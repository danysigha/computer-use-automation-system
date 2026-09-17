/**
 * The operator console — §8's "mock operator surface with a real mechanism".
 *
 * Zero dependencies, one line of input at a time, and the two things §8 asks a console to be:
 *
 * - **a live view of the run's own perception.** The dump it prints is the run process's own
 *   `Observer` rendering, fetched over the bus, so the operator reads the same numbering the agent
 *   read and the engine will act on. §24's split is respected in the letter: `expanded` re-renders
 *   the *same model* without the digest's table budget, so a command typed from the compact view
 *   resolves to the same element after expanding — indices never shift.
 * - **an actuator on the same live session.** A numbered command is sent to the run process, which
 *   resolves it against the live page, policy-checks it and drives the same browser the automation
 *   paused inside. The console never touches a browser, which is what keeps §3 key-1's single choke
 *   point true even while a human is driving.
 *
 * Three smaller decisions are worth recording.
 *
 * 1. **The value of a `type` never round-trips into a printed line.** The console says what it did
 *    (`type into [4] (12 chars)`), never what was typed: the operator's terminal is a sink too, and a
 *    password echoed into it would defeat the redaction the rest of the system performs. The bus is
 *    given the value; the screen is given the shape.
 * 2. **The heartbeat carries the view.** A lease has to be renewed every ~2s anyway, and a state
 *    response comes back with it — so the console prints the dump again only when the page actually
 *    changed, which makes it live without turning into a firehose.
 * 3. **`exit` is not `pass-control-back`.** Leaving the console without handing the token back is a
 *    legitimate thing to do (the operator went to look at something else); it is *observable* rather
 *    than silent — the lease lapses, the run re-raises with a fresh nonce, and the log says so.
 */
import { quote } from "../surface/target.ts";
import type { ConsoleCommand, ConsoleState, EscalationView } from "./controller.ts";
import { BusClient, type BusEnvelope } from "./bus-client.ts";

export interface ConsoleIo {
  /** One already-rendered block, for the terminal. */
  readonly out: (text: string) => void;
  /** The next line the operator typed, or `null` at end of input. */
  readonly readLine: (prompt: string) => Promise<string | null>;
  /** Open a file in the OS viewer (`open`/`xdg-open`). Failures are the caller's to swallow. */
  readonly openFile: (path: string) => void;
  /**
   * Give the terminal back. Optional because it is about the *process* rather than about the console:
   * an in-process caller that supplied its own line source has nothing to release and no event loop to
   * release it from. A real terminal does — see `terminalIo` in `src/cli/operator.ts`, where an
   * interface still attached to stdin is what keeps a finished command from exiting.
   */
  readonly close?: () => void;
}

export interface ConsoleOptions {
  readonly bus: string;
  readonly nonce: string;
  readonly io: ConsoleIo;
  /** Renewal cadence, from the policy's `timing.heartbeatMs`. */
  readonly heartbeatMs: number;
}

