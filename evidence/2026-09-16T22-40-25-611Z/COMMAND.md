# replay — sub-account-open (latest)

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
npm run replay -- sub-account-open --memberId 12345 --entry 'http://localhost:4173/?sim=dialog=unexpected' --headed
```

## What this run ended as

Exit code `0` — success or business outcome — both are legitimate answers a caller acts on.

success — confirmation: Sub-Account Activated

## Notes

- Drift preflight (§26) — match: the target advertises atlas-console/base@0.1, as recorded.
- `--entry` carries a `?sim=` state. Sim states are session-scoped in the fixture: the state set here stays in force for every later navigation and form post in this run, which is how the run reaches the step it demonstrates rather than only its first page.
- This run was launched `--headed`: the browser window was visible for the whole run, which is what makes the escalation handoff watchable rather than asserted.
- In force for this command: `PORT=4173`, `BUS_PORT=4517`.

