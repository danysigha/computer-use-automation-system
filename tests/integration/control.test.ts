/**
 * §8's handoff, end to end (§11 P6's exit criteria) — a real bus, a real operator client, a real page.
 *
 * Every claim in the plan's P6 row is a claim about *two* processes and one browser session: the run
 * that paused, an operator who took the token over a socket, and what the run did with the page it got
 * back. So nothing is stubbed at the seam that matters — the fixture is real, the driver is real, the
 * bus is a real HTTP server, and the "operator" speaks the protocol `npm run operator` speaks. What
 * these tests do *not* do is type at a terminal: the console TUI's grammar and rendering are unit-tested
 * (`tests/unit/control.test.ts`), and its transport is one POST.
 *
 * **The four-way resume matrix is the spine of the file**, and each row is exercised on a page that can
 * actually produce it:
 *
 * | branch | what the human did | page |
 * |---|---|---|
 * | (1) advance | completed the step in the console | the fixture's unknown dialog (`OK`) |
 * | (2) re-execute | cleared the blocker, left the step to the run | the `stub-confirm` target |
 * | (3) re-escalate | moved the page somewhere unverifiable | the `stub-confirm` target |
 * | (4) stop | handed back with nothing verifiable | the `stub-confirm` target |
 *
 * The `stub-confirm` target exists because the fixture cannot show branches (2)–(4): its only dialog
 * control navigates straight to the success page (branch 1 by construction), and no shipped `?sim=`
 * can leave a page that is neither the step's start nor its end. The stub's dialog is *dismissible*
 * and its confirmation then succeeds — which is exactly what branch (2) is for: the human clears the
 * blocker, the precondition (the previous step's postcondition) still holds, and the run performs the
 * step it was interrupted on.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfig } from "../../src/agent/config.ts";
import type { AgentDriver, Decision, Turn } from "../../src/agent/driver.ts";
import { runDiscovery } from "../../src/agent/loop.ts";
import { ControlBus } from "../../src/control/bus.ts";
import { Controller, type ConsoleState } from "../../src/control/controller.ts";
import { OperatorConsole, parseConsoleLine } from "../../src/control/console-tui.ts";
import { Policy, type PolicyOverrides } from "../../src/policy/policy.ts";
import { replaySeams, runReplay, type EscalationRequest } from "../../src/replay/engine.ts";
import type { EvidenceRefs, RunResult } from "../../src/replay/result.ts";
import type { Capability } from "../../src/schema/artifact.ts";
import { parseCapability } from "../../src/schema/validate.ts";
import type { ApprovalHandler } from "../../src/surface/session-driver.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPPED = join(REPO, "capabilities", "sub-account-open", "v1", "artifact.json");
const BALANCE = join(REPO, "capabilities", "member-savings-balance", "v1", "artifact.json");
const MEMBER = "12345";
/** The fixture's synthetic credentials (PLAN §10): what the operator types in the G6 test. */
const TELLER = { id: "teller1", password: "atlas-demo" };

const booted: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of booted.splice(0)) await close().catch(() => undefined);
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Handoff {
  readonly surface: Surface;
  readonly controller: Controller;
  readonly bus: ControlBus;
  /** Every escalation the run raised, in order — the engine's own view of what it asked. */
  readonly escalations: EscalationRequest[];
  /** What the run's terminal showed: the nonce, the bus URL, and the conditions. */
  readonly notes: string[];
  readonly state: ReturnType<typeof replaySeams>["state"];
  readonly evidence: EvidenceRefs;
  readonly result: Promise<RunResult>;
  /** `run.jsonl`, parsed. Safe to call once the run has finished. */
  log(): Promise<readonly Record<string, unknown>[]>;
  /** `run.jsonl` as raw text, for "the secret is in no sink" assertions. */
  raw(): Promise<string>;
}

interface HandoffOptions {
  readonly capability: (base: string) => Capability;
  /** The URL the run starts from, as a function of the fixture's own base URL. */
  readonly entry: (base: string) => string;
  readonly origins?: (base: string) => readonly string[];
  readonly params?: Readonly<Record<string, string>>;
  readonly timing?: PolicyOverrides["timing"];
}

/**
 * A run with §8's machinery attached: the engine, the Controller, a live bus, and the same approval
 * wiring the CLI uses (the operator's own actions are self-approved; everything else escalates).
 */
