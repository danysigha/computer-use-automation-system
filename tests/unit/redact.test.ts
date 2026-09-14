/**
 * The scrubber (§6, §11 P3).
 *
 * Two halves, and the second is the one that matters: masking a key **named** `password` is the
 * obvious half, and it is not the leak that actually happens. A typed secret reaches evidence under
 * keys nobody greps for — an accessibility render's `text`, a DOM snapshot's `value` attribute, a
 * console line quoting the page — which is why the registry of literals exists. Every test below
 * that pushes a value through an unrelated key is testing that half.
 */
import { describe, expect, it } from "vitest";
import { Redactor, REDACTED } from "../../src/policy/redact.ts";

const SSN = "412-88-9077";

/** The shipped policy's `redact` section, which is what a run actually scrubs with. */
function redactor(extra: { readonly outputIds?: readonly string[] } = {}): Redactor {
  return new Redactor({ fieldPatterns: ["password", "ssn", "account_number"], ...extra });
}

describe("the literal registry", () => {
  it("removes a registered value wherever it appears, under any key", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    // None of these keys is named `ssn` — that is the point.
    const scrubbed = scrubber.scrub({
      text: `Taxpayer SSN ${SSN}`,
      html: `<input value="${SSN}">`,
      nested: { deep: ["a", `and ${SSN} too`] },
      seq: 7,
    }) as { text: string; html: string; nested: { deep: string[] }; seq: number };

    expect(scrubbed.text).toBe(`Taxpayer SSN ${REDACTED}`);
    expect(scrubbed.html).toBe(`<input value="${REDACTED}">`);
    expect(scrubbed.nested.deep[1]).toBe(`and ${REDACTED} too`);
    expect(scrubbed.seq).toBe(7); // non-strings pass through untouched
  });

  it("scrubs inside a longer value that contains a registered one", () => {
    const scrubber = redactor();
    scrubber.noteValue("412-88-9077");
    expect(scrubber.scrubText("prefix 412-88-9077 suffix")).toBe(`prefix ${REDACTED} suffix`);
  });

  it("replaces the longest registered value first, so an overlap cannot leave a fragment behind", () => {
    const scrubber = redactor();
    scrubber.noteValue("9077");
    scrubber.noteValue(SSN);
    expect(scrubber.scrubText(`ssn ${SSN}`)).toBe(`ssn ${REDACTED}`);
  });

  it("scrubs text sinks with no structure at all — a DOM snapshot, a console render", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    const file = `<html><body><input id="taxpayerSsn" value="${SSN}"><p>Taxpayer SSN: ${SSN}</p></body></html>`;
    expect(scrubber.scrubText(file)).not.toContain(SSN);
    expect(scrubber.scrubText(file)).toContain(REDACTED);
  });

  it("ignores a value too short to register, because scrubbing is global", () => {
    // Registering `"1"` would turn every evidence line into confetti. Field-name masking still
    // applies to such a field — only the literal registry is bounded.
    const scrubber = redactor();
    scrubber.noteValue("12");
    expect(scrubber.secretCount).toBe(0);
    expect(scrubber.scrubText("member 12345 balance 12")).toBe("member 12345 balance 12");
  });

  it("registers a value once, however many times it is typed", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    scrubber.noteValue(SSN);
    expect(scrubber.secretCount).toBe(1);
  });

  it("counts registered values but never exposes them", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    // The registry is search strings held for the life of the run; the count is the only thing
    // about it a sink (or a log line) may observe.
    expect(scrubber.secretCount).toBe(1);
    expect(JSON.stringify(Object.keys(scrubber))).not.toContain(SSN);
  });
});

