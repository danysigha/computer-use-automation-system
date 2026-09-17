/**
 * The recorder (§9, §11 P4) — the trace, read back as an artifact.
 *
 * It is a **pure function of the trace plus the run's declared inputs**, and that is the whole
 * design rather than a property it happens to have. §9 splits discovery into a loop that drives a
 * model and a recorder that emits an artifact so that a recording is *reviewable*: there is one
 * account of what happened (`trace.ts`), and the artifact is a reading of it rather than a second,
 * invisible opinion about the same pages. Nothing here looks at a browser, and nothing here decides
 * what the run did. If a field is in the artifact, it is in the trace.
 *
 * ## What becomes a step
 *
 * | trace        | artifact                                            |
 * |--------------|-----------------------------------------------------|
 * | `entry`      | **nothing** — it is `surface.entry`                 |
 * | `navigate`   | a `navigate` step                                   |
 * | `act`        | an `act` step, with a derived `expect`              |
 * | `read`       | an `extract` step, one per output that names it     |
 * | `wait`       | a `wait` step (`condition: "load"`)                 |
 * | `screenshot` | **nothing** — an observation, not an action         |
 *
 * Two of those rows are decisions rather than mappings.
 *
 * **The bootstrap navigation is not a step.** §4.2's abbreviated example shows one, and this
 * deliberately departs from it: `surface.entry` already says where a run begins, replay navigates
 * there to begin, and a step for the same URL would make every replay navigate twice. The
 * difference is visible in step *numbers* — an artifact recorded from the same run has its first act
 * at id 1 where the example has it at 2 — and it is worth naming, because a reviewer comparing the
 * two should see a decision rather than an off-by-one.
 *
 * **A read no output names is not a step either.** It produced nothing the capability promises, and
 * an `extract` step has to be *named* — inventing a name for a value nobody asked for would put a
 * fictional output in the artifact. Reads are read-only, so dropping one cannot change the page
 * state a later step's `expect` is checked against; the observation is still in the run log.
 *
 * ## The derived `expect`
 *
 * §4.2 requires every `act` to carry one, and the recorder derives it from the delta the run
 * actually observed. Four sources, in this order, and the order is the design:
 *
 * 1. **The URL moved** → `urlMatches` from `routePattern`, or `urlContains` when the new path has no
 *    variable segment to patternize. First because a navigation is the coarsest, most durable
 *    statement an action can make, and because it *invalidates the alternative*: once the page has
 *    moved, the node the step acted on is usually gone, so a `textEquals` naming it would be an
 *    assertion about an element that no longer exists.
 * 2. **The acted-upon node's own text moved** → `textEquals` on the captured chain. This is the
 *    assertion that a field *accepted* what was typed into it, which is a different fact from "we
 *    sent it" and the commonest real failure in a legacy form.
 * 3. **Something appeared** → `elementExists` on the anchor's captured chain.
 * 4. **Something else changed** → `textEquals` on the anchor's captured chain.
 *
 * When none of the four applies the recorder **refuses the recording** rather than inventing a
 * fifth. The reachable case is an act that only removed nodes: `elementAbsent` is the assertion for
 * it, but a chain has to be captured while the element is live and the loop can only capture what
 * survived. So there is no honest assertion left, and §4.1 makes `expect` mandatory precisely so
 * that this cannot be papered over — a step emitted without one is a step that can only fail at
 * replay, in somebody else's deployment, long after anyone could see why.
 *
 * ## What is stamped, never defaulted
 *
 * §27 gives the recorder two producers and forbids both from guessing: `risk` comes from the
 * verdicts the run's own choke point produced (`class: "approval-gated"` iff some recorded act was
 * gated, `irreversibleSteps` naming exactly those), and each `Output.redact` is true when the
 * output's name or its extract target matches a policy `redact.fieldPatterns` pattern. Neither is
 * ever set to a comfortable default, because defaulting `redact` to `false` would mean an artifact
 * silently opted *out* of redaction — the one direction a safety field must not fail in.
 *
 * ## Canonicalization
 *
 * Every emitted string field the schema scans for placeholders goes through `BindingLog.text`
 * (§28): `surface.entry`, `steps[].url`, `steps[].value`, the assertion literals, and
 * `outcomes[].message`. A **target descriptor is never rewritten** — its strings are identity
 * captured from the live DOM, so a `{memberId}` substituted inside one would name something no
 * resolver can find. The rule and its boundary are the same rule: a field is canonicalizable iff a
 * placeholder in it resolves.
 *
 * The two variable syntaxes stay in their lanes, which is §28's "two syntaxes, one meaning each"
 * applied at the producer. A `navigate` step's `url` binds the **caller's** value
 * (`/member/{memberId}/summary`). A URL-derived `expect` describes the **route's shape**
 * (`/member/:id/summary`) — the plan's own example, and the reason a replay carrying a different
 * member id still passes the checkpoint.
 */
