/**
 * The action trace — what the run did, in the one form the recorder can read.
 *
 * §9 splits discovery into a loop that drives a model and a recorder that emits an artifact, and
 * this file is the boundary between them. The split is only worth having if it is a *data* boundary:
 * the loop observes and acts, and everything it learns lands here; the recorder is then a pure
 * function of this trace plus the goal's declared inputs. Nothing in the recorder looks at the page,
 * and nothing in the loop decides what the artifact will say. That is what makes a recording
 * reviewable after the fact — there is one account of the run, and the artifact is a reading of it
 * rather than a second, invisible opinion about the same page.
 *
 * Three properties carry the weight.
 *
 * 1. **A target is captured at call time.** §9: "the tool layer resolves `idx` against the live page
 *    into a full `TargetDescriptor` chain at call time". A node index is snapshot-scoped — node 7 is
 *    a different element after a navigation — so the index is not identity and never reaches the
 *    artifact. The chain captured from the element while it is live is the durable identity, and it
 *    exists only in that moment. Everything recorded after the action is a description of the
 *    *page*, never of the element that was clicked.
 *
 * 2. **Ephemeral handles are absent from every type below.** Playwright's `ref` is invalid across
 *    navigations and §9 forbids it reaching an artifact, so the trace does not carry it and nothing
 *    downstream can be tempted by it.
 *
 * 3. **The delta is recorded, not judged.** §4.2 requires every `act` to carry an `expect` derived
 *    from "the post-action state delta actually observed", and forbids recording an act with no
 *    observable delta. The loop therefore captures the delta and hands the *whole* of it to the
 *    recorder, which decides what assertion expresses it. That division is why the derivation rules
 *    read as one short priority list in `recorder.ts` instead of as a pile of special cases spread
 *    across the loop: the observations are all here, in one shape, and the decision is in one place.
 *
 * Node identity across snapshots is deliberately **`role` + `name`, as a multiset**. Indices are
 * not comparable between two snapshots (the whole reason a click can be recorded at all), so a
 * diff has to key on something that survives a re-render. Role and name are what the accessibility
 * tree gives every node, and counting occurrences rather than picking one is what keeps two
 * identically-named cells from cancelling each other out into "nothing changed".
 */
import type { Snapshot, SnapshotNode } from "../surface/observer.ts";
import type { TargetDescriptor } from "../surface/target.ts";

/** The act actions of §4.1. `press` is in the artifact vocabulary; no tool produces one today. */
export type ActAction = "click" | "type" | "select" | "press";

/** A node as the digest described it — the part of a snapshot worth keeping in a trace. */
export interface NodeDigest {
  readonly index: number | null;
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly framePath: readonly number[];
}

export function nodeDigest(node: SnapshotNode): NodeDigest {
  return { index: node.index, role: node.role, name: node.name, text: node.text, framePath: node.framePath };
}

/* -------------------------------------------------------------------------- */
/* The delta                                                                   */
/* -------------------------------------------------------------------------- */

/** One node's text, before and after. */
export interface TextChange {
  readonly node: SnapshotNode;
  readonly from: string;
  readonly to: string;
}

/**
 * What changed across one action, as node references from the two snapshots.
 *
 * The lists hold live `SnapshotNode`s rather than digests because the caller has to do one thing
 * with them that a digest cannot support: resolve the element and capture its chain while the
 * element is still there. `nodeDigest` is applied when a node is *stored*.
 */
export interface StateDiff {
  readonly urlChanged: boolean;
  readonly appeared: readonly SnapshotNode[];
  readonly disappeared: readonly SnapshotNode[];
  readonly changed: readonly TextChange[];
}

/**
 * The node the recorder may assert an appearance or a text-change on, with the chain captured while
 * it was live.
 *
 * One anchor, not a list, and that is a deliberate bound: an assertion needs a durable target, and a
 * target costs a capture against the live page. Every step therefore carries at most one captured
 * *extra* node — the acted-upon target's own chain is captured anyway — which keeps a recording's
 * cost a small constant per step rather than a function of how much the page moved.
 */
export interface DeltaAnchor {
  readonly kind: "appeared" | "changed";
  readonly node: NodeDigest;
  readonly target: TargetDescriptor;
  /** The text before, for `changed`. `null` for `appeared`. */
  readonly from: string | null;
  readonly to: string;
}

/** How much moved, for the evidence line. The lists above are the recorder's business, not a log's. */
export interface DeltaCounts {
  readonly appeared: number;
  readonly disappeared: number;
  readonly changed: number;
}

/**
 * What an action did to the page.
 *
 * `urlChanged` is separated from a URL string comparison because that is the question the recorder
 * actually asks, and asking it once here keeps two callers from disagreeing about whether a
 * `#fragment` move or a trailing-slash difference counts. It does: an assertion derived from a URL
 * that did not move is an assertion about a page the step never left.
 */
export interface StateDelta {
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly urlChanged: boolean;
  readonly counts: DeltaCounts;
  readonly anchor: DeltaAnchor | null;
}

