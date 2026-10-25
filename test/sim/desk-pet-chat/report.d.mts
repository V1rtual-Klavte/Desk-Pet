export interface ChatRetentionPlan {
  blocked: boolean;
  reasons: string[];
  kept: string[];
  evicted: string[];
  keptBytes: number;
  evictedPaths?: string[];
}

export function renderChatReport(options: { runDir: string; generatedAt: string }): string;
export function writeChatReport(options: { runDir: string; generatedAt: string }): { path: string; markdown: string };
export function planChatRetention(options: {
  reportsDir: string;
  maxGroups?: number;
  maxBytes?: number;
  protect?: string[];
}): ChatRetentionPlan;
export function pruneChatRuns(options: {
  reportsDir: string;
  maxGroups?: number;
  maxBytes?: number;
  protect?: string[];
}): ChatRetentionPlan;
