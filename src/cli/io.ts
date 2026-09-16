/**
 * What both CLIs write to, and how (§5.4).
 *
 * Three small things live here because there are two commands and each of them must behave the same
 * in both: where output goes (`Streams`, injected so a test can drive a command without capturing
 * process streams), and how narration reaches the operator — one line on stderr *and* one line in the
 * run log, in that order.
 *
 * The narration half is the load-bearing one. `EvidenceLogger.write` is async and both note sources
 * are synchronous, so two unawaited appends would make the run log's line order a race — and the
 * order is the whole reason the log exists. The queue below is a chain rather than a buffer so a long
 * run streams instead of holding every line in memory, and `flush` is what an entrypoint awaits
 * before it reads the file back.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redactor } from "../policy/redact.ts";
import type { EvidenceLogger } from "../surface/evidence.ts";

/**
 * The repo root, from this file's own location — both entrypoints live one directory down, and both
 * need it for the same two things: the checked-in `.env`, and `evidence/` as the one place runs are
 * written. Computed here rather than in each CLI so a run started by either command lands in the
 * same tree, which is what makes `evidence/` a place a person can look at rather than two.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Where every run's directory goes: `<repo>/evidence/<timestamp>/`, or `EVIDENCE_DIR` when it is set.
 *
 * There is an override for the same reason `POLICY_PATH` has one — `evidence/` is where a *deliverable*
 * run is written (P8 adds a `COMMAND.md` per run directory giving the command that regenerates it), and
 * a run whose evidence belongs somewhere else should not have to be indistinguishable from one that is
 * part of the record. The CI-shaped case is a checkout that must stay clean; the test-shaped one is a
 * suite that wants a run's log in a temp directory it can read and delete.
 *
 * A function rather than a constant, because the environment is read when a run starts: a module-level
 * value would have to be set before the import, which is exactly the kind of ordering a test gets
 * subtly wrong and then debugs for an hour.
 */
export function evidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["EVIDENCE_DIR"];
  return configured === undefined || configured === "" ? join(REPO_ROOT, "evidence") : resolve(configured);
}

/**
 * Load the checked-in `.env`, when there is one.
 *
 * Called before preflight reads the environment, because the environment is an input to preflight:
 * discovery needs the key it holds, and either command may be pointed at a policy by `POLICY_PATH`.
 * Absent is the normal case for replay, which is the keyless path.
 */
export function loadDotenv(): void {
  const file = join(REPO_ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Where a CLI writes. Injected so a test can drive a command without capturing process streams. */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const PROCESS_STREAMS: Streams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * What a CLI answers when the *caller* got it wrong — §5.4's exit code 2, and deliberately not a run
 * outcome: a bad flag must never become a `VALIDATION_ERROR`, because a caller scripted against a
 * capability has to be able to tell "the run did not happen" from "the run happened and the answer is
 * no". Both commands report it in the same shape so the two read as one tool.
 *
 * The shape carries a `fix` rather than only a `problem`, for the same reason preflight does: an
 * error a caller cannot act on is a bug report, not a message.
 */
export interface UsageError {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}

/** How a usage error renders: the command, the problem, the fix — in that order, on stderr. */
export function describeUsageError(command: string, error: UsageError): string {
  return `${command}: ${error.problem}\n  fix: ${error.fix}\n`;
}

export interface NoteWriter {
  /** Sync, because both callers are: the note is queued and written in order. */
  readonly note: (line: string) => void;
  readonly flush: () => Promise<void>;
}

/** Narration to stderr, and to the run log — in the order it happened. See the header. */
export function noteWriter(evidence: EvidenceLogger, streams: Streams): NoteWriter {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    note: (line) => {
      streams.err(`  ${line}\n`);
      queue = queue
        .then(() => evidence.write({ kind: "note", actor: "agent", message: line }))
        .catch(() => undefined);
    },
    flush: () => queue.then(() => undefined),
  };
}

/* -------------------------------------------------------------------------- */
/* The run's recipe — `COMMAND.md`                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a run directory says about **how to make it again** (§11 P8).
 *
 * Every field here is something the run already knows about itself, which is the point: a run's
 * evidence is only worth what someone else can reproduce, and the reproduction command is the one
 * piece of it that cannot be *derived* from the log — the flags that were passed are not in
 * `run.jsonl`, because the log records what happened rather than how the process was invoked.
 *
 * `outcome` and `exitCode` are here for the same reason, one level up: a run that ends in a
 * classified failure exits `1`, and a reader who re-runs it must know that the non-zero exit is
 * the demonstration rather than a broken copy-paste.
 */
export interface CommandSheet {
  /** The exact command, as a shell line — `npm run replay -- …`. */
  readonly command: string;
  /** What this run is, in the words of the command that produced it. */
  readonly what: string;
  /** How it ended: the status, the code, and the value or paths behind it. */
  readonly outcome: string;
  /** §5.4's exit code for *this* run — `0` success or business outcome, `1` failure, `2` refused. */
  readonly exitCode: number;
  /** Anything true of this run that its command alone does not show (the §26 identity, a sim, …). */
  readonly notes?: readonly string[];
}

/** §5.4's exit codes, in the words a reader of a run directory needs them in. */
const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  0: "success or business outcome — both are legitimate answers a caller acts on",
  1: "run failure — the run happened and the result is a classified failure",
  2: "usage or preflight error — the run never started",
};

