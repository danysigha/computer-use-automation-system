/**
 * EvidenceLogger — the run's black box (§3, §16's `src/surface/evidence.ts`).
 *
 * A run has to be reconstructable afterwards: what was observed, what was decided, what was done,
 * and under whose control. The logger is the one writer for all of it, which is what makes the
 * redaction rule (§6) enforceable rather than a convention — every line and every snapshot goes
 * through the run's `Redactor` on the way out, so a later sink (P6's console, the CLI's `--json`)
 * has nothing to remember and nothing to forget.
 *
 * What lands on disk:
 *
 * ```
 * <runDir>/run.jsonl                 one JSON object per line, scrubbed
 * <runDir>/dom-snapshots/NN-*.html   serialized DOM, scrubbed as text
 * <runDir>/screenshots/NN-*.png      written by the driver, capture-gated (see below)
 * ```
 *
 * `seq` is monotonic across kinds, so "what happened third" survives the fact that a decision, an
 * action and an observation can all happen within one turn. `actor` and `channel` are §3 key-3's
 * control-transfer record: `agent`, or `human` with the channel that carried the action —
 * `console` (policy-checked, command-attributed) or `direct-session` (detected in a headed window,
 * §25). Writers supply them; the logger's job is to keep them on every line that could be an action.
 *
 * The logger does not own the browser. DOM snapshots arrive as text (`page.content()`), because a
 * logger that held a `Page` would be a second path to the surface — the very thing the choke point
 * exists to prevent.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REDACTED, type Redactor } from "../policy/redact.ts";

/** §3 key-3: whose action this was. §25 adds the channel for the human case. */
export type EvidenceActor = "agent" | "human";
export type HumanChannel = "console" | "direct-session";

export type EvidenceKind =
  /** A policy-checked action that reached the surface. */
  | "action"
  /** What the run saw: an observation digest, and the state hash the stuck detector compares. */
  | "observation"
  /** What the run chose to do, before doing it — the model's tool call, or the engine's step. */
  | "decision"
  /** Something the run decided *not* to do, and why. A suppression belongs here, not in silence. */
  | "suppressed"
  /** Operator narration: run start, preflight verdicts, escalation lifecycle. */
  | "note";

export interface EvidenceLine {
  readonly kind: EvidenceKind;
  readonly actor?: EvidenceActor;
  readonly channel?: HumanChannel;
  readonly [key: string]: unknown;
}

/** Every field a line carries once the logger has stamped it. */
export type StampedLine = EvidenceLine & { readonly seq: number; readonly at: string };

export class EvidenceLogger {
  readonly #dir: string;
  readonly #redactor: Redactor;
  readonly #lines: StampedLine[] = [];
  #seq = 0;
  #snapshots = 0;

  private constructor(dir: string, redactor: Redactor) {
    this.#dir = dir;
    this.#redactor = redactor;
  }

  /** Open a run directory. The directory is created; the logger never retargets it afterwards. */
  static async open(dir: string, redactor: Redactor): Promise<EvidenceLogger> {
    await mkdir(dir, { recursive: true });
    return new EvidenceLogger(dir, redactor);
  }

  get dir(): string {
    return this.#dir;
  }

  get runLogPath(): string {
    return join(this.#dir, "run.jsonl");
  }

  /** The run's scrubber. Exposed so a sink the logger does not write (a console render) uses it. */
  get redactor(): Redactor {
    return this.#redactor;
  }

  /** The lines written so far, already scrubbed — what a console's log tail renders. */
  get lines(): readonly StampedLine[] {
    return this.#lines;
  }

  /**
   * Append one line. Returns the stamped, scrubbed form: the caller can print it or assert on it,
   * and it is by construction the same thing that reached disk — a sink that renders a value the
   * log scrubbed is a leak with a nice interface.
   */
  async write(line: EvidenceLine): Promise<StampedLine> {
    this.#seq += 1;
    const stamped = { seq: this.#seq, at: new Date().toISOString(), ...line } as StampedLine;
    const scrubbed = this.#redactor.scrub(stamped);
    this.#lines.push(scrubbed);
    await appendFile(this.runLogPath, `${this.#redactor.serialize(scrubbed)}\n`, "utf8");
    return scrubbed;
  }

  /**
   * Write a serialized DOM. Scrub-as-text, not scrub-as-JSON: the payload is HTML, so the literal
   * registry is the half that applies — which is exactly the half that catches a typed value
   * sitting in a `value` attribute or an accessibility label.
   */
  async domSnapshot(label: string, html: string): Promise<string> {
    const dir = join(this.#dir, "dom-snapshots");
    await mkdir(dir, { recursive: true });
    this.#snapshots += 1;
    const path = join(dir, `${String(this.#snapshots).padStart(2, "0")}-${slug(label)}.html`);
    await writeFile(path, this.#redactor.scrubText(html), "utf8");
    return path;
  }
}

function slug(label: string): string {
  return label.split(/[^a-zA-Z0-9]+/).filter(Boolean).join("-").toLowerCase() || "snapshot";
}

export { REDACTED };
