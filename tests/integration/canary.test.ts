/**
 * The determinism canary (§11 P7's gate, §5.1) — the committed artifact, replayed twice, back to
 * back, with the two `run.jsonl` step traces diffed.
 *
 * §5.1's claim is the one the whole design rests on: *recording* may be expensive, non-deterministic
 * and unrepeatable, but **replay is a program**. The suite proves that claim one case at a time; this
 * file proves it the way the plan states it, as a property — run the same artifact against the same
 * app twice and nothing about the run is allowed to differ except the clock.
 *
 * **Why the trace and not the result.** A `RunResult` that matches is necessary and not sufficient:
 * two runs can reach the same answer by different routes, and the route *is* the deliverable here
 * (which candidate resolved, in what order, with what policy verdict). `run.jsonl` is the run, in
 * order, and it is what an evaluator reads — so it is what gets diffed. `seq` is kept in the
 * comparison on purpose: the same lines in the same order is the assertion, not merely the same set.
 *
 * **What is allowed to differ, and why.** One field, `at` — the wall clock, which is evidence about
 * *when* rather than about *what*. Everything else is compared verbatim, including timings-free
 * narration, the policy rule behind every verdict, and the value read out of the grid. If a future
 * change needs a second exemption, this file is where the argument for it belongs, in the same
 * paragraph as the exemption.
 *
 * The artifact is read off disk exactly as P4 saved it (`sub-account-open`'s sibling, the flagship
 * goal-1 capability), and each run gets its own browser session and its own evidence directory —
 * that is, two runs of the shape a caller would actually make, not one session re-used.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningApp } from "../../sample-app/server.ts";
import { Policy } from "../../src/policy/policy.ts";
import { redactorFor } from "../../src/policy/redact.ts";
import { replaySeams, runReplay } from "../../src/replay/engine.ts";
import { describeResult, type RunResult } from "../../src/replay/result.ts";
import type { Capability } from "../../src/schema/artifact.ts";
import { parseCapability } from "../../src/schema/validate.ts";
import { fetchIdentity, identityEvidence } from "../../src/surface/identity.ts";
import { SessionDriver } from "../../src/surface/session-driver.ts";
import { startFixture } from "../helpers/fixture.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMITTED = join(REPO, "capabilities", "member-savings-balance", "v1", "artifact.json");
const MEMBER = "12345";

/** One line of `run.jsonl`, as a reader parses it. */
type Line = Record<string, unknown>;

/** Anything a case booted, closed after it, so a failing assertion cannot leak a browser. */
const booted: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of booted.splice(0)) await close().catch(() => undefined);
});

/** The recorded capability, read exactly as it was saved — nothing here rewrites its steps. */
function artifact(): Capability {
  return parseCapability(JSON.parse(readFileSync(COMMITTED, "utf8")), "member-savings-balance");
}

/** The fixture, with the shipped policy allowlisted to the port it just took (§5.4's usual test fix). */
async function fixtureWithPolicy(): Promise<{ app: RunningApp; policy: Policy }> {
  const app = await startFixture();
  booted.push(() => app.close());
  const policy = await Policy.load({ env: {}, overrides: { allowlist: { origins: [app.url] } } });
  return { app, policy };
}

interface Run {
  readonly result: RunResult;
  /** Parsed `run.jsonl`, in order. */
  readonly log: readonly Line[];
}

/** One replay, in a fresh browser session with its own evidence directory. */
async function replayOnce(app: RunningApp, policy: Policy): Promise<Run> {
  const driver = await SessionDriver.launch({
    headless: true,
    evidenceDir: await mkdtemp(join(tmpdir(), "atlas-canary-")),
    actionTimeoutMs: policy.document.timing.waitForMs,
    policy,
    redactor: redactorFor(policy),
  });
  booted.push(() => driver.close());

  const capability = artifact();
  // §26's comparison, made the way the CLI makes it: against what the target advertises, before the
  // run. It is part of the trace, so a drift check that started answering differently would show up
  // here rather than as a mystery failure downstream.
  const identity = identityEvidence(capability.app, await fetchIdentity(app.url));

  const result = await runReplay({
    capability,
    driver,
    policy,
    params: new Map([["memberId", MEMBER]]),
    entry: app.url,
    // The fixture took an ephemeral port, so the caller is overriding the artifact's own entry — the
    // same thing every other case in this suite does, and the reason the criterion is about the
    // *artifact* rather than about a port.
    entryOverridden: true,
    identity,
    seams: replaySeams(),
  });

  const raw = await readFile(driver.evidence.runLogPath, "utf8");
  const log = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
  return { result, log };
}

