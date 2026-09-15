/**
 * The discovery loop (§9): observe → decide → act, until the goal is met or the run is done.
 *
 * One turn is one model call, and the shape of a turn is fixed:
 *
 * ```
 * snapshot → digest (+ screenshot) → the model chooses a tool → the stuck detector is asked
 *          → the call is carried out → the page is snapshotted again → the delta is recorded
 * ```
 *
 * Four decisions in that sequence are worth stating, because each one is a place the obvious
 * implementation is wrong.
 *
 * 1. **The snapshot is taken once and used for everything.** The digest the model reads, the index
 *    it resolves against, and the state the stuck detector hashes are all the same object. A second
 *    snapshot would be a second page, and the model's indices would address a state that no longer
 *    exists — which is what §24's "numbering never shifts" rule is written against.
 *
 * 2. **The stuck check runs before the call, not after it.** Reading it before means a call that
 *    would repeat a loop is *refused* rather than performed, so the run stops at the third identical
 *    click instead of the fourth. The counters are unaffected by the move (call *k*'s pre-state is
 *    call *k−1*'s post-state — see `StuckDetector.observe`), so this costs nothing and saves a click.
 *
 * 3. **A terminal call is not subject to the detector at all.** `markComplete` and `reportStuck` end
 *    the run; they cannot extend it, so a budget cannot bound them and a no-progress count cannot
 *    describe them. Exempting them is not an exception to the budget — it is what the budget is
 *    *for*, which is bounding a run that keeps going. The alternative throws away a finished goal
 *    because the model spent one call more than an operator's guess, and §8's budget exists to stop
 *    a runaway, not to discard an answer.
 *
 * 4. **Every other turn is counted, including a malformed one.** A turn whose arguments do not parse
 *    still cost an API call, so it is charged to the budget; otherwise a model that always emits bad
 *    JSON would loop forever on corrections, each one free.
 *
 * The loop's outcome is a trace plus an ending, and nothing here decides what the artifact will say.
 * That is `recorder.ts`'s job, and the split is what makes a recording reviewable: there is one
 * account of the run (`trace.ts`), and the artifact is a reading of it rather than a second opinion.
 *
 * **A policy block ends the run.** It is not turned into a correction the model can learn from. §5.2
 * makes `NAVIGATION_BLOCKED` a hard failure, and a model told "try something else" will probe the
 * boundary — which is precisely the behaviour the choke point exists to prevent. The rule and the
 * reason are in the run log, so a human who wants the action to have happened can widen the
 * allowlist and re-run; that is the correct direction for the decision to travel.
 */
import type { Policy } from "../policy/policy.ts";
import { checkOperation, type DriverOperation } from "../policy/risk.ts";
import { captureTarget } from "../surface/capture.ts";
import type { RenderOptions, Snapshot, SnapshotNode } from "../surface/observer.ts";
import {
  ApprovalRequiredError,
  PolicyBlockedError,
  type ApprovalRequest,
  type PolicyVerdict,
  type SessionDriver,
  type SurfaceAction,
} from "../surface/session-driver.ts";
import type { TargetDescriptor } from "../surface/target.ts";
import type { AgentBudgets, ScreenshotPolicy } from "./config.ts";
import { describeValue } from "./describe.ts";
import type { AgentDriver, TurnRecord } from "./driver.ts";
import { ObserverDriver } from "./observer-driver.ts";
import { describeStuck, stateDigest, StuckDetector, type StuckReason } from "./stuck.ts";
import { requiredIndex, requiredOutputs, requiredString, targetsANode, ToolUseError, type ToolName } from "./tools.ts";
import {
  collapse,
  deltaCounts,
  describeDelta,
  diffStates,
  isEmptyDelta,
  matchRead,
  nodeDigest,
  targetKeyFor,
  type ActAction,
  type DeltaAnchor,
  type ReadTrace,
  type StateDelta,
  type TraceEntry,
} from "./trace.ts";

/* -------------------------------------------------------------------------- */
/* What a run hands back                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How a discovery run ended — §5.3's outcome vocabulary, as far as the loop can tell.
 *
 * `stuck` and `gave-up` are deliberately separate: one is the detector concluding the run was not
 * getting anywhere, the other is the model saying so itself. They read very differently in a log
 * ("it thrashed" vs. "it told us the app has no such screen"), and collapsing them would throw away
 * the more useful of the two.
 */