import type { AppIdentity, Capability, Output, Param, StateAssertion, Step } from "../schema/artifact.ts";
import { placeholdersIn, SCHEMA_VERSION } from "../schema/artifact.ts";
import { CapabilityInvalidError, validateCapability } from "../schema/validate.ts";
import { namePattern } from "../policy/pattern.ts";
import type { Policy } from "../policy/policy.ts";
import type { TargetDescriptor } from "../surface/target.ts";
import { routePattern, type BindingLog, type ParamSample } from "./canonicalize.ts";
import type { DiscoveryRun } from "./loop.ts";
import { matchRead } from "./trace.ts";
import type { ActTrace, NavigateTrace, ReadTrace, TraceEntry } from "./trace.ts";

/* -------------------------------------------------------------------------- */
/* Input and output                                                            */
/* -------------------------------------------------------------------------- */

/** A recording that cannot be produced, with a reason a person can act on. */
export class RecordingRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "RecordingRefusedError";
    this.reason = reason;
  }
}

export interface RecordOptions {
  /** The finished run. A run that did not complete has no capability to record. */
  readonly run: DiscoveryRun;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The samples the CLI was given, which are also what every emitted field is canonicalized against. */
  readonly params: readonly ParamSample[];
  /** §26: the identity the surface advertised during *this* run, or the declared default. */
  readonly identity: AppIdentity;
  /** §27's classifier, read for the `redact` stamp. The verdicts are in the trace; the patterns are here. */
  readonly policy: Policy;
  readonly discoveryRunId: string;
  /** Injected by tests; a recorded artifact's timestamp is otherwise the moment it was written. */
  readonly recordedAt?: string;
  /** §28's reconciliation. Built by the caller so the CLI can log its entries as they are made. */
  readonly bindings: BindingLog;
}

export interface Recording {
  readonly capability: Capability;
  /** One line per thing the reviewer should look at. Recorded, never acted on silently. */
  readonly warnings: readonly string[];
  /**
   * The artifact's output name → the words the model used, which is the translation the *caller* needs
   * as well as the reviewer: the value a run reports comes out of the model's own answer, while every
   * name it is published under — the artifact, replay's outputs, a policy `redact.outputIds` entry —
   * is the identifier. A caller keyed by anything else answers one capability in two vocabularies.
   */
  readonly outputs: ReadonlyMap<string, string>;
}

/* -------------------------------------------------------------------------- */
/* The recorder                                                                */
/* -------------------------------------------------------------------------- */

export function recordCapability(options: RecordOptions): Recording {
  const { run, bindings } = options;
  if (run.ending.kind !== "completed") {
    throw new RecordingRefusedError(
      `this run ended as "${run.ending.kind}", so there is no capability to record — ` +
        "an artifact is a record of a run that reached its goal",
    );
  }

  const outputs = run.ending.outputs;
  const warnings: string[] = [];
  // The model's labels become identifiers before anything else reads them, so every name below —
  // the extract steps, the outputs, the pointers between them — is the same translated one.
  const named = identifierOutputs(outputs, warnings);
  const plan = planSteps(run.trace, named.ids);

  const steps: Step[] = [];
  const irreversible: number[] = [];

  for (const [index, entry] of run.trace.entries()) {
    const ids = plan.idsAt.get(index) ?? [];
    switch (entry.kind) {
      case "entry":
      case "screenshot":
        break; // not steps; see the header
      case "wait":
        steps.push({ id: requireId(ids, 0, entry.kind), kind: "wait", condition: "load" });
        break;
      case "navigate":
        steps.push(planNavigate(requireId(ids, 0, entry.kind), entry, bindings));
        break;
      case "act": {
        const id = requireId(ids, 0, entry.kind);
        steps.push(planAct(id, entry, bindings, warnings));
        if (entry.verdict.approvalRequired) irreversible.push(id);
        break;
      }
      case "read": {
        // One extract step per output this read supplies, in the order the model declared them.
        for (const [position, name] of (plan.outputsAt.get(index) ?? []).entries()) {
          steps.push(planExtract(requireId(ids, position, entry.kind), name, entry));
        }
        break;
      }
    }
  }

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    description: options.description,
    app: options.identity,
    surface: { kind: "web-dom" as const, entry: bindings.text("surface.entry", run.entry) },
    inputs: options.params.map(toParam),
    outputs: buildOutputs(named, plan, options),
    success: urlAssertion(run.finalUrl, "success", bindings),
    // §4.1's rule 4: a successful recording never witnesses a failure state, so this starts empty
    // and the human review pass fills it. An unreviewed artifact is honest about being unreviewed.
    outcomes: [],
    steps,
    risk:
      irreversible.length === 0
        ? { class: "safe" as const, irreversibleSteps: [] }
        : { class: "approval-gated" as const, irreversibleSteps: irreversible },
    provenance: {
      recordedAt: options.recordedAt ?? new Date().toISOString(),
      model: run.model,
      discoveryRunId: options.discoveryRunId,
    },
  };

  // Validated here rather than only at the store, because the difference is *when* a recorder bug is
  // reported: now, with the run and its trace in hand, instead of after the run's evidence directory
  // has been closed. The store validates too — belt and braces in the one direction that matters,
  // since nothing invalid may ever reach `capabilities/`.
  const checked = validateCapability(artifact);
  if (!checked.ok) {
    throw new CapabilityInvalidError(checked.issues, `the recording for "${options.id}"`);
  }
  return { capability: checked.capability, warnings, outputs: named.labels };
}

