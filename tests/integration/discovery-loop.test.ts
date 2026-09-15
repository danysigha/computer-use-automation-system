/**
 * The discovery loop, driven against the real fixture on a real browser.
 *
 * The model is scripted, and that is the point rather than a shortcut. §9's whole bet is that the
 * loop's *behaviour* — observe, resolve an index against the snapshot the model was shown, check the
 * policy choke point, record the delta — is the system's and not the provider's. A test that needed
 * an API key could only run when someone had one, so the property that matters would go unverified
 * on exactly the runs where it mattered. Here the decisions are fixed and everything else is real:
 * the fixture's nasty nested tables, the balance grid's iframe, the capture chain, the policy.
 *
 * The scripted driver reads the digest — the same text a model reads — and answers with indices,
 * never with selectors. That is what makes this a test of the loop rather than of a stub: if the
 * digest stopped numbering a node, or the numbering stopped matching the snapshot the loop resolves
 * against, these tests would fail the way a real model would fail.
 */
import { describe, expect, it } from "vitest";
import { runDiscovery, type DiscoveryRun } from "../../src/agent/loop.ts";
import type { AgentDriver, Decision, Turn } from "../../src/agent/driver.ts";
import { agentConfig } from "../../src/agent/config.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

const GOAL = "Look up member 12345 and read their current savings balance";
const BALANCE = "$4,201.55";

/* -------------------------------------------------------------------------- */
/* Reading the digest, the way a model does                                    */
/* -------------------------------------------------------------------------- */

interface DigestNode {
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly text: string;
}

/**
 * The digest's nodes, parsed.
 *
 * A row renders as one line holding several `[index] role "name"` entries joined by `|`, so the
 * split is on both. This is the test's own reader and deliberately not a shared helper: if the
 * format drifts, a parser that drifted with it would hide exactly what the test exists to catch.
 */
