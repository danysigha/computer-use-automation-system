/**
 * The `outputs` object a discovery run hands its caller.
 *
 * It used to be three lines inline at the end of `assemble`, and both defects it is now tested for
 * lived in them: the object was keyed by the model's prose label rather than the artifact's name, so
 * discovery answered one capability's output under a name no other command used, and the redaction
 * declaration was looked up by that same wrong key, so an output the recorder had stamped `redact:
 * true` came back in clear text while replay masked it.
 *
 * Which is the point of moving it: the value shapes the caller sees were reachable only by paying for a
 * model run, and a leak in the last three lines of a run is not something to discover that way. Nothing
 * here needs a browser, a model or a store.
 */
import { describe, expect, it } from "vitest";
import { callerOutputs } from "../../src/cli/discover.ts";
import { REDACTED, Redactor } from "../../src/policy/redact.ts";
import type { Output } from "../../src/schema/artifact.ts";

function output(name: string, type: Output["type"], redact = false): Output {
  return { name, type, source: { kind: "extract", stepId: 1 }, redact };
}

/** The shipped policy's pattern list, which is what a run actually stamps against. */
function redactor(outputIds: readonly string[] = []): Redactor {
  return new Redactor({
    fieldPatterns: ["password", "ssn", "account_number"],
    outputIds,
  });
}

/** The live case this file exists for: the model finished in prose, the recorder named it an identifier. */
const LABELS = new Map([["currentSavingsBalance", "current savings balance"]]);
const READ = { "current savings balance": "$4,201.55" };

describe("what a discovery run reports as its outputs", () => {
  it("publishes the value under the artifact's name, in the type the artifact declares", () => {
    // Both halves at once, because they are the same defect: `current savings balance` is the model's
    // answer and `currentSavingsBalance` is what replay, the artifact and a caller's script all use, and
    // a money output is a number in replay rather than the string the model read off the page.
    const values = callerOutputs({
      declared: [output("currentSavingsBalance", "money")],
      labels: LABELS,
      read: READ,
      redactor: redactor(),
    });
    expect(values).toEqual({ currentSavingsBalance: 4201.55 });
    expect(Object.keys(values)).not.toContain("current savings balance");
  });

  it("masks what the artifact declares, even though the model named it in prose", () => {
    // §6, and the leak this file is really about: the recorder stamps `redact` from the artifact's name,
    // the model's words *or* the field the value was read out of, so a lookup keyed by the label misses
    // a stamp the artifact is carrying.
    const values = callerOutputs({
      declared: [output("savingsBalance", "money", true)],
      labels: new Map([["savingsBalance", "savings balance"]]),
      read: { "savings balance": "$4,201.55" },
      redactor: redactor(),
    });
    expect(values).toEqual({ savingsBalance: REDACTED });
  });

  it("applies the policy's own output floor under the artifact's name", () => {
    const values = callerOutputs({
      declared: [output("currentSavingsBalance", "money")],
      labels: LABELS,
      read: READ,
      redactor: redactor(["currentSavingsBalance"]),
    });
    expect(values).toEqual({ currentSavingsBalance: REDACTED });
  });

  it("leaves a value it did not type as money exactly as the run read it", () => {
    const values = callerOutputs({
      declared: [output("confirmation", "string")],
      labels: new Map([["confirmation", "what the page said"]]),
      read: { "what the page said": "Sub-Account Activated" },
      redactor: redactor(),
    });
    expect(values).toEqual({ confirmation: "Sub-Account Activated" });
  });

  it("reads an output the model already named the artifact's way", () => {
    // The fallback's arm: an artifact from somewhere other than this recorder has one word for the value
    // and no label to translate.
    const values = callerOutputs({
      declared: [output("balance", "string")],
      labels: new Map(),
      read: { balance: "980.12" },
      redactor: redactor(),
    });
    expect(values).toEqual({ balance: "980.12" });
  });
});
