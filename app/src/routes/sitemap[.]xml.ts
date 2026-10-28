import { createFileRoute } from '@tanstack/react-router'
import { ConfigService, svc } from '@lovbase/api'
import { publicSitemapPaths } from '../lib/seo'

function escapeXml(value: string) {
  return value.replace(
    /[<>&'\"]/g,
    (char) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[char]!,
  )
}

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const origin = new URL((await svc(ConfigService)).env.BETTER_AUTH_URL).origin
        const urls = publicSitemapPaths(origin)
          .map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`)
          .join('\n')
        const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
        return new Response(body, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        })
      },
    },
  },
})
