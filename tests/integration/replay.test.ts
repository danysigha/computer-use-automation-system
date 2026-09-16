/**
 * Replay, end to end (§11 P5's exit criteria) — a saved artifact, a live fixture, no model.
 *
 * The unit tests next door pin the pure decisions (`step-runner.test.ts`, `replay-args.test.ts`).
 * This file is the other half, and it is the half §11 grades: every P5 criterion is a claim about
 * what a real browser does to a real page when the app misbehaves, so each case here boots the
 * fixture, drives Chromium, and asserts on the `RunResult` a caller would actually receive.
 *
 * Two things make that tractable.
 *
 * **The artifact is the recorded one.** `capabilities/sub-account-open/v1/artifact.json` is read off
 * disk exactly as P4 saved it, so "replay of a saved artifact succeeds" is a claim about the file
 * that ships, rather than about a hand-built fixture that agrees with the engine by construction.
 *
 * **The fixture injects the states.** `?sim=` (sample-app §10) keeps a failure state in the session
 * cookie, which is the only way to reach §5.2's recoverable half from one app: a dialog, a slow
 * response, a locked record. The sim is set on the *entry* URL and fires wherever the condition
 * belongs — the dialog on step 7's confirmation POST, the expired session on the second navigation —
 * which is also §11's "a sim that only comes into force after the target step" criterion: state
 * injected at the start cannot be allowed to disturb the replay of a step that was recorded before it
 * was ever in force.
 *
 * Where a budget has to be *spent*, the policy is rebuilt with a smaller `timing`: §22's terminal is
 * `retries` attempts spaced by `backoffMs`, and a test that spent the shipped budget (2 retries, 1s +
 * 3s of backoff) against a 10s `waitForMs` would conclude nothing it could not conclude in 600ms.
 * Everything else in those policies is the shipped document, with the allowlist narrowed to the port
 * the fixture took — the ephemeral-origin case §5.4's preflight exists to name.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningApp } from "../../sample-app/server.ts";
import type { Streams } from "../../src/cli/io.ts";
import { runReplay as cliReplay } from "../../src/cli/replay.ts";
import { Policy, type PolicyOverrides } from "../../src/policy/policy.ts";
import { redactorFor } from "../../src/policy/redact.ts";
import { replaySeams, runReplay, type EscalationRequest } from "../../src/replay/engine.ts";
import { describeResult, type RunResult } from "../../src/replay/result.ts";
import type { Capability } from "../../src/schema/artifact.ts";
import { parseCapability } from "../../src/schema/validate.ts";
import type { AppIdentity } from "../../src/surface/identity.ts";
import { SessionDriver } from "../../src/surface/session-driver.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";
import { startFixture } from "../helpers/fixture.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPPED = join(REPO, "capabilities", "sub-account-open", "v1", "artifact.json");
const MEMBER = "12345";

/* -------------------------------------------------------------------------- */
/* The artifact under test                                                     */
/* -------------------------------------------------------------------------- */

/** The recorded capability, read exactly as it was saved — nothing here rewrites its steps. */
function artifact(): Capability {
  return parseCapability(JSON.parse(readFileSync(SHIPPED, "utf8")), "sub-account-open");
}

/**
 * The same artifact with §28's canonical routes made literal — the control for the different-member-id
 * case.
 *
 * `:id` occurs only inside route patterns in this file (three step expectations and the success
 * condition), so a whole-file substitution is exactly "the artifact someone would have recorded if
 * routes were only ever asserted literally". Everything else about the two artifacts is identical,
 * which is what makes the pair a control rather than two scenarios.
 *
 * The literal spelling has to be `urlContains`, and that is §28's own rule rather than a convenience
 * of this test: the schema refuses a `urlMatches` with no variable segment, on the grounds that it
 * asserts nothing a `urlContains` would not. So the pair is also a statement about what is
 * *expressible* — an artifact that pinned the recorded member id as a route could not be saved.
 */
function literalRoutes(): Capability {
  const recorded: unknown = JSON.parse(readFileSync(SHIPPED, "utf8").replaceAll(":id", MEMBER));
  return parseCapability(literalized(recorded), "sub-account-open with literal routes");
}

/** Every `urlMatches` key becomes `urlContains`; everything else is copied through. */
function literalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(literalized);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key === "urlMatches" ? "urlContains" : key,
      literalized(entry),
    ]),
  );
}

