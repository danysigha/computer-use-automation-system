/**
 * Canonicalization (§28) — the record-time rule that makes an artifact portable, and the two
 * variable syntaxes it is allowed to write.
 *
 * §28's finding was that §7 had claimed cross-tenant reuse for three gates while **nothing in the
 * plan wrote a pattern anywhere**: the binding rule substituted declared param samples, but no
 * assertion kind could read a pattern, so there was nowhere for a canonical form to live. Two
 * spellings fixed that, and this file is the only place either is produced:
 *
 *   `{param}`  — the caller's declared input, interpolated. A literal that *contains* a declared
 *                param's sample becomes this, so a recorded route reads `/member/{memberId}` and
 *                never carries the sample id.
 *   `:name`    — any single non-empty segment, matched by shape. A route assertion derived from a
 *                URL is written this way (`/member/:id/summary`) so it stays true for a different
 *                id — which is the difference between a route checkpoint and a recording of one
 *                particular run.
 *
 * **Two syntaxes, one meaning each** — that sentence is owed to the reader (REPORT §2) because the
 * alternative reading, that they are two ways to write one thing, is exactly the drift §28 was
 * fixing. `{param}` binds *this caller's value*; `:name` binds *any value of this shape*.
 *
 * Three boundaries are deliberate, and they are the whole of the "deliberately not changed" half of
 * §28:
 *
 * 1. **Model-chosen values stay literal.** A value the model decided — an account type, a product
 *    pick, an id nobody declared — is never laundered into a placeholder, because the artifact is
 *    supposed to record what the model decided. Binding those would destroy the parameterization
 *    *proof* rather than serve it: a replay with a different member id must be a different id, not
 *    a rewritten constant.
 * 2. **Canonicalization reaches exactly the fields the schema scans for placeholders.** That set is
 *    not a judgement call, it is `validate.ts`'s: `surface.entry`, `steps[].url`, `steps[].value`,
 *    every assertion literal, and `outcomes[].message`. A **target descriptor is not on that list**
 *    and is never rewritten — its strings are identity captured from the live DOM, so substituting
 *    inside one would produce a `{memberId}` that no resolver can find. The rule and its boundary
 *    are the same rule: a field is canonicalizable iff a placeholder in it resolves.
 * 3. **Substitution is substring-based, and over-binding is possible.** §28 says "a literal
 *    *containing* a declared param's sample", so that is what this does — a `--param amount=100`
 *    will bind the `100` inside `$100.00`. Every substitution is therefore recorded
 *    (`BindingLog.entries` → `run.jsonl`) so a mis-binding is reviewable and correctable in the
 *    human review pass rather than silent. That reconciliation is §28's own answer to this hazard,
 *    and it is why the log is part of the deliverable rather than a debugging aid.
 */
import { placeholdersIn } from "../schema/artifact.ts";

/** A goal input as the CLI received it: the name it binds to, and the sample the operator supplied. */
export interface ParamSample {
  readonly name: string;
  readonly value: string;
}

/** One substitution, for the reconciliation log. */
export interface BindingEntry {
  /** Dotted path into the artifact (`steps.2.value`, `outcomes.0.message`). */
  readonly field: string;
  readonly param: string;
  /** The sample that was found, recorded so a reviewer can judge whether the bind was intended. */
  readonly sample: string;
  readonly result: string;
}

/** `[param]` names in the URL's path, plus the rest. */
const PLACEHOLDER_RUN = /\{[A-Za-z_][A-Za-z0-9_-]*\}/g;

/**
 * A path segment that identifies an entity rather than a route: all digits/signs (a member number,
 * a date), a UUID, or a long hex string. The length floor on the numeric case is the one heuristic
 * here, and it is aimed at the failure that costs more: mistaking `/v2/` or `/step/1/` for a
 * variable would make the assertion *weaker* (it would pass on a wrong page), while requiring three
 * digits only risks leaving a genuine two-character key literal — which fails loudly at replay
 * rather than passing quietly.
 */
function isEntitySegment(segment: string): boolean {
  if (/^[0-9][0-9-]{2,}$/.test(segment)) return true; // 12345, 2026-08-02
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
  return false;
}

