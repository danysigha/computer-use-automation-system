/**
 * Preflight (§5.4) — everything a run needs to exist before it starts, checked before it starts.
 *
 * The rule this file implements is the one §5.4 states as a hard boundary: a setup problem is a
 * **usage error**, not a run outcome. A missing browser, a Node that is too old, a policy with a typo,
 * an entry the allowlist refuses, a discovery run with no API key — each of these exits `2` with a
 * problem and a fix, before a browser is launched and long before anything could become a
 * `VALIDATION_ERROR` business outcome. The distinction is worth the file: a caller scripted against a
 * capability needs to know "the run did not happen" and "the run happened and the answer is no" to be
 * different events, and the exit code is how it tells them apart.
 *
 * Three decisions shape it.
 *
 * 1. **Every check runs, and all failures are reported together.** Stopping at the first would make a
 *    fresh machine a sequence of one-problem-at-a-time re-runs — install Node, then discover the
 *    browser is missing, then discover the key is missing. None of the checks has a side effect (the
 *    browser check reads a path rather than launching anything), so there is nothing to be gained by
 *    stopping early and a first-run experience to be lost.
 *
 * 2. **The checks are injectable where the machine is not.** `nodeVersion` and `browserPath` are
 *    parameters with real defaults, because the alternative is a unit test that can only exercise the
 *    happy path — it cannot uninstall Node or delete Chromium. The failure arms are the ones worth
 *    testing, so they are the ones the seam makes reachable.
 *
 * 3. **Problem, cause, fix — in that order, in one object.** §5.4 asks each failure to print the exact
 *    fix. The policy's own origin check already produces the most valuable fix text in the system
 *    ("does not include port 8080 — update `policy.json` or run the app on the allowlisted port"), so
 *    this file passes that through rather than paraphrasing it: the policy is the one place that knows
 *    which rule refused and why.
 *
 * What is *not* here: tenant drift (§26) and the artifact's `risk` re-check (§27). Both are replay-time
 * — they need a loaded artifact, which `discover` does not have and cannot have, since its job is to
 * produce one. P5's `replay` extends this module at its own entrypoint; the `Command` parameter below
 * is where that split already shows.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describeValue } from "../agent/describe.ts";
import { DEFAULT_POLICY_PATH, Policy, PolicyInvalidError } from "../policy/policy.ts";
import type { ActionContext } from "../surface/session-driver.ts";

/**
 * The commands that preflight, each with the same four checks plus its own.
 *
 * `replay` is here already, though P5 builds it: a preflight module that only knew about discovery
 * would grow a second, divergent copy of the origin check the day replay landed, and the origin check
 * is the one whose absence produces a `NAVIGATION_BLOCKED` cascade instead of an explanation.
 */
export type Command = "discover" | "replay";

/** One thing that is wrong, and the exact thing that fixes it. */
export interface PreflightIssue {
  /** What is wrong, in the terms the operator can act on. */
  readonly problem: string;
  /** The command or edit that fixes it. Never "check your configuration". */
  readonly fix: string;
}

/**
 * The Node floor, mirroring `package.json`'s `engines.node` (`>=22.18`) — the version that runs
 * TypeScript by stripping types, which is what lets this repo ship `.ts` files with no build step.
 *
 * Duplicated here rather than parsed from `package.json` at startup: the check exists to explain a
 * problem that happens *before* the repo's own tooling can run, so it has to work when the install is
 * broken. `tests/unit/preflight.test.ts` asserts the two agree, which is the part a comment cannot do.
 */
export const MIN_NODE = { major: 22, minor: 18 } as const;

/** Read by `discover` alone: the model is the one thing replay is built not to need. */
export const API_KEY_VAR = "OPENAI_API_KEY";

