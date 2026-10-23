# Lovbase web app

## PWA

The production build supports installation as a standalone app. Serve it over HTTPS
(localhost is also supported). Chrome/Edge offer **Install app** in the browser menu;
on iPhone/iPad, use Safari's **Share → Add to Home Screen**. The installed app starts
at `/home`, with the existing login flow for signed-out users.

- `pwa/plugin.ts` emits a versioned `/sw.js` into `dist/client` during the client build.
  No worker is registered by the development server.
- Only build-listed static assets are cached after use, with a 200-entry limit.
  The small offline page and icons are precached. SSR documents, authentication,
  APIs, server functions, AI streams, and sandbox previews are not cached.
- A network failure during a full-page navigation shows an offline page with a retry
  button. An already-open app shows a connection notice. AI and project operations
  still require a connection; there is no offline editing or queued mutation replay.
- Updates are checked on registration, when returning to a visible window or going
  online, and hourly while visible. The user can defer the update or explicitly
  refresh after saving work. Accepting an update refreshes only that window.
- Keep `/sw.js`, `/manifest.webmanifest`, and `/offline.html` revalidated through
  any CDN. `server.mjs` sets `Cache-Control: no-cache` for these URLs. Deploy the
  client and server outputs together using the existing build process.

The icons reuse `public/favicon.svg`; the maskable icon has an opaque background
and safe padding. These settings apply to the Lovbase host, not generated apps.

Validation: `bun test app/tests` from the repository root, plus
`bun run --cwd app typecheck` and `bun run --cwd app build`. In a production browser,
check installation, offline navigation, a second build's update prompt, and the
absence of API/HTML responses in Cache Storage.

### Testing updates locally

Stop the running web server **before** rebuilding, keep the browser tab open, then
run this from the repository root:

```bash
bun run build && bun run start:web
```

Wait for `lovbase on :3008` before checking for an update in the browser. Do not
run a build and the production server concurrently: Vite replaces `dist/server`,
while a running Node process retains its old module references. That can make
page refreshes return `{"status":500,"unhandled":true,"message":"HTTPError"}`.
If this happens, wait for the build to finish and restart `bun run start:web`;
clearing the browser's PWA cache does not fix stale server modules.

To exercise the update prompt, change a visible frontend string between builds.
In DevTools → Application → Service Workers, click **Update** after the new server
starts. Leave **Update on reload** disabled and do not click **skipWaiting**:
use the app's **Refresh to update** button to test the actual activation flow.

# Getting Started

To run this application:

```bash
bun install
bun --bun run dev
```

# Building For Production

To build this application for production:

```bash
bun --bun run build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`


## Deploy to Cloudflare Workers

This project uses the Cloudflare Vite plugin (configured in `vite.config.ts`) and `wrangler.jsonc`:

1. Install Wrangler: `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Deploy: `npx wrangler deploy`

For production env vars, run `wrangler secret put MY_VAR` for each secret listed in `.env.example`. Public (non-secret) vars go in `wrangler.jsonc` under `vars`.

KV, D1, R2, and Durable Object bindings are configured in `wrangler.jsonc` — see https://developers.cloudflare.com/workers/wrangler/configuration/.



## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).



# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
