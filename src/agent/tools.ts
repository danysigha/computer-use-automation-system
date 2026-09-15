/**
 * §9's ten semantic tools — one home for their names, their descriptions, and their arguments.
 *
 * The list is deliberately small and deliberately *semantic*. §9's point is that the model is given
 * "click the node with this index", never "evaluate this selector": the model's job is to decide
 * *what* to do in the app's own terms, and the system's job is to turn that decision into a durable
 * target chain. A model that could emit selectors would be a model authoring the artifact, and the
 * artifact's determinism would then be exactly as good as the model's guess about the DOM.
 *
 * Two things are decided here rather than in the provider file, and both are about portability.
 *
 * 1. **The specs are provider-neutral data.** `openai.ts` translates them into the Responses API's
 *    function shape; nothing in this file knows that shape exists. If the provider changes, the
 *    descriptions — which are the model's entire instruction manual for the tools, and therefore the
 *    part worth keeping — move without an edit.
 * 2. **Argument checking is ours, not the provider's.** The schemas are deliberately permissive
 *    (`strict: false` at the provider) because a strict schema's requirement that every property be
 *    listed in `required` produces a *rejected request* when it is wrong — a failure that cannot be
 *    exercised without a key, in a code path whose whole job is to be right on the first live run.
 *    Checking here instead turns the same mistake into a sentence the model can read and correct:
 *    every rejection below is a `ToolUseError`, which the loop hands straight back to the model as
 *    the next turn's correction rather than failing the run.
 *
 * Indices are 0-based and refer to **the digest the model was just given**. They are the one input
 * that is not durable: `capture.ts` turns the index into a chain at call time, and the index itself
 * never reaches an artifact (§9).
 */
import type { TargetCandidate } from "../surface/target.ts";
import { describeValue } from "./describe.ts";

/** The strategy names a target chain can hold, for the run log's `resolvedBy`. */
export type ResolvedBy = TargetCandidate["strategy"];

export const TOOL_NAMES = [
  "navigate",
  "click",
  "type",
  "select",
  "read",
  "wait",
  "screenshot",
  "markComplete",
  "requestApproval",
  "reportStuck",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSpec {
  readonly name: ToolName;
  /** The model's instruction for when and how to use it. Load-bearing prose, not a label. */
  readonly description: string;
  /** JSON-schema properties. `additionalProperties: false` is applied by the provider adapter. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
}

const INDEX = {
  type: "number",
  description: "The `[index]` of a node in the digest you were just given. Indices change with every page.",
};

/** One entry per name in `TOOL_NAMES`, in that order. Missing one is a `typecheck` failure. */
export const TOOL_SPECS = [
  {
    name: "navigate",
    description:
      "Load a URL. Use it only to leave the page you are on; a path like /member/12345/summary is " +
      "resolved against the current origin.",
    properties: { url: { type: "string", description: "An absolute URL, or a path starting with /." } },
    required: ["url"],
  },
  {
    name: "click",
    description:
      "Click the node with this index. Use the row context on the digest line to tell identical " +
      "controls in different rows apart.",
    properties: { index: INDEX },
    required: ["index"],
  },
  {
    name: "type",
    description:
      "Put this text into the field with this index. It replaces whatever is in the field, so there " +
      "is no need to clear it first.",
    properties: { index: INDEX, text: { type: "string", description: "The exact value to enter." } },
    required: ["index", "text"],
  },
  {
    name: "select",
    description: "Choose the option with this visible label in the dropdown with this index.",
    properties: {
      index: INDEX,
      label: { type: "string", description: "The option's visible label, exactly as it appears." },
    },
    required: ["index", "label"],
  },
  {
    name: "read",
    description:
      "Read the visible text of the node with this index without acting on the page. A value the " +
      "goal asks you to report must be read this way before you can report it.",
    properties: { index: INDEX },
    required: ["index"],
  },
  {
    name: "wait",
    description:
      "Wait for the page to finish loading, when a frame or a panel is still empty. Do not use it " +
      "to retry an action that had no effect — do something different instead.",
    properties: {},
    required: [],
  },
  {
    name: "screenshot",
    description: "Capture the current view for the run's evidence. Nothing about the page changes.",
    properties: {},
    required: [],
  },
  {
    name: "markComplete",
    description:
      "Finish the run and report the goal's outputs. Call it as soon as they are all known; a value " +
      "you read and did not report here is lost, and the goal counts as unmet.",
    properties: {
      outputs: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'The goal\'s outputs as {"name": "value"}. Every value must be one you read with `read` in ' +
          "this run, copied exactly.",
      },
    },
    required: ["outputs"],
  },
  {
    name: "requestApproval",
    description:
      "Ask a human to approve an action you may not take alone. The run stops and waits for them. " +
      "Use this instead of attempting the action.",
    properties: {
      action: { type: "string", description: "What you want to do, in one sentence." },
    },
    required: ["action"],
  },
  {
    name: "reportStuck",
    description:
      "Give up, and say why the goal cannot be reached. Use it when the app is missing something " +
      "the goal needs — not when an action merely did not work yet.",
    properties: { reason: { type: "string", description: "What is missing or blocking, specifically." } },
    required: ["reason"],
  },
] as const satisfies readonly ToolSpec[];

/**
 * The names, as the type the loop switches over. The `satisfies` above proves each spec names a
 * real tool; this proves the reverse — a tool with no spec is a name the model can never be given,
 * which would silently shrink the tool set.
 */
type EveryToolHasASpec = Exclude<ToolName, (typeof TOOL_SPECS)[number]["name"]> extends never ? true : false;
export const everyToolHasASpec: EveryToolHasASpec = true;

/**
 * A call the run could not carry out, in a way the model can fix on the next turn.
 *
 * This type is the loop's only recoverable failure. Everything else it catches is either an
 * escalation (`ApprovalRequiredError`), a policy refusal, or a bug — and a bug must not be
 * presented to the model as something it did wrong, because the model will spend its budget trying
 * to correct a problem that is not there.
 */
export class ToolUseError extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = "ToolUseError";
    this.tool = tool;
  }
}

