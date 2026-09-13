/**
 * "Atlas Core Console" — a deliberately hostile local bank-core fixture.
 *
 * Why it looks like this (PLAN §10): the target of the brief is legacy/no-clean-DOM
 * financial software, so the fixture reproduces that reality on purpose —
 * frameset-era chrome, deeply nested tables, no test ids, labels rendered as text
 * cells instead of `label[for]`, duplicated visible text, an unnamed legacy control —
 * while staying screen-reader-operable where US financial software would legally have
 * to be (accessible names on the inputs that need them).
 *
 * Zero dependencies beyond Node built-ins; synthetic data only.
 *
 * Two server-side mechanisms matter to the system under test:
 *   1. `?sim=` failure injection — session-scoped, so a state set at the entry URL is
 *      still in force at step 4 of a replay (PLAN §10).
 *   2. The build marker (`#app-build`) — injected centrally into every HTML response,
 *      so no route and no sim state can omit it (PLAN §26 drift preflight).
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* Synthetic data                                                             */
/* -------------------------------------------------------------------------- */

interface Account {
  readonly type: string;
  readonly kind: string;
  readonly balance: string;
  readonly opened: string;
  /** A dormant account renders `Locked` on a perfectly happy page — decoy text that a
   *  loosely-anchored outcome signature would wrongly match (PLAN §4.1/§10). */
  readonly status: "Open" | "Locked";
}

interface Member {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "locked";
  readonly accounts: readonly Account[];
}

const MEMBERS: ReadonlyMap<string, Member> = new Map<string, Member>([
  [
    "12345",
    {
      id: "12345",
      name: "Dana Whitfield",
      status: "active",
      accounts: [
        { type: "Savings", kind: "SAV", balance: "$4,201.55", opened: "2019-03-14", status: "Open" },
        { type: "Checking", kind: "CHK", balance: "$1,290.04", opened: "2019-03-14", status: "Open" },
        { type: "Certificate", kind: "CD", balance: "$10,000.00", opened: "2021-07-02", status: "Open" },
        { type: "Holiday Club", kind: "CLUB", balance: "$0.00", opened: "2020-11-01", status: "Locked" },
      ],
    },
  ],
  ["12346", { id: "12346", name: "Marcus Oyelaran", status: "locked", accounts: [] }],
  [
    "12347",
    {
      id: "12347",
      name: "Priya Raman",
      status: "active",
      accounts: [
        { type: "Savings", kind: "SAV", balance: "$980.12", opened: "2022-01-19", status: "Open" },
        { type: "Checking", kind: "CHK", balance: "$312.77", opened: "2022-01-19", status: "Open" },
      ],
    },
  ],
]);

/** Fixture credentials for the `/login` page. Synthetic, documented, never real. */
const LOGIN_CREDENTIALS = { tellerId: "teller1", password: "atlas-demo" } as const;

const SUBACCOUNT_TYPES = ["Regular Share", "Money Market", "Certificate"] as const;
const MINIMUM_DEPOSIT = 25;

/* -------------------------------------------------------------------------- */
/* Simulation states (`?sim=`)                                                */
/* -------------------------------------------------------------------------- */

type MemberState = "ok" | "not-found" | "locked" | "restricted";

/** Sims that take no argument. */
const BARE_SIM_KINDS = [
  "record-not-found",
  "record-locked",
  "permission-denied",
  "session-expired",
  "validation-error",
  "page-error",
] as const;
type BareSimKind = (typeof BARE_SIM_KINDS)[number];

type Sim =
  | { readonly kind: BareSimKind }
  | { readonly kind: "slow"; readonly ms: number; readonly maxResponses: number }
  | { readonly kind: "dialog"; readonly flavor: "known" | "unexpected" };

/**
 * Persisted in the `atlas_sim` cookie so a state survives in-app navigation until
 * `?sim=off`. `served` counts *navigation* responses (documents and form posts) only —
 * subresource traffic must not consume a one-shot transient.
 */
interface SimState {
  readonly sim: Sim;
  readonly served: number;
  readonly loggedIn: boolean;
}

const SIM_COOKIE = "atlas_sim";
const DEFAULT_SLOW_MS = 12_000;

const SIM_HELP =
  "valid: record-not-found | record-locked | permission-denied | slow[=ms] " +
  "(with optional `slowResponses=n`, default 1) | session-expired | dialog=known | " +
  "dialog=unexpected | validation-error | page-error | off";

