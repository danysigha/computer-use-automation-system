/**
 * The stuck detector (§8) — three counters, and the boundary between "still working" and "wandering".
 *
 * The failure this catches never looks like an error: a model that cannot reach the goal keeps
 * making valid tool calls against a page that never changes. So the tests are about the *edges* —
 * the action that finally crosses a limit, and the action that resets a counter — because an
 * off-by-one here is the difference between a run that hands back and a run that burns its budget
 * against a wall.
 */
import { describe, expect, it } from "vitest";
import { describeStuck, stateDigest, StuckDetector, type ObservedCall } from "../../src/agent/stuck.ts";
import type { Snapshot, SnapshotNode } from "../../src/surface/observer.ts";

const BUDGETS = { maxToolCalls: 25, noProgressActions: 5, repeatLimit: 3 };

function call(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return { tool: "click", targetKey: "role=button:Search", state: "s1", ...overrides };
}

let wanderToken = 0;

/**
 * A call that acts on a *different* control every time, so the only counter that can fire is
 * no-progress — the repeat limit would otherwise trip first and mask what is being tested.
 */
function wander(state: string): ObservedCall {
  wanderToken += 1;
  return { tool: "click", targetKey: `role=link:row ${wanderToken}`, state };
}

/** A snapshot literal — `stateDigest` reads plain data, so no browser belongs in this test. */
function snapshot(url: string, nodes: readonly Partial<SnapshotNode>[]): Snapshot {
  const numbered = nodes.map((node, index) => ({
    index,
    role: "cell",
    name: "",
    text: "",
    url: null,
    framePath: [],
    ref: null,
    state: [],
    children: [],
    ...node,
  })) as SnapshotNode[];
  return { url, title: "t", root: [], numbered, frameCount: 0 };
}

describe("the state hash", () => {
  it("changes when a node's text changes — a form that accepted input is progress", () => {
    const before = snapshot("http://a/", [{ text: "" }]);
    const after = snapshot("http://a/", [{ text: "12345" }]);
    expect(stateDigest(after)).not.toBe(stateDigest(before));
  });

  it("changes when the page moves, even if the tree does not", () => {
    expect(stateDigest(snapshot("http://a/", [{ text: "x" }]))).not.toBe(
      stateDigest(snapshot("http://a/b", [{ text: "x" }])),
    );
  });

  it("is stable for the same page, which is what makes it a detector and not noise", () => {
    expect(stateDigest(snapshot("http://a/", [{ text: "x" }]))).toBe(
      stateDigest(snapshot("http://a/", [{ text: "x" }])),
    );
  });

  it("does not depend on a rendering policy — truncation must never read as progress (§24)", () => {
    // The digest the model reads is size-capped and elides rows. Hashing *that* would make a page
    // that grew past the cap look unchanged, and would report "stuck" for a run that was moving.
    const many = Array.from({ length: 40 }, (_, index) => ({ text: `row ${index}` }));
    expect(stateDigest(snapshot("http://a/", many))).toBe(stateDigest(snapshot("http://a/", many)));
  });
});

