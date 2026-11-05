import { useLockFn } from 'ahooks'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

import { useConnection } from '../home/use-connection'
import { Seg } from '../routes/own-routes'
import { OWN_GROUP, upsertRoute } from '../routes/routes'
import { parseServerName } from '../servers/model'
import { withoutEmoji } from '../servers/service-names'
import type { FocusGroupState } from '../use-focus-group'

import {
  keepOrder,
  type ProgramStat,
  programWay,
  sortPrograms,
} from './program-traffic'
import { type ProgramChoice, reconnectProgram } from './reconnect'
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

  const choiceOf = (name: string): ProgramChoice => {
    const route = routes.find(
      (item) =>
        item.kind === 'app' && item.value?.toLowerCase() === name.toLowerCase(),
    )
    return (route?.via as ProgramChoice | undefined) ?? 'auto'
  }

  const setChoice = useLockFn(async (name: string, choice: ProgramChoice) => {
    const next =
      choice === 'auto'
        ? routes.filter(
            (item) =>
              !(
                item.kind === 'app' &&
                item.value?.toLowerCase() === name.toLowerCase()
              ),
          )
        : upsertRoute(routes, { kind: 'app', value: name, via: choice })
    try {
      await patchVerge({ origami_routes: next })
      void reconnectProgram(name, choice)
      showNotice.success(`origami.programs.set.${choice}`, { name })
    } catch (error) {
      showNotice.error(error)
    }
  })

  // Programs with an own rule stay listed even with no traffic, so the rule can be undone here.
  const rows = new Map(programs)
  for (const route of routes) {
    if (route.kind !== 'app' || !route.value) continue
    const known = [...rows.keys()].some(
      (name) => name.toLowerCase() === route.value?.toLowerCase(),
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
              heldOrderRef.current = list.map((stat) => stat.name)
            }}
            onMouseLeave={() => {
              heldOrderRef.current = null
            }}
          >
            {list.map((stat) => (
              <li key={stat.name || 'unknown'}>
                <span className="o-apps__name">
                  <b title={stat.name}>
                    {stat.name || t('origami.programs.unknown')}
                  </b>
                  <span className="o-hint">{describe(stat)}</span>
                </span>
                <span className="o-apps__bytes o-mono">
                  {formatBytes(stat.direct + stat.vpn)}
                </span>
                {stat.name ? (
                  <Seg
                    label={t('origami.routes.via')}
                    value={choiceOf(stat.name)}
                    onChange={(choice) => void setChoice(stat.name, choice)}
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
            ))}
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
