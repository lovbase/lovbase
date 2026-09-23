import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '../components/AuthForm'
import { authOptions } from '../functions/account'
import { translate } from '../lib/i18n'

export const Route = createFileRoute('/login')({
  // Which buttons to draw and whether to challenge: decided by what the deployment configured.
  // An OAuth provider reports failure by sending the browser back here with `?error=`.
  validateSearch: (s: Record<string, unknown>): { error?: string } => (typeof s.error === 'string' && s.error ? { error: s.error } : {}),
  loader: () => authOptions(),
  component: () => <AuthForm mode="login" options={Route.useLoaderData()} oauthError={Route.useSearch().error} />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({ meta: [{ title: translate('meta.login.title', 'Log in · Lovbase') }] }),
})
