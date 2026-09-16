/**
 * The Observer — §8's "shared service, not a discovery-only helper", under §24's pin.
 *
 * One snapshot model feeds three consumers: the discovery agent's turn digest, replay-time
 * escalation, and the operator console. §24 separates what genuinely must be shared from what
 * never needed to be:
 *
 *  - **Shared:** the snapshot model and its numbering. Node indices are computed over the
 *    *full* interactable set at snapshot time, so they are identical in every rendering.
 *  - **Not shared:** the rendering. The model's digest is size-capped (§9) because context is
 *    expensive; the console renders unsummarized on demand because a human called in
 *    precisely because the automation was stuck should not inherit its blind spot.
 *
 * Truncation is therefore display-only: it can hide a row from a *rendering*, never renumber
 * one. `expand` on the console side adds nodes at their true indices and shifts nothing —
 * which is what makes a command typed from the compact view still mean the same element after
 * expansion (§24 nit 2, a mis-targeted action in a banking app).
 *
 * Indices are 0-based and contiguous: `numbered[i].index === i`, so the number the model sees
 * in the digest is literally the argument it passes back.
 */
import { createHash } from "node:crypto";
import type { ElementHandle, Page } from "playwright";

/** Roles that are actionable — the model may click/type/select them. */
export const INTERACTABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "option",
  "tab",
]);

/** Roles that are readable — extract targets and the grid anchors `row-relative` needs. */
export const READABLE_ROLES: ReadonlySet<string> = new Set([
  "cell",
  "columnheader",
  "rowheader",
  "heading",
]);

export function isNumbered(role: string): boolean {
  return INTERACTABLE_ROLES.has(role) || READABLE_ROLES.has(role);
}

export interface SnapshotNode {
  /** Position in the full interactable set. `null` for structure (tables, rows, containers). */
  readonly index: number | null;
  readonly role: string;
  readonly name: string;
  /** Static text, or a form control's current value. */
  readonly text: string;
  readonly url: string | null;
  /** iframe index path from the top document. */
  readonly framePath: readonly number[];
  /**
   * Playwright's snapshot-scoped handle for this node, or `null` if the tree carried none.
   * Ephemeral by design — see `elementFor` for what it may and may not be used for.
   */
  readonly ref: string | null;
  /** State flags the browser reported: disabled, checked, selected, expanded, … */
  readonly state: readonly string[];
  readonly children: readonly SnapshotNode[];
}

export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly root: readonly SnapshotNode[];
  /** The numbered set in index order; `numbered[i].index === i`. */
  readonly numbered: readonly SnapshotNode[];
  readonly frameCount: number;
}

export interface ObserverOptions {
  /**
   * Data rows rendered per table before the compact digest summarizes the rest. A rendering
   * budget only — it never affects numbering (§24). Tests shrink it to exercise truncation
   * on the fixture's real tables.
   */
  readonly maxTableRows: number;
  /** Per-line cap on static text, so one long paragraph cannot dominate the digest. */
  readonly maxTextLength: number;
}

export const DEFAULT_OBSERVER_OPTIONS: ObserverOptions = { maxTableRows: 20, maxTextLength: 100 };

export interface RenderOptions {
  /** `compact` (the model's digest) summarizes large tables; `expanded` (the console) does not. */
  readonly mode?: "compact" | "expanded";
}

/** The a11y-snapshot node shape, as documented for `ariaSnapshotJSON`. */
interface RawNode {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly url?: string;
  readonly ref?: string;
  readonly cursor?: string;
  readonly children?: readonly RawNode[];
  readonly [key: string]: unknown;
}

const STATE_FLAGS = ["checked", "disabled", "expanded", "pressed", "selected", "active", "invalid", "level"] as const;

export class Observer {
  readonly #page: Page;
  readonly #options: ObserverOptions;

  constructor(page: Page, options: Partial<ObserverOptions> = {}) {
    this.#page = page;
    this.#options = { ...DEFAULT_OBSERVER_OPTIONS, ...options };
  }

