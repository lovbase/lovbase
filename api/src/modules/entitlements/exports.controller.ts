import { Controller, Get, Param, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { pipeline } from 'node:stream/promises'
import { AccessService } from '../auth/access.service'
import { requestHeaders } from '../../common/http'
import { ExportsService } from './exports.service'

@Controller('api/projects/:projectId/export')
export class ExportsController {
  constructor(
    private readonly access: AccessService,
    private readonly exports: ExportsService,
  ) {}
  @Get(':format')
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param('projectId') id: string,
    @Param('format') format: string,
  ) {
    const ctx = await this.access.requireProject(requestHeaders(req), id)
    if (format !== 'sql' && format !== 'source') return void res.status(404).end()
    const stream = format === 'sql' ? await this.exports.sql(ctx) : await this.exports.source(ctx)
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': format === 'sql' ? 'application/sql; charset=utf-8' : 'application/zip',
      'Content-Disposition': `attachment; filename="${id}.${format === 'sql' ? 'sql' : 'zip'}"`,
    })
    await pipeline(stream, res).catch(() => {
      res.destroy()
    })
  }
}
