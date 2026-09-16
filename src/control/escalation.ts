/**
 * §8's escalation contract — what a run asks a human, and what the human's answer means.
 *
 * The contract lives in `src/control/` rather than in either of its two callers because it is the
 * seam *between* them: the replay engine (and, for its own endings, the discovery loop) raises a
 * request, and the Controller is the implementation that turns it into a leased human token over the
 * control bus. P5 shipped the same four facts with the engine as their home and `noOperator` as the
 * only implementation; P6 moves them here so the console, the bus and the engine cannot drift into
 * two shapes for one conversation (`src/control/escalation.ts` is §16's own entry for this).
 *
 * Four decisions are worth stating, because each one is a place where a plausible alternative would
 * have been wrong.
 *
 * 1. **A request is the *condition*, not the reason to stop.** `observed` carries what the app
 *    actually showed (the dialog's own words, the URL the login screen landed on) because the human
 *    is being asked to decide something, and §8's intervention payload is "full context" — a summary
 *    the operator cannot act on turns a takeover into a guess.
 * 2. **Three answers, and two of them end the run.** `took-over` is the only one that resumes;
 *    `declined` is a person saying no (the run ends, and says why), and `unavailable` is nobody
 *    answering inside `timing.escalationTimeoutMs` — §8's `HUMAN_UNAVAILABLE`, the terminal that
 *    exists so an unattended run fails cleanly instead of parking forever.
 * 3. **The answer carries the accounting.** P6's §25 carve-out needs to know whether the change the
 *    run found on handback was made through the console (attributable) or directly in a `--headed`
 *    window (detectable but unattributable), and only the Controller can see that. So a takeover
 *    reports `humanActions` and `accounted` beside its outcome, and the engine records
 *    `channel: direct-session` when the state moved without an accounting action.
 * 4. **A plain string is still an answer.** The three-state vocabulary is what the engine's seams
 *    were written against (and what the P5 tests return), so a handler may answer with the outcome
 *    alone; the extended form is what the Controller answers.
 */

import type { ApprovalHandler } from "../surface/session-driver.ts";

/** Where a run is in its life. §5.3 spells the same word in `failure.stage`. */
export type RunStage = "discovery" | "replay";

/**
 * Why a human is being asked.
 *
 * The first three are replay's (§5.2's recoverable middle and §6's approval gate). `STUCK` is
 * discovery's: §8 routes the stuck detector's verdict to `Controller.escalate` too, because "the
 * model cannot get anywhere" is precisely the condition a person can often resolve in one action —
 * and P6's rule is that the run then re-observes and continues rather than throwing the run away.
 */
export type EscalationCode = "INTERSTITIAL_DIALOG" | "SESSION_EXPIRED" | "APPROVAL_REQUIRED" | "STUCK";

/** §8's intervention request, as the engine raises it. */
export interface EscalationRequest {
  readonly code: EscalationCode;
  /** The step in flight, or `null` for the synthetic entry unit / a discovery turn with no step. */
  readonly stepId: number | null;
  /** Why a human is needed, in one sentence: the condition and what it means for the run. */
  readonly reason: string;
  readonly url: string;
  /** What the surface showed. The dialog's text, the login URL, the action policy gated. */
  readonly observed: string;
  /** Where the run's evidence is, so a reviewer can open what the operator saw. */
  readonly evidenceDir: string;
  /**
   * §8's payload names the run: which capability, at which stage.
   *
   * Optional because the Controller already knows which run it is serving — it is constructed with
   * the id and the stage — and a raiser that had to repeat them would be a second place they are
   * written. A raiser that *does* know them (the replay engine has the capability in hand) may pass
   * them anyway; the Controller fills whatever is missing.
   */
  readonly capabilityId?: string;
  readonly stage?: RunStage;
}

/** §5.3's three states, as the engine's seams speak them. */
export type EscalationOutcome = "took-over" | "declined" | "unavailable";

/**
 * A takeover, with the accounting §25 needs.
 *
 * `atEscalation`/`atHandback` are §8's state hashes either side of the human's control (the same
 * digest the stuck detector uses), so the engine can tell "nothing changed" from "something moved"
 * without asking the page twice more. `accounted` is true when the state the run finds on handback is
 * the state the console's last action produced — a change nothing in the console log explains is a
 * change made by an unattributable path (§25's direct-session case).
 */
export interface TakeoverAnswer {
  readonly outcome: "took-over";
  readonly humanActions: number;
  readonly accounted: boolean;
  readonly atEscalation: string;
  readonly atHandback: string;
}

/**
 * What a handler may answer: the outcome alone, or a takeover with its accounting.
 *
 * The union is deliberate rather than a mandatory detail object. A caller with nothing to account for
 * — a test, or a run with no operator attached — should not have to invent three fields to say "a
 * human did it", and every consumer below normalizes through `answerOutcome`/`answerDetail` rather
 * than reading the two shapes at each site.
 */
export type EscalationAnswer = EscalationOutcome | TakeoverAnswer;

export type EscalationHandler = (request: EscalationRequest) => Promise<EscalationAnswer>;

/** §5.3's vocabulary for the outcome, with the string form normalized first. */
export function answerOutcome(answer: EscalationAnswer): EscalationOutcome {
  return typeof answer === "string" ? answer : answer.outcome;
}

/** The takeover's accounting, or `null` for a plain answer (which has none to report). */
export function answerDetail(answer: EscalationAnswer): TakeoverAnswer | null {
  return typeof answer === "string" ? null : answer;
}

/**
 * The handler a run has when it has none: nothing can answer, so nothing does.
 *
 * It returns immediately rather than waiting out `escalationTimeoutMs`, and that is the whole point
 * of it existing: a wait with nothing on the other end is a run that hangs for ten minutes to learn
 * what it already knew. §8's terminal is the same either way — `HUMAN_UNAVAILABLE`, `no-operator` —
 * so the honest default is to arrive at it now. It is the default for every seam that is not wired to
 * a Controller, which is why it stays in the shipped code rather than in tests.
 */
export const noOperator: EscalationHandler = async () => "unavailable";

/**
 * §6's approval gate, asked of the escalation seam — the one mapping both runs share.
 *
 * The driver speaks two states (`approved`/`denied`); the seam speaks three
 * (`took-over`/`declined`/`unavailable`). Only a human who actually took control approves the action:
 * a decline and a silence both mean the run does not act, and the plan is explicit that a run with no
 * approval seam refuses rather than guessing that the human would have said yes.
 *
 * `stepId` is a function rather than a value because both callers have to answer it *at the moment of
 * the question*: the replay engine's step is the one in flight, and the discovery loop's step is the
 * turn the model is on. Passing a number would freeze whichever answer was true first.
 */
export function approvalFor(ask: EscalationHandler, stepId: () => number | null): ApprovalHandler {
  return async (request) => {
    const target = request.targetName === null ? "an unnamed target" : `"${request.targetName}"`;
    const answer = await ask({
      code: "APPROVAL_REQUIRED",
      stepId: stepId(),
      reason: `policy gated this action (${request.verdict.rule}): ${request.verdict.reason}`,
      url: request.url,
      observed: `${request.action.kind} on ${target}`,
      evidenceDir: request.evidenceDir,
    });
    return answerOutcome(answer) === "took-over" ? "approved" : "denied";
  };
}
