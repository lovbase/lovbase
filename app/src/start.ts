import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

/**
 * Server functions are same-origin RPC endpoints: any page on the internet can POST to one, and
 * the browser will attach the session cookie. Without this check a hostile page could create
 * projects, run SQL through the workspace role, or spend credits as whoever is logged in.
 *
 * Scoped to `serverFn` because the data API and the Stripe webhook authenticate with tokens and
 * signatures rather than cookies, so a cross-site restriction there would only break them.
 *
 * Leaving it out also cost the dev server: the missing-middleware warning fires per module
 * instance, Vite echoes each `console.warn` back with its own prefix, and the two compound into
 * a log that ate 18 million lines and the heap with it in about two minutes.
 */
const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
}))