async function handoff(options: HandoffOptions): Promise<Handoff> {
  // Late-bound, because the driver is constructed before the controller exists — the same ordering the
  // CLI has, and the same fix: §8's wiring is a cycle if written in dependency order.
  let approval: ApprovalHandler = async () => "denied";
  const surface = await startSurface({
    policy: async (base) =>
      Policy.load({
        env: {},
        overrides: {
          allowlist: { origins: [...(options.origins?.(base) ?? [base])] },
          ...(options.timing === undefined ? {} : { timing: options.timing }),
        },
      }),
    driver: { approval: (request) => approval(request) },
  });
  booted.push(() => surface.stop());

  const policy = surface.policy;
  // **The driver's own redactor**, not a fresh one: one scrubber per run is §6's rule, and a second
  // instance would have its own (empty) literal registry — so the bus would render the operator's typed
  // secret while the driver's registry knew about it.
  const redactor = surface.driver.redactor;
  const notes: string[] = [];
  const escalations: EscalationRequest[] = [];
  const base = surface.base;

  const controller = new Controller({
    surface: surface.driver,
    timing: policy.document.timing,
    stage: "replay",
    runId: "control-test",
    redactor,
    onNote: (line) => notes.push(line),
  });
  // `0` asks the kernel for a free port, which is what lets these boot in parallel without fighting
  // over §3's 4517 — the same `BUS_PORT` knob a person would use.
  const bus = await ControlBus.listen({ controller, redactor, port: 0 });
  booted.push(() => bus.close());
  controller.busUrl = bus.url;

  const seams = replaySeams({
    escalation: (request) => {
      escalations.push(request);
      return controller.escalate(request);
    },
  });
  approval = async (request) => (controller.humanInControl ? "approved" : seams.approval(request));

  const evidence: EvidenceRefs = {
    runDir: surface.driver.evidenceDir,
    runLog: surface.driver.evidence.runLogPath,
  };
  const result = runReplay({
    capability: options.capability(base),
    driver: surface.driver,
    policy,
    params: new Map(Object.entries(options.params ?? { memberId: MEMBER })),
    entry: options.entry(base),
    entryOverridden: true,
    identity: null,
    seams,
    onNote: (line) => notes.push(`  ${line}`),
  });

  return {
    surface,
    controller,
    bus,
    escalations,
    notes,
    state: seams.state,
    evidence,
    result,
    log: async () =>
      (await readFile(surface.driver.evidence.runLogPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => readFile(surface.driver.evidence.runLogPath, "utf8"),
  };
}

/* -------------------------------------------------------------------------- */
/* Talking to the bus the way the console does                                 */
/* -------------------------------------------------------------------------- */

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly state: ConsoleState | undefined;
}

async function post(bus: string, path: string, body: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(`${bus}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed, state: parsed["state"] as ConsoleState | undefined };
}

/** A raw request, so the Host/Origin/content-type rules are met the way a browser would meet them. */
function raw(
  bus: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const url = new URL(`${bus}/state`);
  return new Promise((done, fail) => {
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: "/state", method: "POST", headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => done({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", fail);
    request.end(body);
  });
}

/** What the operator reads off the run's terminal: the nonce, and where to connect. */
function nonceOf(notes: readonly string[]): string {
  // The *latest* announcement: after a lapsed lease the run re-raises with a fresh nonce, and the
  // operator reads the line at the bottom of their terminal.
  const line = [...notes].reverse().find((note) => note.includes("--nonce"));
  const match = /--nonce ([0-9a-f]{32,})/.exec(line ?? "");
  if (match === null) throw new Error(`no takeover nonce was printed. notes:\n${notes.join("\n")}`);
  return match[1] ?? "";
}

/** Wait for something the run reaches asynchronously (an escalation, a finished result). */
async function until<T>(what: () => T | null | undefined | false, description: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = what();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** The node index of the first numbered node whose role and name match — how an operator finds it. */
function nodeIndex(state: ConsoleState, role: string, name: string): number {
  const node = state.snapshot.numbered.find((candidate) => candidate.role === role && candidate.name === name);
  if (node === undefined || node.index === null) {
    throw new Error(`no ${role} named ${JSON.stringify(name)} in the dump:\n${state.dump}`);
  }
  return node.index;
}

/** Acquire once the run has raised an escalation, exactly as `npm run operator` would. */
async function acquire(run: Handoff): Promise<{ bearer: string; state: ConsoleState }> {
  await until(() => run.controller.escalation, "an escalation to be raised");
  const reply = await post(run.bus.url, "/acquire", { nonce: nonceOf(run.notes) });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return { bearer: String(reply.body["bearer"]), state: reply.state as ConsoleState };
}

/** One console command, through the same endpoint the TUI uses. */
async function command(
  bus: string,
  bearer: string,
  cmd: { kind: "click" | "type" | "press"; index: number; value?: string; key?: string },
): Promise<Reply> {
  return post(bus, "/act", { bearer, command: cmd });
}

/** The numbered nodes a rendered dump shows, as `index → "role name"`. */
function numberedInDump(dump: string): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of dump.split("\n")) {
    const match = /\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
    if (match === null) continue;
    found.set(Number(match[1]), `${match[2]} ${match[3] ?? ""}`.trim());
  }
  return found;
}

function artifact(path: string, id: string): Capability {
  return parseCapability(JSON.parse(readFileSync(path, "utf8")), id);
}

/* -------------------------------------------------------------------------- */
/* The stub target — the page that can show branches (2)–(4)                    */
/* -------------------------------------------------------------------------- */

interface Stub {
  readonly url: string;
  readonly confirms: () => number;
}

/**
 * A two-page target whose confirmation action raises a dialog the run cannot answer, and whose dialog
 * can be dismissed *without* leaving the confirmation page.
 *
 * That shape is deliberate: it is the one arrangement in which §8's branch (2) is real. The human
 * clears the blocker, the step's precondition (the confirm page, i.e. step 1's postcondition) still
 * holds, and the run therefore performs the step itself — which is what "re-execute" means.
 */
async function startStub(): Promise<Stub> {
  let dismissed = false;
  let confirms = 0;

  const html = (response: ServerResponse, body: string): void => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>stub</title></head><body>${body}</body></html>`,
    );
  };
  const dialog =
    '<div role="dialog" aria-modal="true" aria-label="Application dialog">' +
    "<p>Workstation policy notice: verify teller session before continuing (ref STUB-1).</p>" +
    '<p><a href="/dismiss">Dismiss</a></p></div>';

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    switch (url.pathname) {
      case "/":
        html(response, '<h1>Stub Home</h1><p><a href="/confirm">Continue</a></p>');
        return;
      case "/confirm":
        // The dialog belongs to the *action*, exactly as the fixture's does: the confirm page itself is
        // clean, and the notice appears when the run tries to confirm. "Start over" is the affordance
        // branch (3) needs — a way to leave the step's precondition behind without satisfying its
        // postcondition.
        html(response, '<h1>Confirm Action</h1><p><a href="/confirm/do">Confirm</a></p><p><a href="/">Start over</a></p>');
        return;
      case "/dismiss":
        dismissed = true;
        response.writeHead(302, { location: "/confirm" });
        response.end();
        return;
      case "/confirm/do":
        if (dismissed) {
          confirms += 1;
          html(response, "<h1>Action Complete</h1>");
          return;
        }
        html(response, "<h1>Confirm Action</h1>" + dialog + '<p><a href="/confirm/do">Confirm</a></p>');
        return;
      default:
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  booted.push(() => new Promise<void>((done) => server.close(() => done())));
  return { url: `http://localhost:${port}`, confirms: () => confirms };
}

/** The capability that drives the stub: continue, then confirm. */
function stubCapability(stub: Stub): Capability {
  const link = (name: string) => ({
    candidates: [{ strategy: "role" as const, role: "link" as const, name }],
    framePath: [],
  });
  const heading = (name: string) => ({
    candidates: [{ strategy: "role" as const, role: "heading" as const, name }],
    framePath: [],
  });
  return parseCapability(
    {
      schemaVersion: "1.0",
      id: "stub-confirm",
      name: "Confirm an action on the stub target",
      description: "Reach the confirmation page and confirm the action",
      app: { product: "stub", variant: "base", version: "0.1" },
      surface: { kind: "web-dom", entry: `${stub.url}/` },
      inputs: [],
      outputs: [],
      success: { urlContains: "/confirm" },
      outcomes: [],
      steps: [
        { id: 1, kind: "act", action: "click", target: link("Continue"), expect: { elementExists: heading("Confirm Action") } },
        { id: 2, kind: "act", action: "click", target: link("Confirm"), expect: { elementExists: heading("Action Complete") } },
      ],
      risk: { class: "safe", irreversibleSteps: [] },
      provenance: { recordedAt: new Date().toISOString(), model: "test", discoveryRunId: "control-test" },
    },
    "stub-confirm",
  );
}

/* -------------------------------------------------------------------------- */
/* Branch (1): the human completes the step, and it is never submitted twice    */
/* -------------------------------------------------------------------------- */

describe("a human takes control of the live session", () => {
  it("acts on the same page, hands back, and the run advances on what they did", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer, state } = await acquire(run);

    // §8's payload: the condition, the step, what the page showed, the evidence, and a screenshot.
    expect(state.escalation.code).toBe("INTERSTITIAL_DIALOG");
    expect(state.escalation.stepId).toBe(7);
    expect(state.escalation.held).toBe(true);
    expect(state.escalation.observed).toContain("WS-4471");
    expect("path" in state.escalation.screenshot).toBe(true);
    expect(state.dump).toContain("WS-4471");

    // F9: the console's view *is* the run's own rendering of the same model — one observer, one
    // numbering, and no second format that could drift away from the discovery digest.
    expect(state.dump).toBe(await run.surface.driver.render({ mode: "compact" }));

    // The operator answers the dialog on the live page, through the choke point.
    const ok = nodeIndex(state, "link", "OK");
    const acted = await command(run.bus.url, bearer, { kind: "click", index: ok });
    expect(acted.status, JSON.stringify(acted.body)).toBe(200);

    const released = await post(run.bus.url, "/release", { bearer });
    expect(released.body["answer"]).toMatchObject({ outcome: "took-over", humanActions: 1, accounted: true });

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(result.status === "success" ? result.outputs : {}).toEqual({ confirmation: "Sub-Account Activated" });

    const log = await run.log();
    // The console's action is on the record as a *human's*, with the channel that carried it (§3 key-3).
    expect(log.find((line) => line["kind"] === "action" && line["actor"] === "human")).toMatchObject({
      channel: "console",
      outcome: "executed",
    });
    // Branch (1): the postcondition held, so the run advanced instead of re-issuing the step.
    expect(log.find((line) => line["subject"] === "resume")).toMatchObject({ decision: "advance" });
    // The double-fire guard, as a count: the recorded flow is eight actions plus the entry navigation,
    // and the human's accept is the ninth — a re-issued submit would show up as a tenth.
    expect(log.filter((line) => line["kind"] === "action")).toHaveLength(9);
  });

  it("records a change no console action accounts for as channel: direct-session (§25)", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer } = await acquire(run);

    // The §25 case: a click in a `--headed` window bypasses the choke point entirely. Nothing in the
    // console accounts for it, and the run still advances — the *state* is verified, only its cause is
    // not — but the audit trail names the path instead of flattening it.
    await run.surface.page.getByRole("link", { name: "OK" }).click();

    const released = await post(run.bus.url, "/release", { bearer });
    expect(released.body["answer"]).toMatchObject({ outcome: "took-over", humanActions: 0, accounted: false });
    expect((await run.result).status).toBe("success");

    expect((await run.log()).find((line) => line["subject"] === "attribution")).toMatchObject({
      actor: "human",
      channel: "direct-session",
      stepId: 7,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Branch (2): the precondition holds, so the run performs the step again       */
/* -------------------------------------------------------------------------- */

describe("a handback that leaves the step to the run", () => {
  it("re-executes the interrupted step once the blocker is gone and the precondition holds", async () => {
    const stub = await startStub();
    const run = await handoff({
      capability: () => stubCapability(stub),
      entry: () => `${stub.url}/`,
      origins: () => [stub.url],
    });
    const { bearer, state } = await acquire(run);
    expect(state.escalation.code).toBe("INTERSTITIAL_DIALOG");
    expect(state.escalation.stepId).toBe(2);

    // The operator clears the blocker and leaves the step alone.
    expect((await command(run.bus.url, bearer, { kind: "click", index: nodeIndex(state, "link", "Dismiss") })).status).toBe(200);
    expect((await post(run.bus.url, "/release", { bearer })).body["answer"]).toMatchObject({
      outcome: "took-over",
      humanActions: 1,
    });

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("success");
    // The step was performed by the run *after* the handback — that is branch (2), as a count.
    expect(stub.confirms()).toBe(1);
    expect((await run.log()).find((line) => line["subject"] === "resume")).toMatchObject({ decision: "re-execute" });
  });

  it("re-escalates with evidence when the page moved beyond verification, then stops", async () => {
    const stub = await startStub();
    const run = await handoff({
      capability: () => stubCapability(stub),
      entry: () => `${stub.url}/`,
      origins: () => [stub.url],
      timing: { waitForMs: 500, retries: 0, backoffMs: [] },
    });
    const first = await acquire(run);

    // The operator dismisses the dialog *and* leaves the page the step belongs to, so neither the
    // step's postcondition nor its precondition can be verified (branch 3).
    await command(run.bus.url, first.bearer, { kind: "click", index: nodeIndex(first.state, "link", "Dismiss") });
    const home = await post(run.bus.url, "/state", { bearer: first.bearer });
    await command(run.bus.url, first.bearer, {
      kind: "click",
      index: nodeIndex(home.state as ConsoleState, "link", "Start over"),
    });
    await post(run.bus.url, "/release", { bearer: first.bearer });

    // It asks again, with the evidence — and answering that second ask with "no" is §8's branch (4):
    // the run stops rather than guessing past a state it cannot verify.
    const second = await acquire(run);
    expect(run.escalations.length).toBeGreaterThanOrEqual(2);
    expect((await post(run.bus.url, "/decline", { bearer: second.bearer })).status).toBe(200);

    const result = await run.result;
    expect(result.status).toBe("failure");
    const failure = result as Extract<RunResult, { status: "failure" }>;
    expect(failure.stage).toBe("replay");
    expect(failure.escalation).toBe("declined");
    expect(failure.errorCode).toBe("INTERSTITIAL_DIALOG");
  });
});

/* -------------------------------------------------------------------------- */
/* Branch (1) again, on the real expiry (G6)                                    */
/* -------------------------------------------------------------------------- */

describe("a session that expired mid-flow", () => {
  it("resumes past the interrupted step once the operator signs in over the console (G6)", async () => {
    const run = await handoff({
      capability: () => artifact(BALANCE, "member-savings-balance"),
      entry: (base) => `${base}/?sim=session-expired`,
    });
    const { bearer, state } = await acquire(run);
    expect(state.escalation.code).toBe("SESSION_EXPIRED");

    // The operator signs in on the same live page: two fields and a button, resolved against the same
    // numbered dump the agent reads.
    await command(run.bus.url, bearer, {
      kind: "type",
      index: nodeIndex(state, "textbox", "Teller ID"),
      value: TELLER.id,
    });
    const typed = await command(run.bus.url, bearer, {
      kind: "type",
      index: nodeIndex(state, "textbox", "Password"),
      value: TELLER.password,
    });
    // §6's redaction reaches the bus payload too: the operator's own secret is not in the state the
    // console renders back onto a screen.
    expect(typed.state?.dump ?? "").not.toContain(TELLER.password);
    await command(run.bus.url, bearer, {
      kind: "click",
      index: nodeIndex(typed.state as ConsoleState, "button", "Sign on"),
    });
    await post(run.bus.url, "/release", { bearer });

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("success");
    // The run resumed *past* the interrupted step: it did not restart the flow, and it read the value
    // the capability declares.
    expect(result.status === "success" ? result.outputs : {}).toEqual({ savingsBalance: 4201.55 });
    // The secret is in no sink: not the log, not the bus, not the console's render.
    expect(await run.raw()).not.toContain(TELLER.password);
  });
});

/* -------------------------------------------------------------------------- */
/* A gated step a human touched (§8's second double-fire guard)                 */
/* -------------------------------------------------------------------------- */

/**
 * The off-path SSN field (§10 G5), reached by the goal-1 flow: a `type` the shipped policy gates
 * (`fieldName: /ssn|taxid/`), so it can only run with a human's approval. The operator types a *wrong*
 * value into it and hands back; the run's own `type` is a fill/replace, so the field ends holding the
 * step's value exactly — the `1234512345` case §8 pins.
 */
function ssnCapability(base: string): Capability {
  const recorded = artifact(BALANCE, "member-savings-balance");
  const memberLink = {
    candidates: [
      {
        strategy: "row-relative" as const,
        row: { by: "cell-text" as const, text: "SAV" },
        column: { by: "header-text" as const, text: "Actions" },
        action: "link-in-row" as const,
      },
      { strategy: "css" as const, selector: "a", index: 0 },
    ],
    framePath: [],
  };
  const ssn = {
    candidates: [
      { strategy: "role" as const, role: "textbox" as const, name: "Taxpayer SSN" },
      { strategy: "css" as const, selector: 'input[name="taxpayerSsn"]', index: 0 },
    ],
    framePath: [],
  };
  const searchForm = {
    candidates: [
      { strategy: "role" as const, role: "textbox" as const, name: "Member ID" },
      { strategy: "css" as const, selector: 'input[name="memberId"]', index: 0 },
    ],
    framePath: [],
  };
  return parseCapability(
    {
      ...recorded,
      id: "ssn-certify",
      name: "Certify a member's taxpayer SSN",
      description: "Open the member summary and record the taxpayer SSN",
      surface: { kind: "web-dom", entry: `${base}/` },
      outputs: [],
      success: { urlMatches: "/member/:id/summary" },
      // §27: the gate is declared on the artifact *and* enforced by policy. Both say the same thing, so
      // the cross-check has nothing to upgrade and the run's own record is honest either way.
      risk: { class: "approval-gated", irreversibleSteps: [4] },
      steps: [
        {
          id: 1,
          kind: "act",
          action: "type",
          target: searchForm,
          value: "{memberId}",
          expect: { textEquals: { target: searchForm, value: "{memberId}" } },
        },
        {
          id: 2,
          kind: "act",
          action: "click",
          target: { candidates: [{ strategy: "role" as const, role: "button" as const, name: "Search" }], framePath: [] },
          expect: { urlContains: "/search?memberId={memberId}" },
        },
        { id: 3, kind: "act", action: "click", target: memberLink, expect: { urlMatches: "/member/:id/summary" } },
        {
          id: 4,
          kind: "act",
          action: "type",
          target: ssn,
          value: "123-45-6789",
          expect: { textEquals: { target: ssn, value: "123-45-6789" } },
        },
      ],
      provenance: { recordedAt: new Date().toISOString(), model: "test", discoveryRunId: "control-test" },
    },
    "ssn-certify",
  );
}

describe("a gated step the operator touched", () => {
  it("corrects the wrong value they left behind instead of appending to it", async () => {
    const run = await handoff({
      capability: (base) => ssnCapability(base),
      entry: (base) => base,
    });
    const { bearer, state } = await acquire(run);
    expect(state.escalation.code).toBe("APPROVAL_REQUIRED");
    expect(state.escalation.stepId).toBe(4);

    // The operator puts a *wrong* value in the field — a plausible thing to do with a field the run
    // was asking permission to write — and hands back.
    const field = nodeIndex(state, "textbox", "Taxpayer SSN");
    expect((await command(run.bus.url, bearer, { kind: "type", index: field, value: "999-88-7777" })).status).toBe(200);
    await post(run.bus.url, "/release", { bearer });

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("success");
    // Fill/replace, asserted against the live page: the field holds the step's value exactly, with
    // nothing of the operator's value left in front of it.
    expect(await run.surface.page.locator('input[name="taxpayerSsn"]').inputValue()).toBe("123-45-6789");
    const log = await run.log();
    // Both writes are on the record, and both are marked sensitive — the human's and the run's.
    expect(log.some((line) => line["actor"] === "human" && line["sensitive"] === true)).toBe(true);
    expect(log.some((line) => line["actor"] === "agent" && line["sensitive"] === true)).toBe(true);
    // The secret the *run* typed is in no sink either: §6's scrubber follows the value, not the field.
    expect(await run.raw()).not.toContain("123-45-6789");
  });
});

/* -------------------------------------------------------------------------- */
/* §8's lease and the ways an escalation ends                                   */
/* -------------------------------------------------------------------------- */

describe("an escalation nobody holds", () => {
  it("releases a lapsed lease, re-raises with a fresh nonce, and terminates as HUMAN_UNAVAILABLE", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
      timing: {
        waitForMs: 500,
        retries: 0,
        backoffMs: [],
        heartbeatMs: 40,
        leaseTtlMs: 200,
        escalationTimeoutMs: 1_500,
      },
    });
    const first = await acquire(run);
    const firstNonce = nonceOf(run.notes);

    // No heartbeats. §8's liveness rule is what makes a dead console observable: the token returns to
    // the run, the escalation re-raises, and the run never parks on a lost operator.
    await until(() => nonceOf(run.notes) !== firstNonce, "the re-raised escalation to print its nonce");
    expect(run.controller.escalation?.reRaised ?? 0).toBeGreaterThan(0);
    // The superseded nonce and the dead bearer are both refused, by name.
    expect((await post(run.bus.url, "/acquire", { nonce: firstNonce })).status).toBe(410);
    expect((await post(run.bus.url, "/state", { bearer: first.bearer })).status).toBe(401);

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("failure");
    const failure = result as Extract<RunResult, { status: "failure" }>;
    expect(failure.errorCode).toBe("HUMAN_UNAVAILABLE");
    expect(failure.escalation).toBe("no-operator");
    expect(failure.hint).toContain("attended");
    expect((await run.log()).some((line) => String(line["message"] ?? "").includes("lease lapsed"))).toBe(true);
  });

  it("ends the run when the operator declines", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer } = await acquire(run);
    expect((await post(run.bus.url, "/decline", { bearer })).status).toBe(200);

    const result = await run.result;
    expect(result.status).toBe("failure");
    const failure = result as Extract<RunResult, { status: "failure" }>;
    expect(failure.errorCode).toBe("INTERSTITIAL_DIALOG");
    expect(failure.escalation).toBe("declined");
    expect((await run.log()).some((line) => line["decision"] === "declined")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Bus security (§8)                                                           */
/* -------------------------------------------------------------------------- */

describe("the control bus admits only what §8 allows", () => {
  it("refuses a second console, a spent nonce, and any request without this session's bearer", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer } = await acquire(run);

    // A second console presenting the same nonce is refused *because the nonce is single-use* (§8): it
    // was spent by the first acquisition, and a takeover credential that could be replayed would make
    // the handoff a race between two operators on one banking session.
    const second = await post(run.bus.url, "/acquire", { nonce: nonceOf(run.notes) });
    expect(second.status).toBe(410);
    expect(JSON.stringify(second.body)).toContain("spent");
    // A nonce that was never issued is not a password.
    expect((await post(run.bus.url, "/acquire", { nonce: "0".repeat(64) })).status).toBe(403);
    // Every request after acquisition carries the bearer — polls included.
    expect((await post(run.bus.url, "/state", {})).status).toBe(401);
    expect(
      (await post(run.bus.url, "/act", { bearer: "not-the-bearer", command: { kind: "click", index: 0 } })).status,
    ).toBe(401);
    expect((await post(run.bus.url, "/heartbeat", { bearer: "not-the-bearer" })).status).toBe(401);
    // And the right bearer gets through, so the refusals above are not a broken bus.
    expect((await post(run.bus.url, "/state", { bearer })).status).toBe(200);
    await post(run.bus.url, "/decline", { bearer });
    await run.result;
  });

  it("refuses a request that is not from this machine (Host, Origin, content-type)", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer } = await acquire(run);
    const url = new URL(run.bus.url);

    // A name a browser can be tricked into resolving to 127.0.0.1 is not loopback: the bus answers
    // loopback *literals* only, which is what closes the DNS-rebinding vector (§8).
    const spoofedHost = await raw(
      run.bus.url,
      { host: "evil.example.com", "content-type": "application/json" },
      JSON.stringify({ bearer }),
    );
    expect(spoofedHost.status).toBe(400);
    expect(spoofedHost.text).toContain("loopback");

    const spoofedOrigin = await raw(
      run.bus.url,
      { host: `127.0.0.1:${url.port}`, origin: "http://evil.example.com", "content-type": "application/json" },
      JSON.stringify({ bearer }),
    );
    expect(spoofedOrigin.status).toBe(400);
    expect(spoofedOrigin.text).toContain("Origin");

    // A cross-origin page cannot send this content type without a preflight the bus never grants — and
    // form-encoded posts (which it *can* send) are refused here.
    const formEncoded = await raw(
      run.bus.url,
      { host: `127.0.0.1:${url.port}`, "content-type": "application/x-www-form-urlencoded" },
      "nonce=anything",
    );
    expect(formEncoded.status).toBe(400);
    expect(formEncoded.text).toContain("application/json");
    await post(run.bus.url, "/decline", { bearer });
    await run.result;
  });
});

