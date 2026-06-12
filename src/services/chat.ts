/**
 * 兼容性导出 —— 所有逻辑已迁移至 @/features/chat
 * 保留此文件避免其他模块引用报错
 */
export {
  chatHistory,
  sendMessage,
  setAIConfig,
  getAIConfig,
} from "@/features/chat";

export type { Message, AIConfig } from "@/features/chat";
