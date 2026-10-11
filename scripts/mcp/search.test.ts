import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CatalogTemplate } from './catalog.js'
import { filterTemplates, searchTemplates, tokenize } from './search.js'

const templates: readonly CatalogTemplate[] = [
  fixture({
    id: 'kit/nextjs',
    name: 'nextjs',
    description: 'Next.js, Tailwind, @solana/kit wallet',
    keywords: ['kit', 'nextjs'],
    dependencies: ['next'],
  }),
  fixture({
    id: 'kit/nextjs-anchor',
    name: 'nextjs-anchor',
    description: 'Next.js with an Anchor program',
    keywords: ['kit', 'nextjs', 'anchor'],
    dependencies: ['next', '@coral-xyz/anchor'],
  }),
  fixture({
    id: 'mobile/kit-expo-minimal',
    name: 'kit-expo-minimal',
    kind: 'expo',
    group: 'mobile',
    keywords: ['expo'],
    dependencies: ['expo'],
  }),
  fixture({
    id: 'community/supabase-auth',
    name: 'supabase-auth',
    group: 'community',
    description: 'Sign in with Solana backed by Supabase',
    keywords: ['supabase'],
    readmeHeadings: ['Supabase setup'],
    needsSecrets: true,
  }),
]

test('an exact id match ranks first', () => {
  const hits = searchTemplates(templates, 'kit/nextjs')
  assert.equal(hits[0]?.template.id, 'kit/nextjs')
  assert.ok(hits[0].score > (hits[1]?.score ?? 0))
  assert.ok(hits[0].matched.includes('id'))
})

test('an exact name match ranks first', () => {
  assert.equal(searchTemplates(templates, 'nextjs-anchor')[0]?.template.id, 'kit/nextjs-anchor')
})

test('keyword, dependency and README heading matches contribute to the score', () => {
  assert.equal(searchTemplates(templates, 'anchor program')[0]?.template.id, 'kit/nextjs-anchor')
  assert.equal(searchTemplates(templates, 'supabase')[0]?.template.id, 'community/supabase-auth')
  assert.ok(searchTemplates(templates, 'supabase')[0]?.matched.includes('readmeHeadings'))
  assert.deepEqual(searchTemplates(templates, 'zzz-no-match'), [])
  assert.deepEqual(searchTemplates(templates, '   '), [])
})

test('filters and limit apply before ranking', () => {
  const hits = searchTemplates(templates, 'kit', { kind: 'expo' })
  assert.deepEqual(
    hits.map((hit) => hit.template.id),
    ['mobile/kit-expo-minimal'],
  )
  assert.equal(searchTemplates(templates, 'nextjs', { limit: 1 }).length, 1)
  assert.equal(filterTemplates(templates, { group: 'kit' }).length, 2)
  assert.equal(filterTemplates(templates, { needsSecrets: true }).length, 1)
})

test('tokenize keeps scoped package names and drops noise', () => {
  assert.deepEqual(tokenize('Next.js + @solana/kit, wallet!'), ['next.js', '@solana/kit', 'wallet'])
})

function fixture(overrides: Partial<CatalogTemplate> & { id: string; name: string }): CatalogTemplate {
  return {
    group: 'kit',
    dir: `/repo/${overrides.id}`,
    description: '',
    keywords: [],
    kind: 'next',
    scripts: {},
    dependencies: [],
    devDependencies: [],
    packageManager: 'npm',
    createSolanaDapp: null,
    readmePath: 'README.md',
    readmeHeadings: [],
    hasOgImage: true,
    needsSecrets: false,
    credentialKeys: [],
    ...overrides,
  }
}
