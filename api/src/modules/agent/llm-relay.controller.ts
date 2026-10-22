import { All, Controller, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { rawBody, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { LlmService } from '../llm/llm.service'
import { GenerationService } from './generation.service'
import { usageObserver } from './model-usage'

/** Only a server-issued active run can use the coding-model relay. */
@Public()
@Controller('api/llm')
export class LlmRelayController {
  constructor(private readonly generation:GenerationService,private readonly llm:LlmService) {}
  @All('v1/*tail')
  @All('v1')
  async relay(@Req() req:Request,@Res() res:Response) {
    const token=req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const run=token ? await this.generation.authorize(token) : null
    if(!run)return void res.status(401).json({error:{message:'Active generation authorization required'}})
    const tail=req.path.replace(/^\/api\/llm\/v1\/?/,'')
    if(req.method!=='POST' || tail!=='chat/completions')return void res.status(404).end()
    const cfg=await this.llm.configFor(run.user_id,run.tier)
    if(!cfg || cfg.model!==run.model || (cfg.source==='user')!==run.byok)
      return void res.status(409).json({error:{message:'Model entitlement changed; start a new generation'}})
    let body:any
    try { body=JSON.parse((await rawBody(req)).toString('utf8')) }
    catch { return void res.status(400).json({error:{message:'Invalid JSON'}}) }
    body.model=run.model
    if(body.stream)body.stream_options={...body.stream_options,include_usage:true}
    const id=await this.generation.beginRequest(run)
    const abort=new AbortController()
    res.once('close',()=>{if(!res.writableEnded)abort.abort()})
    try {
      const upstream=await fetch(`${cfg.baseURL.replace(/\/+$/,'')}/chat/completions`,{
        method:'POST',headers:{authorization:`Bearer ${cfg.apiKey}`,'content-type':'application/json'},
        body:JSON.stringify(body),signal:abort.signal,
      })
      if(!upstream.ok || !upstream.body) {
        await this.generation.observe(id,run,null)
        return sendFetchResponse(res,upstream)
      }
      let measured=false
      const stream=upstream.body.pipeThrough(usageObserver(upstream.headers.get('content-type') ?? '',async usage=>{
        measured=true;await this.generation.observe(id,run,usage)
      }))
      const headers=new Headers(upstream.headers)
      headers.delete('content-length');headers.delete('content-encoding')
      res.once('close',()=>{if(!measured)void this.generation.observe(id,run,null)})
      sendFetchResponse(res,new globalThis.Response(stream,{status:upstream.status,headers}))
    } catch(e) {
      await this.generation.observe(id,run,null)
      if(!res.headersSent)res.status(502).json({error:{message:'Model request failed'}})
      else res.destroy(e instanceof Error ? e : undefined)
    }
  }
}
