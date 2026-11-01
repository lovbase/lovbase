import { useEffect, useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import type { LlmCatalogEntry, LlmPing } from '@lovbase/api'
import { TIERS, TIER_LABEL, type Tier } from '@lovbase/core/billing'
import { adminClearLlm, adminListModels, adminSaveLlm, adminTestLlm } from '../functions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '../lib/i18n'
import { Check, PROVIDERS, ProviderGrid, type ProviderId } from './model-providers'


type Llm = { baseUrl: string; hasKey: boolean; key: { state: 'none' | 'ok' | 'env' | 'unreadable'; hint?: string }; models: string[]; tiers: Record<Tier, string>; defaultTier: Tier; effective: string; fromEnv: boolean }

const NONE = '__none__'

export function AdminModelSettings({ llm }: { llm: Llm }) {
  const { t, locale } = useI18n()
  const router = useRouter()
  const listModels = useServerFn(adminListModels)
  const testLlm = useServerFn(adminTestLlm)
  const saveLlm = useServerFn(adminSaveLlm)
  const clearLlm = useServerFn(adminClearLlm)

  const [provider, setProvider] = useState<ProviderId>(() => llm.baseUrl ? PROVIDERS.find((p) => p.url === llm.baseUrl)?.id ?? 'custom' : 'vercel')
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl || PROVIDERS[0].url)
  const [apiKey, setApiKey] = useState('')
  const [catalog, setCatalog] = useState<LlmCatalogEntry[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [models, setModels] = useState<string[]>(llm.models)
  const [tiers, setTiers] = useState<Record<string, string>>(llm.tiers)
  const [defaultTier, setDefaultTier] = useState<Tier>(llm.defaultTier)
  const [pings, setPings] = useState<LlmPing[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const preset = PROVIDERS.find((p) => p.id === provider)
  const prices = useMemo(() => new Map(catalog?.map((m) => [m.id, m])), [catalog])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (catalog ?? []).filter((m) => !q || m.id.toLowerCase().includes(q)).slice(0, 200)
  }, [catalog, query])
  const picked = shown.filter((m) => models.includes(m.id)).length
  const allShown = shown.length > 0 && picked === shown.length
  const tierModels = TIERS.map((x) => tiers[x]?.trim()).filter(Boolean) as string[]

  /** A different endpoint or key makes the fetched list and the test results about something else. */
  function stale() { setCatalog(null); setCatalogError(''); setPings(null) }

  function pick(id: ProviderId) {
    if (id === provider) return
    setProvider(id); stale()
    const p = PROVIDERS.find((x) => x.id === id)
    const url = p ? p.url : PROVIDERS.some((x) => x.url === llm.baseUrl) ? '' : llm.baseUrl
    setBaseUrl(url)
    // Model ids belong to an endpoint: another provider's names would only fail there. Coming back
    // to the saved provider brings its list back.
    const saved = !!llm.baseUrl && url === llm.baseUrl
    setModels(saved ? llm.models : []); setTiers(saved ? llm.tiers : {})
  }

  async function fetchModels() {
    setFetching(true); stale()
    try { setCatalog(await listModels({ data: { baseUrl, apiKey } })) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setCatalogError(m.includes('KEY_UNREADABLE') ? t('admin.llm.keyUnreadable', 'The saved key can no longer be decrypted (the encryption key changed). Enter it again.') : m)
    }
    finally { setFetching(false) }
  }

  // A saved setup opens with its catalog already loaded: the key is on the server, so there is
  // nothing for the admin to retype just to see prices or pick a different model.
  const keyUsable = llm.key.state === 'ok' || llm.key.state === 'env'
  useEffect(() => { if (llm.baseUrl && keyUsable) void fetchModels() }, [])

  const keyPlaceholder = llm.key.state === 'unreadable' ? t('account.byok.reenter', 'Enter it again')
    : keyUsable ? `${t('admin.llm.keySaved', 'Saved')}${llm.key.hint ? ` ····${llm.key.hint}` : ''}${llm.key.state === 'env' ? ` (${t('admin.llm.env', 'env')})` : ''} · ${t('admin.llm.keyKeep', 'leave empty to keep')}`
    : 'sk-…'

  function toggle(id: string) {
    setModels((v) => v.includes(id) ? v.filter((m) => m !== id) : [...v, id])
    if (models.includes(id)) setTiers((v) => Object.fromEntries(Object.entries(v).map(([k, m]) => [k, m === id ? '' : m])))
  }

  /** Select all acts on what the search shows, so "search claude, select all" adds just those. */
  function toggleAll() {
    const ids = shown.map((m) => m.id)
    if (allShown) {
      setModels((v) => v.filter((m) => !ids.includes(m)))
      setTiers((v) => Object.fromEntries(Object.entries(v).map(([k, m]) => [k, ids.includes(m) ? '' : m])))
    } else setModels((v) => [...v, ...ids.filter((m) => !v.includes(m))])
  }

  function addManual() {
    const id = manual.trim()
    if (id && !models.includes(id)) setModels((v) => [...v, id])
    setManual('')
  }

  async function test() {
    setTesting(true); setPings(null)
    try { setPings(await testLlm({ data: { baseUrl, apiKey, models: tierModels } })) }
    catch (e) { setPings([{ model: '—', ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) }]) }
    finally { setTesting(false) }
  }

  async function save() {
    setBusy(true); setMsg('')
    const priced = Object.fromEntries(tierModels.flatMap((m) => {
      const p = prices.get(m)
      return p?.inPer1M != null && p.outPer1M != null ? [[m, { inPer1M: p.inPer1M, outPer1M: p.outPer1M, cachedInPer1M: p.cachedInPer1M }]] : []
    }))
    try { await saveLlm({ data: { baseUrl, apiKey, models, tiers, defaultTier, prices: priced } }); setApiKey(''); setMsg(t('admin.llm.saved', 'Saved, in effect for every user')); router.invalidate() }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const price = (id: string) => {
    const p = prices.get(id)
    return p?.inPer1M != null ? `$${p.inPer1M} / $${p.outPer1M}` : ''
  }

  return (
    <section className="rounded-xl border border-edge overflow-hidden">
      <div className="px-5 py-4 border-b border-edge flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium">{t('admin.llm.title', 'Platform model')}</h2>
          <p className="text-[12.5px] text-fg-dim mt-1">{t('admin.llm.sub', 'Every user’s generation runs on the model configured here. Any OpenAI-compatible endpoint; the key is stored encrypted.')}</p>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-edge text-[12px] text-fg-mid">
          <span className={`size-1.5 rounded-full ${llm.effective ? 'bg-ok' : 'bg-warn'}`} />
          {llm.effective ? <span className="font-mono text-fg">{llm.effective}</span> : t('account.notConfigured', 'Not configured')}
          {llm.fromEnv && <span className="text-fg-dim">· {t('admin.llm.env', 'env')}</span>}
        </span>
      </div>
      <div className="p-5 space-y-7">

      <Step n={1} title={t('admin.llm.step.connect', 'Connect a provider')}>
        <ProviderGrid value={provider} onChange={pick} />
        <label className="block">
          <span className="eyebrow block mb-1.5">Base URL</span>
          <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); stale() }} readOnly={!!preset}
            placeholder="https://your-endpoint/v1" className={`font-mono placeholder:font-sans ${preset ? 'text-fg-dim bg-fg/[.03]' : ''}`} />
        </label>
        <div>
          <span className="flex items-center gap-2 mb-1.5">
            <span className="eyebrow">API key</span>
            {preset && <a href={preset.keys} target="_blank" rel="noreferrer" className="text-[12px] text-fg-mid hover:text-fg">{t('admin.llm.getKey', 'Get an API key')} ↗</a>}
          </span>
          <div className="flex gap-2">
            <Input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); stale() }} aria-label="API key"
              placeholder={keyPlaceholder} className="font-mono placeholder:font-sans" />
            <Button variant="outline" onClick={fetchModels} disabled={fetching || !baseUrl}>{fetching ? t('admin.llm.fetching', 'Fetching…') : t('admin.llm.fetch', 'Fetch models')}</Button>
          </div>
          {catalogError ? <p className="mt-2 text-[12px] text-warn break-words">{catalogError}</p>
            : llm.key.state === 'unreadable' && !apiKey && <p className="mt-2 text-[12px] text-warn">{t('admin.llm.keyUnreadable', 'The saved key can no longer be decrypted (the encryption key changed). Enter it again.')}</p>}
          {fetching && !catalog && <p className="mt-2 text-[12px] text-fg-dim">{t('admin.llm.fetching', 'Fetching…')}</p>}
        </div>
      </Step>

      <Step n={2} title={t('admin.llm.step.models', 'Add models')} hint={t('admin.llm.step.modelsHint', 'Only added models can be put behind a tier.')}>
        {catalog && (
          <div className="rounded-lg border border-edge">
            <div className="p-2 border-b border-edge">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('admin.llm.search', 'Search {n} models').replace('{n}', String(catalog.length))} className="h-8" />
            </div>
            {shown.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-1.5 border-b border-edge">
                <button type="button" onClick={toggleAll} className="flex items-center gap-3 text-[12.5px] text-fg-mid hover:text-fg">
                  <Check state={allShown ? 'on' : picked ? 'some' : 'off'} />
                  {query.trim() ? t('admin.llm.selectMatches', 'Select all {n} matches').replace('{n}', String(shown.length)) : t('admin.llm.selectAll', 'Select all')}
                </button>
                <span className="ml-auto text-[12px] text-fg-dim tabular-nums">{t('admin.llm.addedCount', '{n} added').replace('{n}', String(models.length))}</span>
              </div>
            )}
            <ul className="max-h-64 overflow-y-auto py-1">
              {shown.map((m) => {
                const on = models.includes(m.id)
                return (
                  <li key={m.id}>
                    <button type="button" onClick={() => toggle(m.id)} className="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-fg/5">
                      <Check state={on ? 'on' : 'off'} />
                      <span className="flex-1 min-w-0 truncate font-mono text-[12.5px]">{m.id}</span>
                      <span className="text-[11.5px] text-fg-dim tabular-nums">{price(m.id)}</span>
                    </button>
                  </li>
                )
              })}
              {!shown.length && <li className="px-3 py-2 text-[12.5px] text-fg-dim">{t('admin.llm.noMatch', 'No model matches')}</li>}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManual()}
            placeholder={t('admin.llm.manual', 'Or type a model name the list does not have')} className="font-mono placeholder:font-sans" />
          <Button variant="outline" onClick={addManual} disabled={!manual.trim()}>{t('admin.llm.add', 'Add')}</Button>
        </div>
        {models.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span key={m} className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-md bg-fg/6 font-mono text-[12px]">
                {m}
                <button type="button" onClick={() => toggle(m)} aria-label={t('admin.llm.remove', 'Remove')} className="size-5 grid place-items-center rounded text-fg-dim hover:text-fg">×</button>
              </span>
            ))}
          </div>
        ) : <p className="text-[12px] text-fg-dim">{t('admin.llm.noModels', 'No models added yet. Fetch the list above, or type a name.')}</p>}
      </Step>

      <Step n={3} title={t('admin.llm.step.tiers', 'Choose a model for each tier')} hint={t('admin.tiers.offNote', 'A tier that is not offered is hidden in the chat; anyone who had picked it falls back to the default tier.')}>
        {TIERS.map((tier) => {
          const ping = pings?.find((p) => p.model === tiers[tier])
          return (
            <div key={tier} className="flex items-center gap-3">
              <label className="flex items-center gap-2 w-28 shrink-0 cursor-pointer" title={t('admin.tiers.setDefault', 'Make this the default tier')}>
                <input type="radio" name="defaultTier" checked={defaultTier === tier} onChange={() => setDefaultTier(tier)}
                  disabled={!tiers[tier]} className="accent-accent" />
                <span className="text-[13px]">{TIER_LABEL[tier][locale]}</span>
              </label>
              <Select value={tiers[tier] || NONE} onValueChange={(v) => { setTiers((s) => ({ ...s, [tier]: v === NONE || v == null ? '' : String(v) })); setPings(null) }}>
                <SelectTrigger className="flex-1 min-w-0 border-edge bg-panel font-mono text-[13px]">
                  <SelectValue>{(v: string) => v === NONE ? <span className="text-fg-dim font-sans">{t('admin.tiers.off', 'Not offered')}</span> : v}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="p-1">
                  <SelectItem value={NONE} className="px-2.5 py-1.5 text-[13px] text-fg-dim">{t('admin.tiers.off', 'Not offered')}</SelectItem>
                  {models.length > 0 && <SelectSeparator className="my-1" />}
                  {models.map((m) => (
                    <SelectItem key={m} value={m} className="px-2.5 py-1.5 font-mono text-[13px]">
                      {m}{price(m) && <span className="ml-auto pl-4 font-sans text-[11.5px] text-fg-dim tabular-nums">{price(m)}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="w-28 shrink-0 text-right text-[11.5px] tabular-nums truncate">
                {ping ? <span className={ping.ok ? 'text-ok' : 'text-warn'} title={ping.error}>{ping.ok ? `✓ ${ping.ms} ms` : `✗ ${t('admin.llm.failed', 'Failed')}`}</span>
                  : <span className="text-fg-dim">{tiers[tier] ? price(tiers[tier]) : ''}</span>}
              </span>
            </div>
          )
        })}
        {pings?.some((p) => !p.ok) && (
          <div className="space-y-1">{pings.filter((p) => !p.ok).map((p) => <p key={p.model} className="text-[12px] text-warn break-words"><span className="font-mono">{p.model}</span>: {p.error}</p>)}</div>
        )}
      </Step>

      </div>
      <div className="px-5 py-3 border-t border-edge bg-fg/[.02] flex items-center gap-3">
        {(llm.baseUrl || llm.hasKey) && (
          <button type="button" onClick={() => clearLlm().then(() => { setModels([]); setTiers({}); stale(); router.invalidate() })}
            className="text-[12.5px] text-fg-dim hover:text-warn transition-colors">
            {t('admin.llm.clear', 'Clear and fall back to environment variables')}
          </button>
        )}
        <span className="flex-1 text-right text-[12.5px] text-fg-mid truncate">{msg}</span>
        <Button variant="outline" onClick={test} disabled={testing || !baseUrl || !tierModels.length}>{testing ? t('admin.llm.testing', 'Testing…') : t('admin.llm.test', 'Test')}</Button>
        <Button onClick={save} disabled={busy || !baseUrl || !tierModels.length}>{t('account.save', 'Save')}</Button>
      </div>
    </section>
  )
}


function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[24px_1fr] gap-x-3">
      <span className="size-6 rounded-full border border-edge-strong grid place-items-center text-[11.5px] text-fg-mid tabular-nums">{n}</span>
      <div className="space-y-3 min-w-0">
        <div className="pt-0.5">
          <p className="text-[13.5px] font-medium">{title}</p>
          {hint && <p className="text-[12px] text-fg-dim mt-0.5">{hint}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}
