#!/usr/bin/env node
/**
 * Inline src/logic.js into the client factory.
 *
 * The DSH browser module loader only answers require() for platform seeds
 * (react) and registered bundles, so a plugin's client half cannot import a
 * sibling file. The pure logic therefore lives in logic.js (unit tested
 * directly) and is textually inlined into dist/client.js at build time.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marker = '// __LOGIC_BUNDLE__'

const logic = await readFile(join(root, 'src/logic.js'), 'utf8')
if (/^\s*import\s/m.test(logic)) throw new Error('src/logic.js must stay dependency-free (no imports)')
if (/^\s*export\s+default\s/m.test(logic)) throw new Error('src/logic.js must use named exports only')
const inlined = logic.replace(/^export\s+/gm, '').trimEnd()

const template = await readFile(join(root, 'src/client.template.js'), 'utf8')
if (!template.includes(marker)) throw new Error(`src/client.template.js is missing the ${marker} marker`)

const output = template.replace(marker, inlined)
if (!output.includes('__ModuleLoader__.load')) throw new Error('built bundle does not register through __ModuleLoader__')
if (output.includes('export ')) throw new Error('built bundle still contains an ES module export')

const target = join(root, 'dist/client.js')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, output)
console.log(`Built ${target} (${Buffer.byteLength(output)} bytes)`)
