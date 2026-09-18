/**
 * The Controller — §8's token, its lease, and the four-way resume question it makes answerable.
 *
 * §3 key-3 says it in one line: *who is in control is a token*. This file is that sentence as code.
 * One holder at a time (`AGENT → PAUSED_ESCALATED → HUMAN → RESUMING → AGENT`), only the holder may
 * call `SessionDriver.execute`, and the console is not a second control path but the *same* driver
 * reached through a socket — which is what makes "transfer control of the live session" structural
 * rather than a demo convention.
 *
 * Five decisions shape it, and every one of them is a §8 bullet rather than an implementation taste.
 *
 * 1. **An escalation is a request with a lease, not a pause.** Raising one publishes §8's payload
 *    (reason, step, live state, screenshot, log tail), mints a ≥128-bit single-use nonce, and starts
 *    two clocks: the console must heartbeat inside `timing.heartbeatMs` or its `timing.leaseTtlMs`
 *    lease lapses, and the escalation itself terminates at `timing.escalationTimeoutMs` as
 *    `HUMAN_UNAVAILABLE` / `escalation: "no-operator"`. A lapsed lease does **not** end the run — it
 *    returns the token to `PAUSED_ESCALATED`, mints a *fresh* nonce (so a replayed one cannot
 *    re-acquire) and re-raises, which is how a console that died mid-hold becomes observable instead
 *    of a stuck token.
 * 2. **Authorization is per request.** Acquisition takes the nonce; every request after it — state
 *    polls included — takes the bearer minted at acquisition. That split is what §8 asks for: the
 *    nonce is the one-time credential printed in the run's terminal, and the bearer is the session
 *    that credential bought. A second console is rejected rather than queued, because two operators
 *    driving one banking session is not a feature.
 * 3. **The console acts through the choke point, and its actor is recorded.** A command names a node
 *    index from the shared Observer model, which this class turns into a durable candidate chain the
 *    same way the agent's tool layer does (`captureTarget`), and then hands to `driver.execute` with
 *    `actor: human, channel: console`. Policy still applies: the operator inherits the allowlist, and
 *    a risk-gated action the operator performs is their own approval, recorded as such.
 * 4. **Human actions are counted, because the run's provenance depends on it.** §9/T14's rule is that
 *    a run which received in-flow human state changes never emits an artifact, and §25's carve-out
 *    distinguishes a console action from a direct `--headed` click. Both need an answer to "what did
 *    the human do while they held the token", so the count and the digest their last action produced
 *    are part of the takeover answer.
 * 5. **The four-way resume is the engine's decision, and this class hands it the facts.** Which
 *    branch applies (postcondition holds / precondition holds / partial progress / neither) is a
 *    question about the artifact's own step, so it is answered in `replay/engine.ts`. What this class
 *    contributes is the evidence: the state hash at escalation, the hash at handback, whether the
 *    console's log accounts for the difference, and whether the condition that *caused* the escalation
 *    is still standing.
 */
import { randomBytes } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import type { Redactor } from "../policy/redact.ts";
import type { RenderOptions } from "../surface/observer.ts";
import { stateDigest, type Snapshot, type SnapshotNode } from "../surface/observer.ts";
import type { EvidenceLine, StampedLine } from "../surface/evidence.ts";
import { captureTarget } from "../surface/capture.ts";
import type {
  ExecuteOptions,
  ExecutedAction,
  ScreenshotOptions,
  ScreenshotResult,
  SurfaceAction,
} from "../surface/session-driver.ts";
import type {
  EscalationAnswer,
  EscalationCode,
  EscalationRequest,
  RunStage,
  TakeoverAnswer,
} from "./escalation.ts";

/** §3 key-3's token states. `resuming` is the instant between handback and the run's next decision. */
export type ControlHolder = "agent" | "paused" | "human" | "resuming";

/**
 * The surface the console drives. `SessionDriver` satisfies it structurally; tests inject a fake so
 * the token machine, the lease arithmetic and the authorization rules can be exercised without a
 * browser (the same division §11 draws everywhere else: the rules are unit-testable, the behaviour is
 * integration-tested).
 */
