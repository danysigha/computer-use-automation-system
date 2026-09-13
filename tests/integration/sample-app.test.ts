/**
 * P0 exit criteria for the fixture app (PLAN §11 P0): every route serves, `?sim=`
 * states are session-scoped, the build marker is on every page including sim states,
 * the login page is real, and the deep-link member route exists.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locationOf, session, startFixture } from "../helpers/fixture.ts";
import type { RunningApp } from "../../sample-app/server.ts";

const MEMBER_ROUTES = [
  "/",
  "/header",
  "/search?memberId=12345",
  "/member/12345/summary",
  "/member/12345/grid",
  "/member/12345/subaccount",
  "/member/12345/close-account",
  "/login",
];

const VALID_SUBACCOUNT = {
  type: "Regular Share",
  deposit: "250.00",
  nickname: "Vacation",
  branch: "04",
};

describe("Atlas Core Console fixture", () => {
  let app: RunningApp;
  let base: string;

  beforeAll(async () => {
    app = await startFixture();
    // Dial 127.0.0.1 directly: the fixture binds loopback only, and this avoids any
    // dependency on how the host resolves `localhost` (v4 vs v6).
    base = `http://127.0.0.1:${app.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("routes and the build marker", () => {
    it("serves every route with the advertised build marker", async () => {
      for (const route of MEMBER_ROUTES) {
        const response = await session(base).get(route);
        const body = await response.text();
        expect(response.status, route).toBe(200);
        expect(body, route).toContain('<div id="app-build" hidden');
        expect(body, route).toContain('data-product="atlas-console"');
        expect(body, route).toContain('data-variant="base"');
        expect(body, route).toContain('data-version="0.1"');
      }
    });

    it("stamps the marker on sim states, error states, and 404s alike", async () => {
      for (const route of ["/?sim=record-locked", "/?sim=page-error", "/?sim=dialog=known", "/no-such-route"]) {
        const body = await session(base).body(route);
        expect(body, route).toContain('<div id="app-build" hidden');
      }
    });

    it("lets a deployment change the advertised identity (the drift fixture)", async () => {
      const variant = await startFixture({ variant: "sunrise-cu", version: "9.9" });
      try {
        const body = await session(`http://127.0.0.1:${variant.port}`).body("/");
        expect(body).toContain('data-variant="sunrise-cu"');
        expect(body).toContain('data-version="9.9"');
        expect(body).toContain('data-product="atlas-console"');
      } finally {
        await variant.close();
      }
    });

    it("answers favicon quietly and 404s unknown routes with the un-declared error page", async () => {
      expect((await session(base).get("/favicon.ico")).status).toBe(204);
      const missing = await session(base).get("/no-such-route");
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("An unexpected condition occurred");
    });
  });

  describe("?sim= failure injection", () => {
    it("keeps a sim in force across in-app navigation until ?sim=off", async () => {
      const s = session(base);

      const entry = await s.get("/?sim=record-locked");
      expect(entry.status).toBe(200);
      expect(await entry.text()).not.toContain("Member 12345 is locked"); // entry still renders

      // …and the state is still in force two navigations later.
      expect(await s.body("/search?memberId=12345")).toContain("Member 12345 is locked");
      expect(await s.body("/member/12345/summary")).toContain("Member 12345 is locked");
      expect(await s.body("/member/12345/grid")).toContain("Member 12345 is locked");

      await s.get("/?sim=off");
      const cleared = await s.body("/member/12345/summary");
      expect(cleared).toContain("Member Summary");
      expect(cleared).not.toContain("is locked");
      expect(s.cookie).toBe("");
    });

    it("renders the pinned failure messages a shipped signature anchors to", async () => {
      expect(await session(base).body("/search?memberId=12345&sim=record-not-found")).toContain(
        "No member 12345 on file",
      );
      expect(await session(base).body("/search?memberId=12345&sim=record-locked")).toContain(
        "Member 12345 is locked",
      );
      expect(await session(base).body("/search?memberId=12345&sim=permission-denied")).toContain(
        "Access to member 12345 is restricted",
      );
    });

    it("reports an unknown member the same way, with no sim at all", async () => {
      expect(await session(base).body("/search?memberId=99999")).toContain("No member 99999 on file");
      expect(await session(base).body("/member/99999/summary")).toContain("No member 99999 on file");
    });

    it("replaces every page with an un-declared state under ?sim=page-error", async () => {
      const body = await session(base).body("/?sim=page-error");
      expect(body).toContain("An unexpected condition occurred. Reference: ATL-5001");
      const s = session(base);
      await s.get("/?sim=page-error");
      expect(await s.body("/member/12345/summary")).toContain("ATL-5001");
    });

    it("rejects an unknown sim loudly instead of ignoring it", async () => {
      const response = await session(base).get("/?sim=not-a-sim");
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("unknown sim");
    });

    it("delays only the first navigation by default (a transient, not a dead surface)", async () => {
      const s = session(base);
      const slowStarted = Date.now();
      await s.get("/?sim=slow=250");
      expect(Date.now() - slowStarted).toBeGreaterThanOrEqual(200);

      const fastStarted = Date.now();
      await s.get("/member/12345/summary");
      expect(Date.now() - fastStarted).toBeLessThan(150);
    });
  });

  describe("session expiry and the real login page", () => {
    it("expires mid-flow, lands on /login, and returns to the flow once signed on", async () => {
      const s = session(base);
      await s.get("/?sim=session-expired");

      const interrupted = await s.get("/member/12345/summary");
      expect(interrupted.status).toBe(302);
      expect(locationOf(interrupted)).toBe("/login?next=%2Fmember%2F12345%2Fsummary");

      const loginPage = await s.get(locationOf(interrupted));
      expect(loginPage.status).toBe(200);
      expect(await loginPage.text()).toContain("Teller Sign-On");

      const signedOn = await s.post("/login", {
        tellerId: "teller1",
        password: "atlas-demo",
        next: "/member/12345/summary",
      });
      expect(signedOn.status).toBe(302);
      expect(locationOf(signedOn)).toBe("/member/12345/summary");

      // Back in the flow, and no longer expiring on every navigation.
      expect(await s.body("/member/12345/summary")).toContain("Member Summary");
      expect((await s.get("/member/12345/grid")).status).toBe(200);
    });

    it("rejects bad credentials on the same page", async () => {
      const s = session(base);
      await s.get("/?sim=session-expired");
      await s.get("/member/12345/summary");
      const response = await s.post("/login", { tellerId: "teller1", password: "wrong", next: "/" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Invalid teller credentials");
    });
  });

  describe("sub-account flow and its dialogs", () => {
    it("validates the form and reaches the confirmation screen", async () => {
      const invalid = await session(base).post("/member/12345/subaccount", { ...VALID_SUBACCOUNT, deposit: "10.00" });
      expect(await invalid.text()).toContain("Initial deposit must be at least 25.00");

      const valid = await session(base).post("/member/12345/subaccount", VALID_SUBACCOUNT);
      const body = await valid.text();
      expect(body).toContain("Confirm Sub-Account Activation");
      expect(body).not.toContain('role="dialog"');
    });

    it("forces the validation-error state under its sim", async () => {
      const s = session(base);
      await s.get("/?sim=validation-error");
      const response = await s.post("/member/12345/subaccount", VALID_SUBACCOUNT);
      expect(await response.text()).toContain("Sub-account type is not available for this member");
    });

    it("surfaces dialogs on the confirmation action, never on the entry page", async () => {
      const unexpected = session(base);
      expect(await unexpected.body("/?sim=dialog=unexpected")).not.toContain('role="dialog"');
      await unexpected.post("/member/12345/subaccount", VALID_SUBACCOUNT);
      const escalated = await unexpected.post("/member/12345/subaccount/confirm", VALID_SUBACCOUNT);
      const text = await escalated.text();
      expect(text).toContain('role="dialog"');
      expect(text).toContain("Workstation policy notice");

      const known = session(base);
      await known.get("/?sim=dialog=known");
      await known.post("/member/12345/subaccount", VALID_SUBACCOUNT);
      const accepted = await known.post("/member/12345/subaccount/confirm", VALID_SUBACCOUNT);
      expect(await accepted.text()).toContain("Confirm activation of account");
    });

    it("activates the sub-account when no dialog stands in the way", async () => {
      const s = session(base);
      await s.post("/member/12345/subaccount", VALID_SUBACCOUNT);
      const confirmed = await s.post("/member/12345/subaccount/confirm", VALID_SUBACCOUNT);
      expect(confirmed.status).toBe(302);
      expect(locationOf(confirmed)).toBe("/member/12345/subaccount/done");
    });
  });

  describe("the hostile markup a capability has to target", () => {
    it("exposes the deep link, the actions, and the frame the balance grid lives in", async () => {
      const body = await session(base).body("/member/12345/summary");
      expect(body).toContain('src="/member/12345/grid"');
      expect(body).toContain('href="/member/12345/subaccount"');
      expect(body).toContain("Close account");
      expect(body).toContain('aria-label="Taxpayer SSN"');
    });

    it("renders the balance grid with the row/column shape a row-relative target reads", async () => {
      const body = await session(base).body("/member/12345/grid");
      expect(body).toContain("<th>Balance</th>");
      expect(body).toContain("<td>Savings</td>");
      expect(body).toContain("<td>$4,201.55</td>");
    });

    it("carries decoy text a loosely-anchored signature would wrongly match", async () => {
      const body = await session(base).body("/member/12345/grid");
      expect(body).toContain("<td>Locked</td>"); // a dormant account, on a happy page
      expect(body).not.toContain("Member 12345 is locked");
    });

    it("repeats the deep-link text so link targeting cannot rely on a bare label", async () => {
      const body = await session(base).body("/search?memberId=12345");
      const links = body.match(/>Detail<\/a>/g) ?? [];
      expect(links.length).toBeGreaterThan(1);
    });

    it("keeps one legacy control with no accessible name at all", async () => {
      const body = await session(base).body("/member/12345/subaccount");
      expect(body).toContain('name="branch"');
      expect(body).not.toContain('name="branch" aria-label');
    });
  });

  it("stays dependency-free: the fixture imports nothing but Node built-ins", () => {
    const source = readFileSync(new URL("../../sample-app/server.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("node:") || specifier.startsWith("."), specifier).toBe(true);
    }
  });
});
