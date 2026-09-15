/**
 * Policy: the document, the precedence chain, and the verdict matrix (§11 P3 exit criteria).
 *
 * The classifier is pure — a document in, a verdict out — so the whole security surface is a table
 * here rather than a browser test. What needs a browser (the sink rule, the approval seam reaching
 * a live page) is in `tests/integration/policy-sinks.test.ts`.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY_PATH,
  DEFAULT_ORIGINS,
  Policy,
  PolicyInvalidError,
  resolvePolicyDocument,
  type PolicyDocument,
} from "../../src/policy/policy.ts";
import { canonicalOrigin, checkOperation, classify, OPERATIONS, READ_FAMILY } from "../../src/policy/risk.ts";
import type { ActionContext, SurfaceAction } from "../../src/surface/session-driver.ts";

/** A context for one action, with the target an action's resolver would have described. */
function context(action: SurfaceAction, targetName: string | null = null): ActionContext {
  return { action, targetName, targetRole: targetName === null ? null : "button" };
}

const click = (name: string | null): ActionContext =>
  context({ kind: "click", target: { candidates: [{ strategy: "css", selector: "a", index: 0 }] } }, name);

const typeInto = (name: string | null, value = "x"): ActionContext =>
  context({ kind: "type", target: { candidates: [{ strategy: "css", selector: "input", index: 0 }] }, value }, name);

async function tempPolicy(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-policy-"));
  const path = join(dir, "policy.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return path;
}

/** The shipped policy, with no environment in the way. */
const shipped = async (): Promise<Policy> => Policy.load({ env: {} });

describe("loading the shipped policy", () => {
  it("parses the checked-in file with no environment overrides", async () => {
    const policy = await shipped();
    expect(policy.document.allowlist.origins).toEqual([...DEFAULT_ORIGINS]);
    expect(policy.document.allowlist.actions).toEqual([...OPERATIONS]);
    expect(policy.document.timing.waitForMs).toBe(10_000);
    expect(policy.document.timing.backoffMs).toEqual([1_000, 3_000]);
    expect(policy.document.agent.maxToolCalls).toBe(25);
    expect(policy.document.recoverableDialogs).toHaveLength(1);
  });

  it("keeps the shipped allowlist origin in step with the fixture's default port", async () => {
    // §6: the default origin shares the sample app's PORT constant, so the two cannot disagree.
    const { DEFAULT_PORT } = await import("../../sample-app/server.ts");
    expect(DEFAULT_ORIGINS).toEqual([`http://localhost:${DEFAULT_PORT}`]);
    expect(DEFAULT_POLICY_PATH.endsWith("policy/policy.json")).toBe(true);
  });

  it("fails closed when the file is missing, naming the path and the shipped default", async () => {
    const error = await Policy.load({ file: "/nonexistent/policy.json", env: {} }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PolicyInvalidError);
    expect((error as PolicyInvalidError).message).toContain("/nonexistent/policy.json");
    expect((error as PolicyInvalidError).message).toContain("policy/policy.json");
  });

  it("fails closed on malformed JSON", async () => {
    const file = await tempPolicy("{ this is not json");
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("not valid JSON");
  });

  it("rejects an unknown key instead of ignoring a guardrail the operator believes exists", async () => {
    const file = await tempPolicy({ allowlist: { denyRoutes: ["/admin/"], denyRoute: ["/ops/"] } });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("denyRoute");
  });

  it("rejects a route pattern that does not compile", async () => {
    const file = await tempPolicy({ allowlist: { denyRoutes: ["^/admin["] } });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("allowlist.denyRoutes.0");
  });

  it("rejects the retry/backoff mismatch that would silently retry with no delay", async () => {
    const file = await tempPolicy({ timing: { retries: 3, backoffMs: [1_000] } });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PolicyInvalidError);
    expect((error as PolicyInvalidError).issues[0]?.path).toBe("timing.backoffMs");
  });

  it("rejects a risk rule that names nothing — it would gate the whole run", async () => {
    const file = await tempPolicy({ risk: { approvalRequired: [{ matches: {}, note: "oops" }] } });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("must name something to match");
  });

  it("rejects a redact pattern that would match nothing (the fail-open direction)", async () => {
    const file = await tempPolicy({ redact: { fieldPatterns: ["___"] } });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("redact.fieldPatterns.0");
  });
});

/**
 * The curated failure vocabulary (§4.1, §10 G1/G2) — the section no run can produce.
 *
 * These are loader rules rather than review rules, and the division is deliberate: a signature that
 * cannot fire, or one anchored to a message the app does not render, is a mistake in the *policy
 * file*, and §6's posture is that a mistake there stops the process at boot rather than becoming a
 * capability that looks fine and returns a code it can never return.
 */
