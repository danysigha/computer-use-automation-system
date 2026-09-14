/**
 * The capability artifact — §4.1's schema, in zod (§11 P2).
 *
 * This file is the contract between the two worlds §3 names: the recorder writes against it
 * (P4), the replay engine compiles against it (P5), and a calling agent reads it. Three rules
 * shaped it.
 *
 * 1. **`TargetDescriptor` is not restated here.** §4.1's target shape already has a canonical
 *    home in `src/surface/target.ts`, where the resolver consumes it; writing it out again would
 *    create a second definition free to drift from the first. So this file imports the *type* and
 *    proves at compile time that the schemas below accept exactly it
 *    (`schemaAgreesWithResolverTypes`, at the bottom) — a candidate this validator accepts is, by
 *    construction, one the resolver can execute. The runtime role list is the one thing that
 *    cannot be imported, and it carries its own exhaustiveness proof for the same reason.
 *
 * 2. **Shape lives here; rules that need the whole artifact live in `validate.ts`.** A rule that
 *    reads one field (a `pattern` must compile as a regex) belongs beside the field. A rule that
 *    reads two (every `irreversibleSteps` id names an existing `act` step) does not, because it
 *    has no field to sit on.
 *
 * 3. **Types are inferred from the schemas**, so the type and the runtime check cannot disagree —
 *    the same reason `target.ts` is the single home of the target types.
 *
 * Objects are strict throughout. The plan's own scar here is F8: §7 once claimed
 * `perVariantOverrides` fields the schema did not have, and a reviewer caught it. Strictness makes
 * that class of drift impossible to ship — an artifact carrying a field this schema does not
 * declare is rejected loudly instead of being silently stripped and ignored. The escape hatch is
 * `schemaVersion`, which is what a genuine shape change is supposed to bump.
 */
import { z } from "zod";
import type { CandidateRole, TargetCandidate, TargetDescriptor } from "../surface/target.ts";

/** §4.1's `schemaVersion`. A shape change is a new value here, not a quiet addition below. */
export const SCHEMA_VERSION = "1.0";

/* -------------------------------------------------------------------------- */
/* Names, placeholders, and routes — the three little languages in the schema  */
/* -------------------------------------------------------------------------- */

/** A regex the schema can compile is a regex the engine can run. */
function compilesAsRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a declared name looks like (`Param.name`, `Output.name`, extract step names). It is also
 * the placeholder vocabulary below, which is the point: `{memberId}` resolves because a `Param`
 * named `memberId` is spelled the same way. One source, so the scanner can never accept a
 * placeholder the `Param` schema would have refused.
 */
const NAME_SOURCE = "[A-Za-z_][A-Za-z0-9_-]*";
const NAME_PATTERN = new RegExp(`^${NAME_SOURCE}$`);
const PLACEHOLDER_SOURCE = String.raw`\{(${NAME_SOURCE})\}`;

/** Every `{name}` in a value, in order of appearance. §9's binding rule decides what gets one. */
export function placeholdersIn(value: string): readonly string[] {
  return [...value.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))].map((match) => match[1] ?? "");
}

/**
 * `urlMatches` syntax (§4.1, §28): two variable syntaxes, one meaning each — `{param}`
 * interpolates the caller's declared input, `:name` matches any single non-empty segment.
 *
 * The syntax is defined once, here, because two consumers have to agree about it: validation
 * (this file rejects a pattern with no variable segment at all) and the route matcher (P5, which
 * decides what a pattern *matches*). P5 owns the matching semantics; this owns only the spelling.
 * Two syntaxes is deliberate, not drift, and REPORT §2 owes the reader that sentence.
 */
const ROUTE_VARIABLE_SOURCE = String.raw`\{${NAME_SOURCE}\}|(?:^|/):${NAME_SOURCE}`;

/** Does this pattern constrain anything a `urlContains` would not? See the vacuity rule below. */
export function hasRouteVariable(pattern: string): boolean {
  return new RegExp(ROUTE_VARIABLE_SOURCE).test(pattern);
}

/* -------------------------------------------------------------------------- */
/* Target descriptors — validated against target.ts, never restated            */
/* -------------------------------------------------------------------------- */