/* -------------------------------------------------------------------------- */
/* §24: one numbering, two renderings                                          */
/* -------------------------------------------------------------------------- */

describe("the console's perception", () => {
  it("expands without renumbering, and the expanded view is a superset of the compact one", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    const { bearer, state } = await acquire(run);
    const expanded = await post(run.bus.url, "/state", { bearer, mode: "expanded" });
    const compactNodes = numberedInDump(state.dump);
    const expandedNodes = numberedInDump((expanded.state as ConsoleState).dump);

    expect(expanded.state?.mode).toBe("expanded");
    expect(expandedNodes.size).toBeGreaterThanOrEqual(compactNodes.size);
    for (const [index, description] of compactNodes) {
      // The same number means the same element in both renderings — which is what makes a command
      // typed from the compact view safe to send after expanding (§24 nit 2).
      expect(expandedNodes.get(index)).toBe(description);
    }
    await post(run.bus.url, "/decline", { bearer });
    await run.result;
  });
});

/* -------------------------------------------------------------------------- */
/* The console process itself                                                  */
/* -------------------------------------------------------------------------- */

describe("the operator console", () => {
  it("drives a live session from its own process, over the bus, and hands it back", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    await until(() => run.controller.escalation, "an escalation to be raised");

    // A whole console session, driven from a scripted line source: acquire → read the dump → act →
    // hand back. The index is read out of what the console *rendered*, which is what an operator does —
    // and it is the same numbering the agent's digest uses (§8, §24).
    const printed: string[] = [];
    // An `expand` first: the operator asks to see the model, and the answer must be the model rather than
    // the briefing they already read.
    const script: string[] = ["expand 1"];
    const console_ = new OperatorConsole({
      bus: run.bus.url,
      nonce: nonceOf(run.notes),
      heartbeatMs: 250,
      io: {
        out: (text: string) => printed.push(text),
        readLine: async () => {
          const next = script.shift();
          if (next !== undefined) return next;
          const ok = /\[(\d+)\]\s+link\s+"OK"/.exec(printed.join("\n"));
          if (ok?.[1] === undefined) return null;
          script.push("pass-control-back");
          return `${ok[1]} click`;
        },
        openFile: () => undefined,
      },
    });
    expect(await console_.run()).toBe(0);

    const result = await run.result;
    expect(result.status, JSON.stringify(result)).toBe("success");
    const session = printed.join("\n");
    expect(session).toContain("escalation INTERSTITIAL_DIALOG");
    expect(session).toContain("you hold the session");
    // The console says where input goes, because a headed window and the screenshot viewer both look
    // like places to act and neither is one (§25 detects a click in the window; saying so is cheaper).
    expect(session).toContain("typed at this prompt");
    expect(session).toMatch(/you ran click \[\d+\] through the choke point/);
    expect(session).toContain("control handed back");
    // The briefing is printed when the console takes over, and the render after the click is the progress
    // one, so the escalation's preamble appears exactly once in the session rather than after every line.
    expect(session.split("── escalation INTERSTITIAL_DIALOG").length - 1).toBe(1);
    // And exactly what the click made available is marked: the nav links were already on offer, so the
    // one marked line is the link the confirmation produced. Marking the whole new page as new is the
    // bug this pins — the briefing has to remember the affordances it showed.
    const marked = session.split("\n").filter((line) => line.includes("← new"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Return to member summary");

    const afterExpand = session.slice(
      session.indexOf('expanded — node [1] is link "Search"'),
      session.indexOf("you ran click"),
    );
    expect(afterExpand).toContain("── verbs ──");
    expect(afterExpand).not.toContain("escalation INTERSTITIAL_DIALOG");
    expect(afterExpand).not.toContain("run log (tail)");
  });

  it("presses the key a person types, not the spelling the browser library wants", async () => {
    // The demo's OK node is a link, and the operator who typed `16 press enter` — the natural spelling,
    // against a help line that says `3 press Enter` — was refused by `elementHandle.press: Unknown key:
    // "enter"`. The alias lives at the surface, so this case drives the whole chain the operator did:
    // console line, bus, controller, driver, page, and then the resume decision that follows.
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
    });
    await until(() => run.controller.escalation, "an escalation to be raised");

    const printed: string[] = [];
    const script: string[] = [];
    const console_ = new OperatorConsole({
      bus: run.bus.url,
      nonce: nonceOf(run.notes),
      heartbeatMs: 250,
      io: {
        out: (text: string) => printed.push(text),
        readLine: async () => {
          const next = script.shift();
          if (next !== undefined) return next;
          const ok = /\[(\d+)]\s+link\s+"OK"/.exec(printed.join("\n"));
          if (ok?.[1] === undefined) return null;
          // Lowercase on purpose: this is the line the operator typed.
          script.push("pass-control-back");
          return `${ok[1]} press enter`;
        },
        openFile: () => undefined,
      },
    });
    expect(await console_.run()).toBe(0);

    expect((await run.result).status, printed.join("\n")).toBe("success");
    const session = printed.join("\n");
    expect(session).toMatch(/you ran press enter on \[\d+\] through the choke point/);
    expect(session).not.toContain("Unknown key");
  });

  it("parses §8's numbered grammar in both spellings", () => {
    expect(parseConsoleLine("3 click")).toMatchObject({ kind: "command", command: { kind: "click", index: 3 } });
    expect(parseConsoleLine("click 3")).toMatchObject({ kind: "command", command: { kind: "click", index: 3 } });
    expect(parseConsoleLine("4 type hello world")).toMatchObject({
      kind: "command",
      command: { kind: "type", index: 4, value: "hello world" },
    });
    expect(parseConsoleLine("expand 9")).toMatchObject({ kind: "expand", index: 9 });
    expect(parseConsoleLine("expand")).toMatchObject({ kind: "expand", index: null });
    expect(parseConsoleLine("pass-control-back")).toMatchObject({ kind: "release" });
    expect(parseConsoleLine("decline")).toMatchObject({ kind: "decline" });
    expect(parseConsoleLine("7 frobnicate")).toMatchObject({ kind: "error" });
    expect(parseConsoleLine("4 type")).toMatchObject({ kind: "error" });
  });
});

