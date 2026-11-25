import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
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
      body: options.toolbar ? `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;background:#f5f6f8;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#5f6368}
        .test-card{position:absolute;top:420px;left:24px;box-sizing:border-box;width:${options.width ?? 560}px;padding:12px 8px 6px;border:1px solid #e5e7eb;border-radius:16px;background:white}
        .test-draft{height:60px;padding:6px 10px;color:#a8adb5;font-size:14px}
        /* DSH Desktop 0.12.1 / Harness 0.2.1-rc.2 composer group geometry. */
        .test-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;min-width:0;padding:2px 8px 6px;container-type:inline-size}
        .test-row[data-model-compact]{--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}
        .test-tools,.test-modes,.test-trailing,.test-standard{display:flex;align-items:center;min-width:0;gap:12px}
        .test-trailing{flex:none;margin-left:auto}
        .test-control{display:flex;flex:none;align-items:center;justify-content:center;border:none;background:none;color:inherit;height:28px;padding:0;font:inherit;white-space:nowrap}
        .test-add,.test-mic{width:28px}.test-add{background:#f2f3f5;border-radius:50%;font-size:20px}
        .test-permission{gap:5px}.test-send{width:34px;height:34px;background:#9ab7f4;color:white;border-radius:50%;font-size:22px;transform:translateY(-2px)}
        .test-credit{white-space:nowrap}.test-extra{width:20px;font-size:17px}
        @container (width<=560px){.test-tools,.test-modes,.test-trailing{gap:8px}}
        @container (width<=440px){.test-permission-label{display:none}}
        .test-shell{position:absolute;inset:0 0 0 240px;transform:translateX(0);overflow:hidden}
      </style></head><body>${options.clipped ? '<div class="test-shell">' : ''}<div class="test-card"><div class="test-draft">描述你想要构建的内容，/ 调用指令，@ 文件或对话</div>
        <div class="test-row"><div class="test-tools"><button class="test-control test-add" aria-label="添加">+</button><div class="test-modes"><button class="test-control test-permission"><span>♧</span><span class="test-permission-label">工作区内修改⌄</span></button></div></div>
        <div class="test-trailing"><div class="test-standard"><span class="test-credit">积分 4,321.00</span><button class="test-control test-extra" aria-label="草图">♧</button><div id="fixture"></div></div><button class="test-control test-mic" aria-label="录音">♩</button><button class="test-control test-send" aria-label="发送">↑</button></div></div></div>${options.clipped ? '</div>' : ''}</body></html>`
        : '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture" style="position:absolute;top:500px;left:100px"></div></body></html>',
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
        groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'first', name: 'First' }, { id: 'second', name: options.modelName ?? 'Second', reasoning }] }],
        status: 'ready', error: null,
      }
      if (options.otherGroup) snapshot.groups.push({ id: 'other', name: 'Other', models: [{ id: 'third', name: 'Third' }] })
      if (options.longChoice) snapshot.groups[0].models.push({
        id: 'long', name: 'A very long model name with a provider and version',
        reasoning: { defaultEffort: 'max', efforts: [{ id: 'max', name: 'Maximum reasoning effort' }] },
      })
      if (options.manyModels) snapshot.groups[0].models.push(...Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`, name: `Model ${index}` })))
      if (options.collapsed) localStorage.setItem('dsh-quick-model-selector:prefs:v1', JSON.stringify({ collapsed: { demo: true } }))
      window.picks = []
      const listeners = new Set()
      const update = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const fn of listeners) fn()
      }
      const directory = {
        store: {
          subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
          getSnapshot: () => snapshot,
        },
        load: async () => snapshot,
        select: async selection => {
          window.picks.push(selection)
          if (options.deferSelection) {
            update({ status: 'selecting', pending: selection, error: null })
            const accepted = await new Promise(resolve => { window.finishSelection = resolve })
            if (!accepted) {
              const error = 'Model unavailable'
              update({ status: 'error', pending: null, error })
              return { ok: false, error }
            }
          }
          update({ current: selection, status: 'ready', pending: null, error: null })
          return { ok: true }
        },
      }
      let entry
      const ctx = {
        get: key => key === 'modelDirectories' ? { directoryFor: () => directory } : undefined,
        inject: (_deps, fn) => fn(ctx),
        slots: {
          inject: (_name, fn) => fn(),
          register: (options, component) => { entry = { options, component }; return () => {} },
        },
      }
      window.handoff.factory(() => window.React).apply(ctx)
      const slot = entry.options.inject('test-session')
      const root = window.ReactDOM.createRoot(document.getElementById('fixture'))
      window.setSelectorLocked = locked => root.render(window.React.createElement(entry.component, { ...slot, locked }))
      window.setSelectorLocked(false)
      window.removeFirstModel = () => update({ groups: snapshot.groups.map(group => ({
        ...group, models: group.models.filter(model => model.id !== 'first'),
      })) })
      if (options.toolbar) {
        // Same compact-signal algorithm as the real DSH control-row observer.
        const row = document.querySelector('.test-row')
        const measure = () => {
          row.removeAttribute('data-model-compact')
          const style = getComputedStyle(row)
          const available = row.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          const widths = Array.from(row.children, child => child.getBoundingClientRect().width).filter(width => width > 0)
          const needed = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * parseFloat(style.columnGap)
          row.toggleAttribute('data-model-compact', needed > available)
        }
        const resize = new ResizeObserver(measure)
        for (const element of [row, ...row.children]) resize.observe(element)
        const mutation = new MutationObserver(measure)
        mutation.observe(row, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] })
        measure()
      }
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

    await t.test('favoriting a result keeps that model highlighted when the results reorder', async () => {
      const page = await mount()
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-input').fill('demo')
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'First')
      await page.keyboard.press('Control+d')
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'First')
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.picks[0].model), 'first')

      await page.locator('.qms-trigger').click()
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'First')
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'Second')
    })

    await t.test('removing the highlighted model does not silently select another one', async () => {
      const page = await mount({ otherGroup: true })
      await page.locator('.qms-trigger').click()
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'First')
      await page.evaluate(() => window.removeFirstModel())
      await page.locator('.qms-row').getByText('First').waitFor({ state: 'detached' })
      await page.keyboard.press('Enter')
      assert.equal(await pickCount(page), 0)
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('.qms-row.active .qms-name').textContent(), 'Second')
    })

    await t.test('clicking a star preserves search focus and tabbing out dismisses the menu', async () => {
      const page = await mount({ toolbar: true, width: 800 })
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-input').fill('demo')
      const star = page.locator('.qms-row').filter({ hasText: 'First' }).locator('.qms-star')
      assert.match(await star.getAttribute('aria-label'), /^(收藏模型|Add to favorites)$/)
      await star.click()
      assert.equal(await page.locator('.qms-input').evaluate(input => input === document.activeElement), true)
      assert.match(await star.getAttribute('aria-label'), /^(取消收藏|Remove from favorites)$/)
      await star.focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('.qms-input').evaluate(input => input === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('.qms-head').last().evaluate(head => head === document.activeElement), true)
      await page.keyboard.press('Tab')
      await page.locator('.qms-menu').waitFor({ state: 'detached', timeout: 2500 })
      assert.equal(await page.locator('.test-mic').evaluate(el => el === document.activeElement), true)
    })

    await t.test('an open menu closes when DSH locks model changes', async () => {
      const page = await mount()
      await page.locator('.qms-trigger').click()
      await page.evaluate(() => window.setSelectorLocked(true))
      await page.locator('.qms-trigger:disabled').waitFor()
      await page.locator('.qms-menu').waitFor({ state: 'detached', timeout: 2500 })
      await page.keyboard.press('Enter')
      assert.equal(await pickCount(page), 0)
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

    await t.test('the toolbar uses remaining space and restores controls when expanded', async () => {
      const page = await mount({ toolbar: true, width: 800, modelName: 'DeepSeek-V4.1-Flash' })
      const layout = () => page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect()
        const row = rect('.test-row')
        const leading = rect('.test-tools')
        const trailing = rect('.test-trailing')
        const model = rect('.qms-trigger')
        const label = document.querySelector('.qms-trigger-label')
        return {
          oneLine: Math.abs(leading.top + leading.height / 2 - trailing.top - trailing.height / 2) < 2,
          inside: trailing.right <= row.right + 1 && leading.right <= model.left + 1,
          labelVisible: label.clientWidth > 20 && getComputedStyle(label).display !== 'none',
          mode: document.querySelector('.qms-root').dataset.qmsLayout,
        }
      })
      for (const width of [800, 680, 600, 580, 560, 540, 520, 480, 440, 400, 360, 320, 560, 800]) {
        await page.locator('.test-card').evaluate((el, value) => { el.style.width = `${value}px` }, width)
        await page.waitForFunction(() => document.querySelector('.qms-root').dataset.qmsLayout !== undefined)
        // Layout observers and the host compact signal settle on animation frames.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const measured = await layout()
        assert.equal(measured.oneLine, width !== 320, `unexpected toolbar rows at ${width}px`)
        assert.equal(measured.inside, true, `controls overlap or overflow at ${width}px`)
        assert.equal(measured.labelVisible, true, `model name disappears at ${width}px`)
        if (width === 800) assert.equal(measured.mode, 'expanded')
      }
      await page.locator('.test-card').evaluate(el => { el.style.width = '560px' })
      await page.locator('.test-credit').evaluate(el => { el.textContent = '积分余额 123,456.78' })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal((await layout()).oneLine, true, 'changing a peer label must reallocate width')
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-link-slot').getByRole('button').click()
      await page.locator('.qms-menu-effort').waitFor()
      assert.equal(await page.locator('.qms-menu-effort .qms-row').count(), 2)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.qms-trigger').evaluate(el => el === document.activeElement), true)
      if (process.env.QMS_SCREENSHOT_DIR) {
        await mkdir(process.env.QMS_SCREENSHOT_DIR, { recursive: true })
        await page.locator('.test-card').screenshot({ path: join(process.env.QMS_SCREENSHOT_DIR, 'responsive-composer.png') })
      }
    })

    await t.test('menus stay within a narrow viewport and reposition while open', async () => {
      const page = await mount({ toolbar: true, width: 320, modelName: 'A-very-long-model-name-with-a-provider-and-version' })
      await page.setViewportSize({ width: 368, height: 700 })
      const insideViewport = () => page.locator('.qms-menu').evaluate(el => {
        const rect = el.getBoundingClientRect()
        return rect.left >= 15 && rect.right <= document.documentElement.clientWidth - 15
          && rect.top >= 15 && rect.bottom <= window.innerHeight - 15
      })
      await page.locator('.qms-trigger').click()
      assert.equal(await insideViewport(), true)
      await page.setViewportSize({ width: 368, height: 480 })
      await page.locator('.test-card').evaluate(el => { el.style.top = '30px' })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await insideViewport(), true)
      await page.locator('.qms-input').fill('First')
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await pickCount(page), 1)
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-star').first().click()
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-quick-model-selector:prefs:v1')).favorites[0]), 'demo/first')
    })

    await t.test('narrow model buttons fit their label inside a fixed-width seat', async () => {
      const widths = []
      for (const modelName of ['Mini', 'DeepSeek-V4.1-Flash', 'A-very-long-model-name-with-a-provider-and-version']) {
        const page = await mount({ toolbar: true, width: 560, modelName })
        await page.waitForFunction(() => document.querySelector('.qms-root').dataset.qmsLayout === 'compact')
        const measured = await page.locator('.qms-trigger').evaluate(el => {
          const label = el.querySelector('.qms-trigger-label')
          return {
            width: el.parentElement.getBoundingClientRect().width,
            buttonWidth: el.getBoundingClientRect().width,
            clipped: label.scrollWidth > label.clientWidth,
            title: el.title,
          }
        })
        widths.push(measured.width)
        assert.equal(measured.title, modelName, 'hover must expose the complete model name')
        assert.equal(measured.clipped, modelName !== 'Mini')
        if (modelName === 'Mini') assert.ok(measured.buttonWidth < 75, 'the short label should have a compact focus target')
      }
      assert.deepEqual(widths, [150, 150, 150], 'model names must not move neighboring actions')
    })

    await t.test('both menus stay on screen inside the clipped, offset conversation pane', async () => {
      const page = await mount({ toolbar: true, width: 720, clipped: true })
      await page.setViewportSize({ width: 1000, height: 720 })
      const geometry = trigger => page.locator('.qms-menu').evaluate((menu, trigger) => {
        const rect = menu.getBoundingClientRect()
        const anchor = document.querySelector(trigger).getBoundingClientRect()
        return { right: Math.round(rect.right), expectedRight: Math.round(anchor.right),
          width: document.documentElement.clientWidth,
          hit: menu.contains(document.elementFromPoint(rect.right - 8, rect.top + 12)) }
      }, trigger)
      for (const trigger of ['.qms-trigger', '.qms-effort-btn']) {
        await page.locator(trigger).click()
        const bounds = await geometry(trigger)
        assert.ok(bounds.right <= bounds.width - 15 && bounds.hit, JSON.stringify(bounds))
        assert.ok(Math.abs(bounds.right - bounds.expectedRight) <= 1, JSON.stringify(bounds))
        await page.keyboard.press('Escape')
      }

      await page.locator('.qms-trigger').click()
      await page.locator('.test-card').evaluate(card => { card.style.transform = 'translateX(-72px)' })
      await page.waitForFunction(() => {
        const menu = document.querySelector('.qms-menu').getBoundingClientRect()
        const trigger = document.querySelector('.qms-trigger').getBoundingClientRect()
        return Math.abs(menu.right - trigger.right) <= 1
      })
      if (process.env.QMS_SCREENSHOT_DIR) {
        await page.screenshot({ path: join(process.env.QMS_SCREENSHOT_DIR, 'model-menu-desktop.png') })
      }
      await page.locator('.test-permission').click()
      await page.locator('.qms-menu').waitFor({ state: 'detached' })

      await page.setViewportSize({ width: 1000, height: 240 })
      await page.locator('.test-card').evaluate(card => { card.style.top = '25px' })
      await page.locator('.qms-trigger').click()
      assert.equal(await page.locator('.qms-menu').evaluate(menu => {
        const { top, bottom } = menu.getBoundingClientRect()
        return top >= 15 && bottom <= window.innerHeight - 15
          && menu.querySelector('.qms-body').clientHeight > 30
      }), true)
      if (process.env.QMS_SCREENSHOT_DIR) {
        await page.screenshot({ path: join(process.env.QMS_SCREENSHOT_DIR, 'model-menu-short.png') })
      }
      await page.locator('.qms-input').fill('First')
      await page.keyboard.press('Enter')
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await pickCount(page), 1)
      assert.equal(await page.locator('.qms-trigger').evaluate(el => el === document.activeElement), true)
    })

    await t.test('switching model name and effort support keeps the toolbar in place', async () => {
      for (const width of [800, 600]) {
        const page = await mount({ toolbar: true, width, longChoice: true })
        const positions = () => page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return ['.qms-root', '.test-extra', '.test-mic', '.test-send'].map(selector => {
            const { x, y, width } = document.querySelector(selector).getBoundingClientRect()
            return { x, y, width }
          })
        })
        const initial = await positions()
        for (const name of ['A very long model name with a provider and version', 'First', 'Second']) {
          await page.locator('.qms-trigger').click()
          await page.locator('.qms-input').fill(name)
          await page.keyboard.press('Enter')
          await page.locator('.qms-menu').waitFor({ state: 'detached' })
          assert.equal(await page.locator('.qms-trigger-label').textContent(), name)
          assert.equal(await page.locator('.qms-effort-btn').count(), name === 'First' ? 0 : 1)
          assert.deepEqual(await positions(), initial, `${name} moved controls at ${width}px`)
          if (name === 'First') {
            const metrics = await page.locator('.qms-trigger').evaluate(button => {
              const trigger = button.getBoundingClientRect()
              const mic = document.querySelector('.test-mic').getBoundingClientRect()
              const seat = button.parentElement.getBoundingClientRect()
              return {
                rightAligned: Math.abs(trigger.right - seat.right) < 1,
                sameCenter: Math.abs(trigger.top + trigger.height / 2 - mic.top - mic.height / 2) < 1,
                gap: mic.left - trigger.right,
                focused: button === document.activeElement,
                outline: getComputedStyle(button).outlineWidth,
              }
            })
            assert.deepEqual(metrics, { rightAligned: true, sameCenter: true, gap: 12, focused: true, outline: '1px' })
            if (width === 800 && process.env.QMS_SCREENSHOT_DIR) {
              await page.locator('.test-card').screenshot({ path: join(process.env.QMS_SCREENSHOT_DIR, 'model-trigger-focused.png') })
            }
          }
        }
      }
    })

    await t.test('failed selection stays open for retry and repeated Enter submits only once', async () => {
      const page = await mount({ deferSelection: true })
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-input').fill('First')
      await page.keyboard.press('Enter')
      await page.evaluate(() => window.finishSelection(false))
      await page.locator('.qms-menu [role="alert"]').getByText('Model unavailable', { exact: false }).waitFor({ timeout: 2500 })
      assert.equal(await page.locator('.qms-input').inputValue(), 'First')
      assert.equal(await page.locator('.qms-trigger-label').textContent(), 'Second')
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh-quick-model-selector:prefs:v1')), null)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      assert.equal(await pickCount(page), 2)
      await page.evaluate(() => window.finishSelection(true))
      await page.locator('.qms-menu').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.qms-trigger-label').textContent(), 'First')
    })

    await t.test('settling a dismissed selection leaves the reopened menu and its search alone', async () => {
      const page = await mount({ deferSelection: true })
      await page.locator('.qms-trigger').click()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      await page.locator('.qms-trigger').click()
      await page.locator('.qms-input').fill('Second')
      await page.evaluate(() => window.finishSelection(true))
      await page.waitForFunction(() => document.querySelector('.qms-trigger-label').textContent === 'First')
      assert.equal(await page.locator('.qms-input').inputValue({ timeout: 2500 }), 'Second')
      assert.equal(await page.locator('.qms-input').evaluate(el => el === document.activeElement), true)
    })

    await t.test('pointer highlight on a clipped row leaves scrolling under user control', async () => {
      const page = await mount({ toolbar: true, width: 420, manyModels: true })
      await page.setViewportSize({ width: 880, height: 240 })
      await page.locator('.test-card').evaluate(card => { card.style.top = '25px' })
      await page.locator('.qms-trigger').click()
      const clipped = await page.locator('.qms-body').evaluate(body => {
        const bounds = body.getBoundingClientRect()
        const row = [...body.querySelectorAll('.qms-row')].find(el => {
          const rect = el.getBoundingClientRect()
          return rect.top + 2 < bounds.bottom && rect.bottom > bounds.bottom + 2
        })
        return row ? { x: bounds.left + 32, y: bounds.bottom - 2, scroll: body.scrollTop } : null
      })
      assert.ok(clipped, 'fixture needs a partly visible row')
      await page.mouse.move(clipped.x, clipped.y)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.locator('.qms-body').evaluate(body => body.scrollTop), clipped.scroll)
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('.qms-body').evaluate(body => {
        const row = body.querySelector('[data-active="true"]').getBoundingClientRect()
        return row.bottom <= body.getBoundingClientRect().bottom + 1
      }), true)
    })

    await t.test('the open menu stays over the composer and crosses resize thresholds smoothly', async () => {
      const page = await mount({ toolbar: true, width: 408, clipped: true })
      await page.locator('.qms-trigger').click()
      const bounds = await page.locator('.qms-menu').evaluate(menu => {
        const row = document.querySelector('.test-row').getBoundingClientRect()
        const rect = menu.getBoundingClientRect()
        return { left: rect.left, right: rect.right, rowLeft: row.left, rowRight: row.right }
      })
      assert.ok(bounds.left >= bounds.rowLeft && bounds.right <= bounds.rowRight, JSON.stringify(bounds))

      let previousLeft
      for (const width of [358, 357, 356, 355, 354, 353, 352]) {
        await page.locator('.test-card').evaluate((card, width) => { card.style.width = `${width}px` }, width)
        const left = await page.locator('.qms-menu').evaluate(async menu => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return menu.getBoundingClientRect().left
        })
        if (previousLeft !== undefined) assert.ok(Math.abs(left - previousLeft) <= 2, `menu moved from ${previousLeft} to ${left} at ${width}px`)
        previousLeft = left
      }

      const aboveTrigger = () => page.locator('.qms-menu').evaluate(async menu => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return menu.getBoundingClientRect().bottom <= document.querySelector('.qms-trigger').getBoundingClientRect().top
      })
      await page.setViewportSize({ width: 1000, height: 640 })
      await page.locator('.test-card').evaluate(card => { card.style.top = '220px' })
      assert.equal(await aboveTrigger(), true)
      await page.setViewportSize({ width: 1000, height: 760 })
      assert.equal(await aboveTrigger(), true, 'keep the current side while it has room')
      await page.locator('.test-card').evaluate(card => { card.style.top = '5px' })
      assert.equal(await aboveTrigger(), false, 'flip when the current side runs out of room')
    })
  } finally {
    await browser.close()
  }
})
