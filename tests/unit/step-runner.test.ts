/**
 * Replay's decision table, without a browser (§4.1, §5.2, §22, §28).
 *
 * Everything asserted here is a *judgement* rather than a plumbing detail: which signature wins when
 * two match, whether a route pattern is a shape or a literal, what a thrown thing is called, and
 * whether the code it is called can be retried. Those four answers are what the replay engine does
 * with a page, and they are all pure functions over strings — so the classification table can be
 * exhaustively tested here, and the integration tests next door only have to prove the table is
 * reached.
 *
 * The `bind`/`bindDescriptor` cases are the other half of the same argument: §9's placeholders are how
 * a recorded artifact stops being a recording of *one* member, and a binding bug is invisible in the
 * happy path (it looks like a correct run against the id the artifact was recorded with).
 */
import { describe, expect, it } from "vitest";
import type { BusinessOutcome } from "../../src/schema/artifact.ts";
import {
  ApprovalRequiredError,
  PolicyBlockedError,
  type PolicyVerdict,
} from "../../src/surface/session-driver.ts";
import {
  ElementNotFoundError,
  FramePathError,
  type TargetDescriptor,
} from "../../src/surface/target.ts";
import {
  bind,
  bindDescriptor,
  checkAssertion,
  classifyError,
  describeAssertion,
  describeCandidate,
  describeDescriptor,
  describeStep,
  isRetryFamily,
  matchOutcome,
  matchRecoverableDialog,
  matchesRoute,
  parseMoney,
  type Params,
} from "../../src/replay/step-runner.ts";
import type { SessionDriver } from "../../src/surface/session-driver.ts";

const params = (entries: Record<string, string>): Params => new Map(Object.entries(entries));

/* -------------------------------------------------------------------------- */
/* Binding                                                                     */
/* -------------------------------------------------------------------------- */

describe("binding a template", () => {
  it("substitutes every declared placeholder with the caller's value", () => {
    expect(bind("/search?memberId={memberId}&x=1", params({ memberId: "12345" }))).toBe(
      "/search?memberId=12345&x=1",
    );
    expect(bind("{a}-{a}", params({ a: "x" }))).toBe("x-x");
  });

  it("leaves a placeholder with no value alone, braces and all", () => {
    // The artifact validator refuses an undeclared `{name}`, so this is unreachable from a saved
    // capability — and it is still the right behaviour, because the alternative is silently binding
    // to nothing and navigating to a URL with a hole in it.
    expect(bind("/m/{memberId}", params({ other: "1" }))).toBe("/m/{memberId}");
  });
});