/* -------------------------------------------------------------------------- */
/* Numbering the steps                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which trace entries become steps, and what each is called.
 *
 * **One rule, walked once.** Step ids are the schema's only cross-references — `risk.irreversibleSteps`
 * and `Output.source.stepId` both resolve one — so the builder and the output pointers have to agree
 * about every id. Deriving them in two places would be two opinions free to drift, and the drift
 * would show up as an artifact whose `Output.source.stepId` names the wrong step: valid, plausible,
 * and wrong. So the walk happens here, and everything downstream reads its result.
 */
interface StepPlan {
  /** Step ids produced at each trace index, in order. Absent for an entry that is not a step. */
  readonly idsAt: ReadonlyMap<number, readonly number[]>;
  /** Output names supplied by the read at each trace index, in declaration order. */
  readonly outputsAt: ReadonlyMap<number, readonly string[]>;
  /** The extract step id an output is supplied by. */
  readonly stepIdForOutput: ReadonlyMap<string, number>;
  /** The read each output came from — the node label the `redact` stamp is read off. */
  readonly readForOutput: ReadonlyMap<string, ReadTrace>;
}

function planSteps(
  trace: readonly TraceEntry[],
  outputs: Readonly<Record<string, string>>,
): StepPlan {
  const reads = trace.filter((entry): entry is ReadTrace => entry.kind === "read");

  // Which read each output came from. The loop already refused a `markComplete` naming a value the
  // run never read (§9's provenance rule), so a miss here is a bug rather than a model error — and it
  // is caught now, while the run's own trace is still in hand, rather than as an artifact whose
  // `Output.source.stepId` points at nothing.
  const outputsAt = new Map<number, string[]>();
  const readOf = new Map<string, ReadTrace>();
  for (const [name, value] of Object.entries(outputs)) {
    const read = matchRead(reads, value);
    if (read === null) {
      throw new RecordingRefusedError(
        `output "${name}" matches no value this run read, so no extract step can supply it — ` +
          "reporting a value nothing read is refused at the loop, so a trace that reached here " +
          "without one is a bug in the discovery loop rather than a bad run",
      );
    }
    readOf.set(name, read);
    const index = trace.indexOf(read);
    const bucket = outputsAt.get(index);
    if (bucket === undefined) outputsAt.set(index, [name]);
    else bucket.push(name);
  }

  const idsAt = new Map<number, number[]>();
  const stepIdForOutput = new Map<string, number>();
  let next = 0;

  for (const [index, entry] of trace.entries()) {
    const names = outputsAt.get(index) ?? [];
    // One step per navigate/wait/act; one per output for a read; none for an entry or a screenshot.
    const count = entry.kind === "read" ? names.length : entry.kind === "entry" || entry.kind === "screenshot" ? 0 : 1;
    if (count === 0) continue;

    const ids: number[] = [];
    for (let position = 0; position < count; position += 1) {
      next += 1;
      ids.push(next);
      const name = names[position];
      if (name !== undefined) stepIdForOutput.set(name, next);
    }
    idsAt.set(index, ids);
  }

  return { idsAt, outputsAt, stepIdForOutput, readForOutput: readOf };
}

