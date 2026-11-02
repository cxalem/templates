/**
 * Template catalog for the MCP server.
 *
 * Enumerates templates from root package.json `repokit.groups`, the same source of truth used by
 * scripts/generate.ts, and classifies each one with the heuristics of the templates health check.
 * Every function reads the file system on each call and holds no cache.
 *
 * Discovery never follows symlinks: group directories, template directories and package.json files are
 * checked with lstat, so a link cannot pull a directory from outside the checkout into the catalog. A
 * manifest that is unreadable, not valid JSON or not a JSON object is reported in `skipped` with the reason
 * instead of failing the whole catalog, and every field read from it is coerced to the expected shape.
 * README and .env.example bodies are read up to MAX_METADATA_BYTES only.
 */

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Dirent, type Stats } from 'fs'
import { isAbsolute, join } from 'path'
import { err, ok, type Result } from '../shared/result.js'
import type { GroupConfig } from '../shared/types.js'
import type { HealthKind } from './health-types.js'

export type TemplateKind = HealthKind

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

export type CreateSolanaDappConfig = {
  readonly instructions?: readonly string[]
  readonly rename?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export type CatalogTemplate = {
  /** group-relative id, e.g. "kit/nextjs" */
  readonly id: string
  /** repokit group path, e.g. "kit" */
  readonly group: string
  /** absolute path to the template directory */
  readonly dir: string
  readonly name: string
  readonly displayName?: string
  readonly description: string
  readonly usecase?: string
  readonly keywords: readonly string[]
  readonly kind: TemplateKind
  readonly scripts: Readonly<Record<string, string>>
  readonly dependencies: readonly string[]
  readonly devDependencies: readonly string[]
  readonly packageManager: PackageManager
  readonly createSolanaDapp: CreateSolanaDappConfig | null
  /** template-relative README path, or null when the template has none */
  readonly readmePath: string | null
  readonly readmeHeadings: readonly string[]
  readonly hasOgImage: boolean
  readonly needsSecrets: boolean
  /** env variable names in .env.example that look like real credentials */
  readonly credentialKeys: readonly string[]
}

/** A directory under a group that has a package.json the catalog could not describe. */
export type SkippedTemplate = {
  readonly id: string
  readonly reason: string
}

export type Catalog = {
  readonly repositoryName: string
  readonly groups: readonly GroupConfig[]
  readonly templates: readonly CatalogTemplate[]
  readonly skipped: readonly SkippedTemplate[]
}

export type TemplatePackage = {
  readonly name?: string
  readonly displayName?: string
  readonly description?: string
  readonly usecase?: string
  readonly keywords?: readonly string[]
  readonly scripts?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly packageManager?: string
  readonly 'create-solana-dapp'?: CreateSolanaDappConfig
}

/** Most bytes read from a package.json, README or .env.example while building the catalog. */
export const MAX_METADATA_BYTES = 200_000
export const MAX_README_HEADINGS = 100
export const MAX_HEADING_LENGTH = 200
export const MAX_ENV_KEYS = 100
export const MAX_ENV_KEY_LENGTH = 100

const DEFAULT_REPOSITORY_NAME = 'solana-foundation/templates'
const OG_IMAGE_FILENAME = 'og-image.png'
const README_CANDIDATES = ['README.md', 'readme.md', 'Readme.md']

/** Env variable names that mean "you need a real credential to run this" (same rules as the health check). */
const CREDENTIAL_KEY_PATTERN = /(API_?KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|SUPABASE|PRIVY)/i
const NON_CREDENTIAL_KEY_PATTERN = /(MINT|PROGRAM|ADDRESS|RPC|URL|PUBKEY|PUBLIC_KEY|APP_ID|CLIENT_ID|PROJECT_ID)/i

export function loadCatalog(rootDir: string): Result<Catalog> {
  const rootPackage = readJson(join(rootDir, 'package.json'))
  if (!rootPackage.ok) return err(`Failed to read root package.json: ${rootPackage.error}`)
  if (!isRecord(rootPackage.value)) return err('Root package.json is not a JSON object')

  const groups = normalizeGroups(rootPackage.value.repokit)
  if (groups.length === 0) return err('No valid repokit.groups configuration found in package.json')

  const repository = rootPackage.value.repository
  const repositoryName = (isRecord(repository) && optionalString(repository.name)?.trim()) || DEFAULT_REPOSITORY_NAME
  const templates: CatalogTemplate[] = []
  const skipped: SkippedTemplate[] = []

  for (const group of groups) {
    const groupDir = join(rootDir, group.path)
    // lstat, not stat: a group path that is a symlink is ignored rather than followed.
    if (!lstatOrNull(groupDir)?.isDirectory()) continue
    for (const entry of readDirectoryEntries(groupDir)) {
      // Dirent reports a symlink as a symlink, never as a directory, so linked template directories are skipped.
      if (!entry.isDirectory()) continue
      const id = `${group.path}/${entry.name}`
      const dir = join(groupDir, entry.name)
      const manifestPath = join(dir, 'package.json')
      const manifest = lstatOrNull(manifestPath)
      if (!manifest) continue
      if (!manifest.isFile()) {
        skipped.push({ id, reason: 'package.json is not a regular file (symlinks are never followed)' })
        continue
      }
      if (manifest.size > MAX_METADATA_BYTES) {
        skipped.push({ id, reason: `package.json is ${manifest.size} bytes, above the ${MAX_METADATA_BYTES} byte cap` })
        continue
      }
      const raw = readJson(manifestPath)
      if (!raw.ok) {
        skipped.push({ id, reason: `package.json ${raw.error}` })
        continue
      }
      const pkg = normalizeTemplatePackage(raw.value)
      if (!pkg) {
        skipped.push({ id, reason: 'package.json is not a JSON object' })
        continue
      }
      templates.push(describeTemplate(id, group.path, dir, entry.name, pkg))
    }
  }

  return ok({
    groups,
    repositoryName,
    templates: templates.sort((left, right) => left.id.localeCompare(right.id)),
    skipped: skipped.sort((left, right) => left.id.localeCompare(right.id)),
  })
}

export function findTemplate(catalog: Catalog, id: string): Result<CatalogTemplate> {
  const normalized = id.trim().replace(/^\/+|\/+$/g, '')
  const template = catalog.templates.find((candidate) => candidate.id === normalized)
  if (template) return ok(template)
  const suggestions = catalog.templates
    .filter((candidate) => candidate.id.includes(normalized) || candidate.name === normalized)
    .map((candidate) => candidate.id)
  const hint =
    suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ' Use list_templates to see valid ids.'
  return err(`Unknown template id "${id}".${hint}`)
}

export function classifyTemplate(dir: string, pkg: TemplatePackage): TemplateKind {
  if (isFile(join(dir, 'Cargo.toml')) || isFile(join(dir, 'program', 'Cargo.toml'))) return 'rust'
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const scripts = Object.values(pkg.scripts ?? {}).join(' ')
  if ('expo' in deps || scripts.includes('expo')) return 'expo'
  if ('next' in deps || scripts.includes('next ')) return 'next'
  if ('vite' in deps || scripts.includes('vite')) return 'vite'
  if (pkg.scripts?.build || pkg.scripts?.start) return 'node'
  return 'unknown'
}

/**
 * Variable names in an .env.example body that require real credentials. Comments and values never count.
 * At most MAX_ENV_KEYS names are returned and names longer than MAX_ENV_KEY_LENGTH are ignored.
 */
export function envKeysRequiringCredentials(envBody: string): readonly string[] {
  return envBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((key) => key.length <= MAX_ENV_KEY_LENGTH)
    .filter((key) => CREDENTIAL_KEY_PATTERN.test(key) && !NON_CREDENTIAL_KEY_PATTERN.test(key))
    .slice(0, MAX_ENV_KEYS)
}

/**
 * Markdown headings of a README body, without the leading hashes. At most MAX_README_HEADINGS are returned
 * and each is cut at MAX_HEADING_LENGTH characters.
 */
export function readmeHeadings(markdown: string): readonly string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .slice(0, MAX_README_HEADINGS)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .trim()
        .slice(0, MAX_HEADING_LENGTH),
    )
}

