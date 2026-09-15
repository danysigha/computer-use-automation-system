/**
 * Canonicalization (§28) — the rule, its two syntaxes, and the three places it deliberately stops.
 *
 * This is the unit half of §28's own test plan ("substitution inside a `navigate` literal is
 * unit-tested unconditionally"), and it holds each boundary as a test rather than as a comment:
 * `{param}` binds the caller's declared sample, `:name` binds a shape, a model-chosen value stays
 * literal, and a route with no variable segment yields `null` so the recorder writes `urlContains`
 * instead of an assertion validate would reject.
 */
import { describe, expect, it } from "vitest";
import { BindingLog, routePattern, type ParamSample } from "../../src/agent/canonicalize.ts";

const MEMBER: ParamSample = { name: "memberId", value: "12345" };

describe("binding a declared param's sample (§28 rule 1)", () => {
  it("turns a literal sample into the caller's placeholder, in any field", () => {
    const bind = new BindingLog([MEMBER]);
    expect(bind.text("steps.1.url", "http://localhost:4173/member/12345/summary")).toBe(
      "http://localhost:4173/member/{memberId}/summary",
    );
    expect(bind.text("steps.2.value", "12345")).toBe("{memberId}");
    expect(bind.text("outcomes.0.message", "No member 12345 on file")).toBe("No member {memberId} on file");
  });

  it("records every substitution, so a mis-binding is reviewable rather than silent", () => {
    const bind = new BindingLog([MEMBER]);
    bind.text("steps.1.url", "http://localhost:4173/member/12345/summary");
    expect(bind.entries).toEqual([
      {
        field: "steps.1.url",
        param: "memberId",
        sample: "12345",
        result: "http://localhost:4173/member/{memberId}/summary",
      },
    ]);
  });

  it("leaves a value that does not carry a declared sample exactly as it was", () => {
    const bind = new BindingLog([MEMBER]);
    // A model-chosen value: an account type the agent picked, which nothing declared (§28's
    // "deliberately not changed" half).
    expect(bind.text("steps.3.value", "Savings")).toBe("Savings");
    expect(bind.entries).toEqual([]);
    expect(bind.contains("Savings")).toBe(false);
  });

  it("binds the longest sample first, so a sample inside another does not leave a fragment", () => {
    const bind = new BindingLog([
      { name: "short", value: "1234" },
      { name: "long", value: "12345" },
    ]);
    expect(bind.text("steps.2.value", "12345")).toBe("{long}");
  });

  it("never rewrites text inside a placeholder it has already written", () => {
    // A param named `id` sampled as "id" would otherwise corrupt `{memberId}` into `{member{id}}`
    // — the kind of bug that shows up on somebody else's deployment and nowhere else.
    const bind = new BindingLog([
      { name: "memberId", value: "12345" },
      { name: "id", value: "id" },
    ]);
    expect(bind.text("steps.2.value", "12345")).toBe("{memberId}");
  });

  it("ignores an empty sample rather than replacing every position in the string", () => {
    const bind = new BindingLog([{ name: "blank", value: "" }]);
    expect(bind.text("steps.2.value", "anything")).toBe("anything");
  });

  it("tells the recorder which placeholders it produced, from the schema's own scanner", () => {
    const bind = new BindingLog([MEMBER]);
    expect(bind.placeholders(bind.text("steps.2.value", "12345"))).toEqual(["memberId"]);
  });
});

describe("route patterns: shape, not literal (§28 rule 2)", () => {
  it("marks the entity segment of the deep link goal 1 actually follows", () => {
    // The fixture's results rows are deep links to /member/{id}/summary (§10), which is what makes
    // this rule observable instead of vacuous.
    expect(routePattern("http://localhost:4173/member/12345/summary")).toBe("/member/:id/summary");
  });

  it("keeps the query string out of the pattern, and is honest about what that costs", () => {
    // `/search?memberId=12345` cannot be patternized without claiming to know which query
    // parameters vary, so the route it yields is the path — a weaker checkpoint than the deep
    // link's, and a true one.
    expect(routePattern("http://localhost:4173/search?memberId=12345")).toBeNull();
  });

  it("returns null when there is no variable segment — the vacuity rule, at the producer", () => {
    expect(routePattern("http://localhost:4173/")).toBeNull();
    expect(routePattern("http://localhost:4173/member/summary")).toBeNull();
  });

  it("does not mistake a version discriminator for an entity key", () => {
    // "/v2/" and "/step/1/" are route vocabulary, not keys. Marking them variable would make the
    // assertion *weaker* — it would pass on a page the run never visited.
    expect(routePattern("http://localhost:4173/v2/detail")).toBeNull();
    expect(routePattern("http://localhost:4173/step/1/detail")).toBeNull();
  });

  it("names a second variable segment positionally, never as a backreference", () => {
    // `:id2` is a label for position 2; §28's pattern language has no equality constraint, and
    // naming it after a param would invite reading it as one.
    expect(routePattern("http://localhost:4173/member/12345/account/67890")).toBe("/member/:id/account/:id2");
  });

  it("handles the identifier shapes a bank console puts in a route", () => {
    expect(routePattern("http://h/statement/2026-08-02/detail")).toBe("/statement/:id/detail");
    expect(routePattern("http://h/item/4f0b1c2e-9d3a-4a71-8e5c-1b2c3d4e5f60")).toBe("/item/:id");
  });

  it("gives up on a URL it cannot parse rather than guessing a pattern", () => {
    expect(routePattern("not a url")).toBeNull();
  });
});