function digestNodes(digest: string): DigestNode[] {
  const nodes: DigestNode[] = [];
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

/**
 * A node by its role and accessible name — never by name alone.
 *
 * The fixture makes the loose version wrong twice over, and both are the ambiguity §9's digest
 * exists to resolve. The header carries `[1] link "Search"` while the inquiry form carries
 * `[9] button "Search"`; and `<td class="field-label">Member ID</td>` is a *cell* whose accessible
 * name is `Member ID`, sitting one row above the `[6] textbox "Member ID"` it labels. A reader that
 * matched on the name alone would type into the label, which is precisely the mistake a model has
 * to avoid and the reason the digest prints the role on every line.
 */
function find(digest: string, role: string, name: string): DigestNode {
  const node = digestNodes(digest).find((candidate) => candidate.role === role && candidate.name === name);
  if (node === undefined) throw new Error(`no ${role} named ${JSON.stringify(name)} in:\n${digest}`);
  return node;
}

/** A node by what it displays. A cell carries its text as its name, so both are checked. */
function showing(digest: string, text: string): DigestNode {
  const node = digestNodes(digest).find((candidate) => candidate.name === text || candidate.text === text);
  if (node === undefined) throw new Error(`no node showing ${JSON.stringify(text)} in:\n${digest}`);
  return node;
}

/** A driver that follows a fixed script, one decision per turn. */
function scripted(script: readonly ((turn: Turn) => Decision)[]): AgentDriver & { readonly turns: Turn[] } {
  const turns: Turn[] = [];
  return {
    name: "scripted",
    turns,
    async decide(turn: Turn): Promise<Decision> {
      turns.push(turn);
      const step = script[turn.step - 1];
      if (step === undefined) {
        throw new Error(`the script has no step ${turn.step}; the loop asked for more turns than expected`);
      }
      return step(turn);
    },
  };
}

async function discover(surface: Surface, agent: AgentDriver): Promise<DiscoveryRun> {
  const config = agentConfig(surface.policy, {});
  return runDiscovery({
    driver: surface.driver,
    agent,
    policy: surface.policy,
    budgets: config.budgets,
    // Vision off: the loop must work on the digest alone, and a JPEG per turn would only make the
    // test slower and its evidence larger.
    screenshot: null,
    entry: `${surface.base}/`,
    goal: GOAL,
  });
}

/* -------------------------------------------------------------------------- */

describe("a discovery run against the fixture", () => {
  it("reaches the goal, and records it as steps the recorder can read", async () => {
    const surface = await startSurface();
    try {
      const agent = scripted([
        // 1. The entry page's inquiry form.
        (turn) => ({ tool: "type", arguments: { index: find(turn.digest, "textbox", "Member ID").index, text: "12345" } }),
        // 2. Submit it.
        (turn) => ({ tool: "click", arguments: { index: find(turn.digest, "button", "Search").index } }),
        // 3. The results grid carries one `Detail` link per account row; the first belongs to Savings.
        //    Nothing but the digest's numbering distinguishes them, which is the ambiguity §9's index
        //    resolution exists to close.
        (turn) => ({ tool: "click", arguments: { index: find(turn.digest, "link", "Detail").index } }),
        // 4. The summary page's balance grid is a separate document behind iframe 1; the value is a
        //    cell in a row inside it. This is the fixture's flagship case: a row-relative target
        //    composed with a frame path, which is the pairing an artifact has to carry to replay it.
        (turn) => ({ tool: "read", arguments: { index: showing(turn.digest, BALANCE).index } }),
        // 5. Report what was read.
        () => ({ tool: "markComplete", arguments: { outputs: { balance: BALANCE } } }),
      ]);

      const run = await discover(surface, agent);

      expect(run.ending).toEqual({ kind: "completed", outputs: { balance: BALANCE } });

      // The entry navigation is not a step: replay navigates to `surface.entry` to begin, so a step
      // for it would make every replay navigate twice.
      const kinds = run.trace.map((entry) => entry.kind);
      expect(kinds).toEqual(["entry", "act", "act", "act", "read"]);

      const [, type, click] = run.trace;
      expect(type).toMatchObject({ kind: "act", action: "type", value: "12345" });
      expect(click).toMatchObject({ kind: "act", action: "click" });

      // The index is the model's and the digest's, not the trace's invention: the node the act
      // records is the node at the index the model named. It is the one field here that must never
      // reach an artifact (§9), so it is worth pinning to its source.
      if (type?.kind !== "act") throw new Error("expected the type act");
      expect(type.index).toBe(type.node.index);

      // Each act carries a chain captured while the element was live, and the action line records
      // which rung of it resolved — §11's "artifact candidates start with the strategy that
      // resolved". No index, and no Playwright `ref`, reaches the trace.
      for (const entry of [type, click]) {
        if (entry?.kind !== "act") throw new Error("expected an act");
        expect(entry.target.candidates.length).toBeGreaterThan(0);
        expect(entry.resolvedBy).toBe(entry.target.candidates[0]?.strategy);
        expect(entry.resolvedBy).not.toBe("css");
      }

      // The typed field's own text either side is what the recorder turns into `textEquals`: the
      // assertion that the field *accepted* the input rather than only that we sent it.
      if (type?.kind !== "act") throw new Error("expected the type act");
      expect(type.textBefore).toBe("");
      expect(type.textAfter).toBe("12345");

      // The read carries the value the model was shown, and a target to point an extract at.
      const read = run.trace[4];
      if (read?.kind !== "read") throw new Error("expected the read");
      expect(read.text).toBe(BALANCE);
      expect(read.target.candidates.length).toBeGreaterThan(0);
      // The value lives in the grid frame, and the chain says so. A chain that dropped the frame
      // path would resolve against the top document at replay and find no such cell — the failure
      // would land on a run that had recorded every other field correctly.
      expect(read.node.framePath).toEqual([1]);
      expect(read.target.framePath).toEqual(read.node.framePath);
    } finally {
      await surface.stop();
    }
  });

  it("refuses to report a value the run never read, and lets the model fix it", async () => {
    // §9's provenance rule: every output becomes an `extract` step pointing at where it came from.
    // A value nothing was read from has nowhere to point, so it is caught while the model can still
    // go and read it — rather than failing the recording after the run has ended.
    const surface = await startSurface();
    try {
      const agent = scripted([
        (turn) => ({ tool: "type", arguments: { index: find(turn.digest, "textbox", "Member ID").index, text: "12345" } }),
        (turn) => ({ tool: "click", arguments: { index: find(turn.digest, "button", "Search").index } }),
        // Report a plausible-looking balance without reading anything.
        () => ({ tool: "markComplete", arguments: { outputs: { balance: BALANCE } } }),
        // Told to read it, the model does.
        (turn) => ({ tool: "read", arguments: { index: showing(turn.digest, BALANCE).index } }),
        () => ({ tool: "markComplete", arguments: { outputs: { balance: BALANCE } } }),
      ]);

      const run = await discover(surface, agent);

      expect(run.ending).toEqual({ kind: "completed", outputs: { balance: BALANCE } });
      // The refusal is a correction, not a step: nothing about the page was attempted. It reaches
      // the model on the *next* turn, which is the turn that goes and reads the value.
      expect(run.trace.map((entry) => entry.kind)).toEqual(["entry", "act", "act", "read"]);
      expect(agent.turns[3]?.correction).toContain("has to come from a `read`");
    } finally {
      await surface.stop();
    }
  });

  it("refuses the third identical call rather than performing it", async () => {
    // The run re-types the value it already typed. The second call changes nothing, so it is not
    // recorded and the model is told; the third is refused by the repeat counter *before* it is
    // performed — which is the difference between stopping at the third and making a fourth.
    const surface = await startSurface();
    try {
      const sameField = (turn: Turn): Decision => ({
        tool: "type",
        arguments: { index: find(turn.digest, "textbox", "Member ID").index, text: "12345" },
      });
      const agent = scripted([sameField, sameField, sameField]);

      const run = await discover(surface, agent);

      expect(run.ending).toMatchObject({ kind: "stuck", reason: { kind: "repeat", tool: "type", count: 3 } });
      expect(agent.turns).toHaveLength(3);
      // Only the first call did anything, so only the first is a step. The second was a genuine
      // no-op and the third was never carried out.
      expect(run.trace.map((entry) => entry.kind)).toEqual(["entry", "act"]);
      // The model was told, rather than left to guess: the no-op act came back as a correction
      // naming what it did and why nothing was recorded.
      expect(agent.turns[2]?.correction).toContain("no observable effect");
    } finally {
      await surface.stop();
    }
  });
});