/**
 * The same artifact with its `RECORD_LOCKED` signature loosened to the bare word — the control for
 * the decoy case below.
 *
 * One pattern changes and nothing else, so the pair (this and the committed file) isolates what the
 * anchoring is doing: §10's happy page says "Locked" as chrome and as a dormant account's row, and a
 * signature that settled for the word would call that an answer.
 */
function looseSignature(): Capability {
  const recorded = artifact();
  const outcomes = recorded.outcomes.map((outcome) =>
    outcome.code === "RECORD_LOCKED" ? { ...outcome, detect: { kind: "text-on-page" as const, pattern: "Locked" } } : outcome,
  );
  return parseCapability({ ...recorded, outcomes }, "sub-account-open with a loose signature");
}

/**
 * The same artifact plus the one signature a reviewer adds on seeing the form refused.
 *
 * §5.2 puts `VALIDATION_ERROR` in the *business outcome* family — the app answered, and the answer is
 * no — and §10's reachability map points at goal 2 for it. The committed recording does not declare it
 * (that run never saw a validation error, and §9 seeds `outcomes[]` from what a run saw), so the
 * declaration is made here, anchored to the message the fixture really renders (§10's pinned text).
 */
function withValidationError(): Capability {
  const recorded = artifact();
  const outcomes = [
    ...recorded.outcomes,
    {
      code: "VALIDATION_ERROR",
      detect: { kind: "text-on-page" as const, pattern: "Sub-account type is not available for this member" },
      message: "the app refused the sub-account request",
    },
  ];
  return parseCapability({ ...recorded, outcomes }, "sub-account-open with a validation-error signature");
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Anything a test booted and has to close, so one failing case cannot leak a browser into the next. */
const booted: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of booted.splice(0)) await close().catch(() => undefined);
});

/**
 * A surface with a real driver on a real fixture: the shipped policy, allowlisted to the port the
 * fixture just took, with the driver's auto-wait following that policy's `waitForMs` (§5.4).
 */
async function surfaceWith(timing?: PolicyOverrides["timing"]): Promise<Surface> {
  const surface = await startSurface({
    policy: timing === undefined ? undefined : (base) => policyOverrides([base], timing),
  });
  booted.push(() => surface.stop());
  return surface;
}

/** The shipped policy document, with two knobs the caller owns: the origins, and the budget. */
async function policyOverrides(
  origins: readonly string[],
  timing?: PolicyOverrides["timing"],
): Promise<Policy> {
  return Policy.load({
    env: {},
    overrides: {
      allowlist: { origins: [...origins] },
      ...(timing === undefined ? {} : { timing }),
    },
  });
}

/** A driver with no fixture behind it, for the cases whose target is a stub origin. */
async function driverFor(policy: Policy): Promise<SessionDriver> {
  const driver = await SessionDriver.launch({
    headless: true,
    evidenceDir: await mkdtemp(join(tmpdir(), "atlas-evidence-")),
    actionTimeoutMs: policy.document.timing.waitForMs,
    policy,
    redactor: redactorFor(policy),
  });
  booted.push(() => driver.close());
  return driver;
}

/** What a run needs: a driver and the policy it was built from. `Surface` satisfies it too. */
interface Harness {
  readonly driver: SessionDriver;
  readonly policy: Policy;
}

interface Run {
  readonly result: RunResult;
  /** How long the run took, for the criteria phrased as "in ~1-2s, not a timeout". */
  readonly elapsedMs: number;
  readonly notes: readonly string[];
  /** `run.jsonl`, parsed: evidence is a file a reader parses, so the test parses it too. */
  readonly log: readonly Record<string, unknown>[];
  readonly evidenceDir: string;
  /** Every escalation the run raised. P6 attaches an operator; here there is never one (§8). */
  readonly escalations: readonly EscalationRequest[];
}

interface ReplayCase {
  readonly entry: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly capability?: Capability;
}