/* -------------------------------------------------------------------------- */
/* §8's discovery half: a stuck verdict raises instead of ending                */
/* -------------------------------------------------------------------------- */

/** The digest's nodes, parsed the way the scripted model reads them (§9's own format). */
function digestNodes(digest: string): { index: number; role: string; name: string; text: string }[] {
  const nodes: { index: number; role: string; name: string; text: string }[] = [];
  for (const line of digest.split("\n")) {
    for (const part of line.split("|")) {
      const match = /^\[(\d+)]\s+([a-z]+)(?:\s+"([^"]*)")?(?:\s+=\s+"([^"]*)")?/.exec(part.trim());
      if (match === null) continue;
      nodes.push({ index: Number(match[1]), role: match[2] ?? "", name: match[3] ?? "", text: match[4] ?? "" });
    }
  }
  return nodes;
}

function findIn(digest: string, role: string, name: string): number {
  const node = digestNodes(digest).find((candidate) => candidate.role === role && candidate.name === name);
  if (node === undefined) throw new Error(`no ${role} named ${JSON.stringify(name)} in:\n${digest}`);
  return node.index;
}

function showingIn(digest: string, text: string): number {
  const node = digestNodes(digest).find((candidate) => candidate.name === text || candidate.text === text);
  if (node === undefined) throw new Error(`no node showing ${JSON.stringify(text)} in:\n${digest}`);
  return node.index;
}

