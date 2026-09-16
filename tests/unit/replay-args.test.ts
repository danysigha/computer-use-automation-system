/**
 * `replay`'s three pure decisions: the grammar, the inputs, and §26's drift verdict (§5.4, §26).
 *
 * They are one file because they are one boundary. §5.4 makes the CLI's job "turn a caller's words
 * into a run, or refuse before anything is paid for", and all three of these decide *refuse*: a flag
 * the grammar does not have, a value the artifact's own declaration rejects, a target that is not the
 * app the artifact was recorded against. Each exits `2` and each never produces a `RunResult` — a
 * distinction a caller scripted against a capability depends on, because "the run did not happen" and
 * "the run happened and the answer is no" have to be told apart from outside the process.
 *
 * The error *text* is asserted, not just the refusal, for the reason `discover-args.test.ts` gives:
 * a usage error is the whole interface a caller sees when they get it wrong, and "invalid input" is
 * not something anyone can act on. `driftVerdict`'s message is the one that names both sides, because
 * the operator reading it is looking at two apps they cannot see from the terminal.
 */
import { describe, expect, it } from "vitest";
import { bindInputs, driftVerdict, narratingEscalation, parseArgs, type Args } from "../../src/cli/replay.ts";
import type { Capability } from "../../src/schema/artifact.ts";
import { identityEvidence } from "../../src/surface/identity.ts";
import { validArtifact } from "../helpers/artifact.ts";

