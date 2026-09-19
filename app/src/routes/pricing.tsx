import { createFileRoute } from '@tanstack/react-router'
import { PricingView } from '../components/marketing/PricingView'

export const Route = createFileRoute('/pricing')({
  component: PricingView,
  head: () => ({
    meta: [
      { title: '价格 · Lovbase' },
      { name: 'description', content: '按实际用量计费,不按座位。免费版即可建出真实的 Postgres 数据库;自托管始终免费。' },
    ],
  }),
})
