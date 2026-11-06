import { useLockFn } from 'ahooks'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

import { useConnection } from '../home/use-connection'
import {
  familyOf,
  folderName,
  isGenericName,
  isLinkablePublisher,
  type ProgramChoice,
  programFolder,
  programKey,
  programScope,
  publisherLink,
  routeOf,
  withProgramChoice,
} from '../routes/linked'
import { Seg } from '../routes/own-routes'
import {
  learnPublishers,
  publisherOf,
  publishersVersion,
  subscribePublishers,
} from '../routes/publishers'
import { OWN_GROUP } from '../routes/routes'
import { keepAutoServers } from '../servers/auto-hold'
import { parseServerName } from '../servers/model'
import { withoutEmoji } from '../servers/service-names'
import type { FocusGroupState } from '../use-focus-group'

import {
  gameTitleOf,
  gameTitlesVersion,
  learnGameTitles,
  subscribeGameTitles,
} from './game-titles'
import {
  keepOrder,
  type ProgramStat,
  programWay,
  sortPrograms,
} from './program-traffic'
import { reconnectProgram } from './reconnect'
import { useProgramTraffic } from './use-program-traffic'

const formatBytes = (value: number) => parseTraffic(value).join(' ')

const MAX_ROWS = 50

/** Which programs use the internet, how they go and how much; each can be sent another way. */
export const OrigamiPrograms = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { verge, patchVerge } = useVerge()
  const { connected, mode } = useConnection()
  const { programs } = useProgramTraffic()
  const routes = verge?.origami_routes ?? []
  useSyncExternalStore(subscribePublishers, publishersVersion)
  const seen = [...programs.values()]
  const pathsKey = seen.map((stat) => stat.path ?? '').join('|')
  useSyncExternalStore(subscribeGameTitles, gameTitlesVersion)
  useEffect(() => {
    const paths = pathsKey.split('|')
    void learnPublishers(paths)
    void learnGameTitles(paths)
  }, [pathsKey])

  /** The publisher that links this program with others, if any. */
  const publisherHint = (stat: ProgramStat) => {
    const route = routeOf(routes, stat.name, stat.path)
    const publisher = route?.publisher ?? publisherOf(stat.path)
    return isLinkablePublisher(publisher) ? publisher : null
  }

  const choiceOf = (stat: ProgramStat) =>
    (routeOf(routes, stat.name, stat.path)?.via as ProgramChoice | undefined) ??
    'auto'

  /** What else changes with this program, once it has a choice or belongs to a family. */
  const linkedHint = (stat: ProgramStat) => {
    const family = familyOf(stat.name, stat.path)
    if (family) {
      return t('origami.programs.linked.family', { family: family.title })
    }
    const publisher = publisherHint(stat)
    if (publisher) {
      return t('origami.programs.linked.family', { family: publisher })
    }
    const folder = routeOf(routes, stat.name, stat.path)?.folder
    return folder
      ? t('origami.programs.linked.folder', { folder: folderName(folder) })
      : null
  }

  const setChoice = useLockFn(
    async (stat: ProgramStat, choice: ProgramChoice) => {
      const { name, path } = stat
      const link = publisherLink(seen, name, path, publisherOf)
      const next = withProgramChoice(routes, name, path, choice, link)
      const family = familyOf(name, path)
      const folder = routeOf(next, name, path)?.folder
      const publisher = publisherHint(stat)
      const label = family
        ? t('origami.programs.linked.allOf', { family: family.title })
        : publisher
          ? t('origami.programs.linked.allOf', { family: publisher })
          : folder
            ? t('origami.programs.linked.withFolder', { name })
            : name
      try {
        await keepAutoServers(() => patchVerge({ origami_routes: next }))
        void reconnectProgram(programScope(routes, next, name, path), choice)
        showNotice.success(`origami.programs.set.${choice}`, { name: label })
      } catch (error) {
        showNotice.error(error)
      }
    },
  )

  // Programs with an own rule stay listed even with no traffic, so the rule can be undone here.
  const rows = new Map(programs)
  for (const route of routes) {
    if (route.kind !== 'app' || !route.value) continue
    const known = [...rows.values()].some(
      ({ name }) => name.toLowerCase() === route.value?.toLowerCase(),
    )
    if (!known) {
      rows.set(route.value, {
        name: route.value,
        direct: 0,
        vpn: 0,
        activeDirect: 0,
        activeVpn: 0,
      })
    }
  }
  const sorted = sortPrograms(rows.values()).slice(0, MAX_ROWS)
  // The busiest go first, but a row must not jump away from under the cursor: that sent a click to
  // another program. The order is held while the pointer is over the list.
  const heldOrderRef = useRef<string[] | null>(null)
  const list = heldOrderRef.current
    ? keepOrder(sorted, heldOrderRef.current)
    : sorted

  const describe = (stat: ProgramStat) => {
    const way = programWay(stat)
    if (way === 'vpn' && stat.server) {
      const server = withoutEmoji(parseServerName(stat.server).base)
      return t('origami.programs.way.vpnVia', { server })
    }
    return t(`origami.programs.way.${way}`)
  }

  const openOwnRules = () => {
    const state: FocusGroupState = { origamiFocusGroup: OWN_GROUP }
    navigate('/proxies', { state })
  }

  return (
    <BasePage title={t('origami.programs.title')}>
      <div className="o-apps">
        <p className="o-srv__lead">
          <b>{t('origami.programs.lead')}</b>
          <br />
          {t('origami.programs.period')}
        </p>

        {mode === 'proxy' && connected && (
          <p className="o-routes__warn">{t('origami.routes.proxyMode')}</p>
        )}

        {list.length === 0 ? (
          <section className="o-plate">
            <p className="o-hint">
              {connected
                ? t('origami.programs.empty')
                : t('origami.programs.off')}
            </p>
          </section>
        ) : (
          <ul
            className="o-plate o-apps__list"
            onMouseEnter={() => {
              heldOrderRef.current = list.map(programKey)
            }}
            onMouseLeave={() => {
              heldOrderRef.current = null
            }}
          >
            {list.map((stat) => {
              const linked = stat.name ? linkedHint(stat) : null
              const folder = programFolder(stat.path)
              // Two programs may share a common file name: the folder tells them apart.
              const game =
                gameTitleOf(stat.path) ??
                (isGenericName(stat.name) && folder ? folderName(folder) : null)
              return (
                <li key={programKey(stat) || 'unknown'}>
                  <span className="o-apps__name">
                    <b title={stat.name}>
                      {stat.name || t('origami.programs.unknown')}
                    </b>
                    {game && <span className="o-hint">{game}</span>}
                    <span className="o-hint">{describe(stat)}</span>
                    {linked && <span className="o-hint">{linked}</span>}
                  </span>
                  <span className="o-apps__bytes o-mono">
                    {formatBytes(stat.direct + stat.vpn)}
                  </span>
                  {stat.name ? (
                    <Seg
                      label={t('origami.routes.via')}
                      value={choiceOf(stat)}
                      onChange={(choice) => void setChoice(stat, choice)}
                      options={[
                        ['auto', t('origami.programs.auto')],
                        ['direct', t('origami.routes.direct')],
                        ['vpn', t('origami.routes.vpn')],
                      ]}
                    />
                  ) : (
                    <span className="o-hint o-apps__nochoice">
                      {t('origami.programs.unknownHint')}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <p className="o-srv__foot">
          {t('origami.programs.foot')}{' '}
          <button type="button" className="o-srv__link" onClick={openOwnRules}>
            {t('origami.programs.footLink')}
          </button>
        </p>
      </div>
    </BasePage>
  )
}

export default OrigamiPrograms
