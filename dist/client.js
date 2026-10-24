/**
 * Quick Model Selector — the browser half.
 *
 * Takes over the composer's model seat ('conversation.input.model', a
 * single-occupant session slot). The slot's shadowing rule renders the lowest
 * live priority, so the stock ModelSelect — and the codex picker at -10 — stay
 * registered as fallbacks and take back over if this entry ever abdicates.
 *
 * Two separate composer controls, each with its own hit area, popover and focus
 * target: the model picker (search + collapsed providers + favorites/recents)
 * and the reasoning-effort picker. When the row cannot hold both, the trigger
 * collapses to an icon per the host's compact contract and effort moves into the
 * model menu.
 *
 * The panel keeps the stock data face (the shared per-session ModelDirectory),
 * so a pick here is the same host-reported selection the /model popup sees.
 *
 * Bundled by scripts/build-client.mjs: the `__LOGIC_BUNDLE__` marker is
 * replaced with src/logic.js (exports stripped) inside this factory scope.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-model-selector',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /**
 * Pure selector logic: model-label parsing, preference normalization, and the
 * view model the panel renders. No React, no DOM, no DSH imports — bundled
 * verbatim into the client half (see scripts/build-client.mjs) and unit
 * tested directly.
 */

/** Preference schema version. */
const PREFS_VERSION = 1

/** Models per provider above which a group starts collapsed. */
const COLLAPSE_THRESHOLD = 6

/** How many recent picks the panel remembers. */
const RECENTS_LIMIT = 8

/** How many recents the panel shows as a section. */
const RECENTS_SHOWN = 5

