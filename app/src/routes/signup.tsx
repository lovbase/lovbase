import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '../components/AuthForm'
import { detectLocale } from '../lib/i18n'

export const Route = createFileRoute('/signup')({
  component: () => <AuthForm mode="signup" />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({ meta: [{ title: detectLocale() === 'en' ? 'Sign up · Lovbase' : '注册 · Lovbase' }] }),
})
