/**
 * The error taxonomy (§5.2) — three classes, one vocabulary, and the single line of advice each code
 * carries.
 *
 * §5.2 classifies every way a run can end into exactly three families, and the classification is a
 * *response* rule rather than a labelling exercise: an expected business outcome stops the run
 * cleanly and hands the caller an answer; a recoverable condition is retried with backoff, dismissed
 * by a policy-known handler, or escalated; a hard failure stops and reports. The families are
 * disjoint here because they are disjoint there — a code that could be read as two of them would make
 * "what happens next" ambiguous, and this file is what replay consults to decide.
 *
 * The hint map is the other half. §5.3 asks that "every taxonomy code ships a `hint` one-liner
 * (problem + likely fix)", and §5.4 puts it in both the CLI's failure summary and README
 * troubleshooting. It is written as data with a totality guarantee rather than as a `switch` at each
 * render site, so the failure a caller cannot get advice for is a type error and a failing test
 * (`tests/unit/taxonomy.test.ts`) rather than a run that prints `hint: undefined`.
 *
 * Two codes sit outside §5.2's table and are named here anyway, because §5.3's contract has a slot
 * for them:
 *
 * - `HUMAN_UNAVAILABLE` — §5.3's own terminal for an escalation nobody answered (§8's lease and
 *   `timing.escalationTimeoutMs`). It is a *failure*, deliberately: the unattended path fails cleanly
 *   instead of parking forever.
 * - The discovery-stage codes. Discovery has no cursor, no `expect` and no retry budget, so a run that
 *   stops before emitting an artifact stops for reasons replay's table does not name: it thrashed
 *   (§8's budgets), the model declined the goal, the path needed an approval nothing could grant, or
 *   the harness itself threw. They are one-way — replay never produces them — which is why they get
 *   their own list rather than a fourth family.
 *
 * **Produced today vs. declared.** `DISCOVERY_CODES` and `NAVIGATION_BLOCKED` are what P4's `discover`
 * can emit. The rest are §5.2's vocabulary, complete and hinted, for P5's engine to classify into —
 * stated plainly so a reader does not take this table for an inventory of running code.
 */

/* -------------------------------------------------------------------------- */
/* The three families                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Class 1 — the app answered, and the answer is a legitimate outcome.
 *
 * These are the codes a capability's `outcomes[]` may declare, and they are why `RunResult` has a
 * `business-outcome` status at all: `NO_SUCH_ENTITY` is not a broken run, it is the run working.
 */
export const BUSINESS_OUTCOME_CODES = [
  "NO_SUCH_ENTITY",
  "VALIDATION_ERROR",
  "PERMISSION_DENIED",
  "RECORD_LOCKED",
] as const;

/**
 * Class 2 — the run can continue if the condition is handled.
 *
 * Four of the five are retried with backoff (§5.2's pinned terminals) and terminate *under their own
 * code* when the budget is spent — never escalated, because a slow or unreachable surface offers a
 * human nothing the retry budget did not already take. `SESSION_EXPIRED` is the exception and the
 * reason the class is not one rule: it always escalates, since no credential seam exists and inventing
 * one would mean storing credentials.
 */
export const RECOVERABLE_CODES = [
  "INTERSTITIAL_DIALOG",
  "SLOW_LOAD",
  "TRANSIENT_ERROR",
  "TRANSPORT_ERROR",
  "SESSION_EXPIRED",
] as const;

/** Class 3 — the run stops. All candidates failed, `expect` was false, or policy refused. */
export const HARD_FAILURE_CODES = [
  "ELEMENT_NOT_FOUND",
  "CHECKPOINT_MISMATCH",
  "NAVIGATION_BLOCKED",
  "UNEXPECTED_STATE",
] as const;

/** §5.3's own terminal: an escalation that went unanswered until `timing.escalationTimeoutMs`. */
export const ESCALATION_CODES = ["HUMAN_UNAVAILABLE"] as const;

/**
 * The discovery stage's endings (§4.2, §8) — the codes a run that never produced an artifact can
 * report. One per `DiscoveryEnding` kind, so nothing about how a discovery run stopped is lost in the
 * translation to a `RunResult`.
 */
export const DISCOVERY_CODES = ["STUCK", "GAVE_UP", "ESCALATION_REQUIRED", "DISCOVERY_FAILED"] as const;

export type BusinessOutcomeCode = (typeof BUSINESS_OUTCOME_CODES)[number];
export type RecoverableCode = (typeof RECOVERABLE_CODES)[number];
export type HardFailureCode = (typeof HARD_FAILURE_CODES)[number];
export type EscalationCode = (typeof ESCALATION_CODES)[number];
export type DiscoveryCode = (typeof DISCOVERY_CODES)[number];

export type TaxonomyCode =
  | BusinessOutcomeCode
  | RecoverableCode
  | HardFailureCode
  | EscalationCode
  | DiscoveryCode;

