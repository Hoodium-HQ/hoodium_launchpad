/**
 * RPC access and ABIs.
 *
 * Barrel for `@hoodium/core/chain`. Consumers import from the subpath, never
 * from a file inside it — that keeps the package's surface a decision rather
 * than an accident of file layout.
 *
 * The launchpad ABIs are re-exported under explicit names rather than with
 * `export *`. Both `abi.ts` and `launchpad-abi.ts` call their factory
 * `factoryAbi` — one is Uniswap's, one is Hoodium's — which was harmless while
 * each was imported by path, and becomes ambiguous the moment they share a
 * namespace. Naming them apart removes a way to reach for the wrong contract
 * and still typecheck.
 */
export * from './rpc.js'
export * from './abi.js'
export {
  factoryAbi as launchpadFactoryAbi,
  curveAbi,
  FACTORY_EVENTS,
  CURVE_EVENTS,
} from './launchpad-abi.js'
