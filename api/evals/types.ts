import type { Change } from '@lovbase/core/diff'
import type { IR } from '@lovbase/core/ir'

// ── What an eval case is ──
// The pipeline under test is: (current IR, one sentence) → LLM → validated IR → diffIR.
// The last step is deterministic, which is the whole reason this harness can assert exactly
// instead of asking another model to judge. Every assertion below is on the diff, not on prose.

export type Category =
  | 'add'                 // the baseline: new tables and columns
  | 'rename'              // must come out as RENAME, never drop + create — the product's core claim
  | 'type-change'         // must be recognised as destructive
  | 'modeling-judgment'   // select vs text, link vs text: does the model model, or just transcribe?
  | 'preserve'            // changing one thing must not disturb anything else
  | 'ambiguous'           // vague input must not be answered with invented structure
  | 'adversarial'         // injection, forced drops, system column names

/** A deep-partial match against one `Change`. `kind` is required; everything else is optional. */
export type Matcher = { kind: Change['kind'] } & Record<string, unknown>

export type Expect = {
  /** Changes that must appear. Order does not matter. */
  changes?: Matcher[]
  /**
   * Reject any change not covered by `changes`. Defaults to true — a model that also renames
   * three unrelated columns has not passed, however good its main answer was.
   */
  exact?: boolean
  /** Defaults to true unless one of `changes` is itself destructive. */
  noDestructive?: boolean
  /** Every entity/field id in `given` must survive. Defaults to true unless a drop is expected. */
  preservesIds?: boolean
  /** Anything the matchers cannot express. Return a reason to fail, or null to pass. */
  check?: (ir: IR, changes: Change[]) => string | null
}

export type Case = {
  name: string
  category: Category
  /** The workspace as it stands before the request. */
  given: IR
  /** What the user types, in whatever language they write in; the fixtures use English. */
  when: string
  expect: Expect
  /** Set when a case is known to be hard; it still runs, but the report separates it out. */
  stretch?: boolean
}

export type ModelSpec = { label: string; baseURL: string; apiKey: string; model: string }

export type CaseResult = {
  case: Case
  model: string
  ok: boolean
  /** How many LLM round trips the pipeline needed. 1 = right first time. */
  attempts: number
  /** True when attempt 1 was accepted — the number that says whether a model is comfortable here. */
  firstAttemptOk: boolean
  failures: string[]
  durationMs: number
  /** Set when the pipeline threw instead of producing an IR (3 invalid attempts, network, …). */
  error?: string
}
