/**
 * Template catalog for the MCP server.
 *
 * Enumerates templates from root package.json `repokit.groups`, the same source of truth used by
 * scripts/generate.ts, and classifies each one with the heuristics of the templates health check.
 * Every function reads the file system on each call and holds no cache.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
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

export type Catalog = {
  readonly repositoryName: string
  readonly groups: readonly GroupConfig[]
  readonly templates: readonly CatalogTemplate[]
}

type TemplatePackage = {
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

type RootPackage = {
  readonly repository?: { readonly name?: string }
  readonly repokit?: { readonly groups?: readonly GroupConfig[] }
}

const DEFAULT_REPOSITORY_NAME = 'solana-foundation/templates'
const OG_IMAGE_FILENAME = 'og-image.png'
const README_CANDIDATES = ['README.md', 'readme.md', 'Readme.md']

/** Env variable names that mean "you need a real credential to run this" (same rules as the health check). */
const CREDENTIAL_KEY_PATTERN = /(API_?KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|SUPABASE|PRIVY)/i
const NON_CREDENTIAL_KEY_PATTERN = /(MINT|PROGRAM|ADDRESS|RPC|URL|PUBKEY|PUBLIC_KEY|APP_ID|CLIENT_ID|PROJECT_ID)/i

export function loadCatalog(rootDir: string): Result<Catalog> {
  const rootPackage = readJson<RootPackage>(join(rootDir, 'package.json'))
  if (!rootPackage.ok) return err(`Failed to read root package.json: ${rootPackage.error}`)

  const groups = rootPackage.value.repokit?.groups ?? []
  if (groups.length === 0) return err('No repokit.groups configuration found in package.json')

  const repositoryName = rootPackage.value.repository?.name || DEFAULT_REPOSITORY_NAME
  const templates: CatalogTemplate[] = []

  for (const group of groups) {
    const groupDir = join(rootDir, group.path)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(groupDir, entry.name)
      const pkg = readJson<TemplatePackage>(join(dir, 'package.json'))
      if (!pkg.ok) continue
      templates.push(describeTemplate(`${group.path}/${entry.name}`, group.path, dir, entry.name, pkg.value))
    }
  }

  return ok({
    groups,
    repositoryName,
    templates: templates.sort((left, right) => left.id.localeCompare(right.id)),
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
  if (existsSync(join(dir, 'Cargo.toml')) || existsSync(join(dir, 'program', 'Cargo.toml'))) return 'rust'
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const scripts = Object.values(pkg.scripts ?? {}).join(' ')
  if ('expo' in deps || scripts.includes('expo')) return 'expo'
  if ('next' in deps || scripts.includes('next ')) return 'next'
  if ('vite' in deps || scripts.includes('vite')) return 'vite'
  if (pkg.scripts?.build || pkg.scripts?.start) return 'node'
  return 'unknown'
}

/** Variable names in an .env.example body that require real credentials. Comments and values never count. */
export function envKeysRequiringCredentials(envBody: string): readonly string[] {
  return envBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((key) => CREDENTIAL_KEY_PATTERN.test(key) && !NON_CREDENTIAL_KEY_PATTERN.test(key))
}

/** Markdown headings of a README body, without the leading hashes. */
export function readmeHeadings(markdown: string): readonly string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
}

function describeTemplate(
  id: string,
  group: string,
  dir: string,
  directoryName: string,
  pkg: TemplatePackage,
): CatalogTemplate {
  const readmePath = README_CANDIDATES.find((candidate) => isFile(join(dir, candidate))) ?? null
  const readme = readmePath ? readText(join(dir, readmePath)) : ''
  const envExample = join(dir, '.env.example')
  const credentialKeys = isFile(envExample) ? envKeysRequiringCredentials(readText(envExample)) : []
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

function readJson<T>(path: string): Result<T> {
  try {
    return ok(JSON.parse(readFileSync(path, 'utf-8')) as T)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** True for a regular file only: symlinked README, env or image files are ignored, never followed. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}