/**
 * The roles a `role` candidate may name. `target.ts` owns the `CandidateRole` union, but a zod
 * enum needs the values at runtime, so the list has to be written out somewhere. The two checks
 * below are what stop it from becoming a second source of truth: `satisfies` proves every entry is
 * a real role, and the exhaustiveness alias proves no real role is missing.
 */
const CANDIDATE_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "option",
  "listbox",
  "menuitem",
  "tab",
  "switch",
  "spinbutton",
  "cell",
  "columnheader",
  "rowheader",
  "heading",
] as const satisfies readonly CandidateRole[];

const roleCandidateSchema = z.strictObject({
  strategy: z.literal("role"),
  role: z.enum(CANDIDATE_ROLES),
  // A role candidate exists to be named: §4.1 records one only when the element has an accessible
  // name, and an unnamed one would resolve to nothing. Rejecting it here means an artifact can
  // never claim a strategy the recorder refuses to emit.
  name: z.string().min(1),
});

const textCandidateSchema = z.strictObject({
  strategy: z.literal("text"),
  text: z.string().min(1),
});

const rowRelativeCandidateSchema = z.strictObject({
  strategy: z.literal("row-relative"),
  row: z.strictObject({ by: z.literal("cell-text"), text: z.string().min(1) }),
  column: z.strictObject({ by: z.literal("header-text"), text: z.string().min(1) }).optional(),
  action: z.enum(["cell", "button-in-row", "link-in-row"]),
});

const cssCandidateSchema = z.strictObject({
  strategy: z.literal("css"),
  selector: z.string().min(1),
  // The one positional strategy (§4.1): an index is what it means, so it is required and not
  // defaulted — a silent 0 would turn a recorded intent into "the first one".
  index: z.number().int().min(0),
});

export const targetCandidateSchema = z.discriminatedUnion("strategy", [
  roleCandidateSchema,
  textCandidateSchema,
  rowRelativeCandidateSchema,
  cssCandidateSchema,
]);

export const targetDescriptorSchema = z.strictObject({
  // Ordered, and never empty: an empty chain is a step that can only fail.
  candidates: z.array(targetCandidateSchema).min(1),
  framePath: z.array(z.number().int().min(0)).optional(),
});

/** The role list covers the union — a missing role makes this `never`, which will not assign. */
type EveryRoleIsListed = Assert<
  Exclude<CandidateRole, (typeof CANDIDATE_ROLES)[number]> extends never ? true : false
>;

/* -------------------------------------------------------------------------- */
/* State assertions                                                            */
/* -------------------------------------------------------------------------- */

const ASSERTION_KEYS = ["urlContains", "urlMatches", "elementExists", "elementAbsent", "textEquals"] as const;

/**
 * A route pattern that asserts nothing is rejected (§28, rule 3): a pattern with no variable
 * segment says no more than `urlContains` would, so it reads as a checkpoint while checking
 * nothing. The message names the fix, per the plan's DX rule that every rejection carries one.
 */
const routePatternSchema = z
  .string()
  .min(1)
  .refine(hasRouteVariable, {
    message:
      "a urlMatches pattern must contain a variable segment ({param} interpolates an input, " +
      ":name matches any single segment) — a pattern with neither asserts nothing urlContains " +
      "would not; write urlContains instead",
  });

/**
 * One schema per assertion shape, keyed by the key it requires — the same names `ASSERTION_KEYS`
 * lists, so the gate below can look up the member an author actually wrote. The `satisfies` is a
 * coverage proof: a sixth assertion key added to the list without a member here fails `typecheck`.
 */
const ASSERTION_MEMBERS = {
  urlContains: z.strictObject({ urlContains: z.string().min(1) }),
  urlMatches: z.strictObject({ urlMatches: routePatternSchema }),
  elementExists: z.strictObject({ elementExists: targetDescriptorSchema }),
  elementAbsent: z.strictObject({ elementAbsent: targetDescriptorSchema }),
  textEquals: z.strictObject({ textEquals: z.strictObject({ target: targetDescriptorSchema, value: z.string() }) }),
} as const satisfies Record<(typeof ASSERTION_KEYS)[number], z.ZodType>;