export type DiscoveryEnding =
  | { readonly kind: "completed"; readonly outputs: Readonly<Record<string, string>> }
  | { readonly kind: "stuck"; readonly reason: StuckReason }
  | { readonly kind: "gave-up"; readonly reason: string }
  | { readonly kind: "escalated"; readonly reason: string; readonly request: ApprovalRequest | null }
  | { readonly kind: "blocked"; readonly verdict: PolicyVerdict }
  | { readonly kind: "failed"; readonly error: Error };

export interface DiscoveryRun {
  readonly goal: string;
  readonly model: string;
  /** Where the run started — the artifact's `surface.entry`, and not one of its steps. */
  readonly entry: string;
  /** The URL the run ended on. The recorder's fallback when no step carries a URL assertion. */
  readonly finalUrl: string;
  readonly ending: DiscoveryEnding;
  readonly trace: readonly TraceEntry[];
  /** Model turns taken. §8's budget is over tool calls; with one call per turn they coincide. */
  readonly turns: number;
}

export interface DiscoveryOptions {
  readonly driver: SessionDriver;
  readonly agent: AgentDriver;
  /** §6's policy, for the operations that do not pass through the driver's own review. */
  readonly policy: Policy;
  readonly budgets: AgentBudgets;
  /** `null` runs without vision, on the digest alone. */
  readonly screenshot: ScreenshotPolicy | null;
  readonly entry: string;
  readonly goal: string;
  readonly render?: RenderOptions;
  /** Run narration. Receives **already-scrubbed** text — the loop scrubs before calling (§6). */
  readonly onNote?: (line: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

/** Tools that end the run. See decision 3 in the header. */
const TERMINAL_TOOLS: ReadonlySet<ToolName> = new Set(["markComplete", "requestApproval", "reportStuck"]);

/**
 * The driver operation a tool performs, for the tools the driver does not review itself.
 *
 * `click`/`type`/`select`/`navigate` are reviewed inside `SessionDriver.execute`, where the resolved
 * target is in hand and a risk rule can match on what is actually about to be clicked. These four
 * never reach `execute`: they observe the page, or they wait for it, so the loop is the only thing
 * that can check them — and §6's rule is that *every* driver operation is checked somewhere. Every
 * one of them is permitted by today's policy (the read family is always safe, `wait` is listed), so
 * none can fail; the check is here so that the day one of them is gated, the loop already asks.
 */
const LOOP_CHECKED_OPERATIONS: Partial<Record<ToolName, DriverOperation>> = {
  read: "read",
  wait: "wait",
  screenshot: "screenshot",
};

/** What one call did, as the loop needs to know it. */
interface Applied {
  /** The call, rendered — the same string the log and the model's history both carry. */
  readonly call: string;
  readonly outcome: string;
  /** The trace entry the call produced, when it produced one. */
  readonly entry: TraceEntry | null;
  /** Set when the call ended the run. */
  readonly ending: DiscoveryEnding | null;
  /** What to tell the model next turn, when the call was refused rather than effective. */
  readonly correction: string | null;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryRun> {
  const { driver, agent, policy, budgets } = options;
  const redactor = driver.redactor;
  const observer = new ObserverDriver(driver, {
    render: options.render,
    screenshot: options.screenshot,
    redactor,
  });
  const detector = new StuckDetector(budgets);
  const trace: TraceEntry[] = [];
  const history: TurnRecord[] = [];

  // Stdout is a sink like any other, so the loop scrubs before it narrates rather than trusting the
  // writer to. `openai.ts`'s `onNote` is the same function with the same guarantee behind it.
  const note = (line: string): void => {
    options.onNote?.(redactor.scrubText(line));
  };

  const finish = (ending: DiscoveryEnding, turn: number): DiscoveryRun => {
    note(`discovery ended after ${turn} turn(s): ${describeEnding(ending)}`);
    return {
      goal: options.goal,
      model: agent.name,
      entry: options.entry,
      finalUrl: driver.page.url(),
      ending,
      trace,
      turns: turn,
    };
  };

  /* ------------------------------------------------------------------------ */
  /* Carrying out one call                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * index → live element → recorded target chain.
   *
   * The seam §9 names: "the tool layer resolves `idx` against the live page into a full
   * `TargetDescriptor` chain at call time". Both failure modes are `ToolUseError`s, because both are
   * things the model can act on — an index the digest does not have, and a node that left the tree
   * between the snapshot and the call are different problems with the same fix: look again.
   */
  const captureAt = async (
    snapshot: Snapshot,
    index: number,
    tool: string,
  ): Promise<{ target: TargetDescriptor; node: SnapshotNode }> => {
    const node = driver.observer.nodeAt(snapshot, index);
    if (node === null) {
      throw new ToolUseError(
        tool,
        `the digest has no node at index ${index} — indices run 0..${snapshot.numbered.length - 1}`,
      );
    }
    const element = await driver.observer.elementFor(node);
    if (element === null) {
      throw new ToolUseError(
        tool,
        `node ${index} (${node.role} ${describeValue(node.name)}) is no longer in the tree; ` +
          `observe the page again and use the index it shows you`,
      );
    }
    try {
      return { target: await captureTarget(driver.page, element, node.framePath), node };
    } finally {
      await element.dispose();
    }
  };

  /**
   * The same capture, for a node the run did not act on — the delta's anchor. Returns `null` rather
   * than throwing: an anchor is how the recorder *may* express a delta, so a node that cannot be
   * captured simply means this delta is expressed some other way, not that the step failed.
   */
  const captureNode = async (node: SnapshotNode): Promise<TargetDescriptor | null> => {
    const element = await driver.observer.elementFor(node);
    if (element === null) return null;
    try {
      return await captureTarget(driver.page, element, node.framePath);
    } catch {
      return null;
    } finally {
      await element.dispose();
    }
  };

  /**
   * The delta, from the two snapshots and the node the action addressed.
   *
   * **One anchor, and only when the URL did not move.** A capture is a round trip to the live page,
   * so making the recording's cost a function of how much the page moved would make a busy page
   * expensive to record for no benefit; and when the URL *has* moved there is nothing left for an
   * anchor to add, because the recorder's assertion is the route itself. The preference order is
   * "what appeared" over "what changed text", because an appearance is the stronger claim: it says a
   * thing was not there and now is, while a text change is a value the page might have re-rendered.
   */
  const deltaBetween = async (
    before: Snapshot,
    after: Snapshot,
    actedUpon: SnapshotNode | null,
  ): Promise<StateDelta> => {
    const diff = diffStates(before, after);
    const counts = deltaCounts(diff);
    return {
      beforeUrl: before.url,
      afterUrl: after.url,
      urlChanged: diff.urlChanged,
      counts,
      anchor: diff.urlChanged ? null : await pickAnchor(diff, actedUpon),
    };
  };

  const pickAnchor = async (
    diff: ReturnType<typeof diffStates>,
    actedUpon: SnapshotNode | null,
  ): Promise<DeltaAnchor | null> => {
    const appeared = diff.appeared[0];
    if (appeared !== undefined) {
      const target = await captureNode(appeared);
      if (target !== null) {
        return { kind: "appeared", node: nodeDigest(appeared), target, from: null, to: appeared.text };
      }
    }
    for (const change of diff.changed) {
      // The acted-upon node is skipped even when its text moved: its chain is already captured, and
      // an assertion about it is derived from `textBefore`/`textAfter` instead — one target, one
      // claim, rather than the same node described twice.
      if (change.node === actedUpon) continue;
      const target = await captureNode(change.node);
      if (target !== null) {
        return {
          kind: "changed",
          node: nodeDigest(change.node),
          target,
          from: change.from,
          to: change.to,
        };
      }
    }
    return null;
  };

  /**
   * One action that addresses a node: capture it, run it through the choke point, and record what
   * the page did about it.
   *
   * The refusal case is §4.2's: an act whose delta is empty is **not recorded**, and the model is
   * told. A step that asserts nothing cannot be replayed against anything, so recording one would
   * put a step in the artifact that verifies only that a click happened — and the model, not seeing
   * anything change, would otherwise click it again.
   */
  const act = async (
    turn: number,
    snapshot: Snapshot,
    index: number,
    tool: ToolName,
    call: string,
    build: (target: TargetDescriptor, node: SnapshotNode) => SurfaceAction,
    value: string | null,
  ): Promise<Applied> => {
    const { target, node } = await captureAt(snapshot, index, tool);
    const executed = await driver.execute(build(target, node));
    const after = await driver.snapshot();
    const delta = await deltaBetween(snapshot, after, node);

    if (isEmptyDelta(delta.counts, delta.urlChanged)) {
      return {
        call,
        outcome: "nothing on the page changed",
        entry: null,
        ending: null,
        correction:
          `the ${tool} on ${describeNode(node)} had no observable effect — the page is identical ` +
          "before and after, so there is nothing to record and nothing was recorded. Do something " +
          "different.",
      };
    }

    note(`turn ${turn}: ${call} → ${describeDelta(delta)}`);
    return {
      call,
      outcome: describeDelta(delta),
      entry: {
        kind: "act",
        turn,
        action: tool as ActAction,
        index,
        node: nodeDigest(node),
        target,
        textBefore: node.text,
        textAfter: textOfSameNode(after, node, index),
        value,
        resolvedBy: executed.resolved?.candidate.strategy ?? "unknown",
        verdict: { rule: executed.verdict.rule, approvalRequired: executed.verdict.approvalRequired },
        sensitive: executed.sensitive,
        delta,
      },
      ending: null,
      correction: null,
    };
  };

  /**
   * The whole of one tool call. Returns what happened; the loop decides what to do about it.
   *
   * A `ToolUseError` thrown from here is **not** caught here — the caller turns it into the next
   * turn's correction, which is the one thing this function cannot do for itself.
   */
  const applyCall = async (
    turn: number,
    snapshot: Snapshot,
    tool: ToolName,
    args: Record<string, unknown>,
    call: string,
  ): Promise<Applied> => {
    const operation = LOOP_CHECKED_OPERATIONS[tool];
    if (operation !== undefined) {
      const verdict = checkOperation(policy.document, operation);
      if (!verdict.allowed) {
        return { call, outcome: "refused by policy", entry: null, ending: { kind: "blocked", verdict }, correction: null };
      }
    }

    switch (tool) {
      case "navigate": {
        const requested = requiredString(tool, args, "url");
        const url = resolveNavigation(requested, snapshot.url);
        await driver.execute({ kind: "navigate", url });
        const after = await driver.snapshot();
        const delta = await deltaBetween(snapshot, after, null);
        if (isEmptyDelta(delta.counts, delta.urlChanged)) {
          return {
            call,
            outcome: "the page did not move",
            entry: null,
            ending: null,
            correction: `navigating to ${describeValue(url)} did not change the page — you are already there.`,
          };
        }
        return {
          call,
          outcome: `${describeValue(url)}: ${describeDelta(delta)}`,
          entry: { kind: "navigate", turn, requested, url, delta },
          ending: null,
          correction: null,
        };
      }

      case "click":
      case "type":
      case "select": {
        const index = requiredIndex(tool, args);
        if (tool === "click") {
          return act(turn, snapshot, index, tool, call, (target) => ({ kind: "click", target }), null);
        }
        if (tool === "type") {
          const value = requiredString(tool, args, "text");
          return act(turn, snapshot, index, tool, call, (target) => ({ kind: "type", target, value }), value);
        }
        const label = requiredString(tool, args, "label");
        return act(turn, snapshot, index, tool, call, (target) => ({ kind: "select", target, label }), label);
      }

      case "read": {
        const index = requiredIndex(tool, args);
        const { target, node } = await captureAt(snapshot, index, tool);
        // What the node *displays*, from the snapshot rather than from a second read of the live
        // DOM: the model decided to read index 12 because of what the digest said index 12 held, so
        // the value recorded has to be the one it was shown. Re-reading the element could return
        // something else, and the run would assert a value the model never saw.
        //
        // Which field holds it depends on the kind of node, and the fixture makes both cases load
        // bearing: a form control's current value is its `text` (`= "12345"` on the digest line),
        // while a static element's content is its accessible *name* — a `<td>` reads `"Savings"`
        // with an empty `text`, because the accessibility tree puts a cell's content in its name.
        // The value wins where there is one; otherwise the name is the content.
        const text = collapse(node.text !== "" ? node.text : node.name);
        if (text === "") {
          return {
            call,
            outcome: `node ${index} has no text`,
            entry: null,
            ending: null,
            correction: `node ${index} (${node.role}) shows nothing to read — read a node that displays a value.`,
          };
        }
        return {
          call,
          outcome: `read ${describeValue(text)}`,
          entry: { kind: "read", turn, index, node: nodeDigest(node), target, text },
          ending: null,
          correction: null,
        };
      }

      case "wait": {
        // A settle, never a sleep: the loop asks for the load state, and a page that is already
        // loaded returns at once. §4.1 gives the artifact's wait step `condition: "load"` for the
        // same reason — a fixed delay is a race with a number in it.
        await driver.page.waitForLoadState("load").catch(() => undefined);
        return { call, outcome: "waited for the page to settle", entry: { kind: "wait", turn }, ending: null, correction: null };
      }

      case "screenshot": {
        const result = await driver.screenshot(`turn-${String(turn).padStart(2, "0")}`);
        const captured = result.kind === "captured";
        return {
          call,
          outcome: captured ? "captured the view" : `suppressed: ${result.reason}`,
          entry: { kind: "screenshot", turn, captured, note: captured ? null : result.reason },
          ending: null,
          correction: null,
        };
      }

      case "markComplete": {
        const outputs = requiredOutputs(tool, args);
        const reads = trace.filter((entry): entry is ReadTrace => entry.kind === "read");
        const unmatched = Object.entries(outputs).filter(([, value]) => matchRead(reads, value) === null);
        if (unmatched.length > 0) {
          // §9's provenance rule, enforced while the model can still fix it. Every output becomes an
          // `extract` step pointing at where the value came from, so a value nothing was read from
          // has nowhere to point — and catching it here turns a recording that would fail later into
          // one more turn.
          const named = unmatched.map(([name, value]) => `${name} (${describeValue(value)})`).join(", ");
          return {
            call,
            outcome: "refused: outputs that were never read",
            entry: null,
            ending: null,
            correction:
              `${named} is not a value this run read. Every reported value has to come from a ` +
              "`read`, so that replay can point at where it came from. You have read: " +
              (reads.length === 0 ? "nothing yet" : reads.map((read) => describeValue(read.text)).join(", ")),
          };
        }
        return {
          call,
          outcome: `reported ${Object.keys(outputs).length} output(s)`,
          entry: null,
          ending: { kind: "completed", outputs },
          correction: null,
        };
      }

      case "requestApproval": {
        const what = requiredString(tool, args, "action");
        return {
          call,
          outcome: "escalated to a human",
          entry: null,
          ending: { kind: "escalated", reason: what, request: null },
          correction: null,
        };
      }

      case "reportStuck": {
        const reason = requiredString(tool, args, "reason");
        return {
          call,
          outcome: "gave up",
          entry: null,
          ending: { kind: "gave-up", reason },
          correction: null,
        };
      }
    }
  };

  /* ------------------------------------------------------------------------ */
  /* The run                                                                   */
  /* ------------------------------------------------------------------------ */

  try {
    // The bootstrap. Recorded as `entry` rather than as a step: it is where the artifact says the
    // run starts, and a step for it would make every replay navigate to the entry twice.
    await driver.execute({ kind: "navigate", url: options.entry });
    trace.push({ kind: "entry", turn: 0, url: options.entry });
    note(`discovery started at ${options.entry}`);
  } catch (error: unknown) {
    const ending = endingFor(error);
    if (ending !== null) return finish(ending, 0);
    throw error;
  }

  let turn = 0;
  let correction: string | null = null;

  for (;;) {
    turn += 1;

    const snapshot = await driver.snapshot();
    const observed = await observer.observe(snapshot, `turn-${String(turn).padStart(2, "0")}`);
    const state = stateDigest(snapshot);
    await driver.log({
      kind: "observation",
      step: turn,
      url: snapshot.url,
      stateDigest: state,
      digest: observed.digest,
    });

    // ---- decide ----------------------------------------------------------
    let decision;
    try {
      decision = await agent.decide({
        step: turn,
        digest: observed.digest,
        screenshot: observed.screenshot,
        screenshotNote: observed.screenshotNote,
        history,
        correction,
      });
    } catch (error: unknown) {
      if (!(error instanceof ToolUseError)) {
        const ending = endingFor(error);
        if (ending !== null) return finish(ending, turn);
        return finish({ kind: "failed", error: asError(error) }, turn);
      }
      // A call the provider could not even build still cost a turn, so it is charged like any
      // other (header, decision 4) — otherwise a model emitting bad JSON forever loops for free.
      const reason = detector.observe({ tool: error.tool, targetKey: "call", state });
      if (reason !== null) return finish({ kind: "stuck", reason }, turn);
      history.push({ step: turn, tool: error.tool, call: "(unusable)", outcome: error.message, failed: true });
      correction = error.message;
      note(`turn ${turn}: ${error.tool} call was unusable — ${error.message}`);
      continue;
    }

    correction = null;
    const call = describeCall(decision.tool, decision.arguments);
    await driver.log({ kind: "decision", step: turn, tool: decision.tool, call });

    // ---- is the run still going anywhere? --------------------------------
    if (!TERMINAL_TOOLS.has(decision.tool)) {
      const targetKey = targetKeyOf(snapshot, decision.tool, decision.arguments);
      const reason = detector.observe({ tool: decision.tool, targetKey, state });
      if (reason !== null) {
        history.push({ step: turn, tool: decision.tool, call, outcome: describeStuck(reason), failed: true });
        return finish({ kind: "stuck", reason }, turn);
      }
    }

    // ---- act -------------------------------------------------------------
    let applied;
    try {
      applied = await applyCall(turn, snapshot, decision.tool, decision.arguments, call);
    } catch (error: unknown) {
      if (!(error instanceof ToolUseError)) {
        const ending = endingFor(error);
        if (ending !== null) return finish(ending, turn);
        return finish({ kind: "failed", error: asError(error) }, turn);
      }
      // The recoverable half: a wrong index, an argument the schema refused, a call the run could
      // not carry out. Handed back as the next turn's correction rather than failing the run.
      history.push({ step: turn, tool: decision.tool, call, outcome: error.message, failed: true });
      correction = error.message;
      note(`turn ${turn}: ${call} → refused (${error.message})`);
      continue;
    }

    history.push({ step: turn, tool: decision.tool, call, outcome: applied.outcome, failed: false });
    if (applied.entry !== null) trace.push(applied.entry);
    if (applied.correction !== null) {
      note(`turn ${turn}: ${call} → ${applied.correction}`);
    } else if (applied.entry === null && applied.ending === null) {
      note(`turn ${turn}: ${call} → ${applied.outcome}`);
    }
    correction = applied.correction;

    if (applied.ending !== null) return finish(applied.ending, turn);
  }
}

/* -------------------------------------------------------------------------- */
/* Small decisions, kept where they can be read                                */
/* -------------------------------------------------------------------------- */

/**
 * What the model wrote, resolved against the page it is on.
 *
 * A non-http(s) target is refused here as a **usage** error rather than left to policy, and the
 * distinction is what keeps the two failure classes apart: `javascript:…` or `file:…` is the model
 * misreading the tool, and the fix belongs in a correction; a URL that is well-formed but off the
 * allowlist is a security event, and it stays `NAVIGATION_BLOCKED`. Letting the first fall through
 * to the second would report a typo as a policy violation, and a log full of those is a log nobody
 * reads.
 */
function resolveNavigation(requested: string, base: string): string {
  let url: URL;
  try {
    url = new URL(requested, base);
  } catch {
    throw new ToolUseError("navigate", `${describeValue(requested)} is not a URL, absolute or relative to ${base}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolUseError(
      "navigate",
      `${describeValue(requested)} resolves to a ${url.protocol} URL; only http and https can be loaded`,
    );
  }
  return url.toString();
}

/**
 * One call, rendered for the log and for the model's history.
 *
 * A value being *written* is described, never reproduced — the driver's own `describeAction` rule,
 * and here it closes an ordering hole rather than only a stylistic one: the decision line is written
 * before the action runs, and the redactor only learns a typed value when `execute` registers it. A
 * line carrying the raw value would already be on disk before anything could scrub it. The model
 * loses nothing: the value it typed is the node's own text in the very next digest.
 *
 * The rest goes through `describeValue`, so a wrong argument is *shown* to be wrong — `index` as the
 * string `"12"` reads as `"12"`, and an index that was never sent reads as `(absent)`, which is the
 * fact the model needs most often and the one `JSON.stringify` cannot express at all.
 */
export function describeCall(tool: ToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case "navigate":
      return `navigate to ${describeValue(args["url"])}`;
    case "click":
      return `click [${describeValue(args["index"])}]`;
    case "type": {
      const text = args["text"];
      const size = typeof text === "string" ? `${text.length} chars` : describeValue(text);
      return `type into [${describeValue(args["index"])}] (${size})`;
    }
    case "select":
      return `select [${describeValue(args["index"])}] labelled ${describeValue(args["label"])}`;
    case "read":
      return `read [${describeValue(args["index"])}]`;
    case "wait":
      return "wait";
    case "screenshot":
      return "screenshot";
    case "markComplete": {
      const outputs = args["outputs"];
      const names =
        outputs !== null && typeof outputs === "object" && !Array.isArray(outputs) ? Object.keys(outputs) : [];
      return `markComplete with ${names.length} output(s)${names.length === 0 ? "" : `: ${names.join(", ")}`}`;
    }
    case "requestApproval":
      return `requestApproval: ${describeValue(args["action"])}`;
    case "reportStuck":
      return `reportStuck: ${describeValue(args["reason"])}`;
  }
}

/**
 * The key §8's repeat counter compares, for the call about to be made.
 *
 * A node-addressing tool keys on the target's identity *including the row it sits in*, which is what
 * keeps four clicks on four "Detail" links in a results grid from reading as one target clicked four
 * times — see `targetKeyFor`. Everything else keys on the page as a whole, because that is what it
 * addresses: three `wait`s in a row are three waits, whatever the model hoped would change.
 */
function targetKeyOf(snapshot: Snapshot, tool: ToolName, args: Record<string, unknown>): string {
  if (!targetsANode(tool)) return "page";
  const index = args["index"];
  return typeof index === "number" ? targetKeyFor(snapshot, index) : "page";
}

/** The acted-upon node's text after the action, when it is still the same node; `null` otherwise. */
function textOfSameNode(after: Snapshot, node: SnapshotNode, index: number): string | null {
  const now = after.numbered[index];
  if (now === undefined) return null;
  // Matched by index *and* identity: a re-render that put a different control at the same position
  // would otherwise have its text recorded as this node's, which is an assertion about the wrong
  // element — the failure mode `textAfter`'s `null` exists to avoid.
  if (now.role !== node.role || now.name !== node.name) return null;
  return now.text;
}

/** A node as a sentence reads it: role and accessible name, with a nameless node still named. */
function describeNode(node: SnapshotNode): string {
  return node.name === "" ? `the ${node.role}` : `the ${node.role} ${describeValue(node.name)}`;
}

/**
 * The ending an exception implies, or `null` when it implies none — a bug is not an outcome, and
 * `loop.ts` must not present one to a reader as though it were.
 */
function endingFor(error: unknown): DiscoveryEnding | null {
  if (error instanceof PolicyBlockedError) return { kind: "blocked", verdict: error.verdict };
  if (error instanceof ApprovalRequiredError) {
    return { kind: "escalated", reason: error.message, request: error.request };
  }
  return null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeEnding(ending: DiscoveryEnding): string {
  switch (ending.kind) {
    case "completed":
      return `completed with ${Object.keys(ending.outputs).length} output(s)`;
    case "stuck":
      return `stuck — ${describeStuck(ending.reason)}`;
    case "gave-up":
      return `the model reported it could not proceed: ${ending.reason}`;
    case "escalated":
      return `escalated for approval: ${ending.reason}`;
    case "blocked":
      return `blocked by policy (${ending.verdict.rule}): ${ending.verdict.reason}`;
    case "failed":
      return `failed: ${ending.error.message}`;
  }
}
