import { useEffect, useMemo, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { clearSettings, getSettings, listMyModels, saveSettings } from '../functions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '../lib/i18n'
import { PROVIDERS, ProviderGrid, type ProviderId } from './model-providers'

/**
 * Bring your own model. Paid plans only: on Free this shows what the feature is and points at
 * pricing rather than pretending the fields are editable.
 */
export function ByokSettings({ llm, onUpgrade, onChange, compact }: { llm: Awaited<ReturnType<typeof getSettings>>; onUpgrade?: () => void; onChange?: () => void; compact?: boolean }) {
  const t = useT()
  const save = useServerFn(saveSettings)
  const clear = useServerFn(clearSettings)
  const listModels = useServerFn(listMyModels)
  const router = useRouter()
  const [provider, setProvider] = useState<ProviderId>(() => llm.baseUrl ? PROVIDERS.find((p) => p.url === llm.baseUrl)?.id ?? 'custom' : 'openrouter')
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl || PROVIDERS[1].url)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(llm.model)
  const [catalog, setCatalog] = useState<{ id: string; inPer1M?: number; outPer1M?: number }[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const preset = PROVIDERS.find((p) => p.id === provider)
  const keyUsable = llm.hasKey && !llm.keyUnreadable
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (catalog ?? []).filter((m) => !q || m.id.toLowerCase().includes(q)).slice(0, 200)
  }, [catalog, query])

  async function fetchModels() {
    setFetching(true); setCatalog(null); setCatalogError('')
    try { setCatalog(await listModels({ data: { baseUrl, apiKey } })) }
    catch (e) {
      const m = e instanceof Error ? e.message.replace(/^LIMIT:/, '') : String(e)
      setCatalogError(m.includes('KEY_UNREADABLE') ? t('account.byok.unreadable', 'The saved key can no longer be decrypted (the encryption key changed), so the platform model is in use. Enter the key once more to restore it.')
        : /PUBLIC_ONLY|Local or reserved|must use HTTPS/.test(m) ? t('account.byok.publicOnly', 'Only public HTTPS endpoints can be used.') : m)
    } finally { setFetching(false) }
  }
  // A saved setup opens with its list loaded: the key is on the server, there is nothing to retype.
  useEffect(() => { if (llm.canByok && llm.baseUrl && keyUsable) void fetchModels() }, [])

  if (!llm.canByok)
    return (
      <section className="flex items-center justify-between gap-6 py-3.5 border-y border-edge">
        <div className="min-w-0">
          <p className="text-[14px]">{t('account.byok.title', 'Bring your own model')}</p>
          <p className="text-[13px] leading-5 text-fg-dim mt-0.5">{t('account.byok.lockedShort', 'Use your own key and model. Pro and above.')}</p>
        </div>
        <Link to="/pricing" search={{ billing: 'monthly' }} onClick={onUpgrade} className="shrink-0 inline-flex items-center h-8 px-3.5 rounded-lg bg-fg text-ink text-[13px] font-medium">{t('account.byok.unlock', 'Upgrade to unlock')}</Link>
      </section>
    )

  function pick(id: ProviderId) {
    if (id === provider) return
    setProvider(id); setCatalog(null); setCatalogError('')
    const p = PROVIDERS.find((x) => x.id === id)
    const url = p ? p.url : PROVIDERS.some((x) => x.url === llm.baseUrl) ? '' : llm.baseUrl
    setBaseUrl(url); setModel(url === llm.baseUrl ? llm.model : '')
  }

  async function submit() {
    setBusy(true); setMsg('')
    try {
      await save({ data: { baseUrl, apiKey, model } })
      setApiKey(''); setMsg(t('account.byok.saved', 'Saved. Generation now runs on your own model.')); router.invalidate(); onChange?.()
    } catch (e) { setMsg(e instanceof Error ? e.message.replace(/^LIMIT:/, '') : String(e)) } finally { setBusy(false) }
  }

  const keyPlaceholder = llm.keyUnreadable ? t('account.byok.reenter', 'Enter it again')
    : llm.hasKey ? `${t('admin.llm.keySaved', 'Saved')} · ${t('admin.llm.keyKeep', 'leave empty to keep')}` : 'sk-…'

  return (
    <section>
      <div className="pb-5 mb-6 border-b border-edge flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[14px] font-medium">{t('account.byok.title', 'Bring your own model')}</p>
          <p className="text-[13px] leading-5 text-fg-dim mt-0.5">{t('account.byok.noteShort', 'Your own model uses no credits.')}</p>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-panel-2 text-[12.5px] text-fg-mid">
          <span className={`size-1.5 rounded-full ${llm.effective.includes('own key') ? 'bg-ok' : 'bg-fg-dim'}`} />
          {llm.effective.includes('own key') ? <span className="font-mono text-fg">{llm.model}</span> : t('account.byok.onPlatform', 'Platform model')}
        </span>
      </div>
      <div className="space-y-6">
        <ProviderGrid value={provider} onChange={pick} columns={compact ? 4 : 5} />
        <label className="block">
          <span className="block text-[13px] font-medium mb-2">Base URL</span>
          <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setCatalog(null) }} readOnly={!!preset}
            placeholder="https://your-endpoint/v1" className={`font-mono placeholder:font-sans ${preset ? 'text-fg-dim bg-fg/[.03]' : ''}`} />
        </label>
        <div>
          <span className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[13px] font-medium">API key</span>
            {preset && <a href={preset.keys} target="_blank" rel="noreferrer" className="text-[13px] text-fg-dim hover:text-fg">{t('admin.llm.getKey', 'Get an API key')} ↗</a>}
          </span>
          <div className="flex gap-2">
            <Input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setCatalog(null) }} aria-label="API key"
              placeholder={keyPlaceholder} className="font-mono placeholder:font-sans" />
            <Button variant="outline" onClick={fetchModels} disabled={fetching || !baseUrl}>{fetching ? t('admin.llm.fetching', 'Fetching…') : t('admin.llm.fetch', 'Fetch models')}</Button>
          </div>
          {catalogError ? <p className="mt-2 text-[13px] leading-5 text-warn break-words">{catalogError}</p>
            : llm.keyUnreadable && !apiKey && <p className="mt-2 text-[13px] leading-5 text-warn">{t('account.byok.unreadableShort', 'The saved key can no longer be read. Enter it again.')}</p>}
        </div>
        <div>
          <span className="block text-[13px] font-medium mb-2">{t('account.byok.model', 'Model')}</span>
          {catalog && (
            <div className="rounded-lg border border-edge mb-2">
              <div className="p-2 border-b border-edge">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('admin.llm.search', 'Search {n} models').replace('{n}', String(catalog.length))} className="h-8" />
              </div>
              <ul className="max-h-56 overflow-y-auto py-1">
                {shown.map((m) => (
                  <li key={m.id}>
                    <button type="button" aria-pressed={model === m.id} onClick={() => setModel(m.id)}
                      className={`w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-fg/5 ${model === m.id ? 'bg-fg/5' : ''}`}>
                      <span className={`size-3.5 shrink-0 rounded-full border grid place-items-center ${model === m.id ? 'border-fg' : 'border-edge-strong'}`}>
                        {model === m.id && <span className="size-1.5 rounded-full bg-fg" />}
                      </span>
                      <span className="flex-1 min-w-0 truncate font-mono text-[12.5px]">{m.id}</span>
                      {m.inPer1M != null && <span className="text-[11.5px] text-fg-dim tabular-nums">${m.inPer1M} / ${m.outPer1M}</span>}
                    </button>
                  </li>
                ))}
                {!shown.length && <li className="px-3 py-2 text-[12.5px] text-fg-dim">{t('admin.llm.noMatch', 'No model matches')}</li>}
              </ul>
            </div>
          )}
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={catalog ? t('account.byok.modelOr', 'Or type a model name') : 'gpt-5.2 / claude-sonnet-5'} className="font-mono placeholder:font-sans" />
        </div>
      </div>
      <div className="mt-8 pt-5 border-t border-edge flex items-center gap-3">
        {(llm.baseUrl || llm.hasKey) && (
          <button type="button" onClick={() => clear().then(() => { setModel(''); setApiKey(''); setCatalog(null); { router.invalidate(); onChange?.() } })}
            className="text-[13px] text-fg-dim hover:text-warn transition-colors">
            {t('account.byok.clearShort', 'Use platform model')}
          </button>
        )}
        <span className="flex-1 text-right text-[13px] text-fg-mid truncate">{msg}</span>
        <Button onClick={submit} disabled={busy || !baseUrl || !model.trim()}>{t('account.save', 'Save')}</Button>
      </div>
    </section>
  )
}
