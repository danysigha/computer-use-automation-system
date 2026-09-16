/**
 * The replay engine — the cursor, the waiting, and §5.2's three families (§5.1–§5.3, §22, §27).
 *
 * Replay executes a recorded artifact with no model anywhere in the decision loop. Every question it
 * asks has an answer already written down: the candidate chain to resolve, the assertion to check,
 * the outcome signatures to match, the retry budget to spend. What this file decides is only *when*
 * to ask and *what an answer means* — which is where all of the phase's judgement lives.
 *
 * **One loop, and it is a settle loop.** §5.2 pins the precedence, so the poll order below is the
 * spec rather than a preference:
 *
 * 1. **declared outcome** — the artifact's `outcomes[]`, in declaration order, earliest wins;
 * 2. **recoverable with a policy handler** — a dialog policy knows how to answer;
 * 3. **escalate** — a dialog it does not, and a login screen mid-flow;
 * 4. **hard failure** — the step's own checkpoint.
 *
 * Everything is evaluated **only on a settled poll** (`readyState === "complete"` in every frame).
 * That is §5.2's "as each step's state settles", and it is doing three jobs at once: it stops a
 * half-rendered page from matching an outcome signature, it makes the assertion checks meaningful,
 * and it is what lets an `extract` be a single read — the step before it already proved the document
 * was complete.
 *
 * **A signature must be stable across two settled polls** (§4.1's soundness rule). So a settled poll
 * that matches spends the next poll confirming rather than checking the step's `expect`, and an
 * unsettled poll in between clears it. That ordering is deliberate: an artifact that declared
 * `NO_SUCH_ENTITY` has already said what the page means, and a stale `expect` must not be allowed to
 * pre-empt it — which is exactly the failure mode the "not a timeout crash" criterion names.
 *
 * **Where the two hard-failure codes divide, and why it has to be written down.** §5.2 gives
 * `CHECKPOINT_MISMATCH` the detection "`expect` false after timeout" and `SLOW_LOAD` the detection
 * "expected state not reached within `waitForMs`", which sound like one rule. §22 is what separates
 * them, and the split is about what a retry could possibly fix:
 *
 * - the state the step was waiting for **never arrived** inside the budget → `SLOW_LOAD`. The surface
 *   is slow; waiting longer is the one thing that might work, so it is retried with backoff and, when
 *   the budget is spent, terminates under its own code — never escalated (§22).
 * - the page **settled** and the expectation is still false → `CHECKPOINT_MISMATCH`. The surface
 *   answered with a stable wrong state; another attempt would see the same page, so it is terminal
 *   and immediate. Re-asking a question that has been answered is not a retry.
 *
 * "Never arrived" is wider than "never settled", and that is not a detail. A navigation whose
 * response has not come back leaves the *previous* document on screen, and that document reports
 * itself complete — so "the page settled" is true, and reading the split off `isSettled` alone would
 * file a target that never answered as a checkpoint mismatch. The poll's own reason for not passing
 * is the honest signal (`SettleState.navigationPending`), and it is what keeps a budget-spent slow
 * load terminating as `SLOW_LOAD`, which §22 pins.
 *
 * The same rule decides the two recoverable codes that are not throws: a `>= 500` document response
 * is a response (§5.2), so it is `TRANSIENT_ERROR` and retryable; a thrown `TimeoutError` from the
 * driver means the state never arrived, so it is `SLOW_LOAD`. And a dead driver session — a closed
 * browser, not a refused connection — is an immediate terminal `TRANSPORT_ERROR`, because §8's resume
 * rule is that the engine never guesses past a state it cannot verify.
 *
 * **What a retry actually does, and why it is not "do it again".** §22 says "retry the interrupted
 * step". The literal reading — issue the action a second time — is wrong for the case it is most
 * needed in, and the fixture is what shows it: a `?sim=slow` target delays the *entry navigation*,
 * and a re-issued navigation would arrive before the first response had landed and re-arm the delay
 * from scratch, so the retry would be strictly worse than waiting. So a retry first **re-checks the
 * previous attempt's expectation with a full budget**, and only re-issues the action if the state
 * genuinely is not what the step wanted. That is both the fixture's own design ("a retry meets a
 * surface that has recovered") and the double-fire guard §8 asks for: a click whose response was
 * merely slow is never clicked twice.
 *
 * **A navigation that is still outstanding is waited for, never re-issued.** The rule above is
 * sharpened by what re-issuing one actually does: it starts a fresh request and cancels the request
 * in flight, so a slow target would be given a *new* full delay on every attempt and could never
 * recover — the browser reporting the cancellation (`net::ERR_ABORTED`) rather than the slow load it
 * is. So when the re-check finds a navigation still pending, the attempt is spent looking again
 * instead of asking again, and the last attempt terminates under §22's pinned code with the URL the
 * browser never left as `observed`. Only the retry family reaches this: every other ending is
 * decided on the first answer.
 *
 * **A navigation is not "done" until the browser has actually left.** `isSettled` asks each frame for
 * its `readyState`, and a page that has been told to navigate but has not yet received a response is
 * still the *previous* document — `about:blank`, whose `readyState` is `"complete"`. So the poll
 * would call it settled and a navigation would pass instantly, which is precisely the bug that would
 * let the slow-target criterion pass on a page that never loaded. A navigation unit therefore also
 * requires `page.url()` to have moved off the URL it was on before the navigation was issued
 * (`Expectation.kind === "navigated"`), which is a claim about the *response having arrived* rather
 * than about the document that was already there.
 *
 * That doubt is only raised when there is one to have. `driver.execute` awaits the navigation's load
 * event, so a call that *returned* has produced its document and the URL comparison has nothing left
 * to answer — it is cleared, and the unit settles like any other. Keeping the comparison armed in
 * that case would fail a re-navigation to the URL the browser is already on, waiting for a change
 * that is never going to come.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Policy } from "../policy/policy.ts";
import { classify as classifyRisk, operationOf } from "../policy/risk.ts";
import type { Redactor } from "../policy/redact.ts";
import type { Capability, StateAssertion, Step } from "../schema/artifact.ts";
import type { IdentityEvidence } from "../surface/identity.ts";
import { quote } from "../surface/target.ts";
import {
  ApprovalRequiredError,
  type ActionContext,
  type ActionPolicy,
  type ApprovalHandler,
  type ApprovalRequest,
  type DialogObservation,
  type PolicyVerdict,
  type SessionDriver,
  type SurfaceAction,
} from "../surface/session-driver.ts";
import type { EvidenceLine } from "../surface/evidence.ts";
import {
  businessOutcomeResult,
  failureResult,
  successResult,
  type Escalation,
  type EvidenceRefs,
  type RunResult,
} from "./result.ts";
import {
  bind,
  bindDescriptor,
  checkAssertion,
  classifyError,
  describeAssertion,
  describeDescriptor,
  describeStep,
  matchOutcome,
  matchRecoverableDialog,
  parseMoney,
  type Classified,
  type OutcomeMatch,
  type Params,
} from "./step-runner.ts";

/** How often a settled-state poll runs. One interval is ~1% of the default 10s `waitForMs`. */
export const POLL_INTERVAL_MS = 100;

