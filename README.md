# Computer-use automation, in one vertical slice

An LLM-driven **discovery** run performs a goal in a browser once and distils it into a versioned
JSON artifact — targets, expectations, typed inputs and outputs, declared business outcomes. After
that the artifact **replays** deterministically with no model in the loop, under a policy that
decides what may run unattended, and a human can take over the same live session when the app does
something the artifact never saw.

The target is a deliberately hostile fixture: **Atlas Core Console**, a mock credit-union servicing
app (`sample-app/`) with framesets, headerless nested tables, duplicate text, no test ids — and a
`?sim=` switch that makes it fail on purpose (record locked, session expired, an unexpected dialog,
an undeclared error page). Everything below runs locally; no accounts, no network targets.

---

## Quick demo (no API key)

Prerequisites: **Node ≥ 22.18** (`.nvmrc` pins 24 — `nvm use` if you use nvm), and one browser
download (~200 MB, once). Nothing here needs an API key; replay is the keyless path.

```sh
npm ci
npx playwright install chromium        # on Linux, add --with-deps
```

Then, in **terminal A**:

```sh
npm run app
# Atlas Core Console (fixture) listening on http://localhost:4173
```

and in **terminal B**:

```sh
npm run replay -- member-savings-balance --memberId 12345
```

Expected output (paths shortened to `<repo>/…`; everything else is verbatim):

```text
  control bus: http://127.0.0.1:4517 (loopback only, per-request bearer)
  replay: member-savings-balance vlatest — 3 step(s) from http://localhost:4173/
  step entry: load the entry page http://localhost:4173/
  step 1: type role=textbox[name="Member ID"] +1 fallback(s) then role=textbox[name="Member ID"] +1 fallback(s) shows "12345"
  step 2: click role=button[name="Search"] +1 fallback(s) then the URL contains "/search?memberId=12345"
  step 3: read text="$4,201.55" +2 fallback(s) as output "savingsBalance"
    read savingsBalance
  success condition holds
success
  savingsBalance: 4201.55
  evidence: <repo>/evidence/2026-09-16T22-40-14-847Z
  run log: <repo>/evidence/2026-09-16T22-40-14-847Z/run.jsonl
```

Two more replays worth running, because they show the two ways a run can end without being broken:

```sh
# A member that is not on file is an answer, not a crash — exit code 0 like the success above.
npm run replay -- member-savings-balance --memberId 99999
# business-outcome: NO_SUCH_ENTITY
#   No member 99999 on file

# An undeclared state stops the run with expected-vs-observed, a hint and evidence — exit code 1.
npm run replay -- member-savings-balance --memberId 12345 --entry 'http://localhost:4173/?sim=page-error'
# failure (replay): ELEMENT_NOT_FOUND
#   step: 1
#   expected: role=textbox[name="Member ID"] +1 fallback(s) shows "12345"
#   observed: no candidate resolved uniquely (role=0 match(es), css=0 match(es))
```

Read the artifact the replay just executed — it is the whole contract, and it is meant to be read by
a person: [`capabilities/member-savings-balance/v1/artifact.json`](capabilities/member-savings-balance/v1/artifact.json).
Three steps, each with the target chain that resolved and a postcondition; the outcomes the caller can
receive, declared up front; `{memberId}` where the caller's value goes.

What to look at while it runs: the `?sim=` states are **session-scoped**, so a state set on the entry
URL is still in force seven steps later. That is how `--entry '…?sim=record-locked'` reaches the
results page rather than only the home page.

---

## Record your own capability (needs `OPENAI_API_KEY`)

```sh
cp .env.example .env      # then put your key in it
npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
  --param memberId=12345 --id member-savings-balance
```

You get a live turn-by-turn narration (`turn 1: type into [6]`, `turn 2: click [9] → url → …`), then
the recorder's binding log, the review pass, and a saved artifact:

```text
  binding: steps.0.value ← memberId (sample 12345)
  binding: steps.1.expect.urlContains ← memberId (sample 12345)
  review: declared 3 outcome signature(s) — NO_SUCH_ENTITY, RECORD_LOCKED, PERMISSION_DENIED
saved: <repo>/capabilities/member-savings-balance/v1/artifact.json
success
```

Replay it with a different member id and the same artifact still works — that is the parameterization
claim, not a demonstration of memorisation:

```sh
npm run replay -- member-savings-balance --memberId 12347
# …
#   step 2: click role=button[name="Search"] +1 fallback(s) then the URL contains "/search?memberId=12347"
#   step 3: read text="$4,201.55" +2 fallback(s) as output "savingsBalance"
# success
#   savingsBalance: 980.12
```

Note what step 3 does there: its **first** candidate is the literal text the model actually read
during discovery (`"$4,201.55"`), which does not exist on this member's page — so the chain falls
through to the row-relative candidate ("the Balance cell of the row whose account is `SAV`") and reads
the right number. Literal readings stay literal; the shape is what carries the reuse. The same run is
kept as evidence: [`evidence/2026-09-16T22-42-27-579Z/`](evidence/2026-09-16T22-42-27-579Z/COMMAND.md).

