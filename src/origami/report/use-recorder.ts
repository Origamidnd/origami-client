import { useEffect, useReducer, useRef, useState } from 'react'

import { useConnectionData } from '@/hooks/use-connection-data'
import { getClashLogs } from '@/services/cmds'

import { EntryCollector, parseLogFailure } from './model'

/** Recording stops by itself after this long, so a forgotten window does not record forever. */
export const MAX_RECORD_MS = 3 * 60 * 1000
// Connections that started just before «Начать» still belong to what people were doing.
const START_SLACK_MS = 2000

const logPayloads = async () => {
  const logs = await getClashLogs().catch(() => [] as ILogItem[])
  return logs.map((log) => log.payload)
}

/** Collects connections and core dial errors between start() and stop(). */
export const useRecorder = () => {
  const [recording, setRecording] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const collectorRef = useRef(new EntryCollector())
  const logsBeforeRef = useRef<Set<string>>(new Set())
  const { response } = useConnectionData({ enabled: recording })

  useEffect(() => {
    if (!recording || startedAt === null) return
    const since = startedAt - START_SLACK_MS
    const { activeConnections, closedConnections } = response.data
    const recent = (item: IConnectionsItem) => Date.parse(item.start) >= since
    for (const item of activeConnections) {
      if (recent(item)) collectorRef.current.addConnection(item, false)
    }
    for (const item of closedConnections) {
      if (recent(item)) collectorRef.current.addConnection(item, true)
    }
    bump()
  }, [recording, startedAt, response])

  const start = async () => {
    collectorRef.current = new EntryCollector()
    logsBeforeRef.current = new Set(await logPayloads())
    setStartedAt(Date.now())
    setRecording(true)
  }

  const stop = async () => {
    setRecording(false)
    for (const payload of await logPayloads()) {
      if (logsBeforeRef.current.has(payload)) continue
      const failure = parseLogFailure(payload)
      if (failure) collectorRef.current.addLogError(failure)
    }
    bump()
    return collectorRef.current.list()
  }

  useEffect(() => {
    if (!recording || startedAt === null) return
    const left = MAX_RECORD_MS - (Date.now() - startedAt)
    const timer = window.setTimeout(() => void stop(), Math.max(0, left))
    return () => window.clearTimeout(timer)
  }, [recording, startedAt])

  return {
    recording,
    startedAt,
    entries: collectorRef.current.list(),
    start,
    stop,
  }
}
