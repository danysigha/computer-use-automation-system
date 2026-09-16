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
 *
 * **The read half (P5).** Replay has to ask the page questions that are not actions — is it still
 * loading, what does it say, is a password field on it, does this chain resolve — and the
 * alternative to putting them here is the engine reaching into `#page` from outside, which is the
 * seam this file exists to be. So the reads live here too, in one block below, and none of them
 * acts: `execute` remains the only method that changes anything. They are deliberately **not**
 * policy-checked, matching the observer's own snapshot reads (P4 reads through `snapshot()` for the
 * same reason); `allowlist.actions` does name `read`/`extract`, and that entry is the seam a future
 * gated-read path would consult — stated plainly rather than left as an implied guarantee.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright";
import type { Redactor } from "../policy/redact.ts";
import { EvidenceLogger, type EvidenceActor, type EvidenceLine, type HumanChannel } from "./evidence.ts";
import { Observer, type ObserverOptions, type RenderOptions, type Snapshot } from "./observer.ts";
import {
  isCandidateRole,
  isResolvable,
  normalizeText,
  quote,
  resolveTarget,
  type ResolvedTarget,
  type TargetCandidate,
  type TargetDescriptor,
} from "./target.ts";

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

/**
 * What an approver can answer, and the third one is P6's.
 *
 * `approved` and `denied` are the two §6 gives: the human's verdict on the action. `satisfied` is
 * §8's resume rule reaching the one place it can still save a double-fire — **the step's
 * postcondition already holds**, so the action must not be performed at all. It exists because an
 * approval escalation happens *inside* `execute`: by the time the human has answered, they may have
 * carried the step out themselves in the console (or the step may have completed while they looked),
 * and performing the click on top of that is exactly the `1234512345` class of bug §8 pins. A second
 * boolean beside `approved` would say the same thing in a shape a caller can misread; a third member
 * cannot.
 */
export type ApprovalDecision = "approved" | "denied" | "satisfied";

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
  /**
   * `granted` when a human said yes at the approval seam, `not-required` when policy allowed the
   * action outright, and `satisfied` when the seam found the step's postcondition already holding —
   * in which case the action was deliberately **not** performed (see `ApprovalDecision`).
   */
  readonly approval: "granted" | "not-required" | "satisfied";
  /** True when the action wrote into a field the redactor considers sensitive. */
  readonly sensitive: boolean;
}

/**
 * Who is acting, for §3 key-3's control-transfer record. The driver stamps it on the lines it
 * writes, because the driver is the only place every action passes through and therefore the only
 * place the attribution can be made once rather than by each caller.
 */
export interface ExecuteOptions {
  readonly actor?: EvidenceActor;
  readonly channel?: HumanChannel;
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

/**
 * A dialog standing on the page, as `findDialog` reports it.
 *
 * `text` is what policy's `recoverableDialogs` are matched against. `control` is a descriptor the
 * caller can hand straight back to `execute` — or `null` when the dialog carries nothing the
 * resolver can address, which is a fact the caller has to act on (escalate) rather than a detail it
 * can ignore.
 */
export interface DialogObservation {
  readonly text: string;
  readonly control: TargetDescriptor | null;
  /** How the control was addressed, for the run log. */
  readonly via: string;
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
  /** See `lastDocumentStatus`. A box rather than a field because the listener owns the writing. */
  readonly #documentStatus: { value: number | null };
  /** See `lastNavigationFailure`, and the box's own note above. */
  readonly #documentFailure: { value: string | null };
  /** See `#withinBudget`. The same number the actions use, because it is the same budget. */
  readonly #readBudgetMs: number;
  #screenshotCount = 0;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SessionOptions,
    evidenceDir: string,
    evidence: EvidenceLogger,
    documentStatus: { value: number | null },
    documentFailure: { value: string | null },
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#evidenceDir = evidenceDir;
    this.#evidence = evidence;
    this.#documentStatus = documentStatus;
    this.#documentFailure = documentFailure;
    this.#readBudgetMs = options.actionTimeoutMs ?? DEFAULT_READ_BUDGET_MS;
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

