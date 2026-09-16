/**
 * §27's cross-check: the artifact's `risk` block, re-read against the policy in force (§11 P7).
 *
 * §26 gave `app` a reader and §27 did the same for `risk`, and it did it in both directions on
 * purpose. The artifact's declaration is a *fact about the recording* — a step the run gated is
 * gated forever, even if the policy is later loosened — while the policy is the floor that a later
 * tightening has to reach. So "bind on the stricter side" is two statements, and each has its own
 * failure:
 *
 * - **A tightening must not be invisible.** An artifact recorded `"safe"` whose step policy now
 *   refuses to run unattended must be upgraded, and the upgrade has to be *named* (which step, which
 *   rule) or the evidence cannot answer "why did this run stop". `crossCheckRisk` is that half.
 * - **A recorded gate must not be loosened.** A policy edit that drops a rule must not quietly
 *   un-gate a step the recording already called irreversible. `StricterPolicy` is that half, and it
 *   is the direction where a bug is a security bug rather than an audit gap.
 *
 * The pure classifier is tested next door in `policy.test.ts`; what is asserted here is only the
 * *binding* of the two sides, which is a decision replay makes before a browser exists.
 */
import { describe, expect, it } from "vitest";
import { Policy } from "../../src/policy/policy.ts";
import { crossCheckRisk, replayState, StricterPolicy } from "../../src/replay/engine.ts";
import type { Capability, Step } from "../../src/schema/artifact.ts";
import { parseCapability } from "../../src/schema/validate.ts";
import type { ActionContext, SurfaceAction } from "../../src/surface/session-driver.ts";
import { validArtifact } from "../helpers/artifact.ts";

const params = new Map([["memberId", "12345"]]);

/** The shipped policy, with no environment in the way. */
const shipped = (): Promise<Policy> => Policy.load({ env: {} });

/** A context for one action, with the target name the resolver would have reported. */
function context(action: SurfaceAction, targetName: string | null = null): ActionContext {
  return { action, targetName, targetRole: targetName === null ? null : "button" };
}

const click = (name: string | null): ActionContext =>
  context({ kind: "click", target: { candidates: [{ strategy: "css", selector: "a", index: 0 }] } }, name);

const press = (name: string | null): ActionContext =>
  context(
    { kind: "press", target: { candidates: [{ strategy: "css", selector: "input", index: 0 }] }, key: "Enter" },
    name,
  );

/* -------------------------------------------------------------------------- */
/* Building the two artifacts the cross-check has to reconcile                 */
/* -------------------------------------------------------------------------- */

/**
 * The worked example with step 2 writing into a field policy calls sensitive.
 *
 * Nothing else changes — the step keeps its id, its `expect` and its place in the flow — so a
 * difference in the cross-check's answer is attributable to the target's *name* and to the
 * artifact's declaration, and to nothing else. That is what makes this a control rather than a
 * second scenario.
 */
function typingIntoASensitiveField(): Capability {
  const json = validArtifact();
  json.steps[1] = {
    ...json.steps[1],
    target: { candidates: [{ strategy: "role", role: "textbox", name: "Taxpayer SSN" }] },
    value: "123-45-6789",
  };
  return parseCapability(json, "a run that typed a taxpayer id");
}

/** The same artifact, recorded gated — the state §27 says a later policy edit cannot retract. */
function recordedGated(): Capability {
  const json = validArtifact();
  json.steps[1] = {
    ...json.steps[1],
    target: { candidates: [{ strategy: "role", role: "textbox", name: "Taxpayer SSN" }] },
    value: "123-45-6789",
  };
  json.risk = { class: "approval-gated", irreversibleSteps: [2] };
  return parseCapability(json, "a run that gated the taxpayer id");
}

/** The worked example with a `press` step, for the policy that does not list `press`. */
function pressingEnter(): Capability {
  const json = validArtifact();
  json.steps[2] = { ...json.steps[2], action: "press", value: "{memberId}" };
  return parseCapability(json, "a run that pressed a key");
}

/** The shipped policy with one operation removed from the allowlist — deny-by-default, exercised. */
async function withoutPress(): Promise<Policy> {
  const base = await shipped();
  return Policy.load({
    env: {},
    overrides: { allowlist: { actions: base.document.allowlist.actions.filter((a) => a !== "press") } },
  });
}

const stepOf = (capability: Capability, id: number): Step => {
  const step = capability.steps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`no step ${id} in the fixture`);
  return step;
};