/* -------------------------------------------------------------------------- */
/* The trace                                                                   */
/* -------------------------------------------------------------------------- */

/** Fields every entry carries. `turn` is the model turn that produced it; 0 is the bootstrap. */
interface TraceCommon {
  readonly turn: number;
}

/**
 * The bootstrap navigation. Recorded as its own kind because it is **not a step**: it is where the
 * artifact says the run starts (`surface.entry`), and re-recording it as step 1 would make every
 * replay navigate to the entry twice — once to begin, once as a step.
 */
export interface EntryTrace extends TraceCommon {
  readonly kind: "entry";
  readonly url: string;
}

/** A navigation the model chose. This one *is* a step: it is part of what the goal required. */
export interface NavigateTrace extends TraceCommon {
  readonly kind: "navigate";
  /** As the model wrote it, for the log. The artifact carries `url`. */
  readonly requested: string;
  /** Absolute, resolved against the page the model was on. */
  readonly url: string;
  readonly delta: StateDelta;
}

/**
 * An action on a captured target.
 *
 * `textBefore`/`textAfter` are the acted-upon node's own text either side of the action — the
 * observation behind the commonest derived assertion there is, a field that accepted what was typed
 * into it. `textAfter` is `null` when the node is not identifiable in the post-state (a navigation
 * replaced it, or something else now occupies its position), which is the honest answer rather than
 * a guess: a text comparison against a different element would be an assertion about the wrong node.
 */
export interface ActTrace extends TraceCommon {
  readonly kind: "act";
  readonly action: ActAction;
  /** The index the model used, for the log. Never an artifact field — see the header. */
  readonly index: number;
  readonly node: NodeDigest;
  readonly target: TargetDescriptor;
  readonly textBefore: string;
  readonly textAfter: string | null;
  /** The literal written, for `type`/`select`. Raw: whether it binds to a param or stays literal
   *  is the recorder's decision (§9's binding rule), and it needs the uncanonicalized value. */
  readonly value: string | null;
  /** Which candidate strategy actually resolved, in the run's own words (§11 P4 exit). */
  readonly resolvedBy: string;
  readonly verdict: {
    readonly rule: string;
    readonly approvalRequired: boolean;
  };
  /** True when the write landed in a field the redactor considers sensitive (§6). */
  readonly sensitive: boolean;
  readonly delta: StateDelta;
}

/**
 * A value read off the page.
 *
 * Carries the target like an act does, because a read that a goal's output names becomes an
 * `extract` step — the only step kind that produces a value — and an extract needs the same durable
 * pointer an act does.
 */
export interface ReadTrace extends TraceCommon {
  readonly kind: "read";
  readonly index: number;
  readonly node: NodeDigest;
  readonly target: TargetDescriptor;
  readonly text: string;
}

/** A deliberate pause. A step in the artifact, and the one whose `condition` is always "load":
 *  the model asks to wait for the surface to settle, never for a fixed number of milliseconds. */
export interface WaitTrace extends TraceCommon {
  readonly kind: "wait";
}

/** A capture taken for evidence. An observation, not an action — it never becomes a step. */
export interface ScreenshotTrace extends TraceCommon {
  readonly kind: "screenshot";
  readonly captured: boolean;
  /** Why it was suppressed, when it was (§6). */
  readonly note: string | null;
}

export type TraceEntry =
  | EntryTrace
  | NavigateTrace
  | ActTrace
  | ReadTrace
  | WaitTrace
  | ScreenshotTrace;

/* -------------------------------------------------------------------------- */
/* A reported output, matched to the read it came from                         */
/* -------------------------------------------------------------------------- */

