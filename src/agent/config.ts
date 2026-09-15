/**
 * The discovery agent's configuration (§9's `agent/config.ts`).
 *
 * Two things live here and nothing else does: **which model**, and **how much room the run has**
 * before the stuck detector calls it stuck. Both are settings rather than constants for the same
 * reason — the plan's own budget numbers are defaults an operator tunes, not facts about the
 * problem — and both have exactly one reader, so this file is where "the model changed" and "the
 * budget changed" are answered.
 *
 * The model is an env override on a code default (§9: "name configurable in `agent/config.ts`
 * (default: a current mid-tier model; `OPENAI_MODEL` env overrides)"). A tool-calling, vision-capable
 * model is required — the loop sends both a digest and a screenshot — so the seam is this one
 * string, and a provider or model change costs an env var rather than an edit. It is also the value
 * recorded in the artifact's `provenance.model`, so a replay that behaves differently from its
 * recording has the recording's model named in the file it is reading.
 *
 * The budgets come from §6's policy rather than from here, and that is deliberate: they are the
 * same three numbers §8's stuck detector is specified with, and a policy is where a per-deployment
 * tolerance for "how long may this wander" belongs. This file reads them; `policy.json` owns them.
 */
import type { Policy } from "../policy/policy.ts";

/**
 * §9's "current mid-tier model". Wrong is a cost, not a breakage: the seam is one env var, and a
 * misconfigured model fails on the first API call rather than halfway through a run.
 */
export const DEFAULT_MODEL = "gpt-5.4-mini";

/** §8's three thresholds, as they arrive from policy `agent`. */
export interface AgentBudgets {
  /** Total tool calls before the run stops and hands back. */
  readonly maxToolCalls: number;
  /** Consecutive calls with an unchanged state hash (url + interactable-text digest). */
  readonly noProgressActions: number;
  /** Calls repeating one `(action, target)` identity before the run stops. */
  readonly repeatLimit: number;
}

/**
 * What the model is shown of the page.
 *
 * §9 asks for "a downscaled screenshot (vision)", and the reduction here is to **encoding quality,
 * not resolution** — a documented deviation with a reason: the surface this system is built for is a
 * legacy console, whose whole informational content is small print in dense tables, and halving the
 * pixels would blur exactly the thing the screenshot is sent to read. JPEG at this quality cuts a
 * 1280×800 capture from ~150 KB to ~50 KB, which is the same context and cost saving the plan is
 * after, with the text intact. The digest remains the primary observation; the image is the
 * "computer use" half that catches what a tree flattens.
 */
export interface ScreenshotPolicy {
  readonly type: "jpeg";
  readonly quality: number;
}

export interface AgentConfig {
  readonly model: string;
  readonly budgets: AgentBudgets;
  readonly screenshot: ScreenshotPolicy;
}

export const SCREENSHOT_POLICY: ScreenshotPolicy = { type: "jpeg", quality: 50 };

/** §6's precedence, applied to the one knob that is not a guardrail: env > policy > code default. */
export function agentConfig(policy: Policy, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const override = env["OPENAI_MODEL"];
  return {
    model: override === undefined || override === "" ? DEFAULT_MODEL : override,
    budgets: {
      maxToolCalls: policy.document.agent.maxToolCalls,
      noProgressActions: policy.document.agent.noProgressActions,
      repeatLimit: policy.document.agent.repeatLimit,
    },
    screenshot: SCREENSHOT_POLICY,
  };
}
