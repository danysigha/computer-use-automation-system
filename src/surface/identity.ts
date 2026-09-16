/**
 * App identity — §26's build marker, read from a surface instead of declared by it.
 *
 * §26's finding was that `app` was write-only: every artifact carried `product`/`variant`/`version`
 * and nothing ever read them, so "reuse across tenants" could only ever fail as a confusing
 * `ELEMENT_NOT_FOUND` in somebody else's app. This module is the reader. It has exactly two
 * consumers, and they are the two moments the question is worth asking: **discovery**, which stamps
 * the block from what the target advertised *during that run* (so the value is a fact about the run
 * rather than a config line someone typed), and **replay's preflight**, which compares the
 * artifact's block against the target *before launching anything* (P5).
 *
 * One parse, one comparison, one vocabulary — because those two consumers must never disagree about
 * what "same app" means. The marker markup itself is the fixture's, and the reader is deliberately
 * loose about everything that is not the question: tag name, attribute order, surrounding markup,
 * and whether the surface advertises at all. §26 nit 3 is the load-bearing half of that: **an absent
 * marker is never a failure**. Real legacy consoles advertise nothing, and a check that only worked
 * on a cooperative fixture would be worthless, so "no marker" resolves to `absent` and each caller
 * decides what to do — discovery falls back to the declared default, replay proceeds as `unknown`
 * and lets step-level `expect` be the backstop.
 *
 * The comparison is exact-string on all three fields, deliberately: no semver parsing, no
 * "compatible version" notion, nothing that could let a genuine cross-tenant mistake through while
 * looking clever. What the fields *mean* for the decision is §26's, and it is asymmetric:
 * `product`/`variant` are **identity** (a different configuration, where the recorded locators may
 * genuinely not exist) so a difference stops; `version` is **a patch** on the same configured
 * product, which usually moves nothing the artifact depends on, so a difference proceeds and is
 * recorded as drift. Blocking on every version bump is what would teach operators to reach for
 * `--allow-drift` reflexively and destroy the signal the check exists to give.
 */
import type { Page } from "playwright";

/** §4.1's `app` block, and the shape the marker advertises. Field-for-field the same three names. */
export interface AppIdentity {
  readonly product: string;
  readonly variant: string;
  readonly version: string;
}

/**
 * What a surface that advertises nothing is called. A named value rather than `null` because it has
 * to travel: it is what discovery stamps into an artifact and what replay writes into evidence, and
 * an `app` block with a `null` in it would fail the schema at exactly the moment the run had already
 * succeeded. "unknown" is honest — it is a claim about the *observation*, not about the app.
 */
export const UNKNOWN_IDENTITY: AppIdentity = { product: "unknown", variant: "unknown", version: "unknown" };

/** Whether the surface said anything, which is a different fact from what it said (§26 nit 3). */
export type IdentityObservation =
  | { readonly kind: "observed"; readonly identity: AppIdentity }
  | { readonly kind: "absent" };

export const ABSENT_IDENTITY: IdentityObservation = { kind: "absent" };

/** The id the fixture injects into every HTML response. One string, two readers, no third. */
const MARKER_ID = "app-build";

const ATTRIBUTES = ["product", "variant", "version"] as const;

/**
 * One HTML attribute value: double-quoted, single-quoted, or bare (which HTML permits and
 * hand-written legacy markup uses). Group order is the caller's to know — `attributeValue` below.
 */
