/**
 * ControlBus — §8's local HTTP surface, and the reason the console is a *real* mechanism.
 *
 * The browser session lives in the run's process; the console is a second process. That split is what
 * makes "took control of the live session" structural (there is one `SessionDriver`, and the console
 * reaches it over a socket) rather than a claim two cooperating processes make about each other. This
 * file is the socket.
 *
 * Four rules are enforced here and nowhere else, because a rule enforced at a call site is a rule one
 * call site can forget:
 *
 * 1. **Loopback only, by `Host` and `Origin`.** The bus binds `127.0.0.1`, but binding is not enough:
 *    a browser page on any site can send a request to `http://127.0.0.1:4517` — DNS rebinding makes
 *    "localhost" reachable from a name an attacker controls, and a hostile page can post form data
 *    cross-origin without reading the response. So every request's `Host` must name a loopback
 *    literal, and an `Origin`, when present, must be loopback too.
 * 2. **`Content-Type: application/json` on every request.** A cross-origin browser cannot send that
 *    without a CORS preflight, and preflight needs this server's permission — which it never grants
 *    (no CORS headers, no `OPTIONS` handling). This is the standard "open web page on localhost"
 *    vector, closed by the same rule that makes the payloads machine-checkable.
 * 3. **Authorization is per request, not per acquisition.** `acquire` takes §8's single-use nonce;
 *    every subsequent request — state polls included — takes the bearer minted at acquisition. A poll
 *    that leaks nothing but the current dump still lets a stranger watch a banking session, so it is
 *    authorized like everything else.
 * 4. **Every payload crosses the redactor's serializer.** The bus is a sink like `run.jsonl` and the
 *    terminal (§6's list is exhaustive by construction): the a11y dump it serves carries field values,
 *    so it is scrubbed by the same single pipeline rather than by the console's good intentions.
 *
 * What this is *not* is a defense against a hostile local actor with shell access. §8 says so
 * explicitly, and REPORT §6 repeats it: the threat model is stray local processes and the browser
 * vector, not an attacker who already runs code on the machine.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Redactor } from "../policy/redact.ts";
import { quote } from "../surface/target.ts";
import { ControlError, type ConsoleCommand, type ConsoleState, type Controller } from "./controller.ts";

/** §3's diagram puts the bus at 4517; `BUS_PORT` moves it (§5.4's env-overridable knobs). */
export const DEFAULT_BUS_PORT = 4517;

/** A big enough body for a typed value and a command, and small enough that a hostile one is cheap. */
const MAX_BODY_BYTES = 1_048_576;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class BusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusError";
  }
}

export interface BusOptions {
  readonly controller: Controller;
  readonly redactor: Redactor;
  /** `BUS_PORT`, or the §3 default. `0` asks the kernel for a free port (the tests' case). */
  readonly port?: number;
  readonly onNote?: (line: string) => void;
}

export class ControlBus {
  readonly #server: ReturnType<typeof createServer>;
  readonly #controller: Controller;
  readonly #redactor: Redactor;
  #port: number;

  private constructor(
    server: ReturnType<typeof createServer>,
    controller: Controller,
    redactor: Redactor,
    port: number,
  ) {
    this.#server = server;
    this.#controller = controller;
    this.#redactor = redactor;
    this.#port = port;
  }

