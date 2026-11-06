import {
  delayProxyByName,
  getProxies,
  selectNodeForGroup,
  unfixedProxy,
} from 'tauri-plugin-mihomo-api'

const TEST_TIMEOUT_MS = 5000
// A frozen core may never answer, and the next change waits for this one.
const READ_DEADLINE_MS = 3000
const HOLD_DEADLINE_MS = TEST_TIMEOUT_MS + 3000

interface AutoPick {
  group: string
  server: string
  testUrl: string
}

export const autoGroups = async () => {
  const { proxies } = await getProxies()
  return Object.values(proxies).filter(
    (proxy) => proxy.type === 'URLTest' && proxy.testUrl,
  )
}

/** What the auto groups use now. A server someone pinned comes back by itself after a reload. */
const readPicks = async (): Promise<AutoPick[]> =>
  (await autoGroups()).flatMap((group) =>
    group.now && !group.fixed
      ? [
          {
            group: group.name,
            server: group.now,
            testUrl: group.testUrl as string,
          },
        ]
      : [],
  )

const beforeDeadline = async <T>(work: Promise<T>, ms: number, late: T) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

let holding: Promise<unknown> = Promise.resolve()

/** Resolves when no group is held any more, so that nothing tests or reads them halfway. */
export const autoGroupsSettled = () => holding

const release = async (picks: AutoPick[]) => {
  // One server measured is enough to stay on it: the first test of the whole group then moves away
  // only for a server faster by the group's tolerance, as it would without a reload. A test of the
  // group would drop the pin and so go back to the first server on the list.
  await Promise.allSettled(
    picks.map(({ server, testUrl }) =>
      delayProxyByName(server, testUrl, TEST_TIMEOUT_MS),
    ),
  )
  await Promise.allSettled(picks.map(({ group }) => unfixedProxy(group)))
}

/**
 * Runs a change that reloads the core, keeping the auto groups on their servers. After a reload a
 * group knows nothing and would take another one, so a running game could open its next connection
 * from another IP and be thrown out. Returns as soon as the groups are back on their servers.
 */
export const keepAutoServers = async <T>(change: () => Promise<T>) => {
  // One change after another: the next one must not take a held group for one someone pinned.
  await holding
  let settle = () => {}
  holding = new Promise<void>((resolve) => {
    settle = resolve
  })
  try {
    const picks = await beforeDeadline(
      readPicks().catch(() => []),
      READ_DEADLINE_MS,
      [],
    )
    const result = await change()
    if (picks.length === 0) {
      settle()
      return result
    }
    await Promise.allSettled(
      picks.map(({ group, server }) => selectNodeForGroup(group, server)),
    )
    // A pin takes effect when the group is next read.
    await getProxies().catch(() => null)
    void beforeDeadline(release(picks), HOLD_DEADLINE_MS, undefined).finally(
      settle,
    )
    return result
  } catch (error) {
    settle()
    throw error
  }
}
