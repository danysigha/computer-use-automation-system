/**
 * The one-serializer rule, enforced structurally (§6, §11 P3).
 *
 * §6 asks for redaction "at every serialization boundary" and names the sinks — `run.jsonl`, DOM
 * snapshots, the control bus's state, console renders, `--json` stdout. A rule that depends on each
 * future sink remembering to scrub is a rule that holds until the fourth sink, so the codebase
 * states it as an invariant instead: **`Redactor.serialize` is the only function in `src/` that
 * turns a run payload into JSON.** `redact.ts` and `session-driver.ts` both point at this file in
 * their comments, which is what makes it the enforcement rather than a coincidence.
 *
 * This is a source scan, not a runtime check, on purpose: a sink that was never exercised by a test
 * would pass a runtime check and still leak in production. P6's control bus is the next sink that
 * will hit this file, and hitting it is the point — adding a `JSON.stringify` for a bus payload
 * fails `npm test` with an explanation of what to call instead.
 *
 * Two exemptions, both stated:
 *
 * - `src/policy/redact.ts` — it *is* the serializer.
 * - `src/store/**` — the capability store writes a different class of data: reviewed, versioned
 *   artifacts (the thing a human approved), not run evidence (what happened during a run). Its
 *   payloads come from `artifact.json`, and P2's schema already refuses unknown fields, so there is
 *   no path by which a page's text reaches one. If that ever stops being true, this exemption is
 *   the line to delete.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** The call this test is about. `JSON.parse` is deliberately not covered — see below. */
const SERIALIZER_CALL = /JSON\.stringify\s*\(/;

/**
 * The files allowed to call it, and why. Everything else must go through `Redactor.serialize`.
 *
 * `JSON.parse` is unrestricted and that asymmetry is intentional: parsing is the *inbound*
 * direction (a policy file, an artifact on disk), it constructs no sink payload, and a leaked
 * secret in an inbound file is a leak the file already had.
 */
const EXEMPT = ["policy/redact.ts", "store/"];

/**
 * Comments are stripped before scanning, because the files that *describe* this rule necessarily
 * name the call it forbids. A `//` is only treated as a comment when it opens a line (or follows
 * whitespace) — good enough for source we control, and the assertion below proves the stripper
 * still sees real calls rather than having flattened the file into nothing.
 */
export function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/(^|\s)\/\/[^\n]*/g, "$1");
}

async function sourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(SRC, join(entry.parentPath, entry.name)))
    .sort();
}

/** Every non-exempt call site, as `path:line`. */
async function serializerCalls(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles()) {
    if (EXEMPT.some((exempt) => file === exempt || file.startsWith(exempt))) continue;
    const lines = stripComments(await readFile(join(SRC, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (SERIALIZER_CALL.test(line)) found.push(`${file}:${index + 1}`);
    });
  }
  return found;
}

describe("the one-serializer rule", () => {
  it("finds no serializer call outside the redactor", async () => {
    const calls = await serializerCalls();
    expect(
      calls,
      calls.length === 0
        ? ""
        : `serialized a payload without the redactor at ${calls.join(", ")} — call ` +
            `Redactor.serialize (or scrubText for a text sink) instead: it is the only path that ` +
            `scrubs §6's sinks, and a second formatter is a sink nobody scrubs.`,
    ).toEqual([]);
  });

  it("scans the whole source tree — the rule is not vacuous", async () => {
    const files = await sourceFiles();
    // A handful today; the floor is here so a broken walk (a moved directory, a renamed root)
    // fails loudly instead of reporting "no violations" about nothing.
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("policy/redact.ts");
    expect(files.some((file) => file.startsWith("surface/"))).toBe(true);
  });

  it("keeps the redactor's own call, so the rule has something to permit", async () => {
    const redact = stripComments(await readFile(join(SRC, "policy/redact.ts"), "utf8"));
    expect(SERIALIZER_CALL.test(redact)).toBe(true);
    expect(redact).toContain("this.scrub(value)");
  });

  it("strips comments without stripping code", () => {
    // The stripper's own contract, asserted: it must remove the prose that names the forbidden
    // call and leave a real call standing, or every finding above would be an artifact of it.
    const source = ["// JSON.stringify(x) in a line comment", "/* JSON.stringify(y) in a block */", "const z = JSON.stringify(a);"].join(
      "\n",
    );
    const stripped = stripComments(source);
    expect(stripped).not.toContain("in a line comment");
    expect(stripped).not.toContain("in a block");
    expect(stripped.match(SERIALIZER_CALL)?.length ?? 0).toBe(1);
  });

  it("leaves the capability store exempt for the reason the exemption states", async () => {
    // Not a free pass: the store's exemption rests on it writing reviewed artifacts rather than run
    // evidence. If a page-derived value ever becomes storable, this is the test to delete.
    const store = await readdir(join(SRC, "store"));
    expect(store.some((file) => file.endsWith(".ts"))).toBe(true);
    const calls = (await serializerCalls()).filter((call) => call.startsWith("store/"));
    expect(calls).toEqual([]);
  });

  it("is the rule the source files point at, so a reader finds it from either end", async () => {
    // The invariant is only enforceable if the next person to write a sink learns about it where
    // they are writing. Both files that would otherwise be the first to break it name this test.
    for (const file of ["surface/session-driver.ts", "policy/redact.ts"]) {
      const source = await readFile(join(SRC, file), "utf8");
      expect(`${file}: ${source.includes("serialization-sinks.test.ts")}`).toBe(`${file}: true`);
    }
  });

  it("scrubs through the one path the driver's own action lines go through", async () => {
    // The driver hand-writes its action descriptions precisely because it may not build a JSON
    // payload; the evidence logger is where those descriptions land.
    const evidence = await readFile(join(SRC, "surface/evidence.ts"), "utf8");
    expect(evidence).toContain("this.#redactor.serialize(");
    expect(evidence).toContain("this.#redactor.scrubText(");
  });
});
