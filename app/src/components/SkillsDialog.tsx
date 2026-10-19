import { useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Lock, Search, Trash2, Upload, Wand2 } from 'lucide-react'
import { SKILL_MAX_BYTES, type SkillCatalogueItem } from '@lovbase/core/skills'
import { deleteSkill, getSkills, importSkill, setSkillEnabled } from '../functions/skills'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

export function SkillsDialog({ open, onOpenChange, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId?: string
}) {
  const t = useT()
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden bg-panel p-0 text-fg sm:max-w-2xl">
      <div className="border-b border-edge px-6 py-5 pr-12">
        <DialogTitle className="flex items-center gap-2"><Wand2 className="size-4" />{t('skills.title', 'Skills')}</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-fg-dim">{t('skills.description', 'Enable skills for the agent to load when relevant. Your choices apply to future messages and are saved for this project.')}</DialogDescription>
      </div>
      {open && <SkillCatalogue key={projectId ?? 'home'} projectId={projectId} />}
    </DialogContent>
  </Dialog>
}

function SkillCatalogue({ projectId }: { projectId?: string }) {
  const t = useT()
  const list = useServerFn(getSkills), upload = useServerFn(importSkill)
  const toggle = useServerFn(setSkillEnabled), remove = useServerFn(deleteSkill)
  const [skills, setSkills] = useState<SkillCatalogueItem[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [deleting, setDeleting] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let alive = true
    void list({ data: { projectId } }).then(next => { if (alive) setSkills(next) })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [list, projectId, attempt])

  async function change(action: () => Promise<SkillCatalogueItem[]>, success = '') {
    setBusy(true); setError(''); setNotice('')
    try { setSkills(await action()); setNotice(success) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function importFile(file: File | undefined) {
    if (!file || !projectId) return
    if (file.name !== 'SKILL.md') { setError(t('skills.fileName', 'Choose a single file named SKILL.md.')); return }
    if (file.size > SKILL_MAX_BYTES) { setError(t('skills.fileSize', 'Skill must be 64 KiB or smaller.')); return }
    await change(async () => upload({ data: { projectId, fileName: 'SKILL.md', content: await file.text() } }),
      t('skills.imported', 'Skill imported and enabled for you.'))
  }
  const filtered = skills?.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const custom = skills?.filter(s => s.source === 'project') ?? []

  function section(source: SkillCatalogueItem['source'], title: string) {
    const entries = filtered.filter(s => s.source === source)
    return <section className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">{title}</h3>
      {entries.map(skill => <div key={skill.id} className="rounded-xl border border-edge bg-panel px-4 py-3">
        <div className="flex items-start gap-3">
          <label aria-label={skill.name} className="flex min-w-0 flex-1 items-start gap-3">
            <input type="checkbox" checked={skill.enabled} disabled={busy || !projectId || skill.alwaysEnabled}
              onChange={e => { if (projectId) void change(() => toggle({ data: { projectId, id: skill.id, enabled: e.target.checked } })) }}
              className="mt-1 size-4 shrink-0 accent-accent cursor-pointer disabled:cursor-default" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="break-all text-sm font-medium">{skill.name}</span>
                {skill.alwaysEnabled && <span className="inline-flex items-center gap-1 text-[10px] text-fg-dim"><Lock className="size-2.5" />{t('skills.alwaysEnabled', 'Always enabled')}</span>}
              </span>
              <span className="mt-1 block break-words text-xs leading-relaxed text-fg-dim">{t(`skills.builtin.${skill.name}`, skill.description)}</span>
            </span>
          </label>
          {skill.source === 'project' && <button type="button" disabled={busy} title={t('skills.delete', 'Delete skill')}
            aria-label={`${t('skills.delete', 'Delete skill')} ${skill.name}`} onClick={() => setDeleting(skill.id)}
            className="mt-0.5 rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-red-600 disabled:opacity-50 cursor-pointer"><Trash2 className="size-3.5" /></button>}
        </div>
        {deleting === skill.id && <div className="mt-3 border-t border-edge pt-3">
          <p className="text-xs text-fg-mid">{t('skills.deleteWarning', 'Delete this skill for the entire project? This also disables it for other users.')}</p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t('skills.cancel', 'Cancel')}</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={async () => {
              if (projectId) await change(() => remove({ data: { projectId, id: skill.id } }), t('skills.deleted', 'Skill deleted.'))
              setDeleting(null)
            }}>{t('skills.delete', 'Delete skill')}</Button>
          </div>
        </div>}
      </div>)}
      {!entries.length && <p className="rounded-xl border border-dashed border-edge p-4 text-xs text-fg-dim">{
        query.trim() ? t('skills.noMatches', 'No matching skills.') : t('skills.empty', 'Import a SKILL.md to add a project skill.')
      }</p>}
    </section>
  }

  return <>
    <div className="flex items-center gap-3 border-b border-edge px-6 py-3">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge px-3 py-2 text-fg-dim">
        <Search className="size-3.5 shrink-0" /><input value={query} onChange={e => setQuery(e.target.value)}
          aria-label={t('skills.search', 'Search skills')} placeholder={t('skills.search', 'Search skills')}
          className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-dim" />
      </label>
      <input ref={input} type="file" accept=".md,text/markdown" className="hidden" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; void importFile(file)
      }} />
      <Button variant="outline" size="sm" disabled={busy || !projectId || !skills} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}{t('skills.import', 'Import SKILL.md')}
      </Button>
    </div>
    <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-4" aria-busy={busy}>
      {!projectId && <p className="rounded-lg bg-panel-2 p-3 text-xs text-fg-dim">{t('skills.projectRequired', 'Open a project to import skills and save your choices.')}</p>}
      {error && <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-600">
        <p>{error}</p>{!skills && <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setError(''); setAttempt(n => n + 1) }}>{t('skills.retry', 'Try again')}</Button>}
      </div>}
      {notice && <output className="block text-xs text-emerald-600">{notice}</output>}
      {!skills && !error && <output className="flex items-center gap-2 py-6 text-xs text-fg-dim"><Loader2 className="size-4 animate-spin" />{t('skills.loading', 'Loading skills…')}</output>}
      {skills && <>
        {section('builtin', t('skills.builtin', 'Built-in skills'))}
        {projectId && section('project', `${t('skills.project', 'Project skills')} (${custom.length})`)}
      </>}
    </div>
    <div className="border-t border-edge px-6 py-3 text-[11px] leading-relaxed text-fg-dim">{t('skills.scope', 'Project skills are shared across its apps. Enabled skills are your personal preference. Single Markdown files only; supporting files and scripts are not imported.')}</div>
  </>
}