class SimParseError extends Error {}

function isBareSimKind(value: string): value is BareSimKind {
  return (BARE_SIM_KINDS as readonly string[]).includes(value);
}

function parseSim(raw: string, url: URL): Sim | null {
  if (raw === "off") return null;
  if (isBareSimKind(raw)) return { kind: raw };

  if (raw === "slow" || raw.startsWith("slow=")) {
    const [, value] = raw.split("=");
    const ms = value === undefined || value === "" ? DEFAULT_SLOW_MS : Number(value);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new SimParseError(`sim=slow needs a non-negative ms — ${SIM_HELP}`);
    }
    const rawResponses = url.searchParams.get("slowResponses");
    const maxResponses = rawResponses === null ? 1 : Number(rawResponses);
    if (!Number.isInteger(maxResponses) || maxResponses < 1) {
      throw new SimParseError(`slowResponses needs to be a positive integer — ${SIM_HELP}`);
    }
    return { kind: "slow", ms, maxResponses };
  }

  if (raw === "dialog=known" || raw === "dialog=unexpected") {
    return { kind: "dialog", flavor: raw === "dialog=known" ? "known" : "unexpected" };
  }

  throw new SimParseError(`unknown sim \`${raw}\` — ${SIM_HELP}`);
}

function isSim(value: unknown): value is Sim {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") return false;
  return isBareSimKind(kind) || kind === "slow" || kind === "dialog";
}

function readSimState(cookieHeader: string | undefined): SimState | null {
  if (cookieHeader === undefined) return null;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SIM_COOKIE}=`));
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw.slice(SIM_COOKIE.length + 1)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sim, served, loggedIn } = parsed as { sim?: unknown; served?: unknown; loggedIn?: unknown };
    if (!isSim(sim) || typeof served !== "number" || typeof loggedIn !== "boolean") return null;
    return { sim, served, loggedIn };
  } catch {
    return null; // A tampered or truncated cookie is simply not a sim.
  }
}

/* -------------------------------------------------------------------------- */
/* Pages and rendering                                                        */
/* -------------------------------------------------------------------------- */

const PAGE_CACHE = new Map<string, string>();

/** Read (and cache) a page template from disk. A typo fails loudly with its path. */
function page(name: string): string {
  const cached = PAGE_CACHE.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(HERE, `${name}.html`), "utf8");
  PAGE_CACHE.set(name, text);
  return text;
}

/**
 * Fill `<!--{{SLOT}}-->` and `{{SLOT}}` placeholders. The comment form disappears
 * when a page is opened on disk; the bare form is what attribute values need
 * (`src="{{GRID_URL}}"`). Values are inserted literally — callers escape.
 */
function fill(template: string, slots: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(slots)) {
    // A function replacer keeps `$` in values literal (money values start with one).
    out = out.replaceAll(`<!--{{${key}}}-->`, () => value).replaceAll(`{{${key}}}`, () => value);
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stateMessage(state: Exclude<MemberState, "ok">, memberId: string): string {
  switch (state) {
    // Pinned fixture messages (PLAN §10 G1/G2) — the shipped outcome signatures
    // anchor to these exact strings, so they are load-bearing, not cosmetic.
    case "not-found":
      return `No member ${memberId} on file`;
    case "locked":
      return `Member ${memberId} is locked`;
    case "restricted":
      return `Access to member ${memberId} is restricted`;
  }
}

type Lookup = { readonly ok: true; readonly member: Member } | { readonly ok: false; readonly state: Exclude<MemberState, "ok"> };

/** Member lookup. The sim wins over the data, so demos are deterministic. */
function lookupMember(memberId: string, sim: Sim | undefined): Lookup {
  if (sim?.kind === "record-not-found") return { ok: false, state: "not-found" };
  if (sim?.kind === "record-locked") return { ok: false, state: "locked" };
  if (sim?.kind === "permission-denied") return { ok: false, state: "restricted" };
  const member = MEMBERS.get(memberId);
  if (member === undefined) return { ok: false, state: "not-found" };
  if (member.status === "locked") return { ok: false, state: "locked" };
  return { ok: true, member };
}

function renderState(memberId: string, state: Exclude<MemberState, "ok">): string {
  return fill(page("state"), {
    MEMBER_ID: escapeHtml(memberId),
    MESSAGE: escapeHtml(stateMessage(state, memberId)),
    TITLE: state === "not-found" ? "Member not found" : "Member access blocked",
  });
}

function renderError(reference: string): string {
  return fill(page("error"), { REFERENCE: reference });
}

function accountRows(member: Member, indent: string): string {
  return member.accounts
    .map(
      (account) => `${indent}<tr>
