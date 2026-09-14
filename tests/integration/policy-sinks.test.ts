/**
 * The sink rule against a live page — §11 P3's exit criteria, and §21's G5.
 *
 * The unit tests prove the scrubber works on payloads a test hands it. This file proves the thing
 * §6 actually asks for: that a secret **typed into a real browser page by a real action** is absent
 * from every sink the system writes. Each sink is therefore asserted twice — the raw form carries
 * the value (the leak is real), the swept form does not (the scrubber is load-bearing) — because a
 * one-sided assertion keeps passing if the value stops reaching evidence for some unrelated reason,
 * which is exactly when a redaction test should start failing.
 *
 * G5's field is the fixture's off-path **Taxpayer Certification** block on `/member/:id/summary`:
 * an SSN box that is not part of routine account servicing, sitting on a page the demo flow visits
 * anyway. It is the honest version of the problem — `redact.fieldPatterns` says `ssn`,
 * `risk.approvalRequired` says `/password|ssn|taxid/i`, and the markup says `aria-label="Taxpayer
 * SSN"` and `name="taxpayerSsn"`: three spellings that agree only because one interpreter
 * (`pattern.ts`) and one label builder (`SessionDriver`'s `fieldLabel`) read all of them.
 *
 * The sinks §6 names that are not written yet — bus state and `--json` stdout (P6/P5) — are covered
 * in the shape they will take: the same `Redactor.serialize` call, on a payload built from the live
 * page. That is the pipeline they are required to use, not a stand-in for a test.
 */
import { readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED } from "../../src/policy/redact.ts";
import { ApprovalRequiredError, PolicyBlockedError, type ExecutedAction } from "../../src/surface/session-driver.ts";
import type { TargetDescriptor } from "../../src/surface/target.ts";
import { startSurface, type Surface } from "../helpers/browser.ts";

/** §6: synthetic data only. This value is not a real SSN and must never be one. */
const SSN = "412-88-9077";
const MEMBER = "/member/12345/summary";

/** The Taxpayer SSN box, targeted the way an artifact would record it. */
const SSN_FIELD: TargetDescriptor = {
  candidates: [{ strategy: "role", role: "textbox", name: "Taxpayer SSN" }],
};

const surfaces: Surface[] = [];

/** A surface whose approval seam answers however the test needs it to. */
async function surface(approve: boolean): Promise<Surface> {
  const started = await startSurface({ approval: async () => (approve ? "approved" : "denied") });
  surfaces.push(started);
  return started;
}

/** Open the fixture app on the surface's allowlist. */
async function open(started: Surface): Promise<void> {
  await started.driver.execute({ kind: "navigate", url: `${started.base}${MEMBER}` });
}

/** Type the SSN the way a run would: through the choke point, with a human's approval. */
async function typeSsn(started: Surface): Promise<ExecutedAction> {
  await open(started);
  return started.driver.execute({ kind: "type", target: SSN_FIELD, value: SSN });
}

/**
 * Every sink §6 names, in the form the system writes it, with the live page's own rendering as the
 * payload. `digest` is passed in raw and unscrubbed on purpose — it is the leak this file is about.
 */
async function sinks(started: Surface, digest: string): Promise<Record<string, string>> {
  const read = started.driver.redactor;
  const snapshotDir = `${started.driver.evidenceDir}/dom-snapshots`;
  const files = await readdir(snapshotDir);
  const html = (
    await Promise.all(files.map(async (file) => readFile(`${snapshotDir}/${file}`, "utf8")))
  ).join("\n");

  return {
    "run.jsonl": await readFile(started.driver.evidence.runLogPath, "utf8"),
    "dom snapshot": html,
    // The console's two renderings (§24), scrubbed the way a console render must be.
    "compact render": read.scrubText(await started.driver.render({ mode: "compact" })),
    "expanded render": read.scrubText(await started.driver.render({ mode: "expanded" })),
    // P5's `--json` stdout and P6's bus state: the same serializer on the run's own payloads.
    "--json stdout": read.serialize({ kind: "observation", digest }),
    "bus state": read.serialize({ kind: "state", url: started.page.url(), digest, lines: started.driver.evidence.lines }),
  };
}

afterEach(async () => {
  for (const started of surfaces.splice(0)) await started.stop();
});

