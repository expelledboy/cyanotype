/**
 * Speculum — public runtime entry.
 *
 * Three identity factories drive the user-facing API:
 *   - `defineBlueprint(spec)` — declare a Component Blueprint (the contract).
 *   - `bind(blueprint, spec)` — bind a Blueprint to a substrate (image, env, ports).
 *   - `createEnvironment(record)` — compose Bindings, validate reserved names.
 *
 * Plus protocol constructors (`http`, `opaque`), the interface constructor
 * (`iface`), and the shared-envs harness (`createSharedEnvs`).
 */

// Runtime values
export { http, opaque, createHttpClient } from "./protocol";
export { iface } from "./interface";
export { defineBlueprint } from "./blueprint";
export { bind } from "./binding";
export { createEnvironment, RESERVED_COMPONENT_NAMES } from "./environment";
export { createSharedEnvs } from "./shared";
export { createEventBus } from "./events";
export { runProbe } from "./probe";
export { createHelpers } from "./helpers";
export { createInMemoryAdapter } from "./adapters/memory";
export { createDockerAdapter } from "./adapters/docker";
export { createK8sAdapter, K8sAdapterConfigSchema } from "./adapters/kubernetes";

// Re-export types so direct `import { type Blueprint } from "speculum"` works
// without going through index.d.ts. The canonical type contract is in
// `./index.d.ts`; this list mirrors it.
export type {
  Protocol, HttpProtocol, OpaqueProtocol,
  HttpMethod, HttpRoute, HttpRouteMap, HttpClient, ApiOf,
} from "./protocol";
export type { Interface, InterfaceRecord, ApiFromInterface } from "./interface";
export type { HelperContext, HttpHelpers, HttpRequestInit, HttpResponse } from "./helpers";
export type { Probe, HttpProbe, CustomProbe } from "./probe";
export type {
  EventSchema, EventCatalog, AttributesOf,
  Event, EventBus, EventFilter, LogParser, ParsedEvent,
} from "./events";
export type { Blueprint } from "./blueprint";
export type {
  Binding, BlueprintOf, ConfigOf, EnvOf, IfaceOf, ApiOfBlueprint, EventsOf,
} from "./binding";
export type { Environment, Slot, IsMultiInstance } from "./environment";
export type { Adapter, AdapterConfig, StartSpec, Started } from "./adapter";
export type { EnvironmentMetadata, SlotSnapshot, ComponentSnapshot } from "./metadata";
export type { Runtime, Running, ComponentRuntime, ChaosControls, RuntimeSnapshot } from "./runtime";
export type { SharedMode, SharedOptions, SharedHarness } from "./shared";
export type { FakeFactory, FakeHandle, InMemoryAdapterOptions } from "./adapters/memory";
