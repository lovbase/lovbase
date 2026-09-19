import { useMemo } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getSharedState, insertSharedRow, listSharedRows } from '../functions'
import { Logo } from '../components/Logo'
import { PreviewTab, type RowApi } from '../components/PreviewTab'
import { ThemeToggle } from '../components/ThemeToggle'

export const Route = createFileRoute('/share/$token')({
  loader: ({ params }) => getSharedState({ data: { token: params.token } }),
  component: SharedApp,
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name || '应用'} · Lovbase` }] }),
  errorComponent: ({ error }) => (
    <div className="min-h-screen bg-ink text-fg flex items-center justify-center font-mono text-sm text-fg-dim">
      {error instanceof Error ? error.message : '分享链接不存在或已关闭'}
    </div>
  ),
})

function SharedApp() {
  const { token } = Route.useParams()
  const { name, ir } = Route.useLoaderData()
  const list = useServerFn(listSharedRows)
  const insert = useServerFn(insertSharedRow)
  const api = useMemo<RowApi>(() => ({
    list: (entityId) => list({ data: { token, entityId } }),
    insert: (entityId, values) => insert({ data: { token, entityId, values } }),
  }), [token, list, insert])

  return (
    <div className="h-screen flex flex-col bg-ink text-fg antialiased">
      <header className="flex items-center px-4 h-header border-b border-edge shrink-0 gap-4 bg-panel/40">
        <span className="text-[15px] font-medium tracking-tight">{name}</span>
        <div className="ml-auto flex items-center gap-4">
          <ThemeToggle />
          <Link to="/" className="flex items-center gap-1.5 text-fg-dim hover:text-fg-mid transition-colors">
            <Logo />
            <span className="font-mono text-[11px]">built with lovbase</span>
          </Link>
        </div>
      </header>
      <main className="flex-1 min-h-0">
        <PreviewTab ir={ir} api={api} />
      </main>
    </div>
  )
}