Two honest limits: discovery costs **cents per run** (~4–9 turns against localhost), and it is
**model-driven** — a re-run is a fresh recording, not a byte-identical repeat. A recorded version is
also immutable: re-recording over `v1` is refused by the store, so record under a new `--id` (or move
the version aside) rather than expecting the same path to be overwritten.

---

## Escalation demo — two terminals

The interesting half of automation is what happens when the app does something nobody recorded. In
this demo the confirmation POST raises a dialog whose text is **not** in the policy's
`recoverableDialogs`, so the run pauses and asks for a human. `--headed` puts the browser on screen
so you can watch the operator's click land in the same live session the run is driving — corroboration
only, never a second control path, and never the default.

**Terminal A** — the run, escalated and waiting:

```console
$ npm run replay -- sub-account-open --memberId 12345 --entry 'http://localhost:4173/?sim=dialog=unexpected' --headed

  replay: sub-account-open vlatest — 8 step(s) from http://localhost:4173/?sim=dialog=unexpected
  …steps 1–6…
  step 7: click role=button[name="Confirm activation"] +2 fallback(s) then the URL matches the route "/member/:id/subaccount/done"
  escalation: INTERSTITIAL_DIALOG — the app raised a dialog that policy does not list in `recoverableDialogs`, and the choice is a human one
    observed: Workstation policy notice: verify teller session before continuing (ref WS-4471). OK
    take over with:  npm run operator -- --nonce 4c805d2850fe80bbbf0e5ad65e0c34bee2b85bece2e153ec07ef56f5c6a43494 --bus http://127.0.0.1:4517
    the escalation terminates by itself in 600s if nobody answers
```

**Terminal B** — paste the printed nonce. The console renders the run's own view of the page (same
observer, same numbering the agent uses), and everything it does is policy-checked and logged as
`actor: human, channel: console`:

```console
$ npm run operator -- --nonce 4c805d2850fe80bbbf0e5ad65e0c34bee2b85bece2e153ec07ef56f5c6a43494 --bus http://127.0.0.1:4517

── escalation INTERSTITIAL_DIALOG — step 7 ────────
  why:        the app raised a dialog that policy does not list in `recoverableDialogs`, and the choice is a human one
  observed:   Workstation policy notice: verify teller session before continuing (ref WS-4471). OK
  run:        sub-account-open (replay)   evidence: <repo>/evidence/2026-09-16T22-40-25-611Z
  terminates: 575s from now unless you answer
  token:      human   lease: 10s left of 10s (renewed every heartbeat)   your actions: 0
  you hold the session — the run is paused until you hand it back
  ── live view (indices are the agent's own numbering; `expand` shows the hidden rows) ──
    # Confirm Sub-Account — Atlas Core Console — http://localhost:4173/member/12345/subaccount/confirm
    frame [0]
      text "ATLAS CORE CONSOLE"
      [0] link "Inquiry" → /
      [1] link "Search" → /
      [2] link "Locked Accounts Report" → /
      [3] link "End of Day" → /
    [4] heading "Confirm Sub-Account Activation"
    text "Member 12345 — review the request before it posts."
    table (5 rows)
      [5] cell "Field" | [6] cell "Value"
      [7] cell "Sub-account type" | [8] cell "Regular Share"
      [9] cell "Initial deposit" | [10] cell "100"
      [11] cell "Nickname"
      [13] cell "Branch code"
    [15] button "Confirm activation"
    text "Workstation policy notice: verify teller session before continuing (ref WS-4471)."
    [16] link "OK" → /member/12345/subaccount/done
  ── actionable now ──
  [0] link "Inquiry"
  [1] link "Search"
  [2] link "Locked Accounts Report"
  [3] link "End of Day"
  [15] button "Confirm activation"
  [16] link "OK"
  …run-log tail…

operator> 16 click
  you ran click [16] through the choke point (actor: human, channel: console)
    # Sub-Account Activated — Atlas Core Console — http://localhost:4173/member/12345/subaccount/done

operator> pass-control-back
operator: control handed back — the run re-verifies the page and continues
```

…and terminal A finishes on its own, one step later:

```text
    the step's postcondition holds after the handback — advancing
  step 8: read role=heading[name="Sub-Account Activated"] +2 fallback(s) as output "confirmation"
    read confirmation
  success condition holds
success
  confirmation: Sub-Account Activated
```

The run never re-issued the submit (a double submission would have been a real business action), and
its `run.jsonl` records the human's click, the handback, and the resume decision that followed. The
whole exchange is preserved in [`evidence/2026-09-16T22-40-25-611Z/`](evidence/2026-09-16T22-40-25-611Z/COMMAND.md).

Worth knowing: if nobody answers, the escalation ends the run at `timing.escalationTimeoutMs`
(default 10 min) as `HUMAN_UNAVAILABLE` rather than hanging — and the console's lease means a console
that dies while holding the session hands it back instead of stranding it.

