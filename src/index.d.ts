/**
 * Speculum — public type contract.
 *
 * Type-only re-exports. The runtime entry (factories, helpers) lives in
 * `index.ts`. Adding a new public type goes here; adding a new public
 * runtime value goes there. The two surfaces evolve independently.
 */

// --- Protocol & HTTP ---
export type {
  Protocol,
  HttpProtocol,
  OpaqueProtocol,
  HttpMethod,
  HttpRoute,
  HttpRouteMap,
  HttpClient,
  ApiOf,
} from "./protocol";

// --- Interfaces ---
export type {
  Interface,
  InterfaceRecord,
  ApiFromInterface,
} from "./interface";

// --- Helpers (passed to custom api factories) ---
export type {
  HelperContext,
  HttpHelpers,
  HttpRequestInit,
  HttpResponse,
} from "./helpers";

// --- Probes ---
export type { Probe, HttpProbe, CustomProbe } from "./probe";

// --- Events ---
export type {
  EventSchema,
  EventCatalog,
  AttributesOf,
  Event,
  EventBus,
  EventFilter,
  LogParser,
  ParsedEvent,
} from "./events";

// --- Blueprint (the typed contract) ---
export type { Blueprint } from "./blueprint";

// --- Binding (the substrate-bound instantiation) ---
export type {
  Binding,
  BlueprintOf,
  ConfigOf,
  EnvOf,
  IfaceOf,
  ApiOfBlueprint,
  EventsOf,
} from "./binding";

// --- Environment ---
export type { Environment, Slot, IsMultiInstance } from "./environment";

// --- Adapter ---
export type { Adapter, StartSpec, Started } from "./adapter";

// --- Metadata ---
export type {
  EnvironmentMetadata,
  SlotSnapshot,
  ComponentSnapshot,
} from "./metadata";

// --- Runtime ---
export type {
  Runtime,
  Running,
  ComponentRuntime,
  ChaosControls,
  RuntimeSnapshot,
} from "./runtime";

// --- Shared ---
export type {
  SharedMode,
  SharedOptions,
  SharedHarness,
} from "./shared";

// --- In-memory adapter ---
export type {
  FakeFactory,
  FakeHandle,
  InMemoryAdapterOptions,
} from "./adapters/memory";

// --- Kubernetes adapter ---
export type { K8sAdapterOptions } from "./adapters/kubernetes";
export type { KubectlMode } from "./adapters/kubectl";
