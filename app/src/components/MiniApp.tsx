/** A CSS-drawn miniature of a generated app: sidebar with the tables, a page with a header and rows. */
export function MiniApp({ name, tables, className = 'h-32' }: { name: string; tables: string[]; className?: string }) {
  const rows = [78, 62, 70, 55]
  return (
    // One box, not two: the miniature is the thumbnail, so it reaches the tile's own edges rather
    // than floating on a mat inside it.
    <div className={`${className} flex overflow-hidden rounded-xl border border-edge bg-panel text-[8px] leading-none`}>
      <div className="w-[34%] border-r border-edge p-2 space-y-[3px] bg-ink/60">
        <div className="flex items-center gap-1 mb-1.5"><span className="size-2.5 rounded-sm bg-fg" /><span className="font-medium text-fg truncate">{name}</span></div>
        {(tables.length ? tables : ['还没有表']).slice(0, 5).map((t, i) => (
          <div key={t} className={`px-1.5 py-[3px] rounded-[3px] truncate ${i === 0 ? 'bg-panel-2 text-fg' : 'text-fg-dim'}`}>{t}</div>
        ))}
      </div>
      <div className="flex-1 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between"><span className="h-[7px] w-10 rounded-sm bg-fg/80" /><span className="h-[7px] w-7 rounded-sm bg-fg" /></div>
        <div className="h-[5px] w-16 rounded-sm bg-edge-strong/70" />
        <div className="mt-1.5 space-y-[3px]">
          {rows.map((w, i) => <div key={i} className="h-[6px] rounded-sm bg-edge" style={{ width: `${w}%` }} />)}
        </div>
      </div>
    </div>
  )
}
