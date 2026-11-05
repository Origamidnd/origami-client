import { describe, expect, it } from 'vitest'

import {
  daysLeft,
  expiryStage,
  needsRenew,
  reminderKey,
} from './subscription-status'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const inDays = (days: number) => Math.floor(NOW / 1000) + days * 24 * 3600

describe('expiryStage', () => {
  it('stays quiet while more than three days are left', () => {
    expect(expiryStage(inDays(10), NOW)).toBeNull()
    expect(expiryStage(undefined, NOW)).toBeNull()
    expect(expiryStage(0, NOW)).toBeNull()
  })

  it('warns three days ahead, on the last day and after the end', () => {
    expect(expiryStage(inDays(3), NOW)).toBe('soon')
    expect(expiryStage(inDays(2.5), NOW)).toBe('soon')
    expect(expiryStage(inDays(1), NOW)).toBe('lastDay')
    expect(expiryStage(inDays(0.2), NOW)).toBe('lastDay')
    expect(expiryStage(inDays(-1), NOW)).toBe('expired')
  })

  it('counts partial days down like the panel and never below zero', () => {
    expect(daysLeft(inDays(2.9), NOW)).toBe(2)
    expect(daysLeft(inDays(0.5), NOW)).toBe(0)
    expect(daysLeft(inDays(-5), NOW)).toBe(0)
  })

  it('keys reminders by the paid period', () => {
    expect(reminderKey('R1', 100, 'soon')).not.toBe(
      reminderKey('R1', 200, 'soon'),
    )
  })
})

describe('needsRenew', () => {
  const now = NOW
  it('offers renewal only with a week or less left', () => {
    expect(needsRenew(inDays(30), now)).toBe(false)
    expect(needsRenew(inDays(365), now)).toBe(false)
    expect(needsRenew(inDays(7), now)).toBe(true)
    expect(needsRenew(inDays(1), now)).toBe(true)
    expect(needsRenew(inDays(-1), now)).toBe(true)
  })

  it('never offers it for an endless subscription', () => {
    expect(needsRenew(undefined, now)).toBe(false)
    expect(needsRenew(0, now)).toBe(false)
  })
})
