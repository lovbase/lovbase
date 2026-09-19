import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '../components/AuthForm'
import { detectLocale } from '../lib/i18n'

export const Route = createFileRoute('/login')({
  component: () => <AuthForm mode="login" />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({ meta: [{ title: detectLocale() === 'en' ? 'Log in · Lovbase' : '登录 · Lovbase' }] }),
})
