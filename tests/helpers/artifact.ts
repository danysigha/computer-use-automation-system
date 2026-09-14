/**
 * The artifact fixture: §4.2's worked example, completed to the full §4.1 shape.
 *
 * The plan's example is marked "abbreviated", and two places are abbreviated in ways that matter
 * here: it omits `provenance` and it omits `Output.redact`. Both are required by §4.1 and both are
 * required by the schema on purpose — §27 makes `redact` a recorded fact (a defaulted `false` would
 * mean a hand-edited artifact silently opted *out* of redaction) and provenance is what makes a
 * recording reviewable. So the fixture adds them rather than the schema relaxing for the example.
 *
 * `validArtifact()` returns a loose, mutable copy. Most of the tests below mutate it into shapes the
 * schema exists to reject — a step with no `expect`, a `urlMatches` with no variable — which the
 * `Capability` type would not let them express at all. The fixture literal itself is checked against
 * `Capability`, so the *valid* case stays honest.
 */
import type { Capability } from "../../src/schema/artifact.ts";

/** A mutable, unchecked view of the fixture. See the note above on why this is loose. */
export type ArtifactJson = Record<string, any>;

const FIXTURE: Capability = {
  schemaVersion: "1.0",
  id: "member-savings-balance",
  name: "Member savings balance",
  description: "Look up a member and read the balance of their Savings account.",
  app: { product: "atlas-console", variant: "base", version: "0.1" },
  surface: { kind: "web-dom", entry: "http://localhost:4173/" },
  inputs: [
    {
      name: "memberId",
      type: "string",
      pattern: "^[0-9]{5}$",
      description: "Five-digit member number",
    },
  ],
  outputs: [
    { name: "balance", type: "money", source: { kind: "extract", stepId: 4 }, redact: false },
  ],
  success: { urlMatches: "/member/:id/summary" },
  outcomes: [
    {
      code: "NO_SUCH_ENTITY",
      detect: {
        kind: "text-on-page",
        pattern: String.raw`No member \d{5} (was )?not found|No member \d{5} on file`,
      },
      message: "No member {memberId} on file",
    },
    {
      code: "RECORD_LOCKED",
      detect: { kind: "text-on-page", pattern: String.raw`Member \d{5} is locked` },
      message: "Member {memberId} is locked",
    },
  ],
  steps: [
    { id: 1, kind: "navigate", url: "http://localhost:4173/" },
    {
      id: 2,
      kind: "act",
      action: "type",
      target: {
        candidates: [
          { strategy: "role", role: "textbox", name: "Member ID" },
          { strategy: "css", selector: "input", index: 0 },
        ],
      },
      value: "{memberId}",
      expect: {
        elementExists: { candidates: [{ strategy: "role", role: "button", name: "Search" }] },
      },
    },
    {
      id: 3,
      kind: "act",
      action: "click",
      target: {
        candidates: [
          { strategy: "role", role: "button", name: "Search" },
          { strategy: "text", text: "Search" },
        ],
      },
      expect: { urlMatches: "/member/:id/summary" },
    },
    {
      id: 4,
      kind: "extract",
      name: "balance",
      target: {
        candidates: [
          {
            strategy: "row-relative",
            row: { by: "cell-text", text: "Savings" },
            column: { by: "header-text", text: "Balance" },
            action: "cell",
          },
        ],
      },
      as: "table-cell",
    },
  ],
  risk: { class: "safe", irreversibleSteps: [] },
  provenance: {
    recordedAt: "2026-09-13T00:00:00.000Z",
    model: "gpt-5.4-mini",
    discoveryRunId: "2026-09-13T00-00-00-000Z",
  },
};

/** A fresh, mutable copy of the worked example — mutating one test's copy never touches another's. */
export function validArtifact(): ArtifactJson {
  return structuredClone(FIXTURE) as ArtifactJson;
}

/** The same fixture with its real type, for tests that need a `Capability` (the store's `save`). */
export function validCapability(): Capability {
  return structuredClone(FIXTURE);
}
