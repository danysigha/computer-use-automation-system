/**
 * The pieces one step is made of (§5.1, §5.2, §28) — and deliberately not the loop that drives them.
 *
 * `engine.ts` owns the cursor, the ordering and the result; this file owns the questions a step asks
 * of a page and the answers it gets back. The split is the usual one for this repo: everything here
 * is either pure or a single read through the driver's seam, so the classification rules — which are
 * the part §5.2 pins and an evaluator will read — can be tested without a browser, and the engine
 * above can be read as control flow rather than as a pile of string handling.
 *
 * Four things live here, and each has a reason for being a function rather than a line in the loop:
 *
 * 1. **Binding (`bind`).** §9's rule, at replay: a `{param}` is the caller's value. `validate.ts`
 *    has already proven every placeholder names a declared input and the CLI has already refused to
 *    start without a value for each, so a placeholder that reaches here unresolved is unreachable —
 *    it is left literal rather than thrown on, because a thrown error from inside a URL template
 *    would report a harness bug as a run outcome.
 * 2. **The assertions (`checkAssertion`, `describeAssertion`).** Five shapes, one checker and one
 *    describer, because `expected`/`observed` in a failure has to be written by the same code that
 *    decided the check failed — a second describer is a second opinion about what the run wanted.
 * 3. **The route matcher (§28).** `{param}` interpolates the caller's value, `:name` matches any
 *    single non-empty segment, anchored, **against the URL's path**. Path-only is not a shortcut:
 *    `canonicalize.ts` drops the query when it writes a pattern, so a matcher that considered the
 *    query would accept patterns the recorder can never emit and reject shapes it does.
 * 4. **The classifier (`classifyError`).** One place turns a thrown thing into §5.2's vocabulary,
 *    plus the one bit the engine needs from it: whether the code's family is retried with backoff
 *    or stops the run. That bit is the pinned terminal of §22 — the retry family ends as `failure`
 *    under its own code and is never escalated — so it is written as data next to the code, not
 *    re-derived at the call site.
 */
import type { BusinessOutcome, StateAssertion, Step } from "../schema/artifact.ts";
import {
  ElementNotFoundError,
  FramePathError,
  normalizeText,
  quote,
  type TargetCandidate,
  type TargetDescriptor,
} from "../surface/target.ts";
import { ApprovalRequiredError, PolicyBlockedError, type SessionDriver } from "../surface/session-driver.ts";
import { RECOVERABLE_CODES, type TaxonomyCode } from "./taxonomy.ts";
import { textPattern } from "../policy/pattern.ts";
import type { RecoverableDialog } from "../policy/policy.ts";

/** The caller's inputs, by the name the artifact declared them under. */
export type Params = ReadonlyMap<string, string>;

/* -------------------------------------------------------------------------- */
/* Binding                                                                     */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** A `{param}` field, with the caller's value substituted. See the header's note 1. */
export function bind(template: string, params: Params): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => params.get(name) ?? whole);
}

/** A whole target descriptor, bound field by field — the object the resolver actually gets. */
export function bindDescriptor(descriptor: TargetDescriptor, params: Params): TargetDescriptor {
  return {
    candidates: descriptor.candidates.map((candidate) => bindCandidate(candidate, params)),
    ...(descriptor.framePath === undefined ? {} : { framePath: descriptor.framePath }),
  };
}

