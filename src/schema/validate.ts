/**
 * Artifact validation — the rules that need the whole document (§11 P2).
 *
 * `artifact.ts` owns shape: one field, checked in one place. This file owns every rule that has to
 * read two fields or more, which is why it exists as a separate step rather than as refinements on
 * the zod object. There is one reason that matters more than tidiness: **§4.1 promises that a
 * calling agent never receives a broken pointer.** An artifact whose `outputs[].source.stepId`
 * names a step that does not exist parses perfectly and fails at run time, in front of the caller.
 * So every cross-reference in the schema is resolved here, at validate time, and the artifact is
 * refused rather than shipped.
 *
 * Each rule is its own function, dispatched from `crossChecks`. They are not independent — a
 * renaming that fixes one can orphan a placeholder another owns — so they all append to one list
 * and the author sees the whole damage at once rather than fixing it one error per run.
 *
 * Failures are collected, not thrown: an author fixing an artifact wants the whole list, not the
 * first line of it. `parseCapability` is the throwing form for callers that want one.
 */
import {
  capabilitySchema,
  isUsableName,
  placeholdersIn,
  type Capability,
  type StateAssertion,
  type Step,
} from "./artifact.ts";
import type { z } from "zod";

/** One problem, located. `path` is a dotted path into the artifact (`steps.2.expect`). */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type Validation =
  | { readonly ok: true; readonly capability: Capability }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * §4.1: a `Param.name` must not collide with the CLI's own flags. The grammar is
 * `--<input-name> <value>`, so a `Param` named `version` would make `replay --version 2` mean two
 * different things — the artifact is refused at write time with a rename hint rather than becoming
 * a silent ambiguity at the CLI.
 */
const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set([
  "version",
  "entry",
  "policy",
  "json",
  "goal",
  "headed",
  "param",
  "allow-drift",
]);

/** §4.1's reserved flag set, in the order the plan writes it, for the rename hint. */
const RESERVED_LIST = "version/entry/policy/json/goal/headed/param/allow-drift";

/**
 * Why this string cannot be a declared input's name — or `null` when it can.
 *
 * The pre-run form of the rule `checkNamesAreUnambiguous` and the schema's own `NAME_PATTERN` enforce
 * on a finished artifact. §5.4's boundary is what it is for: a `discover --param 2fast=x` must exit 2
 * with a fix *before* a model is called, not surface later as a `VALIDATION_ERROR` business outcome
 * or, worse, as an artifact that fails to save after a run has already been paid for.
 *
 * The wording matches the artifact's own messages, because a caller who hits this at the CLI and
 * again in a saved file should read the same sentence twice rather than wonder if it is one problem.
 */
export function paramNameProblem(name: string): string | null {
  if (name === "") return "an input name cannot be empty";
  if (!isUsableName(name)) {
    return `"${name}" is not usable as a {placeholder} — names start with a letter or underscore and continue with letters, digits, underscores or dashes`;
  }
  return RESERVED_PARAM_NAMES.has(name) ? reservedNameMessage(name) : null;
}

/**
 * The reserved-flag half, on its own so the pre-run check and the artifact check say the same words.
 * They are separate entry points on purpose: here the *shape* of a name is `NAME_PATTERN`'s business
 * in the schema above, and reporting it a second time from `crossChecks` would show an author the
 * same problem twice under two paths.
 */
function reservedNameMessage(name: string): string {
  return (
    `"${name}" collides with the reserved CLI flag set (${RESERVED_LIST}); ` +
    `rename it — the flag grammar would make --${name} ambiguous`
  );
}

/**
 * Validate an artifact of unknown provenance — a freshly recorded one (P4), a file off disk (the
 * store), or anything a caller handed us. Returns the parsed capability so a caller cannot forget
 * to use the checked value instead of the input.
 */
export function validateCapability(input: unknown): Validation {
  const parsed = capabilitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };

  const issues = crossChecks(parsed.data);
  return issues.length === 0 ? { ok: true, capability: parsed.data } : { ok: false, issues };
}

export class CapabilityInvalidError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], context = "capability artifact") {
    super(`${context} is invalid:\n${formatIssues(issues)}`);
    this.name = "CapabilityInvalidError";
    this.issues = issues;
  }
}

/** The throwing form. Used by the store's `save`, so an invalid artifact is never persisted. */
export function parseCapability(input: unknown, context?: string): Capability {
  const result = validateCapability(input);
  if (!result.ok) throw new CapabilityInvalidError(result.issues, context);
  return result.capability;
}

/** Rendered for a terminal: one problem per line, each naming where it is. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  const plural = issues.length === 1 ? "problem" : "problems";
  return [`${issues.length} ${plural}:`, ...issues.map((issue) => `  · ${issue.path} — ${issue.message}`)].join(
    "\n",
  );
}

/* -------------------------------------------------------------------------- */
/* Cross-field rules                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a check reads: the artifact, the two indexes references resolve against, and the list they
 * all append to. Each check is a small function over this, so the rules below read one per function
 * rather than as one long walk over everything that can go wrong.
 */
