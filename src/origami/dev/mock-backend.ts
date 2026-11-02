// Dev-only fake backend for previewing the UI in a plain browser (origami/dev/preview.html).
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

const DAY = 24 * 60 * 60

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

const verge: Record<string, unknown> = {
  language: params.get('lang') ?? 'ru',
  theme_mode: theme,
  enable_system_proxy: false,
  enable_tun_mode: false,
  menu_icon: 'monochrome',
  clash_core: 'verge-mihomo',
  verge_mixed_port: 7897,
  proxy_auto_config: false,
  notice_position: 'top-right',
  traffic_graph: true,
}

const sysproxy = { enable: false, server: '', bypass: '' }

const servers = [
  ['Финляндия', 18],
  ['Литва', 31],
  ['Польша', 39],
  ['Нидерланды', 46],
  ['Эстония', 52],
] as const

const history = (delay: number) => [{ time: new Date().toISOString(), delay }]
const caps = { udp: true, xudp: false, tfo: false, mptcp: false, smux: false }

const proxyView = () => {
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
        'Плановые работы на сервере Нидерланды 5 ноября с 03:00 до 04:00 МСК. Остальные серверы работают как обычно.',
      support: 'https://t.me/Origami_Dragons',
      selected: [{ name: 'OrigamiVPN', now: servers[0][0] }],
    },
  ],
}

const runState = {
  mode: 'Sidecar',
  service: 'notInstalled',
  serviceUnavailableReason: null,
  pendingAction: null,
  sidecarAllowed: true,
  isAdmin: false,
  opInFlight: false,
  serviceUsable: false,
  tunCapable: false,
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
  'plugin:mihomo|select_node_for_group': ({ groupName, node }) => {
    if (groupName === 'OrigamiVPN') selected = node
    return null
  },
  'plugin:mihomo|get_base_config': () => ({
    mode: 'rule',
    'mixed-port': 7897,
    mixedPort: 7897,
  }),
  'plugin:mihomo|get_version': () => ({ meta: true, version: 'v1.19.0' }),
  'plugin:app|version': () => '0.1.0',
  'plugin:app|name': () => 'OrigamiVPN',
  'plugin:os|platform': () => 'windows',
  'plugin:event|listen': () => Math.floor(Math.random() * 1e6),
  'plugin:event|unlisten': () => null,
  'plugin:window|theme': () => theme,
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
