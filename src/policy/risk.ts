/**
 * The risk classifier — the single place an action's verdict is decided (§6, §11 P3).
 *
 * Everything that acts goes through `SessionDriver.execute`, and every call there asks this module
 * one question: may this happen, and under what conditions? Three rule families answer it, in this
 * order, because the order is the security property:
 *
 * 1. **The read family is always safe.** `read`/`extract`/`screenshot` observe; they cannot change
 *    the world, so nothing gates them. (They are not `SurfaceAction`s yet — P4's tools call
 *    `checkOperation` directly — but the vocabulary is fixed here so the allowlist can name them.)
 * 2. **Everything else must be listed** in `allowlist.actions`. Deny-by-default: a new operation
 *    added to the driver is not silently permitted by an old policy file.
 * 3. **Risk rules gate, they do not block.** A matched `approvalRequired` rule produces
 *    `approvalRequired: true` with `allowed: false`, which is the escalation trigger (§8) — not a
 *    hard failure. A *blocked* action (not listed, or off-allowlist) is a different thing entirely:
 *    `NAVIGATION_BLOCKED`, the §5.2 hard-failure class.
 *
 * That distinction is the reason `PolicyVerdict` carries two booleans instead of one. Collapsing
 * them would make "a human should approve this" and "this is not allowed at all" the same value,
 * and the driver — which must escalate on the first and refuse on the second — could not tell them
 * apart.
 *
 * `classify` is pure and synchronous; `Policy` (in `policy.ts`) is the loader that gives it a
 * document. Keeping the decision free of I/O is what lets the whole matrix be tested as a table.
 */
import type { ActionContext, PolicyVerdict, SurfaceAction } from "../surface/session-driver.ts";
import { namePattern } from "./pattern.ts";
import type { PolicyDocument, RiskRule } from "./policy.ts";

/**
 * §6's "full driver operation vocabulary" — the choke point is total only if the allowlist can
 * name every operation the driver will ever perform. `wait`/`read`/`extract`/`screenshot` are here
 * ahead of their implementations (P4/P5) for exactly that reason: a policy that cannot name them
 * would either have to be edited later (a policy change to ship a feature — the wrong direction) or
 * would silently permit them.
 */
export const OPERATIONS = [
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "wait",
  "read",
  "extract",
  "screenshot",
] as const;

export type DriverOperation = (typeof OPERATIONS)[number];

/** §6: the read family is always safe — it observes, it cannot act. */
export const READ_FAMILY: ReadonlySet<DriverOperation> = new Set(["read", "extract", "screenshot"]);

/** Operations that write a value into a field, and so can have a `fieldName`. */
const FIELD_OPERATIONS: ReadonlySet<DriverOperation> = new Set(["type", "select"]);

/**
 * Compile-time proof that the vocabulary above covers the driver: adding a `SurfaceAction` kind
 * without listing it here fails `npm run typecheck`, which is the moment to decide whether the
 * allowlist should be able to name it.
 */
type EverySurfaceActionIsAnOperation = SurfaceAction["kind"] extends DriverOperation ? true : never;
export const vocabularyCoversDriver: readonly [EverySurfaceActionIsAnOperation] = [true];

/* -------------------------------------------------------------------------- */
/* Origin identity (§6 "Origin canonicalization")                              */
/* -------------------------------------------------------------------------- */

/**
 * The normalized form of a URL's origin — the only thing the allowlist compares. Both sides are
 * normalized, so an entry URL and a redirect never fail policy on a cosmetic difference: case,
 * a default port written out loud (`http://localhost:80`), or `localhost` vs `127.0.0.1` (the same
 * machine, and Playwright's `page.url()` may report either). **Normalization never widens the
 * allowlist beyond that rule** — no wildcard hosts, no subdomain matching, no scheme relaxation.
 * Returns `null` for anything that is not an absolute http(s) URL, which the caller reports as a
 * block rather than guessing at.
 */
export function canonicalOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return null;

  const host = parsed.hostname.toLowerCase() === "localhost" ? "127.0.0.1" : parsed.hostname.toLowerCase();
  const defaultPort = scheme === "http:" ? "80" : "443";
  const port = parsed.port === "" || parsed.port === defaultPort ? "" : `:${parsed.port}`;
  return `${scheme}//${host}${port}`;
}

