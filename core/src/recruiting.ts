export type Locale = 'zh' | 'en'
export type Stage = 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
export type Employment = 'full_time' | 'part_time' | 'contract' | 'intern'
export type JobStatus = 'draft' | 'open' | 'paused' | 'closed'
export type Source = 'referral' | 'linkedin' | 'website' | 'agency' | 'other'
export type InterviewKind = 'phone' | 'technical' | 'onsite' | 'culture'
export type Recommendation = 'strong_no' | 'no' | 'yes' | 'strong_yes'

/** The path an application walks. `rejected` sits beside it and can be reached from any step. */
export const pipeline = ['applied', 'screening', 'interview', 'offer', 'hired'] as const
export const stages: Stage[] = [...pipeline, 'rejected']
export const employments: Employment[] = ['full_time', 'part_time', 'contract', 'intern']
export const jobStatuses: JobStatus[] = ['draft', 'open', 'paused', 'closed']
export const sources: Source[] = ['referral', 'linkedin', 'website', 'agency', 'other']
export const interviewKinds: InterviewKind[] = ['phone', 'technical', 'onsite', 'culture']
export const recommendations: Recommendation[] = ['strong_no', 'no', 'yes', 'strong_yes']
/** Stored as these codes so both languages can show them; anything else is the recruiter's own words. */
export const rejectionReasons = ['experience', 'skills', 'compensation', 'location', 'withdrew', 'filled'] as const
export const recruitingTables = ['jobs', 'candidates', 'applications', 'interviews', 'stage_events'] as const
export const MAX_HEADCOUNT = 500
const DAY = 86_400_000

type RecordBase = { id: string; created_at: string }
export type Job = RecordBase & {
  title: string
  title_en: string
  department: string
  location: string
  employment: Employment
  status: JobStatus
  headcount: number
  /** Set by the database the first time the job leaves draft. */
  opened_on: string | null
}
export type Candidate = RecordBase & {
  name: string
  email: string
  phone: string
  source: Source
  current_title: string
  notes: string
}
export type Application = RecordBase & {
  job_id: string
  candidate_id: string
  stage: Stage
  rating: number | null
  rejected_reason: string | null
  applied_on: string
  /** Stamped by the database on every stage change. */
  stage_changed_at: string
}
export type Interview = RecordBase & {
  application_id: string
  kind: InterviewKind
  scheduled_at: string
  interviewer: string
  score: number | null
  recommendation: Recommendation | null
  feedback: string
}
/** Written only by the database, one row per stage change, so the history cannot be edited. */
export type StageEvent = RecordBase & {
  application_id: string
  from_stage: Stage | null
  to_stage: Stage
  at: string
}
export type RecruitingData = {
  readOnly: boolean
  jobs: Job[]
  candidates: Candidate[]
  applications: Application[]
  interviews: Interview[]
  stage_events: StageEvent[]
}

export type JobInput = {
  title: string
  title_en: string
  department: string
  location: string
  employment: Employment
  headcount: number
}
export type CandidateInput = {
  name: string
  email: string
  phone: string
  source: Source
  current_title: string
  notes: string
}
/**
 * Everything the app writes. Each action is exactly one SQL statement against one table; the
 * database triggers do the rest (stage history, headcount, closing a filled job). New rows carry
 * an id made by the client, so a retry after a lost response cannot add the same thing twice.
 */
export type RecruitingAction =
  | ({ action: 'create-job'; id: string; status: 'draft' | 'open' } & JobInput)
  | ({ action: 'update-job'; id: string } & JobInput)
  | { action: 'set-job-status'; id: string; status: JobStatus }
  | ({ action: 'add-candidate'; id: string } & CandidateInput)
  | ({ action: 'update-candidate'; id: string } & CandidateInput)
  | { action: 'delete-candidate'; id: string }
  | { action: 'apply'; id: string; jobId: string; candidateId: string; appliedOn: string }
  /** `from` is the stage the person saw, so a move made on a stale board fails instead of jumping. */
  | { action: 'move'; id: string; from: Stage; to: Stage; reason?: string }
  | { action: 'reject-remaining'; jobId: string; reason: string }
  | { action: 'rate'; id: string; rating: number | null }
  | { action: 'schedule-interview'; id: string; applicationId: string; kind: InterviewKind; scheduledAt: string; interviewer: string }
  | { action: 'record-scorecard'; id: string; score: number; recommendation: Recommendation; feedback: string }
  | { action: 'cancel-interview'; id: string }
