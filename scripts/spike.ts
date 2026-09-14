/**
 * P1 discovery-risk spike (§11 P1, §14 risk row 1 — "T5").
 *
 * The plan's one irreplaceable deliverable is an LLM driving a live browser, and it is also the
 * only thing here that depends on a third party. §14 moves a thin version of it to the *end of
 * P1* rather than the tail of P4 for a specific reason: if a model cannot consume the Observer's
 * digest and answer with tool calls that resolve, we want to know at hour ~6 — before five more
 * phases are built on top of a format that does not work — rather than at hour ~16.
 *
 * ## Two modes, and the difference between them is the whole point
 *
 *   node scripts/spike.ts --dry-run    Everything except the model call. The digest is built by
 *                                      the real Observer, the tool call is validated, the index
 *                                      is resolved to a live element, a real target chain is
 *                                      captured from it, and a real action is executed and
 *                                      logged. The "decider" is a scripted oracle, not a model.
 *                                      Needs no key, so it runs today and in CI.
 *
 *   node scripts/spike.ts              The same path with the real model in the decider seat.
 *
 * So what is genuinely unverified until the second form runs is narrow and worth naming: that the
 * configured account has the model, and that the model reads this digest well enough to pick the
 * right rows and emit calls of this shape. Everything else — the format, the index→element→chain
 * plumbing, the logging — is exercised by `--dry-run`. The `--dry-run` oracle deliberately does
 * its selection *by parsing the digest text*, the way a competent reader would, so it also proves
 * the digest is answerable in the form we are asking the model to answer it.
 *
 * Exit codes: 0 done · 1 ran and failed · 2 blocked (no OPENAI_API_KEY).
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { configFromEnv, startServer } from "../sample-app/server.ts";
import { captureTarget } from "../src/surface/capture.ts";
import { SessionDriver, type SurfaceAction } from "../src/surface/session-driver.ts";
import type { Snapshot, SnapshotNode } from "../src/surface/observer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "spike");

/** Goal 1 (§10): the happy path the whole system is proved against. */
const GOAL = {
  id: "member-savings-balance",
  question:
    "Look up member 12345 and report the balance of their Savings account. " +
    "Start from the member inquiry page you are already on.",
  memberId: "12345",
};

/** §9 caps discovery at 25 tool calls; the spike only needs the happy path, so it caps far lower. */
const STEP_BUDGET = 8;

/**
 * The plan's default is "a current mid-tier model", overridable by `OPENAI_MODEL`. A tool-calling
 * model is required; the seam is this one line, so a wrong default costs one env var, not an edit.
 */
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

/* -------------------------------------------------------------------------- */
/* Tools (§9's list, restricted to what goal 1 needs)                          */
/* -------------------------------------------------------------------------- */

/**
 * `strict: false` on purpose. Strict schemas demand every property be required and forbid
 * optional keys, and getting that wrong makes the API reject the call — a failure mode that
 * cannot be exercised without a key. So the schemas stay permissive and the `required*`
 * helpers do the checking, where a mistake is a clear message instead of a rejected request.
 */
