/**
 * `npm run discover` — one model-driven run, distilled into an artifact (§5.4, §9).
 *
 *     npm run discover -- --goal "<natural-language goal>" [--param <name>=<value> …] [--entry <url>] [--headed]
 *
 * This file is the whole of P4 made runnable: preflight, the model, the loop, the recorder, the
 * review pass, the store. Everything it calls was built to be called from here, and what is left is
 * the ordering — which is where the phase's real decisions are.
 *
 * **Five decisions shape it.**
 *
 * 1. **Usage errors are decided before anything is loaded, and they exit `2`.** §5.4 makes that
 *    boundary hard: a bad flag, a malformed `--param`, a name the schema would refuse — each is
 *    reported with a fix and exits before a browser or a model is paid for. The alternative is an
 *    hour of model time ending in `VALIDATION_ERROR`, which reads like the app's fault and is not.
 *
 * 2. **stdout carries exactly one thing.** The result — the human summary, or with `--json` the
 *    serialized `RunResult` — and nothing else. Narration (the loop's notes, the model's protocol
 *    slips, the artifact's path) goes to stderr, because `--json` is a contract a caller parses: a
 *    progress line interleaved into it is a parse error at the consumer, and the sink rule (§6) would
 *    otherwise have to be reasoned about per line rather than once.
 *
 * 3. **The artifact is recorded, reviewed, then saved — in that order, with the save last.** The
 *    store validates on write, so saving last means the file in `capabilities/` is the reviewed one
 *    or nothing: a refused review cannot leave an unreviewed artifact behind for a caller to pick up.
 *
 * 4. **A discovery run that does not complete is a `failure`, and never a business outcome.** §5.2's
 *    first class is the *replay* engine's to produce — it is the answer the app gave to a declared
 *    question. Discovery's endings (thrash, give-up, an approval nothing can grant, a thrown error)
 *    are all "no artifact was produced", which is a failure with a hint, at exit `1`.
 *
 * 5. **`--id` is an extension to §5.4's frozen grammar, and it is a naming input, not a behavior.**
 *    An artifact's id is its path in the store and the handle callers use; nothing in a goal's prose
 *    determines it. So it is an explicit option, and when it is absent the id is derived from the
 *    goal — with the declared params' samples replaced by their placeholder names, so the derivation
 *    can never put a caller's value in a filename. The frozen grammar is a subset of what this
 *    accepts, which is the direction that cannot break a caller.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConfig } from "../agent/config.ts";
import { describeStuck } from "../agent/stuck.ts";
import { ControlBus, BusError } from "../control/bus.ts";
import { Controller } from "../control/controller.ts";
import { approvalFor, type EscalationOutcome, type EscalationRequest } from "../control/escalation.ts";
import { runDiscovery, type DiscoveryRun } from "../agent/loop.ts";
import { openaiDriver } from "../agent/openai.ts";
import { recordCapability } from "../agent/recorder.ts";
import { reviewCapability } from "../agent/review.ts";
import { BindingLog, type ParamSample } from "../agent/canonicalize.ts";
import { redactorFor, type Redactor } from "../policy/redact.ts";
import type { Policy } from "../policy/policy.ts";
import { isUsableName } from "../schema/artifact.ts";
import { paramNameProblem } from "../schema/validate.ts";
import { CapabilityStore } from "../store/capability-store.ts";
import {
  ABSENT_IDENTITY,
  identityOf,
  observeIdentity,
  UNKNOWN_IDENTITY,
  type AppIdentity,
} from "../surface/identity.ts";
import { SessionDriver, type ApprovalHandler } from "../surface/session-driver.ts";
import {
  PROCESS_STREAMS,
  describeUsageError,
  evidenceRoot,
  loadDotenv,
  noteWriter,
  type NoteWriter,
  type Streams,
  type UsageError,
} from "./io.ts";
import { describePreflightFailure, preflight } from "./preflight.ts";
import {
  describeResult,
  exitCodeFor,
  failureResult,
  successResult,
  type EvidenceRefs,
  type RunResult,
} from "../replay/result.ts";

/* `<repo>/` and `<repo>/evidence` come from `io.ts`, so both commands write runs to one tree. */

