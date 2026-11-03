import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  Columns3,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import {
  clockOf,
  dayOf,
  daysBetween,
  daysOpen,
  employments,
  funnel,
  hiredFor,
  hiresByMonth,
  hueOf,
  initials,
  interviewKinds,
  isActive,
  lastMonths,
  localizedTitle,
  median,
  nextStage,
  offerAcceptance,
  pipeline,
  recommendations,
  rejectionReasons,
  scorecards,
  sourceStats,
  sources,
  stageCounts,
  stages,
  timeInStage,
  timeToHire,
  timelines,
  validate,
  type Application,
  type Candidate,
  type Interview,
  type InterviewKind,
  type Job,
  type JobStatus,
  type Locale,
  type Recommendation,
  type RecruitingAction,
  type RecruitingClient,
  type RecruitingData,
  type Source,
  type Stage,
} from '@lovbase/core/recruiting'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translate } from './labels'
import './recruiting.css'

type Page = 'jobs' | 'pipeline' | 'candidates' | 'interviews' | 'reports'
type Form =
  | { type: 'job'; job?: Job; newId: string }
  | { type: 'candidate'; candidate?: Candidate; newId: string; applicationId: string }
  | { type: 'apply'; candidate: Candidate; newId: string }
  | { type: 'move'; application: Application; to?: Stage }
  | { type: 'reject-remaining'; job: Job }
  | { type: 'schedule'; applicationId?: string; newId: string }
  | { type: 'scorecard'; interview: Interview }
  | { type: 'delete-candidate'; candidate: Candidate }
type T = (key: string) => string

