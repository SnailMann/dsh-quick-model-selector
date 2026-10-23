import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAPSE_THRESHOLD, buildView, emptyPrefs, formatMultiplier, modelKey, multiplierTone,
  normalizePrefs, parseModel, queryTerms, stepIndex, withCollapsed, withFavorite, withRecent,
} from '../src/logic.js'

const model = (id, name, description) => ({ id, name, ...description === undefined ? {} : { description } })
const group = (id, name, models) => ({ id, name, models })
const state = (groups, current = null) => ({ current, routable: true, groups, failures: [], status: 'ready', error: null })

test('parseModel pulls a trailing multiplier out of the name', () => {
  const parsed = parseModel(model('glm-5-turbo', 'GLM-5-Turbo · x0.51'))
  assert.equal(parsed.label, 'GLM-5-Turbo')
  assert.equal(parsed.multiplier, 0.51)
  assert.equal(parsed.note, undefined)
})

test('parseModel pulls a multiplier out of the description', () => {
  const parsed = parseModel(model('kimi', 'Kimi-K2.5', 'Trae · x0.48'))
  assert.equal(parsed.label, 'Kimi-K2.5')
  assert.equal(parsed.multiplier, 0.48)
  assert.equal(parsed.note, 'Trae')
})

test('parseModel leaves a name without a multiplier untouched', () => {
  const parsed = parseModel(model('g', 'Gemini-3-Flash-Preview', 'Trae Global'))
  assert.equal(parsed.label, 'Gemini-3-Flash-Preview')
  assert.equal(parsed.multiplier, null)
  assert.equal(parsed.note, 'Trae Global')
})

test('parseModel does not mistake an x inside a word for a multiplier', () => {
  assert.equal(parseModel(model('a', 'max0.5-preview')).multiplier, null)
  assert.equal(parseModel(model('b', 'x0.9-turbo')).multiplier, 0.9)
})

test('formatMultiplier trims trailing zeros', () => {
  assert.equal(formatMultiplier(0.5), 'x0.5')
  assert.equal(formatMultiplier(0.12), 'x0.12')
  assert.equal(formatMultiplier(1), 'x1')
})

test('multiplierTone buckets the price bands', () => {
  assert.equal(multiplierTone(0.12), 'low')
  assert.equal(multiplierTone(0.3), 'low')
  assert.equal(multiplierTone(0.51), 'mid')
  assert.equal(multiplierTone(0.9), 'high')
  assert.equal(multiplierTone(null), 'none')
})

test('normalizePrefs survives junk and dedupes entries', () => {
  const prefs = normalizePrefs({
    favorites: ['a/1', 'a/1', 'nonsense', 42],
    recents: [{ key: 'a/2', at: 5 }, { key: 'a/2', at: 9 }, { key: 7 }],
    collapsed: { a: true, b: 'yes' },
  })
  assert.deepEqual(prefs.favorites, ['a/1'])
  assert.deepEqual(prefs.recents, [{ key: 'a/2', at: 5 }])
  assert.deepEqual(prefs.collapsed, { a: true })
})

test('normalizePrefs returns empty prefs for non-objects', () => {
  assert.deepEqual(normalizePrefs(null), emptyPrefs())
  assert.deepEqual(normalizePrefs('x'), emptyPrefs())
  assert.deepEqual(normalizePrefs([]), emptyPrefs())
})

test('queryTerms splits on whitespace and lowercases', () => {
  assert.deepEqual(queryTerms('  Kimi  K2 '), ['kimi', 'k2'])
  assert.deepEqual(queryTerms(null), [])
})

test('buildView shows favorites and recents ahead of provider groups', () => {
  const groups = [group('trae', 'Trae', [model('kimi', 'Kimi-K2.5'), model('glm', 'GLM-5-Turbo')])]
  const prefs = withRecent(withFavorite(emptyPrefs(), 'trae/glm'), 'trae/kimi')
  const view = buildView(state(groups, { provider: 'trae', model: 'glm' }), prefs, '')
  assert.deepEqual(view.sections.map(section => section.kind), ['favorites', 'recents', 'group'])
  assert.equal(view.sections[0].rows[0].key, 'trae/glm')
  assert.equal(view.sections[1].rows[0].key, 'trae/kimi')
  assert.equal(view.sections[2].collapsed, false)
  assert.equal(view.rows.length, 4)
})

