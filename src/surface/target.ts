/**
 * Target resolution (§4.1) — the determinism strategy of §5.1.
 *
 * A descriptor is an ordered list of candidate strategies, tried in the order the artifact
 * recorded them. A candidate wins only if it matches **exactly one** node: N>1 matches is a
 * *no-match*, never a DOM-order pick, and the chain falls through. So the semantic strategies
 * (role / text / row-relative) are never positional; `css` is the one strategy carrying an
 * index, and it is the last resort precisely because it is the only one that can drift into
 * a different element without the markup meaning anything different.
 *
 * The types here are the canonical home of `TargetDescriptor`: the resolver needs them, and
 * P2's `src/schema/artifact.ts` validates against them rather than restating them. One
 * definition means the artifact schema and the resolver cannot disagree about what a
 * candidate is.
 */
import type { ElementHandle, Frame, Page } from "playwright";

/** ARIA roles a candidate may name. Kept to roles the fixture and a legacy console actually use. */
export type CandidateRole =
  | "button"
  | "link"
  | "textbox"
  | "searchbox"
  | "combobox"
  | "checkbox"
  | "radio"
  | "option"
  | "listbox"
  | "menuitem"
  | "tab"
  | "switch"
  | "spinbutton"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "heading";

/**
 * The same union, at runtime — for code holding a *live* role string rather than a typed one.
 *
 * The union above stays written out by hand and this list is checked against it (`satisfies` here,
 * and its converse in `schema/artifact.ts`, which builds its zod enum from this array). Two checks
 * in opposite directions are what make one list safe to share; deriving the union from the array
 * would make both vacuous and let a typo become a new role. The live-role caller is
 * `session-driver.findDialog`, which reads a dialog control's computed role off the page and has to
 * know whether the resolver can address it that way.
 */
export const CANDIDATE_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "option",
  "listbox",
  "menuitem",
  "tab",
  "switch",
  "spinbutton",
  "cell",
  "columnheader",
  "rowheader",
  "heading",
] as const satisfies readonly CandidateRole[];

const ROLE_SET: ReadonlySet<string> = new Set(CANDIDATE_ROLES);

/** Is this live role string one a `role` candidate can name? Narrows, so callers need no cast. */
export function isCandidateRole(role: string): role is CandidateRole {
  return ROLE_SET.has(role);
}

export interface RoleCandidate {
  readonly strategy: "role";
  readonly role: CandidateRole;
  readonly name: string;
}

export interface TextCandidate {
  readonly strategy: "text";
  readonly text: string;
}

/**
 * The hostile-app workhorse. Identity comes from "the row containing member X, the Balance
 * column" — how a human operator reads a grid with no stable per-cell identity.
 *
 * Pinned semantics (§4.1), implemented literally below:
 *  - the row is the nearest `<tr>` ancestor of the anchor cell, within that cell's
 *    INNERMOST table (an account grid nested inside a member row must resolve its own
 *    headers, not the outer table's);
 *  - the header row is that same table's `<thead>` if it has one, else its first `<tr>`;
 *  - text matching is normalized whole-cell containment — trim + collapse whitespace, and
 *    deliberately nothing else (no case folding: the plan pinned the normalization to
 *    whitespace, and inventing a third rule would make `text` here mean something the
 *    artifact never recorded).
 */
export interface RowRelativeCandidate {
  readonly strategy: "row-relative";
  readonly row: { readonly by: "cell-text"; readonly text: string };
  readonly column?: { readonly by: "header-text"; readonly text: string };
  readonly action: "cell" | "button-in-row" | "link-in-row";
}

export interface CssCandidate {
  readonly strategy: "css";
  readonly selector: string;
  readonly index: number;
}

export type TargetCandidate = RoleCandidate | TextCandidate | RowRelativeCandidate | CssCandidate;

