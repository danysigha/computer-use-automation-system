/**
 * Target capture — the recording half of §4.1 ("candidate order is recorded truth").
 *
 * Given a live element, produce the ordered candidate chain to store in the artifact. Two
 * rules from the plan drive the whole design:
 *
 * 1. **A `role` candidate is emitted only when the element has an accessible name.** The
 *    fixture's Branch-code field is a real instance: a legacy input with no `label[for]`, no
 *    `aria-label`, no placeholder. Its chain honestly starts one rung down instead of
 *    pretending role/name will work at replay.
 * 2. **The recorder skips ambiguous strategies, so ambiguity never enters the artifact.** So
 *    every candidate considered here is *verified before emission*: it is resolved through
 *    the same `resolveTarget` the replay engine uses, and kept only if it lands on exactly
 *    this element. That check is what makes the accessible-name derivation below safe — the
 *    derivation is an approximation of ARIA, but a wrong guess fails to resolve and is
 *    dropped, so the worst case is a shorter chain, never a wrong one.
 */
import type { ElementHandle, Page } from "playwright";
import {
  resolveTarget,
  type CandidateRole,
  type TargetCandidate,
  type TargetDescriptor,
} from "./target.ts";

/**
 * Subset of the ARIA name-from rules that covers this surface: aria-labelledby → aria-label →
 * native label → value (submit-ish inputs) → nested img alt → title → placeholder →
 * name-from-content for roles that take it. Runs in the page.
 */
interface Described {
  role: CandidateRole | null;
  name: string;
}

function describeElement(el: Element): Described {
  const norm = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

  const explicit = norm(el.getAttribute("role")) as CandidateRole | "";
  const tag = el.tagName.toLowerCase();
  const type = norm(el.getAttribute("type")).toLowerCase();

  let role: CandidateRole | null = null;
  if (explicit !== "") {
    role = explicit;
  } else if (tag === "button") {
    role = "button";
  } else if (tag === "a" && el.hasAttribute("href")) {
    role = "link";
  } else if (tag === "select") {
    role = (el as HTMLSelectElement).multiple || el.hasAttribute("size") ? "listbox" : "combobox";
  } else if (tag === "textarea") {
    role = "textbox";
  } else if (tag === "option") {
    role = "option";
  } else if (tag === "td") {
    role = "cell";
  } else if (tag === "th") {
    role = el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
  } else if (/^h[1-6]$/.test(tag)) {
    role = "heading";
  } else if (tag === "input") {
    if (type === "checkbox") role = "checkbox";
    else if (type === "radio") role = "radio";
    else if (type === "submit" || type === "button" || type === "reset" || type === "image") role = "button";
    else if (type === "search") role = "searchbox";
    else if (type === "number") role = "spinbutton";
    else if (type === "hidden") role = null;
    else role = "textbox";
  }

  // --- accessible name -------------------------------------------------------
  const labelledBy = norm(el.getAttribute("aria-labelledby"));
  if (labelledBy !== "") {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => norm(el.ownerDocument.getElementById(id)?.textContent))
      .filter((part) => part !== "");
    if (parts.length > 0) return { role, name: parts.join(" ") };
  }

  const ariaLabel = norm(el.getAttribute("aria-label"));
  if (ariaLabel !== "") return { role, name: ariaLabel };

  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel !== null) {
      const text = norm(forLabel.textContent);
      if (text !== "") return { role, name: text };
    }
  }

  const wrappingLabel = el.closest("label");
  if (wrappingLabel !== null) {
    const text = norm(wrappingLabel.textContent);
    if (text !== "") return { role, name: text };
  }

  if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
    const value = norm((el as HTMLInputElement).value);
    if (value !== "") return { role, name: value };
  }

  const image = el.querySelector("img[alt]");
  if (image !== null) {
    const alt = norm(image.getAttribute("alt"));
    if (alt !== "") return { role, name: alt };
  }

  const title = norm(el.getAttribute("title"));
  if (title !== "") return { role, name: title };

  // Last name source before content: a textbox's placeholder is a legitimate fallback name.
  const placeholder = norm((el as HTMLInputElement).placeholder);
  if (placeholder !== "") return { role, name: placeholder };

  // Name-from-content applies to these roles only — a nameless textbox must NOT borrow the
  // text sitting beside it in the same table cell, which is exactly the legacy-control trap.
  const nameFromContent: ReadonlySet<string> = new Set([
    "button",
    "link",
    "heading",
    "cell",
    "columnheader",
    "rowheader",
    "option",
    "menuitem",
    "tab",
  ]);
  if (role !== null && nameFromContent.has(role)) {
    const text = norm(el.textContent);
    if (text !== "") return { role, name: text };
  }

  return { role, name: "" };
}

/**
 * The row-relative plan for an element sitting in a table, or `null` when it is not in one.
 * Runs in the page; returns plain data so the candidate can be built node-side.
 */
interface RowRelativePlan {
  rowText: string;
  columnText: string | null;
  action: "cell" | "button-in-row" | "link-in-row";
}

