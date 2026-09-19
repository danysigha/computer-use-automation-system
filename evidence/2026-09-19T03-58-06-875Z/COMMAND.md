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
npm run replay -- member-savings-balance --memberId 12345
```

## What this run ended as

Exit code `0` — success or business outcome — both are legitimate answers a caller acts on.

success — savingsBalance: 4201.55

## Notes

- Drift preflight (§26) — match: the target advertises atlas-console/base@0.1, as recorded.
- In force for this command: `PORT=4173`, `BUS_PORT=4517`.