${indent}  <td>${escapeHtml(account.type)}</td>
${indent}  <td>${escapeHtml(account.kind)}</td>
${indent}  <td>${escapeHtml(account.balance)}</td>
${indent}  <td>${escapeHtml(account.opened)}</td>
${indent}  <td>${escapeHtml(account.status)}</td>
${indent}  <td><a href="/member/${escapeHtml(member.id)}/summary">Detail</a></td>
${indent}</tr>`,
    )
    .join("\n");
}

function renderResults(member: Member): string {
  return fill(page("results"), {
    MEMBER_ID: escapeHtml(member.id),
    MEMBER_NAME: escapeHtml(member.name),
    ROWS: accountRows(member, "            "),
  });
}

function renderMember(member: Member): string {
  return fill(page("member"), {
    MEMBER_ID: escapeHtml(member.id),
    MEMBER_NAME: escapeHtml(member.name),
    GRID_URL: `/member/${escapeHtml(member.id)}/grid`,
  });
}

function renderGrid(member: Member): string {
  return fill(page("grid"), {
    MEMBER_ID: escapeHtml(member.id),
    ROWS: accountRows(member, "      "),
  });
}

interface SubaccountFields {
  readonly type: string;
  readonly deposit: string;
  readonly nickname: string;
  readonly branch: string;
}

function readSubaccountFields(form: URLSearchParams): SubaccountFields {
  return {
    type: form.get("type") ?? "",
    deposit: form.get("deposit") ?? "",
    nickname: form.get("nickname") ?? "",
    branch: form.get("branch") ?? "",
  };
}

function renderSubaccountForm(memberId: string, fields: SubaccountFields, errors: readonly string[]): string {
  const errorLines = errors.map((error) => `      <p>${escapeHtml(error)}</p>`).join("\n");
  const errorBlock =
    errors.length === 0 ? "" : ["<div class=\"banner\" role=\"alert\">", errorLines, "    </div>"].join("\n");
  const options = SUBACCOUNT_TYPES.map(
    (type) => `        <option${fields.type === type ? " selected" : ""}>${escapeHtml(type)}</option>`,
  ).join("\n");
  return fill(page("forms"), {
    MEMBER_ID: escapeHtml(memberId),
    ERRORS: errorBlock,
    OPTIONS: options,
    DEPOSIT: escapeHtml(fields.deposit),
    NICKNAME: escapeHtml(fields.nickname),
    BRANCH: escapeHtml(fields.branch),
  });
}

/**
 * The confirmation-action dialog. Rendered in-page rather than as a native
 * `window.confirm` so it is reachable from the accessibility snapshot, the operator
 * console, and the screenshot at escalation time (PLAN §5.2/§8).
 */
function dialogMarkup(flavor: "known" | "unexpected", memberId: string): string {
  const text =
    flavor === "known"
      ? `Confirm activation of account for member ${memberId}?` // matches policy recoverableDialogs
      : "Workstation policy notice: verify teller session before continuing (ref WS-4471).";
  return `  <div class="modal" role="dialog" aria-modal="true" aria-label="Application dialog">
    <div class="modal-body">
      <p>${escapeHtml(text)}</p>
      <p><a class="btn" href="/member/${escapeHtml(memberId)}/subaccount/done">OK</a></p>
    </div>
  </div>`;
}

function renderConfirm(memberId: string, fields: SubaccountFields, dialog: string): string {
  const summaryRows: [string, string][] = [
    ["Sub-account type", fields.type],
    ["Initial deposit", fields.deposit],
    ["Nickname", fields.nickname],
    ["Branch code", fields.branch],
  ];
  const hidden = (["type", "deposit", "nickname", "branch"] as const)
    .map((name) => `    <input type="hidden" name="${name}" value="${escapeHtml(fields[name])}">`)
    .join("\n");
  return fill(page("confirm"), {
    MEMBER_ID: escapeHtml(memberId),
    DIALOG: dialog,
    HIDDEN: hidden,
    SUMMARY: summaryRows
      .map(([label, value]) => `      <tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join("\n"),
  });
}