    // The main document's HTTP status, kept for the engine's classifier (§5.2: "the app responded
    // but unusably"). Only the **main frame's** document responses count: a subresource or an
    // iframe's own document answering 500 is not the page failing to render, and counting those
    // would let an unrelated frame misclassify the step in flight.
    const documentStatus: { value: number | null } = { value: null };
    page.on("response", (response) => {
      if (response.request().resourceType() !== "document") return;
      if (response.frame() !== page.mainFrame()) return;
      documentStatus.value = response.status();
    });

    // The other half of the same fact, and the one a URL cannot tell you: a navigation that *failed*
    // still moves the address (Chromium keeps the requested URL on the page it shows instead), so
    // "the browser left the old URL" is not the same question as "a document arrived" (§5.2's
    // transport failure). Cleared when a navigation is issued — see `execute` — so it always
    // describes the most recent one rather than any that ever failed.
    const documentFailure: { value: string | null } = { value: null };
    page.on("requestfailed", (request) => {
      if (request.resourceType() !== "document") return;
      if (request.frame() !== page.mainFrame()) return;
      documentFailure.value = request.failure()?.errorText ?? "the request failed";
    });

    const evidenceDir = resolve(options.evidenceDir ?? (await mkdtemp(join(tmpdir(), "atlas-session-"))));
    const evidence = options.evidence ?? (await EvidenceLogger.open(evidenceDir, options.redactor));
    return new SessionDriver(browser, context, page, options, evidenceDir, evidence, documentStatus, documentFailure);
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
  async execute(action: SurfaceAction, options: ExecuteOptions = {}): Promise<ExecutedAction> {
    if (action.kind === "navigate") {
      const context: ActionContext = { action, targetName: null, targetRole: null };
      const verdict = await this.#policy.review(context);
      const approval = await this.#permit(verdict, context, options);
      // Cleared here, because both facts describe *this* navigation: a status or a failure from an
      // earlier one would otherwise outlive the page it happened on and be read against a navigation
      // that is still in flight (see `lastNavigationFailure`).
      this.#documentStatus.value = null;
      this.#documentFailure.value = null;
      if (approval === "satisfied") {
        return this.#record({ action, verdict, approval, sensitive: false }, options);
      }
      await this.#page.goto(action.url, { waitUntil: "load" });
      return this.#record({ action, verdict, approval, sensitive: false }, options);
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
      approval = await this.#permit(verdict, context, options);
    } catch (error: unknown) {
      await resolved.element.dispose();
      throw error;
    }

    // Register the literal *before* it is typed, so the value cannot reach a sink even if the
    // action itself fails midway (§6: the scrubber follows the value, not the field).
    const sensitive = action.kind === "type" && this.#redactor.matchesField(context.targetName);
    if (sensitive && action.kind === "type") this.#redactor.noteValue(action.value);

    // The one arm that does not act: a seam that answered "the postcondition already holds" is
    // telling the driver the work is done, and §8's rule is that a completed step is never performed
    // again. Recorded like any other action, so the reason the click did not happen is on file.
    if (approval !== "satisfied") await this.#perform(action, resolved.element);
    await resolved.element.dispose();
    return this.#record({ action, verdict, resolved, approval, sensitive }, options);
  }

