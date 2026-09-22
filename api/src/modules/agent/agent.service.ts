import { Injectable } from '@nestjs/common'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, hasToolCall, stepCountIs, streamText, tool, type StreamTextResult, type UIMessage } from 'ai'
import { z } from 'zod'
import { IR } from '@lovbase/core/ir'
import { irToDDL } from '@lovbase/core/ddl'
import { AppsService } from '../apps/apps.service'
import { CreditsService, OutOfCredits } from '../credits/credits.service'
import type { LlmConfig } from '../llm/llm.service'
import { ProjectsService, schemaFor } from '../projects/projects.service'
import type { Project } from '../projects/project.types'
import type { RunProgress } from '../projects/conversation.service'
import { ProposeService } from '../modeling/propose.service'
import { RolesService } from '../roles/roles.service'
import { SandboxService } from '../sandbox/sandbox.service'
import { SqlService } from '../sql/sql.service'
import { SkillsService } from './skills.service'
import { RatesService } from '../billing/rates.service'
import { ConfigService } from '../../config/config.service'
import { summarize as borisSummary } from './boris'

// ── The modeling agent: AI SDK tool loop over the same capabilities as the data API and the sandbox CLI. ──

const SYSTEM = (schemaSnapshot: string, skillIndex: string, checklist: string) => `You are Lovbase's agent. Lovbase turns natural language into a real Postgres database (tables = entities, columns = fields) with an app on top. You help the user shape their data model, look at and fix their data, import data they bring, and build or change the app's UI. You decide which of these a request needs — never tell the user to switch modes or go elsewhere.

How to work:
- Say what you are about to do BEFORE calling tools, in one or two plain sentences ("我来建三张表:客户、联系人、跟进记录,客户带状态字段。"). Then do it. Then summarise the result in one or two sentences. Never leave the user staring at tool calls with no words.
- Be decisive. When the request describes an app well enough (a template-style sentence naming the things to manage), build it now — no clarifying question. When two readings would produce materially different results (structure, or a style/theme choice), ask with the ask_user tool: ONE question, 2–4 concrete options with a one-line description each, and then STOP (the user's pick arrives as their next message). Never ask in plain prose and never ask more than one question per turn.
- Reply in the user's language, briefly and concretely. Use markdown lightly (short lists, bold, small tables), never dump raw JSON.

Current data model (authoritative snapshot at the start of this turn; call get_schema only if you changed it during this turn and need ids):
${schemaSnapshot}

Tools:
- get_schema: the current model (IR) and DDL. Call it before reasoning about structure; the IR is the source of truth.
- query: run ONE SQL statement (SELECT/INSERT/UPDATE/DELETE) as the workspace role. Inspect real data before modeling, answer data questions, make data changes the user asks for, import rows. Reads are capped at 1000 rows; batch inserts ≤50 rows per call with $1.. params.
- propose_schema: submit the COMPLETE updated IR in ONE call — all new tables together, even when they link to each other (a link to a table created in the same call uses that table's dbName as linkTo; the server resolves it). Never split one request into several calls. Additive changes apply immediately; destructive ones (drop table/field, type change) wait for the user's confirmation in the UI — tell them so.
- load_skill: pull in a skill's full instructions when its description matches the task (the modeling checklist below is already included; load others only when relevant). Available skills:
${skillIndex}
- list_app_files / read_app_file / write_app_file: the generated app's source (Vite + React + Tailwind + shadcn/ui, sandboxed). Read before you answer questions about the UI. Use write_app_file for small, targeted edits you can make confidently in one file (a colour, a label, a column, a default), then say what you changed.
- edit_app: hand a brief to Boris, the coding agent inside the sandbox for anything bigger — new pages, features, layouts, multi-file work. It takes minutes; write a concrete brief (which pages, which tables/fields, what the user asked for, what to keep). It returns the preview URL; tell the user the preview updated.

Attachments: images are visible to you directly; text-like files (CSV, JSON, Markdown, TXT) arrive as text blocks labelled with the file name. A spreadsheet usually means "build a table and import this" — load the import-spreadsheet skill.

Iron rules for the IR — breaking these destroys user data:
1. Every existing entity and field MUST keep its exact "id". Never invent, change, or reuse ids.
2. New entities/fields get "id": "". The server assigns real ids.
3. Never remove or change entities/fields the user did not ask to change.
4. "dbName" is snake_case ascii ([a-z][a-z0-9_]*), stable and English; "name" is the display label in the user's language.
5. "dbName" must not be "id" or "created_at" (system columns).

Modeling judgment:
- A field with a fixed set of states is type "select" with options, never free text.
- A reference to another entity is type "link" with linkTo = that entity's id (or its dbName when it is new in the same proposal), never a text field holding a name.
- Prefer fewer, well-named fields. Only model what the description implies.
- Dates/times are "date"; money/quantity "number"; yes-no "boolean".

After propose_schema succeeds, summarize what changed in one or two sentences. Never claim a change you did not submit.

${checklist}`