/**
 * How many dialogs one settle may answer before the next one is a failure.
 *
 * A number rather than "until it stops": a page that raises a dialog every time it is dismissed is a
 * loop, and a loop with no bound is a run that never ends. Two covers the real shapes (a
 * confirm-then-warn pair) and turns the pathological one into an honest `INTERSTITIAL_DIALOG`.
 */
export const MAX_DIALOG_ACTIONS = 2;

/* -------------------------------------------------------------------------- */
/* The escalation seam (§8)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a run asks a human, in replay's terms. §8's ControlBus payload arrives with P6; this is the
 * shape the engine needs today, and it is deliberately the same four facts either way — the
 * condition, the step, what the page showed, and where the evidence is.
 */
export interface EscalationRequest {
  readonly code: "INTERSTITIAL_DIALOG" | "SESSION_EXPIRED" | "APPROVAL_REQUIRED";
  readonly stepId: number | null;
  readonly reason: string;
  readonly url: string;
  readonly observed: string;
  readonly evidenceDir: string;
}

/** §8's answer, in the three states §5.3's `escalation` field can spell. */
export type EscalationOutcome =
  /** A human took control. The engine re-probes rather than assuming the step was done. */
  | "took-over"
  /** A human said no. The run ends the same way an unanswered escalation does, but says why. */
  | "declined"
  /** Nobody could answer — the default when nothing is wired. */
  | "unavailable";

export type EscalationHandler = (request: EscalationRequest) => Promise<EscalationOutcome>;

/**
 * The handler a run has when it has none: nothing can answer, so nothing does.
 *
 * It returns immediately rather than waiting out `escalationTimeoutMs`, and that is the whole point
 * of it existing in P5: the lease, the heartbeat and the timeout are the Controller's machinery
 * (P6), and a wait with nothing on the other end is a run that hangs for ten minutes to learn what it
 * already knew. §8's terminal is the same either way — `HUMAN_UNAVAILABLE`, `no-operator` — so the
 * honest default is to arrive at it now.
 */
export const noOperator: EscalationHandler = async () => "unavailable";

/**
 * The run state the seams share. Its one field the *policy* reads is `step`: §27 binds an artifact's
 * recorded gate to the step in flight, so the policy decorator below has to know which step that is,
 * and threading it through one object is what keeps the driver's `ActionPolicy` interface a single
 * method.
 */
export interface ReplayState {
  /** The step in flight. `null` for the synthetic entry unit, which no artifact recorded. */
  step: Step | null;
  /** What the last escalation answered, or `null` if none was raised. */
  escalation: EscalationOutcome | null;
  /** How many escalations this run raised, for the evidence and for tests. */
  count: number;
}

export interface ReplaySeams {
  readonly escalation: EscalationHandler;
  readonly approval: ApprovalHandler;
  readonly state: ReplayState;
}

/**
 * Wire the two seams replay needs onto one shared state.
 *
 * They are two views of one thing (§6's approval gate *is* §8's escalation — a gated action is a
 * decision a human makes), so the approval handler is implemented over the escalation handler rather
 * than beside it. The mapping is the point: the driver's two-way `approved`/`denied` is the
 * escalation's `took-over`/`declined`/`unavailable`, and only a human who actually took control
 * approves the action — a decline and a silence both mean the run does not act.
 */
export function replaySeams(options: { readonly escalation?: EscalationHandler } = {}): ReplaySeams {
  const state: ReplayState = { step: null, escalation: null, count: 0 };
  const ask = options.escalation ?? noOperator;

  const escalation: EscalationHandler = async (request) => {
    state.count += 1;
    const outcome = await ask(request);
    state.escalation = outcome;
    return outcome;
  };

  const approval: ApprovalHandler = async (request: ApprovalRequest) => {
    const target = request.targetName === null ? "an unnamed target" : `"${request.targetName}"`;
    return (await escalation({
      code: "APPROVAL_REQUIRED",
      stepId: state.step?.id ?? null,
      reason: `policy gated this action (${request.verdict.rule}): ${request.verdict.reason}`,
      url: request.url,
      observed: `${request.action.kind} on ${target}`,
      evidenceDir: request.evidenceDir,
    })) === "took-over"
      ? "approved"
      : "denied";
  };

  return { escalation, approval, state };
}

/** §5.3's vocabulary for an escalation that has happened. */
function escalationName(outcome: EscalationOutcome): Escalation {
  switch (outcome) {
    case "took-over":
      return "human-took-over";
    case "declined":
      return "declined";
    case "unavailable":
      return "no-operator";
  }
}

/* -------------------------------------------------------------------------- */
/* §27 — risk, bound on the stricter side                                      */
/* -------------------------------------------------------------------------- */

/**
 * The artifact's `risk` block, re-checked against the policy that is about to run (§27).
 *
 * §27's shape is the one §6 already uses for redaction — *artifact declaration or policy floor* — and
 * the direction matters: a policy tightened since the recording must take effect (the step runs
 * approval-gated and the upgrade is recorded), while a policy loosened since the recording must not
 * un-gate a step a human approved. So the two sides are unioned, never intersected.
 *
 * The static pass is best-effort by construction and says so: it classifies each `act` step from the
 * **recorded** descriptor's first candidate, which is what the artifact says the target was, rather
 * than from the element that actually resolves. The live classification at the choke point reads the
 * resolved element and is the one that decides — this pass exists so the *upgrade* is known before
 * the run starts and can be reported, not so it can replace the runtime verdict.
 */
