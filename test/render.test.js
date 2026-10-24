import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Smoke-render the built browser bundle with the profile's own React.
 *
 * The bundle is a real DSH client factory, so this exercises the exact code
 * the app loads: module registration, the slot entry, and one render pass over
 * live-shaped directory data. Skips when the local profile is unavailable.
 */
const modules = process.env.DSH_PROFILE_MODULES
  ?? join(homedir(), 'Library/Application Support/dsh-desktop/harness/profiles/node_modules')
const reactLike = [
  modules,
  ...['dsh-client-ui-goal', 'dsh-client-ui-plan', 'dsh-client-ui-jobs'].map(name => join(modules, '@deepseek-ai', name, 'node_modules')),
]

const load = specifier => {
  for (const base of reactLike) {
    try {
      return createRequire(join(base, 'noop.js'))(specifier)
    } catch {
      /* try the next candidate root */
    }
  }
  return undefined
}

const React = load('react')
const server = load('react-dom/server')
const available = React !== undefined && server?.renderToString !== undefined
const skip = available ? false : 'local DSH profile react/react-dom not found'

const bundleUrl = new URL('../dist/client.js', import.meta.url)

const loadFactory = async (patch = text => text, seed = null) => {
  const source = patch(await readFile(bundleUrl, 'utf8'))
  const handoffs = []
  const memory = new Map(seed === null ? [] : Object.entries(seed))
  const fakeWindow = {
    __ModuleLoader__: { load: handoff => { handoffs.push(handoff) } },
    localStorage: {
      getItem: key => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => { memory.set(key, String(value)) },
      removeItem: key => { memory.delete(key) },
    },
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser classic script, not an ES module
  new Function('window', 'navigator', 'document', source)(fakeWindow, { language: 'zh-CN' }, undefined)
  assert.equal(handoffs.length, 1, 'bundle must register exactly one module')
  assert.equal(handoffs[0].id, 'dsh-quick-model-selector')
  return {
    plugin: handoffs[0].factory(specifier => {
      if (specifier === 'react') return React
      throw new Error(`unexpected require(${specifier}) in the client bundle`)
    }),
    storage: memory,
  }
}

const DEFAULT_CURRENT = { provider: 'trae', model: 'glm-5-turbo' }

const snapshot = (current = DEFAULT_CURRENT) => ({
  current,
  routable: true,
  groups: [
    {
      id: 'trae',
      name: 'Trae',
      models: [
        { id: 'glm-5-turbo', name: 'GLM-5-Turbo · x0.51' },
        {
          id: 'kimi-k2.5',
          name: 'Kimi-K2.5 · x0.48',
          reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
      ],
    },
    { id: 'trae-global', name: 'Trae Global', models: [{ id: 'gemini-3-flash', name: 'Gemini-3-Flash-Preview' }] },
  ],
  failures: [],
  status: 'ready',
  error: null,
})

/** Minimal host context: capture the one slot entry the plugin registers. */
const mount = async (patch = text => text, current = DEFAULT_CURRENT, seed = null) => {
  const { plugin, storage } = await loadFactory(patch, seed)
  const captured = []
  const directory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot(current),
    },
    load: async () => snapshot(current),
    select: async () => {},
  }
  const ctx = {
    logger: { info: () => {} },
    get: name => (name === 'modelDirectories' ? { directoryFor: () => directory } : undefined),
    inject: (_deps, callback) => { callback(ctx) },
    slots: {
      inject: (_name, callback) => { callback() },
      register: (options, component) => {
        captured.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(captured.length, 1, 'exactly one slot entry')
  return { plugin, entry: captured[0], directory, storage }
}

test('the bundle registers a shadowing entry on the composer model seat', { skip }, async () => {
  const { plugin, entry } = await mount()
  assert.equal(plugin.name, 'quick-model-selector')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(entry.options.name, 'conversation.input.model')
  assert.equal(entry.options.priority, -20, 'must outrank both the stock entry (0) and provider plugins that shadow it (-10)')
  assert.equal(typeof entry.options.inject, 'function')
})

test('the injected face resolves the shared directory and its verbs', { skip }, async () => {
  const { entry, directory } = await mount()
  const face = entry.options.inject('session-1')
  assert.equal(face.available, true)
  assert.equal(face.directory.getSnapshot().groups.length, 2)
  face.load()
  assert.equal(await directory.store.getSnapshot().current.provider, 'trae')
})

test('the seat renders the current model and drops the multiplier token', { skip }, async () => {
  const { entry } = await mount()
  const props = { ...entry.options.inject('session-1'), locked: false }
  const html = server.renderToString(React.createElement(entry.component, props))
  assert.match(html, /qms-trigger/)
  assert.match(html, /GLM-5-Turbo/)
  assert.ok(!html.includes('x0.51'), 'the multiplier belongs in the panel badge, not the trigger label')
})

test('the seat renders nothing for addressed subagent sessions', { skip }, async () => {
  const { entry } = await mount()
  const props = { ...entry.options.inject('session-1'), locked: false, available: false }
  assert.equal(server.renderToString(React.createElement(entry.component, props)), '')
})

test('a locked session disables the trigger but still shows the model', { skip }, async () => {
  const { entry } = await mount()
  const props = { ...entry.options.inject('session-1'), locked: true }
  const html = server.renderToString(React.createElement(entry.component, props))
  assert.match(html, /disabled/)
  assert.match(html, /GLM-5-Turbo/)
})

test('preferences migrate from the pre-rename package key', { skip }, async () => {
  const { entry, storage } = await mount(undefined, DEFAULT_CURRENT, {
    'dsh-model-palette:prefs:v1': JSON.stringify({
      favorites: ['trae/kimi-k2.5'],
      recents: [{ key: 'trae/glm-5-turbo', at: 1 }],
      collapsed: { 'trae-global': true },
    }),
  })
  // useState(readPrefs) runs the migration on the very first render.
  server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  const migrated = JSON.parse(storage.get('dsh-quick-model-selector:prefs:v1'))
  assert.deepEqual(migrated.favorites, ['trae/kimi-k2.5'])
  assert.deepEqual(migrated.recents, [{ key: 'trae/glm-5-turbo', at: 1 }])
  assert.deepEqual(migrated.collapsed, { 'trae-global': true })
  assert.equal(storage.get('dsh-model-palette:prefs:v1'), undefined, 'the legacy key is consumed, not left behind')
})

test('the built bundle carries no ES module syntax', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  assert.ok(existsSync(bundleUrl))
  assert.ok(!/^\s*export\s/m.test(source))
  assert.ok(!/^\s*import\s/m.test(source))
})

test('the built bundle matches the current source files', async () => {
  const logic = (await readFile(new URL('../src/logic.js', import.meta.url), 'utf8'))
    .replace(/^export\s+/gm, '').trimEnd()
  const template = await readFile(new URL('../src/client.template.js', import.meta.url), 'utf8')
  const built = await readFile(bundleUrl, 'utf8')
  assert.equal(built === template.replace('// __LOGIC_BUNDLE__', logic), true, 'run npm run build after editing sources')
})

test('the stylesheet never puts `inherit` inside the font shorthand', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  // `font: 13px/18px inherit` is invalid — `inherit` is a CSS-wide keyword, not
  // a family name — so the browser drops the whole declaration and every size
  // silently falls back to the inherited one. That is what made the panel look
  // oversized and misaligned; use font-size / line-height longhand instead.
  assert.ok(
    !/font:[^;{}]*\binherit\b/.test(source),
    'font shorthand must not name `inherit` as the family',
  )
})

// Both surfaces start closed; effects never run under SSR, so the initial open
// state is patched in memory to render one of them.
const openSurface = surface => text => text.replace('useState(null)', `useState('${surface}')`)

test('the effort picker is its own popover, not a page inside the model list', { skip }, async () => {
  const { entry } = await mount(openSurface('effort'))
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  assert.match(html, /qms-menu-effort/, 'the effort surface renders as itself')
  assert.ok(!html.includes('qms-search'), 'no model search box inside the effort popover')
  assert.ok(!html.includes('qms-link'), 'the effort entry row belongs to the model picker only')
})

test('the trigger honours the composer row compact contract', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  // The composer row measures "would the expanded controls fit on one line?"
  // and sets data-model-compact, which flips these two variables. The model
  // name stays readable (ellipsis), so only the effort control folds away.
  assert.match(source, /--dsh-composer-model-text-display/, 'the effort control collapses with the row')
  assert.ok(
    /display:var\(--dsh-composer-model-text-display/.test(source),
    'the variable must actually be consumed, not merely declared',
  )
  assert.ok(
    !/qms-trigger-label\{display:var\(--dsh-composer-model-text-display/.test(source),
    'the model name must not be hidden by the compact contract',
  )
})

test('the trigger keeps the model name in narrow rows instead of an icon', { skip }, async () => {
  const { entry } = await mount()
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  assert.match(html, /qms-trigger-label/)
  assert.ok(!html.includes('qms-trigger-icon'), 'the name is never replaced by a glyph')
})

test('the model picker carries no effort surface', { skip }, async () => {
  const { entry } = await mount(openSurface('models'))
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  assert.match(html, /qms-search/)
  assert.ok(!html.includes('qms-menu-effort'), 'effort is never mixed into the model list')
})

test('picking a model closes the picker instead of handing over to effort', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  // Guard against the auto-jump coming back: the model picker's own `pick()`
  // must end the interaction, never chain into the effort surface.
  const start = source.indexOf('const pick = ')
  const end = source.indexOf('const toggleFavorite', start)
  assert.ok(start > 0 && end > start, 'pick() must still exist verbatim enough to be inspected')
  const pick = source.slice(start, end)
  assert.ok(!pick.includes("openSurface('effort')"), 'picking a model never opens the effort surface')
  assert.ok(pick.includes("close('models')"), 'picking a model just closes its own surface')
  assert.ok(!/reasoning\?\.efforts/.test(source), 'selection must not branch on the picked model having reasoning levels')
})

test('model and effort are two separately clickable controls', { skip }, async () => {
  // A model with reasoning levels: that is when the second control appears.
  const { entry } = await mount(undefined, { provider: 'trae', model: 'kimi-k2.5' })
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  // Effort lives beside the model button, not inside it: separate element,
  // separate hit area, separate aria state.
  assert.match(html, /qms-effort/, 'the effort control is its own box in the row')
  assert.ok(!html.includes('qms-trigger-effort'), 'effort text is no longer nested inside the model pill')
  const model = html.indexOf('class="qms-trigger"')
  const effort = html.indexOf('class="qms-effort-btn"')
  assert.ok(model > 0, 'the model button renders')
  assert.ok(effort > model, 'the effort button sits after it, as a sibling')
  assert.ok(effort > html.indexOf('</button>'), 'the effort button is not nested inside the model button')
})

test('a model without reasoning levels shows no effort control', { skip }, async () => {
  const { entry } = await mount()
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('session-1'), locked: false }))
  assert.ok(!html.includes('qms-effort'), 'nothing to pick, so no control')
})

test('the effort control keeps its own popover and its own focus target', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  assert.match(source, /ref:\s*effortRef/, 'the effort button is a focus target of its own')
  assert.ok(source.includes("close('effort')"), 'closing the effort popover returns focus to the effort button')
  // When the row is too narrow for two controls, effort folds back into the
  // model picker through the compact contract instead of disappearing.
  assert.match(source, /qms-link-slot\{display:var\(--dsh-composer-model-icon-display/)
})
