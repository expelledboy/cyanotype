/**
 * Runtime invariants — cross-module agreements the type system cannot express.
 *
 * D-012 bans *defensive* asserts that duplicate what types already guarantee.
 * This is the other half of the rule `CONVENTIONS.md` already carves out: "a
 * non-type invariant that would be hard to debug otherwise". The archetype it
 * names — an `O_CREAT|O_EXCL` claim succeeded but the file then disappeared —
 * is checked here rather than left as prose.
 *
 * WHAT BELONGS HERE. An agreement between two modules that no single signature
 * can state: the session label one module stamps must equal the one another
 * module sweeps; a Service selector must be a subset of the Pod labels it
 * selects; a container the orchestrator does not own must never reach
 * `adapter.stop`. Violating one of these does not throw at the violation — it
 * produces a confusing failure somewhere else entirely, which is precisely what
 * makes it worth a check.
 *
 * WHAT DOES NOT. Anything a type, a boundary validator, or a chokepoint already
 * covers. `missing_cyanotype_label`, `metadata_corrupt` and the attach-mode
 * denylists are stronger than an invariant and stay where they are.
 *
 * OFF BY DEFAULT. Consumers run Cyanotype to test *their* system; they should
 * not pay for — or be interrupted by — checks on ours. Enabled by
 * `tests/preload.ts` for this repository's own suite, and by
 * `CYANOTYPE_INVARIANTS=1` for anyone debugging behaviour that looks
 * impossible. When disabled the cost is one boolean read and a call; the
 * `detail` thunk exists so building a diagnostic never happens either.
 *
 * Named `invariant`, not `assert`: `CONVENTIONS.md` bans the latter outright,
 * in source and in tests.
 */

let enabled = process.env.CYANOTYPE_INVARIANTS === "1";

/** Turn invariants on for this process. Called by `tests/preload.ts`. */
export const enableInvariants = (): void => { enabled = true; };

/** Turn them off again. Exists so the invariants' own tests can restore state. */
export const disableInvariants = (): void => { enabled = false; };

export const invariantsEnabled = (): boolean => enabled;

/**
 * Throw `{ kind: "invariant_violated" }` when `held` is false and invariants
 * are on. `name` identifies the agreement; `detail` is a thunk so the cost of
 * describing a violation is paid only when there is one.
 */
export const invariant = (
  held: boolean,
  name: string,
  detail?: () => unknown,
): void => {
  if (enabled === false || held === true) return;
  throw {
    kind: "invariant_violated",
    invariant: name,
    ...(detail !== undefined ? { detail: detail() } : {}),
  };
};
