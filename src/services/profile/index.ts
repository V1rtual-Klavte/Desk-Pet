// Profile 模块统一导出
export {
  initProfiles,
  discoverAllProfiles,
  ensureProfileLoaded,
  activateProfile,
  switchActiveProfile,
  getActiveProfile,
  readProfileMeta,
  getProfile,
  isProfilesLoaded,
  refreshProfileAssets,
  invalidateProfileCache,
  invalidateAllProfileCaches,
} from "./loader";

export {
  exportProfileZip,
  importProfileZip,
  deleteProfile,
  createProfile,
  nextCreateId,
  renameProfile,
  restoreDefaultResources,
  profileDisplayPath,
} from "./io";

export type { ProfileOpResult, RestoreResult } from "./io";

export type {
  ProfileData,
  ProfileMeta,
  ProfileTheme,
  ProfileParallax,
  ProfileParallaxLayer,
} from "./loader";