async function replay(harness: Harness, options: ReplayCase): Promise<Run> {
  const notes: string[] = [];
  const escalations: EscalationRequest[] = [];
  const started = Date.now();
  const result = await runReplay({
    capability: options.capability ?? artifact(),
    driver: harness.driver,
    policy: harness.policy,
    params: new Map(Object.entries(options.params ?? { memberId: MEMBER })),
    entry: options.entry,
    // Every case here passes the fixture's own URL, so the caller is overriding the artifact's entry.
    entryOverridden: true,
    identity: null,
    seams: replaySeams({
      escalation: async (request) => {
        escalations.push(request);
        return "unavailable";
      },
    }),
    onNote: (line) => notes.push(line),
  });
  const elapsedMs = Date.now() - started;

  const raw = await readFile(harness.driver.evidence.runLogPath, "utf8");
  const log = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, elapsedMs, notes, log, evidenceDir: harness.driver.evidenceDir, escalations };
}

/** The `?sim=` URL a state is injected through: the entry the run starts from, plus the sim. */
function simUrl(surface: Surface, sim: string): string {
  return `${surface.base}/?sim=${sim}`;
}

/* -------------------------------------------------------------------------- */
/* Reading a result without losing the failure                                 */
/* -------------------------------------------------------------------------- */

function succeeded(result: RunResult): Extract<RunResult, { status: "success" }> {
  if (result.status !== "success") {
    throw new Error(`expected a success:\n${describeResult(result).join("\n")}`);
  }
  return result;
}

function outcomeOf(result: RunResult): Extract<RunResult, { status: "business-outcome" }>["outcome"] {
  if (result.status !== "business-outcome") {
    throw new Error(`expected a business outcome:\n${describeResult(result).join("\n")}`);
  }
  return result.outcome;
}

/**
 * The failure, with the whole result in the error when it is not one. Asserting `status` first and
 * narrowing by hand is the same thing said twice, and the version that prints `observed` when it
 * fails is the one that explains itself later.
 */
function failed(result: RunResult): Extract<RunResult, { status: "failure" }> {
  if (result.status !== "failure") {
    throw new Error(`expected a failure:\n${describeResult(result).join("\n")}`);
  }
  return result;
}

/** The one line of `run.jsonl` carrying this field, or `undefined`. */
function lineWhere(
  log: readonly Record<string, unknown>[],
  field: string,
  value: unknown,
): Record<string, unknown> | undefined {
  return log.find((line) => line[field] === value);
}

/* -------------------------------------------------------------------------- */
/* A stub origin                                                               */
/* -------------------------------------------------------------------------- */

interface Stub {
  readonly url: string;
}

/**
 * A one-answer origin, for the two targets the fixture cannot be: one that answers HTTP 5xx (a
 * *response*, so §5.2's `TRANSIENT_ERROR` rather than a transport failure) and one that serves a page
 * with no build marker (§26's `unknown`).
 */
async function startStub(answer: { status: number; body: string }): Promise<Stub> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(answer.status, { "content-type": "text/html; charset=utf-8" });
    response.end(answer.body);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  booted.push(() => new Promise<void>((done) => server.close(() => done())));
  return { url: `http://localhost:${port}` };
}

/**
 * An origin that is not there at all: bound to a real port, then shut. The only target that produces
 * a *transport* failure rather than a slow or wrong answer — and the reason the retry budget has two
 * ways to spend an attempt.
 */
async function deadOrigin(): Promise<Stub> {
  const server = createServer(() => undefined);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return { url: `http://localhost:${port}` };
}

/* -------------------------------------------------------------------------- */
/* The saved artifact, replayed                                                */
/* -------------------------------------------------------------------------- */

