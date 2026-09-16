/**
 * `replay` (§5.4) — the keyless command: a recorded artifact, executed against a live target.
 *
 * The division this file implements is §5.4's, and it is the reason the command exists at all: a run
 * that needs a model is paid, non-deterministic and unrepeatable, so everything that can be decided
 * *before* a browser is launched is decided here and reported as a usage error (exit 2), while
 * everything that can only be learned from the target is the engine's business (exit 0 or 1).
 *
 * The order is the file, and each step exists because it can stop the run cheaper than the next:
 *
 * 1. **usage** — the grammar, by hand, with a problem and a fix (§5.4).
 * 2. **the artifact** — loaded and re-validated from the store, so a hand-edited file is caught here.
 * 3. **the inputs** — every declared input has a value, no undeclared one was passed, and each value
 *    matches its declared `type`/`pattern`. This is the layer `validate.ts` cannot be: the artifact
 *    declares its inputs, and only the caller knows the values.
 * 4. **preflight** — policy, origin, entry (§5.4), shared with `discover`.
 * 5. **tenant drift** (§26) — one bounded GET, before anything is launched. This is the check's whole
 *    value: an artifact recorded against another tenant must fail as *"wrong app"*, not as a
 *    confusing `ELEMENT_NOT_FOUND` eight steps in.
 * 6. **risk** (§27) — the artifact's recorded gates, re-checked against the policy in force, so a
 *    tightening shows up as an upgrade in the record rather than as an unexplained approval prompt.
 * 7. **the run**, then the summary, then §5.4's rendering.
 *
 * Two of these deserve a note about *why they are not in the engine*. Drift is a property of a target
 * and an artifact, not of a step, and it has to be decided before a browser exists — the engine's
 * first act is to launch one. And the risk cross-check is a statement about the artifact as a whole,
 * which is why its findings are reported as notes and its enforcement is left where it already lives:
 * `StricterPolicy` decorates the driver's policy, so the gate is applied at the choke point on the
 * element that actually resolved, and this pass only tells the operator what to expect.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlBus, BusError } from "../control/bus.ts";
import { Controller } from "../control/controller.ts";
import { redactorFor, type Redactor } from "../policy/redact.ts";
import type { Capability, Param } from "../schema/artifact.ts";
import { CapabilityStore } from "../store/capability-store.ts";
import {
  describeIdentity,
  fetchIdentity,
  identityEvidence,
  type IdentityEvidence,
} from "../surface/identity.ts";
import { SessionDriver, type ApprovalHandler } from "../surface/session-driver.ts";
import {
  StricterPolicy,
  crossCheckRisk,
  replaySeams,
  replayState,
  runReplay as executeReplay,
  type RiskCrossCheck,
} from "../replay/engine.ts";
import {
  describeResult,
  exitCodeFor,
  failureResult,
  type EvidenceRefs,
  type RunResult,
} from "../replay/result.ts";
import { bind, parseMoney, type Params } from "../replay/step-runner.ts";
import {
  PROCESS_STREAMS,
  describeUsageError,
  evidenceRoot,
  loadDotenv,
  noteWriter,
  type Streams,
  type UsageError,
} from "./io.ts";
import { describePreflightFailure, preflight } from "./preflight.ts";

/** §5.4's grammar, quoted in every usage error so a caller never has to find the docs. */
const USAGE =
  "npm run replay -- <capability-id> [--version <version>] [--<input> <value> …] [--entry <url>] " +
  "[--policy <file>] [--allow-drift] [--headed] [--json]";

/**
 * The flags this command owns.
 *
 * The set matters because of what is *not* in it: every other `--name` is one of the artifact's
 * declared inputs, which is what makes §5.4's `--<input-name> <value>` grammar possible at all. The
 * artifact's inputs are forbidden from colliding with these names when it is saved (`validate.ts`
 * checks the same list), so the two layers cannot disagree about what a flag means.
 */
const FLAGS: ReadonlySet<string> = new Set(["version", "entry", "policy", "allow-drift", "headed", "json"]);

