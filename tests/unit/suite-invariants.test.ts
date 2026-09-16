/**
 * Two properties of the suite itself, enforced structurally (§23 nit 3, §12).
 *
 * Both are rules the plan states about *tests* rather than about the system, and both fail in the
 * same direction if they are left to discipline: nobody notices until CI, where the symptom is a
 * red build on a machine with no display, or a green build that proves less than it claims.
 *
 * 1. **No integration test runs a browser it cannot see.** §23 added `--headed` to `replay` for the
 *    attended escalation demo, and §23 nit 3 is the CI-honesty rule that came with it: the demo
 *    needs a window; a test must not, because the runner has no display and the suite's value is
 *    that it reproduces the demo's *behaviour* without one. This is a source scan rather than a
 *    runtime check for the reason the sink rule next door is one: a test that opened a headed
 *    browser would pass on a developer's laptop and fail only on the machine that matters.
 *
 * 2. **The scans stay honest about their own instrument.** A source scan is only as good as its
 *    ability to see the thing it forbids, so each rule below is asserted to fire on a planted
 *    example. The convention comes from `serialization-sinks.test.ts`, which pins that its comment
 *    stripper still sees real calls; the pin matters more here, because "no matches found" is
 *    exactly what a broken scan reports.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../helpers/source-scan.ts";

const INTEGRATION = resolve(dirname(fileURLToPath(import.meta.url)), "../integration");

/**
 * Ways a test can ask for a visible browser. Two spellings, because there are two doors: the CLI's
 * `--headed` flag (a spawned process, as in `control.test.ts`) and the driver's own option (the
 * `startSurface` helper passes `headless` straight through to `SessionDriver.launch`).
 */
const VISIBLE_BROWSER = [/(^|[^-\w])--headed\b/, /headless\s*:\s*false\b/];

/** The integration tests, with comments stripped: the files that *describe* the rule may name it. */
async function integrationSources(): Promise<readonly { readonly path: string; readonly code: string }[]> {
  const entries = await readdir(INTEGRATION, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => relative(INTEGRATION, join(entry.parentPath, entry.name)))
    .sort();
  return Promise.all(
    files.map(async (path) => ({
      path,
      code: stripComments(await readFile(join(INTEGRATION, path), "utf8")),
    })),
  );
}

/** Every integration source that asks for a visible browser, as `path:needle`. */
async function visibleBrowserAsks(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const file of await integrationSources()) {
    for (const rule of VISIBLE_BROWSER) {
      if (rule.test(file.code)) found.push(`${file.path}:${String(rule)}`);
    }
  }
  return found;
}

describe("the suite's own invariants", () => {
  it("scans the integration tests it means to scan, not an empty directory", async () => {
    // Without this, a wrong path makes every assertion below vacuous — the failure mode a source
    // scan hides best, because "nothing to see" and "nothing found" read the same.
    const files = await integrationSources();
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => file.path)).toContain("replay.test.ts");
  });

  it("keeps every integration test headless (§23 nit 3, §12)", async () => {
    expect(await visibleBrowserAsks()).toEqual([]);
  });

  it("would catch a headed run — the rule is not vacuous", () => {
    // The planted examples are the two spellings a real test would use. Nothing in the runner is
    // invoked here: the rules themselves are the thing under test.
    expect(VISIBLE_BROWSER.some((rule) => rule.test('spawn(node, ["src/cli/replay.ts", "--headed"]);'))).toBe(true);
    expect(VISIBLE_BROWSER.some((rule) => rule.test("startSurface({ headless: false });"))).toBe(true);
    // And they do not fire on the ways a headless run spells the same words, which is what makes the
    // rule above a statement about *visible* browsers rather than about the word "headless".
    expect(VISIBLE_BROWSER.some((rule) => rule.test("startSurface({ headless: true });"))).toBe(false);
    expect(VISIBLE_BROWSER.some((rule) => rule.test("headless = true;"))).toBe(false);
  });
});
