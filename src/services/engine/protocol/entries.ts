// 计划类自定义条目类型：会话层的共享词汇，plan 与 runtime 共同消费，不归任一业务模块私有。

/** Plan checkpoint 条目类型；恢复扫描按它过滤会话条目。 */
export const PLAN_CHECKPOINT_ENTRY = "deskpet.plan_checkpoint"
/** 计划步骤结果条目：PLAN-09② 的「可回读地址」；宿主自定义条目，不进模型消息流。 */
export const PLAN_STEP_RESULT_ENTRY = "deskpet.plan_step_result"
/** 启动恢复失败证据条目（FIX-30④）；不进模型消息流。 */
export const PLAN_RECOVERY_FAILED_ENTRY = "deskpet.plan_recovery_failed"
/** 计划写盘失败证据条目（FIX-63①）；不进模型消息流。 */
export const PLAN_WRITE_FAILED_ENTRY = "deskpet.plan_write_failed"