describe("outcome seeds", () => {
  /** The shipped file's own seeds, so the three §10 G1/G2 anchors are checked where they live. */
  it("ships one signature per pinned fixture message, each matching its own sample", async () => {
    const { document } = await shipped();
    expect(document.outcomes.map((seed) => seed.code)).toEqual([
      "NO_SUCH_ENTITY",
      "RECORD_LOCKED",
      "PERMISSION_DENIED",
    ]);
    for (const seed of document.outcomes) {
      expect(new RegExp(seed.pattern).test(seed.sample)).toBe(true);
    }
    // The §10 G1/G2 pin, as data: the fixture's `stateMessage()` renders exactly these. A change to
    // either side that the other did not follow is the fiction this section exists to prevent.
    expect(document.outcomes.map((seed) => seed.sample)).toEqual([
      "No member 99999 on file",
      "Member 12345 is locked",
      "Access to member 12345 is restricted",
    ]);
  });

  it("rejects a signature that cannot fire on the message it claims to detect", async () => {
    const file = await tempPolicy({
      outcomes: [
        { code: "RECORD_LOCKED", message: "locked", sample: "Member 12345 is locked", pattern: "Member \\d{6} is locked" },
      ],
    });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PolicyInvalidError);
    expect((error as PolicyInvalidError).issues[0]?.path).toBe("outcomes.0.pattern");
    expect((error as PolicyInvalidError).message).toContain("does not match `sample`");
  });

  it("rejects a vacuous signature, at the seed's own path rather than the artifact's", async () => {
    const file = await tempPolicy({
      outcomes: [{ code: "UNEXPECTED_STATE", message: "m", sample: "anything", pattern: "locked|" }],
    });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).issues[0]?.path).toBe("outcomes.0.pattern");
    expect((error as PolicyInvalidError).message).toContain("matches the empty string");
  });

  it("reports a malformed pattern as a regex error rather than throwing out of the loader", async () => {
    // The redundant-looking `compilesAsRegex` guard: zod runs the sample-match refinement too, so a
    // pattern that does not compile would be compiled there and raise a SyntaxError instead.
    const file = await tempPolicy({
      outcomes: [{ code: "X", message: "m", sample: "s", pattern: "Member [" }],
    });
    const error = await Policy.load({ file, env: {} }).catch((thrown: unknown) => thrown);
    expect((error as PolicyInvalidError).message).toContain("valid regular expression");
  });
});

describe("precedence: code default < policy.json < env < explicit override", () => {
  it("fills a section the file omits from the code defaults", async () => {
    const file = await tempPolicy({ timing: { waitForMs: 5_000 } });
    const document = await resolvePolicyDocument({ file, env: {} });
    expect(document.timing.waitForMs).toBe(5_000);
    expect(document.timing.retries).toBe(2); // code default
    expect(document.agent.maxToolCalls).toBe(25); // code default
  });

  it("replaces arrays wholesale rather than appending to the default", async () => {
    const file = await tempPolicy({ allowlist: { origins: ["http://localhost:8080"] } });
    const document = await resolvePolicyDocument({ file, env: {} });
    // The whole point: a policy that names one origin means exactly that origin.
    expect(document.allowlist.origins).toEqual(["http://localhost:8080"]);
  });

  it("lets an env knob override the file, and the override layer beat the env", async () => {
    const file = await tempPolicy({ timing: { waitForMs: 5_000 }, agent: { maxToolCalls: 9 } });
    const fromEnv = await resolvePolicyDocument({ file, env: { POLICY_TIMING_WAITFORMS: "1234" } });
    expect(fromEnv.timing.waitForMs).toBe(1_234);
    expect(fromEnv.agent.maxToolCalls).toBe(9);

    const overridden = await resolvePolicyDocument({
      file,
      env: { POLICY_TIMING_WAITFORMS: "1234" },
      overrides: { timing: { waitForMs: 77 } },
    });
    expect(overridden.timing.waitForMs).toBe(77);
  });

  it("reports a non-numeric env override as an invalid policy, naming the variable", async () => {
    const error = await resolvePolicyDocument({ file: null, env: { POLICY_TIMING_RETRIES: "lots" } }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as PolicyInvalidError).message).toContain("env:POLICY_TIMING_RETRIES");
  });

  it("builds a usable policy from no file at all (the defaults alone)", async () => {
    const policy = new Policy(await resolvePolicyDocument({ file: null, env: {} }));
    expect((await policy.review(click("Search"))).allowed).toBe(true);
  });
});

describe("origin canonicalization", () => {
  it("treats localhost and 127.0.0.1, and a written-out default port, as one origin", () => {
    expect(canonicalOrigin("http://LOCALHOST:80/member/1")).toBe("http://127.0.0.1");
    expect(canonicalOrigin("http://127.0.0.1/member/1")).toBe("http://127.0.0.1");
    expect(canonicalOrigin("https://example.com:443/x")).toBe("https://example.com");
  });

  it("keeps a non-default port, because it is a different origin", () => {
    expect(canonicalOrigin("http://localhost:4173/")).toBe("http://127.0.0.1:4173");
  });

  it("refuses anything that is not an absolute http(s) URL", () => {
    expect(canonicalOrigin("file:///etc/passwd")).toBeNull();
    expect(canonicalOrigin("not a url")).toBeNull();
    expect(canonicalOrigin("/member/1")).toBeNull();
  });
});