export interface ControlSurface {
  readonly page: Page;
  readonly observer: {
    nodeAt(snapshot: Snapshot, index: number): SnapshotNode | null;
    elementFor(node: SnapshotNode): Promise<ElementHandle<Element> | null>;
  };
  readonly evidence: { readonly lines: readonly StampedLine[] };
  readonly evidenceDir: string;
  snapshot(): Promise<Snapshot>;
  render(options?: RenderOptions): Promise<string>;
  execute(action: SurfaceAction, options?: ExecuteOptions): Promise<ExecutedAction>;
  screenshot(label: string, options?: ScreenshotOptions): Promise<ScreenshotResult>;
  log(line: EvidenceLine): Promise<unknown>;
}

/** The three clocks §8 gives the escalation lifecycle. They come from policy `timing`. */
export interface ControlTiming {
  readonly heartbeatMs: number;
  readonly leaseTtlMs: number;
  readonly escalationTimeoutMs: number;
}

/** One semantic command from the operator console (§8's numbered grammar, as data). */
export type ConsoleCommand =
  | { readonly kind: "click"; readonly index: number }
  | { readonly kind: "type"; readonly index: number; readonly value: string }
  | { readonly kind: "press"; readonly index: number; readonly key: string };

/** What the console is told about the escalation it holds. Never includes the nonce. */
export interface EscalationView {
  readonly id: string;
  readonly code: EscalationCode;
  readonly stepId: number | null;
  readonly reason: string;
  readonly url: string;
  readonly observed: string;
  readonly evidenceDir: string;
  readonly capabilityId: string;
  readonly stage: RunStage;
  readonly raisedAt: string;
  /** Milliseconds until §8's terminal answers the escalation on the operator's behalf. */
  readonly terminatesInMs: number;
  readonly held: boolean;
  /** §8's screenshot: the path the console opens, or the reason there is none (§6's gate). */
  readonly screenshot: { readonly path: string } | { readonly suppressed: string };
  /** How many times the lease has lapsed and the escalation has re-raised. */
  readonly reRaised: number;
}

/** Everything the console renders for one moment of the run. */
export interface ConsoleState {
  readonly token: ControlHolder;
  readonly escalation: EscalationView;
  readonly snapshot: Snapshot;
  /** The live a11y dump — the *same* rendering the discovery digest is built from (§8, §24). */
  readonly dump: string;
  readonly mode: "compact" | "expanded";
  /** The tail of `run.jsonl`, already scrubbed by the logger that wrote it. */
  readonly logTail: readonly StampedLine[];
  readonly lease: { readonly ttlMs: number; readonly expiresInMs: number } | null;
  /** Console actions this escalation has carried out. */
  readonly humanActions: number;
}

export interface ConsoleSession {
  readonly bearer: string;
  readonly state: ConsoleState;
}

/** Why a console request could not be served. The bus maps these to HTTP status codes. */
export type ControlErrorCode =
  | "no-escalation"
  | "already-resolved"
  | "bad-nonce"
  | "spent-nonce"
  | "console-in-use"
  | "unauthorized"
  | "no-such-node"
  | "stale-node"
  | "unaddressable-node"
  | "policy-refused"
  | "action-failed";

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export interface ControllerOptions {
  readonly surface: ControlSurface;
  readonly timing: ControlTiming;
  readonly stage: RunStage;
  /** The capability id (replay) or the goal's slug (discovery), for §8's payload. */
  readonly runId: string;
  /** Injectable clock, so lease arithmetic is testable without waiting on a real one. */
  readonly now?: () => number;
  /** Operator-facing narration: the nonce, the lease lapse, the terminal. */
  readonly onNote?: (line: string) => void;
  /** §8's log tail: how many of the run's recent lines the console is shown. */
  readonly logTailLines?: number;
}

/** How much of `run.jsonl` rides along with a state poll. Enough to see the last few decisions. */
const DEFAULT_LOG_TAIL = 12;

