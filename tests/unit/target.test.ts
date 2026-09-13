/**
 * Target resolution across the fixture's hostile markup shapes (§11 P1 exit criteria).
 *
 * Every case here is a shape the plan calls out by name: nested tables, a headerless table,
 * duplicated text, an ambiguous multi-match, and row-relative inside an iframe. The fixture
 * was built hostile in P0 precisely so these are real assertions rather than synthetic ones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ElementNotFoundError,
  FramePathError,
  frameAt,
  isResolvable,
  resolveTarget,
  type ResolvedTarget,
  type TargetDescriptor,
} from "../../src/surface/target.ts";
import { startSurface, textOf, type Surface } from "../helpers/browser.ts";

let surface: Surface;

beforeAll(async () => {
  surface = await startSurface();
});
afterAll(async () => {
  await surface.stop();
});

async function resolve(descriptor: TargetDescriptor): Promise<ResolvedTarget> {
  return resolveTarget(surface.page, descriptor);
}

async function resolveText(descriptor: TargetDescriptor): Promise<string> {
  const resolved = await resolve(descriptor);
  const text = await textOf(resolved.element);
  await resolved.element.dispose();
  return text;
}

/**
 * Run a descriptor that is expected to exhaust its chain, and hand back the error so the
 * test can assert on what each candidate saw. Fails loudly if it resolves instead.
 */
async function expectNotFound(descriptor: TargetDescriptor): Promise<ElementNotFoundError> {
  try {
    const resolved = await resolveTarget(surface.page, descriptor);
    await resolved.element.dispose();
  } catch (error: unknown) {
    if (error instanceof ElementNotFoundError) return error;
    throw error;
  }
  throw new Error("expected the candidate chain to exhaust, but it resolved");
}

/** The member summary page: header iframe at [0], account grid iframe at [1]. */
const MEMBER = "/member/12345/summary";
/** The results page: one table nested inside another, and no <thead> anywhere. */
const RESULTS = "/search?memberId=12345";
const SUBACCOUNT = "/member/12345/subaccount";

describe("row-relative", () => {
  it("resolves a cell in a table with no <thead>, nested inside another table", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    // The account grid on this page sits inside a cell of an outer table and has no <thead>,
    // so the header row is the table's own first <tr> — the else-branch of the pinned rule.
    expect(
      await resolveText({
        candidates: [
          {
            strategy: "row-relative",
            row: { by: "cell-text", text: "Certificate" },
            column: { by: "header-text", text: "Balance" },
            action: "cell",
          },
        ],
      }),
    ).toBe("$10,000.00");
  });

  it("resolves through the <thead> branch when the table has one", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    // Same descriptor shape, different branch: grid.html has a real <thead>, and the whole
    // table lives inside an iframe, so this also exercises framePath composition (G4).
    expect(
      await resolveText({
        framePath: [1],
        candidates: [
          {
            strategy: "row-relative",
            row: { by: "cell-text", text: "Savings" },
            column: { by: "header-text", text: "Balance" },
            action: "cell",
          },
        ],
      }),
    ).toBe("$4,201.55");
  });

  it("scopes the header lookup to the innermost table", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    // The member cell lives in the OUTER table, whose own rows are member containers — the
    // "Account"/"Balance" headers belong to the grid nested two levels down. An outermost-
    // table lookup would happily find them and resolve the wrong thing; innermost must not.
    await expect(
      resolve({
        candidates: [
          {
            strategy: "row-relative",
            row: { by: "cell-text", text: "Member 12345 — Dana Whitfield" },
            column: { by: "header-text", text: "Balance" },
            action: "cell",
          },
        ],
      }),
    ).rejects.toThrow(ElementNotFoundError);
  });

  it("treats row text that appears in several cells as no-match, not a first-hit pick", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    // "Savings" is the account name in the grid AND the prefix of two Recent Activity rows.
    // Three cells contain it, so the descriptor cannot say which row it meant.
    const error = await expectNotFound({
      candidates: [
        {
          strategy: "row-relative",
          row: { by: "cell-text", text: "Savings" },
          column: { by: "header-text", text: "Balance" },
          action: "cell",
        },
      ],
    });

    expect(error.attempts[0]?.matches).toBe(3);
  });

  it("reaches a control whose own text is duplicated, by scoping to the row", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    // Four rows each carry a link named "Detail" — "the link in the Certificate row" is the
    // only description that identifies one of them.
    const resolved = await resolve({
      candidates: [
        {
          strategy: "row-relative",
          row: { by: "cell-text", text: "Certificate" },
          action: "link-in-row",
        },
      ],
    });
    expect(await textOf(resolved.element)).toBe("Detail");
    await resolved.element.dispose();
  });

  it("resolves the anchor cell itself when no column is named", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    expect(
      await resolveText({
        candidates: [
          { strategy: "row-relative", row: { by: "cell-text", text: "Certificate" }, action: "cell" },
        ],
      }),
    ).toBe("Certificate");
  });
});

describe("role", () => {
  it("resolves a uniquely named control", async () => {
    await surface.page.goto(`${surface.base}/`);
    expect(
      await resolveText({ candidates: [{ strategy: "role", role: "button", name: "Search" }] }),
    ).toBe("Search");
  });

  it("treats a name shared by several controls as no-match", async () => {
    await surface.page.goto(`${surface.base}${RESULTS}`);
    const error = await expectNotFound({
      candidates: [{ strategy: "role", role: "link", name: "Detail" }],
    });
    expect(error.attempts[0]?.matches).toBe(4);
  });

  it("does not resolve a role candidate for a control with no accessible name", async () => {
    await surface.page.goto(`${surface.base}${SUBACCOUNT}`);
    // The Branch-code field's label is a plain text cell — no label[for], no aria-label, no
    // placeholder. Its accessible name is empty, so no role candidate can reach it.
    const error = await expectNotFound({
      candidates: [{ strategy: "role", role: "textbox", name: "Branch code" }],
    });
    expect(error.attempts[0]?.matches).toBe(0);
  });
});

