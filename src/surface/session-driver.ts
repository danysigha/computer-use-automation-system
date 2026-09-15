/**
 * SessionDriver — the surface seam and the guardrail choke point (§3 key-1, §3 key-4).
 *
 * Everything that touches a browser goes through here, which is what makes the policy choke
 * point real rather than aspirational: there is exactly one method that performs an action
 * (`execute`), so a guardrail cannot be bypassed by forgetting to call it — only by editing
 * this file. §8 adds the other half of that property: only the token holder may call
 * `execute`. The token itself arrives with the Controller in P6; the seam it needs is the
 * single-entry-point shape, which is here now.
 *
 * P3 gives the one method its two guards, both **required** at construction so a run cannot start
 * without them:
 *
 * - `policy` — §6's classifier. Every action is reviewed *after* its target resolves, so the
 *   classifier sees what is about to be clicked rather than only the descriptor it came from.
 * - `redactor` — §6's scrubber. The driver is where a sensitive value first becomes known (it is
 *   the code that types it), so it is where the value is registered with the run's redactor; from
 *   there every sink scrubs it without knowing it exists.
 *
 * Three outcomes follow from a review, and they are three, not two: **allowed** (proceed),
 * **approval-required** (ask the approval seam — P6's escalation — and refuse if nobody answers or
 * the answer is no), and **blocked** (`NAVIGATION_BLOCKED`, §5.2's hard failure). Collapsing the
 * last two would either escalate things policy flatly forbids or silently perform things a human
 * was supposed to approve.
 *
 * The Observer rides on this seam too (§8): `snapshot()` is the same call the discovery
 * agent, the replay-time escalation, and the operator console all make, so their views cannot
 * drift into two formats.
 *
 * There is deliberately no `goto`. Bootstrapping the entry URL is a navigation like any other and
 * goes through `execute`, which is what keeps the choke point total — a second door would be the
 * one an action eventually walks through.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright";
import type { Redactor } from "../policy/redact.ts";
import { EvidenceLogger, type EvidenceLine } from "./evidence.ts";
import { Observer, type ObserverOptions, type RenderOptions, type Snapshot } from "./observer.ts";
import { resolveTarget, type ResolvedTarget, type TargetDescriptor } from "./target.ts";

export type SurfaceAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly target: TargetDescriptor }
  | { readonly kind: "type"; readonly target: TargetDescriptor; readonly value: string }
  | { readonly kind: "select"; readonly target: TargetDescriptor; readonly label: string }
  | { readonly kind: "press"; readonly target: TargetDescriptor; readonly key: string };

export interface ActionContext {
  readonly action: SurfaceAction;
  /** Live accessible name and role of the resolved target, for classification. */
  readonly targetName: string | null;
  readonly targetRole: string | null;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  /** True when the action may proceed only with human approval — feeds the §27 risk stamp. */
  readonly approvalRequired: boolean;
  readonly reason: string;
  /** Which rule produced the verdict; recorded in the run log so a later review can audit it. */
  readonly rule: string;
}

export interface ActionPolicy {
  review(context: ActionContext): Promise<PolicyVerdict>;
}

/**
 * §5.2's hard-failure code for "policy rejected an action". The taxonomy itself lands with the
 * replay engine (P5); the code is named here because this is where the condition is detected, and
 * a code that has to be re-derived at the far end of the call stack is a code that drifts.
 */
export class PolicyBlockedError extends Error {
  readonly code = "NAVIGATION_BLOCKED";
  readonly verdict: PolicyVerdict;
  constructor(verdict: PolicyVerdict) {
    super(`action blocked by policy (${verdict.rule}): ${verdict.reason}`);
    this.name = "PolicyBlockedError";
    this.verdict = verdict;
  }
}

/**
 * Raised when policy gates an action and no approval was given. This is **an escalation trigger,
 * not a failure**: §6's policy default is "block, then escalate with full context", so the run's
 * next move is to ask a human (P6's Controller, over the control bus), not to declare the
 * capability broken. A run with no approval seam therefore refuses the action rather than guessing
 * that the human would have said yes — which is the only safe reading of an unattended run.
 */
