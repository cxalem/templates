/**
 * Safe file access inside a template directory.
 *
 * Every path is resolved against the template directory and rejected when it escapes it (including through
 * symlinks), names an env file, points into install or build output, is binary, or exceeds the size cap.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { err, ok, type Result } from '../shared/result.js'
import type { CatalogTemplate } from './catalog.js'

export type TemplateFile = {
  readonly path: string
  readonly size: number
  readonly content: string
}

export type TemplateFileEntry = {
  readonly path: string
  readonly size: number
}

export type TemplateFileListing = {
  readonly files: readonly TemplateFileEntry[]
  readonly directories: readonly string[]
  readonly truncated: boolean
}

export type ListOptions = {
  readonly maxDepth?: number
  readonly maxEntries?: number
}

export const MAX_FILE_BYTES = 200_000
export const DEFAULT_MAX_DEPTH = 3
export const MAX_DEPTH = 8
export const DEFAULT_MAX_ENTRIES = 500
export const MAX_ENTRIES = 2000

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.expo',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])
const ENV_FILE_PATTERN = /^\.env(\..*)?$/i
const BINARY_SNIFF_BYTES = 8000

/** Resolve a template-relative path to an absolute path, or explain why it is not allowed. */
export function resolveTemplateFile(template: CatalogTemplate, relativePath: string): Result<string> {
  const requested = relativePath.trim()
  if (requested.length === 0) return err('A template-relative file path is required, for example "README.md".')
  if (isAbsolute(requested) || /^[a-zA-Z]:[\\/]/.test(requested)) {
    return err(`Absolute paths are not allowed; pass a path relative to the template directory: ${requested}`)
  }

  const segments = normalize(requested)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    return err(`Path traversal is not allowed; the path must stay inside the template directory: ${requested}`)
  }
  const denied = segments.find((segment) => IGNORED_DIRECTORIES.has(segment) || ENV_FILE_PATTERN.test(segment))
  if (denied) return err(`Access to "${denied}" is not allowed (env files, install and build output are hidden).`)

  const templateDir = resolve(template.dir)
  const target = resolve(templateDir, ...segments)
  if (!isInside(templateDir, target)) return err(`Path escapes the template directory: ${requested}`)

  let realTarget: string
  try {
    realTarget = realpathSync(target)
  } catch {
    return err(`File not found in template ${template.id}: ${segments.join('/')}`)
  }
  if (!isInside(realpathSync(templateDir), realTarget)) {
    return err(`Path resolves outside the template directory through a symlink: ${requested}`)
  }

  return ok(target)
}

export function readTemplateFile(template: CatalogTemplate, relativePath: string): Result<TemplateFile> {
  const resolved = resolveTemplateFile(template, relativePath)
  if (!resolved.ok) return resolved

  const stats = statSync(resolved.value)
  if (!stats.isFile()) {
    return err(`Not a file: ${relativePath}. Use list_template_files to browse directories.`)
  }
  if (stats.size > MAX_FILE_BYTES) {
    return err(`File is ${stats.size} bytes, above the ${MAX_FILE_BYTES} byte cap: ${relativePath}`)
  }

  const bytes = readFileSync(resolved.value)
  if (looksBinary(bytes)) return err(`Binary files are not served: ${relativePath}`)

  return ok({
    path: toPosix(relative(resolve(template.dir), resolved.value)),
    size: stats.size,
    content: bytes.toString('utf-8'),
  })
}

export function listTemplateFiles(template: CatalogTemplate, options: ListOptions = {}): Result<TemplateFileListing> {
  const maxDepth = clamp(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH)
  const maxEntries = clamp(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES)
  const templateDir = resolve(template.dir)
  const files: TemplateFileEntry[] = []
  const directories: string[] = []
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => compareNames(left.name, right.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length + directories.length >= maxEntries) {
        truncated = true
        return
      }
      const absolute = join(dir, entry.name)
      const relativePath = toPosix(relative(templateDir, absolute))
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        directories.push(relativePath)
        if (depth < maxDepth) walk(absolute, depth + 1)
        else truncated = true
        continue
      }
      if (!entry.isFile() || ENV_FILE_PATTERN.test(entry.name)) continue
      files.push({ path: relativePath, size: fileSize(absolute) })
    }
  }

  walk(templateDir, 1)
  return ok({ files, directories, truncated })
}

export function isEnvFile(name: string): boolean {
  return ENV_FILE_PATTERN.test(basename(name))
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, BINARY_SNIFF_BYTES)
  return sample.includes(0)
}

/** Byte-order comparison so listings are stable across locales. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fileSize(path: string): number {
  try {
    return lstatSync(path).size
  } catch {
    return 0
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(value), max))
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