const assertionUnion = z.union([
  ASSERTION_MEMBERS.urlContains,
  ASSERTION_MEMBERS.urlMatches,
  ASSERTION_MEMBERS.elementExists,
  ASSERTION_MEMBERS.elementAbsent,
  ASSERTION_MEMBERS.textEquals,
]);

/**
 * §4.1's `StateAssertion`: exactly one of five shapes.
 *
 * The gate in front of the union is not a second copy of the rule, it is how the rule gets to
 * report itself. A plain union over five strict objects describes a malformed assertion as a pile
 * of per-member complaints, because every member sees the same input — and one of those complaints
 * is `Unrecognized key: "elementExists"` at the assertion's own path, which tells an author who
 * wrote `elementExists` correctly to delete it. So the gate picks the one key that was written,
 * validates the value against *that* member alone, and reports that member's issues; the union then
 * runs only to give this schema its inferred type, which is the one thing the gate cannot provide.
 *
 * The union never sees a failing value, because a failing one has already been reported here and
 * zod does not run the second half of a pipe whose first half failed.
 */
export const stateAssertionSchema = z
  .any()
  .superRefine((value, ctx) => {
    const written =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? ASSERTION_KEYS.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        : [];
    const key = written[0];
    if (written.length !== 1 || key === undefined) {
      ctx.addIssue({ code: "custom", message: `a state assertion must carry exactly one of: ${ASSERTION_KEYS.join(", ")}` });
      return;
    }

    const parsed = ASSERTION_MEMBERS[key].safeParse(value);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  })
  .pipe(assertionUnion);

/**
 * §4.1's `SuccessCondition` is a `StateAssertion`, and deliberately not a parallel vocabulary: a
 * pattern the engine can assert at the end of a run is exactly one it can assert at step 3, and
 * giving the two different shapes would mean the engine carries two checkers that can disagree.
 */
export const successConditionSchema = stateAssertionSchema;

/* -------------------------------------------------------------------------- */
/* Params, outputs, outcomes                                                   */
/* -------------------------------------------------------------------------- */

export const paramSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN, "must be a name usable as a {placeholder}"),
  type: z.enum(["string", "int", "money"]),
  // Optional: most inputs need no shape beyond their type. When present it must compile — a
  // broken regex here would only surface at the CLI, as a usage error on the wrong input.
  pattern: z
    .string()
    .min(1)
    .refine(compilesAsRegex, { message: "must be a valid regular expression" })
    .optional(),
  description: z.string().min(1),
});

/**
 * §4.1's `Extractor`. One member today, written as a discriminated union because `kind` is the
 * seam: a second extraction source would be a new member here rather than a new optional field.
 */
export const extractorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("extract"), stepId: z.number().int().positive() }),
]);

export const outputSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN, "must be a name usable as a {placeholder}"),
  type: z.enum(["string", "money"]),
  source: extractorSchema,
  // Required, never defaulted. §27 makes this a recorded fact and §6 makes policy
  // `redact.outputIds` the floor; defaulting it to `false` would mean a hand-written or
  // hand-edited artifact silently opted *out* of redaction, which is the one direction a safety
  // field must not fail in.
  redact: z.boolean(),
});

/**
 * An outcome signature is a regex over the app's real message (§4.1's soundness rules), so it has
 * to compile, and it has to be anchored enough to mean something. The vacuity rule is the plan's
 * own: empty, `.*`, or anything matching the empty string matches every page there is, and a
 * signature that fires on every page would terminate every run as that outcome.
 *
 * Note what is deliberately *not* scanned for `{param}` placeholders here: this is a pattern over
 * rendered page text, and the fixture's messages interpolate the id into the text itself
 * (`No member 99999 on file`), which is what `\d{5}` in §4.2's shipped pattern matches.
 */
const signaturePatternSchema = z
  .string()
  .min(1)
  .refine(compilesAsRegex, { message: "must be a valid regular expression" })
  // The `compilesAsRegex` guard is load-bearing, not belt-and-braces: zod runs every refinement
  // even after one has failed, so without it a malformed pattern would be *compiled* here to test
  // vacuity and would throw a SyntaxError out of validation instead of being reported as the
  // regex error it is. A pattern that does not compile is already accounted for above.
  .refine((pattern) => !compilesAsRegex(pattern) || !new RegExp(pattern).test(""), {
    message:
      "matches the empty string, so it would fire on any page — anchor it to the app's real " +
      "message (the shipped signatures are whole-message patterns, never broad substrings)",
  });

const outcomeDetectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text-on-page"), pattern: signaturePatternSchema }),
  // `target` is required for this kind for the same reason `pattern` is optional on the other:
  // §4.1 marks it optional only because a text-on-page signature has nothing to point at.
  z.strictObject({
    kind: z.literal("element-shown"),
    pattern: signaturePatternSchema,
    target: targetDescriptorSchema,
  }),
]);

export const businessOutcomeSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'must be SCREAMING_SNAKE_CASE (e.g. "NO_SUCH_ENTITY")'),
  detect: outcomeDetectSchema,
  // May interpolate `{param}` — this is the caller-facing sentence, so it is scanned for
  // placeholders by `validate.ts` along with the step literals.
  message: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/** Step ids are the schema's only cross-references (`risk`, `Output.source`), so they are 1-based. */
const stepIdSchema = z.number().int().positive();

const navigateStepSchema = z.strictObject({
  id: stepIdSchema,
  kind: z.literal("navigate"),
  url: z.string().min(1),
});

const waitStepSchema = z.strictObject({
  id: stepIdSchema,
  kind: z.literal("wait"),
  // "fixed" is a deliberate pause, not an error state (§4.1). Whether one carries the other's
  // field is a cross-field rule and lives in `validate.ts` — a refined member cannot join a
  // discriminated union, which is exactly the boundary rule 2 above draws.
  condition: z.enum(["load", "fixed"]),
  ms: z.number().int().positive().optional(),
});

const actStepSchema = z.strictObject({
  id: stepIdSchema,
  kind: z.literal("act"),
  action: z.enum(["click", "type", "select", "press"]),
  target: targetDescriptorSchema,
  value: z.string().optional(),
  // REQUIRED, and the requirement is load-bearing three times over (§4.1): it anchors the
  // three-way handback of §8, it localizes a failure to the step that broke, and it is what makes
  // "an act with no observable delta" unrepresentable rather than merely discouraged.
  expect: stateAssertionSchema,
});

const extractStepSchema = z.strictObject({
  id: stepIdSchema,
  kind: z.literal("extract"),
  name: z.string().regex(NAME_PATTERN, "must be a name usable as a {placeholder}"),
  target: targetDescriptorSchema,
  as: z.enum(["text", "table-cell"]),
});

const assertStepSchema = z.strictObject({
  id: stepIdSchema,
  kind: z.literal("assert"),
  name: z.string().regex(NAME_PATTERN, "must be a name usable as a {placeholder}"),
  condition: stateAssertionSchema,
});

export const stepSchema = z.discriminatedUnion("kind", [
  navigateStepSchema,
  waitStepSchema,
  actStepSchema,
  extractStepSchema,
  assertStepSchema,
]);

/* -------------------------------------------------------------------------- */
/* The capability                                                              */
/* -------------------------------------------------------------------------- */

/**
 * §4.1's `app` block, the tenant seam of §7 and the identity §26's preflight reads. `product` and
 * `variant` are free strings rather than the literals §4.1 writes for the fixture's values
 * ("atlas-console"/"base") because §26 stamps this block from the marker a target advertises
 * during *that* run — a literal would make an artifact recorded against any other variant
 * unrepresentable, which is precisely the cross-tenant case the seam exists for.
 */
export const appSchema = z.strictObject({
  product: z.string().min(1),
  variant: z.string().min(1),
  version: z.string().min(1),
});

/**
 * `entry` is checked for the shape a browser needs, not for membership: the allowlist is policy
 * (P3) and is read at preflight, so encoding it here would put the same rule in two places with
 * two ways to disagree. A `{param}` in the entry is legal, which is why this is a scheme check
 * rather than `new URL()` — WHATWG parsing percent-encodes the braces that the placeholder syntax
 * is written with.
 */