/** The shape of DataTemplateClient (core/src/template-data.ts), spelled out so a copy needs only this file. */
export type RecruitingClient = {
  read(): Promise<RecruitingData>
  run(action: RecruitingAction): Promise<void>
}

// ── SQL ────────────────────────────────────────────────────────────────────────────────────────
// The copy's client and the integration tests run exactly these statements. Names are unqualified:
// the SQL API sets search_path to the project's schema.

/**
 * One read per table, shaped the way the gallery preview hands rows to the app: numeric columns
 * cast so they arrive as numbers, timestamps left to the driver, which serializes them as ISO.
 */
export const readStatements: Record<(typeof recruitingTables)[number], string> = {
  jobs: `SELECT id, created_at, title, title_en, department, location, employment, status, headcount::int AS headcount, opened_on FROM jobs ORDER BY created_at, id`,
  candidates: `SELECT id, created_at, name, email, phone, source, current_title, notes FROM candidates ORDER BY created_at, id`,
  applications: `SELECT id, created_at, job_id, candidate_id, stage, rating::int AS rating, rejected_reason, applied_on, stage_changed_at FROM applications ORDER BY created_at, id`,
  interviews: `SELECT id, created_at, application_id, kind, scheduled_at, interviewer, score::int AS score, recommendation, feedback FROM interviews ORDER BY created_at, id`,
  stage_events: `SELECT id, created_at, application_id, from_stage, to_stage, at FROM stage_events ORDER BY created_at, id`,
}

/** `one`: the statement returns the row it touched, and touching none means the record moved on. */
export type Statement = { sql: string; params: unknown[]; one?: boolean }

