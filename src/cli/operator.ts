/**
 * `operator` (§5.4) — the console's entrypoint, and the second half of §8's demos.
 *
 * The command is deliberately tiny: it takes the nonce the run printed at escalation (and, if the run
 * is not on the default bus, its URL), connects, and hands the terminal to the console loop. There is
 * no artifact, no policy and no browser here — the console's whole job is to drive *the run's* session
 * through the bus, so anything this file added would be a second path to the same page.
 *
 * Exit codes follow §5.4's boundary: `0` when the console session ended normally (handback, decline,
 * or the operator leaving), `2` when the command could not start — no nonce, or a bus that is not
 * there — because that is a *usage* problem, not a run outcome.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUS_PORT } from "../control/bus.ts";
import { OperatorConsole, type ConsoleIo } from "../control/console-tui.ts";
import { DEFAULT_TIMING } from "../policy/policy.ts";
import { PROCESS_STREAMS, describeUsageError, loadDotenv, type Streams, type UsageError } from "./io.ts";

const USAGE = "npm run operator -- --nonce <takeover-nonce> [--bus <url>] [--heartbeat <ms>]";

export interface Args {
  readonly nonce: string;
  readonly bus: string;
  readonly heartbeatMs: number;
}

export type ParsedArgs = { readonly ok: true; readonly args: Args } | UsageError;

/**
 * The grammar, hand-parsed like the other two commands — the errors are the feature.
 *
 * `--nonce` is the only required flag, and it is required *loudly*: the nonce is printed by the run at
 * exactly the moment it needs a human, and a console started without one has nothing to present. The
 * default bus is §3's port, with `BUS_PORT` honoured so a run on another port is still reachable.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let nonce: string | null = null;
  let bus = `http://127.0.0.1:${env["BUS_PORT"] ?? DEFAULT_BUS_PORT}`;
  let heartbeatMs: number = DEFAULT_TIMING.heartbeatMs;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = (): string | null => {
      const next = argv[index + 1];
      return next === undefined || next.startsWith("--") ? null : next;
    };
    const take = (): string | UsageError => {
      const next = value();
      if (next === null) return { ok: false, problem: `${flag} needs a value`, fix: `${flag} <value> — see: ${USAGE}` };
      index += 1;
      return next;
    };

    switch (flag) {
      case "--nonce": {
        const taken = take();
        if (typeof taken !== "string") return taken;
        nonce = taken;
        break;
      }
      case "--bus": {
        const taken = take();
        if (typeof taken !== "string") return taken;
        bus = taken.replace(/\/+$/, "");
        break;
      }
      case "--heartbeat": {
        const taken = take();
        if (typeof taken !== "string") return taken;
        const parsed = Number(taken);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { ok: false, problem: `--heartbeat needs a positive number of milliseconds`, fix: USAGE };
        }
        heartbeatMs = parsed;
        break;
      }
      default:
        return { ok: false, problem: `unknown flag ${flag}`, fix: USAGE };
    }
  }

  if (nonce === null || nonce === "") {
    return {
      ok: false,
      problem: "no takeover nonce was given, and the bus admits nobody without one",
      fix:
        "start the operator console with the nonce the run printed at escalation: " +
        "`npm run operator -- --nonce <nonce>` — the run prints it on the line beginning `take over with:`",
    };
  }
  return { ok: true, args: { nonce, bus, heartbeatMs } };
}

/**
 * The real terminal, with **a queue for lines that arrive before anyone asks for them**.
 *
 * That queue is not a nicety. `readline.question` resolves the *next* line and drops anything that
 * arrives while no question is pending — and the console spends its first moments acquiring the
 * escalation, rendering the dump and printing the help, which is easily long enough for a piped script
 * (`printf '16 click\npass-control-back\n' | npm run operator …`) to deliver every line and close the
 * pipe. Without the queue the operator's commands are silently eaten, the console exits, and the *lease
 * lapses* — which is exactly the failure a demo transcript would hit and no interactive session ever
 * would. Found by running the two-process demo rather than by reading the code.
 *
 * `readLine` resolves `null` at end of input (Ctrl-D, or a script finishing), which the console treats
 * as "leaving without handing back": the lease lapses and the run re-raises, so a closed console is
 * never a stuck token (§8).
 */
export function terminalIo(
  streams: Streams = PROCESS_STREAMS,
  inputStream: Readable = input,
  outputStream: Writable = output,
): ConsoleIo {
  const pending: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;

  const readline = createInterface({ input: inputStream, output: outputStream });
  readline.on("line", (line: string) => {
    const next = waiting.shift();
    if (next === undefined) pending.push(line);
    else next(line);
  });
  readline.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });

  return {
    out: (text) => streams.out(`${text}\n`),
    readLine: (prompt) => {
      outputStream.write(prompt);
      const buffered = pending.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => waiting.push(resolve));
    },
    openFile: (path) => {
      // Zero-dependency (§8): the OS viewer, spawned detached and never awaited — a headless box has
      // no viewer, and that must not break the console.
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      try {
        spawn(command, [path], { detached: true, stdio: "ignore" }).unref();
      } catch {
        // The path is printed either way, so the operator can open it by hand.
      }
    },
    /**
     * Let the command end.
     *
     * A readline interface holds stdin open in flowing mode, and an open handle is enough to keep a
     * Node process alive after its work is done — so a console that handed the session back (or that
     * never acquired it) would print its last line and then sit there, while the operator waits for a
     * prompt that has already been served. Detaching and pausing the stream is what lets the process
     * exit with the code the session ended on.
     *
     * Found by running §15's two-terminal transcript rather than by reading this file: a piped script
     * closes its own pipe and hides the difference, and an in-process console has no event loop of its
     * own to be kept alive.
     */
    close: () => {
      readline.close();
      inputStream.pause();
    },
  };
}

export async function runOperator(
  argv: readonly string[],
  streams: Streams = PROCESS_STREAMS,
  io?: ConsoleIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    streams.err(describeUsageError("operator", parsed));
    return 2;
  }
  loadDotenv();
  const { args } = parsed;

  const consoleIo = io ?? terminalIo(streams);
  const console_ = new OperatorConsole({
    bus: args.bus,
    nonce: args.nonce,
    heartbeatMs: args.heartbeatMs,
    io: consoleIo,
  });
  try {
    return await console_.run();
  } finally {
    // Every ending gives the terminal back — handback, decline, a lease that lapsed, or a nonce that
    // was refused — because in all of them the command is over and the operator's shell is next.
    consoleIo.close?.();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOperator(process.argv.slice(2));
}
