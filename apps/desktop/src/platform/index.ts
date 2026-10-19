export { parseAppInfo, previewAppInfo, type AppInfo, type BuildProfile } from './appInfo.ts';
export {
  NAVIGATE_EVENT,
  createBrowserPlatform,
  createTauriPlatform,
  detectPlatform,
  listenWhileMounted,
  parseHideOutcome,
  parseNavigatePayload,
  toPathList,
  reportPlatformError,
  type HideOutcome,
  type NavigateTarget,
  type Platform,
  type Unlisten,
  type WindowApi,
} from './platform.ts';
export {
  PlatformProvider,
  useAppInfo,
  usePlatform,
  useWindowMaximized,
  type AppInfoState,
} from './PlatformContext.tsx';
export {
  ServiceError,
  parseDecision,
  parseProposal,
  parseQuarantine,
  parseScan,
  type DecisionResult,
  type Proposal,
  type QuarantineEntry,
  type ScanFinding,
  type ScanResult,
  type SecondChallenge,
  type ServiceApi,
} from './service.ts';