export interface PreflightInput {
  readonly command: Command;
  /**
   * The origin this run will actually hit — an artifact's `surface.entry`, or `--entry`. `null` means
   * the caller named none, and the run starts at the policy allowlist's own first origin (§5.4's
   * default), which is why the effective entry comes back rather than being re-derived by the caller.
   *
   * Named `entry` rather than `origin` because that is what the caller passed and what the fix text
   * has to quote back.
   */
  readonly entry: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--policy`. `undefined` resolves `POLICY_PATH` then the checked-in file (`POLICY_PATH`). */
  readonly policyFile?: string | null;
  /** Injected by tests. Defaults to the running Node. */
  readonly nodeVersion?: string;
  /** Injected by tests: `undefined` probes the machine, `null` means "no browser installed". */
  readonly browserPath?: string | null;
}

export type PreflightResult =
  | {
      readonly ok: true;
      /** The parsed policy, handed on so the run does not read it a second time. */
      readonly policy: Policy;
      /**
       * Where it came from, for the run log's first line. `null` is `Policy.load`'s "no file at all":
       * the code defaults plus the env layer, which is a policy a run can honestly report.
       */
      readonly policyPath: string | null;
      /** The effective entry: what was asked for, or the allowlist's default, normalized. */
      readonly entry: string;
    }
  | { readonly ok: false; readonly issues: readonly PreflightIssue[] };

/**
 * Every check, in §5.4's order. Returns the loaded policy on success — preflight is the only reader
 * of the policy file, so "the policy parses" and "here is the policy" are the same event.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const issues: PreflightIssue[] = [];

  const nodeIssue = nodeVersionProblem(input.nodeVersion ?? process.versions.node);
  if (nodeIssue !== null) issues.push(nodeIssue);

  // Not `??`: `undefined` means "probe the machine" and `null` means "there is no browser", so the two
  // nullish values are different instructions here and collapsing them would make the missing-browser
  // test silently pass.
  const missingBrowser = browserIssue(input.browserPath === undefined ? probeBrowser() : input.browserPath);
  if (missingBrowser !== null) issues.push(missingBrowser);

  // Same distinction, and it is `Policy.load`'s: `undefined` resolves `POLICY_PATH` then the checked-in
  // file, while `null` reads no file at all.
  const policyPath: string | null =
    input.policyFile === undefined
      ? (input.env["POLICY_PATH"] ?? DEFAULT_POLICY_PATH)
      : input.policyFile;
  let policy: Policy | null = null;
  try {
    policy = await Policy.load({ file: policyPath, env: input.env });
  } catch (error: unknown) {
    issues.push(policyProblem(error, policyPath));
  }

  // Only meaningful once the policy parsed: the origin check *is* a policy lookup, and running it
  // against no policy would produce a second, confusing complaint about the same file.
  let entry: string | null = null;
  if (policy !== null) {
    const resolved = await resolveEntry(policy, input.entry);
    if ("issue" in resolved) issues.push(resolved.issue);
    else entry = resolved.entry;
  }

  if (input.command === "discover") {
    const keyProblem = keyIssue(input.env);
    if (keyProblem !== null) issues.push(keyProblem);
  }

  if (issues.length > 0 || policy === null || entry === null) return { ok: false, issues };
  return { ok: true, policy, policyPath, entry };
}

/**
 * The `engines` check, as a comparison rather than a call to a semver package: the floor is two
 * numbers and the input is one string, and a dependency whose whole job is to compare them would be
 * the largest thing in this module.
 */
export function nodeVersionProblem(version: string): PreflightIssue | null {
  const parsed = /^v?(\d+)\.(\d+)/.exec(version);
  if (parsed === null) {
    return {
      problem: `could not read the running Node version (${version})`,
      fix: `run this on Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer — see .nvmrc, or \`nvm use\``,
    };
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) return null;
  return {
    problem:
      `Node ${version} is older than this repo's \`engines\` floor (>=${MIN_NODE.major}.${MIN_NODE.minor}) — ` +
      "the runtime's TypeScript support is what lets these `.ts` entrypoints run under plain `node`",
    fix: "`nvm use` (the repo pins .nvmrc), or install Node 24",
  };
}

