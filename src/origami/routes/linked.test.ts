import { describe, expect, it } from 'vitest'

import {
  familyOf,
  folderPattern,
  isLinkablePublisher,
  joinPublisher,
  programFolder,
  programScope,
  publisherLink,
  routeOf,
  withProgramChoice,
} from './linked'

// As seen on a real install of Battle.net.
const AGENT = 'C:\\ProgramData\\Battle.net\\Agent\\Agent.9852\\Agent.exe'
const HELPER = 'C:\\ProgramData\\Battle.net\\Agent\\AgentHelper.exe'
const OVERLAY =
  'C:\\Program Files (x86)\\Battle.net\\Battle.net.17986\\bdk\\battlenet.overlay.runtime.exe'
const MONITOR =
  'C:\\Program Files (x86)\\Battle.net\\Battle.net.17986\\GameSessionMonitor.exe'
const WOW = 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe'
const GAME = 'D:\\Games\\My Game\\bin\\x64\\game.exe'

describe('familyOf', () => {
  it('knows the Blizzard programs by name, whatever the case', () => {
    for (const name of [
      'Wow.exe',
      'WOW.EXE',
      'WowClassic.exe',
      'Battle.net.exe',
      'Battle.net Launcher.exe',
      'Battle.net-Setup.exe',
      'BlizzardError.exe',
      'BlizzardBrowser.exe',
    ]) {
      expect(familyOf(name)?.id, name).toBe('blizzard')
    }
  })

  it('knows a program with a common name only by its path', () => {
    expect(familyOf('Agent.exe')).toBeUndefined()
    expect(familyOf('Agent.exe', AGENT)?.id).toBe('blizzard')
    expect(familyOf('AgentHelper.exe', HELPER)?.id).toBe('blizzard')
    expect(familyOf('Agent.exe', 'C:\\Other\\Agent.exe')).toBeUndefined()
  })

  it('leaves other programs alone', () => {
    expect(familyOf('WorldOfShips.exe')).toBeUndefined()
    expect(familyOf('launcher.exe')).toBeUndefined()
    expect(familyOf('chrome.exe')).toBeUndefined()
    expect(familyOf('steam.exe')).toBeUndefined()
    // BattlEye serves games of many publishers.
    expect(familyOf('BEService.exe')).toBeUndefined()
  })

  it('knows the launcher and the game of other publishers', () => {
    const programs: [string, string, string][] = [
      ['riot', 'RiotClientServices.exe', 'C:\\Riot Games\\Riot Client'],
      ['riot', 'LeagueClientUx.exe', 'C:\\Riot Games\\League of Legends'],
      [
        'riot',
        'League of Legends.exe',
        'C:\\Riot Games\\League of Legends\\Game',
      ],
      ['riot', 'VALORANT.exe', 'C:\\Riot Games\\VALORANT\\live'],
      ['riot', 'vgc.exe', 'C:\\Program Files\\Riot Vanguard'],
      ['battlestate', 'BsgLauncher.exe', 'C:\\Battlestate Games\\BsgLauncher'],
      ['battlestate', 'EscapeFromTarkov.exe', 'D:\\Battlestate Games\\EFT'],
      ['wargaming', 'lgc.exe', 'C:\\ProgramData\\Lesta\\GameCenter'],
      ['wargaming', 'helper_process.exe', 'C:\\ProgramData\\Lesta\\GameCenter'],
      ['wargaming', 'wgc.exe', 'C:\\ProgramData\\Wargaming.net\\GameCenter'],
      ['wargaming', 'WorldOfTanks.exe', 'C:\\Games\\Tanki'],
      ['hoyoverse', 'HYP.exe', 'C:\\Program Files\\HoYoPlay\\1.9.0.276'],
      ['hoyoverse', 'GenshinImpact.exe', 'D:\\Games\\Genshin Impact Game'],
      ['hoyoverse', 'StarRail.exe', 'D:\\Games\\Star Rail\\Games'],
    ]
    for (const [family, name, folder] of programs) {
      expect(familyOf(name, `${folder}\\${name}`)?.id, name).toBe(family)
    }
  })

  it('has one program standing for each family', () => {
    for (const name of [
      'Battle.net.exe',
      'RiotClientServices.exe',
      'BsgLauncher.exe',
      'lgc.exe',
      'HYP.exe',
    ]) {
      expect(familyOf(name)?.main, name).toBe(name)
    }
  })

  it('moves a launcher together with its game in another folder', () => {
    const game =
      'C:\\Battlestate Games\\Escape from Tarkov\\EscapeFromTarkov.exe'
    const launcher = 'C:\\Battlestate Games\\BsgLauncher\\BsgLauncher.exe'
    const next = withProgramChoice([], 'EscapeFromTarkov.exe', game, 'direct')
    expect(routeOf(next, 'BsgLauncher.exe', launcher)?.via).toBe('direct')
    expect(routeOf(next, 'steam.exe')).toBeUndefined()
  })
})