/**
 * The route pattern for a URL, or `null` when it would contain no variable segment at all.
 *
 * `null` is the vacuity rule (§28 nit 3) reaching the producer rather than only the validator: a
 * pattern like `/search` asserts nothing `urlContains` would not, so validate would reject it, and
 * the recorder would be emitting an artifact it knows is invalid. The caller's answer is the one
 * validate's message names — write `urlContains` instead — and answering it here means the emitted
 * artifact never depends on a rejection to be well-formed.
 *
 * **The query string is dropped, not patternized.** A route literal is about *where* the run went,
 * and the path is the part of that with a stable shape; a query can be patternized only by deciding
 * which of its parameters vary, which is a claim about the app's intentions rather than about what
 * was observed. The consequence is real and small: `/search?memberId=12345` yields
 * `urlContains: "/search"`, which is a weaker checkpoint than the deep link's `urlMatches`. It is
 * also true, and replay's step-level `expect` is the backstop the plan names for exactly this.
 */
export function routePattern(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = pathname.split("/").filter((segment) => segment !== "");
  let variables = 0;
  const pattern = segments.map((segment) => {
    if (!isEntitySegment(segment)) return segment;
    variables += 1;
    // Positional labels, not backreferences: §28's `:name` matches any single non-empty segment,
    // so `:id` and `:id2` are names for two different positions rather than an equality
    // constraint between them. Numbering them keeps a variable segment from ever looking like the
    // `{param}` spelling of a caller's input — the confusion the two-syntax rule exists to prevent.
    return variables === 1 ? ":id" : `:id${variables}`;
  });

  return variables === 0 ? null : `/${pattern.join("/")}`;
}

/**
 * The binding rule (§28 rule 1), with its reconciliation log.
 *
 * One instance per recording. Every emitted string field the schema scans for placeholders is
 * passed through `text()` with the path it occupies, so the log is a complete account of what the
 * recorder decided — which is what makes the review pass a *review* rather than a re-derivation.
 */
export class BindingLog {
  readonly #params: readonly ParamSample[];
  readonly #entries: BindingEntry[] = [];

  constructor(params: readonly ParamSample[]) {
    // Longest sample first, so a param whose sample contains another's (`12345` / `1234`) binds
    // whole instead of leaving a fragment of itself behind.
    this.#params = [...params]
      .filter((param) => param.value !== "")
      .sort((left, right) => right.value.length - left.value.length);
  }

  get entries(): readonly BindingEntry[] {
    return this.#entries;
  }

  /** Does any declared input's sample appear in this value? Asked *before* canonicalizing, by the
   *  recorder, when it needs to know whether a step carries the caller's input at all. */
  contains(value: string): boolean {
    return this.#params.some((param) => value.includes(param.value));
  }

  /**
   * Canonicalize one field, recording every substitution.
   *
   * The string is walked in runs so that text already inside a `{placeholder}` is never rewritten —
   * without that, a param named `id` with the sample `"id"` would corrupt `{memberId}` into
   * `{member{id}}`, which is the kind of bug that only shows up on somebody else's deployment.
   */
  text(field: string, value: string): string {
    PLACEHOLDER_RUN.lastIndex = 0;
    let out = "";
    let cursor = 0;

    const substitute = (literal: string): string => {
      let replaced = literal;
      for (const param of this.#params) {
        if (!replaced.includes(param.value)) continue;
        replaced = replaced.replaceAll(param.value, `{${param.name}}`);
        this.#entries.push({ field, param: param.name, sample: param.value, result: replaced });
      }
      return replaced;
    };

    for (const match of value.matchAll(PLACEHOLDER_RUN)) {
      const at = match.index;
      out += substitute(value.slice(cursor, at)) + match[0];
      cursor = at + match[0].length;
    }
    out += substitute(value.slice(cursor));
    return out;
  }

  /**
   * The placeholders a canonicalized value carries. Used by the recorder to check its own output
   * against `validate.ts`'s rule rather than to re-implement it: a `{name}` here that is not a
   * declared input is a recording bug, and the recorder fails on it before the store ever sees it.
   */
  placeholders(value: string): readonly string[] {
    return placeholdersIn(value);
  }
}