describe("the escalation's clock", () => {
  it("does not time out a session a live console is holding", async () => {
    // The bug this exists for: the deadline was set when the escalation was raised and checked whoever
    // held the token, so an operator who arrived late inherited the remainder of the window — and when
    // it closed, the run terminated *under their hands* while the log said "no operator answered" about
    // an operator who was holding it. The console was left heartbeating at a closed bus.
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
      timing: {
        waitForMs: 500,
        retries: 0,
        backoffMs: [],
        heartbeatMs: 40,
        // The lease is deliberately generous against the window: this case is about *which* of the two
        // clocks decides, and a lease that a loaded CI machine could trip over would fail for a reason
        // that has nothing to do with the question.
        leaseTtlMs: 2_000,
        escalationTimeoutMs: 600,
      },
    });
    const { bearer, state } = await acquire(run);

    // Hold it for three times the window it was raised with, heartbeating the way a console does.
    const until_ = Date.now() + 1_800;
    while (Date.now() < until_) {
      const beat = await post(run.bus.url, "/heartbeat", { bearer });
      expect(beat.status, JSON.stringify(beat.body)).toBe(200);
      await new Promise((done) => setTimeout(done, 250));
    }

    // The session is still ours to finish: the run is paused rather than gone, so the handback that ends
    // this escalation is the one the operator makes. Accept the dialog first, or the resume decision
    // finds the condition still standing and re-raises — which is the engine doing its job, not the
    // clock doing this test's.
    await command(run.bus.url, bearer, { kind: "click", index: nodeIndex(state, "link", "OK") });
    const released = await post(run.bus.url, "/release", { bearer });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await run.result).status).toBe("success");
  });

  it("gives a re-raised escalation its own window rather than the remains of the old one", async () => {
    // A console that dies at the end of the window hands back an escalation that would otherwise expire
    // immediately, leaving the operator handed a nonce they have no time to use.
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
      timing: {
        waitForMs: 500,
        retries: 0,
        backoffMs: [],
        heartbeatMs: 40,
        leaseTtlMs: 1_200,
        escalationTimeoutMs: 2_000,
      },
    });
    await acquire(run);
    const firstNonce = nonceOf(run.notes);
    // No heartbeats: the lease lapses, and the re-raise prints a fresh nonce. Waited for as a *line*
    // rather than as the counter, which flips a tick before the note reaches the terminal.
    await until(() => nonceOf(run.notes) !== firstNonce, "the re-raised escalation to print its nonce");

    // Let the clock run past the deadline the *first* escalation was raised with (2s from that raise)
    // and stop short of the fresh one (2s from the re-raise, ~1.2s later). Re-acquiring at this point
    // is the assertion: a re-raise that inherited the old deadline would already have ended the run.
    // Both margins are structural rather than latency-based, since they are measured from the re-raise
    // the run just printed.
    await new Promise((done) => setTimeout(done, 1_200));
    const second = await post(run.bus.url, "/acquire", { nonce: nonceOf(run.notes) });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const bearer = String(second.body["bearer"]);
    const state = second.state as ConsoleState;

    // Renew the lease once before acting, so the two round trips below have a full window rather than
    // whatever was left of this acquisition's.
    expect((await post(run.bus.url, "/heartbeat", { bearer })).status).toBe(200);
    await command(run.bus.url, bearer, { kind: "click", index: nodeIndex(state, "link", "OK") });
    const released = await post(run.bus.url, "/release", { bearer });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await run.result).status).toBe("success");
  });
});

