import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { createApi } from './bootstrap'
import { ConfigService } from './config/config.service'

// Standalone mode: the API as its own service, with no web app in front of it. The single-process
// deployment (app/server.mjs) calls createApi() instead — same modules, same routes, one port.
const app = await createApi()
const port = app.get(ConfigService).env.PORT
await app.listen(port, '0.0.0.0')
new Logger('api').log(`listening on :${port}`)