describe("the three counters", () => {
  it("reports nothing while every action changes the page", () => {
    const detector = new StuckDetector(BUDGETS);
    for (let step = 0; step < 10; step += 1) {
      expect(detector.observe(wander(`s${step}`))).toBeNull();
    }
  });

  it("stops on no-progress at the limit, not before it", () => {
    const detector = new StuckDetector(BUDGETS);
    detector.observe(wander("same")); // the first observation is progress by definition
    for (let repeat = 1; repeat < BUDGETS.noProgressActions; repeat += 1) {
      expect(detector.observe(wander("same"))).toBeNull();
    }
    const stuck = detector.observe(wander("same"));
    expect(stuck).toEqual({ kind: "no-progress", actions: BUDGETS.noProgressActions, limit: 5 });
  });

  it("resets no-progress the moment the page moves again", () => {
    const detector = new StuckDetector(BUDGETS);
    detector.observe(wander("same"));
    for (let repeat = 0; repeat < BUDGETS.noProgressActions - 1; repeat += 1) detector.observe(wander("same"));
    detector.observe(wander("moved")); // progress — the run is not stuck
    expect(detector.observe(wander("moved"))).toBeNull();
  });

  it("stops on a repeated action even while the page keeps changing", () => {
    // The case the other two counters cannot see: real progress elsewhere, a loop on one control.
    const detector = new StuckDetector(BUDGETS);
    detector.observe(call({ state: "s1", targetKey: "role=button:Search" }));
    detector.observe(call({ state: "s2", targetKey: "role=button:Search" }));
    expect(detector.observe(call({ state: "s3", targetKey: "role=button:Search" }))).toEqual({
      kind: "repeat",
      count: 3,
      limit: 3,
      tool: "click",
      targetKey: "role=button:Search",
    });
  });

  it("counts a repeat against the target's identity, not against a snapshot-scoped index", () => {
    // Node 7 is a different element after a navigation, so two clicks on "index 7" are not a
    // repeat unless they resolved the same way — which is what `targetKey` records.
    const detector = new StuckDetector(BUDGETS);
    detector.observe(call({ state: "s1", targetKey: "role=button:Search" }));
    detector.observe(call({ state: "s2", targetKey: "role=button:Cancel" }));
    detector.observe(call({ state: "s3", targetKey: "role=button:Search" }));
    // Two Searches and one Cancel: the Cancel is not a Search, and nothing has happened thrice.
    expect(detector.observe(call({ state: "s4", targetKey: "role=button:Cancel" }))).toBeNull();
    // The third Search is a loop whatever the Cancel clicks did in between: the counter is over
    // the action's identity, not over consecutive runs of one action.
    expect(detector.observe(call({ state: "s5", targetKey: "role=button:Search" }))?.kind).toBe("repeat");
  });

  it("spends the budget last, and only when the run has actually exceeded it", () => {
    const detector = new StuckDetector({ maxToolCalls: 3, noProgressActions: 99, repeatLimit: 99 });
    for (let step = 1; step <= 3; step += 1) {
      expect(detector.observe(wander(`s${step}`))).toBeNull();
    }
    expect(detector.observe(wander("s4"))).toEqual({
      kind: "budget",
      toolCalls: 4,
      limit: 3,
    });
  });

  it("prefers the specific reason when two limits land on the same call", () => {
    // "you clicked Search three times" is a better thing to tell a human than "nothing changed
    // five times", even when the counters agree.
    const detector = new StuckDetector({ maxToolCalls: 99, noProgressActions: 3, repeatLimit: 3 });
    detector.observe(call({ state: "same" }));
    detector.observe(call({ state: "same" }));
    expect(detector.observe(call({ state: "same" }))?.kind).toBe("repeat");
  });

  it("counts its own tool calls, so the run log can report the budget it spent", () => {
    const detector = new StuckDetector(BUDGETS);
    detector.observe(call({ state: "a" }));
    detector.observe(call({ state: "b" }));
    expect(detector.toolCalls).toBe(2);
  });
});

describe("observations are not actions", () => {
  it("does not count reads as no-progress — reading is the job, not wandering", () => {
    // A goal with several outputs makes the model read several values in a row with the page
    // standing still. The budget's counter is `toolCalls`; this one is `noProgressActions`, and a
    // detector that ended the run here would report a stuck agent where there is only one that
    // looked before it reported.
    const detector = new StuckDetector(BUDGETS);
    for (let step = 0; step < BUDGETS.noProgressActions + 2; step += 1) {
      expect(detector.observe({ tool: "read", targetKey: `role:cell ${step}`, state: "same" })).toBeNull();
    }
  });

  it("does not let a read reset a genuine run of no-op actions", () => {
    // The other half of the exemption: skipping the counter must not mean clearing it. Five
    // no-op actions are a loop whether or not a read sits in the middle of them. `wander` moves to
    // a different control every call, so the repeat limit cannot fire first and mask the answer.
    const detector = new StuckDetector(BUDGETS);
    detector.observe(wander("same"));
    detector.observe({ tool: "read", targetKey: "role:cell", state: "same" });
    for (let repeat = 1; repeat < BUDGETS.noProgressActions; repeat += 1) detector.observe(wander("same"));
    expect(detector.observe(wander("same"))?.kind).toBe("no-progress");
  });

  it("still catches an observation loop through the repeat counter", () => {
    // Reading the same cell three times is not progress either, and nothing else would see it.
    const detector = new StuckDetector(BUDGETS);
    detector.observe({ tool: "read", targetKey: "role:cell", state: "same" });
    detector.observe({ tool: "read", targetKey: "role:cell", state: "same" });
    expect(detector.observe({ tool: "read", targetKey: "role:cell", state: "same" })?.kind).toBe("repeat");
  });

  it("counts a read against the budget, so reading forever is still bounded", () => {
    // Neither counter is left without a job: no-progress is for action loops, the budget is the
    // backstop for every other kind.
    const detector = new StuckDetector({ maxToolCalls: 2, noProgressActions: 99, repeatLimit: 99 });
    detector.observe({ tool: "read", targetKey: "a", state: "s1" });
    detector.observe({ tool: "read", targetKey: "b", state: "s1" });
    expect(detector.observe({ tool: "read", targetKey: "c", state: "s1" })?.kind).toBe("budget");
  });
});

describe("describing a stop", () => {
  it("says which limit was hit and what it means", () => {
    expect(describeStuck({ kind: "budget", toolCalls: 26, limit: 25 })).toContain("26/25");
    expect(describeStuck({ kind: "repeat", count: 3, limit: 3, tool: "click", targetKey: "role=button:Search" }))
      .toContain("role=button:Search");
    expect(describeStuck({ kind: "no-progress", actions: 5, limit: 5 })).toContain("left the page unchanged");
  });
});