describe("a console whose run goes away", () => {
  it("says so once and closes, rather than printing at a closed bus", async () => {
    const run = await handoff({
      capability: () => artifact(SHIPPED, "sub-account-open"),
      entry: (base) => `${base}/?sim=dialog=unexpected`,
      timing: {
        waitForMs: 500,
        retries: 0,
        backoffMs: [],
        heartbeatMs: 40,
        leaseTtlMs: 400,
        escalationTimeoutMs: 10_000,
      },
    });
    await until(() => run.controller.escalation, "an escalation to be raised");

    const printed: string[] = [];
    let release: ((line: string | null) => void) | null = null;
    const console_ = new OperatorConsole({
      bus: run.bus.url,
      nonce: nonceOf(run.notes),
      heartbeatMs: 40,
      io: {
        out: (text: string) => printed.push(text),
        // A terminal nobody types into: the prompt stays open while the heartbeat runs.
        readLine: () => new Promise<string | null>((done) => (release = done)),
        openFile: () => undefined,
        close: () => release?.(null),
      },
    });
    const exited = console_.run();
    await until(() => printed.join("\n").includes("you hold the session"), "the console to take over");

    // The run goes away exactly as it does when its window closes or its process ends.
    await run.bus.close();

    expect(await exited).toBe(0);
    const session = printed.join("\n");
    expect(session).toContain("this console no longer holds the session");
    // Once, not once per heartbeat: the loop this replaced printed at every tick.
    expect(session.split("is not answering").length - 1).toBe(1);
  });
});

