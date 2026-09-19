import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { IR, assignIds, validateIR, type IR as IRType } from '@lovbase/core/ir'
import { LlmService, type LlmConfig } from '../llm/llm.service'

const RULES = `Iron rules — breaking any of these destroys user data:
1. Every existing entity and field MUST keep its exact "id". Never invent, change, or reuse ids.
2. New entities/fields get "id": "" (empty string). The server assigns real ids.
3. Never remove or change entities/fields the user did not ask to change.
4. "dbName" is snake_case ascii ([a-z][a-z0-9_]*), stable and English; "name" is the display label in the user's language. When renaming, update both if the meaning changed.
5. "dbName" must not be "id" or "created_at" (system columns).

Modeling judgment (this is where you earn your keep):
- A field holding a fixed set of states ("待处理/进行中/完成") is type "select" with options, never free text.
- A reference to another entity ("订单属于客户") is type "link" with linkTo set to that entity's id — never a text field holding a name.
- Prefer fewer, well-named fields over exhaustive ones. Only model what the user's description implies.
- Dates/times are "date"; money/quantity are "number"; yes-no is "boolean".`

const IR_SCHEMA = JSON.stringify(z.toJSONSchema(IR))

// ── Pure modeler: message → full IR. Used by the /w/:id/schema API where a deterministic IR is required. ──
const SYSTEM_IR = `You are the data modeler inside Lovbase, a tool that turns natural language into a real Postgres database plus an app.

You receive the CURRENT data model (IR) and a user request. Return the COMPLETE updated IR.

${RULES}

Output format: respond with ONLY the JSON object of the complete updated IR.
No markdown fences. No commentary before or after. The JSON must match this schema:
${IR_SCHEMA}`

// ── Conversational agent: always replies in prose, attaches an IR only when the user wants the structure changed. ──
const SYSTEM_TURN = `You are Lovbase's agent. Lovbase turns natural language into a real Postgres database (tables = entities, columns = fields) plus an app on top. You talk with the user about their app and, when they want the structure created or changed, you produce the complete updated data model (IR).

How to behave:
- Reply in the user's language, briefly and concretely, like a sharp colleague. Answer questions, explain the current model, suggest improvements, ask ONE clarifying question when the request is genuinely ambiguous.
- Only include "ir" when the user is asking to create or change the structure (new app, new table, add/rename/remove field, change type). For greetings, questions, opinions or anything else, set "ir": null.
- When you include "ir", say in "reply" what you changed and why, in one or two sentences. Do not paste the JSON into the reply.
- Never claim you changed something without including "ir".

${RULES}

Output format: respond with ONLY one JSON object: {"reply": string, "ir": <complete updated IR> | null}
No markdown fences, no text before or after. When present, "ir" must match this schema:
${IR_SCHEMA}`

export function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('输出中找不到 JSON 对象')
  return JSON.parse(candidate.slice(start, end + 1))
}

function checkIR(raw: unknown): { ir: IRType } | { errors: string[] } {
  const ir = assignIds(IR.parse(raw))
  const errors = validateIR(ir)
  return errors.length ? { errors } : { ir }
}

export type HistoryItem = { role: 'user' | 'assistant'; text: string }
export type Turn = { reply: string; ir: IRType | null }

/** Why an attempt ended. `invalid` means the JSON parsed but `validateIR` rejected it. */
export type AttemptOutcome = 'ok' | 'invalid' | 'unparsable'

/**
 * Optional observer over the retry loop. Production can log it; the eval harness uses it to
 * separate "the model got it right first try" from "the validation feedback rescued it", which
 * is the number that actually tells you whether a model is usable here.
 */
export type GenerateHooks = {
  onAttempt?: (attempt: number, outcome: AttemptOutcome, detail?: string) => void
}

@Injectable()
export class GenerateService {
  constructor(private readonly llm: LlmService) {}

  /** Up to 3 attempts; validation errors are fed back so the model can fix its own output. */
  private async withRetries<T>(
    cfg: LlmConfig, system: string, user: string,
    parse: (text: string) => T | { errors: string[] },
    hooks?: GenerateHooks,
  ): Promise<T> {
    let note = ''
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await this.llm.chat(cfg, system, user + note)
      try {
        const r = parse(text)
        if (r && typeof r === 'object' && 'errors' in r && Array.isArray((r as any).errors)) {
          lastError = (r as any).errors.join('; ')
          hooks?.onAttempt?.(attempt + 1, 'invalid', lastError)
          note = `\n\nYour previous attempt failed validation, fix these and output the full corrected JSON:\n- ${(r as any).errors.join('\n- ')}`
          continue
        }
        hooks?.onAttempt?.(attempt + 1, 'ok')
        return r as T
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        hooks?.onAttempt?.(attempt + 1, 'unparsable', lastError)
        note = `\n\nYour previous output could not be parsed as JSON (${lastError}). Respond with ONLY the raw JSON object, no fences, no commentary.`
      }
    }
    throw new Error(`模型连续 3 次输出无效(${lastError})— 换个模型或简化描述再试`)
  }

  /** Pure modeler: message → full IR. Used by the data API, where a deterministic IR is required. */
  async toIR(cfg: LlmConfig, current: IRType, message: string, hooks?: GenerateHooks): Promise<IRType> {
    return this.withRetries(cfg, SYSTEM_IR,
      `Current IR:\n${JSON.stringify(current, null, 2)}\n\nUser request:\n${message}`,
      (text) => { const c = checkIR(extractJSON(text)); return 'errors' in c ? c : c.ir },
      hooks)
  }

  /** Conversational turn: always prose, with an IR attached only when the structure should change. */
  async turn(cfg: LlmConfig, current: IRType, history: HistoryItem[], message: string, hooks?: GenerateHooks): Promise<Turn> {
    const transcript = history.map((h) => `${h.role === 'user' ? 'User' : 'Agent'}: ${h.text}`).join('\n')
    const user = `Current IR:\n${JSON.stringify(current, null, 2)}\n\nRecent conversation:\n${transcript || '(none)'}\n\nUser:\n${message}`
    return this.withRetries(cfg, SYSTEM_TURN, user, (text) => {
      const raw = extractJSON(text) as { reply?: unknown; ir?: unknown }
      if (typeof raw.reply !== 'string' || !raw.reply.trim()) return { errors: ['"reply" must be a non-empty string'] }
      if (raw.ir == null) return { reply: raw.reply, ir: null }
      const c = checkIR(raw.ir)
      return 'errors' in c ? c : { reply: raw.reply, ir: c.ir }
    }, hooks)
  }
}
