# Computer-use automation, in one vertical slice

An LLM-driven **discovery** run performs a goal in a browser once and distils it into a versioned
JSON artifact: targets, expectations, typed inputs and outputs, declared business outcomes. After
that the artifact **replays** deterministically with no model in the loop, under a policy that
decides what may run unattended, and a human can take over the same live session when the app does
something the artifact never saw.

The target is a deliberately hostile fixture: **Atlas Core Console**, a mock credit-union servicing
app (`sample-app/`) with framesets, headerless nested tables, duplicate text, no test ids, plus a
`?sim=` switch that makes it fail on purpose (record locked, session expired, an unexpected dialog,
an undeclared error page). Everything below runs locally; no accounts, no network targets.

---

## Quick demo (no API key)

Prerequisites: **Node ≥ 22.18** (`.nvmrc` pins 24, so `nvm use` if you use nvm), and one browser
download (~200 MB, once). Nothing here needs an API key; replay is the keyless path.

```sh
npm ci
npx playwright install chromium        # on Linux, add --with-deps
```

One npm detail, since it is the first thing that trips people up: `npm run <script> -- <args>` is npm's
way of saying "the rest of this line belongs to the script", so the tool's own grammar starts at the
first flag after the `--`. Leave it out and npm eats the flags and forwards only their values, which the
command then reports as an unexpected positional (`discover takes no positional arguments (got …)`)
while npm warns that `Unknown cli config "--goal"` will stop being tolerated. Calling the entrypoint
directly, `node src/cli/discover.ts --goal …`, is the same command with npm out of the middle.

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
  step 1: type (locator: role=textbox[name="Member ID"] +1 fallback(s)) then role=textbox[name="Member ID"] +1 fallback(s) shows "12345"
  step 2: click (locator: role=button[name="Search"] +1 fallback(s)) then the URL contains "/search?memberId=12345"
  step 3: read (locator: text="$4,201.55" +2 fallback(s)) as output "savingsBalance"
    read savingsBalance = 4201.55
  success condition holds
success
  savingsBalance: 4201.55
  evidence: <repo>/evidence/2026-09-16T22-40-14-847Z
  run log: <repo>/evidence/2026-09-16T22-40-14-847Z/run.jsonl
```

Two more replays worth running, because they show the two ways a run can end without being broken:

```sh
# A member that is not on file is an answer, not a crash; exit code 0 like the success above.
npm run replay -- member-savings-balance --memberId 99999
# business-outcome: NO_SUCH_ENTITY
#   No member 99999 on file

# An undeclared state stops the run with expected-vs-observed, a hint and evidence; exit code 1.
npm run replay -- member-savings-balance --memberId 12345 --entry 'http://localhost:4173/?sim=page-error'
# failure (replay): ELEMENT_NOT_FOUND
#   step: 1
#   expected: role=textbox[name="Member ID"] +1 fallback(s) shows "12345"
#   observed: no locator resolved uniquely (role=0 match(es), css=0 match(es))
```

Read the artifact the replay just executed: it is the whole contract, and it is meant to be read by
a person: [`capabilities/member-savings-balance/v1/artifact.json`](capabilities/member-savings-balance/v1/artifact.json).
Three steps, each with the target chain that resolved and a postcondition; the outcomes the caller can
receive, declared up front; `{memberId}` where the caller's value goes.

What to look at while it runs: the `?sim=` states are **session-scoped**, so a state set on the entry
URL is still in force seven steps later. That is how `--entry '…?sim=record-locked'` reaches the
results page rather than only the home page.

---

## Record your own capability (needs `OPENAI_API_KEY`)

Both capabilities in `capabilities/` ship with the repo, and a recorded version is immutable, so the
command below asks for a **new version** of the shipped one. Re-using an `--id` and `--version` that
already exist is refused by preflight, before a browser opens and before the model is paid for.

```sh
cp .env.example .env      # then put your key in it
npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
  --param memberId=12345 --id member-savings-balance --version 2
