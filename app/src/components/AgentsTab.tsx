import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, isStaticToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { useServerFn } from '@tanstack/react-start'
import { useRouter } from '@tanstack/react-router'
import { AlertDialog } from '@base-ui-components/react/alert-dialog'
import type { Change } from '@lovbase/core/diff'
import { appFiles, buildActivity, chatState, confirmPending, discardPending, listSkills, truncateChat, type getProjectState } from '../functions'
import { PromptEditor } from './PromptEditor'
import { ChangeList } from './ChangeList'
import type { Pane } from './Workspace'
import { useI18n, useT } from '../lib/i18n'
import { track } from '../lib/posthog'
import { Database, FileCode, FilePen, FolderTree, Lightbulb, Sparkles, Table2, Wand2, ArrowUpRight, Check, ChevronDown, ChevronsDownUp, Loader2, Copy, Pencil, RefreshCw, CornerDownLeft, X } from 'lucide-react'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from './ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from './ai-elements/message'
import {
  PromptInput, PromptInputActionAddAttachments, PromptInputActionMenu, PromptInputActionMenuContent,
  PromptInputActionMenuTrigger, PromptInputBody, PromptInputHeader, PromptInputProvider, PromptInputSubmit,
  usePromptInputAttachments,
} from './ai-elements/prompt-input'
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from './ai-elements/attachments'
import { Suggestion, Suggestions } from './ai-elements/suggestion'
import { Shimmer } from './ai-elements/shimmer'

type State = Awaited<ReturnType<typeof getProjectState>>

const EXAMPLES = [
  '做一个客户管理系统,记录客户、联系人和跟进记录',
  '做一个库存台账,管理商品、出入库和供应商',
  '做一个活动报名工具,有活动、报名人和签到状态',
]
const TOOL_LABEL: Record<string, string> = {
  'tool-get_schema': '读取结构', 'tool-query': '查询数据', 'tool-propose_schema': '修改结构', 'tool-load_skill': '加载技能',
  'tool-list_app_files': '列出应用文件', 'tool-read_app_file': '读取应用文件', 'tool-write_app_file': '修改应用文件', 'tool-edit_app': '生成界面 · Boris', 'tool-ask_user': '提问',
}

