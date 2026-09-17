/**
 * Preflight (§5.4) — the checks, and the boundary they exist to hold.
 *
 * The boundary is the thing worth testing: §5.4 makes a setup problem a **usage error**, never a
 * business outcome. So the assertions are mostly about *which* problems are found and *when*, and
 * about the fix text — §5.4 asks each failure to carry the exact fix, and a fix that says "check your
 * configuration" is the failure mode. The port message is asserted verbatim because it is the one a
 * real operator hits first: start the sample app on a non-default `PORT` and the run would otherwise
 * die at its first navigation with `NAVIGATION_BLOCKED` and no mention of the policy file.
 *
 * The machine-dependent checks (Node version, browser, policy file, key) are all injectable, which is
 * why the failure arms are reachable here at all — a unit test cannot uninstall Node. The one test
 * that is deliberately *not* injected asserts the probe's answer matches the machine, which is the
 * only way to check that the default is a probe and not a constant.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  API_KEY_VAR,
  MIN_NODE,
  describePreflightFailure,
  nodeVersionProblem,
  preflight,
  reRecordProblem,
  type PreflightInput,
  type PreflightIssue,
} from "../../src/cli/preflight.ts";
import { DEFAULT_ORIGINS } from "../../src/policy/policy.ts";

/** A preflight that passes every check: a good Node, a browser, the shipped policy, a key. */
function healthy(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    command: "discover",
    entry: null,
    env: { [API_KEY_VAR]: "sk-test" },
    nodeVersion: "v24.4.0",
    browserPath: "/usr/bin/chromium",
    ...overrides,
  };
}

/** The problems a failed preflight reported, for a substring assertion that reads well. */
function problems(issues: readonly PreflightIssue[]): string {
  return issues.map((issue) => issue.problem).join("\n");
}

function fixes(issues: readonly PreflightIssue[]): string {
  return issues.map((issue) => issue.fix).join("\n");
}

