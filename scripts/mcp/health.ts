/**
 * Loader for the most recent templates health report (`pnpm health` writes health-reports/<timestamp>.json).
 *
 * The directory is gitignored and often absent, so a missing report is a normal, non-error answer that tells the
 * agent how to produce one, or that the health check itself is not in this checkout yet.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { HealthReport, HealthStatus, TemplateHealthReport } from './health-types.js'

export const HEALTH_REPORTS_DIRNAME = 'health-reports'
export const HEALTH_CHECK_SCRIPT = 'scripts/health-check.ts'
export const HEALTH_UNAVAILABLE_NOTE =
  'No health report found. Run `pnpm health` in the templates repository to generate health-reports/<timestamp>.json, then call this tool again.'
export const HEALTH_CHECK_MISSING_NOTE =
  'The templates health check is not in this checkout yet (solana-foundation/templates PR #420 adds `pnpm health`). The health tools return available: false until it lands and a report has been generated.'

export type HealthLoadResult =
  | { readonly available: true; readonly reportPath: string; readonly report: HealthReport }
  | { readonly available: false; readonly note: string }

export type TemplateHealthSummary = {
  readonly id: string
  readonly status: HealthStatus
  readonly kind: string
  readonly needsSecrets: boolean
  readonly flaky: boolean
  readonly dimensions: Readonly<Record<string, HealthStatus>>
}

export type HealthSummary = {
  readonly reportPath: string
  readonly generatedAt: string
  readonly packageManager: string
  readonly options: HealthReport['options']
  readonly summary: HealthReport['summary']
  readonly failing: readonly string[]
  readonly warning: readonly string[]
  readonly templates: readonly TemplateHealthSummary[]
}

/** Load the newest report in `<rootDir>/health-reports`, picking by file name (reports are named by ISO timestamp). */
export function loadLatestHealthReport(rootDir: string): HealthLoadResult {
  const reportsDir = join(rootDir, HEALTH_REPORTS_DIRNAME)
  const note = existsSync(join(rootDir, HEALTH_CHECK_SCRIPT)) ? HEALTH_UNAVAILABLE_NOTE : HEALTH_CHECK_MISSING_NOTE
  if (!existsSync(reportsDir)) return { available: false, note }

  const candidates = readdirSync(reportsDir)
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left))

  for (const name of candidates) {
    const reportPath = join(reportsDir, name)
    const report = parseHealthReport(reportPath)
    if (report) return { available: true, reportPath, report }
  }

  return { available: false, note }
}

export function summarizeHealthReport(reportPath: string, report: HealthReport): HealthSummary {
  const templates = report.templates.map(summarizeTemplate)
  return {
    reportPath,
    generatedAt: report.generatedAt,
    packageManager: report.packageManager,
    options: report.options,
    summary: report.summary,
    failing: templates.filter((template) => template.status === 'fail').map((template) => template.id),
    warning: templates.filter((template) => template.status === 'warn').map((template) => template.id),
    templates,
  }
}

export function findTemplateHealth(report: HealthReport, id: string): TemplateHealthReport | undefined {
  return report.templates.find((template) => template.id === id)
}

function summarizeTemplate(template: TemplateHealthReport): TemplateHealthSummary {
  const dimensions: Record<string, HealthStatus> = {}
  for (const name of ['build', 'rust', 'boot', 'deps', 'audit', 'deprecation', 'docDrift'] as const) {
    const dimension = template[name]
    if (dimension) dimensions[name] = dimension.status
  }
  return {
    id: template.id,
    status: template.status,
    kind: template.kind,
    needsSecrets: template.needsSecrets,
    flaky: template.flaky === true,
    dimensions,
  }
}

function parseHealthReport(path: string): HealthReport | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HealthReport>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.templates) || typeof parsed.summary !== 'object') {
      return null
    }
    return parsed as HealthReport
  } catch {
    return null
  }
}
