/**
 * The recorder (§9, §27, §28) — the trace read back as an artifact.
 *
 * Against hand-built traces rather than a browser, and the division is deliberate: the integration
 * run next door proves a *real* recording comes out valid, while the rules this file pins are ones a
 * successful run cannot reach. A gated step, a sensitive write, an act with no expressible
 * postcondition, a read that supplies two outputs — none of them happen on the happy path, and all
 * of them are places where being wrong is invisible in the artifact that results.
 *
 * The traces are built from the same types the loop produces, so a change to `trace.ts` that broke
 * these inputs would fail `typecheck` here rather than silently stop testing anything.
 */
import { describe, expect, it } from "vitest";
import { BindingLog, type ParamSample } from "../../src/agent/canonicalize.ts";
import { recordCapability, identifierFor, RecordingRefusedError } from "../../src/agent/recorder.ts";
import type { DiscoveryRun } from "../../src/agent/loop.ts";
import type {
  ActTrace,
  EntryTrace,
  NodeDigest,
  ReadTrace,
  StateDelta,
  TraceEntry,
} from "../../src/agent/trace.ts";
import { Policy } from "../../src/policy/policy.ts";
import type { AppIdentity } from "../../src/schema/artifact.ts";
import type { TargetDescriptor } from "../../src/surface/target.ts";

const SEARCH: TargetDescriptor = {
  candidates: [{ strategy: "role", role: "button", name: "Search" }],
  framePath: [],
};

const CELL: NodeDigest = { index: 7, role: "cell", name: "$1,204.55", text: "", framePath: [1] };

const IDENTITY: AppIdentity = { product: "atlas-console", variant: "base", version: "0.1" };

/* -------------------------------------------------------------------------- */
/* Traces, built the way the loop builds them                                   */
/* -------------------------------------------------------------------------- */

function delta(overrides: Partial<StateDelta> = {}): StateDelta {
  return {
    beforeUrl: "http://app/",
    afterUrl: "http://app/",
    urlChanged: false,
    counts: { appeared: 0, disappeared: 0, changed: 0 },
    anchor: null,
    ...overrides,
  };
}

function entry(url = "http://app/"): EntryTrace {
  return { kind: "entry", turn: 0, url };
}