/* -------------------------------------------------------------------------- */
/* The tightening direction (§27 nit 3, first half)                            */
/* -------------------------------------------------------------------------- */

describe("a policy tightened after the recording", () => {
  it("upgrades the step to approval-gated, and names the rule that did it", async () => {
    const capability = typingIntoASensitiveField();
    const check = crossCheckRisk(capability, await shipped(), params);

    // The artifact says safe; the policy in force does not agree. The stricter side wins, and the
    // disagreement is a recorded fact rather than a silent re-classification.
    expect(capability.risk).toEqual({ class: "safe", irreversibleSteps: [] });
    expect([...check.gated]).toEqual([2]);
    expect(check.upgraded).toEqual([2]);
    expect(check.blocked).toEqual([]);

    // The note has to be actionable on its own: which step, what policy thought of it, and the fact
    // that the recording disagreed. "approval-gated" with no rule named is not an audit trail.
    expect(check.notes).toHaveLength(1);
    expect(check.notes[0]).toContain("step 2");
    expect(check.notes[0]).toContain('on "Taxpayer SSN"');
    expect(check.notes[0]).toContain("risk.approval-required");
    expect(check.notes[0]).toContain("was recorded as safe");
  });

  it("leaves an artifact that already declared the same gate alone, and says nothing", async () => {
    // Agreement is the quiet case, and it has to be quiet: an upgrade note here would train a reader
    // to skim the field that exists to make a real upgrade visible.
    const check = crossCheckRisk(recordedGated(), await shipped(), params);
    expect([...check.declared]).toEqual([2]);
    expect([...check.gated]).toEqual([2]);
    expect(check.upgraded).toEqual([]);
    expect(check.notes).toEqual([]);
  });

  it("records an artifact gate the policy agrees with only because the artifact says so", async () => {
    // The other control for the same pair: the recording gated step 2, and this policy does not name
    // the field at all. The declared set is what keeps the step gated, not the classifier.
    const base = await shipped();
    const lenient = await Policy.load({
      env: {},
      overrides: { risk: { approvalRequired: [] } },
    });
    expect(base.document.risk.approvalRequired.length).toBeGreaterThan(0);

    const check = crossCheckRisk(recordedGated(), lenient, params);
    expect([...check.gated]).toEqual([2]);
    expect(check.upgraded).toEqual([]);
    expect(check.notes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The loosening direction (§27 nit 3, second half)                            */
/* -------------------------------------------------------------------------- */

describe("the gate a recording already declared", () => {
  it("is enforced even when the policy in force would allow the action", async () => {
    const state = replayState();
    const capability = recordedGated();
    const stricter = new StricterPolicy(await shipped(), new Set([2]), state);

    // Step 2 is the declared one, and the current policy has nothing to say about it: an ordinary
    // `type` into a field it does not recognise as sensitive.
    state.step = stepOf(capability, 2);
    const verdict = await stricter.review(click("Taxpayer SSN"));

    expect(verdict.allowed).toBe(false);
    expect(verdict.approvalRequired).toBe(true);
    expect(verdict.rule).toBe("artifact.irreversibleSteps");
    expect(verdict.reason).toContain("never un-gated");
  });

  it("does not leak the artifact's gate onto a step it did not name", async () => {
    // The decorator adds one sentence to the policy; it must not become a blanket gate. Everything
    // outside `irreversibleSteps` gets the policy's own verdict, rule included.
    const state = replayState();
    const capability = recordedGated();
    const stricter = new StricterPolicy(await shipped(), new Set([2]), state);

    state.step = stepOf(capability, 3);
    expect(await stricter.review(click("Search"))).toMatchObject({
      allowed: true,
      approvalRequired: false,
      rule: "allowlist.action",
    });
  });

  it("cannot turn a refusal into an approval — a block passes through untouched", async () => {
    // §6: a blocked action is a hard failure, not a decision a human can make. The decorator only
    // ever *adds* gates, so the two directions cannot collapse into each other.
    const policy = await withoutPress();
    const capability = pressingEnter();

    const check = crossCheckRisk(capability, policy, params);
    expect(check.blocked).toEqual([3]);
    expect(check.upgraded).toEqual([]);
    expect([...check.gated]).toEqual([]);
    expect(check.notes[0]).toContain("refused by policy");

    const state = replayState();
    const stricter = new StricterPolicy(policy, check.gated, state);
    state.step = stepOf(capability, 3);
    const verdict = await stricter.review(press("Member ID"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.approvalRequired).toBe(false);
  });
});