/**
 * §4.1's version for a fresh recording — `v1`, which is the path §11's P4 criterion names
 * (`capabilities/member-savings-balance/v1/`) and the one §9's recorder section writes
 * (`capabilities/<id>/v1/artifact.json`). Spelled `1` rather than `1.0.0`: the store treats the three
 * spellings as one version, and the directory it writes is named from this string, so the spelling
 * here is what an evaluator sees on disk.
 */
const FIRST_VERSION = "1";

/** §5.4's grammar, quoted in every usage error so a caller never has to find the docs. */
const USAGE =
  'npm run discover -- --goal "<natural-language goal>" [--param <name>=<value> …] [--entry <url>] [--id <capability-id>] [--headed] [--json]';

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

export interface Args {
  readonly goal: string;
  /** The goal's declared inputs, in declaration order — the order §28 canonicalizes in. */
  readonly params: readonly ParamSample[];
  /** `null` means "whatever the policy's allowlist says the default origin is" (§5.4). */
  readonly entry: string | null;
  readonly id: string | null;
  readonly headed: boolean;
  readonly json: boolean;
}

export type ParsedArgs = { readonly ok: true; readonly args: Args } | UsageError;

/**
 * The frozen grammar, parsed by hand.
 *
 * No argument-parsing dependency, and not only because the grammar is small: the errors are the
 * feature. `parseArgs` answers with a problem and a fix for every way a caller can get it wrong,
 * which is the contract §5.4 asks for and the thing a generic parser would replace with its own
 * voice.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const params: ParamSample[] = [];
  let goal: string | null = null;
  let entry: string | null = null;
  let id: string | null = null;
  let headed = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    // Every flag takes a value except the two switches, so `value` is read here and the loop's
    // increment is shared — one place decides what "missing value" means.
    const value = (): string | null => {
      const next = argv[index + 1];
      return next === undefined || next.startsWith("--") ? null : next;
    };
    const takeValue = (): string | UsageError => {
      const next = value();
      if (next === null) {
        return { ok: false, problem: `${flag} needs a value`, fix: `${flag} <value> — see: ${USAGE}` };
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--goal": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        goal = taken;
        break;
      }
      case "--param": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        const parsed = parseParam(taken);
        if (parsed.ok === false) return parsed;
        params.push(parsed.param);
        break;
      }
      case "--entry": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        entry = taken;
        break;
      }
      case "--id": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        // Checked here rather than at save time: an unusable id is a usage error, and it is one the
        // caller can fix in the command they are still typing.
        if (!isUsableName(taken)) {
          return {
            ok: false,
            problem: `--id "${taken}" is not usable as a capability id`,
            fix: "use letters, digits, underscores and dashes, starting with a letter — e.g. --id member-savings-balance",
          };
        }
        id = taken;
        break;
      }
      case "--headed":
        headed = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        return {
          ok: false,
          problem: argv[index]?.startsWith("--")
            ? `unknown flag ${flag}`
            : `discover takes no positional arguments (got ${flag})`,
          fix: USAGE,
        };
    }
  }

  if (goal === null || goal.trim() === "") {
    return {
      ok: false,
      problem: "--goal is required: discovery needs a goal written the way a person would say it",
      fix: `--goal "Look up member 12345 and read their current savings balance" — see: ${USAGE}`,
    };
  }

  const duplicate = firstDuplicate(params.map((param) => param.name));
  if (duplicate !== null) {
    return {
      ok: false,
      problem: `--param ${duplicate} was declared twice`,
      fix: "declare each input once; the value you meant is the one you want",
    };
  }

  return { ok: true, args: { goal, params, entry, id, headed, json } };
}

/** `--param name=value`, with the name checked against the rule the artifact will apply. */
function parseParam(raw: string): { readonly ok: true; readonly param: ParamSample } | UsageError {
  const at = raw.indexOf("=");
  if (at <= 0) {
    return {
      ok: false,
      problem: `--param ${raw} is not <name>=<value>`,
      fix: "declare inputs as --param memberId=12345 (repeat the flag for each input)",
    };
  }
  const name = raw.slice(0, at);
  // Not trimmed: a value with a leading space may well be what the field wants, and the caller can
  // see it. The *name* is trimmed, because a space in a name is always a typo.
  const value = raw.slice(at + 1);
  const problem = paramNameProblem(name.trim());
  if (problem !== null) {
    return { ok: false, problem: `--param ${name}: ${problem}`, fix: "rename the input in --param and re-run" };
  }
  return { ok: true, param: { name: name.trim(), value } };
}

