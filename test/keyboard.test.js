import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Optional browser checks use the same React as the local DSH profile. Supply
// Playwright through NODE_PATH and QMS_BROWSER_CHANNEL if using system Chrome.
const modules = process.env.DSH_PROFILE_MODULES
  ?? join(homedir(), 'Library/Application Support/dsh-desktop/harness/profiles/node_modules')
const roots = [modules, ...['dsh-client-ui-goal', 'dsh-client-ui-plan', 'dsh-client-ui-jobs']
  .map(name => join(modules, '@deepseek-ai', name, 'node_modules'))]
const resolve = specifier => {
  for (const root of roots) {
    try { return createRequire(join(root, 'noop.js')).resolve(specifier) } catch { /* next root */ }
  }
}
const playwright = resolve('playwright')
const react = resolve('react/package.json')
const reactDom = resolve('react-dom/package.json')
const skip = playwright && react && reactDom ? false : 'Playwright and local DSH React are required for browser interactions'

test('keyboard interactions in the rendered selector', { skip }, async t => {
  const { chromium } = createRequire(import.meta.url)(playwright)
  const browser = await chromium.launch({ channel: process.env.QMS_BROWSER_CHANNEL || undefined })
  const scripts = await Promise.all([
    readFile(join(dirname(react), 'umd/react.development.js'), 'utf8'),
    readFile(join(dirname(reactDom), 'umd/react-dom.development.js'), 'utf8'),
    readFile(new URL('../dist/client.js', import.meta.url), 'utf8'),
  ])
  const mount = async (options = {}) => {
    const page = await browser.newPage()
    t.after(() => page.close())
    // A mocked origin provides real localStorage without contacting a server.
    await page.route('http://selector.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture" style="position:absolute;top:500px;left:100px"></div></body></html>',
    }))
    await page.goto('http://selector.test/')
    await page.evaluate(() => {
      window.__ModuleLoader__ = { load: handoff => { window.handoff = handoff } }
    })
    for (const content of scripts) await page.addScriptTag({ content })
    await page.evaluate(options => {
      const reasoning = { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
      let snapshot = {
        current: { provider: 'demo', model: 'second', reasoningEffort: 'low' },
        groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second', reasoning }] }],
        status: 'ready', error: null,
      }
      if (options.otherGroup) snapshot.groups.push({ id: 'other', name: 'Other', models: [{ id: 'third', name: 'Third' }] })
      if (options.collapsed) localStorage.setItem('dsh-quick-model-selector:prefs:v1', JSON.stringify({ collapsed: { demo: true } }))
      window.picks = []
      const listeners = new Set()
      const directory = {
        store: {
          subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
          getSnapshot: () => snapshot,
        },
        load: async () => snapshot,
        select: async selection => {
          window.picks.push(selection)
          snapshot = { ...snapshot, current: selection }
          for (const fn of listeners) fn()
        },
      }
      let entry
      const ctx = {
        get: key => key === 'modelDirectories' ? { directoryFor: () => directory } : undefined,
        inject: (_deps, fn) => fn(ctx),
        slots: {
          inject: (_name, fn) => fn(),
          register: (_options, component) => { entry = component; return () => {} },
        },
      }
      window.handoff.factory(() => window.React).apply(ctx)
      window.ReactDOM.createRoot(document.getElementById('fixture')).render(window.React.createElement(entry, {
        available: true, locked: false, directory: directory.store,
        load: () => directory.load(),
        select: selection => directory.select(selection).then(() => true),
      }))
    }, options)
    await page.locator('.qms-trigger').waitFor()
    return page
  }
  const pickCount = page => page.evaluate(() => window.picks.length)
  try {
    await t.test('Enter opens either closed trigger without selecting a model', async () => {
      const page = await mount()
      await page.locator('.qms-trigger').focus()
      await page.keyboard.press('Enter')
      await page.locator('.qms-input').waitFor()
      assert.equal(await pickCount(page), 0)
      await page.keyboard.press('Escape')
      await page.locator('.qms-effort-btn').focus()
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu-effort').waitFor()
      assert.equal(await pickCount(page), 0)
    })

    await t.test('IME confirmation, navigation and legacy 229 events remain untouched', async () => {
      const page = await mount()
      await page.locator('.qms-trigger').click()
      const result = await page.locator('.qms-input').evaluate(input => {
        const cases = [
          { key: 'Enter', isComposing: true },
          { key: 'ArrowDown', isComposing: true },
          { key: 'Escape', isComposing: true },
          { key: 'Enter', keyCode: 229 },
        ]
        return cases.map(props => {
          const event = new KeyboardEvent('keydown', { ...props, bubbles: true, cancelable: true })
          input.dispatchEvent(event)
          return event.defaultPrevented
        })
      })
      assert.deepEqual(result, [false, false, false, false])
      assert.equal(await pickCount(page), 0)
      assert.equal(await page.locator('.qms-input').isVisible(), true)
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'First')
      await page.locator('.qms-input').fill('First')
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await pickCount(page), 1)
    })

    for (const otherGroup of [false, true]) {
      await t.test(`Tab restores its group and highlighted row (${otherGroup ? 'multiple providers' : 'single provider'})`, async () => {
        const page = await mount({ otherGroup })
        await page.locator('.qms-trigger').click()
        await page.keyboard.press('ArrowDown')
        assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'Second')
        await page.keyboard.press('Tab')
        assert.equal(await page.locator('.qms-head').first().getAttribute('aria-expanded'), 'false')
        await page.keyboard.press('Tab')
        assert.equal(await page.locator('.qms-head').first().getAttribute('aria-expanded'), 'true')
        assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'Second')
        await page.keyboard.press('Enter')
        await page.locator('.qms-menu').waitFor({ state: 'detached' })
        assert.equal(await page.evaluate(() => window.picks[0].model), 'second')
      })
    }

    await t.test('Tab opens an initially folded group and Shift+Tab keeps native focus navigation', async () => {
      const page = await mount({ collapsed: true })
      await page.locator('.qms-trigger').click()
      assert.equal(await page.locator('.qms-row').count(), 0)
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('.qms-row').count(), 2)
      await page.keyboard.press('Shift+Tab')
      assert.equal(await page.locator('.qms-effort-btn').evaluate(el => el === document.activeElement), true)
      assert.equal(await pickCount(page), 0)
    })

    await t.test('focused group and effort buttons keep native Enter behavior', async () => {
      const page = await mount()
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-head').focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('.qms-head').getAttribute('aria-expanded'), 'false')
      assert.equal(await pickCount(page), 0)
      await page.keyboard.press('Escape')
      await page.locator('.qms-effort-btn').click()
      await page.locator('.qms-menu-effort .qms-row').last().focus()
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.picks[0].reasoningEffort), 'high')
    })
  } finally {
    await browser.close()
  }
})
