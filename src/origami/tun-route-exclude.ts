/**
 * OrigamiVPN: the TUN dialog shows the running config, where the excluded addresses usually come
 * from the subscription. Saving them back would make the app own that list and hide later changes
 * to it on the panel, so the list is saved only when it was edited in the dialog.
 */
export const routeExcludeForSave = (
  loaded: string[],
  current: string[],
): { 'route-exclude-address'?: string[] } =>
  loaded.join(',') === current.join(',')
    ? {}
    : { 'route-exclude-address': current }