describe("field-name masking", () => {
  it("masks the value of a key whose name matches a field pattern, keeping the key", () => {
    const scrubbed = redactor().scrub({ password: "hunter2-please", memberId: "12345" }) as Record<string, unknown>;
    // The key stays: "this line carries a password field" is what a reviewer needs. Its contents
    // are not.
    expect(scrubbed["password"]).toBe(REDACTED);
    expect(scrubbed["memberId"]).toBe("12345");
  });

  it("matches the ways a bank actually spells the same field", () => {
    const scrubber = redactor();
    for (const name of ["password", "Password", "userPassword", "ssn", "Taxpayer SSN", "taxpayerSsn", "account_number", "accountNumber"]) {
      expect(`${name}: ${scrubber.matchesField(name)}`).toBe(`${name}: true`);
    }
    for (const name of ["memberId", "branchCode", "noteCount", "amount"]) {
      expect(`${name}: ${scrubber.matchesField(name)}`).toBe(`${name}: false`);
    }
  });

  it("masks a nested key, and an object inside an array, at any depth", () => {
    const scrubber = redactor();
    scrubber.noteValue("typed-nowhere"); // registered, so nothing below leans on the registry
    const scrubbed = scrubber.scrub({
      step: 3,
      attempts: [{ password: "hunter2-please", at: "12:01" }],
      meta: { credentials: { password: "hunter2-please" } },
    }) as { attempts: { password: unknown; at: string }[]; meta: { credentials: { password: unknown } } };

    expect(scrubbed.attempts[0]?.password).toBe(REDACTED);
    expect(scrubbed.attempts[0]?.at).toBe("12:01"); // a sibling key is untouched
    expect(scrubbed.meta.credentials.password).toBe(REDACTED);
  });

  it("does not mask a field *record* whose name is a value — that is what the registry is for", () => {
    // The known limit of name masking, asserted rather than assumed: a payload spelling a field as
    // `{name: "ssn", value: "…"}` has no key that matches, so nothing here is masked by name.
    // What protects that shape is the literal registry — the value was typed through the driver, so
    // it was registered before it could be written. Any sink that formats a field this way is
    // relying on the braces, not the belt, and this test is the record of that.
    const scrubber = redactor();
    const record = { name: "ssn", value: "412-88-9077-but-unregistered" };
    expect(scrubber.scrub([record])).toEqual([record]);

    scrubber.noteValue("412-88-9077-but-unregistered");
    expect((scrubber.scrub([record]) as { value: string }[])[0]?.value).toBe(REDACTED);
  });

  it("does not treat a null target as a match", () => {
    expect(redactor().matchesField(null)).toBe(false);
  });
});

describe("the one serializer", () => {
  it("scrubs before it serializes, so a serialized sink cannot carry a literal", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    const line = scrubber.serialize({ kind: "action", text: `typed ${SSN}` });
    expect(line).not.toContain(SSN);
    expect(JSON.parse(line)).toMatchObject({ kind: "action", text: `typed ${REDACTED}` });
  });

  it("serializes the way a JSON sink needs, with the scrub already applied at any indent", () => {
    const scrubber = redactor();
    scrubber.noteValue(SSN);
    const pretty = scrubber.serialize({ kind: "note", html: `<input value="${SSN}">` }, 2);
    expect(pretty).not.toContain(SSN);
    expect(pretty).toContain("\n  "); // still an indented file, just not a leaky one
  });

  it("writes `null` rather than `undefined` — a log line has to be valid JSON", () => {
    expect(redactor().serialize(undefined)).toBe("null");
  });

  it("serializes a value the scrubber could not walk without corrupting it", () => {
    expect(redactor().serialize({ count: 0, flag: false, missing: null })).toBe('{"count":0,"flag":false,"missing":null}');
  });
});

describe("output redaction precedence", () => {
  it("redacts an output the artifact declared, and one the policy names", () => {
    const scrubber = redactor({ outputIds: ["balance"] });
    expect(scrubber.output("balance", "1234.56", false)).toEqual({ value: REDACTED, redacted: true });
    expect(scrubber.output("ssn_last4", "9077", true)).toEqual({ value: REDACTED, redacted: true });
  });

  it("passes through an output neither declaration names", () => {
    const scrubber = redactor({ outputIds: ["balance"] });
    expect(scrubber.output("memberName", "Dana Okafor", false)).toEqual({ value: "Dana Okafor", redacted: false });
  });

  it("is a floor, not a ceiling: the artifact can redact more than policy requires", () => {
    const scrubber = redactor();
    expect(scrubber.redactsOutput("balance")).toBe(false);
    expect(scrubber.output("balance", "1234.56", true).redacted).toBe(true);
  });

  it("reports the policy's floor list for the §27 comparison", () => {
    const scrubber = redactor({ outputIds: ["balance", "ssn_last4"] });
    expect([...["balance", "ssn_last4", "memberName"].map((id) => `${id}:${scrubber.redactsOutput(id)}`)]).toEqual([
      "balance:true",
      "ssn_last4:true",
      "memberName:false",
    ]);
  });
});

describe("the redactor's surface", () => {
  it("reports the field patterns it was configured with, as written", () => {
    expect(redactor().fieldPatterns).toEqual(["password", "ssn", "account_number"]);
  });

  it("leaves an unregistered field alone — the belt and the braces are independent", () => {
    // `matchesField` is about a name; `noteValue` is about a value. A field that looks sensitive
    // but was never typed into has nothing to scrub, and vice versa.
    expect(redactor().scrubText("nothing registered yet")).toBe("nothing registered yet");
  });
});