  /**
   * Enforce a verdict. Three outcomes, and the middle one is why this returns rather than throws:
   * an approval-gated action that a human approved proceeds and says so in the evidence.
   */
  async #permit(
    verdict: PolicyVerdict,
    context: ActionContext,
    options: ExecuteOptions = {},
  ): Promise<ExecutedAction["approval"]> {
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

    const decision = this.#approval === undefined ? "denied" : await this.#approval(request);
    if (decision === "satisfied") {
      await this.#evidence.write({
        kind: "decision",
        // A satisfaction is a fact about the page, not a human's act — but it is only ever reached on
        // a path a human was on, so the line carries the actor the caller was acting as.
        actor: options.actor ?? "agent",
        ...(options.channel === undefined ? {} : { channel: options.channel }),
        decision: "satisfied",
        rule: verdict.rule,
        action: describeAction(context.action),
      });
      return "satisfied";
    }
    if (decision !== "approved") {
      throw new ApprovalRequiredError(
        request,
        decision === "denied" && this.#approval === undefined
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
  async #record(executed: ExecutedAction, options: ExecuteOptions = {}): Promise<ExecutedAction> {
    await this.#evidence.write({
      kind: "action",
      actor: options.actor ?? "agent",
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      action: describeAction(executed.action),
      outcome: executed.approval === "satisfied" ? "already satisfied — not performed" : "executed",
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

  /* ------------------------------------------------------------------------ */
  /* The read half — questions, never actions                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Ask a question, and answer `unanswered` if the page takes longer than the budget to respond.
   *
   * Every read below needs this, and the reason is not tidiness. `frame.evaluate` cannot be given a
   * timeout, and it does not obey Playwright's default one either: **on a frame whose navigation is
   * still outstanding it waits for the new execution context**, so it blocks until the app finally
   * answers — measured at 11.8s while the default timeout stood at 200ms, in the probe that found
   * this. That turns replay's step budget into a fiction. §22's pinned terminal is "the budget ran
   * out → `failure` under the detected condition", and a read that outlives the deadline converts
   * that into "the app eventually answered": the poll's clock is only real if every question in it
   * returns, so each one is raced against the budget and gives up.
   *
   * Giving up is not a new verdict — it is the "no answer" each caller already documents: a frame
   * mid-navigation counts as settled (see `isSettled`), an unreadable page has no text, no dialog
   * and no password field. What changes is that the poll can now act on those facts *within its
   * budget* instead of after the app decides to speak.
   *
   * The abandoned evaluation is left to settle on its own; it has a `catch`, so nothing is
   * unhandled, and it resolves at the latest when the navigation it was waiting on commits.
   */
  async #withinBudget<T>(question: () => Promise<T>, unanswered: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(unanswered), this.#readBudgetMs);
    });
    try {
      return await Promise.race([question().catch(() => unanswered), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether every visible document has finished loading (`readyState === "complete"`).
   *
   * All frames, because the choke point's own frame rules are: a page is not settled while a frame
   * it needs is still arriving. Frames that cannot be evaluated (cross-origin, mid-navigation)
   * count as settled — the alternative is a check that never returns true on a page carrying an
   * unreadable frame, which would turn a working app into a permanent `SLOW_LOAD`. Mid-navigation
   * is where that matters: the previous document is complete and the new one has not arrived, so
   * "settled" is exactly the state §22 calls `navigationPending`, and the poll reads it off the
   * step's own expectation rather than off this answer (see the engine's `checkExpectation`).
   */
  async isSettled(): Promise<boolean> {
    return this.#withinBudget(async () => {
      for (const frame of this.#page.frames()) {
        const state = await frame.evaluate(() => document.readyState).catch(() => "complete");
        if (state !== "complete") return false;
      }
      return true;
    }, true);
  }

  /**
   * The text a person would read off the page, normalized, frames included — the string §4.1's
   * outcome signatures are matched against.
   *
   * `innerText`, not `textContent`: a signature is a claim about what the app *shows*, and the
   * fixture's build marker is `hidden` precisely so that the two are different questions.
   */
  async visibleText(): Promise<string> {
    return this.#withinBudget(async () => {
      const parts: string[] = [];
      for (const frame of this.#page.frames()) {
        const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (text !== "") parts.push(text);
      }
      return normalizeText(parts.join("\n"));
    }, "");
  }

  /**
   * Is a password field on the page? §5.2's signature for a login screen appearing mid-flow
   * (`SESSION_EXPIRED`) — and the one signal that needs no route knowledge, so a session that
   * expires onto a differently-spelled login page is still caught.
   */
  async hasPasswordField(): Promise<boolean> {
    return this.#withinBudget(async () => {
      for (const frame of this.#page.frames()) {
        const found = await frame
          .evaluate(() => document.querySelector('input[type="password"]') !== null)
          .catch(() => false);
        if (found) return true;
      }
      return false;
    }, false);
  }

  /**
   * The HTTP status of the main document's most recent response, or `null` before the first one.
   *
   * Read by replay's classifier for `TRANSIENT_ERROR` (§5.2: "the app responded but unusably").
   * It is the *response*, not an exception, which is the distinction §5.2 draws between a 5xx and a
   * transport failure — so it arrives as a fact about the last navigation rather than as a throw.
   * No budget here: it is a field the response listener wrote, not a question asked of the page.
   */
  lastDocumentStatus(): number | null {
    return this.#documentStatus.value;
  }

  /**
   * The browser's own words for why the most recent navigation delivered no document, or `null` when
   * it did (or when none was issued).
   *
   * A navigation that fails is not a navigation that did not happen: Chromium shows an error page
   * *at the requested URL*, so `page.url()` has moved and the step's own `navigated` check would
   * report the step as having arrived. That misreading is what this answers — §5.2 files the failure
   * as `TRANSPORT_ERROR` (recoverable, "the next attempt is a fresh question") rather than letting a
   * run walk onto an error page and fail later on whatever it looks for first. The text is
   * Playwright's (`net::ERR_CONNECTION_REFUSED` and friends), because `observed` is more useful
   * carrying it than carrying a paraphrase.
   */
  lastNavigationFailure(): string | null {
    return this.#documentFailure.value;
  }

  /** Does this chain resolve to exactly one node right now? Backs `elementExists`/`elementAbsent`. */
  async resolves(descriptor: TargetDescriptor): Promise<boolean> {
    // Bounded for the same reason as the reads above — resolution is a question too, and a locator
    // query against a page mid-navigation waits with it. "Cannot confirm it resolves" is already
    // this predicate's false branch, which is what makes `elementAbsent` on a page that is still
    // answering a *retryable* state rather than a settled absence.
    return this.#withinBudget(() => isResolvable(this.#page, descriptor), false);
  }

  /**
   * A modal dialog standing on the page, its own text, and the control that answers it.
   *
   * §5.2's `INTERSTITIAL_DIALOG` is detected here rather than by an artifact target, because a
   * dialog is by definition the thing nothing recorded: the artifact has no candidate chain for it,
   * and it must not need one. So the *page* is asked what it is showing, and the answer comes back
   * in the two halves the caller needs — the text policy matches on, and a descriptor built from
   * the control's **live** accessible role and name.
   *
   * That last part is the design: the control is described as an ordinary role candidate, so
   * answering the dialog goes through `execute` like every other action — resolved, policy-reviewed,
   * recorded. A driver that clicked the node directly would be the second door this file exists to
   * close, and a dialog would be the one action in the system that no policy saw.
   *
   * `control` is null when the dialog carries nothing addressable (a `role="dialog"` of prose, or a
   * control whose role is not one the resolver names). The caller's move is then to escalate, which
   * is right: a dialog we cannot operate is a dialog a human has to.
   */
  async findDialog(): Promise<DialogObservation | null> {
    return this.#withinBudget(async () => {
      for (const frame of this.#page.frames()) {
        const found = await frame.evaluate((): RawDialog | null => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]');
          if (dialog === null) return null;
          const text = ((dialog as HTMLElement).innerText ?? dialog.textContent ?? "").replace(/\s+/g, " ").trim();

          const control = dialog.querySelector(
            'button, a[href], input[type=submit], input[type=button], [role="button"], [role="link"]',
          );
          if (control === null) return { text, role: null, name: null };
          // The *live* role and name, computed the way the accessibility tree computes them, because
          // those are the two things `getByRole` will match on. Reading them from the markup's
          // intention instead — "it's a `<button>`, so it's a button" — is how an `<a>` with no href
          // (not a link) or an `input[type=submit]` named by its `value` (which has no text content
          // at all) become descriptors that resolve to nothing or to everything.
          const tag = control.tagName.toLowerCase();
          const explicit = control.getAttribute("role");
          const role = explicit ?? (tag === "a" ? "link" : tag === "input" ? "button" : tag);
          const name =
            control.getAttribute("aria-label") ??
            control.getAttribute("title") ??
            (tag === "input" ? control.getAttribute("value") : null) ??
            (control as HTMLElement).innerText ??
            control.textContent ??
            "";
          return { text, role, name: name.replace(/\s+/g, " ").trim() };
        }).catch(() => null);

        if (found === null) continue;
        return { text: found.text, ...describeControl(found) };
      }
      return null;
    }, null);
  }

  /**
   * Resolve a target and read what it shows, without acting on it — the extract step's whole job.
   *
   * A target read through the **same resolver** the action path uses, which is the property that
   * matters: an extractor that resolved by its own rules could point at a different element than
   * the step that clicked there, and the artifact's candidate chain would mean two things.
   */
  async read(descriptor: TargetDescriptor): Promise<{ readonly text: string; readonly candidate: TargetCandidate }> {
    const resolved = await resolveTarget(this.#page, descriptor);
    try {
      return { text: await readElementText(resolved.element), candidate: resolved.candidate };
    } finally {
      await resolved.element.dispose();
    }
  }

  async close(): Promise<void> {
    await this.#context.close();
    await this.#browser.close();
  }
}