describe("replaying the recorded artifact", () => {
  it("runs the saved capability end to end and reads the output it declares", async () => {
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: surface.base });

    const success = succeeded(run.result);
    expect(success.outputs).toEqual({ confirmation: "Sub-Account Activated" });
    expect(success.evidence.runDir).toBe(run.evidenceDir);
    expect(success.evidence.runLog).toBe(join(run.evidenceDir, "run.jsonl"));

    // The output is evidence, not only an answer: its value was logged where it was read, and the
    // artifact's `redact: false` is what let it through unmasked (§6's precedence).
    const output = lineWhere(run.log, "subject", "output");
    expect(output).toMatchObject({ name: "confirmation", value: "Sub-Account Activated", redacted: false });

    // Seven steps acted — the eighth is the read above — plus the synthetic entry navigation (§5.4).
    const actions = run.log.filter((line) => line["kind"] === "action");
    expect(actions).toHaveLength(8);
    expect(actions.filter((line) => line["resolvedBy"] !== undefined)).toHaveLength(7);
    expect(actions.some((line) => String(line["action"]).startsWith("navigate "))).toBe(true);
    // Step 3 is the flagship row-relative case (§10 G4): replay resolves it through the same strategy
    // the recorder saw resolve, because the chain is walked in its recorded order and never reordered.
    expect(actions.map((line) => line["resolvedBy"])).toContain("row-relative");
    expect(run.notes).toContain("success condition holds");
  });

  it("replays a different member id, because the assertion is on the route's shape (§28)", async () => {
    // The recorded run was member 12345. This one is 12347, and step 3's expectation is
    // `urlMatches: "/member/:id/summary"` — a *shape*, so it holds for an id the recorder never saw.
    // The control beside it is the same artifact with `:id` made literal, which fails at that step:
    // the pair is what says the canonicalization is load-bearing rather than decorative.
    const surface = await surfaceWith({ waitForMs: 700, retries: 0, backoffMs: [] });
    const other = "12347";

    const shaped = await replay(surface, { entry: surface.base, params: { memberId: other } });
    expect(succeeded(shaped.result).outputs).toEqual({ confirmation: "Sub-Account Activated" });

    const literal = await replay(surface, {
      entry: surface.base,
      params: { memberId: other },
      capability: literalRoutes(),
    });
    const failure = failed(literal.result);
    expect(failure.errorCode).toBe("CHECKPOINT_MISMATCH");
    expect(failure.stepId).toBe(3);
    expect(failure.expected).toContain(`/member/${MEMBER}/summary`);
    expect(failure.observed).toContain(`/member/${other}/summary`);
  });

  it("passes the page's decoy text only because the recorded signature is anchored (§4.1, §10)", async () => {
    // The happy path above succeeds on a page that carries "Locked" twice — the shell's "Locked
    // Accounts Report" link and a dormant account row — and that is the decoy, stated as a property
    // rather than as a coincidence: the loosened copy below is the same artifact with one pattern
    // widened, and it takes that text for the app's answer before the flow has started.
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: surface.base, capability: looseSignature() });
    expect(outcomeOf(run.result).code).toBe("RECORD_LOCKED");
  });
});

/* -------------------------------------------------------------------------- */
/* §5.2's first class: the app's own answers                                    */
/* -------------------------------------------------------------------------- */

describe("an outcome the artifact declares", () => {
  it("comes back as an answer in about a second, not as a timeout", async () => {
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: surface.base, params: { memberId: "99999" } });

    const outcome = outcomeOf(run.result);
    expect(outcome.code).toBe("NO_SUCH_ENTITY");
    expect(outcome.message).toBe("No member 99999 on file");
    // The ordering criterion, as a number: the shipped `waitForMs` is 10s, so a run that reached its
    // budget before looking at the page could not finish in this window. §5.2's precedence is what
    // makes the difference — declared outcomes are probed before the step's own checkpoint, so a
    // stale `expect` cannot pre-empt an answer the app already gave.
    expect(run.elapsedMs).toBeLessThan(3_000);
    expect(run.notes.join("\n")).toContain("business outcome: NO_SUCH_ENTITY");
  });

  it("matches a locked record the sim puts in the data's place", async () => {
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: simUrl(surface, "record-locked") });

    const outcome = outcomeOf(run.result);
    expect(outcome.code).toBe("RECORD_LOCKED");
    expect(outcome.message).toBe(`Member ${MEMBER} is locked`);
    expect(run.elapsedMs).toBeLessThan(3_000);
  });

  it("matches a restricted record the same way", async () => {
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: simUrl(surface, "permission-denied") });

    const outcome = outcomeOf(run.result);
    expect(outcome.code).toBe("PERMISSION_DENIED");
    expect(outcome.message).toBe(`Access to member ${MEMBER} is restricted`);
    expect(run.elapsedMs).toBeLessThan(3_000);
  });

  it("reads a refused form as VALIDATION_ERROR — an answer, not a wrong page (§5.2, §10)", async () => {
    // The fourth code of §5.2's first family, and the one whose detection is easiest to get wrong: the
    // form POST answers 200 with the *same* form carrying two error lines, so a run that only compared
    // URLs would file this as a checkpoint mismatch. §10's reachability map names this state as the
    // reason goal 2 exists; what makes it an answer rather than a wrong page is the outcome probe
    // running before the step's own `expect` does.
    const surface = await surfaceWith();
    const run = await replay(surface, {
      entry: simUrl(surface, "validation-error"),
      capability: withValidationError(),
    });

    const outcome = outcomeOf(run.result);
    expect(outcome.code).toBe("VALIDATION_ERROR");
    expect(outcome.message).toBe("the app refused the sub-account request");
    expect(run.elapsedMs).toBeLessThan(3_000);

    // The control, and the pair is the point: the committed artifact — which declares no such
    // signature, because the run that recorded it never saw this state — meets the same page and ends
    // as a failure. Nothing about the page differs between the two runs; the declaration does.
    //
    // `CHECKPOINT_MISMATCH` and not `ELEMENT_NOT_FOUND`, which is §22's boundary doing its job: the
    // page *settled* — the form came back with its errors — and the answer is simply the wrong one, so
    // re-asking would see the same page. Only a state that never arrived is worth another attempt.
    const control = await replay(surface, { entry: simUrl(surface, "validation-error") });
    expect(failed(control.result).errorCode).toBe("CHECKPOINT_MISMATCH");
  });
});

