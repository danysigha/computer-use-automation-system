/**
 * Runtime smoke test (PLAN §11 P0): boot the real entry point with plain `node` —
 * native type stripping and real ESM resolution — then hit it over HTTP.
 *
 * Vitest resolves and transforms modules its own way, so it happily hides a relative
 * import written without its `.ts` extension or a construct that is not erasable.
 * The evaluator's first command is `npm run app`, so that exact path is what this
 * checks. Run with: `node scripts/smoke.ts`.
 */
import { spawn } from "node:child_process";

const START_TIMEOUT_MS = 30_000;
const ENTRY = "sample-app/server.ts";

function fail(message: string): never {
  process.stderr.write(`smoke: FAIL — ${message}\n`);
  process.exit(1);
}

// PORT=0 asks the kernel for a free port, so the smoke never collides with a running app.
const child = spawn(process.execPath, [ENTRY], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let settled = false;

child.stdout.on("data", (chunk: Buffer) => {
  stdout += chunk.toString("utf8");
  const announced = /listening on (http:\/\/\S+)/.exec(stdout);
  if (!settled && announced?.[1] !== undefined) {
    settled = true;
    void verify(announced[1]);
  }
});
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString("utf8");
});
child.on("exit", (code) => {
  if (!settled) {
    settled = true;
    fail(`${ENTRY} exited before it announced a URL (code ${code})\n${stderr}`);
  }
});

setTimeout(() => {
  if (!settled) {
    settled = true;
    fail(`${ENTRY} did not start within ${START_TIMEOUT_MS}ms\n${stdout}${stderr}`);
  }
}, START_TIMEOUT_MS).unref();

async function verify(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    const body = await response.text();
    if (!response.ok) fail(`GET ${url} returned ${response.status}`);
    if (!body.includes('id="app-build"')) fail(`GET ${url} served a page with no build marker`);
    process.stdout.write(`smoke: ok — ${ENTRY} served ${url} with its build marker\n`);
  } catch (error: unknown) {
    fail(`could not fetch ${url}: ${String(error)}`);
  } finally {
    child.kill("SIGTERM");
  }
}