export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED";
  readonly request: ApprovalRequest;
  constructor(request: ApprovalRequest, reason: string) {
    super(`action is approval-gated and was not approved (${request.verdict.rule}): ${reason}`);
    this.name = "ApprovalRequiredError";
    this.request = request;
  }
}

export interface ApprovalRequest {
  readonly action: SurfaceAction;
  readonly targetName: string | null;
  readonly targetRole: string | null;
  readonly verdict: PolicyVerdict;
  /** What "full context" (§8) means to a caller: the live state the decision is about. */
  readonly url: string;
  readonly evidenceDir: string;
}

export type ApprovalDecision = "approved" | "denied";

/**
 * The escalation seam. §8's Controller implements this in P6 — raise the request on the bus, lease
 * the human token, act on the answer. Until then the only implementations are tests, and the
 * default (no handler) is a refusal, never an implied yes.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface SessionOptions {
  readonly headless?: boolean;
  /**
   * Where evidence lands. Defaults to a fresh temp directory — the same directory the logger
   * writes `run.jsonl` into, so a run's log and its screenshots are never split across two roots.
   */
  readonly evidenceDir?: string;
  /** §6's classifier. Required: a driver without one is a driver with no guardrails. */
  readonly policy: ActionPolicy;
  /** §6's scrubber. Required for the same reason — see the redactor's own note on shared state. */
  readonly redactor: Redactor;
  /** An existing logger (the agent loop's). When omitted the driver opens its own for the run. */
  readonly evidence?: EvidenceLogger;
  /** Where an approval-gated action goes to be decided. Absent means "refuse and say so". */
  readonly approval?: ApprovalHandler;
  readonly observer?: Partial<ObserverOptions>;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Default timeout for element actions, in ms (policy `timing.waitForMs`). */
  readonly actionTimeoutMs?: number;
}

export interface ExecutedAction {
  readonly action: SurfaceAction;
  readonly verdict: PolicyVerdict;
  /** Set for target-bearing actions; the chain that actually resolved, for the run log. */
  readonly resolved?: ResolvedTarget;
  /** `granted` when a human said yes at the approval seam; `not-required` otherwise. */
  readonly approval: "granted" | "not-required";
  /** True when the action wrote into a field the redactor considers sensitive. */
  readonly sensitive: boolean;
}

/**
 * A capture either happened or it was suppressed, and the caller has to be able to tell which: a
 * caller that treats a suppressed screenshot as a path will render a file that is not there.
 *
 * `data` is present only when the caller asked for it, because the two consumers want different
 * things from the same capture: evidence wants a file a human will open, and the discovery agent
 * wants bytes to send to a model without a round trip through the filesystem. Both read the *same*
 * pixels — one capture, two readers — which is what keeps the image the model reasoned about and the
 * image in the run's evidence from being two different moments of a page that was still moving.
 */
export type ScreenshotResult =
  | {
      readonly kind: "captured";
      readonly path: string;
      readonly mediaType: string;
      readonly data?: string;
    }
  | { readonly kind: "suppressed"; readonly reason: string; readonly fields: readonly string[] };

/**
 * How to encode a capture. PNG by default (lossless, what a human reviewing evidence wants);
 * the discovery loop asks for JPEG, where the trade is deliberate and paid for in §9's context.
 */
export interface ScreenshotEncoding {
  readonly type: "png" | "jpeg";
  readonly quality?: number;
}

export interface ScreenshotOptions {
  readonly encoding?: ScreenshotEncoding;
  /** Include the base64 bytes in the result. Skipped by default: a 150 KB PNG read back into
   *  memory for a caller that only wants the path is work nobody asked for. */
  readonly withData?: boolean;
}

