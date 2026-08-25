/**
 * The approve-then-act step derivation. The live bug: after "Approve USDG"
 * confirmed, the button still said "Approve USDG" because the flag behind it
 * came from an allowance read that was never refreshed. The step must follow
 * the numbers — allowance against the *total* due — and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { deriveApprovalFlow, needsApproval } from '../src/lib/tx-steps'

const labels = { approveLabel: 'Approve USDG', actLabel: 'Launch token' }
const USDG = (n: number) => BigInt(n) * 10n ** 6n

describe('needsApproval', () => {
  it('is false when nothing is due, whatever the allowance', () => {
    expect(needsApproval(undefined, 0n)).toBe(false)
    expect(needsApproval(0n, 0n)).toBe(false)
  })

  it('treats an unread allowance as zero', () => {
    expect(needsApproval(undefined, USDG(1))).toBe(true)
  })

  it('is exact at the boundary', () => {
    expect(needsApproval(USDG(1), USDG(1))).toBe(false)
    expect(needsApproval(USDG(1) - 1n, USDG(1))).toBe(true)
  })
})

describe('deriveApprovalFlow', () => {
  it('starts on the approval step with the act step upcoming', () => {
    const flow = deriveApprovalFlow({ allowance: 0n, due: USDG(1), ...labels })
    expect(flow.step).toBe('approve')
    expect(flow.label).toBe('Approve USDG')
    expect(flow.waiting).toBe(false)
    expect(flow.steps.map((s) => [s.key, s.status])).toEqual([
      ['approve', 'current'],
      ['act', 'upcoming'],
    ])
  })

  it('skips straight to the action when the allowance is already sufficient on mount', () => {
    const flow = deriveApprovalFlow({ allowance: USDG(5), due: USDG(1), ...labels })
    expect(flow.step).toBe('act')
    expect(flow.label).toBe('Launch token')
    expect(flow.steps.map((s) => [s.key, s.status])).toEqual([
      ['approve', 'done'],
      ['act', 'current'],
    ])
  })

  it('advances to the action once the re-read allowance covers the due — no extra click', () => {
    const before = deriveApprovalFlow({ allowance: 0n, due: USDG(1), ...labels })
    const after = deriveApprovalFlow({ allowance: USDG(1), due: USDG(1), ...labels })
    expect(before.step).toBe('approve')
    expect(after.step).toBe('act')
    expect(after.label).toBe('Launch token')
    // The approval stays visible as a finished step.
    expect(after.steps[0]).toEqual({ key: 'approve', label: 'Approve USDG', status: 'done' })
  })

  it('waits, rather than offering the same approval again, while the read catches up', () => {
    const flow = deriveApprovalFlow({ allowance: 0n, due: USDG(1), syncing: true, ...labels })
    expect(flow.step).toBe('approve')
    expect(flow.waiting).toBe(true)
    expect(flow.label).toBe('Confirming approval…')
  })

  it('re-requires approval when the amount due grows past what was granted', () => {
    // Approved the 1 USDG fee, then typed a 10 USDG dev buy: due is fee + dev buy.
    const creationDue = USDG(1)
    const approvedForFee = deriveApprovalFlow({ allowance: creationDue, due: creationDue, ...labels })
    expect(approvedForFee.step).toBe('act')

    const withDevBuy = deriveApprovalFlow({ allowance: creationDue, due: creationDue + USDG(10), ...labels })
    expect(withDevBuy.step).toBe('approve')
    expect(withDevBuy.label).toBe('Approve USDG')
    expect(withDevBuy.steps[0]?.status).toBe('current')
  })

  it('shows a single step when nothing is due', () => {
    const flow = deriveApprovalFlow({ allowance: undefined, due: 0n, ...labels })
    expect(flow.step).toBe('act')
    expect(flow.steps).toEqual([{ key: 'act', label: 'Launch token', status: 'current' }])
  })
})