/* -------------------------------------------------------------------------- */
/* §5.2's third class: a broken run, with the evidence to explain it            */
/* -------------------------------------------------------------------------- */

describe("a page nothing declared", () => {
  it("stops as a hard failure naming what it wanted and what it found", async () => {
    // `?sim=page-error` renders an un-declared state on the entry page itself, so the very first
    // action has nothing to resolve. Note what this is *not*: the fixture answers HTTP 200 with a page,
    // so §5.2 files it as the hard failure it is — `ELEMENT_NOT_FOUND` — rather than reading a status
    // code it was never given (the 5xx case is TRANSIENT_ERROR, and has its own test below).
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: simUrl(surface, "page-error") });

    const failure = failed(run.result);
    expect(failure.stage).toBe("replay");
    expect(failure.stepId).toBe(1);
    expect(failure.errorCode).toBe("ELEMENT_NOT_FOUND");
    expect(failure.escalation).toBe("none");
    expect(failure.expected).toContain("Member ID");
    expect(failure.observed).toContain("no candidate resolved uniquely");
    // §5.3's per-code hint, from the taxonomy map rather than from this call site.
    expect(failure.hint).toContain("re-record");
    // §5.3's evidence refs: the run directory exists and holds the log this test just read.
    expect(await readdir(run.evidenceDir)).toContain("run.jsonl");
  });

  it("reads a 5xx as a response to retry, and terminates under TRANSIENT_ERROR", async () => {
    // A 5xx is the app *answering* unusably, which §22 puts in the retry family: re-ask, and when the
    // budget is spent report the condition's own code — never promote it, never escalate it.
    const stub = await startStub({ status: 503, body: "<html><body><h1>Service unavailable</h1></body></html>" });
    const policy = await policyOverrides([stub.url], { waitForMs: 300, retries: 1, backoffMs: [10] });
    const run = await replay({ driver: await driverFor(policy), policy }, { entry: stub.url });

    const failure = failed(run.result);
    expect(failure.errorCode).toBe("TRANSIENT_ERROR");
    expect(failure.escalation).toBe("none");
    expect(failure.expected).toContain("loads");
    expect(failure.observed).toContain("HTTP 503");
    expect(failure.hint).toContain("re-run");
    // Both attempts are in the log, so "it retried twice and gave up" is a fact a reader can check
    // rather than a claim the terminal made.
    expect(run.log.filter((line) => line["subject"] === "retry")).toHaveLength(1);
    expect(lineWhere(run.log, "subject", "retry-budget")?.["errorCode"]).toBe("TRANSIENT_ERROR");
  });
});

/* -------------------------------------------------------------------------- */
/* §22's retry budget, spent                                                    */
/* -------------------------------------------------------------------------- */