function act(overrides: Partial<ActTrace> = {}): ActTrace {
  return {
    kind: "act",
    turn: 1,
    action: "click",
    index: 0,
    node: { index: 0, role: "button", name: "Search", text: "", framePath: [] },
    target: SEARCH,
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

function read(text: string, node: NodeDigest = CELL): ReadTrace {
  return { kind: "read", turn: 2, index: 3, node, target: SEARCH, text };
}

function runOf(trace: readonly TraceEntry[], outputs: Readonly<Record<string, string>>): DiscoveryRun {
  return {
    goal: "read the balance",
    model: "test-model",
    entry: "http://app/",
    finalUrl: "http://app/member/12345/summary",
    ending: { kind: "completed", outputs },
    trace,
    turns: trace.length,
  };
}

async function policy(fieldPatterns: readonly string[]): Promise<Policy> {
  return Policy.load({ env: {}, overrides: { redact: { fieldPatterns: [...fieldPatterns], outputIds: [] } } });
}

function record(
  trace: readonly TraceEntry[],
  outputs: Readonly<Record<string, string>>,
  options: { params?: readonly ParamSample[]; fieldPatterns?: readonly string[] } = {},
) {
  const params = options.params ?? [];
  return policy(options.fieldPatterns ?? ["ssn", "password"]).then((loaded) =>
    recordCapability({
      run: runOf(trace, outputs),
      id: "member-savings-balance",
      name: "Member savings balance",
      description: "d",
      params,
      identity: IDENTITY,
      policy: loaded,
      discoveryRunId: "run-1",
      recordedAt: "2026-09-15T00:00:00.000Z",
      bindings: new BindingLog(params),
    }),
  );
}

/* -------------------------------------------------------------------------- */

describe("what becomes a step", () => {
  it("numbers the steps it emits and skips the entries that are not steps", async () => {
    // The bootstrap navigation and an unconsumed read are both *observations*. The read is the case
    // worth pinning: it sits in the middle of the trace and produces no step, so a recorder that
    // numbered by trace position would give the extract an id one too high — and the artifact would
    // validate, because ids only have to be positive and unique.
    const { capability } = await record(
      [entry(), act({ delta: delta({ urlChanged: true, afterUrl: "http://app/member/12345/summary" }) }), read("$9.99", { ...CELL, name: "$9.99" }), read("$1,204.55")],
      { balance: "$1,204.55" },
      { params: [{ name: "memberId", value: "12345" }] },
    );

    expect(capability.steps.map((step) => step.kind)).toEqual(["act", "extract"]);
    expect(capability.steps.map((step) => step.id)).toEqual([1, 2]);
    expect(capability.outputs[0]?.source.stepId).toBe(2);
  });

  it("gives two outputs read from one cell their own extract steps", async () => {
    // A model may report the same string under two names. Both need a step, because `Output.source`
    // names one and the id has to be unique — so the second id is new rather than shared.
    const { capability } = await record([entry(), read("$1,204.55")], {
      balance: "$1,204.55",
      savings: "$1,204.55",
    });

    expect(capability.steps.map((step) => step.id)).toEqual([1, 2]);
    expect(capability.steps.map((step) => (step.kind === "extract" ? step.name : ""))).toEqual([
      "balance",
      "savings",
    ]);
    expect(capability.outputs.map((output) => output.source.stepId)).toEqual([1, 2]);
  });

  it("calls a value read out of a grid position a table-cell, and anything else text", async () => {
    const { capability } = await record(
      [entry(), read("$1,204.55", CELL), read("Savings", { ...CELL, role: "heading", name: "Savings" })],
      { balance: "$1,204.55", kind: "Savings" },
    );
    expect(capability.steps.map((step) => (step.kind === "extract" ? step.as : ""))).toEqual([
      "table-cell",
      "text",
    ]);
  });
});

describe("the expect, derived from what the run observed", () => {
  it("prefers the route's shape when the action navigated", async () => {
    const { capability } = await record(
      [
        entry(),
        act({
          // Both are true here: the page moved *and* the node's text moved. The URL wins, and the
          // reason is the one that matters at replay — the node the step acted on is usually gone
          // after a navigation, so a `textEquals` naming it would assert about an element that no
          // longer exists.
          textBefore: "Search",
          textAfter: "Searching",
          delta: delta({ urlChanged: true, afterUrl: "http://app/member/12345/summary" }),
        }),
      ],
      {},
    );
    expect(capability.steps[0]).toMatchObject({ expect: { urlMatches: "/member/:id/summary" } });
  });

  it("falls back to the location when the path has no shape to patternize", async () => {
    // `/search` has no entity segment, so `routePattern` refuses (a variable-free `urlMatches` is
    // rejected at validate), and the fallback keeps the query rather than dropping it — the query is
    // the part of the location that says *which* member, and it carries the binding.
    const { capability } = await record(
      [
        entry(),
        act({
          delta: delta({ urlChanged: true, afterUrl: "http://app/search?memberId=12345" }),
        }),
      ],
      {},
      { params: [{ name: "memberId", value: "12345" }] },
    );
    expect(capability.steps[0]).toMatchObject({ expect: { urlContains: "/search?memberId={memberId}" } });
  });

  it("asserts the field accepted the input when nothing navigated", async () => {
    const { capability } = await record(
      [
        entry(),
        act({
          action: "type",
          value: "12345",
          textBefore: "",
          textAfter: "12345",
        }),
      ],
      {},
      { params: [{ name: "memberId", value: "12345" }] },
    );
    // The binding reaches the assertion, which is §28's proof case: the check that the field took
    // the value must not pin the artifact to the value.
    expect(capability.steps[0]).toMatchObject({
      value: "{memberId}",
      expect: { textEquals: { value: "{memberId}" } },
    });
  });

  it("asserts an appearance, and otherwise a text change elsewhere on the page", async () => {
    const anchorTarget: TargetDescriptor = {
      candidates: [{ strategy: "role", role: "heading", name: "Member Summary" }],
      framePath: [],
    };
    const node: NodeDigest = { index: 5, role: "heading", name: "Member Summary", text: "", framePath: [] };

    const appeared = await record(
      [
        entry(),
        act({
          delta: delta({
            counts: { appeared: 1, disappeared: 0, changed: 0 },
            anchor: { kind: "appeared", node, target: anchorTarget, from: null, to: "Member Summary" },
          }),
        }),
      ],
      {},
    );
    expect(appeared.capability.steps[0]).toMatchObject({ expect: { elementExists: anchorTarget } });

    const changed = await record(
      [
        entry(),
        act({
          delta: delta({
            counts: { appeared: 0, disappeared: 0, changed: 1 },
            anchor: { kind: "changed", node, target: anchorTarget, from: "Summary", to: "Member Summary" },
          }),
        }),
      ],
      {},
    );
    expect(changed.capability.steps[0]).toMatchObject({
      expect: { textEquals: { target: anchorTarget, value: "Member Summary" } },
    });
  });

  it("refuses rather than inventing one, when the action only removed nodes", async () => {
    // The reachable dead end: `elementAbsent` is the assertion for a removal, but a chain has to be
    // captured while the element is live. §4.1 makes `expect` mandatory so this cannot be papered
    // over — and a refusal during recording is visible, where an invented assertion would not be.
    await expect(
      record(
        [entry(), act({ delta: delta({ counts: { appeared: 0, disappeared: 1, changed: 0 } }) })],
        {},
      ),
    ).rejects.toBeInstanceOf(RecordingRefusedError);
  });
});

describe("what is stamped, never defaulted", () => {
  it("marks the artifact approval-gated, naming exactly the steps policy gated", async () => {
    const { capability } = await record(
      [
        entry(),
        act({ delta: delta({ urlChanged: true, afterUrl: "http://app/member/12345/summary" }) }),
        act({
          verdict: { rule: "risk.approval-required", approvalRequired: true },
          delta: delta({ urlChanged: true, afterUrl: "http://app/member/12345/done" }),
        }),
      ],
      {},
      { params: [{ name: "memberId", value: "12345" }] },
    );

    // The id, not a count: `risk.irreversibleSteps` is what replay reads to decide which step needs
    // a human, so naming the wrong one is the same as gating the wrong action.
    expect(capability.risk).toEqual({ class: "approval-gated", irreversibleSteps: [2] });
  });

  it("leaves a run that gated nothing safe, with an empty list", async () => {
    const { capability } = await record(
      [entry(), act({ delta: delta({ urlChanged: true, afterUrl: "http://app/member/12345/summary" }) })],
      {},
      { params: [{ name: "memberId", value: "12345" }] },
    );
    expect(capability.risk).toEqual({ class: "safe", irreversibleSteps: [] });
  });

  it("redacts an output whose name policy calls sensitive", async () => {
    const { capability } = await record([entry(), read("123-45-6789", { ...CELL, name: "123-45-6789" })], {
      ssn: "123-45-6789",
    });
    expect(capability.outputs[0]?.redact).toBe(true);
  });

  it("redacts an output read from a node policy calls sensitive, whatever the value was named", async () => {
    // The half that a name-only rule misses, and the reason §27 says "its name **or** its extract
    // target": a model that reports `{"value": "123-45-6789"}` has chosen an innocuous name for a
    // number read out of the taxpayer field, and a stamp keyed on the name alone would clear it.
    const { capability } = await record(
      [entry(), read("123-45-6789", { ...CELL, name: "Taxpayer SSN" })],
      { value: "123-45-6789" },
    );
    expect(capability.outputs[0]?.redact).toBe(true);
  });

  it("does not redact an ordinary value, which is the failure that costs an answer", async () => {
    const { capability } = await record([entry(), read("$1,204.55")], { balance: "$1,204.55" });
    expect(capability.outputs[0]?.redact).toBe(false);
  });

  it("warns when a sensitive step would carry its value as a literal", async () => {
    const trace = [
      entry(),
      act({
        action: "type",
        value: "hunter2",
        sensitive: true,
        textBefore: "",
        textAfter: "hunter2",
        delta: delta({ counts: { appeared: 0, disappeared: 0, changed: 1 } }),
      }),
    ];

    const unbound = await record(trace, {});
    expect(unbound.warnings.join(" ")).toContain("sensitive");

    // Bound to a declared input, it is the caller's value rather than a literal in the file — which
    // is what the warning is asking for, so it goes quiet.
    const bound = await record(trace, {}, { params: [{ name: "passcode", value: "hunter2" }] });
    expect(bound.warnings).toEqual([]);
    expect(bound.capability.steps[0]).toMatchObject({ value: "{passcode}" });
  });
});

describe("the model's words, as names an artifact can use", () => {
  it("turns a prose label into an identifier, and says so", async () => {
    // The live discovery run named its output "current savings balance" — a good answer to "what did
    // you read" and an illegal `Output.name`. The recorder translates rather than asking the model to
    // camel-case, and the rename is a warning because a reader comparing the artifact against the run
    // log should not have to guess that two different words are one value.
    const { capability, warnings } = await record([entry(), read("$1,204.55")], {
      "current savings balance": "$1,204.55",
    });

    expect(capability.outputs.map((output) => output.name)).toEqual(["currentSavingsBalance"]);
    expect(capability.steps.map((step) => (step.kind === "extract" ? step.name : ""))).toEqual([
      "currentSavingsBalance",
    ]);
    expect(warnings.join(" ")).toContain("current savings balance");
    expect(warnings.join(" ")).toContain("currentSavingsBalance");
  });

  it("leaves a label that is already an identifier alone, and stays quiet about it", async () => {
    const { capability, warnings } = await record([entry(), read("$1,204.55")], { balance: "$1,204.55" });
    expect(capability.outputs.map((output) => output.name)).toEqual(["balance"]);
    expect(warnings).toEqual([]);
  });

  it("keeps the extract step's name and its output's name the same", async () => {
    // The one cross-reference the schema checks by name: `Output.source.stepId` must point at an
    // extract step *called the same thing*. Translating at one site and not the other would produce an
    // artifact that validates and reads its own output from a differently-named step.
    const { capability } = await record([entry(), read("$1,204.55")], { "Member Balance": "$1,204.55" });
    const step = capability.steps.find((candidate) => candidate.kind === "extract");
    expect(step?.kind === "extract" && step.name).toBe(capability.outputs[0]?.name);
  });

  it("disambiguates two labels that reduce to one identifier", async () => {
    // "current balance" and "currentBalance" are two outputs the model declared and two values the run
    // read. Reducing both to one name would drop one of them silently — the artifact would be valid and
    // missing an answer.
    const { capability } = await record([entry(), read("$1,204.55"), read("$9.99")], {
      "current balance": "$1,204.55",
      currentBalance: "$9.99",
    });
    expect(capability.outputs.map((output) => output.name)).toEqual(["currentBalance", "currentBalance2"]);
    expect(capability.outputs.map((output) => output.source.stepId)).toEqual([1, 2]);
  });

  it("still stamps redact from the model's own words", async () => {
    // §27: the stamp comes from the run's classifications, and the model's label is one of them. A
    // regex literal is tested as written, so `/taxpayer ssn/` matches the label and *not* the
    // identifier it was translated into — which makes this the test that fails if the translation
    // quietly drops the model's words from the redaction check.
    const { capability } = await record(
      [entry(), read("123-45-6789", { ...CELL, name: "123-45-6789" })],
      { "taxpayer ssn": "123-45-6789" },
      { fieldPatterns: ["/taxpayer ssn/"] },
    );
    expect(capability.outputs[0]?.name).toBe("taxpayerSsn");
    expect(capability.outputs[0]?.redact).toBe(true);
  });

  it("translates a label the schema would refuse, rather than emitting it and failing to save", () => {
    // The pure half, table-style, because these are the shapes a model's phrasing actually takes.
    expect(identifierFor("current savings balance")).toBe("currentSavingsBalance");
    expect(identifierFor("Balance")).toBe("balance");
    expect(identifierFor("SSN")).toBe("ssn");
    expect(identifierFor("member SSN")).toBe("memberSSN");
    expect(identifierFor("account #")).toBe("account");
    expect(identifierFor("12345 balance")).toBe("balance");
    expect(identifierFor("2fast balance")).toBe("fastBalance");
    expect(identifierFor("balance ($)")).toBe("balance");
    expect(identifierFor("currentBalance")).toBe("currentBalance");
    expect(identifierFor("$4,201.55")).toBeNull();
    expect(identifierFor("   ")).toBeNull();
  });
});

describe("a run with nothing to record", () => {
  it("refuses to emit an artifact for a run that did not reach its goal", async () => {
    const params: ParamSample[] = [];
    const loaded = await policy(["ssn"]);
    expect(() =>
      recordCapability({
        run: {
          ...runOf([entry()], {}),
          ending: { kind: "stuck", reason: { kind: "budget", toolCalls: 26, limit: 25 } },
        },
        id: "x",
        name: "n",
        description: "d",
        params,
        identity: IDENTITY,
        policy: loaded,
        discoveryRunId: "run-1",
        bindings: new BindingLog(params),
      }),
    ).toThrow(RecordingRefusedError);
  });
});