const ATTRIBUTE_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))`;

/** The marker's own `id`, in the same three spellings. */
const MARKER_TAG = new RegExp(String.raw`<[a-z][^>]*\bid\s*=\s*(?:"${MARKER_ID}"|'${MARKER_ID}'|${MARKER_ID}(?=[\s>]))[^>]*>`, "i");

function attributeValue(tag: string, name: string): string | null {
  const match = new RegExp(String.raw`\bdata-${name}\s*=\s*${ATTRIBUTE_VALUE}`, "i").exec(tag);
  if (match === null) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined || value === "" ? null : unescapeAttribute(value);
}

/** The five entities the fixture's `escapeHtml` can produce, plus the numeric ones browsers emit. */
function unescapeAttribute(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&"); // last: an escaped `&amp;quot;` is the literal text, not a quote
}

/**
 * The identity a page advertises, or `null` when it advertises none.
 *
 * Deliberately a *scan of the served text* rather than a DOM query: this runs for a bounded HTTP GET
 * during replay preflight (P5), where there is no browser and no DOM — and a browser-side
 * `querySelector` here would make the same rule need two implementations that could disagree. The
 * tag is matched whole so attribute order is irrelevant, and a partial marker (one attribute
 * missing) is `null` rather than a half-filled identity: three fields are one statement.
 */
export function parseBuildMarker(html: string): AppIdentity | null {
  const tag = MARKER_TAG.exec(html);
  if (tag === null) return null;

  const found: Record<string, string> = {};
  for (const name of ATTRIBUTES) {
    const value = attributeValue(tag[0], name);
    // A partial marker is no marker: three fields are one statement, and a half-filled identity
    // (empty `variant`, say) compares as a mismatch against everything rather than as unknown.
    if (value === null) return null;
    found[name] = value;
  }
  // Every attribute was proven present above, so these fallbacks are unreachable — they exist
  // because `noUncheckedIndexedAccess` is right that a `Record<string, string>` lookup may be
  // undefined, and a cast here would be the place a future partial marker slipped through.
  return { product: found["product"] ?? "", variant: found["variant"] ?? "", version: found["version"] ?? "" };
}

/** Read the marker out of a live page. The discovery half of §26; replay's half is an HTTP GET. */
export async function observeIdentity(page: Page): Promise<IdentityObservation> {
  // `hidden` on the marker (fixture §10) keeps it out of the accessibility tree, but it is still
  // serialized into the document — which is what makes it readable without disturbing an
  // observation, the property §24 asks for.
  const html = await page.content().catch(() => "");
  const identity = parseBuildMarker(html);
  return identity === null ? ABSENT_IDENTITY : { kind: "observed", identity };
}

/** How long replay's preflight GET may take before the target is treated as not advertising. */
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * The identity a URL advertises, read without a browser (P5's half of §26).
 *
 * Preflight runs **before anything is launched**, so it cannot ask a page — and the whole value of
 * the check is that it happens before a browser is anywhere near the wrong app. So it is a bounded
 * HTTP GET: one request, one timeout, no session, no follow-up.
 *
 * Everything that is not "an HTML response carrying a marker" resolves to `absent`, and that is §26
 * nit 3 rather than a swallowed error: a network failure, a timeout, a redirect to a login page, a
 * 404, a PDF — none of them is a claim that the app is *different*, and treating any of them as a
 * stop would turn an unreachable target into a tenant-drift report. The `unknown` verdict that
 * follows says the honest thing: the check did not get an answer, and step-level `expect` is the
 * backstop. Redirects are followed (the marker lives on the page the target actually serves), and
 * the timeout covers the body read as well as the headers, so a target that answers and then
 * trickles forever is bounded too.
 */
export async function fetchIdentity(
  url: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<IdentityObservation> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) return ABSENT_IDENTITY;

    // Loose about the content type in the direction the module is loose in everywhere else: a type
    // that names something other than HTML is a definite "no marker here", but a server that sends
    // no type at all still gets parsed, because an unlabelled page can perfectly well be one.
    const contentType = response.headers.get("content-type");
    if (contentType !== null && !/html/i.test(contentType)) return ABSENT_IDENTITY;

    const identity = parseBuildMarker(await response.text());
    return identity === null ? ABSENT_IDENTITY : { kind: "observed", identity };
  } catch {
    return ABSENT_IDENTITY;
  }
}

/** The identity to record, from an observation that may have carried none (§26's fallback). */
export function identityOf(observation: IdentityObservation): AppIdentity {
  return observation.kind === "observed" ? observation.identity : UNKNOWN_IDENTITY;
}

/**
 * §26's verdict, named for the decision it drives rather than for the fields that differ — the
 * field-level detail belongs in `reason`, so no caller has to re-derive which half failed.
 *
 * `match` carries a reason like the others rather than being a bare tag: the evidence line §26 asks
 * every run to write is one sentence in every case, and "no drift" is information a reader of a
 * fleet's logs wants to *see* rather than infer from the absence of a warning.
 */
export type IdentityVerdict =
  | { readonly kind: "match"; readonly reason: string }
  | { readonly kind: "version-drift"; readonly reason: string }
  | { readonly kind: "mismatch"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Compare what an artifact was recorded against with what the target advertises now.
 *
 * `expected` is the run's declared identity — the artifact's `app` block on replay, and the
 * operator's declared default on discovery. Two cases both resolve to `unknown` rather than to a
 * verdict, and they are the same case: an unrecorded identity (`unknown/unknown@unknown`, from a
 * surface that advertised nothing at record time) and a surface that advertises nothing now. There
 * is nothing to compare either way, and manufacturing a `match` would be the check lying about
 * having looked.
 */
export function compareIdentity(expected: AppIdentity, observed: IdentityObservation): IdentityVerdict {
  if (observed.kind === "absent") {
    return {
      kind: "unknown",
      reason:
        "the target advertises no build marker, so its identity cannot be compared — " +
        "step-level checks are the backstop (§26)",
    };
  }

  const actual = observed.identity;
  if (expected.product === UNKNOWN_IDENTITY.product && expected.variant === UNKNOWN_IDENTITY.variant) {
    return {
      kind: "unknown",
      reason:
        `was recorded against a surface that advertised nothing (${describeIdentity(expected)}), ` +
        `and the target advertises ${describeIdentity(actual)} — there is no recorded identity to compare`,
    };
  }
  if (actual.product !== expected.product || actual.variant !== expected.variant) {
    return {
      kind: "mismatch",
      reason:
        `recorded against ${describeIdentity(expected)}; target advertises ${describeIdentity(actual)} — ` +
        "a different product or variant means the recorded locators may not exist here",
    };
  }
  if (actual.version !== expected.version) {
    return {
      kind: "version-drift",
      reason:
        `recorded against ${describeIdentity(expected)}; target advertises ${describeIdentity(actual)} — ` +
        "same product and variant, different build",
    };
  }
  return { kind: "match", reason: `the target advertises ${describeIdentity(actual)}, as recorded` };
}

/** `atlas-console/base@0.1` — how both sides of a comparison are named in one line. */
export function describeIdentity(identity: AppIdentity): string {
  return `${identity.product}/${identity.variant}@${identity.version}`;
}

/**
 * The `appIdentity` evidence line §26 asks every run to write, **regardless of verdict** — which is
 * the whole point of it being a separate object from the artifact stamp: a drifted-but-successful
 * run is still a `success` (§5.3 untouched), and the drift is visible after the fact rather than
 * only at the moment it stopped someone.
 */
export interface IdentityEvidence {
  readonly expected: AppIdentity;
  readonly observed: AppIdentity;
  readonly verdict: IdentityVerdict["kind"];
  readonly reason: string;
}

export function identityEvidence(expected: AppIdentity, observed: IdentityObservation): IdentityEvidence {
  const verdict = compareIdentity(expected, observed);
  return {
    expected,
    observed: identityOf(observed),
    verdict: verdict.kind,
    reason: verdict.reason,
  };
}
