import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { HealthReport } from './health-types.js'
import {
  findTemplateHealth,
  HEALTH_CHECK_SCRIPT,
  HEALTH_REPORTS_DIRNAME,
  isHealthReport,
  loadLatestHealthReport,
  summarizeHealthReport,
} from './health.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test('returns available: false with a note that matches the checkout', () => {
  const missing = loadLatestHealthReport(join(tmpdir(), 'templates-mcp-health-does-not-exist'))
  assert.equal(missing.available, false)
  if (!missing.available) assert.match(missing.note, /PR #420/)

  const withScript = createTempRoot(true)
  const noReports = loadLatestHealthReport(withScript)
  assert.equal(noReports.available, false)
  if (!noReports.available) {
    assert.match(noReports.note, /pnpm health/)
    assert.doesNotMatch(noReports.note, /PR #420/)
  }

  const reportsDir = join(withScript, HEALTH_REPORTS_DIRNAME)
  mkdirSync(reportsDir)
  writeFileSync(join(reportsDir, 'notes.md'), '# not json\n')
  writeFileSync(join(reportsDir, 'broken.json'), '{')
  assert.equal(loadLatestHealthReport(withScript).available, false)
})

test('loads the newest valid report and summarizes it', () => {
  const rootDir = createTempRoot(false)
  const dir = join(rootDir, HEALTH_REPORTS_DIRNAME)
  mkdirSync(dir)
  writeFileSync(
    join(dir, '2026-06-20T09-00-00.json'),
    JSON.stringify(fixtureReport('2026-06-20T09:00:00.000Z', 'fail')),
  )
  writeFileSync(
    join(dir, '2026-07-01T10-00-00.json'),
    JSON.stringify(fixtureReport('2026-07-01T10:00:00.000Z', 'warn')),
  )
  writeFileSync(join(dir, '2026-07-02T10-00-00.json'), '{"schemaVersion": 2}')

  const loaded = loadLatestHealthReport(rootDir)
  assert.ok(loaded.available)
  if (!loaded.available) return
  assert.equal(loaded.reportPath, join(dir, '2026-07-01T10-00-00.json'))
  assert.equal(loaded.report.generatedAt, '2026-07-01T10:00:00.000Z')

  const summary = summarizeHealthReport(loaded.reportPath, loaded.report)
  assert.equal(summary.summary.total, 2)
  assert.deepEqual(summary.warning, ['kit/nextjs'])
  assert.deepEqual(summary.failing, [])
  assert.deepEqual(summary.templates[0].dimensions, {
    build: 'pass',
    deps: 'warn',
    audit: 'pass',
    deprecation: 'pass',
    docDrift: 'pass',
  })
  assert.deepEqual(summary.templates[1].dimensions, {
    build: 'pass',
    rust: 'pass',
    deps: 'skip',
    audit: 'skip',
    deprecation: 'pass',
    docDrift: 'pass',
  })

  assert.equal(findTemplateHealth(loaded.report, 'kit/nextjs')?.status, 'warn')
  assert.equal(findTemplateHealth(loaded.report, 'kit/nope'), undefined)
})

test('falls back past a newest report that is malformed below the top level', () => {
  const rootDir = createTempRoot(false)
  const dir = join(rootDir, HEALTH_REPORTS_DIRNAME)
  mkdirSync(dir)
  const valid = fixtureReport('2026-07-01T10:00:00.000Z', 'warn')
  writeFileSync(join(dir, '2026-07-01T10-00-00.json'), JSON.stringify(valid))
  writeFileSync(
    join(dir, '2026-08-01T10-00-00.json'),
    '{"schemaVersion":1,"generatedAt":"x","packageManager":"npm","options":{},"summary":null,"templates":[null]}',
  )
  writeFileSync(
    join(dir, '2026-08-02T10-00-00.json'),
    JSON.stringify({ ...valid, templates: [{ ...valid.templates[0], status: 'bogus' }] }),
  )
  writeFileSync(
    join(dir, '2026-08-03T10-00-00.json'),
    JSON.stringify({ ...valid, templates: [{ ...valid.templates[0], build: { note: 'no status' } }] }),
  )
  writeFileSync(join(dir, '2026-08-04T10-00-00.json'), JSON.stringify({ ...valid, summary: { total: '2' } }))
  writeFileSync(join(dir, '2026-08-05T10-00-00.json'), JSON.stringify([valid]))

  for (const [input, expected] of [
    [valid, true],
    [{ ...valid, templates: [] }, true],
    [{ ...valid, options: null }, false],
    [{ ...valid, generatedAt: 1 }, false],
    [{ ...valid, templates: [{ ...valid.templates[0], needsSecrets: 'no' }] }, false],
  ] as const) {
    assert.equal(isHealthReport(input), expected)
  }

  const loaded = loadLatestHealthReport(rootDir)
  assert.ok(loaded.available)
  if (!loaded.available) return
  assert.equal(loaded.reportPath, join(dir, '2026-07-01T10-00-00.json'))
  assert.equal(summarizeHealthReport(loaded.reportPath, loaded.report).summary.total, 2)
})

function fixtureReport(generatedAt: string, nextjsStatus: 'warn' | 'fail'): HealthReport {
  const pass = { status: 'pass' as const }
  return {
    schemaVersion: 1,
    generatedAt,
    packageManager: 'npm',
    options: { build: true, boot: false, source: 'local' },
    summary: {
      total: 2,
      pass: 1,
      warn: nextjsStatus === 'warn' ? 1 : 0,
      fail: nextjsStatus === 'fail' ? 1 : 0,
      skip: 0,
    },
    templates: [
      {
        id: 'kit/nextjs',
        group: 'kit',
        kind: 'next',
        status: nextjsStatus,
        needsSecrets: false,
        packageManager: 'npm',
        build: { ...pass, phase: 'ci', command: 'npm run ci' },
        deps: { status: 'warn', major: 2, note: 'outdated' },
        audit: pass,
        deprecation: pass,
        docDrift: pass,
      },
      {
        id: 'kit/pinocchio-counter',
        group: 'kit',
        kind: 'rust',
        status: 'pass',
        needsSecrets: false,
        packageManager: 'npm',
        flaky: true,
        build: pass,
        rust: { ...pass, command: 'cargo check' },
        deps: { status: 'skip' },
        audit: { status: 'skip' },
        deprecation: pass,
        docDrift: pass,
      },
    ],
  }
}

function createTempRoot(withHealthCheck: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'templates-mcp-health-'))
  temporaryDirectories.push(dir)
  if (withHealthCheck) {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, HEALTH_CHECK_SCRIPT), '')
  }
  return dir
}