/** How often the leases are checked. Fast enough that a small test can watch one lapse. */
const MIN_TICK_MS = 20;

interface PendingEscalation {
  readonly id: string;
  /** The request as raised, with the run's own identity filled in from the Controller's options. */
  readonly request: EscalationRequest & { readonly capabilityId: string; readonly stage: RunStage };
  /** Minted at raise time and again after every lapsed lease. Single-use. */
  nonce: string;
  /**
   * When an unanswered escalation gives up. Moves on a re-raise, because a re-raised escalation is a
   * new ask: a console that died just before the window closed would otherwise hand back an escalation
   * that expires a second later, and the operator would have no chance to answer the nonce they were
   * just given.
   */
  deadline: number;
  readonly raisedAt: number;
  /** The bearer the console holds, or `null` while no console is in control. */
  bearer: string | null;
  leaseUntil: number;
  humanActions: number;
  /** The state hash the console's most recent action produced, for §25's accounting. */
  digestAfterLastAction: string | null;
  readonly atEscalation: string;
  readonly screenshot: EscalationView["screenshot"];
  reRaised: number;
  answered: boolean;
  resolve: (answer: EscalationAnswer) => void;
}

export class Controller {
  readonly #surface: ControlSurface;
  readonly #timing: ControlTiming;
  readonly #stage: RunStage;
  readonly #runId: string;
  readonly #now: () => number;
  readonly #note: (line: string) => void;
  readonly #logTailLines: number;
  readonly #redactor: Redactor;

  #token: ControlHolder = "agent";
  #pending: PendingEscalation | null = null;
  #timer: NodeJS.Timeout | null = null;
  #escalations = 0;
  #humanActions = 0;
  /**
   * Where a console should connect, for the announcement. The CLI sets it once the bus is listening,
   * because only the bus knows which port it actually took (`BUS_PORT=0` is a legal spelling).
   */
  #busUrl: string = `http://127.0.0.1:${process.env["BUS_PORT"] ?? 4517}`;
  /** Nonces that have been spent or superseded. Kept so a replayed nonce is refused by name. */
  readonly #spentNonces = new Set<string>();

  constructor(options: ControllerOptions & { readonly redactor: Redactor }) {
    this.#surface = options.surface;
    this.#timing = options.timing;
    this.#stage = options.stage;
    this.#runId = options.runId;
    this.#now = options.now ?? (() => Date.now());
    this.#note = options.onNote ?? ((): void => undefined);
    this.#logTailLines = options.logTailLines ?? DEFAULT_LOG_TAIL;
    this.#redactor = options.redactor;
  }

  get token(): ControlHolder {
    return this.#token;
  }

  /** Tell the console where to connect. Set by the entrypoint once the bus has a port. */
  set busUrl(url: string) {
    this.#busUrl = url;
  }

  get busUrl(): string {
    return this.#busUrl;
  }

  /** True while an operator holds the token, which is when their own actions are self-approved. */
  get humanInControl(): boolean {
    return this.#pending !== null && this.#pending.bearer !== null && !this.#pending.answered;
  }

  /**
   * How many console actions this run has carried out, in total.
   *
   * §9/T14's artifact rule reads this: a discovery run that received in-flow human state changes may
   * not emit an artifact, because the recording would contain steps no autonomous run performed.
   */
  get humanActions(): number {
    return this.#humanActions;
  }

  /** The live escalation, for the bus and for tests. */
  get escalation(): EscalationView | null {
    const pending = this.#pending;
    return pending === null || pending.answered ? null : this.#view(pending);
  }

