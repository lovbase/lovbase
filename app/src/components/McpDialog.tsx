import { McpConnections } from './McpIntegration'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { useT } from '../lib/i18n'

export function McpDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (open: boolean) => void; projectId?: string }) {
  const t = useT()
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] flex-col overflow-hidden bg-panel p-6 text-fg sm:max-w-[800px]">
      <DialogTitle className="text-xl font-semibold">{t('connections.customMcp', 'Custom MCP')}</DialogTitle>
      <DialogDescription className="text-sm text-fg-dim">{t('mcp.description', 'Connect remote MCP servers and let your Agent use their tools.')}</DialogDescription>
      <div className="min-h-0 overflow-y-auto">{open && <McpConnections projectId={projectId} returnTo={typeof window !== 'undefined' && new URLSearchParams(window.location.hash.slice(1)).get('view') === 'settings' ? 'settings' : 'dialog'} />}</div>
    </DialogContent>
  </Dialog>
}
