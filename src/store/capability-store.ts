/**
 * The capability store — save / load / version (§11 P2, layout §16).
 *
 * On disk a capability is a directory of versioned artifacts, plus a pointer:
 *
 *     capabilities/
 *       member-savings-balance/
 *         latest.json                 → { "version": "1.0.0" }
 *         v1.0.0/artifact.json
 *         v1.1.0/artifact.json
 *
 * Two properties are the whole design.
 *
 * **A version directory is immutable once written.** Re-recording a capability produces a new
 * version, and the old artifact keeps replaying untouched (§14's rollback story: no data stores,
 * no migrations, git and directories). `save` therefore refuses to clobber an existing version
 * unless the caller says so in as many words — a silently replaced artifact would quietly change
 * what a caller had already been running.
 *
 * **Nothing invalid is ever written or read.** `save` validates before it touches the filesystem
 * (§18's recorder rescue: "validate before write; refuse with message"), and `load` validates what
 * it finds, so a hand-edited or half-written file surfaces as the exact schema problem rather than
 * as a confusing failure several steps into a replay. This is the same promise §4.1 makes to a
 * calling agent — it never receives a broken pointer — enforced at the last place that can.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityInvalidError, parseCapability } from "../schema/validate.ts";
import type { Capability } from "../schema/artifact.ts";

/** `<repo>/capabilities`, derived from this file's location rather than the process cwd. */
export const DEFAULT_CAPABILITIES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "capabilities",
);

/** The version a caller passes to mean "whatever the pointer says". Also §5.4's `--version` default. */
export const LATEST = "latest";

const POINTER_FILE = "latest.json";
const ARTIFACT_FILE = "artifact.json";

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §16 writes the layout as `v<semver>` and §5.4 writes the flag as `--version <semver>`, while
 * §11's P4 exit names the first directory `v1`. Rather than overrule one of them, the two shorter
 * spellings are accepted and zero-filled on comparison, so `1`, `1.0` and `1.0.0` are one version
 * with a well-defined order. The directory keeps whatever spelling it was saved under.
 *
 * No dependency: the shape is four numbers and an optional prerelease, and `semver` would be a
 * package for a comparison this file already has to implement for `latest`.
 */
const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `null` for a release; a release sorts *after* the same version with a prerelease (semver). */
  readonly prerelease: string | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ?? null,
  };
}

/** Strip a `v` prefix, so `v1.0.0` and `1.0.0` name the same version. */
export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

export function isVersion(value: string): boolean {
  return parseVersion(normalizeVersion(value)) !== null;
}

/**
 * Order two versions; throws on one that is not a version at all, because a comparison that
 * silently returned 0 for garbage would make the `latest` fallback pick a directory at random.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(normalizeVersion(a));
  const right = parseVersion(normalizeVersion(b));
  if (left === null || right === null) {
    throw new Error(`not a version: ${left === null ? JSON.stringify(a) : JSON.stringify(b)}`);
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1; // a release outranks its own prereleases
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Every store error is a message a person can act on: what was asked for, what exists instead. */
export class CapabilityNotFoundError extends Error {
  readonly id: string;
  readonly known: readonly string[];

  constructor(id: string, root: string, known: readonly string[]) {
    super(
      `no capability "${id}" in ${root} — ` +
        (known.length === 0
          ? "nothing is recorded yet (record one with `npm run discover`)"
          : `known: ${known.join(", ")}`),
    );
    this.name = "CapabilityNotFoundError";
    this.id = id;
    this.known = known;
  }
}

export class CapabilityVersionNotFoundError extends Error {
  readonly id: string;
  readonly requested: string;
  readonly available: readonly string[];

  constructor(id: string, requested: string, available: readonly string[]) {
    super(
      available.length === 0
        ? `capability "${id}" has no recorded versions, so ${requested} cannot resolve`
        : `capability "${id}" has no version ${requested} — available: ${available.join(", ")}`,
    );
    this.name = "CapabilityVersionNotFoundError";
    this.id = id;
    this.requested = requested;
    this.available = available;
  }
}

