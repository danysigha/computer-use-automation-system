/**
 * The capability store: save / load / version (§11 P2, layout §16).
 *
 * The two properties worth testing are the ones the design is built on: a version directory is
 * immutable once written, and nothing invalid is ever written or read. Everything else here is
 * about the small decisions in between — what `latest` means when a version is backfilled, that
 * `1.10.0` outranks `1.9.0`, and that the failure messages say what does exist rather than only
 * what does not.
 *
 * Every test gets its own root under the OS temp dir, so nothing here can touch the real
 * `capabilities/` directory.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityNotFoundError,
  CapabilityStore,
  CapabilityVersionExistsError,
  CapabilityVersionNotFoundError,
  DEFAULT_CAPABILITIES_ROOT,
  compareVersions,
  isVersion,
  normalizeVersion,
} from "../../src/store/index.ts";
import { CapabilityInvalidError } from "../../src/schema/validate.ts";
import { validArtifact, validCapability } from "../helpers/artifact.ts";

const ID = "member-savings-balance";

let root: string;
let store: CapabilityStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "capabilities-"));
  store = new CapabilityStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Where a version of the fixture capability lands on disk. */
function artifactPath(version: string): string {
  return join(root, ID, `v${version}`, "artifact.json");
}

describe("save and load", () => {
  it("round-trips a capability through the disk", async () => {
    const capability = validCapability();
    const stored = await store.save(capability, { version: "1.0.0" });

    expect(stored).toMatchObject({ id: ID, version: "1.0.0", latest: true });
    expect(stored.artifactPath).toBe(artifactPath("1.0.0"));
    expect(await store.load(ID)).toEqual(capability);
  });

  it("loads an explicitly named version", async () => {
    await store.save(validCapability(), { version: "1.0.0" });
    expect(await store.load(ID, "1.0.0")).toEqual(validCapability());
  });

  it("writes an artifact a person can read", async () => {
    // The brief asks for an artifact that is reviewable, which is a property of the bytes: a
    // one-line JSON dump is technically the same document and useless to a reviewer.
    await store.save(validCapability(), { version: "1.0.0" });
    const raw = await readFile(artifactPath("1.0.0"), "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "schemaVersion": "1.0",');
    expect(JSON.parse(raw)).toEqual(validCapability());
  });

  it("reports where it read from, without reading", async () => {
    await store.save(validCapability(), { version: "1.0.0" });
    expect(await store.locate(ID)).toBe(artifactPath("1.0.0"));
  });
});

describe("nothing invalid is ever written", () => {
  it("refuses an artifact that fails validation, and writes nothing at all", async () => {
    // §18's recorder rescue: validate before write. The artifact here is the fixture with a step
    // that cannot be replayed, so the failure is one the schema exists to catch.
    const broken = validArtifact();
    broken.steps[0].url = "http://localhost:4173/member/{undeclared}";

    await expect(store.save(broken, { version: "1.0.0" })).rejects.toThrowError(CapabilityInvalidError);
    // Not just "the artifact was not written" — the capability directory was never created, so a
    // failed recording leaves no trace a later `list` would report as a capability.
    expect(existsSync(join(root, ID))).toBe(false);
  });

  it("names the problem in the error, not just that there was one", async () => {
    const broken = validCapability() as unknown as { steps: { expect?: unknown }[] };
    delete broken.steps[1]?.expect;

    await expect(store.save(broken, { version: "1.0.0" })).rejects.toThrowError(
      /steps\.1\.expect — a state assertion must carry exactly one of/,
    );
  });

  it("refuses a version that is not a version", async () => {
    await expect(store.save(validCapability(), { version: "tomorrow" })).rejects.toThrowError(
      /"tomorrow" is not a version/,
    );
  });

  it("validates what it reads back, naming the file", async () => {
    // A half-written or hand-edited artifact has to surface as the exact schema problem, not as a
    // confusing failure several steps into a replay.
    await mkdir(join(root, ID, "v1.0.0"), { recursive: true });
    await writeFile(artifactPath("1.0.0"), JSON.stringify({ id: ID, steps: "nope" }));

    await expect(store.load(ID)).rejects.toThrowError(/artifact\.json is invalid/);
  });

  it("refuses an artifact filed under an id it does not declare", async () => {
    // The id is the artifact's own truth and the directory is a filing decision; if the two
    // disagree the caller asked for something other than what they got.
    await mkdir(join(root, "other-capability", "v1.0.0"), { recursive: true });
    await writeFile(join(root, "other-capability", "v1.0.0", "artifact.json"), JSON.stringify(validCapability()));

    await expect(store.load("other-capability")).rejects.toThrowError(/declares id "member-savings-balance"/);
  });
});

describe("a recorded version is immutable", () => {
  it("refuses to replace a version that exists", async () => {
    await store.save(validCapability(), { version: "1.0.0" });

    await expect(store.save(validCapability(), { version: "1.0.0" })).rejects.toThrowError(
      CapabilityVersionExistsError,
    );
    await expect(store.save(validCapability(), { version: "1.0.0" })).rejects.toThrowError(
      /a recorded version is immutable, so save a new version, or pass `overwrite`/,
    );
  });

  it("replaces it when the caller says so in as many words", async () => {
    await store.save(validCapability(), { version: "1.0.0" });
    const revised = validCapability();
    revised.name = "Member savings balance (revised)";

    await store.save(revised, { version: "1.0.0", overwrite: true });
    expect((await store.load(ID)).name).toBe("Member savings balance (revised)");
  });

  it("keeps an older version loadable after a newer one is recorded", async () => {
    // §14's rollback story: the old artifact keeps replaying untouched.
    await store.save(validCapability(), { version: "1.0.0" });
    const revised = validCapability();
    revised.name = "v2";
    await store.save(revised, { version: "2.0.0" });

    expect((await store.load(ID, "1.0.0")).name).toBe("Member savings balance");
    expect((await store.load(ID, "2.0.0")).name).toBe("v2");
    expect((await store.load(ID)).name).toBe("v2");
  });
});

describe("versions", () => {
  it("orders numerically, not lexically", async () => {
    for (const version of ["1.9.0", "1.10.0", "1.2.0"]) {
      await store.save(validCapability(), { version });
    }
    expect(await store.versions(ID)).toEqual(["1.2.0", "1.9.0", "1.10.0"]);
    expect(await store.latestVersion(ID)).toBe("1.10.0");
  });

  it("treats v1, 1 and 1.0.0 as one version", async () => {
    // §16 writes `v<semver>` and §11's P4 exit names the first directory `v1`; §5.4 writes the
    // flag as `--version <semver>`. Both spellings are accepted and zero-filled on comparison.
    await store.save(validCapability(), { version: "1" });
    expect(await store.load(ID, "v1.0.0")).toEqual(validCapability());
    expect(await store.load(ID, "1.0.0")).toEqual(validCapability());
    await expect(store.save(validCapability(), { version: "v1.0.0" })).rejects.toThrowError(
      CapabilityVersionExistsError,
    );
  });

  it("names the directory v<version>, keeping the spelling it was saved under", async () => {
    const stored = await store.save(validCapability(), { version: "v2.1.0" });
    expect(stored.version).toBe("2.1.0");
    expect(stored.dir).toBe(join(root, ID, "v2.1.0"));
    expect(existsSync(artifactPath("2.1.0"))).toBe(true);
  });

  it("moves latest forward only", async () => {
    // Backfilling an older version — re-recording v1 after v2 exists — is legitimate and must not
    // demote `latest`, or the pointer would follow whatever was written most recently.
    await store.save(validCapability(), { version: "1.0.0" });
    await store.save(validCapability(), { version: "2.0.0" });

    const backfilled = await store.save(validCapability(), { version: "1.5.0" });
    expect(backfilled.latest).toBe(false);
    expect(await store.latestVersion(ID)).toBe("2.0.0");
  });

  it("falls back to the highest version when there is no pointer", async () => {
    // A hand-authored `capabilities/` tree predates the pointer file, and "latest" still has an
    // honest reading there.
    await mkdir(join(root, ID, "v1.0.0"), { recursive: true });
    await writeFile(artifactPath("1.0.0"), JSON.stringify(validCapability()));

    expect(await store.latestVersion(ID)).toBe("1.0.0");
    expect(await store.load(ID)).toEqual(validCapability());
  });
});

describe("failure messages", () => {
  it("lists the capabilities that do exist", async () => {
    await store.save(validCapability(), { version: "1.0.0" });

    await expect(store.load("no-such-capability")).rejects.toThrowError(
      new RegExp(`no capability "no-such-capability" in .* — known: ${ID}`),
    );
    await expect(store.load("no-such-capability")).rejects.toBeInstanceOf(CapabilityNotFoundError);
    await expect(store.load("no-such-capability")).rejects.toMatchObject({ known: [ID] });
  });

  it("says so plainly when nothing is recorded yet", async () => {
    await expect(store.load(ID)).rejects.toThrowError(/nothing is recorded yet/);
  });

  it("lists the versions that do exist", async () => {
    await store.save(validCapability(), { version: "1.0.0" });
    await store.save(validCapability(), { version: "1.1.0" });

    await expect(store.load(ID, "9.9.9")).rejects.toThrowError(
      /no version 9\.9\.9 — available: 1\.0\.0, 1\.1\.0/,
    );
    await expect(store.load(ID, "9.9.9")).rejects.toBeInstanceOf(CapabilityVersionNotFoundError);
  });
});

describe("list", () => {
  it("is empty, not an error, when nothing has been recorded", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.versions(ID)).toEqual([]);
    expect(await store.latestVersion(ID)).toBeNull();
  });

  it("summarises what is in the store", async () => {
    await store.save(validCapability(), { version: "1.0.0" });
    await store.save(validCapability(), { version: "1.1.0" });
    const other = validCapability();
    other.id = "another-capability";
    await store.save(other, { version: "1.0.0" });

    expect(await store.list()).toEqual([
      { id: "another-capability", versions: ["1.0.0"], latest: "1.0.0" },
      { id: ID, versions: ["1.0.0", "1.1.0"], latest: "1.1.0" },
    ]);
  });
});

describe("version arithmetic", () => {
  it("normalises the v prefix and whitespace", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("V2")).toBe("2");
    expect(isVersion(" 1.0.0 ")).toBe(true);
  });

  it("rejects what is not a version", () => {
    for (const value of ["", "latest", "1.0.0.0", "one", "1.x"]) {
      expect(isVersion(value)).toBe(false);
    }
  });

  it("zero-fills missing components", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.1", "1.0.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0-alpha")).toBe(1); // a release outranks its prereleases
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  it("refuses to compare something that is not a version", () => {
    // A comparison that silently returned 0 for garbage would make the `latest` fallback pick a
    // directory at random.
    expect(() => compareVersions("1.0.0", "latest")).toThrowError(/not a version: "latest"/);
  });
});

describe("the default root", () => {
  it("is the repo's capabilities directory, derived from the module and not the cwd", () => {
    // The claim worth checking is the derivation: a relative path would resolve against whatever
    // directory the CLI happened to be run from, which is not where the artifacts live.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(DEFAULT_CAPABILITIES_ROOT).toBe(join(repoRoot, "capabilities"));
  });
});
