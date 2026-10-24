/**
 * Pure selector logic: model-label parsing, preference normalization, and the
 * view model the panel renders. No React, no DOM, no DSH imports — bundled
 * verbatim into the client half (see scripts/build-client.mjs) and unit
 * tested directly.
 */

/** Preference schema version. */
export const PREFS_VERSION = 1

/** Models per provider above which a group starts collapsed. */
export const COLLAPSE_THRESHOLD = 6

/** How many recent picks the panel remembers. */
export const RECENTS_LIMIT = 8

/** How many recents the panel shows as a section. */
export const RECENTS_SHOWN = 5

/** The trailing billing-multiplier token some providers put in a model name or description. */
const MULTIPLIER = /(?:^|[\s·|,，(（])[x×]\s*([0-9]+(?:\.[0-9]+)?)(?![0-9])/i

/** Word boundaries used for "starts a segment" matching (Kimi-K2.5 → kimi, k2, 5). */
const SEGMENT = /[\s\-_./·:：|,，()（）[\]]+/

/** Dangling separators left behind once the multiplier token is removed. */
const TRAILING_JUNK = /[\s·|,，;；:：\-–—_]+$/

/** Empty preferences. */
export function emptyPrefs() {
  return { version: PREFS_VERSION, favorites: [], recents: [], collapsed: {} }
}

/**
 * Coerce anything read from storage into the current schema. Unknown keys are
 * dropped, wrong types fall back to empty, and entries that cannot be
 * addressed are discarded rather than poisoning the whole payload.
 * @param raw - parsed storage value, or anything else.
 * @returns valid preferences.
 */
export function normalizePrefs(raw) {
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
export function modelKey(provider, model) {
  return `${provider}/${model}`
}

/**
 * Split a trailing multiplier token off a model name or description.
 * @param model - directory model ({ name, description }).
 * @returns display label without the token, the remaining note, and the value.
 */
export function parseModel(model) {
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
export function multiplierTone(value) {
  if (value === null || !Number.isFinite(value)) return 'none'
  if (value <= 0.3) return 'low'
  if (value <= 0.8) return 'mid'
  return 'high'
}

/** Format a multiplier deterministically regardless of locale. */
export function formatMultiplier(value) {
  return `x${Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** Tokenize a query into lowercase terms. */
export function queryTerms(query) {
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
export function buildView(state, prefs, query) {
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
export function toggleTarget(row) {
  return row?.provider
}

/**
 * Next highlight index with wraparound.
 * @param current - current index (-1 for none).
 * @param length - row count.
 * @param delta - ±1 (or a jump count).
 */
export function stepIndex(current, length, delta) {
  if (length <= 0) return 0
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current
  return ((from + delta) % length + length) % length
}

/**
 * Record a pick in the recent list (most recent first, deduplicated, bounded).
 * @returns a new preferences object.
 */
export function withRecent(prefs, key, now = Date.now()) {
  const recents = [{ key, at: now }, ...prefs.recents.filter(row => row.key !== key)].slice(0, RECENTS_LIMIT)
  return { ...prefs, recents }
}

/** Toggle one key in the favorites list. */
export function withFavorite(prefs, key) {
  const favorites = prefs.favorites.includes(key)
    ? prefs.favorites.filter(other => other !== key)
    : [key, ...prefs.favorites]
  return { ...prefs, favorites }
}

/** Set an explicit collapse state for one group. */
export function withCollapsed(prefs, groupId, collapsed) {
  return { ...prefs, collapsed: { ...prefs.collapsed, [groupId]: collapsed } }
}
