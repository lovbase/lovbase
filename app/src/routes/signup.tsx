import { createFileRoute } from '@tanstack/react-router'
import { authSearch } from '../lib/auth-return'
import { AuthForm } from '../components/AuthForm'
import { authOptions } from '../functions/account'
import { translate } from '../lib/i18n'

export const Route = createFileRoute('/signup')({
  // Which buttons to draw and whether to challenge: decided by what the deployment configured.
  // An OAuth provider reports failure by sending the browser back here with `?error=`.
  validateSearch: authSearch,
  loader: () => authOptions(),
  component: () => <AuthForm mode="signup" options={Route.useLoaderData()} oauthError={Route.useSearch().error} returnTo={Route.useSearch().returnTo} />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({ meta: [{ title: translate('meta.signup.title', 'Sign up · Lovbase') }, { name: 'robots', content: 'noindex,nofollow' }] }),
})
