/**
 * §8's token machine, lease arithmetic and console grammar, without a browser.
 *
 * The integration suite next door proves the handoff *works*; this file proves the rules that make it
 * safe are the rules written down. They are separable on purpose: the lease is arithmetic, the
 * authorization is a comparison, the grammar is a parser, and a test that needed Chromium to check
 * that a lapsed token re-raises would be a test nobody runs.
 *
 * The fake surface is the seam §11's division asks for — `ControlSurface` is the subset of
 * `SessionDriver` the controller touches, so a fake is a small object rather than a browser double,
 * and the clock is injected for the same reason: a lease test that spends ten real seconds to watch a
 * lease lapse is a lease test that gets deleted.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { Controller, ControlError, type ControlSurface } from "../../src/control/controller.ts";
import {
  describeCommand,
  parseConsoleLine,
  renderModel,
  renderProgress,
  renderState,
} from "../../src/control/console-tui.ts";
import { DEFAULT_TIMING } from "../../src/policy/policy.ts";
import { Redactor } from "../../src/policy/redact.ts";
import type { EvidenceLine, StampedLine } from "../../src/surface/evidence.ts";
import { stateDigest, type Snapshot, type SnapshotNode } from "../../src/surface/observer.ts";
import type { ExecuteOptions, ExecutedAction, SurfaceAction } from "../../src/surface/session-driver.ts";
import { parseArgs as operatorArgs } from "../../src/cli/operator.ts";
import { terminalIo } from "../../src/cli/operator.ts";
import { humanAssistedRefusal } from "../../src/cli/discover.ts";

/* -------------------------------------------------------------------------- */
/* A surface small enough to reason about                                      */
/* -------------------------------------------------------------------------- */

function node(index: number, role: string, name: string, text = ""): SnapshotNode {
  return { index, role, name, text, url: null, framePath: [], ref: `r${index}`, state: [], children: [] };
}

function snapshot(url: string, nodes: readonly SnapshotNode[]): Snapshot {
  return { url, title: "stub", root: nodes, numbered: nodes, frameCount: 0 };
}

interface Fake extends ControlSurface {
  readonly lines: StampedLine[];
  setSnapshot(next: Snapshot): void;
}

function fakeSurface(): Fake {
  let current = snapshot("http://example.test/", [node(0, "textbox", "Member ID"), node(1, "button", "Search")]);
  const lines: StampedLine[] = [];
  return {
    // The controller touches none of these on the paths under test; a fake that implemented a browser
    // would be a browser.
    page: {} as ControlSurface["page"],
    observer: { nodeAt: (snap, index) => snap.numbered[index] ?? null, elementFor: async () => null },
    evidence: { lines },
    evidenceDir: "/tmp/run",
    snapshot: async () => current,
    render: async () => `# stub — ${current.url}`,
    execute: async (action: SurfaceAction, options?: ExecuteOptions) => {
      lines.push({
        seq: lines.length + 1,
        at: new Date().toISOString(),
        kind: "action",
        actor: options?.actor ?? "agent",
        ...(options?.channel === undefined ? {} : { channel: options.channel }),
        action: action.kind,
      });
      // A real click changes the page; the lease tests care that the digest *can* move.
      current = snapshot(current.url, [...current.numbered, node(current.numbered.length, "link", "OK")]);
      return { action, verdict: { allowed: true, approvalRequired: false, reason: "", rule: "test" }, approval: "not-required", sensitive: false } satisfies ExecutedAction;
    },
    screenshot: async () => ({ kind: "suppressed", reason: "no pixels in a fake", fields: [] }),
    log: async (line: EvidenceLine) => {
      lines.push({ seq: lines.length + 1, at: new Date().toISOString(), ...line });
    },
    lines,
    setSnapshot: (next) => {
      current = next;
    },
  };
}

