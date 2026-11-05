import { closeConnection, getConnections } from 'tauri-plugin-mihomo-api'

import { OWN_GROUP } from '../routes/routes'

export type ProgramChoice = 'auto' | 'direct' | 'vpn'

const PASS_MS = 800
// The core may still be taking the new rules in, and a request to it can get lost meanwhile: a game
// sends a packet every few milliseconds and reopens its flow by the old rule at once. So this keeps
// looking until the program's connections go the new way, for a few seconds at most.
const MAX_PASSES = 8
const CLEAN_PASSES = 2

interface Candidate {
  rule?: string
  chains?: string[]
}

/** Whether an open connection already goes the way the program was set to. */
export const followsChoice = (connection: Candidate, choice: ProgramChoice) => {
  const chains = connection.chains ?? []
  const viaOwn = chains.includes(OWN_GROUP)
  const ownDirect = chains[0] === 'DIRECT' && connection.rule === 'ProcessName'
  if (choice === 'vpn') return viaOwn
  if (choice === 'direct') return ownDirect
  return !viaOwn && !ownDirect
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The latest change per program; an older one still looking must not fight it.
const latest = new Map<string, symbol>()

/** Closes what a program has open the old way, so the new way applies now, not on its next start. */
export const reconnectProgram = async (name: string, choice: ProgramChoice) => {
  const key = name.toLowerCase()
  const token = Symbol(key)
  latest.set(key, token)

  let clean = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (pass > 0) await sleep(PASS_MS)
    if (latest.get(key) !== token) return

    const stale = await getConnections()
      .then(({ connections }) =>
        (connections ?? []).filter(
          (item) =>
            item.metadata.process?.toLowerCase() === key &&
            !followsChoice(item, choice),
        ),
      )
      .catch(() => null)
    if (stale?.length === 0) {
      if (++clean >= CLEAN_PASSES) break
      continue
    }
    clean = 0
    await Promise.allSettled(
      (stale ?? []).map((item) => closeConnection(item.id)),
    )
  }
  if (latest.get(key) === token) latest.delete(key)
}
