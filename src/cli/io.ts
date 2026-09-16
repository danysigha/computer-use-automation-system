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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
