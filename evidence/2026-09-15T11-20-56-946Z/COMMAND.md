# discover — member-savings-balance: Look up member 12345 and read their current savings balance

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
npm run discover -- --goal 'Look up member 12345 and read their current savings balance' --param memberId=12345 --id member-savings-balance
```

## What this run ended as

Exit code `0` — success or business outcome — both are legitimate answers a caller acts on.

success — savings balance: $4,201.55

## Notes

- This command needs `OPENAI_API_KEY` — discovery is the one paid, model-driven step. Replaying what it records does not.
- Discovery is model-driven, so re-running it is a *fresh recording*, not this one again: the model's own wording, the recorded targets and the resulting artifact can all differ. The review pass is deterministic — it seeds the artifact's `outcomes[]` from `policy.json`'s curated vocabulary and stamps `reviewedBy: human` — so a re-run is reproducible in shape, not in bytes.
- The recording is `capabilities/member-savings-balance/v1/artifact.json`: this run wrote it (`saved …` in its own run log, which spells the version `v1.0` — the store treats `1`, `1.0` and `1.0.0` as one version) and its `provenance.discoveryRunId` names this directory.
- **The outcome line above is the vocabulary of the tool as it stood.** The model named that output `savings balance`, so the run printed `success — savings balance: $4,201.55`. A run today publishes a value under the artifact's own name and in the type the artifact declares, so the same read reports `savingsBalance: 4201.55`; see `evidence/README.md`.
- **Re-running this command today is refused before anything runs.** A recorded version is immutable, so preflight stops at exit `2` with `capability "member-savings-balance" already has a recorded v1 … a recorded version is immutable` and names the fix: record a new version with `--version <next>`, or name a new capability with `--id <new-id>`. It is a preflight problem rather than a store error at the end of a run because discovery is the paid step; moving the existing version directory aside also works, deliberately.
- The surface advertised `atlas-console/base@0.1` at the end of the run, which is what the artifact's `app` block is stamped with.
- This run's model: `gpt-5.4-mini`, the default then in force — the artifact records it in `provenance.model`, so a replay that behaves differently has the recording's model named in the file it is reading.