  /** Start listening on loopback. A busy port is a named startup error, never a silent fallback. */
  static async listen(options: BusOptions): Promise<ControlBus> {
    const desired = options.port ?? Number(process.env["BUS_PORT"] ?? DEFAULT_BUS_PORT);
    if (!Number.isInteger(desired) || desired < 0 || desired > 65_535) {
      throw new BusError(
        `BUS_PORT must be an integer in 0..65535 (got \`${desired}\`) — set BUS_PORT to a free port`,
      );
    }

    let bus: ControlBus | null = null;
    const server = createServer((request, response) => {
      void (bus as ControlBus).handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        reject(
          new BusError(
            error.code === "EADDRINUSE"
              ? `the control bus cannot listen on 127.0.0.1:${desired} — the port is already in use. ` +
                "Set BUS_PORT to a free port, or stop whatever is holding it (`lsof -i :" + desired + "`)"
              : `the control bus could not listen on 127.0.0.1:${desired}: ${error.message}`,
          ),
        );
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // Loopback only, and never a public interface: the session is a live banking screen.
      server.listen(desired, "127.0.0.1");
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : desired;
    bus = new ControlBus(server, options.controller, options.redactor, port);
    options.onNote?.(`control bus: http://127.0.0.1:${port} (loopback only, per-request bearer)`);
    return bus;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get port(): number {
    return this.#port;
  }

  /** Hand a request to the token machine. Public for tests that want to drive it without a socket. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = pathOf(request.url ?? "/");

      if (request.method === "OPTIONS") {
        // No CORS, ever: a preflight that never passes is the mechanism §8 relies on.
        throw new BusError("preflight: this bus serves no cross-origin requests");
      }
      if (request.method !== "POST") {
        throw new BusError(`${request.method ?? "that"} is not a verb this bus speaks — use POST`);
      }
      if (!loopbackHost(request.headers["host"])) {
        throw new BusError(
          `Host header ${quote(String(request.headers["host"] ?? ""))} is not a loopback literal — the control bus answers 127.0.0.1 only (§8)`,
        );
      }
      if (!loopbackOrigin(request.headers["origin"])) {
        throw new BusError(
          `Origin ${quote(String(request.headers["origin"] ?? "null"))} is not a loopback origin — cross-origin pages cannot drive this bus (§8)`,
        );
      }
      const contentType = String(request.headers["content-type"] ?? "");
      if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new BusError(
          "every request must carry `Content-Type: application/json` — a cross-origin page cannot send " +
            "that without a preflight this bus never grants (§8)",
        );
      }

      const body = await readBody(request);
      const bearer = typeof body["bearer"] === "string" ? body["bearer"] : "";

      switch (path) {
        case "/acquire": {
          const nonce = typeof body["nonce"] === "string" ? body["nonce"] : "";
          const session = await this.#controller.acquire(nonce);
          this.#send(response, 200, {
            ok: true,
            bearer: session.bearer,
            state: session.state,
            bus: this.url,
          });
          return;
        }
        case "/state": {
          this.#send(response, 200, { ok: true, state: await this.#controller.status(bearer, modeOf(body)) });
          return;
        }
        case "/act": {
          const command = asCommand(body["command"]);
          this.#send(response, 200, {
            ok: true,
            state: await this.#controller.act(bearer, command, modeOf(body)),
          });
          return;
        }
        case "/heartbeat": {
          this.#send(response, 200, { ok: true, state: await this.#controller.heartbeat(bearer) });
          return;
        }
        case "/release": {
          this.#send(response, 200, { ok: true, answer: await this.#controller.release(bearer) });
          return;
        }
        case "/decline": {
          await this.#controller.decline(bearer);
          this.#send(response, 200, { ok: true });
          return;
        }
        case "/shot": {
          this.#send(response, 200, { ok: true, shot: await this.#controller.shot(bearer) });
          return;
        }
        default:
          this.#send(response, 404, {
            ok: false,
            error: { code: "no-such-endpoint", message: `no endpoint ${path}` },
          });
          return;
      }
    } catch (error: unknown) {
      const { status, body } = describe(error);
      this.#send(response, status, body);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => this.#server.close(() => done()));
  }

  /** One writer, so the redaction rule is not a thing each endpoint remembers (§6). */
  #send(response: ServerResponse, status: number, payload: unknown): void {
    const body = this.#redactor.serialize(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading a request                                                           */
/* -------------------------------------------------------------------------- */

function pathOf(url: string): string {
  const question = url.indexOf("?");
  return question === -1 ? url : url.slice(0, question);
}

function loopbackHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  // Strip the port, keeping `[::1]:8080` intact long enough to compare the host half.
  const host = header.startsWith("[")
    ? header.slice(0, header.indexOf("]") + 1)
    : (header.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function loopbackOrigin(header: string | string[] | undefined): boolean {
  // Absent is the normal case for a local CLI client, and it is not a bypass: a browser cannot *omit*
  // `Origin` on a cross-origin POST, and the `Content-Type` rule closes the form-encoded path anyway.
  if (header === undefined) return true;
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === "null") return false;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new BusError("request body is too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BusError("the request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof BusError) throw error;
    throw new BusError("the request body is not valid JSON");
  }
}

function modeOf(body: Record<string, unknown>): "compact" | "expanded" {
  return body["mode"] === "expanded" ? "expanded" : "compact";
}

/** The console's command vocabulary, checked here so the controller can trust its argument. */
function asCommand(value: unknown): ConsoleCommand {
  if (typeof value !== "object" || value === null) throw new BusError("`command` is required");
  const candidate = value as Record<string, unknown>;
  const index = candidate["index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new BusError("`command.index` must be a non-negative integer from the dump");
  }
  switch (candidate["kind"]) {
    case "click":
      return { kind: "click", index };
    case "type": {
      const text = candidate["value"];
      if (typeof text !== "string") throw new BusError("a `type` command needs a string `value`");
      return { kind: "type", index, value: text };
    }
    case "press": {
      const key = candidate["key"];
      if (typeof key !== "string" || key === "") throw new BusError("a `press` command needs a `key`");
      return { kind: "press", index, key };
    }
    default:
      throw new BusError("`command.kind` must be one of click | type | press");
  }
}

/** A failure as an HTTP status and a body the console can print. */
function describe(error: unknown): { readonly status: number; readonly body: unknown } {
  if (error instanceof ControlError) {
    const status: Record<ControlError["code"], number> = {
      "no-escalation": 404,
      "already-resolved": 409,
      "bad-nonce": 403,
      "spent-nonce": 410,
      "console-in-use": 409,
      unauthorized: 401,
      "no-such-node": 409,
      "stale-node": 409,
      "unaddressable-node": 409,
      "policy-refused": 403,
      "action-failed": 400,
    };
    return { status: status[error.code], body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  if (error instanceof BusError) {
    return { status: 400, body: { ok: false, error: { code: "bad-request", message: error.message } } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { ok: false, error: { code: "bus-failure", message } } };
}

/** Re-exported so a caller (the console) can type what it gets back without importing the controller. */
export type { ConsoleState };
