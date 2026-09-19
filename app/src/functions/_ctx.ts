import { redirect } from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { AccessService, Unauthorized, svc, type AppCtx, type ProjectCtx, type UserCtx } from '@lovbase/api'

// ── The seam between TanStack's server functions and the Nest backend ──
// Everything a server function is allowed to touch comes from a context produced here, and the
// only way to get one is to pass the real request headers through AccessService. A handler that
// forgets to authorize cannot reach a project: it has nothing to pass on.
//
// This file is also the only place in the app that knows about TanStack's request plumbing, which
// is what keeps `api/` free of any web-framework import.

const headers = () => getRequest().headers

/** An unauthenticated call is a login redirect to the router, not a 401 to the UI. */
async function toLogin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Unauthorized) throw redirect({ to: '/login' })
    throw err
  }
}

const access = () => svc(AccessService)

export const currentUser = async () => (await access()).currentUser(headers())
export const requireUser = (): Promise<UserCtx> => toLogin(async () => (await access()).requireUser(headers()))
export const requireAdmin = (): Promise<UserCtx> => toLogin(async () => (await access()).requireAdmin(headers()))
export const requireProject = (projectId: string): Promise<ProjectCtx> =>
  toLogin(async () => (await access()).requireProject(headers(), projectId))
export const requireApp = (projectId: string, appId: string): Promise<AppCtx> =>
  toLogin(async () => (await access()).requireApp(headers(), projectId, appId))
/** A share link is its own capability: read and add rows, never change structure. */
export const sharedProject = async (token: string) => (await access()).requireShared(token)
