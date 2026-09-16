/**
 * The console's half of the wire — one POST, one JSON body, and nothing else.
 *
 * It is a file of its own for a structural reason rather than a tasteful one: §6's one-serializer rule
 * (`tests/unit/serialization-sinks.test.ts`) forbids `JSON.stringify` anywhere under `src/` except the
 * redactor and the capability store, because a second formatter is a sink nobody scrubs. This client
 * is the exemption that keeps that rule strict everywhere else — and the exemption is narrow by
 * construction, because the *only* payload this file can build is a request body:
 *
 * - **outbound**, the console *must not* scrub: it is the operator's own typed value travelling to the
 *   page, and masking it would break the one thing the operator is there to do. Nothing is written;
 *   the value is in flight.
 * - **inbound**, every payload the console renders has already been through the run process's
 *   `Redactor` — the bus serializes with it before the bytes leave, so the console's render path has
 *   nothing to scrub and no way to leak what it was never sent.
 *
 * `console-tui.ts` therefore stays under the scan (its rendering and grammar are exactly the kind of
 * code the rule is about), and this file carries the single call the wire needs.
 */
import type { TakeoverAnswer } from "./escalation.ts";
import type { ConsoleCommand, ConsoleState } from "./controller.ts";

/** What the bus answers with. Every field is optional: failures carry `error` and nothing else. */
export interface BusEnvelope {
  readonly ok?: boolean;
  readonly bearer?: string;
  readonly state?: ConsoleState;
  readonly answer?: TakeoverAnswer;
  readonly shot?: { readonly path?: string; readonly suppressed?: string };
  readonly bus?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class BusClient {
  readonly #bus: string;

  constructor(bus: string) {
    this.#bus = bus;
  }

  get url(): string {
    return this.#bus;
  }

  /**
   * One request. Transport failures come back as an envelope rather than a throw, because a run that
   * died while the operator was looking at the page is a *message* the console should print — not a
   * stack trace in place of a session that is genuinely gone.
   */
  async post(path: string, body: Record<string, unknown>): Promise<BusEnvelope> {
    try {
      const response = await fetch(`${this.#bus}${path}`, {
        method: "POST",
        // The `Host` header is the runtime's to write (`127.0.0.1:<port>` for this URL), which is the
        // loopback literal the bus checks for.
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as BusEnvelope;
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: "bus-unreachable",
          message:
            `${this.#bus} is not answering ` +
            `(${error instanceof Error ? error.message : String(error)}) — is the run still going?`,
        },
      };
    }
  }

  act(bearer: string, command: ConsoleCommand, mode?: "compact" | "expanded"): Promise<BusEnvelope> {
    return this.post("/act", { bearer, command, ...(mode === undefined ? {} : { mode }) });
  }
}