describe("a stuck discovery run", () => {
  it("asks a human, re-observes on a takeover, and continues instead of ending", async () => {
    // The same late-bound approval wiring the CLI has, so the operator's own action on a gated field
    // (the SSN box) is *their* approval rather than a second request.
    let approval: ApprovalHandler = async () => "denied";
    const surface = await startSurface({ driver: { approval: (request) => approval(request) } });
    booted.push(() => surface.stop());
    const policy = surface.policy;
    const notes: string[] = [];
    const controller = new Controller({
      surface: surface.driver,
      timing: policy.document.timing,
      stage: "discovery",
      runId: "goal-1",
      redactor: surface.driver.redactor,
      onNote: (line) => notes.push(line),
    });
    const bus = await ControlBus.listen({ controller, redactor: surface.driver.redactor, port: 0 });
    booted.push(() => bus.close());
    controller.busUrl = bus.url;
    const escalate = (incoming: EscalationRequest) => controller.escalate(incoming);
    approval = async () => (controller.humanInControl ? "approved" : "denied");

    // A model that types the same value three times: §8's repeat trigger, and the case the detector
    // exists for — every turn is a perfectly valid call against a page that stopped responding to it.
    // (Typing the *same* value is also the correction path: the loop tells the model the click had no
    // observable effect, and the model does it again anyway, which is what a stuck model looks like.)
    const script: ((turn: Turn) => Decision)[] = [
      (turn) => ({ tool: "type", arguments: { index: findIn(turn.digest, "textbox", "Member ID"), text: MEMBER } }),
      (turn) => ({ tool: "type", arguments: { index: findIn(turn.digest, "textbox", "Member ID"), text: MEMBER } }),
      (turn) => ({ tool: "type", arguments: { index: findIn(turn.digest, "textbox", "Member ID"), text: MEMBER } }),
      // Turns 4–7 are what the run does *after* the human took control.
      (turn) => ({ tool: "click", arguments: { index: findIn(turn.digest, "button", "Search") } }),
      (turn) => ({ tool: "click", arguments: { index: findIn(turn.digest, "link", "Detail") } }),
      (turn) => ({ tool: "read", arguments: { index: showingIn(turn.digest, "$4,201.55") } }),
      () => ({ tool: "markComplete", arguments: { outputs: { balance: "$4,201.55" } } }),
    ];
    const agent: AgentDriver = {
      name: "scripted",
      async decide(turn: Turn): Promise<Decision> {
        const step = script[turn.step - 1];
        if (step === undefined) throw new Error(`the script has no step ${turn.step}`);
        return step(turn);
      },
    };

    const running = runDiscovery({
      driver: surface.driver,
      agent,
      policy,
      budgets: agentConfig(policy, {}).budgets,
      screenshot: null,
      entry: `${surface.base}/`,
      goal: "Look up member 12345 and read their current savings balance",
      escalation: escalate,
    });

    // §8: the verdict *raises*, and the operator takes the session over the bus.
    const view = await until(() => controller.escalation, "the stuck escalation");
    expect(view.code).toBe("STUCK");
    expect(view.stepId).toBe(3);
    expect(notes.join("\n")).toContain("--nonce");
    const acquired = await post(bus.url, "/acquire", { nonce: nonceOf(notes) });
    const state = acquired.state as ConsoleState;
    const bearer = String(acquired.body["bearer"]);
    // The human does something real on the same page, through the choke point.
    await command(bus.url, bearer, {
      kind: "type",
      index: nodeIndex(state, "textbox", "Member ID"),
      value: MEMBER,
    });
    await post(bus.url, "/release", { bearer });

    const run = await running;
    // The run finished its goal: the takeover reset the counters and the model's own next turn found
    // the balance, which is §8's discovery resume rule ("re-observes and continues").
    expect(run.ending).toEqual({ kind: "completed", outputs: { balance: "$4,201.55" } });
    // And the human's action is evidence, never a step: the artifact's trace holds only what the model
    // did (§9/T14), which is why a human-assisted run cannot be recorded as a capability.
    expect(run.trace.some((entry) => entry.kind === "act" && entry.value === MEMBER && entry.textAfter === MEMBER)).toBe(true);
    expect(controller.humanActions).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The real command, in its own process                                         */
/* -------------------------------------------------------------------------- */

/**
 * `npm run replay`, spawned for real, with a second process driving its bus.
 *
 * Everything above calls the engine and the controller as functions, which is the right way to test
 * *rules* — but it cannot see whether the command a person actually runs comes back. It did not: the
 * first version of P6 left the control bus listening after the run, so `npm run replay` printed its
 * result and then hung forever. No in-process test could fail on that, and the evaluator's first
 * command would have. So the last thing this file does is run the shipped entrypoint the way §5.4
 * pins it, with a control bus, an escalation, a handback, and an exit code.
 */
describe("the `replay` command in its own process", () => {
  /** A policy file allowlisting one origin — the form the CLI takes (`--policy`). */
  async function policyFileFor(origin: string): Promise<string> {
    const document = JSON.parse(readFileSync(join(REPO, "policy", "policy.json"), "utf8")) as {
      allowlist: { origins: string[] };
    };
    document.allowlist.origins = [origin];
    const file = join(await mkdtemp(join(tmpdir(), "atlas-policy-")), "policy.json");
    await writeFile(file, JSON.stringify(document, null, 2), "utf8");
    return file;
  }

  interface CliRun {
    readonly code: number | null;
    readonly out: string;
    readonly err: string;
    readonly evidenceDir: string;
  }

  /** Spawn the shipped entrypoint. Resolves only if it exits — the property under test. */
  async function spawnReplay(args: readonly string[], evidenceDir: string, busPort: number): Promise<CliRun> {
    const child = spawn(process.execPath, ["src/cli/replay.ts", ...args], {
      cwd: REPO,
      env: { ...process.env, EVIDENCE_DIR: evidenceDir, BUS_PORT: String(busPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    booted.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const code = await new Promise<number | null>((done, fail) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`\`replay\` did not exit within 45s. stdout:\n${out}\nstderr:\n${err}`));
      }, 45_000);
      child.on("exit", (exit) => {
        clearTimeout(timer);
        done(exit);
      });
    });
    return { code, out, err, evidenceDir };
  }

  it("runs a capability and exits", async () => {
    const surface = await startSurface();
    booted.push(() => surface.stop());
    const policyFile = await policyFileFor(surface.base);
    const evidenceDir = await mkdtemp(join(tmpdir(), "atlas-evidence-"));

    const run = await spawnReplay(
      ["sub-account-open", "--memberId", MEMBER, "--entry", surface.base, "--policy", policyFile],
      evidenceDir,
      0,
    );
    expect(run.code, `${run.err}\n${run.out}`).toBe(0);
    expect(run.out).toContain("success");
    expect(run.out).toContain("confirmation: Sub-Account Activated");
  });

  it("exits after a handoff: escalation, handback, resume", async () => {
    const surface = await startSurface();
    booted.push(() => surface.stop());
    const policyFile = await policyFileFor(surface.base);
    const evidenceDir = await mkdtemp(join(tmpdir(), "atlas-evidence-"));
    // A fixed port, because the nonce note names it and the test is the client that connects. The
    // kernel picks nothing here on purpose: this test is checking the *operational* path, and a
    // `BUS_PORT` an operator can read off the terminal is part of it.
    const busPort = 20_000 + Math.floor(Math.random() * 20_000);

    const child = spawn(process.execPath, [
      "src/cli/replay.ts",
      "sub-account-open",
      "--memberId",
      MEMBER,
      "--entry",
      `${surface.base}/?sim=dialog=unexpected`,
      "--policy",
      policyFile,
    ], {
      cwd: REPO,
      env: { ...process.env, EVIDENCE_DIR: evidenceDir, BUS_PORT: String(busPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    booted.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const exited = new Promise<number | null>((done) => child.on("exit", done));

    // What the operator reads: the nonce and the bus URL, printed by the run at escalation.
    const nonce = await until(
      () => /--nonce ([0-9a-f]{32,}) --bus (\S+)/.exec(err)?.[1] ?? null,
      `the nonce in the run's terminal. stderr so far:\n${err}`,
    );
    const bus = `http://127.0.0.1:${busPort}`;
    const acquired = await post(bus, "/acquire", { nonce });
    expect(acquired.status, JSON.stringify(acquired.body)).toBe(200);
    const state = acquired.state as ConsoleState;
    const bearer = String(acquired.body["bearer"]);
    expect(state.escalation.code).toBe("INTERSTITIAL_DIALOG");

    // The operator answers the dialog through the choke point and hands back.
    await command(bus, bearer, { kind: "click", index: nodeIndex(state, "link", "OK") });
    await post(bus, "/release", { bearer });

    const code = await exited;
    expect(code, `${err}\n${out}`).toBe(0);
    expect(out).toContain("confirmation: Sub-Account Activated");
    // And the run's own record says a human was there, which is the difference between this run and
    // the autonomous one above.
    const logDir = (await readdir(evidenceDir))[0] ?? "";
    const log = await readFile(join(evidenceDir, logDir, "run.jsonl"), "utf8");
    expect(log).toContain('"actor":"human"');
  });
});

/* -------------------------------------------------------------------------- */
/* The console as a command                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The console has two lives: the one above, driven in-process by a scripted line source, and the one
 * §15's transcript actually shows — `npm run operator`, on a terminal, in its own process.
 *
 * The difference between them is not the console's logic, which is shared; it is the *handle*. A
 * terminal is an open stream attached to the process, and a finished command that leaves one behind
 * never exits: it prints its last line and hangs, which in the transcript is a prompt that never comes
 * back. No in-process test can see that, and neither can a shell pipeline — piping `printf … |` closes
 * the pipe and hands the command an EOF nothing real ever sends.
 */
describe("the `operator` command in its own process", () => {
  it("gives the terminal back and exits once the session is over", async () => {
    // A stdin that is opened and never written to, never ended: the shape a TTY has, and the only one
    // that distinguishes "the console finished" from "the process finished". The bus is deliberately
    // not there — a refused nonce ends the session too, and it ends it in a second.
    const child = spawn(
      process.execPath,
      ["src/cli/operator.ts", "--nonce", "0".repeat(32), "--bus", "http://127.0.0.1:1"],
      { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] },
    );
    booted.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    // The console narrates to its own stream (`io.out`), which for this command is stdout — the
    // operator's terminal — so that is where the ending is asserted, and stderr stays the CLI's.
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));

    const code = await new Promise<number | null>((done, fail) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`\`operator\` printed its ending and never exited — stdin was still held open.\n${out}`));
      }, 20_000);
      child.on("exit", (exit) => {
        clearTimeout(timer);
        done(exit);
      });
    });

    expect(code).toBe(2);
    expect(out).toContain("is not answering");
  });
});