function controllerWith(overrides: {
  readonly now?: () => number;
  readonly timing?: Partial<Record<keyof typeof DEFAULT_TIMING, number>>;
  readonly surface?: Fake;
} = {}) {
  const surface = overrides.surface ?? fakeSurface();
  const notes: string[] = [];
  const controller = new Controller({
    surface,
    timing: { ...DEFAULT_TIMING, ...overrides.timing },
    stage: "replay",
    runId: "test-capability",
    redactor: new Redactor({ fieldPatterns: [] }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    onNote: (line) => notes.push(line),
  });
  return { controller, surface, notes };
}

/**
 * The nonce the operator would read *now* — the latest announcement.
 *
 * Read out of the narration rather than off the Controller, which is the point: the nonce's only route
 * to a console is the run's terminal, exactly as §8 describes it.
 */
/** Wait for `escalate`'s own async work (the snapshot and the screenshot) to publish the request. */
async function raised(controller: Controller): Promise<void> {
  for (let tick = 0; tick < 400; tick += 1) {
    if (controller.escalation !== null) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("the escalation was never raised");
}

function nonceOf(notes: readonly string[]): string {
  const line = [...notes].reverse().find((note) => note.includes("--nonce")) ?? "";
  return /--nonce ([0-9a-f]+)/.exec(line)?.[1] ?? "";
}

const request = {
  code: "INTERSTITIAL_DIALOG" as const,
  stepId: 7,
  reason: "policy does not know this dialog",
  url: "http://example.test/member/1/summary",
  observed: "Workstation policy notice (ref WS-1)",
  evidenceDir: "/tmp/run",
};

/* -------------------------------------------------------------------------- */
/* The takeover credential                                                     */
/* -------------------------------------------------------------------------- */

describe("the takeover nonce", () => {
  it("is at least 128 bits, printed for the operator, and single-use", async () => {
    const { controller, notes } = controllerWith();
    const pending = controller.escalate(request);
    await raised(controller);

    expect(notes.some((note) => note.includes("--nonce"))).toBe(true);
    const nonce = nonceOf(notes);
    // §8's floor is 128 bits; this is 256, and the test pins the floor rather than the spelling.
    expect(nonce.length * 4).toBeGreaterThanOrEqual(128);
    expect(nonce).toMatch(/^[0-9a-f]+$/);

    const session = await controller.acquire(nonce);
    expect(session.bearer).toHaveLength(64);
    // Spent, superseded, or never issued — three different refusals, all named.
    await expect(controller.acquire(nonce)).rejects.toThrow(ControlError);
    // A nonce that was never issued is not a credential either — and the refusal does not say which
    // half of the pair was wrong.
    await expect(controller.acquire("0".repeat(64))).rejects.toMatchObject({ code: "bad-nonce" });

    await controller.decline(session.bearer);
    expect(await pending).toBe("declined");
  });

  it("is regenerated when a lease lapses, and the old one is refused by name", async () => {
    let clock = 1_000;
    const { controller, notes } = controllerWith({
      now: () => clock,
      timing: { heartbeatMs: 10, leaseTtlMs: 50, escalationTimeoutMs: 10_000 },
    });
    void controller.escalate(request);
    await raised(controller);
    const firstNonce = nonceOf(notes);
    const { bearer } = await controller.acquire(firstNonce);

    // The console stops heartbeating. §8's liveness rule: the token comes back, the escalation
    // re-raises, and the credential that lapsed with it is dead.
    clock += 51;
    await new Promise((done) => setTimeout(done, 60));
    expect(controller.escalation?.reRaised).toBe(1);
    expect(controller.token).toBe("paused");
    const secondNonce = nonceOf(notes);
    expect(secondNonce).not.toBe(firstNonce);
    await expect(controller.status(bearer, "compact")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(controller.acquire(firstNonce)).rejects.toMatchObject({ code: "spent-nonce" });
  });
});

/* -------------------------------------------------------------------------- */
/* The escalation lifecycle                                                    */
/* -------------------------------------------------------------------------- */

describe("an escalation with nobody on the other end", () => {
  it("terminates as unavailable at its deadline, and says so in the log", async () => {
    const { controller, surface } = controllerWith({
      timing: { heartbeatMs: 10, leaseTtlMs: 20, escalationTimeoutMs: 40 },
    });
    const answer = await controller.escalate(request);
    expect(answer).toBe("unavailable");
    expect(
      surface.lines.some((line) => String(line["message"] ?? "").includes("HUMAN_UNAVAILABLE")),
    ).toBe(true);
  });

  it("answers a handback with the accounting §25 needs", async () => {
    // The positive half of this rule — a console action that *does* account for the change — needs a
    // page a click can move, so it lives where a real one does
    // (`tests/integration/control.test.ts`, "acts on the same page…", which asserts `accounted: true`).
    // What is left here is the arithmetic: what the answer says about a page nobody's console touched.
    const { controller, surface, notes } = controllerWith();
    void controller.escalate(request);
    await raised(controller);
    const atEscalation = stateDigest(await surface.snapshot());
    const { bearer } = await controller.acquire(nonceOf(notes));

    surface.setSnapshot(snapshot("http://example.test/elsewhere", []));
    const answer = await controller.release(bearer);
    expect(answer).toMatchObject({ outcome: "took-over", humanActions: 0, accounted: false });
    expect(answer.atEscalation).toBe(atEscalation);
    expect(answer.atHandback).not.toBe(answer.atEscalation);
  });
});

/* -------------------------------------------------------------------------- */
/* The console's grammar and rendering                                         */
/* -------------------------------------------------------------------------- */

describe("the console's grammar", () => {
  it("accepts §8's numbered commands in both spellings, and refuses the rest", () => {
    expect(parseConsoleLine("3 click")).toMatchObject({ kind: "command", command: { kind: "click", index: 3 } });
    expect(parseConsoleLine("click 3")).toMatchObject({ kind: "command", command: { kind: "click", index: 3 } });
    expect(parseConsoleLine("4 type hello world")).toMatchObject({
      kind: "command",
      command: { kind: "type", index: 4, value: "hello world" },
    });
    expect(parseConsoleLine("3 press Enter")).toMatchObject({
      kind: "command",
      command: { kind: "press", index: 3, key: "Enter" },
    });
    expect(parseConsoleLine("expand 9")).toMatchObject({ kind: "expand", index: 9 });
    expect(parseConsoleLine("expand")).toMatchObject({ kind: "expand", index: null });
    expect(parseConsoleLine("pass-control-back")).toMatchObject({ kind: "release" });
    expect(parseConsoleLine("decline")).toMatchObject({ kind: "decline" });
    expect(parseConsoleLine("")).toMatchObject({ kind: "empty" });
    expect(parseConsoleLine("7 frobnicate")).toMatchObject({ kind: "error" });
    expect(parseConsoleLine("4 type")).toMatchObject({ kind: "error" });
  });

  it("takes `expand`'s index on either side, and refuses one on a verb that has no use for it", () => {
    // `expand` is the one console verb that takes a node index, so it sits where the dump's spelling
    // (`<idx> <verb>`) meets the console's (`<verb> [idx]`). It answers to both rather than making the
    // operator remember which side the number goes: `1 expand` used to be refused, and the refusal said
    // `expand` was not a verb this console carries out, which it plainly is.
    expect(parseConsoleLine("1 expand")).toMatchObject({ kind: "expand", index: 1 });
    expect(parseConsoleLine("expand 1")).toMatchObject({ kind: "expand", index: 1 });

    const indexed = parseConsoleLine("1 refresh");
    expect(indexed.kind).toBe("error");
    if (indexed.kind !== "error") return;
    expect(indexed.message).toContain("takes no node index");
    expect(indexed.message).toContain("`refresh` on its own");
  });

  it("shows the escalation, the live dump and the lease — and never a typed value", async () => {
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));
    const rendered = renderState(state);
    expect(rendered).toContain("escalation INTERSTITIAL_DIALOG");
    expect(rendered).toContain("Member ID");
    expect(rendered).toContain("lease");
    expect(state.dump).toContain("stub");

    // A typed command is described by its shape, never its value: the operator's terminal is a sink too.
    expect(describeCommand({ kind: "type", index: 4, value: "hunter2" })).toBe("type into [4] (7 chars)");
    expect(describeCommand({ kind: "type", index: 4, value: "hunter2" })).not.toContain("hunter2");
  });

  it("says the window is suspended while a console holds it, and counts it down while nobody does", async () => {
    // The countdown used to keep running under a session the operator was holding, and once it passed it
    // read `0s from now unless you answer` — a deadline that has expired, printed at an operator whose
    // session the clock is not allowed to touch. `held` is the fact the renderer needed.
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));

    expect(state.escalation.held).toBe(true);
    expect(renderState(state)).toContain("terminates: suspended while you hold the session (§8)");

    const unattended = { ...state, escalation: { ...state.escalation, held: false, terminatesInMs: 42_000 } };
    expect(renderState(unattended)).toContain("terminates: 42s from now unless you answer (§8)");
  });

  it("keeps the actionable list when the model is expanded", async () => {
    // `expand` is asked for when the operator wants to see more, and it used to drop the short list of
    // what they can act on — so on a page with nothing hidden, expanding looked like it had taken
    // something away rather than shown anything.
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));

    const expanded = { ...state, mode: "expanded" as const };
    expect(renderState(state)).toContain("── actionable now ──");
    expect(renderState(expanded)).toContain("── actionable now ──");
  });

  it("answers a command with what moved, what is actionable, and the clock — not the briefing again", async () => {
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));

    // The stub page's affordances: [0] textbox "Member ID", [1] button "Search".
    const rendered = renderProgress(state, {
      note: "you ran click [1] through the choke point (actor: human, channel: console)",
      moved: true,
      previousActions: new Set([0]),
    });
    expect(rendered).toContain("you ran click [1] through the choke point");
    expect(rendered).toContain("page: # stub — http://example.test/");
    expect(rendered).toContain("── actionable now ──");
    // The node the previous render did not offer is the one this render points at.
    expect(rendered).toContain('[1] button "Search"   ← new');
    expect(rendered).toContain("lease 10s left · your actions: 0 · escalation window suspended");
    // The verbs repeat, in one line rather than the briefing's ten: `pass-control-back` is what an
    // operator forgets mid-session, and `help` is how they get the descriptions again.
    expect(rendered).toContain("── verbs ──");
    expect(rendered).toContain("pass-control-back · decline · exit · help");

    // What it deliberately does not repeat: the escalation's static preamble, its screenshot, the dump,
    // and the run-log tail. Those are the briefing's, and they are what made every action expensive.
    expect(rendered).not.toContain("escalation INTERSTITIAL_DIALOG");
    expect(rendered).not.toContain("screenshot:");
    expect(rendered).not.toContain("ATLAS CORE CONSOLE");
    expect(rendered).not.toContain("run log (tail)");
  });

  it("marks nothing as new when the page offered nothing new, and counts the window when nobody holds it", async () => {
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));

    const settled = renderProgress(state, { moved: false, previousActions: new Set([0, 1]) });
    expect(settled).not.toContain("← new");
    // Nothing moved, so there is no page line to print — and nothing to say about the page.
    expect(settled).not.toContain("page: ");

    const unattended = { ...state, escalation: { ...state.escalation, held: false, terminatesInMs: 9_000 } };
    expect(renderProgress(unattended, { moved: false, previousActions: new Set() })).toContain(
      "escalation window 9s",
    );
  });

  it("prints the model for `expand`, and not the briefing again", async () => {
    // `expand` was given the whole state at first, on the grounds that asking is explicit. What was asked
    // for is the model: the escalation's preamble, its screenshot and the run-log tail answer "what is
    // being asked", which the operator read when they took over.
    const { controller, notes } = controllerWith({ timing: { leaseTtlMs: 10_000 } });
    void controller.escalate(request);
    await raised(controller);
    const { state } = await controller.acquire(nonceOf(notes));

    const rendered = renderModel(state, {
      note: 'expanded — node [1] is button "Search"; indices are unchanged',
      previousActions: new Set([0, 1]),
    });
    expect(rendered).toContain('expanded — node [1] is button "Search"');
    expect(rendered).toContain("── live view");
    expect(rendered).toContain("── actionable now ──");
    expect(rendered).toContain("── verbs ──");
    expect(rendered).toContain("lease 10s left · your actions: 0 · escalation window suspended");

    expect(rendered).not.toContain("── escalation INTERSTITIAL_DIALOG");
    expect(rendered).not.toContain("screenshot:");
    expect(rendered).not.toContain("run log (tail)");
    expect(rendered).not.toContain("you hold the session");
  });
});

