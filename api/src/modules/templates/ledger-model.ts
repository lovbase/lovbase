import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import {
  BASE_CURRENCY,
  lastMonths,
  planEntry,
  planOpening,
  type Account,
  type AccountKind,
  type Currency,
  type PlannedPosting,
  type RecordInput,
} from '@lovbase/core/ledger'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'accounts',
    '账户',
    [
      ['name', 'text'],
      ['name_en', 'text'],
      ['kind', 'select', 'asset,liability,income,expense,equity'],
      ['currency', 'select', 'USD,EUR,GBP'],
      ['archived', 'boolean'],
    ],
  ],
  [
    'fx_rates',
    '汇率',
    [
      ['currency', 'select', 'EUR,GBP'],
      ['rate', 'number'],
    ],
  ],
  [
    'entries',
    '记账凭证',
    [
      ['occurred_on', 'text'],
      ['kind', 'select', 'expense,income,transfer,opening,reversal'],
      ['payee', 'text'],
      ['memo', 'text'],
      ['reverses', 'link', 'entries'],
    ],
  ],
  [
    'postings',
    '分录',
    [
      ['entry_id', 'link', 'entries'],
      ['account_id', 'link', 'accounts'],
      ['amount_cents', 'number'],
      ['base_cents', 'number'],
    ],
  ],
  [
    'budgets',
    '预算',
    [
      ['account_id', 'link', 'accounts'],
      ['month', 'text'],
      ['amount_cents', 'number'],
    ],
  ],
]
export const ledgerIR: IR = {
  version: 1,
  appName: 'Ledger',
  entities: definitions.map(([dbName, name, fields]) => ({
    id: dbName,
    dbName,
    name,
    fields: fields.map(([field, type, extra]) => ({
      id: `${dbName}_${field}`,
      dbName: field,
      name: field,
      type,
      required: false,
      ...(type === 'link' ? { linkTo: extra } : {}),
      ...(type === 'select' ? { options: extra!.split(',') } : {}),
    })),
  })),
}

const cents = (column: string, zero: boolean) =>
  `CHECK(${column} = trunc(${column}) AND abs(${column}) <= 10000000000${zero ? '' : ` AND ${column} <> 0`})`

/**
 * The bookkeeping rules live in the database as well as the service, so an app the owner later
 * changes, or a query typed into the SQL console, cannot unbalance the books either.
 */
