/**
 * The review pass (§4.1, §11 P4) — the outcomes a run cannot witness, and the two ways curating them
 * goes wrong.
 *
 * This is a small module with a large job, so the tests are mostly about *refusals*: a signature that
 * matches the happy path, and a message that interpolates an input the recording never declared.
 * Neither is a style problem. The first turns every successful replay into a business outcome; the
 * second makes the outcome's caller-facing sentence unresolvable, which the schema refuses outright.
 * Both are mistakes a curator makes while editing `policy.json`, which is why the pass names the seed
 * rather than the artifact path.
 *
 * The other half is the haystack: which recorded text a signature is checked against. It is the part
 * of this pass that is easy to get subtly wrong — collect too little and a bad signature ships,
 * collect the wrong things (URLs, say) and good ones are refused — so every arm of the walk has a
 * case below.
 */
import { describe, expect, it } from "vitest";
import { reviewCapability, ReviewRefusedError, type ReviewOptions } from "../../src/agent/review.ts";
import { Policy, type OutcomeSeed } from "../../src/policy/policy.ts";
import type { DiscoveryRun } from "../../src/agent/loop.ts";
import type { Capability } from "../../src/schema/artifact.ts";
import { CapabilityInvalidError } from "../../src/schema/validate.ts";
import type { ActTrace, NavigateTrace, NodeDigest, ReadTrace, StateDelta, TraceEntry } from "../../src/agent/trace.ts";
import type { TargetDescriptor } from "../../src/surface/target.ts";
import { validCapability } from "../helpers/artifact.ts";

const TARGET: TargetDescriptor = {
  candidates: [{ strategy: "role", role: "cell", name: "$4,201.55" }],
  framePath: [],
};

/* -------------------------------------------------------------------------- */
/* Traces, built for their text                                                 */
/* -------------------------------------------------------------------------- */

function digest(name: string): NodeDigest {
  return { index: 0, role: "cell", name, text: "", framePath: [] };
}

function delta(anchor: StateDelta["anchor"] = null): StateDelta {
  return {
    beforeUrl: "http://app/",
    afterUrl: "http://app/",
    urlChanged: false,
    counts: { appeared: anchor === null ? 0 : 1, disappeared: 0, changed: 0 },
    anchor,
  };
}

function read(text: string): ReadTrace {
  return { kind: "read", turn: 1, index: 0, node: digest(text), target: TARGET, text };
}

function act(overrides: Partial<ActTrace> = {}): ActTrace {
  return {
    kind: "act",
    turn: 1,
    action: "click",
    index: 0,
    node: digest("Search"),
    target: TARGET,
    textBefore: "",
    textAfter: null,
    value: null,
    resolvedBy: "role",
    verdict: { rule: "allowlist.action", approvalRequired: false },
    sensitive: false,
    delta: delta(),
    ...overrides,
  };
}

function navigate(overrides: Partial<NavigateTrace> = {}): NavigateTrace {
  return {
    kind: "navigate",
    turn: 1,
    requested: "/member/12345/summary",
    url: "http://app/member/12345/summary",
    delta: delta(),
    ...overrides,
  };
}

function runObserving(trace: readonly TraceEntry[]): DiscoveryRun {
  return {
    goal: "Look up member 12345 and read their current savings balance",
    model: "test-model",
    entry: "http://app/",
    finalUrl: "http://app/member/12345/summary",
    ending: { kind: "completed", outputs: { balance: "$4,201.55" } },
    trace,
    turns: trace.length,
  };
}

/* -------------------------------------------------------------------------- */
/* The two inputs                                                               */
/* -------------------------------------------------------------------------- */

/** A recording, as `recordCapability` emits it: no outcomes, and no `reviewedBy`. */
function recorded(): Capability {
  const { outcomes: _uncurated, ...rest } = validCapability();
  return { ...rest, outcomes: [] };
}

/**
 * A seed for the tests that only care about one field. `sample` is filled in without being made
 * consistent with `pattern`: the sample-match rule is the *policy* loader's (`policy.test.ts`), and
 * these stand in for a document that already passed it.
 */
function seed(overrides: Partial<OutcomeSeed> & Pick<OutcomeSeed, "pattern">): OutcomeSeed {
  return { code: "UNEXPECTED_STATE", message: "the app said something unexpected", sample: "x", ...overrides };
}

const shipped = async (): Promise<readonly OutcomeSeed[]> => (await Policy.load({ env: {} })).document.outcomes;