describe('programFolder', () => {
  it('finds the folder of the program, above the inner ones', () => {
    expect(programFolder(GAME)).toBe('D:\\Games\\My Game')
    expect(programFolder(WOW)).toBe(
      'C:\\Program Files (x86)\\World of Warcraft',
    )
    expect(
      programFolder(
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dota 2\\game\\bin\\win64\\dota2.exe',
      ),
    ).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dota 2')
    expect(
      programFolder(
        'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe',
      ),
    ).toBe('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING')
  })

  it('takes the whole game of an Unreal project', () => {
    expect(
      programFolder(
        'D:\\SteamLibrary\\steamapps\\common\\Satisfactory\\FactoryGame\\Binaries\\Win64\\Game-Win64-Shipping.exe',
      ),
    ).toBe('D:\\SteamLibrary\\steamapps\\common\\Satisfactory')
    expect(
      programFolder(
        'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe',
      ),
    ).toBe('C:\\Riot Games\\VALORANT')
  })

  it('does not climb out of a game into a shared folder', () => {
    expect(
      programFolder(
        'D:\\SteamLibrary\\steamapps\\common\\Solo\\Binaries\\Win64\\solo.exe',
      ),
    ).toBe('D:\\SteamLibrary\\steamapps\\common\\Solo')
    expect(
      programFolder('C:\\Users\\me\\Solo\\Binaries\\Win64\\solo.exe'),
    ).toBe('C:\\Users\\me\\Solo')
    expect(programFolder('D:\\Games\\Solo\\Binaries\\Win64\\solo.exe')).toBe(
      'D:\\Games\\Solo',
    )
    expect(programFolder('D:\\Games\\Game\\solo.exe')).toBeNull()
  })

  it('takes no folder shared with other programs', () => {
    for (const path of [
      'C:\\foo.exe',
      'C:\\Windows\\System32\\svchost.exe',
      'C:\\Program Files\\foo.exe',
      'C:\\Program Files (x86)\\Steam\\steam.exe',
      'C:\\Program Files (x86)\\Steam\\bin\\steamservice.exe',
      'C:\\Users\\me\\foo.exe',
      'C:\\Users\\me\\Downloads\\setup.exe',
      'C:\\Users\\me\\Desktop\\foo.exe',
      'C:\\Users\\me\\AppData\\Local\\foo.exe',
      'D:\\Games\\foo.exe',
    ]) {
      expect(programFolder(path), path).toBeNull()
    }
  })

  it('takes no folder outside Windows or one a rule cannot hold', () => {
    expect(programFolder('/usr/bin/firefox')).toBeNull()
    expect(programFolder('D:\\a,b\\game.exe')).toBeNull()
    expect(programFolder(undefined)).toBeNull()
  })
})

describe('folderPattern', () => {
  it('reads as in the rule the core gets', () => {
    expect(folderPattern('D:\\Games\\My Game (x64)')).toBe(
      '(?i)^D:\\\\Games\\\\My Game \\(x64\\)\\\\.*',
    )
  })
})

