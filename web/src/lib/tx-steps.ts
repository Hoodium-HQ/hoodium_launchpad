/**
 * The approve-then-act flow, as a pure derivation.
 *
 * Every write that pulls an ERC-20 (`launch`, `buy`, `sell`, `fixAndBuy`) is
 * two signatures when the allowance is short and one when it is not. The bug
 * this file exists to prevent: the button read "Approve USDG" *after* the
 * approval had confirmed, because the flag driving it was derived from an
 * allowance read nobody refreshed. The step is derived here from the live
 * numbers only — never from "an approval was sent" — so the label can only
 * advance when the chain actually says the allowance is there, and it goes
 * back to "Approve" by itself when the amount due grows past what was granted.
 */
export type StepStatus = 'done' | 'current' | 'upcoming'

export interface TxStep {
  key: 'approve' | 'act'
  label: string
  status: StepStatus
}

export interface ApprovalFlowInput {
  /** Current on-chain allowance for the spender; `undefined` while unread. */
  allowance: bigint | undefined
  /** Amount the spender will pull — the *total*, fee and dev buy together. */
  due: bigint
  /**
   * The approval receipt is in but the allowance read has not caught up yet
   * (the public RPC can lag a block). The button waits rather than offering
   * the same approval twice.
   */
  syncing?: boolean
  approveLabel: string
  actLabel: string
}

export interface ApprovalFlow {
  /** Which action the primary button performs when pressed. */
  step: 'approve' | 'act'
  /** The primary button's text. */
  label: string
  /** True while the allowance is being re-read after an approval. */
  waiting: boolean
  steps: TxStep[]
}

export function needsApproval(allowance: bigint | undefined, due: bigint): boolean {
  return due > 0n && (allowance ?? 0n) < due
}

export function deriveApprovalFlow(input: ApprovalFlowInput): ApprovalFlow {
  const { allowance, due, syncing = false, approveLabel, actLabel } = input
  const short = needsApproval(allowance, due)

  // Nothing to pull: a single step, no approval row at all.
  if (due <= 0n) {
    return { step: 'act', label: actLabel, waiting: false, steps: [{ key: 'act', label: actLabel, status: 'current' }] }
  }

  if (!short) {
    return {
      step: 'act',
      label: actLabel,
      waiting: false,
      steps: [
        { key: 'approve', label: approveLabel, status: 'done' },
        { key: 'act', label: actLabel, status: 'current' },
      ],
    }
  }

  return {
    step: 'approve',
    label: syncing ? 'Confirming approval…' : approveLabel,
    waiting: syncing,
    steps: [
      { key: 'approve', label: approveLabel, status: 'current' },
      { key: 'act', label: actLabel, status: 'upcoming' },
    ],
  }
}
