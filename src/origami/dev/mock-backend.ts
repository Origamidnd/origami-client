// Dev-only fake backend for previewing the UI in a plain browser (origami/dev/preview.html).
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

const DAY = 24 * 60 * 60

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

const verge: Record<string, unknown> = {
  language: params.get('lang') ?? 'ru',
  theme_mode: theme,
  enable_system_proxy: params.get('on') === '1',
  enable_tun_mode: false,
  menu_icon: 'monochrome',
  clash_core: 'verge-mihomo',
  verge_mixed_port: 7897,
  proxy_auto_config: false,
  notice_position: 'top-right',
  traffic_graph: true,
}

const sysproxy = {
  enable: params.get('on') === '1',
  server: params.get('on') === '1' ? '127.0.0.1:7897' : '',
  bypass: '',
}

const servers = [
  ['Финляндия', 18],
  ['Литва', 31],
  ['Польша', 39],
  ['Нидерланды', 46],
  ['Эстония', 52],
] as const

interface GroupsFixture {
  nodes: [string, string][]
  groups: { name: string; type: string; hidden: boolean; members: string[] }[]
}

// `?real=1` previews the real group layout from fixtures/subscription-groups.json: names only,
// generated locally from a subscription and kept out of git.
const fixtures = import.meta.glob<{ default: GroupsFixture }>(
  './fixtures/subscription-groups.json',
  { eager: true },
)
const realGroups =
  params.get('real') === '1' ? Object.values(fixtures)[0]?.default : undefined

const GROUP_TYPES: Record<string, string> = {
  select: 'Selector',
  'url-test': 'URLTest',
  fallback: 'Fallback',
  'load-balance': 'LoadBalance',
}

const groupNow: Record<string, string> = {}

const realProxyView = (fixture: GroupsFixture) => {
  const groupNames = new Set(fixture.groups.map((g) => g.name))
  const recordIds = new Map(fixture.nodes.map(([name], i) => [name, `r${i}`]))
  const records = Object.fromEntries(
    fixture.nodes.map(([name, type], i) => [
      `r${i}`,
      {
        ...caps,
        recordId: `r${i}`,
        name,
        type:
          type === 'direct'
            ? 'Direct'
            : type === 'hysteria2'
              ? 'Hysteria2'
              : 'Vless',
        alive: true,
        history: type === 'direct' ? [] : history(20 + ((i * 37) % 140)),
        source: { kind: 'core', proxyName: name },
      },
    ]),
  )
  return {
    schemaVersion: 1,
    orderSource: 'runtime',
    providerState: 'ready',
    global: null,
    direct: 'DIRECT',
    groups: fixture.groups.map((g) => ({
      ...caps,
      name: g.name,
      type: GROUP_TYPES[g.type] ?? 'Selector',
      alive: true,
      hidden: g.hidden,
      now: groupNow[g.name] ?? g.members[0],
      history: [],
      members: g.members.map((name) =>
        groupNames.has(name)
          ? { kind: 'group' as const, name }
          : {
              kind: 'node' as const,
              name,
              recordId: recordIds.get(name) ?? name,
            },
      ),
    })),
    records,
    standalone: [],
    providers: [],
  }
}

const history = (delay: number) => [{ time: new Date().toISOString(), delay }]
const caps = { udp: true, xudp: false, tfo: false, mptcp: false, smux: false }

const proxyView = () => {
  if (realGroups) return realProxyView(realGroups)
  const records = Object.fromEntries(
    servers.map(([name, delay], i) => [
      `n${i}`,
      {
        ...caps,
        recordId: `n${i}`,
        name,
        type: 'Vless',
        alive: true,
        history: history(delay),
        source: { kind: 'core', proxyName: name },
      },
    ]),
  )
  const members = servers.map(([name], i) => ({
    kind: 'node' as const,
    name,
    recordId: `n${i}`,
  }))
  return {
    schemaVersion: 1,
    orderSource: 'runtime',
    providerState: 'ready',
    global: null,
    direct: 'DIRECT',
    groups: [
      {
        ...caps,
        name: 'OrigamiVPN',
        type: 'Selector',
        alive: true,
        now: selected,
        history: [],
        members,
      },
    ],
    records,
    standalone: [],
    providers: [],
  }
}

let selected: string = servers[0][0]

const profiles = {
  current: 'R1',
  items: [
    {
      uid: 'R1',
      type: 'remote',
      name: 'OrigamiVPN',
      url: 'https://sub.origamivpn.pro/example',
      updated: Math.floor(Date.now() / 1000) - 3 * 3600,
      extra: {
        upload: 1.2e9,
        download: 13.1e9,
        total: 0,
        expire:
          Math.floor(Date.now() / 1000 / DAY) * DAY +
          Number(params.get('days') ?? 23) * DAY -
          3600,
      },
      home: 'https://lk.origamivpn.pro',
      announce:
        'Здесь появляются сообщения от OrigamiVPN: плановые работы, новые серверы, важные новости.',
      support: 'https://t.me/Origami_Dragons',
      selected: [{ name: 'OrigamiVPN', now: servers[0][0] }],
    },
  ],
}