function firstDuplicate(names: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

/**
 * The capability id, when the caller did not name one.
 *
 * Derived from the goal, which is the only text there is — with the declared params' samples swapped
 * for their names first, so `--param memberId=12345` gives `…-memberid-…` rather than putting a
 * caller's value in a path. Words that carry no meaning for a filename are dropped and the rest is
 * capped, because a goal is a sentence and an id is a handle.
 */
export function deriveId(goal: string, params: readonly ParamSample[]): string {
  let text = goal.toLowerCase();
  for (const param of params) {
    if (param.value !== "") text = text.replaceAll(param.value.toLowerCase(), param.name.toLowerCase());
  }
  const words = text
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !STOP_WORDS.has(word))
    .slice(0, 6);
  const slug = words.join("-").replace(/^[^a-z]+/, "");
  return slug === "" ? "capability" : slug;
}

/**
 * Words a goal uses and a handle does not need. Deliberately short and obvious — this is a
 * convenience for the flag-less case, not a summarizer, and a caller who cares passes `--id`.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "at", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "read",
  "report", "the", "their", "then", "to", "up", "using", "with", "you", "your",
]);

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `discover`, end to end. Returns the process exit code: `0` success, `1` a failed run, `2` a usage
 * or preflight error — §5.4's three, with the third decided before any of the first two can happen.
 */