/** The trailing billing-multiplier token some providers put in a model name or description. */
const MULTIPLIER = /(?:^|[\s·|,，(（])[x×]\s*([0-9]+(?:\.[0-9]+)?)(?![0-9])/i

/** Word boundaries used for "starts a segment" matching (Kimi-K2.5 → kimi, k2, 5). */
const SEGMENT = /[\s\-_./·:：|,，()（）[\]]+/

/** Dangling separators left behind once the multiplier token is removed. */
const TRAILING_JUNK = /[\s·|,，;；:：\-–—_]+$/

/** Empty preferences. */
function emptyPrefs() {
  return { version: PREFS_VERSION, favorites: [], recents: [], collapsed: {} }
}

/**
 * Coerce anything read from storage into the current schema. Unknown keys are
 * dropped, wrong types fall back to empty, and entries that cannot be
 * addressed are discarded rather than poisoning the whole payload.
 * @param raw - parsed storage value, or anything else.
 * @returns valid preferences.
 */
function normalizePrefs(raw) {
  const base = emptyPrefs()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const favorites = Array.isArray(raw.favorites)
    ? [...new Set(raw.favorites.filter(key => typeof key === 'string' && key.includes('/')))]
    : []
  const recents = Array.isArray(raw.recents)
    ? raw.recents
      .filter(row => row !== null && typeof row === 'object' && typeof row.key === 'string')
      .map(row => ({ key: row.key, at: Number.isFinite(row.at) ? row.at : 0 }))
      .filter((row, index, all) => all.findIndex(other => other.key === row.key) === index)
      .slice(0, RECENTS_LIMIT)
    : []
  const collapsed = {}
  if (raw.collapsed !== null && typeof raw.collapsed === 'object' && !Array.isArray(raw.collapsed)) {
    for (const [id, value] of Object.entries(raw.collapsed)) {
      if (typeof value === 'boolean') collapsed[id] = value
    }
  }
  return { version: PREFS_VERSION, favorites, recents, collapsed }
}

/** Stable key for one provider/model pair. */
function modelKey(provider, model) {
  return `${provider}/${model}`
}

/**
 * Split a trailing multiplier token off a model name or description.
 * @param model - directory model ({ name, description }).
 * @returns display label without the token, the remaining note, and the value.
 */
function parseModel(model) {
  const rawName = String(model?.name ?? model?.id ?? '')
  const rawDescription = String(model?.description ?? '')
  let multiplier = null
  let label = rawName
  let note = rawDescription

  const inName = rawName.match(MULTIPLIER)
  if (inName !== null) {
    multiplier = Number(inName[1])
    const stripped = rawName.replace(inName[0], ' ').replace(/\s+/g, ' ').replace(TRAILING_JUNK, '').trim()
    label = stripped === '' ? rawName : stripped
  }
  const inNote = rawDescription.match(MULTIPLIER)
  if (inNote !== null) {
    if (multiplier === null) multiplier = Number(inNote[1])
    note = rawDescription.replace(inNote[0], ' ').replace(/\s+/g, ' ').replace(TRAILING_JUNK, '').trim()
  }
  return {
    label,
    note: note === '' ? undefined : note,
    multiplier: Number.isFinite(multiplier) ? multiplier : null,
  }
}

/** Bucket a multiplier for the badge tone: cheap, normal, or expensive. */
function multiplierTone(value) {
  if (value === null || !Number.isFinite(value)) return 'none'
  if (value <= 0.3) return 'low'
  if (value <= 0.8) return 'mid'
  return 'high'
}

/** Format a multiplier deterministically regardless of locale. */
function formatMultiplier(value) {
  return `x${Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** Tokenize a query into lowercase terms. */
function queryTerms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether a haystack contains every term. */
function matchesAll(haystack, terms) {
  for (const term of terms) if (!haystack.includes(term)) return false
  return true
}

/** Whether any segment of the name starts with the term (k2 → Kimi-K2.5). */
function segmentStart(name, term) {
  return name.split(SEGMENT).some(segment => segment.startsWith(term))
}

/** Relevance of one row for the current terms; higher wins. */
function scoreRow(row, terms) {
  let score = 0
  const name = row.label.toLowerCase()
  for (const term of terms) {
    if (name === term) score += 120
    else if (name.startsWith(term)) score += 80
    else if (segmentStart(name, term)) score += 55
    else if (name.includes(term)) score += 30
    else score += 10
  }
  if (row.favorite) score += 400
  if (row.recentRank !== undefined) score += Math.max(0, 60 - row.recentRank * 8)
  if (row.selected) score += 200
  return score
}

/**
 * Build one row view for a model.
 * @returns row with display copy, selection payload, and match haystack.
 */
function makeRow(group, model, state, favorites, recentRanks) {
  const parsed = parseModel(model)
  const key = modelKey(group.id, model.id)
  const selected = state.current !== null
    && state.current !== undefined
    && state.current.provider === group.id
    && state.current.model === model.id
  return {
    key,
    provider: group.id,
    providerName: group.name,
    modelId: model.id,
    label: parsed.label,
    note: parsed.note,
    multiplier: parsed.multiplier,
    tone: multiplierTone(parsed.multiplier),
    reasoning: model.reasoning,
    selected,
    favorite: favorites.has(key),
    recentRank: recentRanks.get(key),
    selection: {
      provider: group.id,
      model: model.id,
      ...selected && state.current?.reasoningEffort !== undefined
        ? { reasoningEffort: state.current.reasoningEffort }
        : model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
    },
    haystack: `${parsed.label}\n${group.name}\n${group.id}\n${model.id}`.toLowerCase(),
  }
}

/** Whether a provider group renders collapsed, honoring an explicit user override first. */
function collapsedOf(prefs, groupId, rows, state) {
  const explicit = prefs.collapsed[groupId]
  if (typeof explicit === 'boolean') return explicit
  if (rows.length <= COLLAPSE_THRESHOLD) return false
  if (state.current?.provider === groupId) return false
  if (rows.some(row => row.favorite)) return false
  return true
}

/**
 * Derive everything the panel renders from the directory snapshot.
 * @param state - model directory snapshot ({ current, groups, status, error }).
 * @param prefs - normalized preferences.
 * @param query - raw search text.
 * @returns sections in render order plus the flat visible row list for keyboard navigation.
 */
function buildView(state, prefs, query) {
  const groups = Array.isArray(state?.groups) ? state.groups : []
  const favorites = new Set(prefs.favorites)
  const recentRanks = new Map(prefs.recents.map((row, index) => [row.key, index]))
  const terms = queryTerms(query)

  const rowsByGroup = new Map()
  const byKey = new Map()
  for (const group of groups) {
    const rows = (group.models ?? []).map(model => makeRow(group, model, state, favorites, recentRanks))
    rowsByGroup.set(group.id, rows)
    for (const row of rows) byKey.set(row.key, row)
  }
  const total = byKey.size

  if (terms.length > 0) {
    const hits = []
    for (const row of byKey.values()) {
      if (!matchesAll(row.haystack, terms)) continue
      hits.push({ ...row, score: scoreRow(row, terms) })
    }
    hits.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    const buckets = new Map()
    for (const row of hits) {
      const bucket = buckets.get(row.provider)
      if (bucket === undefined) buckets.set(row.provider, [row])
      else bucket.push(row)
    }
    const sections = [...buckets.entries()].map(([id, rows]) => ({
      kind: 'group',
      id,
      name: rows[0].providerName,
      rows,
      collapsed: false,
      count: rows.length,
    }))
    return {
      sections: sections.length === 0
        ? []
        : [{ kind: 'results', id: '__results', name: '', rows: [], collapsed: false, count: hits.length }, ...sections],
      rows: sections.flatMap(section => section.rows),
      searching: true,
      total,
      hits: hits.length,
    }
  }

  // Recents sit above favorites: the model just used is the likeliest next pick.
  const sections = []
  const recentRows = prefs.recents
    .map(row => byKey.get(row.key))
    .filter(row => row !== undefined && !favorites.has(row.key))
    .slice(0, RECENTS_SHOWN)
  if (recentRows.length > 0) {
    sections.push({ kind: 'recents', id: '__recents', name: 'recents', rows: recentRows, collapsed: false, count: recentRows.length })
  }
  const favoriteRows = prefs.favorites.map(key => byKey.get(key)).filter(row => row !== undefined)
  if (favoriteRows.length > 0) {
    sections.push({ kind: 'favorites', id: '__favorites', name: 'favorites', rows: favoriteRows, collapsed: false, count: favoriteRows.length })
  }
  for (const group of groups) {
    const rows = rowsByGroup.get(group.id) ?? []
    sections.push({
      kind: 'group',
      id: group.id,
      name: group.name,
      rows,
      collapsed: collapsedOf(prefs, group.id, rows, state),
      count: rows.length,
    })
  }
  return {
    sections,
    rows: sections.filter(section => !section.collapsed).flatMap(section => section.rows),
    searching: false,
    total,
    hits: total,
  }
}

/**
 * The group id whose collapse state Tab toggles for the highlighted row.
 * @returns provider id, or undefined when the row is a synthetic section.
 */
function toggleTarget(row) {
  return row?.provider
}

/**
 * Next highlight index with wraparound.
 * @param current - current index (-1 for none).
 * @param length - row count.
 * @param delta - ±1 (or a jump count).
 */
function stepIndex(current, length, delta) {
  if (length <= 0) return 0
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current
  return ((from + delta) % length + length) % length
}

/**
 * Record a pick in the recent list (most recent first, deduplicated, bounded).
 * @returns a new preferences object.
 */
function withRecent(prefs, key, now = Date.now()) {
  const recents = [{ key, at: now }, ...prefs.recents.filter(row => row.key !== key)].slice(0, RECENTS_LIMIT)
  return { ...prefs, recents }
}

/** Toggle one key in the favorites list. */
function withFavorite(prefs, key) {
  const favorites = prefs.favorites.includes(key)
    ? prefs.favorites.filter(other => other !== key)
    : [key, ...prefs.favorites]
  return { ...prefs, favorites }
}

/** Set an explicit collapse state for one group. */
function withCollapsed(prefs, groupId, collapsed) {
  return { ...prefs, collapsed: { ...prefs.collapsed, [groupId]: collapsed } }
}

    const PREFS_KEY = 'dsh-quick-model-selector:prefs:v1'
    // Pre-rename package key: read once, migrated, then dropped.
    const LEGACY_PREFS_KEY = 'dsh-model-palette:prefs:v1'
    const FALLBACK_CACHE_LIMIT = 32

    const COPY = {
      zh: {
        search: '搜索模型',
        triggerFallback: '选择模型',
        triggerAria: '选择模型',
        favorites: '收藏',
        recents: '最近使用',
        results: '搜索结果',
        empty: '没有匹配的模型',
        allFolded: '分组已折叠，点击展开',
        loading: '正在加载模型…',
        retry: '重试',
        effort: '推理强度',
        effortDefault: '默认',
        fold: '折叠',
        unfold: '展开',
        failed: '切换失败',
        keys: ['↑↓ 选择', 'Enter 确认', '⌘D 收藏'],
        keysEffort: ['↑↓ 选择', 'Enter 确认', 'Esc 关闭'],
        back: '返回',
        backToModels: '返回模型列表',
        selectAria: '选择模型',
        locked: '当前会话已锁定模型',
      },
      en: {
        search: 'Search models',
        triggerFallback: 'Select model',
        triggerAria: 'Select model',
        favorites: 'Favorites',
        recents: 'Recent',
        results: 'Results',
        empty: 'No matching model',
        allFolded: 'Groups collapsed — click to expand',
        loading: 'Loading models…',
        retry: 'Retry',
        effort: 'Reasoning effort',
        effortDefault: 'Default',
        fold: 'Collapse',
        unfold: 'Expand',
        failed: 'Could not switch',
        keys: ['↑↓ move', 'Enter select', '⌘D favorite'],
        keysEffort: ['↑↓ move', 'Enter select', 'Esc close'],
        back: 'Back',
        backToModels: 'Back to models',
        selectAria: 'Select model',
        locked: 'Model is locked for this session',
      },
    }
    const lang = typeof navigator !== 'undefined' && String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const copy = COPY[lang]
    const t = key => copy[key] ?? COPY.zh[key] ?? key

    const css = `
.qms-root{position:relative;display:flex;align-items:center;gap:2px;flex:0 0 auto;min-width:0}
.qms-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}
.qms-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.qms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,#c7cbd1)}
.qms-trigger:disabled{color:var(--dsw-alias-label-dimmed,#a8adb5);cursor:default}
.qms-trigger-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 窄行里保留模型名（超出用省略号），只把宽度收紧一点；图标不再顶替文字。 */
@container (width<=560px){.qms-trigger{max-width:150px}.qms-trigger-label{max-width:150px}}
/* 推理强度是模型按钮旁边的独立控件：各自 hover、各自点击、各自开自己的弹层。
   控制行排不下一行时宿主会置 --dsh-composer-model-text-display:none，强度按钮收起，退回模型菜单底部。 */
.qms-effort{display:var(--dsh-composer-model-text-display,block);flex:0 0 auto}
.qms-effort-btn{display:flex;align-items:center;gap:2px;height:28px;padding:0 4px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-caption,#8a8f98);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
.qms-effort-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.qms-effort-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,#c7cbd1)}
.qms-effort-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed,#a8adb5)}
.qms-chevron{flex:0 0 auto;color:var(--dsw-alias-label-caption,#8a8f98);transition:transform 120ms ease}
.qms-chevron.open{transform:rotate(180deg)}
.qms-menu,.qms-menu *{box-sizing:border-box}
.qms-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:30;display:flex;flex-direction:column;width:min(336px,calc(100vw - 32px));max-height:min(430px,calc(100vh - 140px));overflow:hidden;padding:5px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:var(--dsw-radius-lg,12px);outline:none;background:var(--dsw-specific-menu,#fff);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.14));color:var(--dsw-alias-label-primary,#1f2328);font-family:inherit;font-size:13px;line-height:18px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,#c7cbd1);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,#a8adb5)}
.qms-menu-effort{width:min(212px,calc(100vw - 32px));max-height:min(320px,calc(100vh - 140px))}
.qms-search{display:flex;flex:0 0 auto;align-items:center;gap:6px;margin:0 0 4px;padding:5px 7px;border:1px solid var(--dsw-alias-border-inverted,#e5e7eb);border-radius:7px;background:var(--dsw-alias-background-secondary,#f7f8f9)}
.qms-search svg{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.qms-input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:400;line-height:18px}
.qms-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.qms-kbd{flex:0 0 auto;padding:0 4px;border:1px solid var(--dsw-alias-border-inverted,#e5e7eb);border-radius:4px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:ui-monospace,monospace;font-size:10px;line-height:15px}
.qms-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.qms-fade{flex:0 0 24px;height:24px;margin-top:-24px;pointer-events:none;background:linear-gradient(to top,var(--dsw-specific-menu,#fff) 30%,transparent)}
.qms-head{display:flex;align-items:center;gap:5px;width:100%;height:24px;padding:0 6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:inherit;font-size:11px;font-weight:500;line-height:16px;text-align:left;cursor:pointer}
.qms-head.static{cursor:default}
.qms-head:hover:not(.static){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.qms-head-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em}
.qms-head-count{flex:0 0 auto;margin-left:auto;color:var(--dsw-alias-label-caption,#a8adb5);font-weight:400;font-variant-numeric:tabular-nums}
.qms-caret{display:grid;place-items:center;flex:0 0 10px;height:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);transition:transform 100ms ease}
.qms-caret.open{transform:rotate(90deg)}
.qms-row{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 6px;border:none;border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:400;line-height:18px;text-align:left;cursor:pointer;user-select:none}
.qms-row.nested{padding-left:17px}
.qms-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.qms-row.active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));box-shadow:inset 2px 0 0 var(--dsw-alias-label-link,#2377df)}
.qms-row.is-busy,.qms-row:disabled{cursor:default;color:var(--dsw-alias-label-dimmed,#a8adb5)}
.qms-star{display:grid;place-items:center;flex:0 0 14px;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-state-warn-label,#b07c1e);opacity:0;cursor:pointer;transition:opacity 80ms ease}
.qms-row:hover .qms-star,.qms-row.active .qms-star,.qms-star.on{opacity:1}
.qms-star:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08))}
.qms-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qms-tag{flex:0 0 auto;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#a8adb5);font-size:10px;line-height:14px}
.qms-badge{flex:0 0 auto;padding:0 4px;border-radius:4px;font-family:ui-monospace,monospace;font-size:10px;font-weight:500;line-height:15px}
.qms-badge.low{background:#eaf3de;color:#3b6d11}
.qms-badge.mid{background:#faeeda;color:#854f0b}
.qms-badge.high{background:#fcebeb;color:#a32d2d}
.qms-check{display:grid;place-items:center;flex:0 0 13px;color:var(--dsw-alias-label-primary,#1f2328)}
/* 窄到放不下那枚独立按钮时，推理强度退回模型菜单里，功能不丢。 */
.qms-link-slot{display:var(--dsh-composer-model-icon-display,none)}
.qms-link{display:flex;flex:0 0 28px;align-items:center;gap:5px;width:100%;height:28px;margin-top:3px;padding:0 6px;border:none;border-top:1px solid var(--dsw-alias-border-l2,#eceef1);background:transparent;color:inherit;font-family:inherit;font-size:12px;font-weight:400;line-height:18px;cursor:pointer}
.qms-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.qms-link:disabled{cursor:default;color:var(--dsw-alias-label-dimmed,#a8adb5)}
.qms-link-label{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}
.qms-link-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.qms-go{display:grid;place-items:center;flex:0 0 10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.qms-title{display:flex;flex:0 0 28px;align-items:center;gap:4px;height:28px;margin:0 0 3px;padding:0 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#eceef1)}
.qms-title-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;letter-spacing:.01em}
.qms-dot{flex:0 0 14px}
.qms-foot{display:flex;flex:0 0 auto;align-items:center;gap:10px;padding:5px 7px 1px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;line-height:15px}
.qms-status{padding:12px 8px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px}
.qms-error{display:flex;align-items:flex-start;gap:8px;margin:0 0 4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-danger,#fdecea);color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:18px}
.qms-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font-family:inherit;font-size:12px;font-weight:600;line-height:18px;cursor:pointer}
`

    if (typeof document !== 'undefined' && document.head.querySelector('style[data-plugin="dsh-quick-model-selector"]') === null) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-quick-model-selector')
      style.textContent = css
      document.head.append(style)
    }

    const readPrefs = () => {
      try {
        const stored = window.localStorage.getItem(PREFS_KEY)
        if (stored !== null) return normalizePrefs(JSON.parse(stored))
        // One-time migration from the pre-rename package: favorites, recents and
        // collapsed groups survive the rename instead of resetting.
        const legacy = window.localStorage.getItem(LEGACY_PREFS_KEY)
        if (legacy === null) return emptyPrefs()
        const migrated = normalizePrefs(JSON.parse(legacy))
        try {
          window.localStorage.setItem(PREFS_KEY, JSON.stringify(migrated))
          window.localStorage.removeItem(LEGACY_PREFS_KEY)
        } catch {
          /* private mode: migration is best-effort, the panel still works */
        }
        return migrated
      } catch {
        return emptyPrefs()
      }
    }
    const writePrefs = value => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(value))
      } catch {
        /* private mode: the panel still works, preferences just do not persist */
      }
    }

    const SearchIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 7, cy: 7, r: 4.6, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M10.4 10.4L14 14', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    const CheckIcon = () => h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M3 8.4L6.2 11.6L13 4.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const ChevronIcon = ({ open }) => h('svg', {
      className: `qms-chevron${open ? ' open' : ''}`, width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    }, h('path', { d: 'M4 6.5L8 10.5L12 6.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const CaretIcon = ({ open }) => h('span', { className: `qms-caret${open ? ' open' : ''}`, 'aria-hidden': true },
      h('svg', { width: 9, height: 9, viewBox: '0 0 16 16', fill: 'none' },
        h('path', { d: 'M6 3.5L10.5 8L6 12.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })))
    const ChevronRight = () => h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M6 3.5L10.5 8L6 12.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const ChevronLeft = () => h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M10 3.5L5.5 8L10 12.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const StarIcon = ({ on }) => h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', {
        d: 'M8 1.9l1.9 3.86 4.26.62-3.08 3.01.73 4.24L8 11.63l-3.81 2-0.73-4.24L.38 6.38l4.26-.62z',
        fill: on ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinejoin: 'round',
      }))
    /**
     * One selectable model row: star · name · optional provider tag · multiplier · check.
     *
     * A div rather than a button so the star can be a real nested button
     * without invalid markup; keyboard access goes through the menu's own
     * handler, which is where focus already lives.
     */
    function Row({ row, active, nested, tagged, disabled, onPick, onHover, onStar }) {
      return h('div', {
        role: 'menuitemradio',
        'aria-checked': row.selected ? 'true' : 'false',
        'aria-disabled': disabled ? 'true' : undefined,
        tabIndex: -1,
        'data-active': active ? 'true' : 'false',
        className: `qms-row${active ? ' active' : ''}${nested ? ' nested' : ''}${disabled ? ' is-busy' : ''}`,
        title: row.note === undefined ? row.label : `${row.label} · ${row.note}`,
        onMouseEnter: onHover,
        onClick: disabled ? undefined : onPick,
      },
        h('button', {
          type: 'button',
          tabIndex: -1,
          className: `qms-star${row.favorite ? ' on' : ''}`,
          title: row.favorite ? t('unfav') : t('fav'),
          'aria-label': row.favorite ? t('unfav') : t('fav'),
          onClick: event => {
            event.stopPropagation()
            onStar()
          },
        }, h(StarIcon, { on: row.favorite })),
        h('span', { className: 'qms-name' }, row.label),
        tagged && h('span', { className: 'qms-tag' }, row.providerName),
        row.multiplier !== null && h('span', { className: `qms-badge ${row.tone}` }, formatMultiplier(row.multiplier)),
        h('span', { className: 'qms-check' }, row.selected ? h(CheckIcon) : null))
    }

    /** One reasoning-effort row inside the drill-in pane. */
    function EffortRow({ choice, active, checked, disabled, onPick, onHover }) {
      return h('button', {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': checked ? 'true' : 'false',
        'data-active': active ? 'true' : 'false',
        className: `qms-row${active ? ' active' : ''}`,
        disabled,
        onMouseEnter: onHover,
        onClick: onPick,
      },
        h('span', { className: 'qms-dot', 'aria-hidden': true }),
        h('span', { className: 'qms-name' }, choice.label),
        h('span', { className: 'qms-check' }, checked ? h(CheckIcon) : null))
    }

    /**
     * The composer model seat.
     * @param props - the slot's injected face (directory store + verbs) and the owner's `locked`.
     */
    function QuickModelSelector({ locked, available, directory, load, select }) {
      const state = useSyncExternalStore(
        useCallback(fn => directory.subscribe(fn), [directory]),
        useCallback(() => directory.getSnapshot(), [directory]),
        useCallback(() => directory.getSnapshot(), [directory]))

      // Which popover is up: null (both down), 'models', or 'effort'. The two
      // are independent surfaces — opening one never pulls the other in.
      const [open, setOpen] = useState(null)
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(0)
      const [effortActive, setEffortActive] = useState(0)
      const [prefs, setPrefs] = useState(readPrefs)
      const [failure, setFailure] = useState(null)
      const [overflowing, setOverflowing] = useState(false)
      // Space actually available above the trigger; the composer is not always
      // docked at the bottom, so `100vh - 140px` is not a safe cap.
      const [roomAbove, setRoomAbove] = useState(null)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const effortRef = useRef(null)
      const menuRef = useRef(null)
      const inputRef = useRef(null)
      const bodyRef = useRef(null)
      // Folding removes the highlighted row from navigation. Keep its group
      // and key until the user moves, so the next Tab can unfold it again.
      const tabTargetRef = useRef(null)

      const view = useMemo(() => buildView(state, prefs, query), [state, prefs, query])
      const rows = view.rows
      const busy = state.status === 'selecting'

      const current = useMemo(() => {
        if (state.current === null || state.current === undefined) return null
        for (const group of state.groups ?? []) {
          for (const model of group.models ?? []) {
            if (group.id === state.current.provider && model.id === state.current.model) {
              return { group, model, parsed: parseModel(model) }
            }
          }
        }
        return null
      }, [state.current, state.groups])

      const efforts = current === null || current.model.reasoning === undefined
        ? undefined
        : current.model.reasoning.efforts ?? []
      const effectiveEffort = efforts === undefined
        ? undefined
        : state.current?.reasoningEffort ?? current.model.reasoning.defaultEffort
      const effortLabel = efforts === undefined
        ? undefined
        : effectiveEffort === undefined
          ? t('effortDefault')
          : efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
      const modelLabel = current === null ? t('triggerFallback') : current.parsed.label

      const effortChoices = useMemo(() => {
        if (efforts === undefined || current === null) return null
        return [
          ...current.model.reasoning.defaultEffort === undefined
            ? [{ key: 'default', value: undefined, label: t('effortDefault') }]
            : [],
          ...efforts.map(level => ({ key: level.id, value: level.id, label: level.name })),
        ]
      }, [efforts, current])

      const remember = useCallback(key => {
        setPrefs(currentPrefs => {
          const next = withRecent(currentPrefs, key)
          writePrefs(next)
          return next
        })
      }, [])

      // Mount-time load resolves the trigger label; every open refreshes.
      useEffect(() => {
        if (available) load()
      }, [available, load])

      useEffect(() => {
        if (open === null) return
        const closeOutside = event => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(null)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])

      // The search field owns focus in the model picker; the panel itself does
      // in the effort popover (there is nothing to type there).
      useEffect(() => {
        if (open === null) return
        if (open === 'models') inputRef.current?.focus()
        else menuRef.current?.focus()
      }, [open])

      useEffect(() => {
        if (open !== 'models') return
        setActive(at => (rows.length === 0 ? 0 : Math.min(at, rows.length - 1)))
      }, [open, rows.length])

      useEffect(() => {
        if (open !== 'models') return
        bodyRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
      }, [open, active, view])

      // Opening the effort popover lands the highlight on the current level.
      useEffect(() => {
        if (open !== 'effort') return
        const list = effortChoices ?? []
        const index = list.findIndex(choice => choice.value === effectiveEffort)
        setEffortActive(index < 0 ? 0 : index)
      }, [open, effortChoices, effectiveEffort])

      useEffect(() => {
        if (open !== 'effort') return
        bodyRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
      }, [open, effortActive])

      // A clipped row at the scroll edge reads as a rendering bug, so the list
      // gets a fade while there is more content below.
      const syncOverflow = useCallback(() => {
        const element = bodyRef.current
        setOverflowing(element !== null && element.scrollHeight - element.scrollTop - element.clientHeight > 1)
      }, [])

      useEffect(() => {
        if (open === 'models') syncOverflow()
      }, [open, view, syncOverflow])

      // `surface` names which control owns focus once the popover is gone —
      // `null` means the interaction is over (outside click, trigger toggle).
      const close = useCallback(surface => {
        setOpen(null)
        setQuery('')
        setFailure(null)
        if (surface === null || surface === undefined) return
        queueMicrotask(() => (surface === 'effort' ? effortRef : triggerRef).current?.focus())
      }, [])

      /** Open a surface, first measuring how much room the trigger has above it. */
      const openSurface = useCallback(surface => {
        const rect = rootRef.current?.getBoundingClientRect()
        setRoomAbove(rect === undefined ? null : Math.max(180, Math.round(rect.top - 16)))
        setOpen(surface)
      }, [])

      const pick = useCallback(row => {
        if (row === undefined || row === null) return
        setFailure(null)
        void select(row.selection).then(accepted => {
          if (!accepted) {
            const message = directory.getSnapshot().error
            setFailure(message === null || message === undefined ? t('failed') : `${t('failed')} · ${message}`)
            return
          }
          // Picking a model ends the interaction, exactly like the stock
          // picker: effort is a separate control the user opens on purpose.
          remember(row.key)
          close('models')
        })
      }, [select, remember, close, directory])

      const toggleFavorite = useCallback(row => {
        if (row === undefined || row === null) return
        tabTargetRef.current = null
        setPrefs(currentPrefs => {
          const next = withFavorite(currentPrefs, row.key)
          writePrefs(next)
          return next
        })
      }, [])

      const toggleGroup = useCallback((groupId, collapsed) => {
        setPrefs(currentPrefs => {
          const next = withCollapsed(currentPrefs, groupId, !collapsed)
          writePrefs(next)
          return next
        })
      }, [])

      const chooseEffort = useCallback(effort => {
        if (state.current === null || state.current === undefined) return
        setFailure(null)
        void select({
          provider: state.current.provider,
          model: state.current.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        }).then(accepted => {
          if (accepted) {
            close('effort')
            return
          }
          const message = directory.getSnapshot().error
          setFailure(message === null || message === undefined ? t('failed') : `${t('failed')} · ${message}`)
        })
      }, [select, state.current, directory, close])

      const onKeyDown = useCallback(event => {
        if (open === null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        // Buttons (triggers, group heads, stars and effort rows) keep their
        // native Enter/Space behavior. List navigation belongs to the search
        // field or the effort menu's own focus target.
        if (event.target !== inputRef.current && event.target !== menuRef.current) {
          if (event.key === 'Escape') {
            event.preventDefault()
            close(open)
          }
          return
        }
        if (open === 'effort') {
          const count = effortChoices === null ? 0 : effortChoices.length
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setEffortActive(at => stepIndex(at, count, event.key === 'ArrowDown' ? 1 : -1))
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            const choice = effortChoices?.[effortActive]
            if (choice !== undefined) chooseEffort(choice.value)
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            close('effort')
            return
          }
          return
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          tabTargetRef.current = null
          setActive(at => stepIndex(at, rows.length, event.key === 'ArrowDown' ? 1 : -1))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          pick(rows[active])
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (query !== '') {
            setQuery('')
            tabTargetRef.current = null
            setActive(0)
            return
          }
          close('models')
          return
        }
        if (event.key === 'Tab' && !view.searching && !event.shiftKey) {
          const row = rows[active]
          const provider = tabTargetRef.current?.provider ?? row?.provider
          const section = view.sections.find(candidate => candidate.kind === 'group'
            && (provider === undefined || candidate.id === provider))
          if (section === undefined) return
          event.preventDefault()
          if (tabTargetRef.current === null) {
            tabTargetRef.current = { provider: section.id, key: row?.key ?? section.rows[0]?.key }
          }
          if (section.collapsed) {
            const expanded = buildView(state, withCollapsed(prefs, section.id, false), query)
            const restored = expanded.rows.findIndex(candidate => candidate.key === tabTargetRef.current.key)
            setActive(restored < 0 ? 0 : restored)
          }
          toggleGroup(section.id, section.collapsed)
          return
        }
        if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
          const row = rows[Number(event.key) - 1]
          if (row === undefined) return
          event.preventDefault()
          pick(row)
          return
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          toggleFavorite(rows[active])
        }
      }, [open, effortChoices, effortActive, chooseEffort, close, rows, active, pick, query, view.sections, view.searching, state, prefs, toggleGroup, toggleFavorite])

      if (!available) return null

      const foldedOnly = !view.searching
        && view.total > 0
        && view.sections.some(section => section.kind === 'group' && section.collapsed)
      const emptyText = state.status === 'loading' && view.total === 0
        ? t('loading')
        : foldedOnly ? t('allFolded') : t('empty')

      let flat = -1
      const renderRow = (row, key, nested, tagged) => {
        flat += 1
        const index = flat
        return h(Row, {
          key,
          row,
          nested,
          tagged,
          active: index === active,
          disabled: busy,
          onPick: () => pick(row),
          onHover: () => {
            tabTargetRef.current = null
            setActive(index)
          },
          onStar: () => toggleFavorite(row),
        })
      }

      const sectionHead = (section, label, showCount) => {
        const foldable = section.kind === 'group'
        return h(foldable ? 'button' : 'div', {
          key: `head-${section.id}`,
          type: foldable ? 'button' : undefined,
          className: `qms-head${foldable ? '' : ' static'}`,
          onClick: foldable ? () => {
            tabTargetRef.current = null
            toggleGroup(section.id, section.collapsed)
          } : undefined,
          'aria-expanded': foldable ? !section.collapsed : undefined,
          title: foldable ? (section.collapsed ? t('unfold') : t('fold')) : undefined,
        },
          foldable ? h(CaretIcon, { open: !section.collapsed }) : h('span', { className: 'qms-caret' }),
          h('span', { className: 'qms-head-label' }, label),
          showCount && h('span', { className: 'qms-head-count' }, section.count))
      }

      const modelsPane = h(React.Fragment, null,
        h('div', { className: 'qms-search' },
          h(SearchIcon),
          h('input', {
            ref: inputRef,
            className: 'qms-input',
            type: 'text',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: event => {
              setQuery(event.currentTarget.value)
              tabTargetRef.current = null
              setActive(0)
            },
          }),
          h('span', { className: 'qms-kbd' }, 'esc')),

        failure !== null && h('div', { className: 'qms-error', role: 'alert' }, h('span', null, failure)),

        state.error !== null && state.error !== undefined && rows.length === 0
          && h('div', { className: 'qms-error', role: 'alert' },
            h('span', null, state.error),
            h('button', { type: 'button', className: 'qms-retry', onClick: () => load() }, t('retry'))),

        h('div', { ref: bodyRef, className: 'qms-body', onScroll: syncOverflow },
          rows.length === 0 && h('div', { className: 'qms-status' }, emptyText),

          view.sections.map(section => {
            if (section.kind === 'results') return sectionHead(section, t('results'), true)
            const label = section.kind === 'favorites'
              ? t('favorites')
              : section.kind === 'recents'
                ? t('recents')
                : section.name
            // Favorites and recents pull rows out of their provider group, so
            // those rows carry the provider name; grouped rows do not need it.
            const tagged = section.kind === 'favorites' || section.kind === 'recents'
            return h('div', { key: section.id },
              sectionHead(section, label, section.kind === 'group'),
              section.collapsed
                ? null
                : section.rows.map(row => renderRow(row, `${section.id}-${row.key}`, section.kind === 'group', tagged)))
          })),

        overflowing && h('div', { className: 'qms-fade', 'aria-hidden': true }),

        // Reached only when the row cannot carry both controls: effort keeps its
        // entry here rather than taking width away from the model name.
        // Only reachable here when the row is too tight for the separate
        // effort button (see .qms-link-slot) — the control never disappears.
        effortChoices !== null && effortChoices.length > 0 && h('div', { className: 'qms-link-slot' },
          h('button', {
            type: 'button',
            className: 'qms-link',
            'aria-haspopup': 'menu',
            onClick: () => openSurface('effort'),
          },
            h('span', { className: 'qms-link-label' }, t('effort')),
            h('span', { className: 'qms-link-value' }, effortLabel),
            h('span', { className: 'qms-go' }, h(ChevronRight)))),

        h('div', { className: 'qms-foot' }, t('keys').map(text => h('span', { key: text }, text))))

      // Its own popover, not a page swap: closing the model picker and opening
      // this one are separate steps, and picking a model never lands here.
      const effortPopup = h(React.Fragment, null,
        h('div', { className: 'qms-title' },
          h('span', { className: 'qms-title-label' }, t('effort'))),

        failure !== null && h('div', { className: 'qms-error', role: 'alert' }, h('span', null, failure)),

        h('div', { ref: bodyRef, className: 'qms-body' },
          (effortChoices ?? []).map((choice, index) => h(EffortRow, {
            key: choice.key,
            choice,
            active: index === effortActive,
            checked: effectiveEffort === choice.value,
            disabled: busy,
            onPick: () => chooseEffort(choice.value),
            onHover: () => setEffortActive(index),
          }))),

        h('div', { className: 'qms-foot' }, t('keysEffort').map(text => h('span', { key: text }, text))))

      return h('div', { ref: rootRef, className: 'qms-root', onKeyDown },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'qms-trigger',
          'aria-label': current === null ? t('triggerAria') : `${t('triggerAria')}: ${modelLabel}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open === 'models',
          title: locked ? t('locked') : modelLabel,
          disabled: locked,
          onClick: () => {
            // Idempotent toggle, but switching from the other surface is a
            // single click — the two controls are peers, not a chain.
            if (open === 'models') {
              close(null)
              return
            }
            openSurface('models')
            setQuery('')
            tabTargetRef.current = null
            setActive(0)
            setFailure(null)
            load()
          },
        },
          h('span', { className: 'qms-trigger-label' }, modelLabel),
          h(ChevronIcon, { open: open === 'models' })),

        // Sibling control, not part of the model pill: its own hit area, its own
        // popover, its own focus target. Collapses into the model menu (see
        // .qms-link-slot) only when the composer row is too narrow for both.
        effortChoices !== null && effortChoices.length > 0 && h('div', { className: 'qms-effort' },
          h('button', {
            ref: effortRef,
            type: 'button',
            className: 'qms-effort-btn',
            'aria-label': `${t('effort')}: ${effortLabel}`,
            'aria-haspopup': 'menu',
            'aria-expanded': open === 'effort',
            title: `${t('effort')}: ${effortLabel}`,
            disabled: locked || busy,
            onClick: () => {
              if (open === 'effort') {
                close(null)
                return
              }
              openSurface('effort')
              setFailure(null)
            },
          },
            effortLabel,
            h(ChevronIcon, { open: open === 'effort' }))),

        open === 'models' && h('div', {
          ref: menuRef,
          className: 'qms-menu',
          role: 'menu',
          tabIndex: -1,
          'aria-label': t('selectAria'),
          style: roomAbove === null ? undefined : { maxHeight: Math.min(430, roomAbove) },
        }, modelsPane),

        open === 'effort' && h('div', {
          ref: menuRef,
          className: 'qms-menu qms-menu-effort',
          role: 'menu',
          tabIndex: -1,
          'aria-label': t('effort'),
          style: roomAbove === null ? undefined : { maxHeight: Math.min(320, roomAbove) },
        }, effortPopup))
    }

    /** Minimal directory for hosts that do not expose the `modelDirectories` service. */
    const makeDirectory = (sessions, sessionId) => {
      let snapshot = { current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }
      const listeners = new Set()
      const update = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }
      return {
        store: {
          subscribe(fn) {
            listeners.add(fn)
            return () => { listeners.delete(fn) }
          },
          getSnapshot: () => snapshot,
        },
        async load() {
          update({ status: 'loading', error: null })
          const { result } = await sessions.models({ sessionId })
          if (!result.ok) {
            update({ status: 'error', error: `${result.error.code}: ${result.error.message}` })
            throw new Error(result.error.message)
          }
          update({ ...result.value, status: 'ready', error: null })
          return result.value
        },
        async select(selection) {
          update({ status: 'selecting', error: null })
          const { result } = await sessions.selectModel({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          })
          if (!result.ok) {
            update({ status: 'error', error: `${result.error.code}: ${result.error.message}` })
            throw new Error(result.error.message)
          }
          update({ current: result.value.selected, routable: true, status: 'ready', error: null })
        },
      }
    }

    /** Resolve the shared per-session directory, falling back to a local one. */
    const directoryFor = (scope, sessionId, cache) => {
      let shared
      try {
        shared = scope.get('modelDirectories')
      } catch {
        shared = undefined
      }
      if (shared !== undefined && shared !== null && typeof shared.directoryFor === 'function') {
        return shared.directoryFor(sessionId)
      }
      const existing = cache.get(sessionId)
      if (existing !== undefined) return existing
      let sessions
      try {
        sessions = scope.get('connection')?.api?.sessions ?? scope.get('sessions')
      } catch {
        sessions = undefined
      }
      const directory = makeDirectory(sessions, sessionId)
      if (cache.size >= FALLBACK_CACHE_LIMIT) cache.delete(cache.keys().next().value)
      cache.set(sessionId, directory)
      return directory
    }

    /**
     * How far below the stock seat this entry registers.
     *
     * The rule is "lowest live priority wins the cell", and provider plugins
     * already shadow the stock seat: dsh-codex-subscription sits at -10. -20
     * outranks that so this panel renders; raising it back above -10 returns
     * control to that plugin's picker (which owns codex-model hiding).
     */
    const SEAT_PRIORITY = -20

    /** Client plugin body: one shadowing entry on the composer's model seat. */
    const apply = ctx => {
      const cache = new Map()
      ctx.inject(['slots'], scope => {
        scope.slots.inject('conversation.input.model', () => {
          const dispose = scope.slots.register({
            name: 'conversation.input.model',
            priority: SEAT_PRIORITY,
            inject: sessionId => {
              const directory = directoryFor(scope, sessionId, cache)
              let sessions
              try {
                sessions = scope.get('sessions')
              } catch {
                sessions = undefined
              }
              const available = sessions === undefined || typeof sessions.subagentAddress !== 'function'
                ? true
                : sessions.subagentAddress(sessionId) === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => { /* surfaced on the store */ })
                },
                select: selection => available
                  ? directory.select(selection).then(() => true, () => false)
                  : Promise.resolve(false),
              }
            },
          }, QuickModelSelector)
          // warn level on purpose: the desktop log bridge forwards warn/error
          // only, so this line is how `harness.log` proves the seat mounted.
          console.warn(`[dsh-quick-model-selector] 模型座位已接管（priority ${SEAT_PRIORITY}）`)
          return dispose
        })
      })
    }

    return { name: 'quick-model-selector', inject: ['slots'], apply }
  },
})