/** Narrows an unknown catch to a message, without losing a non-Error thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CapabilityVersionExistsError extends Error {
  readonly path: string;

  constructor(id: string, version: string, path: string) {
    super(
      `capability "${id}" already has a recorded v${version} at ${path} — ` +
        "a recorded version is immutable, so save a new version, or pass `overwrite` to replace it knowingly",
    );
    this.name = "CapabilityVersionExistsError";
    this.path = path;
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

export interface StoredCapability {
  readonly id: string;
  readonly version: string;
  /** The version directory. */
  readonly dir: string;
  readonly artifactPath: string;
  /** Whether the `latest` pointer was moved to this version. */
  readonly latest: boolean;
}

export interface CapabilitySummary {
  readonly id: string;
  readonly versions: readonly string[];
  /** The pointer's version, or the highest recorded one when no pointer was written. */
  readonly latest: string | null;
}

export interface SaveOptions {
  readonly version: string;
  /** Replace an existing version directory. Off by default: a recorded version is immutable. */
  readonly overwrite?: boolean;
}

export class CapabilityStore {
  readonly root: string;

  constructor(root: string = DEFAULT_CAPABILITIES_ROOT) {
    this.root = resolve(root);
  }

  /**
   * Write a capability, and move the `latest` pointer to it when it is the newest version.
   *
   * Validation comes first and is not advisory: an artifact that fails it is refused here with the
   * full issue list, so no invalid artifact ever reaches `capabilities/`. The parameter is typed
   * `unknown` on purpose — a recorder that assembled its artifact as data gets checked exactly the
   * way a hand-written one does, rather than being trusted for having the right static type.
   */
  async save(capability: unknown, options: SaveOptions): Promise<StoredCapability> {
    const version = normalizeVersion(options.version);
    if (!isVersion(version)) {
      throw new Error(`"${options.version}" is not a version (expected e.g. 1.0.0 or 1)`);
    }

    const parsed = parseCapability(capability);

    // An equivalent version may already be recorded under a different spelling (`1` saved, `1.0.0`
    // offered), and the immutability promise is about the *version*, not the directory name. So the
    // existing spelling wins outright: it is what gets replaced under `overwrite`, so that one
    // version never becomes two directories that only `compareVersions` knows are the same.
    const existing = await this.matchVersion(version, await this.versions(parsed.id));
    if (existing !== null && options.overwrite !== true) {
      throw new CapabilityVersionExistsError(parsed.id, existing, this.versionDir(parsed.id, existing));
    }
    const resolved = existing ?? version;

    const dir = this.versionDir(parsed.id, resolved);
    await mkdir(dir, { recursive: true });
    // Two-space JSON with a trailing newline: an artifact is meant to be read and reviewed by a
    // person (the brief asks for exactly that), and a one-line dump is not.
    await writeFile(join(dir, ARTIFACT_FILE), `${JSON.stringify(parsed, null, 2)}\n`);

    // The pointer moves only forward. Backfilling an older version (re-recording v1 after v2
    // exists) is legitimate and must not demote `latest`; pinning `latest` deliberately is a
    // hand-edit of the pointer file, which `latestVersion` honours.
    const latest = await this.writePointer(parsed.id, resolved);

    return { id: parsed.id, version: resolved, dir, artifactPath: join(dir, ARTIFACT_FILE), latest };
  }

  /** Load and validate. `version` defaults to the pointer; `v1.0.0` and `1.0.0` both work. */
  async load(id: string, version: string = LATEST): Promise<Capability> {
    const artifactPath = await this.locate(id, version);
    const raw = await readArtifactJson(artifactPath);
    const capability = parseArtifact(raw, artifactPath);

    // The id is the artifact's own truth and the directory it lives in is a filing decision; if the
    // two disagree the file was moved or edited, and the caller asked for the wrong thing.
    if (capability.id !== id) {
      throw new CapabilityInvalidError(
        [{ path: "id", message: `artifact declares id "${capability.id}" but was loaded as "${id}"` }],
        artifactPath,
      );
    }
    return capability;
  }