// `?service=1` previews a machine with the OrigamiVPN service installed.
const withService = params.get('service') === '1'

const runState = {
  mode: withService ? 'Service' : 'Sidecar',
  service: withService ? 'ready' : 'notInstalled',
  serviceUnavailableReason: null,
  pendingAction: null,
  sidecarAllowed: true,
  isAdmin: false,
  opInFlight: false,
  serviceUsable: withService,
  tunCapable: withService,
  serviceNeedsAttention: false,
}

const handlers: Record<string, (args: any) => unknown> = {
  get_verge_config: () => verge,
  patch_verge_config: ({ payload }) => {
    Object.assign(verge, payload)
    if ('enable_system_proxy' in payload) {
      sysproxy.enable = !!payload.enable_system_proxy
      sysproxy.server = sysproxy.enable ? '127.0.0.1:7897' : ''
    }
    return null
  },
  import_profile: ({ url }) => {
    const status = /status=(\d{3})/.exec(url)?.[1]
    if (status) {
      throw `failed to fetch remote profile with status ${status}`
    }
    return null
  },
  get_profiles: () =>
    params.get('empty') ? { current: null, items: [] } : profiles,
  update_profile: async () => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    profiles.items[0].updated = Math.floor(Date.now() / 1000)
    return null
  },
  get_runtime_state: () => runState,
  get_sys_proxy: () => sysproxy,
  get_auto_proxy: () => ({ enable: false, url: '' }),
  get_clash_info: () => ({
    mixed_port: 7897,
    socks_port: 0,
    port: 0,
    server: '127.0.0.1:9097',
    secret: '',
  }),
  get_runtime_config: () => ({ 'mixed-port': 7897, mode: 'rule' }),
  get_proxy_view: () => proxyView(),
  get_app_uptime: () => 3600 * 1000,
  get_embedded_server_port: () => 33331,
  get_system_hostname: () => 'origami-pc',
  get_network_interfaces: () => [],
  get_pending_failures: () => [],
  get_runtime_logs: () => ({}),
  test_delay: async ({ url }) => {
    await new Promise((resolve) =>
      setTimeout(resolve, 300 + Math.random() * 600),
    )
    // `?fail=1` shows a blocked service in the connection check.
    return params.get('fail') === '1' && url.includes('instagram')
      ? 10000
      : Math.round(80 + Math.random() * 250)
  },
  get_clash_logs: () => [
    'time="2026-11-02T06:40:00Z" level=warning msg="[TCP] dial OrigamiVPN error: i/o timeout"',
  ],
  // `?pm=pacman` previews an Arch install that pacman updates.
  get_package_manager: () => params.get('pm'),
  get_system_info: () => ({
    system_name: 'Windows',
    system_version: '11 (26100)',
  }),
  // Delay check from the Servers tab: about one in eight servers does not answer.
  'plugin:mihomo|delay_proxy_by_name': async ({ proxyName }) => {
    await new Promise((resolve) =>
      setTimeout(resolve, 200 + Math.random() * 500),
    )
    const hash = [...String(proxyName)].reduce(
      (sum, ch) => sum + ch.charCodeAt(0),
      0,
    )
    // alive=1 keeps every server answering, for screenshots.
    return hash % 8 === 0 && params.get('alive') !== '1'
      ? { delay: 0 }
      : { delay: 20 + ((hash * 7) % 160) }
  },
  'plugin:mihomo|select_node_for_group': ({ groupName, node }) => {
    if (groupName === 'OrigamiVPN') selected = node
    groupNow[groupName] = node
    return null
  },
  'plugin:mihomo|get_base_config': () => ({
    mode: 'rule',
    'mixed-port': 7897,
    mixedPort: 7897,
  }),
  'plugin:mihomo|get_version': () => ({ meta: true, version: 'v1.19.0' }),
  'plugin:app|version': () => '0.1.0',
  'plugin:updater|check': () =>
    params.get('update') === '1'
      ? {
          rid: 1,
          currentVersion: '0.1.4',
          version: '0.1.5',
          date: '2026-11-04',
          body: 'Preview',
          rawJson: {},
        }
      : null,
  'plugin:app|name': () => 'OrigamiVPN',
  'plugin:os|platform': () => 'windows',
  'plugin:event|listen': () => Math.floor(Math.random() * 1e6),
  'plugin:event|unlisten': () => null,
  'plugin:window|theme': () => theme,
  'plugin:window|is_decorated': () => params.get('frame') === '1',
  'plugin:window|is_maximized': () => false,
  'plugin:clipboard-manager|write_text': (args) => {
    console.info('[mock] clipboard', JSON.stringify(args))
    return null
  },
  'plugin:notification|notify': ({ options }) => {
    console.info('[mock] system notification', options.title, options.body)
    return null
  },
  'plugin:clipboard-manager|read_text': () =>
    'https://sub.origamivpn.pro/AbCdEf123456',
}

const seen = new Set<string>()

mockWindows('main')
mockIPC((cmd, args) => {
  const handler = handlers[cmd]
  if (handler) return handler(args as any)
  if (!seen.has(cmd)) {
    seen.add(cmd)
    console.debug('[mock] unhandled', cmd, args)
  }
  return null
})
