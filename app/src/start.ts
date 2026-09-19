import { createStart } from '@tanstack/react-start'

// Nothing to run around requests: everything server-side lives in the Nest container, which the
// server functions reach through app/src/functions/_ctx.ts.
export const startInstance = createStart(() => ({}))