export interface RiskCrossCheck {
  /** Steps that will run approval-gated: the artifact's declarations, plus what policy now adds. */
  readonly gated: ReadonlySet<number>;
  /** What the artifact itself declared, for the record. */
  readonly declared: ReadonlySet<number>;
  /** Steps policy now gates that the artifact did not — §27's "records the upgrade". */
  readonly upgraded: readonly number[];
  /** Steps policy now refuses outright. Reported, never fatal: the choke point is the enforcement. */
  readonly blocked: readonly number[];
  readonly notes: readonly string[];
}

/** The label and role a policy `text`/`fieldName` rule is matched against, from the recording. */
function recordedTarget(step: Extract<Step, { kind: "act" }>): { readonly name: string | null; readonly role: string | null } {
  const first = step.target.candidates[0];
  if (first === undefined) return { name: null, role: null };
  switch (first.strategy) {
    case "role":
      return { name: first.name, role: first.role };
    case "text":
      return { name: first.text, role: null };
    case "css":
      return { name: first.selector, role: null };
    case "row-relative":
      return { name: first.row.text, role: null };
  }
}

/** The action a recorded `act` step performs, with every literal bound. */
function actionForStep(step: Extract<Step, { kind: "act" }>, params: Params): SurfaceAction {
  const target = bindDescriptor(step.target, params);
  const value = step.value === undefined ? "" : bind(step.value, params);
  switch (step.action) {
    case "click":
      return { kind: "click", target };
    case "type":
      return { kind: "type", target, value };
    case "select":
      return { kind: "select", target, label: value };
    case "press":
      return { kind: "press", target, key: value };
  }
}

export function crossCheckRisk(capability: Capability, policy: Policy, params: Params): RiskCrossCheck {
  const declared: ReadonlySet<number> = new Set(capability.risk.irreversibleSteps);
  const gated = new Set(declared);
  const upgraded: number[] = [];
  const blocked: number[] = [];
  const notes: string[] = [];

  for (const step of capability.steps) {
    if (step.kind !== "act") continue;
    const action = actionForStep(step, params);
    const { name, role } = recordedTarget(step);
    const context: ActionContext = { action, targetName: name, targetRole: role };
    const verdict = classifyRisk(policy.document, context);
    if (verdict.allowed) continue;

    const what = `step ${step.id} (${operationOf(context)}${name === null ? "" : ` on "${name}"`})`;
    if (verdict.approvalRequired) {
      gated.add(step.id);
      if (!declared.has(step.id)) {
        upgraded.push(step.id);
        notes.push(
          `${what} is approval-gated by policy (${verdict.rule}) and was recorded as safe — ` +
            "it runs gated, and the upgrade is recorded (§27)",
        );
      }
      continue;
    }
    blocked.push(step.id);
    notes.push(`${what} is refused by policy (${verdict.rule}): ${verdict.reason} — the run stops there as NAVIGATION_BLOCKED`);
  }

  return { gated, declared, upgraded, blocked, notes };
}

/**
 * The driver's policy, with the artifact's own gate folded in — §27's "never un-gated".
 *
 * A decorator rather than a second classifier, because the rule it adds is one sentence: *the
 * stricter side wins*. It can only ever turn an `allowed` verdict into a gated one; a `blocked`
 * verdict passes through untouched, and a verdict the inner policy already gated keeps the inner
 * policy's rule name (the more specific one — "policy says a human must approve this field" beats
 * "the artifact marked the step").
 */
export class StricterPolicy implements ActionPolicy {
  readonly #inner: Policy;
  readonly #gated: ReadonlySet<number>;
  readonly #state: ReplayState;

  constructor(inner: Policy, gated: ReadonlySet<number>, state: ReplayState) {
    this.#inner = inner;
    this.#gated = gated;
    this.#state = state;
  }