/* -------------------------------------------------------------------------- */
/* The hints                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One line per code: what happened, then the most likely fix. The audience is the person reading a
 * failed run at a terminal, so each is written as advice rather than as a restatement of the code —
 * "the id is probably wrong" is worth more than "the entity was not found", which the code already
 * said. Where the fix is genuinely "nothing, this is the answer", the hint says that too, because a
 * caller who reads `NO_SUCH_ENTITY` as a bug will go looking for one.
 */
export const HINTS: Readonly<Record<TaxonomyCode, string>> = {
  NO_SUCH_ENTITY:
    "the app reports no record for this input — it is a real answer, so check the id before treating " +
    "the run as broken; if the id is right, the record genuinely is not there",
  VALIDATION_ERROR:
    "the app refused the submitted values — usually a param the artifact accepts and the app does " +
    "not; check the value you passed against the field's own rules",
  PERMISSION_DENIED:
    "the app withheld this record from the current identity — nothing to fix in the run; call it " +
    "with an identity that may read it, or declare the outcome so callers get it as an answer",
  RECORD_LOCKED:
    "the record is locked by another user or process — a state that clears on its own; retry later, " +
    "or route it to a human rather than looping on it",

  INTERSTITIAL_DIALOG:
    "the app raised a dialog nothing expected — its text is a decision, so a human answers it; add " +
    "it to policy `recoverableDialogs` only if accepting it is always safe",
  SLOW_LOAD:
    "the page did not settle within policy `timing.waitForMs` and the retry budget is spent — raise " +
    "`waitForMs` for a genuinely slow surface, or check the app is loading at all",
  TRANSIENT_ERROR:
    "the app answered unusably (5xx, throttle, or a race) through the whole retry budget — re-run; " +
    "if it repeats, the surface is broken rather than slow",
  TRANSPORT_ERROR:
    "the origin never answered — connection refused or reset, DNS, or a dead browser session; check " +
    "the app is running and on the origin the policy allows",
  SESSION_EXPIRED:
    "the login screen appeared mid-flow and a session cannot be resumed without credentials, which " +
    "are never stored — sign in again and re-run the capability from a live session; a run longer " +
    "than the app's session lifetime will hit this every time",

  ELEMENT_NOT_FOUND:
    "every candidate in this step's target chain failed — the page moved under the artifact; check " +
    "the app for a rename, then re-record the capability",
  CHECKPOINT_MISMATCH:
    "the step ran but the page never showed what it expected — `observed` names what it showed " +
    "instead; if the app renders that state on purpose, update the artifact's `expect` to match it, " +
    "and re-record if you would rather not hand-edit the file",
  NAVIGATION_BLOCKED:
    "policy refused the action — the artifact wants something the allowlist forbids; allow the " +
    "origin or route in `policy.json`, or re-record a path that stays inside it",
  UNEXPECTED_STATE:
    "the page settled where no declared outcome and no `expect` describes — read `observed`; if the " +
    "app shows it deliberately, declare it as an outcome in the capability",
  HUMAN_UNAVAILABLE:
    "the escalation went unanswered until `timing.escalationTimeoutMs` and the run ended rather than " +
    "hanging — run it attended, or raise the timeout",

  STUCK:
    "the run stopped changing the page and §8's budget ended it — the last turns in the evidence " +
    "show the loop; give the goal a more concrete target or a clearer starting point",
  GAVE_UP:
    "the model reported it could not reach the goal — usually the app has no screen for what the " +
    "goal describes; read its reason in the run log",
  ESCALATION_REQUIRED:
    "an action on this path is approval-gated by policy and discovery has no operator to ask — " +
    "approve it in `policy.json`, or record a path that does not need it",
  DISCOVERY_FAILED:
    "the run ended on an exception rather than an outcome — that is a bug in the harness rather than " +
    "in the goal; read the last line of the run log for the message, and re-run once the cause is fixed",
};

/**
 * The hint for a code, or `null` when the code is not one this taxonomy names.
 *
 * `null` rather than a fallback sentence, because the codes that reach here unclaimed are legitimate:
 * a capability declares its own `outcomes[]`, and a curator may name one `MEMBER_RETIRED` — a code
 * this file has never heard of and should not pretend to advise on. The caller renders what it has.
 */
export function hintFor(code: string): string | null {
  return Object.hasOwn(HINTS, code) ? HINTS[code as TaxonomyCode] : null;
}

/** Every code this taxonomy names, for the totality test and for the README's troubleshooting table. */
export const ALL_CODES: readonly TaxonomyCode[] = [
  ...BUSINESS_OUTCOME_CODES,
  ...RECOVERABLE_CODES,
  ...HARD_FAILURE_CODES,
  ...ESCALATION_CODES,
  ...DISCOVERY_CODES,
];
