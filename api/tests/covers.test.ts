import { describe, expect, test } from 'bun:test'
import { parseKey, thumbKey, thumbPrefix } from '../src/modules/storage/keys'

// A cover is the one key that is not content-addressed — it is replaced in place every time its
// app is published — so it is the one that must stay reachable under a stable name.

describe('cover keys', () => {
  test('scope, kind, project, then the app it pictures', () => {
    expect(thumbKey('p1', 'a1')).toBe('public/thumb/p1/a1.png')
  })

  test('parses back as a public thumb belonging to the project', () => {
    expect(parseKey(thumbKey('p1', 'a1'))).toEqual({ scope: 'public', kind: 'thumb', owner: 'p1' })
  })

  test('the same app always writes the same key, because a cover replaces its predecessor', () => {
    expect(thumbKey('p1', 'a1')).toBe(thumbKey('p1', 'a1'))
  })

  test('a project sweep covers every app of it', () => {
    expect(thumbKey('p1', 'a1')).toStartWith(thumbPrefix('p1'))
    expect(thumbKey('p1', 'a2')).toStartWith(thumbPrefix('p1'))
    expect(thumbKey('p2', 'a1')).not.toStartWith(thumbPrefix('p1'))
  })

  test('still refuses the shapes nothing writes', () => {
    expect(parseKey('private/thumb/p1/a1.png')).toBeNull()
    expect(parseKey('public/thumb/../../x/y')).toBeNull()
    expect(parseKey('public/thumb//a1.png')).toBeNull()
  })
})
