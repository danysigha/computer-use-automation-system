/**
 * An arbitrary value, rendered small for a sentence.
 *
 * This is a **display formatter, not a serializer**: it produces a fragment meant to be read inside
 * a message, never a payload meant to be parsed back. It is the same class of function as the
 * driver's hand-written `describeAction`, and it exists for the reason that one does.
 *
 * The obvious implementation is `JSON.stringify`, and it is wrong twice over here. It is forbidden
 * outside `policy/redact.ts` — §6's one-formatter rule, enforced structurally by
 * `tests/unit/serialization-sinks.test.ts`, on the grounds that one formatter for run data means one
 * place for the scrub to live. And it is the wrong tool for this job regardless:
 * `JSON.stringify(undefined)` is `undefined` rather than a string, so the message would read `got
 * undefined` at best and interpolate a non-string at worst — while **an argument the model never
 * sent** is the single most common thing these messages have to name. `describeValue(undefined)`
 * says `(absent)`, which is the fact the model needs in order to fix its call.
 *
 * Two properties are deliberate:
 *
 * 1. **It is lossy.** A wrong argument is described, not reproduced: `an array of 3` rather than its
 *    contents. The messages built from it are shown to the model and written to the run log, and a
 *    value quoted back at length is a value echoed into a sink for no diagnostic gain — the model
 *    already knows what it sent, and a reviewer needs to know *what was wrong with it*, not read it
 *    again. The uniform 120-character cap is here so a reader learns the bound once, rather than
 *    per call site.
 * 2. **It does not scrub.** Nothing here knows a redactor exists; the caller that owns the sink
 *    (`loop.ts` for a correction, the run's writer for a note) scrubs the finished sentence like any
 *    other text (§6). Scrubbing *inside* would need a redactor threaded through five pure argument
 *    checks in `tools.ts`, which is a larger coupling than the leak it would close — and the leak
 *    only exists at a sink, which is where the scrub belongs anyway.
 */

const MAX_LENGTH = 120;

/** Whitespace is collapsed before clipping: these fragments land in single-line messages. */
function clip(text: string): string {
  const flattened = text.replaceAll(/\s+/g, " ");
  return flattened.length <= MAX_LENGTH ? flattened : `${flattened.slice(0, MAX_LENGTH)}…`;
}

export function describeValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "null";
  if (typeof value === "string") return `"${clip(value)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return `an array of ${value.length}`;

  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 0 ? "an empty object" : `an object with keys ${clip(keys.join(", "))}`;
}