  /**
   * Resolve a capability version to the path of its `artifact.json`, without reading it. This is
   * what a CLI needs to print *where* it read from, and what `load` is built on.
   */
  async locate(id: string, version: string = LATEST): Promise<string> {
    const available = await this.versions(id);

    // "No such capability" and "no such version of it" are different mistakes with different
    // fixes, and the second one is nonsense to say about a capability that was never recorded.
    if (available.length === 0 && !(await exists(this.capabilityDir(id)))) {
      throw new CapabilityNotFoundError(id, this.root, await this.ids());
    }

    const resolved =
      version === LATEST ? await this.latestVersion(id) : await this.matchVersion(version, available);
    if (resolved === null) throw new CapabilityVersionNotFoundError(id, version, available);

    return join(this.versionDir(id, resolved), ARTIFACT_FILE);
  }

  /** The capability ids in the store, for a message that can say what to ask for instead. */
  async ids(): Promise<readonly string[]> {
    const entries = await readdirOrEmpty(this.root);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Every recorded version of a capability, oldest first. Empty when the capability is unknown. */
  async versions(id: string): Promise<readonly string[]> {
    const dir = this.capabilityDir(id);
    const entries = await readdirOrEmpty(dir);
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("v"))
      .map((entry) => normalizeVersion(entry.name.slice(1)))
      .filter(isVersion)
      .sort(compareVersions);
  }

  /** What is in the store — the catalog view §13 defers, in the one form the CLI needs today. */
  async list(): Promise<readonly CapabilitySummary[]> {
    const summaries: CapabilitySummary[] = [];
    for (const id of await this.ids()) {
      summaries.push({ id, versions: await this.versions(id), latest: await this.latestVersion(id) });
    }
    return summaries;
  }

  /** The `latest` pointer's version, or the highest recorded one when there is no pointer. */
  async latestVersion(id: string): Promise<string | null> {
    const pointer = join(this.capabilityDir(id), POINTER_FILE);
    const raw = await readFile(pointer, "utf8").catch(() => null);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      const version =
        typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
      if (typeof version === "string" && isVersion(version)) {
        // The pointer is authoritative, so a hand-edit is how a capability is deliberately pinned to
        // an older version. It still has to name a version that exists.
        const matched = await this.matchVersion(version, await this.versions(id));
        if (matched !== null) return matched;
      }
    }
    // No pointer (a hand-authored capabilities/ tree, or a save that predates this file): the
    // highest version is the honest reading of "latest".
    return (await this.versions(id)).at(-1) ?? null;
  }

  /** Write the pointer to `version`, returning whether it landed (false = a higher version is latest). */
  private async writePointer(id: string, version: string): Promise<boolean> {
    const current = await this.latestVersion(id);
    if (current !== null && current !== version && compareVersions(version, current) < 0) return false;
    await mkdir(this.capabilityDir(id), { recursive: true });
    await writeFile(join(this.capabilityDir(id), POINTER_FILE), `${JSON.stringify({ version }, null, 2)}\n`);
    return true;
  }

  /** Find the recorded directory a requested version names, tolerating the `1` / `1.0.0` spellings. */
  private async matchVersion(requested: string, available: readonly string[]): Promise<string | null> {
    const wanted = normalizeVersion(requested);
    if (available.includes(wanted)) return wanted;
    if (!isVersion(wanted)) return null;
    return available.find((candidate) => compareVersions(candidate, wanted) === 0) ?? null;
  }

  capabilityDir(id: string): string {
    // The id's kebab grammar is enforced by the schema, and it is also what keeps this join from
    // escaping the store root — `load("../..")` is refused by the regex long before it is a path.
    return join(this.root, id);
  }

  versionDir(id: string, version: string): string {
    return join(this.capabilityDir(id), `v${normalizeVersion(version)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                          */
/* -------------------------------------------------------------------------- */

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

async function readdirOrEmpty(path: string): Promise<DirectoryEntry[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    // A missing directory is an empty store, not an error: `list` on a fresh checkout is empty.
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readArtifactJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    throw new Error(`expected an artifact at ${path}, but the file is not there`);
  }
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`);
  }
}

/**
 * Validate a file's contents. `parseCapability`'s context argument is the file path, so a broken
 * artifact reports as "capabilities/x/v1.0.0/artifact.json is invalid: …" — the reader is told which
 * file to open, not just which field is wrong.
 */
function parseArtifact(raw: unknown, path: string): Capability {
  return parseCapability(raw, path);
}
