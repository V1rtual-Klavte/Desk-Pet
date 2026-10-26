# 审批记录

当前没有审批记录，`saturday-companionship` 是 **silver / pending**。

只有用户本人针对当前 `specHash` 的真实会话消息审阅后，才能在这里新增审批记录。代理可以起草候选、展示审阅包和差异，但不得代填 `reviewer`、`feedbackSource` 或审批结论，也不得把框架层面的方案通过当成用例审批。

本 case 的 23 条探针（含 6 条 `humanizer.*` semantic）和 humanizer 质量 rubric 全部由独立 coding-agent judge 判定，没有 `human` 权威分流；用户可以抽查任一规则，gold 批准仍只能由用户本人给出。

审批记录至少包含：

```json
{
  "schemaVersion": 4,
  "approvalId": "approval-<stamp>",
  "caseId": "saturday-companionship",
  "suiteId": "daily-companionship",
  "decision": "approved",
  "reviewer": { "role": "user", "name": "<用户名>" },
  "feedbackSource": {
    "kind": "session_message",
    "sessionId": "<真实会话>",
    "messageId": "<真实消息>",
    "quote": "<用户原话>"
  },
  "reviewedAt": "<ISO 时间>",
  "binding": {
    "contentHash": "sha256:<hex>",
    "fixtureHash": "sha256:<hex>",
    "driverHash": "sha256:<hex>",
    "oracleHash": "sha256:<hex>",
    "specHash": "sha256:<hex>"
  },
  "notes": "<审阅备注>"
}
```

任一绑定内容变化（含 case 的 `questionTypes`、任一探针的增删改或 `difficulty`、fixture 的 `loading`、driver 的 `at`），旧审批都会变成 stale；需要重新审阅并生成新的 `specHash`。W1–W5 没有写审批的命令，审批记录的落盘由用户明确授权的后续动作完成。
