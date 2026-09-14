/**
 * The artifact schema and its cross-field rules (§11 P2's exit criteria).
 *
 * One shape covers nearly every case: take the valid fixture, break exactly one thing, and assert
 * that validation refuses it *at a named path* with a message that says what to do about it. The
 * path matters as much as the rejection — an author who is told "invalid artifact" has learned
 * nothing, and a validator that is right for the wrong reason is one refactor from being wrong.
 *
 * The positive cases are here for the same reason: a rule that rejects everything is not a rule.
 */
import { describe, expect, it } from "vitest";
import { formatIssues, parseCapability, validateCapability } from "../../src/schema/validate.ts";
import type { ValidationIssue } from "../../src/schema/validate.ts";
import { validArtifact, type ArtifactJson } from "../helpers/artifact.ts";

/**
 * Break one thing, and assert the rejection lands where it should with a message that reads.
 * Returns the whole issue list so a test can also assert that one mistake produced *only* the
 * problem it was meant to.
 */
function expectRejected(
  mutate: (artifact: ArtifactJson) => void,
  path: string,
  message: RegExp,
): readonly ValidationIssue[] {
  const artifact = validArtifact();
  mutate(artifact);

  const result = validateCapability(artifact);
  if (result.ok) throw new Error(`expected validation to reject this artifact, but it passed`);

  const issue = result.issues.find((candidate) => candidate.path === path);
  if (issue === undefined) {
    throw new Error(`expected a problem at "${path}", got:\n${formatIssues(result.issues)}`);
  }
  expect(issue.message).toMatch(message);
  return result.issues;
}

