import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '../components/AuthForm'
import { authOptions } from '../functions/account'
import { detectLocale } from '../lib/i18n'

export const Route = createFileRoute('/signup')({
  // Which buttons to draw and whether to challenge: decided by what the deployment configured.
  loader: () => authOptions(),
  component: () => <AuthForm mode="signup" options={Route.useLoaderData()} />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({ meta: [{ title: detectLocale() === 'en' ? 'Sign up · Lovbase' : '注册 · Lovbase' }] }),
})
