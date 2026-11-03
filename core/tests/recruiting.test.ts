import { describe, expect, test } from 'bun:test'
import {
  clockOf,
  daysOpen,
  errorCode,
  funnel,
  furthest,
  hiresByMonth,
  initials,
  lastMonths,
  median,
  nextStage,
  offerAcceptance,
  scorecards,
  sourceStats,
  stageCounts,
  statementFor,
  timeInStage,
  timeToHire,
  validate,
  type Application,
  type Candidate,
  type Job,
  type RecruitingData,
  type Source,
  type Stage,
  type StageEvent,
} from '../src/recruiting'

const DAY = 86_400_000
const at = (day: number) => new Date(Date.UTC(2026, 9, 1) + day * DAY).toISOString()
const job = (id: string, headcount = 1, status: Job['status'] = 'open'): Job => ({
  id, created_at: at(0), title: id, title_en: '', department: 'Eng', location: 'Remote', employment: 'full_time', status, headcount, opened_on: '2026-10-01',
})
const candidate = (id: string, source: Source): Candidate => ({ id, created_at: at(0), name: id, email: `${id}@example.invalid`, phone: '', source, current_title: '', notes: '' })
/** An application and its history from a list of [stage, day] steps, the way the trigger writes it. */
function walk(id: string, jobId: string, candidateId: string, steps: [Stage, number][]) {
  const application: Application = {
    id, created_at: at(steps[0][1]), job_id: jobId, candidate_id: candidateId, stage: steps[steps.length - 1][0],
    rating: null, rejected_reason: steps[steps.length - 1][0] === 'rejected' ? 'skills' : null,
    applied_on: at(steps[0][1]).slice(0, 10), stage_changed_at: at(steps[steps.length - 1][1]),
  }
  const events: StageEvent[] = steps.map(([stage, day], i) => ({
    id: `${id}-${i}`, created_at: at(day), application_id: id, from_stage: i ? steps[i - 1][0] : null, to_stage: stage, at: at(day),
  }))
  return { application, events }
}
// Four people for one job: a hire, an offer declined, a rejection at screening, one still in interview.
const walks = [
  walk('a1', 'j1', 'ref', [['applied', 0], ['screening', 2], ['interview', 6], ['offer', 16], ['hired', 20]]),
  walk('a2', 'j1', 'web', [['applied', 1], ['screening', 3], ['interview', 9], ['offer', 15], ['rejected', 18]]),
  walk('a3', 'j1', 'lin', [['applied', 2], ['screening', 6], ['rejected', 10]]),
  walk('a4', 'j1', 'lin2', [['applied', 3], ['screening', 5], ['interview', 9]]),
  walk('b1', 'j2', 'web', [['applied', 4]]),
]
const data: RecruitingData = {
  readOnly: false,
  jobs: [job('j1', 2), job('j2')],
  candidates: [candidate('ref', 'referral'), candidate('web', 'website'), candidate('lin', 'linkedin'), candidate('lin2', 'linkedin')],
  applications: walks.map((w) => w.application),
  interviews: [],
  // Out of order on purpose: readers must sort the history themselves.
  stage_events: walks.flatMap((w) => w.events).reverse(),
}

describe('recruiting analytics', () => {
  test('funnel counts how far each application got, not where it stopped', () => {
    expect(funnel(data, 'j1').map((s) => [s.stage, s.reached])).toEqual([
      ['applied', 4], ['screening', 4], ['interview', 3], ['offer', 2], ['hired', 1],
    ])
    const steps = funnel(data, 'j1')
    expect(steps[0].conversion).toBeNull()
    expect(steps[2].conversion).toBe(0.75)
    expect(steps[4].conversion).toBe(0.5)
    expect(funnel(data)[0].reached).toBe(5)
    expect(furthest({ stage: 'rejected' }, [{ to_stage: 'applied' }, { to_stage: 'offer' }, { to_stage: 'rejected' }])).toBe(3)
  })

  test('time in stage takes medians of finished stints only', () => {
    const byStage = Object.fromEntries(timeInStage(data, 'j1').map((s) => [s.stage, [s.median, s.count]]))
    // applied: 2, 2, 4, 2 days → median 2. screening: 4, 6, 4, 4 → 4. interview: 10, 6 (a4 is still there) → 8.
    expect(byStage).toEqual({ applied: [2, 4], screening: [4, 4], interview: [8, 2], offer: [3.5, 2] })
    expect(timeInStage(data, 'j2')[0]).toEqual({ stage: 'applied', median: null, count: 0 })
  })

  test('time to hire, offer acceptance and source effectiveness', () => {
    expect(timeToHire(data)).toEqual([20])
    expect(offerAcceptance(data)).toBe(0.5)
    expect(offerAcceptance(data, 'j2')).toBeNull()
    const rows = Object.fromEntries(sourceStats(data).map((r) => [r.source, r]))
    expect(rows.referral).toMatchObject({ candidates: 1, applications: 1, interviewed: 1, hired: 1, hireRate: 1 })
    // Two people from LinkedIn: one stopped at screening, one is interviewing.
    expect(rows.linkedin).toMatchObject({ candidates: 2, applications: 2, interviewed: 1, hired: 0, hireRate: 0 })
    // One website candidate applied twice: counted once as a person, twice as applications.
    expect(rows.website).toMatchObject({ candidates: 1, applications: 2, interviewed: 1, hired: 0 })
    expect(rows.agency).toMatchObject({ candidates: 0, applications: 0, hireRate: null })
    expect(sourceStats(data)[0].source).toBe('referral')
  })

  test('hires land in the month the database recorded them', () => {
    expect(lastMonths('2026-11', 3)).toEqual(['2026-09', '2026-10', '2026-11'])
    expect(hiresByMonth(data, lastMonths('2026-11', 3))).toEqual([
      { month: '2026-09', hires: 0 }, { month: '2026-10', hires: 1 }, { month: '2026-11', hires: 0 },
    ])
  })

  test('stage counts, scorecards, medians and days open', () => {
    expect(stageCounts(data.applications.filter((a) => a.job_id === 'j1'))).toEqual({ applied: 0, screening: 0, interview: 1, offer: 0, hired: 1, rejected: 2 })
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    const cards = scorecards([
      { score: 4, recommendation: 'strong_yes' }, { score: 2, recommendation: 'no' }, { score: null, recommendation: null },
    ])
    expect(cards).toMatchObject({ total: 3, scored: 2, average: 3 })
    expect(cards.votes).toEqual({ strong_no: 0, no: 1, yes: 0, strong_yes: 1 })
    const now = new Date(Date.UTC(2026, 10, 1, 12))
    expect(daysOpen(job('j1'), data, now)).toBe(31)
    // A closed job stops counting at its last hire.
    expect(daysOpen({ ...job('j1'), status: 'closed' }, data, now)).toBe(20)
    expect(daysOpen({ ...job('j3'), opened_on: null, status: 'draft' }, data, now)).toBeNull()
    expect(nextStage('offer')).toBe('hired')
    expect(nextStage('hired')).toBeNull()
    expect(nextStage('rejected')).toBeNull()
  })

  test('the demo reads time as of its seeding; a copy uses the clock', () => {
    const now = new Date('2026-12-01T00:00:00Z')
    expect(clockOf({ ...data, readOnly: true, jobs: [job('a'), { ...job('b'), created_at: at(9) }] }, now).toISOString()).toBe(at(9))
    expect(clockOf(data, now)).toBe(now)
  })

  test('initials show a Chinese surname or two Latin letters', () => {
    expect(initials('王思远')).toBe('王')
    expect(initials('Emily Carter')).toBe('EC')
    expect(initials('  priya  ')).toBe('P')
    expect(initials('')).toBe('?')
  })
})