  async review(context: ActionContext): Promise<PolicyVerdict> {
    const verdict = await this.#inner.review(context);
    if (!verdict.allowed) return verdict;

    const id = this.#state.step?.id;
    // A step the artifact recorded as irreversible is gated here even though the policy in force
    // permits it — the recorded approval is a fact about the recording, and a policy edit after the
    // fact cannot retract it.
    if (id === undefined || !this.#gated.has(id)) return verdict;

    return {
      allowed: false,
      approvalRequired: true,
      rule: "artifact.irreversibleSteps",
      reason:
        `the recorded artifact marks step ${id} irreversible (risk.irreversibleSteps), so it is ` +
        "approval-gated regardless of the current policy — a recorded gate is never un-gated (§27)",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReplayOptions {
  readonly capability: Capability;
  readonly driver: SessionDriver;
  /** The live policy. Its `timing` drives every budget and its `recoverableDialogs` the dialog rule. */
  readonly policy: Policy;
  /** The caller's inputs, already bound and validated against the artifact's `Param` patterns. */
  readonly params: Params;
  /** The URL the run starts from: `--entry`, or the artifact's `surface.entry`, interpolated. */
  readonly entry: string;
  /** True when `--entry` chose it, which makes it an override of the artifact's step-1 URL (§5.4). */
  readonly entryOverridden: boolean;
  /** §26's comparison, written to evidence on every run. `null` when the caller made none. */
  readonly identity?: IdentityEvidence | null;
  readonly seams?: ReplaySeams;
  /** Human-facing narration. The CLI sends it to stderr and to the run log. */
  readonly onNote?: (line: string) => void;
}

/** What a step is expected to be true about the page when its work is finished. */
type Expectation =
  /** The document has loaded. Enough for a `wait` or a read, neither of which names a state. */
  | { readonly kind: "settled" }
  /**
   * The document has loaded **and** the browser has left the URL it was on beforehand. See the file
   * header: a pending navigation still shows the previous document, and `about:blank` reports itself
   * complete, so "settled" alone would let a navigation pass before its response arrived.
   */
  | { readonly kind: "navigated"; readonly url: string }
  | { readonly kind: "assertion"; readonly assertion: StateAssertion };

/** A step, or the synthetic entry navigation, as one unit of work with one checkpoint. */
interface Unit {
  /** The artifact's step id, or `null` for the entry unit — which no artifact recorded. */
  readonly id: number | null;
  readonly step: Step | null;
  /** What the unit is, for a failure written before any assertion was evaluated. */
  readonly label: string;
  readonly expectation: Expectation;
  /** True when the unit's work is a read, which changes what a passed re-check means. */
  readonly reads: boolean;
  /** §5.4's `--entry` override applies to the artifact's step 1 when that step is a navigation. */
  readonly overrideWithEntry: boolean;
  /**
   * The URL the browser must have left for this unit's navigation to count as arrived — or `null`
   * when there is nothing being waited for: no navigation was issued, or the one that was issued has
   * already completed. Written by `navigate`, which is the only place either happens.
   *
   * It survives a retry unchanged, and that is the point: after a `goto` times out, this is the
   * original attempt's URL, which is what lets the late-landing check tell "the response finally
   * arrived" from "the page never moved".
   */
  urlBefore: string | null;
}

interface Context {
  readonly capability: Capability;
  readonly driver: SessionDriver;
  readonly policy: Policy;
  readonly params: Params;
  readonly entry: string;
  readonly redactor: Redactor;
  readonly seams: ReplaySeams;
  readonly evidence: EvidenceRefs;
  readonly note: (line: string) => void;
  readonly log: (line: EvidenceLine) => Promise<void>;
}

/** One unit's ending, before it is dressed as a `RunResult`. */
interface UnitFailure {
  readonly kind: "failed";
  readonly code: string;
  readonly expected: string;
  readonly observed: string;
  readonly escalation: Escalation;
  readonly stepId: number | null;
}

type UnitResult =
  | { readonly kind: "done"; readonly output: OutputValue | null }
  | { readonly kind: "outcome"; readonly match: OutcomeMatch }
  | UnitFailure;

/**
 * What doing a unit's work can conclude. Narrower than `UnitResult` on purpose: an outcome is
 * something the *poll* matches on the page, never something an action reports about itself, so a
 * `performUnit` that claimed one would be describing a page it had not looked at.
 */
type Performed = { readonly kind: "done"; readonly output: OutputValue | null } | UnitFailure;

interface OutputValue {
  readonly name: string;
  readonly value: unknown;
}

/** What the settle loop concluded. */
type Poll =
  | { readonly kind: "passed" }
  | { readonly kind: "outcome"; readonly match: OutcomeMatch }
  /**
   * A condition §22 retries: the caller decides whether to spend another attempt, and how.
   *
   * `navigationPending` is *why* it is worth another look, and the caller needs the reason rather
   * than only the code: a surface still working on a navigation has no answer yet, and re-issuing
   * the action would cancel the very response the retry is waiting for (see `runUnit`).
   */
  | { readonly kind: "retry"; readonly classified: Classified; readonly navigationPending: boolean }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly observed: string;
      readonly escalation: Escalation;
    };

export async function runReplay(options: ReplayOptions): Promise<RunResult> {
  const { capability, driver, policy, params } = options;
  const seams = options.seams ?? replaySeams();
  const evidence: EvidenceRefs = { runDir: driver.evidenceDir, runLog: driver.evidence.runLogPath };
  const note = options.onNote ?? ((): void => undefined);

  const context: Context = {
    capability,
    driver,
    policy,
    params,
    entry: options.entry,
    redactor: driver.redactor,
    seams,
    evidence,
    note,
    log: (line) => driver.log(line),
  };

  await context.log({
    kind: "note",
    subject: "replay",
    message: `replay: ${capability.id} — ${capability.steps.length} step(s) from ${options.entry}`,
    inputs: Object.fromEntries(params),
  });

  // §26's line, on every run regardless of verdict: a drifted-but-successful run is still a
  // `success`, and the only way that stays visible afterwards is if the run wrote it down.
  if (options.identity !== undefined && options.identity !== null) {
    await context.log({ kind: "note", subject: "appIdentity", ...options.identity });
    if (options.identity.verdict !== "match") note(`app identity: ${options.identity.reason}`);
  }

  const outputs: Record<string, unknown> = {};

  for (const unit of buildUnits(capability, options)) {
    seams.state.step = unit.step;
    await context.log({
      kind: "decision",
      subject: "step",
      stepId: unit.id,
      message: `step ${unit.id ?? "entry"}: ${unit.label}`,
    });
    note(`step ${unit.id ?? "entry"}: ${unit.label}`);

    const result = await runUnit(unit, context);
    switch (result.kind) {
      case "done":
        if (result.output !== null) outputs[result.output.name] = result.output.value;
        break;
      case "outcome":
        return answerOutcome(result.match, outputs, context);
      case "failed":
        return failureFrom(result, evidence);
    }
  }

  // Every step's checkpoint held. §5.3's `success` is the artifact's own statement about where the
  // run should end, so it gets its own check rather than being assumed from the last step's: the two
  // are different claims, and this is the only place `CHECKPOINT_MISMATCH` can mean "the flow
  // finished somewhere the capability did not call finished".
  const last = capability.steps.at(-1);
  const successUnit: Unit = {
    id: last?.id ?? null,
    step: last ?? null,
    label: `the success condition (${describeAssertion(capability.success, params)})`,
    expectation: { kind: "assertion", assertion: capability.success },
    reads: false,
    overrideWithEntry: false,
    urlBefore: null,
  };

  const final = await settle(successUnit, Date.now() + policy.document.timing.waitForMs, context);
  switch (final.kind) {
    case "passed":
      await context.log({ kind: "note", subject: "success", message: "the success condition holds" });
      note("success condition holds");
      return successResult(outputs, evidence);
    case "outcome":
      return answerOutcome(final.match, outputs, context);
    case "retry":
      // The success check runs after the cursor has already finished, so there is no attempt left to
      // spend: a condition that was still arriving when the budget ran out is reported under its own
      // code, which is §22's terminal without the retry it never got to make.
      return failureFrom(
        failedFromClassified(successUnit, final.classified, params),
        evidence,
      );
    case "failed":
      return failureFrom(failedFromPoll(successUnit, final, params), evidence);
  }
}

/**
 * The units a run executes, in order.
 *
 * The first one is synthetic whenever step 1 is not itself a `navigate`: an artifact recorded from a
 * run that began on the search form has no step for "get to the search form", and something has to go
 * there. When step 1 *is* a navigation there is no synthetic unit — §5.4's rule that `--entry`
 * "overrides the artifact's step-1 URL" is implemented by the unit itself, and adding an entry
 * navigation in front of it would make the artifact's first step a second hop to somewhere it never
 * went.
 */
function buildUnits(capability: Capability, options: ReplayOptions): readonly Unit[] {
  const units: Unit[] = [];
  const first = capability.steps[0];

  if (first === undefined || first.kind !== "navigate") {
    units.push({
      id: null,
      step: null,
      label: `load the entry page ${options.entry}`,
      expectation: { kind: "navigated", url: options.entry },
      reads: false,
      overrideWithEntry: false,
      urlBefore: null,
    });
  }

  for (const step of capability.steps) {
    const overrideWithEntry = options.entryOverridden && step === first && step.kind === "navigate";
    const url = overrideWithEntry ? options.entry : step.kind === "navigate" ? bind(step.url, options.params) : "";
    units.push({
      id: step.id,
      step,
      label: describeStep(step, options.params),
      expectation: expectationFor(step, url),
      reads: step.kind === "extract",
      overrideWithEntry,
      urlBefore: null,
    });
  }
  return units;
}

function expectationFor(step: Step, url: string): Expectation {
  switch (step.kind) {
    case "navigate":
      return { kind: "navigated", url };
    case "act":
      return { kind: "assertion", assertion: step.expect };
    case "assert":
      return { kind: "assertion", assertion: step.condition };
    // A `wait` has already waited by the time it is checked, and a read does its own resolving when
    // it runs. Both still need a settle poll, because the state after them is exactly where an
    // outcome signature or a dialog appears.
    case "wait":
    case "extract":
      return { kind: "settled" };
  }
}

/**
 * One unit, with §22's retry budget around it.
 *
 * The budget is `timing.retries` **additional** attempts (default 2 → three attempts total), spaced
 * by `timing.backoffMs`. Only the retry family is ever retried: everything else is terminal on the
 * first answer, and the terminal for a spent budget is the detected condition's own code — never
 * promoted, never escalated (§22's pinned terminal).
 */
async function runUnit(unit: Unit, context: Context): Promise<UnitResult> {
  const { retries, backoffMs, waitForMs } = context.policy.document.timing;
  let pending: Classified | null = null;

  for (let attempt = 0; ; attempt += 1) {
    let issue = true;
    if (attempt > 0) {
      // §22's "retry the interrupted step", done as a re-check first — see the file header. The
      // budget is the full one: the surface is exactly as slow as it was, so a shorter look would
      // conclude nothing the first attempt had not already concluded.
      const late = await settle(unit, Date.now() + waitForMs, context).catch(
        (error: unknown): Poll => ({
          kind: "retry",
          classified: classifyError(error),
          // An error thrown while re-checking says nothing about the surface's navigation, and the
          // action is the only way to find out — so this is the re-issue case, not the wait case.
          navigationPending: false,
        }),
      );
      if (late.kind === "outcome") return { kind: "outcome", match: late.match };
      if (late.kind === "failed") return failedFromPoll(unit, late, context.params);
      // A read unit's "passed" is not "already done" — nothing was read — so it falls through to be
      // read now that the page is finally sane. Everything else is genuinely finished, and re-issuing
      // its action is the double-fire this check exists to prevent.
      if (late.kind === "passed" && !unit.reads) {
        context.note("  the expectation already holds — the step is not repeated");
        return { kind: "done", output: null };
      }
      if (late.kind === "retry") {
        pending = late.classified;
        // The header's rule, applied where it can be: a **navigation** that is still outstanding is
        // asked to wait rather than asked again. Re-issuing it starts a fresh request and cancels
        // the one in flight — so the retry would re-arm the very delay it is waiting out, and the
        // browser reports the cancellation as `net::ERR_ABORTED` rather than as the slow load it is.
        // The attempt is therefore spent looking again, which is what the budget is for; the next
        // attempt re-checks, and the last one terminates under §22's pinned code (`SLOW_LOAD`, whose
        // `observed` names the URL the browser never left).
        //
        // Whether anything is *in flight* is the poll's call, not this one's: it reports a
        // navigation as pending only when the URL is unmoved and no document request failed, and a
        // failed one comes back as a transport retry that is re-issued like any other.
        //
        // Everything else *is* re-issued when its re-check finds the state still absent, because for
        // an action the alternative — never asking again — is the strict worse one: a click whose
        // response was merely slow has already been answered by the re-check above (`passed`), and
        // one that was not has to be asked for again.
        issue = !(late.navigationPending && unit.expectation.kind === "navigated");
        if (!issue) {
          // Its own subject, next to the two it sits between: a reader filtering `retry` gets the
          // attempts that re-asked, and this line is the one that explains why this attempt did not.
          await context.log({
            kind: "note",
            subject: "retry-wait",
            message: `${late.classified.code}: the navigation is still outstanding — waiting for it rather than re-issuing it`,
            errorCode: late.classified.code,
            attempt: attempt + 1,
          });
          context.note(`  ${late.classified.code} — still navigating; waiting rather than re-issuing`);
        }
      }
    }

    if (issue) {
      try {
        const performed = await performUnit(unit, context);
        if (performed.kind === "failed") return performed;

        const poll = await settle(unit, Date.now() + waitForMs, context);
        switch (poll.kind) {
          case "passed":
            return { kind: "done", output: performed.output };
          case "outcome":
            return { kind: "outcome", match: poll.match };
          case "failed":
            return failedFromPoll(unit, poll, context.params);
          case "retry":
            pending = poll.classified;
        }
      } catch (error: unknown) {
        // §6's approval gate, resolved by what the seam answered. Caught here rather than classified
        // because the escalation *already happened* inside the driver — the engine only has to report
        // which of §5.3's three escalation states the run ended in.
        if (error instanceof ApprovalRequiredError) {
          const outcome = context.seams.state.escalation ?? "unavailable";
          return {
            kind: "failed",
            code: outcome === "unavailable" ? "HUMAN_UNAVAILABLE" : "NAVIGATION_BLOCKED",
            expected: expectedFor(unit, context.params),
            observed: error.message,
            escalation: escalationName(outcome),
            stepId: unit.id,
          };
        }
        const classified = classifyError(error);
        if (!classified.retryable) return failedFromClassified(unit, classified, context.params);
        pending = classified;
      }
    }

    const classified: Classified = pending ?? {
      code: "UNEXPECTED_STATE",
      retryable: false,
      observed: "the step ended without an error to report",
    };
    if (attempt >= retries) {
      await context.log({
        kind: "note",
        subject: "retry-budget",
        message: `${classified.code}: the retry budget is spent after ${attempt + 1} attempt(s) — terminating`,
        errorCode: classified.code,
      });
      return failedFromClassified(unit, classified, context.params);
    }

    const backoff = backoffMs[attempt] ?? 0;
    await context.log({
      kind: "note",
      subject: "retry",
      message: `${classified.code} on attempt ${attempt + 1}: ${classified.observed} — retrying in ${backoff}ms`,
      errorCode: classified.code,
      attempt: attempt + 1,
    });
    context.note(`  ${classified.code} — retrying in ${backoff}ms`);
    await sleep(backoff);
  }
}

/** Do one unit's work. For everything but a read this is the action; for a read it is the read. */
async function performUnit(unit: Unit, context: Context): Promise<Performed> {
  const { driver, params } = context;
  const step = unit.step;

  if (step === null) {
    await navigate(unit, context, context.entry);
    return { kind: "done", output: null };
  }

  switch (step.kind) {
    case "navigate":
      await navigate(unit, context, unit.overrideWithEntry ? context.entry : bind(step.url, params));
      return { kind: "done", output: null };
    case "wait":
      if (step.condition === "fixed") await sleep(step.ms ?? 0);
      return { kind: "done", output: null };
    case "act": {
      // A `type`/`select`/`press` with no `value` is a shape the schema allows and no correct run can
      // produce. Reported as what it is — the artifact is not executable — rather than defaulted,
      // because a silently-empty value would look exactly like a working step.
      if (step.action !== "click" && step.value === undefined) {
        return {
          kind: "failed",
          code: "UNEXPECTED_STATE",
          expected: describeStep(step, params),
          observed: `step ${step.id} declares a \`${step.action}\` with no \`value\` to act with`,
          escalation: "none",
          stepId: unit.id,
        };
      }
      await driver.execute(actionForStep(step, params));
      return { kind: "done", output: null };
    }
    case "extract": {
      const descriptor = bindDescriptor(step.target, params);
      const read = await driver.read(descriptor);
      const declared = context.capability.outputs.find((output) => output.source.stepId === step.id);
      let value: unknown = read.text;
      if (declared?.type === "money") {
        const money = parseMoney(read.text);
        if (money === null) {
          return {
            kind: "failed",
            code: "UNEXPECTED_STATE",
            expected: `${describeDescriptor(descriptor)} reads as an amount`,
            observed: `${describeDescriptor(descriptor)} shows ${quote(read.text)}, which is not an amount`,
            escalation: "none",
            stepId: unit.id,
          };
        }
        value = money;
      }
      // §6/§27's precedence, applied where the value first exists: artifact declaration or policy
      // floor. Registered with the run's redactor, so one decision covers the summary, `--json` and
      // the run log rather than three render sites that could disagree.
      const decided = context.redactor.output(step.name, value, declared?.redact ?? false);
      await context.log({
        kind: "observation",
        subject: "output",
        stepId: step.id,
        name: step.name,
        type: declared?.type ?? "string",
        redacted: decided.redacted,
        value: decided.value,
      });
      context.note(`  read ${step.name}${decided.redacted ? " (redacted)" : ""}`);
      return { kind: "done", output: { name: step.name, value: decided.value } };
    }
    case "assert":
      return { kind: "done", output: null };
  }
}

/**
 * Issue a navigation and record what is left to wait for — the one place a navigation is performed,
 * because the two things it must get right are easy to get right in one place and easy to forget in
 * two.
 *
 * `urlBefore` is written **before** the navigation is issued, so a `goto` that times out leaves
 * behind the URL the browser must leave for the response to have arrived (`Expectation`), and it is
 * cleared **after** the call returns — a resolved `goto` has produced its document, so the
 * comparison is discharged rather than left armed. Nothing is overwritten on the way in: across a
 * retry the URL that matters is the *first* attempt's, because that is what tells "the response
 * finally landed" from "the page never moved".
 */
async function navigate(unit: Unit, context: Context, url: string): Promise<void> {
  unit.urlBefore ??= context.driver.page.url();
  await context.driver.execute({ kind: "navigate", url });
  unit.urlBefore = null;
}

/* -------------------------------------------------------------------------- */
/* The settle loop (§5.2's precedence, in order)                               */
/* -------------------------------------------------------------------------- */

/** The loop's own memory across polls. One object, so a handler can update it in place. */
interface SettleState {
  /** The outcome code seen on the last settled poll, and how many polls in a row have seen it. */
  streak: { readonly code: string; readonly count: number } | null;
  /** What the last settled poll saw, for `observed` when the budget runs out. */
  lastObserved: string;
  everSettled: boolean;
  /**
   * Did the last poll decline to pass because the *navigation's response has not arrived*, rather
   * than because the state is wrong? The two are §22's split (see the header), and this flag is why
   * the split is read off the poll's own reason instead of off `isSettled` — a pending navigation
   * leaves a complete-looking previous document on screen, so "settled" alone would file a surface
   * that never answered as a checkpoint mismatch.
   */
  navigationPending: boolean;
  dialogsAnswered: number;
  /**
   * A dialog a human was already asked about, and a login screen likewise. Both are re-probed after
   * a take-over — the human may have dealt with it — and both are terminal when the same condition
   * is *still* standing afterwards, which is what stops "escalate, resume, escalate, resume" from
   * being an unbounded loop.
   */
  dialogEscalatedOver: string | null;
  sessionEscalated: boolean;
}

/**
 * Poll until the expectation holds, a condition fires, or the budget ends.
 *
 * At least one poll always runs, and each iteration either returns or burns an interval, so the loop
 * terminates on the clock rather than on a counter — which is what makes a `waitForMs` of `0` mean
 * "ask once" instead of "ask never".
 */
async function settle(unit: Unit, deadline: number, context: Context): Promise<Poll> {
  const state: SettleState = {
    streak: null,
    lastObserved: "the page showed nothing this step's expectation describes",
    everSettled: false,
    navigationPending: false,
    dialogsAnswered: 0,
    dialogEscalatedOver: null,
    sessionEscalated: false,
  };

  for (;;) {
    // Cleared here rather than set false in each arm: the flag is a claim about *this* poll, and one
    // place that forgets to clear it would leave a stale "still waiting" behind a page that has since
    // answered — the exact misclassification the flag exists to prevent.
    state.navigationPending = false;

    const settled = await context.driver.isSettled().catch(() => true);
    if (settled) {
      state.everSettled = true;

      // 1. The artifact's declared outcomes, in declaration order (§5.2). Nothing outranks them —
      //    not a dialog, not a checkpoint — because a declared signature is the app's own answer.
      const match = await probeOutcomes(context);
      if (match !== null) {
        state.streak =
          state.streak?.code === match.outcome.code
            ? { code: match.outcome.code, count: state.streak.count + 1 }
            : { code: match.outcome.code, count: 1 };
        state.lastObserved = describeMatch(match);
        // §4.1: stable across ≥2 consecutive settled polls. Until then the poll is spent confirming,
        // so a step's now-stale `expect` cannot pre-empt an answer the artifact already declared.
        if (state.streak.count >= 2) return { kind: "outcome", match };
        if (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        // Out of budget on the very poll the signature appeared, so it could not be confirmed. Not
        // returned as an outcome — §4.1's soundness rule exists because a signature that fires
        // spuriously ends a run with an answer the app never gave — but not hidden either: the
        // failure names the signature it saw once.
        state.lastObserved = `${describeMatch(match)}, but it was not stable across two settled polls`;
      } else {
        state.streak = null;

        // 2. A recoverable condition policy knows how to answer, and 3. one it does not.
        const dialog = await context.driver.findDialog().catch(() => null);
        if (dialog !== null) {
          const answered = await handleDialog(dialog, unit, state, context);
          if (answered !== null) return answered;
          continue;
        }
        state.dialogEscalatedOver = null;

        const expired = await context.driver.hasPasswordField().catch(() => false);
        if (expired) {
          const answered = await handleSessionExpiry(unit, state, context);
          if (answered !== null) return answered;
          continue;
        }
        state.sessionEscalated = false;

        // A 5xx is a *response*, not a transport failure (§5.2), so it is TRANSIENT_ERROR and
        // retryable. Checked before the checkpoint: a page that answered unusably has not answered
        // the step's question, even when its URL happens to be the one the step wanted.
        const status = context.driver.lastDocumentStatus();
        if (status !== null && status >= 500) {
          return {
            kind: "retry",
            classified: {
              code: "TRANSIENT_ERROR",
              retryable: true,
              observed: `the app answered HTTP ${status} for the page the step needs`,
            },
            // The app *answered* — badly — so the next attempt is a fresh question rather than a
            // longer wait for this one.
            navigationPending: false,
          };
        }

        // 4. The step's own checkpoint.
        const held = await checkExpectation(unit, state, context);
        if (held !== null) return held;
      }
    } else {
      state.streak = null;
      state.lastObserved = "the page was still loading";
    }

    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // The split §22 draws, and the reason it is not cosmetic: a surface that is merely slow is worth
  // retrying, and a surface that has answered with a stable wrong state is not (see the file header).
  // Both halves of "the state never arrived" are here — a page still loading, and a navigation whose
  // response is still outstanding — because a retry is the right answer to each and neither is a
  // statement the app made.
  if (!state.everSettled || state.navigationPending) {
    return {
      kind: "retry",
      classified: {
        code: "SLOW_LOAD",
        retryable: true,
        observed: state.everSettled
          ? state.lastObserved
          : `the page never finished loading within ${context.policy.document.timing.waitForMs}ms`,
      },
      // True for every way a navigation can be outstanding — a response that has not arrived, and a
      // document that is still loading — because both mean the surface has not finished with this
      // navigation, and both are cancelled by re-issuing it.
      navigationPending: true,
    };
  }
  return { kind: "failed", code: "CHECKPOINT_MISMATCH", observed: state.lastObserved, escalation: "none" };
}

/** Step 4 of the poll: the unit's own checkpoint, or `null` to keep polling. */
async function checkExpectation(unit: Unit, state: SettleState, context: Context): Promise<Poll | null> {
  switch (unit.expectation.kind) {
    case "settled":
      return { kind: "passed" };
    case "navigated": {
      // A call that returned has produced its document — `navigate` clears `urlBefore` when the driver
      // resolves — so there is nothing left to ask about it, not even of the failure below: a redirect
      // or a subresource that aborted does not turn a page that rendered into one that did not.
      if (unit.urlBefore === null) return { kind: "passed" };

      const here = context.driver.page.url();
      // "The browser is somewhere else" and "a document arrived" are two different questions, and the
      // address alone answers the wrong one: a *failed* navigation puts Chromium's error page at the
      // requested URL, so a target that refused the connection looks exactly like one that answered.
      // The failure is only read as the cause when no response came back either — a request that
      // aborted while the page it was racing rendered (`ERR_ABORTED` on a redirect chain) is the case
      // where the failure is real and the page is fine.
      const failure = context.driver.lastNavigationFailure();
      if (failure !== null && context.driver.lastDocumentStatus() === null) {
        return {
          kind: "retry",
          classified: {
            code: "TRANSPORT_ERROR",
            retryable: true,
            observed: `the navigation to ${unit.expectation.url} delivered no document (${failure})`,
          },
          // Nothing is in flight — the request is over, and over badly — so the next attempt is the
          // fresh question §5.2 means by a transport retry, not a longer wait for this one.
          navigationPending: false,
        };
      }
      if (here !== unit.urlBefore) return { kind: "passed" };
      state.navigationPending = true;
      state.lastObserved =
        `the browser is still at ${here}, where it was before the navigation to ` +
        `${unit.expectation.url} — the response has not arrived`;
      return null;
    }
    case "assertion": {
      const outcome = await checkAssertion(
        unit.expectation.assertion,
        context.driver,
        context.driver.page.url(),
        context.params,
      );
      state.lastObserved = outcome.observed;
      return outcome.ok ? { kind: "passed" } : null;
    }
  }
}

/** The artifact's outcome signatures against the page as it is now. */
async function probeOutcomes(context: Context): Promise<OutcomeMatch | null> {
  const text = await context.driver.visibleText().catch(() => "");
  return matchOutcome(text, context.capability.outcomes, (descriptor) =>
    context.driver.resolves(bindDescriptor(descriptor, context.params)).catch(() => false),
  );
}

function describeMatch(match: OutcomeMatch): string {
  return `the page shows ${quote(match.evidence)}, the signature for ${match.outcome.code}`;
}

/**
 * A dialog on the page: policy's answer if it has one, a human's otherwise (§5.2). Returns the
 * ending, or `null` to keep polling — the caller has been answered and the page is worth re-reading.
 *
 * Answering goes through `driver.execute`, so a dialog control is resolved, policy-reviewed and
 * recorded like every other action — the fixture's `OK` link is a policy-checked click, not a
 * shortcut around the choke point. A dialog policy knows and *cannot address* is treated as one
 * policy does not know, because "accept this" is not an instruction anyone can carry out.
 */
async function handleDialog(
  dialog: DialogObservation,
  unit: Unit,
  state: SettleState,
  context: Context,
): Promise<Poll | null> {
  if (state.dialogEscalatedOver === dialog.text) {
    return {
      kind: "failed",
      code: "INTERSTITIAL_DIALOG",
      observed: `a human took over and the dialog is still standing: ${dialog.text}`,
      escalation: "human-took-over",
    };
  }

  const known = matchRecoverableDialog(dialog.text, context.policy.document.recoverableDialogs);
  if (known !== null && dialog.control !== null) {
    if (state.dialogsAnswered >= MAX_DIALOG_ACTIONS) {
      return {
        kind: "failed",
        code: "INTERSTITIAL_DIALOG",
        observed: `${state.dialogsAnswered + 1} dialogs raised in one step, the latest: ${dialog.text}`,
        escalation: "none",
      };
    }
    context.note(`  ${known.response}ing the policy-known dialog (${dialog.via})`);
    await context.log({
      kind: "decision",
      subject: "dialog",
      stepId: unit.id,
      decision: known.response,
      rule: "policy.recoverableDialogs",
      observed: dialog.text,
    });
    // `dismiss` presses Escape on the control rather than clicking it: the control is what the
    // resolver can address, and Escape is the gesture that declines a modal without activating it.
    await context.driver.execute(
      known.response === "accept"
        ? { kind: "click", target: dialog.control }
        : { kind: "press", target: dialog.control, key: "Escape" },
    );
    state.dialogsAnswered += 1;
    return null;
  }

  const unaddressable = known !== null && dialog.control === null;
  if (unaddressable) {
    context.note("  the dialog is policy-known but has no control this run can address — asking a human");
  }

  const outcome = await context.seams.escalation({
    code: "INTERSTITIAL_DIALOG",
    stepId: unit.id,
    reason: unaddressable
      ? "the app raised a policy-known dialog whose control cannot be resolved, so the run cannot answer it"
      : "the app raised a dialog that policy does not list in `recoverableDialogs`, and the choice is a human one",
    url: context.driver.page.url(),
    observed: dialog.text,
    evidenceDir: context.evidence.runDir,
  });

  if (outcome === "took-over") {
    state.dialogEscalatedOver = dialog.text;
    return null;
  }
  return {
    kind: "failed",
    code: outcome === "declined" ? "INTERSTITIAL_DIALOG" : "HUMAN_UNAVAILABLE",
    observed: `the app raised a dialog: ${dialog.text}`,
    escalation: escalationName(outcome),
  };
}

/**
 * A login screen mid-flow: §5.2's `SESSION_EXPIRED`, which **always escalates**.
 *
 * There is no session seam and there never will be one — resuming a session means holding
 * credentials, and the plan's answer to that is that a human signs in. So the engine's job is to
 * notice, ask, and then *re-verify* rather than assume: the login page may as well have been a
 * redirect the engine misread.
 */
async function handleSessionExpiry(unit: Unit, state: SettleState, context: Context): Promise<Poll | null> {
  const here = context.driver.page.url();
  if (state.sessionEscalated) {
    return {
      kind: "failed",
      code: "SESSION_EXPIRED",
      observed: `a human took over and the login screen is still standing at ${here}`,
      escalation: "human-took-over",
    };
  }

  const outcome = await context.seams.escalation({
    code: "SESSION_EXPIRED",
    stepId: unit.id,
    reason:
      "a password field appeared mid-flow, so the session expired — resuming it needs credentials " +
      "this run does not hold, and a human signs in instead",
    url: here,
    observed: `a login form is showing at ${here}`,
    evidenceDir: context.evidence.runDir,
  });

  if (outcome === "took-over") {
    state.sessionEscalated = true;
    return null;
  }
  return {
    kind: "failed",
    code: outcome === "declined" ? "SESSION_EXPIRED" : "HUMAN_UNAVAILABLE",
    observed: `the session expired at ${here} and the login screen is showing`,
    escalation: escalationName(outcome),
  };
}

/* -------------------------------------------------------------------------- */
/* Dressing a unit's ending as §5.3's contract                                 */
/* -------------------------------------------------------------------------- */

/**
 * §5.3's `expected`, in the artifact's own terms.
 *
 * It is derived from the **unit's own expectation** rather than from the step kind again, because the
 * expectation is what the loop actually checked — and where the two could differ (a navigation whose
 * URL `--entry` overrode, a unit that never got as far as acting) the line has to describe the check
 * that failed rather than the step as it was recorded.
 */
function expectedFor(unit: Unit, params: Params): string {
  const { expectation, step } = unit;
  switch (expectation.kind) {
    case "settled":
      return step === null ? `${unit.label} loads` : describeStep(step, params);
    case "navigated":
      return step === null || step.kind !== "navigate" || step.url !== expectation.url
        ? `the browser leaves ${unit.urlBefore ?? "the page it was on"} and loads ${expectation.url}`
        : describeStep(step, params);
    case "assertion":
      return describeAssertion(expectation.assertion, params);
  }
}

function failedFromPoll(unit: Unit, poll: Extract<Poll, { kind: "failed" }>, params: Params): UnitFailure {
  return {
    kind: "failed",
    code: poll.code,
    expected: expectedFor(unit, params),
    observed: poll.observed,
    escalation: poll.escalation,
    stepId: unit.id,
  };
}

function failedFromClassified(unit: Unit, classified: Classified, params: Params): UnitFailure {
  return {
    kind: "failed",
    code: classified.code,
    expected: expectedFor(unit, params),
    observed: classified.observed,
    escalation: "none",
    stepId: unit.id,
  };
}

/**
 * §5.2's first class: a declared outcome matched, so the run stops cleanly and hands the caller an
 * answer. Outputs read before the outcome fired travel with it — §5.3 makes them optional on this
 * variant precisely for the case where part of the answer was already in hand.
 */
function answerOutcome(match: OutcomeMatch, outputs: Record<string, unknown>, context: Context): RunResult {
  const message = bind(match.outcome.message, context.params);
  context.note(`business outcome: ${match.outcome.code} — ${message}`);
  return businessOutcomeResult({
    code: match.outcome.code,
    message,
    ...(Object.keys(outputs).length === 0 ? {} : { outputs }),
  });
}

function failureFrom(failed: UnitFailure, evidence: EvidenceRefs): RunResult {
  return failureResult({
    stage: "replay",
    errorCode: failed.code,
    expected: failed.expected,
    observed: failed.observed,
    ...(failed.stepId === null ? {} : { stepId: failed.stepId }),
    evidence,
    escalation: failed.escalation,
  });
}
