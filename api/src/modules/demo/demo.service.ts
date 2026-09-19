import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { assignIds, emptyIR, type IR } from '@lovbase/core/ir'
import { diffIR } from '@lovbase/core/diff'
import { qi } from '@lovbase/core/ddl'
import { TEMPLATES, type Template } from '@lovbase/core/templates'
import { InjectPool } from '../../database/pool.provider'
import { NotFound } from '../../common/errors'
import { ApplyService } from '../modeling/apply.service'
import { ProjectsService, schemaFor } from '../projects/projects.service'
import { RolesService } from '../roles/roles.service'
import { SandboxService } from '../sandbox/sandbox.service'

// ── Template demos: one system-owned project per template, built from the template's IR and seed rows. ──
// The first open creates schema + data + boots the sandbox preview; later opens just return the URL.

export const DEMO_OWNER = 'system'
const demoId = (t: Template) => `tpl${t.id.replace(/[^a-z0-9]/g, '')}`

function templateIR(t: Template): IR {
  const ir = assignIds({
    version: 1,
    appName: t.name,
    entities: t.ir.map((e) => ({
      id: '', name: e.name, dbName: e.dbName,
      fields: e.fields.map((f) => ({ id: '', name: f.name, dbName: f.dbName, type: f.type, required: false, options: f.options, linkTo: f.linkTo })),
    })),
  })
  // linkTo in the template refers to dbName; the IR wants entity ids.
  const byDb = new Map(ir.entities.map((e) => [e.dbName, e.id]))
  for (const e of ir.entities) for (const f of e.fields) if (f.type === 'link' && f.linkTo) f.linkTo = byDb.get(f.linkTo)
  return ir
}

@Injectable()
export class DemoService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly projects: ProjectsService,
    private readonly applier: ApplyService,
    private readonly roles: RolesService,
    private readonly sandbox: SandboxService,
  ) {}

  private async seed(projectId: string, ir: IR, t: Template) {
    const schema = schemaFor(projectId)
    const idsByName = new Map<string, Map<string, string>>() // entity dbName → (label → row id)
    for (const e of ir.entities) {                            // template order respects link dependencies
      const rows = t.seed[e.dbName] ?? []
      const labels = new Map<string, string>()
      for (const row of rows) {
        const cols: string[] = [], vals: unknown[] = []
        for (const f of e.fields) {
          let v = row[f.dbName]
          if (v == null) continue
          if (f.type === 'link') {
            const target = ir.entities.find((x) => x.id === f.linkTo)!
            v = idsByName.get(target.dbName)?.get(String(v)) ?? null
            if (!v) continue
          }
          cols.push(qi(f.dbName)); vals.push(v)
        }
        const r = await this.pool.query(
          `INSERT INTO ${qi(schema)}.${qi(e.dbName)} (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals)
        labels.set(String(row[e.fields[0].dbName]), r.rows[0].id)
      }
      idsByName.set(e.dbName, labels)
    }
  }

  /** Ensure the demo project exists with schema + data; returns the project. */
  async ensure(t: Template) {
    const id = demoId(t)
    let p = await this.projects.find(id)
    if (!p) {
      p = await this.projects.create(DEMO_OWNER, id)
      const ir = templateIR(t)
      await this.applier.apply(id, ir, diffIR(emptyIR(), ir))
      await this.roles.ensureWorkspaceRole(id)
      await this.seed(id, ir, t)
      await this.roles.setSchemaReadOnly(id)          // demos are look-but-don't-touch, enforced by Postgres
      await this.projects.setReadOnly(id, true)
      p = await this.projects.get(id)
    }
    return this.projects.ensureApiToken(p)
  }

  async preview(templateId: string) {
    const t = TEMPLATES.find((x) => x.id === templateId)
    if (!t) throw new NotFound('unknown template')
    const p = await this.ensure(t)
    const { previewUrl } = await this.sandbox.preview(p.id, { workspaceId: p.id, apiToken: p.api_token })
    return { previewUrl, projectId: p.id }
  }
}
