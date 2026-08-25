import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router'
import { Clipart } from '@/components/Clipart'
import { Footer } from '@/components/Footer'
import { Navbar } from '@/components/Navbar'
import { TabBar } from '@/components/TabBar'
import { Skeleton } from '@/components/ui/skeleton'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import { Explore } from '@/routes/Explore'
import { useTheme } from '@/store/ui'

/**
 * Explore is the only eager route. The token page pulls in lightweight-charts
 * (~163 kB), which no first paint needs.
 */
const TokenPage = lazy(() => import('@/routes/TokenPage').then((m) => ({ default: m.TokenPage })))
const LaunchToken = lazy(() => import('@/routes/LaunchToken').then((m) => ({ default: m.LaunchToken })))
const Learn = lazy(() => import('@/routes/Learn').then((m) => ({ default: m.Learn })))
const Profile = lazy(() => import('@/routes/Profile').then((m) => ({ default: m.Profile })))

/**
 * The shell is hoodium.app's: a fixed navbar, a bottom tab bar below `md`, one
 * `max-w-7xl` column, the footer clearing the tab bar. Mobile-first — a single
 * column that widens, never a desktop layout squeezed down. `pt-24` clears the
 * fixed 64px navbar plus breathing room.
 */
export function App() {
  useTheme() // applies data-theme to <html>

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <Navbar />

      {/* Below `md` the primary navigation is the bottom tab bar, a sibling of
          the navbar fixed to the opposite edge — see `TabBar`. */}
      <TabBar />

      <main id="main" className="container max-w-7xl pad-safe-x pt-24 pb-10 sm:px-6">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Routes>
            {/* Everything is public — a shared token link must open for a stranger with no wallet. */}
            <Route path="/" element={<Explore />} />
            <Route path="/t/:address" element={<TokenPage />} />
            <Route path="/learn" element={<Learn />} />
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
    </>
  )
}

function LegacyTokenRedirect() {
  const { address = '' } = useParams()
  return <Navigate to={`/t/${address}`} replace />
}

function NotFound() {
  /* The one route that must never be indexed: every unknown path under this
     origin renders here with a 200. */
  useDocumentMeta({ title: 'Not found', noindex: true })

  return (
    <div className="py-24 text-center">
      <Clipart name="compass" className="mx-auto mb-6 size-32" />
      <h1 className="text-page-title">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">That page does not exist.</p>
    </div>
  )
}
