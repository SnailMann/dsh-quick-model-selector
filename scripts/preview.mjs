/**
 * Render the real panel to a static page and screenshot it.
 *
 * This exists so layout changes can be judged before shipping: it loads the
 * built bundle exactly as the app does, flips the initial `open` / `pane` /
 * `query` state via a source patch held only in memory, and server-renders the
 * component with the profile's own React. Nothing here reaches dist/client.js.
 *
 * Usage: node scripts/preview.mjs [outDir]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const outDir = process.argv[2] ?? join(tmpdir(), 'qms-preview')
const modules = process.env.DSH_PROFILE_MODULES
  ?? join(homedir(), 'Library/Application Support/dsh-desktop/harness/profiles/node_modules')
const roots = [
  modules,
  ...['dsh-client-ui-goal', 'dsh-client-ui-plan', 'dsh-client-ui-jobs'].map(name => join(modules, '@deepseek-ai', name, 'node_modules')),
]
const load = specifier => {
  for (const base of roots) {
    try {
      return createRequire(join(base, 'noop.js'))(specifier)
    } catch {
      /* next candidate root */
    }
  }
  return undefined
}
const React = load('react')
const server = load('react-dom/server')
if (React === undefined || server === undefined) throw new Error('local DSH profile react/react-dom not found')

const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

const prefs = JSON.stringify({
  version: 1,
  favorites: ['trae-openai/gpt-5.4-mini'],
  recents: [{ key: 'trae-global/gemini-3-flash', at: 3 }, { key: 'trae/kimi-k2.5', at: 2 }],
  collapsed: {},
})

const snapshot = () => ({
  current: { provider: 'trae', model: 'kimi-k2.5', reasoningEffort: 'low' },
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
        { id: 'deepseek-v3.2', name: 'DeepSeek-V3.2 · x0.12' },
      ],
    },
    {
      id: 'trae-global',
      name: 'Trae Global',
      models: [
        { id: 'gemini-3-flash', name: 'Gemini-3-Flash-Preview · x0.95' },
        { id: 'gemini-3-pro', name: 'Gemini-3-Pro · x1' },
        { id: 'claude-opus-4.5', name: 'Claude-Opus-4.5 · x2.4' },
      ],
    },
    {
      id: 'trae-openai',
      name: 'OpenAI (Trae)',
      models: [
        { id: 'gpt-5.4-mini', name: 'GPT-5.4-mini · x0.28' },
        { id: 'gpt-5.4', name: 'GPT-5.4 · x1.2' },
      ],
    },
    {
      id: 'misc',
      name: '其他接入商',
      models: [
        { id: 'm1', name: 'Qwen3-Max · x0.4' },
        { id: 'm2', name: 'Doubao-Seed-1.6 · x0.2' },
        { id: 'm3', name: 'Ernie-5.0 · x0.33' },
        { id: 'm4', name: 'Hunyuan-T1 · x0.45' },
        { id: 'm5', name: 'MiniMax-M2 · x0.3' },
        { id: 'm6', name: 'Yi-Lightning · x0.25' },
        { id: 'm7', name: 'Spark-X1 · x0.36' },
      ],
    },
  ],
  failures: [],
  status: 'ready',
  error: null,
})