/**
 * The trace as it is compared: every line, in order, with the one volatile field removed.
 *
 * Destructured rather than deleted so a reader can see the exemption is exhaustive — a second
 * volatile field would have to be added here, in the open, next to the argument for it.
 */
function traceOf(log: readonly Line[]): readonly Line[] {
  return log.map((line) => {
    const { at: _at, ...rest } = line;
    return rest;
  });
}

/** The step traces alone: the decisions that name a recorded step, which is the run's spine. */
function stepTraceOf(log: readonly Line[]): readonly Line[] {
  return log.filter((line) => line["kind"] === "decision" && line["subject"] === "step");
}

/** Where two traces first differ, for a failure message that points at the line rather than the file. */
function firstDivergence(left: readonly Line[], right: readonly Line[]): string | null {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return (
        `line ${index + 1} differs:\n` +
        `  first run:  ${JSON.stringify(left[index])}\n` +
        `  second run: ${JSON.stringify(right[index])}`
      );
    }
  }
  if (left.length !== right.length) {
    return `the traces are different lengths: ${left.length} line(s) then ${right.length}`;
  }
  return null;
}

/**
 * The result, narrowed, with the failure's own rendering in the error when it is not a success.
 * Asserting `status` first and narrowing by hand is the same thing said twice, and the version that
 * prints `observed` when it fails is the one that explains itself later.
 */
function succeeded(result: RunResult, which: string): Extract<RunResult, { status: "success" }> {
  if (result.status !== "success") {
    throw new Error(`${which} did not succeed:\n${describeResult(result).join("\n")}`);
  }
  return result;
}

describe("the committed artifact, replayed twice", () => {
  it("produces the same result and the same run trace, line for line", async () => {
    const { app, policy } = await fixtureWithPolicy();

    // Back to back, sequentially, each in its own browser session — no cleanup, restart or wait
    // between them, because the criterion is about the engine and not about a tidy machine.
    const first = await replayOnce(app, policy);
    const second = await replayOnce(app, policy);

    // The answer first, so a failure reads as "the run itself broke" before it reads as "the traces
    // differ", and because a trace diff on a failed run would be noise.
    const firstResult = succeeded(first.result, "the first run");
    const secondResult = succeeded(second.result, "the second run");
    // `evidence` is the run's *address*, not a fact about the run: the caller chose the directory,
    // and a timestamped run id is the same class of thing as `at` below. It is asserted to be
    // per-run instead — two runs that wrote to one directory would not be two runs.
    const { evidence: firstDir, ...firstFacts } = firstResult;
    const { evidence: secondDir, ...secondFacts } = secondResult;
    expect(secondFacts).toEqual(firstFacts);
    expect(secondDir).not.toEqual(firstDir);

    const firstTrace = traceOf(first.log);
    const secondTrace = traceOf(second.log);
    expect(firstDivergence(firstTrace, secondTrace)).toBeNull();
    expect(secondTrace).toEqual(firstTrace);

    // The trace is the run's *spine*, so it is asserted to be non-trivial rather than merely equal:
    // three recorded steps, each with the decision line that names it, and the entry unit §5.4
    // synthesizes. Two empty logs would also match each other.
    const steps = stepTraceOf(first.log);
    expect(steps.map((line) => line["stepId"])).toEqual([null, 1, 2, 3]);
    expect(secondTrace.length).toBe(firstTrace.length);

    // And the evidence the run is read for is in there: the value came out of the grid, and the
    // observation line that recorded it is part of the trace that has to hold still.
    expect(firstTrace.some((line) => line["subject"] === "output" && line["value"] === 4201.55)).toBe(true);
  });
});

/**
 * The instrument, held to the same standard as the thing it measures (§11 P3's "the rule is not
 * vacuous" convention). A comparator that answered `null` for everything would let the canary above
 * pass while asserting nothing, so the three answers it can give — equal, different at a line,
 * different in length — are pinned here rather than trusted.
 */
describe("the comparator the canary rests on", () => {
  const line = (seq: number, message: string): Line => ({ seq, kind: "note", message });

  it("is quiet about two traces that agree", () => {
    expect(firstDivergence([line(1, "a"), line(2, "b")], [line(1, "a"), line(2, "b")])).toBeNull();
  });

  it("points at the line where they first differ, and shows both sides", () => {
    const divergence = firstDivergence([line(1, "a"), line(2, "b")], [line(1, "a"), line(2, "c")]);
    expect(divergence).toContain("line 2 differs");
    expect(divergence).toContain('"message":"b"');
    expect(divergence).toContain('"message":"c"');
  });

  it("names a trace that lost or gained a line, rather than calling it equal", () => {
    expect(firstDivergence([line(1, "a"), line(2, "b")], [line(1, "a")])).toContain(
      "different lengths: 2 line(s) then 1",
    );
  });
});
