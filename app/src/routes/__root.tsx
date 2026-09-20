import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../lib/i18n'
import { getLocale } from '../functions/locale'
import { getLayout } from '../functions/layout'
import { LayoutProvider } from '../lib/layout-context'
import { Analytics } from '../components/Analytics'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Lovbase',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      // Fallback for the browsers that still do not take an SVG favicon.
      { rel: 'icon', type: 'image/png', href: '/favicon.png' },
    ],
  }),
  // Resolved on the server from the cookie, so the document is rendered in the right language
  // rather than rendered in Chinese and corrected after hydration.
  loader: async () => {
    const [locale, layout] = await Promise.all([getLocale(), getLayout()])
    return { locale, layout }
  },
  staleTime: Infinity,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { locale, layout } = Route.useLoaderData()
  return (
    // The theme script below adds `dark` to this element before React hydrates, so the server HTML
    // and the client tree disagree on purpose. Without this, React reports it as a mismatch on
    // every single page load — and it cannot patch it up, so the warning is pure noise. The
    // alternative, rendering the theme only after mount, is the flash of the wrong colour.
    <html lang={locale === 'en' ? 'en' : 'zh-CN'} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html:
          `(()=>{try{var t=localStorage.getItem('lovbase-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()`
        }} />
        <HeadContent />
      </head>
      <body>
        <I18nProvider initial={locale}><LayoutProvider value={layout}><TooltipProvider>{children}</TooltipProvider></LayoutProvider><Analytics /></I18nProvider>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
