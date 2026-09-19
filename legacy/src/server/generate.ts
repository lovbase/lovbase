import { z } from 'zod'
import { IR, assignIds, validateIR, type IR as IRType } from '../shared/ir'
import { chat } from './llm'

const SYSTEM = `You are the data modeler inside Lovbase, a tool that turns natural language into a real Postgres database plus an app.

You receive the CURRENT data model (IR) and a user request. Return the COMPLETE updated IR.

Iron rules — breaking any of these destroys user data:
1. Every existing entity and field MUST keep its exact "id". Never invent, change, or reuse ids.
2. New entities/fields get "id": "" (empty string). The server assigns real ids.
3. Never remove or change entities/fields the user did not ask to change.
4. "dbName" is snake_case ascii ([a-z][a-z0-9_]*), stable and English; "name" is the display label in the user's language. When renaming, update both if the meaning changed.
5. "dbName" must not be "id" or "created_at" (system columns).

Modeling judgment (this is where you earn your keep):
- A field holding a fixed set of states ("待处理/进行中/完成") is type "select" with options, never free text.
- A reference to another entity ("订单属于客户") is type "link" with linkTo set to that entity's id — never a text field holding a name.
- Prefer fewer, well-named fields over exhaustive ones. Only model what the user's description implies.
- Dates/times are "date"; money/quantity are "number"; yes-no is "boolean".

Output format: respond with ONLY the JSON object of the complete updated IR.
No markdown fences. No commentary before or after. The JSON must match this schema:
${JSON.stringify(z.toJSONSchema(IR))}`

/** Tolerant extraction (models wrap JSON in fences/prose) + strict Zod after. */
export function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('输出中找不到 JSON 对象')
  return JSON.parse(candidate.slice(start, end + 1))
}

export async function generateIR(current: IRType, message: string): Promise<IRType> {
  let note = ''
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await chat(
      SYSTEM,
      `Current IR:\n${JSON.stringify(current, null, 2)}\n\nUser request:\n${message}${note}`,
    )
    try {
      const ir = assignIds(IR.parse(extractJSON(text)))
      const errors = validateIR(ir)
      if (errors.length === 0) return ir
      lastError = errors.join('; ')
      note = `\n\nYour previous attempt failed validation, fix these and output the full corrected JSON:\n- ${errors.join('\n- ')}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      note = `\n\nYour previous output could not be parsed as JSON (${lastError}). Respond with ONLY the raw JSON object, no fences, no commentary.`
    }
  }
  throw new Error(`模型连续 3 次输出无效(${lastError})— 换个模型或简化描述再试`)
}