export interface TargetDescriptor {
  readonly candidates: readonly TargetCandidate[];
  /** iframe index path from the top document. Absent = top document. */
  readonly framePath?: readonly number[];
}

/** What each candidate did, so `ELEMENT_NOT_FOUND` can carry expected-vs-observed (§5.3). */
export interface CandidateAttempt {
  readonly candidate: TargetCandidate;
  /** Match count; `-1` when the candidate could not be evaluated (bad selector, missing frame). */
  readonly matches: number;
}

export class ElementNotFoundError extends Error {
  readonly attempts: readonly CandidateAttempt[];
  constructor(framePath: readonly number[], attempts: readonly CandidateAttempt[]) {
    const detail = attempts.map(describeAttempt).join(", ");
    super(
      `no candidate resolved uniquely at frame [${framePath.join(".") || "top"}]: ${detail || "chain was empty"}`,
    );
    this.name = "ElementNotFoundError";
    this.attempts = attempts;
  }
}

function describeAttempt(attempt: CandidateAttempt): string {
  const outcome = attempt.matches < 0 ? "unusable" : `${attempt.matches} match(es)`;
  return `${attempt.candidate.strategy}=${outcome}`;
}

export class FramePathError extends Error {
  constructor(framePath: readonly number[], at: number) {
    super(
      `frame path [${framePath.join(".")}] is unreachable: no iframe at index ${framePath[at]} ` +
        `(frames load asynchronously; ensure the step's wait has settled)`,
    );
    this.name = "FramePathError";
  }
}

/**
 * Resolve a frame path to a Frame. Indices are positions in the parent frame's
 * `iframe` list, in document order.
 *
 * Two deliberate choices, both about agreeing with the Observer rather than about
 * convenience:
 *
 *  - **`iframe:visible`, not `iframe`.** The Observer derives paths from the accessibility
 *    tree, which omits frames that are hidden. A hidden frame is one the model can neither
 *    see nor address, so the enumerations must agree; `visible` is Playwright's own
 *    definition of what the tree would include.
 *  - **Never derived from Playwright's `ref` prefixes** (`f2e7`). Those are a counter over
 *    every frame the page has ever had, so after one navigation the *top* document itself
 *    carries an `f2`-prefixed ref. The prefix looks like a path and is not one.
 */
export async function frameAt(page: Page, framePath: readonly number[] = []): Promise<Frame> {
  let frame = page.mainFrame();
  for (let depth = 0; depth < framePath.length; depth += 1) {
    const iframes = await frame.$$("iframe:visible");
    const handle = iframes[framePath[depth] ?? -1];
    const child = handle === undefined ? null : await handle.contentFrame();
    if (child === null) throw new FramePathError(framePath, depth);
    frame = child;
  }
  return frame;
}

/** Trim + collapse whitespace. The pinned normalization (§4.1) and nothing more. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A page string, rendered for a message: quoted, with its line breaks made visible.
 *
 * It sits here next to `normalizeText` because both answer the same kind of question — what a
 * string *looks like* when it leaves the browser and becomes a sentence in a run log — and both
 * sides of the system need the same answer: the driver names the control it found, and the replay
 * engine names the text it read. Putting it in the replay layer would make `surface/` import from
 * `replay/`, which is backwards.
 *
 * Deliberately not `JSON.stringify`, which §6's one-serializer rule forbids outside the redactor
 * (`tests/unit/serialization-sinks.test.ts` scans for the call, because a payload formatter nobody
 * scrubs is how a page's text reaches a sink with a secret in it). The guard cannot tell a message
 * from a payload, and that bluntness is worth more than the characters this saves — a helper that
 * can only ever wrap one string can never grow into a sink.
 *
 * Line breaks matter more than escaping: an `observed` is one line in `run.jsonl`, so a page's text
 * containing a newline would otherwise forge a line boundary in the log.
 */
export function quote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

