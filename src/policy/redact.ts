/**
 * Redaction — the scrubber, and the one serializer every sink goes through (§6, §11 P3).
 *
 * §6's rule is that raw sensitive values are scrubbed at every **serialization boundary**, not only
 * at the action choke point, and it names the sinks: `run.jsonl` (action lines *and* observation
 * lines), DOM snapshots, bus state, console renders, `--json` stdout. Two things make that list
 * exhaustive rather than aspirational:
 *
 * 1. **One function writes serialized run data** — `serialize`. Nothing in `src/` outside this file
 *    (and the capability store, which writes a different class of data: reviewed artifacts, not run
 *    evidence) calls `JSON.stringify`; `tests/unit/serialization-sinks.test.ts` enforces that
 *    structurally, so a later sink — P6's control bus is the next one — cannot quietly format its
 *    own payload. Plain-text sinks (a console render, a DOM snapshot) call `scrubText`, which is the
 *    same scrubber with the JSON walk removed.
 *
 * 2. **Redaction follows the *value*, not just the field.** Masking by field name alone would miss
 *    the leak that actually matters: the accessibility snapshot reports a textbox's current value as
 *    its `text`, and a DOM snapshot serializes a `value` attribute, so a typed secret lands in
 *    evidence under a key nobody thought to grep for. So when a value is typed into a field whose
 *    name matches `redact.fieldPatterns`, the driver registers the **literal** here, and every later
 *    scrub of any string removes it wherever it appears. The field-name rule is the belt; the
 *    literal registry is the braces.
 *
 * What this cannot do is stated honestly in REPORT §6: pixels are not scrubbable, which is why
 * screenshots are *suppressed* while a sensitive field holds a value (the driver's job — see
 * `SessionDriver.screenshot`) rather than redacted after the fact. And redaction is not encryption:
 * the literal is held in memory for the life of the run, which is exactly as long as it needs to be
 * scrubbed.
 */
import { namePattern, type NamePattern } from "./pattern.ts";
import type { Policy } from "./policy.ts";

/** What a scrubbed value becomes. One spelling, so a reviewer can grep evidence for it. */
export const REDACTED = "[redacted]";

/**
 * Values shorter than this are not registered as literals. The reason is not squeamishness about
 * secrets — it is that scrubbing is global: registering `"1"` would replace every `1` in every
 * evidence line, turning the log into confetti. Four characters is well below any real credential
 * and well above the length at which a substring collision becomes likely. Field-name masking still
 * applies to short values; only the literal registry is bounded.
 */
const MIN_SECRET_LENGTH = 4;

export interface RedactorOptions {
  /** Policy `redact.fieldPatterns` — field names whose values are sensitive. */
  readonly fieldPatterns: readonly string[];
  /** Policy `redact.outputIds` — the floor for output redaction (§6's precedence rule). */
  readonly outputIds?: readonly string[];
}

/**
 * The scrubber. One per run, shared by every writer — a second instance would have its own literal
 * registry and would therefore miss the values the first one saw.
 */
export class Redactor {
  readonly #fields: readonly NamePattern[];
  readonly #outputIds: ReadonlySet<string>;
  readonly #secrets: string[] = [];

  constructor(options: RedactorOptions) {
    this.#fields = options.fieldPatterns.map(namePattern);
    this.#outputIds = new Set(options.outputIds ?? []);
  }

  /** The policy's field patterns, as written — for diagnostics and the in-page field probe. */
  get fieldPatterns(): readonly string[] {
    return this.#fields.map((pattern) => pattern.source);
  }

  /** Does this field name look sensitive? The rule that decides both registration and masking. */
  matchesField(name: string | null): boolean {
    return name !== null && this.#fields.some((pattern) => pattern.matches(name));
  }

  /** How many literals are registered. Counted, never printed — the values themselves never leave. */
  get secretCount(): number {
    return this.#secrets.length;
  }

  /**
   * Remember a value that must never appear in evidence again. Called by the driver when a `type`
   * lands in a sensitive field; the value itself is used only as a search string.
   */
  noteValue(value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    if (!this.#secrets.includes(value)) this.#secrets.push(value);
  }

  /** Every registered literal, longest first, so a value containing another is replaced whole. */
  #needles(): readonly string[] {
    return [...this.#secrets].sort((left, right) => right.length - left.length);
  }

  /**
   * Scrub free text — a console render, a DOM snapshot, an error message. Used for the sinks that
   * are not JSON, which is why it is public: a text sink must not have to pretend to be structured
   * data to get scrubbed.
   */
  scrubText(text: string): string {
    let out = text;
    for (const needle of this.#needles()) {
      if (out.includes(needle)) out = out.replaceAll(needle, REDACTED);
    }
    return out;
  }

  /**
   * Scrub a payload shape: strings by literal, and any key whose name matches a field pattern
   * masked outright. Keys are kept — the field *name* is exactly what a reviewer needs to see
   * ("this line carries an SSN field"), while its contents are not.
   */
  scrub<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown, key: string | null = null): unknown {
    if (key !== null && this.matchesField(key)) return REDACTED;
    if (typeof value === "string") return this.scrubText(value);
    if (Array.isArray(value)) return value.map((entry) => this.#walk(entry));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value)) out[entryKey] = this.#walk(entryValue, entryKey);
      return out;
    }
    return value;
  }

  /**
   * The one serializer. Every structured sink in the system — `run.jsonl`, the control bus's state
   * payload, `--json` stdout — is this call. `space` is the only variation any sink needs (an
   * evidence file a human will open reads better indented); it is a parameter rather than a second
   * function so the scrub cannot be the part a caller forgets. `JSON.stringify` succeeding on
   * `undefined` is the only wrinkle: `serialize(undefined)` writes `null`, which is what a log line
   * should say.
   */
  serialize(value: unknown, space?: number): string {
    return JSON.stringify(this.scrub(value), null, space) ?? "null";
  }

  /**
   * §6's output-redaction precedence, in one place so the two declarations can never disagree: an
   * output is redacted if the artifact declares `redact: true` **or** policy `redact.outputIds`
   * names it. Artifact declaration or policy floor — both paths strip at the same serializer, and
   * a caller gets the decision rather than re-deriving it.
   */
  output(id: string, value: unknown, declared: boolean): { readonly value: unknown; readonly redacted: boolean } {
    const redacted = declared || this.#outputIds.has(id);
    return { value: redacted ? REDACTED : value, redacted };
  }

  /** Is this output id in the policy's floor list? Exposed for the preflight/§27 comparison. */
  redactsOutput(id: string): boolean {
    return this.#outputIds.has(id);
  }
}

/** The redactor a policy defines. The only supported way to build one, so config has one reader. */
export function redactorFor(policy: Policy): Redactor {
  return new Redactor({
    fieldPatterns: policy.document.redact.fieldPatterns,
    outputIds: policy.document.redact.outputIds,
  });
}
