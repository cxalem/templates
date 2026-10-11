import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { CATALOG_RESOURCE_URI, readmeUri } from './server.js'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = join(ROOT_DIR, 'scripts', 'mcp-server.ts')

const client = new Client({ name: 'templates-mcp-test', version: '0.0.0' })

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', ENTRY, '--root', ROOT_DIR],
    cwd: ROOT_DIR,
    stderr: 'pipe',
  })
  await client.connect(transport)
})

after(async () => {
  await client.close()
})

test('lists the expected tools and resources over stdio', async () => {
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'get_health_summary',
    'get_scaffold_command',
    'get_template',
    'get_template_file',
    'get_template_health',
    'list_template_files',
    'list_templates',
    'search_templates',
  ])
  assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true))

  const resources = await client.listResources()
  assert.ok(resources.resources.some((resource) => resource.uri === CATALOG_RESOURCE_URI))
  assert.ok(resources.resources.some((resource) => resource.uri === readmeUri('kit/nextjs')))
  const templates = await client.listResourceTemplates()
  assert.ok(templates.resourceTemplates.some((template) => template.uriTemplate === 'template://{+id}/readme'))
})

test('list_templates and get_template return parsable JSON', async () => {
  const list = parseJson(await client.callTool({ name: 'list_templates', arguments: { kind: 'next', group: 'kit' } }))
  assert.ok(list.total >= 1)
  assert.ok(
    list.templates.every(
      (template: { kind: string; group: string }) => template.kind === 'next' && template.group === 'kit',
    ),
  )
  assert.ok(list.templates.some((template: { id: string }) => template.id === 'kit/nextjs'))

  const template = parseJson(await client.callTool({ name: 'get_template', arguments: { id: 'kit/nextjs' } }))
  assert.equal(template.id, 'kit/nextjs')
  assert.equal(template.kind, 'next')
  assert.equal(template.dir, undefined, 'absolute directories must not be exposed')
  assert.ok(Array.isArray(template.dependencies))
  assert.equal(
    template.scaffoldCommand,
    'npm create solana-dapp@latest -t gh:solana-foundation/templates/kit/nextjs nextjs',
  )
})

test('search, files, scaffold and health tools answer over stdio', async () => {
  const search = parseJson(
    await client.callTool({ name: 'search_templates', arguments: { query: 'kit/nextjs', limit: 3 } }),
  )
  assert.equal(search.hits[0].id, 'kit/nextjs')
  assert.ok(search.hits.length <= 3)

  const listing = parseJson(
    await client.callTool({ name: 'list_template_files', arguments: { id: 'kit/nextjs', maxDepth: 1 } }),
  )
  assert.ok(listing.files.some((file: { path: string }) => file.path === 'package.json'))

  const file = parseJson(
    await client.callTool({ name: 'get_template_file', arguments: { id: 'kit/nextjs', path: 'package.json' } }),
  )
  assert.equal(JSON.parse(file.content).name, 'nextjs')

  const scaffold = parseJson(
    await client.callTool({
      name: 'get_scaffold_command',
      arguments: { id: 'kit/nextjs', packageManager: 'pnpm', projectName: 'demo' },
    }),
  )
  assert.equal(scaffold.command, 'pnpm create solana-dapp@latest -t gh:solana-foundation/templates/kit/nextjs demo')

  const health = parseJson(await client.callTool({ name: 'get_health_summary', arguments: {} }))
  assert.equal(typeof health.available, 'boolean')
  if (!health.available) assert.match(health.note, /pnpm health/)
})

test('errors come back as tool errors instead of protocol failures', async () => {
  const unknown = await client.callTool({ name: 'get_template', arguments: { id: 'kit/does-not-exist' } })
  assert.equal(unknown.isError, true)
  assert.match(textOf(unknown), /Unknown template id/)

  const traversal = await client.callTool({
    name: 'get_template_file',
    arguments: { id: 'kit/nextjs', path: '../../package.json' },
  })
  assert.equal(traversal.isError, true)
  assert.match(textOf(traversal), /traversal/i)

  const env = await client.callTool({ name: 'get_template_file', arguments: { id: 'kit/nextjs', path: '.env' } })
  assert.equal(env.isError, true)
})

test('resources serve the catalog and a template README', async () => {
  const catalog = await client.readResource({ uri: CATALOG_RESOURCE_URI })
  const parsed = JSON.parse(resourceText(catalog.contents[0]))
  assert.ok(parsed.templates.length >= 30)
  assert.equal(parsed.templates[0].dir, undefined)

  const readme = await client.readResource({ uri: readmeUri('kit/nextjs') })
  assert.equal(readme.contents[0].mimeType, 'text/markdown')
  assert.match(resourceText(readme.contents[0]), /#/)
})

function parseJson(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.notEqual(result.isError, true, textOf(result))
  return JSON.parse(textOf(result))
}

function resourceText(content: { readonly text?: string; readonly blob?: string }): string {
  assert.equal(typeof content.text, 'string', 'expected a text resource')
  return content.text ?? ''
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as readonly { type: string; text?: string }[]
  return content.map((item) => item.text ?? '').join('\n')
}
