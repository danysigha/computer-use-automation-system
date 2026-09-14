/**
 * The capability store's public surface (§16's `src/store/` entry).
 *
 * The CLI (P5) imports `CapabilityStore` and the error types it has to turn into exit codes; the
 * recorder (P4) imports `CapabilityStore` alone. Version helpers are exported because the CLI
 * validates a `--version` argument before it has a store to ask.
 */
export {
  CapabilityStore,
  DEFAULT_CAPABILITIES_ROOT,
  LATEST,
  CapabilityNotFoundError,
  CapabilityVersionNotFoundError,
  CapabilityVersionExistsError,
  compareVersions,
  isVersion,
  normalizeVersion,
  type CapabilitySummary,
  type SaveOptions,
  type StoredCapability,
} from "./capability-store.ts";
