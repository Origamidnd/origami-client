import type { IOrigamiRoute } from '@/services/bindings'

import rawFamilies from './families.json'
import genericNames from './generic-names.json'

export type ProgramChoice = 'auto' | 'direct' | 'vpn'

export interface Family {
  id: string
  title: string
  /** Stands for the family in a route when the program's own name says nothing (`Agent.exe`). */
  main: string
  names: string
  paths: string
  nameTest: RegExp
  pathTest: RegExp
}

// One login, one way: a launcher and its games with different IPs get captchas. The core reads the
// same file (src-tauri enhance/origami_routes.rs), so the patterns must suit both and hold no commas.
const FAMILIES: Family[] = rawFamilies.map((family) => ({
  ...family,
  nameTest: new RegExp(family.names, 'i'),
  pathTest: new RegExp(family.paths, 'i'),
}))

export const familyOf = (name: string, path?: string | null) =>
  FAMILIES.find(
    (family) =>
      family.nameTest.test(name) || (!!path && family.pathTest.test(path)),
  )

const sameName = (a: string | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase()

// File names many unrelated programs use: `Launcher.exe` of one game says nothing about another. The
// core reads the same file (src-tauri enhance/origami_routes.rs).
const GENERIC_NAMES = new Set(genericNames)

export const isGenericName = (name: string) =>
  GENERIC_NAMES.has(name.toLowerCase())

/** One row per program: two different files named `Launcher.exe` are two programs. */
export const programKey = ({
  name,
  path,
}: {
  name: string
  path?: string | null
}) =>
  isGenericName(name) && path
    ? `${name.toLowerCase()}|${(programFolder(path) ?? path).toLowerCase()}`
    : name

// Folders inside a program that say nothing about it: the program is the folder above them.
const INNER_FOLDER =
  /^(bin|bin32|bin64|binaries|win32|win64|x64|x86|amd64|shipping|app|application|client|game|live|_retail_|_classic_|_classic_era_|_ptr_|_beta_|app-[\d.]+|[\d.]+)$/i
// Folders shared with other programs: Steam holds every game installed through it.
const SHARED_FOLDER =
  /^(program files|program files \(x86\)|programdata|users|public|desktop|downloads|documents|appdata|local|locallow|roaming|temp|games|steam|steamapps|common|epic games|gog games|gog galaxy|riot games|windowsapps)$/i

const leaveInnerFolders = (parts: string[]) => {
  while (parts.length > 2 && INNER_FOLDER.test(parts.at(-1) ?? '')) parts.pop()
}

const isSharedFolder = (parts: string[]) =>
  parts.length < 2 ||
  SHARED_FOLDER.test(parts.at(-1) ?? '') ||
  // A home folder itself: C:\Users\name.
  (parts.length === 3 && parts[1].toLowerCase() === 'users')

/**
 * The folder that holds a program and its helpers, or null when that folder is shared with others.
 * Windows paths only.
 */
export const programFolder = (path?: string | null) => {
  if (!path || !/^[a-z]:\\/i.test(path) || path.includes(',')) return null
  const parts = path.split('\\').slice(0, -1)
  if (parts[1]?.toLowerCase() === 'windows') return null
  const unreal = /^binaries$/i.test(parts.at(-2) ?? '')
  leaveInnerFolders(parts)
  // An Unreal game: <game>\<project>\Binaries\Win64, with its launcher in <game>.
  if (unreal && parts.length > 2 && !isSharedFolder(parts.slice(0, -1))) {
    parts.pop()
    leaveInnerFolders(parts)
  }
  // A folder per version in the middle (EA Desktop\13.822.0.6335\EA Desktop): the next update moves
  // the program, so the folder above it is the one that stays.
  const version = parts
    .map((part, index) => (index > 1 && /^\d+(\.\d+)+$/.test(part) ? index : 0))
    .reduce((last, index) => Math.max(last, index), 0)
  if (version > 0) {
    const above = parts.slice(0, version)
    leaveInnerFolders(above)
    if (!isSharedFolder(above)) return above.join('\\')
  }
  return isSharedFolder(parts) ? null : parts.join('\\')
}

export const folderName = (folder: string) => folder.split('\\').pop() ?? folder

const isUnder = (folder: string | null | undefined, path?: string | null) =>
  !!folder &&
  !!path &&
  path.toLowerCase().startsWith(`${folder.toLowerCase()}\\`)

/** A route with a folder decides a program of a common name by that folder alone. */
const routeNamesProgram = (
  route: IOrigamiRoute,
  name: string,
  path?: string | null,
) =>
  route.kind === 'app' &&
  sameName(route.value, name) &&
  !(isGenericName(name) && route.folder && path)

/** Whether a program's way is decided by this route. */
export const routeCovers = (
  route: IOrigamiRoute,
  name: string,
  path?: string | null,
) => {
  if (route.kind !== 'app' || !route.value) return false
  if (routeNamesProgram(route, name, path)) return true
  if (route.also_names?.some((other) => sameName(other, name))) return true
  const family = familyOf(name, path)
  return (
    (!!family && familyOf(route.value) === family) ||
    isUnder(route.folder, path) ||
    !!route.also_folders?.some((folder) => isUnder(folder, path))
  )
}

/** The route of a program itself goes before one that only covers it. */
export const routeOf = (
  routes: IOrigamiRoute[],
  name: string,
  path?: string | null,
) =>
  routes.find((route) => routeNamesProgram(route, name, path)) ??
  routes.find((route) => routeCovers(route, name, path))

/** A folder set earlier on the program above this one stays whole: one folder, one way. */
const folderOfChoice = (
  routes: IOrigamiRoute[],
  name: string,
  path: string | null | undefined,
) => {
  const family = familyOf(name, path)
  if (path && family?.pathTest.test(path)) return null
  const held = routes
    .filter((route) => isUnder(route.folder, path))
    .map((route) => route.folder as string)
    .sort((a, b) => a.length - b.length)
  return held[0] ?? programFolder(path)
}

// Publishers of platforms and of tools that serve many games: their signature says nothing about
// which program belongs to which. Valve signs Steam, a game from Steam is signed by its own studio.
const GENERIC_PUBLISHER =
  /microsoft|valve|epic games|google|nvidia|advanced micro devices|\bamd\b|intel|apple|mozilla|discord|battleye|easy ?anti ?cheat|kamu|overwolf|unity technologies|realtek|logitech|razer|corsair|steelseries|asus|micro-star|oracle|adobe|cloudflare|yandex|opera |brave software|vivaldi|telegram|zoom|spotify|gog /i

export const isLinkablePublisher = (publisher?: string | null) =>
  !!publisher && !GENERIC_PUBLISHER.test(publisher)

export interface LinkedProgram {
  name: string
  path?: string | null
}

export interface PublisherLink {
  publisher: string
  peers: LinkedProgram[]
}

type ReadPublisher = (path?: string | null) => string | null

/** The other programs seen with the same signature; none for a known family, which has its own rules. */
export const publisherLink = (
  programs: LinkedProgram[],
  name: string,
  path: string | null | undefined,
  publisherOf: ReadPublisher,
): PublisherLink | undefined => {
  if (familyOf(name, path)) return undefined
  const publisher = publisherOf(path)
  if (!publisher || !isLinkablePublisher(publisher)) return undefined
  return {
    publisher,
    peers: programs.filter(
      (program) =>
        !sameName(program.name, name) &&
        !familyOf(program.name, program.path) &&
        publisherOf(program.path) === publisher,
    ),
  }
}

const unique = (items: string[]) => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Sets the way of a program with everything linked to it, replacing what decided it before. */
export const withProgramChoice = (
  routes: IOrigamiRoute[],
  name: string,
  path: string | null | undefined,
  choice: ProgramChoice,
  link?: PublisherLink,
): IOrigamiRoute[] => {
  const folder = folderOfChoice(routes, name, path)
  const replaced = routes.filter(
    (route) =>
      routeCovers(route, name, path) ||
      (!!link && route.publisher === link.publisher),
  )
  const rest = routes.filter(
    (route) =>
      !replaced.includes(route) &&
      !(route.folder && isUnder(folder, `${route.folder}\\`)),
  )
  if (choice === 'auto') return rest
  const family = familyOf(name, path)
  const route: IOrigamiRoute = {
    kind: 'app',
    value: family && !family.nameTest.test(name) ? family.main : name,
    via: choice,
    folder,
  }
  // Members of the old route stay members, also the ones that are not running at the moment.
  const held = replaced.filter((item) => item.publisher)
  const publisher = link?.publisher ?? held[0]?.publisher
  if (publisher) {
    route.publisher = publisher
    // By folder where there is one: a name such as `Launcher.exe` would also catch other programs.
    route.also_names = unique(
      [
        ...held.flatMap((item) => [
          item.folder ? '' : (item.value ?? ''),
          ...(item.also_names ?? []),
        ]),
        ...(link?.peers ?? []).map((peer) =>
          programFolder(peer.path) ? '' : peer.name,
        ),
      ].filter((other) => other && !sameName(other, name)),
    )
    route.also_folders = unique(
      [
        ...held.flatMap((item) => [
          item.folder ?? '',
          ...(item.also_folders ?? []),
        ]),
        ...(link?.peers ?? []).map((peer) => programFolder(peer.path) ?? ''),
      ].filter(
        (other) =>
          other &&
          other.toLowerCase() !== folder?.toLowerCase() &&
          !isUnder(folder, `${other}\\`),
      ),
    )
  }
  return [...rest, route]
}

/** A program seen for the first time joins the route of its publisher. */
export const joinPublisher = (
  routes: IOrigamiRoute[],
  programs: LinkedProgram[],
  publisherOf: ReadPublisher,
) => {
  let next = routes
  const joined: (LinkedProgram & { publisher: string; via: string })[] = []
  for (const program of programs) {
    const publisher = publisherOf(program.path)
    if (!publisher || familyOf(program.name, program.path)) continue
    if (routeOf(next, program.name, program.path)) continue
    const route = next.find((item) => item.publisher === publisher)
    if (!route) continue
    const folder = programFolder(program.path)
    const updated: IOrigamiRoute = {
      ...route,
      also_names: unique([
        ...(route.also_names ?? []),
        ...(folder ? [] : [program.name]),
      ]),
      also_folders: unique([
        ...(route.also_folders ?? []),
        ...(folder ? [folder] : []),
      ]),
    }
    next = next.map((item) => (item === route ? updated : item))
    joined.push({ ...program, publisher, via: route.via ?? 'auto' })
  }
  return { routes: next, joined }
}

const escapeRegex = (text: string) =>
  text.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&')

const ownPayloads = (route: IOrigamiRoute) => {
  const family = familyOf(route.value ?? '')
  return [
    route.value ?? '',
    ...(family ? [`(?i)${family.names}`, `(?i)${family.paths}`] : []),
    ...(route.also_names ?? []),
    ...[route.folder ?? '', ...(route.also_folders ?? [])]
      .filter(Boolean)
      .map(folderPattern),
  ]
}

/** As in the rule the core gets, where a connection reports it back (`rulePayload`). */
export const folderPattern = (folder: string) =>
  `(?i)^${escapeRegex(folder)}\\\\.*`

export interface ProgramScope {
  key: string
  has: (name?: string, path?: string) => boolean
  /** What the rules of these routes read in a connection. */
  payloads: Set<string>
}

/** The programs one change touches: those of the routes it replaces and those of the new one. */
export const programScope = (
  before: IOrigamiRoute[],
  after: IOrigamiRoute[],
  name: string,
  path?: string | null,
): ProgramScope => {
  const touched = [
    ...before.filter((route) => !after.includes(route)),
    ...after.filter((route) => !before.includes(route)),
  ]
  return {
    key: familyOf(name, path)?.id ?? name.toLowerCase(),
    has: (process, processPath) =>
      !!process &&
      ((sameName(process, name) &&
        programKey({ name: process, path: processPath }) ===
          programKey({ name, path })) ||
        touched.some((route) => routeCovers(route, process, processPath))),
    payloads: new Set(touched.flatMap(ownPayloads)),
  }
}
