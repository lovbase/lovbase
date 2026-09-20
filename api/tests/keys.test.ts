import { describe, expect, test } from 'bun:test'
import { avatarKey, chatAttachmentKey, chatPrefixes, parseKey } from '../src/modules/storage/keys'

// parseKey is the only thing standing between a crafted URL and someone else's object, so the
// rejections below matter more than the acceptances.

describe('key layout', () => {
  test('scope, then business, then owner', () => {
    expect(chatAttachmentKey('p1', 'x', 'a.PNG')).toBe('private/chat/p1/x.png')
    expect(avatarKey('u1', 'x', 'me.jpeg')).toBe('public/avatar/u1/x.jpeg')
  })

  test('a project sweep covers both the current and the legacy prefix', () => {
    expect(chatPrefixes('p1')).toEqual(['private/chat/p1/', 'projects/p1/'])
  })
})

describe('parseKey', () => {
  test('reads back what the builders wrote', () => {
    expect(parseKey('private/chat/p1/x.png')).toEqual({ scope: 'private', kind: 'chat', owner: 'p1' })
    expect(parseKey('public/avatar/u1/x.png')).toEqual({ scope: 'public', kind: 'avatar', owner: 'u1' })
  })

  test('still reads the shape attachments used to be written under', () => {
    expect(parseKey('projects/p1/x.png')).toEqual({ scope: 'private', kind: 'chat', owner: 'p1' })
  })

  test('refuses to climb out of a prefix, which is how one owner would reach another', () => {
    expect(parseKey('private/chat/p1/../../public/avatar/u/x')).toBeNull()
    expect(parseKey('private/chat/../x/y')).toBeNull()
    expect(parseKey('public/avatar/u1//x')).toBeNull()
  })

  test('refuses combinations nothing writes, so a new prefix cannot be invented from outside', () => {
    expect(parseKey('public/chat/p1/x')).toBeNull()
    expect(parseKey('private/avatar/u1/x')).toBeNull()
    expect(parseKey('secret/chat/p1/x')).toBeNull()
    expect(parseKey('private/chat//x')).toBeNull()
  })

  test('refuses anything too short to name an owner', () => {
    for (const k of ['', 'private', 'private/chat', 'private/chat/p1', 'projects', 'projects/p1'])
      expect(parseKey(k)).toBeNull()
  })
})
