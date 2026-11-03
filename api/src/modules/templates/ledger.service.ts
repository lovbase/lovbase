import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { qi } from '@lovbase/core/ddl'
import {
  BASE_CURRENCY,
  MAX_AMOUNT_CENTS,
  MAX_RATE,
  isBalanced,
  isDay,
  isMonth,
  ledgerTables,
  planEntry,
  planOpening,
  reversePostings,
  type Account,
  type FxRate,
  type LedgerData,
  type LedgerResult,
  type PlannedPosting,
  type Posting,
} from '@lovbase/core/ledger'
import { InjectPool } from '../../database/pool.provider'
import { DomainError, Forbidden, NotFound } from '../../common/errors'
import { roleFor, schemaFor } from '../roles/roles.service'
import { LimitsService } from '../limits/limits.service'

const uuid = z.string().uuid()
const day = z.string().refine(isDay)
const cents = z.number().int().min(1).max(MAX_AMOUNT_CENTS)
const text = (max: number) => z.string().trim().max(max)
export const ledgerCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record'),
    requestId: uuid,
    kind: z.enum(['expense', 'income', 'transfer']),
    occurredOn: day,
    payee: text(160),
    memo: text(500),
    fromAccountId: uuid,
    toAccountId: uuid,
    amountCents: cents,
    toAmountCents: cents.optional(),
  }),
  z.object({ action: z.literal('reverse'), requestId: uuid, entryId: uuid, occurredOn: day }),
  z.object({
    action: z.literal('save-account'),
    requestId: uuid,
    id: uuid.optional(),
    name: text(80).min(1),
    name_en: text(80),
    kind: z.enum(['asset', 'liability', 'income', 'expense']),
    currency: z.enum(['CNY', 'HKD', 'USD']),
    archived: z.boolean(),
    openingCents: z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS).optional(),
    openedOn: day.optional(),
  }),
  z.object({
    action: z.literal('set-budget'),
    requestId: uuid,
    accountId: uuid,
    month: z.string().refine(isMonth),
    amountCents: z.number().int().min(0).max(MAX_AMOUNT_CENTS),
  }),
  z.object({
    action: z.literal('set-rate'),
    requestId: uuid,
    currency: z.enum(['HKD', 'USD']),
    rate: z.number().positive().max(MAX_RATE),
  }),
])
const numericFields = new Set(['amount_cents', 'base_cents', 'rate'])
function decode(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      numericFields.has(key) ? Number(value) : value instanceof Date ? value.toISOString() : value,
    ]),
  )
}