describe("a surface that is too slow", () => {
  it("terminates under SLOW_LOAD when the budget runs out", async () => {
    // 200ms per attempt against a surface that answers in 12 — and answers the *retry* just as slowly
    // (`slowResponses=3`), which is what makes the budget the only thing that ends this run. Attempt
    // one's goto times out; the re-check then finds the response still outstanding (the previous
    // document is on screen reporting itself complete, the misreading §22's split exists to prevent);
    // and because re-issuing a navigation cancels the request in flight, the second attempt waits
    // rather than asking again. Two attempts are the budget, so the run ends where it started:
    // SLOW_LOAD, with the URL the browser never left as `observed`.
    //
    // The retry-arrives-too-late shape is not an accident of the sim: a target slow enough to outlast
    // its budget is slow for the retry as well, and the run has to end as `failure` under the
    // condition rather than as whatever the browser calls a cancelled navigation (`net::ERR_ABORTED`,
    // which is what an earlier engine reached here — see `runUnit`).
    const surface = await surfaceWith({ waitForMs: 200, retries: 1, backoffMs: [10] });
    const run = await replay(surface, { entry: simUrl(surface, "slow=12000&slowResponses=3") });

    const failure = failed(run.result);
    expect(failure.errorCode).toBe("SLOW_LOAD");
    expect(failure.escalation).toBe("none");
    // A failure before step 1 has no step to name — the entry navigation is not a step any artifact
    // recorded, and inventing an id for it would put a step in the caller's hands that it never asked
    // for.
    expect(failure.stepId).toBeUndefined();
    expect(failure.expected).toContain("loads");
    expect(failure.expected).toContain(surface.base);
    // `observed` is the split made visible: not "the page was wrong", but "the response never came".
    expect(failure.observed).toContain("the response has not arrived");
    expect(failure.hint).toContain("waitForMs");
    // Evidence for both attempts: the one that timed out, the one that waited instead of re-asking,
    // and the terminal that says the budget is what ended it.
    expect(run.notes).toContain("  SLOW_LOAD — still navigating; waiting rather than re-issuing");
    expect(run.log.filter((line) => line["subject"] === "retry")).toHaveLength(1);
    expect(lineWhere(run.log, "subject", "retry-wait")?.["errorCode"]).toBe("SLOW_LOAD");
    expect(lineWhere(run.log, "subject", "retry-budget")?.["errorCode"]).toBe("SLOW_LOAD");
  });

  it("re-issues a navigation the origin refused, rather than waiting out a request nobody has", async () => {
    // The other reason §22 retries, and the one that must not be confused with the slow case above: a
    // refused connection leaves `page.url()` exactly where a slow response does — unmoved — but there
    // is nothing in flight to wait for. So the retry is the "fresh question" §5.2 calls it, the terminal
    // is the refusal's own code rather than `SLOW_LOAD`, and a recovered origin is something this run
    // could actually notice.
    const dead = await deadOrigin();
    const policy = await policyOverrides([dead.url], { waitForMs: 300, retries: 1, backoffMs: [10] });
    const run = await replay({ driver: await driverFor(policy), policy }, { entry: dead.url });

    const failure = failed(run.result);
    expect(failure.errorCode).toBe("TRANSPORT_ERROR");
    expect(failure.escalation).toBe("none");
    expect(failure.observed).toMatch(/ERR_CONNECTION_REFUSED|ECONNREFUSED/);
    expect(failure.hint).toContain("check the app is running");
    // Asked twice, and never once "waited" for: an attempt spent waiting would have been spent on a
    // request that does not exist.
    expect(run.log.filter((line) => line["subject"] === "retry")).toHaveLength(1);
    expect(run.log.some((line) => line["subject"] === "retry-wait")).toBe(false);
    expect(lineWhere(run.log, "subject", "retry-budget")?.["errorCode"]).toBe("TRANSPORT_ERROR");
  });

  it("succeeds after a retry when the response lands inside the second look", async () => {
    // The other half of §22's split, and the reason the re-check runs before the step is repeated: the
    // entry navigation's response arrives 3s in, while the first attempt's 2s goto had already given
    // up. Re-issuing the navigation would cancel the very response being waited for, so the check
    // polls the page instead and finds the step already done.
    const surface = await surfaceWith({ waitForMs: 2_000, retries: 2, backoffMs: [100, 100] });
    const run = await replay(surface, { entry: simUrl(surface, "slow=3000") });

    expect(succeeded(run.result).outputs).toEqual({ confirmation: "Sub-Account Activated" });
    expect(run.log.some((line) => line["subject"] === "retry" && line["errorCode"] === "SLOW_LOAD")).toBe(true);
    expect(run.notes).toContain("  the expectation already holds — the step is not repeated");
  });
});

