import { useT } from '../lib/i18n'

/**
 * Known OpenAI-compatible endpoints, in the manner of cc-switch: picking one fills the base URL and
 * points at where its keys are made. Every one of them, and a custom URL, then goes through the
 * same steps — fetch /models, then pick from what came back. The admin's platform model and a
 * user's own model (BYOK) both start here.
 */
export const PROVIDERS = [
  { id: 'vercel', name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1', keys: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys', recommended: true },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keys: 'https://openrouter.ai/settings/keys', recommended: false },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', keys: 'https://platform.openai.com/api-keys', recommended: false },
  { id: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com/v1', keys: 'https://console.anthropic.com/settings/keys', recommended: false },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', keys: 'https://platform.deepseek.com/api_keys', recommended: false },
  { id: 'moonshot', name: 'Kimi', url: 'https://api.moonshot.cn/v1', keys: 'https://platform.moonshot.cn/console/api-keys', recommended: false },
  { id: 'zhipu', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', keys: 'https://open.bigmodel.cn/usercenter/apikeys', recommended: false },
  { id: 'qwen', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keys: 'https://bailian.console.aliyun.com/?apiKey=1', recommended: false },
] as const
export type ProviderId = (typeof PROVIDERS)[number]['id'] | 'custom'

/** The preset tiles plus "Custom". */
export function ProviderGrid({ value, onChange, columns = 5 }: { value: ProviderId; onChange: (id: ProviderId) => void; columns?: 4 | 5 }) {
  const t = useT()
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 ${columns === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
      {[...PROVIDERS, { id: 'custom' as const, name: t('admin.llm.custom', 'Custom'), recommended: false }].map((p) => (
        <button key={p.id} type="button" onClick={() => onChange(p.id)} aria-pressed={value === p.id}
          className={`px-3 py-2 rounded-lg border text-left transition-colors ${value === p.id ? 'border-fg bg-panel shadow-[0_0_0_1px_var(--t-fg)]' : 'border-edge bg-panel hover:border-edge-strong'}`}>
          <span className={`block truncate text-[12.5px] ${value === p.id ? 'text-fg font-medium' : 'text-fg-mid'}`}>{p.name}</span>
          <span className={`block truncate text-[11px] mt-0.5 ${p.recommended ? 'text-accent' : 'text-fg-dim'}`}>
            {p.recommended ? t('admin.llm.recommended', 'Recommended') : 'url' in p ? new URL(p.url).host : t('admin.llm.anyEndpoint', 'Any OpenAI-compatible URL')}
          </span>
        </button>
      ))}
    </div>
  )
}

export function Check({ state }: { state: 'on' | 'off' | 'some' }) {
  return (
    <span className={`size-4 shrink-0 rounded border grid place-items-center text-[10px] leading-none ${state === 'off' ? 'border-edge-strong' : 'bg-fg border-fg text-ink'}`}>
      {state === 'on' ? '✓' : state === 'some' ? '–' : null}
    </span>
  )
}
