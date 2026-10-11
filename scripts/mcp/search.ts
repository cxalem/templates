/**
 * Keyword search over the template catalog.
 *
 * Scoring is additive and deterministic: every query term is matched against the id, name, display name,
 * keywords, description, dependency names and README headings, and ties break on id order.
 */

import type { CatalogTemplate, TemplateKind } from './catalog.js'

export type SearchOptions = {
  readonly limit?: number
  readonly group?: string
  readonly kind?: TemplateKind
  readonly needsSecrets?: boolean
}

export type SearchHit = {
  readonly template: CatalogTemplate
  readonly score: number
  readonly matched: readonly string[]
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export function filterTemplates(
  templates: readonly CatalogTemplate[],
  options: Pick<SearchOptions, 'group' | 'kind' | 'needsSecrets'>,
): readonly CatalogTemplate[] {
  return templates.filter(
    (template) =>
      (options.group === undefined || template.group === options.group) &&
      (options.kind === undefined || template.kind === options.kind) &&
      (options.needsSecrets === undefined || template.needsSecrets === options.needsSecrets),
  )
}

export function searchTemplates(
  templates: readonly CatalogTemplate[],
  query: string,
  options: SearchOptions = {},
): readonly SearchHit[] {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const normalizedQuery = query.trim().toLowerCase()
  const terms = tokenize(normalizedQuery)
  if (terms.length === 0) return []

  return filterTemplates(templates, options)
    .map((template) => scoreTemplate(template, normalizedQuery, terms))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.template.id.localeCompare(right.template.id))
    .slice(0, limit)
}

export function tokenize(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9@/._-]+/)
        .filter((term) => term.length > 1),
    ),
  ]
}

function scoreTemplate(template: CatalogTemplate, query: string, terms: readonly string[]): SearchHit {
  const matched = new Set<string>()
  let score = 0
  const add = (points: number, field: string): void => {
    score += points
    matched.add(field)
  }

  const id = template.id.toLowerCase()
  const name = template.name.toLowerCase()
  const displayName = template.displayName?.toLowerCase() ?? ''
  const description = template.description.toLowerCase()
  const keywords = template.keywords.map((keyword) => keyword.toLowerCase())
  const dependencies = [...template.dependencies, ...template.devDependencies].map((dep) => dep.toLowerCase())
  const headings = template.readmeHeadings.map((heading) => heading.toLowerCase())

  if (id === query || name === query) add(100, 'id')
  else if (description.includes(query) || displayName === query) add(10, 'description')

  for (const term of terms) {
    if (id === term || name === term) add(40, 'id')
    else if (id.split('/').includes(term)) add(25, 'id')
    else if (id.includes(term)) add(12, 'id')
    if (displayName.includes(term)) add(8, 'displayName')
    if (keywords.includes(term)) add(12, 'keywords')
    else if (keywords.some((keyword) => keyword.includes(term))) add(5, 'keywords')
    if (description.includes(term)) add(4, 'description')
    if (dependencies.includes(term)) add(8, 'dependencies')
    else if (dependencies.some((dep) => dep.includes(term))) add(3, 'dependencies')
    if (headings.some((heading) => heading.includes(term))) add(3, 'readmeHeadings')
  }

  return { template, score, matched: [...matched].sort() }
}
