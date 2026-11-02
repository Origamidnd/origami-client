import { patchVergeConfig } from '@/services/cmds'

/** The tray menu is built in Rust, so it gets copies of the choices the UI keeps in its storage. */
export const syncToTray = (
  patch: Pick<IVergeConfig, 'origami_expert_mode' | 'origami_connect_mode'>,
) => {
  patchVergeConfig(patch).catch(() => {
    // The tray keeps its previous menu; the next change or start tries again.
  })
}
