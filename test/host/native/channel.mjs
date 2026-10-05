// ==========================================
// E2E 私有测试通道（写入侧 + schema 定义）
// ==========================================
//
// 执行契约 §8 W11：启动器把隔离 root、合成 CONFIG、trial 身份与 attestation 经
// 私有通道交给 debug 原生宿主；宿主在初始化前读取（`crates/native-host/src/main.rs`
// 的 E2eChannel 是读取侧，字段逐一同名同形，camelCase）。
//
// 通道文件写在隔离根内（`<dataRoot>/e2e-channel.json`），随临时根一起删除；
// 路径只经环境变量 `DESKPET_E2E_CHANNEL` 传给宿主，不写 CONFIG、不写日志。
// Node（test/e2e Scene runner）不直接读通道文件 —— 宿主经 `e2e_options` 命令把
// 选项与身份转交给它，通道只有一个读取方。
//
// schema 变更：改这里必须同时改宿主侧 E2eChannel 结构体并递增两侧的 schemaVersion。
//
// 本文件是开发工具（Node 脚本），直接 console 输出错误；不进产品构建。

import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

/** 通道 schema 版本。与 crates/native-host/src/main.rs 的 E2E_CHANNEL_SCHEMA_VERSION 同步。 */
export const SCHEMA_VERSION = 1
/** 通道文件名（隔离根内）。 */
export const CHANNEL_FILE_NAME = "e2e-channel.json"
/** 宿主读取通道用的环境变量（唯一传递点）。 */
export const CHANNEL_ENV_VAR = "DESKPET_E2E_CHANNEL"
/** 隔离数据根的环境变量（AppPaths 在 debug + is_e2e 时消费）。 */
export const DATA_ROOT_ENV_VAR = "DESKPET_E2E_DATA_ROOT"
/** E2E 模式开关（宿主据此进入隔离分支）。 */
export const E2E_ENV_VAR = "DESKPET_E2E"

/** 本次运行的 trial 身份：时间戳 + 随机段，用于把结果/日志/报告绑定到同一场运行。 */
export function newTrialId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  return `${stamp}-${randomBytes(4).toString("hex")}`
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`E2E 通道字段 ${field} 必须是非空字符串`)
  }
  return value
}

/**
 * 构造通道对象（纯函数；落盘前做形状校验）。
 *
 * `options` 是过滤参数与测试侧模型覆盖的键值表（键清单与 test/e2e/cli.ts 的解析
 * 逐项对应；宿主只原样转交，不维护第二份清单）。`attestation` 是本次运行的源码
 * 证明：commit / sourceHashes（启动器算出的预检证明 JSON 字符串）/ seedHash。
 */
export function buildChannel({ trialId, dataRoot, configPath, resultPath, harnessEntry, nodeBinary, options, attestation }) {
  requireString(trialId, "trialId")
  const channel = {
    schemaVersion: SCHEMA_VERSION,
    trialId,
    dataRoot: requireString(dataRoot, "dataRoot"),
    configPath: requireString(configPath, "configPath"),
    resultPath: requireString(resultPath, "resultPath"),
    harnessEntry: requireString(harnessEntry, "harnessEntry"),
    nodeBinary: requireString(nodeBinary, "nodeBinary"),
    options: options ?? {},
    attestation: {
      commit: attestation?.commit ?? null,
      sourceHashes: attestation?.sourceHashes ?? null,
      seedHash: attestation?.seedHash ?? null,
    },
  }
  // 通道只携带地址、身份与证明；凭据值绝不过通道（凭据经隔离根内的
  // eval-models.local.json / setOverrides 写进隔离副本）。这里做一次防呆：
  // 任何 option 值命中凭据键名形状即拒绝。
  for (const key of Object.keys(channel.options)) {
    if (/(api[_-]?key|apikey|secret|password|token)/i.test(key)) {
      throw new Error(`E2E 通道 options 不允许携带凭据字段：${key}`)
    }
  }
  return channel
}

/** 把通道写进隔离根，返回绝对路径（调用方写进 DESKPET_E2E_CHANNEL）。 */
export function writeChannel(dataRoot, channel) {
  const path = join(dataRoot, CHANNEL_FILE_NAME)
  writeFileSync(path, JSON.stringify(channel, null, 2) + "\n")
  return path
}