/** What a review threw, so a test can assert on what it says rather than only that it threw. */
function thrownBy(options: ReviewOptions): Error {
  try {
    reviewCapability(options);
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error("the review returned, and this test expected a refusal");
}

/* -------------------------------------------------------------------------- */

describe("applying the curated signatures", () => {
  it("stamps them in declaration order and marks the artifact reviewed", async () => {
    const artifact = recorded();
    const seeds = await shipped();
    const result = reviewCapability({ capability: artifact, run: runObserving([read("$4,201.55")]), seeds });

    expect(result.reviewed).toBe(true);
    expect(result.notes.join(" ")).toContain("NO_SUCH_ENTITY");
    // Declaration order is the probe order (§5.2), so it is part of the contract rather than an
    // accident of how the file was written.
    expect(result.capability.outcomes.map((outcome) => outcome.code)).toEqual([
      "NO_SUCH_ENTITY",
      "RECORD_LOCKED",
      "PERMISSION_DENIED",
    ]);
    // The pattern reaches the artifact verbatim — no canonicalization, no re-derivation. §28's rule
    // is about a declared param's *sample*, and this regex is matched against rendered page text,
    // where the id appears as itself.
    expect(result.capability.outcomes[0]?.detect).toEqual({
      kind: "text-on-page",
      pattern: String.raw`No member \d{5} on file`,
    });
    expect(result.capability.provenance.reviewedBy).toBe("human");

    // The recording is not edited in place: the pass returns a document, and the one that came out of
    // the recorder still says what the recorder said.
    expect(artifact.outcomes).toEqual([]);
    expect(artifact.provenance.reviewedBy).toBeUndefined();
  });

  it("leaves a recording with nothing curated unreviewed, and untouched", () => {
    const artifact = recorded();
    const result = reviewCapability({ capability: artifact, run: runObserving([read("$4,201.55")]), seeds: [] });

    // §4.1 gives `reviewedBy` presence semantics, so this pass may only set it when a human's
    // declarations are actually in the artifact — otherwise the field would mean "the CLI ran".
    expect(result.reviewed).toBe(false);
    expect(result.capability).toBe(artifact);
    expect(result.notes.join(" ")).toContain("unreviewed");
  });
});

describe("refusing a signature the app cannot satisfy", () => {
  it("refuses one that fires on text the happy path showed", () => {
    // §10's fixture duplicates visible text on purpose, and this is the mistake that invites:
    // `Savings` reads like the label of the row the capability wants, and it is on screen for the
    // whole of a successful replay. A signature is probed as each step settles, *ahead* of that
    // step's expectation, so this one would end every successful replay as UNEXPECTED_STATE.
    const error = thrownBy({
      capability: recorded(),
      run: runObserving([act({ node: digest("Savings"), textAfter: "Savings" }), read("$4,201.55")]),
      seeds: [seed({ code: "RECORD_LOCKED", pattern: "Savings" })],
    });

    expect(error).toBeInstanceOf(ReviewRefusedError);
    expect(error.message).toContain("RECORD_LOCKED");
    expect(error.message).toContain("Savings");
    expect(error.message).toContain("happy path");
  });

  it("refuses a message that interpolates an input this recording never declared", () => {
    const error = thrownBy({
      capability: recorded(),
      run: runObserving([read("$4,201.55")]),
      // A pattern that matches nothing the run showed, so the check that fires is provably the
      // message one: the seed's *text* is fine, and its *sentence* is not.
      seeds: [
        seed({ code: "NO_SUCH_ENTITY", message: "No member {accountId} on file", pattern: String.raw`No member \d{5} on file` }),
      ],
    });

    // The seed is written for the app, but a message is written for one capability's callers — so it
    // has to resolve against *this* recording's inputs, and the error names both sides.
    expect(error).toBeInstanceOf(ReviewRefusedError);
    expect(error.message).toContain("{accountId}");
    expect(error.message).toContain("memberId");
  });

  it("leaves the rules it shares with validation to validation", () => {
    // Decision 2 of the module header: duplicate codes are `validate.ts`'s rule, reported at the
    // artifact path a caller would see. A pass that checked it too would be rule number two for one
    // rule — and the re-validation is what proves the assembled document is the one that was checked.
    const error = thrownBy({
      capability: recorded(),
      run: runObserving([]),
      seeds: [
        seed({ code: "RECORD_LOCKED", pattern: "Member \\d{5} is locked" }),
        seed({ code: "RECORD_LOCKED", pattern: "This record is locked" }),
      ],
    });

    expect(error).toBeInstanceOf(CapabilityInvalidError);
    expect((error as CapabilityInvalidError).issues.map((issue) => issue.path)).toContain("outcomes.1.code");
  });
});

describe("the haystack a signature is checked against", () => {
  const EVERY_ARM = runObserving([
    act({ node: digest("Member ID"), textBefore: "Search", textAfter: "12345" }),
    navigate({
      delta: delta({ kind: "appeared", node: digest("Results"), target: TARGET, from: "Nothing", to: "Member 12345" }),
    }),
    { kind: "read", turn: 1, index: 0, node: digest("Balance cell"), target: TARGET, text: "$4,201.55" },
  ]);

  it("collects the acted node's text, its post-action text, the anchor's, and what was read", () => {
    // One case per arm of the walk, each naming a string only that arm can contribute — because a
    // haystack that silently skips an arm still passes every other test in this file, and would only
    // ever show up as a bad signature that shipped.
    const patterns = [
      "Member ID", // the acted node's own name
      "Search", // its text before the action
      "12345", // and after it
      "Results", // the delta anchor's node
      "Nothing", // the anchor's text before
      "Member 12345", // and after
      "Balance cell", // what a read was taken from
      "\\$4,201\\.55", // and what it read
    ];
    for (const pattern of patterns) {
      const error = thrownBy({ capability: recorded(), run: EVERY_ARM, seeds: [seed({ pattern })] });
      expect(error, `expected ${pattern} to be refused`).toBeInstanceOf(ReviewRefusedError);
    }
  });

  it("does not treat a URL as page text", () => {
    // The direction that costs a capability rather than shipping a broken one: a `text-on-page`
    // signature is matched against rendered text, so a pattern that only matches a path can never
    // fire at replay, and refusing it here would fail a recording for a signature that is merely
    // useless in the way every signature for an absent state is useless until that state arrives.
    const result = reviewCapability({
      capability: recorded(),
      run: EVERY_ARM,
      seeds: [seed({ pattern: "/member/12345/summary" })],
    });
    expect(result.reviewed).toBe(true);
  });
});