  get options(): ObserverOptions {
    return this.#options;
  }

  /**
   * Build the snapshot model. Frames come inlined by `ariaSnapshotJSON`, so a nested document
   * is walked in place rather than fetched separately — the path is derived from each
   * `iframe` node's position among its siblings in the same document.
   *
   * That derivation is the reason `frameAt()` enumerates `iframe:visible`: a frame hidden from
   * the accessibility tree cannot be addressed by the model either, so the two enumerations
   * have to agree. The unit suite pins that agreement against the fixture's real frames.
   */
  async snapshot(): Promise<Snapshot> {
    const raw = (await this.#page.ariaSnapshotJSON({ mode: "ai" })) as readonly RawNode[];
    const numbered: SnapshotNode[] = [];
    const frameCursors = new Map<string, number>();

    const build = (nodes: readonly RawNode[], framePath: readonly number[]): SnapshotNode[] =>
      nodes.map((node) => {
        const role = node.role ?? "generic";
        let children: SnapshotNode[] = [];
        let childPath = framePath;

        if (role === "iframe") {
          // Index among this document's iframes, in document order.
          const key = framePath.join(".");
          const next = frameCursors.get(key) ?? 0;
          frameCursors.set(key, next + 1);
          childPath = [...framePath, next];
        }

        children = build(node.children ?? [], childPath);

        const built: SnapshotNode = {
          index: isNumbered(role) ? numbered.length : null,
          role,
          name: typeof node.name === "string" ? node.name : "",
          text: typeof node.text === "string" ? node.text : "",
          url: typeof node.url === "string" ? node.url : null,
          // An `iframe` node describes the document it hosts, so it carries the child path —
          // that is the path a consumer would pass to `frameAt` to reach what it contains.
          framePath: role === "iframe" ? childPath : framePath,
          ref: typeof node.ref === "string" ? node.ref : null,
          state: STATE_FLAGS.filter((flag) => node[flag] === true).map(String),
          children,
        };
        if (built.index !== null) numbered.push(built);
        return built;
      });

    return {
      url: this.#page.url(),
      title: await this.#page.title(),
      root: build(raw, []),
      numbered,
      frameCount: frameCursors.size,
    };
  }

  /** Node lookup by the index the model or the console used. */
  nodeAt(snapshot: Snapshot, index: number): SnapshotNode | null {
    return snapshot.numbered[index] ?? null;
  }

  /**
   * The element a node addresses, right now — which is what makes §24 pin 1 real rather than
   * notional. A node the compact digest truncated away is still reachable: the console can
   * resolve it and act on it, without the model having paid context for it.
   *
   * The `ref` behind this is deliberately **not durable**, and must never reach an artifact.
   * Playwright invalidates it across navigations, and it fails loudly when it does (it throws
   * rather than silently resolving to whatever now occupies that position — the failure mode
   * we could not otherwise distinguish). Durable identity is the candidate chain in
   * `target.ts`; this is the address for the session that produced the snapshot.
   */
  async elementFor(node: SnapshotNode): Promise<ElementHandle<Element> | null> {
    if (node.ref === null) return null;
    try {
      const locator = this.#page.locator(`aria-ref=${node.ref}`);
      if ((await locator.count()) === 0) return null;
      return (await locator.first().elementHandle()) as ElementHandle<Element> | null;
    } catch {
      return null; // navigated away, or the node left the tree — caller re-snapshots
    }
  }

  /** Render the model's digest (`compact`) or the console's unsummarized view (`expanded`). */
  render(snapshot: Snapshot, options: RenderOptions = {}): string {
    const mode = options.mode ?? "compact";
    const lines: string[] = [`# ${snapshot.title || "(untitled)"} — ${snapshot.url}`];
    this.#renderNodes(snapshot.root, 0, lines, mode);
    if (lines.length === 1) lines.push("(no interactable nodes)");
    return lines.join("\n");
  }

  #renderNodes(nodes: readonly SnapshotNode[], depth: number, out: string[], mode: "compact" | "expanded"): void {
    for (const node of nodes) {
      switch (node.role) {
        case "iframe":
          // The path printed is the one that reaches the frame's *contents*, so the line is a
          // usable address rather than a label for the element that embeds it.
          out.push(`${pad(depth)}frame [${node.framePath.join(".")}]`);
          this.#renderNodes(node.children, depth + 1, out, mode);
          break;
        case "table":
          this.#renderTable(node, depth, out, mode);
          break;
        case "rowgroup":
          // Grouping is a rendering detail; `#renderTable` already collects rows through it.
          this.#renderNodes(node.children, depth, out, mode);
          break;
        case "row":
          // A row reached outside a table (no table ancestor in the tree) still reads as one
          // line, so a grid row means the same thing whichever path the renderer took to it.
          out.push(`${pad(depth)}${describeNodes(ownNodes(node))}`);
          for (const nested of nestedTables(node)) this.#renderTable(nested, depth + 1, out, mode);
          break;
        case "text":
          break; // static fragments are represented by their parent's `text`
        default:
          if (node.index !== null && isWorthShowing(node)) {
            out.push(`${pad(depth)}${describeNode(node)}`);
            this.#renderNodes(node.children, depth + 1, out, mode);
          } else if (node.children.length > 0) {
            // Nameless structure is transparent: it adds no line, but never hides what it holds.
            this.#renderNodes(node.children, depth, out, mode);
          } else if (node.text !== "") {
            out.push(`${pad(depth)}text "${truncate(node.text, this.#options.maxTextLength)}"`);
          }
          break;
      }
    }
  }

