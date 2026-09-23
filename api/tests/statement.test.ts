import { describe, expect, test } from 'bun:test'
import { MAX_ROWS, prepareStatement } from '../src/modules/sql/statement'
import { ConfigService } from '../src/config/config.service'

describe('prepareStatement', () => {
  test('wraps reads in a LIMIT', () => {
    const p = prepareStatement('select * from events;')
    expect(p.kind).toBe('read')
    expect(p.text).toBe(`SELECT * FROM (select * from events) AS _q LIMIT ${MAX_ROWS + 1}`)
  })
  test('writes pass through untouched', () => {
    const p = prepareStatement('insert into events(title) values ($1) returning *')
    expect(p.kind).toBe('write')
    expect(p.text).toBe('insert into events(title) values ($1) returning *')
  })
  test('rejects multiple statements', () => {
    expect(() => prepareStatement('select 1; drop table events')).toThrow(/one statement/)
  })
  test('rejects DDL, DO, SET, COPY', () => {
    for (const s of ['drop table events', 'alter table events add x int', 'do $$ begin end $$', 'set role lovbase', 'copy events to stdout', 'create table x(a int)'])
      expect(() => prepareStatement(s)).toThrow(/only SELECT/)
  })
  test('comments are stripped before classification', () => {
    expect(prepareStatement('-- hi\n/* x */ SELECT 1').kind).toBe('read')
  })
})

describe('ConfigService', () => {
  test('derives the executor connection string from the owner one', () => {
    const cfg = ConfigService.of({ DATABASE_URL: 'postgres://owner:pw@db:5432/lovbase', SQL_ROLE_PASSWORD: 's3cret' })
    const u = new URL(cfg.sqlUrl)
    expect(u.username).toBe('lovbase_sql')
    expect(u.password).toBe('s3cret')
    expect(u.host).toBe('db:5432')
  })
  test('an explicit executor URL wins', () => {
    const cfg = ConfigService.of({ DATABASE_SQL_URL: 'postgres://x:y@other:5432/db' })
    expect(cfg.sqlUrl).toBe('postgres://x:y@other:5432/db')
  })
  test('rejects a malformed number instead of silently defaulting', () => {
    expect(() => ConfigService.of({ PG_POOL_MAX: 'lots' })).toThrow(/Invalid environment variables/)
  })
})
