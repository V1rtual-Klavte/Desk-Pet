// ==========================================
// 聊天命令处理器
// 从 App.vue 抽离，处理聊天文本中的表情切换和窗口命令
// ==========================================

export interface StreamViewRef {
  setExpression(name: string): void;
}

