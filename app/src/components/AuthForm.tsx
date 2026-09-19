import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { signIn, signUp } from '../lib/auth-client'
import { useT } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { Logo } from './Logo'
import { track } from '../lib/posthog'

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter()
  const t = useT()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isLogin = mode === 'login'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    const res = isLogin
      ? await signIn.email({ email, password })
      : await signUp.email({ email, password, name: name || email.split('@')[0] })
    setBusy(false)
    if (res.error) {
      setError(res.error.message ?? t('auth.error.generic', '出错了,再试一次'))
    } else {
      if (mode === 'signup') track('signed_up')
      router.navigate({ to: '/' })
    }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[22.5rem]">
        <div className="flex items-center gap-2.5 justify-center mb-8 select-none">
          <Logo />
          <span className="font-mono text-[17px] font-medium tracking-tight">lovbase</span>
        </div>

        <div className="bg-panel/90 backdrop-blur border border-edge rounded-2xl p-6
                        shadow-2xl shadow-black/10 dark:shadow-black/50">
          <h1 className="font-display text-[20px] font-semibold mb-1">
            {isLogin ? t('auth.login.title', '登录') : t('auth.signup.title', '创建账号')}
          </h1>
          <p className="text-[13px] text-fg-dim mb-5">
            {isLogin ? t('auth.login.sub', '继续构建你的应用') : t('auth.signup.sub', '用一句话,得到一个真数据库')}
          </p>

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

            {error && (
              <p className="text-[12.5px] text-accent-soft border border-accent/25 bg-accent/5 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={busy || !email || !password}
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
        className="w-full px-3.5 py-2.5 bg-ink border border-edge rounded-lg text-[14px] text-fg
                   placeholder-fg-dim/60 focus:outline-none focus:border-edge-strong transition-colors"
        {...rest}
      />
    </label>
  )
}