  #renderTable(table: SnapshotNode, depth: number, out: string[], mode: "compact" | "expanded"): void {
    const rows = collectRows(table);
    out.push(`${pad(depth)}table (${rows.length} row${rows.length === 1 ? "" : "s"})`);

    // A row with nothing to show is not rendered and does not spend budget. The fixture's forms
    // put an empty spacer row between the input and the submit button; letting that row eat a
    // slot would hide the button from the digest while showing the model nothing in return.
    const renderable = rows.filter((row) => ownNodes(row).length > 0 || nestedTables(row).length > 0);

    // The first row is shown whatever the budget allows. On the grid it is the header that makes
    // every other row readable; on a layout table it is the row carrying the panel headings; on
    // a form it is the row holding the first field. It is a digest heuristic, not a claim about
    // `<thead>` — and like every other truncation here it is display-only (§24).
    const budget = mode === "expanded" ? renderable.length : this.#options.maxTableRows;
    const shown = renderable.slice(0, 1 + budget);
    for (const row of shown) {
      const own = ownNodes(row);
      if (own.length > 0) out.push(`${pad(depth + 1)}${describeNodes(own)}`);
      for (const nested of nestedTables(row)) this.#renderTable(nested, depth + 2, out, mode);
    }

    const hidden = renderable.slice(1 + budget);
    if (hidden.length > 0) {
      // Naming the hidden index range is what lets the console's `expand` be additive: the rows
      // are addressable before they are visible, and they keep the indices they have.
      const indices = hidden.flatMap((row) => numberedIn(row));
      const range = indices.length === 0 ? "" : ` (nodes ${Math.min(...indices)}–${Math.max(...indices)})`;
      out.push(`${pad(depth + 1)}… ${hidden.length} more row(s) hidden${range} — expand to view`);
    }
  }
}