export interface Args {
  readonly id: string;
  /** `latest` by default — the store's pointer, which is what a caller means by "the capability". */
  readonly version: string;
  /** `--<input> <value>`, in the order they were passed. Checked against the artifact afterwards. */
  readonly inputs: ReadonlyMap<string, string>;
  /** `null` means "the artifact's own `surface.entry`" (§5.4). */
  readonly entry: string | null;
  readonly policyFile: string | null;
  readonly allowDrift: boolean;
  readonly headed: boolean;
  readonly json: boolean;
}

export type ParsedArgs = { readonly ok: true; readonly args: Args } | UsageError;

/**
 * The grammar, parsed by hand — the same choice `discover` makes and for the same reason: the errors
 * are the feature, and a generic parser would replace them with its own voice.
 *
 * One thing is deliberately *not* checked here: whether the input names are the artifact's. That
 * needs the artifact, and the artifact is loaded next; checking it here would mean reporting the
 * typo before knowing what the declared names are, which is precisely the information the fix needs.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const inputs = new Map<string, string>();
  let id: string | null = null;
  let version = "latest";
  let entry: string | null = null;
  let policyFile: string | null = null;
  let allowDrift = false;
  let headed = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    // Every flag takes a value except the three switches, so `value` is read here and the loop's
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

    if (!flag.startsWith("--")) {
      if (id !== null) {
        return {
          ok: false,
          problem: `replay takes one capability id (got "${id}" and "${flag}")`,
          fix: `replay <capability-id> … — see: ${USAGE}`,
        };
      }
      id = flag;
      continue;
    }

    const name = flag.slice(2);
    if (!FLAGS.has(name)) {
      const taken = takeValue();
      if (typeof taken !== "string") return taken;
      inputs.set(name, taken);
      continue;
    }

    switch (name) {
      case "version": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        version = taken;
        break;
      }
      case "entry": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        entry = taken;
        break;
      }
      case "policy": {
        const taken = takeValue();
        if (typeof taken !== "string") return taken;
        policyFile = taken;
        break;
      }
      case "allow-drift":
        allowDrift = true;
        break;
      case "headed":
        headed = true;
        break;
      case "json":
        json = true;
        break;
      default:
        // Unreachable: `FLAGS` is exactly the switch above. Named rather than silently ignored, so a
        // flag added to one and not the other is a compile error instead of a mystery.
        return { ok: false, problem: `unhandled flag ${flag}`, fix: USAGE };
    }
  }

  if (id === null) {
    return {
      ok: false,
      problem: "no capability was named: replay runs a recorded artifact, and no goal is involved",
      fix: `replay member-savings-balance --memberId 12345 — list what is recorded with \`ls capabilities/\` — see: ${USAGE}`,
    };
  }

  return { ok: true, args: { id, version, inputs, entry, policyFile, allowDrift, headed, json } };
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The caller's values, checked against what the artifact declares.
 *
 * Three ways to get it wrong, all reported together because they are one mistake — the caller does
 * not know what this capability takes — and fixing them one exit-code at a time is how a first run
 * becomes four. An undeclared name is reported with the declared set rather than a guess, because
 * `--memberID` and `--memberId` are one character apart and only one of them is the artifact's.
 *
 * The `pattern` and `type` checks are the same rule `validate.ts` enforces on the *declaration*,
 * applied to the *value*: the schema can prove a declared regex compiles, and only the caller can
 * prove their value matches it. A value that fails here is a usage error (§5.4's exit 2) and never a
 * `VALIDATION_ERROR` outcome — the app was never asked.
 */