describe("G5: a synthetic SSN typed into the off-path Taxpayer field", () => {
  it("is really in the page — the sinks below are being asked a live question", async () => {
    const started = await surface(true);
    const executed = await typeSsn(started);

    expect(await started.page.inputValue("input[name=taxpayerSsn]")).toBe(SSN);
    // Resolution found the box by its accessible name, and the review saw that name: this is the
    // §6 fieldName rule firing, not a hardcoded assumption that "typing is dangerous".
    expect(executed.verdict).toMatchObject({ approvalRequired: true, rule: "risk.approval-required" });
    expect(executed.approval).toBe("granted");
    expect(executed.sensitive).toBe(true);
    expect(started.driver.redactor.secretCount).toBe(1);
  });

  it("is absent from every sink, while the raw form of each payload still carries it", async () => {
    const started = await surface(true);
    await typeSsn(started);

    // The raw renderings, unscrubbed: the value is in the page's own observation formats, which is
    // what makes the swept assertions below a real test rather than a coincidence of this markup.
    const digest = await started.driver.render({ mode: "compact" });
    expect(digest).toContain(SSN);
    expect(await started.driver.render({ mode: "expanded" })).toContain(SSN);

    // A legacy form echoing a submitted value back into the markup — the DOM snapshot's leak
    // vector. The fixture's static HTML takes the value as a *property* (`fill`), which
    // `page.content()` does not serialize, so the attribute is written here to hold that sink to its
    // worst case instead of to the one this particular markup happens to produce.
    await started.page.evaluate((value) => {
      document.querySelector("input[name=taxpayerSsn]")?.setAttribute("value", value);
    }, SSN);
    expect(await started.page.content()).toContain(SSN);

    // What P4's observation line will carry, written through the logger's own sink now.
    await started.driver.log({ kind: "observation", digest });
    await started.driver.domSnapshot("member summary after typing");

    for (const [name, body] of Object.entries(await sinks(started, digest))) {
      expect(`${name}: ${body.includes(SSN)}`, `${name} carried the typed SSN`).toBe(`${name}: false`);
      expect(`${name}: ${body.includes(REDACTED)}`, `${name} shows no scrub happened`).toBe(`${name}: true`);
    }
  });

  it("leaves the run log auditable: the gated action records the rule and the decision", async () => {
    const started = await surface(true);
    await typeSsn(started);
    const lines = started.driver.evidence.lines;

    // What a reviewer needs from a gated action: who decided, under which rule, and what was done.
    expect(lines.find((line) => line["kind"] === "decision" && line["decision"] === "approved")).toMatchObject({
      actor: "human",
      channel: "console",
      rule: "risk.approval-required",
    });
    const actionLine = lines.find((line) => line["kind"] === "action" && line["sensitive"] === true);
    expect(actionLine).toMatchObject({ outcome: "executed", approval: "granted" });
    // The action line describes the *shape* of what was typed, never the value.
    expect(actionLine?.["action"]).toBe(`type into target (${SSN.length} chars)`);
  });

  it("suppresses a screenshot while the field holds a value, and captures once it is cleared", async () => {
    const started = await surface(true);
    await typeSsn(started);

    // Pixels are the one sink the scrubber cannot touch, so the run must not take the picture.
    const suppressed = await started.driver.screenshot("after typing");
    expect(suppressed.kind).toBe("suppressed");
    expect(suppressed.kind === "suppressed" ? suppressed.fields : []).toEqual(["Taxpayer SSN taxpayerSsn"]);
    // The suppression is evidential, not silent: the log says a screenshot was asked for and not
    // taken. (The line is found by `subject`, since the run has a policy suppression too.)
    expect(
      started.driver.evidence.lines.find(
        (line) => line["kind"] === "suppressed" && line["subject"] === "screenshot",
      ),
    ).toMatchObject({ label: "after typing", fields: ["Taxpayer SSN taxpayerSsn"] });
    // Nothing was written, so a caller that ignored the result would be holding a path to nothing.
    await expect(readdir(`${started.driver.evidenceDir}/screenshots`)).rejects.toThrow();

    // Clearing it is an ordinary `type` — and the suppression clears with it, because the check asks
    // the live page rather than trusting a flag someone set.
    await started.driver.execute({ kind: "type", target: SSN_FIELD, value: "" });
    const captured = await started.driver.screenshot("after clearing");
    expect(captured.kind).toBe("captured");
    const png = await readFile(captured.kind === "captured" ? captured.path : "");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("the driver refuses what it cannot approve", () => {
  it("does not type when the approver declines, and records that a decision was sought", async () => {
    const started = await surface(false);
    const error = await typeSsn(started).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect((error as ApprovalRequiredError).code).toBe("APPROVAL_REQUIRED");
    expect((error as ApprovalRequiredError).request.verdict.rule).toBe("risk.approval-required");
    // The refusal is a refusal: nothing was typed, and nothing was registered to scrub.
    expect(await started.page.inputValue("input[name=taxpayerSsn]")).toBe("");
    expect(started.driver.redactor.secretCount).toBe(0);
    expect(
      started.driver.evidence.lines.some(
        (line) => line["kind"] === "suppressed" && line["rule"] === "risk.approval-required",
      ),
    ).toBe(true);
  });

  it("fails a blocked navigation as NAVIGATION_BLOCKED, leaving the page where it was", async () => {
    const started = await surface(true);
    await open(started);
    const before = started.page.url();

    const deniedRoute = await started.driver
      .execute({ kind: "navigate", url: `${started.base}/admin/audit` })
      .catch((thrown: unknown) => thrown);
    expect(deniedRoute).toBeInstanceOf(PolicyBlockedError);
    expect((deniedRoute as PolicyBlockedError).code).toBe("NAVIGATION_BLOCKED");
    expect((deniedRoute as PolicyBlockedError).verdict.rule).toBe("allowlist.route-denied");

    const foreignOrigin = await started.driver
      .execute({ kind: "navigate", url: "https://example.com/member/12345" })
      .catch((thrown: unknown) => thrown);
    expect((foreignOrigin as PolicyBlockedError).code).toBe("NAVIGATION_BLOCKED");
    expect((foreignOrigin as PolicyBlockedError).verdict.rule).toBe("allowlist.origin");

    // A blocked action must not have touched the page — which is the whole reason review happens
    // before the act rather than after it.
    expect(started.page.url()).toBe(before);
    expect(
      started.driver.evidence.lines.filter(
        (line) => line["kind"] === "suppressed" && line["subject"] === "policy",
      ),
    ).toHaveLength(2);
  });

  it("does not gate a keystroke on the same sensitive field — the field rule is about writing a value", async () => {
    const started = await surface(true);
    await typeSsn(started);
    // `fieldName` rules apply where a value is written (`type`/`select`), so pressing a key in the
    // SSN box is ordinary — no second approval for a control that merely sits next to a secret.
    const pressed = await started.driver.execute({ kind: "press", target: SSN_FIELD, key: "Tab" });
    expect(pressed.verdict.rule).toBe("allowlist.action");
    expect(pressed.approval).toBe("not-required");
    expect(pressed.sensitive).toBe(false);
  });
});
