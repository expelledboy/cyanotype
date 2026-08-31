/**
 * EnvironmentMetadata — cross-process JSON snapshot.
 *
 * The ONLY thing that crosses worker boundaries. Round-trips JSON cleanly:
 * no closures, no class instances, no SDK handles.
 *
 * Schema version is the migration guard. A future v2 metadata file written
 * by a newer Cyanotype is rejected by the current parser; the runtime can
 * choose to start fresh or surface the version mismatch.
 */

export type EnvironmentMetadata = {
  readonly schemaVersion: 1;
  readonly envKey: string;
  /** ISO 8601 timestamp. */
  readonly savedAt: string;
  /**
   * `Adapter.name` of the substrate that started these containers.
   *
   * Environment-level rather than per-component: `createSharedEnvs` takes one
   * Adapter for the whole environment, and a composite adapter reports itself
   * as a single name.
   *
   * OPTIONAL by design, exactly as `ComponentSnapshot.version` is: metadata
   * written by an older Cyanotype omits it, and an absent value SKIPS the check
   * rather than invalidating a healthy environment. When present and it differs
   * from the current adapter, the container ids in this file belong to a
   * substrate that cannot interpret them. See D-041.
   */
  readonly adapter?: string;
  readonly components: Readonly<Record<string, SlotSnapshot>>;
};

/** Mirrors `Environment[componentName]`: single-instance OR multi-instance. */
export type SlotSnapshot =
  | { readonly kind: "single"; readonly snapshot: ComponentSnapshot }
  | {
      readonly kind: "multi";
      readonly instances: Readonly<Record<string, ComponentSnapshot>>;
    };

export type ComponentSnapshot = {
  readonly containerId: string;
  readonly ports: Readonly<Record<string, number>>;
  /**
   * The `Binding.version` that produced this component, when known.
   *
   * OPTIONAL by design: metadata written by an older Cyanotype omits it.
   * On re-ensure, an absent `version` SKIPS the freshness check — it never
   * false-invalidates a pre-existing environment. When present and it
   * differs from the current `Binding.version`, the attach path treats the
   * stored environment as stale and rebuilds from scratch.
   */
  readonly version?: string;
  /**
   * Whether the orchestrator owns this container's lifecycle. Optional for
   * backward compatibility with metadata written by older Cyanotype: an
   * absent field is read as `true` (fully owned) — the historical default.
   * Emitted by the writer ONLY when `false`, so existing metadata stays
   * byte-stable for owned components.
   */
  readonly owned?: boolean;
};
