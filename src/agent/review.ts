/**
 * The human review pass (§4.1, §9, §11 P4) — what a successful run cannot know, added by the person
 * who does.
 *
 * A recording is a reading of one trace, and a trace is the record of a run that *worked*. That is
 * the whole difficulty of this file: the states a caller most needs named — the member that is not
 * on file, the record that is locked, the access that is refused — are exactly the states a
 * successful run never reaches, so no amount of watching the run produces them. §4.1's answer is
 * that they are **curated**, by a human, at the same seam as policy's `recoverableDialogs`; this
 * module is the pass that applies them and the place the two sources meet.
 *
 * Four decisions shape it.
 *
 * 1. **Nothing here is invented.** The seeds come from the policy file, where §6's "a malformed
 *    policy is a startup error" rule has already applied to them; this pass adds no signature of its
 *    own. A review that could author outcome text would be a second, invisible opinion about the
 *    app — the same failure the recorder is built to avoid, one layer up.
 *
 * 2. **The artifact is re-validated in the shape a caller receives.** `recordCapability` validated
 *    the artifact *before* the outcomes existed; this pass assembles the final document and validates
 *    that. So the capability returned from here is the one that was checked, and no rule lives in two
 *    places: duplicate codes, unresolvable `{param}`s in a message and vacuous patterns are all
 *    `validate.ts`'s, reported against the artifact's own paths.
 *
 * 3. **§4.1's smoke check is a refusal, not a warning.** A signature that matches text the happy path
 *    showed is not a style problem: §5.2 probes signatures as each step's state settles, *ahead* of
 *    that step's own expectation, so such a signature ends every successful replay as that outcome.
 *    The capability is not degraded, it is broken — and a broken capability that loads cleanly is
 *    invisible in a way a refused recording is not. The haystack is every piece of page text the
 *    trace recorded, including both sides of each delta (during a replay the page shows the previous
 *    step's settled state while the current step runs). It is *not* the whole DOM, which is why
 *    §4.1 calls this a smoke check: the seeds' own `sample` fields are the other half, pinning each
 *    pattern to a message the app really renders.
 *
 * 4. **`reviewedBy` is stamped only when something was curated.** §4.1 gives the field presence
 *    semantics — "presence means reviewed, absence means unreviewed, never approved" — so it has to
 *    mean something narrower than "the CLI ran". It records that a human's declarations are in this
 *    artifact, which is true exactly when a seed was applied; with an app that has no curated outcome
 *    vocabulary there is nothing a review could have added, and the artifact honestly stays
 *    unreviewed.
 *
 * One bound worth stating: a seed always becomes a `text-on-page` signature. The schema also allows
 * `element-shown`, but that kind needs a hand-written `TargetDescriptor`, and hand-authored targeting
 * is the thing §9 captures rather than writes. A curator who wants element-scoped detection is asking
 * for a different feature, not a second seed field.
 */
import { placeholdersIn, type BusinessOutcome, type Capability, type Provenance } from "../schema/artifact.ts";
import { CapabilityInvalidError, validateCapability } from "../schema/validate.ts";
import type { OutcomeSeed } from "../policy/policy.ts";
import { describeValue } from "./describe.ts";
import type { DiscoveryRun } from "./loop.ts";
import { collapse, type StateDelta } from "./trace.ts";

/** A review that would ship a capability the app cannot satisfy. Refused, never warned about. */
export class ReviewRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ReviewRefusedError";
    this.reason = reason;
  }
}

export interface ReviewOptions {
  /** The recording, as `recordCapability` emitted it — outcomes empty, provenance unstamped. */
  readonly capability: Capability;
  /** The run it came from. The only witness to what the happy path actually showed. */
  readonly run: DiscoveryRun;
  /** The app's curated failure vocabulary: policy's `outcomes` section (§4.1). */
  readonly seeds: readonly OutcomeSeed[];
}

export interface Reviewed {
  readonly capability: Capability;
  /** False when there was nothing to curate — see decision 4. */
  readonly reviewed: boolean;
  /** Lines for the run log, already safed for a terminal by the caller's scrubbing writer. */
  readonly notes: readonly string[];
}