function planRowRelative(el: Element): RowRelativePlan | null {
  const norm = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

  // Mirrors `ownText` in target.ts: a cell that contains a nested table does not own that
  // table's text, and the anchor must be chosen with the same notion of "text" the resolver
  // will match against — otherwise capture picks an anchor the resolver cannot find.
  const ownText = (cell: Element): string => {
    let out = "";
    for (const node of Array.from(cell.childNodes)) {
      if (node.nodeType === 3) out += node.nodeValue ?? "";
      else if (node.nodeType === 1) {
        if ((node as Element).tagName === "TABLE") continue;
        out += node.textContent ?? "";
      }
    }
    return out;
  };

  const cell: Element | null = el.closest("td, th");
  const row = el.closest("tr");
  const table = el.closest("table");
  if (cell === null || row === null || table === null) return null;

  // How many of these cells would the *resolver* match for this text? §4.1 pins the resolver's
  // text rule to normalized whole-cell **containment**, so uniqueness has to be counted that
  // way — not by equality. The distinction is not academic: on the results page three cells
  // contain "Savings" (the grid cell, plus two Recent Activity rows that begin with it), so an
  // equality-unique anchor of "Savings" is one the resolver refuses. Capture would then drop its
  // own candidate and fall through to `css` on precisely the hostile page row-relative exists
  // for. Selecting under the resolver's own rule is what keeps the semantic rung alive.
  const occurrences = (text: string, among: readonly Element[]): number =>
    among.filter((other) => norm(ownText(other)).includes(text)).length;

  // The anchor is the first cell in this row whose text identifies the row uniquely across
  // every cell on the page — the row's identity, in the terms a human reads the grid with.
  const allCells = Array.from(document.querySelectorAll("td, th"));
  const rowCells: Element[] = Array.from(row.cells);
  let rowText: string | null = null;
  for (const candidate of rowCells) {
    const text = norm(ownText(candidate));
    if (text === "") continue;
    if (occurrences(text, allCells) === 1) {
      rowText = text;
      break;
    }
  }
  if (rowText === null) return null;

  // The column comes from the header row of the element's own (innermost) table, and is only
  // usable when that header text is itself unambiguous.
  const headerRow = table.tHead?.rows[0] ?? table.rows[0];
  const headers: Element[] = headerRow === undefined ? [] : Array.from(headerRow.cells);
  const index = rowCells.indexOf(cell);
  let columnText: string | null = null;
  if (index >= 0) {
    const headerCell = headers[index];
    const header = headerCell === undefined ? "" : norm(ownText(headerCell));
    // Same containment rule as the resolver's header lookup — see `occurrences` above.
    if (header !== "" && occurrences(header, headers) === 1) {
      columnText = header;
    }
  }

  const action: RowRelativePlan["action"] = el.matches("button, input[type=submit], input[type=button]")
    ? "button-in-row"
    : el.matches("a[href]")
      ? "link-in-row"
      : "cell";

  return { rowText, columnText, action };
}

interface CssPlan {
  selector: string;
  index: number;
}

function planCss(el: Element): CssPlan {
  // Self-contained on purpose: `element.evaluate` ships this function's *source* to the page,
  // where module scope does not exist. A helper declared at module level would throw
  // `ReferenceError` at capture time — not at import time, which is what makes it easy to miss.
  const selectorFor = (target: Element): string => {
    const id = target.getAttribute("id");
    if (id !== null && id !== "") return `#${CSS.escape(id)}`;
    const name = target.getAttribute("name");
    if (name !== null && name !== "") return `${target.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    return target.tagName.toLowerCase();
  };

  // Least positional form first: an id is stable, a `name` is stable, a bare tag is not.
  const selector = selectorFor(el);
  const matches = Array.from(el.ownerDocument.querySelectorAll(selector));
  return { selector, index: Math.max(0, matches.indexOf(el)) };
}

/**
 * Build the candidate chain for a live element, in the plan's priority order:
 * role → text → row-relative → css. Every candidate is verified against the live page and
 * dropped unless it resolves to *this* element.
 */
export async function captureTarget(
  page: Page,
  element: ElementHandle,
  framePath: readonly number[] = [],
): Promise<TargetDescriptor> {
  const considered = await buildCandidates(element);
  const verified: TargetCandidate[] = [];

  for (const candidate of considered) {
    const probe: TargetDescriptor = { candidates: [candidate], framePath };
    try {
      const resolved = await resolveTarget(page, probe);
      const same = await resolved.element.evaluate((self, other) => self === other, element);
      await resolved.element.dispose();
      if (same) verified.push(candidate);
    } catch {
      // Absent or ambiguous through this strategy — the recorder skips it (§4.1). The chain
      // simply gets shorter; it never gets a candidate that does not hold at capture time.
    }
  }

  // `css` is the floor: a chain that can always be built, and the one the plan documents as
  // drift-prone. It is appended whether or not it verified, so a recorded step is never
  // unactionable — but it is last, so it is only reached when nothing semantic held.
  const css = await element.evaluate(planCss);
  if (!verified.some((c) => c.strategy === "css")) {
    verified.push({ strategy: "css", selector: css.selector, index: css.index });
  }

  return { candidates: verified, framePath };
}

/** The unverified candidate list, in priority order. Exported for the recorder's diagnostics. */
export async function buildCandidates(element: ElementHandle): Promise<TargetCandidate[]> {
  const candidates: TargetCandidate[] = [];

  const described = await element.evaluate(describeElement);
  // Rule 1: no accessible name means no role candidate at all.
  if (described.role !== null && described.name !== "") {
    candidates.push({ strategy: "role", role: described.role, name: described.name });
  }

  const text = await element.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  if (text !== "") candidates.push({ strategy: "text", text });

  const rowPlan = await element.evaluate(planRowRelative);
  if (rowPlan !== null) {
    candidates.push({
      strategy: "row-relative",
      row: { by: "cell-text", text: rowPlan.rowText },
      ...(rowPlan.columnText === null
        ? {}
        : { column: { by: "header-text" as const, text: rowPlan.columnText } }),
      action: rowPlan.action,
    });
  }

  return candidates;
}
