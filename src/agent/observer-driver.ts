/**
 * The observation half of §9's observe → decide → act: what the model is shown, built from the
 * Observer and from nothing else.
 *
 * This is a small file with one job, and the job is worth its own file because the alternative is
 * what §24 warns about. The digest is a *rendering* of the shared snapshot model — size-capped for
 * context, with large tables summarized — and the console's view is a different rendering of the
 * same model. If the loop built its own digest, that would be a second renderer; if it read the
 * accessibility tree directly, that would be a second Observer. Either one drifts, and the drift
 * shows up as the console failing to explain a decision the agent made. So the loop asks this class,
 * and this class asks the Observer.
 *
 * The one thing that is *not* shared is the screenshot, and it is here for the same reason: §9 asks
 * for a downscaled capture, and the reduction has to happen once, at the point of capture, so the
 * image in the model's context and the image in the run's evidence are the same bytes. The capture
 * goes through `SessionDriver.screenshot` — the choke point's own method — which means §6's
 * suppression applies to what the model sees as well as to what a reviewer opens. That is the point:
 * a value typed into a sensitive field suppresses the picture for *every* consumer at once, rather
 * than leaving the model as the one reader who still gets pixels the scrubber cannot touch.
 */
import type { Redactor } from "../policy/redact.ts";
import type { SessionDriver } from "../surface/session-driver.ts";
import type { RenderOptions, Snapshot } from "../surface/observer.ts";
import type { ScreenshotPolicy } from "./config.ts";
import type { ScreenshotView } from "./driver.ts";

export interface ObserverDriverOptions {
  /** `compact` (the model's digest) is the default; the console's `expanded` is for humans. */
  readonly render?: RenderOptions;
  /** `null` disables vision entirely — the loop still works, on the digest alone. */
  readonly screenshot?: ScreenshotPolicy | null;
  /** The run's scrubber. The digest is a render of the live page and goes through it (§6). */
  readonly redactor: Redactor;
}

export interface TurnObservation {
  readonly digest: string;
  readonly screenshot: ScreenshotView | null;
  readonly screenshotNote: string | null;
}

export class ObserverDriver {
  readonly #driver: SessionDriver;
  readonly #options: ObserverDriverOptions;

  constructor(driver: SessionDriver, options: ObserverDriverOptions) {
    this.#driver = driver;
    this.#options = options;
  }

  /**
   * Build the model's view of one state.
   *
   * `snapshot` is passed in rather than taken here because the caller already has it: the loop
   * snapshots once per turn and uses the same object to resolve the model's indices and to hash the
   * state for the stuck detector. A second snapshot inside this method would be a second page — the
   * indices in the digest would then address a state that no longer exists, which is precisely the
   * mishap §24's "truncation is display-only, numbering never shifts" rule is written against.
   */
  async observe(snapshot: Snapshot, label: string): Promise<TurnObservation> {
    const digest = this.#options.redactor.scrubText(this.#driver.observer.render(snapshot, this.#options.render));

    const policy = this.#options.screenshot;
    if (policy === null || policy === undefined) {
      return { digest, screenshot: null, screenshotNote: null };
    }

    const result = await this.#driver.screenshot(label, {
      encoding: { type: policy.type, quality: policy.quality },
      withData: true,
    });
    if (result.kind === "suppressed") {
      return { digest, screenshot: null, screenshotNote: result.reason };
    }
    if (result.data === undefined) {
      // Unreachable with `withData: true`; treated as a suppressed capture rather than as an empty
      // image, because an empty image is a thing the model would try to interpret.
      return { digest, screenshot: null, screenshotNote: "the capture produced no image data" };
    }
    return { digest, screenshot: { data: result.data, mediaType: result.mediaType }, screenshotNote: null };
  }
}
