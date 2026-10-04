import type { ModuleContract } from "../host/types"

export const humanizerContract: ModuleContract = {
  module: "humanizer",
  sourceFiles: [
    "src/services/humanizer/protocol.ts",
    "src/services/humanizer/scheduler.ts",
    "src/components/ChatPanel.vue",
    "src/services/agent/runner.ts",
    "src/services/engine/harness/runtime.ts",
  ],
  // Root integration will refresh after the shared runtime/UI audit is complete.
  sourceHash: "2ab7687a16d8577f187f3a1ff665a46088efd9ae5af006873a547c8f1205c5e2",
  coverage: [
    {
      id: "hz-01",
      feature: "表达标记解析",
      description: "只识别整行 SPLIT 标记并将超过四泡的尾部合并；task 流保持单泡且不能合法沉默；SILENT 只在 casual 整条可见正文等于哨兵时成立",
      why: "输出协议必须对模型偏差采取可预测处理，不能把正文中的相似文本误当控制标记",
      layer: "unit",
      depth: "shallow",
      scenarios: ["humanizer-protocol-split-merge", "humanizer-task-single-part", "humanizer-silent-exact"],
    },
    {
      id: "hz-02",
      feature: "会话沉默护栏",
      description: "每会话只接受一次连续 SILENT；下一次同会话 SILENT 改为当前 Card 提供的短文本，不影响另一会话的首次沉默",
      why: "连续空回复会让用户误以为消息或系统故障，且状态不能跨会话串扰",
      layer: "unit",
      depth: "shallow",
      scenarios: ["humanizer-silence-guard"],
    },
    {
      id: "hz-03",
      feature: "逐泡揭示调度",
      description: "casual 气泡按可注入时钟顺序揭示并在完成后清除瞬态状态；取消会立即全显，主动消息首泡即时；首泡显示时释放正在输入标题栏所有权",
      why: "展示延迟不能改变消息正文或在取消、切会话后把内容藏住，阶段所有权也必须在首泡到达时结束",
      layer: "unit",
      depth: "deep",
      scenarios: ["humanizer-scheduler-casual", "humanizer-scheduler-cancel", "humanizer-scheduler-active-first", "humanizer-scheduler-titlebar"],
    },
    { id: "hz-04", feature: "真实生产组件呈现", description: "真实Tauri WebView内挂载生产ChatPanel，普通聊天显示Card typing，已提交内容按泡揭示，停止立即全显并清状态；这提供组件自动证据，不代替桌面截图人工观察", why: "纯调度器测试不能证明Vue组件正确消费瞬态揭示和阶段通道", layer: "e2e", depth: "deep", scenarios: ["humanizer-real-component-reveal"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}

export default humanizerContract