export function AgentsTab({ state, appId, initialPrompt, onInitialSent, onPreview, onAppChanged, onFocus }: {
  state: State; appId: string; initialPrompt?: string; onInitialSent?: () => void; onPreview?: (url: string) => void; onAppChanged?: () => void
  onFocus?: (pane: Pane, file?: string) => void
}) {
  const t = useT()
  const projectId = state.project.id
  const router = useRouter()
  const confirm = useServerFn(confirmPending)
  const discard = useServerFn(discardPending)
  const filesFn = useServerFn(appFiles)
  const listFiles = () => filesFn({ data: { projectId, appId } }).then((r) => r.files.map((f) => f.path))
  const [pending, setPending] = useState<{ pendingId: string; changes: Change[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const appRef = useRef(appId); appRef.current = appId
  // The tier the user picked. Kept in a ref as well, because the transport body is built lazily
  // and would otherwise close over whatever the value was when the chat was created.
  const [tier, setTier] = useState<string>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('lovbase:tier') : null
    return (saved && state.tiers.some((t) => t.tier === saved) ? saved : state.tiers.find((t) => t.isDefault)?.tier) ?? 'standard'
  })
  const tierRef = useRef(tier); tierRef.current = tier
  const pickTier = (t: string) => { setTier(t); try { localStorage.setItem('lovbase:tier', t) } catch { /* private mode */ } }
  const [transport] = useState(() => new DefaultChatTransport({
    api: `/api/chat/${projectId}`,
    body: () => ({ appId: appRef.current, tier: tierRef.current }),
  }))

  const { messages, setMessages, sendMessage, regenerate, status, stop, error } = useChat({
    id: projectId,
    messages: state.chat as UIMessage[],
    transport,
    onFinish: () => router.invalidate(),
  })

  const fired = useRef(false)
  useEffect(() => {
    if (!initialPrompt || fired.current) return
    fired.current = true
    onInitialSent?.()
    sendMessage({ text: initialPrompt })
  }, [initialPrompt])

  async function doConfirm() {
    if (!pending) return
    setBusy(true)
    try { await confirm({ data: { projectId, pendingId: pending.pendingId } }) } finally {
      setPending(null); setBusy(false); router.invalidate()
    }
  }
  async function doDiscard(pendingId: string) {
    setBusy(true)
    try { await discard({ data: { projectId, pendingId } }) } finally { setBusy(false); router.invalidate() }
  }

  const streaming = status === 'submitted' || status === 'streaming'

  // Steering: typing during a run is allowed. The message waits in a queue and is sent the
  // moment the agent finishes, so a correction is never lost to a disabled input.
  const [queued, setQueued] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const truncate = useServerFn(truncateChat)
  const skillsFn = useServerFn(listSkills)
  useEffect(() => { skillsFn().then(setSkills).catch(() => {}) }, [])
  useEffect(() => {
    if (streaming || queued.length === 0) return
    const [next, ...rest] = queued
    setQueued(rest)
    sendMessage({ text: next })
  }, [streaming, queued])

  // Resume after a refresh: the server saves the transcript after every step, so if the last
  // saved message still has an unfinished tool call we poll until the run settles. The poll only
  // ever replaces the transcript with a longer one, stops as soon as the user sends anything,
  // and gives up after a few minutes so an abandoned run cannot poll forever.
  const loadChat = useServerFn(chatState)
  const [resuming, setResuming] = useState(() => !!(state as any).running || hasOpenRun(state.chat as UIMessage[]))
  const [progress, setProgress] = useState<{ text: string; steps: { tool: string; done: boolean }[] } | null>((state as any).progress ?? null)
  useEffect(() => {
    if (!resuming) return
    if (streaming) { setResuming(false); return }
    const deadline = Date.now() + 5 * 60_000
    let alive = true
    const id = setInterval(async () => {
      if (Date.now() > deadline) { setResuming(false); return }
      try {
        const r = await loadChat({ data: { projectId } })
        if (!alive) return
        const next = r.chat as UIMessage[]
        setMessages((cur) => (next.length >= cur.length ? next : cur))
        setProgress(r.progress ?? null)
        if (!r.running && !hasOpenRun(next)) { setResuming(false); router.invalidate() }
      } catch { setResuming(false) }
    }, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [resuming, streaming, projectId])
  // Side effects of app tools: preview URL from edit_app, hot reload after write_app_file.
  // Tool calls already in the saved transcript are marked as seen before the first pass: replaying
  // them would push a preview URL from an old container, which no longer resolves.
  const seen = useRef<Set<string>>(
    new Set((state.chat as UIMessage[] | undefined)?.flatMap((m) =>
      m.parts.filter(isStaticToolUIPart).map((p) => p.toolCallId)) ?? []),
  )
  useEffect(() => {
    for (const m of messages) for (const p of m.parts) {
      if (!isStaticToolUIPart(p) || p.state !== 'output-available' || seen.current.has(p.toolCallId)) continue
      seen.current.add(p.toolCallId)
      const out = p.output as any
      if (p.type === 'tool-edit_app' && out?.previewUrl) { track('ui_generated', { seconds: Math.round((out.duration ?? 0) / 1000) }); onPreview?.(out.previewUrl) }
      if (p.type === 'tool-propose_schema' && Array.isArray(out?.changes) && out.changes.length) track('schema_applied', { changes: out.changes.length })
      if (p.type === 'tool-write_app_file' && out?.ok) onAppChanged?.()
    }
  }, [messages])
  const last = messages[messages.length - 1]
  const lastPart = last?.role === 'assistant' ? last.parts[last.parts.length - 1] : undefined
  const waiting = status === 'submitted' || (status === 'streaming' && !(lastPart?.type === 'text' && lastPart.text.trim()))
  // A Boris build is the one tool slow enough to deserve its own live panel.
  const buildRunning = !!last?.parts.some((p) => isStaticToolUIPart(p) && p.type === 'tool-edit_app' && p.state !== 'output-available' && p.state !== 'output-error')
  useEffect(() => { if (buildRunning) onFocus?.('preview') }, [buildRunning])

  return (
    <div className="h-full flex flex-col">
      <Conversation className="flex-1 min-h-0">
        <ConversationContent className="w-full px-4 py-5 gap-3 min-h-full justify-end">
          {messages.length === 0 && !streaming ? (
            <ConversationEmptyState className="font-display" title="用一句话,得到一个真数据库。"
              description="描述你要的应用,agent 会建出真实的 Postgres 表和界面。之后随时改需求,已有数据一行不丢。也可以直接扔一份 CSV 进来。">
              <Suggestions className="mt-2">
                {EXAMPLES.map((e) => <Suggestion key={e} suggestion={e} onClick={(s) => sendMessage({ text: s })} />)}
              </Suggestions>
            </ConversationEmptyState>
          ) : null}
          {messages.map((m, mi) => (
            <Message key={m.id} from={m.role} className="group/msg">
              <MessageContent className="gap-2">
                {groupParts(m.parts).map((g, i) => {
                  if (g.kind === 'text')
                    return m.role === 'user'
                      ? <div key={i} className="whitespace-pre-wrap">{withChips(g.text)}</div>
                      : <MessageResponse key={i}>{g.text}</MessageResponse>
                  if (g.kind === 'file')
                    return (
                      <Attachments key={i} variant="inline">
                        <Attachment data={{ ...g.part, id: `${m.id}-${i}` }}><AttachmentPreview /></Attachment>
                      </Attachments>
                    )
                  if (g.kind === 'ask')
                    return <AskCard key={i} part={g.part} answered={mi < messages.length - 1} disabled={streaming} onAnswer={(text) => sendMessage({ text })} />
                  return <ToolRun key={i} parts={g.parts} live={streaming && mi === messages.length - 1} pendingIds={state.pendingIds} onConfirm={(p) => setPending(p)} onDiscard={doDiscard} onFocus={onFocus} />
                })}
                <MessageActions message={m} disabled={streaming}
                  onCopy={() => navigator.clipboard?.writeText(textOf(m))}
                  onEdit={m.role === 'user' ? () => { setEditing({ id: m.id, text: textOf(m) }); window.dispatchEvent(new CustomEvent('lovbase:replace', { detail: { text: textOf(m) } })) } : undefined}
                  onRetry={m.role === 'assistant' && mi === messages.length - 1 ? () => regenerate() : undefined} />
              </MessageContent>
            </Message>
          ))}
          {buildRunning && <BorisPanel projectId={projectId} appId={appId} onFocus={onFocus} />}
          {resuming && !streaming && (
            <div className="w-full space-y-2">
              {progress?.text && <MessageResponse>{progress.text}</MessageResponse>}
              {progress?.steps?.length ? (
                <div className="pl-3.5 border-l border-edge space-y-1">
                  {progress.steps.map((st, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px] text-fg-mid">
                      {st.done
                        ? <Check className="size-3 shrink-0 text-fg-dim" strokeWidth={2} />
                        : <Loader2 className="size-3.5 shrink-0 text-fg animate-spin" strokeWidth={1.75} />}
                      <span className="truncate">{TOOL_LABEL[`tool-${st.tool}`] ?? st.tool}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2 text-[12.5px] text-fg-dim">
                <Loader2 className="size-3.5 animate-spin" /> {t('chat.resuming', '这一轮还在服务器上跑,正在接回…')}
              </div>
            </div>
          )}
          {waiting && !buildRunning && <Shimmer className="text-sm">{statusFor(last)}</Shimmer>}
          {error && outOfCredits(error) && <OutOfCreditsSignal />}
          {error && (outOfCredits(error) ? (
            <div className="rounded-xl border border-edge bg-panel px-4 py-3.5">
              <p className="text-[13.5px] font-medium">{t('chat.outOfCredits.title', '本期额度已用完')}</p>
              <p className="text-[12.5px] text-fg-dim mt-1">{t('chat.outOfCredits.hint', '1 次对话 = 1 额度,生成界面 = 5 额度。升级后立即恢复,或等到下个周期重置。')}</p>
              <a href="/pricing" className="inline-block mt-3 px-3.5 py-1.5 text-[12.5px] rounded-lg bg-fg text-ink font-medium">{t('chat.seePlans', '查看套餐')}</a>
            </div>
          ) : (
            <div className="border border-edge bg-panel rounded-lg px-4 py-3 text-sm text-fg-mid">{error.message}</div>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 border-t border-edge bg-ink">
        <div className="px-3 pt-3 pb-2">
          {queued.map((q, i) => (
            <div key={i} className="mb-2 flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] text-fg-mid">
              <CornerDownLeft className="size-3.5 text-fg-dim shrink-0" />
              <span className="truncate flex-1">{t('chat.queued', '这条会在当前这轮结束后发送:')}{q}</span>
              <button type="button" onClick={() => setQueued((v) => v.filter((_, j) => j !== i))} className="text-fg-dim hover:text-fg cursor-pointer"><X className="size-3.5" /></button>
            </div>
          ))}
          {editing && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] text-fg-mid">
              <Pencil className="size-3.5 text-fg-dim shrink-0" />
              <span className="truncate flex-1">{t('chat.editing', '正在改写这条消息,发送后会重新生成')}</span>
              <button type="button" onClick={() => setEditing(null)} className="text-fg-dim hover:text-fg cursor-pointer"><X className="size-3.5" /></button>
            </div>
          )}
          <PromptInputProvider>
          <PromptInput
            onSubmit={async (msg) => {
              if (!msg.text.trim() && msg.files.length === 0) return
              setResuming(false)
              if (streaming) { setQueued((q) => [...q, msg.text]); return }
              if (editing) {
                const at = messages.findIndex((m) => m.id === editing.id)
                setEditing(null)
                if (at >= 0) {
                  setMessages(messages.slice(0, at))
                  try { await truncate({ data: { projectId, messageId: editing.id } }) } catch { /* the resend rewrites it anyway */ }
                }
              }
              track('message_sent', { hasFiles: msg.files.length > 0 })
              sendMessage({ text: msg.text, files: msg.files })
            }}
            globalDrop multiple maxFiles={6} maxFileSize={8 * 1024 * 1024}
            accept="image/*,.csv,.tsv,.txt,.md,.json,.xml,.yaml,.yml,text/*,application/json"
            className="bg-panel border-edge rounded-xl shadow-sm focus-within:border-edge-strong transition-colors"
          >
            <PromptInputHeader><AttachmentStrip /></PromptInputHeader>
            <div data-align="block-end" className="w-full flex flex-col">
              <PromptInputBody>
                <PromptEditor listFiles={listFiles} placeholder={t('chat.placeholder', '想做什么?改结构、改界面、查数据都行,@ 引用文件')} />
              </PromptInputBody>
              <div className="flex items-center gap-1 px-2 pb-2">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="添加附件(图片、CSV、文本)" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                <SkillPicker skills={skills} />
                <TierPicker options={state.tiers} value={tier} onChange={pickTier} />
                <div className="flex-1" />
                <PromptInputSubmit status={status} onStop={stop} />
              </div>
            </div>
          </PromptInput>
          </PromptInputProvider>
          <p className="text-[10.5px] text-fg-dim mt-1.5 px-1 truncate">{t('chat.hint', 'Enter 发送 · Shift+Enter 换行 · 拖入图片或 CSV')}</p>
        </div>
      </div>

      <AlertDialog.Root open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
          <AlertDialog.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[30rem] max-w-[calc(100vw-2rem)]
                                        bg-panel border border-edge-strong rounded-xl p-5 shadow-2xl">
            <AlertDialog.Title className="font-mono text-[11px] uppercase tracking-[.14em] text-accent-soft mb-2">
              Destructive — 需要确认
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-fg-mid mb-3">以下变更会影响已有数据,确认后才会执行:</AlertDialog.Description>
            {pending && <ChangeList changes={pending.changes} />}
            <div className="flex justify-end gap-2 mt-4">
              <AlertDialog.Close className="px-3.5 py-2 border border-edge rounded-lg text-[13px] text-fg-mid hover:text-fg hover:border-edge-strong transition-colors cursor-pointer">
                取消
              </AlertDialog.Close>
              <button onClick={doConfirm} disabled={busy}
                className="px-3.5 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium hover:bg-accent-soft disabled:opacity-50 transition-colors cursor-pointer">
                确认执行
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

function AttachmentStrip() {
  // The hook throws when the provider is momentarily missing (HMR remounts); never take the page down for that.
  let ctx: ReturnType<typeof usePromptInputAttachments> | null = null
  try { ctx = usePromptInputAttachments() } catch { ctx = null }
  if (!ctx || ctx.files.length === 0) return null
  const { files, remove } = ctx
  return (
    <Attachments variant="inline">
      {files.map((f) => (
        <Attachment key={f.id} data={f} onRemove={() => remove(f.id)}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  )
}

/** Consecutive tool parts become one run; text/file parts stay as they are. */
type Group = { kind: 'text'; text: string } | { kind: 'file'; part: any } | { kind: 'tools'; parts: ToolUIPart[] } | { kind: 'ask'; part: ToolUIPart }
function groupParts(parts: UIMessage['parts']): Group[] {
  const out: Group[] = []
  for (const part of parts) {
    if (part.type === 'text') { if (part.text.trim()) out.push({ kind: 'text', text: part.text }); continue }
    if (part.type === 'file') { out.push({ kind: 'file', part }); continue }
    if (isStaticToolUIPart(part)) {
      if (part.type === 'tool-ask_user') { out.push({ kind: 'ask', part }); continue }
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.parts.push(part); else out.push({ kind: 'tools', parts: [part] })
    }
  }
  return out
}

/** What the agent is doing right now, from its latest tool call. */
function statusFor(last?: UIMessage): string {
  const tools = last?.parts.filter(isStaticToolUIPart) ?? []
  const t = tools[tools.length - 1]
  if (!t) return '正在思考…'
  const busy = t.state !== 'output-available' && t.state !== 'output-error'
  switch (t.type) {
    case 'tool-get_schema': return '正在读取数据结构…'
    case 'tool-load_skill': return '正在加载建模经验…'
    case 'tool-query': return busy ? '正在查询数据…' : '正在整理结果…'
    case 'tool-propose_schema': return busy ? '正在建表…' : '正在整理结果…'
    case 'tool-edit_app': return busy ? 'Boris 正在沙箱里写界面,通常两到五分钟…' : '正在整理结果…'
    case 'tool-write_app_file': return '正在修改界面代码…'
    case 'tool-read_app_file': case 'tool-list_app_files': return '正在阅读界面代码…'
  }
  return '正在思考…'
}

const STEP_LABEL: Record<string, (out: any) => string> = {
  'tool-get_schema': () => '读取结构',
  'tool-load_skill': (o) => `参考经验 ${o?.name ?? ''}`.trim(),
  'tool-query': (o) => o?.kind === 'write' ? `写入 ${o.rowCount} 行` : `查询 ${o?.rowCount ?? '…'} 行`,
  'tool-propose_schema': (o) => !o ? '修改结构' : o.needsConfirmation ? `提出 ${o.changes?.length ?? 0} 项变更` : (o.changes?.length ?? 0) === 0 ? '结构无需变更' : `应用 ${o.changes.length} 项变更`,
  'tool-list_app_files': () => '查看代码',
  'tool-read_app_file': (o) => `读 ${(o?.path ?? '').split('/').pop()}`,
  'tool-write_app_file': (o) => `改 ${(o?.path ?? '').split('/').pop()}`,
  'tool-edit_app': () => '生成界面',
}

/** Lovable-style question card: radio options, a free-text option, skip / next. The pick is sent as the user's next message. */
function AskCard({ part, answered, disabled, onAnswer }: { part: ToolUIPart; answered: boolean; disabled: boolean; onAnswer: (text: string) => void }) {
  const inp = (part.input ?? {}) as { question?: string; options?: { label: string; description?: string }[] }
  const options = inp.options ?? []
  const [picked, setPicked] = useState(0)
  const [custom, setCustom] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  if (!inp.question) return null
  if (answered || collapsed)
    return (
      <button onClick={() => setCollapsed(false)} disabled={answered} className="w-full text-left rounded-xl border border-edge bg-panel px-4 py-3 text-[13px] text-fg-mid cursor-pointer disabled:cursor-default">
        <span className="text-fg-dim">问题 · </span>{inp.question}
      </button>
    )
  const isCustom = picked === options.length
  const answer = isCustom ? custom.trim() : options[picked]?.label ?? ''
  return (
    <div className="w-full rounded-xl border border-edge bg-panel overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="px-4 py-3.5 flex items-start gap-3 border-b border-edge/70">
        <p className="flex-1 text-[14px] leading-snug text-fg">{inp.question}</p>
        <button onClick={() => setCollapsed(true)} className="text-fg-dim hover:text-fg cursor-pointer shrink-0 mt-0.5" title="收起">
          <ChevronsDownUp className="size-3.5" />
        </button>
      </div>
      <div className="px-3 py-2 space-y-0.5">
        {options.map((o, i) => (
          <button key={i} onClick={() => setPicked(i)}
            className="w-full flex items-start gap-3 px-2 py-2 rounded-lg text-left hover:bg-panel-2/70 cursor-pointer">
            <Radio on={picked === i} />
            <span className="min-w-0">
              <span className={`block text-[13px] leading-snug ${picked === i ? 'text-fg font-medium' : 'text-fg-mid'}`}>{o.label}</span>
              {o.description && <span className="block text-[12px] text-fg-dim leading-snug mt-0.5">{o.description}</span>}
            </span>
          </button>
        ))}
        <div className="flex items-center gap-3 px-2 py-2">
          <button onClick={() => setPicked(options.length)} className="cursor-pointer shrink-0"><Radio on={isCustom} /></button>
          <input value={custom} onFocus={() => setPicked(options.length)} onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && answer) onAnswer(answer) }}
            placeholder="自己写…" className="flex-1 min-w-0 bg-transparent border border-edge rounded-lg px-3 py-1.5 text-[13px] text-fg placeholder:text-fg-dim focus:border-edge-strong" />
        </div>
      </div>
      <div className="px-3 py-2.5 border-t border-edge/70 flex items-center justify-end gap-2">
        <button onClick={() => onAnswer('跳过这个问题，按你的判断继续。')} disabled={disabled}
          className="px-3 py-1.5 text-[12.5px] text-fg-mid hover:text-fg cursor-pointer disabled:opacity-40">跳过</button>
        <button onClick={() => answer && onAnswer(answer)} disabled={disabled || !answer}
          className="px-3.5 py-1.5 text-[12.5px] rounded-lg bg-fg text-ink font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">下一步</button>
      </div>
    </div>
  )
}
function Radio({ on }: { on: boolean }) {
  return (
    <span className={`mt-0.5 size-4 rounded-full border shrink-0 grid place-items-center ${on ? 'border-fg' : 'border-edge-strong'}`}>
      {on && <span className="size-2 rounded-full bg-fg" />}
    </span>
  )
}

/**
 * One run often proposes each table in its own call, which would render three near-identical
 * "结构已更新 · 1 项" blocks. Fold them into a single result carrying every change.
 */
function mergedResults(parts: ToolUIPart[]): ToolUIPart[] {
  const out: ToolUIPart[] = []
  let schema: ToolUIPart | null = null
  for (const p of parts) {
    if (p.type !== 'tool-propose_schema') { out.push(p); continue }
    const o = p.output as any
    if (!schema) { schema = { ...p, output: { ...o, changes: [...(o.changes ?? [])] } } as ToolUIPart; out.push(schema); continue }
    const acc = schema.output as any
    acc.changes.push(...(o.changes ?? []))
    acc.needsConfirmation = acc.needsConfirmation || o.needsConfirmation
    acc.pendingId = acc.pendingId ?? o.pendingId
  }
  return out
}

/** Merge consecutive same-kind steps into one label: "应用 3 项变更", "参考经验 a, b", "查询 2 次". */
function stripSteps(parts: ToolUIPart[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < parts.length) {
    const t = parts[i].type
    let j = i
    while (j < parts.length && parts[j].type === t) j++
    const group = parts.slice(i, j).map((p) => p.output as any)
    if (group.length === 1) out.push(STEP_LABEL[t]?.(group[0]) ?? t.replace('tool-', ''))
    else if (t === 'tool-propose_schema') {
      const n = group.reduce((a, o) => a + (o?.changes?.length ?? 0), 0)
      out.push(group.some((o) => o?.needsConfirmation) ? `提出 ${n} 项变更` : n === 0 ? '结构无需变更' : `应用 ${n} 项变更`)
    } else if (t === 'tool-load_skill') out.push(`参考经验 ${group.map((o) => o?.name).filter(Boolean).join(', ')}`)
    else if (t === 'tool-query') out.push(`查询 ${group.length} 次`)
    else if (t === 'tool-read_app_file') out.push(`读 ${group.length} 个文件`)
    else if (t === 'tool-write_app_file') out.push(`改 ${group.length} 个文件`)
    else out.push(STEP_LABEL[t]?.(group[0]) ?? t.replace('tool-', ''))
    i = j
  }
  return out
}

/** One run of tool calls: a text progress line, expandable into plain text steps; results as text below. */
function ToolRun({ parts, live = false, pendingIds, onConfirm, onDiscard, onFocus }: {
  parts: ToolUIPart[]; live?: boolean; pendingIds: string[]
  onConfirm: (p: { pendingId: string; changes: Change[] }) => void
  onDiscard: (pendingId: string) => void
  onFocus?: (pane: Pane, file?: string) => void
}) {
  // Live runs unfold step by step (Manus-style); once the turn ends they fold back to one line unless the user opened them.
  const [open, setOpen] = useState(live)
  const touched = useRef(false)
  useEffect(() => { if (!touched.current) setOpen(live) }, [live])
  // Settled means *these tools* have all landed, which is not the same as the message being over:
  // the assistant keeps writing its summary afterwards. Tying this to `live` left the spinner
  // turning above a child that had already failed.
  const done = parts.every((p) => p.state === 'output-available' || p.state === 'output-error')
  const failed = parts.some((p) => p.state === 'output-error' || (p.output as any)?.error)
  const steps = stripSteps(parts)
  const results = parts.filter((p) => (p.type === 'tool-propose_schema' || p.type === 'tool-edit_app') && p.state === 'output-available' && !(p.output as any)?.error)
  return (
    <div className="space-y-2 w-full">
      <button onClick={() => { touched.current = true; setOpen((o) => !o) }}
        className="w-full flex items-center gap-2 text-[12px] text-fg-dim hover:text-fg-mid cursor-pointer text-left">
        {done
          ? <Check className={`size-3 shrink-0 ${failed ? 'text-warn' : 'text-fg-dim'}`} strokeWidth={2} />
          : <Loader2 className="size-3 shrink-0 text-fg animate-spin" strokeWidth={2} />}
        {done ? <span className="truncate">{steps.join(' · ')}</span> : <Shimmer className="truncate text-[12px]">{steps.join(' · ')}</Shimmer>}
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">{open ? '收起' : '详情'}</span>
      </button>
      {open && (
        <div className="pl-3.5 border-l border-edge space-y-2">
          {parts.map((p, i) => <ToolLine key={i} part={p} onFocus={onFocus} />)}
        </div>
      )}
      {mergedResults(results).map((p, i) => <ResultCard key={i} part={p} pendingIds={pendingIds} onConfirm={onConfirm} onDiscard={onDiscard} />)}
    </div>
  )
}

const STEP_ICON: Record<string, typeof Database> = {
  'tool-get_schema': Database, 'tool-propose_schema': Wand2, 'tool-query': Table2, 'tool-load_skill': Lightbulb,
  'tool-list_app_files': FolderTree, 'tool-read_app_file': FileCode, 'tool-write_app_file': FilePen, 'tool-edit_app': Sparkles,
}
/** Where on the right this step's work can be seen (Manus's "computer" panel is our workspace). */
function focusFor(part: ToolUIPart): { pane: Pane; file?: string } | null {
  const inp = part.input as any
  switch (part.type) {
    case 'tool-get_schema': case 'tool-propose_schema': return { pane: 'database' }
    case 'tool-query': return { pane: 'database' }
    case 'tool-list_app_files': return { pane: 'code' }
    case 'tool-read_app_file': case 'tool-write_app_file': return { pane: 'code', file: inp?.path }
    case 'tool-edit_app': return { pane: 'preview' }
    default: return null
  }
}

/** One expanded tool step as a text line: icon, label, summary. The line opens the matching pane; ⌄ shows raw output inline. */
function ToolLine({ part, onFocus }: { part: ToolUIPart; onFocus?: (pane: Pane, file?: string) => void }) {
  const out = part.output as any
  const label = TOOL_LABEL[part.type] ?? part.type
  const sub = summarize(part)
  const Icon = STEP_ICON[part.type] ?? Database
  const target = focusFor(part)
  const [show, setShow] = useState(false)
  const running = part.state !== 'output-available' && part.state !== 'output-error'
  return (
    <div className="text-[12px] animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="group flex items-center gap-2 min-w-0">
        {running ? <Loader2 className="size-3.5 shrink-0 text-fg animate-spin" strokeWidth={1.75} /> : <Icon className="size-3.5 shrink-0 text-fg-dim" strokeWidth={1.75} />}
        <button onClick={() => (target && onFocus ? onFocus(target.pane, target.file) : setShow((v) => !v))}
          className="text-fg-mid hover:text-fg cursor-pointer text-left truncate">
          {running ? <Shimmer className="text-[12px]">{`${label}…`}</Shimmer> : label}{sub && !running ? <span className="text-fg-dim"> · {sub}</span> : ''}
          {out?.error ? <span className="text-warn"> · {String(out.error).slice(0, 80)}</span> : ''}
        </button>
        {target && onFocus && <ArrowUpRight className="size-3 text-fg-dim opacity-0 group-hover:opacity-100 shrink-0" />}
        {out && <button onClick={() => setShow((v) => !v)} className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-dim hover:text-fg-mid cursor-pointer">{show ? '收起' : '输出'}</button>}
      </div>
      {show && out && <div className="mt-1 pl-5.5 text-fg-dim"><ToolOutputView type={part.type} output={out} /></div>}
    </div>
  )
}

/** Result of a schema change or UI generation, as text — no card chrome. */
function ResultCard({ part, pendingIds, onConfirm, onDiscard }: {
  part: ToolUIPart; pendingIds: string[]; onConfirm: (p: { pendingId: string; changes: Change[] }) => void; onDiscard: (pendingId: string) => void
}) {
  const out = part.output as any
  if (part.type === 'tool-propose_schema') {
    const pendingOpen = out.pendingId && pendingIds.includes(out.pendingId)
    return (
      <div className="pl-3.5 border-l border-edge">
        <p className="text-[12.5px] font-medium mb-1">{out.needsConfirmation ? '结构变更 · 等待确认' : '结构已更新'} <span className="text-fg-dim font-normal tabular-nums">· {out.changes?.length ?? 0} 项</span></p>
        <ChangeList changes={out.changes ?? []} plain />
        {pendingOpen && (
          <div className="pt-2 flex items-center gap-2">
            <button onClick={() => onConfirm({ pendingId: out.pendingId, changes: out.changes })}
              className="px-3 py-1.5 bg-accent text-on-accent rounded-lg text-[12.5px] font-medium hover:bg-accent-soft transition-colors cursor-pointer">查看并确认</button>
            <button onClick={() => onDiscard(out.pendingId)}
              className="px-3 py-1.5 border border-edge rounded-lg text-[12.5px] text-fg-mid hover:text-fg hover:border-edge-strong transition-colors cursor-pointer">放弃</button>
          </div>
        )}
      </div>
    )
  }
  if (part.type === 'tool-edit_app')
    return (
      <div className="pl-3.5 border-l border-edge">
        <p className="text-[12.5px] font-medium mb-1">界面已生成 <span className="text-fg-dim font-normal tabular-nums">· {Math.round((out.duration ?? 0) / 1000)}s</span></p>
        <div className="text-[12.5px] text-fg-mid max-h-40 overflow-y-auto"><MessageResponse>{out.summary ?? ''}</MessageResponse></div>
        {out.previewUrl && <p className="text-[11.5px] text-fg-dim mt-1">右侧预览已切换到最新版本</p>}
      </div>
    )
  return null
}


function summarize(part: ToolUIPart): string {
  const out = part.output as any
  if (part.state !== 'output-available' || !out) return part.state === 'output-error' ? '出错' : part.type === 'tool-edit_app' ? '沙箱里写代码中,通常两到五分钟' : ''
  if (out.error) return `出错:${String(out.error).slice(0, 60)}`
  switch (part.type) {
    case 'tool-get_schema': return `${out.ir?.entities?.length ?? 0} 张表`
    case 'tool-query': return out.kind === 'read' ? `${out.rowCount} 行` : `写入 ${out.rowCount} 行`
    case 'tool-propose_schema': return out.needsConfirmation ? `${out.changes?.length ?? 0} 项变更,等待确认` : `${out.changes?.length ?? 0} 项变更已应用`
    case 'tool-load_skill': return out.name ?? ''
    case 'tool-list_app_files': return `${out.files?.length ?? 0} 个文件`
    case 'tool-read_app_file': return out.path ?? ''
    case 'tool-write_app_file': return out.path ?? ''
    case 'tool-edit_app': return out.ok ? `完成,${Math.round((out.duration ?? 0) / 1000)}s` : '出错'
  }
  return ''
}

function ToolOutputView({ type, output }: { type: string; output: any }) {
  if (type === 'tool-query' && Array.isArray(output.rows) && output.rows.length > 0) {
    const cols = Object.keys(output.rows[0])
    return (
      <div className="overflow-x-auto">
        <table className="text-[12px] font-mono">
          <thead><tr>{cols.map((c) => <th key={c} className="text-left px-2 py-1 text-fg-dim font-medium border-b border-edge">{c}</th>)}</tr></thead>
          <tbody>
            {output.rows.slice(0, 20).map((r: any, i: number) => (
              <tr key={i} className="border-b border-edge/60 last:border-0">
                {cols.map((c) => <td key={c} className="px-2 py-1 text-fg-mid whitespace-nowrap max-w-[16rem] truncate">{r[c] == null ? '—' : String(r[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {(output.truncated || output.rows.length > 20) && <p className="text-[11px] text-fg-dim mt-1">只显示前 {Math.min(20, output.rows.length)} 行,共 {output.rowCount} 行</p>}
      </div>
    )
  }
  if (type === 'tool-get_schema' && output.ir) {
    return (
      <ul className="text-[12.5px] space-y-1">
        {output.ir.entities.map((e: any) => (
          <li key={e.id}><span className="text-fg">{e.name}</span> <span className="font-mono text-fg-dim">{e.dbName}</span>: <span className="text-fg-mid">{e.fields.map((f: any) => f.name).join('、')}</span></li>
        ))}
      </ul>
    )
  }
  if (type === 'tool-load_skill' && output.instructions) return <MessageResponse>{output.instructions}</MessageResponse>
  if (type === 'tool-edit_app' && output.summary) return <MessageResponse>{output.summary}</MessageResponse>
  if (type === 'tool-read_app_file' && output.content) return <pre className="text-[11.5px] font-mono whitespace-pre-wrap max-h-64 overflow-auto">{output.content}</pre>
  return <pre className="text-[11.5px] font-mono whitespace-pre-wrap">{JSON.stringify(output, null, 2).slice(0, 4000)}</pre>
}

/** Show `@[path]` tokens in user messages as the same chips the editor uses. */
function withChips(text: string) {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(/@\[([^\]]+)\]/g)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    out.push(<span key={m.index} className="file-chip" title={m[1]}>{m[1].split('/').pop()}</span>)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}


/** True while the saved transcript ends on a tool call that never got its result. */
function hasOpenRun(chat: UIMessage[] | undefined): boolean {
  const last = chat?.[chat.length - 1]
  if (!last || last.role !== 'assistant') return false
  return last.parts.some((p) => isStaticToolUIPart(p) && p.state !== 'output-available' && p.state !== 'output-error')
}

const textOf = (m: UIMessage) => m.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n').trim()

/** Copy / edit / regenerate, revealed on hover so they never crowd the transcript. */
/**
 * A popup anchored above a trigger, rendered into `document.body`.
 *
 * The composer wraps everything in `InputGroup className="overflow-hidden"` (vendored), so an
 * absolutely-positioned menu inside it gets clipped to the input box — which is how the tier list
 * ended up as one half-visible row lying across the placeholder text. Portalling escapes every
 * ancestor's overflow; the position is measured from the trigger each time it opens.
 */
function AnchoredPopup({ anchorRef, open, onClose, width, children }: {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean; onClose: () => void; width: number; children: React.ReactNode
}) {
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null)

  useEffect(() => {
    if (!open) { setBox(null); return }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      // Keep it on screen when the trigger sits near the right edge.
      setBox({ left: Math.min(r.left, window.innerWidth - width - 8), bottom: window.innerHeight - r.top + 6 })
    }
    place()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, width, anchorRef, onClose])

  if (!open || !box || typeof document === 'undefined') return null
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div style={{ left: box.left, bottom: box.bottom, width }}
        className="fixed z-[61] rounded-lg border border-edge bg-panel shadow-xl overflow-hidden">
        {children}
      </div>
    </>,
    document.body,
  )
}

/**
 * Which of the admin's tiers answers this turn.
 *
 * Tiers rather than model names on purpose: the admin can point 标准 at a different model tomorrow
 * without anybody's saved preference breaking, and `gpt-5.6-sol` tells a user nothing about what
 * it will cost them. Hidden entirely when there is no choice to make.
 */
function TierPicker({ options, value, onChange }: {
  options: { tier: string; label: { zh: string; en: string }; model: string; isDefault: boolean }[]
  value: string; onChange: (t: string) => void
}) {
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (options.length < 2) return null
  const current = options.find((o) => o.tier === value) ?? options.find((o) => o.isDefault) ?? options[0]
  const name = (o: (typeof options)[number]) => (locale === 'en' ? o.label.en : o.label.zh)
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)} title={`${name(current)} · ${current.model}`}
        className="h-7 px-1.5 rounded-lg text-[12px] text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer inline-flex items-center gap-1">
        {name(current)}
        <ChevronDown className="size-3 opacity-60" strokeWidth={2} />
      </button>
      <AnchoredPopup anchorRef={btn} open={open} onClose={() => setOpen(false)} width={224}>
        {options.map((o) => (
          <button type="button" key={o.tier}
            onMouseDown={(e) => { e.preventDefault(); onChange(o.tier); setOpen(false) }}
            className="w-full text-left px-3 py-2 hover:bg-panel-2 cursor-pointer flex items-center gap-2">
            <Check className={`size-3.5 shrink-0 ${o.tier === current.tier ? 'text-fg' : 'opacity-0'}`} strokeWidth={2} />
            <span className="text-[12.5px] text-fg flex-1">{name(o)}</span>
            <span className="font-mono text-[10.5px] text-fg-dim truncate max-w-24">{o.model}</span>
          </button>
        ))}
      </AnchoredPopup>
    </>
  )
}

function MessageActions({ message, disabled, onCopy, onEdit, onRetry }: {
  message: UIMessage; disabled: boolean
  onCopy: () => void; onEdit?: () => void; onRetry?: () => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  if (!textOf(message)) return null
  const mine = message.role === 'user'
  return (
    <div className={`flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity ${mine ? 'justify-end' : ''}`}>
      <IconBtn title={copied ? t('chat.copied', '已复制') : t('chat.copy', '复制')} onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </IconBtn>
      {onEdit && <IconBtn title={t('chat.edit', '编辑并重新发送')} onClick={onEdit} disabled={disabled}><Pencil className="size-3.5" /></IconBtn>}
      {onRetry && <IconBtn title={t('chat.retry', '重新生成')} onClick={onRetry} disabled={disabled}><RefreshCw className="size-3.5" /></IconBtn>}
    </div>
  )
}
function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      className="size-6 grid place-items-center rounded-md text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
      {children}
    </button>
  )
}

/** Skills the agent can draw on; picking one states the intent in the prompt. */
function SkillPicker({ skills }: { skills: { name: string; description: string }[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (skills.length === 0) return null
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)} title={t('chat.skills', '技能')}
        className="size-7 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer">
        <Lightbulb className="size-4" strokeWidth={1.75} />
      </button>
      <AnchoredPopup anchorRef={btn} open={open} onClose={() => setOpen(false)} width={288}>
        <p className="px-3 pt-2 pb-1 text-[10.5px] text-fg-dim">技能 · agent 会在相关时自动调用</p>
        {skills.map((sk) => (
          <button type="button" key={sk.name}
            onMouseDown={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('lovbase:insert', { detail: { text: `参考「${sk.name}」技能:` } })); setOpen(false) }}
            className="w-full text-left px-3 py-2 hover:bg-panel-2 cursor-pointer">
            <span className="block text-[12.5px] text-fg">{sk.name}</span>
            <span className="block text-[11.5px] text-fg-dim leading-snug">{sk.description}</span>
          </button>
        ))}
      </AnchoredPopup>
    </>
  )
}

const BORIS_TOOL: Record<string, string> = {
  read: '读取文件', edit: '编辑文件', write: '写入文件', bash: '执行命令',
  list: '列出目录', glob: '查找文件', grep: '搜索代码', multiedit: '批量编辑',
}
/** What Boris is doing at this instant, phrased for someone watching rather than debugging. */
function describeStep(s?: { tool: string; path?: string; status: string }): string {
  if (!s) return 'Boris 正在准备沙箱…'
  const verb = BORIS_TOOL[s.tool] ?? s.tool
  return s.path ? `Boris 正在${verb} ${s.path}` : `Boris 正在${verb}`
}

/** Live view of the Boris turn: what it is editing right now, with the code streaming in. */
function BorisPanel({ projectId, appId, onFocus }: { projectId: string; appId: string; onFocus?: (pane: Pane, file?: string) => void }) {
  const poll = useServerFn(buildActivity)
  const [a, setA] = useState<{ steps: { tool: string; path?: string; status: string }[]; text: string; code: string; codePath?: string } | null>(null)
  const codeRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => { try { const r = await poll({ data: { projectId, appId } }); if (alive) setA(r) } catch { /* keep the last frame */ } }
    tick()
    const id = setInterval(tick, 900)
    return () => { alive = false; clearInterval(id) }
  }, [projectId, appId])
  useEffect(() => { const el = codeRef.current; if (el) el.scrollTop = el.scrollHeight }, [a?.code])
  const steps = a?.steps ?? []
  const current = steps.findLast((s) => s.status === 'running') ?? steps[steps.length - 1]
  return (
    <div className="w-full space-y-2 animate-in fade-in duration-300">
      <div className="flex items-center gap-2 text-[12px]">
        <Loader2 className="size-3.5 shrink-0 text-fg animate-spin" strokeWidth={2} />
        <Shimmer className="truncate text-[12px]">{describeStep(current)}</Shimmer>
        {steps.length > 0 && <span className="ml-auto shrink-0 text-[11px] text-fg-dim tabular-nums">{steps.filter((s) => s.status !== 'running').length}/{steps.length}</span>}
      </div>
      {steps.length > 0 && (
        <div className="pl-3.5 border-l border-edge space-y-1">
          {steps.slice(-6).map((st, i) => (
            <button key={i} onClick={() => st.path && onFocus?.('code', st.path)}
              className="flex items-center gap-2 text-[12px] w-full text-left cursor-pointer group">
              {st.status === 'running'
                ? <Loader2 className="size-3.5 shrink-0 text-fg animate-spin" strokeWidth={1.75} />
                : <Check className={`size-3 shrink-0 ${st.status === 'failed' ? 'text-warn' : 'text-fg-dim'}`} strokeWidth={2} />}
              <span className="truncate text-fg-mid group-hover:text-fg">{st.path ?? BORIS_TOOL[st.tool] ?? st.tool}</span>
            </button>
          ))}
        </div>
      )}
      {a?.code && (
        <div className="rounded-lg border border-edge bg-panel-2/50 overflow-hidden">
          {a.codePath && <p className="px-3 pt-1.5 text-[11px] font-mono text-fg-dim truncate">{a.codePath}</p>}
          <pre ref={codeRef} className="max-h-44 overflow-y-auto px-3 pb-2 pt-1 text-[11px] leading-[1.5] font-mono text-fg-mid whitespace-pre-wrap break-words">
            {a.code.slice(-2400)}
            <span className="inline-block w-[6px] h-[11px] -mb-[1px] ml-px bg-fg/70 animate-pulse" />
          </pre>
        </div>
      )}
    </div>
  )
}

/** The chat transport surfaces a 402 body as the error message; detect the paywall in it. */
const outOfCredits = (e: Error) => /out_of_credits|额度/.test(e.message)


/** Fires once when the paywall is shown; the rate of this is the clearest pricing signal we get. */
function OutOfCreditsSignal() {
  useEffect(() => { track('out_of_credits') }, [])
  return null
}
