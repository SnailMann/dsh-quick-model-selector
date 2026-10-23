#!/usr/bin/env node
/**
 * Register this source directory with a local DSH profile.
 *
 * What it writes:
 *   1. `<profile>/package.json` — a `link:<root>` dependency and one entry in
 *      the ordered `dsh.profile.bundles` list, so the plugin is a real profile
 *      layer and shows up in the plugin inventory.
 *   2. `<profile>/node_modules/dsh-quick-model-selector` — a managed symlink.
 *   3. `<profile>/cordis.patch.yml` — only to *remove* the legacy managed
 *      `- insert:` block written by older versions of this script. The row
 *      itself now comes from the bundle layer, so re-inserting it here would
 *      register the seat twice.
 *
 * What it does NOT do: reinstall profile dependencies, modify the signed app
 * bundle, or touch any user-owned entry.
 */
import { readFile, writeFile, mkdir, rename, stat, unlink, symlink, lstat, readlink, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const PACKAGE = 'dsh-quick-model-selector'
const ENTRY_ID = 'quick-model-selector'

const args = process.argv.slice(2)
const argument = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const home = argument('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), 'Library/Application Support/dsh-desktop/harness')
const profile = argument('--profile') ?? 'web'
if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('Invalid profile name')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const removing = args.includes('--remove')
const dryRun = args.includes('--dry-run')

await access(join(root, 'dist/client.js')).catch(() => {
  throw new Error('dist/client.js is missing — run `npm run build` first')
})

const profileDir = join(home, 'profiles', profile)
const packageLink = join(profileDir, 'node_modules', PACKAGE)
const patchPath = join(profileDir, 'cordis.patch.yml')
const manifestPath = join(profileDir, 'package.json')

// --- managed symlink -------------------------------------------------------
const linkState = await lstat(packageLink).catch(error => {
  if (error.code === 'ENOENT') return undefined
  throw error
})
if (linkState && !linkState.isSymbolicLink()) throw new Error('Existing local plugin path is not a managed symlink; no files changed')
const linkTarget = linkState ? resolve(dirname(packageLink), await readlink(packageLink)) : undefined
if (linkTarget && linkTarget !== root) throw new Error('Another directory owns the local plugin symlink; remove it from its original directory first')

// --- profile manifest ------------------------------------------------------
const oldManifest = await readFile(manifestPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return undefined
  throw error
})
const manifest = oldManifest === undefined ? { name: `dsh-profile-${profile}`, private: true } : JSON.parse(oldManifest)
const localSpec = `link:${root}`
const recorded = manifest.dependencies?.[PACKAGE]
if (recorded !== undefined && recorded !== localSpec) throw new Error('Another installation owns the profile dependency; no files changed')
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!Array.isArray(bundles)) throw new Error('Profile bundles must be an array; no files changed')

if (removing) {
  if (recorded !== undefined) delete manifest.dependencies[PACKAGE]
} else {
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: localSpec }
}
const nextBundles = removing
  ? bundles.filter(name => name !== PACKAGE)
  : bundles.includes(PACKAGE) ? bundles : [...bundles, PACKAGE]
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: nextBundles } }
const manifestChanged = oldManifest === undefined || JSON.stringify(JSON.parse(oldManifest)) !== JSON.stringify(manifest)
const nextManifest = manifestChanged ? `${JSON.stringify(manifest, null, 2)}\n` : oldManifest