```

To record a capability that is not in the repo yet, give it a goal of your own and a fresh `--id`;
`--version` only matters when you are re-recording one that already exists.

You get a live turn-by-turn narration (`turn 1: type into [6]`, `turn 2: click [9] → url → …`), then
the recorder's binding log, the review pass, and a saved artifact:

```text
  binding: steps.0.value ← memberId (sample 12345)
  binding: steps.1.expect.urlContains ← memberId (sample 12345)
  …
  review: declared 3 outcome signature(s) — NO_SUCH_ENTITY, RECORD_LOCKED, PERMISSION_DENIED
saved member-savings-balance v2 → <repo>/capabilities/member-savings-balance/v2
saved: <repo>/capabilities/member-savings-balance/v2/artifact.json
success
  currentSavingsBalance: 4201.55
```

That block is an excerpt, and the lines the ellipsis stands for are the model-driven part: the model's
wording, and the recorder's translation of it, vary from run to run (`recorder: the model named an
output "current savings balance", which the artifact calls "currentSavingsBalance"` is a real line from
one run). The shape (binding log, review pass, save) does not vary, and the name in that last line
always matches the artifact's, whatever the model called the value: the model's own words reach the
reviewer through the warning, and every name a caller sees comes from the artifact. The two `saved`
lines are one fact from two sinks: the run log's own note, and the artifact path printed for a caller
to copy.

Replay it with a different member id and the same artifact still works, which is the parameterization
claim, not a demonstration of memorisation. This one names `--version 1` so it replays the recording
that ships with the repo, which is the one the transcript below shows. The linked evidence replayed the
same one; its `COMMAND.md` just names no version, because it ran while `latest` still meant v1:

```sh
npm run replay -- member-savings-balance --version 1 --memberId 12347
# …
#   step 2: click (locator: role=button[name="Search"] +1 fallback(s)) then the URL contains "/search?memberId=12347"
#   step 3: read (locator: text="$4,201.55" +2 fallback(s)) as output "savingsBalance"
#     read savingsBalance = 980.12 via locator 2 of 3: row-relative[row="SAV" → cell]
# success
#   savingsBalance: 980.12
```

Note what step 3 does there. A step line names a **locator**: a rule for finding an element, not a value
this run read. Its first one is the literal text the model saw during discovery, on *another* member's
page (`"$4,201.55"`), and `+2 fallback(s)` is the chain behind it. That literal is not on this page, so
the read falls through to the next locator, "the Balance cell of the row whose account is `SAV`" — and
the line under the step states both facts at once: the value this run read, and the locator that read
it. Literal readings stay literal; the shape is what carries the reuse. The artifact stores the chain
under `candidates`; the terminal calls each one a locator. The same run is kept as evidence:
[`evidence/2026-09-18T14-52-02-289Z/`](evidence/2026-09-18T14-52-02-289Z/COMMAND.md).

Two honest limits: discovery costs **cents per run** (~4–9 turns against localhost), and it is
**model-driven**: a re-run is a fresh recording, not a byte-identical repeat. A recorded version is
also immutable: `discover` writes a version once, and preflight refuses an `--id`/`--version` that is
already recorded rather than letting the run find out at its last line. So re-recording means a new
`--version`, a new `--id`, or deliberately moving the old version directory aside.

Recording a version moves the `latest` pointer, so from here on a plain
`npm run replay -- member-savings-balance` replays *your* v2 (with the output name your run produced)
and not the shipped v1 that the examples above show. `--version 1` pins the shipped one.

---

## Escalation demo: two terminals

The interesting half of automation is what happens when the app does something nobody recorded. In
this demo the confirmation POST raises a dialog whose text is **not** in the policy's
`recoverableDialogs`, so the run pauses and asks for a human.

Both commands below run headless, and **everything you do is typed at the console's `operator>`
prompt**: the browser is not on screen and is never the thing you click. The console renders the run's
own view of the page (same observer, same numbering the agent uses), and every action it takes is
policy-checked and logged as `actor: human, channel: console`.

**Terminal A**: the run, escalated and waiting:

```console
$ npm run replay -- sub-account-open --memberId 12345 --entry 'http://localhost:4173/?sim=dialog=unexpected'

  replay: sub-account-open vlatest — 8 step(s) from http://localhost:4173/?sim=dialog=unexpected
  …steps 1–6…
  step 7: click (locator: role=button[name="Confirm activation"] +2 fallback(s)) then the URL matches the route "/member/:id/subaccount/done"
  escalation: INTERSTITIAL_DIALOG — the app raised a dialog that policy does not list in `recoverableDialogs`, and the choice is a human one
    observed: Workstation policy notice: verify teller session before continuing (ref WS-4471). OK
    take over with:  npm run operator -- --nonce 4c805d2850fe80bbbf0e5ad65e0c34bee2b85bece2e153ec07ef56f5c6a43494 --bus http://127.0.0.1:4517
    the escalation terminates by itself in 600s if nobody answers
