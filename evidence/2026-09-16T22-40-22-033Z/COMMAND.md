# replay — member-savings-balance (latest)

This directory is one run: `run.jsonl` is the step-by-step record, `summary.json` is the same run as one object, and the command below is what produced both.

## Regenerate this run

Once per machine:

```sh
npm ci
npx playwright install chromium
```

Then, with the fixture app running in another terminal:

```sh
npm run app
npm run replay -- member-savings-balance --memberId 12345 --entry 'http://localhost:4173/?sim=page-error'
```

## What this run ended as

Exit code `1` — run failure — the run happened and the result is a classified failure.

failure (replay): ELEMENT_NOT_FOUND — step: 1 — expected: role=textbox[name="Member ID"] +1 fallback(s) shows "12345" — observed: no candidate resolved uniquely (role=0 match(es), css=0 match(es)) — hint: every candidate in this step's target chain failed — the page moved under the artifact; check the app for a rename, then re-record the capability

## Notes

- Drift preflight (§26) — match: the target advertises atlas-console/base@0.1, as recorded.
- `--entry` carries a `?sim=` state. Sim states are session-scoped in the fixture: the state set here stays in force for every later navigation and form post in this run, which is how the run reaches the step it demonstrates rather than only its first page.
- In force for this command: `PORT=4173`, `BUS_PORT=4517`.
- The exit code above is this run's result, not a broken reproduction: the command is right, and the state it was pointed at is what the result describes.

