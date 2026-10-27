import 'reflect-metadata'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { SchemaService } from '../src/database/schema.service'
import { FeedbackService, feedbackImage } from '../src/modules/feedback/feedback.service'
import { JobRepository } from '../src/modules/jobs/job.repository'
import type { UserCtx } from '../src/modules/auth/access.service'
import { feedbackInput, FEEDBACK_IMAGE_BYTES } from '@lovbase/core/feedback'

const db = new PGlite()
const query = async (sql: string, params?: unknown[]) => {
  const result = await db.query(sql, params)
  return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
}
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
const schema = new SchemaService(pool), feedback = new FeedbackService(pool, schema)
const jobs = new JobRepository(pool, schema, {} as any)
const user = (id: string, isAdmin = false) => ({ user: { id, isAdmin } }) as UserCtx
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const input = () => feedbackInput.parse({ id: crypto.randomUUID(), kind: 'suggestion', message: '  请增加导出功能  ', page: '/home', screenshots: [{ name: '截图.png', dataUrl: png }] })

beforeAll(async () => {
  await schema.ready()
  for (const id of ['owner','other','admin','rate']) await query('INSERT INTO public."user"(id,name,email) VALUES($1,$1,$2)', [id, `${id}@test.invalid`])
  await query(`INSERT INTO public.lb_projects(id,owner_id,name,ir) VALUES('project','owner','Demo','{"entities":[]}')`)
  await query(`INSERT INTO public.lb_apps(id,project_id,name) VALUES('app','project','App')`)
}, 30000)
afterAll(() => db.close())

test('feedback persists across instances, keeps screenshots private and supports admin status filtering', async () => {
  const report = input()
  await feedback.submit(user('owner'), { ...report, projectId: 'project' })
  const fresh = new FeedbackService(pool, schema)
  const listed = await fresh.list(user('admin',true), 'new')
  const saved = listed.rows.find(row => row.id === report.id)!
  expect(saved.message).toBe('请增加导出功能')
  expect(saved.email).toBe('owner@test.invalid')
  expect(saved.project_name).toBe('Demo')
  expect(saved.screenshots).toEqual([{ position: 0, name: '截图.png' }])
  expect('bytes' in saved).toBe(false)
  const image = await fresh.image(user('owner'),report.id,0)
  expect(Buffer.from(image.bytes).toString('base64')).toBe(png.split(',')[1])
  expect((await fresh.image(user('admin',true), report.id,0)).content_type).toBe('image/png')
  await expect(fresh.image(user('other'),report.id,0)).rejects.toThrow('not found')
  await expect(fresh.list(user('owner'))).rejects.toThrow('Admin access')
  await expect(fresh.setStatus(user('owner'),report.id,'resolved')).rejects.toThrow('Admin access')
  await fresh.setStatus(user('admin',true),report.id,'resolved')
  expect((await fresh.list(user('admin',true),'new')).rows.some(row => row.id === report.id)).toBe(false)
  expect((await fresh.list(user('admin',true),'resolved')).rows.find(row => row.id === report.id)?.status).toBe('resolved')
})

test('feedback retries are idempotent; foreign projects, image types, oversized files and blank reports are rejected', async () => {
  const report = input()
  await feedback.submit(user('owner'), report)
  await feedback.submit(user('owner'), report)
  expect((await query('SELECT count(*)::int AS n FROM public.lb_feedback WHERE id=$1',[report.id])).rows[0].n).toBe(1)
  await expect(feedback.submit(user('other'),report)).rejects.toThrow('not found')
  await expect(feedback.submit(user('other'),{...input(),projectId:'project'})).rejects.toThrow('Project not found')
  expect(() => feedbackInput.parse({...input(),message:'   '})).toThrow()
  expect(() => feedbackInput.parse({...input(),screenshots:Array(4).fill(input().screenshots[0])})).toThrow()
  expect(() => feedbackImage('data:image/svg+xml;base64,PHN2Zz4=')).toThrow()
  expect(() => feedbackImage('data:image/png;base64,PGh0bWw+')).toThrow()
  expect(() => feedbackImage(`data:image/png;base64,${Buffer.alloc(FEEDBACK_IMAGE_BYTES+1).toString('base64')}`)).toThrow()
  expect((await query('SELECT count(*)::int AS n FROM public.lb_feedback WHERE user_id=$1',['other'])).rows[0].n).toBe(0)
})

test('feedback rate limits and pagination bound stored uploads and admin responses', async () => {
  for (let i=0;i<10;i++) await feedback.submit(user('rate'),{...input(),screenshots:[]})
  await expect(feedback.submit(user('rate'),input())).rejects.toThrow('10 reports')
  for (let i=0;i<12;i++) await query('INSERT INTO public.lb_feedback(id,user_id,kind,message,page) VALUES($1,$2,$3,$4,$5)',[crypto.randomUUID(),'owner','bug',`Issue ${i}`,'/home'])
  const first = await feedback.list(user('admin',true))
  const second = await feedback.list(user('admin',true),undefined,20)
  expect(first.rows.length).toBe(20)
  expect(first.hasMore).toBe(true)
  expect(second.rows.length).toBeGreaterThan(0)
  expect(second.hasMore).toBe(false)
  expect(second.rows.some(row => first.rows.some(other => other.id===row.id))).toBe(false)
})

async function job(input: Record<string,unknown> = {}) {
  const id = crypto.randomUUID()
  await query(`INSERT INTO public.lb_jobs(id,request_id,run_id,project_id,app_id,user_id,status,input)
    VALUES($1,$1,$1,'project','app','owner','cancelling',$2)`,[id,JSON.stringify(input)])
  return id
}

test('completion notifications are durable, scoped to the owner, acknowledgeable and emitted once', async () => {
  const id = await job()
  await jobs.finish(id,'succeeded',undefined,{appGenerated:true})
  const fresh = new JobRepository(pool,schema,{} as any)
  const notice = (await fresh.notifications('owner')).find(row => row.id===id)!
  expect(notice.kind).toBe('completed')
  expect(notice.appId).toBe('app')
  expect(notice.projectName).toBe('Demo')
  expect((await fresh.notifications('other')).length).toBe(0)
  await fresh.readNotifications('other',[id])
  expect((await fresh.notifications('owner')).some(row=>row.id===id)).toBe(true)
  await fresh.readNotifications('owner',[id])
  await fresh.finish(id,'failed','redelivered worker')
  expect((await fresh.notifications('owner')).some(row=>row.id===id)).toBe(false)
  expect((await query('SELECT status FROM public.lb_jobs WHERE id=$1',[id])).rows[0].status).toBe('succeeded')
})

test('ordinary chat and cancellation stay quiet; build and failure outcomes produce accurate reminders', async () => {
  const chat = await job(), cancelled = await job(), failed = await job(), build = await job({operation:'build'}), preview = await job({operation:'preview'})
  await jobs.finish(chat,'succeeded',undefined,{appGenerated:false})
  await jobs.finish(cancelled,'cancelled')
  await jobs.finish(failed,'failed','Worker unavailable')
  await jobs.finish(build,'succeeded',undefined,{previewUrl:'https://preview.invalid'})
  await jobs.finish(preview,'succeeded')
  const notices = await jobs.notifications('owner')
  expect(notices.some(row=>[chat,cancelled,preview].includes(row.id))).toBe(false)
  expect(notices.find(row=>row.id===failed)?.kind).toBe('failed')
  expect(notices.find(row=>row.id===build)?.kind).toBe('completed')
})