  /* ------------------------------------------------------------------------ */
  /* The escalation seam (§8)                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Raise an escalation and wait for §8's answer.
   *
   * This is the engine's `EscalationHandler`, and it is the same call the discovery loop makes when
   * its stuck detector fires. The wait ends in exactly three ways — a takeover, a decline, or the
   * escalation clock running out — and never in "still waiting", which is what §8's terminal exists
   * to guarantee.
   */
  async escalate(request: EscalationRequest): Promise<EscalationAnswer> {
    if (this.#pending !== null && !this.#pending.answered) {
      throw new Error("an escalation is already open — the Controller serves one at a time");
    }

    // §8's payload carries the live state, so it is read *before* the operator is told about it: a
    // console that connects and finds a different page than the request described would be deciding
    // on stale context.
    const snapshot = await this.#surface.snapshot();
    const captured = await this.#surface
      .screenshot(`escalation-${request.code.toLowerCase()}`)
      .catch((): ScreenshotResult => ({ kind: "suppressed", reason: "the capture failed", fields: [] }));
    const screenshot: EscalationView["screenshot"] =
      captured.kind === "captured" ? { path: captured.path } : { suppressed: captured.reason };

    const now = this.#now();
    const pending: PendingEscalation = {
      id: `${request.code}-${this.#escalations + 1}`,
      // §8's payload names the run. The raiser may know it (the replay engine holds the capability);
      // when it does not, the Controller's own construction is the answer — one place, not two.
      request: { ...request, capabilityId: request.capabilityId ?? this.#runId, stage: request.stage ?? this.#stage },
      nonce: this.#mintNonce(),
      deadline: now + this.#timing.escalationTimeoutMs,
      raisedAt: now,
      bearer: null,
      leaseUntil: 0,
      humanActions: 0,
      digestAfterLastAction: null,
      atEscalation: stateDigest(snapshot),
      screenshot,
      reRaised: 0,
      answered: false,
      // Replaced below, before anything can call it.
      resolve: (): void => undefined,
    };
    this.#pending = pending;
    this.#escalations += 1;
    this.#token = "paused";
    // Synchronously, before the evidence write is awaited: the escalation is observable the moment
    // `#pending` is set, and an operator who reads the terminal must already have the nonce by then —
    // a console that raced the announcement would present a nonce it was never given.
    this.#announce(pending);
    this.#startTimer();

    await this.#surface.log({
      kind: "note",
      subject: "escalation",
      message:
        `escalation ${request.code} at ${request.stepId === null ? "the entry" : `step ${request.stepId}`}: ` +
        request.reason,
      code: request.code,
      stepId: request.stepId,
      url: request.url,
      observed: request.observed,
      ...("path" in screenshot ? { screenshot: screenshot.path } : { screenshotSuppressed: screenshot.suppressed }),
    });

