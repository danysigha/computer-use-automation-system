/**
 * The taxonomy (§5.2, T9) — the map's totality, and the one property that makes it worth having.
 *
 * §5.3 asks that "every taxonomy code ships a `hint` one-liner (problem + likely fix)", and the
 * failure mode that sentence guards against is specific: a code with no hint renders as
 * `hint: undefined` in the failure a caller is staring at, at exactly the moment they need advice.
 * So the central test is a *totality* test over the exported code lists rather than a spot check —
 * a code added to §5.2 later and not to the map fails here rather than in production.
 *
 * The rest is about the map's boundaries: which codes belong to which family (the families are
 * response rules, so a misfiled code is a misfiled response), and that an unknown code — a
 * capability's own declared outcome, say — is answered with `null` rather than a guess.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CODES,
  BUSINESS_OUTCOME_CODES,
  DISCOVERY_CODES,
  ESCALATION_CODES,
  HARD_FAILURE_CODES,
  HINTS,
  RECOVERABLE_CODES,
  hintFor,
} from "../../src/replay/taxonomy.ts";

describe("the taxonomy's families", () => {
  it("carries §5.2's three classes exactly as the table lists them", () => {
    // Written out rather than derived from the module: this is the plan's own vocabulary, and a
    // test that read it from the same constant it is checking would agree with any typo.
    expect([...BUSINESS_OUTCOME_CODES]).toEqual([
      "NO_SUCH_ENTITY",
      "VALIDATION_ERROR",
      "PERMISSION_DENIED",
      "RECORD_LOCKED",
    ]);
    expect([...RECOVERABLE_CODES]).toEqual([
      "INTERSTITIAL_DIALOG",
      "SLOW_LOAD",
      "TRANSIENT_ERROR",
      "TRANSPORT_ERROR",
      "SESSION_EXPIRED",
    ]);
    expect([...HARD_FAILURE_CODES]).toEqual([
      "ELEMENT_NOT_FOUND",
      "CHECKPOINT_MISMATCH",
      "NAVIGATION_BLOCKED",
      "UNEXPECTED_STATE",
    ]);
  });

  it("names §5.3's escalation terminal and the discovery stage's own endings", () => {
    expect([...ESCALATION_CODES]).toEqual(["HUMAN_UNAVAILABLE"]);
    expect([...DISCOVERY_CODES]).toEqual(["STUCK", "GAVE_UP", "ESCALATION_REQUIRED", "DISCOVERY_FAILED"]);
  });

  it("keeps the families disjoint, so one code cannot imply two responses", () => {
    // §5.2's classes are what happens next — business outcome stops and answers, recoverable retries
    // or escalates, hard failure stops and reports. A code in two families would make "what happens
    // next" ambiguous, which is the one thing this table exists to prevent.
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });

  it("lists every code the map knows, and nothing else", () => {
    expect([...ALL_CODES].sort()).toEqual(Object.keys(HINTS).sort());
  });
});

describe("the hints", () => {
  it("gives every taxonomy code a non-empty line", () => {
    // T9's verify, and the reason it is a loop over `ALL_CODES` rather than a list of assertions: a
    // code added to a family without a hint is a promise §5.3 makes that would go unmet silently.
    for (const code of ALL_CODES) {
      expect(HINTS[code], `${code} needs a hint`).toBeTruthy();
      expect(HINTS[code].trim().length).toBeGreaterThan(0);
    }
  });

  it("reads as a fix rather than a restatement of the code", () => {
    // A hint that says "the element was not found" adds nothing to `ELEMENT_NOT_FOUND`. This is a
    // vocabulary check rather than a semantic one — it cannot tell good advice from bad — but it does
    // catch the actual failure, which is a line that describes the problem and stops there. It has
    // already earned its place twice: `SESSION_EXPIRED` and `CHECKPOINT_MISMATCH` both named their
    // state and left the reader to infer the fix, which is not what §5.3 asks for.
    for (const code of ALL_CODES) {
      expect(HINTS[code], `${code}'s hint should name something to do`).toMatch(
        /\b(check|retry|re-run|run it|raise|add|allow|re-record|declare|read|give|use|export|approve|update|sign in|pass|call it)\b/i,
      );
    }
  });

  it("answers an unknown code with null, not a fallback sentence", () => {
    // A capability declares its own `outcomes[]`, so a code can legitimately arrive that this
    // taxonomy has never heard of — `MEMBER_RETIRED`, say. Inventing advice for it would be the
    // system pretending to knowledge it does not have; the caller renders what it has.
    expect(hintFor("MEMBER_RETIRED")).toBeNull();
    expect(hintFor("")).toBeNull();
    expect(hintFor("toString")).toBeNull(); // not a key of the map, and not a prototype member either
  });

  it("returns the mapped line for every code it does know", () => {
    for (const code of ALL_CODES) expect(hintFor(code)).toBe(HINTS[code]);
  });
});