interface Check {
  readonly capability: Capability;
  /** The names a `{placeholder}` may resolve to. */
  readonly declaredParams: ReadonlySet<string>;
  /** Steps by id — the schema's only cross-references name a step this way. */
  readonly stepById: ReadonlyMap<number, Step>;
  readonly issues: ValidationIssue[];
}

function crossChecks(capability: Capability): ValidationIssue[] {
  const check: Check = {
    capability,
    declaredParams: new Set(capability.inputs.map((param) => param.name)),
    stepById: new Map(capability.steps.map((step) => [step.id, step])),
    issues: [],
  };

  checkNamesAreUnambiguous(check);
  checkPlaceholdersResolve(check);
  checkOutcomesAreDistinguishable(check);
  checkWaitsSayHowLong(check);
  checkOutputsComeFromExtracts(check);
  checkRiskHalvesAgree(check);

  return check.issues;
}

/**
 * Names that have to be unique, and one that has to be free.
 *
 * Step ids carry the last line: `risk.irreversibleSteps` and `Output.source.stepId` both name a
 * step by id, so a duplicate makes both of them unresolvable even though every individual field
 * parses.
 */
function checkNamesAreUnambiguous(check: Check): void {
  for (const [index, param] of check.capability.inputs.entries()) {
    if (!RESERVED_PARAM_NAMES.has(param.name)) continue;
    check.issues.push({ path: `inputs.${index}.name`, message: reservedNameMessage(param.name) });
  }

  duplicateNames(check.capability.inputs.map((param) => param.name), "inputs", check.issues);
  duplicateNames(check.capability.outputs.map((output) => output.name), "outputs", check.issues);
  duplicateNames(check.capability.steps.map((step) => String(step.id)), "steps", check.issues, "id");
}

/** §9's binding rule: a `{placeholder}` is a declared `Param`, or the artifact means nothing. */
function checkPlaceholdersResolve(check: Check): void {
  scanPlaceholders(check, "surface.entry", check.capability.surface.entry);

  for (const [index, step] of check.capability.steps.entries()) {
    switch (step.kind) {
      case "navigate":
        scanPlaceholders(check, `steps.${index}.url`, step.url);
        break;
      case "act":
        if (step.value !== undefined) scanPlaceholders(check, `steps.${index}.value`, step.value);
        scanAssertion(check, `steps.${index}.expect`, step.expect);
        break;
      case "assert":
        scanAssertion(check, `steps.${index}.condition`, step.condition);
        break;
      case "wait":
      case "extract":
        break;
    }
  }

  scanAssertion(check, "success", check.capability.success);
  for (const [index, outcome] of check.capability.outcomes.entries()) {
    scanPlaceholders(check, `outcomes.${index}.message`, outcome.message);
  }
}

/** §5.2's ordered contract: signatures are probed in order, so one code may name only one entry. */
function checkOutcomesAreDistinguishable(check: Check): void {
  const seenCodes = new Map<string, number>();
  for (const [index, outcome] of check.capability.outcomes.entries()) {
    const first = seenCodes.get(outcome.code);
    if (first === undefined) {
      seenCodes.set(outcome.code, index);
      continue;
    }
    check.issues.push({
      path: `outcomes.${index}.code`,
      message:
        `duplicate outcome code "${outcome.code}" (already declared at outcomes.${first}); ` +
        "signatures are probed in declaration order and the earliest match wins, so two entries " +
        "with one code make the winner unidentifiable",
    });
  }
}

/**
 * A `"fixed"` wait is a deliberate pause and must say how long. This is a whole-document rule
 * rather than a field one for a mechanical reason: a refined object cannot be a member of a
 * `discriminatedUnion`, so the conditionality cannot sit on the `wait` schema itself.
 */
function checkWaitsSayHowLong(check: Check): void {
  for (const [index, step] of check.capability.steps.entries()) {
    if (step.kind === "wait" && step.condition === "fixed" && step.ms === undefined) {
      check.issues.push({
        path: `steps.${index}.ms`,
        message: 'a "fixed" wait is a deliberate pause and must say how long (`ms`)',
      });
    }
  }
}

