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

  it('says once that the rule lists did not update, with the reason', () => {
    const names = ['youtube', 'google', 'telegram-ips']
    const text = buildDiagnostics({
      ...base,
      coreErrors: [
        '11-27 15:00:01 [TCP] dial failed',
        ...names.map(
          (name) =>
            `11-27 15:11:13 [Provider] ${name} pull error: Get "https://sub.example.com/geo/${name}.list": context deadline exceeded`,
        ),
      ],
    })
    expect(text).toContain('  11-27 15:00:01 [TCP] dial failed')
    expect(text).toContain(
      '  11-27 15:11:13 [Provider] списки правил не обновились (3: youtube, google, telegram-ips): Get sub.example.com: context deadline exceeded',
    )
    expect(text).not.toContain('youtube pull error')
  })

  it('says the service check did not run in one line', () => {
    const text = buildDiagnostics({ ...base, delays: {} })
    expect(text).toContain('Проверка сервисов: не запускалась')
    expect(text).not.toContain('не проверялся')
  })

  it('names a wrong clock, the traffic left and where games go', () => {
    const text = buildDiagnostics({
      ...base,
      clock: 'behind',
      subscription: { daysLeft: 5, traffic: '9.71 МБ из 15.0 МБ' },
      gameGroup: { name: '🎮 Игры', now: 'Швеция' },
    })
    expect(text).toContain('Часы: отстают, VPN может не подключаться')
    expect(text).toContain(
      'Подписка: осталось дней 5, трафик 9.71 МБ из 15.0 МБ',
    )
    expect(text).toContain('🎮 Игры: Швеция')
    expect(buildDiagnostics(base)).not.toContain('Часы')
  })

  it('points out when the game sent packets and none came back', () => {
    const text = buildDiagnostics({
      ...base,
      gameMode: {
        enabled: true,
        hasCode: true,
        running: true,
        stats: 'from game 20, to game 0, local errors 0; direct up=20',
        secondsAgo: 10,
      },
    })
    expect(text).toContain('(0 мин назад), ответов от сервера не было')
  })
})
