import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router'
import { Footer } from '@/components/Footer'
import { Navbar } from '@/components/Navbar'
import { Skeleton } from '@/components/ui/skeleton'
import { Explore } from '@/routes/Explore'
import { useTheme } from '@/store/ui'

/**
 * Explore is the only eager route. The token page pulls in lightweight-charts
 * (~163 kB), which no first paint needs.
 */
const TokenPage = lazy(() => import('@/routes/TokenPage').then((m) => ({ default: m.TokenPage })))
const LaunchToken = lazy(() => import('@/routes/LaunchToken').then((m) => ({ default: m.LaunchToken })))
const Profile = lazy(() => import('@/routes/Profile').then((m) => ({ default: m.Profile })))

/**
 * Mobile-first shell: a single column that widens, never a desktop layout
 * squeezed down. `pt-24` clears the fixed 64px navbar plus breathing room.
 */
export function App() {
  useTheme() // applies data-theme to <html>

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <Navbar />

      <main
        id="main"
        className="container max-w-7xl flex-1 pad-safe-x pt-24 sm:px-6"
        style={{ paddingBottom: 'max(4rem, calc(3rem + env(safe-area-inset-bottom)))' }}
      >
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Routes>
            {/* Everything is public — a shared token link must open for a stranger with no wallet. */}
            <Route path="/" element={<Explore />} />
            <Route path="/t/:address" element={<TokenPage />} />
            <Route path="/create" element={<LaunchToken />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/:address" element={<Profile />} />

            {/* Aliases from the launchpad's first life inside hoodium.app. Links are in the wild. */}
            <Route path="/launchpad" element={<Navigate to="/" replace />} />
            <Route path="/launchpad/new" element={<Navigate to="/create" replace />} />
            <Route path="/launchpad/:address" element={<LegacyTokenRedirect />} />
            <Route path="/explore" element={<Navigate to="/" replace />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      <Footer />
    </div>
  )
}

function LegacyTokenRedirect() {
  const { address = '' } = useParams()
  return <Navigate to={`/t/${address}`} replace />
}

function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="text-page-title">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">That page does not exist.</p>
    </div>
  )
}
