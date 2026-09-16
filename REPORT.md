# REPORT

A model-driven **discovery** run performs a goal in a browser once and distils it into a versioned
JSON **capability artifact**; a keyless engine **replays** that artifact deterministically under
policy; a human can take over the *same live session* when the app does something the artifact never
saw. Code in `src/`, the hostile fixture app in `sample-app/`, eight reproducible runs in `evidence/`,
each with the command that regenerates it.

## 1. Architecture

One process per run owns the browser session — agent loop, replay engine, policy, evidence log,
control bus — so the operator console is a **second process** reaching the run over a loopback HTTP
bus. "The human drives the same live page" is therefore structural: the console never gets its own
browser, so there is no second path to the page.

**One choke point:** every browser action, the agent's and the engine's alike, goes through
`SessionDriver.execute`, where the allowlist, the risk classifier and redaction live. **The artifact
is the contract between two worlds:** discovery works in semantic tool calls (`click [7]`,
`type [12] "100"`, resolved against the live page at call time) and the artifact is a distilled,
parameterized version of them — never transcript, never model prose. **One observer, three
consumers:** a single accessibility-snapshot model feeds discovery turns, escalations and the
console, numbered over the full interactable set, so the console's indices *are* the agent's and
expansion never renumbers. A **control token** (`AGENT → PAUSED_ESCALATED → HUMAN → RESUMING → AGENT`,
leased) decides who may act on it.

Discovery's model is a seam, not an architecture: tool-calling + vision, default `gpt-5.4-mini`
(cheapest current model with both; cents per run against localhost), overridable with `OPENAI_MODEL`,
stamped into `provenance.model`.

## 2. Artifact schema

`src/schema/artifact.ts` (zod, strict) defines `id`/`name`/`description`, `app` (product, variant,
version — the tenant seam), `surface` (kind + entry), typed `inputs`/`outputs`, `success`, declared
`outcomes[]`, ordered `steps[]`, a `risk` block and `provenance`.

