import {
  AddRounded,
  CloseRounded,
  FolderOpenRounded,
} from '@mui/icons-material'
import { Button, IconButton } from '@mui/material'
import { open } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseStyledTextField } from '@/components/base'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useVerge } from '@/hooks/use-verge'
import type { IOrigamiRoute } from '@/services/bindings'
import { showNotice } from '@/services/notice-service'

import { useConnection } from '../home/use-connection'
import { keepAutoServers } from '../servers/auto-hold'

import { familyOf, folderName, withProgramChoice } from './linked'
import {
  cleanValue,
  recentProcesses,
  type RouteKind,
  type RouteVia,
  upsertRoute,
} from './routes'

const isWindows = navigator.userAgent.includes('Windows')

export const Seg = <T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: [T, string][]
  onChange: (value: T) => void
  label: string
}) => (
  <div className="o-seg o-routes__seg" role="radiogroup" aria-label={label}>
    {options.map(([id, text]) => (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={value === id}
        className={value === id ? 'is-on' : undefined}
        onClick={() => onChange(id)}
      >
        {text}
      </button>
    ))}
  </div>
)

/**
 * The user's own routes, on top of the subscription's rules: a program or a site sent direct or
 * through the VPN until the route is removed. The core puts them first (enhance/origami_routes.rs).
 */
export const OwnRoutes = () => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const { mode } = useConnection()
  const routes = verge?.origami_routes ?? []
  const [kind, setKind] = useState<RouteKind>('app')
  const [via, setVia] = useState<RouteVia>('direct')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  // The whole path of a file picked from disk, which shows what else belongs to the program.
  const [pickedPath, setPickedPath] = useState<string | null>(null)

  const {
    response: { data: connections },
  } = useConnectionData({ enabled: kind === 'app' })
  const recent =
    kind === 'app'
      ? recentProcesses(
          [...connections.activeConnections, ...connections.closedConnections],
          routes,
        )
      : []

  const save = async (next: IOrigamiRoute[]) => {
    setSaving(true)
    try {
      await keepAutoServers(() => patchVerge({ origami_routes: next }))
      return true
    } catch (error) {
      showNotice.error(error)
      return false
    } finally {
      setSaving(false)
    }
  }

  const add = async (raw = value) => {
    const clean = cleanValue(kind, raw)
    if (!clean) {
      showNotice.error(
        kind === 'app' ? 'origami.routes.badApp' : 'origami.routes.badSite',
      )
      return
    }
    const next =
      kind === 'app'
        ? withProgramChoice(
            routes,
            clean,
            pickedPath && cleanValue('app', pickedPath) === clean
              ? pickedPath
              : null,
            via,
          )
        : upsertRoute(routes, { kind, value: clean, via })
    if (await save(next)) {
      setValue('')
      setPickedPath(null)
      showNotice.success('origami.routes.added', { name: clean })
    }
  }

  const pickFile = async () => {
    const file = await open({
      directory: false,
      multiple: false,
      filters: isWindows
        ? [{ name: t('origami.routes.programs'), extensions: ['exe'] }]
        : undefined,
    })
    if (typeof file === 'string') {
      setValue(cleanValue('app', file) ?? '')
      setPickedPath(file)
    }
  }

  const hasApps = routes.some((route) => route.kind === 'app')

  const kindOf = (route: IOrigamiRoute) => {
    if (route.kind !== 'app') return t('origami.routes.site')
    const what =
      familyOf(route.value ?? '')?.title ??
      (route.folder ? folderName(route.folder) : null)
    return what
      ? t('origami.routes.appLinked', { what })
      : t('origami.routes.app')
  }

  return (
    <div className="o-routes">
      <div className="o-routes__form">
        <Seg
          label={t('origami.routes.kind')}
          value={kind}
          onChange={setKind}
          options={[
            ['app', t('origami.routes.app')],
            ['site', t('origami.routes.site')],
          ]}
        />
        <div className="o-routes__input">
          <BaseStyledTextField
            value={value}
            variant="outlined"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (value.trim() && !saving) void add()
            }}
            placeholder={
              kind === 'app'
                ? t('origami.routes.appPlaceholder')
                : t('origami.routes.sitePlaceholder')
            }
            slotProps={{
              input: {
                sx: { pr: 0.5 },
                endAdornment:
                  kind === 'app' ? (
                    <IconButton
                      size="small"
                      title={t('origami.routes.pickFile')}
                      onClick={() => void pickFile()}
                    >
                      <FolderOpenRounded fontSize="small" />
                    </IconButton>
                  ) : null,
              },
            }}
          />
        </div>
        <Seg
          label={t('origami.routes.via')}
          value={via}
          onChange={setVia}
          options={[
            ['direct', t('origami.routes.direct')],
            ['vpn', t('origami.routes.vpn')],
          ]}
        />
        <Button
          variant="contained"
          size="small"
          startIcon={<AddRounded fontSize="small" />}
          disabled={!value.trim() || saving}
          onClick={() => void add()}
        >
          {t('origami.routes.add')}
        </Button>
      </div>

      {recent.length > 0 && (
        <div className="o-routes__recent">
          <span className="o-hint">{t('origami.routes.recent')}</span>
          {recent.map((name) => (
            <button
              key={name}
              type="button"
              className="o-srv__chip"
              onClick={() => setValue(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {routes.length === 0 ? (
        <p className="o-hint o-routes__empty">{t('origami.routes.empty')}</p>
      ) : (
        <ul className="o-routes__list">
          {routes.map((route) => (
            <li key={`${route.kind}:${route.value}`}>
              <span className="o-routes__name">
                <b title={route.value}>{route.value}</b>
                <span className="o-hint">{kindOf(route)}</span>
              </span>
              <Seg
                label={t('origami.routes.via')}
                value={route.via as RouteVia}
                onChange={(next) =>
                  void save(upsertRoute(routes, { ...route, via: next }))
                }
                options={[
                  ['direct', t('origami.routes.direct')],
                  ['vpn', t('origami.routes.vpn')],
                ]}
              />
              <IconButton
                size="small"
                title={t('origami.routes.remove')}
                disabled={saving}
                onClick={() =>
                  void save(routes.filter((item) => item !== route))
                }
              >
                <CloseRounded fontSize="small" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {hasApps && mode === 'proxy' && (
        <p className="o-routes__warn">{t('origami.routes.proxyMode')}</p>
      )}
    </div>
  )
}