/* -------------------------------------------------------------------------- */
/* Server configuration                                                       */
/* -------------------------------------------------------------------------- */

export interface AppConfig {
  readonly product: string;
  readonly variant: string;
  readonly version: string;
  readonly port: number;
}

export const DEFAULT_PRODUCT = "atlas-console";
export const DEFAULT_VARIANT = "base";
export const DEFAULT_VERSION = "0.1";
export const DEFAULT_PORT = 4173;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawPort = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer in 0..65535 (got \`${rawPort}\`)`);
  }
  return {
    product: env.APP_PRODUCT ?? DEFAULT_PRODUCT,
    variant: env.APP_VARIANT ?? DEFAULT_VARIANT,
    version: env.APP_VERSION ?? DEFAULT_VERSION,
    port,
  };
}

/**
 * The advertised build marker. Injected centrally into every HTML response so that no
 * route and no `?sim=` state can omit it — the drift preflight (PLAN §26) reads it,
 * and a marker with holes in it would be worthless. `hidden` keeps it out of the
 * accessibility tree, so it never pollutes an observation (PLAN §24).
 */
function buildMarker(config: AppConfig): string {
  return (
    `<div id="app-build" hidden data-product="${escapeHtml(config.product)}"` +
    ` data-variant="${escapeHtml(config.variant)}" data-version="${escapeHtml(config.version)}"></div>`
  );
}

function withBuildMarker(html: string, config: AppConfig): string {
  const marker = buildMarker(config);
  const closing = html.lastIndexOf("</body>");
  return closing === -1 ? `${html}\n${marker}\n` : `${html.slice(0, closing)}${marker}\n${html.slice(closing)}`;
}

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                           */
/* -------------------------------------------------------------------------- */