test('a group above the threshold starts collapsed unless it owns the selection', () => {
  const models = Array.from({ length: COLLAPSE_THRESHOLD + 2 }, (_, index) => model(`m${index}`, `Model-${index}`))
  const groups = [group('big', 'Big', models), group('small', 'Small', [model('s', 'Solo')])]
  const collapsedView = buildView(state(groups), emptyPrefs(), '')
  assert.equal(collapsedView.sections.find(section => section.id === 'big').collapsed, true)
  assert.equal(collapsedView.sections.find(section => section.id === 'small').collapsed, false)
  assert.equal(collapsedView.rows.length, 1)

  const ownedView = buildView(state(groups, { provider: 'big', model: 'm3' }), emptyPrefs(), '')
  assert.equal(ownedView.sections.find(section => section.id === 'big').collapsed, false)
})

test('an explicit collapse preference beats the threshold and the selection', () => {
  const groups = [group('small', 'Small', [model('a', 'A'), model('b', 'B')])]
  const prefs = withCollapsed(emptyPrefs(), 'small', true)
  const view = buildView(state(groups, { provider: 'small', model: 'a' }), prefs, '')
  assert.equal(view.sections[0].collapsed, true)
  assert.equal(view.rows.length, 0)
})

test('search filters across model and provider names, best match first', () => {
  const groups = [
    group('trae', 'Trae', [model('kimi', 'Kimi-K2.5'), model('glm', 'GLM-5-Turbo')]),
    group('trae-global', 'Trae Global', [model('kimi', 'Kimi-K2.5')]),
  ]
  const view = buildView(state(groups), emptyPrefs(), 'kimi')
  assert.equal(view.searching, true)
  assert.equal(view.hits, 2)
  assert.equal(view.sections[0].kind, 'results')
  assert.deepEqual(view.rows.map(row => row.provider), ['trae', 'trae-global'])

  const providerHit = buildView(state(groups), emptyPrefs(), 'global')
  assert.deepEqual(providerHit.rows.map(row => row.key), ['trae-global/kimi'])
})

test('multi-term search requires every term (AND)', () => {
  const groups = [group('trae', 'Trae', [model('kimi', 'Kimi-K2.5'), model('glm', 'GLM-5-Turbo')])]
  assert.equal(buildView(state(groups), emptyPrefs(), 'kimi 2.5').hits, 1)
  assert.equal(buildView(state(groups), emptyPrefs(), 'kimi glm').hits, 0)
})

test('search surfaces favorites and the selection above plain matches', () => {
  const groups = [group('trae', 'Trae', [model('a', 'Alpha'), model('b', 'Alpha-Pro')])]
  const prefs = withFavorite(emptyPrefs(), 'trae/b')
  const view = buildView(state(groups), prefs, 'alpha')
  assert.deepEqual(view.rows.map(row => row.key), ['trae/b', 'trae/a'])
})

test('selection payload carries the current effort for the selected model', () => {
  const groups = [group('p', 'P', [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }])]
  const view = buildView(state(groups, { provider: 'p', model: 'm', reasoningEffort: 'high' }), emptyPrefs(), '')
  assert.equal(view.rows[0].selection.reasoningEffort, 'high')

  const other = buildView(state(groups, { provider: 'x', model: 'y' }), emptyPrefs(), '')
  assert.equal(other.rows[0].selection.reasoningEffort, 'low')
})

test('withRecent keeps newest first, dedupes, and folds the selection in', () => {
  let prefs = emptyPrefs()
  prefs = withRecent(prefs, 'a/1', 1)
  prefs = withRecent(prefs, 'a/2', 2)
  prefs = withRecent(prefs, 'a/1', 3)
  assert.deepEqual(prefs.recents.map(row => row.key), ['a/1', 'a/2'])
  assert.equal(prefs.recents[0].at, 3)
})

test('withFavorite toggles and pins newest first', () => {
  let prefs = withFavorite(emptyPrefs(), 'a/1')
  prefs = withFavorite(prefs, 'a/2')
  assert.deepEqual(prefs.favorites, ['a/2', 'a/1'])
  prefs = withFavorite(prefs, 'a/1')
  assert.deepEqual(prefs.favorites, ['a/2'])
})

test('stepIndex wraps in both directions', () => {
  assert.equal(stepIndex(0, 3, 1), 1)
  assert.equal(stepIndex(2, 3, 1), 0)
  assert.equal(stepIndex(0, 3, -1), 2)
  assert.equal(stepIndex(-1, 3, 1), 0)
  assert.equal(stepIndex(-1, 3, -1), 2)
  assert.equal(stepIndex(0, 0, 1), 0)
})

test('modelKey joins provider and model', () => {
  assert.equal(modelKey('trae', 'Kimi-K2.5'), 'trae/Kimi-K2.5')
})