export async function installLedger(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(ledgerIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('accounts')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN kind SET NOT NULL, ALTER COLUMN currency SET NOT NULL,
    ALTER COLUMN archived SET NOT NULL, ALTER COLUMN archived SET DEFAULT false,
    ADD CHECK(kind IN ('asset','liability','income','expense','equity')),
    ADD CHECK(currency IN ('USD','EUR','GBP')),
    ADD CHECK(kind IN ('asset','liability') OR currency = '${BASE_CURRENCY}')`)
  await c.query(`ALTER TABLE ${table('fx_rates')}
    ALTER COLUMN currency SET NOT NULL, ALTER COLUMN rate SET NOT NULL,
    ADD UNIQUE(currency), ADD CHECK(currency IN ('EUR','GBP')), ADD CHECK(rate > 0 AND rate <= 10000)`)
  await c.query(`ALTER TABLE ${table('entries')}
    ALTER COLUMN occurred_on SET NOT NULL, ALTER COLUMN kind SET NOT NULL,
    ALTER COLUMN payee SET DEFAULT '', ALTER COLUMN memo SET DEFAULT '',
    ADD CHECK(occurred_on ~ '^\\d{4}-\\d{2}-\\d{2}$' AND occurred_on::date IS NOT NULL),
    ADD CHECK(kind IN ('expense','income','transfer','opening','reversal')),
    ADD CHECK((kind = 'reversal') = (reverses IS NOT NULL)),
    ADD UNIQUE(reverses)`)
  await c.query(`ALTER TABLE ${table('postings')}
    ALTER COLUMN entry_id SET NOT NULL, ALTER COLUMN account_id SET NOT NULL,
    ALTER COLUMN amount_cents SET NOT NULL, ALTER COLUMN base_cents SET NOT NULL,
    ADD ${cents('amount_cents', false)}, ADD ${cents('base_cents', false)},
    ADD CHECK(sign(amount_cents) = sign(base_cents))`)
  await c.query(`ALTER TABLE ${table('budgets')}
    ALTER COLUMN account_id SET NOT NULL, ALTER COLUMN month SET NOT NULL, ALTER COLUMN amount_cents SET NOT NULL,
    ADD CHECK(month ~ '^\\d{4}-(0[1-9]|1[0-2])$'), ADD ${cents('amount_cents', true)}, ADD CHECK(amount_cents >= 0),
    ADD UNIQUE(account_id, month)`)
  await c.query(`CREATE INDEX ON ${table('postings')}(entry_id)`)
  await c.query(`CREATE INDEX ON ${table('postings')}(account_id)`)
  await c.query(`CREATE INDEX ON ${table('entries')}(occurred_on)`)
  // Entries and postings are append-only: a mistake is corrected with a reversing entry.
  await c.query(`CREATE FUNCTION ${s}.ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ledger_append_only' USING ERRCODE = 'check_violation'; END $$`)
  for (const name of ['entries', 'postings'])
    await c.query(`CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON ${table(name)}
      FOR EACH ROW EXECUTE FUNCTION ${s}.ledger_append_only()`)
  // Checked at commit, once every posting of the entry is in: at least two lines, summing to zero.
  await c.query(`CREATE FUNCTION ${s}.ledger_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE total numeric; lines integer; entry uuid;
    BEGIN
      -- Separate statements: plpgsql only plans the branch for the table that fired.
      IF TG_TABLE_NAME = 'entries' THEN entry := NEW.id; ELSE entry := NEW.entry_id; END IF;
      SELECT coalesce(sum(base_cents), 0), count(*) INTO total, lines
        FROM ${table('postings')} WHERE entry_id = entry;
      IF lines < 2 OR total <> 0 THEN
        RAISE EXCEPTION 'ledger_unbalanced' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END $$`)
  for (const name of ['entries', 'postings'])
    await c.query(`CREATE CONSTRAINT TRIGGER balanced AFTER INSERT ON ${table(name)}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.ledger_entry_balanced()`)
}

/** Deterministic, so every demo and every copy starts from the same believable six months. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

export async function seedLedger(c: pg.PoolClient, schema: string, today = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const accounts: Account[] = []
  const account = async (name: string, name_en: string, kind: AccountKind, currency: Currency = BASE_CURRENCY) => {
    // Staggered by a millisecond so the accounts list in the order they were written here.
    const row: Account = { id: randomUUID(), created_at: new Date(today.getTime() + accounts.length).toISOString(), name, name_en, kind, currency, archived: false }
    accounts.push(row)
    await insert('accounts', row)
    return row
  }
  const rates = [
    { currency: 'EUR' as const, rate: 1.087 },
    { currency: 'GBP' as const, rate: 1.274 },
  ]
  for (const rate of rates) await insert('fx_rates', { id: randomUUID(), ...rate })

  const equity = await account('期初余额', 'Opening balances', 'equity')
  const checking = await account('工资卡', 'Everyday checking', 'asset')
  const savings = await account('储蓄账户', 'Savings', 'asset')
  const eur = await account('欧元账户', 'EUR account', 'asset', 'EUR')
  const gbp = await account('英镑券商账户', 'GBP brokerage', 'asset', 'GBP')
  const card = await account('信用卡', 'Credit card', 'liability')
  const salary = await account('工资', 'Salary', 'income')
  const freelance = await account('副业收入', 'Freelance', 'income')
  const interest = await account('利息', 'Interest', 'income')
  const rent = await account('房租', 'Rent', 'expense')
  const groceries = await account('买菜', 'Groceries', 'expense')
  const dining = await account('餐饮', 'Dining out', 'expense')
  const transport = await account('交通', 'Transport', 'expense')
  const subscriptions = await account('会员订阅', 'Subscriptions', 'expense')
  const shopping = await account('购物', 'Shopping', 'expense')
  const health = await account('健康', 'Health', 'expense')
  const travel = await account('旅行', 'Travel', 'expense')

  const book = async (occurred_on: string, kind: string, payee: string, memo: string, postings: PlannedPosting[]) => {
    const id = randomUUID()
    await insert('entries', { id, occurred_on, kind, payee, memo })
    for (const p of postings) await insert('postings', { id: randomUUID(), entry_id: id, ...p })
  }
  // Seven months, so a demo opened early in a month still shows six full ones.
  const months = lastMonths(today.toISOString().slice(0, 7), 7)
  const opened = `${months[0]}-01`
  for (const [target, opening] of [[checking, 1_236_000], [savings, 4_200_000], [eur, 320_000], [gbp, 180_000], [card, -184_000]] as const)
    await book(opened, 'opening', '', 'Fictional sample data', planOpening(target, equity, opening, rates))

  const rand = random(20261103)
  const amount = (low: number, high: number) => Math.round(low + rand() * (high - low)) * 100
  const record = (input: Omit<RecordInput, 'memo'> & { memo?: string }) =>
    book(input.occurredOn, input.kind, input.payee, input.memo ?? '', planEntry({ memo: '', ...input }, accounts, rates))
  const todayDay = today.toISOString().slice(0, 10)
  // What the card owes; each month's repayment clears the statement built up before it.
  let owed = 184_000
  const spend = (from: Account, to: Account, payee: string, amountCents: number, on: string, memo?: string) => {
    if (from === card) owed += amountCents
    return record({ kind: 'expense', fromAccountId: from.id, toAccountId: to.id, payee, amountCents, occurredOn: on, memo })
  }

  for (const [index, month] of months.entries()) {
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()
    const ifPast = async (d: number, run: (on: string) => Promise<unknown> | null) => {
      const on = `${month}-${String(Math.min(d, last)).padStart(2, '0')}`
      if (on <= todayDay) await run(on)
    }
    await ifPast(1, (on) => spend(checking, rent, 'Harbour Lettings', 245_000, on))
    await ifPast(10, (on) => record({ kind: 'income', fromAccountId: salary.id, toAccountId: checking.id, payee: 'Sample Tech Inc.', amountCents: 780_000, occurredOn: on }))
    await ifPast(11, (on) => record({ kind: 'transfer', fromAccountId: checking.id, toAccountId: savings.id, payee: '', memo: 'Monthly savings', amountCents: 150_000, occurredOn: on }))
    await ifPast(15, async (on) => {
      await record({ kind: 'transfer', fromAccountId: checking.id, toAccountId: card.id, payee: '', memo: 'Card repayment', amountCents: owed, occurredOn: on })
      owed = 0
    })
    await ifPast(3, (on) => spend(card, subscriptions, 'Music streaming', 1_099, on))
    await ifPast(7, (on) => spend(card, subscriptions, 'Cloud storage', 999, on))
    await ifPast(20, (on) => spend(card, subscriptions, 'Video streaming', 1_599, on))
    await ifPast(28, (on) => record({ kind: 'income', fromAccountId: interest.id, toAccountId: savings.id, payee: 'Sample Bank', amountCents: 6_500 + index * 150, occurredOn: on }))
    for (const d of [2, 9, 16, 23, 30]) await ifPast(d, (on) => spend(checking, groceries, 'Fresh market', amount(40, 160), on))
    for (const d of [4, 6, 12, 14, 18, 21, 25, 27]) await ifPast(d, (on) => spend(card, dining, ['Corner café', 'Ramen bar', 'Delivery'][d % 3], amount(12, 60), on))
    for (const d of [5, 13, 19, 26]) await ifPast(d, (on) => spend(card, transport, 'Transit & rideshare', amount(10, 45), on))
    if (index % 2) await ifPast(17, (on) => spend(card, shopping, 'Online store', amount(60, 400), on))
    if (index === 3) await ifPast(8, (on) => spend(card, health, 'Community clinic', 32_000, on, 'Annual check-up'))
    if (index === 2 || index === 5) {
      await ifPast(22, (on) => record({ kind: 'income', fromAccountId: freelance.id, toAccountId: checking.id, payee: 'Design client', amountCents: index === 2 ? 480_000 : 720_000, occurredOn: on }))
    }
    if (index === 4) {
      await ifPast(2, (on) => record({ kind: 'transfer', fromAccountId: checking.id, toAccountId: eur.id, payee: '', memo: 'Currency exchange', amountCents: 300_000, toAmountCents: 276_000, occurredOn: on }))
      // Spending abroad: the card is in the base currency, so the merchant amount is already converted.
      await ifPast(6, (on) => spend(card, travel, 'Lisbon hotel', 94_000, on, 'Weekend trip'))
      await ifPast(7, (on) => spend(eur, travel, 'Trams & restaurants', 62_000, on, 'Paid in EUR'))
    }
  }
  for (const [target, budget] of [[rent, 245_000], [groceries, 60_000], [dining, 40_000], [transport, 15_000], [subscriptions, 4_000], [shopping, 50_000], [travel, 200_000]] as const)
    for (const month of months.slice(-3))
      await insert('budgets', { id: randomUUID(), account_id: target.id, month, amount_cents: budget })
}
