/**
 * Policy — §6's guardrail document: its shape, its loader, and the origin it will run against
 * (§11 P3).
 *
 * The policy is the **enforcement floor**. The artifact's `risk` block is the recorded
 * declaration, and replay binds on the stricter of the two (§27) — that comparison is made against
 * this document. So this module's job is to make the floor trustworthy: a policy that does not
 * parse, or that cannot be found, stops the process rather than quietly becoming a permissive
 * default (§6: "a malformed policy is a startup error, never a default-open").
 *
 * Three decisions shape this file.
 *
 * 1. **Fail closed, and name the field.** Every rejection carries a path — `timing.retries`,
 *    `allowlist.denyRoutes.0`, `env:POLICY_TIMING_RETRIES` — because "policy is invalid" with no
 *    field is a message that costs the reader a debugging session. `PolicyInvalidError` collects
 *    every problem at once, the same shape `validate.ts` uses for artifacts, so one fix pass can
 *    clear them all.
 *
 * 2. **The origin is the gate; routes only narrow it.** A run may touch an allowlisted origin, and
 *    within it any path except those explicitly denied. `routes: [{pattern, allow: true}]` therefore
 *    records intent rather than restricting (the shipped policy's `^/member/` says "this is the
 *    part of the app this capability uses"), while `allow: false` and `denyRoutes` deny. Making
 *    route entries an allowlist instead would block the entry page and the search form of the one
 *    flow the system ships with, and a policy whose defaults break the demo gets edited until it
 *    does not — which is how allowlists rot.
 *
 * 3. **Precedence is env > policy.json > code default, per knob.** The code defaults mirror §6's
 *    shipped values so a section the file omits is never an accident; the env layer exists for the
 *    knobs the plan names as overridable (`POLICY_TIMING_*`, `POLICY_AGENT_*`), which is what a
 *    slower CI box tunes without editing a tracked file (§5.1). Arrays (`backoffMs`) are file-only:
 *    a comma-separated list in an env var is a format nobody validates, and P5's shrunk-timing
 *    tests use a policy *file* (`--policy`) rather than env for the same reason.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_PORT } from "../../sample-app/server.ts";
import type { ActionContext, ActionPolicy, PolicyVerdict } from "../surface/session-driver.ts";
import { classify, OPERATIONS } from "./risk.ts";
import { compilesAsRegex, isUsableNamePattern } from "./pattern.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The checked-in config. `POLICY_PATH` (env) or `--policy` (P5) points elsewhere. */
export const DEFAULT_POLICY_PATH = resolve(HERE, "../../policy/policy.json");

/** §6's `timing` section, as code defaults. `waitForMs` 10s, retries 2×, backoff 1s/3s. */
export const DEFAULT_TIMING = {
  waitForMs: 10_000,
  retries: 2,
  backoffMs: [1_000, 3_000],
  escalationTimeoutMs: 600_000,
} as const;

/** §6's `agent` section — the stuck-detector thresholds of §8. */
export const DEFAULT_AGENT = { maxToolCalls: 25, noProgressActions: 5, repeatLimit: 3 } as const;

/**
 * §6's shipped allowlist. The origin is derived from the sample app's own `PORT` default rather
 * than written out again, so the two cannot drift into disagreeing about where the fixture lives;
 * a `PORT` override is caught by the §5.4 preflight origin check with the port named, rather than
 * by a baffling cascade of `NAVIGATION_BLOCKED`s mid-run.
 */
export const DEFAULT_ORIGINS: readonly string[] = [`http://localhost:${DEFAULT_PORT}`];

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

const allowRouteSchema = z.strictObject({
  pattern: z.string().min(1).refine(compilesAsRegex, { message: "must be a valid regular expression" }),
  allow: z.boolean(),
});

const allowlistSchema = z.strictObject({
  origins: z.array(z.string().min(1)),
  routes: z.array(allowRouteSchema),
  denyRoutes: z.array(z.string().min(1).refine(compilesAsRegex, { message: "must be a valid regular expression" })),
  actions: z.array(z.enum(OPERATIONS)),
});

const riskRuleSchema = z.strictObject({
  matches: z
    .strictObject({
      action: z.enum(OPERATIONS).optional(),
      text: z.string().min(1).refine(isUsableNamePattern, { message: "matches nothing — see the pattern rules in src/policy/pattern.ts" }).optional(),
      fieldName: z.string().min(1).refine(isUsableNamePattern, { message: "matches nothing — see the pattern rules in src/policy/pattern.ts" }).optional(),
    })
    // A rule that names nothing would gate every action in the run. That is not a policy, it is an
    // outage, and it is much more likely to be a typo than an intention.
    .refine((matches) => Object.values(matches).some((value) => value !== undefined), {
      message: "a risk rule must name something to match — `action`, `text` or `fieldName`",
    }),
  note: z.string().min(1).optional(),
});

