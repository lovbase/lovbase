import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { signIn, signUp } from '../lib/auth-client'
import { useT } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { Logo } from './Logo'
import { AuthShowcase } from './AuthShowcase'
import { track } from '../lib/posthog'
import { Turnstile } from './Turnstile'
import type { authOptions } from '../functions/account'

type AuthOptions = Awaited<ReturnType<typeof authOptions>>

export function AuthForm({ mode, options }: { mode: 'login' | 'signup'; options?: AuthOptions }) {
  const router = useRouter()
  const t = useT()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isLogin = mode === 'login'
  const siteKey = options?.turnstileSiteKey ?? null
  const social = { github: !!options?.github, google: !!options?.google }
  // The captcha token, when a challenge is configured. A Turnstile token is single-use, so a
  // failed submit bumps `captchaReset` and the widget issues a new one before the next try.
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  const needCaptcha = !!siteKey && !captcha

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || needCaptcha) return
    setBusy(true); setError('')
    const fetchOptions = siteKey ? { headers: { 'x-captcha-response': captcha } } : undefined
    const res = isLogin
      ? await signIn.email({ email, password }, fetchOptions)
      : await signUp.email({ email, password, name: name || email.split('@')[0] }, fetchOptions)
    setBusy(false)
    if (res.error) {
      setError(res.error.message ?? t('auth.error.generic', '出错了,再试一次'))
      if (siteKey) setCaptchaReset((n) => n + 1)
    } else {
      if (mode === 'signup') track('signed_up')
      router.navigate({ to: '/home' })
    }
  }

  // OAuth: the browser leaves for the provider and comes back signed in at `callbackURL`. Any
  // error the provider reports lands on this page's `?error=` for the person to read.
  async function continueWith(provider: 'github' | 'google') {
    if (busy) return
    setBusy(true); setError('')
    const res = await signIn.social({ provider, callbackURL: '/home', errorCallbackURL: `/${mode}` })
    if (res.error) { setBusy(false); setError(res.error.message ?? t('auth.error.generic', '出错了,再试一次')) }
  }

  return (
    // Split, not centred: the left half is the only thing on this page worth looking at, and a
    // form floating alone in the middle of a screen says nothing about what it signs you in to.
    // Below lg there is no room for both, and the form is the half that has a job.
    <div className="min-h-screen bg-panel text-fg antialiased lg:grid lg:grid-cols-[1.1fr_minmax(26rem,0.9fr)]">
      <div className="hidden lg:block border-r border-edge"><AuthShowcase /></div>

      <div className="min-h-screen lg:min-h-0 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[22.5rem]">
        <div className="flex items-center gap-2.5 justify-center mb-8 select-none">
          <Logo />
          <span className="font-mono text-[17px] font-medium tracking-tight">lovbase</span>
        </div>

        <div className="bg-panel border border-edge rounded-2xl p-6
                        shadow-[0_1px_2px_rgb(0_0_0/.03),0_24px_48px_-24px_rgb(0_0_0/.18)] dark:shadow-black/50">
          <h1 className="font-display text-[20px] font-semibold mb-1">
            {isLogin ? t('auth.login.title', '登录') : t('auth.signup.title', '创建账号')}
          </h1>
          <p className="text-[13px] text-fg-dim mb-5">
            {isLogin ? t('auth.login.sub', '继续构建你的应用') : t('auth.signup.sub', '用一句话,得到一个真数据库')}
          </p>

          {(social.github || social.google) && (
            <>
              <div className="space-y-2">
                {social.github && (
                  <SocialButton onClick={() => continueWith('github')} disabled={busy} icon={<GitHubMark />}
                    label={t('auth.social.github', '用 GitHub 继续')} />
                )}
                {social.google && (
                  <SocialButton onClick={() => continueWith('google')} disabled={busy} icon={<GoogleMark />}
                    label={t('auth.social.google', '用 Google 继续')} />
                )}
              </div>
              <div className="my-5 flex items-center gap-3 text-[11px] text-fg-dim">
                <span className="h-px flex-1 bg-edge" />{t('auth.or', '或用邮箱')}<span className="h-px flex-1 bg-edge" />
              </div>
            </>
          )}

          <form onSubmit={submit} className="space-y-3.5">
            {!isLogin && (
              <Field label={t('auth.field.name', '名字')} type="text" value={name} onChange={setName}
                placeholder={t('auth.field.name.placeholder', '怎么称呼你')} autoComplete="name" />
            )}
            <Field label={t('auth.field.email', '邮箱')} type="email" value={email} onChange={setEmail}
              placeholder="you@example.com" autoComplete="email" required />
            <Field label={t('auth.field.password', '密码')} type="password" value={password} onChange={setPassword}
              placeholder={isLogin ? '••••••••' : t('auth.field.password.placeholder', '至少 8 位')} required
              autoComplete={isLogin ? 'current-password' : 'new-password'} />

            {siteKey && <Turnstile siteKey={siteKey} onToken={setCaptcha} resetKey={captchaReset} />}

            {error && (
              <p className="text-[12.5px] text-accent-soft border border-accent/25 bg-accent/5 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={busy || !email || !password || needCaptcha}
              className="w-full py-2.5 bg-accent text-on-accent rounded-lg text-[13.5px] font-medium
                         hover:bg-accent-soft disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors cursor-pointer">
              {busy ? t('auth.submitting', '请稍候…') : isLogin ? t('auth.login.title', '登录') : t('auth.signup.submit', '注册')}
            </button>
          </form>
        </div>

        <p className="text-center text-[13px] text-fg-dim mt-5">
          {isLogin ? t('auth.noAccount', '还没有账号?') : t('auth.hasAccount', '已有账号?')}{' '}
          <Link to={isLogin ? '/signup' : '/login'}
            className="text-fg-mid hover:text-fg underline underline-offset-4 decoration-edge-strong transition-colors">
            {isLogin ? t('auth.signup.submit', '注册') : t('auth.login.title', '登录')}
          </Link>
        </p>

        <div className="mt-6 flex justify-center">
          <LocaleToggle />
        </div>
      </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, ...rest }: {
  label: string; value: string; onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="block font-mono text-[10.5px] uppercase tracking-[.12em] text-fg-dim mb-1.5">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3.5 py-2.5 bg-panel-2 border border-edge rounded-lg text-[14px] text-fg
                   placeholder-fg-dim/60 focus:outline-none focus:border-edge-strong transition-colors"
        {...rest}
      />
    </label>
  )
}

function SocialButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="w-full py-2.5 px-3.5 rounded-lg border border-edge bg-panel text-[13.5px] font-medium text-fg
                 inline-flex items-center justify-center gap-2.5 hover:border-edge-strong hover:bg-panel-2
                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer">
      {icon}{label}
    </button>
  )
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}
