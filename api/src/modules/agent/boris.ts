// Boris is the coding agent running inside the sandbox (pi under the hood).
// It emits one JSON event per line in `--mode json`; these helpers turn that raw stream into
// something a person can watch: what it is doing right now, which files it touched, and a
// final summary. Parsing is deliberately forgiving — an unknown event shape must never break a build.

import { looksLikeCode } from '@lovbase/core/prose'

export type BorisStep = { id?: string; tool: string; path?: string; status: 'running' | 'done' | 'failed'; detail?: string }
export type BorisActivity = { running: boolean; steps: BorisStep[]; text: string; code: string; codePath?: string }

const textOf = (result: any): string => {
  const c = result?.content
  if (Array.isArray(c)) return c.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('')
  return typeof result === 'string' ? result : ''
}
const lastToolCall = (partial: any) => {
  const content = partial?.content
  if (!Array.isArray(content)) return null
  for (let i = content.length - 1; i >= 0; i--) if (content[i]?.type === 'toolCall') return content[i]
  return null
}
/**
 * Arguments stream in as partial JSON, so it cannot be parsed until the call closes. Pull the
 * value of a key out of the half-written text instead, unescaping what JSON escaping we can see.
 */
function looseString(partialJson: string, keys: string[]): string | undefined {
  for (const k of keys) {
    const at = partialJson.indexOf(`"${k}"`)
    if (at < 0) continue
    const q = partialJson.indexOf('"', partialJson.indexOf(':', at) + 1)
    if (q < 0) continue
    let out = ''
    for (let i = q + 1; i < partialJson.length; i++) {
      const ch = partialJson[i]
      if (ch === '\\') {
        const n = partialJson[++i]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n === 'u' ? '' : n ?? ''
        continue
      }
      if (ch === '"') break
      out += ch
    }
    if (out) return out
  }
  return undefined
}

const asPath = (v: any): string | undefined => {
  if (!v || typeof v !== 'object') return undefined
  for (const k of ['path', 'file_path', 'filePath', 'file', 'target']) {
    const x = v[k]
    if (typeof x === 'string' && x.length < 300) return x.replace(/^\/workspace\/app\//, '')
  }
  return undefined
}
const asCode = (v: any): string | undefined => {
  if (!v || typeof v !== 'object') return undefined
  for (const k of ['content', 'new_str', 'newText', 'text', 'replacement']) {
    const x = v[k]
    if (typeof x === 'string' && x.length > 20) return x
  }
  return undefined
}

/** Fold a JSONL transcript into the current activity view. */
export function parseActivity(jsonl: string): BorisActivity {
  const steps: BorisStep[] = []
  let text = ''
  let code = ''
  let codePath: string | undefined
  let ended = false
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let e: any
    try { e = JSON.parse(t) } catch { continue }
    const type = e.type ?? e.event
    switch (type) {
      case 'tool_execution_start': {
        const tool = e.toolName ?? e.tool ?? e.name ?? 'tool'
        const args = e.args ?? e.input ?? e.arguments
        const path = asPath(args)
        // A shell step with no path would otherwise read as "执行命令" three times in a row and say
        // nothing about which three commands. The command is the step's name.
        const command = args && typeof args === 'object' ? (args.command ?? args.cmd) : undefined
        steps.push({ id: e.toolCallId, tool, path, status: 'running', detail: typeof command === 'string' ? command.slice(0, 160) : undefined })
        const c = asCode(args)
        if (c) { code = c; codePath = path }
        break
      }
      case 'tool_execution_update': {
        const c = asCode(e.args ?? e.input ?? e.delta)
        if (c) code = c
        break
      }
      case 'tool_execution_end': {
        const byId = e.toolCallId ? steps.find((s) => s.id === e.toolCallId) : undefined
        const last = byId ?? steps.findLast((s) => s.status === 'running')
        if (last) {
          last.status = e.isError || e.error || e.ok === false ? 'failed' : 'done'
          const err = typeof e.error === 'string' ? e.error : e.isError ? textOf(e.result) : ''
          if (err) last.detail = err.slice(0, 200)
        }
        break
      }
      // The narration and the code being typed both arrive as message_update wrappers: an
      // assistant text delta, or the partial JSON arguments of the tool call in flight.
      case 'message_update': {
        const ev = e.assistantMessageEvent ?? {}
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') text += ev.delta
        if (ev.type === 'toolcall_delta') {
          const partial = lastToolCall(ev.partial)
          const args = partial?.partialArgs
          if (typeof args === 'string' && args.length > 20) {
            const c = looseString(args, ['content', 'new_str', 'newText', 'text', 'replacement'])
            if (c) { code = c; codePath = looseString(args, ['path', 'file_path']) ?? codePath }
          }
        }
        break
      }
      case 'text_delta':
        if (typeof e.delta === 'string') text += e.delta
        else if (typeof e.text === 'string') text += e.text
        break
      case 'agent_end':
      case 'turn_end':
        ended = true
        break
    }
  }
  for (const s of steps) if (ended && s.status === 'running') s.status = 'done'
  return { running: !ended, steps, text: text.slice(-4000), code: code.slice(-8000), codePath }
}

/** Human summary for the finished tool result, when the raw output is a JSON event stream. */
export function summarize(raw: string): string {
  if (!raw.trimStart().startsWith('{')) return raw
  const a = parseActivity(raw)
  const files = [...new Set(a.steps.filter((s) => s.path).map((s) => s.path!))]
  // The closing paragraph is the model talking to the user; anything before it is working notes.
  const tail = a.text.trim().split(/\n{2,}/).pop()?.trim() ?? ''
  if (tail && !looksLikeCode(tail)) return tail.slice(0, 600)
  if (files.length) return `改动了 ${files.length} 个文件:\n${files.map((f) => `- ${f}`).join('\n')}`
  return '完成'
}
