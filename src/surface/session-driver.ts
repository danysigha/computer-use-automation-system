/**
 * SessionDriver — the surface seam (§3 key-4).
 *
 * Everything that touches a browser goes through here, which is what makes the policy choke
 * point real rather than aspirational: there is exactly one method that performs an action
 * (`execute`), so a guardrail cannot be bypassed by forgetting to call it — only by editing
 * this file. §8 adds the other half of that property: only the token holder may call
 * `execute`. The token itself arrives with the Controller in P6; the seam it needs is the
 * single-entry-point shape, which is here now.
 *
 * The Observer rides on this seam too (§8): `snapshot()` is the same call the discovery
 * agent, the replay-time escalation, and the operator console all make, so their views cannot
 * drift into two formats.
 *
 * The policy implementation is a **P1 stub**. It reviews every action, which is the part that
 * matters — the stub's verdict is always "allow" and it records that it was a stub, so the
 * real classifier in P3 replaces one object without touching call sites.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright";
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

export class PolicyBlockedError extends Error {
  readonly verdict: PolicyVerdict;
  constructor(verdict: PolicyVerdict) {
    super(`action blocked by policy (${verdict.rule}): ${verdict.reason}`);
    this.name = "PolicyBlockedError";
    this.verdict = verdict;
  }
}

/**
 * P1 placeholder: permits everything, and says so in the verdict. Its value is structural —
 * it proves the choke point is wired before the classifier exists, so P3 has somewhere to
 * land rather than a refactor to perform.
 */
export class RecordingPolicyStub implements ActionPolicy {
  readonly #seen: ActionContext[] = [];

  async review(context: ActionContext): Promise<PolicyVerdict> {
    this.#seen.push(context);
    return {
      allowed: true,
      approvalRequired: false,
      reason: "no classifier is wired yet (P1 stub)",
      rule: "stub.allow-all",
    };
  }

  get reviewed(): readonly ActionContext[] {
    return this.#seen;
  }
}

export interface SessionOptions {
  readonly headless?: boolean;
  /** Where screenshots land. Defaults to a fresh temp directory. */
  readonly evidenceDir?: string;
  readonly policy?: ActionPolicy;
  readonly observer?: Partial<ObserverOptions>;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Default timeout for element actions, in ms (policy `timing.waitFor` at P3+). */
  readonly actionTimeoutMs?: number;
}

export interface ExecutedAction {
  readonly action: SurfaceAction;
  readonly verdict: PolicyVerdict;
  /** Set for target-bearing actions; the chain that actually resolved, for the run log. */
  readonly resolved?: ResolvedTarget;
}

export class SessionDriver {
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #observer: Observer;
  readonly #policy: ActionPolicy;
  readonly #evidenceDir: string;
  #screenshotCount = 0;

  private constructor(browser: Browser, context: BrowserContext, page: Page, options: SessionOptions, evidenceDir: string) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#evidenceDir = evidenceDir;
    this.#observer = new Observer(page, options.observer ?? {});
    this.#policy = options.policy ?? new RecordingPolicyStub();
  }

  static async launch(options: SessionOptions = {}): Promise<SessionDriver> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    if (options.actionTimeoutMs !== undefined) page.setDefaultTimeout(options.actionTimeoutMs);

    const evidenceDir =
      options.evidenceDir ?? (await mkdtemp(join(tmpdir(), "atlas-session-")));
    return new SessionDriver(browser, context, page, options, resolve(evidenceDir));
  }

  get page(): Page {
    return this.#page;
  }

  get evidenceDir(): string {
    return this.#evidenceDir;
  }

  get policy(): ActionPolicy {
    return this.#policy;
  }

  /** The shared snapshot service (§8). The console and the agent read through this same object. */
  get observer(): Observer {
    return this.#observer;
  }

  /** Navigate without policy review — for bootstrapping the entry URL only. Steps use `execute`. */
  async goto(url: string): Promise<void> {
    await this.#page.goto(url, { waitUntil: "load" });
  }

  async snapshot(): Promise<Snapshot> {
    return this.#observer.snapshot();
  }

  async render(options?: RenderOptions): Promise<string> {
    const snapshot = await this.snapshot();
    return this.#observer.render(snapshot, options);
  }

  /**
   * The one method that acts on the page.
   *
   * Order is resolve → review → act. Resolving first is what lets the classifier see *what*
   * is about to be clicked (its accessible name and role) rather than only the descriptor it
   * came from — "the button whose name is Close account" is only classifiable once resolved.
   * It also means a step that cannot resolve fails as `ELEMENT_NOT_FOUND` before policy is
   * consulted, which keeps "the app changed" and "policy refused" from being conflated.
   */
  async execute(action: SurfaceAction): Promise<ExecutedAction> {
    if (action.kind === "navigate") {
      const verdict = await this.#policy.review({ action, targetName: null, targetRole: null });
      if (!verdict.allowed) throw new PolicyBlockedError(verdict);
      await this.#page.goto(action.url, { waitUntil: "load" });
      return { action, verdict };
    }

    const resolved = await resolveTarget(this.#page, action.target);
    const described = await resolved.element.evaluate((el) => ({
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    }));
    const verdict = await this.#policy.review({
      action,
      targetName: described.name === "" ? null : described.name,
      targetRole: described.role,
    });
    if (!verdict.allowed) {
      await resolved.element.dispose();
      throw new PolicyBlockedError(verdict);
    }

    await this.#perform(action, resolved.element);
    await resolved.element.dispose();
    return { action, verdict, resolved };
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

  /** Capture the current view and return the path, for the escalation payload and evidence. */
  async screenshot(label: string): Promise<string> {
    const dir = join(this.#evidenceDir, "screenshots");
    await mkdir(dir, { recursive: true });
    this.#screenshotCount += 1;
    const safe = label.split(/[^a-zA-Z0-9]+/).filter(Boolean).join("-").toLowerCase() || "shot";
    const path = join(dir, `${String(this.#screenshotCount).padStart(2, "0")}-${safe}.png`);
    await this.#page.screenshot({ path, fullPage: false });
    return path;
  }

  async close(): Promise<void> {
    await this.#context.close();
    await this.#browser.close();
  }
}