/** Coerce a parsed package.json into the fields the catalog reads; null when it is not a JSON object. */
export function normalizeTemplatePackage(value: unknown): TemplatePackage | null {
  if (!isRecord(value)) return null
  const createSolanaDapp = value['create-solana-dapp']
  return {
    name: optionalString(value.name),
    displayName: optionalString(value.displayName),
    description: optionalString(value.description),
    usecase: optionalString(value.usecase),
    keywords: stringArray(value.keywords),
    scripts: stringRecord(value.scripts),
    dependencies: stringRecord(value.dependencies),
    devDependencies: stringRecord(value.devDependencies),
    packageManager: optionalString(value.packageManager),
    'create-solana-dapp': isRecord(createSolanaDapp) ? (createSolanaDapp as CreateSolanaDappConfig) : undefined,
  }
}

/**
 * Valid entries of root package.json `repokit.groups`: objects with a relative, traversal-free string `path`.
 * Anything else is dropped, and a path listed twice counts once.
 */
export function normalizeGroups(repokit: unknown): readonly GroupConfig[] {
  if (!isRecord(repokit) || !Array.isArray(repokit.groups)) return []
  const seen = new Set<string>()
  const groups: GroupConfig[] = []
  for (const entry of repokit.groups) {
    if (!isRecord(entry)) continue
    const path = optionalString(entry.path)?.trim()
    if (!path || !isSafeRelativePath(path) || seen.has(path)) continue
    seen.add(path)
    groups.push({
      name: optionalString(entry.name) ?? path,
      description: optionalString(entry.description) ?? '',
      path,
    })
  }
  return groups
}

