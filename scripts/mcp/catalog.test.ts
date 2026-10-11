import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { envKeysRequiringCredentials, findTemplate, loadCatalog, readmeHeadings } from './catalog.js'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test('enumerates the real repository from repokit.groups', () => {
  const catalog = loadCatalog(ROOT_DIR)
  assert.ok(catalog.ok, catalog.ok ? '' : catalog.error)
  if (!catalog.ok) return

  assert.ok(
    catalog.value.templates.length >= 30,
    `expected at least 30 templates, got ${catalog.value.templates.length}`,
  )
  assert.equal(catalog.value.repositoryName, 'solana-foundation/templates')
  assert.ok(catalog.value.groups.some((group) => group.path === 'kit'))

  const nextjs = catalog.value.templates.find((template) => template.id === 'kit/nextjs')
  assert.ok(nextjs, 'kit/nextjs missing')
  assert.equal(nextjs.kind, 'next')
  assert.equal(nextjs.group, 'kit')
  assert.equal(nextjs.name, 'nextjs')
  assert.equal(nextjs.readmePath, 'README.md')
  assert.ok(nextjs.hasOgImage)
  assert.ok(nextjs.dependencies.includes('next'))
  assert.ok(Object.keys(nextjs.scripts).includes('ci'))
  assert.ok(nextjs.createSolanaDapp?.rename, 'create-solana-dapp rename metadata missing')

  const ids = catalog.value.templates.map((template) => template.id)
  assert.deepEqual(
    ids,
    [...ids].sort((left, right) => left.localeCompare(right)),
  )
  assert.equal(new Set(ids).size, ids.length, 'template ids must be unique')
  assert.ok(catalog.value.templates.some((template) => template.kind === 'rust'))
  assert.ok(catalog.value.templates.some((template) => template.kind === 'expo'))
})

test('findTemplate normalizes slashes and suggests close ids', () => {
  const catalog = loadCatalog(ROOT_DIR)
  assert.ok(catalog.ok)
  if (!catalog.ok) return

  const found = findTemplate(catalog.value, '/kit/nextjs/')
  assert.ok(found.ok)
  if (found.ok) assert.equal(found.value.id, 'kit/nextjs')

  const missing = findTemplate(catalog.value, 'nextjs')
  assert.ok(!missing.ok)
  if (!missing.ok) assert.match(missing.error, /kit\/nextjs/)
})

test('classifies templates and detects credentials from a fixture repository', () => {
  const rootDir = createFixtureRepository()
  writeJson(join(rootDir, 'kit', 'web', 'package.json'), {
    name: 'web',
    description: 'A web app',
    keywords: ['next'],
    dependencies: { next: '15.0.0' },
    packageManager: 'pnpm@10.5.2',
  })
  writeText(
    join(rootDir, 'kit', 'web', '.env.example'),
    'NEXT_PUBLIC_RPC_URL=\nSUPABASE_SERVICE_KEY=\n# API_KEY=comment\n',
  )
  writeText(join(rootDir, 'kit', 'web', 'README.md'), '# Web\n\n## Getting started\n\nText\n')
  writeJson(join(rootDir, 'kit', 'program', 'package.json'), { name: 'program', description: 'd', keywords: ['rust'] })
  writeText(join(rootDir, 'kit', 'program', 'Cargo.toml'), '[package]\nname = "program"\n')
  mkdirSync(join(rootDir, 'kit', 'not-a-template'), { recursive: true })

  const catalog = loadCatalog(rootDir)
  assert.ok(catalog.ok)
  if (!catalog.ok) return

  assert.deepEqual(
    catalog.value.templates.map((template) => template.id),
    ['kit/program', 'kit/web'],
  )
  const web = catalog.value.templates[1]
  assert.equal(web.kind, 'next')
  assert.equal(web.packageManager, 'pnpm')
  assert.equal(web.needsSecrets, true)
  assert.deepEqual(web.credentialKeys, ['SUPABASE_SERVICE_KEY'])
  assert.deepEqual(web.readmeHeadings, ['Web', 'Getting started'])
  assert.equal(web.hasOgImage, false)
  assert.equal(catalog.value.templates[0].kind, 'rust')
  assert.equal(catalog.value.templates[0].needsSecrets, false)
})

test('env key and heading helpers ignore comments and values', () => {
  assert.deepEqual(envKeysRequiringCredentials('# SECRET=1\nAPP_URL=secret\nPRIVY_APP_ID=x\nAUTH_SECRET=\n'), [
    'AUTH_SECRET',
  ])
  assert.deepEqual(readmeHeadings('#notaheading\n# Title\ntext\n### Deep\n'), ['Title', 'Deep'])
})

function createFixtureRepository(): string {
  const rootDir = mkdtempSync(join(tmpdir(), 'templates-mcp-catalog-'))
  temporaryDirectories.push(rootDir)
  writeJson(join(rootDir, 'package.json'), {
    name: 'fixture',
    repository: { name: 'example/templates' },
    repokit: { groups: [{ name: 'Kit', description: 'Kit templates', path: 'kit' }] },
  })
  return rootDir
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