describe("binding a target descriptor", () => {
  const descriptor: TargetDescriptor = {
    framePath: [0],
    candidates: [
      { strategy: "role", role: "textbox", name: "Member {memberId}" },
      { strategy: "text", text: "{memberId}" },
      { strategy: "css", selector: "input", index: 2 },
      {
        strategy: "row-relative",
        row: { by: "cell-text", text: "Member {memberId}" },
        column: { by: "header-text", text: "Balance" },
        action: "cell",
      },
    ],
  };

  it("binds the text fields and nothing else", () => {
    const bound = bindDescriptor(descriptor, params({ memberId: "12345" }));
    expect(bound.candidates[0]).toEqual({ strategy: "role", role: "textbox", name: "Member 12345" });
    expect(bound.candidates[1]).toEqual({ strategy: "text", text: "12345" });
    // A css selector is not a template: escaping or substituting inside one would produce a selector
    // for an element that does not exist, and the recorded `index` is a number, not a string.
    expect(bound.candidates[2]).toEqual({ strategy: "css", selector: "input", index: 2 });
    expect(bound.candidates[3]).toEqual({
      strategy: "row-relative",
      row: { by: "cell-text", text: "Member 12345" },
      column: { by: "header-text", text: "Balance" },
      action: "cell",
    });
    expect(bound.framePath).toEqual([0]);
  });

  it("keeps `framePath` off entirely when the artifact did not declare one", () => {
    const bound = bindDescriptor({ candidates: [{ strategy: "text", text: "Search" }] }, params({}));
    expect("framePath" in bound).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* §28 — the two variable syntaxes                                             */
/* -------------------------------------------------------------------------- */

describe("matching a canonicalized route", () => {
  it("reads a bare `:name` as one segment of any shape", () => {
    // The §28 exit criterion, stated as the two halves of one claim: a route assertion is about the
    // *shape* of the URL, so a replay carrying a different member id passes, and a literal id
    // assertion of the same URL would fail. The recorder canonicalizes `12345` → `:id` for exactly
    // this reason, and this is where that pays off.
    expect(matchesRoute("/member/:id/summary", params({ memberId: "99999" }), "http://x/member/99999/summary")).toBe(true);
    expect(matchesRoute("/member/12345/summary", params({ memberId: "99999" }), "http://x/member/99999/summary")).toBe(false);
  });

  it("reads `{param}` as the caller's own value, escaped", () => {
    const pattern = "/member/{memberId}/summary";
    expect(matchesRoute(pattern, params({ memberId: "12345" }), "http://x/member/12345/summary")).toBe(true);
    // The two directions of "it is a value, not a pattern": a *different* value does not match, and a
    // value that reads as a regex is matched literally rather than compiled.
    expect(matchesRoute(pattern, params({ memberId: "12345" }), "http://x/member/99999/summary")).toBe(false);
    expect(matchesRoute(pattern, params({ memberId: "12.45" }), "http://x/member/12X45/summary")).toBe(false);
    expect(matchesRoute(pattern, params({ memberId: "12.45" }), "http://x/member/12.45/summary")).toBe(true);
  });

  it("does not let one segment swallow a slash", () => {
    expect(matchesRoute("/member/:id/summary", params({}), "http://x/member/1/2/summary")).toBe(false);
    // ...and never matches an empty segment, which `[^/]*` would have allowed.
    expect(matchesRoute("/member/:id/summary", params({}), "http://x/member//summary")).toBe(false);
  });

  it("is anchored at both ends", () => {
    expect(matchesRoute("/member/:id/summary", params({}), "http://x/member/1/summary/extra")).toBe(false);
    expect(matchesRoute("/member/:id/summary", params({}), "http://x/prefix/member/1/summary")).toBe(false);
    expect(matchesRoute("/", params({}), "http://x/")).toBe(true);
  });

  it("asks about the path only — the query is not part of the route", () => {
    // `urlMatches` is the canonicalized half of §28 and a route has no query; a pattern that needed
    // one would be `urlContains`'s job.
    expect(matchesRoute("/member/:id/summary", params({}), "http://x/member/1/summary?tab=grid#top")).toBe(true);
  });

  it("is false for something that is not a URL at all", () => {
    expect(matchesRoute("/member/:id/summary", params({}), "about:blank")).toBe(false);
    expect(matchesRoute("/member/:id/summary", params({}), "")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

describe("describing an assertion", () => {
  const p = params({ memberId: "12345" });

  it("binds and quotes every literal it names", () => {
    expect(describeAssertion({ urlContains: "/search?memberId={memberId}" }, p)).toBe(
      'the URL contains "/search?memberId=12345"',
    );
    expect(describeAssertion({ urlMatches: "/member/:id/summary" }, p)).toBe(
      'the URL matches the route "/member/:id/summary"',
    );
    // A route pattern is *not* bound: `:id` is the route syntax, and `{param}` inside one is the only
    // half that is a placeholder (§28) — which `matchesRoute` handles and this must not undo.
    expect(describeAssertion({ urlMatches: "/m/{memberId}/x" }, p)).toBe('the URL matches the route "/m/{memberId}/x"');
    expect(describeAssertion({ textEquals: { target: { candidates: [{ strategy: "text", text: "Search" }] }, value: "{memberId}" } }, p)).toBe(
      'text="Search" shows "12345"',
    );
  });

  it("names the element for the two element assertions", () => {
    const target = { candidates: [{ strategy: "role" as const, role: "link" as const, name: "Close" }] };
    expect(describeAssertion({ elementExists: target }, p)).toBe('role=link[name="Close"] is on the page');
    expect(describeAssertion({ elementAbsent: target }, p)).toBe('role=link[name="Close"] is not on the page');
  });
});

describe("describing a candidate chain", () => {
  it("names the first candidate and counts the rest", () => {
    expect(describeCandidate({ strategy: "role", role: "button", name: "Search" })).toBe(
      'role=button[name="Search"]',
    );
    expect(
      describeDescriptor({
        candidates: [
          { strategy: "css", selector: "td.balance", index: 1 },
          { strategy: "text", text: "Search" },
        ],
      }),
    ).toBe('css="td.balance"[1] +1 fallback(s)');
  });

  it("says so when the chain is empty rather than rendering nothing", () => {
    expect(describeDescriptor({ candidates: [] })).toBe("an empty candidate chain");
  });
});

describe("describing a step", () => {
  it("reads back what the step was for", () => {
    const p = params({ memberId: "12345" });
    expect(describeStep({ id: 1, kind: "navigate", url: "/search?memberId={memberId}" }, p)).toBe(
      "navigate to /search?memberId=12345",
    );
    expect(describeStep({ id: 2, kind: "wait", condition: "fixed", ms: 250 }, p)).toBe("wait 250ms");
    expect(describeStep({ id: 3, kind: "wait", condition: "load" }, p)).toBe("wait for the page to load");
  });
});

describe("checking an assertion against a URL", () => {
  /** Only the two URL arms of `checkAssertion` need no driver — the rest are integration tests. */
  const noDriver = null as unknown as SessionDriver;

  it("reports what the URL actually was, on both outcomes", async () => {
    const url = "http://x/member/12345/summary";
    await expect(checkAssertion({ urlContains: "/summary" }, noDriver, url, params({}))).resolves.toEqual({
      ok: true,
      observed: `the URL was ${url}`,
    });
    await expect(checkAssertion({ urlContains: "/grid" }, noDriver, url, params({}))).resolves.toEqual({
      ok: false,
      observed: `the URL was ${url}`,
    });
  });

  it("binds the needle before looking for it", async () => {
    const url = "http://x/member/12345/summary";
    const bound = await checkAssertion({ urlContains: "/member/{memberId}/" }, noDriver, url, params({ memberId: "12345" }));
    const literal = await checkAssertion({ urlContains: "/member/{memberId}/" }, noDriver, url, params({ memberId: "99999" }));
    expect(bound.ok).toBe(true);
    expect(literal.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* §4.1 — outcome signatures                                                   */
/* -------------------------------------------------------------------------- */

const OUTCOMES: readonly BusinessOutcome[] = [
  {
    code: "NO_SUCH_ENTITY",
    detect: { kind: "text-on-page", pattern: String.raw`No member \d{5} on file` },
    message: "No member {memberId} on file",
  },
  {
    code: "RECORD_LOCKED",
    detect: { kind: "text-on-page", pattern: String.raw`Member \d{5} is (locked|closed)` },
    message: "Member {memberId} is locked",
  },
  {
    code: "PERMISSION_DENIED",
    detect: {
      kind: "element-shown",
      pattern: "restricted",
      target: { candidates: [{ strategy: "css", selector: "#banner", index: 0 }] },
    },
    message: "Access to member {memberId} is restricted",
  },
];

const never = async (): Promise<boolean> => false;
const always = async (): Promise<boolean> => true;

describe("matching an outcome signature", () => {
  it("takes the earliest declared signature when two would match", async () => {
    // §5.2's ordered contract. Both patterns hold on this text; declaration order decides, and an
    // artifact author's ordering is the only thing that can.
    const text = "No member 12345 on file — Member 12345 is locked";
    const match = await matchOutcome(text, OUTCOMES, never);
    expect(match?.outcome.code).toBe("NO_SUCH_ENTITY");
  });

  it("skips a signature whose pattern does not hold and keeps looking", async () => {
    const match = await matchOutcome("Member 99999 is closed", OUTCOMES, never);
    expect(match?.outcome.code).toBe("RECORD_LOCKED");
    expect(match?.evidence).toBe("Member 99999 is closed");
  });

  it("requires both halves of an element-shown signature", async () => {
    const page = "Access to member 12345 is restricted";
    // The half that matters: a message left over from a previous step over a control that is no
    // longer there is not an answer the app gave, so it must not end the run.
    expect(await matchOutcome(page, OUTCOMES, never)).toBeNull();
    const match = await matchOutcome(page, OUTCOMES, always);
    expect(match?.outcome.code).toBe("PERMISSION_DENIED");
    // The evidence is the matched text, not the page: a reader needs the phrase that fired.
    expect(match?.evidence).toBe("restricted");
  });

  it("hands the resolver the artifact's own descriptor, unmodified", async () => {
    // Binding is the caller's job (`probeOutcomes` does it), and it has to stay that way: this
    // function is pure over its arguments, which is what makes the table testable without a browser.
    const seen: TargetDescriptor[] = [];
    await matchOutcome("restricted", OUTCOMES, async (descriptor) => {
      seen.push(descriptor);
      return false;
    });
    expect(seen).toEqual([{ candidates: [{ strategy: "css", selector: "#banner", index: 0 }] }]);
  });

  it("is null on a page that says none of the declared things", async () => {
    expect(await matchOutcome("Savings Balance $4,201.55", OUTCOMES, always)).toBeNull();
  });

  it("treats each pattern as a fresh regex", async () => {
    // Compiled per call on purpose: a cached `/g` regex carries `lastIndex` between polls, and the
    // symptom would be an outcome that fires on every other poll rather than on every one.
    const text = "Member 12345 is locked";
    expect(await matchOutcome(text, OUTCOMES, never)).not.toBeNull();
    expect(await matchOutcome(text, OUTCOMES, never)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* §5.2 — recoverable dialogs                                                  */
/* -------------------------------------------------------------------------- */

describe("matching a policy-known dialog", () => {
  const dialogs = [
    { text: "session will expire", response: "accept" as const },
    { text: "unsaved changes", response: "dismiss" as const },
  ];

  it("matches case-insensitively on a substring of the page text", () => {
    expect(matchRecoverableDialog("Your SESSION WILL EXPIRE in 2 minutes", dialogs)).toEqual(dialogs[0]);
  });

  it("takes the first policy entry that holds", () => {
    expect(matchRecoverableDialog("session will expire, unsaved changes follow", dialogs)).toEqual(dialogs[0]);
  });

  it("is null when policy does not know this dialog — which is the escalation, not a default", () => {
    expect(matchRecoverableDialog("Transfer complete", dialogs)).toBeNull();
  });

  it("reads the regex-literal spelling the shipped policy actually uses", () => {
    // The one that shipped broken: `policy/policy.json` writes
    // `"/confirm activation of account/i"`, which the schema accepts (`isUsableTextPattern`) and the
    // engine read as a *bare* regex — so the pattern it looked for was the slashes and the flags,
    // and a dialog the operator had explicitly ruled safe escalated instead of being answered. This
    // asserts the spelling against the sentence the fixture renders, which is the whole contract.
    const shipped = [{ text: "/confirm activation of account/i", response: "accept" as const }];
    expect(matchRecoverableDialog("Confirm activation of account for member 12345? OK", shipped)).toEqual(shipped[0]);
    // And the flags are the author's, not ours: no `i` means no case-insensitivity.
    const cased = [{ text: "/confirm activation/", response: "accept" as const }];
    expect(matchRecoverableDialog("Confirm activation of account", cased)).toBeNull();
  });

  it("treats a fragment as the characters typed, never as a pattern", () => {
    // A sentence carries punctuation a name never does, and the fragment arm has to read it
    // literally: as a regex, the `?` would be a quantifier and this dialog would match a page text
    // that never contains the string it was written for.
    const literal = [{ text: "Deactivate account (final)?", response: "accept" as const }];
    expect(matchRecoverableDialog("Warning: Deactivate account (final)? — this cannot be undone", literal)).toEqual(
      literal[0],
    );
    expect(matchRecoverableDialog("Deactivate account (final) — cannot be undone", literal)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* §5.2/§22 — classification                                                   */
/* -------------------------------------------------------------------------- */

const verdict = (rule: string): PolicyVerdict => ({
  allowed: false,
  approvalRequired: false,
  reason: "the rule says no",
  rule,
});

/** A Playwright-shaped timeout: the *name* is the contract, not the class. */
function timeoutError(message = "Timeout 10000ms exceeded"): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

describe("classifying a thrown thing", () => {
  it("reads our own errors first, because they already knew what they were", () => {
    const notFound = classifyError(
      new ElementNotFoundError([0], [
        { candidate: { strategy: "role", role: "button", name: "Search" }, matches: 2 },
        { candidate: { strategy: "css", selector: "button", index: 0 }, matches: -1 },
      ]),
    );
    expect(notFound.code).toBe("ELEMENT_NOT_FOUND");
    expect(notFound.retryable).toBe(false);
    // The per-candidate counts travel with it: "2 matches" (ambiguous) and "unusable" (a broken
    // selector) are different problems with the same code, and `observed` is where they differ.
    expect(notFound.observed).toBe("no candidate resolved uniquely (role=2 match(es), css=unusable)");

    expect(classifyError(new FramePathError([0, 1], 1)).code).toBe("ELEMENT_NOT_FOUND");
    expect(classifyError(new PolicyBlockedError(verdict("origin"))).code).toBe("NAVIGATION_BLOCKED");
    // A gated action that was not approved is a refusal by policy, and this arm exists so the
    // classifier is total — the engine handles the escalation itself, at the call site that knows
    // what the human answered.
    const gated = new ApprovalRequiredError(
      { action: { kind: "click", target: { candidates: [] } }, targetName: "Close", targetRole: "button", verdict: verdict("irreversible"), url: "http://x/", evidenceDir: "/tmp" },
      "nobody answered",
    );
    expect(classifyError(gated).code).toBe("NAVIGATION_BLOCKED");
  });

  it("calls a timeout SLOW_LOAD, whatever it was waiting for", () => {
    // The one case worth spelling out: a goto that timed out and a click's auto-wait that timed out
    // are the same statement — "the state I was told to wait for did not arrive in time".
    const classified = classifyError(timeoutError());
    expect(classified.code).toBe("SLOW_LOAD");
    expect(classified.retryable).toBe(true);
    expect(classified.observed).toContain("did not reach the expected state in time");
  });

  it("separates the network failures that are worth retrying from the dead session", () => {
    for (const message of [
      "net::ERR_CONNECTION_REFUSED at http://x/",
      "connect ECONNRESET 127.0.0.1:4173",
      "socket hang up",
    ]) {
      const classified = classifyError(new Error(message));
      expect(classified.code, message).toBe("TRANSPORT_ERROR");
      expect(classified.retryable, message).toBe(true);
    }

    // §8's resume rule: a closed browser is a state the engine cannot verify its way past, so it is
    // terminal immediately rather than retried into a longer version of the same failure.
    const dead = classifyError(new Error("Target page, context or browser has been closed"));
    expect(dead.code).toBe("TRANSPORT_ERROR");
    expect(dead.retryable).toBe(false);
  });

  it("leaves the Transport patterns out of the way of a plain assertion failure", () => {
    expect(classifyError(new Error("a playwright assertion")).code).toBe("UNEXPECTED_STATE");
    expect(classifyError("not even an error").code).toBe("UNEXPECTED_STATE");
  });

  it("agrees with itself about which codes are in the retry family", () => {
    expect(isRetryFamily("SLOW_LOAD")).toBe(true);
    expect(isRetryFamily("TRANSIENT_ERROR")).toBe(true);
    expect(isRetryFamily("TRANSPORT_ERROR")).toBe(true);
    // Recoverable, but not retried: a session that expired and a dialog nobody answered are decisions
    // a human makes (§5.2's escalation row), and re-asking the page would not change either.
    expect(isRetryFamily("SESSION_EXPIRED")).toBe(false);
    expect(isRetryFamily("INTERSTITIAL_DIALOG")).toBe(false);
    expect(isRetryFamily("ELEMENT_NOT_FOUND")).toBe(false);
    expect(isRetryFamily("NO_SUCH_ENTITY")).toBe(false);
    expect(isRetryFamily("MADE_UP")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* §4.1 — money outputs                                                        */
/* -------------------------------------------------------------------------- */

describe("parsing an amount", () => {
  it("reads the spellings a bank statement uses", () => {
    expect(parseMoney("$4,201.55")).toBe(4201.55);
    expect(parseMoney("  1,200 ")).toBe(1200);
    expect(parseMoney("£12.5")).toBe(12.5);
    expect(parseMoney("0.01")).toBe(0.01);
    expect(parseMoney(".5")).toBe(0.5);
  });

  it("reads a negative however it is written", () => {
    expect(parseMoney("(1,200.00)")).toBe(-1200);
    expect(parseMoney("-$45.10")).toBe(-45.1);
    expect(parseMoney("-$45.10")).toBeLessThan(0);
  });

  it("is null for anything that is not an amount", () => {
    for (const text of ["", "  ", "n/a", "1.2.3", "$", "(no balance)", "12%"]) {
      expect(parseMoney(text), text).toBeNull();
    }
  });
});
