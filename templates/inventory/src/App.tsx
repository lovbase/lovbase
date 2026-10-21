import { InventoryApp } from './InventoryApp'
import { inventoryClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="inventory-viewport">
      <InventoryApp client={inventoryClient} initialLocale={defaultLocale} />
    </div>
  )
}