describe('withProgramChoice', () => {
  it('sets one route for the whole family, whichever program was picked', () => {
    const next = withProgramChoice([], 'Agent.exe', AGENT, 'direct')
    expect(next).toEqual([
      { kind: 'app', value: 'Battle.net.exe', via: 'direct', folder: null },
    ])
    expect(routeOf(next, 'Wow.exe')?.via).toBe('direct')
    expect(routeOf(next, 'Agent.exe', AGENT)?.via).toBe('direct')
    expect(routeOf(next, 'BlizzardError.exe')?.via).toBe('direct')
    expect(routeOf(next, 'chrome.exe')).toBeUndefined()
  })

  it('takes over a rule set on one program of the family before', () => {
    const old = [{ kind: 'app', value: 'Wow.exe', via: 'direct' }]
    expect(routeOf(old, 'Battle.net.exe')?.via).toBe('direct')
    const next = withProgramChoice(old, 'Battle.net.exe', null, 'vpn')
    expect(next.map((route) => [route.value, route.via])).toEqual([
      ['Battle.net.exe', 'vpn'],
    ])
    expect(withProgramChoice(next, 'Wow.exe', WOW, 'auto')).toEqual([])
  })

  it('remembers the folder of a game outside the usual places', () => {
    const custom = 'D:\\Games\\WoW\\_retail_\\Wow.exe'
    expect(withProgramChoice([], 'Wow.exe', custom, 'direct')[0].folder).toBe(
      'D:\\Games\\WoW',
    )
  })

  it('moves the programs of a folder together, and back', () => {
    const next = withProgramChoice([], 'game.exe', GAME, 'direct')
    expect(next[0].folder).toBe('D:\\Games\\My Game')
    const helper = 'D:\\Games\\My Game\\tools\\CrashSender.exe'
    expect(routeOf(next, 'CrashSender.exe', helper)?.via).toBe('direct')
    expect(
      routeOf(next, 'MyGame.exe', 'D:\\Games\\My Game 2\\MyGame.exe'),
    ).toBe(undefined)
    expect(withProgramChoice(next, 'CrashSender.exe', helper, 'auto')).toEqual(
      [],
    )
  })

  it('keeps the whole folder when the choice is made on a program in a subfolder', () => {
    const helper = 'D:\\Games\\My Game\\tools\\CrashSender.exe'
    const first = withProgramChoice([], 'game.exe', GAME, 'direct')
    const next = withProgramChoice(first, 'CrashSender.exe', helper, 'vpn')
    expect(next).toEqual([
      {
        kind: 'app',
        value: 'CrashSender.exe',
        via: 'vpn',
        folder: 'D:\\Games\\My Game',
      },
    ])
    expect(routeOf(next, 'game.exe', GAME)?.via).toBe('vpn')
    expect(routeOf(next, 'CrashSender.exe', helper)?.via).toBe('vpn')
  })

  it('takes in a subfolder set earlier when its parent gets a choice', () => {
    const helper = 'D:\\Games\\My Game\\tools\\CrashSender.exe'
    const first = withProgramChoice([], 'CrashSender.exe', helper, 'vpn')
    expect(first[0].folder).toBe('D:\\Games\\My Game\\tools')
    const next = withProgramChoice(first, 'game.exe', GAME, 'direct')
    expect(next.map((route) => [route.value, route.folder])).toEqual([
      ['game.exe', 'D:\\Games\\My Game'],
    ])
    expect(routeOf(next, 'CrashSender.exe', helper)?.via).toBe('direct')
    expect(withProgramChoice(next, 'game.exe', GAME, 'auto')).toEqual([])
  })

  it('does not take a neighbour with a similar name for a subfolder', () => {
    const other = withProgramChoice(
      [],
      'other.exe',
      'D:\\Games\\My Game 2\\other.exe',
      'vpn',
    )
    const next = withProgramChoice(other, 'game.exe', GAME, 'direct')
    expect(next.map((route) => route.value)).toEqual(['other.exe', 'game.exe'])
  })

  it('keeps the routes of others', () => {
    const site = { kind: 'site', value: 'example.com', via: 'vpn' }
    const app = { kind: 'app', value: 'other.exe', via: 'vpn' }
    expect(withProgramChoice([site, app], 'Wow.exe', WOW, 'auto')).toEqual([
      site,
      app,
    ])
  })

  it('does not mistake a site for a program', () => {
    const site = { kind: 'site', value: 'wow.exe', via: 'vpn' }
    expect(routeOf([site], 'Wow.exe')).toBeUndefined()
  })
})

