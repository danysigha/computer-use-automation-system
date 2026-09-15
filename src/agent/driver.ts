/**
 * The `AgentDriver` seam (§9) — what the loop asks for a decision, and the whole of what a provider
 * has to supply.
 *
 * The interface is one method wide, and that width is the design. Everything else the loop does —
 * observing the page, resolving an index into a durable target, checking the policy choke point,
 * counting the budget, recording the trace — is the system's behaviour and must not vary when the
 * model changes. A provider that could reach the page would make every one of those properties
 * provider-dependent, and §9's "if keys change, the seam is one implementation file" would stop
 * being true the moment somebody implemented the interface honestly.
 *
 * **A turn is a description, not a conversation.** The loop builds each turn from scratch — the
 * digest of the page as it is now, the history of what has been done, the correction owed from the
 * last call — and the provider answers with one tool call. There is no server-side conversation
 * state (`previous_response_id`) and no accumulated message array, for two reasons: a run has to be
 * reconstructable from its evidence alone, and a model that misbehaves on turn 14 should be
 * debuggable by reading turn 14's input, which exists in `run.jsonl`.
 *
 * **History is text; only the current observation is an image.** Re-sending every screenshot would
 * make a long run's cost grow quadratically in exactly the currency §9 is trying to save, and it
 * would spend it on stale pictures: the page as it was ten turns ago is not evidence about the
 * decision in front of the model. The digest of a past turn is cheap, and it is what the model
 * actually reasoned from. `screenshotNote` exists so that a missing image is *stated*: an agent that
 * silently stops receiving pictures and one that is being shown a page it cannot see are the same
 * thing from the inside, and §6's suppression is the former.
 */
import type { ToolName } from "./tools.ts";

/** The image the model is shown. Base64, as the Responses API's `input_image` takes it. */
export interface ScreenshotView {
  readonly data: string;
  readonly mediaType: string;
}

/**
 * One action the run has taken, as the model should remember it.
 *
 * `call` is the model's own request rendered back to it, because a model that cannot see what it
 * asked for last turn cannot tell "I never did that" from "I did it and it failed". It is a string
 * rather than the argument object so that it passes through the run's redactor on the way out like
 * every other sink (§6) — a `type`'s value is in there, and the digest is not a safe place for a
 * value the scrubber has not seen.
 */
export interface TurnRecord {
  readonly step: number;
  readonly tool: string;
  readonly call: string;
  readonly outcome: string;
  readonly failed: boolean;
}

export interface Turn {
  readonly step: number;
  /** The digest of the page as it is now — indices refer to this and to nothing else. */
  readonly digest: string;
  readonly screenshot: ScreenshotView | null;
  readonly screenshotNote: string | null;
  /** Everything the run has done, oldest first. */
  readonly history: readonly TurnRecord[];
  /** What the previous call got wrong, when it got something wrong. */
  readonly correction: string | null;
}

export interface Decision {
  readonly tool: ToolName;
  /**
   * The raw arguments. Deliberately `unknown`-valued: a provider does not validate, because a
   * validation failure has to become a *correction the model can read* (§9), and that is the loop's
   * to deliver. A provider that threw here would turn a fixable slip into a dead run.
   */
  readonly arguments: Record<string, unknown>;
}

export interface AgentDriver {
  /** The model's name — this is what an artifact records as `provenance.model`. */
  readonly name: string;
  decide(turn: Turn): Promise<Decision>;
}

/**
 * Render one turn as the text the model reads: what it has done, then what it is looking at, then
 * what it owes.
 *
 * Order is deliberate and is the order a person catching up would want: the history first, so the
 * current digest is read *in the context of* what has been tried; the digest next, as the thing to
 * act on; the correction last, because it is the one instruction that must survive being skimmed.
 */
export function renderTurn(turn: Turn): string {
  const parts: string[] = [];

  if (turn.history.length > 0) {
    parts.push(
      ["## What you have done so far", ...turn.history.map(renderRecord)].join("\n"),
    );
  }

  parts.push(`## Step ${turn.step}: the page now`, turn.digest);

  if (turn.screenshot === null && turn.screenshotNote !== null) {
    // Stated rather than omitted: "you are not being shown a picture this turn, and here is why" is
    // a fact the model can act on, while a silently missing image reads as a page with nothing on it.
    parts.push(`(no screenshot this turn: ${turn.screenshotNote})`);
  }

  if (turn.correction !== null) {
    parts.push(
      "## Your last call did not work",
      turn.correction,
      "Choose a different call that takes this into account.",
    );
  }

  return parts.join("\n\n");
}

function renderRecord(record: TurnRecord, index: number): string {
  const mark = record.failed ? "✗" : "·";
  return `${index + 1}. ${mark} ${record.tool} ${record.call} → ${record.outcome}`;
}