/** Domain rule failures become 400s with the rule's code, the same codes the UI translates. */
function plan<T>(run: () => T) {
  try {
    return run()
  } catch (error) {
    throw new DomainError(error instanceof Error ? error.message : 'invalid_input')
  }
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly limits: LimitsService,
  ) {}

  async read(projectId: string): Promise<LedgerData> {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='ledger' AND t.version=1`,
        [projectId],
      )
      if (!meta.rows[0]) throw new NotFound('ledger_not_found')
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const data = { readOnly: !!meta.rows[0].read_only } as LedgerData
      for (const table of ledgerTables) {
        const result = await c.query(
          `SELECT * FROM ${qi(schemaFor(projectId))}.${qi(table)} ORDER BY created_at DESC,id LIMIT 20001`,
        )
        if (result.rows.length > 20000) throw new DomainError('dataset_too_large')
        Object.assign(data, { [table]: result.rows.map(decode) })
      }
      await c.query('COMMIT')
      return data
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }

  async command(projectId: string, raw: unknown): Promise<LedgerResult> {
    const parsed = ledgerCommand.safeParse(raw)
    if (!parsed.success) throw new DomainError('invalid_input')
    const input = parsed.data
    const c = await this.pool.connect()
    const table = (name: string) => `${qi(schemaFor(projectId))}.${qi(name)}`
    try {
      await c.query('BEGIN')
      const owner = await this.limits.beforeWrite(c, projectId)
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='ledger' AND t.version=1 FOR UPDATE OF p`,
        [projectId],
      )
      if (!meta.rows[0]) throw new NotFound('ledger_not_found')
      if (meta.rows[0].read_only) throw new Forbidden('read_only')
      const previous = await c.query(
        `SELECT result,input=$3::jsonb AS same FROM public.lb_ledger_requests WHERE project_id=$1 AND request_id=$2`,
        [projectId, input.requestId, JSON.stringify(input)],
      )
      if (previous.rows[0]) {
        if (!previous.rows[0].same) throw new DomainError('request_conflict')
        await c.query('COMMIT')
        return previous.rows[0].result
      }
      // Run business mutations with the same restricted database role as the workspace data API.
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const insert = async (t: string, values: Record<string, unknown>) => {
        const row = { id: randomUUID(), ...values }
        const keys = Object.keys(row)
        await c.query(
          `INSERT INTO ${table(t)} (${keys.map(qi).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
          Object.values(row),
        )
        return row.id
      }
      const accounts = async () =>
        (await c.query(`SELECT * FROM ${table('accounts')} ORDER BY id`)).rows.map(decode) as Account[]
      const rates = async () =>
        (await c.query(`SELECT * FROM ${table('fx_rates')}`)).rows.map(decode) as FxRate[]
      const book = async (entry: Record<string, unknown>, postings: PlannedPosting[]) => {
        if (!isBalanced(postings)) throw new DomainError('ledger_unbalanced')
        const id = await insert('entries', entry)
        for (const p of postings) await insert('postings', { entry_id: id, ...p })
        return id
      }

      let result: LedgerResult
      if (input.action === 'record') {
        const [list, fx] = [await accounts(), await rates()]
        const postings = plan(() => planEntry(input, list, fx))
        const id = await book(
          { occurred_on: input.occurredOn, kind: input.kind, payee: input.payee, memo: input.memo },
          postings,
        )
        result = { id }
      } else if (input.action === 'reverse') {
        const entry = (await c.query(`SELECT * FROM ${table('entries')} WHERE id=$1`, [input.entryId])).rows[0]
        if (!entry) throw new DomainError('record_unavailable')
        if (entry.kind === 'reversal') throw new DomainError('cannot_reverse_reversal')
        const done = await c.query(`SELECT 1 FROM ${table('entries')} WHERE reverses=$1`, [entry.id])
        if (done.rowCount) throw new DomainError('already_reversed')
        const original = (
          await c.query(`SELECT * FROM ${table('postings')} WHERE entry_id=$1`, [entry.id])
        ).rows.map(decode) as Posting[]
        const id = await book(
          {
            occurred_on: input.occurredOn,
            kind: 'reversal',
            payee: entry.payee ?? '',
            memo: entry.memo ?? '',
            reverses: entry.id,
          },
          reversePostings(original),
        )
        result = { id }
      } else if (input.action === 'save-account') {
        const values = { name: input.name, name_en: input.name_en || input.name, archived: input.archived }
        if (input.kind !== 'asset' && input.kind !== 'liability' && input.currency !== BASE_CURRENCY)
          throw new DomainError('category_base_currency')
        if (input.id) {
          if (input.openingCents !== undefined) throw new DomainError('invalid_input')
          const current = (await c.query(`SELECT * FROM ${table('accounts')} WHERE id=$1 FOR UPDATE`, [input.id])).rows[0]
          if (!current || current.kind === 'equity') throw new DomainError('record_unavailable')
          // Changing either would change what every past posting on the account means.
          if (current.kind !== input.kind || current.currency !== input.currency)
            throw new DomainError('account_locked')
          await c.query(`UPDATE ${table('accounts')} SET name=$2,name_en=$3,archived=$4 WHERE id=$1`, [
            input.id,
            values.name,
            values.name_en,
            values.archived,
          ])
          result = { id: input.id }
        } else {
          const id = await insert('accounts', { ...values, kind: input.kind, currency: input.currency })
          if (input.openingCents) {
            if (!input.openedOn) throw new DomainError('invalid_date')
            const list = await accounts()
            let equity = list.find((a) => a.kind === 'equity' && !a.archived)
            if (!equity) {
              await insert('accounts', { name: '期初余额', name_en: 'Opening balances', kind: 'equity', currency: BASE_CURRENCY, archived: false })
              equity = (await accounts()).find((a) => a.kind === 'equity' && !a.archived)!
            }
            const account = list.find((a) => a.id === id)!
            const fx = await rates()
            await book(
              { occurred_on: input.openedOn, kind: 'opening', payee: '', memo: '' },
              plan(() => planOpening(account, equity, input.openingCents!, fx)),
            )
          }
          result = { id }
        }
      } else if (input.action === 'set-budget') {
        const account = (await c.query(`SELECT kind FROM ${table('accounts')} WHERE id=$1`, [input.accountId])).rows[0]
        if (account?.kind !== 'expense') throw new DomainError('record_unavailable')
        if (input.amountCents === 0)
          await c.query(`DELETE FROM ${table('budgets')} WHERE account_id=$1 AND month=$2`, [input.accountId, input.month])
        else
          await c.query(
            `INSERT INTO ${table('budgets')}(id,account_id,month,amount_cents) VALUES($1,$2,$3,$4)
             ON CONFLICT (account_id,month) DO UPDATE SET amount_cents=EXCLUDED.amount_cents`,
            [randomUUID(), input.accountId, input.month, input.amountCents],
          )
        result = { id: input.accountId }
      } else {
        // Applies to entries recorded from now on; past postings keep the rate they were booked at.
        const saved = await c.query(
          `INSERT INTO ${table('fx_rates')}(id,currency,rate) VALUES($1,$2,$3)
           ON CONFLICT (currency) DO UPDATE SET rate=EXCLUDED.rate RETURNING id`,
          [randomUUID(), input.currency, input.rate],
        )
        result = { id: saved.rows[0].id }
      }
      // Run the deferred balance check now, so a violation surfaces here instead of from COMMIT.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE')

      await c.query('RESET ROLE')
      await this.limits.assertAccount(owner, c)
      await c.query(
        `INSERT INTO public.lb_ledger_requests(project_id,request_id,input,result) VALUES($1,$2,$3,$4)`,
        [projectId, input.requestId, JSON.stringify(input), JSON.stringify(result)],
      )
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }
}
