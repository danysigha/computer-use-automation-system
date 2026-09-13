/**
 * Test helpers for the sample-app fixture: boot it on an ephemeral port and drive it
 * with a cookie jar, the way a browser session would.
 */
import {
  DEFAULT_PRODUCT,
  DEFAULT_VARIANT,
  DEFAULT_VERSION,
  startServer,
  type AppConfig,
  type RunningApp,
} from "../../sample-app/server.ts";

export const SIM_COOKIE = "atlas_sim";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { product: DEFAULT_PRODUCT, variant: DEFAULT_VARIANT, version: DEFAULT_VERSION, port: 0, ...overrides };
}

/** Boot the fixture on port 0 (kernel-assigned) so parallel test files never collide. */
export async function startFixture(overrides: Partial<AppConfig> = {}): Promise<RunningApp> {
  return startServer(testConfig(overrides));
}

export interface Session {
  /** A document navigation (what the sim's response counter counts). */
  get(path: string): Promise<Response>;
  post(path: string, form: Record<string, string>): Promise<Response>;
  body(path: string): Promise<string>;
  /** The raw cookie header this session would send, for assertions. */
  readonly cookie: string;
}

export function locationOf(response: Response): string {
  return response.headers.get("location") ?? "";
}

export async function textOf(response: Response): Promise<string> {
  return response.text();
}

/** A cookie-jar session against a running fixture, mimicking browser navigations. */
export function session(base: string): Session {
  let cookie = "";

  const send = async (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("sec-fetch-dest", "document");
    headers.set("accept", "text/html");
    if (cookie !== "") headers.set("cookie", cookie);

    const response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      cookie = name === SIM_COOKIE && value !== "" ? `${name}=${value}` : "";
    }
    return response;
  };

  return {
    get: (path) => send(path, { method: "GET" }),
    post: (path, form) =>
      send(path, {
        method: "POST",
        body: new URLSearchParams(form).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    body: async (path) => textOf(await send(path, { method: "GET" })),
    get cookie() {
      return cookie;
    },
  };
}
