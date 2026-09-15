/**
 * The result contract (§5.3) — one shape for both runs, and the two renderings §5.4 asks for.
 *
 * The union below is §5.3 verbatim, which matters more than it looks: it is the *caller's* interface,
 * frozen before any code was written, and the same type is returned whether a run came out of
 * discovery or replay. A caller that can tell those two apart by shape would have to handle two
 * contracts; the only thing that distinguishes them is `failure.stage`, which is exactly the amount of
 * distinction the caller needs.
 *
 * Three decisions are worth stating, because each is a place where a plausible-looking refinement
 * would be a deviation from the frozen contract.
 *
 * 1. **`business-outcome` carries no `evidence`.** §5.3 gives it none, and that is not an oversight to
 *    be helpfully corrected. The evidence refs on `success` and `failure` are there because the caller
 *    will want to look at *how the run went*; a business outcome is an answer to the question the
 *    caller asked, and its shape says so. The run's evidence is still on disk and still named in the
 *    run log — it is just not part of the answer.
 *
 * 2. **`hint` is filled from the taxonomy map, never at the call site.** §5.3 asks for one line per
 *    code from a code→hint map, so the constructors here are the only place a `failure` is assembled
 *    and the map is the only place the sentence comes from. A code the map does not know — a
 *    capability's own declared outcome code, say — leaves the field off rather than inventing advice
 *    for it.
 *
 * 3. **Rendering is a function of the result alone.** `describeResult` is pure over `RunResult`, so
 *    what the terminal prints can be asserted without a run, and the CLI's own narration (which
 *    artifact was saved, where) is added by the CLI, which is the only thing that knows it. Redaction
 *    is deliberately *not* this function's job: the values a caller may not see are masked when the
 *    result is built (`Redactor.output`, §6's precedence), so a summary and a `--json` payload come
 *    from one already-redacted object rather than from two render sites that could disagree.
 */
import { hintFor } from "./taxonomy.ts";

/** Where a run's evidence lives. Paths, not contents — the caller opens them. */
export interface EvidenceRefs {
  /** The run's directory: the DOM snapshots, the screenshots, everything but the log. */
  readonly runDir: string;
  /** The action log itself, `run.jsonl` inside `runDir`. Named separately because it is the file a
   * reader opens first, and because a caller may want to tail it while a run is still going. */
  readonly runLog: string;
}

/** §5.3's escalation lifecycle: what happened to the human decision the run asked for. */
export type Escalation = "none" | "human-took-over" | "declined" | "no-operator";

export type RunStage = "discovery" | "replay";

