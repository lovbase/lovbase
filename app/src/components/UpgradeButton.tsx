import type { ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { useT } from '../lib/i18n'

/** Menu actions share the same destination as visible upgrade links. */
export function useUpgrade(plan: string) {
  const router = useRouter()
  return {
    open: () => {
      if (plan !== 'business') void router.navigate({ to: '/pricing', search: { billing: 'monthly' } })
    },
  }
}

export function UpgradeButton({
  plan,
  source,
  className,
  children,
}: {
  plan: string
  source: string
  className?: string
  children?: ReactNode
}) {
  const t = useT()
  if (plan === 'business') return null
  return (
    <Link to="/pricing" search={{ billing: 'monthly' }} data-upgrade-source={source} className={className}>
      {children ?? t('nav.upgrade', 'Upgrade')}
    </Link>
  )
}