describe("text", () => {
  it("falls through on duplicated text and settles on the strategy that is unique", async () => {
    await surface.page.goto(`${surface.base}/`);
    // "Search" is both the submit button and the <h2>Search Tips</h2> heading; the chain
    // records the ambiguity and continues to a strategy that can tell them apart.
    const resolved = await resolve({
      candidates: [
        { strategy: "text", text: "Search" },
        { strategy: "role", role: "button", name: "Search" },
      ],
    });
    expect(resolved.candidate.strategy).toBe("role");
    expect(resolved.attempts.map((attempt) => attempt.matches)).toEqual([2, 1]);
    await resolved.element.dispose();
  });
});

describe("css", () => {
  it("is the last resort that reaches the nameless legacy control", async () => {
    await surface.page.goto(`${surface.base}${SUBACCOUNT}`);
    const resolved = await resolve({
      candidates: [
        { strategy: "role", role: "textbox", name: "Branch code" },
        { strategy: "css", selector: 'input[name="branch"]', index: 0 },
      ],
    });
    expect(resolved.candidate.strategy).toBe("css");
    expect(await resolved.element.evaluate((el) => el.getAttribute("name"))).toBe("branch");
    await resolved.element.dispose();
  });

  it("honours the index rather than taking the first match", async () => {
    await surface.page.goto(`${surface.base}/login`);
    // The login form is preceded by a hidden `next` field, so index 2 — not 0 or 1 — is the
    // password input. An index that is ignored would return the teller field here.
    const resolved = await resolve({
      candidates: [{ strategy: "css", selector: "input", index: 2 }],
    });
    expect(await resolved.element.evaluate((el) => el.getAttribute("name"))).toBe("password");
    await resolved.element.dispose();
  });
});

describe("frame paths", () => {
  it("addresses an iframe by path, and reports an unreachable path rather than guessing", async () => {
    await surface.page.goto(`${surface.base}${MEMBER}`);
    expect((await frameAt(surface.page, [1])).url()).toContain("/member/12345/grid");
    expect((await frameAt(surface.page, [0])).url()).toContain("/header");
    await expect(frameAt(surface.page, [4])).rejects.toThrow(FramePathError);
  });

  it("agrees with the Observer's frame numbering", async () => {
    // The Observer derives frame paths from the accessibility tree while `frameAt` walks the
    // DOM; if those two enumerations ever diverge, every recorded framePath is wrong. This
    // pins the agreement that the rest of the system assumes.
    await surface.page.goto(`${surface.base}${MEMBER}`);
    const snapshot = await surface.driver.snapshot();
    const paths = new Set(
      snapshot.numbered.map((node) => node.framePath.join(".")).filter((path) => path !== ""),
    );
    expect([...paths].sort()).toEqual(["0", "1"]);
    expect((await frameAt(surface.page, [1])).url()).toContain("/member/12345/grid");
  });
});

describe("chain discipline", () => {
  it("never resolves when the chain is exhausted, and reports what each candidate saw", async () => {
    await surface.page.goto(`${surface.base}/`);
    const error = await expectNotFound({
      candidates: [
        { strategy: "role", role: "button", name: "No Such Button" },
        { strategy: "text", text: "No Such Text Either" },
        { strategy: "css", selector: "input[name=nonexistent]", index: 0 },
      ],
    });

    expect(error.attempts).toHaveLength(3);
    expect(error.attempts.map((attempt) => attempt.candidate.strategy)).toEqual(["role", "text", "css"]);
    expect(error.message).toContain("role=0 match(es)");
  });

  it("reports an unusable candidate as unusable, not as absent", async () => {
    await surface.page.goto(`${surface.base}/`);
    const error = await expectNotFound({
      candidates: [{ strategy: "css", selector: "input[[[", index: 0 }],
    });
    expect(error.attempts[0]?.matches).toBe(-1);
    expect(error.message).toContain("unusable");
  });

  it("backs elementExists / elementAbsent without throwing", async () => {
    await surface.page.goto(`${surface.base}/`);
    expect(await isResolvable(surface.page, { candidates: [{ strategy: "role", role: "button", name: "Search" }] })).toBe(true);
    expect(await isResolvable(surface.page, { candidates: [{ strategy: "role", role: "button", name: "Nope" }] })).toBe(false);
  });
});

describe("execution through the driver", () => {
  it("performs a click only after resolving, and reports the chain it used", async () => {
    await surface.page.goto(`${surface.base}/`);
    const executed = await surface.driver.execute({
      kind: "type",
      target: { candidates: [{ strategy: "role", role: "textbox", name: "Member ID" }] },
      value: "12345",
    });
    expect(executed.resolved?.candidate.strategy).toBe("role");
    expect(executed.verdict.allowed).toBe(true);
    expect(await surface.page.getByRole("textbox", { name: "Member ID" }).inputValue()).toBe("12345");
  });

  it("fails as a resolution error before policy is consulted", async () => {
    await surface.page.goto(`${surface.base}/`);
    await expect(
      surface.driver.execute({
        kind: "click",
        target: { candidates: [{ strategy: "role", role: "button", name: "Absent" }] },
      }),
    ).rejects.toThrow(ElementNotFoundError);
  });
});