```

**Terminal B**: paste the printed nonce. Everything from here on is typed at the `operator>` prompt,
and the console says which of the windows on screen is which:

```console
$ npm run operator -- --nonce 4c805d2850fe80bbbf0e5ad65e0c34bee2b85bece2e153ec07ef56f5c6a43494 --bus http://127.0.0.1:4517

── escalation INTERSTITIAL_DIALOG — step 7 ────────
  why:        the app raised a dialog that policy does not list in `recoverableDialogs`, and the choice is a human one
  observed:   Workstation policy notice: verify teller session before continuing (ref WS-4471). OK
  run:        sub-account-open (replay)   evidence: <repo>/evidence/2026-09-16T22-40-25-611Z
  terminates: 575s from now unless you answer (§8)
  screenshot: <repo>/evidence/2026-09-16T22-40-25-611Z/screenshots/01-escalation-interstitial-dialog.png
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

  everything here is typed at this prompt — a browser window or a screenshot viewer is a view of the session, not an input to it

  <idx> click            click the node the dump numbers <idx>
  <idx> type <text>      replace the field's contents with <text> (never appended)
  <idx> press <key>      press a key on a node, e.g. `3 press Enter`
  expand [idx]           re-render the whole model unsummarized (spreads nothing)
  refresh                poll the run again
  shot                   open the current screenshot in the OS viewer
  pass-control-back      hand the session back; the run re-verifies and continues
  decline                end the run: a person said no
  exit                   leave without handing back (the lease lapses, the run re-raises)
operator: opening the escalation screenshot in your image viewer — <repo>/evidence/2026-09-16T22-40-25-611Z/screenshots/01-escalation-interstitial-dialog.png

operator> 16 click
  you ran click [16] through the choke point (actor: human, channel: console)
    # Sub-Account Activated — Atlas Core Console — http://localhost:4173/member/12345/subaccount/done

operator> pass-control-back
operator: control handed back — the run re-verifies the page and continues
```

Want the window on screen as well? Add `--headed` to terminal A. Do not click it: a visible window is
physically clickable, and a click there never passes through the console. The run does notice, because
the handback compares the page against the state the console's last action produced and records a
change nothing in the console accounts for as `channel: direct-session` rather than quietly accepting
it. That is a path the audit trail names rather than loses, but it is not the path this demo is about.

…and terminal A finishes on its own, one step later:

```text
    the step's postcondition holds after the handback — advancing
  step 8: read (locator: role=heading[name="Sub-Account Activated"] +2 fallback(s)) as output "confirmation"
    read confirmation = "Sub-Account Activated"
  success condition holds
success
  confirmation: Sub-Account Activated
