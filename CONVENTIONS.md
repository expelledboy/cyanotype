# Conventions

> Read this before writing any code. These are the load-bearing rules; they keep the library small, honest, and reviewable.

## Style

- **No comments by default.** Add a comment only when the *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.
- **Don't explain *what* the code does** — well-named identifiers already do that. Don't reference the current task or call sites ("added for X", "used by Y") — those belong in the commit message and rot.
- **Terse beats clear-but-padded.** A short sentence beats a paragraph. A small function beats a section of a large function. No padding signatures or docstrings.
- **No premature abstraction.** Three similar lines is better than a one-use helper. No factories for a single call site. Inline before extracting.

## TypeScript

- **`any` is forbidden** except in variance-widener positions — where a specific generic must be assignable to a container holding *any* instantiation of it, and TypeScript's variance rules reject the narrower type. When used, add a `biome-ignore` line explaining why. `just lint` enforces this, and also reports suppression comments that no longer suppress anything, so a stale `biome-ignore` fails the build rather than lingering.
- **`strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes` are on.** Respect them. No `// @ts-ignore`, no `as any` shortcuts.
- **Errors are plain tagged objects**, not classes: `throw { kind: "probe_timeout", lastError, elapsedMs }`. Consumers `catch (e)` and check `e.kind`. This round-trips through JSON cleanly and avoids `instanceof` cross-realm pitfalls.
- **`AbortSignal` over flags** for cancellation. `AsyncIterable` over manual iterators where possible.

## Validation

- **Parse at boundaries, trust internally.** Validate inputs where they enter the system (`createEnvironment` checks reserved names; `events.ingest` validates against the catalog; metadata files are checked at load). Inside the orchestrator and runtime, trust the types.
- **Is it an invariant or an error? Ask who broke it.** An agreement between Cyanotype's own modules is an `invariant()` — off for consumers, because they cannot act on it. A mistake a consumer makes in their own code is an **error**, always on, thrown at the boundary where it is still explicable. `createEnvironment` rejecting a Binding that omits one of its Blueprint's declared `portNames` is the second kind: it type-checks (`Binding.ports` is not keyed to `portNames`), and left unchecked it surfaces as `http://host:undefined` and a readiness timeout pointed at the consumer's own service.
- **Consumer-facing errors carry a `hint`.** State what was done, why it is wrong, and the fix — the tagged fields are for programs, the `hint` is for the person reading the failure. Internal errors stay bare: a hint no one can act on is noise. Useful side effect: if you cannot write the hint, the error is probably internal and may want to be an `invariant()` instead.
  - **A hint must never reference this repository's own tooling.** A consumer has no `just` recipes of ours. Say "delete the `<envKey>.json` under your stateDir and stop containers labelled `cyanotype=1`", not "run `just clean-containers`".
  - **Verify the claim before writing it.** `use()` is scoped to the `createSharedEnvs` handle, not the file; `stopAll()` cannot clean containers a previous process started. A confidently wrong hint is worse than none.
  - Enforced by `tests/core/error-classification.test.ts`: every `throw { kind: ... }` in `src/` must be classified consumer-facing or internal, and the hint rules follow from that. A new unclassified error fails the suite. The full decision table is in `AGENTS.md`.

- **No `assert(...)` proliferation.** Runtime asserts add noise that the type system already provides. Use them only where a non-type invariant matters and would be hard to debug otherwise (e.g. an `O_CREAT|O_EXCL` claim succeeded but the file then disappeared — that's a real runtime invariant).
- **That exception has a mechanism: `invariant()` from `src/invariants.ts`.** It is the only way to write one, and it is off unless `tests/preload.ts` turns it on (this repository's own suite) or a consumer sets `CYANOTYPE_INVARIANTS=1` to debug something that looks impossible. Consumers run Cyanotype to test *their* system and should neither pay for nor be interrupted by checks on ours.

  An invariant earns its place when it is an agreement **between two modules that no single signature can state**, and violating it fails somewhere else entirely. The session label one module stamps must equal the one another module sweeps; a Kubernetes Service selector must be a subset of the Pod labels it selects; a container the orchestrator does not own must never reach `adapter.stop`. Each of those, when broken, produced a confusing failure far from the cause.

  Do NOT reach for it when a type, a boundary validator, or a chokepoint already covers the case. `missing_cyanotype_label`, `metadata_corrupt` and the attach-mode denylists are stronger than an invariant and stay as they are — an invariant that duplicates them is exactly the noise D-012 bans.

  Write it as `invariant(() => held, "the rule, stated as a property", () => detail)`. **Both arguments are thunks**, so nothing runs when invariants are off — not the condition, not the diagnostic. This is not style: the first version took `held` as a plain boolean, which JavaScript evaluates at the call site regardless, so consumers ran every condition and one that dereferenced something absent threw `undefined is not an object` — a disabled check crashing a consumer. A violation throws `{ kind: "invariant_violated", invariant, detail }` — a tagged object, never a class. See D-042 for the catalogue and the reasoning.
- **No `new Error(...)` for control-flow errors.** Throw a tagged object. Reserve `new Error` for "this should be impossible" cases.

## File layout

- **File LoC: typical ~200, redesign before 400.** Most files are one concept and should fit in 200 lines. IO-procedural code (the orchestrator, the Docker adapter) is allowed to be larger when splitting would be artificial separation of cohesive logic — but if a file is approaching 400, the design is probably wrong.
- **Whole-project budget: ~2500 LoC of source.** If the project is heading past 3000, a concept is missing — stop and find it before adding more.
- **Runtime values live in the same file as their types** when natural (e.g. `EventBus<Cat>` type and `createEventBus()` value both in `src/events.ts`).
- **`src/index.ts` is the public surface** — it re-exports both values and types. The matching `.d.ts` is emitted by `tsc` at build time; there is no hand-written `index.d.ts`. Add an export only when something is truly user-facing.

## Tests

- All implementation modules have a test file at `tests/core/<module>.test.ts`.
- Use `bun:test`: `import { describe, test, expect, beforeAll } from "bun:test"`.
- Test names: `describe("<module>/<concern>")`, `test("<expected behavior>")`.
- See `tests/core/_template.test.ts` for the canonical shape.
- **Tests should not have any `assert` either** — `expect(...)` is the only assertion mechanism.

## KISS

The temptation in a harness like this is to over-engineer: event stores, idempotency machines, abstraction layers "for flexibility." Resist.

- The simplest thing that satisfies the type contract and the tests *is* the right thing.
- If you find yourself writing a helper "in case we need it later," delete it.
- If you find yourself adding a layer of indirection "for flexibility," delete it.

## What to do when stuck

- **If the spec is ambiguous, STOP and report.** Don't invent semantics. Don't choose between two reasonable interpretations — surface the choice.
- **If a test would require more than a trivial fake to write, STOP and report.** That's a design smell.
- **If LoC is heading past 400 for a single module, STOP and report.** Either the module is eating a neighbour's job or the design is wrong.
