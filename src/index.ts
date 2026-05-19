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
export { http, opaque, createHttpClient } from "./protocol.js";
export { iface } from "./interface.js";
export { defineBlueprint } from "./blueprint.js";
export { bind } from "./binding.js";
export { createEnvironment, RESERVED_COMPONENT_NAMES } from "./environment.js";
export { createSharedEnvs } from "./shared.js";
export { createEventBus } from "./events.js";
export { runProbe } from "./probe.js";
export { createHelpers } from "./helpers.js";
export { startEnvironment, attachEnvironment } from "./orchestrator.js";
export { createInMemoryAdapter } from "./adapters/memory.js";
export { createDockerAdapter } from "./adapters/docker.js";
export { createK8sAdapter, K8sAdapterConfigSchema } from "./adapters/kubernetes.js";

// Re-export types so direct `import { type Blueprint } from "speculum"` works
// without going through index.d.ts. The canonical type contract is in
// `./index.d.ts`; this list mirrors it.
export type {
  Protocol, HttpProtocol, OpaqueProtocol,
  HttpMethod, HttpRoute, HttpRouteMap, HttpClient, ApiOf,
} from "./protocol.js";
export type { Interface, InterfaceRecord, ApiFromInterface } from "./interface.js";
export type { HelperContext, HttpHelpers, HttpRequestInit, HttpResponse } from "./helpers.js";
export type { Probe, HttpProbe, CustomProbe } from "./probe.js";
export type {
  EventSchema, EventCatalog, AttributesOf,
  Event, EventBus, EventFilter, LogParser, ParsedEvent,
} from "./events.js";
export type { Blueprint } from "./blueprint.js";
export type {
  Binding, BlueprintOf, ConfigOf, EnvOf, IfaceOf, ApiOfBlueprint, EventsOf,
} from "./binding.js";
export type { Environment, Slot, IsMultiInstance } from "./environment.js";
export type { Adapter, AdapterConfig, StartSpec, Started } from "./adapter.js";
export type { EnvironmentMetadata, SlotSnapshot, ComponentSnapshot } from "./metadata.js";
export type { Runtime, Running, ComponentRuntime, ChaosControls, RuntimeSnapshot } from "./runtime.js";
export type { SharedMode, SharedOptions, SharedHarness } from "./shared.js";
export type { OrchestratorOptions, AttachSnapshot } from "./orchestrator.js";
export type { FakeFactory, FakeHandle, InMemoryAdapterOptions } from "./adapters/memory.js";
export type { K8sAdapterOptions } from "./adapters/kubernetes.js";
export type { KubectlMode } from "./adapters/kubectl.js";