export async function runDiscover(argv: readonly string[], streams: Streams = PROCESS_STREAMS): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    streams.err(describeUsageError("discover", parsed));
    return 2;
  }
  const { args } = parsed;

  // `.env` is loaded before preflight so the key check sees it — and before `new OpenAI()`, which
  // reads the same variable itself.
  loadDotenv();

  const pre = await preflight({ command: "discover", entry: args.entry, env: process.env });
  if (!pre.ok) {
    streams.err(`${describePreflightFailure(pre.issues)}\n`);
    return 2;
  }

  const { policy, entry } = pre;
  const config = agentConfig(policy, process.env);
  const redactor = redactorFor(policy);

  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runDir = join(evidenceRoot(), runId);

  // §8's control wiring, exactly as `replay` does it: the driver gets a delegate, the Controller gets
  // the driver, the bus gets the Controller. Discovery escalates for a gated action *and* for a stuck
  // verdict, and both arrive here.
  let approval: ApprovalHandler = async () => "denied";
  const driver = await SessionDriver.launch({
    headless: !args.headed,
    evidenceDir: runDir,
    policy,
    redactor,
    actionTimeoutMs: policy.document.timing.waitForMs,
    approval: (request) => approval(request),
  });

  // One writer, used by both the loop and `openai.ts`, so the run log is one ordered document. Both
  // callers scrub before they call in (§6); `EvidenceLogger.write` scrubs again, which costs a string
  // scan and means a future caller that forgets cannot leak.
  const writer = noteWriter(driver.evidence, streams);
  writer.note(`discover: goal ${describeGoal(args.goal)}`);

  const controller = new Controller({
    surface: driver,
    timing: policy.document.timing,
    stage: "discovery",
    runId: args.id ?? deriveId(args.goal, args.params),
    redactor,
    onNote: writer.note,
  });
  let bus: ControlBus;
  try {
    bus = await ControlBus.listen({ controller, redactor, onNote: writer.note });
  } catch (error: unknown) {
    await driver.close().catch(() => undefined);
    streams.err(
      describeUsageError("discover", {
        ok: false,
        problem: error instanceof BusError ? error.message : `the control bus could not start: ${String(error)}`,
        fix: "set BUS_PORT to a free port (or stop whatever holds it) and re-run",
      }),
    );
    return 2;
  }
  controller.busUrl = bus.url;
  const escalate = (request: EscalationRequest) => controller.escalate(request);
  approval = async (request) =>
    controller.humanInControl ? "approved" : approvalFor(escalate, () => null)(request);

  let run: DiscoveryRun | null = null;
  let identity: AppIdentity = UNKNOWN_IDENTITY;
  let crashed: Error | null = null;
  try {
    run = await runDiscovery({
      driver,
      agent: openaiDriver({ model: config.model, goal: args.goal, params: args.params, onNote: writer.note }),
      policy,
      budgets: config.budgets,
      screenshot: config.screenshot,
      entry,
      goal: args.goal,
      escalation: escalate,
      onNote: writer.note,
    });
    // §26/§5.4: the marker is read from the live page *after* the run, because that is the surface
    // the artifact will actually be replayed against. Read before the close, which is why it is in
    // this `try` rather than beside the save.
    identity = identityOf(await observeIdentity(driver.page).catch(() => ABSENT_IDENTITY));
    writer.note(`discover: surface advertised ${describeIdentityBlock(identity)}`);
  } catch (error: unknown) {
    // The loop classifies what it can and rethrows what it cannot, so a throw here is a bug in the
    // harness rather than a state of the app — reported as such, with the evidence that has it.
    crashed = error instanceof Error ? error : new Error(String(error));
  } finally {
    controller.close();
    await bus.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    await writer.flush();
  }

  const evidence: EvidenceRefs = { runDir, runLog: driver.evidence.runLogPath };
  const result =
    run === null
      ? failureResult({
          stage: "discovery",
          errorCode: "DISCOVERY_FAILED",
          expected: "the run reaches the goal or ends in a classified outcome",
          observed: crashed?.message ?? "the run ended without a result",
          evidence,
        })
      : await assemble({
          run,
          args,
          policy,
          redactor,
          evidence,
          runId,
          identity,
          writer,
          streams,
          // §9/T14: a run that received in-flow human state changes may not emit an artifact.
          humanActions: controller.humanActions,
        });

  await writeSummary(redactor, runDir, { runId, args, entry, model: config.model, identity, run, result });
  await writer.flush();

  const text = args.json
    ? redactor.serialize(result, 2)
    : redactor.scrubText(describeResult(result).join("\n"));
  streams.out(`${text}\n`);
  return exitCodeFor(result);
}

/**
 * The run is over; everything from here is about what it produced.
 *
 * Split out so the ordering in decision 3 is one readable function rather than a tail of `try`
 * blocks: record, review, save — and only then the result, which reports what was written.
 */
