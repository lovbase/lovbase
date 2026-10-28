import { createFileRoute } from '@tanstack/react-router'
import { ConfigService, svc } from '@lovbase/api'

async function siteOrigin() {
  return new URL((await svc(ConfigService)).env.BETTER_AUTH_URL).origin
}

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async () => {
        const origin = await siteOrigin()
        return new Response(
          [
            'User-agent: *',
            'Allow: /',
            'Disallow: /home',
            'Disallow: /projects',
            'Disallow: /settings',
            'Disallow: /admin',
            'Disallow: /login',
            'Disallow: /signup',
            'Disallow: /mcp/',
            'Disallow: /connection-callback',
            'Disallow: /share/',
            `Sitemap: ${origin}/sitemap.xml`,
            '',
          ].join('\n'),
          { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        )
      },
    },
  },
})
