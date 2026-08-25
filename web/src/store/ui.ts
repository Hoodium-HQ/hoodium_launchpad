import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Zustand holds **UI state only**. Chain state belongs to wagmi and server
 * state to TanStack Query; duplicating either here is how they drift apart.
 *
 * Nothing persisted from this store is or could become a credential.
 */
type Theme = 'dark' | 'light'

interface UiState {
  theme: Theme
  setTheme: (theme: Theme) => void

  /** Acknowledged once, before the first purchase. */
  riskAcknowledged: boolean
  acknowledgeRisk: () => void

  /** Slippage tolerance in basis points. */
  slippageBps: number
  setSlippageBps: (bps: number) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      setTheme: (theme) => set({ theme }),

      riskAcknowledged: false,
      acknowledgeRisk: () => set({ riskAcknowledged: true }),

      // 1% default. High enough that ordinary curve movement does not revert a
      // trade, low enough that a sandwich costs the attacker more than it earns.
      slippageBps: 100,
      setSlippageBps: (slippageBps) => set({ slippageBps }),
    }),
    {
      name: 'hoodium-launchpad-ui',
      partialize: (state) => ({
        theme: state.theme,
        riskAcknowledged: state.riskAcknowledged,
        slippageBps: state.slippageBps,
      }),
    },
  ),
)

/** Applies the theme to `<html data-theme>`, which is what the CSS variables key off. */
export function useTheme() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') }
}
