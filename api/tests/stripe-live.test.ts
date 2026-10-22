import { test, expect } from 'bun:test'
import { ConfigService } from '../src/config/config.service'
import { replayTestWallet } from '../scripts/lib/test-wallet'
import { stripePreflight } from '../scripts/lib/stripe-preflight'
import { STRIPE_API_VERSION, STRIPE_EVENTS, stripeCatalog } from '../src/modules/billing/stripe-contract'

const env = {
  NODE_ENV:'production',STRIPE_MODE:'live',STRIPE_ACCOUNT_ID:'acct_example',STRIPE_SECRET_KEY:'sk_live_fixture',
  STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_PORTAL_CONFIGURATION:'bpc_example',BETTER_AUTH_URL:'https://lovbase.dev',
  BETTER_AUTH_SECRET:'real-secret',SQL_ROLE_PASSWORD:'real-password',SANDBOX_INTERNAL_TOKEN:'real-token',
  ...Object.fromEntries(stripeCatalog.map(p=>[p.env,'price_'+p.key])),
}
test('production requires an explicit mode, disabled needs no payment secrets',()=>{
  expect(()=>ConfigService.of({...env,STRIPE_MODE:undefined})).toThrow('explicit STRIPE_MODE')
  expect(ConfigService.of({...env,STRIPE_MODE:'disabled',STRIPE_SECRET_KEY:undefined}).billingEnabled).toBe(false)
})
test('enabled billing requires every value and rejects mixed keys and insecure origins without leaking secrets',()=>{
  for(const key of ['STRIPE_ACCOUNT_ID','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET',...stripeCatalog.map(p=>p.env),'STRIPE_PORTAL_CONFIGURATION'])
    expect(()=>ConfigService.of({...env,[key]:undefined})).toThrow(key)
  expect(()=>ConfigService.of({...env,STRIPE_SECRET_KEY:'sk_test_private'})).toThrow('does not match')
  for(const origin of ['http://lovbase.dev','https://localhost','https://127.0.0.1'])
    expect(()=>ConfigService.of({...env,BETTER_AUTH_URL:origin})).toThrow('HTTPS')
  expect(ConfigService.of(env).billingEnabled).toBe(true)
})
function fixture() {
  const prices=Object.fromEntries(stripeCatalog.map(p=>['price_'+p.key,{active:true,livemode:true,currency:'usd',unit_amount:p.amount,tax_behavior:'exclusive',recurring:p.interval?{interval:p.interval,interval_count:1}:null,product:{active:true,livemode:true}}]))
  const portal={active:true,livemode:true,features:{subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:false}}}
  const endpoint={id:'we_example',url:'https://lovbase.dev/api/billing/webhook',status:'enabled',livemode:true,api_version:STRIPE_API_VERSION,enabled_events:[...STRIPE_EVENTS]}
  const account={id:'acct_example',charges_enabled:true,details_submitted:true}
  const stripe={accounts:{retrieve:async()=>account},prices:{retrieve:async(id:string)=>prices[id]},billingPortal:{configurations:{retrieve:async()=>portal}},webhookEndpoints:{list:async()=>({has_more:false,data:[endpoint]})}}
  return {stripe,prices,portal,endpoint,account}
}
test('read-only preflight verifies the entire live catalog and webhook contract',async()=>{
  const f=fixture()
  expect((await stripePreflight(f.stripe as any,env)).prices).toBe(5)
  f.prices.price_pro_monthly.unit_amount=2400
  await expect(stripePreflight(f.stripe as any,env)).rejects.toThrow('Incorrect')
})
test('preflight blocks inactive accounts, wrong-mode products, unsafe portal and stale webhook snapshots',async()=>{
  let f=fixture();f.account.charges_enabled=false
  await expect(stripePreflight(f.stripe as any,env)).rejects.toThrow('cannot accept')
  f=fixture();f.prices.price_credits_small.product.livemode=false
  await expect(stripePreflight(f.stripe as any,env)).rejects.toThrow('wrong-mode')
  f=fixture();f.portal.features.subscription_update.enabled=true
  await expect(stripePreflight(f.stripe as any,env)).rejects.toThrow('Portal')
  f=fixture();f.endpoint.enabled_events.pop()
  await expect(stripePreflight(f.stripe as any,env)).rejects.toThrow('event list')
})
test('mixed wallets consume test purchases first and preserve remaining manual grants',()=>{
  const e=[{id:'1',at:'2026-01-01',kind:'admin' as const,credits:100},{id:'2',at:'2026-01-02',kind:'test' as const,credits:200},{id:'3',at:'2026-01-03',kind:'debit' as const,credits:250}]
  expect(replayTestWallet(e,50)).toEqual({remove:0,preserve:50})
  e[2].credits=50
  expect(replayTestWallet(e,250)).toEqual({remove:150,preserve:100})
})
test('migration stops for missing debit history, mismatched balances and ambiguous order',()=>{
  expect(()=>replayTestWallet([{id:'1',at:'a',kind:'debit',credits:null}],0)).toThrow('missing')
  expect(()=>replayTestWallet([{id:'1',at:'a',kind:'test',credits:200}],100)).toThrow('reconciliation')
  expect(()=>replayTestWallet([{id:'1',at:'a',kind:'admin',credits:100},{id:'2',at:'a',kind:'test',credits:200}],300)).toThrow('Ambiguous')
})