export function bindInputs(
  capability: Capability,
  given: ReadonlyMap<string, string>,
): { readonly ok: true; readonly params: Params } | UsageError {
  const declared = new Map(capability.inputs.map((param) => [param.name, param]));
  const problems: string[] = [];

  const unknown = [...given.keys()].filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    const names = [...declared.keys()];
    problems.push(
      `no input named ${unknown.map((name) => `\`${name}\``).join(", ")}; ` +
        (names.length === 0
          ? "this capability declares no inputs at all"
          : `it declares: ${names.map((name) => `--${name}`).join(", ")}`),
    );
  }

  const params = new Map<string, string>();
  const missing: string[] = [];
  for (const [name, param] of declared) {
    const value = given.get(name);
    if (value === undefined) {
      missing.push(`--${name}`);
      continue;
    }
    const problem = valueProblem(param, value);
    if (problem !== null) problems.push(problem);
    else params.set(name, value);
  }
  if (missing.length > 0) {
    problems.push(
      `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no value — ` +
        `every declared input is required (${capability.inputs.map((param) => `${param.name}: ${param.description}`).join("; ")})`,
    );
  }

  if (problems.length > 0) {
    return {
      ok: false,
      problem: problems.join("\n         "),
      fix: `pass each input as a flag, e.g. ${capability.inputs.map((param) => `--${param.name} <${param.description}>`).join(" ")} — see: ${USAGE}`,
    };
  }
  return { ok: true, params };
}

/** Why this value is not usable for this input, or `null` when it is. */
function valueProblem(param: Param, value: string): string | null {
  if (param.type === "int" && !/^[+-]?\d+$/.test(value.trim())) {
    return `--${param.name} expects an integer (${param.description}), got "${value}"`;
  }
  // `money` accepted at the CLI in the same spellings the page uses, because the caller is reading the
  // amount off a statement and the parser is the one that already knows what an amount looks like.
  if (param.type === "money" && parseMoney(value) === null) {
    return `--${param.name} expects an amount (${param.description}), got "${value}"`;
  }
  if (param.pattern !== undefined && !new RegExp(param.pattern).test(value)) {
    return `--${param.name} must match /${param.pattern}/ (${param.description}), got "${value}"`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* §26 — tenant drift                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether this target is the app the artifact was recorded against.
 *
 * Returns the evidence block either way, because it is written on *every* run (§26) — the verdict
 * decides whether this run happens, never whether it is recorded. Three outcomes, and the asymmetry
 * is §26's:
 *
 * - a difference in `product`/`variant` is a **different app**, where the recorded locators may
 *   genuinely not exist, so it stops the run before a browser exists — unless `--allow-drift`, which
 *   is the operator saying "I know, and I want the run anyway";
 * - a difference in `version` is a **patch** to the same configured product: it proceeds, recorded;
 * - no marker, or nothing to compare against, is `unknown`: it proceeds, and the step-level `expect`
 *   checks are the backstop. §26 nit 3 is why this is not a stop — making a silent legacy console a
 *   hard failure would be a check that only works on a cooperative target.
 */
export function driftVerdict(
  identity: IdentityEvidence,
  allowDrift: boolean,
): { readonly ok: true } | UsageError {
  if (identity.verdict === "mismatch" && !allowDrift) {
    return {
      ok: false,
      problem:
        `the target is not the app this artifact was recorded against\n` +
        `           expected: ${describeIdentity(identity.expected)}\n` +
        `           target:   ${describeIdentity(identity.observed)}\n` +
        `           ${identity.reason}`,
      fix:
        "point --entry at a target running the recorded product and variant, or re-run with " +
        "--allow-drift to replay against this one anyway — the drift is recorded in evidence either way",
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `replay`, end to end. Returns §5.4's exit code: `0` success **or** business outcome, `1` a failure,
 * `2` a usage or preflight problem — the third decided before any of the first two can happen.
 */
export async function runReplay(argv: readonly string[], streams: Streams = PROCESS_STREAMS): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    streams.err(describeUsageError("replay", parsed));
    return 2;
  }
  const { args } = parsed;

  // Before preflight, because the environment is one of preflight's inputs (`POLICY_PATH`).
  loadDotenv();

  // 1. The artifact. Store errors are all "what you asked for and what exists instead", so they are
  //    passed through as written rather than paraphrased.
  let capability: Capability;
  try {
    capability = await new CapabilityStore().load(args.id, args.version);
  } catch (error: unknown) {
    streams.err(
      describeUsageError("replay", {
        ok: false,
        problem: error instanceof Error ? error.message : String(error),
        fix: "check the capability id and version against `ls capabilities/`, or record one with `npm run discover`",
      }),
    );
    return 2;
  }

  // 2. The caller's values.
  const bound = bindInputs(capability, args.inputs);
  if (!bound.ok) {
    streams.err(describeUsageError("replay", bound));
    return 2;
  }
  const { params } = bound;

  // 3. The entry: `--entry`, or the artifact's own — which may itself be a template (§4.1 allows a
  //    `{param}` there, so the same binding applies).
  const requestedEntry = args.entry ?? bind(capability.surface.entry, params);

  // 4. Policy, origin, entry (§5.4).
  const pre = await preflight({
    command: "replay",
    entry: requestedEntry,
    env: process.env,
    policyFile: args.policyFile ?? undefined,
  });
  if (!pre.ok) {
    streams.err(`${describePreflightFailure(pre.issues)}\n`);
    return 2;
  }
  const { policy, policyPath, entry } = pre;

  // 5. Tenant drift (§26) — before the launch, which is the point of it.
  const identity = identityEvidence(capability.app, await fetchIdentity(entry));
  const drift = driftVerdict(identity, args.allowDrift);
  if (!drift.ok) {
    streams.err(describeUsageError("replay", drift));
    return 2;
  }
  if (identity.verdict !== "match") {
    streams.err(`replay: app identity: ${identity.reason}\n`);
    if (args.allowDrift && identity.verdict === "mismatch") {
      streams.err("replay: --allow-drift was given, so the run proceeds — the drift is recorded in evidence\n");
    }
  }

  // 6. Risk (§27).
  const risk = crossCheckRisk(capability, policy, params);
  for (const note of risk.notes) streams.err(`replay: ${note}\n`);

  const redactor = redactorFor(policy);
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runDir = join(evidenceRoot(), runId);
  const evidence: EvidenceRefs = { runDir, runLog: join(runDir, "run.jsonl") };

  // §8's control wiring, in the order the dependencies actually run: the driver needs an approval
  // handler, the handler needs the seams, the seams need the Controller, and the Controller needs the
  // driver's surface and the note writer's log. The one late binding is the approval delegate, and it
  // is honest rather than clever: nothing can ask for an approval before the run starts, so the
  // delegate is always bound by the time anything calls it.
  let approval: ApprovalHandler = async () => "denied";
  // One state object, shared by §27's policy decorator (which asks which step is in flight) and by the
  // seams (which set it). It has to exist before the driver, because the driver is constructed with the
  // decorator.
  const seamsState = replayState();

  const driver = await SessionDriver.launch({
    headless: !args.headed,
    evidenceDir: runDir,
    policy: new StricterPolicy(policy, risk.gated, seamsState),
    redactor,
    // The driver's own auto-wait is the step budget: a click that cannot find its target in the time
    // the step was given to prove itself has not failed for a different reason, and giving it a
    // second, longer timeout would make §5.2's `waitForMs` describe something other than the wait.
    actionTimeoutMs: policy.document.timing.waitForMs,
    approval: (request) => approval(request),
  });
  const writer = noteWriter(driver.evidence, streams);

  // The Controller is §8's token machine and the bus is how a second process reaches it. The run owns
  // the browser, so the console is *always* a client — which is what makes the handoff structural
  // rather than a convention two cooperating processes agree on (§3's diagram).
  const controller = new Controller({
    surface: driver,
    timing: policy.document.timing,
    stage: "replay",
    runId: capability.id,
    redactor,
    onNote: writer.note,
  });
  let bus: ControlBus;
  try {
    bus = await ControlBus.listen({ controller, redactor, onNote: writer.note });
  } catch (error: unknown) {
    // A bus that cannot listen is a usage-level problem, not a run outcome: §5.4's exit 2, before the
    // run has done anything. The browser is closed here because the run never starts.
    await driver.close().catch(() => undefined);
    streams.err(
      describeUsageError("replay", {
        ok: false,
        problem: error instanceof BusError ? error.message : `the control bus could not start: ${String(error)}`,
        fix: "set BUS_PORT to a free port (or stop whatever holds it) and re-run — §5.4's env knobs",
      }),
    );
    return 2;
  }
  controller.busUrl = bus.url;

  const seams = replaySeams({ escalation: (request) => controller.escalate(request) });
  // §6's gate and §8's token meet here: while an operator holds the session, their own action **is** the
  // approval — recorded as `actor: human` by the choke point — so the run never asks a human to approve
  // a human. Every other gate goes to the escalation seam, which is what raises the request.
  approval = async (request) => (controller.humanInControl ? "approved" : seams.approval(request));

  let result: RunResult;
  try {
    writer.note(`replay: ${capability.id} v${args.version} — ${capability.steps.length} step(s) from ${entry}`);
    result = await executeReplay({
      capability,
      driver,
      policy,
      params,
      entry,
      entryOverridden: args.entry !== null,
      identity,
      seams,
      onNote: writer.note,
    });
  } catch (error: unknown) {
    // The engine classifies everything it can reach and reports it as a result, so a throw out of it
    // is a bug in the harness rather than a state of the app. Reported as a run result all the same:
    // a caller who asked for a run should get one, with the evidence that has it.
    result = failureResult({
      stage: "replay",
      errorCode: "UNEXPECTED_STATE",
      expected: "the artifact replays to a classified result",
      observed: error instanceof Error ? error.message : String(error),
      evidence,
    });
  } finally {
    // The run is over, so nothing is waiting for a human any more: stop the lease clocks and stop
    // listening. **A bus left open is a process that never exits** — `server.close()` is what releases
    // the handle, and the failure mode is silent (the run prints its result and then hangs), which is
    // why the two-process demo, not the in-process suite, is what caught it.
    controller.close();
    await bus.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    await writer.flush();
  }

  await writeSummary(redactor, runDir, {
    runId,
    capability,
    requested: args,
    params,
    entry,
    policyPath,
    identity,
    risk,
    result,
  });

  const text = args.json ? redactor.serialize(result, 2) : redactor.scrubText(describeResult(result).join("\n"));
  streams.out(`${text}\n`);
  return exitCodeFor(result);
}

/**
 * The run's own record — `run.jsonl` is what happened, step by step, and this is the one file a
 * person opens first.
 *
 * Written through the redactor's serializer like every other sink (§6), with `space` because a human
 * reads this one. It carries the three things the log alone cannot answer: what was *asked* (the
 * artifact, its version, the bound inputs, the entry), what the surface *was* (§26's identity
 * verdict, recorded even when it did not match), and what the run *decided about risk* (§27's
 * upgrade list) — each of which is a question someone reading a failure a week later will have.
 */
async function writeSummary(
  redactor: Redactor,
  runDir: string,
  summary: {
    readonly runId: string;
    readonly capability: Capability;
    readonly requested: Args;
    readonly params: Params;
    readonly entry: string;
    readonly policyPath: string | null;
    readonly identity: IdentityEvidence;
    readonly risk: RiskCrossCheck;
    readonly result: RunResult;
  },
): Promise<void> {
  const payload = {
    runId: summary.runId,
    capability: summary.capability.id,
    version: summary.requested.version,
    inputs: Object.fromEntries(summary.params),
    entry: summary.entry,
    policy: summary.policyPath,
    identity: summary.identity,
    risk: {
      declared: [...summary.risk.declared],
      gated: [...summary.risk.gated],
      upgraded: summary.risk.upgraded,
      blocked: summary.risk.blocked,
      notes: summary.risk.notes,
    },
    result: summary.result,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "summary.json"), `${redactor.serialize(payload, 2)}\n`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run only when invoked as a program, so a test can import `parseArgs`, `bindInputs` and
 * `driftVerdict` without starting a run. `npm run replay` is the pinned form of exactly this check.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReplay(process.argv.slice(2));
}
