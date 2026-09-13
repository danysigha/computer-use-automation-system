/**
 * Observer numbering (§24 pin 2, §11 P1 exit criteria).
 *
 * The load-bearing claim is that truncation is *display-only*. If the compact digest could
 * renumber, a command typed from it would resolve to a different element once the operator
 * expanded the view — a mis-targeted action in a banking app, which is the failure §24 was
 * raised to prevent. So these tests compare indices across renderings, node by node.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERACTABLE_ROLES, isNumbered } from "../../src/surface/observer.ts";
import { frameAt } from "../../src/surface/target.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

let surface: Surface;
const MEMBER = "/member/12345/summary";
const SUBACCOUNT = "/member/12345/subaccount";

beforeAll(async () => {
  // Two data rows is enough to make the fixture's four-row grid truncate, so the summarizer
  // is exercised against a real table rather than a synthetic one.
  surface = await startSurface({ observer: { maxTableRows: 2 } });
});
afterAll(async () => {
  await surface.stop();
});

/** index → rendered description, so two renderings can be compared node by node. */
function tokens(rendered: string): Map<number, string> {
  const found = new Map<number, string>();
  for (const match of rendered.matchAll(/\[(\d+)\] ([^[|\n]*)/g)) {
    found.set(Number(match[1]), (match[2] ?? "").replace(/\s+/g, " ").trim());
  }
  return found;
}

describe("numbering", () => {
  it("is contiguous and 0-based over the numbered set", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const snapshot = await surface.driver.snapshot();

    expect(snapshot.numbered.length).toBeGreaterThan(10);
    snapshot.numbered.forEach((node, position) => {
      expect(node.index).toBe(position);
      expect(isNumbered(node.role)).toBe(true);
    });
  });

  it("gives every frame-tagged node a path frameAt resolves", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const snapshot = await surface.driver.snapshot();
    const inFrames = snapshot.numbered.filter((node) => node.framePath.length > 0);
    expect(inFrames.length).toBeGreaterThan(0);

    // This page has two documents: the header chrome at [0] and the account grid at [1]. A
    // node's path has to name the frame it is *in*, so both appear — and each one has to be a
    // path the resolver can actually walk, which is the agreement target.ts depends on.
    const paths = new Set(inFrames.map((node) => node.framePath.join(".")));
    expect([...paths].sort()).toEqual(["0", "1"]);
    for (const path of paths) {
      const frame = await frameAt(
        surface.page,
        path.split(".").map(Number),
      );
      expect(frame.url()).toContain(surface.base);
    }
  });

  it("is identical across the compact and expanded renderings", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const compact = tokens(await surface.driver.render({ mode: "compact" }));
    const expanded = tokens(await surface.driver.render({ mode: "expanded" }));

    expect(compact.size).toBeGreaterThan(0);
    // Expansion reveals more and shifts nothing: every node the compact digest shows keeps
    // both its index and its description. That is §24's "adds nodes at their true indices and
    // shifts none", asserted as a property rather than a spot check.
    expect(expanded.size).toBeGreaterThan(compact.size);
    for (const [index, description] of compact) {
      expect(expanded.get(index)).toBe(description);
    }
  });

  it("summarizes a truncated table by naming the hidden node range", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const compact = await surface.driver.render({ mode: "compact" });

    // Four data rows against a budget of two: the two hidden rows are named by index, so the
    // console knows what `expand` would reveal without having to render it.
    expect(compact).toMatch(/… 2 more row\(s\) hidden \(nodes \d+–\d+\) — expand to view/);
    expect(await surface.driver.render({ mode: "expanded" })).not.toContain("more row(s) hidden");
  });

  it("keeps a node that is not currently rendered fully addressable", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const snapshot = await surface.driver.snapshot();
    const shown = new Set(tokens(await surface.driver.render({ mode: "compact" })).keys());
    const hidden = snapshot.numbered.filter((node) => node.index !== null && !shown.has(node.index));

    expect(hidden.length).toBeGreaterThan(0);
    for (const node of hidden) {
      // Addressable means: the console can name it, resolve it, and act on it — the model
      // simply never paid context for it. That asymmetry is the whole point of §24 pin 1.
      expect(isNumbered(node.role)).toBe(true);
      expect(surface.driver.observer.nodeAt(snapshot, node.index ?? -1)).toBe(node);
      await expect(
        frameAt(
          surface.page,
          [...node.framePath],
        ),
      ).resolves.toBeDefined();
      // Anything the model could *act on* has to be describable, or the console would be
      // offering a human an unlabelled control to take responsibility for. Nameless structural
      // cells are fine — the grid's Actions column is a nameless wrapper around a named link,
      // and the cell is addressable by index while the link inside carries the word.
      if (INTERACTABLE_ROLES.has(node.role)) expect(node.name).not.toBe("");

      // Addressable is not a bookkeeping claim. Resolve each hidden node to a live element and
      // check it is the thing the node says it is — that is what makes "the console can act on
      // what the model never saw" true rather than notional.
      const element = await surface.driver.observer.elementFor(node);
      expect(element).not.toBeNull();
      const text = ((await element?.textContent()) ?? "").replace(/\s+/g, " ").trim();
      expect(text).toContain(node.name);
      await element?.dispose();
    }
  });

  it("caps static text so one long paragraph cannot dominate the digest", async () => {
    await surface.page.goto(`${surface.base}${SUBACCOUNT}`);
    const compact = await surface.driver.render({ mode: "compact" });
    const lines = compact.split("\n").filter((line) => line.trimStart().startsWith("text "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });
});

describe("digest shape", () => {
  it("opens with the page it describes and includes controls by role", async () => {
    await surface.page.goto(`${surface.base}/`);
    const compact = await surface.driver.render({ mode: "compact" });

    expect(compact.split("\n")[0]).toContain(`${surface.base}/`);
    expect(compact).toContain("button");
    expect(compact).toContain('"Member ID"');
    // The header iframe is inlined with its path rather than dropped, so the model can see
    // (and later address) chrome that lives in a separate document.
    expect(compact).toContain("frame [0]");
  });

  it("renders a scrollable grid one row per line, cells in column order", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const expanded = await surface.driver.render({ mode: "expanded" });
    const savingsRow = expanded.split("\n").find((line) => line.includes('"Savings"'));
    expect(savingsRow).toBeDefined();
    expect(savingsRow).toContain('"SAV"');
    expect(savingsRow).toContain('"$4,201.55"');
    expect(savingsRow?.indexOf('"Savings"')).toBeLessThan(savingsRow?.indexOf('"$4,201.55"') ?? -1);
  });
});