const job = (a: JobInput) => [a.title.trim(), a.title_en.trim(), a.department.trim(), a.location.trim(), a.employment, a.headcount]
const person = (a: CandidateInput) => [a.name.trim(), a.email.trim(), a.phone.trim(), a.source, a.current_title.trim(), a.notes.trim()]
export function statementFor(action: RecruitingAction): Statement {
  switch (action.action) {
    case 'create-job':
      return {
        sql: `INSERT INTO jobs (id, title, title_en, department, location, employment, headcount, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        params: [action.id, ...job(action), action.status],
      }
    case 'update-job':
      return {
        sql: `UPDATE jobs SET title = $2, title_en = $3, department = $4, location = $5, employment = $6, headcount = $7 WHERE id = $1 RETURNING id`,
        params: [action.id, ...job(action)],
        one: true,
      }
    case 'set-job-status':
      return { sql: `UPDATE jobs SET status = $2 WHERE id = $1 RETURNING id`, params: [action.id, action.status], one: true }
    case 'add-candidate':
      return {
        sql: `INSERT INTO candidates (id, name, email, phone, source, current_title, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        params: [action.id, ...person(action)],
      }
    case 'update-candidate':
      return {
        sql: `UPDATE candidates SET name = $2, email = $3, phone = $4, source = $5, current_title = $6, notes = $7 WHERE id = $1 RETURNING id`,
        params: [action.id, ...person(action)],
        one: true,
      }
    case 'delete-candidate':
      // Applications, interviews and their history go with the person (ON DELETE CASCADE).
      return { sql: `DELETE FROM candidates WHERE id = $1 RETURNING id`, params: [action.id], one: true }
    case 'apply':
      return {
        sql: `INSERT INTO applications (id, job_id, candidate_id, stage, applied_on) VALUES ($1, $2, $3, 'applied', $4)`,
        params: [action.id, action.jobId, action.candidateId, action.appliedOn],
      }
    case 'move':
      return {
        sql: `UPDATE applications SET stage = $2, rejected_reason = $3 WHERE id = $1 AND stage = $4 RETURNING id`,
        params: [action.id, action.to, action.to === 'rejected' ? (action.reason ?? '').trim() : null, action.from],
        one: true,
      }
    case 'reject-remaining':
      return {
        sql: `UPDATE applications SET stage = 'rejected', rejected_reason = $2 WHERE job_id = $1 AND stage NOT IN ('hired', 'rejected')`,
        params: [action.jobId, action.reason.trim()],
      }
    case 'rate':
      return { sql: `UPDATE applications SET rating = $2 WHERE id = $1 RETURNING id`, params: [action.id, action.rating], one: true }
    case 'schedule-interview':
      return {
        sql: `INSERT INTO interviews (id, application_id, kind, scheduled_at, interviewer) VALUES ($1, $2, $3, $4, $5)`,
        params: [action.id, action.applicationId, action.kind, action.scheduledAt, action.interviewer.trim()],
      }
    case 'record-scorecard':
      return {
        sql: `UPDATE interviews SET score = $2, recommendation = $3, feedback = $4 WHERE id = $1 RETURNING id`,
        params: [action.id, action.score, action.recommendation, action.feedback.trim()],
        one: true,
      }
    case 'cancel-interview':
      // Only one that has not been scored: a scorecard is part of the hiring record.
      return { sql: `DELETE FROM interviews WHERE id = $1 AND score IS NULL RETURNING id`, params: [action.id], one: true }
  }
}

/** What the database says, as a code the labels know. Trigger errors already are one. */
export const errorCodes = [
  'headcount_filled',
  'headcount_below_hired',
  'job_not_open',
  'job_closed',
  'job_has_applications',
  'hired_is_final',
  'application_locked',
  'invalid_stage_time',
  'stage_events_managed',
  'read_only',
] as const
export function errorCode(message: string) {
  const known = errorCodes.find((code) => message.includes(code))
  if (known) return known
  if (message.includes('applications_once')) return 'already_applied'
  if (message.includes('candidates_email')) return 'duplicate_email'
  if (/_pkey/.test(message)) return 'duplicate_id'
  if (/check constraint|violates|invalid input|out of range/i.test(message)) return 'invalid_input'
  if (/permission denied|read-only/i.test(message)) return 'read_only'
  return 'generic_error'
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────

export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export const isEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
const filled = (value: string, max: number) => value.trim().length > 0 && value.length <= max

/** The same rules the database checks, so a form can say what is wrong before it is sent. */
const fail = (code: string) => {
  throw new Error(code)
}
export function validate(action: RecruitingAction): void {
  switch (action.action) {
    case 'create-job':
    case 'update-job':
      if (!filled(action.title, 120) || !filled(action.department, 80) || !filled(action.location, 80)) fail('invalid_input')
      if (!employments.includes(action.employment)) fail('invalid_input')
      if (!Number.isInteger(action.headcount) || action.headcount < 1 || action.headcount > MAX_HEADCOUNT) fail('invalid_headcount')
      return
    case 'set-job-status':
      if (!jobStatuses.includes(action.status)) fail('invalid_input')
      return
    case 'add-candidate':
    case 'update-candidate':
      if (!filled(action.name, 120)) fail('invalid_input')
      if (!isEmail(action.email)) fail('invalid_email')
      if (!sources.includes(action.source)) fail('invalid_input')
      return
    case 'apply':
      if (!isDay(action.appliedOn)) fail('invalid_date')
      return
    case 'move':
      if (!stages.includes(action.to) || action.to === action.from) fail('invalid_input')
      if (action.to === 'rejected' && !filled(action.reason ?? '', 500)) fail('reason_required')
      return
    case 'reject-remaining':
      if (!filled(action.reason, 500)) fail('reason_required')
      return
    case 'rate':
      if (action.rating !== null && (!Number.isInteger(action.rating) || action.rating < 1 || action.rating > 5)) fail('invalid_input')
      return
    case 'schedule-interview':
      if (!interviewKinds.includes(action.kind) || Number.isNaN(Date.parse(action.scheduledAt))) fail('invalid_date')
      if (!filled(action.interviewer, 120)) fail('invalid_input')
      return
    case 'record-scorecard':
      if (!Number.isInteger(action.score) || action.score < 1 || action.score > 4) fail('invalid_input')
      if (!recommendations.includes(action.recommendation)) fail('invalid_input')
      return
  }
}

// ── Reading the data ───────────────────────────────────────────────────────────────────────────

/**
 * The moment the app treats as now. A copy uses the clock; the gallery demo is a snapshot, so it
 * reads time as of when it was seeded and its "upcoming" interviews stay upcoming.
 */
export function clockOf(data: Pick<RecruitingData, 'readOnly' | 'jobs'>, now = new Date()) {
  if (!data.readOnly || !data.jobs.length) return now
  return new Date(data.jobs.reduce((latest, j) => (j.created_at > latest ? j.created_at : latest), data.jobs[0].created_at))
}

export const daysBetween = (from: string | Date, to: string | Date) =>
  Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY)
/** Local calendar day, as stored in the text date columns. */
export const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const monthOf = (iso: string) => iso.slice(0, 7)
export function lastMonths(end: string, count: number) {
  const [y, m] = end.split('-').map(Number)
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1)).toISOString().slice(0, 7))
}

