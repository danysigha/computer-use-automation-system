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
import type { RunningApp } from "../../sample-app/server.ts";
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
}

export async function testPolicy(origins: readonly string[]): Promise<Policy> {
  return Policy.load({ env: {}, overrides: { allowlist: { origins: [...origins] } } });
}

export async function startSurface(options: SurfaceOptions = {}): Promise<Surface> {
  const app = await startFixture();
  const policy = await testPolicy(options.origins ?? [app.url]);
  const driver = await SessionDriver.launch({
    evidenceDir: await mkdtemp(join(tmpdir(), "atlas-evidence-")),
    policy,
    redactor: redactorFor(policy),
    headless: options.headless,
    observer: options.observer,
    approval: options.approval,
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
