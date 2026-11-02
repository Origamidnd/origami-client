import { describe, expect, it } from 'vitest'

import { buildDiagnostics } from './diagnostics'

describe('buildDiagnostics', () => {
  const base = {
    time: '02.11.2026 06:40',
    appVersion: '0.1.0',
    mode: 'tun' as const,
    connected: true,
    delays: { telegram: 230, youtube: 10000 },
    coreErrors: [],
  }

  it('summarises the connection and each checked service', () => {
    const text = buildDiagnostics({
      ...base,
      server: 'Финляндия',
      exit: { country: 'Финляндия', asn: 'AS24940 Hetzner' },
    })
    expect(text).toContain('весь компьютер (TUN), подключено: да')
    expect(text).toContain('Telegram: открывается, 230 мс')
    expect(text).toContain('YouTube: не открывается')
    expect(text).toContain('Instagram: не проверялся')
    expect(text).toContain('Ошибок ядра нет')
  })

  it('does not repeat the distribution name', () => {
    const linux = buildDiagnostics({
      ...base,
      system: {
        name: 'CachyOS Linux',
        version: 'Linux (CachyOS Linux rolling)',
        arch: 'x86_64',
      },
    })
    expect(linux).toContain('Система: Linux (CachyOS Linux rolling) (x86_64)')
    const windows = buildDiagnostics({
      ...base,
      system: { name: 'Windows', version: '11 (26100)', arch: 'x86_64' },
    })
    expect(windows).toContain('Система: Windows 11 (26100) (x86_64)')
  })

  it('keeps only the latest core errors', () => {
    const errors = Array.from({ length: 30 }, (_, i) => `error ${i}`)
    const text = buildDiagnostics({ ...base, coreErrors: errors })
    expect(text).not.toContain('error 9\n')
    expect(text).toContain('error 29')
    expect(
      text.split('\n').filter((line) => line.startsWith('  error')),
    ).toHaveLength(20)
  })
})
