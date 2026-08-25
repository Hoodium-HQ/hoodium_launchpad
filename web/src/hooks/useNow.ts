import { useEffect, useState } from 'react'

/**
 * A clock that ticks, for relative timestamps that should read "5s ago" and
 * then "6s ago" without a refetch.
 *
 * One interval per subscriber is fine at this scale: a grid of forty cards is
 * forty cheap `setState`s a second, and the alternative — a shared ticker with
 * a subscriber list — is more code than the problem is worth.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
