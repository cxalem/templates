/**
 * Templates MCP server over stdio.
 *
 * Usage: pnpm mcp [-- --root <templates-repo-dir>]
 *
 * Only stderr is used for logging; stdout carries the MCP protocol.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createTemplatesServer, SERVER_NAME, SERVER_VERSION } from './mcp/server.js'

const options = readOptions(process.argv.slice(2))
const server = createTemplatesServer(options.rootDir)

server
  .connect(new StdioServerTransport())
  .then(() => console.error(`${SERVER_NAME} ${SERVER_VERSION} serving ${options.rootDir} over stdio`))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })

type CliOptions = { readonly rootDir: string }

function readOptions(args: readonly string[]): CliOptions {
  let rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help') {
      console.log('Usage: pnpm mcp [-- --root <templates-repo-dir>]')
      process.exit(0)
    }
    if (argument === '--root') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      rootDir = resolve(value)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  return { rootDir }
}
