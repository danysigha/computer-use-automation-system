# Evidence

Eight runs, one directory each. Every directory holds the same three things:

- `run.jsonl`: the run step by step: what was observed, what was decided, what was executed, and
  every policy verdict and note in the order it happened.
- `summary.json`: the same run as one object: what was asked, what the surface was, and how it ended.
- `COMMAND.md`: the exact command that produced the directory, with what it needs installed first.

All of them ran against the fixture app (`npm run app`, `http://localhost:4173`) with the shipped
`policy/policy.json`, on Node 24. The logs in these directories are the runs' own output. One
packaging edit was applied uniformly to all of them: absolute paths under the recording machine's
checkout were rewritten to `<repo>`, so the logs do not carry a local home directory. Nothing else
was altered.

| Run | What it demonstrates | Result |
|---|---|---|
| [`2026-09-15T11-20-56-946Z`](2026-09-15T11-20-56-946Z/COMMAND.md) | **Discovery**: a model-driven run records the first capability: 4 turns, `gpt-5.4-mini`, then the review pass seeds the business outcomes | `success`; wrote `capabilities/member-savings-balance/v1/artifact.json` |
| [`2026-09-16T22-40-14-847Z`](2026-09-16T22-40-14-847Z/COMMAND.md) | **Replay, happy path**: the keyless command, the recorded artifact executed against a live target | `success`, `savingsBalance: 4201.55` |
| [`2026-09-16T22-40-16-484Z`](2026-09-16T22-40-16-484Z/COMMAND.md) | **Business outcome**: a member that is not on file is an answer, not a crash | `business-outcome NO_SUCH_ENTITY` in ~2s |
| [`2026-09-16T22-40-18-090Z`](2026-09-16T22-40-18-090Z/COMMAND.md) | **Business outcome, from a state the recording never saw**: the same artifact, a locked record | `business-outcome RECORD_LOCKED` |
| [`2026-09-16T22-40-19-718Z`](2026-09-16T22-40-19-718Z/COMMAND.md) | **Known-safe dialog**: policy lists this dialog's text, so the engine accepts it and continues | `success`, `confirmation: Sub-Account Activated` (8 steps) |
| [`2026-09-16T22-40-22-033Z`](2026-09-16T22-40-22-033Z/COMMAND.md) | **Un-declared state**: the app serves a page no outcome signature declares; the run stops cleanly with expected-vs-observed, a hint, and its evidence, exit `1` | `failure ELEMENT_NOT_FOUND` |
| [`2026-09-16T22-40-25-611Z`](2026-09-16T22-40-25-611Z/COMMAND.md) | **Escalation and handoff**: the un-declared *dialog* variant. The run pauses and prints a takeover nonce, a second process (`npm run operator`) takes control of the same live browser session over the control bus, accepts the dialog, hands back, and the run resumes | `success` after handback (the README's two-terminal transcript is this run) |
| [`2026-09-18T12-30-21-326Z`](2026-09-18T12-30-21-326Z/COMMAND.md) | **Parameterization**: the same artifact against a *different* member id. The recorded literal (`"$4,201.55"`) does not exist on this page, so the target chain falls through to the row-relative candidate | `success`, `savingsBalance: 980.12` |

Notes a reader should have before diffing anything:

- **The `?sim=` runs set their state through `--entry`.** Sim states in the fixture are
  session-scoped: the state set at the entry URL is still in force at step 7 of an 8-step flow, which
  is how the dialog runs reach the confirmation action rather than only the home page.
- **Run 6's exit code is the result, not a broken copy-paste.** That run is *supposed* to fail; its
  `COMMAND.md` says so.
- **Run 7 is the only run launched `--headed`** (a visible browser window), because watching the
  operator's action land in the same live session is the point of that demo. Its `COMMAND.md` carries
  the flag.
- **Run 1 is the recording; the other seven replay it.** It is the run that wrote the artifact that
  ships, which is what `provenance.discoveryRunId` in that artifact names. Discovery is model-driven,
  so its `COMMAND.md` is explicit that re-running it is a fresh recording rather than this one again,
  and that a recorded version is immutable, so the same `--id` cannot simply be re-recorded.
- **Run 1 is also the oldest log here** (recorded before the operator console and control bus landed),
  so its `run.jsonl` has one fewer kind of note line: no `control bus:` line. Its step, action,
  decision and observation lines have the same shape as every other run's.
- Run 1's `COMMAND.md` was written at packaging time from that run's own `summary.json`, by the same
  writer every other run's was written by: it predates the writer by a day, and rebuilding the file
  from the run's own record was more honest than hand-writing it.
- **The parameterization run was re-recorded** on 2026-09-18, when a read started naming the candidate it
  resolved through. It is the one run here whose *transcript* changed: its step 3 reads 980.12 through
  the row-relative candidate while its step line names the literal the first candidate holds, so its log
  now carries `via candidate 2 of 3: row-relative[…]` and `resolvedBy`/`candidateIndex` on the output,
  where the earlier recording said only `read savingsBalance`.
- **Runs 2, 5 and 7 predate that line as well**, so their output observations carry no
  `resolvedBy`/`candidateIndex`. None of their reads resolved through a fallback, so their step lines and
  transcripts are unchanged; the difference is one field per output in `run.jsonl`.
