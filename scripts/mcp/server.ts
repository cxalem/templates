/**
 * MCP server exposing the templates catalog, template files, scaffold commands and the latest health report.
 *
 * Every tool answers with JSON text content. Failures are returned as tool errors (`isError: true`) with a
 * message the calling agent can act on; nothing is thrown out of a handler.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { join } from 'path'
import { z } from 'zod'
import { err, ok, type Result } from '../shared/result.js'
import { findTemplate, loadCatalog, type Catalog, type CatalogTemplate } from './catalog.js'
import { DEFAULT_MAX_DEPTH, listTemplateFiles, MAX_DEPTH, readTemplateFile } from './files.js'
import { findTemplateHealth, HEALTH_REPORTS_DIRNAME, loadLatestHealthReport, summarizeHealthReport } from './health.js'
import { buildScaffoldCommand, PACKAGE_MANAGERS } from './scaffold.js'
import { filterTemplates, searchTemplates } from './search.js'

export const SERVER_NAME = 'solana-templates'
export const SERVER_VERSION = '1.0.0'
export const CATALOG_RESOURCE_URI = 'templates://catalog'
export const README_RESOURCE_TEMPLATE = 'template://{+id}/readme'

const TEMPLATE_KINDS = ['next', 'vite', 'expo', 'rust', 'node', 'unknown'] as const

const idSchema = z.string().min(1).describe('Group-relative template id, for example "kit/nextjs".')
const groupSchema = z.string().min(1).describe('Group path from root package.json repokit.groups, e.g. "kit".')
const kindSchema = z.enum(TEMPLATE_KINDS).describe('Framework classification of the template.')

/** The template fields exposed to clients (absolute directories stay private). */
export type PublicTemplate = Omit<CatalogTemplate, 'dir'>