describe("the worked example", () => {
  it("validates, and comes back out exactly as it went in", () => {
    const artifact = validArtifact();
    const result = validateCapability(artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every object in the schema is strict, so nothing is stripped and nothing is defaulted: what
    // the parser returns is what the recorder wrote. That identity is what makes the artifact on
    // disk the artifact a calling agent was promised (§4.1).
    expect(result.capability).toEqual(artifact);
  });

  it("survives the JSON round-trip it actually travels by", () => {
    const artifact = validArtifact();
    const result = validateCapability(artifact);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const onDisk = JSON.parse(JSON.stringify(result.capability)) as unknown;
    expect(validateCapability(onDisk).ok).toBe(true);
  });

  it("accepts an artifact that models no business outcomes", () => {
    // Not every capability has a modelled failure. With `outcomes` empty, success is the only
    // ending, which is a real thing for a screen that has one.
    const artifact = validArtifact();
    artifact.outcomes = [];
    expect(validateCapability(artifact).ok).toBe(true);
  });

  it("rejects an artifact with no steps at all", () => {
    expectRejected((artifact) => (artifact.steps = []), "steps", /at least 1|>=1/);
  });
});

describe("shape", () => {
  it("rejects a param whose pattern is not a regex", () => {
    // The pattern is what the CLI validates a caller's input against, so an uncompilable one
    // would only surface as a usage error on the wrong input.
    expectRejected((artifact) => (artifact.inputs[0].pattern = "["), "inputs.0.pattern", /valid regular expression/);
  });

  it("rejects an unknown step kind", () => {
    expectRejected(
      (artifact) => (artifact.steps[1].kind = "teleport"),
      "steps.1.kind",
      /Expected 'navigate' \| 'wait' \| 'act' \| 'extract' \| 'assert'/,
    );
  });

  it("rejects a step kind that is a real kind in the wrong place", () => {
    // A well-spelled discriminator on a shape that does not match its own member is the more
    // interesting failure: the author believes they wrote a `wait`.
    expectRejected(
      (artifact) => (artifact.steps[1] = { id: 2, kind: "wait", url: "/x" }),
      "steps.1",
      /Unrecognized key/,
    );
  });

  it("rejects an act step with no expect (§4.1)", () => {
    // The requirement is load-bearing three times over: it anchors §8's three-way handback, it
    // localizes a failure to the step that broke, and it is what makes "an act with no observable
    // delta" unrepresentable rather than merely discouraged.
    expectRejected(
      (artifact) => delete artifact.steps[1].expect,
      "steps.1.expect",
      /must carry exactly one of: urlContains, urlMatches, elementExists, elementAbsent, textEquals/,
    );
  });

  it("rejects an artifact carrying a field the schema does not declare", () => {
    // §7's F8 scar: a plan section once claimed a field the schema did not have. Strictness makes
    // that drift unshippable — an unknown key is refused rather than silently dropped.
    expectRejected((artifact) => (artifact.perVariantOverrides = {}), "(root)", /Unrecognized key/);
  });

  it("rejects a capability id that is not kebab-case", () => {
    // The id is a directory name in `capabilities/` (§16), so the naming convention is also what
    // keeps `load("../../etc")` from being a path.
    expectRejected((artifact) => (artifact.id = "../../etc/passwd"), "id", /kebab-case/);
  });

  it("rejects an entry that is not an absolute http(s) URL", () => {
    expectRejected((artifact) => (artifact.surface.entry = "localhost:4173"), "surface.entry", /http\(s\) URL/);
  });

  it("rejects an artifact with no provenance", () => {
    // Required, not optional: provenance is what makes a recording reviewable, and an artifact
    // that cannot say when and by what it was recorded cannot be reviewed.
    expectRejected((artifact) => delete artifact.provenance, "provenance", /expected object/);
  });

  it("rejects an output with no redact flag", () => {
    // §27 makes redaction a recorded fact. Defaulting it would mean a hand-edited artifact
    // silently opted *out* of redaction — the one direction a safety field must not fail in.
    expectRejected((artifact) => delete artifact.outputs[0].redact, "outputs.0.redact", /expected boolean/);
  });
});

describe("placeholders (§9)", () => {
  it("rejects a placeholder naming no declared input", () => {
    expectRejected(
      (artifact) => (artifact.steps[1].value = "{memberNumber}"),
      "steps.1.value",
      /placeholder \{memberNumber\} names no declared input; declared inputs: memberId/,
    );
  });

  it("rejects an unresolved placeholder in an outcome message", () => {
    // The caller-facing sentence is scanned too: "No member {memberId} on file" has to be able to
    // name the input, or the message is a template that never fills.
    expectRejected(
      (artifact) => (artifact.outcomes[0].message = "No member {nope} on file"),
      "outcomes.0.message",
      /placeholder \{nope\}/,
    );
  });

  it("rejects an unresolved placeholder in an endpoint URL", () => {
    expectRejected(
      (artifact) => (artifact.steps[0].url = "http://localhost:4173/member/{nope}"),
      "steps.0.url",
      /placeholder \{nope\}/,
    );
  });

  it("does not mistake a route variable for a placeholder (§28)", () => {
    // The two syntaxes are deliberately different, and this is the test that keeps them apart:
    // `:id` matches any segment at replay, so it is not a name that has to be declared.
    const artifact = validArtifact();
    artifact.success = { urlMatches: "/member/:id/summary" };
    artifact.steps[2].expect = { urlMatches: "/member/:id/summary" };
    expect(validateCapability(artifact).ok).toBe(true);
  });

  it("accepts a route that does interpolate a declared input (§28)", () => {
    const artifact = validArtifact();
    artifact.success = { urlMatches: "/member/{memberId}/summary" };
    expect(validateCapability(artifact).ok).toBe(true);
  });
});

describe("outcome signatures (§4.1, §5.2)", () => {
  it("rejects a signature that is not a regex", () => {
    expectRejected(
      (artifact) => (artifact.outcomes[0].detect.pattern = "No member ("),
      "outcomes.0.detect.pattern",
      /valid regular expression/,
    );
  });

  it("rejects a vacuous signature", () => {
    // `.*` fires on every page there is, so it would terminate every run as this outcome. A
    // signature has to be anchored to the app's real message to mean anything.
    expectRejected(
      (artifact) => (artifact.outcomes[0].detect.pattern = ".*"),
      "outcomes.0.detect.pattern",
      /matches the empty string/,
    );
  });

  it("rejects a signature that matches the empty string only in one branch", () => {
    // The subtler form of the same mistake: `NO_SUCH_ENTITY|` fires on every page as well, and an
    // author who wrote it would not see it as "matches everything".
    expectRejected(
      (artifact) => (artifact.outcomes[0].detect.pattern = "No member \\d{5} on file|"),
      "outcomes.0.detect.pattern",
      /matches the empty string/,
    );
  });

  it("rejects a duplicate outcome code, naming where the first one is", () => {
    expectRejected(
      (artifact) => (artifact.outcomes[1].code = "NO_SUCH_ENTITY"),
      "outcomes.1.code",
      /already declared at outcomes.0/,
    );
  });

  it("rejects a code that is not SCREAMING_SNAKE_CASE", () => {
    expectRejected((artifact) => (artifact.outcomes[0].code = "no_such_entity"), "outcomes.0.code", /SCREAMING/);
  });

  it("keeps the shipped signatures, which do interpolate the value as text", () => {
    // §4.2's real pattern is a regex over *rendered* text — the page says "No member 99999 on
    // file", so `\d{5}` matches the id and `{memberId}` would not. The signature is deliberately
    // not placeholder-scanned, and this pins that.
    const artifact = validArtifact();
    expect(validateCapability(artifact).ok).toBe(true);
    expect(artifact.outcomes[0].detect.pattern).toContain(String.raw`\d{5}`);
  });
});

describe("names that must be free or unique", () => {
  const RESERVED = ["version", "entry", "policy", "json", "goal", "headed", "param", "allow-drift"];

  it.each(RESERVED)("rejects an input named %s, which the CLI already uses", (name) => {
    // §4.1's reserved set. The CLI's grammar is `--<input-name> <value>`, so an input named
    // `version` would make `replay --version 2` mean two different things.
    expectRejected((artifact) => (artifact.inputs[0].name = name), "inputs.0.name", /reserved CLI flag/);
  });

  it("accepts a name that merely starts like a reserved one", () => {
    // The collision is exact, not a prefix match: `--versionId` is not `--version`.
    const artifact = validArtifact();
    artifact.inputs[0].name = "versionId";
    artifact.steps[1].value = "{versionId}";
    artifact.outcomes[0].message = "No member {versionId} on file";
    artifact.outcomes[1].message = "Member {versionId} is locked";
    expect(validateCapability(artifact).ok).toBe(true);
  });

  it("rejects a duplicate input name", () => {
    expectRejected(
      (artifact) => artifact.inputs.push({ name: "memberId", type: "string", description: "again" }),
      "inputs.1.name",
      /duplicate name/,
    );
  });

  it("rejects a duplicate output name", () => {
    expectRejected(
      (artifact) => artifact.outputs.push(structuredClone(artifact.outputs[0])),
      "outputs.1.name",
      /duplicate name/,
    );
  });

  it("rejects a duplicate step id", () => {
    // Step ids are the schema's only cross-references: both `risk.irreversibleSteps` and
    // `Output.source.stepId` name a step this way, so a duplicate makes both unresolvable.
    expectRejected((artifact) => (artifact.steps[2].id = 2), "steps.2.id", /duplicate id "2"/);
  });
});

describe("route patterns (§28)", () => {
  it("rejects a urlMatches with no variable segment, and names urlContains instead", () => {
    // A literal pattern reads as a checkpoint while checking no more than a substring would —
    // the one rule in the plan whose whole point is that the alternative is already available.
    const issues = expectRejected(
      (artifact) => (artifact.success = { urlMatches: "/member/12345/summary" }),
      "success.urlMatches",
      /must contain a variable segment/,
    );
    expect(issues.find((i) => i.path === "success.urlMatches")?.message).toMatch(/write urlContains instead/);
  });

  it("rejects it in a step's expect too, not only at the top level", () => {
    expectRejected(
      (artifact) => (artifact.steps[2].expect = { urlMatches: "/member/12345/summary" }),
      "steps.2.expect.urlMatches",
      /must contain a variable segment/,
    );
  });

  it("accepts urlContains for a literal path, which is the point", () => {
    const artifact = validArtifact();
    artifact.success = { urlContains: "/member/12345/summary" };
    expect(validateCapability(artifact).ok).toBe(true);
  });

  it("counts a :name segment only at a boundary", () => {
    // `:id` matches a segment; a colon mid-segment is just a colon, so `/member/a:b` constrains
    // nothing and is refused for the same reason a literal is.
    expectRejected(
      (artifact) => (artifact.success = { urlMatches: "/member/a:id/summary" }),
      "success.urlMatches",
      /must contain a variable segment/,
    );
  });
});

describe("risk (§27)", () => {
  it("rejects an irreversible step that names no declared step", () => {
    expectRejected(
      (artifact) => (artifact.risk.irreversibleSteps = [99]),
      "risk.irreversibleSteps.0",
      /names step 99, which the artifact does not declare/,
    );
  });

  it("rejects an irreversible step that is not an act", () => {
    // Only an act changes the world; a navigate or an extract cannot be irreversible, so listing
    // one means the artifact's author was describing something else.
    expectRejected(
      (artifact) => (artifact.risk.irreversibleSteps = [4]),
      "risk.irreversibleSteps.0",
      /whose kind is "extract" — only an act can be irreversible/,
    );
  });

  it('rejects "approval-gated" with an empty list', () => {
    expectRejected(
      (artifact) => (artifact.risk.class = "approval-gated"),
      "risk.irreversibleSteps",
      /class is "approval-gated" but the list is empty/,
    );
  });

  it('rejects "safe" with a non-empty list', () => {
    // The other direction, and the one that matters more: a capability that names an irreversible
    // step cannot be advertised to a caller as safe.
    expectRejected(
      (artifact) => (artifact.risk.irreversibleSteps = [3]),
      "risk.class",
      /class is "safe" but irreversibleSteps names 1 step/,
    );
  });

  it("accepts both halves agreeing", () => {
    // Without this the rule above could be satisfied by rejecting everything.
    const artifact = validArtifact();
    artifact.risk = { class: "approval-gated", irreversibleSteps: [3] };
    const result = validateCapability(artifact);
    expect(result.ok).toBe(true);
  });
});

describe("outputs (§4.1)", () => {
  it("rejects a source that names no declared step", () => {
    expectRejected(
      (artifact) => (artifact.outputs[0].source.stepId = 99),
      "outputs.0.source.stepId",
      /names step 99, which the artifact does not declare/,
    );
  });

  it("rejects a source that names a step that is not an extract", () => {
    expectRejected(
      (artifact) => (artifact.outputs[0].source.stepId = 3),
      "outputs.0.source.stepId",
      /whose kind is "act" — only an extract step produces an output/,
    );
  });

  it("rejects a source that names an extract step of a different name", () => {
    // The pointer is by id, so a mismatch here means the output is being filled from a value the
    // artifact does not claim to produce — a silent wrong answer rather than a failure.
    expectRejected(
      (artifact) => (artifact.steps[3].name = "renamed"),
      "outputs.0.source.stepId",
      /named "renamed" but supplies output "balance"/,
    );
  });
});

describe("state assertions", () => {
  it("rejects an assertion carrying two shapes", () => {
    expectRejected(
      (artifact) =>
        (artifact.steps[1].expect = {
          urlContains: "/x",
          textEquals: { value: "y", target: { candidates: [{ strategy: "text", text: "z" }] } },
        }),
      "steps.1.expect",
      /must carry exactly one of/,
    );
  });

  it("rejects an assertion carrying none", () => {
    expectRejected((artifact) => (artifact.steps[1].expect = {}), "steps.1.expect", /must carry exactly one of/);
  });

  it("validates an assertion's target as a target descriptor", () => {
    // The assertion shapes carry `TargetDescriptor`s, so they inherit the resolver's rules: a
    // chain with no candidates is a step that can only fail.
    expectRejected(
      (artifact) => (artifact.steps[1].expect = { elementExists: { candidates: [] } }),
      "steps.1.expect.elementExists.candidates",
      /at least 1|>=1/,
    );
  });

  it("requires a css candidate's index rather than defaulting it", () => {
    // A silent 0 would turn a recorded intent into "the first one", which is precisely the
    // ambiguity the resolver's uniqueness rules exist to refuse.
    const issues = expectRejected(
      (artifact) =>
        (artifact.steps[1].expect = { elementExists: { candidates: [{ strategy: "css", selector: "input" }] } }),
      "steps.1.expect.elementExists.candidates.0.index",
      /expected number/,
    );
    // And only that: the other four assertion shapes were never written, so complaining that they
    // are absent would be five lines about a one-line mistake.
    expect(issues).toHaveLength(1);
  });

  it("rejects a role candidate with no accessible name", () => {
    // A role candidate exists to be named; an unnamed one resolves to nothing, so an artifact
    // can never claim a strategy the recorder refuses to emit.
    expectRejected(
      (artifact) =>
        (artifact.steps[1].expect = {
          elementExists: { candidates: [{ strategy: "role", role: "textbox", name: "" }] },
        }),
      "steps.1.expect.elementExists.candidates.0.name",
      /too small|>=1/i,
    );
  });

  it("rejects a role the resolver does not know", () => {
    expectRejected(
      (artifact) =>
        (artifact.steps[1].expect = {
          elementExists: { candidates: [{ strategy: "role", role: "teleporter", name: "Go" }] },
        }),
      "steps.1.expect.elementExists.candidates.0.role",
      /Invalid option|invalid/i,
    );
  });
});

describe("waits (§4.1)", () => {
  it('requires a "fixed" wait to say how long', () => {
    expectRejected(
      (artifact) => (artifact.steps[1] = { id: 2, kind: "wait", condition: "fixed" }),
      "steps.1.ms",
      /must say how long/,
    );
  });

  it('accepts a "fixed" wait with a duration, and a "load" wait with none', () => {
    const artifact = validArtifact();
    artifact.steps[1] = { id: 2, kind: "wait", condition: "fixed", ms: 500 };
    artifact.steps.push({ id: 5, kind: "wait", condition: "load" });
    expect(validateCapability(artifact).ok).toBe(true);
  });
});

describe("the throwing form", () => {
  it("carries the issues, and names the file when it was given one", () => {
    const artifact = validArtifact();
    artifact.inputs[0].pattern = "[";

    expect(() => parseCapability(artifact, "capabilities/x/v1.0.0/artifact.json")).toThrowError(
      /capabilities\/x\/v1\.0\.0\/artifact\.json is invalid/,
    );
    try {
      parseCapability(artifact);
      throw new Error("expected parseCapability to throw");
    } catch (error: unknown) {
      expect(error).toMatchObject({ name: "CapabilityInvalidError" });
      expect((error as { issues: readonly ValidationIssue[] }).issues[0]?.path).toBe("inputs.0.pattern");
    }
  });
});

describe("formatIssues", () => {
  it("renders one located line per problem", () => {
    const artifact = validArtifact();
    artifact.inputs[0].pattern = "[";
    artifact.id = "Not Kebab";
    const result = validateCapability(artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const rendered = formatIssues(result.issues);
    expect(rendered).toContain("2 problems:");
    expect(rendered).toContain("· inputs.0.pattern — must be a valid regular expression");
    expect(rendered).toContain("· id — must be kebab-case");
  });

  it("says problem, singular, for one", () => {
    expect(formatIssues([{ path: "id", message: "nope" }])).toBe("1 problem:\n  · id — nope");
  });
});