/** Serialized to the page by `evaluateHandle`; must not close over anything in this file. */
interface RowRelativeArgs {
  rowText: string;
  columnText: string | null;
  action: RowRelativeCandidate["action"];
}

/**
 * What the row-relative walk found.
 *
 * `observed` is the size of the candidate set at whichever stage decided the outcome. Without
 * it, an ambiguous anchor ("Savings" in three cells) and an absent one ("NoSuchAccount") both
 * collapse to an empty result, and the replay evidence for `ELEMENT_NOT_FOUND` would say the
 * same thing about two very different situations. §5.3 wants expected-vs-*observed*, so the
 * observed number has to survive the round trip.
 */
interface RowRelativeScan {
  readonly elements: Element[];
  readonly observed: number;
}

function findRowRelative(args: RowRelativeArgs): RowRelativeScan {
  const norm = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

  // A cell's *own* text — what it carries directly, not what a table nested inside it carries.
  // This is load-bearing on a page like the fixture's results view, where the account grid is
  // nested inside a cell of the outer table: that container's `textContent` includes the whole
  // grid, so a naive containment check finds the row text twice (in the real cell and in the
  // container enclosing it) and reports a spurious ambiguity.
  const ownText = (el: Element): string => {
    let out = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) out += node.nodeValue ?? "";
      else if (node.nodeType === 1) {
        if ((node as Element).tagName === "TABLE") continue; // its rows are its own
        out += node.textContent ?? "";
      }
    }
    return out;
  };

  const controlSelector = (action: RowRelativeArgs["action"]): string =>
    action === "button-in-row" ? "button, input[type=submit], input[type=button]" : "a[href]";

  const rowText = norm(args.rowText);

  // Anchors are cells whose own normalized text contains the row text. Only cells are
  // candidates, so the Recent Activity rows on the fixture's results page — which repeat
  // "Savings — 2026-08-02 — deposit — $250.00" — make this ambiguous rather than silently
  // selecting one, which is the correct outcome for text that is not actually unique.
  const anchors = Array.from(document.querySelectorAll("td, th")).filter((cell) =>
    norm(ownText(cell)).includes(rowText),
  );
  if (anchors.length !== 1) return { elements: [], observed: anchors.length };
  const anchor = anchors[0];
  if (anchor === undefined) return { elements: [], observed: 0 };

  // Nearest <tr> ancestor, and the innermost table containing the anchor. `closest` is
  // innermost by definition, which is what makes a nested grid resolve its own headers.
  const row = anchor.closest("tr");
  const table = anchor.closest("table");
  if (row === null || table === null) return { elements: [], observed: 0 };

  if (args.columnText !== null) {
    const columnText = norm(args.columnText);
    const headerRow = table.tHead?.rows[0] ?? table.rows[0];
    if (headerRow === undefined) return { elements: [], observed: 0 };
    const headers = Array.from(headerRow.cells);
    // The column name must be unambiguous in its own header row; "Balance" appearing twice
    // means this descriptor cannot say which one it meant.
    const columnIndexes = headers
      .map((cell, index) => (norm(ownText(cell)).includes(columnText) ? index : -1))
      .filter((index) => index >= 0);
    if (columnIndexes.length !== 1) return { elements: [], observed: columnIndexes.length };
    const cell = row.cells[columnIndexes[0] ?? -1];
    if (cell === undefined) return { elements: [], observed: 0 };
    const found =
      args.action === "cell" ? [cell] : Array.from(cell.querySelectorAll(controlSelector(args.action)));
    return { elements: found, observed: found.length };
  }

  // No column named: `cell` means the anchor cell itself — the row was located *by* that
  // cell's text, so it is already the thing being pointed at. Controls still search the whole
  // row, since "the link in this row" is a row-level statement.
  if (args.action === "cell") return { elements: [anchor], observed: 1 };
  const found = Array.from(row.querySelectorAll(controlSelector(args.action)));
  return { elements: found, observed: found.length };
}