/** The same origin, normalized on both sides. */
export function originsEqual(left: string, right: string): boolean {
  const a = canonicalOrigin(left);
  const b = canonicalOrigin(right);
  return a !== null && a === b;
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

function allow(rule: string, reason: string): PolicyVerdict {
  return { allowed: true, approvalRequired: false, reason, rule };
}

function block(rule: string, reason: string): PolicyVerdict {
  return { allowed: false, approvalRequired: false, reason, rule };
}

function gate(rule: string, reason: string): PolicyVerdict {
  return { allowed: false, approvalRequired: true, reason, rule };
}

/** The operation an action context names. Reads the action itself, never a caller's claim about it. */
export function operationOf(context: ActionContext): DriverOperation {
  return context.action.kind;
}

/**
 * §6 rule 1 and 2: the read family is always safe; every other operation must be listed. Split out
 * from `classify` because P4's `read`/`screenshot` tools need this half without an `ActionContext`.
 */
export function checkOperation(document: PolicyDocument, operation: DriverOperation): PolicyVerdict {
  if (READ_FAMILY.has(operation)) {
    return allow("read-only.always-safe", `${operation} observes the page and cannot change it`);
  }
  if (!document.allowlist.actions.includes(operation)) {
    return block(
      "allowlist.action",
      `operation \`${operation}\` is not in the policy allowlist's \`actions\` ` +
        `(${document.allowlist.actions.join(", ")}) — add it to policy.json if the run should be ` +
        `able to perform it`,
    );
  }
  return allow("allowlist.action", `\`${operation}\` is a listed operation`);
}

/**
 * The §5.4 preflight check, expressed as a verdict so preflight and the runtime cannot disagree:
 * is this the origin the policy was written for? The reason string is the **exact fix** the plan
 * asks preflight to print — when the cause is the common one (the sample app on a non-default
 * `PORT`), it names the port.
 */
export function checkNavigation(document: PolicyDocument, url: string): PolicyVerdict {
  const op = checkOperation(document, "navigate");
  if (!op.allowed) return op;

  const origin = canonicalOrigin(url);
  if (origin === null) {
    return block("allowlist.origin", `\`${url}\` is not an absolute http(s) URL, so it cannot be matched against the origin allowlist`);
  }

  const allowedOrigins = document.allowlist.origins;
  if (!allowedOrigins.some((entry) => originsEqual(entry, url))) {
    const port = new URL(url).port;
    const fix =
      port === ""
        ? "update policy.json's `allowlist.origins`, or point the run at an allowlisted origin"
        : `policy allowlist does not include port ${port} — update policy.json or run the app on the allowlisted port`;
    return block(
      "allowlist.origin",
      `origin ${origin} is not allowlisted (allowlist: ${allowedOrigins.join(", ")}) — ${fix}`,
    );
  }

  // Routes narrow the origin; they never widen it (§6). `denyRoutes` is the shorthand for the
  // common case and `routes[].allow: false` the explicit one; both are regexes tested against the
  // pathname, so `/admin/` denies any path containing it.
  const path = new URL(url).pathname;
  for (const source of [...document.allowlist.denyRoutes, ...deniedRoutePatterns(document)]) {
    if (new RegExp(source).test(path)) {
      return block("allowlist.route-denied", `route ${path} matches the denied pattern ${source}`);
    }
  }

  return allow("allowlist.origin", `origin ${origin} is allowlisted`);
}

function deniedRoutePatterns(document: PolicyDocument): readonly string[] {
  return document.allowlist.routes.filter((route) => !route.allow).map((route) => route.pattern);
}

/**
 * Does a `risk.approvalRequired` rule fire on this action?
 *
 * A rule's criteria are conjunctive — every one declared must hold — and the plan's two shipped
 * rules show why both kinds exist: `{action: "click", text: "Close account"}` gates a *target*, and
 * `{action: "type", fieldName: "/ssn/"}` gates a *field*. `fieldName` is only meaningful where a
 * value is written, so it never matches a click: a rule about sensitive input must not be able to
 * gate an unrelated control that happens to sit near one.
 */
function ruleFires(rule: RiskRule, context: ActionContext): boolean {
  const { action, text, fieldName } = rule.matches;
  const operation = operationOf(context);
  if (action !== undefined && action !== operation) return false;
  if (text !== undefined && !namePattern(text).matches(context.targetName)) return false;
  if (fieldName !== undefined) {
    if (!FIELD_OPERATIONS.has(operation)) return false;
    if (!namePattern(fieldName).matches(context.targetName)) return false;
  }
  return true;
}

/** The matched rule, written for a human reading a run log — no `JSON.stringify` (see the sink rule). */
function describeRule(rule: RiskRule): string {
  const parts: string[] = [];
  if (rule.matches.action !== undefined) parts.push(`action=${rule.matches.action}`);
  if (rule.matches.text !== undefined) parts.push(`text=${rule.matches.text}`);
  if (rule.matches.fieldName !== undefined) parts.push(`fieldName=${rule.matches.fieldName}`);
  return parts.join(" ");
}

/**
 * The whole decision for one action: allowlist, then risk rules. Records which rule produced the
 * verdict so the §27 recorder can stamp the artifact from the run's own classifications and a later
 * review can audit *why* something was gated — "approval-gated" with no rule named is not auditable.
 */
export function classify(document: PolicyDocument, context: ActionContext): PolicyVerdict {
  const operation = operationOf(context);

  // The permission half, kept rather than discarded: the rule that *admits* an action is what a run
  // log wants to distinguish — "the origin allowlist admitted this navigation" is a different fact
  // from "the action allowlist admitted this click", and §27's stamp reads the same field.
  let permitted: PolicyVerdict;
  if (context.action.kind === "navigate") {
    permitted = checkNavigation(document, context.action.url);
  } else {
    permitted = checkOperation(document, operation);
  }
  if (!permitted.allowed) return permitted;

  for (const rule of document.risk.approvalRequired) {
    if (ruleFires(rule, context)) {
      const target = context.targetName === null ? `the ${operation} target` : `"${context.targetName}"`;
      return gate(
        "risk.approval-required",
        `${rule.note ?? "matches a policy approval rule"} (${describeRule(rule)}) — ${target} is ` +
          `approval-gated; a human decides, and replay records the upgrade`,
      );
    }
  }

  return allow(permitted.rule, `${permitted.reason}; it matches no approval rule`);
}