describe("the verdict matrix", () => {
  it("admits a navigation to an allowlisted origin, in either spelling of the host", async () => {
    const policy = await shipped();
    const verdict = await policy.review(context({ kind: "navigate", url: "http://127.0.0.1:4173/search?memberId=1" }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.rule).toBe("allowlist.origin");
  });

  it("blocks another origin, and names the port when the port is the problem", async () => {
    const policy = await shipped();
    const foreign = await policy.review(context({ kind: "navigate", url: "https://example.com/" }));
    expect(foreign.allowed).toBe(false);
    expect(foreign.rule).toBe("allowlist.origin");

    const wrongPort = await policy.review(context({ kind: "navigate", url: "http://localhost:8080/" }));
    expect(wrongPort.reason).toContain("does not include port 8080");
    expect(wrongPort.reason).toContain("policy.json");
  });

  it("blocks a denied route on an allowlisted origin", async () => {
    const policy = await shipped();
    const verdict = await policy.review(context({ kind: "navigate", url: "http://localhost:4173/admin/ops" }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("allowlist.route-denied");
  });

  it("permits an ordinary click", async () => {
    const policy = await shipped();
    const verdict = await policy.review(click("Search"));
    // The rule named is the one that admitted it — the action allowlist — and the reason records
    // that the approval rules were consulted and none fired.
    expect(verdict).toMatchObject({ allowed: true, approvalRequired: false, rule: "allowlist.action" });
    expect(verdict.reason).toContain("matches no approval rule");
  });

  it("gates the click the brief's risk example names", async () => {
    const policy = await shipped();
    const verdict = await policy.review(click("Close account"));
    // §6's default is "block, then escalate" — not a hard failure, which is why `allowed` is false
    // and `approvalRequired` is true rather than the other way round.
    expect(verdict).toMatchObject({ allowed: false, approvalRequired: true, rule: "risk.approval-required" });
    expect(verdict.reason).toContain("Close account");
  });

  it("gates typing into a sensitive field and leaves ordinary fields alone", async () => {
    const policy = await shipped();
    expect(await policy.review(typeInto("Taxpayer SSN"))).toMatchObject({
      allowed: false,
      approvalRequired: true,
      rule: "risk.approval-required",
    });
    expect(await policy.review(typeInto("Member ID"))).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it("over-matches a decorated legacy label rather than under-matching it", async () => {
    // The safe direction: an over-match escalates (a human says yes), an under-match executes.
    const policy = await shipped();
    expect((await policy.review(click("Close account — irreversible"))).approvalRequired).toBe(true);
  });

  it("never lets a field rule gate a click that happens to sit near the field", async () => {
    const document = await resolvePolicyDocument({
      file: null,
      env: {},
      overrides: { risk: { approvalRequired: [{ matches: { fieldName: "/ssn/i" } }] } },
    });
    const verdict = classify(document, click("Taxpayer SSN"));
    expect(verdict.approvalRequired).toBe(false);
  });

  it("does not gate an unnamed target on a text rule", async () => {
    const policy = await shipped();
    expect((await policy.review(click(null))).allowed).toBe(true);
  });

  it("treats the read family as always safe, allowlist or not", async () => {
    // A policy that lists no actions at all still permits observation: reads cannot change the
    // world, and a policy that could forbid them would only make the run blind, not safe.
    const document = await resolvePolicyDocument({
      file: null,
      env: {},
      overrides: { allowlist: { actions: [] } },
    });
    for (const operation of READ_FAMILY) {
      expect(checkOperation(document, operation)).toMatchObject({ allowed: true, rule: "read-only.always-safe" });
    }
    expect(checkOperation(document, "click")).toMatchObject({ allowed: false, rule: "allowlist.action" });
  });

  it("denies by default an operation the allowlist does not name", async () => {
    const document = await resolvePolicyDocument({
      file: null,
      env: {},
      overrides: { allowlist: { actions: ["navigate", "click"] } },
    });
    const verdict = checkOperation(document, "press");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("press");
  });
});

describe("the policy a run reports", () => {
  it("carries the rule that produced each verdict, for the §27 stamp and the run log", async () => {
    const policy = await shipped();
    const rules = new Set<string>();
    for (const verdict of [
      await policy.review(click("Search")),
      await policy.review(click("Close account")),
      await policy.review(context({ kind: "navigate", url: "https://example.com/" })),
    ]) {
      rules.add(verdict.rule);
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
    expect([...rules].sort()).toEqual(["allowlist.action", "allowlist.origin", "risk.approval-required"]);
  });

  it("rejects a document that has been mutated into an invalid shape", () => {
    const document = { allowlist: { origins: "http://localhost:4173" } } as unknown as PolicyDocument;
    expect(() => new Policy(document)).toThrow(PolicyInvalidError);
  });
});
