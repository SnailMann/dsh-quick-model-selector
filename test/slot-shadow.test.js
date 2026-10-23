import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * Verify the takeover mechanism against DSH's own slot registry.
 *
 * The plugin relies on single-slot shadowing: entries sharing a cell coexist at
 * distinct priorities and the lowest live one renders. This runs that rule on
 * the real SlotCore so a harness change shows up here instead of in the app.
 */
const modules = process.env.DSH_PROFILE_MODULES
  ?? join(homedir(), 'Library/Application Support/dsh-desktop/harness/profiles/node_modules')
const enginePath = join(modules, '@deepseek-ai/dsh-client-ui-slots/lib/index.js')

const SlotCore = await import(pathToFileURL(enginePath)).then(module => module.SlotCore).catch(() => undefined)
const skip = SlotCore === undefined ? 'DSH slot engine not found in the local profile' : false

/** A core with the composer model seat declared, as ui-conversation declares it. */
const declCore = () => {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: { 'conversation.input.model': { kind: 'single', scope: 'session' } },
  }, () => null)
  return core
}

const winnerOf = (core, name) => core.entriesOfSlot(name)[0]

test('the seat is a single-occupant slot', { skip }, () => {
  assert.equal(declCore().specDynamic('conversation.input.model').kind, 'single')
})

test('priority -1 wins the cell and leaves the stock entry registered', { skip }, () => {
  const core = declCore()
  core.register({ name: 'conversation.input.model' }, () => 'stock')
  core.register({ name: 'conversation.input.model', priority: -1 }, () => 'selector')
  const winners = core.entriesOfSlot('conversation.input.model')
  assert.equal(winners.length, 1, 'one entry per cell renders')
  assert.equal(winners[0].component(), 'selector')
  assert.equal(core.entries('conversation.input.model').length, 2, 'both entries stay on the ledger')
})

test('disposing the shadowing entry falls back to the stock one', { skip }, () => {
  const core = declCore()
  core.register({ name: 'conversation.input.model' }, () => 'stock')
  const dispose = core.register({ name: 'conversation.input.model', priority: -1 }, () => 'selector')
  dispose()
  assert.equal(winnerOf(core, 'conversation.input.model').component(), 'stock')
})

test('a same-priority duplicate throws, which is why an explicit priority is required', { skip }, () => {
  const core = declCore()
  core.register({ name: 'conversation.input.model' }, () => 'stock')
  assert.throws(
    () => core.register({ name: 'conversation.input.model' }, () => 'selector'),
    /priority|occupied|cell/i)
})

test('outranking a provider plugin that already shadows the seat', { skip }, () => {
  // Live topology: stock 0, dsh-codex-subscription -10, this plugin -20.
  const core = declCore()
  core.register({ name: 'conversation.input.model' }, () => 'stock')
  core.register({ name: 'conversation.input.model', priority: -10 }, () => 'codex')
  assert.equal(winnerOf(core, 'conversation.input.model').component(), 'codex')

  const dispose = core.register({ name: 'conversation.input.model', priority: -20 }, () => 'selector')
  assert.equal(winnerOf(core, 'conversation.input.model').component(), 'selector')
  assert.equal(core.entries('conversation.input.model').length, 3, 'all three stay registered')

  dispose()
  assert.equal(winnerOf(core, 'conversation.input.model').component(), 'codex', 'codex takes back over')
})
test('registering into an undeclared slot throws', { skip }, () => {
  assert.throws(() => new SlotCore().register({ name: 'conversation.input.model' }, () => null), /not declared/i)
})
