import { ExpressAdapter } from '@nestjs/platform-express'

/**
 * Nest normally terminates every unmatched request with its own 404. That is right for a standalone
 * API, but wrong when it shares an Express app with the web server: `/`, `/login` and the static
 * assets all have to reach the middleware registered after it.
 *
 * Making the not-found handler a pass-through turns the backend into just another layer — it answers
 * the routes it declares and gets out of the way for everything else, so neither side has to keep a
 * list of the other's paths.
 */
export class EmbeddedExpressAdapter extends ExpressAdapter {
  setNotFoundHandler() {
    /* intentionally nothing: fall through to the next middleware */
  }
}
