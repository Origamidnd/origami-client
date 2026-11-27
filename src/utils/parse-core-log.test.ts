import { describe, expect, it } from 'vitest'

import { parseCoreLogLine } from './parse-core-log'

describe('parseCoreLogLine', () => {
  it('keeps the whole message when it quotes something', () => {
    const line =
      'time="2026-11-27T15:11:13.123+03:00" level=error msg="[Provider] youtube pull error: Get \\"https://example.com/geo/youtube.list\\": context deadline exceeded"'
    expect(parseCoreLogLine(line)).toMatchObject({
      type: 'error',
      payload:
        '[Provider] youtube pull error: Get "https://example.com/geo/youtube.list": context deadline exceeded',
    })
  })

  it('reads plain messages as before', () => {
    expect(
      parseCoreLogLine(
        'time="2026-11-27T15:11:13+03:00" level=warning msg="[TCP] dial failed"',
      ),
    ).toMatchObject({ type: 'warning', payload: '[TCP] dial failed' })
    expect(parseCoreLogLine('15:11:13 info started')).toEqual({
      time: '15:11:13',
      type: 'info',
      payload: 'started',
    })
  })
})