/**
 * Parse a tool call's arguments.
 *
 * The provider hands arguments over as a JSON *string*, and a malformed one is a real occurrence
 * rather than a hypothetical: a truncated generation, or a model that emitted prose inside the
 * argument field. Recovering it here means the failure is one more thing the model is told about,
 * instead of an exception out of the provider adapter.
 */
export function parseArguments(tool: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === "" ? "{}" : raw);
  } catch (error: unknown) {
    throw new ToolUseError(
      tool,
      `the arguments were not valid JSON (${(error as Error).message}): ${describeValue(raw)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolUseError(tool, `the arguments must be a JSON object, got ${describeValue(parsed)}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * A digest index. Required to be a non-negative integer: the digest's numbering starts at 0, and a
 * model that answers with a node's *name* or a 1-based guess gets told the rule rather than an
 * `undefined` lookup.
 */
export function requiredIndex(tool: string, args: Record<string, unknown>): number {
  const value = args["index"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolUseError(
      tool,
      `"index" must be a non-negative integer from the digest, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function requiredString(tool: string, args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new ToolUseError(tool, `"${key}" must be a non-empty string, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * `markComplete`'s outputs. Values are coerced to strings rather than rejected for being numbers:
 * a model reporting a balance as `1204.55` has understood the goal, and refusing that on a type
 * technicality would be the loop failing the model's correct answer.
 */
export function requiredOutputs(tool: string, args: Record<string, unknown>): Record<string, string> {
  const value = args["outputs"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolUseError(
      tool,
      `"outputs" must be an object of name/value pairs, got ${describeValue(value)}`,
    );
  }
  const outputs: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry === "object") {
      throw new ToolUseError(tool, `output "${name}" must be a single value, got ${describeValue(entry)}`);
    }
    outputs[name] = String(entry);
  }
  if (Object.keys(outputs).length === 0) {
    throw new ToolUseError(tool, '"outputs" is empty — report the values the goal asked for, or keep working');
  }
  return outputs;
}

/** Does this tool address a node? The loop resolves those through the digest before acting. */
export function targetsANode(tool: ToolName): boolean {
  return tool === "click" || tool === "type" || tool === "select" || tool === "read";
}

/** Is this tool an action on the page (as opposed to an observation or a termination)? */
export function actsOnPage(tool: ToolName): boolean {
  return tool === "click" || tool === "type" || tool === "select";
}
