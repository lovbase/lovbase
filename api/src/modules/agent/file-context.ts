import { isStaticToolUIPart, type UIMessage } from 'ai'

const FILE_TOOLS = new Set(['tool-read_app_file', 'tool-read_app_files', 'tool-search_app_files', 'tool-write_app_file', 'tool-edit_app_file', 'tool-edit_app_files'])
const OMITTED = '[Historical source omitted; read current source if needed.]'
const failed = (output: any): boolean => !output || !!output.error || output.ok === false
  || (Array.isArray(output.errors) && output.errors.length > 0)
  || (Array.isArray(output.files) && output.files.some(failed))
  || (Array.isArray(output.checks) && output.checks.some(failed))

/** Model-only projection: keep the transcript, active work, failures and approvals intact. */
export function compactFileContext(messages: UIMessage[]): UIMessage[] {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  return messages.map((message, index) => {
    if (index >= lastUser || message.role !== 'assistant') return message
    if (message.parts.some(part => isStaticToolUIPart(part) && part.state !== 'output-available')) return message
    return { ...message, parts: message.parts.map(part => {
      if (!isStaticToolUIPart(part) || part.state !== 'output-available') return part
      if (!FILE_TOOLS.has(part.type) && part.type !== 'tool-run_app_command') return part
      const output = part.output as any
      if (failed(output) || part.approval) return part
      const input = part.input as any
      if (part.type === 'tool-run_app_command') {
        if (output.ok !== true) return part
        return { ...part, output: { ok: true, summary: 'Command succeeded; historical logs omitted.' } }
      }
      if (part.type === 'tool-search_app_files') return {
        ...part, output: { matches: output.matches?.map((match: any) => ({ path: match.path, line: match.line })), summary: OMITTED },
      }
      const summarized = (file: any) => {
        const { content: _content, ...rest } = file
        return { ...rest, summary: OMITTED }
      }
      const writing = ['tool-write_app_file', 'tool-edit_app_file', 'tool-edit_app_files'].includes(part.type)
      return {
        ...part,
        input: writing ? (input?.files
          ? { files: input.files.map((file: any) => ({ path: file.path, editCount: file.edits?.length })), summary: OMITTED }
          : { path: input?.path, summary: OMITTED }) : part.input,
        output: output.files ? {
          ...output, files: output.files.map(summarized),
          ...(output.checks ? { checks: output.checks.map((check: any) => ({ command: check.command, ok: true })) } : {}),
        } : summarized(output),
      }
    }) }
  })
}
