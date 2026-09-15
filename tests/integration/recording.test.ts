/**
 * Recording a real run (§11 P4's exit criteria), end to end on the fixture.
 *
 * The loop tests next door prove the *loop* works; this proves the thing the phase is actually
 * graded on — that a genuine discovery run against a real browser emits an artifact that passes
 * validation and carries the four properties §11 names: candidates starting with the strategy that
 * resolved, a reconciliation record of the binding, `risk`/`redact` stamped from the run's own
 * classifications, and canonicalization over every emitted string field.
 *
 * Every assertion here is about a field that would be *invisible* if it were wrong. An artifact with
 * a literal `12345` in a `textEquals` validates perfectly and replays correctly against member 12345
 * and nobody else; a `redact: false` that should have been `true` validates perfectly and leaks. That
 * is why the checks are on exact values rather than on shape — the shape is what the schema already
 * guards, and it is not what this phase can get wrong.
 */
import { describe, expect, it } from "vitest";
import { runDiscovery } from "../../src/agent/loop.ts";
import { BindingLog } from "../../src/agent/canonicalize.ts";
import { recordCapability } from "../../src/agent/recorder.ts";
import { reviewCapability } from "../../src/agent/review.ts";
import type { AgentDriver, Decision, Turn } from "../../src/agent/driver.ts";
import { agentConfig } from "../../src/agent/config.ts";
import { identityOf, observeIdentity } from "../../src/surface/identity.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

const GOAL = "Look up member 12345 and read their current savings balance";
const BALANCE = "$4,201.55";
const MEMBER = "12345";

/* -------------------------------------------------------------------------- */
/* A scripted model, reading the digest the way a model does                    */
/* -------------------------------------------------------------------------- */

function digestNodes(digest: string): { index: number; role: string; name: string; text: string }[] {
  const nodes: { index: number; role: string; name: string; text: string }[] = [];
  for (const line of digest.split("\n")) {
    for (const part of line.split("|")) {
      const match = /^\[(\d+)]\s+([a-z]+)(?:\s+"([^"]*)")?(?:\s+=\s+"([^"]*)")?/.exec(part.trim());
      if (match === null) continue;
      nodes.push({
        index: Number(match[1]),
        role: match[2] ?? "",
        name: match[3] ?? "",
        text: match[4] ?? "",
      });
    }
  }
  return nodes;
}

function find(digest: string, role: string, name: string): number {
  const node = digestNodes(digest).find((candidate) => candidate.role === role && candidate.name === name);
  if (node === undefined) throw new Error(`no ${role} named ${JSON.stringify(name)}`);
  return node.index;
}

function showing(digest: string, text: string): number {
  const node = digestNodes(digest).find((candidate) => candidate.name === text || candidate.text === text);
  if (node === undefined) throw new Error(`no node showing ${JSON.stringify(text)}`);
  return node.index;
}

function scripted(steps: readonly ((turn: Turn) => Decision)[]): AgentDriver {
  return {
    name: "scripted",
    async decide(turn: Turn): Promise<Decision> {
      const step = steps[turn.step - 1];
      if (step === undefined) throw new Error(`the script has no step ${turn.step}`);
      return step(turn);
    },
  };
}

/** The path a person takes: search, open the member, read the balance off the grid, report it. */
const SCRIPT = [
  (turn: Turn): Decision => ({
    tool: "type",
    arguments: { index: find(turn.digest, "textbox", "Member ID"), text: MEMBER },
  }),
  (turn: Turn): Decision => ({ tool: "click", arguments: { index: find(turn.digest, "button", "Search") } }),
  (turn: Turn): Decision => ({ tool: "click", arguments: { index: find(turn.digest, "link", "Detail") } }),
  (turn: Turn): Decision => ({ tool: "read", arguments: { index: showing(turn.digest, BALANCE) } }),
  (): Decision => ({ tool: "markComplete", arguments: { outputs: { balance: BALANCE } } }),
];

async function record(surface: Surface, goal = GOAL) {
  const config = agentConfig(surface.policy, {});
  const run = await runDiscovery({
    driver: surface.driver,
    agent: scripted(SCRIPT),
    policy: surface.policy,
    budgets: config.budgets,
    screenshot: null,
    entry: `${surface.base}/`,
    goal,
  });
  const params = [{ name: "memberId", value: MEMBER }];
  const identity = identityOf(await observeIdentity(surface.page));
  const recording = recordCapability({
    run,
    id: "member-savings-balance",
    name: "Member savings balance",
    description: "Looks up a member and reads their savings balance.",
    params,
    identity,
    policy: surface.policy,
    discoveryRunId: "run-1",
    recordedAt: "2026-09-15T00:00:00.000Z",
    bindings: new BindingLog(params),
  });
  return { run, recording };
}

