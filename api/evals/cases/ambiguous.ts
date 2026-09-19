import type { Case } from '../types'
import { crm } from '../fixtures'

// The pure modeller has no way to ask a question — it must return an IR. So the bar here is
// restraint: a vague sentence must not become five invented tables.
export const cases: Case[] = [
  {
    name: 'vague praise changes nothing',
    category: 'ambiguous',
    given: crm,
    when: '帮我优化一下',
    expect: { changes: [] },
  },
  {
    name: 'an under-specified request stays small',
    category: 'ambiguous',
    given: crm,
    when: '再加个字段',
    expect: {
      exact: false,
      check: (_ir, changes) =>
        changes.length <= 1 ? null : `invented ${changes.length} changes from an empty request`,
    },
    stretch: true,
  },
]
