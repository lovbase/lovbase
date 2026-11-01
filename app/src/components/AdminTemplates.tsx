import { useCallback, useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import type { CommunityTemplate, TemplateStatus } from '@lovbase/api'
import { adminDeleteTemplateCategory, adminReviewTemplate, adminSaveTemplateCategory, adminTemplates } from '../functions/templates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus } from 'lucide-react'
import { useI18n, useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'

type Data = Awaited<ReturnType<typeof adminTemplates>>
const NONE = '__none__'
const NEW = '__new__'
/** A category's id comes from its English name; nobody should have to invent a slug. */
const slug = (name: string) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `c-${Date.now().toString(36)}`

function CategoryForm({ initial, onSave, onCancel }: {
  initial?: { nameZh: string; nameEn: string }
  onSave: (c: { nameZh: string; nameEn: string }) => Promise<unknown>
  onCancel: () => void
}) {
  const t = useT()
  const [zh, setZh] = useState(initial?.nameZh ?? '')
  const [en, setEn] = useState(initial?.nameEn ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <form className="py-3 flex flex-wrap items-center gap-2" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true)
      try { await onSave({ nameZh: zh.trim(), nameEn: en.trim() }) } finally { setBusy(false) }
    }}>
      <Input autoFocus className="w-44 h-8" placeholder={t('tpl.admin.nameZh', 'Chinese name')} value={zh} onChange={(e) => setZh(e.target.value)} />
      <Input className="w-52 h-8" placeholder={t('tpl.admin.nameEn', 'English name')} value={en} onChange={(e) => setEn(e.target.value)} />
      <span className="flex-1" />
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('dialog.cancel', 'Cancel')}</Button>
      <Button type="submit" size="sm" disabled={busy || !zh.trim() || !en.trim()}>{t('account.save', 'Save')}</Button>
    </form>
  )
}
const FILTERS: (TemplateStatus | 'all')[] = ['pending', 'approved', 'rejected', 'all']