function isNavigationRequest(req: IncomingMessage, url: URL): boolean {
  if (url.pathname === "/favicon.ico") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document";
  return (req.headers.accept ?? "").includes("text/html");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface Sender {
  html(status: number, body: string): void;
  redirect(location: string, status?: number): void;
  text(status: number, body: string): void;
}

function makeSender(
  res: ServerResponse,
  config: AppConfig,
  state: SimState | null,
  clearSimCookie: boolean,
): Sender {
  const withCookies = (headers: Record<string, string>): Record<string, string> => {
    if (clearSimCookie) {
      headers["Set-Cookie"] = `${SIM_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
    } else if (state !== null) {
      headers["Set-Cookie"] =
        `${SIM_COOKIE}=${encodeURIComponent(JSON.stringify(state))}; Path=/; SameSite=Lax; HttpOnly`;
    }
    return headers;
  };

  return {
    html(status, body) {
      const payload = withBuildMarker(body, config);
      res.writeHead(
        status,
        withCookies({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(payload)),
          "Cache-Control": "no-store",
        }),
      );
      res.end(payload);
    },
    redirect(location, status = 302) {
      res.writeHead(status, withCookies({ Location: location, "Cache-Control": "no-store" }));
      res.end();
    },
    text(status, body) {
      res.writeHead(
        status,
        withCookies({
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body)),
        }),
      );
      res.end(body);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

interface RouteContext {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly method: string;
  readonly sim: Sim | undefined;
  readonly state: SimState | null;
  /** Standard responses: the sim cookie is stamped with this response's `served + 1`. */
  readonly send: Sender;
  /** Explicit-state responses (used by login, which changes `loggedIn`, not `served`). */
  readonly sendAs: (state: SimState | null) => Sender;
}

/** Keep redirect targets local — cheap open-redirect hygiene, even in a fixture. */
function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/** Route dispatch. Sim effects are already applied by `handle()` further down. */
function route(ctx: RouteContext): void {
  const path = ctx.url.pathname;
  const segments = path.split("/").filter((segment) => segment !== "");

  if (ctx.method === "GET" && path === "/header") {
    ctx.send.html(200, page("header")); // chrome, loaded inside the home page's iframe
    return;
  }

  if (ctx.method === "GET" && path === "/") {
    handleHome(ctx, "");
    return;
  }

  if (ctx.method === "GET" && path === "/search") {
    handleSearch(ctx);
    return;
  }

  if (path === "/login") {
    handleLogin(ctx);
    return;
  }

  if (segments[0] === "member" && segments[1] !== undefined) {
    handleMember(ctx, decodeURIComponent(segments[1]), segments.slice(2).join("/"));
    return;
  }

  ctx.send.html(404, renderError("ATL-4040"));
}

function handleHome(ctx: RouteContext, note: string): void {
  ctx.send.html(200, fill(page("index"), { NOTE: note }));
}

function handleSearch(ctx: RouteContext): void {
  const memberId = ctx.url.searchParams.get("memberId") ?? "";
  if (memberId === "") {
    handleHome(ctx, '<p class="banner" role="alert">Enter a member number to search.</p>');
    return;
  }
  const found = lookupMember(memberId, ctx.sim);
  ctx.send.html(200, found.ok ? renderResults(found.member) : renderState(memberId, found.state));
}

function handleLogin(ctx: RouteContext): void {
  const next = safeNext(ctx.url.searchParams.get("next"));
  if (ctx.method === "GET") {
    ctx.send.html(200, fill(page("login"), { NEXT: escapeHtml(next), ERROR: "" }));
    return;
  }
  if (ctx.method !== "POST") {
    ctx.send.text(405, "method not allowed\n");
    return;
  }
  void readBody(ctx.req)
    .then((body) => {
      const form = new URLSearchParams(body);
      const target = safeNext(form.get("next") ?? next);
      const authenticated =
        form.get("tellerId") === LOGIN_CREDENTIALS.tellerId &&
        form.get("password") === LOGIN_CREDENTIALS.password;
      if (!authenticated) {
        ctx.send.html(
          200,
          fill(page("login"), {
            NEXT: escapeHtml(target),
            ERROR: '<div class="banner" role="alert"><p>Invalid teller credentials.</p></div>',
          }),
        );
        return;
      }
      // A successful login clears the expired condition without clearing the sim.
      ctx.sendAs(ctx.state === null ? null : { ...ctx.state, loggedIn: true }).redirect(target);
    })
    .catch(() => ctx.send.text(500, "request body could not be read\n"));
}

function handleMember(ctx: RouteContext, memberId: string, sub: string): void {
  const { method, sim, send } = ctx;
  const found = lookupMember(memberId, sim);
  /** Render the member's page, or the blocked-member state page instead. */
  const pageOrState = (render: (member: Member) => string): void => {
    send.html(200, found.ok ? render(found.member) : renderState(memberId, found.state));
  };

  if (method === "GET") {
    switch (sub) {
      case "summary":
        pageOrState(renderMember);
        return;
      case "grid":
        // The balance grid lives in its own frame — the flagship row-relative ×
        // framePath case (PLAN §10 G4). A blocked member shows the banner instead.
        pageOrState(renderGrid);
        return;
      case "subaccount":
        pageOrState(() => renderSubaccountForm(memberId, emptyFields(), []));
        return;
      case "subaccount/done":
        send.html(200, fill(page("done"), { MEMBER_ID: escapeHtml(memberId) }));
        return;
      case "close-account":
        send.html(200, fill(page("close"), { MEMBER_ID: escapeHtml(memberId) }));
        return;
      default:
        send.html(404, renderError("ATL-4040"));
        return;
    }
  }

  if (method === "POST") {
    switch (sub) {
      case "subaccount":
        void readBody(ctx.req)
          .then((body) => {
            const fields = readSubaccountFields(new URLSearchParams(body));
            const errors = validateSubaccount(fields, sim);
            send.html(
              200,
              errors.length > 0 ? renderSubaccountForm(memberId, fields, errors) : renderConfirm(memberId, fields, ""),
            );
          })
          .catch(() => send.text(500, "request body could not be read\n"));
        return;
      // The confirmation action is where the dialog sims surface (PLAN §10): the
      // escalation demo dialogs the action, not the entry page.
      case "subaccount/confirm":
        void readBody(ctx.req)
          .then((body) => {
            const fields = readSubaccountFields(new URLSearchParams(body));
            if (sim?.kind === "dialog") {
              send.html(200, renderConfirm(memberId, fields, dialogMarkup(sim.flavor, memberId)));
              return;
            }
            send.redirect(`/member/${encodeURIComponent(memberId)}/subaccount/done`);
          })
          .catch(() => send.text(500, "request body could not be read\n"));
        return;
      // Irreversible, and gated at the click that submits it (PLAN §6) — by the time
      // this route runs, the decision was already made at the choke point.
      case "close-account":
        send.redirect(`/member/${encodeURIComponent(memberId)}/summary`);
        return;
      default:
        send.html(404, renderError("ATL-4040"));
        return;
    }
  }

  send.text(405, "method not allowed\n");
}

function emptyFields(): SubaccountFields {
  return { type: "", deposit: "", nickname: "", branch: "" };
}

function validateSubaccount(fields: SubaccountFields, sim: Sim | undefined): string[] {
  if (sim?.kind === "validation-error") {
    return ["Initial deposit must be at least 25.00", "Sub-account type is not available for this member"];
  }
  const errors: string[] = [];
  if (!(SUBACCOUNT_TYPES as readonly string[]).includes(fields.type)) {
    errors.push("Sub-account type is required");
  }
  const deposit = Number(fields.deposit.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(deposit) || deposit < MINIMUM_DEPOSIT) {
    errors.push(`Initial deposit must be at least ${MINIMUM_DEPOSIT}.00`);
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse, config: AppConfig): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  const prior = readSimState(req.headers.cookie);
  const rawSim = url.searchParams.get("sim");
  let state: SimState | null = prior;
  let clearSimCookie = false;

  if (rawSim !== null) {
    try {
      const parsed = parseSim(rawSim, url);
      state = parsed === null ? null : { sim: parsed, served: 0, loggedIn: prior?.loggedIn ?? false };
      clearSimCookie = parsed === null;
    } catch (error) {
      if (error instanceof SimParseError) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`bad ?sim= — ${error.message}\n`);
        return;
      }
      throw error;
    }
  }

  const navigation = isNavigationRequest(req, url);
  const servedBefore = state?.served ?? 0;
  // Every response the handler makes advances the counter; login is the one route
  // that needs a *different* state (loggedIn), so it gets a sender of its own.
  const nextState: SimState | null =
    state === null ? null : { sim: state.sim, served: servedBefore + 1, loggedIn: state.loggedIn };
  const send = makeSender(res, config, nextState, clearSimCookie);
  const sendAs = (override: SimState | null): Sender => makeSender(res, config, override, clearSimCookie);

  // page-error replaces every page in the session with an un-declared state.
  if (state?.sim.kind === "page-error" && navigation) {
    send.html(200, renderError("ATL-5001"));
    return;
  }

  // session-expired kicks in from the *second* navigation on, so the entry URL that
  // sets the sim still renders — the expiry lands mid-flow, where it is interesting.
  if (
    state?.sim.kind === "session-expired" &&
    navigation &&
    servedBefore >= 1 &&
    !state.loggedIn &&
    url.pathname !== "/login"
  ) {
    send.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    return;
  }

  // slow: delay the first `maxResponses` navigation responses (default 1), so a retry
  // meets a surface that has recovered — the transient branch of the retry family.
  if (state?.sim.kind === "slow" && navigation && servedBefore < state.sim.maxResponses) {
    await delay(state.sim.ms);
  }

  route({ req, url, method, sim: state?.sim, send, sendAs, state });
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

export function createAppServer(config: AppConfig = configFromEnv()): Server {
  return createServer((req, res) => {
    handle(req, res, config).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(`fixture crashed: ${message}\n`);
    });
  });
}

export interface RunningApp {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startServer(config: AppConfig = configFromEnv()): Promise<RunningApp> {
  const server = createAppServer(config);
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(config.port, "127.0.0.1", ready);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  return {
    server,
    port,
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((done, failed) => {
        server.close((error) => (error === undefined ? done() : failed(error)));
      }),
  };
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const config = configFromEnv();
  try {
    const app = await startServer(config);
    process.stdout.write(
      `Atlas Core Console (fixture) listening on ${app.url}\n` +
        `  build marker: ${config.product}/${config.variant}/${config.version}\n` +
        `  sim states:   ?sim=record-not-found | ?sim=slow=12000 | ?sim=dialog=unexpected | …\n`,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `port ${config.port} is in use — start with PORT=<free port> and keep policy/policy.json's allowlist in step\n`,
      );
    } else {
      process.stderr.write(`could not start the fixture: ${String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