async function assemble(input: {
  readonly run: DiscoveryRun;
  readonly args: Args;
  readonly policy: Policy;
  readonly redactor: Redactor;
  readonly evidence: EvidenceRefs;
  readonly runId: string;
  readonly identity: AppIdentity;
  readonly writer: NoteWriter;
  readonly streams: Streams;
  /** Console actions this run carried out. Any at all is §9's "human help" case. */
  readonly humanActions: number;
}): Promise<RunResult> {
  const { run, args, policy, redactor, evidence, identity, streams, humanActions } = input;

  if (run.ending.kind !== "completed") return failureFor(run, evidence);

  const humanAssisted = humanAssistedRefusal(humanActions, evidence);
  if (humanAssisted !== null) {
    input.writer.note(
      `refusing to emit an artifact: this run received ${humanActions} in-flow human action(s) — ` +
        "re-derive it in a fresh autonomous run (§9)",
    );
    return humanAssisted;
  }

  const outputs = run.ending.outputs;
  try {
    const bindings = new BindingLog(args.params);
    const recording = recordCapability({
      run,
      id: args.id ?? deriveId(args.goal, args.params),
      name: titleFrom(args.goal),
      description: args.goal,
      params: args.params,
      identity,
      policy,
      discoveryRunId: input.runId,
      bindings,
    });
    for (const warning of recording.warnings) input.writer.note(`recorder: ${warning}`);
    // §28's reconciliation, into the log rather than into the artifact: it is evidence about the
    // review pass, not a field a caller reads.
    for (const entry of bindings.entries) {
      input.writer.note(`binding: ${entry.field} ← ${entry.param} (sample ${entry.sample})`);
    }

    const reviewed = reviewCapability({
      capability: recording.capability,
      run,
      seeds: policy.document.outcomes,
    });
    for (const note of reviewed.notes) input.writer.note(note);

    const saved = await new CapabilityStore().save(reviewed.capability, { version: FIRST_VERSION });
    input.writer.note(`saved ${saved.id} v${saved.version} → ${saved.dir}`);
    streams.err(`saved: ${saved.artifactPath}\n`);
    // §6's precedence, once, for the values a caller receives: an output is masked when the artifact
    // declares it or policy names it. Doing it here rather than at the renderer means the human
    // summary and the `--json` payload are the same masked object.
    const declared = new Map(reviewed.capability.outputs.map((output) => [output.name, output.redact]));
    const masked: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(outputs)) {
      masked[name] = redactor.output(name, value, declared.get(name) ?? false).value;
    }
    return successResult(masked, evidence);
  } catch (error: unknown) {
    // A completed run that could not be turned into an artifact. Reported as the failure it is —
    // the message is the whole diagnosis, and it names a harness problem rather than the app's.
    return failureResult({
      stage: "discovery",
      errorCode: "DISCOVERY_FAILED",
      expected: "the run's trace records as a capability and the store accepts it",
      observed: error instanceof Error ? error.message : String(error),
      evidence,
    });
  }
}

/**
 * §9/T14's artifact rule: **a run that received in-flow human state changes emits no artifact**.
 *
 * The reason it is a refusal rather than a note is provenance. An artifact's steps are read off the
 * run's trace, and the trace is what the *model* did; a human's console actions travel the same choke
 * point and are logged with `actor: human`, but they are deliberately not trace entries. So an artifact
 * built from such a run would encode a flow no autonomous run performed — replay would fail on the step
 * nobody can reproduce — and the honest output is the refusal plus the evidence, with "re-derive it
 * autonomously" as the fix.
 *
 * A function rather than three lines inside `assemble`, because the *rule* is what a reviewer reads and
 * what a test should be able to state without an API key, a model, or a store.
 */
export function humanAssistedRefusal(humanActions: number, evidence: EvidenceRefs): RunResult | null {
  if (humanActions <= 0) return null;
  return failureResult({
    stage: "discovery",
    errorCode: "HUMAN_ASSISTED",
    expected: "the run reaches the goal without a human changing the page in flow",
    observed:
      `the run completed, but ${humanActions} action(s) came from an operator console — the artifact ` +
      "would record a flow nobody can replay autonomously",
    evidence,
    escalation: "human-took-over",
  });
}

