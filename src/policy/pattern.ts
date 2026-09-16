/**
 * What a policy pattern means — one interpreter, three consumers (§11 P3, §5.2).
 *
 * The shipped policy spells patterns two ways, and both spellings are load-bearing:
 * `redact.fieldPatterns` writes `"password"` (a bare word), `risk.approvalRequired` writes
 * `"/password|ssn|taxid/i"` (a regex literal), and `recoverableDialogs` writes
 * `"/confirm activation of account/i"` — a literal whose slashes, read as a bare regex, are two
 * characters the app never renders. If each consumer interpreted those for itself, the risk
 * classifier and the redactor could disagree about whether a field named `taxpayerSsn` is
 * sensitive — and a disagreement like that leaks a value, which is the one thing §6's redaction
 * rule exists to prevent. So the interpretation lives here, once.
 *
 * Two rules, and one of them is a deliberate over-match:
 *
 * 1. `/body/flags` is a regex, tested as written.
 * 2. Anything else is a **fragment**, matched case-insensitively — as a name with separators removed
 *    (`namePattern`), or as prose, literally (`textPattern`). One spelling rule for both, because the
 *    operator writing the file is one person; two fragment rules, because `account_number` and
 *    `"Confirm activation of account?"` are not the same kind of string.
 *
 * The over-match direction is intentional: a fragment that matches too much gates an action behind
 * approval (safe) or redacts a harmless value (cosmetic), while a fragment that matches too little
 * either executes a risky action unattended or leaves a secret in an evidence file. Where the two
 * costs differ that much, the matcher errs toward the cheap one.
 */

/** A pattern that could not be compiled. Thrown by `parseRegexLiteral`'s callers, never returned. */
export class PatternSyntaxError extends Error {
  constructor(source: string) {
    super(`not a valid regular expression: ${source}`);
    this.name = "PatternSyntaxError";
  }
}

/** Does this string compile as a regex? Used by validation, which reports rather than throws. */
export function compilesAsRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * `/body/flags` → its parts, or `null` when the source is a bare fragment rather than a regex
 * literal. A lone `/` is a fragment, not an empty regex: the policy has no way to spell one, and
 * treating it as a regex would make `denyRoutes: ["/admin/"]` silently match nothing.
 */
export function parseRegexLiteral(source: string): { readonly body: string; readonly flags: string } | null {
  if (source.length < 3 || !source.startsWith("/")) return null;
  const closing = source.lastIndexOf("/");
  if (closing === 0) return null;
  const body = source.slice(1, closing);
  if (body === "") return null;
  return { body, flags: source.slice(closing + 1) };
}

/**
 * Separators out, case down. `account_number`, `account-number`, `Account Number` and
 * `accountNumber` all normalize to the same fragment — which is the entire point, because the
 * config is written by a human and the markup is written by a bank.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(/[\s_-]+/g, "");
}

/**
 * Would this source actually match anything? Validation asks, because a pattern that normalizes
 * away (`"___"`) or a regex that does not compile is a **fail-open** typo: a useless
 * `redact.fieldPatterns` entry leaves values in evidence, and a useless risk rule gates nothing.
 * Both are refused at load rather than discovered in a transcript.
 */
export function isUsableNamePattern(source: string): boolean {
  const literal = parseRegexLiteral(source);
  if (literal !== null) return compilesAsRegex(literal.body + literal.flags);
  return normalizeName(source) !== "";
}

/** A compiled policy pattern. */
export interface NamePattern {
  /** The source as the policy wrote it, for logs and messages. */
  readonly source: string;
  matches(name: string | null): boolean;
}

/**
 * Compile one policy pattern. A `null` name (an action with no resolved target, e.g. a navigation)
 * matches only a regex that was written to match nothing in particular — fragments never match it.
 */
export function namePattern(source: string): NamePattern {
  const literal = parseRegexLiteral(source);
  if (literal !== null) {
    if (!compilesAsRegex(literal.body + literal.flags)) throw new PatternSyntaxError(source);
    const regex = new RegExp(literal.body, literal.flags);
    return {
      source,
      // Tested against both spellings: `/tax.id/` is written for the raw name, `/ssn/` for the
      // normalized one, and a policy author should not have to know which side we normalized.
      matches: (name) => name !== null && (regex.test(name) || regex.test(normalizeName(name))),
    };
  }

  const fragment = normalizeName(source);
  return { source, matches: (name) => name !== null && fragment !== "" && normalizeName(name).includes(fragment) };
}

/** A compiled pattern for matching **prose** — a page's text, a dialog's sentence (§5.2). */
export interface TextPattern {
  /** The source as the policy wrote it, for logs and messages. */
  readonly source: string;
  matches(text: string): boolean;
}

/**
 * Compile one policy pattern for matching *prose* rather than a name.
 *
 * The spelling rule is `namePattern`'s, deliberately: both kinds are written in one file by one
 * operator, who should not have to remember which is which. `/body/flags` is a regex, tested as
 * written — which is how the shipped `recoverableDialogs` entry is spelled.
 *
 * The fragment rule is **not** `namePattern`'s, and that difference is why this is a second
 * function rather than a flag on the first. A *name* fragment drops separators and lowercases, so
 * `account_number` and `accountNumber` are one name; prose is matched literally and
 * case-insensitively, punctuation intact, because `"Confirm activation of account for member
 * 12345?"` is a sentence and not an identifier. Escaping it is what makes that true: read as a
 * regex, the `?` in a sentence would become a quantifier, and a fragment like `"100 (USD)"` would
 * be a capture group. A policy author writing a fragment means the characters they typed.
 */
export function textPattern(source: string): TextPattern {
  const literal = parseRegexLiteral(source);
  if (literal !== null) {
    if (!compilesAsRegex(literal.body + literal.flags)) throw new PatternSyntaxError(source);
    const regex = new RegExp(literal.body, literal.flags);
    return { source, matches: (text) => regex.test(text) };
  }

  const fragment = source.trim().toLowerCase();
  return { source, matches: (text) => fragment !== "" && text.toLowerCase().includes(fragment) };
}

/** Would this text pattern match anything? The dialog schema's usability check, as above. */
export function isUsableTextPattern(source: string): boolean {
  const literal = parseRegexLiteral(source);
  if (literal !== null) return compilesAsRegex(literal.body + literal.flags);
  return source.trim() !== "";
}