/* -------------------------------------------------------------------------- */

describe("a recording of a real run", () => {
  it("emits an artifact that validates, with the entry as the surface and not as a step", async () => {
    const surface = await startSurface();
    try {
      const { recording } = await record(surface);

      // The store validates, so this passing *is* the schema check — there is no second gate.
      const artifact = recording.capability;
      expect(artifact.schemaVersion).toBe("1.0");
      expect(artifact.surface).toEqual({ kind: "web-dom", entry: `${surface.base}/` });
      expect(artifact.steps.map((step) => step.kind)).toEqual(["act", "act", "act", "extract"]);
      expect(artifact.steps.map((step) => step.id)).toEqual([1, 2, 3, 4]);
      expect(recording.warnings).toEqual([]);
    } finally {
      await surface.stop();
    }
  });

  it("starts every chain with the strategy that actually resolved, never a template order", async () => {
    const surface = await startSurface();
    try {
      const { run, recording } = await record(surface);
      const acts = run.trace.filter((entry) => entry.kind === "act");

      for (const [index, step] of recording.capability.steps.entries()) {
        if (step.kind !== "act") continue;
        // The trace is the record of what happened; the artifact must not have reordered it. §4.1's
        // whole determinism story is that the first rung is the one that worked — a chain that put
        // `css` first "because it always works" would resolve to a different element on a page that
        // had grown a column, and would do so silently.
        expect(step.target.candidates[0]?.strategy).toBe(acts[index]?.kind === "act" ? acts[index].resolvedBy : "");
        expect(step.target.candidates[0]?.strategy).not.toBe("css");
      }
    } finally {
      await surface.stop();
    }
  });

  it("canonicalizes the sample out of every field that carries it (§28)", async () => {
    const surface = await startSurface();
    try {
      const { recording } = await record(surface);
      // Canonicalization is the one rule whose failure is *invisible*: an artifact carrying `12345`
      // everywhere validates, replays, and produces exactly the right answer for exactly one member.
      // So the assertion is the absence of the sample, not the presence of a placeholder.
      const emitted = JSON.stringify(recording.capability);
      expect(emitted).not.toContain(MEMBER);
      expect(emitted).toContain("{memberId}");

      // A member id is a string that happens to be digits, not an amount — §4.2's examples agree,
      // and the distinction is only visible when a sample is ambiguous. `12345` is the ambiguous
      // case, which makes it the one worth pinning.
      const [input] = recording.capability.inputs;
      expect(input).toMatchObject({ name: "memberId", type: "string" });

      const [type] = recording.capability.steps;
      if (type?.kind !== "act") throw new Error("expected the type step");
      expect(type.action).toBe("type");
      expect(type.value).toBe("{memberId}");
      // The field that accepted the input is the field whose postcondition is the input — the case
      // §28 exists for, since a `textEquals` here would pin the artifact to one member.
      expect(type.expect).toEqual({
        textEquals: { target: type.target, value: "{memberId}" },
      });
    } finally {
      await surface.stop();
    }
  });

  it("asserts the route by shape, so a different member id still passes (§28)", async () => {
    const surface = await startSurface();
    try {
      const { recording } = await record(surface);
      const steps = recording.capability.steps;

      // Clicking `Detail` navigates to `/member/12345/summary` — the deep link, and the one place a
      // member id reaches an assertion. `:id` is the route's shape; `{memberId}` would have been the
      // caller's value, which is the other syntax and the other meaning.
      const detail = steps[2];
      expect(detail?.kind === "act" ? detail.expect : null).toEqual({ urlMatches: "/member/:id/summary" });
      expect(recording.capability.success).toEqual({ urlMatches: "/member/:id/summary" });
    } finally {
      await surface.stop();
    }
  });

  it("points every output at the extract step that read it, and stamps its redaction", async () => {
    const surface = await startSurface();
    try {
      const { recording } = await record(surface);
      const [output] = recording.capability.outputs;
      expect(output).toBeDefined();
      if (output === undefined) return;

      const source = recording.capability.steps.find((step) => step.id === output.source.stepId);
      expect(source?.kind).toBe("extract");
      // The schema's own cross-check requires these to match; asserting it here says the recorder
      // *chose* the right step rather than happening to satisfy the validator.
      expect(source?.kind === "extract" ? source.name : null).toBe(output.name);
      expect(output.type).toBe("money");
      // Stamped from the run: policy `redact.fieldPatterns` are password/ssn/account_number, and
      // neither the output's name nor the cell it was read from carries one. The value is the
      // point — this is the assertion that fails the day someone defaults the flag to `true` to
      // "be safe", which would silently strip a number the capability exists to return.
      expect(output.redact).toBe(false);
    } finally {
      await surface.stop();
    }
  });

  it("records the binding reconciliation, so a mis-binding is reviewable rather than silent", async () => {
    const surface = await startSurface();
    try {
      const params = [{ name: "memberId", value: MEMBER }];
      const bindings = new BindingLog(params);
      const config = agentConfig(surface.policy, {});
      const run = await runDiscovery({
        driver: surface.driver,
        agent: scripted(SCRIPT),
        policy: surface.policy,
        budgets: config.budgets,
        screenshot: null,
        entry: `${surface.base}/`,
        goal: GOAL,
      });
      recordCapability({
        run,
        id: "member-savings-balance",
        name: "n",
        description: "d",
        params,
        identity: identityOf(await observeIdentity(surface.page)),
        policy: surface.policy,
        discoveryRunId: "run-1",
        bindings,
      });

      // §28 rule 3: substitution is substring-based and over-binding is possible, so every
      // substitution is recorded and the human review pass is what catches a wrong one. An entry
      // naming the field is what makes that possible; a count alone would not.
      const fields = bindings.entries.map((entry) => entry.field);
      expect(fields).toContain("steps.0.value");
      expect(fields).toContain("steps.0.expect.textEquals.value");
      for (const entry of bindings.entries) {
        expect(entry.param).toBe("memberId");
        expect(entry.sample).toBe(MEMBER);
      }
    } finally {
      await surface.stop();
    }
  });
});

