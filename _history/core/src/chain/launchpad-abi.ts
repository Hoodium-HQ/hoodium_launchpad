/**
 * Launchpad ABIs — re-exported from `@hoodium/shared/abi` (WA-N6).
 *
 * These were the clearest case of the duplication WA-N6 forbids: the same
 * fragments existed here and in the web app, free to drift apart the moment the
 * contract changed and only one side was updated.
 *
 * Read-only usage on this side. LP-N7 requires trading and graduation to work
 * with Hoodium's servers fully offline, so the browser talks to the contracts
 * directly and the backend is never in that path.
 */
export {
  launchpadFactoryAbi as factoryAbi,
  bondingCurveAbi as curveAbi,
  LAUNCHPAD_FACTORY_EVENTS as FACTORY_EVENTS,
  LAUNCHPAD_CURVE_EVENTS as CURVE_EVENTS,
} from '@hoodium/shared/abi'