const timingSchema = z.strictObject({
  waitForMs: z.number().int().min(0),
  retries: z.number().int().min(0),
  backoffMs: z.array(z.number().int().min(0)),
  escalationTimeoutMs: z.number().int().min(0),
});

const agentSchema = z.strictObject({
  maxToolCalls: z.number().int().min(1),
  noProgressActions: z.number().int().min(1),
  repeatLimit: z.number().int().min(1),
});

const redactSchema = z.strictObject({
  // Field *names*, as §6 writes them: `password`, `ssn`, `account_number`. Interpreted by
  // `namePattern`, so they match `taxpayerSsn` and `accountNumber` alike.
  fieldPatterns: z
    .array(z.string().min(1).refine(isUsableNamePattern, { message: "matches nothing — see the pattern rules in src/policy/pattern.ts" })),
  outputIds: z.array(z.string().min(1)),
});

const recoverableDialogSchema = z.strictObject({
  text: z.string().min(1).refine(isUsableNamePattern, { message: "matches nothing — see the pattern rules in src/policy/pattern.ts" }),
  response: z.enum(["accept", "dismiss"]),
});

/**
 * The document. Strict throughout, for the reason `artifact.ts` gives: an unrecognized key is a
 * typo'd guardrail (`denyRoute` for `denyRoutes`), and silently ignoring it means the operator
 * believes something is being enforced that is not.
 */
export const policyDocumentSchema = z
  .strictObject({
    allowlist: allowlistSchema,
    risk: z.strictObject({ approvalRequired: z.array(riskRuleSchema) }),
    redact: redactSchema,
    recoverableDialogs: z.array(recoverableDialogSchema),
    timing: timingSchema,
    agent: agentSchema,
  })
  // One cross-field invariant, of the same family as the artifact's: a retry budget with fewer
  // backoff entries than retries silently retries with no delay, which is a busy-loop against a
  // struggling surface. The plan's own numbers (2 retries, [1s, 3s]) satisfy it.
  .refine((document) => document.timing.backoffMs.length >= document.timing.retries, {
    path: ["timing", "backoffMs"],
    message: "must hold at least one backoff entry per retry (retries: 2 needs [1000, 3000])",
  });

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
export type RiskRule = z.infer<typeof riskRuleSchema>;
export type AllowRoute = z.infer<typeof allowRouteSchema>;
export type RecoverableDialog = z.infer<typeof recoverableDialogSchema>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export interface PolicyIssue {
  readonly path: string;
  readonly message: string;
}

/** Rendered for a terminal: one problem per line, each naming where it is. */
export function formatPolicyIssues(issues: readonly PolicyIssue[]): string {
  const plural = issues.length === 1 ? "problem" : "problems";
  return [`${issues.length} ${plural}:`, ...issues.map((issue) => `  · ${issue.path} — ${issue.message}`)].join("\n");
}

/** Fail closed, loudly, with the field named. */
export class PolicyInvalidError extends Error {
  readonly issues: readonly PolicyIssue[];