/**
 * What an element shows, as text: a form control's current **value**, otherwise its text content.
 *
 * One function, because the expectation and the extraction have to agree: §4.1's recorded
 * `textEquals` for a typed field is the value the recorder saw in the snapshot, whose own rule is
 * "static text, or a form control's current value". A `select` reports its selected option's label
 * rather than its value attribute, which is what an accessibility tree calls that control's value.
 */
export async function readElementText(element: ElementHandle<Element>): Promise<string> {
  const text = await element.evaluate((node) => {
    if (node instanceof HTMLSelectElement) {
      return node.selectedOptions[0]?.textContent ?? node.value;
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return node.value;
    return node.textContent ?? "";
  });
  return normalizeText(text);
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

/** What the page hands back from `findDialog`'s scan. Plain data: it crosses the process boundary. */
interface RawDialog {
  readonly text: string;
  readonly role: string | null;
  readonly name: string | null;
}

/**
 * A raw dialog's control as a descriptor, or `null` when nothing there can be addressed.
 *
 * A role candidate when the live role is one the resolver names and the control has a name — which
 * is the normal case and the one the fixture exercises (`<a class="btn">OK</a>` → `link`/`OK`). The
 * text fallback exists because a control's live role is sometimes not in that list (a `<span
 * role="presentation">` styled as a button) while its text is still unique; the resolver's own
 * exactly-one-match rule is what keeps that honest. When neither holds the answer is `null` and the
 * caller escalates, because a dialog nothing can address is a dialog a person has to answer.
 */
function describeControl(found: RawDialog): { control: TargetDescriptor | null; via: string } {
  const name = found.name ?? "";
  if (name === "") return { control: null, via: "the dialog has no addressable control" };

  const role = found.role ?? "";
  if (isCandidateRole(role)) {
    return {
      control: { candidates: [{ strategy: "role", role, name }] },
      via: `role=${role}[name=${quote(name)}]`,
    };
  }
  return {
    control: { candidates: [{ strategy: "text", text: name }] },
    via: `text=${quote(name)} (its live role ${quote(role)} is not one a role candidate may name)`,
  };
}

/**
 * The attributes a form control can be identified by, in the order the label is built. A bank's
 * markup spells the same field `aria-label="Taxpayer SSN"` and `name="taxpayerSsn"`; both spellings
 * are the field, so both go into the label.
 */
/**
 * What a read is worth when the caller set no `actionTimeoutMs`: Playwright's own default for
 * actions, so a driver that never named a budget keeps behaving as it did rather than acquiring a
 * new one here. Every caller that replays sets it (`policy.document.timing.waitForMs`).
 */
const DEFAULT_READ_BUDGET_MS = 30_000;

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
