import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { templateDefinition } from '../src/modules/templates/registry'

test('INKWAVE copies preserve binary assets and omit source-project configuration', () => {
  const template = templateDefinition('inkwave')
  expect(template.ir.entities).toEqual([])
  expect(template.files.some((file) => /(^|\/)\.env/.test(file.path))).toBe(false)
  expect(template.files.find((file) => file.path === 'index.html')!.content)
    .not.toContain('https://inkwave.lovbase.app')
  expect(template.files.find((file) => file.path === 'public/game/LICENSE')!.content)
    .toContain('Copyright (c) 2026 caoxing')
  for (const path of [
    'public/game/assets/fonts/Rubik-latin.woff2',
    'public/game/assets/lightmaps/tidewater.png',
    'public/downloads/inkwave-local.zip',
  ]) {
    const file = template.files.find((file) => file.path === path)!
    expect(file.encoding).toBe('base64')
    expect(Buffer.from(file.content, 'base64'))
      .toEqual(readFileSync(new URL(`../../templates/inkwave/${path}`, import.meta.url)))
    expect(readFileSync(new URL(`../../app/public/templates/inkwave/${path.slice(7)}`, import.meta.url)))
      .toEqual(Buffer.from(file.content, 'base64'))
  }
  expect(template.files.find((file) => file.path === 'src/pages/GamePage.tsx')!.content)
    .toContain("entry.searchParams.set('lang', defaultLocale)")
  expect(template.files.find((file) => file.path === 'public/game/src/net/lobby.js')!.content)
    .not.toContain('<select')
  expect(template.files.find((file) => file.path === 'public/game/vendor/lovbase-ui.js')!.content.length)
    .toBeGreaterThan(1000)
})