export function createTemplatesServer(rootDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const healthReportsDir = join(rootDir, HEALTH_REPORTS_DIRNAME)

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'List every template in the solana-foundation/templates catalog with its id, kind, group, description and keywords. Optional filters narrow by group, kind or whether the template needs credentials.',
      inputSchema: {
        group: groupSchema.optional(),
        kind: kindSchema.optional(),
        needsSecrets: z
          .boolean()
          .optional()
          .describe('Keep only templates that need (true) or do not need (false) credentials.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ group, kind, needsSecrets }) =>
      respond(
        withCatalog(rootDir, (catalog) => {
          const templates = filterTemplates(catalog.templates, { group, kind, needsSecrets })
          return ok({
            groups: catalog.groups,
            total: templates.length,
            templates: templates.map(toListEntry),
          })
        }),
      ),
  )

  server.registerTool(
    'search_templates',
    {
      title: 'Search templates',
      description:
        'Keyword search over template ids, names, descriptions, keywords, dependency names and README headings. Returns ranked hits with the fields that matched.',
      inputSchema: {
        query: z.string().min(1).describe('Free text, for example "anchor nextjs" or "expo wallet".'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum hits to return (default 10).'),
        group: groupSchema.optional(),
        kind: kindSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, group, kind }) =>
      respond(
        withCatalog(rootDir, (catalog) =>
          ok({
            query,
            hits: searchTemplates(catalog.templates, query, { limit, group, kind }).map((hit) => ({
              ...toListEntry(hit.template),
              score: hit.score,
              matched: hit.matched,
            })),
          }),
        ),
      ),
  )

  server.registerTool(
    'get_template',
    {
      title: 'Get template',
      description:
        'Full metadata for one template: package scripts, dependency names, create-solana-dapp instructions and rename rules, README headings, credential requirements and the default scaffold command.',
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      respond(
        withCatalog(rootDir, (catalog) => {
          const template = findTemplate(catalog, id)
          if (!template.ok) return template
          const scaffold = buildScaffoldCommand(catalog, template.value.id, template.value.packageManager)
          return ok({
            ...toPublic(template.value),
            scaffoldCommand: scaffold.ok ? scaffold.value.command : undefined,
          })
        }),
      ),
  )

  server.registerTool(
    'list_template_files',
    {
      title: 'List template files',
      description:
        'List files and directories inside a template (install and build output, .git and env files are skipped). Depth and entry counts are capped; "truncated" tells you when the listing is partial.',
      inputSchema: {
        id: idSchema,
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .optional()
          .describe(`Directory depth to descend (default ${DEFAULT_MAX_DEPTH}).`),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, maxDepth }) =>
      respond(
        withCatalog(rootDir, (catalog) => {
          const template = findTemplate(catalog, id)
          if (!template.ok) return template
          const listing = listTemplateFiles(template.value, { maxDepth })
          return listing.ok ? ok({ id: template.value.id, ...listing.value }) : listing
        }),
      ),
  )

  server.registerTool(
    'get_template_file',
    {
      title: 'Get template file',
      description:
        'Read one text file from a template by template-relative path. Env files, install and build output, binaries and files above 200 KB are refused.',
      inputSchema: {
        id: idSchema,
        path: z.string().min(1).describe('Template-relative path, for example "README.md" or "src/app/page.tsx".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, path }) =>
      respond(
        withCatalog(rootDir, (catalog) => {
          const template = findTemplate(catalog, id)
          if (!template.ok) return template
          const file = readTemplateFile(template.value, path)
          return file.ok ? ok({ id: template.value.id, ...file.value }) : file
        }),
      ),
  )

  server.registerTool(
    'get_scaffold_command',
    {
      title: 'Get scaffold command',
      description:
        'Build the create-solana-dapp command that scaffolds a template into a new project directory, plus the post-create steps the template declares. The command is returned as text; nothing is executed.',
      inputSchema: {
        id: idSchema,
        packageManager: z
          .enum(PACKAGE_MANAGERS)
          .optional()
          .describe(
            'Package manager to invoke create-solana-dapp with (default: the one the template pins, else npm).',
          ),
        projectName: z
          .string()
          .min(1)
          .max(214)
          .optional()
          .describe('Directory name for the new project (default: template directory name).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, packageManager, projectName }) =>
      respond(
        withCatalog(rootDir, (catalog) => {
          const template = findTemplate(catalog, id)
          if (!template.ok) return template
          return buildScaffoldCommand(
            catalog,
            template.value.id,
            packageManager ?? template.value.packageManager,
            projectName,
          )
        }),
      ),
  )

  server.registerTool(
    'get_health_summary',
    {
      title: 'Get health summary',
      description:
        'Summary of the most recent `pnpm health` report (health-reports/<timestamp>.json): pass/warn/fail counts and per-template dimension statuses. Reports are generated locally and never committed, so the answer may say none is available.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const loaded = loadLatestHealthReport(healthReportsDir)
      if (!loaded.available) return jsonResult(loaded)
      return jsonResult({ available: true, ...summarizeHealthReport(loaded.reportPath, loaded.report) })
    },
  )

  server.registerTool(
    'get_template_health',
    {
      title: 'Get template health',
      description:
        'The full health check record for one template from the most recent `pnpm health` report: build, rust, boot, deps, audit, deprecation and doc drift results.',
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const loaded = loadLatestHealthReport(healthReportsDir)
      if (!loaded.available) return jsonResult(loaded)
      const template = findTemplateHealth(loaded.report, id.trim().replace(/^\/+|\/+$/g, ''))
      if (!template) {
        return errorResult(
          `Template "${id}" is not in the latest health report (${loaded.reportPath}). Check the id with list_templates or rerun \`pnpm health --only ${id}\`.`,
        )
      }
      return jsonResult({
        available: true,
        reportPath: loaded.reportPath,
        generatedAt: loaded.report.generatedAt,
        template,
      })
    },
  )

  server.registerResource(
    'catalog',
    CATALOG_RESOURCE_URI,
    {
      title: 'Templates catalog',
      description: 'JSON catalog of every template with metadata, classification and credential requirements.',
      mimeType: 'application/json',
    },
    (uri) => {
      const catalog = loadCatalog(rootDir)
      if (!catalog.ok) throw new Error(catalog.error)
      const payload = { ...catalog.value, templates: catalog.value.templates.map(toPublic) }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: stringify(payload) }] }
    },
  )

  server.registerResource(
    'readme',
    new ResourceTemplate(README_RESOURCE_TEMPLATE, {
      list: () => {
        const catalog = loadCatalog(rootDir)
        if (!catalog.ok) return { resources: [] }
        return {
          resources: catalog.value.templates
            .filter((template) => template.readmePath !== null)
            .map((template) => ({
              uri: readmeUri(template.id),
              name: `${template.id} README`,
              description: template.description,
              mimeType: 'text/markdown',
            })),
        }
      },
    }),
    { title: 'Template README', description: 'README.md of one template.', mimeType: 'text/markdown' },
    (uri, { id }) => {
      const catalog = loadCatalog(rootDir)
      if (!catalog.ok) throw new Error(catalog.error)
      const template = findTemplate(catalog.value, String(id))
      if (!template.ok) throw new Error(template.error)
      if (!template.value.readmePath) throw new Error(`Template ${template.value.id} has no README`)
      const file = readTemplateFile(template.value, template.value.readmePath)
      if (!file.ok) throw new Error(file.error)
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: file.value.content }] }
    },
  )

  return server
}

export function readmeUri(id: string): string {
  return README_RESOURCE_TEMPLATE.replace('{+id}', id)
}

export function toPublic(template: CatalogTemplate): PublicTemplate {
  const { dir: _dir, ...rest } = template
  return rest
}

function toListEntry(template: CatalogTemplate) {
  return {
    id: template.id,
    name: template.name,
    displayName: template.displayName,
    description: template.description,
    usecase: template.usecase,
    group: template.group,
    kind: template.kind,
    keywords: template.keywords,
    packageManager: template.packageManager,
    needsSecrets: template.needsSecrets,
  }
}

function withCatalog<T>(rootDir: string, fn: (catalog: Catalog) => Result<T>): Result<T> {
  try {
    const catalog = loadCatalog(rootDir)
    return catalog.ok ? fn(catalog.value) : catalog
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

function respond<T>(result: Result<T>): CallToolResult {
  return result.ok ? jsonResult(result.value) : errorResult(result.error)
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: stringify(value) }] }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