```

The run never re-issued the submit (a double submission would have been a real business action), and
its `run.jsonl` records the human's click, the handback, and the resume decision that followed. The
whole exchange is preserved in [`evidence/2026-09-16T22-40-25-611Z/`](evidence/2026-09-16T22-40-25-611Z/COMMAND.md).
That recorded run is the one `--headed` run in the evidence set, so its `COMMAND.md` says `--headed`
where the command above does not; the transcript is the same either way, since the window is a view of
the session rather than an input to it.

Worth knowing: if nobody answers, the escalation ends the run at `timing.escalationTimeoutMs`
(default 10 min) as `HUMAN_UNAVAILABLE` rather than hanging, and the console's lease means a console
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

Discovery's flags: `--goal "<sentence>"` (required), `--param <name>=<value>` (one per declared input,
in declaration order), `--id <capability-id>` (the store path; derived from the goal when absent),
`--version <semver>` (the version this recording becomes; default `1`, and an id/version that already
exists is refused by preflight), `--entry <url>`, `--json`, `--headed`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `playwright: browser not found` / `Executable doesn't exist` | `npx playwright install chromium` (add `--with-deps` on Linux) |
| Node too old / `type stripping` errors | `nvm use`; the repo pins 24 in `.nvmrc` and requires ≥ 22.18 |
| `port 4173 is in use` | `PORT=4300 npm run app`, and make sure the same port is in the policy allowlist (preflight names the mismatch for you) |
| `the target is not the app this artifact was recorded against` | You are pointing at a different build/variant. Re-record, or pass `--allow-drift` to attempt reuse knowingly |
| Discovery: `OPENAI_API_KEY` is not set | Put the key in `.env` (see `.env.example`). Replay needs no key |
| Discovery: `capability "…" already has a recorded v1 … a recorded version is immutable` | Preflight refused the re-recording before it started. Add `--version <next>` to record a new version, or pass a new `--id` to record a new capability |
| Discovery: a provider error (401 / 429 / 5xx) mid-run | The run inherits it rather than hiding it: preflight checks that a key exists before launching, and an error during the loop ends the run as `DISCOVERY_FAILED` with the turns that did happen in `run.jsonl`, rather than retrying silently and forever |
| Replay: `ELEMENT_NOT_FOUND` with a "page moved under the artifact" hint | The app changed under a recorded target. The artifact is meant to be reviewed: re-record, or fix the target chain |
| Replay: `NAVIGATION_BLOCKED` | The URL/action is not on the policy allowlist. That is the guardrail working, not a bug |
| Escalation: a browser window and an image viewer opened, and you are not sure where to type | At the `operator>` prompt. The viewer is a picture of the page and the window is only there if the run was launched `--headed`; a click in that window does not pass through the console, and is recorded as `channel: direct-session` (§25) rather than `channel: console` |

Every failure carries a per-code `hint` line and the evidence paths, so the terminal answer and the
`run.jsonl` next to it say the same thing.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success **or** business outcome: `NO_SUCH_ENTITY` and `$4,201.55` are both answers a caller acts on |
| `1` | Run failure: the run happened, and it ended as a classified failure (`ELEMENT_NOT_FOUND`, `SLOW_LOAD`, `HUMAN_UNAVAILABLE`, …) |
| `2` | Usage or preflight error: bad flag, unknown capability, an input that fails the artifact's own pattern, policy or environment problem; **the run never started** |

That boundary is deliberate: a scripted caller must be able to tell "the run did not happen" from
"the run happened and the answer is no".

## Where things are

| Path | What |
|---|---|
| `src/surface/` | The only place that touches a browser: `SessionDriver` (policy choke point), Observer, target resolution, capture |
| `src/agent/` | Discovery loop, OpenAI tool-calling driver, recorder, canonicalization, review pass |
| `src/schema/`, `src/store/` | The artifact schema (zod) and the versioned capability store |
| `src/policy/` | Allowlist, risk classifier, redaction: one choke point, every sink |
| `src/replay/` | Replay engine, taxonomy, result contract |
| `src/control/` | Controller token, control bus, operator console |
| `capabilities/` | Recorded artifacts, one directory per capability and version |
| `evidence/` | Run directories, each with a `COMMAND.md` that regenerates it; see [`evidence/README.md`](evidence/README.md) |
| `sample-app/` | The hostile fixture app, including its `?sim=` failure injection |

`npm test` runs the unit and integration suites (including a determinism canary that replays the
committed artifact twice and diffs the step traces); `npm run typecheck` is `tsc --noEmit`;
`node scripts/smoke.ts` boots the real entry point through plain `node`, which is the path an
evaluator takes.

## What this is not

No queues, clusters, or multi-tenant plumbing; no hosted service and no desktop driver (the
`SessionDriver` seam is the extension point, and `REPORT.md` §4 says what is built versus named); no
credential storage: an expired session always escalates to a human rather than re-authenticating
itself. [`REPORT.md`](REPORT.md) is the design write-up, including the parts that were deliberately
cut.