function describeTemplate(
  id: string,
  group: string,
  dir: string,
  directoryName: string,
  pkg: TemplatePackage,
): CatalogTemplate {
  const readmePath = README_CANDIDATES.find((candidate) => isFile(join(dir, candidate))) ?? null
  const readme = readmePath ? readTextBounded(join(dir, readmePath)) : ''
  const envExample = join(dir, '.env.example')
  const credentialKeys = isFile(envExample) ? envKeysRequiringCredentials(readTextBounded(envExample)) : []
  const name = !pkg.name || pkg.name.includes('{{') ? directoryName : pkg.name

  return {
    id,
    group,
    dir,
    name,
    displayName: pkg.displayName,
    description: pkg.description ?? '',
    usecase: pkg.usecase,
    keywords: [...(pkg.keywords ?? [])],
    kind: classifyTemplate(dir, pkg),
    scripts: { ...(pkg.scripts ?? {}) },
    dependencies: Object.keys(pkg.dependencies ?? {}).sort(),
    devDependencies: Object.keys(pkg.devDependencies ?? {}).sort(),
    packageManager: resolvePackageManager(pkg.packageManager),
    createSolanaDapp: pkg['create-solana-dapp'] ?? null,
    readmePath,
    readmeHeadings: readmeHeadings(readme),
    hasOgImage: isFile(join(dir, OG_IMAGE_FILENAME)),
    needsSecrets: credentialKeys.length > 0,
    credentialKeys,
  }
}

/** "pnpm@10.20.0" -> "pnpm"; missing or unknown -> "npm". */
function resolvePackageManager(field: string | undefined): PackageManager {
  const name = field?.split('@')[0]?.trim()
  return name === 'pnpm' || name === 'yarn' ? name : 'npm'
}

/**
 * Parse a JSON file. Error text never includes the path: a read failure reports the error code only and a parse
 * failure reports the JSON.parse message, because both reasons are shown to clients.
 */
function readJson(path: string): Result<unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    return err(`could not be read (${fsErrorCode(error)})`)
  }
  try {
    return ok(JSON.parse(text) as unknown)
  } catch (error) {
    return err(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Directory entries, or none when the directory cannot be listed (an unreadable group is treated as empty). */
function readDirectoryEntries(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function fsErrorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined
  return typeof code === 'string' ? code : 'unknown error'
}

/** The first MAX_METADATA_BYTES bytes of a regular file as UTF-8; empty when it cannot be read. */
function readTextBounded(path: string): string {
  let fd: number | undefined
  try {
    const stats = lstatSync(path)
    if (!stats.isFile()) return ''
    const length = Math.min(stats.size, MAX_METADATA_BYTES)
    const buffer = Buffer.alloc(length)
    fd = openSync(path, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.toString('utf-8', 0, read)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** True for a regular file only: symlinked README, env or image files are ignored, never followed. */
function isFile(path: string): boolean {
  return lstatOrNull(path)?.isFile() ?? false
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function isSafeRelativePath(path: string): boolean {
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return false
  return path.split(/[\\/]+/).every((segment) => segment !== '..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return Object.fromEntries(entries)
}
