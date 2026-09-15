/**
 * The result contract and its two renderings (§5.3, §5.4).
 *
 * This is the caller's interface, so the tests are written from the caller's side: what does the
 * terminal print, what exit code does a script branch on, and — the one that matters most — is a
 * business outcome reachable by the same code path as a success? §5.4 pairs them at exit `0` on
 * purpose, and a test that only checked `1` for failures would not notice if that pairing broke.
 *
 * `describeResult` is pure over a `RunResult`, which is exactly why it can be tested this way: no
 * browser, no model, no evidence on disk — the shape of the summary is a property of the result.
 */
import { describe, expect, it } from "vitest";
import {
  businessOutcomeResult,
  describeResult,
  exitCodeFor,
  failureResult,
  successResult,
  type EvidenceRefs,
  type RunResult,
} from "../../src/replay/result.ts";
import { HINTS } from "../../src/replay/taxonomy.ts";

const EVIDENCE: EvidenceRefs = {
  runDir: "evidence/2026-09-15T10-00-00-000Z",
  runLog: "evidence/2026-09-15T10-00-00-000Z/run.jsonl",
};

describe("the exit code", () => {
  it("gives 0 to a success", () => {
    expect(exitCodeFor(successResult({ balance: "$4,201.55" }, EVIDENCE))).toBe(0);
  });

  it("gives 0 to a business outcome, which is a legitimate answer", () => {
    // §5.4's sharpest consequence: `NO_SUCH_ENTITY` is the answer to "does this member exist", so a
    // caller asking that question must not have to treat the answer as a crash. If this ever returns
    // 1, every caller is forced to parse stderr to use a declared outcome.
    const result = businessOutcomeResult({ code: "NO_SUCH_ENTITY", message: "No member 99999." });
    expect(exitCodeFor(result)).toBe(0);
  });

  it("gives 1 to a failure, whichever stage produced it", () => {
    const discovery = failureResult({
      stage: "discovery",
      errorCode: "STUCK",
      expected: "an artifact",
      observed: "the page stopped changing",
      evidence: EVIDENCE,
    });
    const replay = failureResult({
      stage: "replay",
      errorCode: "ELEMENT_NOT_FOUND",
      expected: "the balance field",
      observed: "no match",
      stepId: 3,
      evidence: EVIDENCE,
    });
    expect(exitCodeFor(discovery)).toBe(1);
    expect(exitCodeFor(replay)).toBe(1);
  });

  it("names no 2, because no result can imply one", () => {
    // Usage and preflight errors are decided before a run exists (§5.4's hard boundary). The
    // signature is `0 | 1` so that an attempt to return 2 from here is a type error, not a habit.
    const code: 0 | 1 = exitCodeFor(successResult({}, EVIDENCE));
    expect([0, 1]).toContain(code);
  });
});

describe("building a failure", () => {
  it("fills the hint from the taxonomy's map", () => {
    const result = failureResult({
      stage: "replay",
      errorCode: "RECORD_LOCKED",
      expected: "the balance to be readable",
      observed: "the record is locked by another session",
      stepId: 4,
      evidence: EVIDENCE,
    });
    expect(result.status === "failure" && result.hint).toBe(HINTS.RECORD_LOCKED);
  });

  it("leaves the hint off for a code the map does not know", () => {
    // A capability declares its own outcome codes, so an unknown one is legitimate. The failure must
    // render without a hint rather than with an invented one — and without the key at all, so a
    // caller checking `"hint" in result` is not told there is advice when there is none.
    const result = failureResult({
      stage: "replay",
      errorCode: "MEMBER_RETIRED",
      expected: "the member's page",
      observed: "the app reports the member retired",
      evidence: EVIDENCE,
    });
    expect(result.status === "failure" && "hint" in result).toBe(false);
    expect(describeResult(result).some((line) => line.includes("hint"))).toBe(false);
  });

  it("omits stepId when there was no step, and keeps it when there was", () => {
    // Discovery failures have no step: the run is not replaying an artifact, so there is no step in
    // flight. Emitting `stepId: undefined` would put `step: undefined` in the summary.
    const noStep = failureResult({
      stage: "discovery",
      errorCode: "GAVE_UP",
      expected: "a recorded artifact",
      observed: "the model stopped calling tools",
      evidence: EVIDENCE,
    });
    expect(noStep.status === "failure" && "stepId" in noStep).toBe(false);

    const withStep = failureResult({
      stage: "replay",
      errorCode: "CHECKPOINT_MISMATCH",
      expected: "the member's own page",
      observed: "a different member's page",
      stepId: 7,
      evidence: EVIDENCE,
    });
    expect(withStep.status === "failure" && withStep.stepId).toBe(7);
  });

  it("defaults the escalation to none, and keeps a real one", () => {
    const raised = { stage: "replay", errorCode: "PERMISSION_DENIED", expected: "x", observed: "y", evidence: EVIDENCE } as const;
    const quiet = failureResult(raised);
    expect(quiet.status === "failure" && quiet.escalation).toBe("none");

    const declined = failureResult({ ...raised, escalation: "declined" });
    expect(declined.status === "failure" && declined.escalation).toBe("declined");
  });
});