- **Steps are semantic and prove themselves.** A target is a `TargetDescriptor` whose candidates are
  tried in order — `role`+name (the portable core), `text`, `row-relative` ("the Balance cell of the
  row containing `SAV`"), `css` as an explicit last resort — and non-css candidates must resolve
  **uniquely**: ambiguity is a no-match, never a DOM-order guess. `framePath` covers frames, and every
  `act` requires an `expect` postcondition, which localizes a failure to a step and makes §5's
  four-way handback decidable.
- **Outcomes are declared and probed first.** `outcomes[]` names the codes a caller can receive
  (`NO_SUCH_ENTITY`, `RECORD_LOCKED`, `PERMISSION_DENIED`, …) as signatures over renderable page text
  plus messages that may interpolate inputs, and they are checked **before** any timeout or failure
  verdict — so a locked record is an answer, not a slow-looking failure.
- **Risk and parameterization are recorded facts.** `class`/`irreversibleSteps` are stamped from the
  policy verdicts the run already produced and re-checked at replay, binding on the stricter side. A
  declared input's sample becomes `{param}` in *every* emitted string field — typed values, `navigate`
  URLs, assertion literals — and a URL whose only change is a variable segment becomes
  `urlMatches: "/member/:id/summary"` (a pattern with no variable segment is rejected at validation:
  write `urlContains`). Model-chosen values stay literal, keeping "recorded a parameter"
  distinguishable from "memorised a page".
- **Absent by design:** per-step recovery hooks (recovery is single-homed at taxonomy + policy),
  per-variant overrides, credential fields. `provenance.reviewedBy` has *presence* semantics — reviewed,
  never "approved".

## 3. Determinism and error handling

Replay has no model and no randomness: same artifact, same app, same decisions — pinned by a canary
that replays the committed artifact twice and diffs the step traces, timestamps being the only
permitted difference, with ordered lines, policy verdicts and resolved candidates all compared.

Every ending lands in one of three families, each with a response rule rather than a label:

| Family | Codes | Response |
|---|---|---|
| Business outcome | `NO_SUCH_ENTITY`, `VALIDATION_ERROR`, `PERMISSION_DENIED`, `RECORD_LOCKED` | stop cleanly, hand the caller an answer — exit `0` |
| Recoverable | `INTERSTITIAL_DIALOG`, `SLOW_LOAD`, `TRANSIENT_ERROR`, `TRANSPORT_ERROR` | retry with backoff, dismiss a policy-known dialog, or escalate; on budget exhaustion terminate **under its own code** with evidence — never escalate, because a slow surface offers a human nothing the budget did not |
| Recoverable, human-only | `SESSION_EXPIRED` | always escalates: no credential seam exists, by design |
| Hard failure | `ELEMENT_NOT_FOUND`, `CHECKPOINT_MISMATCH`, `NAVIGATION_BLOCKED`, `UNEXPECTED_STATE` | stop; report expected-vs-observed + evidence + hint |

One result contract serves both commands (`success` | `business-outcome` | `failure`), with per-code
`hint` lines and exit codes `0` (success *or* business outcome), `1` (classified failure), `2`
(usage/preflight — the run never started). The boundary is deliberate: a scripted caller must
distinguish "the run did not happen" from "the run happened and the answer is no", so a bad flag
never becomes a `VALIDATION_ERROR`.

**Scope note.** Evidence runs cover both dialog branches, the three business codes and an undeclared
error page through `?sim=` on a real page; the integration suite covers what a page-shaped fixture
cannot honestly simulate — `SESSION_EXPIRED` escalation and login-resume, `SLOW_LOAD`'s
exhausted-budget terminal, `TRANSPORT_ERROR` against a non-listening origin and a mid-run kill, and
the redaction and handback matrices. That demonstrates classification and response, not a production
app's variety: these states were designed alongside the taxonomy, so they are credible fixtures, not
proof against unknown unknowns. `TRANSIENT_ERROR` is honestly designed-only, in both columns.

## 4. Heterogeneity and multi-tenant

Built and testable today:

- **The surface seam.** Everything the system knows about "a page" sits behind `SessionDriver` plus
  the Observer. `role`/`name` is the portable core; `text`, `row-relative` and `css` are web-surface
  implementations — so a desktop surface is a new driver contributing candidates for the same target
  shape, not a schema rewrite. **The desktop driver itself is designed, not built.**
- **Tenant reuse by canonicalization**, demonstrated end-to-end: the shipped artifacts carry
  `{memberId}` where a caller's value goes and `urlMatches: "/member/:id/summary"` where a route shape
  is the assertion, and replaying `member-savings-balance` for member `12347` reads `$980.12` — where
  the recorded literal candidate (`"$4,201.55"`) missed and the row-relative candidate resolved.
- **Drift detection before anything launches.** A product/variant mismatch against the target's
  advertised build marker stops at exit `2` naming both sides, a version difference on a matching
  variant proceeds recorded, an absent marker proceeds as `unknown`; `--allow-drift` reuses across a
  mismatch knowingly, and the verdict is recorded either way.

Honest bound: detection is **opportunistic** — exact where the surface advertises identity, otherwise
degrading to a step-level `ELEMENT_NOT_FOUND`/`CHECKPOINT_MISMATCH`, which says something did not
match but never which tenant's build you have.

## 5. Escalation and handoff

Escalation is raised from one place when the run cannot legitimately continue: a recoverable with no
policy handler, or (in discovery) a stuck verdict, a budget or a gated action. The request carries the
goal/capability, stage, step, reason, what the page showed, a screenshot path and the action-log tail;
the run holds `PAUSED_ESCALATED` and prints a takeover nonce.

A console acquires the token with it, drives the *same* session through the choke point, and hands
back. Every human action is logged as `actor: human` with a `channel`: `console`, or `direct-session`
for a click made in the `--headed` window itself. That carve-out matters because a headed window is
physically clickable: resume re-verifies state rather than assuming the choke point was honoured, and
if the postcondition holds with nothing in the console accounting for it, the run **still advances**
while the audit trail names the path.

Resume is four-way, never a blind re-execute: the postcondition already holds → advance; the state is
unchanged → re-run the step (`type` replays as replace, so a partial human entry cannot double into
`1234512345`); progress is visible but unverifiable → re-escalate with evidence; otherwise → fail with
evidence. In the demo the human dismisses the dialog on the live page and the run advances without
re-issuing the submit — the double-fire guard asserted as an action count.

A run never parks forever: the token is leased (heartbeat ~2 s, TTL ~10 s), so a console that dies
mid-hold hands it back and the escalation re-raises; an unanswered escalation ends as
`failure HUMAN_UNAVAILABLE` after `timing.escalationTimeoutMs`; `decline` ends a run on purpose and a
second console is rejected.

## 6. Safety

- **Deny by default, with a risk floor.** The allowlist is origin- and route-scoped and its `actions`
  list is the driver's whole vocabulary, so the choke point is total: violations are
  `NAVIGATION_BLOCKED`, and a malformed policy is a startup error. Actions are `safe` or
  `approval-gated` (configured actions, sensitive fields), and replay binds on the stricter of
  artifact and policy — tightening policy upgrades a capability and records it, and no edit silently
  un-gates a recorded gate.
- **Redaction at every serialization boundary.** One serializer is the only way a run payload becomes
  JSON or text (a source scan in the suite enforces it), applied to `run.jsonl`, DOM snapshots, bus
  state, console renders — expanded dump and screenshot view included — and `--json` stdout.
  Pattern-matched typed values are registered as literals and scrubbed wherever they appear, even
  under unrelated keys, and automatic screenshots are suppressed while a sensitive field holds text.
  Honest bound: the fixture is synthetic and local, so screenshots can only contain synthetic data —
  the pattern rule carries the guarantee, not the fixture.
- **No secrets, ever.** Nothing is stored or injected: `SESSION_EXPIRED` escalates to a human who
  completes the mock login by hand rather than the system re-authenticating itself. A credential seam
  is the change that would make this system dangerous, so it does not exist.
- **Bus security.** Loopback-only bind, a per-run ≥128-bit single-use takeover nonce, then a bearer on
  every request, with Host/Origin validation and a JSON content type. That stops stray local processes
  and the "any webpage can POST to localhost" vector — **not** a hostile local actor with shell
  access, which is outside this system's threat model.

## 7. Cuts

One stretch item was taken on its cheap path: **canonicalization** — parameter *and route* patterns
written by the recorder, with `urlMatches` as a real reader — that is, the brief's "canonicalize
across tenants and/or parameterize per tenant" without the half needing a second tenant to point at.

Five were cut, each with the seam that would take it: **capability catalog / invocation surface** (the
store already indexes versions; the artifact is the typed contract a catalog would serve); **code
generation from an artifact** (it is already a reviewable program); **confidence scoring × approval
gate** (needs a reviewer role and a flakiness signal; the half needing neither shipped — `risk`,
`provenance.reviewedBy`); **assisted single-step LLM recovery** (recovery is single-homed at
taxonomy + policy, so an LLM belongs at the escalation decision point, never as a per-step hook); and
**multi-run stability metric** (the cheap version is the determinism canary; the metric itself waits
for evidence of drift). Also cut, as the specialization half of the item that *was* taken: a second
variant to demo against and `perVariantOverrides`.

Depth beat breadth because each interesting claim — a reviewable artifact, deterministic replay,
declared outcomes, one choke point, a handoff that survives a human — is only demonstrated by the
whole slice working end to end. What is *not* cut is the honesty: §3's scope note, §4's opportunistic
bound and §6's threat model state what the evidence does not show. The two things the brief asked to
be *designed* rather than built are designed — a desktop surface, and a real co-browsing UI over a
mock operator console with a real mechanism behind it — while scaling infrastructure is excluded by
the brief and not attempted.
