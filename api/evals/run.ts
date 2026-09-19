import { writeFileSync } from 'node:fs'
import { diffIR } from '@lovbase/core/diff'
import { GenerateService, type AttemptOutcome } from '../src/modules/modeling/generate.service'
import { chatCompletion, type LlmConfig, type LlmService } from '../src/modules/llm/llm.service'
import { allCases } from './cases'
import { evaluate } from './match'
import type { Case, CaseResult, ModelSpec } from './types'

// ── Eval harness for the modelling pipeline ──
//
//   (current IR, one sentence) → LLM → validateIR → diffIR → assertions on the diff
//
// The last step is deterministic, so every assertion is exact: no LLM-as-judge, no rubric, no
// drift. That is a property of this problem, not a general one, and it is the reason these
// numbers mean something. Run it with `bun run eval`.

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const filter = flag('case')
const category = flag('category')
const jsonOut = flag('json')
const concurrency = Number(flag('concurrency') ?? 4)

/** Models to compare. `EVAL_MODELS` takes a JSON array; otherwise the single configured model is used. */
function models(): ModelSpec[] {
  const raw = process.env.EVAL_MODELS
  if (raw) return JSON.parse(raw) as ModelSpec[]
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, ANTHROPIC_API_KEY } = process.env
  if (LLM_BASE_URL && LLM_MODEL)
    return [{ label: LLM_MODEL, baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY ?? 'none', model: LLM_MODEL }]
  if (ANTHROPIC_API_KEY)
    return [{
      label: LLM_MODEL ?? 'claude-sonnet-5', baseURL: 'https://api.anthropic.com/v1/',
      apiKey: ANTHROPIC_API_KEY, model: LLM_MODEL ?? 'claude-sonnet-5',
    }]
  return []
}

/** GenerateService only ever calls `llm.chat`, so the evals skip the DI container and the database. */
const generate = new GenerateService({ chat: chatCompletion } as unknown as LlmService)

async function runCase(c: Case, spec: ModelSpec): Promise<CaseResult> {
  const cfg: LlmConfig = { baseURL: spec.baseURL, apiKey: spec.apiKey, model: spec.model, source: 'platform' }
  const outcomes: AttemptOutcome[] = []
  const started = Date.now()
  try {
    const produced = await generate.toIR(cfg, c.given, c.when, {
      onAttempt: (_n, outcome) => outcomes.push(outcome),
    })
    const changes = diffIR(c.given, produced)
    const failures = evaluate(c.given, produced, changes, c.expect)
    return {
      case: c, model: spec.label, ok: failures.length === 0,
      attempts: outcomes.length, firstAttemptOk: outcomes[0] === 'ok',
      failures, durationMs: Date.now() - started,
    }
  } catch (err) {
    return {
      case: c, model: spec.label, ok: false,
      attempts: outcomes.length || 3, firstAttemptOk: false,
      failures: [], durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Bounded parallelism — enough to keep the run short, not enough to get rate limited. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

const pct = (n: number, d: number) => (d === 0 ? '  — ' : `${Math.round((n / d) * 100).toString().padStart(3)}%`)

function report(results: CaseResult[], specs: ModelSpec[]) {
  console.log('\n── by model ' + '─'.repeat(58))
  console.log('model'.padEnd(26) + 'pass'.padStart(7) + 'first try'.padStart(12) + 'avg tries'.padStart(12) + 'avg ms'.padStart(9))
  for (const s of specs) {
    const r = results.filter((x) => x.model === s.label)
    const passed = r.filter((x) => x.ok).length
    const first = r.filter((x) => x.firstAttemptOk).length
    const tries = r.reduce((a, x) => a + x.attempts, 0) / (r.length || 1)
    const ms = r.reduce((a, x) => a + x.durationMs, 0) / (r.length || 1)
    console.log(
      s.label.slice(0, 25).padEnd(26) +
      `${pct(passed, r.length)}`.padStart(7) +
      `${pct(first, r.length)}`.padStart(12) +
      tries.toFixed(2).padStart(12) +
      Math.round(ms).toString().padStart(9),
    )
  }

  const cats = [...new Set(results.map((x) => x.case.category))]
  console.log('\n── by category ' + '─'.repeat(55))
  console.log('category'.padEnd(22) + specs.map((s) => s.label.slice(0, 14).padStart(16)).join(''))
  for (const cat of cats) {
    const row = specs.map((s) => {
      const r = results.filter((x) => x.model === s.label && x.case.category === cat)
      return `${r.filter((x) => x.ok).length}/${r.length}`.padStart(16)
    })
    console.log(cat.padEnd(22) + row.join(''))
  }

  const failed = results.filter((x) => !x.ok)
  if (failed.length) {
    console.log('\n── failures ' + '─'.repeat(58))
    for (const f of failed) {
      const tag = f.case.stretch ? ' (stretch)' : ''
      console.log(`\n  ${f.case.category}/${f.case.name}${tag}  [${f.model}]`)
      console.log(`    “${f.case.when}”`)
      if (f.error) console.log(`    pipeline error: ${f.error}`)
      for (const reason of f.failures) console.log(`    ✗ ${reason}`)
    }
  }

  // Retries exist to rescue invalid output; this is how much they actually earn.
  const total = results.length
  const passed = results.filter((x) => x.ok).length
  const firstTry = results.filter((x) => x.firstAttemptOk).length
  console.log('\n' + '─'.repeat(70))
  console.log(`${passed}/${total} passed (${pct(passed, total).trim()}).  ` +
    `First attempt accepted ${pct(firstTry, total).trim()}; validation feedback rescued ${results.filter((x) => !x.firstAttemptOk && x.attempts > 1 && !x.error).length}.`)
}

async function main() {
  const specs = models()
  if (specs.length === 0) {
    console.error('No model configured. Set LLM_BASE_URL + LLM_MODEL (+ LLM_API_KEY), ANTHROPIC_API_KEY,')
    console.error('or EVAL_MODELS=\'[{"label":"gpt-5.2","baseURL":"…","apiKey":"…","model":"gpt-5.2"}]\' to compare several.')
    process.exit(2)
  }

  let cases = allCases
  if (filter) cases = cases.filter((c) => c.name.includes(filter))
  if (category) cases = cases.filter((c) => c.category === category)
  if (cases.length === 0) {
    console.error('No cases matched.')
    process.exit(2)
  }

  const jobs = specs.flatMap((s) => cases.map((c) => ({ c, s })))
  console.log(`${cases.length} cases × ${specs.length} model(s) = ${jobs.length} runs, ${concurrency} at a time\n`)

  let done = 0
  const results = await pool(jobs, concurrency, async ({ c, s }) => {
    const r = await runCase(c, s)
    done++
    const mark = r.ok ? '✓' : '✗'
    process.stdout.write(`${mark} [${String(done).padStart(3)}/${jobs.length}] ${s.label} · ${c.name}\n`)
    return r
  })

  report(results, specs)
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(
      results.map((r) => ({
        case: { name: r.case.name, category: r.case.category, when: r.case.when },
        model: r.model, ok: r.ok, attempts: r.attempts, firstAttemptOk: r.firstAttemptOk,
        failures: r.failures, durationMs: r.durationMs, error: r.error,
      })), null, 2))
    console.log(`\nreport → ${jsonOut}`)
  }
}

await main()