/** An `Output` is a pointer to an extract step, and the two must agree on which value it names. */
function checkOutputsComeFromExtracts(check: Check): void {
  for (const [index, output] of check.capability.outputs.entries()) {
    const step = check.stepById.get(output.source.stepId);
    if (step === undefined) {
      check.issues.push({
        path: `outputs.${index}.source.stepId`,
        message: `names step ${output.source.stepId}, which the artifact does not declare`,
      });
    } else if (step.kind !== "extract") {
      check.issues.push({
        path: `outputs.${index}.source.stepId`,
        message: `names step ${step.id}, whose kind is "${step.kind}" — only an extract step produces an output`,
      });
    } else if (step.name !== output.name) {
      check.issues.push({
        path: `outputs.${index}.source.stepId`,
        message:
          `names extract step ${step.id}, which is named "${step.name}" but supplies output ` +
          `"${output.name}" — the names must match, or the pointer is to a different value`,
      });
    }
  }
}

/**
 * §27: the two halves of `risk` are one statement, and they cannot disagree.
 *
 * `irreversibleSteps` non-empty **iff** `class` is `"approval-gated"`. Both directions are checked
 * because a caller reading `class` and a caller reading the list must never be told different
 * things — the artifact is what both of them trust.
 */
function checkRiskHalvesAgree(check: Check): void {
  const { class: riskClass, irreversibleSteps } = check.capability.risk;

  for (const [index, stepId] of irreversibleSteps.entries()) {
    const step = check.stepById.get(stepId);
    if (step === undefined) {
      check.issues.push({
        path: `risk.irreversibleSteps.${index}`,
        message: `names step ${stepId}, which the artifact does not declare`,
      });
    } else if (step.kind !== "act") {
      check.issues.push({
        path: `risk.irreversibleSteps.${index}`,
        message: `names step ${stepId}, whose kind is "${step.kind}" — only an act can be irreversible`,
      });
    }
  }

  if (riskClass === "approval-gated" && irreversibleSteps.length === 0) {
    check.issues.push({
      path: "risk.irreversibleSteps",
      message: 'risk.class is "approval-gated" but the list is empty — name the steps that require approval',
    });
  }
  if (riskClass === "safe" && irreversibleSteps.length > 0) {
    check.issues.push({
      path: "risk.class",
      message:
        `risk.class is "safe" but irreversibleSteps names ${irreversibleSteps.length} step(s) — ` +
        'a capability with an irreversible step is "approval-gated"',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Small scanners                                                              */
/* -------------------------------------------------------------------------- */

/** Every `{placeholder}` in a value, reported at the path that value occupies. */
function scanPlaceholders(check: Check, path: string, value: string): void {
  for (const name of placeholdersIn(value)) {
    if (check.declaredParams.has(name)) continue;
    check.issues.push({
      path,
      message:
        `placeholder {${name}} names no declared input` +
        (check.declaredParams.size === 0
          ? " (the artifact declares no inputs at all); declare it in `inputs` or remove the braces"
          : `; declared inputs: ${[...check.declaredParams].join(", ")}`),
    });
  }
}

/** Every `{placeholder}` in an assertion's literals, at the path that assertion actually occupies. */
function scanAssertion(check: Check, path: string, assertion: StateAssertion): void {
  if ("urlContains" in assertion) scanPlaceholders(check, `${path}.urlContains`, assertion.urlContains);
  // A `urlMatches` pattern's variables are `{param}` / `:name`, and only the first is a placeholder
  // — the second is the route syntax itself (§28) — so the same scanner is the right one here.
  else if ("urlMatches" in assertion) scanPlaceholders(check, `${path}.urlMatches`, assertion.urlMatches);
  else if ("textEquals" in assertion) {
    scanPlaceholders(check, `${path}.textEquals.value`, assertion.textEquals.value);
  }
}

function duplicateNames(
  names: readonly string[],
  collection: string,
  issues: ValidationIssue[],
  field = "name",
): void {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(name)) {
      issues.push({
        path: `${collection}.${index}.${field}`,
        message: `duplicate ${field} "${name}" in ${collection} — references to it would be ambiguous`,
      });
    }
    seen.add(name);
  }
}

/* -------------------------------------------------------------------------- */
/* zod issues → our issues                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Flatten a zod error into located messages.
 *
 * The one subtlety is `invalid_union`, which carries its per-member failures in a nested `errors`
 * array: reporting only the union's own summary ("Invalid input") would tell an author nothing
 * about which of five assertion shapes they got wrong. So the nested failures are flattened in,
 * de-duplicated, and the branch only falls back to the summary when there is nothing better.
 */
function toIssues(error: z.ZodError): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  const push = (path: string, message: string): void => {
    const key = `${path} ${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ path: path === "" ? "(root)" : path, message });
  };

  const walk = (current: z.core.$ZodIssue, prefix: string): void => {
    const path = [prefix, ...current.path.map(String)].filter((part) => part !== "").join(".");
    const nested: unknown = (current as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      const leaves = nested.flat() as z.core.$ZodIssue[];
      if (leaves.length > 0) {
        for (const leaf of leaves) walk(leaf, path);
        return;
      }
    }
    push(path, current.message);
  };

  for (const issue of error.issues) walk(issue, "");
  return issues;
}