export class SessionDriver {
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #observer: Observer;
  readonly #policy: ActionPolicy;
  readonly #redactor: Redactor;
  readonly #evidence: EvidenceLogger;
  readonly #approval: ApprovalHandler | undefined;
  readonly #evidenceDir: string;
  #screenshotCount = 0;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SessionOptions,
    evidenceDir: string,
    evidence: EvidenceLogger,
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#evidenceDir = evidenceDir;
    this.#evidence = evidence;
    this.#observer = new Observer(page, options.observer ?? {});
    this.#policy = options.policy;
    this.#redactor = options.redactor;
    this.#approval = options.approval;
  }

  static async launch(options: SessionOptions): Promise<SessionDriver> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    if (options.actionTimeoutMs !== undefined) page.setDefaultTimeout(options.actionTimeoutMs);

    const evidenceDir = resolve(options.evidenceDir ?? (await mkdtemp(join(tmpdir(), "atlas-session-"))));
    const evidence = options.evidence ?? (await EvidenceLogger.open(evidenceDir, options.redactor));
    return new SessionDriver(browser, context, page, options, evidenceDir, evidence);
  }

  get page(): Page {
    return this.#page;
  }

  get evidenceDir(): string {
    return this.#evidenceDir;
  }

  /** The run's evidence writer, for callers (the agent loop, the engine) that log their own lines. */
  get evidence(): EvidenceLogger {
    return this.#evidence;
  }

  get policy(): ActionPolicy {
    return this.#policy;
  }

  get redactor(): Redactor {
    return this.#redactor;
  }

  /** The shared snapshot service (§8). The console and the agent read through this same object. */
  get observer(): Observer {
    return this.#observer;
  }

  async snapshot(): Promise<Snapshot> {
    return this.#observer.snapshot();
  }

  /** Append a line to the run log. The one entry point for anything that wants to be evidential. */
  async log(line: EvidenceLine): Promise<void> {
    await this.#evidence.write({ actor: "agent", ...line });
  }

  async render(options?: RenderOptions): Promise<string> {
    const snapshot = await this.snapshot();
    return this.#observer.render(snapshot, options);
  }

  /**
   * The one method that acts on the page.
   *
   * Order is resolve → review → permit → act. Resolving first is what lets the classifier see
   * *what* is about to be clicked (its accessible name and role) rather than only the descriptor it
   * came from — "the button whose name is Close account" is only classifiable once resolved. It also
   * means a step that cannot resolve fails as `ELEMENT_NOT_FOUND` before policy is consulted, which
   * keeps "the app changed" and "policy refused" from being conflated.
   *
   * `permit` sits between review and act so that the one place a verdict becomes a decision is
   * inside the choke point: a caller cannot receive an approval-gated verdict and act on it anyway,
   * because the only path to the page runs through the check.
   */
  async execute(action: SurfaceAction): Promise<ExecutedAction> {
    if (action.kind === "navigate") {
      const context: ActionContext = { action, targetName: null, targetRole: null };
      const verdict = await this.#policy.review(context);
      const approval = await this.#permit(verdict, context);
      await this.#page.goto(action.url, { waitUntil: "load" });
      return this.#record({ action, verdict, approval, sensitive: false });
    }

    const resolved = await resolveTarget(this.#page, action.target);
    const described = await resolved.element.evaluate(
      (element, attributes) => ({
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        attributes: attributes.map((name) => element.getAttribute(name)),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      }),
      FIELD_ATTRIBUTES,
    );
    const label = fieldLabel(described.attributes);
    const context: ActionContext = {
      action,
      // A form control carries no text of its own, so its identity is what it is *called* —
      // `aria-label`, `name`, `id`, `placeholder` — which is the same string `#liveSensitiveFields`
      // builds for that same element. Describing a textbox by its `textContent` would name every
      // input `""`, and a classifier that cannot name the field cannot gate it (§6's fieldName
      // rule) nor register its value with the redactor. One label function, both callers.
      targetName: label !== "" ? label : described.text || null,
      targetRole: described.role,
    };
    const verdict = await this.#policy.review(context);

    let approval: ExecutedAction["approval"];
    try {
      approval = await this.#permit(verdict, context);
    } catch (error: unknown) {
      await resolved.element.dispose();
      throw error;
    }

    // Register the literal *before* it is typed, so the value cannot reach a sink even if the
    // action itself fails midway (§6: the scrubber follows the value, not the field).
    const sensitive = action.kind === "type" && this.#redactor.matchesField(context.targetName);
    if (sensitive && action.kind === "type") this.#redactor.noteValue(action.value);

    await this.#perform(action, resolved.element);
    await resolved.element.dispose();
    return this.#record({ action, verdict, resolved, approval, sensitive });
  }

  /**
   * Enforce a verdict. Three outcomes, and the middle one is why this returns rather than throws:
   * an approval-gated action that a human approved proceeds and says so in the evidence.
   */
  async #permit(verdict: PolicyVerdict, context: ActionContext): Promise<ExecutedAction["approval"]> {
    if (verdict.allowed) return "not-required";

    const request: ApprovalRequest = {
      action: context.action,
      targetName: context.targetName,
      targetRole: context.targetRole,
      verdict,
      url: this.#page.url(),
      evidenceDir: this.#evidenceDir,
    };

    // A gated action is recorded either way: a reviewer reading the log needs to see the decision
    // the run did *not* take, not only the ones it did.
    await this.#evidence.write({
      kind: "suppressed",
      subject: "policy",
      action: describeAction(context.action),
      rule: verdict.rule,
      reason: verdict.reason,
      approvalRequired: verdict.approvalRequired,
    });

    if (!verdict.approvalRequired) throw new PolicyBlockedError(verdict);

    const decision = this.#approval === undefined ? "unavailable" : await this.#approval(request);
    if (decision !== "approved") {
      throw new ApprovalRequiredError(
        request,
        decision === "unavailable"
          ? "no approval seam is wired, so nothing could approve it (§8's escalation arrives with the Controller)"
          : "the approver declined",
      );
    }
    await this.#evidence.write({
      kind: "decision",
      actor: "human",
      channel: "console",
      decision: "approved",
      rule: verdict.rule,
      action: describeAction(context.action),
    });
    return "granted";
  }

  /** Write the action line and return the executed record. Nothing reaches the page without one. */
  async #record(executed: ExecutedAction): Promise<ExecutedAction> {
    await this.#evidence.write({
      kind: "action",
      actor: "agent",
      action: describeAction(executed.action),
      outcome: "executed",
      rule: executed.verdict.rule,
      approval: executed.approval,
      ...(executed.sensitive ? { sensitive: true } : {}),
      ...(executed.resolved === undefined ? {} : { resolvedBy: executed.resolved.candidate.strategy }),
      url: this.#page.url(),
    });
    return executed;
  }

  async #perform(action: Exclude<SurfaceAction, { kind: "navigate" }>, element: ElementHandle): Promise<void> {
    switch (action.kind) {
      case "click":
        await element.click();
        return;
      case "type":
        // Replace semantics, never append (§4.1): a replayed `type` fills the field. This is
        // what makes a partially-typed value from a human handback safe to re-execute — it
        // cannot double into `1234512345`.
        await element.fill(action.value);
        return;
      case "select":
        await element.selectOption({ label: action.label });
        return;
      case "press":
        await element.press(action.key);
        return;
    }
  }

  /**
   * Capture the current view, for the escalation payload and evidence.
   *
   * **Suppressed while a sensitive field holds a value.** Pixels are the one sink the scrubber
   * cannot touch, so §6's answer is to not take the picture: a value typed into a
   * `redact.fieldPatterns` field never sits on screen while a capture runs. The check is live
   * rather than a flag the caller sets — the field is genuinely empty or it is not — which is also
   * why the suppression clears itself: once the human (or the next step) clears the field, evidence
   * screenshots work again, and the run's log says exactly which of the two happened.
   */
  async screenshot(label: string, options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const live = await this.#liveSensitiveFields();
    if (live.length > 0) {
      const reason =
        `screenshot suppressed: ${live.length} sensitive field(s) hold a value ` +
        `(${live.join(", ")}) — pixels cannot be scrubbed (§6)`;
      await this.#evidence.write({ kind: "suppressed", subject: "screenshot", label, reason, fields: live });
      return { kind: "suppressed", reason, fields: live };
    }

    const encoding = options.encoding ?? { type: "png" as const };
    const mediaType = encoding.type === "png" ? "image/png" : "image/jpeg";
    const dir = join(this.#evidenceDir, "screenshots");
    await mkdir(dir, { recursive: true });
    this.#screenshotCount += 1;
    const path = join(
      dir,
      `${String(this.#screenshotCount).padStart(2, "0")}-${slug(label)}.${encoding.type === "png" ? "png" : "jpg"}`,
    );
    // One call to the page's capture, and both readers come off it. A second capture would be a
    // second moment: the image the model reasoned about would be a different frame from the one in
    // evidence, and a reviewer comparing them would be comparing two pages.
    const shot = await this.#page.screenshot({
      path,
      type: encoding.type,
      fullPage: false,
      ...(encoding.quality === undefined ? {} : { quality: encoding.quality }),
    });
    await this.#evidence.write({ kind: "note", subject: "screenshot", label, path, mediaType });
    return options.withData === true
      ? { kind: "captured", path, mediaType, data: shot.toString("base64") }
      : { kind: "captured", path, mediaType };
  }

  /** Serialize the live DOM into evidence, scrubbed as text. The other half of §6's sink list. */
  async domSnapshot(label: string): Promise<string> {
    return this.#evidence.domSnapshot(label, await this.#page.content());
  }

  /**
   * The names (never the values) of fields currently holding something sensitive. Frames are walked
   * too: the fixture's balance grid lives in one, and a check that only looked at the top document
   * would call a page clean while a secret sat in a frame.
   *
   * The pattern interpretation stays node-side — the page reports each field's identifying
   * attributes and whether it is filled, and `fieldLabel` + `Redactor.matchesField` decide. Shipping
   * the patterns into the page instead would put a second copy of the matching rules in a place that
   * cannot import this one, which is how the redactor and the classifier drift apart.
   */
  async #liveSensitiveFields(): Promise<readonly string[]> {
    const names: string[] = [];
    for (const frame of this.#page.frames()) {
      const fields = await frame
        .evaluate(
          (attributes) =>
            [...document.querySelectorAll("input, textarea, select")].map((element) => ({
              attributes: attributes.map((name) => element.getAttribute(name)),
              filled:
                element instanceof HTMLSelectElement
                  ? element.value !== ""
                  : (element as HTMLInputElement | HTMLTextAreaElement).value !== "",
            })),
          FIELD_ATTRIBUTES,
        )
        .catch(() => [] as { attributes: (string | null)[]; filled: boolean }[]);
      for (const field of fields) {
        const label = fieldLabel(field.attributes);
        if (field.filled && label !== "" && this.#redactor.matchesField(label)) names.push(label);
      }
    }
    return names;
  }

  async close(): Promise<void> {
    await this.#context.close();
    await this.#browser.close();
  }
}