/**
 * What a reconnecting browser is shown: every tool call as it starts and finishes, and what the
 * model said on the way.
 *
 * The turn's assistant message is only written to the transcript once the turn ends, so for the
 * minutes in between this row is the only account of it. Steps are taken from the tools
 * themselves, which are definitely ours; the text comes from the step callback, and used to be
 * reported as the empty string — so a page reloaded mid-turn restored the spinners but never the
 * sentence explaining what they were for.
 */
function progressOf(onProgress?: (p: RunProgress) => void) {
  const steps: { tool: string; done: boolean }[] = []
  let text = ''
  // Capped like the transcript's own: this is a live status, not a second copy of the answer.
  const report = () => onProgress?.({ text: text.slice(-4000), steps: steps.slice(-12) })
  return {
    say(chunk: string) {
      if (!chunk) return
      text += text ? `\n\n${chunk}` : chunk
      report()
    },
    wrap<T extends Record<string, any>>(tools: T): T {
      if (!onProgress) return tools
      const out: Record<string, any> = {}
      for (const [name, tool] of Object.entries(tools)) {
        out[name] = {
          ...tool,
          execute: async (args: any, opts: any) => {
            const entry = { tool: name, done: false }
            steps.push(entry)
            report()
            try { return await tool.execute(args, opts) } finally { entry.done = true; report() }
          },
        }
      }
      return out as T
    },
  }
}

/**
 * Minimum charge for a UI build, in credits.
 *
 * This is a stand-in for Boris's *tokens*, not for its compute. The container is cheap — a
 * three-minute build is fractions of a cent — but the coding agent inside it runs for minutes
 * against a real model, and the sandbox contract does not report that usage back. Charging only
 * the measured seconds would therefore under-price the most expensive thing the product does by
 * two orders of magnitude.
 *
 * Delete this the day the sandbox returns pi's token counts, and charge the real number instead.
 */
const BUILD_FLOOR_CREDITS = 20

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s)

const TEXT_LIKE = /^(text\/|application\/(json|csv|x-ndjson))/
const TEXT_EXT = /\.(csv|tsv|txt|md|json|sql|xml|yaml|yml)$/i

/** Non-image files become labelled text blocks; OpenAI-compatible gateways rarely accept arbitrary file parts. */
function inlineTextFiles(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((part) => {
      if (part.type !== 'file' || part.mediaType.startsWith('image/')) return part
      const name = part.filename ?? 'file'
      if (!(TEXT_LIKE.test(part.mediaType) || TEXT_EXT.test(name))) {
        return { type: 'text' as const, text: `[附件 ${name}(${part.mediaType})无法读取:只支持图片和文本类文件]` }
      }
      let text = ''
      try {
        const b64 = part.url.split(',')[1] ?? ''
        text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      } catch { text = '(decode failed)' }
      return { type: 'text' as const, text: `[附件 ${name}]\n\`\`\`\n${trunc(text, 60_000)}\n\`\`\`` }
    }),
  }))
}

/** Compact, human-readable schema for the system prompt. Ids included so proposals can reference them without a round trip. */
function snapshot(project: Project): string {
  const p = project.ir
  if (!p.entities.length) return '(empty — no tables yet)'
  return p.entities.map((e) => `- ${e.name} \`${e.dbName}\` (id ${e.id}): ` + e.fields.map((f) =>
    `${f.name} \`${f.dbName}\` [${f.type}${f.options ? ': ' + f.options.join('/') : ''}${f.linkTo ? ' → ' + (p.entities.find((x) => x.id === f.linkTo)?.dbName ?? f.linkTo) : ''}] (id ${f.id})`).join(', ')).join('\n')
}

const REF_RE = /@\[([^\]]+)\]/g