const navigation: [Page, typeof Users][] = [
  ['jobs', BriefcaseBusiness],
  ['pipeline', Columns3],
  ['candidates', Users],
  ['interviews', CalendarClock],
  ['reports', BarChart3],
]
const DAY = 86_400_000
const newId = () => crypto.randomUUID()
const intl = (locale: Locale) => (locale === 'zh' ? 'zh-CN' : 'en-US')
function dateLabel(iso: string, locale: Locale, withYear = false) {
  // Text dates are calendar days; read them at noon so no time zone moves them.
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)
  return new Intl.DateTimeFormat(intl(locale), { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(d)
}
const timeLabel = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(intl(locale), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
function monthLabel(month: string, locale: Locale) {
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(intl(locale), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}
const percent = (ratio: number | null) => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`)
const reasonLabel = (reason: string | null, t: T) =>
  !reason ? '' : reason === 'location' ? t('location_reason') : (rejectionReasons as readonly string[]).includes(reason) ? t(reason) : reason
const kindLabel = (kind: InterviewKind, t: T) => t(kind === 'phone' ? 'phone_kind' : kind)

export function RecruitingApp({
  client,
  initialLocale = 'en',
  locale: controlledLocale,
  onLocaleChange,
  initialData,
}: {
  client: RecruitingClient
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  initialData?: RecruitingData
}) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t = (key: string) => translate(locale, key)
  const [data, setData] = useState<RecruitingData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<Page>('jobs')
  const [form, setForm] = useState<Form | null>(null)
  const [jobId, setJobId] = useState('')
  const [boardJobId, setBoardJobId] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [reportJob, setReportJob] = useState('')
  const [dragging, setDragging] = useState('')
  const [over, setOver] = useState<Stage | ''>('')

  const read = useCallback(async () => {
    setLoading(true)
    try {
      setData(await client.read())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'generic_error')
    } finally {
      setLoading(false)
    }
  }, [client])
  useEffect(() => {
    if (!initialData) void read()
  }, [initialData, read])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4200)
    return () => clearTimeout(timer)
  }, [notice])
  const switchLocale = (next: Locale) => {
    setLocalLocale(next)
    onLocaleChange?.(next)
  }

  // Every write is one action, then a fresh read: the database may have done more than asked
  // (logged the move, closed the job), and the screen should show what it did.
  const run = async (action: RecruitingAction, inDialog = true) => {
    if (busy || data?.readOnly) return false
    setBusy(true)
    setFormError('')
    try {
      validate(action)
      await client.run(action)
      setData(await client.read())
      setForm(null)
      return true
    } catch (e) {
      const code = e instanceof Error ? e.message : 'generic_error'
      if (inDialog) setFormError(code)
      else setNotice(code)
      return false
    } finally {
      setBusy(false)
    }
  }
  const open = (next: Form) => {
    setFormError('')
    setForm(next)
  }

  const view = useMemo(() => {
    if (!data) return null
    const now = clockOf(data)
    const jobs = new Map(data.jobs.map((j) => [j.id, j]))
    const candidates = new Map(data.candidates.map((c) => [c.id, c]))
    const applications = new Map(data.applications.map((a) => [a.id, a]))
    const order: JobStatus[] = ['open', 'paused', 'draft', 'closed']
    const sortedJobs = [...data.jobs].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (b.opened_on ?? '9').localeCompare(a.opened_on ?? '9'),
    )
    return { now, jobs, candidates, applications, sortedJobs, history: timelines(data.stage_events) }
  }, [data])

  if (!data || !view)
    return (
      <div className="recruiting-app rec-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="rec-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  const writable = !data.readOnly
  const now = view.now
  const jobTitle = (id: string) => {
    const job = view.jobs.get(id)
    return job ? localizedTitle(job, locale) : '—'
  }
  const personOf = (a: Application) => view.candidates.get(a.candidate_id)
  const openCandidate = (id: string) => {
    setCandidateId(id)
    setPage('candidates')
  }
  const openBoard = (id: string) => {
    setBoardJobId(id)
    setPage('pipeline')
  }
  const describeApplication = (a: Application) => `${personOf(a)?.name ?? '—'} · ${jobTitle(a.job_id)}`
  const nonDraft = view.sortedJobs.filter((j) => j.status !== 'draft')

  // ── Jobs ──────────────────────────────────────────────────────────────────────────────────────
  const active = data.applications.filter(isActive)
  const weekAhead = data.interviews.filter((i) => {
    const at = Date.parse(i.scheduled_at)
    return at >= now.getTime() && at < now.getTime() + 7 * DAY
  })
  const hireDays = median(timeToHire(data))
  const jobRow = (job: Job) => {
    const apps = data.applications.filter((a) => a.job_id === job.id)
    const counts = stageCounts(apps)
    const hired = counts.hired
    const age = daysOpen(job, data, now)
    return (
      <li key={job.id}>
        <button className="rec-job" onClick={() => setJobId(job.id)}>
          <div className="rec-job-name">
            <strong>{localizedTitle(job, locale)}</strong>
            <span>
              {job.department} · {job.location} · {t(job.employment)}
            </span>
          </div>
          <StatusPill status={job.status} t={t} />
          <StageStrip counts={counts} t={t} />
          <Seats hired={hired} total={job.headcount} t={t} />
          <span className="rec-job-age">
            {age === null ? (
              <em>{t('notOpened')}</em>
            ) : (
              <>
                <b>{age}</b>
                <em>{job.status === 'closed' ? t('daysToFill') : t('daysOpenShort')}</em>
              </>
            )}
          </span>
        </button>
      </li>
    )
  }
  const jobsList = (
    <>
      <section className="rec-kpis">
        <Kpi label={t('openRoles')} value={String(data.jobs.filter((j) => j.status === 'open').length)} />
        <Kpi label={t('inProcess')} value={String(active.length)} hint={`${data.candidates.length} ${t('candidates').toLowerCase()}`} />
        <Kpi label={t('nextWeek')} value={String(weekAhead.length)} />
        <Kpi label={t('timeToHire')} value={hireDays === null ? '—' : `${Math.round(hireDays)}`} hint={t('daysUnit')} accent />
      </section>
      <Panel className="rec-flush">
        {data.jobs.length === 0 ? (
          <p className="rec-empty">{t('noJobs')}</p>
        ) : (
          <>
            <div className="rec-jobs-head" aria-hidden>
              <span>{t('role')}</span>
              <span>{t('status')}</span>
              <StageLegend t={t} />
              <span>{t('seatsFilled')}</span>
              <span>{t('age')}</span>
            </div>
            <ul className="rec-jobs">{view.sortedJobs.map(jobRow)}</ul>
          </>
        )}
      </Panel>
    </>
  )

  const selectedJob = view.jobs.get(jobId)
  const jobDetail = selectedJob
    ? (() => {
        const job = selectedJob
        const apps = data.applications.filter((a) => a.job_id === job.id)
        const counts = stageCounts(apps)
        const stillIn = apps.filter(isActive)
        const age = daysOpen(job, data, now)
        const interviews = data.interviews.filter((i) => view.applications.get(i.application_id)?.job_id === job.id)
        const sorted = [...apps].sort(
          (a, b) => Number(isActive(b)) - Number(isActive(a)) || pipeline.indexOf(b.stage as never) - pipeline.indexOf(a.stage as never) || b.stage_changed_at.localeCompare(a.stage_changed_at),
        )
        // The job takes over the page heading, with the way back above it.
        const head = (
          <div>
            <p className="rec-eyebrow">
              <button className="rec-link rec-back" onClick={() => setJobId('')}>
                <ArrowLeft size={13} />
                01 — {t('allJobs')}
              </button>
            </p>
            <h1>{localizedTitle(job, locale)}</h1>
            <div className="rec-job-meta">
              <StatusPill status={job.status} t={t} />
              <span>
                {job.department} · {job.location} · {t(job.employment)}
                {job.title_en && job.title !== job.title_en ? ` · ${locale === 'zh' ? job.title_en : job.title}` : ''}
              </span>
            </div>
          </div>
        )
        const actions = (
          <div className="rec-toolbar">
            {writable && (
              <>
                <Choice
                  label={t('status')}
                  value={job.status}
                  onChange={(status) => void run({ action: 'set-job-status', id: job.id, status: status as JobStatus }, false)}
                  options={(['draft', 'open', 'paused', 'closed'] as const).map((s): [string, string] => [s, t(s)])}
                />
                <button onClick={() => open({ type: 'job', job, newId: job.id })}>
                  <Pencil size={15} />
                  {t('editJob')}
                </button>
              </>
            )}
            {job.status !== 'draft' && (
              <button className="rec-primary" onClick={() => openBoard(job.id)}>
                <Columns3 size={15} />
                {t('openPipeline')}
              </button>
            )}
          </div>
        )
        const body = (
          <>
            {job.status === 'closed' && counts.hired >= job.headcount && stillIn.length > 0 && (
              <div className="rec-callout">
                <span>{t('filledNotice').replace('{n}', String(stillIn.length))}</span>
                {writable && (
                  <button onClick={() => open({ type: 'reject-remaining', job })}>{t('rejectRemaining')}</button>
                )}
              </div>
            )}
            <section className="rec-kpis">
              <Kpi label={t('applicants')} value={String(apps.length)} />
              <Kpi label={t('inProcess')} value={String(stillIn.length)} />
              <Kpi label={t('seatsFilled')} value={`${counts.hired} / ${job.headcount}`} accent={counts.hired > 0} />
              <Kpi
                label={job.status === 'closed' ? t('filledIn') : t('daysOpen')}
                value={age === null ? '—' : String(age)}
                hint={age === null ? t('notOpened') : t('daysUnit')}
              />
            </section>
            <div className="rec-grid rec-top">
              <Panel title={t('byStage')}>
                <FunnelBars steps={funnel(data, job.id)} counts={counts} t={t} compact />
                <p className="rec-muted rec-small">
                  {interviews.length} {t('interviews').toLowerCase()} · {scorecards(interviews).scored} {t('scorecards').toLowerCase()}
                </p>
              </Panel>
              <Panel title={t('recentApplicants')} className="rec-span-2">
                {sorted.length === 0 ? (
                  <p className="rec-empty">{t('noApplicants')}</p>
                ) : (
                  <ul className="rec-people">
                    {sorted.map((a) => {
                      const person = personOf(a)
                      return (
                        <li key={a.id}>
                          <button className="rec-person" onClick={() => person && openCandidate(person.id)}>
                            <Avatar name={person?.name ?? '?'} />
                            <span className="rec-person-name">
                              <strong>{person?.name}</strong>
                              <em>{person?.current_title}</em>
                            </span>
                            <StagePill stage={a.stage} t={t} />
                            <Stars value={a.rating} />
                            <time>{dateLabel(a.applied_on, locale)}</time>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Panel>
            </div>
          </>
        )
        return { head, actions, body }
      })()
    : null

  // ── Pipeline ──────────────────────────────────────────────────────────────────────────────────
  const boardJob = view.jobs.get(boardJobId) ?? nonDraft[0]
  const boardApps = boardJob ? data.applications.filter((a) => a.job_id === boardJob.id) : []
  const boardHired = boardJob ? hiredFor(data, boardJob.id) : 0
  // A drop or a button goes through the same door: hires and rejections ask first.
  const requestMove = (application: Application, to: Stage) => {
    if (!writable || application.stage === to || application.stage === 'hired') return
    if (to === 'hired' || to === 'rejected') return open({ type: 'move', application, to })
    void run({ action: 'move', id: application.id, from: application.stage, to }, false)
  }
  const onDrop = (stage: Stage) => (e: DragEvent) => {
    e.preventDefault()
    setOver('')
    const application = view.applications.get(e.dataTransfer.getData('text/plain') || dragging)
    setDragging('')
    if (application) requestMove(application, stage)
  }
  const card = (a: Application) => {
    const person = personOf(a)
    const next = nextStage(a.stage)
    const days = Math.max(0, daysBetween(a.stage_changed_at, now))
    const canDrag = writable && a.stage !== 'hired'
    return (
      <li
        key={a.id}
        className={`rec-card${dragging === a.id ? ' is-dragging' : ''}`}
        draggable={canDrag}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', a.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(a.id)
        }}
        onDragEnd={() => {
          setDragging('')
          setOver('')
        }}
      >
        <button className="rec-card-main" onClick={() => person && openCandidate(person.id)}>
          <Avatar name={person?.name ?? '?'} />
          <span>
            <strong>{person?.name}</strong>
            <em>{person?.current_title || '—'}</em>
          </span>
        </button>
        <div className="rec-card-meta">
          {person && <span className={`rec-source rec-source-${person.source}`}>{t(person.source)}</span>}
          <Stars value={a.rating} />
          <span className="rec-age" title={t('inStage')}>
            {days}
            {t('dayShort')}
          </span>
        </div>
        {a.stage === 'rejected' && <p className="rec-reason">{reasonLabel(a.rejected_reason, t)}</p>}
        {writable && a.stage !== 'hired' && (
          <div className="rec-card-actions">
            {next && (
              <button onClick={() => requestMove(a, next)} title={`${t('advance')} ${t(next)}`}>
                {t(next)}
                <ArrowRight size={13} />
              </button>
            )}
            <button className="rec-icon" onClick={() => open({ type: 'move', application: a })} title={t('move')} aria-label={t('move')}>
              <Columns3 size={14} />
            </button>
            {a.stage !== 'rejected' && (
              <button className="rec-icon rec-danger" onClick={() => requestMove(a, 'rejected')} title={t('reject')} aria-label={t('reject')}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </li>
    )
  }
  const board = boardJob ? (
    <>
      <div className="rec-board-head">
        <Choice
          label={t('choosePipeline')}
          value={boardJob.id}
          onChange={setBoardJobId}
          options={nonDraft.map((j): [string, string] => [j.id, `${localizedTitle(j, locale)}${j.status === 'open' ? '' : ` · ${t(j.status)}`}`])}
        />
        <Seats hired={boardHired} total={boardJob.headcount} t={t} wide />
        <span className="rec-muted rec-small">
          {boardApps.filter(isActive).length} {t('inProcess').toLowerCase()}
        </span>
      </div>
      <div className="rec-board" role="list">
        {stages.map((stage) => {
          const list = boardApps
            .filter((a) => a.stage === stage)
            .sort((a, b) => a.stage_changed_at.localeCompare(b.stage_changed_at))
          return (
            <section
              key={stage}
              className={`rec-column rec-column-${stage}${over === stage ? ' is-over' : ''}`}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (over !== stage) setOver(stage)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver('')
              }}
              onDrop={onDrop(stage)}
            >
              <header>
                <span className={`rec-dot rec-dot-${stage}`} />
                <h3>{t(stage)}</h3>
                <span className="rec-count">{list.length}</span>
              </header>
              <ul>
                {list.map(card)}
                {list.length === 0 && <li className="rec-column-empty">{dragging ? t('dropHere') : t('emptyColumn')}</li>}
              </ul>
            </section>
          )
        })}
      </div>
    </>
  ) : (
    <p className="rec-empty">{t('noJobs')}</p>
  )

  // ── Candidates ────────────────────────────────────────────────────────────────────────────────
  const needle = query.trim().toLowerCase()
  const latestOf = (candidate: Candidate) =>
    data.applications
      .filter((a) => a.candidate_id === candidate.id)
      .sort((a, b) => b.stage_changed_at.localeCompare(a.stage_changed_at))[0]
  const people = data.candidates
    .filter(
      (c) =>
        (!sourceFilter || c.source === sourceFilter) &&
        (!needle || `${c.name} ${c.email} ${c.current_title}`.toLowerCase().includes(needle)),
    )
    .map((c) => ({ candidate: c, latest: latestOf(c) }))
    .sort((a, b) => (b.latest?.stage_changed_at ?? b.candidate.created_at).localeCompare(a.latest?.stage_changed_at ?? a.candidate.created_at))
  const chosen = view.candidates.get(candidateId)
  const profile = chosen ? (
    (() => {
      const c = chosen
      const apps = data.applications.filter((a) => a.candidate_id === c.id).sort((a, b) => b.applied_on.localeCompare(a.applied_on))
      const ids = new Set(apps.map((a) => a.id))
      const interviews = data.interviews.filter((i) => ids.has(i.application_id)).sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))
      const events = data.stage_events.filter((e) => ids.has(e.application_id)).sort((a, b) => b.at.localeCompare(a.at) || b.created_at.localeCompare(a.created_at))
      const applicable = data.jobs.filter((j) => j.status === 'open' && !apps.some((a) => a.job_id === j.id))
      return (
        <div className="rec-profile">
          <button className="rec-link rec-profile-back" onClick={() => setCandidateId('')}>
            <ArrowLeft size={14} />
            {t('back')}
          </button>
          <header className="rec-profile-head">
            <Avatar name={c.name} size="lg" />
            <div>
              <h2>{c.name}</h2>
              <p>{c.current_title || '—'}</p>
              <div className="rec-contact">
                <span>
                  <Mail size={13} />
                  {c.email}
                </span>
                {c.phone && (
                  <span>
                    <Phone size={13} />
                    {c.phone}
                  </span>
                )}
                <span className={`rec-source rec-source-${c.source}`}>{t(c.source)}</span>
              </div>
            </div>
            {writable && (
              <div className="rec-toolbar">
                {applicable.length > 0 && (
                  <button onClick={() => open({ type: 'apply', candidate: c, newId: newId() })}>
                    <Plus size={15} />
                    {t('applyToJob')}
                  </button>
                )}
                <button className="rec-icon" onClick={() => open({ type: 'candidate', candidate: c, newId: c.id, applicationId: '' })} aria-label={t('editCandidate')} title={t('editCandidate')}>
                  <Pencil size={15} />
                </button>
                <button className="rec-icon rec-danger" onClick={() => open({ type: 'delete-candidate', candidate: c })} aria-label={t('deleteCandidate')} title={t('deleteCandidate')}>
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </header>
          {c.notes && <p className="rec-notes">{c.notes}</p>}
          <h3 className="rec-section">{t('applications')}</h3>
          <ul className="rec-apps">
            {apps.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{jobTitle(a.job_id)}</strong>
                  <span>
                    {t('appliedOn')} {dateLabel(a.applied_on, locale, true)}
                    {a.stage === 'rejected' && a.rejected_reason ? ` · ${reasonLabel(a.rejected_reason, t)}` : ''}
                  </span>
                </div>
                <Stars
                  value={a.rating}
                  onChange={writable ? (rating) => void run({ action: 'rate', id: a.id, rating: rating === a.rating ? null : rating }, false) : undefined}
                />
                <StagePill stage={a.stage} t={t} />
                {writable && a.stage !== 'hired' && (
                  <button className="rec-icon" onClick={() => open({ type: 'move', application: a })} aria-label={t('move')} title={t('move')}>
                    <Columns3 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h3 className="rec-section">{t('scorecards')}</h3>
          {interviews.length === 0 ? (
            <p className="rec-empty rec-left">{t('noScorecards')}</p>
          ) : (
            <ul className="rec-scorecards">
              {interviews.map((i) => (
                <ScorecardItem
                  key={i.id}
                  interview={i}
                  job={jobTitle(view.applications.get(i.application_id)?.job_id ?? '')}
                  locale={locale}
                  t={t}
                  now={now}
                  onRecord={writable ? () => open({ type: 'scorecard', interview: i }) : undefined}
                />
              ))}
            </ul>
          )}
          <h3 className="rec-section">{t('timeline')}</h3>
          <ol className="rec-timeline">
            {events.map((e) => {
              const application = view.applications.get(e.application_id)!
              return (
                <li key={e.id}>
                  <span className={`rec-dot rec-dot-${e.to_stage}`} />
                  <div>
                    <strong>{e.from_stage ? `${t('movedTo')} ${t(e.to_stage)}` : t('appliedFor')}</strong>
                    <span>{jobTitle(application.job_id)}</span>
                  </div>
                  <time>{dateLabel(e.at, locale, true)}</time>
                </li>
              )
            })}
          </ol>
        </div>
      )
    })()
  ) : null
  const directory = (
    <div className={`rec-directory${chosen ? ' has-profile' : ''}`}>
      <Panel className="rec-roster">
        <div className="rec-filters">
          <label className="rec-search">
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} />
          </label>
          <Choice
            label={t('source')}
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[['', t('allSources')], ...sources.map((s): [string, string] => [s, t(s)])]}
          />
        </div>
        <p className="rec-muted rec-small">
          {people.length} {t('people')}
        </p>
        {people.length === 0 && <p className="rec-empty">{t('noCandidates')}</p>}
        <ul className="rec-roster-list">
          {people.map(({ candidate: c, latest }) => (
            <li key={c.id}>
              <button aria-current={c.id === candidateId ? 'true' : undefined} onClick={() => setCandidateId(c.id)}>
                <Avatar name={c.name} />
                <span className="rec-person-name">
                  <strong>{c.name}</strong>
                  <em>{latest ? jobTitle(latest.job_id) : c.current_title}</em>
                </span>
                {latest && <StagePill stage={latest.stage} t={t} />}
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel className="rec-profile-panel">{profile ?? <p className="rec-empty">{t('candidatesLead')}</p>}</Panel>
    </div>
  )

  // ── Interviews ────────────────────────────────────────────────────────────────────────────────
  const upcoming = data.interviews
    .filter((i) => Date.parse(i.scheduled_at) >= now.getTime())
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
  const awaiting = data.interviews
    .filter((i) => Date.parse(i.scheduled_at) < now.getTime() && i.score === null)
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))
  const recent = data.interviews
    .filter((i) => i.score !== null)
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))
    .slice(0, 8)
  const byDay = new Map<string, Interview[]>()
  for (const i of upcoming) {
    const key = dayOf(new Date(i.scheduled_at))
    byDay.set(key, [...(byDay.get(key) ?? []), i])
  }
  const relativeDay = (day: string) =>
    day === dayOf(now) ? t('today') : day === dayOf(new Date(now.getTime() + DAY)) ? t('tomorrow') : ''
  const interviewLine = (i: Interview, action?: ReactNode) => {
    const application = view.applications.get(i.application_id)
    const person = application && personOf(application)
    return (
      <li key={i.id} className="rec-slot">
        <time>{timeLabel(i.scheduled_at, locale)}</time>
        <button className="rec-person" onClick={() => person && openCandidate(person.id)}>
          <Avatar name={person?.name ?? '?'} />
          <span className="rec-person-name">
            <strong>{person?.name}</strong>
            <em>{application ? jobTitle(application.job_id) : ''}</em>
          </span>
        </button>
        <span className="rec-slot-kind">
          {kindLabel(i.kind, t)}
          <em>{i.interviewer}</em>
        </span>
        {action}
      </li>
    )
  }
  const interviews = (
    <div className="rec-grid rec-top">
      <Panel title={t('upcoming')} className="rec-span-2" action={<span className="rec-count">{upcoming.length}</span>}>
        {byDay.size === 0 && <p className="rec-empty">{t('nothingUpcoming')}</p>}
        {[...byDay].map(([day, list]) => (
          <section key={day} className="rec-day">
            <h4>
              {dateLabel(day, locale)}
              {relativeDay(day) && <em>{relativeDay(day)}</em>}
            </h4>
            <ul className="rec-slots">
              {list.map((i) =>
                interviewLine(
                  i,
                  writable ? (
                    <button className="rec-icon" onClick={() => void run({ action: 'cancel-interview', id: i.id }, false)} aria-label={t('cancelInterview')} title={t('cancelInterview')}>
                      <X size={14} />
                    </button>
                  ) : undefined,
                ),
              )}
            </ul>
          </section>
        ))}
      </Panel>
      <div className="rec-stack">
      <Panel title={t('awaiting')} action={<span className="rec-count rec-count-warn">{awaiting.length}</span>}>
        {awaiting.length === 0 && <p className="rec-empty">{t('nothingAwaiting')}</p>}
        <ul className="rec-slots rec-slots-compact">
          {awaiting.map((i) =>
            interviewLine(
              i,
              writable ? (
                <button className="rec-small-button" onClick={() => open({ type: 'scorecard', interview: i })}>
                  {t('recordScorecard')}
                </button>
              ) : (
                <span className="rec-muted rec-small">{dateLabel(i.scheduled_at, locale)}</span>
              ),
            ),
          )}
        </ul>
      </Panel>
      <Panel title={t('recentScores')}>
        <ul className="rec-scorecards rec-scorecards-single">
          {recent.map((i) => {
            const application = view.applications.get(i.application_id)
            return (
              <ScorecardItem
                key={i.id}
                interview={i}
                person={application ? personOf(application)?.name : undefined}
                job={application ? jobTitle(application.job_id) : ''}
                locale={locale}
                t={t}
                now={now}
              />
            )
          })}
        </ul>
      </Panel>
      </div>
    </div>
  )

  // ── Reports ───────────────────────────────────────────────────────────────────────────────────
  const scope = reportJob || undefined
  const scoped = scope ? data.applications.filter((a) => a.job_id === scope) : data.applications
  const steps = funnel(data, scope)
  const times = timeInStage(data, scope)
  const channel = sourceStats(data, scope)
  const months = lastMonths(dayOf(now).slice(0, 7), 4)
  const monthly = hiresByMonth(data, months, scope)
  const scopedHireDays = median(timeToHire(data, scope))
  const bestRate = Math.max(0, ...channel.map((r) => r.hireRate ?? 0))
  const reports = (
    <>
      <div className="rec-board-head">
        <Choice
          label={t('allJobs')}
          value={reportJob}
          onChange={setReportJob}
          options={[['', t('allJobs')], ...nonDraft.map((j): [string, string] => [j.id, localizedTitle(j, locale)])]}
        />
      </div>
      <section className="rec-kpis">
        <Kpi label={t('totalApplications')} value={String(scoped.length)} />
        <Kpi label={t('hires')} value={String(scoped.filter((a) => a.stage === 'hired').length)} accent />
        <Kpi label={t('timeToHire')} value={scopedHireDays === null ? '—' : String(Math.round(scopedHireDays))} hint={t('daysUnit')} />
        <Kpi label={t('offerAcceptance')} value={percent(offerAcceptance(data, scope))} />
      </section>
      <div className="rec-grid">
        <Panel title={t('funnel')} className="rec-span-2" action={<span className="rec-muted rec-small">{t('funnelHint')}</span>}>
          <FunnelBars steps={steps} t={t} />
        </Panel>
        <Panel title={t('hiresByMonth')}>
          <HiresChart rows={monthly} locale={locale} t={t} />
        </Panel>
        <Panel title={t('stageTime')} action={<span className="rec-muted rec-small">{t('stageTimeHint')}</span>}>
          <ul className="rec-durations">
            {times.map((s) => {
              const longest = Math.max(1, ...times.map((x) => x.median ?? 0))
              return (
                <li key={s.stage}>
                  <span>{t(s.stage)}</span>
                  <div className="rec-bar">
                    <i className={`rec-fill-${s.stage}`} style={{ width: `${s.median === null ? 0 : Math.max(3, (s.median / longest) * 100)}%` }} />
                  </div>
                  <strong>
                    {s.median === null ? '—' : s.median.toFixed(1)}
                    <em> {t('dayShort')}</em>
                  </strong>
                </li>
              )
            })}
          </ul>
        </Panel>
        <Panel title={t('sources')} className="rec-span-2">
          <div className="rec-table-scroll">
            <table className="rec-table">
              <thead>
                <tr>
                  <th>{t('source')}</th>
                  <th>{t('candidates')}</th>
                  <th>{t('totalApplications')}</th>
                  <th>{t('interviewed')}</th>
                  <th>{t('hires')}</th>
                  <th>{t('hireRate')}</th>
                </tr>
              </thead>
              <tbody>
                {channel.map((row) => (
                  <tr key={row.source}>
                    <td>
                      <span className={`rec-source rec-source-${row.source}`}>{t(row.source)}</span>
                    </td>
                    <td>{row.candidates}</td>
                    <td>{row.applications}</td>
                    <td>
                      {row.interviewed}
                      <em> · {percent(row.applications ? row.interviewed / row.applications : null)}</em>
                    </td>
                    <td>{row.hired}</td>
                    <td>
                      <div className="rec-rate">
                        <div className="rec-bar">
                          <i style={{ width: `${bestRate ? ((row.hireRate ?? 0) / bestRate) * 100 : 0}%` }} />
                        </div>
                        {percent(row.hireRate)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  )

  const content = {
    jobs: jobDetail?.body ?? jobsList,
    pipeline: board,
    candidates: directory,
    interviews,
    reports,
  }[page]
  const index = navigation.findIndex(([id]) => id === page) + 1
  return (
    <div className="recruiting-app">
      <header className="rec-masthead">
        <div className="rec-brand">
          <span className="rec-mark">h</span>
          {t('brand')}
        </div>
        <nav>
          {navigation.map(([id, Icon]) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setPage(id)
                if (id === 'jobs') setJobId('')
              }}
            >
              <Icon size={16} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
        <div className="rec-toolbar">
          <div className="rec-language" aria-label={t('language')}>
            {(['zh', 'en'] as const).map((l) => (
              <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
          <button className="rec-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
            <RefreshCw size={16} />
          </button>
        </div>
      </header>
      {data.readOnly && (
        <div className="rec-demo">
          <span className="rec-pulse" />
          {t('readonly')}
        </div>
      )}
      <main className="rec-main">
        <div className="rec-title">
          {page === 'jobs' && jobDetail ? (
            jobDetail.head
          ) : (
            <div>
              <p className="rec-eyebrow">
                {String(index).padStart(2, '0')} — {t(page)}
              </p>
              <h1>{t(page)}</h1>
              <p>{t(`${page}Lead`)}</p>
            </div>
          )}
          {page === 'jobs' && jobDetail?.actions}
          {writable && (
            <div className="rec-toolbar">
              {page === 'jobs' && !jobDetail && (
                <button className="rec-primary" onClick={() => open({ type: 'job', newId: newId() })}>
                  <Plus size={16} />
                  {t('newJob')}
                </button>
              )}
              {page === 'candidates' && (
                <button className="rec-primary" onClick={() => open({ type: 'candidate', newId: newId(), applicationId: newId() })}>
                  <UserPlus size={16} />
                  {t('addCandidate')}
                </button>
              )}
              {page === 'interviews' && (
                <button className="rec-primary" onClick={() => open({ type: 'schedule', newId: newId() })}>
                  <CalendarClock size={16} />
                  {t('schedule')}
                </button>
              )}
            </div>
          )}
        </div>
        {content}
      </main>
      {notice && (
        <div className="rec-toast" role="status">
          {t(notice)}
          <button className="rec-icon" onClick={() => setNotice('')} aria-label={t('cancel')}>
            <X size={14} />
          </button>
        </div>
      )}
      {form && (
        <Modal
          title={
            form.type === 'job'
              ? t(form.job ? 'editJob' : 'newJob')
              : form.type === 'candidate'
                ? t(form.candidate ? 'editCandidate' : 'addCandidate')
                : form.type === 'apply'
                  ? `${t('applyToJob')} · ${form.candidate.name}`
                  : form.type === 'move'
                    ? form.to === 'hired'
                      ? t('hireAction')
                      : form.to === 'rejected'
                        ? t('reject')
                        : t('move')
                    : form.type === 'reject-remaining'
                      ? t('rejectRemaining')
                      : form.type === 'schedule'
                        ? t('schedule')
                        : form.type === 'scorecard'
                          ? t('recordScorecard')
                          : t('deleteCandidate')
          }
          onClose={() => !busy && setForm(null)}
        >
          {form.type === 'job' && (
            <JobForm job={form.job} t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(input, status) =>
                void run(form.job ? { action: 'update-job', id: form.job.id, ...input } : { action: 'create-job', id: form.newId, status, ...input })
              }
            />
          )}
          {form.type === 'candidate' && (
            <CandidateForm candidate={form.candidate} jobs={data.jobs.filter((j) => j.status === 'open')} locale={locale} t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={async (input, applyTo) => {
                if (form.candidate) return void run({ action: 'update-candidate', id: form.candidate.id, ...input })
                // Two statements: the person, then the application. If the second fails the
                // person is still saved, and a notice says why the application was not.
                if (!(await run({ action: 'add-candidate', id: form.newId, ...input }))) return
                setCandidateId(form.newId)
                if (applyTo) await run({ action: 'apply', id: form.applicationId, jobId: applyTo, candidateId: form.newId, appliedOn: dayOf(new Date()) }, false)
              }}
            />
          )}
          {form.type === 'apply' && (
            <ApplyForm
              jobs={data.jobs.filter((j) => j.status === 'open' && !data.applications.some((a) => a.candidate_id === form.candidate.id && a.job_id === j.id))}
              locale={locale} t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(jobId) => void run({ action: 'apply', id: form.newId, jobId, candidateId: form.candidate.id, appliedOn: dayOf(new Date()) })}
            />
          )}
          {form.type === 'move' && (
            <MoveForm
              application={form.application}
              initial={form.to}
              label={describeApplication(form.application)}
              job={view.jobs.get(form.application.job_id)}
              hired={hiredFor(data, form.application.job_id)}
              t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(to, reason) => void run({ action: 'move', id: form.application.id, from: form.application.stage, to, reason })}
            />
          )}
          {form.type === 'reject-remaining' && (
            <ReasonForm
              hint={t('rejectRemainingHint').replace('{n}', String(data.applications.filter((a) => a.job_id === form.job.id && isActive(a)).length))}
              initial="filled" t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(reason) => void run({ action: 'reject-remaining', jobId: form.job.id, reason })}
            />
          )}
          {form.type === 'schedule' && (
            <ScheduleForm
              options={data.applications
                .filter((a) => a.stage === 'screening' || a.stage === 'interview' || a.stage === 'offer' || a.stage === 'applied')
                .map((a): [string, string] => [a.id, describeApplication(a)])
                .sort((a, b) => a[1].localeCompare(b[1]))}
              initial={form.applicationId} now={now} t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(input) => void run({ action: 'schedule-interview', id: form.newId, ...input })}
            />
          )}
          {form.type === 'scorecard' && (
            <ScorecardForm
              label={(() => {
                const application = view.applications.get(form.interview.application_id)
                return `${application ? describeApplication(application) : ''} · ${kindLabel(form.interview.kind, t)}`
              })()}
              interview={form.interview} t={t} busy={busy} error={formError} onCancel={() => setForm(null)}
              onSubmit={(input) => void run({ action: 'record-scorecard', id: form.interview.id, ...input })}
            />
          )}
          {form.type === 'delete-candidate' && (
            <form
              className="rec-form"
              onSubmit={(e) => {
                e.preventDefault()
                void run({ action: 'delete-candidate', id: form.candidate.id }).then((ok) => ok && setCandidateId(''))
              }}
            >
              <p className="rec-muted">{t('deleteConfirm').replace('{name}', form.candidate.name)}</p>
              <Actions t={t} busy={busy} error={formError} onCancel={() => setForm(null)} submit={t('delete')} danger />
            </form>
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────

function Panel({ title, action, className = '', children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`rec-panel ${className}`}>
      {(title || action) && (
        <header>
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

function Kpi({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`rec-kpi${accent ? ' is-accent' : ''}`}>
      <span>{label}</span>
      <strong>
        {value}
        {hint && <em>{hint}</em>}
      </strong>
    </div>
  )
}

function Avatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const hue = hueOf(name)
  return (
    <span className={`rec-avatar rec-avatar-${size}`} style={{ background: `hsl(${hue} 52% 88%)`, color: `hsl(${hue} 45% 28%)` }} aria-hidden>
      {initials(name)}
    </span>
  )
}

function StagePill({ stage, t }: { stage: Stage; t: T }) {
  return <span className={`rec-pill rec-pill-${stage}`}>{t(stage)}</span>
}

function StatusPill({ status, t }: { status: JobStatus; t: T }) {
  return <span className={`rec-status rec-status-${status}`}>{t(status)}</span>
}

function StageLegend({ t }: { t: T }) {
  return (
    <span className="rec-strip rec-legend">
      {pipeline.map((stage) => (
        <span key={stage} title={t(stage)}>
          <i className={`rec-dot rec-dot-${stage}`} />
          {t(stage)}
        </span>
      ))}
    </span>
  )
}

function StageStrip({ counts, t }: { counts: Record<Stage, number>; t: T }) {
  return (
    <span className="rec-strip">
      {pipeline.map((stage) => (
        <span key={stage} className={counts[stage] ? '' : 'is-zero'} title={t(stage)}>
          <i className={`rec-dot rec-dot-${stage}`} />
          {counts[stage]}
        </span>
      ))}
    </span>
  )
}

function Seats({ hired, total, t, wide }: { hired: number; total: number; t: T; wide?: boolean }) {
  const shown = Math.min(total, 8)
  return (
    <span className={`rec-seats${wide ? ' is-wide' : ''}`} title={t('seatsFilled')}>
      <span className="rec-seat-dots">
        {Array.from({ length: shown }, (_, i) => (
          <i key={i} className={i < hired ? 'is-filled' : ''} />
        ))}
      </span>
      <b>
        {hired}/{total}
      </b>
      {wide && <em>{t('seats')}</em>}
    </span>
  )
}

function Stars({ value, onChange }: { value: number | null; onChange?: (rating: number) => void }) {
  return (
    <span className={`rec-stars${onChange ? ' is-editable' : ''}`} aria-label={value ? `${value}/5` : undefined}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" className={value !== null && n <= value ? 'is-on' : ''} onClick={() => onChange(n)} aria-label={`${n}/5`}>
            <Star size={13} />
          </button>
        ) : (
          <Star key={n} size={11} className={value !== null && n <= value ? 'is-on' : ''} />
        ),
      )}
    </span>
  )
}

function ScoreDots({ score }: { score: number | null }) {
  return (
    <span className="rec-score" aria-label={score === null ? undefined : `${score}/4`}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={score !== null && n <= score ? `is-on is-${score}` : ''} />
      ))}
    </span>
  )
}

function ScorecardItem({
  interview: i,
  person,
  job,
  locale,
  t,
  now,
  onRecord,
}: {
  interview: Interview
  person?: string
  job: string
  locale: Locale
  t: T
  now: Date
  onRecord?: () => void
}) {
  const future = Date.parse(i.scheduled_at) >= now.getTime()
  return (
    <li className="rec-scorecard">
      <header>
        <strong>{person ? `${person} · ${kindLabel(i.kind, t)}` : kindLabel(i.kind, t)}</strong>
        <time>
          {dateLabel(i.scheduled_at, locale)} {timeLabel(i.scheduled_at, locale)}
        </time>
      </header>
      <span className="rec-muted rec-small">
        {job} · {i.interviewer}
      </span>
      {i.score !== null ? (
        <>
          <div className="rec-verdict">
            <ScoreDots score={i.score} />
            <span className={`rec-vote rec-vote-${i.recommendation}`}>{t(i.recommendation ?? '')}</span>
          </div>
          {i.feedback && <blockquote>{i.feedback}</blockquote>}
        </>
      ) : future ? (
        <span className="rec-pill rec-pill-screening">{t('upcoming')}</span>
      ) : onRecord ? (
        <button className="rec-small-button" onClick={onRecord}>
          {t('recordScorecard')}
        </button>
      ) : (
        <span className="rec-pill rec-pill-offer">{t('awaiting')}</span>
      )}
    </li>
  )
}

function FunnelBars({ steps, counts, t, compact }: { steps: ReturnType<typeof funnel>; counts?: Record<Stage, number>; t: T; compact?: boolean }) {
  // With `counts` it shows where people are now; without, how far applications got.
  const value = (s: (typeof steps)[number]) => (counts ? counts[s.stage] : s.reached)
  const top = Math.max(1, ...steps.map(value))
  return (
    <ol className={`rec-funnel${compact ? ' is-compact' : ''}`}>
      {steps.map((s) => (
        <li key={s.stage}>
          <span className="rec-funnel-label">
            <i className={`rec-dot rec-dot-${s.stage}`} />
            {t(s.stage)}
          </span>
          <div className="rec-funnel-track">
            <i className={`rec-fill-${s.stage}`} style={{ width: `${value(s) ? Math.max(3, (value(s) / top) * 100) : 0}%` }} />
          </div>
          <strong>{value(s)}</strong>
          {!compact && <em>{s.conversion === null ? '' : `${percent(s.conversion)} ${t('ofPrevious')}`}</em>}
        </li>
      ))}
      {counts && (
        <li className="rec-funnel-rejected">
          <span className="rec-funnel-label">
            <i className="rec-dot rec-dot-rejected" />
            {t('rejected')}
          </span>
          <div />
          <strong>{counts.rejected}</strong>
        </li>
      )}
    </ol>
  )
}

function HiresChart({ rows, locale, t }: { rows: ReturnType<typeof hiresByMonth>; locale: Locale; t: T }) {
  const width = 320
  const height = 190
  const pad = { top: 22, right: 6, bottom: 26, left: 6 }
  const top = Math.max(2, ...rows.map((r) => r.hires))
  const band = (width - pad.left - pad.right) / rows.length
  const bar = Math.min(30, band * 0.56)
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom)
  return (
    <figure className="rec-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('hiresByMonth')}>
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="rec-baseline" />
        {rows.map((r, i) => {
          const x = pad.left + band * i + band / 2
          return (
            <g key={r.month}>
              {r.hires > 0 ? (
                <rect x={x - bar / 2} y={y(r.hires)} width={bar} height={y(0) - y(r.hires)} rx={4} className="rec-chart-bar">
                  <title>{`${monthLabel(r.month, locale)} · ${r.hires}`}</title>
                </rect>
              ) : (
                <rect x={x - bar / 2} y={y(0) - 2} width={bar} height={2} rx={1} className="rec-chart-zero" />
              )}
              <text x={x} y={y(r.hires) - 7} textAnchor="middle" className="rec-chart-value">
                {r.hires}
              </text>
              <text x={x} y={height - 7} textAnchor="middle" className="rec-chart-axis">
                {monthLabel(r.month, locale)}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger aria-label={label} className="rec-select">
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="rec-select-popup" positionerClassName="rec-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'all'} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="rec-modal-backdrop" />
        <Dialog.Popup className="recruiting-app rec-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="rec-icon rec-modal-close" aria-label="Close">
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A label around one input; `group` for a row of buttons, which a label would hijack clicks for. */
function Field({ label, hint, group, children }: { label: string; hint?: string; group?: boolean; children: ReactNode }) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className="rec-field" role={group ? 'group' : undefined} aria-label={group ? label : undefined}>
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </Tag>
  )
}

function Actions({ t, busy, error, onCancel, submit, danger }: { t: T; busy: boolean; error: string; onCancel: () => void; submit?: string; danger?: boolean }) {
  return (
    <>
      {error && <p className="rec-error">{t(error)}</p>}
      <div className="rec-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className={danger ? 'rec-primary rec-danger-fill' : 'rec-primary'} disabled={busy}>
          {busy ? t('saving') : (submit ?? t('save'))}
        </button>
      </div>
    </>
  )
}

/** Runs the shared rules before submitting, so the dialog can say what is wrong right away. */
function useCheck(error: string) {
  const [local, setLocal] = useState('')
  const check = (action: RecruitingAction) => {
    try {
      validate(action)
      setLocal('')
      return true
    } catch (e) {
      setLocal(e instanceof Error ? e.message : 'generic_error')
      return false
    }
  }
  return { check, shown: local || error }
}

function Segments<V extends string>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div className="rec-segments" role="tablist">
      {options.map(([id, text]) => (
        <button type="button" role="tab" key={id} aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function JobForm({
  job,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  job?: Job
  t: T
  busy: boolean
  error: string
  onSubmit: (input: { title: string; title_en: string; department: string; location: string; employment: Job['employment']; headcount: number }, status: 'draft' | 'open') => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(job?.title ?? '')
  const [titleEn, setTitleEn] = useState(job?.title_en ?? '')
  const [department, setDepartment] = useState(job?.department ?? '')
  const [location, setLocation] = useState(job?.location ?? '')
  const [employment, setEmployment] = useState<Job['employment']>(job?.employment ?? 'full_time')
  const [headcount, setHeadcount] = useState(String(job?.headcount ?? 1))
  const [status, setStatus] = useState<'draft' | 'open'>('open')
  const { check, shown } = useCheck(error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input = { title, title_en: titleEn, department, location, employment, headcount: Number(headcount) }
    if (check({ action: 'create-job', id: '', status, ...input })) onSubmit(input, status)
  }
  return (
    <form onSubmit={submit} className="rec-form">
      <div className="rec-form-row">
        <Field label={t('title')}>
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label={t('titleEn')}>
          <input maxLength={120} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
        </Field>
      </div>
      <div className="rec-form-row">
        <Field label={t('department')}>
          <input required maxLength={80} value={department} onChange={(e) => setDepartment(e.target.value)} />
        </Field>
        <Field label={t('location')}>
          <input required maxLength={80} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <div className="rec-form-row">
        <Field label={t('employment')}>
          <Choice label={t('employment')} value={employment} onChange={(v) => setEmployment(v as Job['employment'])} options={employments.map((k): [string, string] => [k, t(k)])} />
        </Field>
        <Field label={t('headcount')} hint={t('headcountHint')}>
          <input type="number" min={1} max={500} step={1} required value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
        </Field>
      </div>
      {!job && <Segments value={status} onChange={setStatus} options={[['open', t('publishNow')], ['draft', t('saveDraft')]]} />}
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} />
    </form>
  )
}

function CandidateForm({
  candidate,
  jobs,
  locale,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  candidate?: Candidate
  jobs: Job[]
  locale: Locale
  t: T
  busy: boolean
  error: string
  onSubmit: (input: { name: string; email: string; phone: string; source: Source; current_title: string; notes: string }, applyTo: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(candidate?.name ?? '')
  const [email, setEmail] = useState(candidate?.email ?? '')
  const [phone, setPhone] = useState(candidate?.phone ?? '')
  const [source, setSource] = useState<Source>(candidate?.source ?? 'referral')
  const [title, setTitle] = useState(candidate?.current_title ?? '')
  const [notes, setNotes] = useState(candidate?.notes ?? '')
  const [applyTo, setApplyTo] = useState(jobs[0]?.id ?? '')
  const { check, shown } = useCheck(error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input = { name, email, phone, source, current_title: title, notes }
    if (check({ action: 'add-candidate', id: '', ...input })) onSubmit(input, candidate ? '' : applyTo)
  }
  return (
    <form onSubmit={submit} className="rec-form">
      <div className="rec-form-row">
        <Field label={t('name')}>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('currentTitle')}>
          <input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <div className="rec-form-row">
        <Field label={t('email')}>
          <input type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('phone')}>
          <input type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <div className="rec-form-row">
        <Field label={t('source')}>
          <Choice label={t('source')} value={source} onChange={(v) => setSource(v as Source)} options={sources.map((s): [string, string] => [s, t(s)])} />
        </Field>
        {!candidate && (
          <Field label={t('applyTo')}>
            <Choice label={t('applyTo')} value={applyTo} onChange={setApplyTo} options={[['', t('noJob')], ...jobs.map((j): [string, string] => [j.id, localizedTitle(j, locale)])]} />
          </Field>
        )}
      </div>
      <Field label={t('notes')}>
        <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} />
    </form>
  )
}

function ApplyForm({ jobs, locale, t, busy, error, onSubmit, onCancel }: { jobs: Job[]; locale: Locale; t: T; busy: boolean; error: string; onSubmit: (jobId: string) => void; onCancel: () => void }) {
  const [target, setTarget] = useState(jobs[0]?.id ?? '')
  return (
    <form
      className="rec-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (target) onSubmit(target)
      }}
    >
      <Field label={t('applyTo')}>
        <Choice label={t('applyTo')} value={target} onChange={setTarget} options={jobs.map((j): [string, string] => [j.id, localizedTitle(j, locale)])} />
      </Field>
      <Actions t={t} busy={busy} error={error} onCancel={onCancel} />
    </form>
  )
}

function ReasonPicker({ value, onChange, t }: { value: string; onChange: (reason: string) => void; t: T }) {
  const preset = (rejectionReasons as readonly string[]).includes(value)
  const [custom, setCustom] = useState(!preset && value !== '')
  return (
    <div className="rec-field" role="group" aria-label={t('reason')}>
      <span>{t('reason')}</span>
      <div className="rec-chips">
        {rejectionReasons.map((r) => (
          <button
            type="button"
            key={r}
            aria-pressed={!custom && value === r}
            onClick={() => {
              setCustom(false)
              onChange(r)
            }}
          >
            {reasonLabel(r, t)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom}
          onClick={() => {
            setCustom(true)
            onChange('')
          }}
        >
          {t('otherReason')}
        </button>
      </div>
      {custom && <input autoFocus maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('otherReason')} />}
    </div>
  )
}

function MoveForm({
  application,
  initial,
  label,
  job,
  hired,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  application: Application
  initial?: Stage
  label: string
  job?: Job
  hired: number
  t: T
  busy: boolean
  error: string
  onSubmit: (to: Stage, reason?: string) => void
  onCancel: () => void
}) {
  const [to, setTo] = useState<Stage>(initial ?? nextStage(application.stage) ?? 'screening')
  const [reason, setReason] = useState('')
  const { check, shown } = useCheck(error)
  const seat = hired + 1
  return (
    <form
      className="rec-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (check({ action: 'move', id: application.id, from: application.stage, to, reason })) onSubmit(to, to === 'rejected' ? reason : undefined)
      }}
    >
      <div className="rec-quote">
        <strong>{label}</strong>
        <span>
          {t(application.stage)} → {t(to)}
        </span>
      </div>
      {!initial && (
        <Field label={t('moveTo')}>
          <Choice
            label={t('moveTo')}
            value={to}
            onChange={(v) => setTo(v as Stage)}
            options={stages.filter((s) => s !== application.stage).map((s): [string, string] => [s, t(s)])}
          />
        </Field>
      )}
      {to === 'rejected' && <ReasonPicker value={reason} onChange={setReason} t={t} />}
      {to === 'hired' && job && (
        <p className="rec-warning">
          {t('hireConfirm').replace('{n}', String(seat)).replace('{total}', String(job.headcount))}
          {seat === job.headcount && <> {t('hireCloses')}</>}
        </p>
      )}
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} submit={to === 'hired' ? t('hireAction') : to === 'rejected' ? t('reject') : t('confirm')} danger={to === 'rejected'} />
    </form>
  )
}

function ReasonForm({ hint, initial, t, busy, error, onSubmit, onCancel }: { hint: string; initial: string; t: T; busy: boolean; error: string; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState(initial)
  const { check, shown } = useCheck(error)
  return (
    <form
      className="rec-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (check({ action: 'reject-remaining', jobId: '', reason })) onSubmit(reason)
      }}
    >
      <p className="rec-muted">{hint}</p>
      <ReasonPicker value={reason} onChange={setReason} t={t} />
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} submit={t('reject')} danger />
    </form>
  )
}

function ScheduleForm({
  options,
  initial,
  now,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  options: [string, string][]
  initial?: string
  now: Date
  t: T
  busy: boolean
  error: string
  onSubmit: (input: { applicationId: string; kind: InterviewKind; scheduledAt: string; interviewer: string }) => void
  onCancel: () => void
}) {
  const [applicationId, setApplicationId] = useState(initial ?? options[0]?.[0] ?? '')
  const [kind, setKind] = useState<InterviewKind>('technical')
  const [day, setDay] = useState(dayOf(new Date(now.getTime() + DAY)))
  const [time, setTime] = useState('10:00')
  const [interviewer, setInterviewer] = useState('')
  const { check, shown } = useCheck(error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const when = new Date(`${day}T${time}:00`)
    const input = { applicationId, kind, scheduledAt: Number.isNaN(when.getTime()) ? '' : when.toISOString(), interviewer }
    if (applicationId && check({ action: 'schedule-interview', id: '', ...input })) onSubmit(input)
  }
  return (
    <form onSubmit={submit} className="rec-form">
      <Field label={t('application')}>
        <Choice label={t('application')} value={applicationId} onChange={setApplicationId} options={options} />
      </Field>
      <Field label={t('kind')} group>
        <Segments value={kind} onChange={setKind} options={interviewKinds.map((k): [InterviewKind, string] => [k, kindLabel(k, t)])} />
      </Field>
      <div className="rec-form-row">
        <Field label={t('date')}>
          <input type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label={t('time')}>
          <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>
      <Field label={t('interviewer')}>
        <input required maxLength={120} value={interviewer} onChange={(e) => setInterviewer(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} />
    </form>
  )
}

function ScorecardForm({
  label,
  interview,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  label: string
  interview: Interview
  t: T
  busy: boolean
  error: string
  onSubmit: (input: { score: number; recommendation: Recommendation; feedback: string }) => void
  onCancel: () => void
}) {
  const [score, setScore] = useState(interview.score ?? 0)
  const [recommendation, setRecommendation] = useState<Recommendation>(interview.recommendation ?? 'yes')
  const [feedback, setFeedback] = useState(interview.feedback)
  const { check, shown } = useCheck(error)
  return (
    <form
      className="rec-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (check({ action: 'record-scorecard', id: interview.id, score, recommendation, feedback })) onSubmit({ score, recommendation, feedback })
      }}
    >
      <div className="rec-quote">
        <strong>{label}</strong>
        <span>{interview.interviewer}</span>
      </div>
      <Field label={t('score')} hint={t('scoreHint')} group>
        <div className="rec-score-picker">
          {[1, 2, 3, 4].map((n) => (
            <button type="button" key={n} aria-pressed={score === n} className={`is-${n}`} onClick={() => setScore(n)}>
              {n}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('recommendation')} group>
        <Segments value={recommendation} onChange={setRecommendation} options={recommendations.map((r): [Recommendation, string] => [r, t(r)])} />
      </Field>
      <Field label={t('feedback')}>
        <textarea rows={4} maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={shown} onCancel={onCancel} />
    </form>
  )
}
