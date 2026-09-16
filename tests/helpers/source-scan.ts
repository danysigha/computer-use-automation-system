/**
 * Reading source as source, for the tests that assert *rules over the codebase* rather than over a
 * running system (§6's one-serializer rule, §23's headless rule).
 *
 * Those tests are source scans on purpose: a sink that no test exercised, or an integration test
 * that opened a window only on a machine with a display, would pass a runtime check and still be
 * wrong. The scan has one shared problem, and it lives here so the two scans cannot answer it
 * differently.
 */

/**
 * The source with its comments removed.
 *
 * Every one of these rules is *written down* in the very files that must not violate it — the sink
 * rule's header names `JSON.stringify`, the headless rule's names `--headed` — so a scan that read
 * the raw bytes would fire on the documentation and force the rule to be stated somewhere else,
 * which is how a rule stops being findable from the code it governs.
 *
 * A `//` counts as a comment only where it opens a line or follows whitespace: good enough for
 * source this repository controls, and deliberately conservative in the other direction — a `${}`
 * inside a string containing `//` is left alone rather than mistaken for a comment, so the scan
 * errs toward seeing code rather than toward missing it.
 */
export function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/(^|\s)\/\/[^\n]*/g, "$1");
}