/** Chromium's executable path, or `null` when Playwright has not downloaded it. */
function probeBrowser(): string | null {
  try {
    const path = chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch {
    // `executablePath()` throws when the browser registry has nothing for this platform at all.
    return null;
  }
}

function browserIssue(path: string | null): PreflightIssue | null {
  if (path !== null) return null;
  return {
    problem: "Playwright's Chromium binary is not installed, so no run can launch a browser",
    fix:
      "`npx playwright install chromium` — on Linux also install the system libraries with " +
      "`npx playwright install --with-deps chromium`",
  };
}

function policyProblem(error: unknown, path: string | null): PreflightIssue {
  if (error instanceof PolicyInvalidError) {
    // The loader's message already names the offending field, which is the "cause" half (§5.4). It is
    // passed through whole rather than summarized: the field path is the actionable part. This covers
    // every way the file layer can fail — a missing file, unreadable bytes, invalid JSON, a field the
    // schema refuses — because the loader wraps each of them in this error with its own fix text.
    return {
      problem: `${path ?? "the policy"} is not a usable policy:\n${indent(error.message)}`,
      fix: "fix the named field, or run with the shipped policy by unsetting POLICY_PATH",
    };
  }
  // Reachable only if the loader changes shape under us: it reports its own failures as
  // `PolicyInvalidError`, so anything else arriving here is a bug rather than a configuration problem.
  // Reported rather than thrown all the same — a caller who asked for a run should not get a stack
  // trace where §5.4 promises a problem and a fix.
  return {
    problem: `could not read the policy at ${path ?? "the policy"}: ${describeError(error)}`,
    fix: "check the path, or unset POLICY_PATH to use policy/policy.json",
  };
}

/** A thrown value, as a line a reader can act on — an `Error`'s message, not its `[object Object]`. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return `a non-error value was thrown (${typeof error})`;
}

/**
 * The entry the run will use, checked — §5.4's cross-check, and the reason it exists: without it, a
 * sample app started on a non-default `PORT` produces a run that dies at its first navigation with
 * `NAVIGATION_BLOCKED` and no hint that a policy file was the cause.
 *
 * Both halves are here because they are the same question asked twice. A named entry is normalized
 * through `URL` and run past the policy's own review, so a trailing slash or a written-out default
 * port cannot make an allowlisted origin look foreign — the check has to agree with the
 * canonicalization the driver will do. An unnamed entry is the allowlist's first origin, which §5.4
 * makes the default precisely so that "no flag" is always an origin the policy already covers; the
 * one way that can fail is a policy that lists no origins at all, and that is named rather than left
 * to become a mid-run denial.
 *
 * The route is checked as well as the origin, because an artifact may legitimately point at a route
 * the policy denies and the operator should learn that here rather than mid-run.
 */
async function resolveEntry(
  policy: Policy,
  entry: string | null,
): Promise<{ readonly entry: string } | { readonly issue: PreflightIssue }> {
  if (entry === null) {
    const fallback = policy.document.allowlist.origins[0];
    if (fallback === undefined) {
      return {
        issue: {
          problem: "the policy allows no origins, so there is no default entry and no page to open",
          fix: "add an origin to `allowlist.origins` in policy/policy.json, or pass --entry explicitly",
        },
      };
    }
    return { entry: new URL(fallback).href };
  }

  let url: string;
  try {
    url = new URL(entry).href;
  } catch {
    return {
      issue: {
        problem: `the run entry ${describeValue(entry)} is not an absolute URL`,
        fix: "pass --entry with an absolute http(s) URL, e.g. --entry http://localhost:4173/",
      },
    };
  }

  const context: ActionContext = { action: { kind: "navigate", url }, targetName: null, targetRole: null };
  const verdict = await policy.review(context);
  if (verdict.allowed) return { entry: url };

  const isRoute = verdict.rule === "allowlist.route-denied";
  return {
    issue: {
      problem: `the run cannot start: the entry ${url} is not permitted by policy (${verdict.rule}) — ${verdict.reason}`,
      fix: isRoute
        ? "point the run at a route the policy allows (--entry), or narrow `allowlist.denyRoutes` in policy/policy.json"
        : "update `allowlist.origins` in policy/policy.json to include this origin, or run the app on an origin it already allows",
    },
  };
}

function keyIssue(env: Readonly<Record<string, string | undefined>>): PreflightIssue | null {
  const key = env[API_KEY_VAR];
  if (key !== undefined && key.trim() !== "") return null;
  return {
    problem: `${API_KEY_VAR} is not set, and discovery drives a real model — there is no offline path for it`,
    fix:
      `export ${API_KEY_VAR}=… in your shell or a gitignored .env (see .env.example), then re-run. ` +
      "Replay needs no key: `npm run replay -- <capability-id>` is the keyless path",
  };
}

/** Continuation lines under a multi-line message, so the fix line stays visually attached to it. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** How a preflight failure renders: the problem, then what to do, on stderr (§5.4). */
export function describePreflightFailure(issues: readonly PreflightIssue[]): string {
  const count = issues.length === 1 ? "1 problem" : `${issues.length} problems`;
  return [
    `preflight failed — ${count} to fix before a run can start:`,
    ...issues.flatMap((issue, index) => [
      "",
      `  ${index + 1}. ${issue.problem}`,
      `     fix: ${issue.fix}`,
    ]),
  ].join("\n");
}