describe("the compact human summary", () => {
  it("prints a success as status, outputs, then evidence", () => {
    expect(describeResult(successResult({ balance: "$4,201.55", tier: "Gold" }, EVIDENCE))).toEqual([
      "success",
      "  balance: $4,201.55",
      "  tier: Gold",
      "  evidence: evidence/2026-09-15T10-00-00-000Z",
      "  run log: evidence/2026-09-15T10-00-00-000Z/run.jsonl",
    ]);
  });

  it("prints a business outcome as code and message, with no evidence block", () => {
    // §5.3 gives `business-outcome` no `evidence` field, so there is nothing to print. Asserted as an
    // exact list rather than a substring check, because "helpfully" adding paths here would be a
    // deviation from the frozen shape that a looser test would let through.
    expect(
      describeResult(businessOutcomeResult({ code: "NO_SUCH_ENTITY", message: "No member 99999 exists." })),
    ).toEqual(["business-outcome: NO_SUCH_ENTITY", "  No member 99999 exists."]);
  });

  it("prints a business outcome's outputs when it has them", () => {
    const result = businessOutcomeResult({
      code: "RECORD_LOCKED",
      message: "The record is locked.",
      outputs: { lockedBy: "ops-batch" },
    });
    expect(describeResult(result)).toEqual([
      "business-outcome: RECORD_LOCKED",
      "  The record is locked.",
      "  lockedBy: ops-batch",
    ]);
  });

  it("prints a failure in §5.4's order: step, expected-vs-observed, evidence, hint", () => {
    expect(
      describeResult(
        failureResult({
          stage: "replay",
          errorCode: "ELEMENT_NOT_FOUND",
          expected: "the savings balance field",
          observed: "no element matched role=textbox name=Balance",
          stepId: 3,
          evidence: EVIDENCE,
        }),
      ),
    ).toEqual([
      "failure (replay): ELEMENT_NOT_FOUND",
      "  step: 3",
      "  expected: the savings balance field",
      "  observed: no element matched role=textbox name=Balance",
      "  evidence: evidence/2026-09-15T10-00-00-000Z",
      "  run log: evidence/2026-09-15T10-00-00-000Z/run.jsonl",
      `  hint: ${HINTS.ELEMENT_NOT_FOUND}`,
    ]);
  });

  it("prints the escalation only when there was one", () => {
    const base = {
      stage: "replay",
      errorCode: "PERMISSION_DENIED",
      expected: "the page to open",
      observed: "policy blocked the click",
      stepId: 2,
      evidence: EVIDENCE,
    } as const;
    const lines = describeResult(failureResult(base));
    expect(lines.some((line) => line.startsWith("  escalation:"))).toBe(false);
    expect(lines.at(-1)?.startsWith("  hint:")).toBe(true);

    // A raised escalation comes last, after the hint: it is what the operator is being asked about,
    // and it is the one line a caller may need to act on rather than read.
    const escalated = describeResult(failureResult({ ...base, escalation: "no-operator" }));
    expect(escalated.at(-1)).toBe("  escalation: no-operator");
  });

  it("renders a non-scalar output compactly rather than as [object Object]", () => {
    const result: RunResult = successResult({ rows: [1, 2, 3], nested: { a: 1 }, missing: null }, EVIDENCE);
    expect(describeResult(result)).toEqual([
      "success",
      "  rows: [3 item(s)]",
      "  nested: {…}",
      "  missing: —",
      "  evidence: evidence/2026-09-15T10-00-00-000Z",
      "  run log: evidence/2026-09-15T10-00-00-000Z/run.jsonl",
    ]);
  });

  it("prints nothing for an empty output set, and still points at the evidence", () => {
    expect(describeResult(successResult({}, EVIDENCE))).toEqual([
      "success",
      "  evidence: evidence/2026-09-15T10-00-00-000Z",
      "  run log: evidence/2026-09-15T10-00-00-000Z/run.jsonl",
    ]);
  });
});
