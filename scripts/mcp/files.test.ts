import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { loadCatalog, type CatalogTemplate } from './catalog.js'
import { listTemplateFiles, MAX_FILE_BYTES, readTemplateFile, resolveTemplateFile } from './files.js'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test('reads README.md of a real template', () => {
  const template = realTemplate('kit/nextjs')
  const file = readTemplateFile(template, 'README.md')
  assert.ok(file.ok, file.ok ? '' : file.error)
  if (!file.ok) return
  assert.equal(file.value.path, 'README.md')
  assert.ok(file.value.size > 0)
  assert.match(file.value.content, /#/)
  assert.ok(readTemplateFile(template, './package.json').ok)
})

test('rejects traversal, absolute paths, env files and hidden directories', () => {
  const template = realTemplate('kit/nextjs')
  for (const path of [
    '../package.json',
    'src/../../lint.ts',
    '/etc/hosts',
    'C:\\Windows',
    '.env',
    '.env.local',
    '.env.example',
    'node_modules/next/package.json',
    'dist/index.js',
    '',
    '   ',
  ]) {
    const result = resolveTemplateFile(template, path)
    assert.ok(!result.ok, `expected "${path}" to be rejected`)
  }
  assert.match(unwrapError(resolveTemplateFile(template, '../package.json')), /traversal/i)
  assert.match(unwrapError(resolveTemplateFile(template, '/etc/hosts')), /absolute/i)
  assert.match(unwrapError(resolveTemplateFile(template, '.env')), /not allowed/i)
  assert.match(unwrapError(readTemplateFile(template, 'does-not-exist.txt')), /not found/i)
  assert.match(unwrapError(readTemplateFile(template, 'app')), /not a file/i)
})

test('rejects every symlink, including links to env files and outside the template', () => {
  const template = fixtureTemplate()
  writeFileSync(join(template.dir, '..', 'outside.txt'), 'outside')
  writeFileSync(join(template.dir, '.env'), 'SECRET=1\n')
  symlinkSync(join(template.dir, '..', 'outside.txt'), join(template.dir, 'escape.txt'))
  symlinkSync(join(template.dir, '.env'), join(template.dir, 'public.txt'))
  symlinkSync('.env', join(template.dir, 'relative.txt'))
  symlinkSync('/etc/passwd', join(template.dir, 'passwd.txt'))
  symlinkSync(join(template.dir, 'src'), join(template.dir, 'linked-dir'))

  for (const path of ['escape.txt', 'public.txt', 'relative.txt', 'passwd.txt', 'linked-dir/index.ts']) {
    assert.match(unwrapError(readTemplateFile(template, path)), /symlink/i, `expected "${path}" to be refused`)
  }
  assert.ok(readTemplateFile(template, 'src/index.ts').ok)
})

test('rejects binaries and oversized files', () => {
  const template = fixtureTemplate()
  writeFileSync(join(template.dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  writeFileSync(join(template.dir, 'large.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))

  assert.match(unwrapError(readTemplateFile(template, 'image.png')), /binary/i)
  assert.match(unwrapError(readTemplateFile(template, 'large.txt')), /cap/i)
})

test('lists files with depth and entry caps and skips ignored directories and symlinks', () => {
  const template = fixtureTemplate()
  writeFileSync(join(template.dir, '.env'), 'SECRET=1')
  symlinkSync(join(template.dir, 'README.md'), join(template.dir, 'link.md'))
  mkdirSync(join(template.dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(template.dir, 'node_modules', 'dep', 'index.js'), '')
  // "a" sorts before its shallow siblings so a depth limit inside it must not hide "src" or "z.txt".
  mkdirSync(join(template.dir, 'a', 'deep', 'deeper'), { recursive: true })
  writeFileSync(join(template.dir, 'a', 'deep', 'deeper', 'leaf.ts'), '')
  writeFileSync(join(template.dir, 'z.txt'), '')

  const shallow = listTemplateFiles(template, { maxDepth: 1 })
  assert.ok(shallow.ok)
  if (!shallow.ok) return
  assert.deepEqual(
    shallow.value.files.map((file) => file.path),
    ['README.md', 'package.json', 'z.txt'],
  )
  assert.deepEqual(shallow.value.directories, ['a', 'src'])
  assert.deepEqual(shallow.value.depthLimited, ['a', 'src'])
  assert.equal(shallow.value.truncated, false)

  const middle = listTemplateFiles(template, { maxDepth: 2 })
  assert.ok(middle.ok)
  if (!middle.ok) return
  assert.deepEqual(middle.value.directories, ['a', 'a/deep', 'src'])
  assert.deepEqual(middle.value.depthLimited, ['a/deep'])
  assert.ok(middle.value.files.some((file) => file.path === 'src/index.ts'))
  assert.ok(middle.value.files.some((file) => file.path === 'z.txt'))
  assert.equal(middle.value.truncated, false)

  const deep = listTemplateFiles(template, { maxDepth: 8 })
  assert.ok(deep.ok)
  if (!deep.ok) return
  assert.ok(deep.value.files.some((file) => file.path === 'a/deep/deeper/leaf.ts'))
  assert.ok(
    !deep.value.files.some(
      (file) => file.path.includes('node_modules') || file.path.endsWith('.env') || file.path === 'link.md',
    ),
  )
  assert.deepEqual(deep.value.depthLimited, [])
  assert.equal(deep.value.truncated, false)

  const capped = listTemplateFiles(template, { maxDepth: 8, maxEntries: 2 })
  assert.ok(capped.ok && capped.value.truncated)
})

function realTemplate(id: string): CatalogTemplate {
  const catalog = loadCatalog(ROOT_DIR)
  assert.ok(catalog.ok)
  const template = catalog.ok ? catalog.value.templates.find((candidate) => candidate.id === id) : undefined
  assert.ok(template, `${id} missing from catalog`)
  return template
}

function fixtureTemplate(): CatalogTemplate {
  const rootDir = mkdtempSync(join(tmpdir(), 'templates-mcp-files-'))
  temporaryDirectories.push(rootDir)
  const dir = join(rootDir, 'kit', 'sample')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"sample"}\n')
  writeFileSync(join(dir, 'README.md'), '# Sample\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n')
  return {
    id: 'kit/sample',
    group: 'kit',
    dir,
    name: 'sample',
    description: '',
    keywords: [],
    kind: 'node',
    scripts: {},
    dependencies: [],
    devDependencies: [],
    packageManager: 'npm',
    createSolanaDapp: null,
    readmePath: 'README.md',
    readmeHeadings: ['Sample'],
    hasOgImage: false,
    needsSecrets: false,
    credentialKeys: [],
  }
}

function unwrapError(result: { readonly ok: boolean; readonly error?: string }): string {
  assert.ok(!result.ok, 'expected an error result')
  return result.error ?? ''
}