function bindCandidate(candidate: TargetCandidate, params: Params): TargetCandidate {
  switch (candidate.strategy) {
    case "role":
      return { strategy: "role", role: candidate.role, name: bind(candidate.name, params) };
    case "text":
      return { strategy: "text", text: bind(candidate.text, params) };
    case "css":
      return { strategy: "css", selector: candidate.selector, index: candidate.index };
    case "row-relative":
      return {
        strategy: "row-relative",
        row: { by: "cell-text", text: bind(candidate.row.text, params) },
        ...(candidate.column === undefined ? {} : { column: { by: "header-text" as const, text: bind(candidate.column.text, params) } }),
        action: candidate.action,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Describing what a step wants                                                */
/* -------------------------------------------------------------------------- */

/** `role=button[name="Continue"]` — one candidate, as the run log and `observed` spell it. */
export function describeCandidate(candidate: TargetCandidate): string {
  switch (candidate.strategy) {
    case "role":
      return `role=${candidate.role}[name=${quote(candidate.name)}]`;
    case "text":
      return `text=${quote(candidate.text)}`;
    case "css":
      return `css=${quote(candidate.selector)}[${candidate.index}]`;
    case "row-relative":
      return `row-relative[row=${quote(candidate.row.text)} → ${candidate.action}]`;
  }
}

/**
 * A chain, named by the candidate that would be tried first and how many fall back behind it. The
 * whole chain would be a paragraph in a terminal; the first candidate plus a count is what a reader
 * needs to recognize the step, and the run log has the rest.
 */
export function describeDescriptor(descriptor: TargetDescriptor): string {
  const first = descriptor.candidates[0];
  if (first === undefined) return "an empty candidate chain";
  const rest = descriptor.candidates.length - 1;
  const frame = (descriptor.framePath ?? []).length === 0 ? "" : ` in frame [${(descriptor.framePath ?? []).join(".")}]`;
  return rest === 0 ? `${describeCandidate(first)}${frame}` : `${describeCandidate(first)} +${rest} fallback(s)${frame}`;
}

/**
 * The clause a *read* earns when a fallback candidate, rather than the one the step line named,
 * produced the value — and nothing when the first candidate resolved, because then the step line was
 * already true.
 *
 * The step line names the first candidate on purpose (§4.1's chain is walked in order, and the first
 * one is how a reader recognizes the step), but for a read that line is the *intent* and the value is
 * the *outcome*, and the canonical case separates them: a literal reading taken from another member's
 * page is still in the chain, so `read text="$4,201.55"` sits above an answer of `980.12` with nothing
 * in between saying which candidate won. The driver has always known; this is the sentence that says
 * it, and it is a function here rather than a line in the engine so the wording is testable.
 *
 * `index` is `-1` only if the candidate cannot be placed in the chain it came from. That names the
 * candidate without a position rather than staying quiet: the strategy is the useful half.
 */
export function describeResolution(candidate: TargetCandidate, index: number, total: number): string {
  if (index === 0) return "";
  const where = index < 0 ? "" : `candidate ${index + 1} of ${total}: `;
  return ` via ${where}${describeCandidate(candidate)}`;
}

/** §5.3's `expected`, in a sentence a caller who has never read the artifact can act on. */
export function describeAssertion(assertion: StateAssertion, params: Params): string {
  if ("urlContains" in assertion) return `the URL contains ${quote(bind(assertion.urlContains, params))}`;
  if ("urlMatches" in assertion) return `the URL matches the route ${quote(assertion.urlMatches)}`;
  if ("elementExists" in assertion) return `${describeDescriptor(assertion.elementExists)} is on the page`;
  if ("elementAbsent" in assertion) return `${describeDescriptor(assertion.elementAbsent)} is not on the page`;
  return `${describeDescriptor(assertion.textEquals.target)} shows ${quote(bind(assertion.textEquals.value, params))}`;
}

/** What a step is for, when the failure happened before any expectation could be evaluated. */
export function describeStep(step: Step, params: Params): string {
  switch (step.kind) {
    case "navigate":
      return `navigate to ${bind(step.url, params)}`;
    case "wait":
      return step.condition === "fixed" ? `wait ${step.ms ?? 0}ms` : "wait for the page to load";
    case "act":
      return `${step.action} ${describeDescriptor(step.target)} then ${describeAssertion(step.expect, params)}`;
    case "extract":
      return `read ${describeDescriptor(step.target)} as output "${step.name}"`;
    case "assert":
      return `check ${describeAssertion(step.condition, params)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

export interface AssertionOutcome {
  readonly ok: boolean;
  /** What the page actually showed. Always set — a failure with no `observed` is a riddle. */
  readonly observed: string;
}

/** §28's two variable syntaxes, as regex source. `{param}` escapes; `:name` is one segment. */
function routeSource(pattern: string, params: Params): string {
  let source = "";
  let index = 0;
  const token = /\{([A-Za-z_][A-Za-z0-9_-]*)\}|:([A-Za-z_][A-Za-z0-9_-]*)/g;
  for (const match of pattern.matchAll(token)) {
    source += escapeRegex(pattern.slice(index, match.index));
    index = match.index + match[0].length;
    const param = match[1];
    // `{param}` is the caller's value written literally into the route, so it is escaped like any
    // other literal. `:name` is the shape matcher — one non-empty segment, and never empty.
    source += param === undefined ? "[^/]+" : escapeRegex(params.get(param) ?? match[0]);
  }
  return source + escapeRegex(pattern.slice(index));
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a `urlMatches` pattern hold for a URL? Anchored on both ends and matched against the
 * **path** — see the header's note 3 for why the query is not part of the question.
 */
export function matchesRoute(pattern: string, params: Params, url: string): boolean {
  let pathname: string;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return false;
  }
  return new RegExp(`^${routeSource(pattern, params)}$`).test(pathname);
}

/**
 * Evaluate one assertion against the page as it is right now.
 *
 * Every arm reports `observed` even when it held, because the caller's next question on a false
 * result is "what was there instead" and re-asking the page would answer about a later moment.
 */
export async function checkAssertion(
  assertion: StateAssertion,
  driver: SessionDriver,
  url: string,
  params: Params,
): Promise<AssertionOutcome> {
  if ("urlContains" in assertion) {
    const needle = bind(assertion.urlContains, params);
    return { ok: url.includes(needle), observed: `the URL was ${url}` };
  }
  if ("urlMatches" in assertion) {
    return {
      ok: matchesRoute(assertion.urlMatches, params, url),
      observed: `the URL was ${url}`,
    };
  }
  if ("elementExists" in assertion) {
    const descriptor = bindDescriptor(assertion.elementExists, params);
    const resolved = await driver.resolves(descriptor).catch(() => false);
    return { ok: resolved, observed: `${describeDescriptor(descriptor)} ${resolved ? "resolves" : "does not resolve"}` };
  }
  if ("elementAbsent" in assertion) {
    const descriptor = bindDescriptor(assertion.elementAbsent, params);
    const resolved = await driver.resolves(descriptor).catch(() => false);
    return { ok: !resolved, observed: `${describeDescriptor(descriptor)} ${resolved ? "still resolves" : "is absent"}` };
  }

  const descriptor = bindDescriptor(assertion.textEquals.target, params);
  const wanted = normalizeText(bind(assertion.textEquals.value, params));
  try {
    const { text } = await driver.read(descriptor);
    return {
      ok: text === wanted,
      observed: `${describeDescriptor(descriptor)} shows ${quote(text)}`,
    };
  } catch {
    // A `textEquals` whose target does not resolve is false, not an error: the assertion asked a
    // question about the page and the answer is "no". The chain's own exhaustion is a different
    // failure and is reported as one by the step that was trying to act there.
    return { ok: false, observed: `${describeDescriptor(descriptor)} does not resolve` };
  }
}

/* -------------------------------------------------------------------------- */
/* Outcomes (§4.1 signatures, in declaration order)                            */
/* -------------------------------------------------------------------------- */

export interface OutcomeMatch {
  readonly outcome: BusinessOutcome;
  /** The literal page text the signature matched, so a reviewer can see why it fired. */
  readonly evidence: string;
}

/**
 * The first declared signature holding on this page, or `null`.
 *
 * **Declaration order, earliest wins** (§5.2), which is what makes `outcomes[]` an ordered contract
 * rather than a set. The match is against the *whole* normalized page text and each signature is
 * compiled fresh: caching regexes per outcome would be a micro-optimization on a path that runs
 * once per poll, and a stateful `/g` regex would carry `lastIndex` between polls — a bug whose
 * symptom would be an outcome that fires on every other poll.
 *
 * Both of §4.1's `detect` kinds are one question with two halves, and the halves are conjunctive:
 * `text-on-page` is the pattern alone, `element-shown` is the pattern **and** its target resolving.
 * A signature that names an element is asking about two facts the page can disagree on — a leftover
 * message from a previous step over a control that is no longer there — and firing on half of it
 * would end a run with an answer the app did not give.
 *
 * `resolves` is injected rather than reached for: this function stays pure over its arguments, so
 * the whole classification table is testable without a browser, and the engine passes the driver's
 * own resolver — the one that also backs `elementExists`, so "shown" means the same thing here as it
 * does in a checkpoint.
 */
export async function matchOutcome(
  text: string,
  outcomes: readonly BusinessOutcome[],
  resolves: (target: TargetDescriptor) => Promise<boolean>,
): Promise<OutcomeMatch | null> {
  for (const outcome of outcomes) {
    const pattern = new RegExp(outcome.detect.pattern);
    const match = pattern.exec(text);
    if (match === null) continue;
    const { detect } = outcome;
    if (detect.kind === "element-shown" && !(await resolves(detect.target))) continue;
    return { outcome, evidence: normalizeText(match[0]) };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Dialogs (§5.2's recoverable condition)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Policy's verdict on a dialog's text, or `null` when policy does not know it.
 *
 * §5.2's asymmetry is the whole rule: a policy-known dialog is handled (the operator has already
 * said "this one is safe to answer"), and anything else is a human decision. So "not known" is not
 * a default — it is the escalation.
 *
 * What a *found* dialog looks like is `DialogObservation`, declared in `session-driver.ts`: the
 * driver is what finds one, and a second shape here for the same fact is the drift this file's
 * header warns about. What lives here is only the question policy answers about it.
 */
export function matchRecoverableDialog(text: string, dialogs: readonly RecoverableDialog[]): RecoverableDialog | null {
  for (const dialog of dialogs) {
    // Through `pattern.ts`, never `new RegExp(dialog.text, "i")` — the spelling the schema blesses
    // (`isUsableTextPattern`) and the one the shipped policy actually uses are the same, and a
    // `/body/flags` literal read as a bare regex matches the *slashes* instead of the sentence. The
    // miss is not subtle: it is the difference between G3's auto-accept and an escalation on every
    // run that meets a dialog the operator has already ruled on.
    if (textPattern(dialog.text).matches(text)) return dialog;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Classification (§5.2's vocabulary)                                          */
/* -------------------------------------------------------------------------- */

export interface Classified {
  readonly code: TaxonomyCode;
  /** §5.2/§22: the retry family is retried with backoff, and terminates under its own code. */
  readonly retryable: boolean;
  /** What the run saw, for `observed`. */
  readonly observed: string;
}

/**
 * Network-layer failures, and whether the engine may retry in place.
 *
 * The retryable set is §5.2's "request-level transport failures": the origin never answered, and the
 * next attempt is a fresh question rather than a guess. The non-retryable one is the **dead driver
 * session** — §8's resume rule is that the engine never guesses past a state it cannot verify, so a
 * closed browser is an immediate terminal `TRANSPORT_ERROR` and recovery is a re-run.
 */
const TRANSPORT_PATTERNS: readonly { readonly test: RegExp; readonly retryable: boolean }[] = [
  { test: /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|TIMED_OUT)/, retryable: true },
  { test: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b/, retryable: true },
  { test: /socket hang up|fetch failed|other side closed/i, retryable: true },
  { test: /Target (page|closed)|context or browser has been closed|browser has been closed|Page closed/, retryable: false },
];

/**
 * Turn a thrown thing into §5.2's vocabulary, plus the one bit the engine needs from it.
 *
 * The order is deliberate and it is not "most specific first" — it is "whose condition is this".
 * Our own errors come first because they were raised by code that already knew what it was
 * reporting; the driver's refusals come next because they are statements about policy rather than
 * about the page; only then does the error's own text get read. A Playwright `TimeoutError` is the
 * one case worth spelling out: it means "the state I was told to wait for did not arrive in time",
 * which is §5.2's `SLOW_LOAD` exactly, whether the wait was a navigation or a click's auto-wait.
 */
export function classifyError(error: unknown): Classified {
  if (error instanceof ElementNotFoundError) {
    const detail = error.attempts
      .map((attempt) => `${attempt.candidate.strategy}=${attempt.matches < 0 ? "unusable" : `${attempt.matches} match(es)`}`)
      .join(", ");
    return {
      code: "ELEMENT_NOT_FOUND",
      retryable: false,
      observed: `no candidate resolved uniquely${detail === "" ? "" : ` (${detail})`}`,
    };
  }
  if (error instanceof FramePathError) {
    return { code: "ELEMENT_NOT_FOUND", retryable: false, observed: error.message };
  }
  if (error instanceof PolicyBlockedError) {
    return { code: "NAVIGATION_BLOCKED", retryable: false, observed: `${error.verdict.rule}: ${error.verdict.reason}` };
  }
  if (error instanceof ApprovalRequiredError) {
    // Handled by the engine at the call site (it knows what the escalation seam answered); this arm
    // exists so the classifier is total, and it reads as the policy refusal it is.
    return { code: "NAVIGATION_BLOCKED", retryable: false, observed: error.message };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") {
    return { code: "SLOW_LOAD", retryable: true, observed: `the page did not reach the expected state in time (${message})` };
  }
  for (const pattern of TRANSPORT_PATTERNS) {
    if (pattern.test.test(message)) {
      return { code: "TRANSPORT_ERROR", retryable: pattern.retryable, observed: message };
    }
  }
  return { code: "UNEXPECTED_STATE", retryable: false, observed: message };
}

/** Is this code one §5.2/§22 retries with backoff, and never escalates? */
export function isRetryFamily(code: string): boolean {
  return (RECOVERABLE_CODES as readonly string[]).includes(code) && code !== "SESSION_EXPIRED" && code !== "INTERSTITIAL_DIALOG";
}

/* -------------------------------------------------------------------------- */
/* Output values                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A `money` output's text as a number, or `null` when it is not an amount.
 *
 * Per §4.1 a `money` output is a number, so the string the page showed is parsed rather than
 * passed through: a caller doing arithmetic on `"$4,201.55"` gets `NaN`, and the failure would
 * surface in the caller's code instead of in the run's. Currency symbols, thousands separators and
 * whitespace come off; a parenthesized negative — how a bank writes one — comes back negative.
 */
export function parseMoney(text: string): number | null {
  const trimmed = text.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replaceAll(/[()$€£¥,\s]/g, "").replace(/^-/, "");
  if (cleaned === "" || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative || trimmed.startsWith("-") ? -value : value;
}
