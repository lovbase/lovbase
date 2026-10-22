import { templateById, type TemplateId } from '@lovbase/core/templates'
import { NotFound } from '../../common/errors'
import { inventoryIR, installInventory, seedInventory } from './inventory-model'
import { product3dIR, installProduct3d, seedProduct3d } from './product-3d-model'
import inventoryFiles from './inventory-files.json'
import product3dFiles from './product-3d-files.json'

const implementations = {
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
}
export function templateDefinition(id: TemplateId, version = 1) {
  const metadata = templateById(id)
  if (!metadata || metadata.version !== version) throw new NotFound('Template version not found')
  return { ...metadata, ...implementations[id] }
}
