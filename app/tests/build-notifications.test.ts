import { afterEach, expect, test } from 'bun:test'
import { buildNotificationUrl, claimBuildNotification, desktopNotificationsEnabled, setDesktopNotificationsEnabled, showBuildNotification } from '../src/lib/build-notifications'

const originals = new Map(['localStorage','window','navigator','Notification'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]))
function global(key: string, value: unknown) { Object.defineProperty(globalThis,key,{value,configurable:true,writable:true}) }
afterEach(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key) } })
function storage() {
  const values = new Map<string,string>()
  global('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)})
  return values
}

test('notification preference requires opt-in; job claims persist and stay isolated per account', () => {
  const values = storage()
  expect(desktopNotificationsEnabled()).toBe(false)
  setDesktopNotificationsEnabled(true)
  expect(desktopNotificationsEnabled()).toBe(true)
  expect(claimBuildNotification('owner','job')).toBe(true)
  expect(claimBuildNotification('owner','job')).toBe(false)
  expect(claimBuildNotification('other','job')).toBe(true)
  values.set('lovbase-build-alerts:reloaded',JSON.stringify(['job']))
  expect(claimBuildNotification('reloaded','job')).toBe(false)
  setDesktopNotificationsEnabled(false)
  expect(desktopNotificationsEnabled()).toBe(false)
})

test('storage failures and malformed data cannot cause duplicate alerts or break reminders', () => {
  const values = storage()
  values.set('lovbase-build-alerts:malformed','{}')
  expect(claimBuildNotification('malformed','job')).toBe(true)
  global('localStorage',{getItem:()=>{throw Error('disabled')},setItem:()=>{throw Error('disabled')}})
  expect(claimBuildNotification('private-window','job')).toBe(true)
  expect(claimBuildNotification('private-window','job')).toBe(false)
  expect(desktopNotificationsEnabled()).toBe(false)
})

test('browser delivery respects opt-in and permission and includes the app destination', async () => {
  storage()
  const deliveries: unknown[] = []
  global('Notification',{permission:'granted'})
  global('window',{Notification:globalThis.Notification})
  global('navigator',{serviceWorker:{getRegistration:async()=>({active:true,showNotification:async(...args:unknown[])=>{deliveries.push(args)}})}})
  const url = buildNotificationUrl('project /','app?')
  expect(url).toBe('/projects/project%20%2F?app=app%3F')
  await showBuildNotification('Done','App','job',url)
  expect(deliveries).toHaveLength(0)
  setDesktopNotificationsEnabled(true)
  await showBuildNotification('Done','App','job',url)
  expect(deliveries).toEqual([['Done',{body:'App',tag:'lovbase-job',icon:'/icons/icon-192.png',data:{url}}]])
  global('Notification',{permission:'denied'})
  await showBuildNotification('Done','App','job2',url)
  expect(deliveries).toHaveLength(1)
})