// --- legacy cordis.patch.yml block ----------------------------------------
const begin = `# BEGIN managed ${PACKAGE}`
const end = `# END managed ${PACKAGE}`
let previous
try {
  previous = await readFile(patchPath, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  previous = ''
}
let next = previous
const start = next.indexOf(begin)
const hasManagedBlock = start >= 0
if (hasManagedBlock) {
  const finish = next.indexOf(end, start)
  if (finish < 0) throw new Error('Managed plugin block is incomplete; no files changed')
  next = next.slice(0, start) + next.slice(finish + end.length).replace(/^\r?\n/, '')
  if (!next.split(/\r?\n/).some(line => line.trim() && !line.trimStart().startsWith('#'))) next = `${next.trimEnd()}\n[]\n`.trimStart()
}
const patchChanged = next !== previous

if (!removing && !hasManagedBlock && /^\s*-\s*id:\s*['"]?quick-model-selector['"]?\s*$/m.test(next)) {
  throw new Error('A user-owned entry with this ID already exists; no files changed')
}

if (next === previous && !manifestChanged && (linkState === undefined) === removing) {
  console.log('Registration already matches; unchanged')
  process.exit(0)
}

if (dryRun) {
  console.log(`${removing ? 'Would unregister' : 'Would register'} plugin in profile ${profileDir}`)
  console.log(`Profile dependency: ${PACKAGE}@${localSpec}`)
  console.log(`Profile bundles: ${nextBundles.join(', ') || '(none)'}`)
  console.log(`Managed symlink: ${packageLink}`)
  if (patchChanged) console.log(`Would ${removing || hasManagedBlock ? 'remove' : 'leave'} legacy block in ${patchPath}`)
  process.exit(0)
}

// --- commit ---------------------------------------------------------------
await mkdir(profileDir, { recursive: true })
const stamp = Date.now()
const backups = []
const writeBackup = async (path, contents) => {
  const backup = `${path}.${PACKAGE}.backup-${stamp}`
  await writeFile(backup, contents, { mode: 0o600, flag: 'wx' })
  backups.push(backup)
}
if (patchChanged && previous) await writeBackup(patchPath, previous)
if (manifestChanged && oldManifest !== undefined) await writeBackup(manifestPath, oldManifest)

const modeOf = async path => (await stat(path).catch(() => ({ mode: 0o600 }))).mode & 0o777
const patchTemporary = `${patchPath}.${randomUUID()}.tmp`
const manifestTemporary = `${manifestPath}.${randomUUID()}.tmp`
let createdLink = false
let patchCommitted = false
let manifestCommitted = false
try {
  if (patchChanged) await writeFile(patchTemporary, next, { mode: await modeOf(patchPath), flag: 'wx' })
  if (manifestChanged) await writeFile(manifestTemporary, nextManifest, { mode: await modeOf(manifestPath), flag: 'wx' })
  const currentPatch = await readFile(patchPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (currentPatch !== previous) throw new Error('Profile config changed concurrently; no changes committed')
  const currentManifest = await readFile(manifestPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (currentManifest !== oldManifest) throw new Error('Profile manifest changed concurrently; no changes committed')
  if (!removing && linkState === undefined) {
    await mkdir(dirname(packageLink), { recursive: true })
    await symlink(root, packageLink, 'dir')
    createdLink = true
  }
  if (manifestChanged) {
    await rename(manifestTemporary, manifestPath)
    manifestCommitted = true
  }
  if (patchChanged) {
    await rename(patchTemporary, patchPath)
    patchCommitted = true
  }
  if (removing && linkState) await unlink(packageLink)
} catch (error) {
  if (patchCommitted) {
    if (previous === '') await unlink(patchPath).catch(() => {})
    else await writeFile(patchPath, previous, { mode: 0o600 })
  }
  if (manifestCommitted) {
    if (oldManifest === undefined) await unlink(manifestPath).catch(() => {})
    else await writeFile(manifestPath, oldManifest, { mode: 0o600 })
  }
  if (createdLink) await unlink(packageLink).catch(() => {})
  throw error
} finally {
  await unlink(patchTemporary).catch(() => {})
  await unlink(manifestTemporary).catch(() => {})
}

console.log(`${removing ? 'Unregistered' : 'Registered'} local plugin: ${PACKAGE}@${localSpec}`)
console.log(`Profile bundles: ${nextBundles.join(', ') || '(none)'}`)
if (hasManagedBlock && !removing) console.log(`Removed legacy row from ${patchPath} — the bundle layer now inserts it`)
for (const backup of backups) console.log(`Backup: ${backup}`)
console.log('Restart DSH Desktop once to apply this change.')
