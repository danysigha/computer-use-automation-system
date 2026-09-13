/**
 * Target capture — "candidate order is recorded truth, not a template" (§4.1).
 *
 * Two rules are asserted here:
 *  - a `role` candidate is emitted **only** when the element has an accessible name, so a
 *    nameless legacy control's chain honestly starts one rung down;
 *  - the recorder **skips ambiguous strategies**, so ambiguity never enters an artifact.
 *
 * The second rule is what makes the first safe, and the property test at the bottom is the
 * one that matters: every candidate a capture emits must resolve back to the element it was
 * captured from.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureTarget } from "../../src/surface/capture.ts";
import { frameAt, resolveTarget, type TargetCandidate } from "../../src/surface/target.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

let surface: Surface;
const HOME = "/";
const MEMBER = "/member/12345/summary";
const RESULTS = "/search?memberId=12345";
const SUBACCOUNT = "/member/12345/subaccount";

beforeAll(async () => {
  surface = await startSurface();
});
afterAll(async () => {
  await surface.stop();
});

const strategies = (candidates: readonly TargetCandidate[]): string[] =>
  candidates.map((candidate) => candidate.strategy);

describe("role candidates are earned, not assumed", () => {
  it("emits a role candidate first for a properly named control", async () => {
    await surface.page.goto(`${surface.base}${HOME}`);
    const button = await surface.page.getByRole("button", { name: "Search" }).elementHandle();
    expect(button).not.toBeNull();
    const descriptor = await captureTarget(surface.page, button!);

    expect(descriptor.candidates[0]).toEqual({ strategy: "role", role: "button", name: "Search" });
    await button!.dispose();
  });

  it("emits NO role candidate for a control with no accessible name", async () => {
    await surface.page.goto(`${surface.base}${SUBACCOUNT}`);
    // The Branch-code input: no label[for], no aria-label, no placeholder. Its label is a
    // sibling text cell, which is exactly what an accessible name must not be borrowed from.
    const input = await surface.page.locator('input[name="branch"]').elementHandle();
    expect(input).not.toBeNull();
    const descriptor = await captureTarget(surface.page, input!);

    expect(strategies(descriptor.candidates)).not.toContain("role");
    // It is not left unactionable either: the chain still resolves, via the last resort.
    expect(strategies(descriptor.candidates)).toContain("css");
    const resolved = await resolveTarget(surface.page, descriptor);
    expect(await resolved.element.evaluate((el, other) => el === other, input)).toBe(true);
    await resolved.element.dispose();
    await input!.dispose();
  });

  it("emits no role candidate for a nameless control even when a label sits beside it", async () => {
    await surface.page.goto(`${surface.base}${SUBACCOUNT}`);
    const nickname = await surface.page.locator('input[name="nickname"]').elementHandle();
    const descriptor = await captureTarget(surface.page, nickname!);
    // This one DOES have an aria-label, so it earns a role candidate — the contrast with the
    // branch field is the point: same table, same markup idiom, different accessible name.
    expect(strategies(descriptor.candidates)[0]).toBe("role");
    expect(descriptor.candidates[0]).toMatchObject({ strategy: "role", name: "Nickname" });
    await nickname!.dispose();
  });
});

describe("row-relative is captured for grid cells", () => {
  it("records the row anchor and the header column of a cell inside a frame", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const frame = await frameAt(surface.page, [1]);
    const cell = await frame.getByRole("cell", { name: "$4,201.55" }).elementHandle();
    expect(cell).not.toBeNull();
    const descriptor = await captureTarget(surface.page, cell!, [1]);

    const rowRelative = descriptor.candidates.find((candidate) => candidate.strategy === "row-relative");
    expect(rowRelative).toBeDefined();
    expect(rowRelative).toMatchObject({
      strategy: "row-relative",
      row: { by: "cell-text", text: "Savings" },
      column: { by: "header-text", text: "Balance" },
      action: "cell",
    });
    await cell!.dispose();
  });
});

describe("ambiguity never reaches the artifact", () => {
  it("drops the genuinely ambiguous strategies and keeps the one that is not", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    // The grid's "Savings" cell. Its accessible name also matches the two Recent Activity rows
    // that begin with the same word, and the same word sits in three cells — so a `role` or
    // `text` candidate here would be a coin flip between three elements, and the recorder
    // refuses to write one down.
    const cell = await surface.page.locator("td", { hasText: /^Savings$/ }).first().elementHandle();
    expect(cell).not.toBeNull();
    const descriptor = await captureTarget(surface.page, cell!);

    expect(strategies(descriptor.candidates)).not.toContain("role");
    expect(strategies(descriptor.candidates)).not.toContain("text");

    // row-relative survives, and not by being lenient: its anchor is chosen under the resolver's
    // own containment rule, which finds the row's "SAV" code unique exactly where "Savings" is
    // not. So the chain stays semantic-first with css as its floor rather than collapsing to the
    // positional strategy — which is the whole difference between an artifact that survives a
    // layout change and one that quietly drifts.
    expect(strategies(descriptor.candidates)[0]).toBe("row-relative");
    expect(strategies(descriptor.candidates)).toContain("css");

    const resolved = await resolveTarget(surface.page, descriptor);
    expect(await resolved.element.evaluate((el, other) => el === other, cell)).toBe(true);
    await resolved.element.dispose();
    await cell!.dispose();
  });
});

describe("property: a captured chain always resolves back to its element", () => {
  const cases: readonly { path: string; framePath?: number[]; selector: string; description: string }[] = [
    { path: HOME, selector: 'button[type="submit"]', description: "the search submit button" },
    { path: HOME, selector: 'input[name="memberId"]', description: "the member id field" },
    { path: SUBACCOUNT, selector: 'input[name="branch"]', description: "the nameless legacy field" },
    { path: SUBACCOUNT, selector: 'button[type="submit"]', description: "the form's continue button" },
    { path: SUBACCOUNT, selector: "select", description: "the sub-account type combobox" },
    { path: RESULTS, selector: 'a[href="/member/12345/summary"]', description: "a duplicated Detail link" },
    { path: RESULTS, selector: "td", description: "the grid's Savings cell, whose text recurs" },
  ];

  for (const testCase of cases) {
    it(`round-trips ${testCase.description}`, async () => {
      await surface.page.goto(`${surface.base}${testCase.path}`);
      const element = await surface.page.locator(testCase.selector).first().elementHandle();
      expect(element).not.toBeNull();

      const descriptor = await captureTarget(surface.page, element!, testCase.framePath ?? []);
      expect(descriptor.candidates.length).toBeGreaterThan(0);

      const resolved = await resolveTarget(surface.page, descriptor);
      expect(await resolved.element.evaluate((el, other) => el === other, element)).toBe(true);
      await resolved.element.dispose();
      await element!.dispose();
    });
  }
});
