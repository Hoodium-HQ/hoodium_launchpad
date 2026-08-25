import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiUnreachableError,
  launchpadApi,
  type CandleInterval,
  type TokenListParams,
} from '@/lib/launchpad-api'

/**
 * "A live feed of new launches, updating within 5 seconds." Polling at 4s meets
 * that budget; a WebSocket is the right long-term answer and this is an honest
 * placeholder, not a substitute.
 */
const FEED_INTERVAL_MS = 4_000

export function useBackendHealth() {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: () => launchpadApi.health(),
    refetchInterval: 60_000,
    retry: 1,
  })
  return { ...query, isUnreachable: query.error instanceof ApiUnreachableError }
}

export function useLaunchpadConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => launchpadApi.config(),
    staleTime: 5 * 60_000,
  })
}

/**
 * A page of the explore grid plus `total` and the section counts.
 *
 * `placeholderData` keeps the previous page on screen while the next loads,
 * so paging never blanks the grid.
 */
export function useTokenList(params: TokenListParams, options: { live?: boolean } = {}) {
  return useQuery({
    queryKey: ['tokens', params],
    queryFn: () => launchpadApi.tokens(params),
    refetchInterval: options.live === false ? false : FEED_INTERVAL_MS,
    placeholderData: (previous) => previous,
  })
}

export function useToken(address?: string) {
  return useQuery({
    queryKey: ['token', address?.toLowerCase()],
    queryFn: () => launchpadApi.token(address!),
    enabled: Boolean(address),
    refetchInterval: FEED_INTERVAL_MS,
    // A 404 is an answer, not a transient failure.
    retry: (count, error) => !(error instanceof Error && 'status' in error && error.status === 404) && count < 2,
  })
}

export function useTokenTrades(address?: string, page = 1, limit = 25) {
  return useQuery({
    queryKey: ['trades', address?.toLowerCase(), page, limit],
    queryFn: () => launchpadApi.trades(address!, page, limit),
    enabled: Boolean(address),
    refetchInterval: FEED_INTERVAL_MS,
    placeholderData: (previous) => previous,
  })
}

export function useTokenHolders(address?: string, page = 1, limit = 25) {
  return useQuery({
    queryKey: ['holders', address?.toLowerCase(), page, limit],
    queryFn: () => launchpadApi.holders(address!, page, limit),
    enabled: Boolean(address),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
}

export function useTokenCandles(address: string | undefined, interval: CandleInterval) {
  return useQuery({
    queryKey: ['candles', address?.toLowerCase(), interval],
    queryFn: () => launchpadApi.candles(address!, interval),
    enabled: Boolean(address),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  })
}

export function useProfile(address?: string) {
  return useQuery({
    queryKey: ['profile', address?.toLowerCase()],
    queryFn: () => launchpadApi.profile(address!),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  })
}

export function useSaveLinks(address: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (links: { x: string | null; telegram: string | null }) => launchpadApi.saveLinks(address, links),
    onSuccess: () => client.invalidateQueries({ queryKey: ['token', address.toLowerCase()] }),
  })
}

/**
 * Pin the metadata document. Deliberately *not* folded into the launch
 * transaction: pinning can fail, and a launch that half-succeeded would leave a
 * permanent token pointing at nothing.
 */
export function usePinMetadata() {
  return useMutation({ mutationFn: launchpadApi.pinMetadata })
}
