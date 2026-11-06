import { origamiOpenSupportChat } from '@/services/cmds'
import { openExternalUrl } from '@/utils/open-external-url'

/** The support chat, in the Telegram app when there is one and otherwise in the browser. */
export const openSupportChat = async (url: string) => {
  try {
    await origamiOpenSupportChat(url)
  } catch {
    await openExternalUrl(url)
  }
}
