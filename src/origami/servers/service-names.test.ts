import { expect, it } from 'vitest'

import { serviceIconKey, withoutEmoji } from './service-names'

it('picks a drawn icon by the template group name', () => {
  expect(serviceIconKey('🚫 Заблокированные сервисы')).toBe('blocked')
  expect(serviceIconKey('🌐 Остальные незаблокированные сервисы')).toBe('other')
  expect(serviceIconKey('🎮 Игры')).toBe('games')
  expect(serviceIconKey('🤖 Нейросети (AI)')).toBe('ai')
  expect(serviceIconKey('🧪 Что-то новое')).toBe('unknown')
})

it('drops template marks but keeps country flags', () => {
  expect(withoutEmoji('🔷 🇫🇮 Финляндия')).toBe('🇫🇮 Финляндия')
  expect(withoutEmoji('🎲 Авто-выбор (Лучший пинг)')).toBe(
    'Авто-выбор (Лучший пинг)',
  )
  expect(withoutEmoji('Германия')).toBe('Германия')
})
