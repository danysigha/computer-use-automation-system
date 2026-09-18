/**
 * The keyboard, as a person spells it and as Playwright spells it.
 *
 * Found by an operator rather than by a test: the escalation demo's OK node is a link, the console's
 * help says `3 press Enter`, and the natural thing to type is `16 press enter` — which reached
 * `elementHandle.press` unchanged and came back as `Unknown key: "enter"`. The console frames that as a
 * refusal, so nothing broke, but the run answered in the voice of a library about a key the person had
 * named perfectly well.
 *
 * The alias table is deliberately short: the names a keyboard has, not a keymap. Anything the table
 * does not know is passed through untouched, because Playwright knows more than this file does, and the
 * one thing that must not happen is a name being *changed* into something else — a replayed artifact
 * that recorded `Control+a` has to press exactly that.
 */
import { describe, expect, it } from "vitest";
import { normalizeKey, pressFailure } from "../../src/surface/session-driver.ts";

describe("a key name someone typed", () => {
  it("folds the names a keyboard has to the spelling Playwright wants", () => {
    expect(normalizeKey("enter")).toBe("Enter");
    expect(normalizeKey("Enter")).toBe("Enter");
    expect(normalizeKey("return")).toBe("Enter");
    expect(normalizeKey("tab")).toBe("Tab");
    expect(normalizeKey("esc")).toBe("Escape");
    expect(normalizeKey("space")).toBe("Space");
    expect(normalizeKey(" up ")).toBe("ArrowUp");
    expect(normalizeKey("PAGEDOWN")).toBe("PageDown");
    expect(normalizeKey("f5")).toBe("F5");
  });

  it("passes through everything it is not sure about", () => {
    // A single character, a name that is already right, a code-based name, a combination: all of these
    // mean something to the browser, and a layer that guessed would be a layer that changed them.
    expect(normalizeKey("a")).toBe("a");
    expect(normalizeKey("1")).toBe("1");
    expect(normalizeKey("Tab")).toBe("Tab");
    expect(normalizeKey("KeyA")).toBe("KeyA");
    expect(normalizeKey("Control+a")).toBe("Control+a");
  });
});

describe("a key nothing knows", () => {
  it("is refused in this layer's words, naming what a key may be", () => {
    const refused = pressFailure("entr", new Error('elementHandle.press: Unknown key: "entr"'));
    expect(refused.message).toContain('"entr" is not a key name');
    expect(refused.message).toContain('"Enter"');
    expect(refused.message).not.toContain("elementHandle");
  });

  it("leaves every other press failure alone", () => {
    // An element that detached mid-press is not a spelling problem, and rewording it would hide the
    // failure the operator actually has.
    const detached = new Error("element is not attached to the DOM");
    expect(pressFailure("Enter", detached)).toBe(detached);
  });
});