/** Load the bundle, optionally patching initial state, and return the components + CSS. */
const build = patch => {
  const patched = patch(source)
  const handoffs = []
  let css = ''
  const fakeWindow = {
    __ModuleLoader__: { load: handoff => { handoffs.push(handoff) } },
    localStorage: { getItem: () => prefs, setItem: () => {}, removeItem: () => {} },
  }
  const fakeDocument = {
    head: {
      querySelector: () => null,
      append: node => { css = node.textContent },
    },
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser classic script
  new Function('window', 'navigator', 'document', patched)(fakeWindow, { language: 'zh-CN' }, fakeDocument)
  const plugin = handoffs[0].factory(specifier => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  const directory = { store: { subscribe: () => () => {}, getSnapshot: snapshot }, load: async () => snapshot(), select: async () => {} }
  const captured = []
  const ctx = {
    logger: { info: () => {} },
    get: name => (name === 'modelDirectories' ? { directoryFor: () => directory } : undefined),
    inject: (_deps, callback) => { callback(ctx) },
    slots: {
      inject: (_name, callback) => { callback() },
      register: (options, component) => { captured.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const entry = captured[0]
  const html = server.renderToString(React.createElement(entry.component, { ...entry.options.inject('s1'), locked: false }))
  return { css, html }
}

// Initial state is all-closed and effects never run under SSR, so the source is
// patched in memory to reach the states worth looking at. `open` is the first
// `useState(null)` (and `overflowing` the only `useState(false)`).
const openIt = surface => text => text
  .replace('useState(null)', `useState('${surface}')`)
  .replace('useState(false)', 'useState(true)')

const variants = [
  { id: 'split', width: 700, note: '两个独立控件：模型按钮 + 推理强度按钮', patch: text => text },
  { id: 'models', width: 700, note: '默认：折叠分组 + 收藏 / 最近使用', patch: openIt('models') },
  { id: 'search', width: 700, note: '搜索态', patch: text => openIt('models')(text).replace('useState(\'\')', 'useState(\'gl\')') },
  { id: 'effort', width: 700, note: '独立弹层：推理强度', patch: openIt('effort') },
  // 宿主在控制行排不下一行时加 data-model-compact，推理强度移入菜单。
  { id: 'compact', width: 560, compact: true, note: '窄宽度：模型名保留，超长部分省略', patch: text => text },
  { id: 'compact-models', width: 560, compact: true, note: '窄宽度：强度收进模型菜单', patch: openIt('models') },
]

// Real DSH token values, copied out of app.asar, so the preview reproduces the
// menu's translucent-plus-blur surface instead of an opaque white box.
const LIGHT_VARS = `
--dsw-specific-menu:#f8f9faf0;--dsw-menu-backdrop-filter:blur(40px) saturate(150%);
--dsw-alias-border-l1:#e5e7eb;--dsw-radius-lg:12px;--dsw-elevation-prominent:0 12px 32px rgba(0,0,0,.14);
`
const DARK_VARS = `
--dsw-alias-label-primary:#e6e8eb;--dsw-alias-label-secondary:#b6bbc2;--dsw-alias-label-tertiary:#8b9099;
--dsw-alias-label-caption:#767b84;--dsw-alias-label-dimmed:#5d626a;--dsw-alias-label-link:#6aa5f0;
--dsw-alias-border-inverted:#3a3f47;--dsw-alias-border-l1:#3a3f47;--dsw-alias-border-l2:#2b3037;--dsw-alias-border-l3:#4a5058;
--dsw-alias-background-secondary:#24282e;--dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);
--dsw-alias-interactive-bg-hover-danger:#3a2528;--dsw-alias-state-error-primary:#f08a7d;
--dsw-alias-state-warn-label:#e0b062;--dsw-specific-menu:#303136f0;
--dsw-menu-backdrop-filter:blur(40px) saturate(150%);--dsw-radius-lg:12px;
--dsw-elevation-prominent:0 12px 32px rgba(0,0,0,.55);
--dsw-shadow-lv3:0 12px 32px rgba(0,0,0,.5);--dsw-alias-scrollbar-bg-l2:#3a3f47;--dsw-alias-scrollbar-hover-l2:#4a5058;
`

const MEASURE = `<script>
(() => {
  const rect = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] };
  const font = sel => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return [s.fontSize, s.lineHeight, s.fontWeight] };
  const cs = sel => { const el = document.querySelector(sel); return el === null ? null : getComputedStyle(el).display };
  const out = {
    // 行宽 / 模型名实际宽度 / JS 量出来的宽度上限 / 是否截断，这四项是这一轮的核心证据
    row: { box: rect('.crow'), wrapped: (() => { const r = document.querySelector('.crow'); return r === null ? null : r.getBoundingClientRect().height > 44 })() },
    trigger: { box: rect('.qms-trigger'), font: font('.qms-trigger'), cap: (() => { const el = document.querySelector('.qms-trigger'); return el === null ? null : el.style.maxWidth || null })(), parts: {
      label: cs('.qms-trigger-label'), text: (() => { const el = document.querySelector('.qms-trigger-label'); return el === null ? null : el.textContent })(),
      // scrollWidth > clientWidth 即「文字被省略号截断」
      clipped: (() => { const el = document.querySelector('.qms-trigger-label'); return el === null ? null : el.scrollWidth > el.clientWidth + 1 })(),
      labelBox: rect('.qms-trigger-label'),
    } },
    effort: {
      box: rect('.qms-effort-btn'), font: font('.qms-effort-btn'),
      display: cs('.qms-effort'), color: (() => { const el = document.querySelector('.qms-effort-btn'); return el === null ? null : getComputedStyle(el).color })(),
      // 两个控件是否真的分开：模型按钮右边缘与强度按钮左边缘之间的间隙
      gap: (() => {
        const a = document.querySelector('.qms-trigger'); const b = document.querySelector('.qms-effort-btn')
        if (a === null || b === null) return null
        return Math.round((b.getBoundingClientRect().left - a.getBoundingClientRect().right) * 10) / 10
      })(),
    },
    linkSlot: { display: cs('.qms-link-slot'), box: rect('.qms-link') },
    menu: { box: rect('.qms-menu'), font: font('.qms-menu'), surface: (() => { const el = document.querySelector('.qms-menu'); if (!el) return null; const s = getComputedStyle(el); return [s.backgroundColor, s.backdropFilter, s.borderTopWidth, s.borderRadius, s.boxShadow.slice(0, 40)] })() },
    input: { box: rect('.qms-search'), font: font('.qms-input') },
    head: { box: rect('.qms-head'), font: font('.qms-head') },
    rowItem: { box: rect('.qms-row'), font: font('.qms-row') },
    badge: { font: font('.qms-badge') },
    tag: { font: font('.qms-tag') },
    link: { box: rect('.qms-link'), font: font('.qms-link') },
    foot: { font: font('.qms-foot') },
    star: (() => { const el = document.querySelector('.qms-star.on'); if (!el) return null; const s = getComputedStyle(el); return { opacity: s.opacity, color: s.color, box: rect('.qms-star.on') } })(),
    fade: rect('.qms-fade'),
    rows: document.querySelectorAll('.qms-row').length,
    overflow: (() => { const b = document.querySelector('.qms-body'); return b ? [b.scrollHeight, b.clientHeight] : null })(),
  };
  document.body.insertAdjacentHTML('beforeend', '<pre id="m">' + JSON.stringify(out) + '</pre>');
})()
</script>`

/**
 * Reproduce the real composer control row, not a stand-in: `.crow` is the same
 * inline-size container the host measures, the seat sits in its right-hand
 * `trailing` group next to the mic/send buttons, and the left/middle groups are
 * the same kind of filler the app has (+ button, workspace chip, credits).
 */
const docs = process.env.QMS_DOCS === '1'
const row = ({ html, width, compact }) => `<div class="composer" style="width:${width}px">
<div class="typing">发消息或创建任务，/ 调…</div>
<div class="crow"${compact ? ' data-model-compact' : ''}>
  <div class="tools"><span class="rbtn">+</span><span class="rchip">工作区内修改 ⌄</span></div>
  ${docs ? '' : '<div class="modes"><span class="rchip">积分 4,352.75</span><span class="rdiv"></span></div>'}
  <div class="trailing">${html}<span class="rbtn">🎙</span><span class="rbtn rsend">↑</span></div>
</div>
</div>`

const ghostText = process.env.QMS_GHOST
  ?? '面板背后是真实的编辑器文字：半透明表面必须配 backdrop-filter，否则这段文字会透上来。'
// Docs captures show only the UI: no caption line and no background editor text.
const caption = (variant, dark) => docs ? '' : `<div class="cap">${variant.note}${dark ? ' · 深色' : ' · 浅色'}</div>`
const ghost = docs ? '' : `<div class="ghost">${ghostText}</div>`
const page = (variant, { css, html }, dark) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;font-family:-apple-system,'SF Pro Text','Helvetica Neue','PingFang SC',sans-serif}
body{background:${dark ? '#14171b' : '#f2f3f5'};color:${dark ? '#e6e8eb' : '#1f2328'}}
:root{${dark ? DARK_VARS : LIGHT_VARS}}
.stage{position:relative;min-height:100vh;display:flex;align-items:flex-end;justify-content:center;padding:20px 28px 26px;box-sizing:border-box}
.composer{display:flex;flex-direction:column;justify-content:center;gap:2px;max-width:100%;padding:8px 10px 6px 12px;box-sizing:border-box;border:1px solid ${dark ? '#3a3f47' : '#e5e7eb'};border-radius:14px;background:${dark ? '#1c1f24' : '#fff'};box-shadow:0 2px 8px rgba(0,0,0,.05)}
/* 官方 composer 控制行的等价物：inline-size 容器 + flex-wrap + 三组子元素 */
.crow{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;min-width:0;padding:2px 8px 6px;container-type:inline-size}
.crow[data-model-compact]{--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}
.tools,.modes,.trailing{display:flex;align-items:center;min-width:0;gap:12px}
.tools,.modes{flex:0 0 auto}
.trailing{flex:none;gap:12px;margin-left:auto}
.rbtn{display:grid;place-items:center;width:28px;height:28px;border-radius:999px;color:${dark ? '#b6bbc2' : '#5f6368'};font-size:14px}
.rbtn.rsend{background:${dark ? '#3a3f47' : '#e8eaee'}}
.rchip{white-space:nowrap;color:${dark ? '#b6bbc2' : '#5f6368'};font-size:13px}
.rdiv{width:1px;height:16px;background:${dark ? '#3a3f47' : '#e5e7eb'}}
.typing{flex:1;color:${dark ? '#5d626a' : '#a8adb5'};font-size:14px;padding:2px}
.ghost{position:absolute;right:22px;bottom:120px;width:520px;text-align:right;color:${dark ? '#22272d' : '#cdd2d9'};font-size:14px;line-height:23px}
.cap{margin:10px 2px 0;font-size:12px;color:${dark ? '#767b84' : '#8a8f98'}}
${css}
</style></head>
<body><div class="stage">${ghost}<div>${row({ html, width: variant.width ?? 640, compact: variant.compact })}${caption(variant, dark)}</div></div>${MEASURE}</body></html>`

await mkdir(outDir, { recursive: true })
const written = []
for (const variant of variants) {
  const built = build(variant.patch)
  for (const dark of [false, true]) {
    const file = join(outDir, `${variant.id}${dark ? '-dark' : ''}.html`)
    await writeFile(file, page(variant, built, dark))
    written.push(file)
  }
}
console.log(written.join('\n'))
