import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { sql, type Entity, type Field, type IR } from '@/lib/lovbase'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// Generic CRUD page for one entity: list + create dialog + delete. Every entity gets this for free.
export function TablePage({ entity, ir }: { entity: Entity; ir: IR }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    setRows(await sql(`select * from ${entity.dbName} order by created_at desc limit 200`))
    setLoading(false)
  }, [entity.dbName])
  useEffect(() => { load() }, [load])

  async function remove(id: string) {
    await sql(`delete from ${entity.dbName} where id = $1`, [id]); load()
  }

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{entity.name}</h1>
          <p className="text-sm text-muted-foreground">{rows.length} records</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="size-4" /> Refresh</Button>
          {!ir.readOnly && <CreateDialog entity={entity} ir={ir} onCreated={load} />}
        </div>
      </div>
      <Card>
        <CardHeader className="pb-0"><CardTitle className="text-base">All {entity.name}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                {entity.fields.map((f) => <TableHead key={f.id}>{f.name}</TableHead>)}
                {!ir.readOnly && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={String(r.id)}>
                  {entity.fields.map((f) => <TableCell key={f.id}><CellValue value={r[f.dbName]} field={f} /></TableCell>)}
                  {!ir.readOnly && (
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" onClick={() => remove(String(r.id))} aria-label="Delete"><Trash2 className="size-4" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={entity.fields.length + (ir.readOnly ? 0 : 1)} className="text-center text-muted-foreground py-10">No data yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function CellValue({ value, field }: { value: unknown; field: Field }) {
  if (value == null || value === '') return <span className="text-muted-foreground">—</span>
  if (field.type === 'boolean') return <Badge variant={value ? 'default' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
  if (field.type === 'select') return <Badge variant="outline">{String(value)}</Badge>
  if (field.type === 'date') return <span className="tabular-nums">{new Date(String(value)).toLocaleDateString()}</span>
  if (field.type === 'link') return <span className="font-mono text-xs text-muted-foreground">{String(value).slice(0, 8)}</span>
  return <span>{String(value)}</span>
}

function CreateDialog({ entity, ir, onCreated }: { entity: Entity; ir: IR; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  async function submit() {
    const fields = entity.fields.filter((f) => draft[f.id] != null && draft[f.id] !== '')
    if (!fields.length) return
    setBusy(true)
    const cols = fields.map((f) => f.dbName).join(', ')
    const params = fields.map((f) => f.type === 'number' ? Number(draft[f.id]) : f.type === 'boolean' ? draft[f.id] === 'true' : draft[f.id])
    await sql(`insert into ${entity.dbName} (${cols}) values (${fields.map((_, i) => `$${i + 1}`).join(', ')})`, params)
    setBusy(false); setOpen(false); setDraft({}); onCreated()
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}><Plus className="size-4" /> New</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New {entity.name}</DialogTitle></DialogHeader>
        <div className="grid gap-4 py-2">
          {entity.fields.map((f) => (
            <div key={f.id} className="grid gap-1.5">
              <Label htmlFor={f.id}>{f.name}{f.required && <span className="text-destructive"> *</span>}</Label>
              <FieldInput id={f.id} field={f} ir={ir} value={draft[f.id] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldInput({ id, field, ir, value, onChange }: { id: string; field: Field; ir: IR; value: string; onChange: (v: string) => void }) {
  if (field.type === 'select' || field.type === 'boolean') {
    const opts = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : (field.options ?? []).map((o) => [o, o])
    return (
      <Select value={value || null} onValueChange={(v) => onChange(String(v ?? ''))}>
        <SelectTrigger id={id}><SelectValue placeholder="Select…" /></SelectTrigger>
        <SelectContent>{opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    )
  }
  if (field.type === 'link') return <LinkSelect id={id} field={field} ir={ir} value={value} onChange={onChange} />
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'datetime-local' : 'text'
  return <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
}

function LinkSelect({ id, field, ir, value, onChange }: { id: string; field: Field; ir: IR; value: string; onChange: (v: string) => void }) {
  const target = ir.entities.find((e) => e.id === field.linkTo)
  const [opts, setOpts] = useState<Record<string, unknown>[]>([])
  useEffect(() => { if (target) sql(`select * from ${target.dbName} order by created_at desc limit 200`).then(setOpts) }, [target?.dbName])
  const label = target?.fields[0]?.dbName
  return (
    <Select value={value || null} onValueChange={(v) => onChange(String(v ?? ''))}>
      <SelectTrigger id={id}><SelectValue placeholder={`Select ${target?.name ?? ''}`} /></SelectTrigger>
      <SelectContent>{opts.map((o) => <SelectItem key={String(o.id)} value={String(o.id)}>{label ? String(o[label]) : String(o.id)}</SelectItem>)}</SelectContent>
    </Select>
  )
}
