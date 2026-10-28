# 审批记录

当前没有审批记录，`saturday-companionship` 是 **silver / pending**。

只有用户本人针对当前 `specHash` 的真实会话消息审阅后，才能在这里新增审批记录。唯一写入方式是 `node scripts/desk-pet-chat.mjs dataset approve ...`；代理可以起草候选、展示审阅包和差异，但不得代填 `reviewer`、`feedbackSource` 或审批结论，也不得把框架层面的方案通过当成用例审批。

本 case 的全部探针统一由独立 coding-agent judge 判定，没有 `human` 权威分流；结构化用例只评可核对的结果，不评价语气、分泡或拟人化。用户可以抽查任一规则，gold 批准仍只能由用户本人给出。

审批记录至少包含：

```json
{
  "schemaVersion": 4,
  "approvalId": "approval-<caseId>-<YYYYMMDDhhmmss>-<specHash 前 8 位>",
  "caseId": "saturday-companionship",
  "suiteId": "daily-companionship",
  "revision": 6,
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

任一绑定内容变化（含 case 的 `questionTypes`、任一探针的增删改或 `difficulty`、fixture 的 `loading`、driver 的 `at`），旧审批都会变成 stale；需要重新审阅并生成新的 `specHash`。`dataset approve` 是唯一写入口：它校验结构与套件归属、拒绝覆盖，并在成功后回读 `gold/approved`；不要手写 approval JSON，也不要在命令报错后换字段重试。
