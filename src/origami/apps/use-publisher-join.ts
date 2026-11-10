import { useEffect, useRef } from 'react'

import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

import {
  joinPublisher,
  type ProgramChoice,
  programScope,
} from '../routes/linked'
import { learnPublishers, publisherOf } from '../routes/publishers'
import { updateRoutes } from '../routes/update-routes'

import { reconnectProgram } from './reconnect'
import { seenPrograms } from './use-program-traffic'

const CHECK_MS = 5 * 1000

/**
 * Mounted once, in the sidebar. A game started after the choice was made joins the programs of its
 * publisher as soon as it opens a connection, so nobody has to list future games anywhere.
 */
export const usePublisherJoin = () => {
  const { verge, patchVerge } = useVerge()
  const routes = verge?.origami_routes ?? []
  const routesRef = useRef(routes)
  routesRef.current = routes
  const patchRef = useRef(patchVerge)
  patchRef.current = patchVerge
  const watching = routes.some((route) => route.publisher)

  useEffect(() => {
    if (!watching) return
    let busy = false
    const check = async () => {
      if (busy) return
      busy = true
      try {
        const programs = seenPrograms()
        await learnPublishers(programs.map((program) => program.path))
        // Cheap first look at what the app shows; the write itself starts from the saved routes.
        if (
          !joinPublisher(routesRef.current, programs, publisherOf).joined.length
        )
          return
        let joined: ReturnType<typeof joinPublisher>['joined'] = []
        const { before, next } = await updateRoutes(
          patchRef.current,
          (saved) => {
            const result = joinPublisher(saved, programs, publisherOf)
            joined = result.joined
            return result.joined.length ? result.routes : null
          },
        )
        if (!next) return
        for (const { name, path, publisher, via } of joined) {
          void reconnectProgram(
            programScope(before, next, name, path),
            via as ProgramChoice,
          )
          showNotice.info('origami.programs.linked.joined', { name, publisher })
        }
      } catch (error) {
        console.warn('[publisher] could not join', error)
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void check(), CHECK_MS)
    return () => clearInterval(timer)
  }, [watching])
}