describe('programScope', () => {
  it('covers the whole family and what its rules read', () => {
    const next = withProgramChoice([], 'Wow.exe', WOW, 'direct')
    const scope = programScope([], next, 'Wow.exe', WOW)
    expect(scope.key).toBe('blizzard')
    expect(scope.has('Agent.exe', AGENT)).toBe(true)
    expect(scope.has('battlenet.overlay.runtime.exe', OVERLAY)).toBe(true)
    expect(scope.has('GameSessionMonitor.exe', MONITOR)).toBe(true)
    expect(scope.has('Agent.exe', 'C:\\Other\\Agent.exe')).toBe(false)
    expect(scope.has('chrome.exe')).toBe(false)
    expect(scope.has(undefined)).toBe(false)
    expect(scope.payloads.has('Wow.exe')).toBe(true)
    expect([...scope.payloads].some((item) => item.includes('battle'))).toBe(
      true,
    )
  })

  it('reaches a subfolder taken in, also when the choice is taken back', () => {
    const helper = 'D:\\Games\\My Game\\tools\\CrashSender.exe'
    const before = withProgramChoice([], 'CrashSender.exe', helper, 'vpn')
    const after = withProgramChoice(before, 'game.exe', GAME, 'auto')
    expect(after).toEqual([])
    const scope = programScope(before, after, 'game.exe', GAME)
    expect(scope.has('CrashSender.exe', helper)).toBe(true)
    const kept = { kind: 'app', value: 'other.exe', via: 'vpn' }
    expect(
      programScope([kept], [kept], 'game.exe', GAME).has('other.exe'),
    ).toBe(false)
  })

  it('still knows the old rules when the choice is taken back', () => {
    const before = withProgramChoice([], 'game.exe', GAME, 'direct')
    const scope = programScope(before, [], 'game.exe', GAME)
    expect(scope.has('CrashSender.exe', 'D:\\Games\\My Game\\a.exe')).toBe(true)
    expect(scope.payloads.has(folderPattern('D:\\Games\\My Game'))).toBe(true)
  })
})