/* -------------------------------------------------------------------------- */
/* §5.2's recoverable middle: dialogs a human would have to answer              */
/* -------------------------------------------------------------------------- */

describe("a dialog on the confirmation POST", () => {
  it("auto-accepts the one policy knows, and the run continues to its output (G3)", async () => {
    // The sim is set on the entry URL and only comes into force at step 7's POST — seven steps after
    // the state was injected. The run has to be identical to the un-injected one, which is what
    // "state injection timing cannot break replay determinism" means in practice.
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: simUrl(surface, "dialog=known") });

    expect(succeeded(run.result).outputs).toEqual({ confirmation: "Sub-Account Activated" });
    // Answering a known dialog is a *decision*, so it is recorded as one: which rule, which response,
    // and the text it was matched against (§6's log discipline, §5.2's policy rule).
    const decision = lineWhere(run.log, "subject", "dialog");
    expect(decision).toMatchObject({
      kind: "decision",
      stepId: 7,
      decision: "accept",
      rule: "policy.recoverableDialogs",
    });
    expect(String(decision?.["observed"])).toContain("Confirm activation of account");
  });

  it("escalates the one it does not know, and reports that nobody answered", async () => {
    const surface = await surfaceWith();
    const run = await replay(surface, { entry: simUrl(surface, "dialog=unexpected") });

    const failure = failed(run.result);
    expect(failure.errorCode).toBe("HUMAN_UNAVAILABLE");
    expect(failure.escalation).toBe("no-operator");
    expect(failure.stepId).toBe(7);
    expect(failure.hint).toContain("attended");

    // The escalation itself is part of the record: a caller reading `HUMAN_UNAVAILABLE` needs to know
    // *what* the app asked, and the request is the only thing that carries the dialog's own words.
    expect(run.escalations).toHaveLength(1);
    expect(run.escalations[0]).toMatchObject({ code: "INTERSTITIAL_DIALOG", stepId: 7 });
    expect(run.escalations[0]?.observed).toContain("WS-4471");
    expect(run.escalations[0]?.evidenceDir).toBe(run.evidenceDir);
  });
});

/* -------------------------------------------------------------------------- */
/* §26's drift preflight, through the CLI                                       */
/* -------------------------------------------------------------------------- */

/** `summary.json` of a CLI run, as far as these tests read it. */
interface Summary {
  readonly version: string;
  readonly entry: string;
  readonly identity: {
    readonly expected: AppIdentity;
    readonly observed: AppIdentity;
    readonly verdict: string;
    readonly reason: string;
  };
  readonly result: { readonly status: string; readonly errorCode?: string };
}

interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly evidenceDir: string;
  /** The run directories the CLI wrote. Empty means it stopped before it launched anything. */
  readonly runDirs: readonly string[];
  readonly summary: Summary | null;
}

/**
 * `npm run replay`, in-process, with evidence somewhere disposable.
 *
 * `EVIDENCE_DIR` is set for the duration of the call and restored after it, because `evidence/` is a
 * tracked tree of deliverable runs (each directory carries the command that regenerates it) and a test
 * that appended to it would be writing into the record.
 */
async function cli(argv: readonly string[]): Promise<CliRun> {
  const evidenceDir = await mkdtemp(join(tmpdir(), "atlas-evidence-"));
  const previous = process.env["EVIDENCE_DIR"];
  const previousBus = process.env["BUS_PORT"];
  process.env["EVIDENCE_DIR"] = evidenceDir;
  // §8's control bus binds a port for every replay run, and parallel test files would collide on the
  // shipped 4517. `BUS_PORT=0` asks the kernel for a free one — the same env knob §5.4 documents, used
  // here for the reason it exists: a machine running more than one thing at a time.
  process.env["BUS_PORT"] = "0";
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = { out: (text) => out.push(text), err: (text) => err.push(text) };

  let code: number;
  try {
    code = await cliReplay(argv, streams);
  } finally {
    if (previous === undefined) delete process.env["EVIDENCE_DIR"];
    else process.env["EVIDENCE_DIR"] = previous;
    if (previousBus === undefined) delete process.env["BUS_PORT"];
    else process.env["BUS_PORT"] = previousBus;
  }

  const runDirs = await readdir(evidenceDir).catch((): string[] => []);
  const first = runDirs[0];
  const summary =
    first === undefined
      ? null
      : (JSON.parse(await readFile(join(evidenceDir, first, "summary.json"), "utf8")) as Summary);
  return { code, out: out.join(""), err: err.join(""), evidenceDir, runDirs, summary };
}

