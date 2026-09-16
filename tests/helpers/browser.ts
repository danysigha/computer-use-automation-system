/**
 * Browser-backed surface tests: the fixture app plus a real SessionDriver on a real
 * Chromium. The target-resolution rules are about what a *browser's* accessibility tree
 * exposes, so testing them against a hand-built DOM stub would test the stub instead.
 *
 * From P3 a driver needs its two guards (`policy`, `redactor`), and a test surface is no exception
 * — a helper that quietly installed a permissive policy would make every test in the suite a test
 * of a system nobody ships. So the helper builds a *real* policy and allowlists exactly one thing:
 * the fixture origin this test booted, which is the ephemeral-port case §5.4's preflight exists to
 * name. Everything else — the deny-by-default action list, the two shipped `approvalRequired`
 * rules, the field patterns — is the shipped `policy/policy.json`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, RunningApp } from "../../sample-app/server.ts";
import { Policy } from "../../src/policy/policy.ts";
import { redactorFor } from "../../src/policy/redact.ts";
import { SessionDriver, type ApprovalHandler, type SessionOptions } from "../../src/surface/session-driver.ts";
import { startFixture } from "./fixture.ts";

export interface Surface {
  readonly app: RunningApp;
  readonly driver: SessionDriver;
  readonly policy: Policy;
  readonly page: import("playwright").Page;
  /** The fixture's base URL. */
  readonly base: string;
  stop(): Promise<void>;
}

export interface SurfaceOptions {
  readonly headless?: boolean;
  readonly observer?: SessionOptions["observer"];
  readonly approval?: ApprovalHandler;
  /** Extra allowlist origins, for the tests that deliberately aim at a blocked origin. */
  readonly origins?: readonly string[];
  /**
   * The fixture's own config, for the tests that need an app other than the default one. §26's drift
   * pair is the case: the *same* flow has to be recorded against one tenant and replayed against
   * another, and the only thing that makes the second tenant different is the marker it advertises.
   */
  readonly app?: Partial<AppConfig>;
  /**
   * A policy built by the caller instead of the default one.
   *
   * P5's replay tests need a *smaller* `timing` than the shipped 10s `waitForMs` to reach a real
   * retry-budget terminal without a test that takes half a minute. Those are policy documents, so the
   * override is the whole document rather than a patch: a helper that merged a test's fields into
   * the shipped policy would be a second place the shipped defaults live.
   *
   * A *factory* is the form to use whenever the policy has to allowlist the fixture itself, because
   * the port is only known once the fixture is up — and preflight's origin check is exactly what
   * makes that ordering unavoidable rather than a convenience.
   */
  readonly policy?: Policy | PolicyFactory;
  /**
   * Driver options the surface does not set itself, spread *last* so a caller can override
   * `evidenceDir` (the replay tests hand the engine a directory they then read) and `actionTimeoutMs`.
   * `policy`/`redactor` are not settable this way — they must agree with the `policy` above.
   */
  readonly driver?: Omit<SessionOptions, "policy" | "redactor">;
}

/** The fixture's own base URL, once it has one. See `SurfaceOptions.policy`. */
export type PolicyFactory = (base: string) => Promise<Policy>;

export async function testPolicy(origins: readonly string[]): Promise<Policy> {
  return Policy.load({ env: {}, overrides: { allowlist: { origins: [...origins] } } });
}

export async function startSurface(options: SurfaceOptions = {}): Promise<Surface> {
  const app = await startFixture(options.app ?? {});
  const policy =
    typeof options.policy === "function"
      ? await options.policy(app.url)
      : (options.policy ?? (await testPolicy(options.origins ?? [app.url])));
  const driver = await SessionDriver.launch({
    evidenceDir: await mkdtemp(join(tmpdir(), "atlas-evidence-")),
    headless: options.headless,
    observer: options.observer,
    approval: options.approval,
    // §5.4, and the same rule the CLI applies: the driver's own auto-wait *is* the step budget, so a
    // policy whose `waitForMs` is 300ms must not be paired with Playwright's 30s default — that would
    // be a surface nobody ships, measuring a timeout the policy never agreed to.
    actionTimeoutMs: policy.document.timing.waitForMs,
    ...options.driver,
    policy,
    redactor: redactorFor(policy),
  });
  return {
    app,
    driver,
    policy,
    page: driver.page,
    base: app.url,
    async stop() {
      await driver.close();
      await app.close();
    },
  };
}

export async function textOf(element: import("playwright").ElementHandle): Promise<string> {
  return ((await element.textContent()) ?? "").replace(/\s+/g, " ").trim();
}
