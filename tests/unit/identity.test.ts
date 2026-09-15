/**
 * §26's build marker, and the comparison that gives `app` its first reader.
 *
 * Two properties carry the weight. The first is that **an absent marker is never a failure** — the
 * check has to work on a surface that advertises nothing, or it is a check that only passes on our
 * own fixture. The second is the asymmetry: product/variant are identity and stop a run, version is
 * a patch and only gets recorded. Both are asserted here against the fixture's real markup, taken
 * from a live response rather than hand-written, so the parser is held to the served bytes.
 */
import { describe, expect, it } from "vitest";
import {
  ABSENT_IDENTITY,
  compareIdentity,
  describeIdentity,
  identityEvidence,
  identityOf,
  observeIdentity,
  parseBuildMarker,
  UNKNOWN_IDENTITY,
  type AppIdentity,
} from "../../src/surface/identity.ts";
import { startFixture } from "../helpers/fixture.ts";
import { startSurface } from "../helpers/browser.ts";

const RECORDED: AppIdentity = { product: "atlas-console", variant: "base", version: "0.1" };
const observed = (identity: AppIdentity) => ({ kind: "observed", identity }) as const;

describe("parsing the marker", () => {
  it("reads the three fields out of the fixture's own served markup", async () => {
    const app = await startFixture();
    try {
      const html = await (await fetch(app.url)).text();
      // The real bytes: the fixture injects this element into every HTML response (§10).
      expect(html).toContain('id="app-build"');
      expect(parseBuildMarker(html)).toEqual({ product: "atlas-console", variant: "base", version: "0.1" });
    } finally {
      await app.close();
    }
  });

  it("does not care about attribute order, tag name, or surrounding markup", () => {
    // A future surface advertises the same three facts in its own markup. The reader answers the
    // question ("what does this page say it is") and not a question about our own templates.
    expect(
      parseBuildMarker('<span data-version="2" data-product="p" data-variant="v" id=app-build></span>'),
    ).toEqual({ product: "p", variant: "v", version: "2" });
  });

  it("unescapes attribute entities, so an id that needs escaping survives", () => {
    expect(
      parseBuildMarker('<div id="app-build" data-product="a&amp;b" data-variant="v" data-version="1"></div>'),
    ).toEqual({ product: "a&b", variant: "v", version: "1" });
  });

  it("treats a partial marker as no marker — three fields are one statement", () => {
    expect(parseBuildMarker('<div id="app-build" data-product="p" data-variant="v"></div>')).toBeNull();
  });

  it("returns null for a page that advertises nothing", () => {
    expect(parseBuildMarker("<html><body><h1>Legacy console</h1></body></html>")).toBeNull();
  });

  it("reads the marker off a live page without disturbing an observation", async () => {
    // The marker is `hidden` (§10), which is what keeps it out of the accessibility tree: the
    // observation the model reads must not gain a node because of a drift check.
    const surface = await startSurface();
    try {
      await surface.page.goto(`${surface.base}/`);
      const identity = await observeIdentity(surface.page);
      expect(identity).toEqual(observed({ product: "atlas-console", variant: "base", version: "0.1" }));

      const digest = await surface.driver.render({ mode: "compact" });
      expect(digest).not.toContain("atlas-console/base");
    } finally {
      await surface.stop();
    }
  });
});

describe("comparing a recorded identity with a target's", () => {
  it("matches on all three fields", () => {
    expect(compareIdentity(RECORDED, observed(RECORDED)).kind).toBe("match");
  });

  it("stops on a different variant, naming both sides", () => {
    const verdict = compareIdentity(RECORDED, observed({ ...RECORDED, variant: "sunrise-cu" }));
    expect(verdict.kind).toBe("mismatch");
    expect(verdict.reason).toContain("atlas-console/base@0.1");
    expect(verdict.reason).toContain("atlas-console/sunrise-cu@0.1");
  });

  it("stops on a different product even when the variant agrees", () => {
    expect(compareIdentity(RECORDED, observed({ ...RECORDED, product: "other-console" })).kind).toBe("mismatch");
  });

  it("only records a version difference — a patch is not a different app", () => {
    const verdict = compareIdentity(RECORDED, observed({ ...RECORDED, version: "0.2" }));
    expect(verdict.kind).toBe("version-drift");
    expect(verdict.reason).toContain("same product and variant, different build");
  });

  it("proceeds as unknown when the target advertises nothing (§26 nit 3)", () => {
    const verdict = compareIdentity(RECORDED, ABSENT_IDENTITY);
    expect(verdict.kind).toBe("unknown");
    expect(verdict.reason).toContain("step-level checks are the backstop");
  });

  it("proceeds as unknown when the artifact has no recorded identity to compare", () => {
    // Recorded against a surface that advertised nothing. There is nothing to compare, and a
    // manufactured `match` would be the check claiming to have looked at something it did not.
    const verdict = compareIdentity(UNKNOWN_IDENTITY, observed(RECORDED));
    expect(verdict.kind).toBe("unknown");
  });

  it("reports the comparison for evidence whatever the verdict — including no drift", () => {
    expect(identityEvidence(RECORDED, observed(RECORDED))).toEqual({
      expected: RECORDED,
      observed: RECORDED,
      verdict: "match",
      reason: expect.any(String),
    });
    expect(identityEvidence(RECORDED, ABSENT_IDENTITY).observed).toEqual(UNKNOWN_IDENTITY);
  });

  it("names an identity in one line, for both sides of a stop", () => {
    expect(describeIdentity(RECORDED)).toBe("atlas-console/base@0.1");
    expect(identityOf(ABSENT_IDENTITY)).toEqual(UNKNOWN_IDENTITY);
  });
});