describe('publisher links', () => {
  const STUDIO = 'Some Studio'
  const LAUNCHER = 'C:\\Some Launcher\\launcher.exe'
  const TOOL = 'E:\\Studio Tools\\tool.exe'
  const signed: Record<string, string> = {
    [GAME]: STUDIO,
    [LAUNCHER]: STUDIO,
    [TOOL]: STUDIO,
    'C:\\Other\\other.exe': 'Other Studio',
    'C:\\Steam\\steam.exe': 'Valve Corp.',
    [WOW]: 'Blizzard Entertainment',
  }
  const publisher = (path?: string | null) => (path && signed[path]) || null
  const programs = [
    { name: 'game.exe', path: GAME },
    { name: 'launcher.exe', path: LAUNCHER },
    { name: 'other.exe', path: 'C:\\Other\\other.exe' },
    { name: 'unsigned.exe', path: 'C:\\Other\\unsigned.exe' },
    { name: 'Wow.exe', path: WOW },
  ]
  const choose = () => {
    const link = publisherLink(programs, 'game.exe', GAME, publisher)
    return withProgramChoice([], 'game.exe', GAME, 'direct', link)
  }

  it('does not link by the publisher of a platform or a shared tool', () => {
    for (const name of [
      'Microsoft Corporation',
      'Valve Corp.',
      'Epic Games, Inc.',
      'BattlEye Innovations e.K.',
      'Google LLC',
      'NVIDIA Corporation',
    ]) {
      expect(isLinkablePublisher(name), name).toBe(false)
    }
    expect(isLinkablePublisher('Some Studio')).toBe(true)
    expect(isLinkablePublisher(null)).toBe(false)
    expect(
      publisherLink(programs, 'steam.exe', 'C:\\Steam\\steam.exe', publisher),
    ).toBeUndefined()
  })

  it('leaves a known family to its own rules', () => {
    expect(publisherLink(programs, 'Wow.exe', WOW, publisher)).toBeUndefined()
  })

  it('takes the programs of the publisher with their folders', () => {
    expect(choose()).toEqual([
      {
        kind: 'app',
        value: 'game.exe',
        via: 'direct',
        folder: 'D:\\Games\\My Game',
        publisher: STUDIO,
        also_names: [],
        also_folders: ['C:\\Some Launcher'],
      },
    ])
    const next = choose()
    expect(routeOf(next, 'launcher.exe', LAUNCHER)?.via).toBe('direct')
    expect(
      routeOf(next, 'helper.exe', 'C:\\Some Launcher\\helper.exe')?.via,
    ).toBe('direct')
    expect(routeOf(next, 'other.exe', 'C:\\Other\\other.exe')).toBeUndefined()
    expect(routeOf(next, 'unsigned.exe', 'C:\\Other\\unsigned.exe')).toBe(
      undefined,
    )
  })

  it('moves all of them when another member is picked, and back', () => {
    const first = choose()
    const next = withProgramChoice(first, 'launcher.exe', LAUNCHER, 'vpn')
    expect(next).toHaveLength(1)
    expect(next[0].value).toBe('launcher.exe')
    expect(next[0].publisher).toBe(STUDIO)
    expect(next[0].also_names).toEqual([])
    expect(next[0].also_folders).toEqual(['D:\\Games\\My Game'])
    expect(routeOf(next, 'game.exe', GAME)?.via).toBe('vpn')
    expect(withProgramChoice(first, 'launcher.exe', LAUNCHER, 'auto')).toEqual(
      [],
    )
  })

  it('brings in a program of the publisher seen later, once', () => {
    const first = choose()
    const seen = [...programs, { name: 'tool.exe', path: TOOL }]
    const { routes, joined } = joinPublisher(first, seen, publisher)
    expect(joined.map((item) => item.name)).toEqual(['tool.exe'])
    expect(routes[0].also_names).toEqual([])
    expect(routes[0].also_folders).toContain('E:\\Studio Tools')
    expect(routeOf(routes, 'tool.exe', TOOL)?.via).toBe('direct')
    expect(joinPublisher(routes, seen, publisher).joined).toEqual([])
  })

  it('takes a program by name only when it has no folder of its own', () => {
    const bare = 'D:\\Games\\bare.exe'
    signed[bare] = STUDIO
    const seen = [{ name: 'bare.exe', path: bare }]
    const { routes } = joinPublisher(choose(), seen, publisher)
    expect(routes[0].also_names).toEqual(['bare.exe'])
    // A program of another publisher with the same common name stays out.
    expect(
      routeOf(choose(), 'launcher.exe', 'C:\\Other\\launcher.exe'),
    ).toBeUndefined()
  })

  it('leaves alone a program that already has a choice of its own', () => {
    const first = [...choose(), { kind: 'app', value: 'tool.exe', via: 'vpn' }]
    const seen = [{ name: 'tool.exe', path: TOOL }]
    expect(joinPublisher(first, seen, publisher).joined).toEqual([])
  })

  it('reads as the rules do when the change is undone', () => {
    const before = choose()
    const scope = programScope(before, [], 'game.exe', GAME)
    expect(scope.has('launcher.exe', LAUNCHER)).toBe(true)
    expect(scope.payloads.has(folderPattern('C:\\Some Launcher'))).toBe(true)
  })
})