---

## Configuration

Precedence everywhere: **env var > `policy.json` > code default**. `.env` is loaded by the CLIs.

| Knob | Default | What it does |
|---|---|---|
| `PORT` | `4173` | Fixture app's port. Must be in the policy allowlist or preflight stops and says so. |
| `BUS_PORT` | `4517` | Control bus for the operator console (bound to loopback only). |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Discovery model. Needs tool-calling and vision. |
| `POLICY_PATH` | `policy/policy.json` | The guardrail document: allowlist, risk, redaction, timing. |
| `EVIDENCE_DIR` | `evidence/` | Where runs are written. |

Everything in `policy.json`'s `timing` (waits, retries, backoff, escalation timeout, lease) and
`agent` (budgets) sections is overridable per field as `POLICY_TIMING_WAITFORMS=…` and friends, or by
pointing `--policy` at your own file for a single run:

```sh
POLICY_TIMING_RETRIES=1 npm run replay -- member-savings-balance --memberId 12345
npm run replay -- member-savings-balance --memberId 12345 --policy /path/to/your-policy.json
```

Replay's flags: `--version <v>` (default `latest`), `--<input> <value>` (validated against the
artifact's own declarations before anything launches), `--entry <url>` (overrides step 1's URL, must
still be on the allowlist), `--policy <file>`, `--allow-drift` (run against a target that advertises
a different product/variant, recorded in evidence), `--json`, `--headed`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `playwright: browser not found` / `Executable doesn't exist` | `npx playwright install chromium` (add `--with-deps` on Linux) |
| Node too old / `type stripping` errors | `nvm use` — the repo pins 24 in `.nvmrc` and requires ≥ 22.18 |
| `port 4173 is in use` | `PORT=4300 npm run app`, and make sure the same port is in the policy allowlist (preflight names the mismatch for you) |
| `the target is not the app this artifact was recorded against` | You are pointing at a different build/variant. Re-record, or pass `--allow-drift` to attempt reuse knowingly |
| Discovery: `OPENAI_API_KEY` is not set | Put the key in `.env` (see `.env.example`). Replay needs no key |
| Discovery: a provider error (401 / 429 / 5xx) mid-run | The run inherits it rather than hiding it: preflight checks that a key exists before launching, and an error during the loop ends the run as `DISCOVERY_FAILED` with the turns that did happen in `run.jsonl` — no silent infinite retries |
| Replay: `ELEMENT_NOT_FOUND` with a "page moved under the artifact" hint | The app changed under a recorded target. The artifact is meant to be reviewed: re-record, or fix the target chain |
| Replay: `NAVIGATION_BLOCKED` | The URL/action is not on the policy allowlist — that is the guardrail working, not a bug |

Every failure carries a per-code `hint` line and the evidence paths, so the terminal answer and the
`run.jsonl` next to it say the same thing.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success **or** business outcome — `NO_SUCH_ENTITY` and `$4,201.55` are both answers a caller acts on |
| `1` | Run failure: the run happened, and it ended as a classified failure (`ELEMENT_NOT_FOUND`, `SLOW_LOAD`, `HUMAN_UNAVAILABLE`, …) |
| `2` | Usage or preflight error: bad flag, unknown capability, an input that fails the artifact's own pattern, policy or environment problem — **the run never started** |

That boundary is deliberate: a scripted caller must be able to tell "the run did not happen" from
"the run happened and the answer is no".

## Where things are

| Path | What |
|---|---|
| `src/surface/` | The only place that touches a browser: `SessionDriver` (policy choke point), Observer, target resolution, capture |
| `src/agent/` | Discovery loop, OpenAI tool-calling driver, recorder, canonicalization, review pass |
| `src/schema/`, `src/store/` | The artifact schema (zod) and the versioned capability store |
| `src/policy/` | Allowlist, risk classifier, redaction — one choke point, every sink |
| `src/replay/` | Replay engine, taxonomy, result contract |
| `src/control/` | Controller token, control bus, operator console |
| `capabilities/` | Recorded artifacts, one directory per capability and version |
| `evidence/` | Run directories, each with a `COMMAND.md` that regenerates it — see [`evidence/README.md`](evidence/README.md) |
| `sample-app/` | The hostile fixture app, including its `?sim=` failure injection |

`npm test` runs the unit and integration suites (including a determinism canary that replays the
committed artifact twice and diffs the step traces); `npm run typecheck` is `tsc --noEmit`;
`node scripts/smoke.ts` boots the real entry point through plain `node`, which is the path an
evaluator takes.

## What this is not

No queues, clusters, or multi-tenant plumbing; no hosted service and no desktop driver (the
`SessionDriver` seam is the extension point, and `REPORT.md` §4 says what is built versus named); no
credential storage — an expired session always escalates to a human rather than re-authenticating
itself. [`REPORT.md`](REPORT.md) is the design write-up, including the parts that were deliberately
cut.
