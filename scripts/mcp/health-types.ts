/**
 * Minimal subset of the templates health check report shape (`pnpm health`, scripts/health/types.ts).
 *
 * Only the fields the MCP server reads are typed here. Dimension results keep an open shape so a report
 * written by a newer health check still loads; unknown fields are passed through untouched.
 */

export type HealthStatus = 'pass' | 'warn' | 'fail' | 'skip'

export type HealthKind = 'next' | 'vite' | 'expo' | 'rust' | 'node' | 'unknown'

export type HealthDimension = {
  readonly status: HealthStatus
  readonly note?: string
  readonly [key: string]: unknown
}

export type TemplateHealthReport = {
  readonly id: string
  readonly group: string
  readonly kind: HealthKind
  readonly status: HealthStatus
  readonly needsSecrets: boolean
  readonly packageManager: string
  readonly flaky?: boolean
  readonly build: HealthDimension
  readonly deps: HealthDimension
  readonly audit: HealthDimension
  readonly deprecation: HealthDimension
  readonly docDrift: HealthDimension
  readonly boot?: HealthDimension
  readonly rust?: HealthDimension
}

export type HealthReport = {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly packageManager: string
  readonly options: {
    readonly build: boolean
    readonly boot: boolean
    readonly source: 'local' | 'scaffold'
  }
  readonly summary: {
    readonly total: number
    readonly pass: number
    readonly warn: number
    readonly fail: number
    readonly skip: number
  }
  readonly templates: readonly TemplateHealthReport[]
}
