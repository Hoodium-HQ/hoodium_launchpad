/**
 * The price scale against pools at every magnitude this chain produces.
 *
 * This exists because reasoning about the fix was not enough to get it right.
 * lightweight-charts derives `base = Math.round(1 / minMove)` and
 * `PriceTickSpanCalculator` throws `unexpected base` unless that base is an
 * exact power of ten — `1 / 1e-18` evaluates to `999999999999999900`, so a
 * `minMove` that looks perfectly reasonable crashes every frame the chart draws.
 *
 * A unit test over `minMoveFor` can only check the rule we believe in. This one
 * hands the number to the real library and makes it draw.
 *
 * **The draw is deferred to `requestAnimationFrame`, and a throw inside one does
 * not reach the caller.** A first version of this file called `setData` and
 * asserted `not.toThrow()` — it passed against code known to be broken. So
 * frames are run explicitly here and their errors collected; without that, this
 * file asserts nothing at all.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChart, type UTCTimestamp } from 'lightweight-charts'
import { minMoveFor } from '../src/components/AreaChart'

/** Frames the chart has queued but not yet run. */
let queued: FrameRequestCallback[] = []

/**
 * jsdom has no canvas, no `matchMedia` and no `ResizeObserver`, and the chart
 * needs all three to exist before it will lay anything out. They are stubbed
 * rather than implemented on purpose: nothing here asserts on pixels. What is
 * under test is the tick-mark builder, which is arithmetic and runs in full
 * regardless of where the strokes land.
 */
beforeAll(() => {
  const noop = () => undefined

  const context2d = new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as Record<string, unknown>,
    { get: (target, prop) => (prop in target ? target[prop as string] : noop) },
  )
  HTMLCanvasElement.prototype.getContext = (() => context2d) as never

  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  })) as never

  window.ResizeObserver ??= class {
    observe = noop
    unobserve = noop
    disconnect = noop
  } as never

  // Frames are captured rather than scheduled, so the test decides when the
  // chart draws and can see what happens when it does.
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  }) as never
  window.cancelAnimationFrame = noop as never
})

beforeEach(() => {
  queued = []
})

/** Run every queued frame, returning whatever they threw. */
function runFrames(): Error[] {
  const errors: Error[] = []
  for (let pass = 0; pass < 10 && queued.length > 0; pass++) {
    const batch = queued
    queued = []
    for (const frame of batch) {
      try {
        frame(0)
      } catch (err) {
        errors.push(err as Error)
      }
    }
  }
  return errors
}

/**
 * A token priced like a fresh launch: 18 decimals quoted in a 6-decimal stablecoin.
 *
 * `level` rather than `price` because the money rule (WA-N4) rightly flags float
 * arithmetic on anything named that way. These are synthetic chart coordinates —
 * the library's API takes `number` and there is nothing here to settle against —
 * so the name says so instead of a disable comment claiming an exemption.
 */
function series(centre: number) {
  const start = 1_700_000_000
  return Array.from({ length: 48 }, (_, i) => {
    const level = centre * (1 + ((i % 9) - 4) * 0.01)
    return {
      time: (start + i * 900) as UTCTimestamp,
      open: level,
      high: level * 1.008,
      low: level * 0.992,
      close: level * 1.002,
    }
  })
}

function drawAt(centre: number): Error[] {
  const element = document.createElement('div')
  document.body.appendChild(element)

  const chart = createChart(element, { width: 800, height: 320 })
  const data = series(centre)
  const candles = chart.addCandlestickSeries({
    priceFormat: {
      type: 'custom',
      minMove: minMoveFor(data.flatMap((c) => [c.low, c.high])),
      formatter: (v: number) => v.toPrecision(3),
    },
  })

  candles.setData(data)
  chart.timeScale().fitContent()

  const errors = runFrames()

  chart.remove()
  element.remove()
  return errors
}

describe('price scale across token magnitudes', () => {
  it('queues a frame at all, or every case below passes vacuously', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const chart = createChart(element, { width: 800, height: 320 })
    chart.addLineSeries().setData([{ time: 1_700_000_000 as UTCTimestamp, value: 1 }])

    expect(queued.length).toBeGreaterThan(0)
    chart.remove()
    element.remove()
  })

  it.each([
    ['1e-14, an 18-decimal token in a 6-decimal quote', 3.885e-14],
    ['1e-8', 4.2e-8],
    ['about 1, a stable pair', 1.0001],
    ['millions per unit', 4_319_007],
  ])('draws without throwing at %s', (_label, centre) => {
    expect(drawAt(centre)).toEqual([])
  })
})
