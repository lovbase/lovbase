import 'reflect-metadata'
import { expect, test } from 'bun:test'
import { AppOperationsService } from '../src/modules/development/app-operations.service'
import { ConfigService } from '../src/config/config.service'
import type { AppCtx } from '../src/modules/auth/access.service'

function fixture() {
  const ctx = { user:{id:'u',plan:'free'},project:{id:'p',owner_id:'u',api_token:'internal'},app:{id:'a',project_id:'p'} } as AppCtx
  let version = 1, held = false, active = false
  let files = [{path:'src/App.tsx',content:'original'}]
  const calls: string[] = []
  const apps = {
    findById: async () => ctx.app, versions: async () => ({sourceVersion:version}),
    versionedSnapshot: async () => ({ files: structuredClone(files),version }),loadSnapshot:async () => files,
    saveSnapshot:async (_id:string,next:typeof files) => { files=next; version++ },
    markRuntime:async () => {},claimSlug:async () => 'a',markPublished:async () => {calls.push('published')},
  }
  const sandbox = {
    claimLease:async () => {},restoreIfFresh:async () => {},
    writeFile:async (_id:string,path:string,content:string) => {files=[{path,content}];return {ok:true,path}},
    exportFiles:async () => ({files:structuredClone(files)}),resetSource:async () => {calls.push('destroyed')},
    preview:async () => ({previewUrl:'https://preview.test'}),build:async () => ({ok:true,files:['index.html']}),
    publish:async () => ({ok:true,files:1}),
  }
  const leases = {
    acquire:async (_id:string,owner:string) => {if(held)return null;held=true;calls.push(owner);return {generation:1}},
    renew:async () => true,markWarm:async () => {held=false;return true},
  }
  const jobs = {
    activeForProject:async()=>active?{id:'running'}:null,
    byRequest:async (_id: string): Promise<any> => null,
    createTurn:async (input: any) => ({created:true, job:{id:'publish-job',created_at:new Date(1000),status:'queued',error:null,
      project_id:input.projectId,app_id:input.appId,user_id:input.userId,input:input.turn}}),
    latestPublish:async (_appId: string): Promise<any> => null,
    get:async (_id: string): Promise<any> => null,
  }
  const queues = {cancelRelease:async()=>{},scheduleRelease:async()=>{},enqueue:async(id:string)=>{calls.push(`enqueue:${id}`);return true}}
  const service = new AppOperationsService(ConfigService.of({}),apps as any,{ensureApiToken:async (p:unknown)=>p} as any,
    sandbox as any,leases as any,queues as any,
    jobs as any,{capture:async()=>{calls.push('cover')}} as any,
    {owner:async()=> 'user',plan:async()=>({priority:true}),reservePublish:async()=>{},releasePublish:async()=>{}} as any)
  return {ctx,service,calls,sandbox,apps,jobs,queues,setActive:(v:boolean)=>{active=v}}
}

test('web publishing persists and queues without waiting for sandbox compilation', async () => {
  const f = fixture()
  f.sandbox.publish = async () => { throw new Error('must run in worker') }
  expect(await f.service.submitPublish(f.ctx, 'request-123')).toMatchObject({id:'publish-job',createdAt:1000,status:'queued',error:null,files:0})
  expect(f.calls).toEqual(['enqueue:publish-job'])
  f.queues.enqueue = async () => false
  expect(await f.service.submitPublish(f.ctx, 'request-456')).toMatchObject({status:'queued'})
})

test('a repeated publish joins the active task while other active work blocks publication', async () => {
  const f = fixture()
  f.jobs.activeForProject = async () => ({id:'active-publish',created_at:new Date(1000),app_id:'a',input:{operation:'publish'},status:'running'} as any)
  expect(await f.service.submitPublish(f.ctx,'request-123')).toMatchObject({id:'active-publish',status:'running'})
  expect(f.calls).toEqual([])
  f.jobs.activeForProject = async () => ({id:'agent-task'} as any)
  await expect(f.service.submitPublish(f.ctx,'request-456')).rejects.toThrow('already queued or running')
})

test('source writes fail before mutation on export errors and discard uncommitted runtime changes',async () => {
  const f=fixture()
  f.sandbox.exportFiles=async()=>{throw new Error('export incomplete')}
  await expect(f.service.write(f.ctx,'src/App.tsx','lost',1)).rejects.toThrow('export incomplete')
  expect(await f.service.read(f.ctx,'src/App.tsx')).toMatchObject({content:'original',version:1})
  const g=fixture()
  g.apps.saveSnapshot=async()=>{throw new Error('storage unavailable')}
  await expect(g.service.write(g.ctx,'src/App.tsx','lost',1)).rejects.toThrow('storage unavailable')
  expect(g.calls).toContain('destroyed')
})

test('source edits use optimistic versions and exclusive leases shared with the web',async () => {
  const f = fixture()
  expect(await f.service.read(f.ctx,'src/App.tsx')).toMatchObject({content:'original',version:1})
  expect(await f.service.write(f.ctx,'src/App.tsx','changed',1)).toMatchObject({version:2})
  await expect(f.service.write(f.ctx,'src/App.tsx','stale',1)).rejects.toThrow('version conflict')
  expect((await f.service.read(f.ctx,'src/App.tsx')).content).toBe('changed')
  f.setActive(true)
  await expect(f.service.write(f.ctx,'src/App.tsx','racing',2)).rejects.toThrow('already queued or running')
  f.setActive(false)
  let finish!:()=>void
  const pending = f.service.withLease('a',()=>new Promise<void>(r=>{finish=r}))
  for (let i=0; i<10 && !finish; i++) await Promise.resolve()
  expect(finish).toBeDefined()
  await expect(f.service.write(f.ctx,'src/App.tsx','racing',2)).rejects.toThrow('busy')
  finish();await pending
  const owners=f.calls.filter(c=>c.startsWith('interactive-'))
  expect(new Set(owners).size).toBe(owners.length)
})

test('preview/build/publish share business behavior and failed publishes are not marked published',async () => {
  const f=fixture()
  expect(await f.service.perform(f.ctx,'preview')).toMatchObject({previewUrl:'https://preview.test'})
  expect(await f.service.perform(f.ctx,'build')).toMatchObject({ok:true})
  expect(await f.service.perform(f.ctx,'publish')).toMatchObject({ok:true,slug:'a',files:1})
  expect(f.calls).toContain('published');expect(f.calls).toContain('cover')
  f.calls.length=0
  f.sandbox.publish=async()=>({ok:false,error:'build failed'} as any)
  await expect(f.service.perform(f.ctx,'publish')).rejects.toThrow('build failed')
  expect(f.calls).not.toContain('published')
})
