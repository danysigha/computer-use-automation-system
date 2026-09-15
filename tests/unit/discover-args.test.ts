/**
 * `discover`'s argument grammar (§5.4), and the parse's real job: the errors.
 *
 * §5.4 freezes the grammar, so most of this file is one test per accepted form plus one per way a
 * caller can get it wrong. The errors are the point rather than the happy path — §5.4 makes usage
 * errors exit `2` *before* a browser or a model is paid for, and a caller who typed `--param
 * memberId` (no value) or `--gol` should learn that in the command they are still holding, not forty
 * turns into a run. Every error is asserted with both halves: the problem, and the fix.
 *
 * `deriveId` is here too — the flag-less fallback. Its one non-negotiable property is the reason it
 * substitutes samples for names first: an id becomes a *path* in the store, so a caller's value must
 * never be able to reach it.
 */
import { describe, expect, it } from "vitest";
import { deriveId, parseArgs, type Args } from "../../src/cli/discover.ts";
import type { ParamSample } from "../../src/agent/canonicalize.ts";

/** The parsed args, for a command that should have succeeded. Fails loudly when it did not. */
function args(argv: readonly string[]): Args {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected these args to parse: ${parsed.problem}`);
  return parsed.args;
}

describe("parsing the grammar", () => {
  it("takes a goal alone", () => {
    const parsed = args(["--goal", "Read the balance"]);
    expect(parsed.goal).toBe("Read the balance");
    expect(parsed.params).toEqual([]);
    expect(parsed.entry).toBeNull();
    expect(parsed.id).toBeNull();
    expect(parsed.headed).toBe(false);
    expect(parsed.json).toBe(false);
  });

  it("takes the full form", () => {
    const parsed = args([
      "--goal",
      "Look up member 12345 and read their savings balance",
      "--param",
      "memberId=12345",
      "--entry",
      "http://localhost:4173/",
      "--id",
      "member-savings-balance",
      "--headed",
      "--json",
    ]);
    expect(parsed.goal).toContain("savings balance");
    expect(parsed.params).toEqual([{ name: "memberId", value: "12345" }]);
    expect(parsed.entry).toBe("http://localhost:4173/");
    expect(parsed.id).toBe("member-savings-balance");
    expect(parsed.headed).toBe(true);
    expect(parsed.json).toBe(true);
  });

  it("keeps params in declaration order, which is the order §28 canonicalizes in", () => {
    const parsed = args([
      "--param",
      "b=2",
      "--goal",
      "g",
      "--param",
      "a=1",
    ]);
    expect(parsed.params.map((param) => param.name)).toEqual(["b", "a"]);
  });

  it("keeps a value's own `=` — only the first one splits", () => {
    // A value can legitimately contain `=`, and splitting on every one would silently truncate it.
    const parsed = args(["--goal", "g", "--param", "query=name=Ada"]);
    expect(parsed.params[0]).toEqual({ name: "query", value: "name=Ada" });
  });

  it("keeps a value's leading space, and trims the name's", () => {
    // A field may well want the space; a space in a *name* is always a typo.
    const parsed = args(["--goal", "g", "--param", " code = 42"]);
    expect(parsed.params[0]).toEqual({ name: "code", value: " 42" });
  });

  it("accepts an empty value, which is a value a form can be given", () => {
    const parsed = args(["--goal", "g", "--param", "nickname="]);
    expect(parsed.params[0]).toEqual({ name: "nickname", value: "" });
  });
});

describe("usage errors", () => {
  it("requires a goal, and shows one that works", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("--goal is required");
    expect(parsed.fix).toContain("Look up member 12345");
  });

  it("refuses a goal that is only whitespace", () => {
    const parsed = parseArgs(["--goal", "   "]);
    expect(parsed.ok).toBe(false);
  });

  it("reports an unknown flag", () => {
    const parsed = parseArgs(["--goal", "g", "--gol", "x"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toBe("unknown flag --gol");
    expect(parsed.fix).toContain("npm run discover");
  });

  it("refuses a positional argument, naming what it does not take", () => {
    // `npm run discover -- "read the balance"` is the natural mistake, and the fix is the flag.
    const parsed = parseArgs(["read the balance"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("no positional arguments");
    expect(parsed.problem).toContain("read the balance");
  });

  it("reports a flag whose value is missing, or is the next flag", () => {
    // `--goal --param x=1` is a missing value, not a goal of "--param": a flag starting with `--` is
    // never a value, which is what stops one missing argument from silently eating the next one.
    const missing = parseArgs(["--goal"]);
    expect(missing.ok === false && missing.problem).toBe("--goal needs a value");

    const swallowed = parseArgs(["--goal", "--param", "x=1"]);
    expect(swallowed.ok === false && swallowed.problem).toBe("--goal needs a value");
  });

  it("refuses a --param that is not name=value", () => {
    const parsed = parseArgs(["--goal", "g", "--param", "memberId"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("is not <name>=<value>");
    expect(parsed.fix).toContain("--param memberId=12345");
  });

  it("refuses a name the artifact schema would refuse, before a model is called", () => {
    // §5.4's hard boundary: this is a *usage* error, not a `VALIDATION_ERROR` business outcome, and it
    // has to fire before the run because otherwise it surfaces after the run is paid for.
    const parsed = parseArgs(["--goal", "g", "--param", "2fast=1"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("2fast");
    expect(parsed.problem).toContain("placeholder");
  });

  it("refuses a name that collides with the CLI's own flags", () => {
    // The grammar is `--<name> <value>`, so a param named `version` would make `--version 2` mean two
    // things. The message is the artifact's own, so a caller who meets it here and again in a saved
    // file reads one sentence rather than wondering whether it is one problem.
    const parsed = parseArgs(["--goal", "g", "--param", "version=1"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("reserved CLI flag set");
    expect(parsed.problem).toContain("--version ambiguous");
  });

  it("refuses two params with one name", () => {
    const parsed = parseArgs(["--goal", "g", "--param", "memberId=1", "--param", "memberId=2"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toBe("--param memberId was declared twice");
  });

  it("refuses an id that could not be a capability's handle", () => {
    const parsed = parseArgs(["--goal", "g", "--id", "Member Balance"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("Member Balance");
    expect(parsed.fix).toContain("--id member-savings-balance");
  });
});

describe("the id a goal derives", () => {
  const memberId: ParamSample = { name: "memberId", value: "12345" };

  it("replaces a declared sample with its param name", () => {
    // The property that matters: an id becomes a path in the store, so a caller's value must not be
    // able to reach it. Substituting first is what makes that structural rather than a hope. The
    // doubled "member memberid" is honest — the goal says the word and the placeholder repeats it, and
    // this path is a fallback for a caller who did not care enough to pass `--id`.
    const id = deriveId("Look up member 12345 and read their current savings balance", [memberId]);
    expect(id).toBe("look-member-memberid-current-savings-balance");
    expect(id).not.toContain("12345");
  });

  it("replaces every occurrence, whatever the case", () => {
    const id = deriveId("Read 12345, then re-read 12345 twice", [memberId]);
    expect(id).not.toContain("12345");
  });

  it("drops the words a handle does not need", () => {
    expect(deriveId("Read the balance of the account for the member", [])).toBe("balance-account-member");
  });

  it("caps a sentence at six words", () => {
    // A goal is a sentence and an id is a handle; the cap is why the flag-less path produces something
    // a person would type rather than the whole goal.
    const id = deriveId("open the member page then click the savings tab then read the balance field", []);
    expect(id.split("-").length).toBeLessThanOrEqual(6);
  });

  it("never starts with a digit or a dash", () => {
    // The artifact's own name pattern, which the store enforces — so the derived id has to satisfy it
    // too, or the flag-less path would produce an id that cannot be saved.
    expect(deriveId("12345 lookup", [])).toBe("lookup");
    expect(deriveId("  ...  ", [])).toBe("capability");
  });

  it("falls back to a usable name when the goal has nothing to make one from", () => {
    expect(deriveId("the a of to", [])).toBe("capability");
  });
});
