// Profile 模块统一导出
export {
  initProfiles,
  discoverAllProfiles,
  ensureProfileLoaded,
  activateProfile,
  getActiveProfile,
  getActivePreset,
  listProfiles,
  getProfile,
  isProfilesLoaded,
  getBodyUrl,
  getParallaxLayerUrl,
  getCharacterScale,
  getCharacterScaleMode,
  getUiUrl,
  getProfileAssetUrl,
  resolveProfileAssetUrl,
  refreshProfileAssets,
  invalidateProfileCache,
  invalidateAllProfileCaches,
} from "./loader";

export {
  exportProfileZip,
  importProfileZip,
  deleteProfile,
  cloneProfile,
  nextCloneId,
  restoreDefaultResources,
} from "./io";

export type { ProfileOpResult } from "./io";

export type {
  ProfileData,
  ProfileMeta,
  ProfileTheme,
  ProfileThemeColors,
  ProfileParallax,
  ProfileParallaxLayer,
  ProfileDepthOfField,
  ProfileDofRegion,
  ProfileSound,
  ProfileCharacter,
  AnimDef,
  AnimFrame,
  ExpressionRule,
} from "./loader";