describe('recruiting statements', () => {
  test('every write is one statement against one table, with parameters', () => {
    const actions = [
      statementFor({ action: 'create-job', id: 'j', status: 'open', title: ' QA ', title_en: '', department: 'Eng', location: 'SZ', employment: 'intern', headcount: 2 }),
      statementFor({ action: 'move', id: 'a', from: 'offer', to: 'rejected', reason: ' compensation ' }),
      statementFor({ action: 'move', id: 'a', from: 'rejected', to: 'screening', reason: 'ignored' }),
      statementFor({ action: 'reject-remaining', jobId: 'j', reason: 'filled' }),
      statementFor({ action: 'cancel-interview', id: 'i' }),
    ]
    for (const s of actions) {
      expect(s.sql).toMatch(/^(INSERT INTO|UPDATE|DELETE FROM) [a-z_]+ /)
      expect(s.sql).not.toContain(';')
    }
    expect(actions[0].params).toEqual(['j', 'QA', '', 'Eng', 'SZ', 'intern', 2, 'open'])
    expect(actions[1]).toMatchObject({ params: ['a', 'rejected', 'compensation', 'offer'], one: true })
    expect(actions[2].params[2]).toBeNull()
    expect(actions[3].one).toBeUndefined()
  })

  test('validation mirrors the database rules', () => {
    const job = { action: 'create-job', id: 'j', status: 'open', title: 'QA', title_en: '', department: 'Eng', location: 'SZ', employment: 'full_time', headcount: 1 } as const
    expect(() => validate(job)).not.toThrow()
    expect(() => validate({ ...job, headcount: 0 })).toThrow('invalid_headcount')
    expect(() => validate({ ...job, headcount: 1.5 })).toThrow('invalid_headcount')
    expect(() => validate({ ...job, title: '  ' })).toThrow('invalid_input')
    const person = { action: 'add-candidate', id: 'c', name: 'A', email: 'a@example.invalid', phone: '', source: 'referral', current_title: '', notes: '' } as const
    expect(() => validate(person)).not.toThrow()
    expect(() => validate({ ...person, email: 'nope' })).toThrow('invalid_email')
    expect(() => validate({ action: 'move', id: 'a', from: 'offer', to: 'rejected' })).toThrow('reason_required')
    expect(() => validate({ action: 'move', id: 'a', from: 'offer', to: 'offer' })).toThrow('invalid_input')
    expect(() => validate({ action: 'apply', id: 'a', jobId: 'j', candidateId: 'c', appliedOn: '2026-02-30' })).toThrow('invalid_date')
    expect(() => validate({ action: 'rate', id: 'a', rating: 6 })).toThrow('invalid_input')
    expect(() => validate({ action: 'rate', id: 'a', rating: null })).not.toThrow()
    expect(() => validate({ action: 'record-scorecard', id: 'i', score: 5, recommendation: 'yes', feedback: '' })).toThrow('invalid_input')
  })

  test('database errors become codes the labels know', () => {
    expect(errorCode('headcount_filled')).toBe('headcount_filled')
    expect(errorCode('duplicate key value violates unique constraint "applications_once"')).toBe('already_applied')
    expect(errorCode('duplicate key value violates unique constraint "candidates_email"')).toBe('duplicate_email')
    expect(errorCode('duplicate key value violates unique constraint "jobs_pkey"')).toBe('duplicate_id')
    expect(errorCode('new row for relation "jobs" violates check constraint "jobs_headcount_check"')).toBe('invalid_input')
    expect(errorCode('permission denied for table jobs')).toBe('read_only')
    expect(errorCode('socket hang up')).toBe('generic_error')
  })
})