/* -------------------------------------------------------------------------- */
/* `npm run operator`'s grammar                                                */
/* -------------------------------------------------------------------------- */

describe("the operator command", () => {
  it("requires the nonce the run printed, and names the fix when it is missing", () => {
    const parsed = operatorArgs([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem).toContain("nonce");
      expect(parsed.fix).toContain("--nonce");
    }
  });

  it("takes a bus URL and a heartbeat, and refuses an unknown flag", () => {
    const parsed = operatorArgs(["--nonce", "abc123", "--bus", "http://127.0.0.1:9999", "--heartbeat", "500"]);
    expect(parsed).toMatchObject({ ok: true, args: { bus: "http://127.0.0.1:9999", heartbeatMs: 500 } });
    expect(operatorArgs(["--nonce", "abc", "--nope"]).ok).toBe(false);
  });

  it("keeps lines that arrive before the console asks for them", async () => {
    // A piped script delivers everything at once and closes the pipe, while the console is still
    // acquiring and rendering. `readline.question` would drop those lines; the queue is what makes a
    // here-doc transcript (or an automated console) work at all.
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));

    const io = terminalIo({ out: () => undefined, err: () => undefined }, input, output);
    input.write("16 click\n");
    input.write("pass-control-back\n");
    input.end();

    expect(await io.readLine("operator> ")).toBe("16 click");
    expect(await io.readLine("operator> ")).toBe("pass-control-back");
    // End of input is "leave without handing back", not an error.
    expect(await io.readLine("operator> ")).toBeNull();
    expect(written.join("")).toContain("operator> ");
  });
});

/* -------------------------------------------------------------------------- */
/* T14: a human-assisted discovery run emits no artifact                       */
/* -------------------------------------------------------------------------- */

describe("the human-assisted artifact rule", () => {
  const evidence = { runDir: "/tmp/run", runLog: "/tmp/run/run.jsonl" };

  it("lets an autonomous run through untouched", () => {
    expect(humanAssistedRefusal(0, evidence)).toBeNull();
  });

  it("refuses to emit an artifact for a run a human changed in flow", () => {
    const refused = humanAssistedRefusal(2, evidence);
    expect(refused).toMatchObject({
      status: "failure",
      stage: "discovery",
      errorCode: "HUMAN_ASSISTED",
      escalation: "human-took-over",
      evidence,
    });
    // The fix is in the message, because the fix is the only useful thing to say: re-derive it.
    expect(refused?.status === "failure" ? refused.observed : "").toContain("operator console");
  });
});
