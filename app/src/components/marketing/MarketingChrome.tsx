import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import { Logo } from '../Logo'
import { ThemeToggle } from '../ThemeToggle'
import { LocaleToggle } from '../LocaleToggle'
import { useT } from '../../lib/i18n'

/** Repo URL. One place, so swapping the org/name later is a single edit. */
// The repo is not published yet. Set VITE_GITHUB_URL to switch every GitHub link on;
// until then they are hidden rather than pointing at a 404.
export const GITHUB_URL = import.meta.env.VITE_GITHUB_URL ?? ''
export const hasGithub = !!GITHUB_URL

export function Container({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-6 ${className}`}>{children}</div>
}

export function PrimaryLink({ to, children, className = '' }: { to: '/signup' | '/pricing' | '/login'; children: ReactNode; className?: string }) {
  return (
    <Link to={to}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-accent text-on-accent
                  text-[13.5px] font-medium hover:bg-accent-soft transition-colors ${className}`}>
      {children}
    </Link>
  )
}

export function GhostLink({ to, children, className = '' }: { to: '/signup' | '/pricing' | '/login'; children: ReactNode; className?: string }) {
  return (
    <Link to={to}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-edge bg-panel
                  text-[13.5px] font-medium text-fg-mid hover:text-fg hover:border-edge-strong transition-colors ${className}`}>
      {children}
    </Link>
  )
}

/** Small caps label above a section title. */
export function SectionHead({ eyebrow, title, sub, className = '' }: { eyebrow: string; title: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`max-w-2xl ${className}`}>
      <p className="eyebrow uppercase tracking-[.14em]">{eyebrow}</p>
      <h2 className="font-display text-[26px] sm:text-[32px] font-semibold leading-[1.2] text-balance mt-3">{title}</h2>
      {sub && <p className="text-[14.5px] leading-relaxed text-fg-mid mt-3">{sub}</p>}
    </div>
  )
}

const NAV_LINK = 'text-[13px] text-fg-mid hover:text-fg transition-colors'

export function MarketingHeader() {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-panel/85 backdrop-blur-md supports-[backdrop-filter]:bg-panel/70">
      <Container className="h-14 flex items-center gap-7">
        <Link to="/" className="flex items-center gap-2.5 select-none shrink-0" aria-label={t('nav.aria.home', 'Lovbase 首页')}>
          <Logo size={20} />
          <span className="font-mono text-[15px] font-medium tracking-tight">lovbase</span>
        </Link>

        <nav className="hidden md:flex items-center gap-6" aria-label={t('nav.aria.main', '主导航')}>
          <Link to="/" hash="features" className={NAV_LINK}>{t('nav.features', '功能')}</Link>
          <Link to="/pricing" className={NAV_LINK}>{t('nav.pricing', '价格')}</Link>
          {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className={`${NAV_LINK} inline-flex items-center gap-0.5`}>
            GitHub <ArrowUpRight className="size-3" />
          </a>)}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <LocaleToggle className="hidden sm:inline-flex" />
          <ThemeToggle />
          <Link to="/login" className="hidden sm:inline-flex px-3 py-1.5 rounded-lg text-[13px] text-fg-mid hover:text-fg hover:bg-panel-2 transition-colors">
            {t('nav.login', '登录')}
          </Link>
          <Link to="/signup"
            className="inline-flex items-center px-3.5 py-2 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:bg-accent-soft transition-colors">
            {t('nav.start', '开始构建')}
          </Link>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('nav.aria.menu', '菜单')}
            className="md:hidden size-8 -mr-1 flex items-center justify-center rounded-lg text-fg-mid hover:text-fg hover:bg-panel-2 transition-colors cursor-pointer">
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </Container>

      {open && (
        <div className="md:hidden border-t border-edge bg-panel">
          <Container className="py-3 flex flex-col gap-1">
            <Link to="/" hash="features" onClick={() => setOpen(false)} className="py-2 text-[14px] text-fg-mid hover:text-fg">{t('nav.features', '功能')}</Link>
            <Link to="/pricing" onClick={() => setOpen(false)} className="py-2 text-[14px] text-fg-mid hover:text-fg">{t('nav.pricing', '价格')}</Link>
            {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className="py-2 text-[14px] text-fg-mid hover:text-fg inline-flex items-center gap-1">
              GitHub <ArrowUpRight className="size-3.5" />
            </a>)}
            <Link to="/login" onClick={() => setOpen(false)} className="py-2 text-[14px] text-fg-mid hover:text-fg">{t('nav.login', '登录')}</Link>
            <LocaleToggle className="sm:hidden self-start mt-1" />
          </Container>
        </div>
      )}
    </header>
  )
}

export function MarketingFooter() {
  const t = useT()
  return (
    <footer className="border-t border-edge bg-panel">
      <Container className="py-12">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5 select-none">
              <Logo size={20} />
              <span className="font-mono text-[15px] font-medium tracking-tight">lovbase</span>
            </div>
            <p className="text-[13px] leading-relaxed text-fg-dim mt-3">
              {t('footer.blurb', '一句话生成真实的 Postgres 数据库和可用的应用。改需求时,已有数据一行不丢。')}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-10 gap-y-8 text-[13px]">
            <FooterCol title={t('footer.product', '产品')}>
              <FooterHash hash="how">{t('footer.how', '工作方式')}</FooterHash>
              <FooterHash hash="features">{t('nav.features', '功能')}</FooterHash>
              <FooterHash hash="api">{t('footer.api', '数据 API')}</FooterHash>
              <FooterTo to="/pricing">{t('nav.pricing', '价格')}</FooterTo>
            </FooterCol>
            <FooterCol title={t('footer.getStarted', '开始')}>
              <FooterTo to="/signup">{t('footer.signup', '注册')}</FooterTo>
              <FooterTo to="/login">{t('nav.login', '登录')}</FooterTo>
              <FooterHash hash="selfhost">{t('footer.selfhost', '自托管')}</FooterHash>
            </FooterCol>
            <FooterCol title={t('footer.openSource', '开源')}>
              <li>
                {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-fg-mid hover:text-fg transition-colors inline-flex items-center gap-1">
                  GitHub <ArrowUpRight className="size-3" />
                </a>)}
              </li>
            </FooterCol>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-edge flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
          <p className="text-[12px] text-fg-dim">© {new Date().getFullYear()} Lovbase</p>
          <p className="text-[12px] text-fg-dim font-mono">Postgres · IR → diff → DDL · BYOK</p>
        </div>
      </Container>
    </footer>
  )
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="eyebrow uppercase tracking-[.14em] mb-3">{title}</p>
      <ul className="space-y-2.5">{children}</ul>
    </div>
  )
}

function FooterTo({ to, children }: { to: '/signup' | '/login' | '/pricing'; children: ReactNode }) {
  return <li><Link to={to} className="text-fg-mid hover:text-fg transition-colors">{children}</Link></li>
}

function FooterHash({ hash, children }: { hash: string; children: ReactNode }) {
  return <li><Link to="/" hash={hash} className="text-fg-mid hover:text-fg transition-colors">{children}</Link></li>
}
