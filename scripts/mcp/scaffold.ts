/**
 * Build the create-solana-dapp command for a template.
 *
 * The flag and giget reference follow README.md: `npm create solana-dapp@latest -t gh:<repo>/<path>`.
 */

import { err, ok, type Result } from '../shared/result.js'
import type { Catalog } from './catalog.js'
import { findTemplate, type PackageManager } from './catalog.js'

export type ScaffoldCommand = {
  readonly id: string
  readonly templateRef: string
  readonly packageManager: PackageManager
  readonly projectName: string
  readonly command: string
  readonly nextSteps: readonly string[]
}

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn']

const GIGET_PREFIX = 'gh:'
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

const CREATE_COMMANDS: Readonly<Record<PackageManager, string>> = {
  npm: 'npm create solana-dapp@latest',
  pnpm: 'pnpm create solana-dapp@latest',
  yarn: 'yarn create solana-dapp',
}

export function buildScaffoldCommand(
  catalog: Catalog,
  id: string,
  packageManager: PackageManager = 'npm',
  projectName?: string,
): Result<ScaffoldCommand> {
  const template = findTemplate(catalog, id)
  if (!template.ok) return template

  const name = (projectName ?? template.value.id.split('/').pop() ?? 'my-app').trim()
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return err(`Invalid project name "${name}": use letters, numbers, dots, dashes and underscores only.`)
  }

  const templateRef = `${GIGET_PREFIX}${catalog.repositoryName}/${template.value.id}`
  const instructions = template.value.createSolanaDapp?.instructions ?? []

  return ok({
    id: template.value.id,
    templateRef,
    packageManager,
    projectName: name,
    command: `${CREATE_COMMANDS[packageManager]} -t ${templateRef} ${name}`,
    nextSteps: instructions.map((step) => step.replaceAll('{pm}', packageManager)),
  })
}
