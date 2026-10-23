/**
 * Host half.
 *
 * The visible work happens in the browser bundle (it takes over the composer's
 * model seat). This half exists so the package has a loadable entry, and it
 * emits one warn-level line because that is the only level the desktop log
 * bridge records — `harness.log` is how we prove the entry activated.
 */
export const name = 'quick-model-selector'

// Module-top stderr on purpose: it fires on import, so one restart tells
// "entry never created" apart from "imported but apply did not run".
console.error('[dsh-quick-model-selector] host module evaluated')

export function apply(ctx) {
  console.error('[dsh-quick-model-selector] apply invoked')
  ctx.logger?.warn?.('[dsh-quick-model-selector] host 半已激活，客户端座位接管待装配')
}
