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
      },
    })
    expect(linux).toContain('Система: Linux (CachyOS Linux rolling)')
    const windows = buildDiagnostics({
      ...base,
      system: { name: 'Windows', version: '11 (26100)' },
    })
    expect(windows).toContain('Система: Windows 11 (26100)')
  })

  it('shows why the service refused to run', () => {
    const text = buildDiagnostics({
      ...base,
      service: {
        state: 'Unavailable',
        reason: 'core path "C:\\" has an untrusted write ACE',
      },
    })
    expect(text).toContain(
      'Служба: Unavailable, причина: core path "C:\\" has an untrusted write ACE',
    )
    expect(
      buildDiagnostics({ ...base, service: { state: 'Running' } }),
    ).toContain('Служба: Running\n')
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

  it('says nothing about game mode for someone who never set it up', () => {
    expect(buildDiagnostics(base)).not.toContain('Игровой режим')
    expect(
      buildDiagnostics({
        ...base,
        gameMode: { enabled: false, hasCode: false, running: false },
      }),
    ).not.toContain('Игровой режим')
  })

  it('shows whether game mode is on and what it carried', () => {
    const off = buildDiagnostics({
      ...base,
      gameMode: { enabled: false, hasCode: true, running: false },
    })
    expect(off).toContain('Игровой режим: выключен')
    const broken = buildDiagnostics({
      ...base,
      gameMode: { enabled: true, hasCode: true, running: false },
    })
    expect(broken).toContain('Игровой режим: включён, но не работает')
    const idle = buildDiagnostics({
      ...base,
      gameMode: { enabled: true, hasCode: true, running: true },
    })
    expect(idle).toContain('Игровой режим: работает, пакетов от игры не было')
    const busy = buildDiagnostics({
      ...base,
      gameMode: {
        enabled: true,
        hasCode: true,
        running: true,
        stats: 'from game 42, to game 42, local errors 0; direct up=42',
        secondsAgo: 130,
      },
    })
    expect(busy).toContain(
      'Игровой режим: работает, from game 42, to game 42, local errors 0; direct up=42 (2 мин назад)',
    )
  })
})
