/**
 * EnvironmentMetadata — cross-process JSON snapshot.
 *
 * The ONLY thing that crosses worker boundaries. Round-trips JSON cleanly:
 * no closures, no class instances, no SDK handles.
 *
 * Schema version is the migration guard. A future v2 metadata file written
 * by a newer Speculum is rejected by the current parser; the runtime can
 * choose to start fresh or surface the version mismatch.
 */

export type EnvironmentMetadata = {
  readonly schemaVersion: 1;
  readonly envKey: string;
  /** ISO 8601 timestamp. */
  readonly savedAt: string;
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
};
