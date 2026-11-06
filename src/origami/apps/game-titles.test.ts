import { beforeEach, expect, it, vi } from 'vitest'

import { origamiGameTitles } from '@/services/cmds'

import { gameTitleOf, gameTitlesVersion, learnGameTitles } from './game-titles'

vi.mock('@/services/cmds', () => ({ origamiGameTitles: vi.fn() }))

beforeEach(() => {
  vi.mocked(origamiGameTitles).mockReset()
})

it('asks again while the list is not there, then remembers the answers', async () => {
  const path = 'C:\\Games\\Dota 2\\dota2.exe'
  const other = 'C:\\Apps\\notes.exe'
  vi.mocked(origamiGameTitles).mockResolvedValue({})
  await learnGameTitles([path, other, undefined])
  expect(gameTitleOf(path)).toBeNull()

  vi.mocked(origamiGameTitles).mockResolvedValue({ [path]: 'Dota 2' })
  const before = gameTitlesVersion()
  await learnGameTitles([path, other])
  expect(origamiGameTitles).toHaveBeenLastCalledWith([path, other])
  expect(gameTitleOf(path)).toBe('Dota 2')
  expect(gameTitleOf(path.toUpperCase())).toBe('Dota 2')
  expect(gameTitleOf(other)).toBeNull()
  expect(gameTitlesVersion()).toBe(before + 1)

  vi.mocked(origamiGameTitles).mockClear()
  await learnGameTitles([path, other])
  expect(origamiGameTitles).not.toHaveBeenCalled()
})

it('takes a failure for no answer', async () => {
  vi.mocked(origamiGameTitles).mockRejectedValue(new Error('no'))
  await learnGameTitles(['C:\\failed.exe'])
  expect(gameTitleOf('C:\\failed.exe')).toBeNull()
})
