import { closeConnection, getConnections } from 'tauri-plugin-mihomo-api'

import type { ProgramChoice, ProgramScope } from '../routes/linked'
import { OWN_GROUP } from '../routes/routes'

const PASS_MS = 800
// The core may still be taking the new rules in, and a request to it can get lost meanwhile: a game
// sends a packet every few milliseconds and reopens its flow by the old rule at once. So this keeps
// looking until the program's connections go the new way, for a few seconds at most.
const MAX_PASSES = 8
const CLEAN_PASSES = 2

interface Candidate {
  rulePayload?: string
  chains?: string[]
}

/** Whether an open connection already goes the way the program was set to. */
export const followsChoice = (
  connection: Candidate,
  choice: ProgramChoice,
  payloads: Set<string>,
) => {
  const chains = connection.chains ?? []
  const viaOwn = chains.includes(OWN_GROUP)
  const ownDirect =
    chains[0] === 'DIRECT' && payloads.has(connection.rulePayload ?? '')
  if (choice === 'vpn') return viaOwn
  if (choice === 'direct') return ownDirect
  return !viaOwn && !ownDirect
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The latest change per program or family; an older one still looking must not fight it.
const latest = new Map<string, symbol>()

/** Closes what the programs have open the old way, so the new way applies now, not on their next start. */
export const reconnectProgram = async (
  scope: ProgramScope,
  choice: ProgramChoice,
) => {
  const token = Symbol(scope.key)
  latest.set(scope.key, token)

  let clean = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (pass > 0) await sleep(PASS_MS)
    if (latest.get(scope.key) !== token) return

    const stale = await getConnections()
      .then(({ connections }) =>
        (connections ?? []).filter(
          (item) =>
            scope.has(item.metadata.process, item.metadata.processPath) &&
            !followsChoice(item, choice, scope.payloads),
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
  if (latest.get(scope.key) === token) latest.delete(scope.key)
}