/**
 * The review pass on the real recording — §11 P4's last exit criterion, and the only place the
 * signatures meet the app that has to render them.
 *
 * §4.1 rule 3's smoke check runs inside `reviewCapability` (a signature matching the happy path is a
 * refusal), so the first test passing *is* that check passing. What it cannot prove is the other half
 * of the claim: that the patterns match the messages the fixture actually renders for its failure
 * sims. That is fetched below, from the app, with tags stripped — the §10 G1/G2 anchoring as a
 * request rather than a promise.
 */
describe("reviewing the recording of a real run", () => {
  /** The three §10 G1/G2 pins, and the sim that makes the fixture render each one. */
  const PINS = [
    { code: "NO_SUCH_ENTITY", sim: "record-not-found", id: "99999", message: "No member 99999 on file" },
    { code: "RECORD_LOCKED", sim: "record-locked", id: MEMBER, message: "Member 12345 is locked" },
    { code: "PERMISSION_DENIED", sim: "permission-denied", id: MEMBER, message: "Access to member 12345 is restricted" },
  ] as const;

  it("carries the curated failure vocabulary, and the run's own text does not trip it", async () => {
    const surface = await startSurface();
    try {
      const { run, recording } = await record(surface);
      const reviewed = reviewCapability({
        capability: recording.capability,
        run,
        seeds: surface.policy.document.outcomes,
      });

      expect(reviewed.reviewed).toBe(true);
      expect(reviewed.capability.outcomes.map((outcome) => outcome.code)).toEqual(PINS.map((pin) => pin.code));
      expect(reviewed.capability.provenance.reviewedBy).toBe("human");
      // The recorder left them empty — the seeds are the review's work, not the run's.
      expect(recording.capability.outcomes).toEqual([]);
    } finally {
      await surface.stop();
    }
  });

  it("anchors each signature to a message the fixture really renders", async () => {
    const surface = await startSurface();
    try {
      const { run, recording } = await record(surface);
      const { capability } = reviewCapability({
        capability: recording.capability,
        run,
        seeds: surface.policy.document.outcomes,
      });

      for (const pin of PINS) {
        const html = await (await fetch(`${surface.base}/member/${pin.id}/summary?sim=${pin.sim}`)).text();
        const rendered = alertText(html);
        expect(rendered, `${pin.sim} should render its pinned message`).toBe(pin.message);

        const detect = capability.outcomes.find((outcome) => outcome.code === pin.code)?.detect;
        // `text-on-page` because that is what a seed becomes; the pattern is the policy's, verbatim.
        const matches = detect?.kind === "text-on-page" && new RegExp(detect.pattern).test(rendered);
        expect(matches, `${pin.code}'s signature should match ${JSON.stringify(rendered)}`).toBe(true);
      }
    } finally {
      await surface.stop();
    }
  });
});

/**
 * The banner's text, as a reader of the page would get it.
 *
 * Deliberately not a regex for the message itself: extracting the text with the pattern under test
 * would assert only that the pattern matches what the pattern found.
 */
function alertText(html: string): string {
  const banner = /role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (banner?.[1] === undefined) throw new Error("the response carried no alert banner");
  return banner[1].replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
}
