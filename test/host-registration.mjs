// Run with DSH Desktop's Electron as Node: verifies the installed desktop's
// real plugin inventory and bundle composition for this package.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" \
//     test/host-registration.mjs
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = 'dsh-quick-model-selector'
const resources = '/Applications/DSH Desktop.app/Contents/Resources'
const anchor = `${resources}/app.asar/node_modules/@deepseek-ai/dsh/package.json`
const { registerHostModuleFallback } = await import(pathToFileURL(`${resources}/host-module-fallback.mjs`))
registerHostModuleFallback(`${resources}/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js`)

const { loadProfileDirectory, composeEntries, readPluginMeta } = await import('@deepseek-ai/dsh-app-boot')
const { PluginManager } = await import('@deepseek-ai/dsh-plugin-manager')
const home = await mkdtemp(join(tmpdir(), 'dsh-qms-registration-'))
const dir = join(home, 'profiles/web')
try {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'registration-test', private: true, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(dir, 'cordis.patch.yml'), '# user configuration\n- id: existing\n  config: {}\n')

  const script = fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, '--dsh-home', home], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  assert.equal(run.status, 0, run.stderr)

  const manager = Object.assign(Object.create(PluginManager.prototype), {
    profile: { dir, installAnchor: anchor },
    protectsManager: () => false,
    declaredRows: () => ({ rows: [], overrides: [] }),
  })
  const row = (await manager.listBundles()).find(item => item.name === PACKAGE)
  assert.ok(row, 'the local package appears in the real desktop plugin inventory')
  assert.equal(row.installed, true)
  assert.equal(row.enabled, true)
  assert.equal(row.error, undefined)
  assert.equal(row.meta.title.zh, PACKAGE)
  assert.equal(row.meta.title.en, PACKAGE)

  const meta = readPluginMeta(PACKAGE, pathToFileURL(join(dir, 'package.json')).href)
  assert.equal(meta.title.zh, PACKAGE)
  assert.equal(meta.title.en, PACKAGE)
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.equal(row.meta.description.zh, zh.meta.description)
  assert.equal(row.meta.description.en, en.meta.description)
  assert.equal(meta.error, undefined)
  assert.match(meta.icon ?? '', /^data:image\/png;base64,/, 'the package exports its own icon')
  assert.match(row.meta.icon ?? '', /^data:image\/png;base64,/, 'the plugin list row renders the exported icon')

  let profile = loadProfileDirectory('dsh', dir, anchor)
  let entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const ours = entries.filter(entry => entry.name === PACKAGE)
  assert.equal(ours.length, 1, 'the bundle layer inserts exactly one row')
  assert.equal(ours[0].id, 'quick-model-selector')
  assert.equal(ours[0].__dshPluginOwner.packageName, PACKAGE)

  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles = []
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
  profile = loadProfileDirectory('dsh', dir, anchor)
  entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  assert.equal(entries.filter(entry => entry.name === PACKAGE).length, 0, 'switching the bundle off removes the row')
  assert.equal((await manager.listBundles()).find(item => item.name === PACKAGE).enabled, false)

  console.log('PASS: real desktop inventory discovers the plugin; enabled composes one row, disabled composes none')
} finally {
  await rm(home, { recursive: true, force: true })
}