/**
 * §8's state hash: the url plus every numbered node's `role name text`, over the snapshot's own
 * numbering.
 *
 * It lives here, beside the model it hashes, because **three** consumers now need it and they are two
 * different layers: the discovery loop's stuck detector (§8's no-progress counter) and replay's resume
 * decision (§8's "the state is unchanged from escalation"). Computing it in the agent layer would mean
 * the engine importing the agent to ask a question about a snapshot — the coupling §3's "one observer
 * model, three consumers" exists to prevent.
 *
 * It hashes the **model**, never a rendering: the digest string a model reads is size-capped and its
 * rows elided (§24), so a page that grew past the cap would hash the same while genuinely changing —
 * and the resume decision would call a moved page unchanged, which is the one mistake it must not
 * make. Hashing the numbered nodes keeps the rule independent of a display policy, which is §24's own
 * separation applied to one more consumer.
 *
 * Values are in the hash on purpose: a textbox's current value is part of the state, so typing into a
 * field that then shows the typed value is progress, and typing into a field that swallows it is not.
 * In P6 that same fact is what makes a *partial* human type visible to the resume decision at all.
 */
export function stateDigest(snapshot: Snapshot): string {
  const parts = [snapshot.url];
  for (const node of snapshot.numbered) {
    // NUL-joined, not space-joined, because the fields are free text: `["a b", "c"]` and `["a", "b c"]`
    // are different pages, and a separator a value can contain would hash them the same. Written as an
    // escape rather than a literal byte so this file stays text — a raw NUL in a source file makes git
    // call it binary and hides every diff of it.
    parts.push(`${node.role}\u0000${node.name}\u0000${node.text}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function describeNode(node: SnapshotNode): string {
  const parts = [`[${node.index ?? "-"}]`, node.role];
  if (node.name !== "") parts.push(`"${truncate(node.name, 80)}"`);
  if (node.text !== "" && node.text !== node.name) parts.push(`= "${truncate(node.text, 80)}"`);
  if (node.url !== null) parts.push(`→ ${node.url}`);
  if (node.state.length > 0) parts.push(`[${node.state.join(",")}]`);
  return parts.join(" ");
}

function describeNodes(nodes: readonly SnapshotNode[]): string {
  return nodes.map((node) => describeNode(node)).join(" | ");
}

/**
 * Does this node earn a slot in a line?
 *
 * Anything labelled does. So does a nameless *control* — the fixture's Branch-code field is
 * nameless and the agent still has to find and fill it, so dropping it would hide a real
 * affordance. A nameless structural cell, by contrast, is pure noise: the thing inside it
 * (a link, a control) gets its own slot.
 */
function isWorthShowing(node: SnapshotNode): boolean {
  if (node.name !== "" || node.text !== "" || node.url !== null) return true;
  return INTERACTABLE_ROLES.has(node.role);
}

/** Rows belonging to this table — a nested table's rows belong to *it*, not to this one. */
function collectRows(table: SnapshotNode): SnapshotNode[] {
  const rows: SnapshotNode[] = [];
  const walk = (node: SnapshotNode): void => {
    for (const child of node.children) {
      if (child.role === "row") rows.push(child);
      else if (child.role === "table") continue;
      else walk(child);
    }
  };
  walk(table);
  return rows;
}

function nestedTables(node: SnapshotNode): SnapshotNode[] {
  const tables: SnapshotNode[] = [];
  const walk = (current: SnapshotNode): void => {
    for (const child of current.children) {
      if (child.role === "table") tables.push(child);
      else walk(child);
    }
  };
  walk(node);
  return tables;
}

/** The numbered nodes a row or table owns directly — excluding anything in a nested table. */
function ownNodes(row: SnapshotNode): SnapshotNode[] {
  const own: SnapshotNode[] = [];
  const walk = (node: SnapshotNode): void => {
    for (const child of node.children) {
      if (child.role === "table") continue;
      if (child.index !== null) {
        if (isWorthShowing(child)) own.push(child);
        walk(child); // still descend: a named cell can hold the actual control
      } else {
        walk(child);
      }
    }
  };
  walk(row);
  return own;
}

function numberedIn(node: SnapshotNode): number[] {
  const indices: number[] = [];
  const walk = (current: SnapshotNode): void => {
    if (current.index !== null) indices.push(current.index);
    for (const child of current.children) walk(child);
  };
  for (const child of node.children) walk(child);
  return indices;
}