/**
 * A value, quoted for `sh` when it needs to be — and only then, so the common case stays copy-
 * pasteable without noise.
 *
 * The hostile characters are the ones a URL or a goal sentence actually contains: spaces, `?`,
 * `&`, `=`, `$`, quotes. Single quotes defeat all of them, and the one character single quotes
 * cannot carry is the single quote itself, which closes and reopens around an escaped one — the
 * POSIX idiom, written out rather than clever.
 */
export function shellArg(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The environment in force when the run happened, as one line — or nothing, when nothing was set.
 *
 * Only the knobs §5.4 defines, and only when they are set: a `COMMAND.md` that lists every knob it
 * could have been given is a config reference, and the README already is one. What a reproduction
 * needs to see is what this process actually read — `POLICY_PATH` when a shrunk timing was in force,
 * `PORT` when the fixture had been moved — because those are the differences that make a copy-paste
 * fail. It is phrased as "in force" rather than "you must set this" because the environment reaches
 * this process through `.env` as well as through the shell, and the file should not guess which.
 */
export function environmentOverrides(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const knobs = ["PORT", "BUS_PORT", "POLICY_PATH", "OPENAI_MODEL", "EVIDENCE_DIR"];
  const set = knobs.filter((name) => (env[name] ?? "") !== "").map((name) => `\`${name}=${env[name] ?? ""}\``);
  return set.length === 0 ? [] : [`In force for this command: ${set.join(", ")}.`];
}

/**
 * Write the run's `COMMAND.md`.
 *
 * Through `scrubText`, like every other text sink (§6): the command quotes the run's own inputs, and
 * an input is exactly the place a caller's value reaches disk. A run whose arguments are all
 * harmless writes them verbatim; a run handed a `fieldPatterns`-matched value writes the mask. The
 * alternative — exempting a file because "it is only a shell command" — is how a sink list stops
 * being exhaustive.
 */
export async function writeCommandSheet(redactor: Redactor, runDir: string, sheet: CommandSheet): Promise<void> {
  const lines: string[] = [
    `# ${sheet.what}`,
    "",
    "This directory is one run: `run.jsonl` is the step-by-step record, `summary.json` is the same run as one object, and the command below is what produced both.",
    "",
    "## Regenerate this run",
    "",
    "Once per machine:",
    "",
    "```sh",
    "npm ci",
    "npx playwright install chromium",
    "```",
    "",
    "Then, with the fixture app running in another terminal:",
    "",
    "```sh",
    "npm run app",
    sheet.command,
    "```",
    "",
    "## What this run ended as",
    "",
    `Exit code \`${sheet.exitCode}\` — ${EXIT_MEANINGS[sheet.exitCode] ?? "see the README's exit-code table"}.`,
    "",
    `${sheet.outcome}`,
    "",
    "## Notes",
    "",
  ];

  const notes = sheet.notes ?? [];
  if (notes.length === 0) lines.push("- Nothing beyond the command above: this run used every default.");
  else for (const note of notes) lines.push(`- ${note}`);

  lines.push("");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "COMMAND.md"), redactor.scrubText(`${lines.join("\n")}\n`), "utf8");
}
