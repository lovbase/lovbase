import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router'
import { Database, Table2 } from 'lucide-react'
import { schema, type IR } from '@/lib/lovbase'
import { Skeleton } from '@/components/ui/skeleton'
import { TablePage } from '@/pages/TablePage'

// Starter shell: a sidebar with one route per entity and a generic table page.
// pi replaces/extends this with the real app. Keep data access in @/lib/lovbase.
export function App() {
  const [ir, setIr] = useState<IR | null>(null)
  useEffect(() => { schema().then(setIr) }, [])
  if (!ir) return <div className="p-8 space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-72" /></div>

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b font-semibold">
          <span className="size-7 rounded-md bg-primary text-primary-foreground grid place-items-center"><Database className="size-4" /></span>
          <span className="truncate">{ir.appName}</span>
        </div>
        <nav className="p-2 space-y-0.5">
          {ir.entities.map((e) => (
            <NavLink key={e.id} to={`/t/${e.dbName}`}
              className={({ isActive }) => `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'}`}>
              <Table2 className="size-4" /> {e.name}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 min-w-0">
        <Routes>
          <Route path="/" element={ir.entities[0] ? <Navigate to={`/t/${ir.entities[0].dbName}`} replace /> : <p className="p-8 text-muted-foreground">还没有表</p>} />
          <Route path="/t/:table" element={<TableRoute ir={ir} />} />
        </Routes>
      </main>
    </div>
  )
}

function TableRoute({ ir }: { ir: IR }) {
  const { table } = useParams()
  const entity = ir.entities.find((e) => e.dbName === table)
  if (!entity) return <p className="p-8 text-muted-foreground">表不存在</p>
  return <TablePage key={entity.id} entity={entity} ir={ir} />
}
