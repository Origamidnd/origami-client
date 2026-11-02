export interface CheckTarget {
  id: string
  name: string
  url: string
}

// Services people most often open the VPN for; checked through the core with the current rules.
export const CHECK_TARGETS: CheckTarget[] = [
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org' },
  {
    id: 'youtube',
    name: 'YouTube',
    url: 'https://www.youtube.com/generate_204',
  },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
]

/** The backend reports 10000 ms when a request failed or timed out. */
export const FAILED_DELAY = 10000

export const isReachable = (delay: number | undefined) =>
  delay !== undefined && delay > 0 && delay < FAILED_DELAY