export function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export const isActive = (a: Pick<Application, 'stage'>) => a.stage !== 'hired' && a.stage !== 'rejected'
export const nextStage = (stage: Stage): Stage | null => {
  const i = pipeline.indexOf(stage as (typeof pipeline)[number])
  return i >= 0 && i < pipeline.length - 1 ? pipeline[i + 1] : null
}

/** Each application's stage events, oldest first. */
export function timelines(events: StageEvent[]) {
  const map = new Map<string, StageEvent[]>()
  for (const e of events) map.set(e.application_id, [...(map.get(e.application_id) ?? []), e])
  for (const list of map.values()) list.sort((a, b) => a.at.localeCompare(b.at) || a.created_at.localeCompare(b.created_at))
  return map
}

export function stageCounts(applications: Pick<Application, 'stage'>[]) {
  const counts = Object.fromEntries(stages.map((s) => [s, 0])) as Record<Stage, number>
  for (const a of applications) counts[a.stage]++
  return counts
}

export const hiredFor = (data: Pick<RecruitingData, 'applications'>, jobId: string) =>
  data.applications.filter((a) => a.job_id === jobId && a.stage === 'hired').length

/**
 * How long a job has been open. A closed job counts up to its last hire, so a filled role reads
 * "filled in 34 days" instead of growing forever. Drafts have not started.
 */
export function daysOpen(job: Pick<Job, 'id' | 'status' | 'opened_on'>, data: Pick<RecruitingData, 'applications' | 'stage_events'>, now: Date) {
  if (!job.opened_on) return null
  if (job.status !== 'closed') return Math.max(0, daysBetween(job.opened_on + 'T00:00:00', now))
  const ids = new Set(data.applications.filter((a) => a.job_id === job.id).map((a) => a.id))
  const hires = data.stage_events.filter((e) => e.to_stage === 'hired' && ids.has(e.application_id)).map((e) => e.at)
  if (!hires.length) return null
  return Math.max(0, daysBetween(job.opened_on + 'T00:00:00', hires.sort()[hires.length - 1]))
}

const forJob = (data: Pick<RecruitingData, 'applications'>, jobId?: string) =>
  jobId ? data.applications.filter((a) => a.job_id === jobId) : data.applications

/**
 * How far each application got along the path, from its history: one that reached the offer
 * stage and was then rejected still counts as having reached screening, interview and offer.
 */
export function furthest(application: Pick<Application, 'stage'>, history: Pick<StageEvent, 'to_stage'>[] = []) {
  let best = pipeline.indexOf(application.stage as (typeof pipeline)[number])
  for (const e of history) best = Math.max(best, pipeline.indexOf(e.to_stage as (typeof pipeline)[number]))
  return Math.max(best, 0)
}

export type FunnelStep = { stage: (typeof pipeline)[number]; reached: number; conversion: number | null }
/** Applications that reached each step, and the share of the step before that made it there. */
export function funnel(data: Pick<RecruitingData, 'applications' | 'stage_events'>, jobId?: string): FunnelStep[] {
  const history = timelines(data.stage_events)
  const reached = pipeline.map(() => 0)
  for (const a of forJob(data, jobId)) {
    const best = furthest(a, history.get(a.id))
    for (let i = 0; i <= best; i++) reached[i]++
  }
  return pipeline.map((stage, i) => ({
    stage,
    reached: reached[i],
    conversion: i === 0 ? null : reached[i - 1] ? reached[i] / reached[i - 1] : null,
  }))
}

export type StageTime = { stage: Stage; median: number | null; count: number }
/**
 * Median days spent in each step, from finished stints only: the time between entering a stage
 * and the next change. Applications still sitting in a stage do not pull the median down.
 */
export function timeInStage(data: Pick<RecruitingData, 'applications' | 'stage_events'>, jobId?: string): StageTime[] {
  const keep = new Set(forJob(data, jobId).map((a) => a.id))
  const spans = new Map<Stage, number[]>()
  for (const [id, events] of timelines(data.stage_events)) {
    if (!keep.has(id)) continue
    for (let i = 0; i < events.length - 1; i++) {
      const days = (Date.parse(events[i + 1].at) - Date.parse(events[i].at)) / DAY
      spans.set(events[i].to_stage, [...(spans.get(events[i].to_stage) ?? []), days])
    }
  }
  return pipeline.slice(0, -1).map((stage) => {
    const list = spans.get(stage) ?? []
    return { stage, median: median(list), count: list.length }
  })
}