/** Whitespace collapsed to single spaces and trimmed — how two renderings of one value are compared. */
export function collapse(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * The read a reported output came from, or `null` when nothing the run read contains it.
 *
 * Exact match first, then containment — because a model that reads a cell saying `Savings $1,204.55`
 * and reports `$1,204.55` has done exactly what the goal asked, and this check is about provenance
 * rather than about formatting. An empty value matches nothing: it is contained in every read there
 * is, which would make the rule vacuous at precisely the point someone was reporting nothing.
 *
 * **This lives here rather than in the loop because two callers have to agree about it.** The loop
 * asks it before `markComplete` is allowed (§9's provenance rule); the recorder asks it to decide
 * which read becomes the `extract` step an `Output.source.stepId` points at. If the two ever
 * disagreed, a run would be permitted to report a value and then be unable to record where it came
 * from — a failure at the artifact-assembly stage, after the whole run had been spent.
 */
export function matchRead(reads: readonly ReadTrace[], value: string): ReadTrace | null {
  const wanted = collapse(value);
  if (wanted === "") return null;
  return (
    reads.find((read) => collapse(read.text) === wanted) ??
    reads.find((read) => collapse(read.text).includes(wanted)) ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Diffing two snapshots                                                       */
/* -------------------------------------------------------------------------- */

function keyOf(node: SnapshotNode): string {
  return `${node.role} ${node.name}`;
}

/**
 * Partition what changed between two snapshots by node identity (see the header on role+name).
 *
 * The partition is a multiset diff, in three passes per key: counts decide appeared/disappeared,
 * and — only for keys whose counts match — a positional text comparison decides changed. The order
 * matters. Comparing texts first would report a page whose rows all shifted by one as "every row
 * changed", when what actually happened is that one row appeared and one left.
 */
export function diffStates(before: Snapshot, after: Snapshot): StateDiff {
  const byKey = (snapshot: Snapshot): Map<string, SnapshotNode[]> => {
    const index = new Map<string, SnapshotNode[]>();
    for (const node of snapshot.numbered) {
      const key = keyOf(node);
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [node]);
      else bucket.push(node);
    }
    return index;
  };

  const beforeIndex = byKey(before);
  const afterIndex = byKey(after);
  const appeared: SnapshotNode[] = [];
  const disappeared: SnapshotNode[] = [];
  const changed: TextChange[] = [];

  for (const [key, nodes] of afterIndex) {
    const prior = beforeIndex.get(key) ?? [];
    if (nodes.length > prior.length) appeared.push(...nodes.slice(prior.length));
    for (let at = 0; at < Math.min(nodes.length, prior.length); at += 1) {
      const was = prior[at];
      const now = nodes[at];
      if (was === undefined || now === undefined || was.text === now.text) continue;
      changed.push({ node: now, from: was.text, to: now.text });
    }
  }
  for (const [key, nodes] of beforeIndex) {
    const prior = afterIndex.get(key) ?? [];
    if (nodes.length > prior.length) disappeared.push(...nodes.slice(prior.length));
  }

  return { urlChanged: before.url !== after.url, appeared, disappeared, changed };
}

/** The counts the evidence line reports. */
export function deltaCounts(diff: StateDiff): DeltaCounts {
  return { appeared: diff.appeared.length, disappeared: diff.disappeared.length, changed: diff.changed.length };
}

/** Did anything observable happen? The test §4.2 uses to refuse recording a no-op act. */
export function isEmptyDelta(counts: DeltaCounts, urlChanged: boolean): boolean {
  return !urlChanged && counts.appeared === 0 && counts.disappeared === 0 && counts.changed === 0;
}

/** One line for the run log: what the action did, in the terms a reviewer reads it in. */
export function describeDelta(delta: StateDelta): string {
  const parts: string[] = [];
  if (delta.urlChanged) parts.push(`url → ${delta.afterUrl}`);
  if (delta.counts.appeared > 0) parts.push(`${delta.counts.appeared} node(s) appeared`);
  if (delta.counts.disappeared > 0) parts.push(`${delta.counts.disappeared} node(s) left`);
  if (delta.counts.changed > 0) parts.push(`${delta.counts.changed} node(s) changed text`);
  return parts.length === 0 ? "no observable change" : parts.join(", ");
}

/* -------------------------------------------------------------------------- */
/* Naming a target, for the repeat counter                                     */
/* -------------------------------------------------------------------------- */

/**
 * A target's identity, in the terms §8's repeat counter needs.
 *
 * §8 counts "the same `(action, target)` three times", and the obvious spelling — role and name —
 * is wrong in a way this fixture makes visible: a results grid carries four links all named
 * "Detail", and four clicks on four *different* rows would read as one target three times over. So
 * the identity includes the row the node sits in, as the digest renders it. That is the same
 * context a human reads the grid with ("the Detail link on the Savings row"), and it is what makes
 * "clicked the same control three times" mean a loop rather than a survey.
 *
 * The row is found by walking the snapshot tree and remembering the nearest `row` ancestor, which is
 * why this takes the tree and not just the numbered list: rows are structure, and structure is
 * exactly what the numbering discards.
 */
export function targetKeyFor(snapshot: Snapshot, index: number): string {
  const node = snapshot.numbered[index];
  if (node === undefined) return `index:${index}`;
  const row = rowContextFor(snapshot, node);
  const self = `${node.role}:${node.name}`;
  return row === null ? self : `${self} in ${row}`;
}

/** The nearest row ancestor's own numbered content, as the digest line would read it. */
function rowContextFor(snapshot: Snapshot, target: SnapshotNode): string | null {
  let found: string | null = null;
  let seen = false;

  const walk = (nodes: readonly SnapshotNode[], row: SnapshotNode | null): void => {
    for (const node of nodes) {
      if (seen) return;
      if (node === target) {
        seen = true;
        found = row === null ? null : rowContent(row);
        return;
      }
      walk(node.children, node.role === "row" ? node : row);
    }
  };

  walk(snapshot.root, null);
  return found;
}

/** A row's own nodes, excluding any nested table — the same rule the renderer uses. */
function rowContent(row: SnapshotNode): string {
  const parts: string[] = [];
  const walk = (nodes: readonly SnapshotNode[]): void => {
    for (const node of nodes) {
      if (node.role === "table") continue; // its rows are its own
      if (node.index !== null) parts.push(`${node.role}:${node.name}`);
      walk(node.children);
    }
  };
  walk(row.children);
  return parts.join("|");
}
