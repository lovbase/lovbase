import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { diffIR, isDestructive, type Change } from '../shared/diff'
import { changeToSQL, irToDDL } from '../shared/ddl'
import { newId, type IR } from '../shared/ir'
import { getIR, getLog, initDb, log } from './db'
import { applyChanges } from './apply'
import { generateIR } from './generate'
import { llmConfigured, llmDescription } from './llm'
import { deleteRow, insertRow, listRows } from './data'

const app = new Hono()
const pending = new Map<string, { next: IR; changes: Change[] }>()

app.get('/api/state', async (c) => {
  const ir = await getIR()
  return c.json({ ir, ddl: irToDDL(ir), log: await getLog(), hasKey: llmConfigured(), model: llmDescription() })
})

app.post('/api/generate', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  if (!message?.trim()) return c.json({ error: 'empty message' }, 400)
  if (!llmConfigured())
    return c.json({ error: '未配置模型:.env 里设 LLM_BASE_URL + LLM_API_KEY + LLM_MODEL,或 ANTHROPIC_API_KEY' }, 400)

  await log('user', { message })
  const current = await getIR()
  let next: IR
  try {
    next = await generateIR(current, message)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await log('error', { message: msg })
    return c.json({ error: msg }, 500)
  }
  const changes = diffIR(current, next)
  if (changes.length === 0) {
    await log('agent', { note: '没有需要变更的内容', changes: [] })
    return c.json({ applied: true, changes: [] })
  }
  if (changes.some(isDestructive)) {
    const id = newId('p')
    pending.set(id, { next, changes })
    await log('agent', { note: '有破坏性变更,等待确认', changes, pendingId: id })
    return c.json({ applied: false, needsConfirmation: true, pendingId: id, changes })
  }
  await applyChanges(next, changes)
  return c.json({ applied: true, changes })
})

app.post('/api/confirm', async (c) => {
  const { pendingId } = await c.req.json<{ pendingId: string }>()
  const p = pending.get(pendingId)
  if (!p) return c.json({ error: 'pending change not found (server restarted?)' }, 404)
  pending.delete(pendingId)
  await applyChanges(p.next, p.changes)
  return c.json({ applied: true, changes: p.changes })
})

app.get('/api/data/:entityId', async (c) => c.json(await listRows(c.req.param('entityId'))))
app.post('/api/data/:entityId', async (c) =>
  c.json(await insertRow(c.req.param('entityId'), await c.req.json())))
app.delete('/api/data/:entityId/:rowId', async (c) => {
  await deleteRow(c.req.param('entityId'), c.req.param('rowId'))
  return c.json({ ok: true })
})

app.onError((err, c) => c.json({ error: err.message }, 500))

// production: serve the built SPA
app.use('*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

await initDb()
console.log('lovbase server on :3001')
export default { port: 3001, fetch: app.fetch }