/**
 * One line describing an action, for the run log. Written by hand rather than with
 * `JSON.stringify` on purpose: the serializer is the redactor's (§6's one pipeline), so nothing
 * else in `src/` builds a JSON payload — a rule with a structural test behind it
 * (`tests/unit/serialization-sinks.test.ts`), which this function would otherwise be the first
 * thing to break.
 */
function describeAction(action: SurfaceAction): string {
  switch (action.kind) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return "click target";
    case "type":
      return `type into target (${action.value.length} chars)`;
    case "select":
      return `select "${action.label}"`;
    case "press":
      return `press ${action.key}`;
  }
}

/**
 * The attributes a form control can be identified by, in the order the label is built. A bank's
 * markup spells the same field `aria-label="Taxpayer SSN"` and `name="taxpayerSsn"`; both spellings
 * are the field, so both go into the label.
 */
const FIELD_ATTRIBUTES: string[] = ["aria-label", "name", "id", "placeholder"];

/**
 * What a field is called — **one** function, because two callers must never disagree about it. The
 * type action's review asks "does a `fieldName` risk rule gate this?", and `#liveSensitiveFields`
 * asks "does this field's value need scrubbing?"; both compare the string built here against the
 * same policy patterns. Two builders would let a field be gated but not scrubbed, which is a leak
 * wearing a guardrail's uniform.
 */
function fieldLabel(attributes: readonly (string | null)[]): string {
  return attributes.filter((part): part is string => part !== null && part !== "").join(" ");
}

function slug(label: string): string {
  return label.split(/[^a-zA-Z0-9]+/).filter(Boolean).join("-").toLowerCase() || "shot";
}
