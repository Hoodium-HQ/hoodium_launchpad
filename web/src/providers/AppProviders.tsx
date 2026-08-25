import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { appKit, wagmiConfig } from '@/config/chain'
import { useUiStore } from '@/store/ui'

/**
 * Server state is TanStack Query (which wagmi already depends on — no second
 * caching layer), chain state is wagmi, UI state is Zustand. design.md section 1.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
})


/**
 * AppKit's modal is a set of global custom elements rather than a React subtree,
 * so it is constructed once at module scope (config/chain.ts) and there is no
 * provider to nest here. Its theme is therefore imperative: the store is the one
 * source of truth for light/dark, and this is what carries that across the
 * boundary into a tree React does not own.
 */
function useAppKitTheme() {
  const theme = useUiStore((s) => s.theme)

  useEffect(() => {
    appKit.setThemeMode(theme)
  }, [theme])
}

export function AppProviders({ children }: { children: ReactNode }) {
  useAppKitTheme()

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
