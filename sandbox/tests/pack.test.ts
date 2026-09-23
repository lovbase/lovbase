import { describe, expect, test } from 'bun:test'
import { END, pack, unpack, safeRel, unpackBytes } from '../src/pack'

describe('pack / unpack', () => {
  test('round-trips a tree byte for byte, sorted', () => {
    // The Chinese and the curly quotes are deliberate: the stream has to carry non-ASCII text untouched.
    const files = [
      { path: 'src/App.tsx', content: 'export default () => <div>你好, 世界 — “quotes” \\n</div>\n' },
      { path: 'src/index.css', content: '' },
      { path: 'package.json', content: '{\n  "name": "x"\n}\n' },
      { path: 'src/lib/emoji.ts', content: 'const s = "🚀🧪"\r\nexport { s }' },
    ]
    const back = unpack(pack(files))
    expect(back).toEqual(files.toSorted((a, b) => a.path.localeCompare(b.path)))
  })

  test('a stream without its end marker is an error, not a shorter project', () => {
    const text = pack([{ path: 'a.ts', content: 'x' }, { path: 'b.ts', content: 'y' }])
    const cut = text.slice(0, text.lastIndexOf(END))
    expect(() => unpack(cut)).toThrow()
  })

  test('tolerates the trailing text a shell leaves after the marker', () => {
    const text = pack([{ path: 'a.ts', content: 'x' }]) + '\n\n'
    expect(unpack(text)).toEqual([{ path: 'a.ts', content: 'x' }])
  })

  test('drops paths that escape the tree', () => {
    const back = unpack(pack([
      { path: '../etc/passwd', content: 'no' },
      { path: '/abs.ts', content: 'stripped to relative' },
      { path: 'ok.ts', content: 'yes' },
    ]))
    expect(back.map((f) => f.path)).toEqual(['abs.ts', 'ok.ts'])
  })

  test('unpackBytes keeps a binary file intact where unpack would decode it as text', () => {
    const bytes = Uint8Array.from([0, 255, 128, 10, 13, 0xf0, 0x9f])
    const b64 = btoa(String.fromCharCode(...bytes))
    const stream = `assets/font.woff2\n${b64}\n${END}\n`
    expect(Array.from(unpackBytes(stream)[0].bytes)).toEqual(Array.from(bytes))
    expect(unpackBytes(stream)[0].path).toBe('assets/font.woff2')
    expect(() => unpackBytes('assets/font.woff2\nAAAA\n')).toThrow()
  })

  test('safeRel', () => {
    expect(safeRel('a/b.ts')).toBe('a/b.ts')
    expect(safeRel('/a/b.ts')).toBe('a/b.ts')
    expect(safeRel('a/../b')).toBeNull()
    expect(safeRel('a\nb')).toBeNull()
    expect(safeRel('')).toBeNull()
  })
})