/** What one typed line means. Everything that is not a console command is handled locally. */
export type ParsedLine =
  | { readonly kind: "command"; readonly command: ConsoleCommand }
  | { readonly kind: "expand"; readonly index: number | null }
  | { readonly kind: "release" }
  | { readonly kind: "decline" }
  | { readonly kind: "shot" }
  | { readonly kind: "refresh" }
  | { readonly kind: "help" }
  | { readonly kind: "exit" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

/**
 * §8's grammar, parsed.
 *
 * Both spellings of a numbered command are accepted — `3 click` and `click 3` — because an operator
 * reading a dump thinks in indices first and verbs second, and the cost of accepting the natural one
 * is a single line of parsing. A `type`'s value runs to the end of the line: values contain spaces.
 */
export function parseConsoleLine(raw: string): ParsedLine {
  const line = raw.trim();
  if (line === "") return { kind: "empty" };

  const tokens = line.split(/\s+/);
  const [first = "", ...rest] = tokens;
  const keyword = first.toLowerCase();

  if (keyword === "help" || keyword === "?") return { kind: "help" };
  if (keyword === "exit" || keyword === "quit") return { kind: "exit" };
  if (keyword === "refresh" || keyword === "state") return { kind: "refresh" };
  if (keyword === "shot" || keyword === "screenshot") return { kind: "shot" };
  if (keyword === "decline" || keyword === "no") return { kind: "decline" };
  if (keyword === "pass-control-back" || keyword === "release" || keyword === "back" || keyword === "resume") {
    return { kind: "release" };
  }
  if (keyword === "expand") {
    const index = rest[0];
    if (index === undefined) return { kind: "expand", index: null };
    const parsed = Number(index.replace(/[[\]]/g, ""));
    return Number.isInteger(parsed) && parsed >= 0
      ? { kind: "expand", index: parsed }
      : { kind: "error", message: `expand takes a node index, not ${quote(index)}` };
  }

  // `<idx> <verb> …`, the spelling the dump invites.
  const leadingIndex = parseIndex(first);
  if (leadingIndex !== null) {
    const verb = (rest[0] ?? "").toLowerCase();
    const tail = rest.slice(1).join(" ").replace(/^:\s*/, "");
    return verbed(leadingIndex, verb, tail);
  }

  // `<verb> <idx> …`, the spelling a reader who knows the verb first types.
  const trailing = parseIndex(rest[0] ?? "");
  if (trailing !== null) return verbed(trailing, keyword, rest.slice(1).join(" "));

  return {
    kind: "error",
    message: `\`${line}\` is not a console command — try \`help\`, or \`<idx> click\` / \`<idx> type <text>\``,
  };
}

function parseIndex(token: string): number | null {
  const cleaned = token.replace(/[[\]]/g, "").replace(/:$/, "");
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

function verbed(index: number, verb: string, tail: string): ParsedLine {
  switch (verb) {
    case "click":
      return { kind: "command", command: { kind: "click", index } };
    case "type":
    case "fill":
    case "enter":
      return tail === ""
        ? { kind: "error", message: `type needs a value: \`${index} type <text>\`` }
        : { kind: "command", command: { kind: "type", index, value: tail } };
    case "press":
      return tail === ""
        ? { kind: "error", message: `press needs a key: \`${index} press Enter\`` }
        : { kind: "command", command: { kind: "press", index, key: tail } };
    default:
      return {
        kind: "error",
        message: `\`${verb}\` is not a verb this console carries out — use click, type or press`,
      };
  }
}

/** One command, as a line — with a typed value reduced to its length (decision 1 in the header). */
export function describeCommand(command: ConsoleCommand): string {
  switch (command.kind) {
    case "click":
      return `click [${command.index}]`;
    case "type":
      return `type into [${command.index}] (${command.value.length} chars)`;
    case "press":
      return `press ${command.key} on [${command.index}]`;
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/** The escalation block: what is being asked, and what is showing. */
export function renderEscalation(view: EscalationView): string {
  const lines = [
    `── escalation ${view.code} — ${view.stepId === null ? "the entry" : `step ${view.stepId}`} ${"─".repeat(8)}`,
    `  why:        ${view.reason}`,
    `  observed:   ${view.observed}`,
    `  run:        ${view.capabilityId} (${view.stage})   evidence: ${view.evidenceDir}`,
    `  terminates: ${Math.round(view.terminatesInMs / 1000)}s from now unless you answer (§8)`,
    "path" in view.screenshot
      ? `  screenshot: ${view.screenshot.path}`
      : `  screenshot: none — ${view.screenshot.suppressed}`,
  ];
  if (view.reRaised > 0) {
    lines.push(`  note:       this escalation has re-raised ${view.reRaised}× — a lease lapsed`);
  }
  return lines.join("\n");
}

/** The numbered affordances, so the operator sees what is actionable without reading every line. */
export function affordances(state: ConsoleState, limit = 12): readonly string[] {
  const actionable = ["button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "option", "tab"];
  return state.snapshot.numbered
    .filter((node) => actionable.includes(node.role))
    .slice(0, limit)
    .map((node) => `  [${node.index ?? "?"}] ${node.role} ${node.name === "" ? "(unnamed)" : quote(node.name)}`);
}

/** The whole state block: token, lease, dump, affordances and the log tail. */
export function renderState(state: ConsoleState, note?: string): string {
  const lease =
    state.lease === null
      ? "not held"
      : `${Math.round(state.lease.expiresInMs / 1000)}s left of ${Math.round(state.lease.ttlMs / 1000)}s (renewed every heartbeat)`;
  const blocks = [
    "",
    renderEscalation(state.escalation),
    `  token:      ${state.token}   lease: ${lease}   your actions: ${state.humanActions}`,
    note === undefined ? "" : `  ${note}`,
    "",
    "  ── live view (indices are the agent's own numbering; `expand` shows the hidden rows) ──",
    indent(state.dump),
  ];
  const hints = affordances(state);
  if (hints.length > 0 && state.mode === "compact") {
    blocks.push("", "  ── actionable now ──", ...hints);
  }
  if (state.logTail.length > 0) {
    blocks.push(
      "",
      "  ── run log (tail) ──",
      ...state.logTail.map((line) => `  ${line.seq} ${String(line["kind"])}${line["message"] === undefined ? "" : `: ${String(line["message"])}`}`),
    );
  }
  return blocks.filter((block) => block !== "").join("\n");
}

export const COMMAND_HELP = [
  "  everything here is typed at this prompt — a browser window or a screenshot viewer is a view of the session, not an input to it",
  "",
  "  <idx> click            click the node the dump numbers <idx>",
  "  <idx> type <text>      replace the field's contents with <text> (never appended)",
  "  <idx> press <key>      press a key on a node, e.g. `3 press Enter`",
  "  expand [idx]           re-render the whole model unsummarized (spreads nothing)",
  "  refresh                poll the run again",
  "  shot                   open the current screenshot in the OS viewer",
  "  pass-control-back      hand the session back; the run re-verifies and continues",
  "  decline                end the run: a person said no",
  "  exit                   leave without handing back (the lease lapses, the run re-raises)",
].join("\n");

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

export class OperatorConsole {
  readonly #options: ConsoleOptions;
  readonly #client: BusClient;
  #bearer = "";
  #heartbeat: NodeJS.Timeout | null = null;
  #lastDump = "";

  constructor(options: ConsoleOptions) {
    this.#options = options;
    this.#client = new BusClient(options.bus);
  }

  /** Acquire, then serve lines until the operator hands back, declines, or leaves. */
  async run(): Promise<number> {
    const acquired = await this.#post("/acquire", { nonce: this.#options.nonce });
    if (acquired.bearer === undefined || acquired.state === undefined) {
      this.#options.io.out(`operator: could not take control — ${errorText(acquired)}`);
      return 2;
    }
    this.#bearer = acquired.bearer;
    this.#lastDump = acquired.state.dump;

    this.#options.io.out(renderState(acquired.state, "you hold the session — the run is paused until you hand it back"));
    this.#options.io.out(COMMAND_HELP);
    // §24 nit 3: the escalation's screenshot is *rendered*, not merely carried.
    if ("path" in acquired.state.escalation.screenshot) {
      // Named before it opens, because the viewer's window is a picture of the page in the same way the
      // dump below is a description of it: a person who mistakes it for the session will click the wrong
      // window, and §25 detects that but the cheaper fix is to say which window this is.
      this.#options.io.out(
        `operator: opening the escalation screenshot in your image viewer — ${acquired.state.escalation.screenshot.path}`,
      );
      this.#options.io.openFile(acquired.state.escalation.screenshot.path);
    }

    this.#startHeartbeat();
    try {
      for (;;) {
        const line = await this.#options.io.readLine("operator> ");
        if (line === null) {
          this.#options.io.out("operator: input closed — leaving control to lapse (the run re-raises)");
          return 0;
        }
        const done = await this.#handle(line);
        if (done !== null) return done;
      }
    } finally {
      this.#stopHeartbeat();
    }
  }

  /** One line, one action. Returns an exit code when the session is over, else `null`. */
  async #handle(raw: string): Promise<number | null> {
    const parsed = parseConsoleLine(raw);
    switch (parsed.kind) {
      case "empty":
        return null;
      case "help":
        this.#options.io.out(COMMAND_HELP);
        return null;
      case "error":
        this.#options.io.out(`operator: ${parsed.message}`);
        return null;
      case "command": {
        const described = describeCommand(parsed.command);
        const reply = await this.#post("/act", { bearer: this.#bearer, command: parsed.command });
        if (reply.state === undefined) {
          this.#options.io.out(`operator: ${described} — refused: ${errorText(reply)}`);
          return null;
        }
        this.#absorb(reply.state, `you ran ${described} through the choke point (actor: human, channel: console)`);
        return null;
      }
      case "expand": {
        const reply = await this.#post("/state", { bearer: this.#bearer, mode: "expanded" });
        if (reply.state === undefined) {
          this.#options.io.out(`operator: could not re-render — ${errorText(reply)}`);
          return null;
        }
        const node =
          parsed.index === null
            ? null
            : (reply.state.snapshot.numbered[parsed.index] ?? null);
        this.#absorb(
          reply.state,
          node === null
            ? "expanded — the same indices as the compact view, with the hidden rows shown"
            : `expanded — node [${node.index}] is ${node.role} ${quote(node.name)}; indices are unchanged`,
        );
        return null;
      }
      case "shot": {
        const reply = await this.#post("/shot", { bearer: this.#bearer });
        if (reply.shot?.path !== undefined) {
          this.#options.io.out(`operator: screenshot ${reply.shot.path}`);
          this.#options.io.openFile(reply.shot.path);
        } else {
          this.#options.io.out(`operator: screenshot suppressed — ${reply.shot?.suppressed ?? errorText(reply)}`);
        }
        return null;
      }
      case "refresh": {
        const reply = await this.#post("/state", { bearer: this.#bearer });
        if (reply.state === undefined) {
          this.#options.io.out(`operator: ${errorText(reply)}`);
          return null;
        }
        this.#absorb(reply.state, "refreshed");
        return null;
      }
      case "release": {
        const reply = await this.#post("/release", { bearer: this.#bearer });
        this.#options.io.out(
          reply.ok === true
            ? "operator: control handed back — the run re-verifies the page and continues (§8)"
            : `operator: ${errorText(reply)}`,
        );
        return reply.ok === true ? 0 : null;
      }
      case "decline": {
        const reply = await this.#post("/decline", { bearer: this.#bearer });
        this.#options.io.out(
          reply.ok === true ? "operator: declined — the run stops here on purpose (§8)" : `operator: ${errorText(reply)}`,
        );
        return reply.ok === true ? 0 : null;
      }
      case "exit":
        this.#options.io.out("operator: leaving without handing back — the lease lapses and the run re-raises");
        return 0;
    }
  }

  /** Show a state, unless it is the same page as last time and nothing was asked of it. */
  #absorb(state: ConsoleState, note?: string): void {
    const changed = state.dump !== this.#lastDump;
    this.#lastDump = state.dump;
    this.#options.io.out(renderState(state, note ?? (changed ? "the page changed" : undefined)));
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      void this.#post("/heartbeat", { bearer: this.#bearer }).then((reply) => {
        if (reply.state === undefined) {
          this.#options.io.out(`operator: ${errorText(reply)}`);
          return;
        }
        // §24's liveness without the firehose: a heartbeat that finds a different page says so.
        if (reply.state.dump !== this.#lastDump) this.#absorb(reply.state, "the page changed while you held the session");
      });
    }, this.#options.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === null) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #post(path: string, body: Record<string, unknown>): Promise<BusEnvelope> {
    return this.#client.post(path, body);
  }
}

function errorText(envelope: BusEnvelope): string {
  return envelope.error?.message ?? "the bus answered with no detail";
}
