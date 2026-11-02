import { sendNotification } from '@tauri-apps/plugin-notification'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useProfiles } from '@/hooks/use-profiles'
import { showNotice } from '@/services/notice-service'

import {
  daysLeft,
  expiryStage,
  reminderKey,
  type ExpiryStage,
} from './subscription-status'

const SENT_KEY = 'origami.expiryReminders'
const CHECK_INTERVAL_MS = 60 * 60 * 1000

const readSent = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const markSent = (key: string) => {
  try {
    // Older periods are irrelevant once renewed, so a short list is enough.
    const next = [...readSent().filter((item) => item !== key), key].slice(-12)
    localStorage.setItem(SENT_KEY, JSON.stringify(next))
  } catch {
    // Without storage the reminder may repeat on the next start.
  }
}

/** Reminds about the end of the subscription: in the app and as a system notification. */
export const useExpiryReminder = () => {
  const { t, i18n } = useTranslation()
  const { current } = useProfiles()
  const uid = current?.uid
  const expire = current?.extra?.expire

  useEffect(() => {
    if (!uid || !expire) return

    const check = () => {
      const now = Date.now()
      const stage = expiryStage(expire, now)
      if (!stage) return
      const key = reminderKey(uid, expire, stage)
      if (readSent().includes(key)) return
      markSent(key)

      const bodyKey: Record<ExpiryStage, string> = {
        soon: 'origami.reminder.soon',
        lastDay: 'origami.reminder.lastDay',
        expired: 'origami.reminder.expired',
      }
      const title = t('origami.reminder.title')
      const count = daysLeft(expire, now)
      const form = new Intl.PluralRules(i18n.language).select(count)
      const days = t(`origami.home.subscription.days.${form}` as never, {
        count,
      }) as string
      const body = t(bodyKey[stage] as never, { days }) as string

      showNotice.info(body, 10000)
      try {
        sendNotification({ title, body })
      } catch {
        // The in-app notice above is enough when system notifications are off.
      }
    }

    check()
    const timer = window.setInterval(check, CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [uid, expire, t, i18n.language])
}