export const surfaceSchema = z.strictObject({
  kind: z.literal("web-dom"),
  entry: z.string().regex(/^https?:\/\//, "must be an absolute http(s) URL"),
});

/**
 * §4.1's `risk` block: the recorded fact §27 gives a producer (the recorder, from the verdict the
 * run's own choke point produced) and a reader (replay's preflight, which binds on the stricter of
 * artifact and policy). The two halves are cross-checked in `validate.ts` — they cannot disagree.
 */
export const riskSchema = z.strictObject({
  class: z.enum(["safe", "approval-gated"]),
  irreversibleSteps: z.array(stepIdSchema),
});

/**
 * `reviewedBy` presence means reviewed, never "approved" (§4.1). It stays optional because
 * absence is a meaningful state — unreviewed — and the review pass is what fills the outcome
 * signatures a successful recording cannot witness.
 */
export const provenanceSchema = z.strictObject({
  recordedAt: z.iso.datetime(),
  model: z.string().min(1),
  discoveryRunId: z.string().min(1),
  reviewedBy: z.literal("human").optional(),
});

export const capabilitySchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  // Kebab, and it has to be: this string is a directory name in `capabilities/` (§16), so the
  // grammar that reads as a naming convention is also what keeps `load()` from being handed a
  // path traversal. `validate.ts` does not re-check it; the pattern is the check.
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case (e.g. "member-savings-balance")'),
  name: z.string().min(1),
  description: z.string().min(1),
  app: appSchema,
  surface: surfaceSchema,
  inputs: z.array(paramSchema),
  outputs: z.array(outputSchema),
  success: successConditionSchema,
  // Ordered, and an ordered contract: §5.2 probes these in declaration order, so the earliest
  // declared match wins when two fire at the same settle. Duplicate codes are rejected in
  // `validate.ts` so the winner is always identifiable.
  outcomes: z.array(businessOutcomeSchema),
  // A capability with no steps can do nothing; the failure is worth naming here rather than
  // letting a caller discover an empty run.
  steps: z.array(stepSchema).min(1),
  risk: riskSchema,
  provenance: provenanceSchema,
});

/** The type the rest of the system compiles against — inferred, so it cannot drift from the check. */
export type Capability = z.infer<typeof capabilitySchema>;
export type Step = z.infer<typeof stepSchema>;
export type Param = z.infer<typeof paramSchema>;
export type Output = z.infer<typeof outputSchema>;
export type BusinessOutcome = z.infer<typeof businessOutcomeSchema>;
export type StateAssertion = z.infer<typeof stateAssertionSchema>;
export type Extractor = z.infer<typeof extractorSchema>;
export type RiskDeclaration = z.infer<typeof riskSchema>;
export type AppIdentity = z.infer<typeof appSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;

/* -------------------------------------------------------------------------- */
/* The proofs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compile-time type *identity*, not assignability.
 *
 * The obvious formulation — `[A] extends [B] ? ([B] extends [A] ? true : false) : false` — is too
 * weak here, and the way it fails is worth recording: structural assignability permits a *missing
 * optional property*, so a schema that had silently dropped `RowRelativeCandidate.column` still
 * satisfied both directions and the check reported success. This form asks whether the compiler
 * resolves the two types to the same type instead, which does catch that case (while still
 * tolerating `X | undefined` in an optional position, the same type under this config).
 */
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * `readonly` is erased on both sides before comparing. It is a real difference and a meaningless
 * one: `target.ts` freezes its shapes, zod infers mutable ones, and neither changes which *values*
 * are accepted. Everything else must match exactly.
 */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/** Instantiating this with `false` is a compile error where the alias is declared. */
type Assert<T extends true> = T;

/**
 * The proof that this file is a validator for `target.ts`'s types and not a re-description of
 * them (§11 P2's whole point). If either schema drifts from the resolver's types, `npm run
 * typecheck` fails on the line below.
 *
 * It is exported only because an unexported assertion of this kind is an unused declaration, which
 * `noUnusedLocals` rejects. The value is meaningless and nothing should import it.
 */
export const schemaAgreesWithResolverTypes: readonly [
  Assert<Equals<z.infer<typeof targetCandidateSchema>, DeepMutable<TargetCandidate>>>,
  Assert<Equals<z.infer<typeof targetDescriptorSchema>, DeepMutable<TargetDescriptor>>>,
  EveryRoleIsListed,
] = [true, true, true];
