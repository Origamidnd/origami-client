import { check } from '@tauri-apps/plugin-updater'
import { expect, it, vi } from 'vitest'

import { checkUpdateSafe } from './update'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('@root/package.json', () => ({ version: '0.1.13' }))

it('limits each update address so a hanging GitHub leaves time for the mirror', async () => {
  vi.mocked(check).mockResolvedValue(null)

  await checkUpdateSafe()

  const timeout = vi.mocked(check).mock.calls[0]?.[0]?.timeout
  expect(timeout).toBeGreaterThan(0)
  expect(timeout).toBeLessThanOrEqual(12_000)
})
