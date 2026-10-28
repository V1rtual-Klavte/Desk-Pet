export const GAIA_REVISION: string;
export const GAIA_REPOSITORY: string;
export const GAIA_DATA_ROOT: string;
export const GAIA_EXPECTED_QUESTIONS: Readonly<{ validation: number; test: number }>;

export interface GaiaQuestionCounts {
  records: number;
  byLevel: Record<number, number>;
  rowsWithReferenceAnswer: number;
  uniqueReferenceAnswerCount: number;
  knownPlaceholderCounts: Record<string, number>;
  rowsWithAttachment: number;
  uniqueReferencedAssets: number;
  missingReferencedAssets: string[];
}

export interface GaiaInstallResult {
  schemaVersion: 1;
  dataset: "gaia";
  status: "complete" | "verification-failed";
  authorizedLocalAccess: true;
  personalIdentityRecorded: false;
  revision: string;
  devAlias: "validation";
  sourceManifest: Record<string, unknown>;
  files: Array<Record<string, unknown> & { path: string; split: "validation" | "test"; bytes: number; sha256: string; cached: boolean }>;
  totalBytes: number;
  cached: boolean;
  expected: {
    questions: { validation: number; test: number };
    files: { validation: number; test: number; total: number };
    validationUniqueReferenceAnswers: number;
    testReferenceAnswerPlaceholders: Record<string, number>;
  };
  actual: { files: { validation: number; test: number; total: number }; questions: Record<"validation" | "test", GaiaQuestionCounts> };
  completeCounts: boolean;
  adaptationBoundary: string;
}

export function installGaia(options?: {
  repoRoot?: string;
  pythonExecutable?: string;
  onProgress?: (event: Record<string, unknown>) => void;
}): Promise<GaiaInstallResult>;
export function verifyGaiaInstall(options?: { repoRoot?: string }): Promise<{
  ready: boolean;
  reason?: "not-installed" | "incomplete-install";
  revision?: string;
  totalBytes?: number;
  actual?: GaiaInstallResult["actual"];
  authorizedLocalAccess?: true;
  personalIdentityRecorded?: false;
}>;
