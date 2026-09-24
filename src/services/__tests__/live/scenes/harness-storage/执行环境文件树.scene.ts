import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { BaseDirs, runtimePath } from "@/services/paths"

/** 每个 check 自建临时根，失败互不污染；临时目录在系统 temp 下，不触碰用户数据根。 */
async function createEnv(): Promise<TauriExecutionEnv> {
  return new TauriExecutionEnv(await runtimePath("data"), "pet")
}

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

/** 断言失败结果落在指定 FileErrorCode 上（按 Rust 结构化错误码归类，不按 message 文案猜）。 */
function fileErrCode<T>(result: Result<T, FileError>, expected: FileError["code"], label: string): void {
  if (result.ok) throw new Error(`${label}: 期望被拒绝，实际成功`)
  if (result.error.code !== expected) {
    throw new Error(`${label}: 期望 code=${expected}，实际 code=${result.error.code}（${result.error.message}）`)
  }
}

export const 执行环境文件树: SceneDef = {
  meta: {
    caseId: "harness-execution-env-filetree",
    module: "harness-storage",
    contractId: "hs-02",
    description: "TauriExecutionEnv 的 append/rename/createDir/remove/createTempDir 真实命令语义",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "execution-env", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "逐项校验 FileSystem 契约语义",
    userText: "校验 TauriExecutionEnv 的文件系统能力。",
    checks: [
      {
        type: "expectCreateDirAndAppendFile",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir("deskpet-live-env-", context))

          // createDir 默认 recursive：一次建多层
          fileOk(await env.createDir(`${root}/nested/deep`, undefined, context))
          fileOk(await env.exists(`${root}/nested/deep`, context))

          // append 创建缺失文件（含缺失父目录）并在末尾追加
          fileOk(await env.appendFile(`${root}/nested/deep/data.txt`, "AB", context))
          fileOk(await env.appendFile(`${root}/nested/deep/data.txt`, "CD", context))
          const content = fileOk(await env.readTextFile(`${root}/nested/deep/data.txt`, context))
          if (content !== "ABCD") throw new Error(`追加结果应为 ABCD，实际 ${JSON.stringify(content)}`)

          fileOk(await env.remove(root, { recursive: true, force: true }, context))
        },
      },
      {
        type: "expectRenameReplacesDestination",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir("deskpet-live-env-", context))
          try {
            fileOk(await env.writeFile(`${root}/a.txt`, "A", context))
            fileOk(await env.writeFile(`${root}/b.txt`, "B", context))
            // 契约：替换已存在目标
            fileOk(await env.renameFile(`${root}/a.txt`, `${root}/b.txt`, context))
            const content = fileOk(await env.readTextFile(`${root}/b.txt`, context))
            if (content !== "A") throw new Error(`rename 应替换目标内容，实际 ${JSON.stringify(content)}`)
            const sourceExists = fileOk(await env.exists(`${root}/a.txt`, context))
            if (sourceExists) throw new Error("rename 后源文件不应存在")
          } finally {
            await env.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        type: "expectRemoveRespectsFlags",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir("deskpet-live-env-", context))
          try {
            fileOk(await env.createDir(`${root}/tree/child`, undefined, context))
            fileOk(await env.appendFile(`${root}/tree/child/f.txt`, "x", context))

            // 目录 + recursive=false：失败编码进 Result，不 throw
            const refused = await env.remove(`${root}/tree`, undefined, context)
            if (refused.ok) throw new Error("remove 目录时 recursive=false 不应成功")
            fileOk(await env.exists(`${root}/tree`, context))

            // 缺失路径：force=false 失败、force=true 成功
            const missing = await env.remove(`${root}/missing`, undefined, context)
            if (missing.ok) throw new Error("remove 缺失路径时 force=false 不应成功")
            fileOk(await env.remove(`${root}/missing`, { force: true }, context))

            fileOk(await env.remove(`${root}/tree`, { recursive: true }, context))
            const treeExists = fileOk(await env.exists(`${root}/tree`, context))
            if (treeExists) throw new Error("recursive 删除后目录不应存在")
          } finally {
            await env.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        type: "expectCreateTempDir",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir(undefined, context))
          try {
            const info = fileOk(await env.fileInfo(root, context))
            if (info.kind !== "directory") throw new Error(`createTempDir 应产出目录，实际 ${info.kind}`)
            if (root.startsWith(BaseDirs.sessions())) throw new Error("临时目录不应落在会话目录下")
          } finally {
            await env.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // 失败归类按 Rust 结构化错误码（`error.rs` 的 code），不再拿 message 做正则：
        // 旧实现按文案猜，凭据路径（「凭据路径不允许访问」）与相对路径（「工具路径必须是
        // 绝对路径」）都会落成 unknown，目录目标（「目标是目录」）会落成 not_directory。
        // 四条断言各钉一条映射，右列是旧实现下的结果，可见回归会被抓住。
        type: "expectFileErrorsCarryStructuredCodes",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir("deskpet-live-err-", context))
          try {
            // PATH_NOT_FOUND → not_found（旧：not_found，按文案也能猜对）
            fileErrCode(await env.remove(`${root}/missing.txt`, undefined, context), "not_found", "缺失路径 remove(force=false)")

            // SENSITIVE_PATH → permission_denied（词法先于存在性：探针不指向真实凭据，也不需要它存在）
            fileErrCode(await env.readTextFile(`${root}/.ssh/probe`, context), "permission_denied", "凭据路径 readTextFile")

            // NOT_ABSOLUTE → invalid（旧：unknown，旧文案里没有可命中的关键词）
            fileErrCode(await env.writeFile("deskpet-live-relative-probe.txt", "x", context), "invalid", "相对路径 writeFile")

            // TOOL（「只允许操作常规文件」）不在映射表里 → 如实保持 unknown，不猜成 not_directory
            fileErrCode(await env.readTextFile(root, context), "unknown", "目录作为文件 readTextFile")
          } finally {
            await env.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // Rust file_list 直接返回 FileInfo 全字段（绝对 path、kind 三值、size、mtimeMs）；
        // 前端不再用 file_info 回填短条目 —— 缺字段会让 JsonlSessionRepo.list 直接失效。
        type: "expectListDirFullFileInfo",
        run: async () => {
          const env = await createEnv()
          const context = BACKGROUND_CONTEXT
          const root = fileOk(await env.createTempDir("deskpet-live-listdir-", context))
          try {
            fileOk(await env.createDir(`${root}/sub`, undefined, context))
            fileOk(await env.writeFile(`${root}/a.txt`, "abc", context))
            const entries = fileOk(await env.listDir(root, context))
            const file = entries.find(entry => entry.name === "a.txt")
            const dir = entries.find(entry => entry.name === "sub")
            if (!file || !dir) throw new Error(`listDir 缺少条目: ${JSON.stringify(entries)}`)
            if (file.kind !== "file" || dir.kind !== "directory") {
              throw new Error(`listDir kind 不符合契约: file=${file.kind}, dir=${dir.kind}`)
            }
            // file_list 的 path 来自 Rust 侧 validate_file_path 规范化后的绝对路径，
            // 不能直接拿 createTempDir 的原始返回值拼字符串：macOS 上 temp 根位于
            // /var（指向 /private/var 的符号链接），两者必然不等。
            const canonicalRoot = fileOk(await env.canonicalPath(root, context))
            const expectedPath = fileOk(await env.joinPath([canonicalRoot, "a.txt"], context))
            if (file.path !== expectedPath || file.size !== 3) {
              throw new Error(`listDir 缺绝对 path 或 size 错误: ${JSON.stringify(file)}`)
            }
            if (!(file.mtimeMs > 0) || !(dir.mtimeMs > 0)) throw new Error("listDir 缺少 mtimeMs")
          } finally {
            await env.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
    ],
  }],
}

export default 执行环境文件树
