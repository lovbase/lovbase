import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Button } from '../components/ui/button'
import { completeConnectionPopup } from '../lib/connection-popup'
import { useT } from '../lib/i18n'

export const Route = createFileRoute('/connection-callback')({
  component: ConnectionCallback,
  head: () => ({ meta: [{ title: 'Authorization · Lovbase' }, { name: 'robots', content: 'noindex' }] }),
})

function ConnectionCallback() {
  const t = useT()
  useEffect(() => { completeConnectionPopup() }, [])
  return <main className="grid min-h-dvh place-content-center gap-5 bg-panel p-8 text-center text-fg">
    <output>{t('connections.popupReturned', 'Authorization result returned. Continue in the original window.')}</output>
    <Button variant="outline" onClick={() => window.close()}>{t('connections.closeWindow', 'Close window')}</Button>
  </main>
}
