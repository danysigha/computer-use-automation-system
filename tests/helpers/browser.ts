/**
 * Browser-backed surface tests: the fixture app plus a real SessionDriver on a real
 * Chromium. The target-resolution rules are about what a *browser's* accessibility tree
 * exposes, so testing them against a hand-built DOM stub would test the stub instead.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningApp } from "../../sample-app/server.ts";
import { SessionDriver, type SessionOptions } from "../../src/surface/session-driver.ts";
import { startFixture } from "./fixture.ts";

export interface Surface {
  readonly app: RunningApp;
  readonly driver: SessionDriver;
  readonly page: import("playwright").Page;
  /** The fixture's base URL. */
  readonly base: string;
  stop(): Promise<void>;
}

export async function startSurface(options: SessionOptions = {}): Promise<Surface> {
  const app = await startFixture();
  const driver = await SessionDriver.launch({
    evidenceDir: await mkdtemp(join(tmpdir(), "atlas-evidence-")),
    ...options,
  });
  return {
    app,
    driver,
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