    return new Promise<EscalationAnswer>((resolve) => {
      pending.resolve = resolve;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* The console's side of the bus                                             */
  /* ------------------------------------------------------------------------ */

  /** Take control with the nonce the run printed. Mints the bearer §8 requires per request. */
  async acquire(nonce: string): Promise<ConsoleSession> {
    const pending = this.#requireOpen();
    if (this.#spentNonces.has(nonce)) {
      throw new ControlError("spent-nonce", "that takeover nonce has already been used — read the one the run just printed");
    }
    if (nonce !== pending.nonce) {
      throw new ControlError("bad-nonce", "that is not this escalation's nonce");
    }
    if (pending.bearer !== null) {
      throw new ControlError(
        "console-in-use",
        "another console already holds this escalation — only one operator may drive a session",
      );
    }

    this.#spentNonces.add(nonce);
    pending.bearer = this.#mintBearer();
    pending.leaseUntil = this.#now() + this.#timing.leaseTtlMs;
    this.#token = "human";
    await this.#surface.log({
      kind: "note",
      subject: "control",
      message: "an operator took control of the session over the control bus (§8)",
      actor: "human",
    });

    return { bearer: pending.bearer, state: await this.#stateFor(pending, "compact") };
  }

  /** The token state, the live page and the log tail. Requires the bearer (§8: polls included). */
  async status(bearer: string, mode: "compact" | "expanded" = "compact"): Promise<ConsoleState> {
    return this.#stateFor(this.#require(bearer), mode);
  }

  /** Renew the lease. A console that stops doing this loses the token at `leaseTtlMs`. */
  async heartbeat(bearer: string): Promise<ConsoleState> {
    const pending = this.#require(bearer);
    pending.leaseUntil = this.#now() + this.#timing.leaseTtlMs;
    return this.#stateFor(pending, "compact");
  }

  /** Carry out one semantic command through the choke point, attributed to the human. */
  async act(bearer: string, command: ConsoleCommand, mode: "compact" | "expanded" = "compact"): Promise<ConsoleState> {
    const pending = this.#require(bearer);
    const snapshot = await this.#surface.snapshot();
    const node = this.#surface.observer.nodeAt(snapshot, command.index);
    if (node === null) {
      throw new ControlError(
        "no-such-node",
        `the dump has no node [${command.index}] — indices run 0..${snapshot.numbered.length - 1}, and \`expand\` shows what the compact view hides`,
      );
    }

    const target = await this.#descriptorFor(node);
    const action: SurfaceAction =
      command.kind === "click"
        ? { kind: "click", target }
        : command.kind === "type"
          ? { kind: "type", target, value: command.value }
          : { kind: "press", target, key: command.key };

    try {
      await this.#surface.execute(action, { actor: "human", channel: "console" });
    } catch (error: unknown) {
      throw this.#consoleActionError(error, command);
    }

    pending.humanActions += 1;
    this.#humanActions += 1;
    pending.leaseUntil = this.#now() + this.#timing.leaseTtlMs;
    // The digest *after* the console's own action is the yardstick §25's carve-out compares against:
    // a handback state that matches it is a change the console produced, and one that does not is a
    // change nothing in the console log accounts for.
    pending.digestAfterLastAction = stateDigest(await this.#surface.snapshot());
    return this.#stateFor(pending, mode);
  }

  /** Capture the current view for the operator's `shot` verb, through the same §6 gate as evidence. */
  async shot(bearer: string): Promise<{ readonly path: string } | { readonly suppressed: string }> {
    this.#require(bearer);
    const captured = await this.#surface.screenshot("operator");
    return captured.kind === "captured" ? { path: captured.path } : { suppressed: captured.reason };
  }

  /** Give the token back. §8's handback: the engine re-verifies and decides, this only transfers. */
  async release(bearer: string): Promise<TakeoverAnswer> {
    const pending = this.#require(bearer);
    const atHandback = stateDigest(await this.#surface.snapshot());
    const accounted = pending.humanActions > 0 && atHandback === pending.digestAfterLastAction;
    const answer: TakeoverAnswer = {
      outcome: "took-over",
      humanActions: pending.humanActions,
      accounted,
      atEscalation: pending.atEscalation,
      atHandback,
    };

    await this.#surface.log({
      kind: "note",
      subject: "control",
      message:
        `the operator handed control back after ${pending.humanActions} action(s)` +
        (accounted || pending.humanActions === 0 ? "" : " — the page moved without an accounting console action"),
      actor: "human",
      humanActions: pending.humanActions,
      accounted,
    });
    this.#finish(pending, answer);
    return answer;
  }

  /** §8's `decline`: a person said no, on purpose. The run ends the way an unanswered one does. */
  async decline(bearer: string): Promise<void> {
    const pending = this.#require(bearer);
    await this.#surface.log({
      kind: "note",
      subject: "control",
      message: "the operator declined the escalation — the run stops here on purpose (§8)",
      actor: "human",
      decision: "declined",
    });
    this.#finish(pending, "declined");
  }

  /** Stop the clocks. The run is over, so nothing is waiting for an answer any more. */
  close(): void {
    this.#stopTimer();
    const pending = this.#pending;
    if (pending !== null && !pending.answered) this.#finish(pending, "unavailable");
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                 */
  /* ------------------------------------------------------------------------ */

  #mintNonce(): string {
    // 256 bits, four times §8's ≥128-bit floor: the nonce is the only credential a console needs to
    // present before it has one, and it is printed in a terminal.
    return randomBytes(32).toString("hex");
  }

  #mintBearer(): string {
    return randomBytes(32).toString("hex");
  }

  #requireOpen(): PendingEscalation {
    const pending = this.#pending;
    if (pending === null) {
      throw new ControlError("no-escalation", "no escalation is open — the run is not asking for a human right now");
    }
    if (pending.answered) {
      throw new ControlError("already-resolved", "this escalation has already been answered");
    }
    return pending;
  }

  #require(bearer: string): PendingEscalation {
    const pending = this.#requireOpen();
    if (pending.bearer === null || bearer !== pending.bearer) {
      throw new ControlError(
        "unauthorized",
        "this request needs the session bearer minted when you acquired the escalation (§8)",
      );
    }
    return pending;
  }

  /** The console narration: where to connect, with which nonce, and under what clock. */
  #announce(pending: PendingEscalation): void {
    const seconds = Math.round((pending.deadline - this.#now()) / 1000);
    this.#note(`escalation: ${pending.request.code} — ${pending.request.reason}`);
    this.#note(`  observed: ${pending.request.observed}`);
    this.#note(`  take over with:  npm run operator -- --nonce ${pending.nonce} --bus ${this.#busUrl}`);
    this.#note(
      `  the escalation terminates by itself in ${seconds}s if nobody answers (§8's HUMAN_UNAVAILABLE)`,
    );
  }

  #startTimer(): void {
    if (this.#timer !== null) return;
    const tick = Math.max(MIN_TICK_MS, Math.min(this.#timing.heartbeatMs, this.#timing.leaseTtlMs) / 2);
    this.#timer = setInterval(() => {
      void this.#reap();
    }, tick);
    // A run is not a reason to keep the process alive: the timer is a lease checker, not a workload.
    this.#timer.unref?.();
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The two clocks §8 pins: the lease (re-raise) and the escalation (terminal). */
  async #reap(): Promise<void> {
    const pending = this.#pending;
    if (pending === null || pending.answered) {
      this.#stopTimer();
      return;
    }
    const now = this.#now();

    // The lease is checked first, and while it is live it *is* the answer to the deadline's question.
    // §8's deadline exists so a run never parks on an escalation nobody attends; a human holding the
    // token has attended, and the heartbeat is what proves they are still there. Checking the deadline
    // first cut sessions off under the operator's hands at a clock set before they arrived — the run
    // died, the bus closed, and the console went on printing "is the run still going?" at a run that was
    // gone — while the log said "no operator answered" about an operator who was holding it.
    if (pending.bearer !== null && now > pending.leaseUntil) {
      // §8's liveness: the console stopped heartbeating (it died, or the operator walked away), so the
      // token comes back to PAUSED_ESCALATED and the escalation re-raises with a *new* nonce.
      const previous = pending.bearer;
      pending.bearer = null;
      pending.digestAfterLastAction = null;
      pending.nonce = this.#mintNonce();
      pending.reRaised += 1;
      pending.deadline = now + this.#timing.escalationTimeoutMs;
      this.#token = "paused";
      await this.#surface.log({
        kind: "note",
        subject: "control",
        message:
          `the operator's lease lapsed after ${Math.round(this.#timing.leaseTtlMs / 1000)}s without a heartbeat — ` +
          "the human token auto-released and the escalation re-raised (§8)",
        code: pending.request.code,
        reRaised: pending.reRaised,
      });
      this.#note(
        `the operator's lease lapsed (no heartbeat for ${Math.round(this.#timing.leaseTtlMs / 1000)}s) — ` +
          `control returned to the run; re-acquire with:  npm run operator -- --nonce ${pending.nonce} --bus ${this.#busUrl}`,
      );
      void previous;
      return;
    }

    // Nobody holds the token, and the window opened when the escalation was raised (or re-raised) has
    // closed: the run stops rather than hanging.
    if (pending.bearer === null && now >= pending.deadline) {
      await this.#surface.log({
        kind: "note",
        subject: "escalation",
        message:
          `no operator answered within ${Math.round(this.#timing.escalationTimeoutMs / 1000)}s — ` +
          "terminating as HUMAN_UNAVAILABLE rather than hanging (§8)",
        code: pending.request.code,
        escalation: "no-operator",
      });
      this.#note("escalation unanswered — the run terminates as HUMAN_UNAVAILABLE (§8)");
      this.#finish(pending, "unavailable");
      return;
    }
  }

  /** Answer the escalation once, and only once. */
  #finish(pending: PendingEscalation, answer: EscalationAnswer): void {
    if (pending.answered) return;
    pending.answered = true;
    pending.bearer = null;
    this.#stopTimer();
    // §3 key-3's RESUMING: the token is on its way back to the run, which re-verifies the state
    // before it acts. The next thing that happens is the engine's decision, not another human request.
    this.#token = "resuming";
    pending.resolve(answer);
    queueMicrotask(() => {
      if (this.#token === "resuming") this.#token = "agent";
    });
  }

  /** The console's view of the escalation, without the nonce or the bearer. */
  #view(pending: PendingEscalation): EscalationView {
    return {
      id: pending.id,
      code: pending.request.code,
      stepId: pending.request.stepId,
      reason: pending.request.reason,
      url: pending.request.url,
      observed: pending.request.observed,
      evidenceDir: pending.request.evidenceDir,
      capabilityId: pending.request.capabilityId,
      stage: pending.request.stage,
      raisedAt: new Date(pending.raisedAt).toISOString(),
      terminatesInMs: Math.max(0, pending.deadline - this.#now()),
      held: pending.bearer !== null,
      screenshot: pending.screenshot,
      reRaised: pending.reRaised,
    };
  }

  async #stateFor(pending: PendingEscalation, mode: "compact" | "expanded"): Promise<ConsoleState> {
    const snapshot = await this.#surface.snapshot();
    return {
      token: this.#token,
      escalation: this.#view(pending),
      snapshot,
      // The *same* rendering call the discovery digest comes from (§8's F9 assertion): one observer
      // model, one numbering, two renderings, and the console never invents a third.
      dump: this.#redactor.scrubText(await this.#surface.render({ mode })),
      mode,
      logTail: this.#surface.evidence.lines.slice(-this.#logTailLines),
      lease:
        pending.bearer === null
          ? null
          : {
              ttlMs: this.#timing.leaseTtlMs,
              expiresInMs: Math.max(0, pending.leaseUntil - this.#now()),
            },
      humanActions: pending.humanActions,
    };
  }

  /**
   * A node index → the durable candidate chain to act on it with.
   *
   * The same conversion the agent's tool layer performs (`captureTarget`), and deliberately not a
   * hand-built `role`/`css` candidate: the chain is *verified* against the live element before it is
   * used, so a console command cannot resolve to a different node than the one the operator read off
   * the dump — the mis-targeted action §24 nit 2 was written about.
   */
  async #descriptorFor(node: SnapshotNode) {
    const element = await this.#surface.observer.elementFor(node);
    if (element === null) {
      throw new ControlError(
        "stale-node",
        `node [${node.index ?? "?"}] is no longer in the tree — poll again and use the index the dump shows now`,
      );
    }
    try {
      return await captureTarget(this.#surface.page, element, node.framePath);
    } catch {
      throw new ControlError(
        "unaddressable-node",
        `node [${node.index ?? "?"}] cannot be addressed durably from this dump — re-poll and retry`,
      );
    } finally {
      await element.dispose();
    }
  }

  /** A refused console action, as something the operator can act on rather than a stack trace. */
  #consoleActionError(error: unknown, command: ConsoleCommand): ControlError {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /policy|approval-gated|blocked/i.test(message) || (error as { code?: string }).code === "NAVIGATION_BLOCKED";
    return new ControlError(
      blocked ? "policy-refused" : "action-failed",
      blocked
        ? `policy refused that ${command.kind} — the operator inherits the allowlist (§8); ${message}`
        : `the ${command.kind} on node [${command.index}] failed: ${message}`,
    );
  }
}