/** The parsed args, for a command that should have succeeded. Fails loudly when it did not. */
function args(argv: readonly string[]): Args {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected these args to parse: ${parsed.problem}`);
  return parsed.args;
}

/** The failure, for a command that should have been refused — with both halves checked. */
function refused(argv: readonly string[]): { problem: string; fix: string } {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error("expected these args to be refused");
  expect(parsed.fix).not.toBe("");
  return parsed;
}

describe("parsing the replay grammar", () => {
  it("takes a bare capability id, and defaults everything else", () => {
    const parsed = args(["member-savings-balance"]);
    expect(parsed.id).toBe("member-savings-balance");
    // `latest` is the store's pointer, which is what a caller means by "the capability" (§5.4).
    expect(parsed.version).toBe("latest");
    expect(parsed.entry).toBeNull();
    expect(parsed.policyFile).toBeNull();
    expect(parsed.inputs.size).toBe(0);
    expect(parsed.allowDrift).toBe(false);
    expect(parsed.headed).toBe(false);
    expect(parsed.json).toBe(false);
  });

  it("takes the full form, with every flag", () => {
    const parsed = args([
      "member-savings-balance",
      "--version",
      "2",
      "--memberId",
      "12345",
      "--entry",
      "http://localhost:4173/?sim=slow",
      "--policy",
      "/tmp/policy.json",
      "--allow-drift",
      "--headed",
      "--json",
    ]);
    expect(parsed.version).toBe("2");
    expect([...parsed.inputs]).toEqual([["memberId", "12345"]]);
    expect(parsed.entry).toBe("http://localhost:4173/?sim=slow");
    expect(parsed.policyFile).toBe("/tmp/policy.json");
    expect(parsed.allowDrift).toBe(true);
    expect(parsed.headed).toBe(true);
    expect(parsed.json).toBe(true);
  });

  it("reads an undeclared flag as one of the artifact's inputs", () => {
    // The whole reason §5.4's grammar can exist: `FLAGS` is a closed set, so every other `--name` is
    // an input. Whether the name is real is the artifact's question, asked next rather than guessed
    // at here — the fix needs the declared list, which does not exist yet at this point.
    const parsed = args(["cap", "--memberId", "1", "--from", "2026-01-01"]);
    expect([...parsed.inputs]).toEqual([
      ["memberId", "1"],
      ["from", "2026-01-01"],
    ]);
  });

  it("refuses a run with no capability named", () => {
    const parsed = refused([]);
    expect(parsed.problem).toContain("no capability was named");
    // The fix says what to type, not "see --help": a caller who typed nothing needs an example.
    expect(parsed.fix).toContain("member-savings-balance");
  });

  it("refuses a second positional", () => {
    const parsed = refused(["cap", "other-cap"]);
    expect(parsed.problem).toContain("one capability id");
    expect(parsed.problem).toContain('"cap" and "other-cap"');
  });

  it("refuses a flag with no value, naming the flag", () => {
    const parsed = refused(["cap", "--memberId"]);
    expect(parsed.problem).toBe("--memberId needs a value");
    expect(parsed.fix).toContain("--memberId <value>");
  });

  it("does not let a value be another flag", () => {
    // `--version --json` is a caller who forgot the value, not a request to version the artifact
    // "--json". Read as a value it would fail much later, as a store lookup for a nonsense version.
    const parsed = refused(["cap", "--version", "--json"]);
    expect(parsed.problem).toBe("--version needs a value");
  });

  it("refuses the same flag twice by taking the last one, and says nothing false", () => {
    // Last-wins is the conventional reading and the grammar does not need more: an artifact whose
    // inputs collide with a flag cannot be saved (`validate.ts` checks the same reserved list).
    expect(args(["cap", "--version", "1", "--version", "2"]).version).toBe("2");
    expect(args(["cap", "--memberId", "1", "--memberId", "2"]).inputs.get("memberId")).toBe("2");
  });
});

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

describe("binding the caller's inputs to the artifact's declarations", () => {
  const capability = (): Capability => validArtifact() as Capability;

  it("accepts a value that satisfies the declaration", () => {
    const bound = bindInputs(capability(), new Map([["memberId", "12345"]]));
    expect(bound.ok).toBe(true);
    if (bound.ok) expect([...bound.params]).toEqual([["memberId", "12345"]]);
  });

  it("refuses a name the artifact does not declare, listing the ones it does", () => {
    const bound = bindInputs(capability(), new Map([["memberID", "12345"]]));
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    // One character apart, and only one of them is the artifact's — so the declared set is the fix,
    // not a guess at which was meant.
    expect(bound.problem).toContain("no input named `memberID`");
    expect(bound.problem).toContain("it declares: --memberId");
  });

  it("refuses a missing value, quoting the declaration the caller has to satisfy", () => {
    const bound = bindInputs(capability(), new Map());
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.problem).toContain("--memberId has no value");
    expect(bound.problem).toContain("Five-digit member number");
  });

  it("refuses a value the declared pattern rejects, before any run exists", () => {
    const bound = bindInputs(capability(), new Map([["memberId", "not-a-member"]]));
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    // §5.4's boundary: this is exit 2 and never a runtime `VALIDATION_ERROR`, because the app was
    // never asked — the artifact said what its input looks like and the caller's value does not.
    expect(bound.problem).toContain("--memberId must match /^[0-9]{5}$/");
  });

  it("reports every problem at once, because they are one mistake", () => {
    const bound = bindInputs(capability(), new Map([["memberId", "1"], ["extra", "x"]]));
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.problem).toContain("no input named `extra`");
    expect(bound.problem).toContain("must match");
  });

  it("checks `int` and `money` values the way the page would read them", () => {
    const artifact = validArtifact();
    artifact.inputs = [
      { name: "count", type: "int", description: "How many" },
      { name: "amount", type: "money", description: "How much" },
    ];
    const loose = artifact as Capability;

    const ok = bindInputs(loose, new Map([["count", "12"], ["amount", "$1,200.00"]]));
    expect(ok.ok).toBe(true);

    const bad = bindInputs(loose, new Map([["count", "twelve"], ["amount", "lots"]]));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problem).toContain("--count expects an integer");
    expect(bad.problem).toContain("--amount expects an amount");
  });

  it("says so plainly when the capability declares no inputs at all", () => {
    const artifact = validArtifact();
    artifact.inputs = [];
    const bound = bindInputs(artifact as Capability, new Map([["memberId", "1"]]));
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.problem).toContain("this capability declares no inputs at all");
  });
});

/* -------------------------------------------------------------------------- */
/* §26 — tenant drift                                                          */
/* -------------------------------------------------------------------------- */

describe("the tenant-drift verdict", () => {
  const recorded = { product: "atlas-console", variant: "base", version: "0.1" };

  it("passes when the target is the app the artifact was recorded against", () => {
    const identity = identityEvidence(recorded, { kind: "observed", identity: recorded });
    expect(identity.verdict).toBe("match");
    expect(driftVerdict(identity, false).ok).toBe(true);
  });

  it("stops on a different product or variant, naming both sides", () => {
    const identity = identityEvidence(recorded, {
      kind: "observed",
      identity: { product: "atlas-console", variant: "sunrise-cu", version: "0.1" },
    });
    const verdict = driftVerdict(identity, false);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // A different configuration is where the recorded locators may genuinely not exist, so the run
    // stops *before* a browser exists — and the operator who has to decide what to do about it needs
    // both identities in the message, not a code.
    expect(verdict.problem).toContain("expected: atlas-console/base@0.1");
    expect(verdict.problem).toContain("target:   atlas-console/sunrise-cu@0.1");
    expect(verdict.fix).toContain("--allow-drift");
  });

  it("proceeds on a version difference, which is a patch rather than a different app", () => {
    // §26's asymmetry, and the reason it exists: blocking on every version bump is what teaches
    // operators to reach for `--allow-drift` reflexively, which destroys the signal.
    const identity = identityEvidence(recorded, {
      kind: "observed",
      identity: { product: "atlas-console", variant: "base", version: "9.9" },
    });
    expect(identity.verdict).toBe("version-drift");
    expect(driftVerdict(identity, false).ok).toBe(true);
  });

  it("proceeds as `unknown` when the target advertises no marker", () => {
    const identity = identityEvidence(recorded, { kind: "absent" });
    expect(identity.verdict).toBe("unknown");
    // Not a stop, deliberately: real legacy consoles advertise nothing, and a check that only worked
    // on a cooperative target would be worthless. Step-level `expect` is the backstop (§26 nit 3).
    expect(driftVerdict(identity, false).ok).toBe(true);
  });

  it("runs a mismatch anyway under --allow-drift, which is the operator saying they know", () => {
    const identity = identityEvidence(recorded, {
      kind: "observed",
      identity: { product: "atlas-console", variant: "sunrise-cu", version: "0.1" },
    });
    expect(driftVerdict(identity, true).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The escalation seam                                                         */
/* -------------------------------------------------------------------------- */

describe("narrating an escalation", () => {
  it("says what happened and why, then reports that nobody could answer", async () => {
    const lines: string[] = [];
    const handler = narratingEscalation((line) => lines.push(line));
    const outcome = await handler({
      code: "INTERSTITIAL_DIALOG",
      stepId: 3,
      reason: "policy does not know this dialog",
      url: "http://localhost:4173/",
      observed: '"Your session will expire"',
      evidenceDir: "/tmp/run",
    });

    // Without this narration an unexpected dialog ends the run as `HUMAN_UNAVAILABLE` with nothing in
    // the terminal explaining that the *app* asked a question — a failure whose cause is invisible
    // reads as a bug in the tool rather than as the truth about the run.
    expect(lines[0]).toBe("escalation: INTERSTITIAL_DIALOG at step 3");
    expect(lines[1]).toBe("  policy does not know this dialog");
    expect(lines[2]).toContain("observed:");
    expect(lines.join("\n")).toContain("P6 wires the control bus");
    expect(outcome).toBe("unavailable");
  });

  it("names the entry when the escalation happened before any step", async () => {
    const lines: string[] = [];
    await narratingEscalation((line) => lines.push(line))({
      code: "SESSION_EXPIRED",
      stepId: null,
      reason: "a password field appeared",
      url: "http://localhost:4173/login",
      observed: "the page shows a login form",
      evidenceDir: "/tmp/run",
    });
    expect(lines[0]).toBe("escalation: SESSION_EXPIRED at the entry");
  });
});
