import 'reflect-metadata'
import { expect, test } from 'bun:test'
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { SessionGuard } from '../src/common/session.guard'
import { Unauthorized } from '../src/common/errors'
import type { AccessService } from '../src/modules/auth/access.service'

// Match the backend's legacy Nest decorator transform when tests run from the workspace root.
const transpiler = new Bun.Transpiler({ loader: 'ts', tsconfig: { compilerOptions: { experimentalDecorators: true } } })
plugin({ name: 'mcp-controller-decorators', setup(build) {
  build.onLoad({ filter: /\/mcp\.controller\.ts$/ }, args => ({ contents: transpiler.transformSync(readFileSync(args.path, 'utf8')), loader: 'js' }))
} })
const { McpController } = await import('../src/modules/integrations/mcp.controller')

test('OAuth metadata is public but the callback still requires a signed-in user', async () => {
  let authChecks = 0
  const access = { requireUser: async () => { authChecks++; throw new Unauthorized() } } as unknown as AccessService
  const guard = new SessionGuard(new Reflector(), access)
  const context = (handler: Function) => ({
    getHandler: () => handler,
    getClass: () => McpController,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  }) as unknown as ExecutionContext
  expect(await guard.canActivate(context(McpController.prototype.metadata))).toBe(true)
  expect(authChecks).toBe(0)
  await expect(guard.canActivate(context(McpController.prototype.callback))).rejects.toThrow('Please sign in first')
  expect(authChecks).toBe(1)
})