export interface CandidateOutcome {
  /** Match count as observed; `-1` means the candidate could not be evaluated at all. */
  readonly matches: number;
  /** The node this candidate resolves to, or `null` when it does not resolve. */
  readonly element: ElementHandle<Element> | null;
}

/**
 * Evaluate one candidate, applying that strategy's own resolution rule.
 *
 * The rules differ, and collapsing them would be the bug: `role`/`text`/`row-relative` must
 * match **exactly one** node or they are no-match, whereas `css` carries an explicit index and
 * only needs *more matches than that index*. Requiring a single match for `css` would make the
 * documented last resort unusable on exactly the pages it exists for.
 */
export async function evaluateCandidate(frame: Frame, candidate: TargetCandidate): Promise<CandidateOutcome> {
  if (candidate.strategy === "css") {
    try {
      const matches = await frame.locator(candidate.selector).count();
      if (matches <= candidate.index) return { matches, element: null };
      const element = await frame.locator(candidate.selector).nth(candidate.index).elementHandle();
      return { matches, element: element as ElementHandle<Element> | null };
    } catch {
      return { matches: -1, element: null };
    }
  }

  if (candidate.strategy === "row-relative") {
    const handle = await frame.evaluateHandle(findRowRelative, {
      rowText: candidate.row.text,
      columnText: candidate.column?.text ?? null,
      action: candidate.action,
    });
    const count = await handle.evaluate((scan) => scan.elements.length);
    if (count !== 1) {
      const observed = await handle.evaluate((scan) => scan.observed);
      await handle.dispose();
      return { matches: observed, element: null };
    }
    const first = await handle.evaluateHandle((scan) => scan.elements[0] ?? null);
    await handle.dispose();
    return { matches: count, element: first.asElement() as ElementHandle<Element> | null };
  }

  try {
    const locator =
      candidate.strategy === "role"
        ? frame.getByRole(candidate.role, { name: candidate.name })
        : frame.getByText(candidate.text);
    const matches = await locator.count();
    if (matches !== 1) return { matches, element: null };
    const element = await locator.elementHandle();
    return { matches, element: element as ElementHandle<Element> | null };
  } catch {
    return { matches: -1, element: null };
  }
}

/** How many nodes a single candidate matches, under that strategy's own rule. */
export async function countCandidate(frame: Frame, candidate: TargetCandidate): Promise<number> {
  return (await evaluateCandidate(frame, candidate)).matches;
}

export interface ResolvedTarget {
  /** Typed `Element` rather than Playwright's `Node` default: every call site wants `getAttribute`. */
  readonly element: ElementHandle<Element>;
  readonly candidate: TargetCandidate;
  readonly framePath: readonly number[];
  /** Everything that was tried, for the run log — including the candidates that fell through. */
  readonly attempts: readonly CandidateAttempt[];
}

/**
 * Walk the chain in its recorded order and return the first candidate that resolves.
 * Never reorders, never injects a strategy, never falls back to DOM order (§5.1).
 */
export async function resolveTarget(page: Page, descriptor: TargetDescriptor): Promise<ResolvedTarget> {
  const framePath = descriptor.framePath ?? [];
  const frame = await frameAt(page, framePath);
  const attempts: CandidateAttempt[] = [];
  for (const candidate of descriptor.candidates) {
    const outcome = await evaluateCandidate(frame, candidate);
    attempts.push({ candidate, matches: outcome.matches });
    if (outcome.element !== null) {
      return { element: outcome.element, candidate, framePath, attempts };
    }
  }
  throw new ElementNotFoundError(framePath, attempts);
}

/** Does the chain resolve to exactly one node? Backs `elementExists` / `elementAbsent`. */
export async function isResolvable(page: Page, descriptor: TargetDescriptor): Promise<boolean> {
  try {
    const resolved = await resolveTarget(page, descriptor);
    await resolved.element.dispose();
    return true;
  } catch {
    return false;
  }
}
