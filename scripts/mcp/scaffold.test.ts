import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadCatalog, type Catalog } from './catalog.js'
import { buildScaffoldCommand } from './scaffold.js'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('builds the create-solana-dapp command documented in README.md', () => {
  const catalog = realCatalog()
  const npm = buildScaffoldCommand(catalog, 'kit/nextjs', 'npm', 'my-app')
  assert.ok(npm.ok, npm.ok ? '' : npm.error)
  if (!npm.ok) return
  assert.equal(npm.value.command, 'npm create solana-dapp@latest -t gh:solana-foundation/templates/kit/nextjs my-app')
  assert.equal(npm.value.templateRef, 'gh:solana-foundation/templates/kit/nextjs')
  assert.equal(npm.value.projectName, 'my-app')

  const pnpm = buildScaffoldCommand(catalog, 'kit/nextjs', 'pnpm')
  assert.ok(pnpm.ok)
  if (pnpm.ok)
    assert.equal(
      pnpm.value.command,
      'pnpm create solana-dapp@latest -t gh:solana-foundation/templates/kit/nextjs nextjs',
    )

  const yarn = buildScaffoldCommand(catalog, 'kit/nextjs', 'yarn', 'demo')
  assert.ok(yarn.ok)
  if (yarn.ok)
    assert.equal(yarn.value.command, 'yarn create solana-dapp -t gh:solana-foundation/templates/kit/nextjs demo')
})

test('substitutes {pm} in post-create instructions', () => {
  const catalog = realCatalog()
  const withInstructions = catalog.templates.find(
    (template) => (template.createSolanaDapp?.instructions?.length ?? 0) > 0,
  )
  assert.ok(withInstructions, 'expected at least one template with create-solana-dapp instructions')
  const result = buildScaffoldCommand(catalog, withInstructions.id, 'pnpm')
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.value.nextSteps.length, withInstructions.createSolanaDapp?.instructions?.length)
  assert.ok(result.value.nextSteps.every((step) => !step.includes('{pm}')))
})

test('rejects unknown ids and unsafe project names', () => {
  const catalog = realCatalog()
  const unknown = buildScaffoldCommand(catalog, 'kit/does-not-exist', 'npm')
  assert.ok(!unknown.ok)
  if (!unknown.ok) assert.match(unknown.error, /Unknown template id/)

  const unsafe = buildScaffoldCommand(catalog, 'kit/nextjs', 'npm', 'my app; rm -rf /')
  assert.ok(!unsafe.ok)
  if (!unsafe.ok) assert.match(unsafe.error, /Invalid project name/)
})

function realCatalog(): Catalog {
  const catalog = loadCatalog(ROOT_DIR)
  if (!catalog.ok) throw new Error(catalog.error)
  return catalog.value
}
