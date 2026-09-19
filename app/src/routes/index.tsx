import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Landing } from '../components/marketing/Landing'
import { currentUser } from '../functions/_ctx'

/** Signed-out visitors get the marketing site here, so the loader may not require a session. */
const isSignedIn = createServerFn().handler(async () => !!(await currentUser()))

export const Route = createFileRoute('/')({
  // `/` is the public landing only. Anyone with a session is sent to /home on the server, so
  // neither page ever renders the other's shell first.
  loader: async () => {
    if (await isSignedIn()) throw redirect({ to: '/home' })
    return { signedIn: false as const }
  },
  component: Home,
})

function Home() {
  return <Landing />
}