/** Admin: the review queue for community templates, and the categories the gallery filters by. */
export function AdminTemplates() {
  const t = useT()
  const { locale } = useI18n()
  const dialogs = useDialogs()
  const load = useServerFn(adminTemplates)
  const review = useServerFn(adminReviewTemplate)
  const saveCategory = useServerFn(adminSaveTemplateCategory)
  const deleteCategory = useServerFn(adminDeleteTemplateCategory)
  const [data, setData] = useState<Data | null>(null)
  const [filter, setFilter] = useState<TemplateStatus | 'all'>('pending')
  const [editing, setEditing] = useState<string | null>(null)
  const reload = useCallback(() => load().then(setData), [load])
  useEffect(() => { void reload() }, [reload])

  const fail = (e: unknown) => dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e instanceof Error ? e.message : String(e) })
  const act = (id: string, patch: Omit<Parameters<typeof review>[0]['data'], 'id'>) => review({ data: { id, ...patch } }).then(reload).catch(fail)
  const statusLabel = (s: TemplateStatus) => s === 'approved' ? t('tpl.status.approved', 'Live in the gallery') : s === 'rejected' ? t('tpl.status.rejected', 'Not approved') : t('tpl.status.pending', 'In review')

  const catName = (id: string) => {
    const c = data?.categories.find((x) => x.id === id)
    return c ? (locale === 'zh' ? c.nameZh : c.nameEn) : id
  }

  // A new category must not land on an existing id: saving is an upsert and would rename that one.
  const freeId = (base: string) => {
    const taken = new Set(data?.categories.map((c) => c.id))
    let id = base, n = 2
    while (taken.has(id)) id = `${base.slice(0, 37)}-${n++}`
    return id
  }

  if (!data) return <p className="text-[14px] text-fg-dim">{t('common.loading', 'Loading…')}</p>
  const shown = data.items.filter((x) => filter === 'all' || x.status === filter)
  const count = (s: TemplateStatus | 'all') => data.items.filter((x) => s === 'all' || x.status === s).length

  async function reject(item: CommunityTemplate) {
    const note = await dialogs.prompt({
      title: t('tpl.admin.rejectTitle', 'Reason for not approving'),
      description: t('tpl.admin.rejectDesc', 'The author sees this in the publish dialog.'),
      confirmLabel: t('tpl.admin.reject', 'Reject'),
    })
    if (note === null) return
    await act(item.id, { status: 'rejected', note })
  }

  return (
    <div className="space-y-12">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-edge">
          <h2 className="text-[15px] font-medium">{t('tpl.admin.queue', 'Community templates')}</h2>
          <div className="flex gap-1.5">
            {FILTERS.map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                className={`h-8 px-3 rounded-full text-[13px] cursor-pointer transition-colors ${filter === f ? 'bg-fg text-ink' : 'text-fg-mid hover:text-fg hover:bg-panel-2'}`}>
                {f === 'all' ? t('tpl.admin.all', 'All') : statusLabel(f)} <span className="tabular-nums opacity-60">{count(f)}</span>
              </button>
            ))}
          </div>
        </div>
        {!shown.length && <p className="py-10 text-center text-[14px] text-fg-dim">{t('tpl.admin.empty', 'Nothing here.')}</p>}
        <div className="divide-y divide-edge">
          {shown.map((item) => (
            <div key={item.id} className="py-5 flex gap-5">
              <div className="w-44 shrink-0 aspect-[1.65] rounded-lg border border-edge bg-panel-2 overflow-hidden">
                {item.coverUrl && <img src={item.coverUrl} alt="" className="w-full h-full object-cover object-top" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <a href={`/templates?community=${item.id}`} target="_blank" rel="noreferrer" className="text-[14.5px] font-medium hover:underline underline-offset-4">{item.name}</a>
                    <p className="text-[13px] text-fg-dim mt-0.5">
                      {item.author} · {item.tables} {t('tpl.tables', 'tables')} · {item.uses} {t('tpl.uses', 'uses')} · {item.updatedAt.slice(0, 10)}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[12.5px] ${item.status === 'approved' ? 'text-ok' : item.status === 'rejected' ? 'text-warn' : 'text-fg-mid'}`}>{statusLabel(item.status)}</span>
                </div>
                {item.description && <p className="text-[13.5px] text-fg-mid mt-2 line-clamp-2">{item.description}</p>}
                {item.status === 'rejected' && item.reviewNote && <p className="text-[13px] text-fg-dim mt-1.5">{t('tpl.admin.note', 'Note')}: {item.reviewNote}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select value={item.categoryId ?? NONE} onValueChange={(v) => act(item.id, { categoryId: v && v !== NONE ? String(v) : null })}>
                    <SelectTrigger size="sm" aria-label={t('tpl.field.category', 'Category')} className="min-w-32 border-edge bg-panel text-[13px]">
                      <SelectValue>{(v: string) => v === NONE ? <span className="text-fg-dim">{t('tpl.admin.noCategory', 'No category')}</span> : catName(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false} className="p-1">
                      <SelectItem value={NONE} className="pl-2.5 py-1.5 text-[13px] text-fg-dim">{t('tpl.admin.noCategory', 'No category')}</SelectItem>
                      {data.categories.length > 0 && <SelectSeparator className="my-1" />}
                      {data.categories.map((c) => <SelectItem key={c.id} value={c.id} className="pl-2.5 py-1.5 text-[13px]">{locale === 'zh' ? c.nameZh : c.nameEn}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {item.tags.map((tag) => <span key={tag} className="h-6 px-2 inline-flex items-center rounded-md bg-panel-2 text-[12px] text-fg-mid">{tag}</span>)}
                  <span className="flex-1" />
                  {item.status === 'approved' && (
                    <label className="flex items-center gap-2 text-[13px] text-fg-mid mr-2">
                      <Switch checked={item.featured} onCheckedChange={(v) => act(item.id, { featured: v })} />
                      {t('tpl.admin.featured', 'Featured')}
                    </label>
                  )}
                  {item.status !== 'rejected' && <Button variant="outline" size="sm" onClick={() => reject(item)}>{t('tpl.admin.reject', 'Reject')}</Button>}
                  {item.status !== 'approved' && <Button size="sm" onClick={() => act(item.id, { status: 'approved', note: null })}>{t('tpl.admin.approve', 'Approve')}</Button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between pb-3 border-b border-edge">
          <h2 className="text-[15px] font-medium">{t('tpl.admin.categories', 'Categories')}</h2>
          {editing !== NEW && <Button size="sm" variant="outline" onClick={() => setEditing(NEW)}><Plus className="size-3.5" /> {t('tpl.admin.newCategory', 'New category')}</Button>}
        </div>
        <div className="divide-y divide-edge">
          {editing === NEW && (
            <CategoryForm onCancel={() => setEditing(null)} onSave={(c) => saveCategory({ data: { id: freeId(slug(c.nameEn)), ...c, sort: (data.categories.at(-1)?.sort ?? 0) + 10 } })
              .then(() => { setEditing(null); return reload() }).catch(fail)} />
          )}
          {data.categories.map((c) => editing === c.id ? (
            <CategoryForm key={c.id} initial={c} onCancel={() => setEditing(null)} onSave={(next) => saveCategory({ data: { id: c.id, sort: c.sort, ...next } })
              .then(() => { setEditing(null); return reload() }).catch(fail)} />
          ) : (
            <div key={c.id} className="py-3 flex items-center gap-4">
              <span className="flex-1 text-[14px]">{c.nameZh} <span className="text-fg-dim">· {c.nameEn}</span></span>
              <span className="text-[13px] text-fg-dim tabular-nums">{t('tpl.admin.inCategory', '{n} templates').replace('{n}', String(data.items.filter((x) => x.categoryId === c.id).length))}</span>
              <button type="button" className="text-[13px] text-fg-mid hover:text-fg cursor-pointer" onClick={() => setEditing(c.id)}>{t('admin.price.edit', 'Edit')}</button>
              <button type="button" className="text-[13px] text-fg-dim hover:text-warn cursor-pointer" onClick={async () => {
                if (!(await dialogs.confirm({ title: t('tpl.admin.deleteCategory', 'Delete this category?'), description: t('tpl.admin.deleteCategoryDesc', 'Templates in it become uncategorised.'), destructive: true }))) return
                await deleteCategory({ data: { id: c.id } }).then(reload).catch(fail)
              }}>{t('tpl.admin.delete', 'Delete')}</button>
            </div>
          ))}
          {!data.categories.length && editing !== NEW && <p className="py-6 text-center text-[13.5px] text-fg-dim">{t('tpl.admin.noCategories', 'No categories yet.')}</p>}
        </div>
      </section>
    </div>
  )
}
