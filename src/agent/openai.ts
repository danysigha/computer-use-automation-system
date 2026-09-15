/**
 * The OpenAI implementation of the `AgentDriver` seam (§9) — the provider half, and the only file
 * that knows a provider exists.
 *
 * It is a generalization of the P1 spike (`scripts/spike.ts`), which ran against the real API once
 * and answered the one question that could not be answered without a key: whether a model reads the
 * Observer's digest well enough to answer with tool calls that resolve. Everything the spike proved
 * is kept literally, because it is what a live run validated:
 *
 *  - **`tool_choice: "required"`.** The first live run answered in prose — correctly, but without
 *    ever declaring completion, so the run could not finish. Requiring a tool call makes "answered in
 *    prose" structurally impossible rather than merely discouraged.
 *  - **One retry, on prose.** The retry is not for the model's benefit; it is for the *run's*. A
 *    spike that dies on the first protocol slip hides the observation that matters behind one that
 *    does not, and the same is true of a discovery run that spent four turns getting somewhere. The
 *    retry names what the model said and asks again, so a second failure is a real failure.
 *  - **`strict: false` on the tool schemas.** A strict schema demands every property be required
 *    and forbids optional keys; getting that wrong makes the API reject the *request*, which is a
 *    failure mode that cannot be exercised without a key. The schemas stay permissive and
 *    `tools.ts` does the checking, where a mistake is a sentence the model can act on.
 *
 * The two additions are the ones discovery needs and the spike did not: the turn is rendered from
 * `driver.ts` (history + digest + correction) rather than from a bare digest, and the screenshot
 * rides along as an `input_image`. The capture itself was taken by `ObserverDriver` through the
 * driver's choke point, so §6's suppression has already been applied by the time it arrives here —
 * this file never sees a picture the run decided not to take.
 */
import OpenAI from "openai";
import type { FunctionTool, ResponseInputContent, ResponseInputItem, ResponseFunctionToolCall } from "openai/resources/responses/responses";
import type { AgentDriver, Decision, Turn } from "./driver.ts";
import { renderTurn } from "./driver.ts";
import { describeValue } from "./describe.ts";
import { parseArguments, TOOL_NAMES, TOOL_SPECS, ToolUseError, type ToolName } from "./tools.ts";

export interface OpenAIDriverOptions {
  readonly model: string;
  /**
   * The goal, in the caller's words. This is the only place the goal enters the model's context —
   * it is not re-derived from the tools, and nothing downstream parses it. It is what a person would
   * have said to a colleague, which is the standard §1 sets for the whole system.
   */
  readonly goal: string;
  /** The declared inputs, so the model uses the caller's values rather than inventing its own. */
  readonly params?: readonly { readonly name: string; readonly value: string }[];
  /** Injected by tests. `undefined` lets the SDK read `OPENAI_API_KEY` from the environment. */
  readonly client?: OpenAI;
  /**
   * Narrated as the run goes: the prose retry (§9's one recoverable protocol slip) and a note when
   * the model returns several calls in one turn. Stdout is a sink, so the caller must scrub before
   * printing — the loop passes the run's own redactor-backed writer.
   */
  readonly onNote?: (line: string) => void;
}

const MAX_ATTEMPTS = 2;

