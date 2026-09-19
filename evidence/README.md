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
| [`2026-09-19T03-58-06-875Z`](2026-09-19T03-58-06-875Z/COMMAND.md) | **Replay, happy path**: the keyless command, the recorded artifact executed against a live target | `success`, `savingsBalance: 4201.55` |
| [`2026-09-19T03-58-08-703Z`](2026-09-19T03-58-08-703Z/COMMAND.md) | **Business outcome**: a member that is not on file is an answer, not a crash | `business-outcome NO_SUCH_ENTITY` in ~2s |
| [`2026-09-19T03-58-10-544Z`](2026-09-19T03-58-10-544Z/COMMAND.md) | **Business outcome, from a state the recording never saw**: the same artifact, a locked record | `business-outcome RECORD_LOCKED` |
| [`2026-09-19T03-59-28-629Z`](2026-09-19T03-59-28-629Z/COMMAND.md) | **Known-safe dialog**: policy lists this dialog's text, so the engine accepts it and continues | `success`, `confirmation: Sub-Account Activated` (8 steps) |
| [`2026-09-19T03-59-31-088Z`](2026-09-19T03-59-31-088Z/COMMAND.md) | **Un-declared state**: the app serves a page no outcome signature declares; the run stops cleanly with expected-vs-observed, a hint, and its evidence, exit `1` | `failure ELEMENT_NOT_FOUND` |
| [`2026-09-19T03-58-16-557Z`](2026-09-19T03-58-16-557Z/COMMAND.md) | **Escalation and handoff**: the un-declared *dialog* variant. The run pauses and prints a takeover nonce, a second process (`npm run operator`) takes control of the same live browser session over the control bus, accepts the dialog, hands back, and the run resumes | `success` after handback (the README's two-terminal transcript is this run) |
| [`2026-09-18T14-52-02-289Z`](2026-09-18T14-52-02-289Z/COMMAND.md) | **Parameterization**: the same artifact against a *different* member id. The recorded literal (`"$4,201.55"`) does not exist on this page, so the locator chain falls through to the row-relative one | `success`, `savingsBalance: 980.12` |

Notes a reader should have before diffing anything:

- **The rows are ordered by what they demonstrate, not by when they ran.** Run 1 is the recording, made
  on 2026-09-15; runs 2–8 are replays of it, re-recorded on 2026-09-18 and 2026-09-19 so that every
  replay in the set carries the tool's current narration — the `(locator: …)` step lines, a read printed
  as `read savingsBalance = 4201.55`, and `resolvedBy`/`candidateIndex` on the output observation.
- **The `?sim=` runs set their state through `--entry`.** Sim states in the fixture are
  session-scoped: the state set at the entry URL is still in force at step 7 of an 8-step flow, which
  is how the dialog runs reach the confirmation action rather than only the home page.
- **Run 6's exit code is the result, not a broken copy-paste.** That run is *supposed* to fail; its
  `COMMAND.md` says so.
- **Run 7 was recorded headless**, like the command the README documents. The console's own view of the
  page and the escalation's screenshot are how the operator sees what they are acting on; a visible
  browser window is an option (`--headed`), not part of the demo, so its `COMMAND.md` does not carry it.
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
- **Run 1's step lines are the wording of the tool as it stood**: `candidate` where it now says
  `locator`, and a read printed as `read savingsBalance` without its value. It is the one run whose
  transcript this dates, and its `COMMAND.md` says where.
- **Run 1's outcome line is in the vocabulary of the tool as it stood.** It reads
  `savings balance: $4,201.55` — the model's own words for the output, and the value as it was read —
  where the same read today publishes the artifact's name and declared type, `savingsBalance: 4201.55`.
