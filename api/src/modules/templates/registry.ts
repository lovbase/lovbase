import { templateById, type TemplateId } from '@lovbase/core/templates'
import { NotFound } from '../../common/errors'
import { inventoryIR, installInventory, seedInventory } from './inventory-model'
import { product3dIR, installProduct3d, seedProduct3d } from './product-3d-model'
import inventoryFiles from './inventory-files.json'
import product3dFiles from './product-3d-files.json'
import inkwaveFiles from './inkwave-files.json'
import { installInkwave, inkwaveIR, seedInkwave } from './inkwave-model'
import ledgerFiles from './ledger-files.json'
import { installLedger, ledgerIR, seedLedger } from './ledger-model'
import crmFiles from './crm-files.json'
import { crmIR, installCrm, seedCrm } from './crm-model'
import { crmTables } from '@lovbase/core/crm'
import projectsFiles from './projects-files.json'
import { installProjects, projectsIR, seedProjects } from './projects-model'
import { projectsTables } from '@lovbase/core/projects'
import bookingFiles from './booking-files.json'
import { bookingIR, installBooking, seedBooking } from './booking-model'
import { bookingTables } from '@lovbase/core/booking'
import recruitingFiles from './recruiting-files.json'
import { installRecruiting, recruitingIR, seedRecruiting } from './recruiting-model'
import { recruitingTables } from '@lovbase/core/recruiting'
import helpdeskFiles from './helpdesk-files.json'
import { helpdeskIR, installHelpdesk, seedHelpdesk } from './helpdesk-model'
import type { AppFile } from '../apps/apps.service'
import type pg from 'pg'
import type { IR } from '@lovbase/core/ir'
import { helpdeskTables } from '@lovbase/core/helpdesk'

type Implementation = {
  demoId: string
  ir: IR
  install: (c: pg.PoolClient, schema: string) => Promise<void>
  seed: (c: pg.PoolClient, schema: string) => Promise<void>
  files: AppFile[]
  /** SQL-backed templates only: the tables the preview reads, in the app's own shape. */
  tables?: readonly string[]
}

const implementations: Record<TemplateId, Implementation> = {
  inkwave: {
    demoId: 'templateinkwavev1',
    ir: inkwaveIR,
    install: installInkwave,
    seed: seedInkwave,
    files: inkwaveFiles as AppFile[],
  },
  inventory: {
    demoId: 'templateinventoryv1',
    ir: inventoryIR,
    install: installInventory,
    seed: seedInventory,
    files: inventoryFiles,
  },
  'product-3d': {
    demoId: 'templateproduct3dv1',
    ir: product3dIR,
    install: installProduct3d,
    seed: seedProduct3d,
    files: product3dFiles,
  },
  ledger: {
    demoId: 'templateledgerv1',
    ir: ledgerIR,
    install: installLedger,
    seed: seedLedger,
    files: ledgerFiles,
  },
  crm: {
    demoId: 'templatecrmv1',
    ir: crmIR,
    install: installCrm,
    seed: seedCrm,
    files: crmFiles,
    tables: crmTables,
  },
  projects: {
    demoId: 'templateprojectsv1',
    ir: projectsIR,
    install: installProjects,
    seed: seedProjects,
    files: projectsFiles,
    tables: projectsTables,
  },
  booking: {
    demoId: 'templatebookingv1',
    ir: bookingIR,
    install: installBooking,
    seed: seedBooking,
    files: bookingFiles,
    tables: bookingTables,
  },
  recruiting: {
    demoId: 'templaterecruitingv1',
    ir: recruitingIR,
    install: installRecruiting,
    seed: seedRecruiting,
    files: recruitingFiles,
    tables: recruitingTables,
  },
  helpdesk: {
    demoId: 'templatehelpdeskv1',
    ir: helpdeskIR,
    install: installHelpdesk,
    seed: seedHelpdesk,
    files: helpdeskFiles,
    tables: helpdeskTables,
  },
}
export function templateDefinition(id: TemplateId, version = 1) {
  const metadata = templateById(id)
  if (!metadata || metadata.version !== version) throw new NotFound('Template version not found')
  return { ...metadata, ...implementations[id] }
}