export function reviewCapability({ capability, run, seeds }: ReviewOptions): Reviewed {
  if (seeds.length === 0) {
    return {
      capability,
      reviewed: false,
      notes: [
        "review: the policy declares no outcome signatures for this app, so there was nothing to " +
          "curate and the artifact stays unreviewed",
      ],
    };
  }

  const declared = new Set(capability.inputs.map((input) => input.name));
  for (const seed of seeds) checkMessageResolves(seed, declared);

  const observed = observedText(run);
  for (const seed of seeds) checkDoesNotMatchHappyPath(seed, observed);

  const provenance: Provenance = { ...capability.provenance, reviewedBy: "human" };
  const checked = validateCapability({ ...capability, outcomes: seeds.map(toOutcome), provenance });
  if (!checked.ok) throw new CapabilityInvalidError(checked.issues, "reviewed capability");

  return {
    capability: checked.capability,
    reviewed: true,
    notes: [
      `review: declared ${seeds.length} outcome signature(s) — ${seeds.map((seed) => seed.code).join(", ")}`,
    ],
  };
}

/** A seed is a declaration; the artifact wants an entry. The `sample` is the check, not a field. */
function toOutcome(seed: OutcomeSeed): BusinessOutcome {
  return { code: seed.code, message: seed.message, detect: { kind: "text-on-page", pattern: seed.pattern } };
}

/**
 * The one coupling between curated seeds and a particular recording: a seed is written for the app,
 * but its `message` is the sentence *this* capability's callers will read, interpolating *this*
 * recording's declared inputs. Naming the seed rather than the artifact path is deliberate — the
 * artifact is a machine-written file, and policy.json is where the curator will fix it.
 */
function checkMessageResolves(seed: OutcomeSeed, declared: ReadonlySet<string>): void {
  const unbound = placeholdersIn(seed.message).filter((name) => !declared.has(name));
  if (unbound.length === 0) return;
  throw new ReviewRefusedError(
    `the ${seed.code} message ${describeValue(seed.message)} interpolates ` +
      `${unbound.map((name) => `{${name}}`).join(", ")}, and this recording declares no input by ` +
      `that name ${declared.size === 0 ? "(it declares none)" : `(it declares ${[...declared].join(", ")})`}` +
      ". Either rename the placeholder to match the recording's input, or drop the braces and let the " +
      "message read the same for every caller.",
  );
}

function checkDoesNotMatchHappyPath(seed: OutcomeSeed, observed: readonly string[]): void {
  const pattern = new RegExp(seed.pattern);
  const hit = observed.find((text) => pattern.test(text));
  if (hit === undefined) return;
  throw new ReviewRefusedError(
    `the ${seed.code} signature ${describeValue(seed.pattern)} matches text this successful run ` +
      `showed: ${describeValue(hit)}. Signatures are probed as every step's state settles, ahead of ` +
      "the step's own expectation, so one that fires on the happy path ends every successful replay " +
      "as that outcome. Anchor it to the app's failure message alone.",
  );
}

/**
 * Every piece of page text the run recorded — the haystack decision 3 describes.
 *
 * The pre-action side of each delta is included on purpose: during a replay the page shows the
 * *previous* step's settled state while the current step runs, so text that was on screen before an
 * action is text a replay can be probed against. Empty strings are dropped rather than kept as
 * candidates — a pattern matching nothing is already refused by the seed schema, and an empty
 * haystack entry would report a hit against a page that showed nothing.
 */
function observedText(run: DiscoveryRun): readonly string[] {
  const text: string[] = [];
  const add = (value: string | null): void => {
    if (value === null) return;
    const collapsed = collapse(value);
    if (collapsed !== "") text.push(collapsed);
  };

  for (const entry of run.trace) {
    switch (entry.kind) {
      // The bootstrap navigation produces no observation, and the two kinds below it observe rather
      // than read: a wait sees no text, a screenshot's text is the pixels, which are not a haystack.
      case "entry":
      case "wait":
      case "screenshot":
        break;
      case "navigate":
        addAnchor(entry.delta, add);
        break;
      case "act":
        add(entry.node.name);
        add(entry.node.text);
        add(entry.textBefore);
        add(entry.textAfter);
        addAnchor(entry.delta, add);
        break;
      case "read":
        add(entry.node.name);
        add(entry.node.text);
        add(entry.text);
        break;
    }
  }

  return text;
}

function addAnchor(delta: StateDelta, add: (value: string | null) => void): void {
  if (delta.anchor === null) return;
  add(delta.anchor.node.name);
  add(delta.anchor.node.text);
  add(delta.anchor.from);
  add(delta.anchor.to);
}
