import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url))
const PACKAGE = 'dsh-quick-model-selector'

test('installer registers the profile dependency and bundle, then removes both', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-qms-installer-'))
  const dir = join(home, 'profiles/web')
  const patch = join(dir, 'cordis.patch.yml')
  const manifestPath = join(dir, 'package.json')
  const link = join(dir, 'node_modules', PACKAGE)
  const previous = '# user configuration\n- id: existing\n  config:\n    custom: !!js "some.expression"\n'
  const manifest = { name: 'dsh-profile-web', private: true, dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['other'], retained: true }, desktop: { retained: true } } }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(patch, previous)
    await writeFile(manifestPath, JSON.stringify(manifest))
    const run = (...args) => spawnSync(process.execPath, [script, '--dsh-home', home, ...args], { encoding: 'utf8' })

    const dry = run('--dry-run')
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(await readFile(patch, 'utf8'), previous)
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest)

    const install = run()
    assert.equal(install.status, 0, install.stderr)
    assert.equal(await readFile(patch, 'utf8'), previous, 'the row comes from the bundle layer, not the patch')
    const installed = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.match(installed.dependencies[PACKAGE], /^link:/)
    assert.equal(installed.dependencies.other, '1.0.0')
    assert.deepEqual(installed.dsh.profile.bundles, ['other', PACKAGE])
    assert.equal(installed.dsh.profile.retained, true)
    assert.equal(installed.dsh.desktop.retained, true)
    assert.ok((await lstat(link)).isSymbolicLink())

    const repeat = run()
    assert.equal(repeat.status, 0, repeat.stderr)
    assert.match(repeat.stdout, /unchanged/)
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), installed)

    const remove = run('--remove')
    assert.equal(remove.status, 0, remove.stderr)
    const removed = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(removed.dependencies[PACKAGE], undefined)
    assert.equal(removed.dependencies.other, '1.0.0')
    assert.deepEqual(removed.dsh.profile.bundles, ['other'])
    assert.equal(removed.dsh.desktop.retained, true)
    assert.equal(await readFile(patch, 'utf8'), previous)
    await assert.rejects(lstat(link), { code: 'ENOENT' })

    const again = run('--remove')
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /unchanged/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installer migrates the legacy managed insert block without duplicating the row', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-qms-migration-'))
  const dir = join(home, 'profiles/web')
  const patch = join(dir, 'cordis.patch.yml')
  const previous = `# other plugin\n- id: existing\n  config: {}\n\n# BEGIN managed ${PACKAGE}\n# Local source: "/old/checkout"\n- insert:\n    - id: quick-model-selector\n      name: ${PACKAGE}\n      config: {}\n# END managed ${PACKAGE}\n`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(patch, previous)
    const run = (...args) => spawnSync(process.execPath, [script, '--dsh-home', home, ...args], { encoding: 'utf8' })

    const result = run()
    assert.equal(result.status, 0, result.stderr)
    const migrated = await readFile(patch, 'utf8')
    assert.doesNotMatch(migrated, /quick-model-selector/)
    assert.match(migrated, /- id: existing\n {2}config: \{\}/)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [PACKAGE])

    const removed = run('--remove')
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal((await readFile(patch, 'utf8')).trimEnd(), '# other plugin\n- id: existing\n  config: {}')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installer refuses to overwrite another installation of the same package', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-qms-conflict-'))
  const dir = join(home, 'profiles/web')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [PACKAGE]: '1.0.0' } }))
    const run = spawnSync(process.execPath, [script, '--dsh-home', home], { encoding: 'utf8' })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Another installation owns the profile dependency/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