/** §5.2's discovery-stage classification: what the run's ending means as a `RunResult`. */
export function failureFor(run: DiscoveryRun, evidence: EvidenceRefs): RunResult {
  const ending = run.ending;
  switch (ending.kind) {
    case "completed":
      throw new Error("a completed run is a success, not a failure");
    case "stuck":
      return failureResult({
        stage: "discovery",
        errorCode: "STUCK",
        expected: "the goal is reached within the agent budgets (§8)",
        observed: describeStuck(ending.reason),
        evidence,
        // §8: whether the run asked a human, and what came of it. "Nobody was there" and "a person
        // looked and could not help either" are different findings about the capability, and the
        // run's own ending is the only place that distinction survives.
        escalation: escalationOf(ending.escalation),
      });
    case "gave-up":
      return failureResult({
        stage: "discovery",
        errorCode: "GAVE_UP",
        expected: "the model reaches the goal, or names a business outcome",
        observed: ending.reason,
        evidence,
      });
    case "escalated":
      return failureResult({
        stage: "discovery",
        errorCode: "ESCALATION_REQUIRED",
        expected: "every action on the path is either permitted or needs no approval",
        observed: `the run needed a human decision: ${ending.reason}`,
        evidence,
        escalation: escalationOf(ending.escalation),
      });
    case "blocked":
      return failureResult({
        stage: "discovery",
        errorCode: "NAVIGATION_BLOCKED",
        expected: "the goal is reachable inside the policy's allowlist",
        observed: `policy refused an action (${ending.verdict.rule}): ${ending.verdict.reason}`,
        evidence,
      });
    case "failed":
      return failureResult({
        stage: "discovery",
        errorCode: "DISCOVERY_FAILED",
        expected: "the run reaches the goal or ends in a classified outcome",
        observed: ending.error.message,
        evidence,
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Narration                                                                   */
/* -------------------------------------------------------------------------- */

/** A goal is a sentence; keep it to one line in a log even when it was pasted with newlines. */
function describeGoal(goal: string): string {
  return `"${goal.replaceAll(/\s+/g, " ").trim()}"`;
}

/** `atlas-console/base@1.4.0`, or the honest `unknown/unknown@unknown` (§26's fallback). */
function describeIdentityBlock(identity: AppIdentity): string {
  return `${identity.product}/${identity.variant}@${identity.version}`;
}

/** `Look up member…` as a display name: the goal, sentence-cased and clipped to one line. */
/**
 * §8's outcome, in §5.3's spelling.
 *
 * The two vocabularies are the same three facts with different names — the seam says `took-over`,
 * the result contract says `human-took-over` — and the mapping belongs in one function rather than at
 * each of the two call sites that need it.
 */
function escalationOf(outcome: EscalationOutcome | undefined): "none" | "human-took-over" | "declined" | "no-operator" {
  switch (outcome) {
    case "took-over":
      return "human-took-over";
    case "declined":
      return "declined";
    case "unavailable":
      return "no-operator";
    default:
      return "none";
  }
}

function titleFrom(goal: string): string {
  const flattened = goal.replaceAll(/\s+/g, " ").trim();
  const capped = flattened.length <= 70 ? flattened : `${flattened.slice(0, 70)}…`;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * The run's own record of what it was asked and what came of it — `run.jsonl` is the log of the
 * turns, and this is the one file an evaluator opens first.
 *
 * Written through the redactor's serializer like every other sink (§6), with `space` because a person
 * reads this one. `identity` is the *observed* block, which is the fact §26 compares at replay: the
 * artifact says what it was recorded against, and this says what the surface actually advertised.
 */
async function writeSummary(
  redactor: Redactor,
  runDir: string,
  summary: {
    readonly runId: string;
    readonly args: Args;
    readonly entry: string;
    readonly model: string;
    readonly identity: AppIdentity;
    readonly run: DiscoveryRun | null;
    readonly result: RunResult;
  },
): Promise<void> {
  const { run } = summary;
  const payload = {
    runId: summary.runId,
    goal: summary.args.goal,
    params: summary.args.params,
    entry: summary.entry,
    model: summary.model,
    identity: summary.identity,
    ended: run?.ending.kind ?? "crashed",
    turns: run?.turns ?? 0,
    result: summary.result,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "summary.json"), `${redactor.serialize(payload, 2)}\n`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run only when invoked as a program, so a test can import `parseArgs`, `deriveId` and `failureFor`
 * without starting a run. `npm run discover` is the pinned form of exactly this check.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDiscover(process.argv.slice(2));
}