export function openaiDriver(options: OpenAIDriverOptions): AgentDriver {
  const client = options.client ?? new OpenAI();
  const notes = options.onNote ?? ((): void => {});
  const instructions = buildInstructions(options.goal, options.params ?? []);
  const tools = TOOL_SPECS.map(toFunctionTool);

  return {
    name: options.model,
    async decide(turn: Turn): Promise<Decision> {
      const opening = inputFor(turn);
      let prose = "";

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const response = await client.responses.create({
          model: options.model,
          instructions,
          input: attempt === 1 ? opening : [...opening, proseCorrection(prose)],
          tools,
          tool_choice: "required",
        });

        const calls = response.output.filter(
          (item): item is ResponseFunctionToolCall => item.type === "function_call",
        );
        const call = calls[0];
        if (call !== undefined) {
          if (calls.length > 1) {
            notes(`${calls.length} tool calls in one turn; taking ${call.name} and ignoring the rest`);
          }
          return { tool: toolName(call.name), arguments: parseArguments(call.name, call.arguments) };
        }

        prose = response.output_text.trim();
        notes(`replied in prose (${describeValue(prose)}); asked for a tool call`);
      }

      // Two prose answers in a row is not a protocol slip any more, it is the model declining to
      // use the tools. That is a failure of the run, and it says what the model wanted instead.
      throw new Error(`the model never called a tool; its answer was: ${prose === "" ? "(empty)" : prose}`);
    },
  };
}

/**
 * The tool list, in the provider's shape. `strict: false` for the reason in the header, and
 * `additionalProperties: false` so an invented argument is at least visible in the call rather than
 * silently dropped by a schema that had no opinion about it.
 */
function toFunctionTool(spec: (typeof TOOL_SPECS)[number]): FunctionTool {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    strict: false,
    parameters: { type: "object", properties: spec.properties, required: [...spec.required], additionalProperties: false },
  };
}

/**
 * A tool name the model chose, checked against the list we offered.
 *
 * An unknown name is a hard error rather than a correction, unlike every other argument problem, and
 * the asymmetry is deliberate: it means the model and the tool list disagree about what exists,
 * which no retry can fix and which would otherwise show up much later as an inexplicable failure.
 * `ToolUseError` keeps it on the same path as the rest — the loop decides whether to fail or correct.
 */
function toolName(name: string): ToolName {
  const known = TOOL_NAMES.find((candidate) => candidate === name);
  if (known === undefined) {
    throw new ToolUseError(name, `there is no tool called ${describeValue(name)}; available: ${TOOL_NAMES.join(", ")}`);
  }
  return known;
}

function inputFor(turn: Turn): ResponseInputItem[] {
  const content: ResponseInputContent[] = [{ type: "input_text", text: renderTurn(turn) }];
  if (turn.screenshot !== null) {
    content.push({
      type: "input_image",
      image_url: `data:${turn.screenshot.mediaType};base64,${turn.screenshot.data}`,
      detail: "auto",
    });
  }
  return [{ role: "user", content }];
}

function proseCorrection(prose: string): ResponseInputItem {
  return {
    role: "user",
    content:
      `You replied in prose: ${describeValue(prose)}. Every turn must end in exactly ` +
      "one tool call. If the goal is met, call markComplete with the values you read.",
  };
}

/**
 * The system prompt: the model's whole job description.
 *
 * It states the digest format, the one-call-per-turn rule, and the report-what-you-read rule, and
 * then stops. Nothing here describes the fixture's pages, the goal's steps, or an expected route —
 * a prompt that knew the answer would make the discovery run a demonstration rather than a
 * discovery, and the artifact it produced would be evidence of the prompt rather than of the model
 * working the app. The goal arrives as the caller's sentence and is passed through unedited.
 */
function buildInstructions(goal: string, params: readonly { readonly name: string; readonly value: string }[]): string {
  const lines = [
    "You drive a legacy bank console through the numbered digest of its accessibility tree.",
    'Each line is one node: [index] role "name" [state]. A table renders one row per line.',
    "A line's row context — the cells on the same line — is how identical controls in different rows are told apart.",
    "The indices refer to the digest you are given each turn; they never carry over to the next one.",
    "Take exactly one action per turn, and end every turn with exactly one tool call. Never answer in prose.",
    "A value you must report has to be read with `read` in this run before markComplete can report it.",
    `Goal: ${goal}`,
  ];
  if (params.length > 0) {
    lines.push(
      "The caller supplies these values; use these and not others: " +
        params.map((param) => `${param.name} = ${param.value}`).join(", "),
    );
  }
  return lines.join(" ");
}