/**
 * The id at `position`, which the plan above has already proven exists.
 *
 * Unreachable by construction, and written as a throw rather than a cast because the alternative is
 * `ids[0] ?? 0` — which would emit step id 0, fail the schema's `positive()` check, and report a
 * numbering bug as a malformed artifact.
 */
function requireId(ids: readonly number[], position: number, kind: string): number {
  const id = ids[position];
  if (id === undefined) {
    throw new RecordingRefusedError(`the step plan produced no id for a ${kind} at position ${position}`);
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A captured chain, as the artifact's type spells it.
 *
 * **The one cast in this file**, and it is sound for a reason already established elsewhere:
 * `artifact.ts`'s compile-time proof (`schemaAgreesWithResolverTypes`) establishes that
 * `z.infer<typeof targetDescriptorSchema>` *is* `DeepMutable<TargetDescriptor>` — the same type with
 * `readonly` erased — so nothing is asserted that the compiler has not already checked. But zod's
 * inference cannot express the modifier and `target.ts` freezes what it hands out, so the conversion
 * has to happen at exactly one place. Here, rather than by relaxing the schema or widening every
 * signature, so that every *other* field below is still honestly type-checked.
 */
function asArtifactTarget(target: TargetDescriptor): ArtifactTarget {
  return target as ArtifactTarget;
}

/**
 * The artifact's spelling of a chain, read off the schema rather than restated.
 *
 * One alias for all three steps that carry a target (`act`, `extract`, and the two assertions), which
 * is the point: the schema gives every one of them the same `targetDescriptorSchema`, so a local
 * alias per step kind would be four names for one type and four chances for them to diverge.
 */
type ArtifactTarget = Extract<Step, { kind: "act" }>["target"];

function planNavigate(id: number, entry: NavigateTrace, bindings: BindingLog): Step {
  return { id, kind: "navigate", url: bindings.text(`steps.${id - 1}.url`, entry.url) };
}

function planAct(id: number, entry: ActTrace, bindings: BindingLog, warnings: string[]): Step {
  const field = `steps.${id - 1}`;

  // Canonicalized **before** the question is asked of it, and the order is the whole point: the
  // binding rule is what turns a raw `hunter2` into `{passcode}`, so a check run against the trace's
  // value would report every bound sensitive write as an unbound one. The trace carries the raw value
  // because it is the record of what happened; whether that value is a literal *in the artifact* is a
  // question only this function can answer, and only after it has decided.
  const value = entry.value === null ? null : bindings.text(`${field}.value`, entry.value);

  if (entry.sensitive && value !== null && placeholdersIn(value).length === 0) {
    warnings.push(
      `step ${id} writes into a field policy calls sensitive, and the value is a literal this ` +
        "artifact would carry verbatim — a sensitive value belongs in a declared input, and the " +
        "review pass is where it becomes one",
    );
  }

  const target = asArtifactTarget(entry.target);
  const expect = expectFor(entry, `${field}.expect`, bindings);
  if (value === null) return { id, kind: "act", action: entry.action, target, expect };
  return { id, kind: "act", action: entry.action, target, value, expect };
}

function planExtract(id: number, name: string, entry: ReadTrace): Step {
  // `table-cell` is a claim about *how* the value was obtained, and the trace supports it exactly: a
  // cell or a header is a grid position; anything else is free text.
  const grid =
    entry.node.role === "cell" || entry.node.role === "rowheader" || entry.node.role === "columnheader";
  return { id, kind: "extract", name, target: asArtifactTarget(entry.target), as: grid ? "table-cell" : "text" };
}

/**
 * The derived postcondition — the four sources, in the order the header defends.
 *
 * Every literal is canonicalized at the path it will occupy, so a `textEquals` carrying the sample
 * the caller typed reads `{memberId}` rather than the sample itself (§28's proof case: the field
 * that accepted the input is the field whose value *is* the input).
 */
function expectFor(entry: ActTrace, field: string, bindings: BindingLog): StateAssertion {
  const { delta } = entry;

  if (delta.urlChanged) return urlAssertion(delta.afterUrl, field, bindings);

  const target = asArtifactTarget(entry.target);

  if (entry.textAfter !== null && entry.textAfter !== entry.textBefore) {
    return { textEquals: { target, value: bindings.text(`${field}.textEquals.value`, entry.textAfter) } };
  }

  const anchor = delta.anchor;
  if (anchor === null) {
    // See the header: only an act that solely removed nodes reaches here, and no honest assertion is
    // left for it. Refusing is the point of `expect` being mandatory.
    throw new RecordingRefusedError(
      `the act on turn ${entry.turn} changed the page only by removing nodes, which leaves nothing ` +
        "the assertion vocabulary can point at — an `elementAbsent` would need a chain captured " +
        "while the element was still live, and the element was gone before the run could look. " +
        "Nothing is recorded for it, because a step whose `expect` had been invented would fail at " +
        "replay in a deployment with no way to tell why.",
    );
  }

  const anchored = asArtifactTarget(anchor.target);
  if (anchor.kind === "appeared") return { elementExists: anchored };
  return { textEquals: { target: anchored, value: bindings.text(`${field}.textEquals.value`, anchor.to) } };
}

/**
 * A URL as an assertion: the route's *shape* when it has one, and the observed location when it does
 * not.
 *
 * `routePattern` returns `null` for a path with no entity segment (`/search`), and §28's vacuity
 * rule means a `urlMatches` with no variable is rejected at validate — so the fallback is
 * `urlContains`, which validate accepts and which §4.2 calls "legal but asserts too little". The
 * fallback is made as strong as it honestly can be rather than merely legal: it binds declared
 * samples in the path *and the query*, so a search for a member reads `/search?memberId={memberId}`
 * instead of the bare `/search`. Dropping the query would discard the one part of the location that
 * says *which* member, which is exactly the binding §28 exists to preserve.
 */
function urlAssertion(url: string, field: string, bindings: BindingLog): StateAssertion {
  const pattern = routePattern(url);
  if (pattern !== null) return { urlMatches: pattern };

  let location = url;
  try {
    const parsed = new URL(url);
    location = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Not an absolute URL. The assertion is a substring test against whatever the page reports, so
    // the raw string is still a true — if weak — statement, and canonicalizing it is still right.
  }
  return { urlContains: bindings.text(`${field}.urlContains`, location) };
}

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `$1,204.55` — a currency amount as a legacy console renders one.
 *
 * A bare integer is deliberately **not** money, and the first version of this pattern got that wrong
 * in a way worth recording: `^[-$€£]?\d[\d,]*(?:\.\d{2})?$` accepts `12345`, so the fixture's
 * `memberId` was declared `type: "money"`. The lesson is about the sample, not the regex — an
 * identifier and a whole-dollar amount are the same string, so a pattern that accepts both is a
 * pattern that guesses. Requiring either a currency symbol or explicit cents leaves the ambiguous
 * case as `string`, which is what §4.2's own example declares a member id to be.
 */
const MONEY = /^(?:[-$€£]\d[\d,]*(?:\.\d{2})?|\d[\d,]*\.\d{2})$/;

/**
 * A declared input, from the sample the caller supplied.
 *
 * Two things are deliberately **not** derived, and both are decisions worth stating because §4.2's
 * example has them.
 *
 * **No `pattern`.** A pattern is a constraint that can refuse a legitimate caller, and one sample is
 * not evidence for a constraint: `--param amount=50` would become `^[0-9]{2}$` and reject `100`
 * against an app that accepts it. §4.1's own words are that "most inputs need no shape beyond their
 * type", so the recorder emits the type and leaves the narrowing to the review pass, where a person
 * who knows the app's id format can add it.
 *
 * **No sample in the text.** The description is the field a calling agent reads to learn what to
 * pass, and the artifact is the portable half of a recording — §7's whole premise is that this file
 * travels to another installation of the same product. Writing `the recording used the sample
 * '12345'` into it puts a tenant-specific literal in the one place §28 spends its effort keeping them
 * out of, and it does so through a field canonicalization cannot reach: a `{placeholder}` in prose
 * resolves to nothing, so §28's own boundary rule leaves descriptions alone. The sample is not lost —
 * it is in `run.jsonl`, where run evidence belongs.
 */
function toParam(sample: ParamSample): Param {
  return {
    name: sample.name,
    type: MONEY.test(sample.value) ? "money" : "string",
    description:
      `The caller supplies this as \`--${sample.name} <value>\`. Declared by the recorder from the ` +
      "run's own inputs; the review pass is where it earns a description of what the app expects.",
  };
}

function buildOutputs(
  named: NamedOutputs,
  plan: StepPlan,
  options: RecordOptions,
): Output[] {
  const fields = options.policy.document.redact.fieldPatterns.map(namePattern);

  return Object.entries(named.ids).map(([name, value]) => {
    const stepId = plan.stepIdForOutput.get(name);
    const read = plan.readForOutput.get(name);
    if (stepId === undefined || read === undefined) {
      throw new RecordingRefusedError(`output "${name}" lost its read between planning and emission`);
    }

    // §27's stamp, from two facts the run produced: the *name* the model gave the value, and the
    // *label* the app gave the node it was read from. Either can be the sensitive one — a value named
    // innocuously but read out of a field labelled "Taxpayer SSN" must still be redacted. The model's
    // own words are one of those two facts, which is why the label is kept as well as the identifier:
    // a policy pattern for `/taxpayer ssn/` has to be matched against what the model called it.
    const label = named.labels.get(name) ?? name;
    const redact = fields.some(
      (pattern) => pattern.matches(name) || pattern.matches(label) || pattern.matches(read.node.name),
    );

    return {
      name,
      type: MONEY.test(value) ? ("money" as const) : ("string" as const),
      source: { kind: "extract" as const, stepId },
      redact,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Output names                                                                */
/* -------------------------------------------------------------------------- */

interface NamedOutputs {
  /** The identifiers the artifact will use, in the order the model declared them. */
  readonly ids: Readonly<Record<string, string>>;
  /** Identifier → the words the model used, kept for §27's stamp. */
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * The model's labels, as names an artifact can use — the one translation discovery needs.
 *
 * `markComplete` names its outputs in the model's own words, and that is the right vocabulary for the
 * protocol: "current savings balance" is exactly what a person would call the value, and answering
 * "what did you read" in prose is not a mistake to correct. An `Output.name` is a different kind of
 * thing — it is a `{placeholder}`-legal identifier, because that is how a caller asks for it and how
 * an assertion names it — so the translation happens here rather than in the prompt. A prompt
 * instruction ("camel-case your output names") would be a rule the model can quietly break, at the
 * one point in the run where nobody is watching and the failure lands after the run is paid for.
 *
 * Every rename is a warning, because it is a thing the reviewer should see: the artifact says
 * `currentSavingsBalance` and the run log says the model called it `current savings balance`, and a
 * reader reconciling the two should not have to guess that they are the same value.
 */
function identifierOutputs(
  outputs: Readonly<Record<string, string>>,
  warnings: string[],
): NamedOutputs {
  const ids: Record<string, string> = {};
  const labels = new Map<string, string>();
  const taken = new Set<string>();

  for (const [label, value] of Object.entries(outputs)) {
    const base = identifierFor(label) ?? "output";
    // Two labels can reduce to one identifier ("current balance" and "currentBalance"), so a
    // collision is disambiguated rather than allowed to overwrite a value the run actually read.
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
    taken.add(name);
    labels.set(name, label);
    ids[name] = value;
    if (name !== label) {
      warnings.push(
        `the model named an output ${quoted(label)}, which the artifact calls "${name}" — an output ` +
          "name has to be usable as a {placeholder}, so the recorder translates the model's words " +
          "rather than emitting them",
      );
    }
  }

  return { ids, labels };
}

/**
 * One label as an identifier: `current savings balance` → `currentSavingsBalance`.
 *
 * Deliberately not a general slugifier. The rules are the three that a model's phrasing actually
 * needs, and each is here because of a way labels are really written: words are split on anything
 * non-alphanumeric ("balance ($)" → `balance`), a leading run of digits is dropped ("12345 balance"
 * echoes a value rather than naming one), and a leading word written in caps is lowercased ("SSN" →
 * `ssn`, while `member SSN` keeps the acronym as `memberSSN`). A label with no letters in it at all
 * has no identifier, and says so with `null` rather than inventing one.
 */
export function identifierFor(label: string): string | null {
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  const lead = words.findIndex((word) => !/^[0-9]+$/.test(word));
  if (lead === -1) return null;

  const [head = "", ...rest] = words.slice(lead);
  const first = head.replace(/^[0-9]+/, "");
  if (first === "") return null;
  const lower = first.length > 1 && first === first.toUpperCase() ? first.toLowerCase() : lowerFirst(first);

  const name = [lower, ...rest.map(capitalizeFirst)].join("");
  // The schema's rule, checked here rather than left to `validateCapability`: a recorder that emits a
  // name the schema refuses reports a malformed artifact instead of the label that caused it.
  return /^[A-Za-z_]/.test(name) ? name : null;
}

function lowerFirst(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1);
}

function capitalizeFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A label in quotes, so a multi-word one reads as one thing rather than as several words. */
function quoted(label: string): string {
  return `"${label}"`;
}
