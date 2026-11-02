import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import {
  envKeysRequiringCredentials,
  findTemplate,
  loadCatalog,
  MAX_HEADING_LENGTH,
  MAX_METADATA_BYTES,
  MAX_README_HEADINGS,
  normalizeGroups,
  readmeHeadings,
} from './catalog.js'

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

test('never follows symlinked README, env or image files', () => {
  const rootDir = createFixtureRepository()
  writeJson(join(rootDir, 'kit', 'linked', 'package.json'), { name: 'linked', description: 'd', keywords: ['k'] })
  writeText(join(rootDir, 'outside.md'), '# Outside heading\n')
  writeText(join(rootDir, 'outside.env'), 'API_KEY=\n')
  symlinkSync(join(rootDir, 'outside.md'), join(rootDir, 'kit', 'linked', 'README.md'))
  symlinkSync(join(rootDir, 'outside.env'), join(rootDir, 'kit', 'linked', '.env.example'))
  symlinkSync(join(rootDir, 'outside.md'), join(rootDir, 'kit', 'linked', 'og-image.png'))

  const catalog = loadCatalog(rootDir)
  assert.ok(catalog.ok)
  if (!catalog.ok) return
  const linked = catalog.value.templates.find((template) => template.id === 'kit/linked')
  assert.ok(linked)
  assert.equal(linked.readmePath, null)
  assert.deepEqual(linked.readmeHeadings, [])
  assert.equal(linked.needsSecrets, false)
  assert.equal(linked.hasOgImage, false)
})

test('env key and heading helpers ignore comments and values', () => {
  assert.deepEqual(envKeysRequiringCredentials('# SECRET=1\nAPP_URL=secret\nPRIVY_APP_ID=x\nAUTH_SECRET=\n'), [
    'AUTH_SECRET',
  ])
  assert.deepEqual(readmeHeadings('#notaheading\n# Title\ntext\n### Deep\n'), ['Title', 'Deep'])
})

test('skips manifests it cannot describe with a reason and keeps the valid siblings', () => {
  const rootDir = createFixtureRepository()
  writeJson(join(rootDir, 'kit', 'good', 'package.json'), { name: 'good', description: 'd', keywords: ['k'] })
  writeText(join(rootDir, 'kit', 'null', 'package.json'), 'null\n')
  writeText(join(rootDir, 'kit', 'list', 'package.json'), '["not", "an", "object"]\n')
  writeText(join(rootDir, 'kit', 'broken', 'package.json'), '{\n')
  writeJson(join(rootDir, 'kit', 'shape', 'package.json'), {
    name: 3,
    description: ['nope'],
    keywords: { a: 1 },
    scripts: 'build',
    dependencies: ['next'],
    devDependencies: { vite: 1, typescript: '^5' },
    'create-solana-dapp': 'yes',
  })
  writeText(join(rootDir, 'kit', 'huge', 'package.json'), `{"name":"huge","pad":"${'x'.repeat(MAX_METADATA_BYTES)}"}`)
  // root can read anything, so the unreadable manifest is only exercised for other users
  const canLockFiles = process.getuid?.() !== 0
  if (canLockFiles) {
    writeText(join(rootDir, 'kit', 'locked', 'package.json'), '{"name":"locked"}\n')
    chmodSync(join(rootDir, 'kit', 'locked', 'package.json'), 0o000)
  }

  const catalog = loadCatalog(rootDir)
  assert.ok(catalog.ok, catalog.ok ? '' : catalog.error)
  if (!catalog.ok) return

  assert.deepEqual(
    catalog.value.templates.map((template) => template.id),
    ['kit/good', 'kit/shape'],
  )
  const shape = catalog.value.templates[1]
  assert.equal(shape.name, 'shape')
  assert.equal(shape.description, '')
  assert.deepEqual(shape.keywords, [])
  assert.deepEqual(shape.scripts, {})
  assert.deepEqual(shape.dependencies, [])
  assert.deepEqual(shape.devDependencies, ['typescript'])
  assert.equal(shape.createSolanaDapp, null)
  assert.equal(shape.kind, 'unknown')

  assert.deepEqual(
    catalog.value.skipped.map((entry) => entry.id),
    canLockFiles
      ? ['kit/broken', 'kit/huge', 'kit/list', 'kit/locked', 'kit/null']
      : ['kit/broken', 'kit/huge', 'kit/list', 'kit/null'],
  )
  const reasons = Object.fromEntries(catalog.value.skipped.map((entry) => [entry.id, entry.reason]))
  assert.match(reasons['kit/broken'], /not valid JSON/)
  assert.match(reasons['kit/huge'], /byte cap/)
  assert.match(reasons['kit/list'], /not a JSON object/)
  assert.match(reasons['kit/null'], /not a JSON object/)
  if (canLockFiles) assert.match(reasons['kit/locked'], /could not be read \(EACCES\)/)
  for (const entry of catalog.value.skipped) {
    assert.ok(!entry.reason.includes(rootDir), `reason must not leak the path: ${entry.reason}`)
  }
})