/** Days from applying to the hire, per hire. */
export function timeToHire(data: Pick<RecruitingData, 'applications' | 'stage_events'>, jobId?: string) {
  const history = timelines(data.stage_events)
  return forJob(data, jobId)
    .filter((a) => a.stage === 'hired')
    .map((a) => {
      const events = history.get(a.id) ?? []
      const hired = events.filter((e) => e.to_stage === 'hired').pop()
      return hired && events[0] ? (Date.parse(hired.at) - Date.parse(events[0].at)) / DAY : null
    })
    .filter((d): d is number => d !== null)
}

/** Of the offers that were decided either way, the share that ended in a hire. */
export function offerAcceptance(data: Pick<RecruitingData, 'applications' | 'stage_events'>, jobId?: string) {
  const history = timelines(data.stage_events)
  let made = 0
  let accepted = 0
  for (const a of forJob(data, jobId)) {
    if (a.stage !== 'hired' && a.stage !== 'rejected') continue
    if (!(history.get(a.id) ?? []).some((e) => e.to_stage === 'offer')) continue
    made++
    if (a.stage === 'hired') accepted++
  }
  return made ? accepted / made : null
}

export type SourceRow = { source: Source; candidates: number; applications: number; interviewed: number; hired: number; hireRate: number | null }
/** Where people came from, and how far each channel's applications got. */
export function sourceStats(data: Pick<RecruitingData, 'candidates' | 'applications' | 'stage_events'>, jobId?: string): SourceRow[] {
  const history = timelines(data.stage_events)
  const sourceOf = new Map(data.candidates.map((c) => [c.id, c.source]))
  const interview = pipeline.indexOf('interview')
  const rows = new Map(sources.map((source) => [source, { source, people: new Set<string>(), applications: 0, interviewed: 0, hired: 0 }]))
  for (const a of forJob(data, jobId)) {
    const row = rows.get(sourceOf.get(a.candidate_id) ?? 'other')!
    row.people.add(a.candidate_id)
    row.applications++
    if (furthest(a, history.get(a.id)) >= interview) row.interviewed++
    if (a.stage === 'hired') row.hired++
  }
  return [...rows.values()]
    .map(({ people, ...row }) => ({ ...row, candidates: people.size, hireRate: row.applications ? row.hired / row.applications : null }))
    .sort((a, b) => b.hired - a.hired || b.applications - a.applications)
}

/** Hires per calendar month (UTC), from the moment the database recorded each one. */
export function hiresByMonth(data: Pick<RecruitingData, 'applications' | 'stage_events'>, months: string[], jobId?: string) {
  const keep = new Set(forJob(data, jobId).map((a) => a.id))
  const counts = new Map(months.map((m) => [m, 0]))
  for (const e of data.stage_events)
    if (e.to_stage === 'hired' && keep.has(e.application_id) && counts.has(monthOf(e.at)))
      counts.set(monthOf(e.at), counts.get(monthOf(e.at))! + 1)
  return months.map((month) => ({ month, hires: counts.get(month)! }))
}

export type Scorecards = { total: number; scored: number; average: number | null; votes: Record<Recommendation, number> }
export function scorecards(interviews: Pick<Interview, 'score' | 'recommendation'>[]): Scorecards {
  const scored = interviews.filter((i) => i.score !== null)
  const votes = Object.fromEntries(recommendations.map((r) => [r, 0])) as Record<Recommendation, number>
  for (const i of scored) if (i.recommendation) votes[i.recommendation]++
  return {
    total: interviews.length,
    scored: scored.length,
    average: scored.length ? scored.reduce((s, i) => s + i.score!, 0) / scored.length : null,
    votes,
  }
}

// ── Presentation helpers ───────────────────────────────────────────────────────────────────────

export const localizedTitle = (job: Pick<Job, 'title' | 'title_en'>, locale: Locale) =>
  locale === 'en' ? job.title_en || job.title : job.title

/** Two Latin initials, or the surname for a Chinese name, the way a badge would show it. */
export function initials(name: string) {
  const clean = name.trim()
  if (!clean) return '?'
  if (/^[㐀-鿿]/.test(clean)) return clean[0]
  const words = clean.split(/\s+/)
  return ((words[0][0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}

/** A stable hue per person, so the same avatar colour follows them across pages. */
export function hueOf(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