function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
): FunctionTool {
  return {
    type: "function",
    name,
    description,
    strict: false,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

const TOOLS: FunctionTool[] = [
  fn("navigate", "Load a URL in the browser.", { url: { type: "string" } }, ["url"]),
  fn("click", "Click the node with this index from the digest.", { index: { type: "number" } }, ["index"]),
  fn(
    "type",
    "Replace the contents of the text field with this index.",
    { index: { type: "number" }, text: { type: "string" } },
    ["index", "text"],
  ),
  fn(
    "read",
    "Read the visible text of the node with this index, without acting on the page.",
    { index: { type: "number" } },
    ["index"],
  ),
  fn(
    "markComplete",
    "Finish the run and report the goal's outputs.",
    { outputs: { type: "object", additionalProperties: { type: "string" } } },
    ["outputs"],
  ),
  fn("reportStuck", "Give up and say why the goal cannot be reached.", { reason: { type: "string" } }, ["reason"]),
];

/* -------------------------------------------------------------------------- */
/* The decider seam                                                            */
/* -------------------------------------------------------------------------- */

interface Decision {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface StepRecord {
  readonly step: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** What the model saw when it decided. */
  readonly digest: string;
  /** What its decision did. */
  readonly outcome: string;
  /** Which candidate strategy actually resolved, when the step targeted a node. */
  readonly resolvedBy?: string;
  readonly framePath?: readonly number[];
}

interface Turn {
  readonly step: number;
  readonly digest: string;
  readonly history: readonly StepRecord[];
}

type Decider = (turn: Turn) => Promise<Decision>;

/**
 * The scripted oracle behind `--dry-run`.
 *
 * It is not a model and does not pretend to be one: it picks its nodes by *reading the digest*,
 * which is the one thing about the format worth proving without a key — that "the balance cell
 * on the Savings row" is expressible as an index by reading a rendered line, with no DOM access
 * and no hidden metadata.
 */
const scriptedDecider: Decider = async (turn) => {
  const { digest, step } = turn;
  switch (step) {
    case 1:
      return { tool: "type", args: { index: indexOf(digest, "textbox", /"Member ID"/), text: GOAL.memberId } };
    case 2:
      return { tool: "click", args: { index: indexOf(digest, "button", /"Search"/) } };
    case 3:
      // The results page carries four links named "Detail" and three cells mentioning "Savings".
      // Row context is the only thing that identifies one — the flagship hostile shape, read
      // exactly the way the model is being asked to read it.
      return { tool: "click", args: { index: onLineWith(digest, '"Savings"', "link") } };
    case 4:
      // Now on the member summary, whose grid lives inside an iframe. The balance is the first
      // cell carrying a currency amount on the Savings row.
      return { tool: "read", args: { index: onLineWith(digest, '"Savings"', "cell", /\$/) } };
    default:
      return {
        tool: "markComplete",
        args: { outputs: { savingsBalance: lastReading(turn.history) } },
      };
  }
};

function modelDecider(client: OpenAI): Decider {
  const system = [
    "You drive a legacy bank console through the numbered digest of its accessibility tree.",
    "Each line is one node: [index] role \"name\" [state]. A table renders one row per line.",
    "Indices are stable for the snapshot you were given; refer to nodes by index.",
    "Take one action per turn, then observe the new digest.",
    // The first live run answered this in prose — correctly, but without ever declaring
    // completion, so the run could not finish. Saying the rule outright is the cheap fix; the
    // nudge below is the one that catches a model that ignores it.
    "Every turn must end in exactly one tool call; never answer in prose.",
    `When the goal is met, call markComplete with its outputs. Goal: ${GOAL.question}`,
  ].join(" ");

  return async (turn) => {
    const opening: ResponseInputItem[] = [
      { role: "user", content: `Step ${turn.step}. Current state:\n\n${turn.digest}` },
    ];
    let prose = "";

    // Two attempts, because "answered in prose" is a recoverable protocol slip rather than a
    // failure of the run: the model usually means "I am done", and just has to be told to say so
    // through the tool. `tool_choice: "required"` should make the second attempt unnecessary —
    // the retry is here because a spike that dies on the first slip would hide the observation
    // that matters (that the digest was understood) behind one that does not.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const input: ResponseInputItem[] =
        attempt === 1
          ? opening
          : [
              ...opening,
              {
                role: "user",
                content:
                  `You replied in prose: ${JSON.stringify(prose)}. Every turn must end in a tool ` +
                  "call. If the goal is met, call markComplete with its outputs.",
              },
            ];

      const response = await client.responses.create({
        model: MODEL,
        instructions: system,
        input,
        tools: TOOLS,
        tool_choice: "required",
      });

      const call = response.output.find(
        (item): item is ResponseFunctionToolCall => item.type === "function_call",
      );
      if (call !== undefined) return { tool: call.name, args: parseArguments(call.arguments) };

      prose = response.output_text.trim();
      process.stdout.write(`  · replied in prose (${JSON.stringify(prose.slice(0, 120))}); asked for a tool call\n`);
    }

    throw new Error(`the model never called a tool; its answer was: ${prose || "(empty)"}`);
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the digest (the --dry-run oracle's only input)                      */
/* -------------------------------------------------------------------------- */

/** The first line that mentions `anchor` — how a reader finds "the Savings row". */
function lineWith(digest: string, anchor: string): string {
  const line = digest.split("\n").find((candidate) => candidate.includes(anchor));
  if (line === undefined) throw new Error(`the digest has no line mentioning ${anchor}`);
  return line;
}

const TOKEN = /\[(\d+)\] (\w+) ("[^"]*")?/g;

function tokensOn(line: string): RegExpMatchArray[] {
  return [...line.matchAll(TOKEN)];
}

/** The index of the first `role` node on the anchor's line, optionally whose name matches. */
function onLineWith(digest: string, anchor: string, role: string, name?: RegExp): number {
  const found = tokensOn(lineWith(digest, anchor)).find(
    (token) => token[2] === role && (name === undefined || name.test(token[3] ?? "")),
  );
  if (found === undefined) {
    throw new Error(`no ${role}${name === undefined ? "" : ` matching ${String(name)}`} on the ${anchor} line`);
  }
  return Number(found[1]);
}

/** The same, over the whole digest — for controls that need no row context. */
function indexOf(digest: string, role: string, name: RegExp): number {
  for (const line of digest.split("\n")) {
    const found = tokensOn(line).find((token) => token[2] === role && name.test(token[3] ?? ""));
    if (found !== undefined) return Number(found[1]);
  }
  throw new Error(`no ${role} matching ${String(name)} anywhere in the digest`);
}

function lastReading(history: readonly StepRecord[]): string {
  const reads = history.filter((record) => record.tool === "read");
  return reads[reads.length - 1]?.outcome ?? "";
}

/* -------------------------------------------------------------------------- */
/* Argument validation                                                         */
/* -------------------------------------------------------------------------- */

export function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error(`tool arguments were not valid JSON (${(error as Error).message}): ${raw.slice(0, 200)}`);
  }
}

function requiredIndex(args: Record<string, unknown>): number {
  const value = args["index"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`"index" must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`"${key}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Applying a decision                                                         */
/* -------------------------------------------------------------------------- */

/**
 * index → live element → recorded target chain.
 *
 * This is the seam §9 describes: "the tool layer resolves `idx` against the live page into a
 * full `TargetDescriptor` chain at call time". The chain comes from `captureTarget`, the same
 * recorder P4 will use, so the spike exercises the real capture path rather than a shortcut —
 * including the frame path, which the Observer reports on the node itself.
 */
async function targetFor(
  driver: SessionDriver,
  snapshot: Snapshot,
  index: number,
): Promise<{ descriptor: Awaited<ReturnType<typeof captureTarget>>; node: SnapshotNode }> {
  const node = driver.observer.nodeAt(snapshot, index);
  if (node === null) throw new Error(`the digest has no node at index ${index}`);

  const element = await driver.observer.elementFor(node);
  if (element === null) {
    throw new Error(`node ${index} (${node.role}) is no longer in the tree; re-observe and retry`);
  }
  try {
    const descriptor = await captureTarget(driver.page, element, node.framePath);
    return { descriptor, node };
  } finally {
    await element.dispose();
  }
}

async function applyDecision(
  driver: SessionDriver,
  decider: Decider,
  decision: Decision,
  snapshot: Snapshot,
): Promise<{ record: Omit<StepRecord, "step" | "digest">; outputs: Record<string, string> | null }> {
  switch (decision.tool) {
    case "navigate": {
      const url = requiredString(decision.args, "url");
      const absolute = url.startsWith("http") ? url : new URL(url, driver.page.url()).toString();
      await driver.execute({ kind: "navigate", url: absolute });
      return { record: { tool: "navigate", args: decision.args, outcome: `loaded ${absolute}` }, outputs: null };
    }
    case "read": {
      const node = driver.observer.nodeAt(snapshot, requiredIndex(decision.args));
      if (node === null) throw new Error(`the digest has no node at index ${String(decision.args["index"])}`);
      const element = await driver.observer.elementFor(node);
      if (element === null) throw new Error(`node ${node.index} (${node.role}) is no longer in the tree`);
      const text = ((await element.textContent()) ?? "").replace(/\s+/g, " ").trim();
      await element.dispose();
      return {
        record: { tool: "read", args: decision.args, outcome: text, framePath: node.framePath },
        outputs: null,
      };
    }
    case "click":
    case "type": {
      const { descriptor, node } = await targetFor(driver, snapshot, requiredIndex(decision.args));
      const action: SurfaceAction =
        decision.tool === "click"
          ? { kind: "click", target: descriptor }
          : { kind: "type", target: descriptor, value: requiredString(decision.args, "text") };
      const executed = await driver.execute(action);
      return {
        record: {
          tool: decision.tool,
          args: decision.args,
          outcome:
            `resolved ${node.role} "${node.name}" via ${executed.resolved?.candidate.strategy ?? "?"}` +
            `, policy=${executed.verdict.rule}`,
          resolvedBy: executed.resolved?.candidate.strategy,
          framePath: node.framePath,
        },
        outputs: null,
      };
    }
    case "markComplete": {
      const outputs = decision.args["outputs"];
      if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
        throw new Error('"outputs" must be an object of string values');
      }
      const strings: Record<string, string> = {};
      for (const [key, value] of Object.entries(outputs as Record<string, unknown>)) {
        strings[key] = String(value);
      }
      return { record: { tool: "markComplete", args: decision.args, outcome: JSON.stringify(strings) }, outputs: strings };
    }
    case "reportStuck":
      throw new Error(`the model reported itself stuck: ${requiredString(decision.args, "reason")}`);
    default: {
      // A tool we never offered. Worth failing loudly on: it means the model and the tool list
      // disagree, which is exactly the format risk this spike exists to surface.
      void decider;
      throw new Error(`unknown tool ${JSON.stringify(decision.tool)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && process.env["OPENAI_API_KEY"] === undefined) {
    process.stderr.write(
      "BLOCKED: OPENAI_API_KEY is not set, so the model half of this spike cannot run.\n" +
        "  Unblock:  cp .env.example .env  &&  add your key  (then re-run `npm run spike`)\n" +
        "  Meanwhile `npm run spike -- --dry-run` exercises everything but the API call.\n",
    );
    return 2;
  }

  // A dry-run is a rehearsal, not evidence — it goes to a temp directory so `evidence/` only
  // ever holds runs a model actually performed, which is what makes the directory worth reading.
  const runDir = dryRun
    ? await mkdtemp(join(tmpdir(), "atlas-spike-"))
    : join(EVIDENCE, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(runDir, { recursive: true });
  const logPath = join(runDir, "run.jsonl");

  const app = await startServer({ ...configFromEnv(), port: 0 });
  const driver = await SessionDriver.launch({ evidenceDir: runDir });
  const decider: Decider = dryRun ? scriptedDecider : modelDecider(new OpenAI());

  const history: StepRecord[] = [];
  let outputs: Record<string, string> | null = null;
  let failure: string | null = null;

  try {
    await driver.goto(`${app.url}/`);
    process.stdout.write(
      `spike: goal ${GOAL.id} · ${dryRun ? "dry-run (scripted oracle)" : `model ${MODEL}`} · ${app.url}\n`,
    );

    for (let step = 1; step <= STEP_BUDGET && outputs === null; step += 1) {
      const snapshot = await driver.snapshot();
      const digest = driver.observer.render(snapshot, { mode: "compact" });
      const decision = await decider({ step, digest, history });

      const { record, outputs: completed } = await applyDecision(driver, decider, decision, snapshot);
      const entry: StepRecord = { step, digest, ...record };
      history.push(entry);
      await appendFile(logPath, `${JSON.stringify(entry)}\n`);
      process.stdout.write(`  ${step}. ${entry.tool} ${JSON.stringify(entry.args)} → ${entry.outcome}\n`);

      if (completed !== null) outputs = completed;
    }

    if (outputs === null) failure = `the goal was not completed within ${STEP_BUDGET} steps`;
  } catch (error: unknown) {
    failure = (error as Error).message;
  } finally {
    if (failure !== null) {
      await driver.screenshot("failure").catch(() => "");
    }
    await driver.close();
    await app.close();
  }

  await writeFile(join(runDir, "summary.json"), `${JSON.stringify({ goal: GOAL.id, dryRun, model: MODEL, outputs, failure, steps: history.length }, null, 2)}\n`);

  if (failure !== null) {
    process.stderr.write(`spike FAILED: ${failure}\n  evidence: ${runDir}\n`);
    return 1;
  }
  process.stdout.write(`spike OK: ${JSON.stringify(outputs)}\n  evidence: ${runDir}\n`);
  return 0;
}

/** Load `.env` if the developer made one; `.env.example` documents the variables. */
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

process.exitCode = await main();