  constructor(issues: readonly PolicyIssue[], context = "policy") {
    super(`${context} is invalid:\n${formatPolicyIssues(issues)}`);
    this.name = "PolicyInvalidError";
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

function codeDefaultDocument(): PolicyDocument {
  return {
    allowlist: { origins: [...DEFAULT_ORIGINS], routes: [{ pattern: "^/member/", allow: true }], denyRoutes: [], actions: [...OPERATIONS] },
    risk: { approvalRequired: [] },
    redact: { fieldPatterns: [], outputIds: [] },
    recoverableDialogs: [],
    timing: { ...DEFAULT_TIMING, backoffMs: [...DEFAULT_TIMING.backoffMs] },
    agent: { ...DEFAULT_AGENT },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill a partial document from the code defaults, one section at a time. A section that appears in
 * the file replaces that section's defaults field-by-field, and arrays are replaced **wholesale**:
 * a policy that says `origins: ["http://localhost:8080"]` means exactly that origin, not that one
 * plus the default — a merge that appended would leave the allowlist wider than its author wrote.
 */
function mergeDocument(...partials: readonly unknown[]): PolicyDocument {
  const defaults = codeDefaultDocument();
  const sections = <K extends keyof PolicyDocument>(key: K): PolicyDocument[K] => {
    let value = defaults[key];
    for (const partial of partials) {
      if (!isRecord(partial)) continue;
      const section = partial[key];
      if (isRecord(section) && isRecord(value)) {
        value = { ...value, ...section } as PolicyDocument[K];
      } else if (section !== undefined) {
        value = section as PolicyDocument[K];
      }
    }
    return value;
  };

  return {
    allowlist: sections("allowlist"),
    risk: sections("risk"),
    redact: sections("redact"),
    recoverableDialogs: sections("recoverableDialogs"),
    timing: sections("timing"),
    agent: sections("agent"),
  };
}

/**
 * The env layer: `POLICY_<SECTION>_<KEY>`, e.g. `POLICY_TIMING_WAITFORMS`,
 * `POLICY_AGENT_MAXTOOLCALLS`. Derived from the defaults rather than listed, so a knob added to
 * §6's config is overridable the moment it exists; arrays are skipped (see the file header).
 */
function applyEnvScalars(document: PolicyDocument, env: NodeJS.ProcessEnv): PolicyDocument {
  const read = <K extends "timing" | "agent">(key: K): PolicyDocument[K] => {
    const section = { ...document[key] } as Record<string, unknown>;
    for (const [field, value] of Object.entries(section)) {
      if (typeof value !== "number") continue;
      const name = `POLICY_${key.toUpperCase()}_${field.toUpperCase()}`;
      const raw = env[name];
      if (raw === undefined || raw === "") continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new PolicyInvalidError(
          [{ path: `env:${name}`, message: `must be a number (got \`${raw}\`)` }],
          "policy environment override",
        );
      }
      section[field] = parsed;
    }
    return section as PolicyDocument[K];
  };

  return { ...document, timing: read("timing"), agent: read("agent") };
}

function toIssues(error: z.ZodError): PolicyIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(document)" : issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Parse a document that has already been merged. Exported for the writer side of the system — the
 * recorder and replay preflight both hold a document and need the same strictness applied.
 */
export function parsePolicyDocument(input: unknown): PolicyDocument {
  const parsed = policyDocumentSchema.safeParse(input);
  if (!parsed.success) throw new PolicyInvalidError(toIssues(parsed.error));
  return parsed.data;
}

async function readPolicyFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PolicyInvalidError(
      [
        {
          path: path,
          message:
            code === "ENOENT"
              ? "no policy file at this path — the shipped policy is policy/policy.json; pass --policy or set POLICY_PATH"
              : `could not be read: ${String(error)}`,
        },
      ],
      "policy file",
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new PolicyInvalidError([{ path, message: `is not valid JSON: ${(error as Error).message}` }], "policy file");
  }
}

export interface PolicyOverrides {
  readonly allowlist?: Partial<PolicyDocument["allowlist"]>;
  readonly risk?: Partial<PolicyDocument["risk"]>;
  readonly redact?: Partial<PolicyDocument["redact"]>;
  readonly timing?: Partial<PolicyDocument["timing"]>;
  readonly agent?: Partial<PolicyDocument["agent"]>;
  readonly recoverableDialogs?: PolicyDocument["recoverableDialogs"];
}

export interface PolicySources {
  /**
   * The policy file. `undefined` resolves `POLICY_PATH` then the checked-in path; `null` reads no
   * file at all — the code defaults plus the env and override layers, which is what a unit test
   * wants when it is testing the precedence chain itself.
   */
  readonly file?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Programmatic overrides, the layer tests and the spike use to allowlist an ephemeral origin. */
  readonly overrides?: PolicyOverrides;
}

/**
 * The full precedence chain — code default < file < env < explicit override — as a document. Kept
 * separate from `loadPolicy` so preflight can inspect a document without a run, and so the chain
 * itself is testable without a browser or a file on disk.
 */
export async function resolvePolicyDocument(sources: PolicySources = {}): Promise<PolicyDocument> {
  const env = sources.env ?? process.env;
  const file = sources.file === undefined ? (env["POLICY_PATH"] ?? DEFAULT_POLICY_PATH) : sources.file;

  const fromFile = file === null ? undefined : await readPolicyFile(file);
  // The env layer sits *between* the file and the caller's explicit values, which is the order the
  // file headers state: a test or the spike that names a value in code means it, even on a machine
  // whose environment happens to carry a `POLICY_*` variable from an unrelated run.
  const withEnv = applyEnvScalars(mergeDocument(fromFile), env);
  return parsePolicyDocument(mergeDocument(withEnv, sources.overrides));
}

/**
 * The policy a run executes under. Everything that can act holds one of these; nothing acts
 * without asking it (§3 key-1).
 */
export class Policy implements ActionPolicy {
  readonly document: PolicyDocument;

  constructor(document: PolicyDocument) {
    this.document = parsePolicyDocument(document);
  }

  /** Load from the usual places: `POLICY_PATH`, the checked-in file, the env layer. */
  static async load(sources: PolicySources = {}): Promise<Policy> {
    return new Policy(await resolvePolicyDocument(sources));
  }

  /** §6's guardrail decision for one action — the choke point's question. */
  async review(context: ActionContext): Promise<PolicyVerdict> {
    return classify(this.document, context);
  }
}
