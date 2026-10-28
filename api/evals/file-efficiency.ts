/** Same-model, isolated source editing comparison. Never writes to an application or its billing ledger. */
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ts from 'typescript'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, generateText, stepCountIs, tool, type UIMessage } from 'ai'
import { z } from 'zod'
import { appFileTools, appSourcePath, applySourceEdits } from '../src/modules/agent/app-file-tools'
import { compactFileContext } from '../src/modules/agent/file-context'
import { usageObserver, type ObservedUsage } from '../src/modules/agent/model-usage'
import { SOURCE_SEARCH_SCRIPT } from '@lovbase/sandbox/source-search'
import { creditsForTokens, type ModelRate } from '@lovbase/core/billing'

const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = process.env
if (!LLM_BASE_URL || !LLM_MODEL) throw new Error('Configure LLM_BASE_URL and LLM_MODEL before running this paid provider evaluation.')
const rate: ModelRate | undefined = process.env.EVAL_MODEL_RATE ? JSON.parse(process.env.EVAL_MODEL_RATE) : undefined
const margin = Number(process.env.EVAL_MARGIN ?? '1.5')
const padding = Array.from({ length: 150 }, (_, i) => `// Existing unrelated feature ${i}: preserve layout, keyboard navigation, and saved game state.\n`).join('')
const source = {
  'theme.ts': 'export const accent = "orange";\nexport const link = "https://example.com";\nexport const position = "top";\n' + padding,
  'game.ts': 'export type Phase = "menu" | "playing" | "ended";\nexport function visible(phase: Phase, dismissed: boolean) { return true; }\n' + padding,
}
const cases = [
  { name: 'style-links', prompt: 'In src/theme.ts change accent to blue, link to https://lovbase.dev/, and position to bottom-right. Preserve other content.', history: false },
  { name: 'cross-file', prompt: 'In src/theme.ts change position to bottom-right. In src/game.ts make visible return true only before/after playing and when not dismissed. Preserve exports.', history: false },
  { name: 'long-history', prompt: 'In src/theme.ts change accent to blue, link to https://lovbase.dev/, and position to bottom-right. Preserve other content.', history: true },
]
const legacyInstructions = 'List app files, then read the files you will touch. Never write an existing file you have not read this turn. Prefer edit_app_file (find/replace one exact passage) for changes inside a file. Keep each edit to one intention. After edits run bun run typecheck and fix errors.'
const optimizedInstructions = 'Known paths need no listing. Read relevant ranges together with read_app_files. Use search_app_files if needed to locate code. Apply related edits together with edit_app_files. Read current passages before edits. On the final edit_app_files call set check=typecheck to validate in the same call; fix reported errors. Historical source may be omitted; reread if necessary.'
const results = []
const modes = process.env.EVAL_MODE === 'optimized' ? ['optimized'] as const : ['baseline', 'optimized'] as const
for (const scenario of cases) for (const mode of modes) {
  const root = await mkdtemp(join(tmpdir(), 'lovbase-efficiency-'))
  await mkdir(join(root, 'src'))
  for (const [path, content] of Object.entries(source)) await writeFile(join(root, 'src', path), content)
  let validations = 0
  const requests: (ObservedUsage | null)[] = []
  const read = async (_app: string, path: string) => ({ path, content: await readFile(join(root, appSourcePath(path)), 'utf8') })
  const write = async (_app: string, path: string, content: string) => {
    await writeFile(join(root, appSourcePath(path, true)), content)
    return { ok: true as const, path }
  }
  const check = () => {
    const program = ts.createProgram(Object.keys(source).map(path => join(root, 'src', path)), { noEmit: true, strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, skipLibCheck: true, types: [] })
    return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')
  }
  const sandbox = {
    readFile: read, writeFile: write,
    files: async () => ({ files: await Promise.all((await readdir(join(root, 'src'))).map(async name => ({ path: 'src/' + name, size: (await readFile(join(root, 'src', name))).length }))) }),
    exec: async (_app: string, command: string) => {
      if (command !== 'bun run typecheck') return { ok: false, stdout: '', stderr: 'Only bun run typecheck is needed and available in this fixture.' }
      validations++
      const stderr = check()
      return { ok: !stderr, stdout: '', stderr }
    },
    searchSource: async (_app: string, input: unknown) => {
      const result = await promisify(execFile)(process.execPath, ['-e', SOURCE_SEARCH_SCRIPT, root, JSON.stringify(input)])
      return JSON.parse(result.stdout)
    },
  }
  const optimized = appFileTools({ sandbox, appId: 'fixture', ensureSource: async () => {}, persist: async () => {} })
  const baseline = {
    list_app_files: optimized.list_app_files,
    read_app_file: tool({ description: 'Read one whole application source file.', inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => { const result = await read('fixture', path); return { ...result, content: result.content.slice(0, 40000) } } }),
    edit_app_file: tool({ description: 'Replace one exact passage.', inputSchema: z.object({ path: z.string(), find: z.string(), replace: z.string() }), execute: async ({ path, find, replace }) => {
      try { return await write('fixture', path, applySourceEdits((await read('fixture', path)).content, [{ find, replace }])) }
      catch (error) { return { error: String(error) } }
    } }),
    write_app_file: optimized.write_app_file, run_app_command: optimized.run_app_command,
  }
  const history: UIMessage[] = scenario.history ? [
    { id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'Inspect source and keep all exports.' }] },
    { id: 'old-assistant', role: 'assistant', parts: [
      ...Object.entries(source).map(([path, content], i) => ({ type: 'tool-read_app_file' as const, state: 'output-available' as const, toolCallId: 'old-' + i, input: { path: 'src/' + path }, output: { path: 'src/' + path, content } })),
      { type: 'text', text: 'Inspected theme and game source. Exports are unchanged.' },
    ] },
  ] : []
  history.push({ id: 'user', role: 'user', parts: [{ type: 'text', text: scenario.prompt }] })
  try {
    const provider = createOpenAICompatible({ name: 'lovbase-eval', baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY ?? 'none', fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (!response.ok || !response.body) { requests.push(null); return response }
      const headers = new Headers(response.headers)
      headers.delete('content-length'); headers.delete('content-encoding')
      return new Response(response.body.pipeThrough(usageObserver(response.headers.get('content-type') ?? '', async usage => { requests.push(usage) })), { headers, status: response.status })
    } })
    await generateText({
      model: provider.chatModel(LLM_MODEL), maxRetries: 0, stopWhen: stepCountIs(12),
      abortSignal: AbortSignal.timeout(180_000),
      system: 'You edit TypeScript application files. Make the requested changes with tools. ' + (mode === 'baseline' ? legacyInstructions : optimizedInstructions),
      messages: await convertToModelMessages(mode === 'baseline' ? history : compactFileContext(history)),
      tools: mode === 'baseline' ? baseline : optimized,
    })
    const theme = await import(pathToFileURL(join(root, 'src/theme.ts')).href)
    const game = await import(pathToFileURL(join(root, 'src/game.ts')).href)
    const passed = !check() && validations > 0 && (scenario.name === 'cross-file'
      ? theme.position === 'bottom-right' && game.visible('menu', false) && game.visible('ended', false) && !game.visible('playing', false) && !game.visible('menu', true)
      : theme.accent === 'blue' && theme.link === 'https://lovbase.dev/' && theme.position === 'bottom-right')
    const inputTokens = requests.reduce((n, usage) => n + (usage?.inTokens ?? 0), 0)
    results.push({ scenario: scenario.name, mode, model: LLM_MODEL, passed, requests: requests.length, unmeasuredRequests: requests.filter(usage => !usage).length,
      inputTokens, outputTokens: requests.reduce((n, usage) => n + (usage?.outTokens ?? 0), 0), cachedTokens: requests.reduce((n, usage) => n + (usage?.cachedTokens ?? 0), 0),
      calculatedCredits: rate ? requests.reduce((n, usage) => n + (usage ? creditsForTokens(usage, rate, { margin }) : 0), 0) : null,
    })
  } catch (error) { results.push({ scenario: scenario.name, mode, error: error instanceof Error ? error.message : String(error), passed: false }) }
  finally { await rm(root, { recursive: true, force: true }) }
  console.log(JSON.stringify(results.at(-1)))
}
const outputPath = process.argv[2]
if (outputPath) await writeFile(outputPath, JSON.stringify({ note: 'Provider-measured tokens; calculated credits only when a verified EVAL_MODEL_RATE was supplied. No wallet debits. Small synthetic fixtures, not production savings.', results }, null, 2))
if (results.some(result => !result.passed)) process.exitCode = 1