export type RunResult =
  | { readonly status: "success"; readonly outputs: Readonly<Record<string, unknown>>; readonly evidence: EvidenceRefs }
  | {
      readonly status: "business-outcome";
      readonly outcome: {
        readonly code: string;
        readonly message: string;
        readonly outputs?: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly status: "failure";
      readonly stage: RunStage;
      readonly stepId?: number;
      readonly errorCode: string;
      readonly expected: string;
      readonly observed: string;
      readonly hint?: string;
      readonly evidence: EvidenceRefs;
      readonly escalation: Escalation;
    };

/* -------------------------------------------------------------------------- */
/* Building one                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A run that did what it was asked. `outputs` arrives already redacted — see the header's decision 3,
 * and `Redactor.output` for the precedence rule that decides which values those are.
 */
export function successResult(
  outputs: Readonly<Record<string, unknown>>,
  evidence: EvidenceRefs,
): RunResult {
  return { status: "success", outputs, evidence };
}

/** A legitimate answer rather than a broken run — §5.3's first class, and exit code 0. */
export function businessOutcomeResult(
  outcome: { code: string; message: string; outputs?: Readonly<Record<string, unknown>> },
): RunResult {
  return {
    status: "business-outcome",
    outcome: {
      code: outcome.code,
      message: outcome.message,
      ...(outcome.outputs === undefined ? {} : { outputs: outcome.outputs }),
    },
  };
}

export interface FailureInput {
  readonly stage: RunStage;
  readonly errorCode: string;
  /** What the run was trying to achieve, in the artifact's terms. */
  readonly expected: string;
  /** What it got instead. Free text: a page's own words, a classifier's reason, a stuck line. */
  readonly observed: string;
  /** The step in flight, when there was one. Discovery failures have no step to name. */
  readonly stepId?: number;
  readonly evidence: EvidenceRefs;
  /** Defaults to `"none"`: an escalation that was never raised. */
  readonly escalation?: Escalation;
}

/** A run that stopped. The hint comes from the taxonomy map — see the header's decision 2. */
export function failureResult(input: FailureInput): RunResult {
  const hint = hintFor(input.errorCode);
  return {
    status: "failure",
    stage: input.stage,
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    errorCode: input.errorCode,
    expected: input.expected,
    observed: input.observed,
    ...(hint === null ? {} : { hint }),
    evidence: input.evidence,
    escalation: input.escalation ?? "none",
  };
}

/* -------------------------------------------------------------------------- */
/* The script contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * §5.4's exit codes, as far as a `RunResult` can decide them.
 *
 * `0` covers success **and** business-outcome together, and that pairing is the whole point of the
 * code: a caller scripted around a capability needs `NO_SUCH_ENTITY` to be as reachable as `balance:
 * "$4,201.55"` — it is the answer to "does this member exist" — so a business outcome that exited
 * non-zero would force every caller to parse stderr to use it.
 *
 * `2` is not here and cannot be: usage and preflight errors are decided *before* a run exists, and
 * §5.4 makes that boundary hard — a bad flag never becomes a `VALIDATION_ERROR` business outcome. So
 * this function is total over results and returns exactly the two values a result can imply.
 */
export function exitCodeFor(result: RunResult): 0 | 1 {
  return result.status === "failure" ? 1 : 0;
}

/**
 * §5.4's compact human summary, as lines.
 *
 * Lines rather than a formatted string so a caller can indent, prefix, or join them — and so a test
 * can assert on a specific line instead of on a substring of a paragraph. The order is §5.4's own:
 * status line; then the outcome's code and message, or the step, expected-vs-observed, evidence and
 * hint.
 */
export function describeResult(result: RunResult): readonly string[] {
  switch (result.status) {
    case "success":
      return [
        "success",
        ...outputLines(result.outputs),
        ...evidenceLines(result.evidence),
      ];
    case "business-outcome":
      return [
        `business-outcome: ${result.outcome.code}`,
        `  ${result.outcome.message}`,
        ...outputLines(result.outcome.outputs ?? {}),
      ];
    case "failure":
      return [
        `failure (${result.stage}): ${result.errorCode}`,
        ...(result.stepId === undefined ? [] : [`  step: ${result.stepId}`]),
        `  expected: ${result.expected}`,
        `  observed: ${result.observed}`,
        ...evidenceLines(result.evidence),
        ...(result.hint === undefined ? [] : [`  hint: ${result.hint}`]),
        // Printed only when there was one: the common failure has none, and a line saying so on every
        // run is the kind of noise that trains a reader to skip the block that matters.
        ...(result.escalation === "none" ? [] : [`  escalation: ${result.escalation}`]),
      ];
  }
}

function outputLines(outputs: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(outputs).map(([name, value]) => `  ${name}: ${renderValue(value)}`);
}

function evidenceLines(evidence: EvidenceRefs): readonly string[] {
  return [`  evidence: ${evidence.runDir}`, `  run log: ${evidence.runLog}`];
}

/**
 * A value as a summary should show it. Strings unquoted — this is a terminal, not JSON, and the
 * quotes would be noise around the one thing the reader came for. Everything else is `serialize`'s
 * business upstream; a non-scalar reaching here is rendered compactly rather than dropped.
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `[${value.length} item(s)]` : "{…}";
}