test('an unreadable group directory is treated as empty instead of failing the catalog', (context) => {
  if (process.getuid?.() === 0) return context.skip('root can list any directory')
  const rootDir = createFixtureRepository()
  writeJson(join(rootDir, 'kit', 'web', 'package.json'), { name: 'web', description: 'd', keywords: [] })
  chmodSync(join(rootDir, 'kit'), 0o000)
  try {
    const catalog = loadCatalog(rootDir)
    assert.ok(catalog.ok)
    if (catalog.ok) assert.deepEqual(catalog.value.templates, [])
  } finally {
    chmodSync(join(rootDir, 'kit'), 0o755)
  }
})

test('never follows a symlinked group directory, template directory or package.json', () => {
  const linkedGroup = createFixtureRepository()
  writeJson(join(linkedGroup, 'outside', 'leak', 'package.json'), { name: 'leak', description: 'd', keywords: [] })
  symlinkSync(join(linkedGroup, 'outside'), join(linkedGroup, 'kit'))
  const viaGroup = loadCatalog(linkedGroup)
  assert.ok(viaGroup.ok)
  if (viaGroup.ok) {
    assert.deepEqual(viaGroup.value.templates, [])
    assert.deepEqual(viaGroup.value.skipped, [])
  }

  const rootDir = createFixtureRepository()
  writeJson(join(rootDir, 'outside', 'leak', 'package.json'), { name: 'leak', description: 'd', keywords: [] })
  writeJson(join(rootDir, 'outside', 'package.json'), { name: 'outside-manifest', description: 'd', keywords: [] })
  mkdirSync(join(rootDir, 'kit', 'linked-manifest'), { recursive: true })
  symlinkSync(join(rootDir, 'outside', 'leak'), join(rootDir, 'kit', 'linked-dir'))
  symlinkSync(join(rootDir, 'outside', 'package.json'), join(rootDir, 'kit', 'linked-manifest', 'package.json'))
  writeJson(join(rootDir, 'kit', 'real', 'package.json'), { name: 'real', description: 'd', keywords: [] })

  const catalog = loadCatalog(rootDir)
  assert.ok(catalog.ok)
  if (!catalog.ok) return
  assert.deepEqual(
    catalog.value.templates.map((template) => template.id),
    ['kit/real'],
  )
  assert.deepEqual(
    catalog.value.skipped.map((entry) => entry.id),
    ['kit/linked-manifest'],
  )
  assert.match(catalog.value.skipped[0].reason, /symlink/i)
})

test('bounds README and env reads and the metadata extracted from them', () => {
  const rootDir = createFixtureRepository()
  const dir = join(rootDir, 'kit', 'big')
  writeJson(join(dir, 'package.json'), { name: 'big', description: 'd', keywords: [] })
  const longHeading = 'h'.repeat(MAX_HEADING_LENGTH * 2)
  const manyHeadings = Array.from({ length: MAX_README_HEADINGS + 5 }, (_, index) => `## Heading ${index}`).join('\n')
  writeText(
    join(dir, 'README.md'),
    `# Early\n## ${longHeading}\n${manyHeadings}\n${'x'.repeat(MAX_METADATA_BYTES)}\n# Late\n`,
  )
  writeText(join(dir, '.env.example'), `SECRET_ONE=\n#${'c'.repeat(MAX_METADATA_BYTES)}\nSECRET_TWO=\n`)

  const catalog = loadCatalog(rootDir)
  assert.ok(catalog.ok)
  if (!catalog.ok) return
  const big = catalog.value.templates[0]
  assert.equal(big.readmeHeadings.length, MAX_README_HEADINGS)
  assert.equal(big.readmeHeadings[0], 'Early')
  assert.equal(big.readmeHeadings[1], 'h'.repeat(MAX_HEADING_LENGTH))
  assert.ok(!big.readmeHeadings.includes('Late'), 'a heading past the byte cap must not be read')
  assert.deepEqual(big.credentialKeys, ['SECRET_ONE'])
})

test('normalizeGroups keeps only relative, traversal-free string paths and drops duplicates', () => {
  assert.deepEqual(
    normalizeGroups({
      groups: [
        'kit',
        { path: '../escape' },
        { path: '/abs' },
        { path: 'C:\\win' },
        { path: '  ' },
        { name: 'Kit', description: 'Kit templates', path: 'kit' },
        { path: 'kit' },
        { path: 'community', name: 7 },
      ],
    }),
    [
      { name: 'Kit', description: 'Kit templates', path: 'kit' },
      { name: 'community', description: '', path: 'community' },
    ],
  )
  assert.deepEqual(normalizeGroups({ groups: 'kit' }), [])
  assert.deepEqual(normalizeGroups(null), [])

  const rootDir = mkdtempSync(join(tmpdir(), 'templates-mcp-catalog-'))
  temporaryDirectories.push(rootDir)
  writeJson(join(rootDir, 'package.json'), { repokit: { groups: ['kit'] } })
  const noGroups = loadCatalog(rootDir)
  assert.ok(!noGroups.ok)
  if (!noGroups.ok) assert.match(noGroups.error, /repokit\.groups/)
  writeText(join(rootDir, 'package.json'), '[]\n')
  const notObject = loadCatalog(rootDir)
  assert.ok(!notObject.ok)
  if (!notObject.ok) assert.match(notObject.error, /not a JSON object/)
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