/**
 * The shipped policy with its allowlist pointed at one origin, in a file — which is the form the CLI
 * takes it in (`--policy`), and the form §5.1 keeps arrays in.
 */
async function policyFileFor(origin: string): Promise<string> {
  const document = JSON.parse(readFileSync(join(REPO, "policy", "policy.json"), "utf8")) as {
    allowlist: { origins: string[] };
  };
  document.allowlist.origins = [origin];
  const file = join(await mkdtemp(join(tmpdir(), "atlas-policy-")), "policy.json");
  await writeFile(file, JSON.stringify(document, null, 2), "utf8");
  return file;
}

/** The recorded flow, replayed by the CLI against the fixture this test booted. */
function cliArgs(app: RunningApp, policyFile: string, extra: readonly string[] = []): readonly string[] {
  return ["sub-account-open", "--memberId", MEMBER, "--entry", app.url, "--policy", policyFile, ...extra];
}

describe("preflight against the wrong tenant", () => {
  it("stops before launching a browser, naming both sides (§26)", async () => {
    // The artifact was recorded against `atlas-console/base`. This fixture advertises itself as
    // `sunrise-cu`, which is where a recorded locator may genuinely not exist — so the run refuses
    // up front, and the operator who has to decide what to do about it gets both identities rather
    // than a code. "Before launching a browser" is asserted the only way it can be from outside:
    // nothing was written, because the run directory is created by the driver's logger.
    const app = await startFixture({ variant: "sunrise-cu" });
    booted.push(() => app.close());

    const run = await cli(cliArgs(app, await policyFileFor(app.url)));

    expect(run.code).toBe(2);
    expect(run.err).toContain("expected: atlas-console/base@0.1");
    expect(run.err).toContain("target:   atlas-console/sunrise-cu@0.1");
    expect(run.err).toContain("--allow-drift");
    expect(run.runDirs).toEqual([]);
    expect(run.summary).toBeNull();
  });

  it("runs it anyway under --allow-drift, and records the drift in evidence", async () => {
    const app = await startFixture({ variant: "sunrise-cu" });
    booted.push(() => app.close());

    const run = await cli(cliArgs(app, await policyFileFor(app.url), ["--allow-drift"]));

    expect(run.code).toBe(0);
    expect(run.out).toContain("success");
    // The drift is recorded *and* survives as a successful run: §5.3 is untouched, and the question
    // "was this the app it was recorded against?" is answered after the fact rather than only at the
    // moment it stopped someone (§26's `appIdentity` on every run).
    expect(run.summary?.identity.verdict).toBe("mismatch");
    expect(run.summary?.identity.expected).toMatchObject({ product: "atlas-console", variant: "base" });
    expect(run.summary?.identity.observed).toMatchObject({ product: "atlas-console", variant: "sunrise-cu" });
    expect(run.summary?.result.status).toBe("success");
    expect(run.err).toContain("--allow-drift was given");
  });

  it("proceeds as `unknown` when the target advertises no marker at all", async () => {
    // A legacy console that has no build marker is not evidence of a *different* app — §26 nit 3 — and
    // the run says so and goes on. It then fails in the ordinary way (nothing on that page resolves),
    // which is the point: exit 1 with a classified failure, not exit 2 with a drift report.
    const stub = await startStub({ status: 200, body: "<html><body><h1>Legacy console</h1></body></html>" });

    const run = await cli(["sub-account-open", "--memberId", MEMBER, "--entry", stub.url, "--policy", await policyFileFor(stub.url)]);

    expect(run.code).toBe(1);
    expect(run.summary?.identity.verdict).toBe("unknown");
    expect(run.summary?.identity.observed).toMatchObject({ product: "unknown", variant: "unknown" });
    expect(run.summary?.result).toMatchObject({ status: "failure", errorCode: "ELEMENT_NOT_FOUND" });
  });
});