async function tempPolicy(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-preflight-"));
  const path = join(dir, "policy.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return path;
}

describe("the Node floor", () => {
  it("agrees with package.json and .nvmrc", async () => {
    // The check is duplicated in the module rather than parsed from package.json — it has to work when
    // the install is broken, which is exactly when a broken install would make a parse impossible.
    // That duplication is only safe if something fails when the two drift, and this is that something.
    const { readFile } = await import("node:fs/promises");
    const pkg: unknown = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    const engines = (pkg as { engines?: { node?: string } }).engines?.node;
    expect(engines).toBe(`>=${MIN_NODE.major}.${MIN_NODE.minor}`);

    const nvmrc = (await readFile(join(process.cwd(), ".nvmrc"), "utf8")).trim();
    // `.nvmrc` may name a full version (`24.4.0`) or a line (`24`); both have to satisfy the floor,
    // and the file's job is to be the thing `nvm use` installs.
    expect(Number(nvmrc.split(".")[0])).toBeGreaterThanOrEqual(MIN_NODE.major);
  });

  it("accepts the floor, the running runtime, and anything above", () => {
    expect(nodeVersionProblem("v22.18.0")).toBeNull();
    expect(nodeVersionProblem("22.18.0")).toBeNull();
    expect(nodeVersionProblem("23.0.0")).toBeNull();
    expect(nodeVersionProblem(process.versions.node)).toBeNull();
  });

  it("refuses a Node below the floor, naming it", () => {
    const problem = nodeVersionProblem("v22.17.9");
    expect(problem?.problem).toContain("22.17.9");
    expect(problem?.problem).toContain("22.18");
    // The *why*, because the floor is not arbitrary — it is the version whose type stripping lets
    // these `.ts` entrypoints run under plain `node` with no build step.
    expect(problem?.problem).toContain("TypeScript");
    expect(problem?.fix).toContain(".nvmrc");
  });

  it("refuses an old major the same way", () => {
    expect(nodeVersionProblem("v20.11.1")?.problem).toContain("older than");
  });

  it("reports a version string it cannot read instead of guessing", () => {
    // `Number(undefined)`-style coercion is how this check would silently pass everything.
    const problem = nodeVersionProblem("not-a-version");
    expect(problem?.problem).toContain("could not read");
    expect(problem?.problem).toContain("not-a-version");
  });
});

describe("the browser check", () => {
  it("reports the missing binary with the install command", async () => {
    const result = await preflight(healthy({ browserPath: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain("Chromium binary is not installed");
    expect(fixes(result.issues)).toContain("npx playwright install chromium");
    // Linux needs the system libraries too, and a fresh container is where this bites.
    expect(fixes(result.issues)).toContain("--with-deps");
  });

  it("says nothing when a path was given", async () => {
    const result = await preflight(healthy());
    expect(result.ok).toBe(true);
  });

  it("probes the machine when no path was injected", async () => {
    // `undefined` and `null` mean different things here — probe, versus there is no browser — and the
    // module's `not ??` comment rests on that. This is the test that would fail if the two collapsed:
    // the answer must track what is actually installed, whichever way the machine happens to be.
    const installed = existsSync(safeExecutablePath());
    const result = await preflight(healthy({ browserPath: undefined }));
    const complained = !result.ok && problems(result.issues).includes("Chromium binary");
    expect(complained).toBe(!installed);
  });
});

function safeExecutablePath(): string {
  try {
    return chromium.executablePath();
  } catch {
    return join(tmpdir(), "no-such-browser");
  }
}

describe("the policy check", () => {
  it("names the offending field when the file does not parse", async () => {
    const file = await tempPolicy({ allowlist: { origins: [""] } });
    const result = await preflight(healthy({ policyFile: file }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain(file);
    // The loader already names the field; preflight passes it through rather than paraphrasing,
    // because the field path is the actionable half.
    expect(problems(result.issues)).toContain("allowlist.origins");
    expect(fixes(result.issues)).toContain("POLICY_PATH");
  });

  it("reports a path that cannot be read at all, with the way back to the shipped policy", async () => {
    // The loader turns its own IO failure into a field-named policy error, so this arrives through the
    // same branch as a malformed file — which is right: an operator who named a path that is not there
    // wants the path named and the working alternative, not a distinction between the two failures.
    const result = await preflight(healthy({ policyFile: join(tmpdir(), "atlas-no-such-policy.json") }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain("atlas-no-such-policy.json");
    expect(problems(result.issues)).toContain("no policy file at this path");
    expect(problems(result.issues)).toContain("policy/policy.json");
  });

  it("reads no file at all when the path is null, and still reports a usable policy", async () => {
    // `null` is `Policy.load`'s "no file", which is a legitimate configuration — the code defaults
    // plus the env layer. The result says so rather than claiming a path that was never read.
    const result = await preflight(healthy({ policyFile: null, env: { [API_KEY_VAR]: "sk-test" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policyPath).toBeNull();
    expect(result.policy.document.allowlist.origins).toEqual([...DEFAULT_ORIGINS]);
  });

  it("resolves POLICY_PATH from the environment when no flag named one", async () => {
    const file = await tempPolicy({ allowlist: { origins: ["http://localhost:4173"] } });
    const result = await preflight(healthy({ env: { [API_KEY_VAR]: "sk-test", POLICY_PATH: file } }));
    expect(result.ok && result.policyPath).toBe(file);
  });
});

describe("the entry cross-check", () => {
  it("defaults to the allowlist's own first origin, normalized", async () => {
    // §5.4 makes the default the allowlist's origin precisely so that "no flag" is always something
    // the policy already covers. `URL.href` is what the driver will navigate to, so the value handed
    // back is the normalized one rather than the bare string from the file.
    const result = await preflight(healthy({ entry: null }));
    expect(result.ok && result.entry).toBe(new URL(DEFAULT_ORIGINS[0] ?? "").href);
  });

  it("names the port when the app is running on a non-default one", async () => {
    const result = await preflight(healthy({ entry: "http://localhost:9999/" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = problems(result.issues);
    expect(text).toContain("not permitted by policy");
    expect(text).toContain("allowlist.origin");
    expect(text).toContain("port 9999");
    expect(text).toContain("policy allowlist does not include port 9999");
    expect(fixes(result.issues)).toContain("allowlist.origins");
  });

  it("agrees with the canonicalization the driver does", async () => {
    // `localhost` and `127.0.0.1` are the same machine, and Playwright's `page.url()` may report
    // either. A check that disagreed with the driver about that would refuse a run the driver would
    // have allowed — so the entry that reaches the policy is the one the driver would navigate to.
    const result = await preflight(healthy({ entry: "http://127.0.0.1:4173" }));
    expect(result.ok && result.entry).toBe("http://127.0.0.1:4173/");
  });

  it("refuses an entry that is not an absolute URL", async () => {
    const result = await preflight(healthy({ entry: "/member/12345" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain("is not an absolute URL");
    expect(fixes(result.issues)).toContain("--entry");
  });

  it("surfaces a denied route with the route-level fix, not the origin one", async () => {
    // The shipped policy allows the origin and denies `/admin/`. The two failures have different
    // fixes, and telling an operator to widen `allowlist.origins` when the origin was never the
    // problem would send them to edit the wrong field.
    const result = await preflight(healthy({ entry: "http://localhost:4173/admin/users" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain("route-denied");
    expect(fixes(result.issues)).toContain("denyRoutes");
  });

  it("names a policy that allows no origins rather than failing mid-run", async () => {
    const file = await tempPolicy({ allowlist: { origins: [] } });
    const result = await preflight(healthy({ policyFile: file, entry: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain("no origins");
    expect(fixes(result.issues)).toContain("--entry");
  });

  it("does not report the origin twice when the policy itself failed to load", async () => {
    // The origin check *is* a policy lookup. Running it against no policy would add a second,
    // confusing complaint about the same file — one problem, one line.
    const result = await preflight(healthy({ policyFile: join(tmpdir(), "atlas-absent.json"), entry: "http://x/" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
  });
});

describe("the API key check", () => {
  it("is required by discover, and its fix points at the keyless path", async () => {
    const result = await preflight(healthy({ env: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain(API_KEY_VAR);
    expect(fixes(result.issues)).toContain(".env.example");
    expect(fixes(result.issues)).toContain("replay");
  });

  it("treats a blank key as unset", async () => {
    // An exported-but-empty variable is the shape a failed `export KEY=$(...)` leaves behind, and it
    // is not a key.
    const result = await preflight(healthy({ env: { [API_KEY_VAR]: "   " } }));
    expect(result.ok).toBe(false);
  });

  it("is not required by replay, which is built not to need a model", async () => {
    const result = await preflight(healthy({ command: "replay", env: {} }));
    expect(result.ok).toBe(true);
  });
});

describe("the re-record check", () => {
  /**
   * The check that exists because a README following its own example used to spend a full model-driven
   * run to learn something knowable before the browser opened. §5.4's boundary is the assertion: the
   * refusal is a preflight issue, so the caller gets exit `2` and a fix instead of a `DISCOVERY_FAILED`
   * at the end of a paid run.
   */
  it("refuses an id and version the store already holds, naming the fix", async () => {
    const result = await preflight(
      healthy({
        reRecord: { id: "member-savings-balance", version: "1" },
        recordedVersions: async () => ["1"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(problems(result.issues)).toContain('capability "member-savings-balance" already has a recorded v1');
    expect(problems(result.issues)).toContain("immutable");
    expect(problems(result.issues)).toContain("capabilities/member-savings-balance/v1");
    // The fix is a command, not advice — and it is the *next* version, so it can be pasted.
    expect(fixes(result.issues)).toContain("--version 2");
    expect(fixes(result.issues)).toContain("--id");
  });

  it("compares versions the way the store does, not the way strings do", async () => {
    // `1` and `1.0.0` are one version to `save`. A check that compared strings would pass here and be
    // refused at the save — which is precisely the failure this check exists to prevent.
    const result = await preflight(
      healthy({
        reRecord: { id: "member-savings-balance", version: "1.0.0" },
        recordedVersions: async () => ["1"],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("says nothing about a version nobody has recorded", async () => {
    const result = await preflight(
      healthy({
        reRecord: { id: "member-savings-balance", version: "2" },
        recordedVersions: async () => ["1"],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("says nothing about an id that was never recorded", async () => {
    const result = await preflight(
      healthy({
        reRecord: { id: "member-mailing-address", version: "1" },
        recordedVersions: async () => [],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("suggests a version above everything recorded, not just above the clash", () => {
    expect(reRecordProblem("x", "1", ["1", "2"])?.fix).toContain("--version 3");
    expect(reRecordProblem("x", "2", ["1", "2"])?.fix).toContain("--version 3");
    expect(reRecordProblem("x", "1.0.0", ["1.0.0"])?.fix).toContain("--version 2");
  });

  it("has nothing to say about a version the caller got wrong", () => {
    // `parseArgs` refuses a non-version long before this, and a collision message would be the wrong
    // explanation for it.
    expect(reRecordProblem("x", "latest", ["1"])).toBeNull();
  });

  it("is discover's alone, because replay never writes", async () => {
    const result = await preflight(
      healthy({
        command: "replay",
        env: {},
        reRecord: { id: "member-savings-balance", version: "1" },
        recordedVersions: async () => ["1"],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("reads the repo's own store when no seam was injected", async () => {
    // The injected arms above are the ones with interesting wordings; this is the one that would fail
    // if the default were wired to nothing, which no amount of injection would catch. It is asserted
    // as "tracks the shipped artifact" rather than against a hard-coded yes, so a checkout without
    // `capabilities/` says the honest thing instead of failing.
    const result = await preflight(
      healthy({ reRecord: { id: "member-savings-balance", version: "1" } }),
    );
    const shipped = existsSync(join(process.cwd(), "capabilities/member-savings-balance/v1/artifact.json"));
    expect(result.ok).toBe(!shipped);
  });
});

describe("reporting", () => {
  it("reports every problem at once, so a fresh machine is one pass rather than four", async () => {
    // §5.4 decision 1 in the module header: none of these checks has a side effect, so there is
    // nothing to gain by stopping at the first and a first-run experience to lose.
    const result = await preflight({
      command: "discover",
      entry: "http://localhost:9999/",
      env: {},
      nodeVersion: "v20.11.1",
      browserPath: null,
      policyFile: join(tmpdir(), "atlas-absent.json"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Node, browser, policy, key — the origin check sits out, since it needs a policy.
    expect(result.issues).toHaveLength(4);
    const text = describePreflightFailure(result.issues);
    for (const fragment of ["Node", "Chromium", "policy", API_KEY_VAR]) expect(text).toContain(fragment);
  });

  it("renders each problem with its own fix, numbered", () => {
    const issues: PreflightIssue[] = [
      { problem: "first thing", fix: "do the first fix" },
      { problem: "second thing", fix: "do the second fix" },
    ];
    expect(describePreflightFailure(issues)).toBe(
      [
        "preflight failed — 2 problems to fix before a run can start:",
        "",
        "  1. first thing",
        "     fix: do the first fix",
        "",
        "  2. second thing",
        "     fix: do the second fix",
      ].join("\n"),
    );
  });

  it("says problem in the singular when there is one", () => {
    expect(describePreflightFailure([{ problem: "p", fix: "f" }])).toContain("1 problem to fix");
  });
});
