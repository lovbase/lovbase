// One client for every provider: plain OpenAI protocol, no structured-output
// modes — those are the least-supported part of compatible gateways.
//   LLM_BASE_URL + LLM_API_KEY + LLM_MODEL  → any OpenAI-compatible endpoint
//   ANTHROPIC_API_KEY                        → Anthropic's OpenAI-compat layer
import OpenAI from 'openai'

function resolve() {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, ANTHROPIC_API_KEY } = process.env
  if (LLM_BASE_URL) {
    if (!LLM_MODEL) throw new Error('设置了 LLM_BASE_URL 但缺少 LLM_MODEL')
    return { baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY ?? 'none', model: LLM_MODEL }
  }
  if (ANTHROPIC_API_KEY)
    return {
      baseURL: 'https://api.anthropic.com/v1/',
      apiKey: ANTHROPIC_API_KEY,
      model: LLM_MODEL ?? 'claude-sonnet-5',
    }
  throw new Error('未配置模型:在 .env 里设置 LLM_BASE_URL + LLM_API_KEY + LLM_MODEL(OpenAI 兼容协议),或 ANTHROPIC_API_KEY')
}

export function llmConfigured(): boolean {
  return !!(process.env.LLM_BASE_URL || process.env.ANTHROPIC_API_KEY)
}

export function llmDescription(): string {
  try {
    const r = resolve()
    return process.env.LLM_BASE_URL ? `${r.model} @ ${r.baseURL}` : r.model
  } catch {
    return ''
  }
}

export async function chat(system: string, user: string): Promise<string> {
  const { baseURL, apiKey, model } = resolve()
  const client = new OpenAI({ baseURL, apiKey })
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const text = res.choices?.[0]?.message?.content
  if (!text)
    throw new Error(
      `网关响应里没有内容(${JSON.stringify(res).slice(0, 200)})— 检查 LLM_BASE_URL 是否以 /v1 结尾、LLM_MODEL 是否正确`,
    )
  return text
}