@Injectable()
export class AgentService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly apps: AppsService,
    private readonly roles: RolesService,
    private readonly sql: SqlService,
    private readonly propose: ProposeService,
    private readonly sandbox: SandboxService,
    private readonly credits: CreditsService,
    private readonly skills: SkillsService,
    private readonly rates: RatesService,
    private readonly cfg: ConfigService,
  ) {}

  /** `@[path]` chips in the latest user message become labelled file blocks read from the sandbox. */
  private async expandFileRefs(appId: string, messages: UIMessage[]): Promise<UIMessage[]> {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return messages
    const paths = new Set<string>()
    for (const part of last.parts) if (part.type === 'text') for (const m of part.text.matchAll(REF_RE)) paths.add(m[1])
    if (paths.size === 0) return messages
    const blocks = await Promise.all([...paths].map(async (path) => {
      try { const r = await this.sandbox.readFile(appId, path); return `[文件 ${path}]\n\`\`\`\n${trunc(r.content, 40_000)}\n\`\`\`` }
      catch (e) { return `[文件 ${path} 读取失败:${e instanceof Error ? e.message : String(e)}]` }
    }))
    const parts = last.parts.map((p) => (p.type === 'text' ? { ...p, text: p.text.replace(REF_RE, '文件 $1') } : p))
    return [...messages.slice(0, -1), { ...last, parts: [...parts, { type: 'text' as const, text: blocks.join('\n\n') }] }]
  }

  private tools(project: Project, cfg: LlmConfig, appId: string, userId: string, onCharge?: (credits: number) => void) {
    const app = { workspaceId: project.id, apiToken: project.api_token }
    return {
      list_app_files: tool({
        description: 'List source files of the generated app.',
        inputSchema: z.object({}),
        execute: async () => {
          try { const r = await this.sandbox.files(appId); return { files: r.files.map((f) => f.path) } }
          catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
        },
      }),
      read_app_file: tool({
        description: 'Read one source file of the generated app.',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          try { const r = await this.sandbox.readFile(appId, path); return { path, content: trunc(r.content, 40_000) } }
          catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
        },
      }),
      write_app_file: tool({
        description: 'Overwrite one source file of the generated app with the full new content. For small, confident edits only; the preview hot-reloads.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => {
          try { await this.sandbox.writeFile(appId, path, content); return { ok: true, path, bytes: content.length } }
          catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
        },
      }),
      edit_app: tool({
        description: 'Ask Boris, the sandbox coding agent, to build or change the app UI from a brief. Slow (minutes). Returns the preview URL.',
        inputSchema: z.object({ brief: z.string().describe("Concrete instructions for the coding agent, in the user's language.") }),
        execute: async ({ brief }) => {
          try {
            await this.credits.assert(userId, 'build_app')
            await this.sandbox.restoreIfFresh(appId, () => this.apps.loadSnapshot(appId))
            // The agent is not handed the gateway or its key. It is handed a relative path to the
            // relay on this server — the sandbox resolves it against the one host a container is
            // guaranteed to reach — and the workspace's own token as its credential. The relay
            // resolves the real model from that. See llm-relay.controller.ts for why.
            const r = await this.sandbox.run(appId, { ...app, prompt: brief, llm: { baseUrl: '/api/llm/v1', apiKey: project.api_token, model: cfg.model } })
            // Container time is measured; Boris's own token use is not, because the coding agent
            // runs inside the sandbox and the contract does not report it back yet. Until it does,
            // a build is under-charged by whatever pi spent — the single largest known gap in the
            // meter, and the reason build_app keeps a floor on top of the measured seconds.
            const container = await this.rates.forContainer(r.duration ?? 0)
            const charged = Math.max(container.credits, BUILD_FLOOR_CREDITS)
            onCharge?.(charged)
            await this.credits.charge(userId, {
              kind: 'build_app',
              credits: charged,
              costUsd: container.costUsd,
              containerMs: r.duration ?? 0,
              byok: cfg.source === 'user',
              projectId: project.id, model: cfg.model, note: brief.slice(0, 120),
            })
            await this.sandbox.snapshot(appId, (files) => this.apps.saveSnapshot(appId, files))
            // A built copy in object storage, so reopening this app later shows it at once instead
            // of waking a container to boot a dev server. Deliberately not awaited: the user has
            // their answer, and a snapshot that fails is a slower reopen, never a failed turn.
            if (r.ok) void this.keepBuilt(appId)
            // A failed build's summary is the reason it failed, not a digest of the transcript it
            // did not produce. The transcript is never empty — pi writes session events before it
            // ever reaches the model — so `output || stderr` always chose the transcript, and the
            // one line that said "Connection error" was the one line nobody saw.
            const summary = r.ok
              ? trunc(borisSummary((r.output || r.stderr || '').trim()), 4000)
              : (r.stderr.trim().split('\n')[0] || '构建没有完成').slice(0, 600)
            return { ok: r.ok, previewUrl: r.previewUrl, summary, duration: r.duration }
          } catch (err) {
            if (err instanceof OutOfCredits) return { error: '额度不足,生成界面需要 5 点额度,请升级或等待下个周期' }
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),
      ask_user: tool({
        description: 'Ask the user one multiple-choice question and end the turn. Use only when the answer materially changes what you would build.',
        inputSchema: z.object({
          question: z.string(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
        }),
        execute: async () => ({ asked: true }),
      }),
      get_schema: tool({
        description: 'Current data model (IR) and DDL of this workspace.',
        inputSchema: z.object({}),
        execute: async () => {
          const p = await this.projects.get(project.id)
          return { ir: p.ir, ddl: irToDDL(p.ir, schemaFor(p.id)) }
        },
      }),
      query: tool({
        description: 'Run one SQL statement as the workspace role. Table names are the dbName values from the schema. Use $1.. placeholders with params.',
        inputSchema: z.object({ sql: z.string(), params: z.array(z.any()).optional() }),
        execute: async ({ sql, params }) => {
          try {
            const role = await this.roles.ensureWorkspaceRole(project.id)
            const r = await this.sql.run(role, schemaFor(project.id), sql, params ?? [])
            return { kind: r.kind, rowCount: r.rowCount, rows: r.rows.slice(0, 50), truncated: r.truncated || r.rows.length > 50 }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),
      propose_schema: tool({
        description: "Submit the complete updated IR. Returns the diff and whether it was applied or is pending the user's confirmation.",
        inputSchema: z.object({ ir: IR }),
        execute: async ({ ir }) => {
          try {
            const next = this.propose.parse(ir)
            const p = await this.projects.get(project.id)
            const r = await this.propose.propose(p, next)
            return { applied: r.applied, needsConfirmation: !!r.needsConfirmation, pendingId: r.pendingId, changes: r.changes }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err), hint: 'Fix the IR and call propose_schema again. Keep every existing id.' }
          }
        },
      }),
      load_skill: tool({
        description: "Load the full instructions of a skill by name.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const s = this.skills.find(name)
          return s ? { name: s.name, instructions: s.body } : { error: `unknown skill ${name}` }
        },
      }),
    }
  }

  /** Build the app and keep the result. Best effort, and never on the turn's critical path. */
  private async keepBuilt(appId: string) {
    // A build nobody can serve is a build worth skipping: without the sandbox's bucket configured
    // here, the snapshot route answers 404 and this would only spend container seconds.
    if (!this.cfg.snapshotsConfigured) return
    try {
      const r = await this.sandbox.snapshotBuild(appId)
      if (r.ok) await this.apps.markSnapshotted(appId)
    } catch { /* the sandbox has no store, or the build failed; the app simply has no snapshot */ }
  }

  async stream(
    project: Project, cfg: LlmConfig, messages: UIMessage[],
    appId: string, appName: string, userId: string,
    onProgress?: (p: RunProgress) => void,
    /** Credits spent inside the turn by a tool, so the turn can report what it cost in total. */
    onCharge?: (credits: number) => void,
    // Widened on purpose: the inferred result names AI SDK internals that declaration emit cannot
    // reference portably, and the only caller just pipes `toUIMessageStreamResponse` to the client.
  ): Promise<StreamTextResult<any, any, any>> {
    const provider = createOpenAICompatible({ name: 'lovbase', baseURL: cfg.baseURL, apiKey: cfg.apiKey })
    const fresh = (await this.projects.find(project.id)) ?? project
    const system = SYSTEM(snapshot(fresh), this.skills.index(), this.skills.find('modeling-checklist')?.body ?? '')

    const progress = progressOf(onProgress)
    return streamText({
      model: provider.chatModel(cfg.model),
      system: system + `\n\nThe user is currently working on the app named "${appName}" (one workspace can have several apps sharing the same data); all app tools act on that app.`,
      messages: await convertToModelMessages(inlineTextFiles(await this.expandFileRefs(appId, messages))),
      tools: progress.wrap(this.tools(project, cfg, appId, userId, onCharge)),
      onStepFinish: onProgress ? ({ text }) => progress.say(text) : undefined,
      stopWhen: [stepCountIs(10), hasToolCall('ask_user')],
    })
  }
}
