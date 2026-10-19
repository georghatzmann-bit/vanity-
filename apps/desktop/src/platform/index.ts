export { parseAppInfo, previewAppInfo, type AppInfo, type BuildProfile } from './appInfo.ts';
export {
  NAVIGATE_EVENT,
  createBrowserPlatform,
  createTauriPlatform,
  detectPlatform,
  listenWhileMounted,
  parseNavigatePayload,
  reportPlatformError,
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
