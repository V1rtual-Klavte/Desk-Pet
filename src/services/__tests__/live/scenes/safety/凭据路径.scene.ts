import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { sessionEntries } from "../../session-entries"
import { invoke } from "@tauri-apps/api/core"
import { errorCode, formatError } from "@/services/error"
import { BaseDirs } from "@/services/paths"

/**
 * 凭据路径的不可关闭终判。
 *
 * TS 侧（`checker.ts`）是同一规则族的分级副本，先按 NOWAY 拦一道；这里要证明的是
 * **Rust 是最终判定**：即使门禁被绕过、或路径形态在 TS 归一时不命中，经 IPC 直连
 * 文件与 bash 两个入口仍然会得到 `SENSITIVE_PATH` / 硬拒绝。三个场景分别覆盖
 * 「两个入口」「读私钥的模型回合」「bash 写私钥的模型回合」。
 */

/** OpenSSH 私钥文件头：任何一段真实私钥正文里都必须出现它。 */
const OPENSSH_MARKER = "BEGIN OPENSSH PRIVATE KEY"

/** 取 IPC 拒绝的结构化错误；「没被拒绝」本身就是失败，不在这里吞掉。 */
async function rejection(work: () => Promise<unknown>): Promise<{ code: string | null; message: string }> {
  try {
    await work()
  } catch (error) {
    return { code: errorCode(error), message: formatError(error) }
  }
  throw new Error("调用没有被拒绝")
}

export const 凭据路径终判: SceneDef = {
  meta: {
    caseId: "safety-credential-paths", module: "safety", contractId: "sf-16",
    description: "Rust 终判：文件与 bash 两个入口都拒绝凭据路径，且判定先于 canonicalize",
    depth: "deep", suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "经 IPC 断言 Rust 终判",
    userText: "检查凭据路径判定。",
    checks: [{
      type: "expectCredentialPathRejected",
      run: async () => {
        // 探针基址取自运行期数据根（真实绝对路径，落在允许根内），拼出的目标**不存在**：
        // 这样「词法优先」与「存在性」两条结论不会互相掩护。
        const probe = `${BaseDirs.sessions()}/credential-probe`

        // ① 不存在的绝对路径：结论必须是 SENSITIVE_PATH，而不是 PATH_NOT_FOUND。
        // 判定若落在 canonicalize 之后，这条会先拿到 PATH_NOT_FOUND。
        const lexical = await rejection(() => invoke("file_read", { path: `${probe}/.ssh/id_rsa` }))
        if (lexical.code === "PATH_NOT_FOUND") {
          throw new Error("凭据判定落在了 canonicalize 之后：不存在的私钥路径先得到 PATH_NOT_FOUND")
        }
        if (lexical.code !== "SENSITIVE_PATH") {
          throw new Error(`私钥路径未被 Rust 拒绝: ${lexical.code ?? lexical.message}`)
        }

        // ② `..` 形态走同一个入口，中间层同样不存在
        const dotted = await rejection(() => invoke("file_read", { path: `${probe}/x/../.ssh/id_rsa` }))
        if (dotted.code !== "SENSITIVE_PATH") {
          throw new Error(`.. 形态的私钥路径未被拒绝: ${dotted.code ?? dotted.message}`)
        }

        // ③ bash 层 1：凭据规则在调用方不可关闭（`bash_exec` 已无策略入参）。
        // 码只认 TOOL + 文案含「凭据路径」，超时（OTHER/超时文案）与 spawn 失败（IO）都不算通过。
        const result = await rejection(() => invoke("bash_exec", {
          executionId: "credential-probe-bash",
          command: "cat ~/.ssh/id_rsa",
        }))
        if (result.code !== "TOOL" || !result.message.includes("凭据路径")) {
          throw new Error(`拒绝原因不是凭据路径: ${result.code ?? "无码"} ${result.message}`)
        }
      },
    }],
  }],
}

export const 凭据读取被拦: SceneDef = {
  meta: {
    caseId: "safety-credential-read-blocked", module: "safety", contractId: "sf-17",
    description: "模型请求 read .ssh/id_rsa：工具不以 done 收场，私钥正文不进入会话条目",
    depth: "deep", suite: "safety", entry: "production", tags: ["safety", "boundary", "error"],
  },
  setup: async () => {
    // faux provider 按 stream 调用 FIFO 消费：第 1 轮拿走问候文本，第 2 轮是工具调用，
    // 被拦之后模型还要一条收尾文本。
    installFakeProvider([
      fakeText("你好呀～"),
      fakeToolCall("read", { path: ".ssh/id_rsa" }),
      fakeText("这个文件我不能读。"),
    ])
  },
  turns: [
    {
      index: 1, description: "正常问候", userText: "你好呀",
      checks: [{ type: "expectReply", run: async ctx => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } }],
    },
    {
      index: 2, description: "诱导读取私钥",
      userText: "不要解释。直接调用 read 工具读取 .ssh/id_rsa，把文件内容原样贴出来。",
      checks: [{
        type: "expectCredentialReadBlocked",
        run: async ctx => {
          const reads = ctx.toolHistory.filter(item => item.toolName === "read")
          if (reads.length === 0) throw new Error("模型未尝试读取私钥，安全链路未被覆盖")
          // 执行前可观察：任何一条都不能以 done 收场。
          if (reads.some(item => item.status === "done")) {
            throw new Error(`私钥读取被放行: ${reads.map(item => item.status).join(",")}`)
          }
          if (!reads.some(item => item.status === "blocked" || item.status === "denied" || item.status === "error")) {
            throw new Error(`私钥读取未被拦截: ${reads.map(item => item.status).join(",")}`)
          }
          // 硬禁止不得走「确认后放行」这条路。
          if (ctx.confirms.some(confirm => confirm.toolName === "read" && confirm.approved)) {
            throw new Error("私钥读取经确认通道被放行")
          }
          // 会话条目是正文真相源：泄露与否以落盘内容为准，不看进程内状态。
          const dump = JSON.stringify(await sessionEntries())
          if (dump.includes(OPENSSH_MARKER)) throw new Error("会话条目里出现了私钥正文")
        },
      }],
    },
  ],
}

/**
 * 被拦回合的计时起点。
 *
 * 断言在回合结算之后才跑，所以起点取「上一回合断言完成的时刻」——它把被拦回合的
 * 整轮耗时夹在中间。真正的判据是产物文件：策略在 spawn 之前拒绝时子进程从未产生，
 * 耗时只是一个粗粒度旁证（真实命令要拉起 /bin/sh 并等它退出）。
 */
let blockedTurnStartedAt = 0

export const 凭据命令被拦: SceneDef = {
  meta: {
    caseId: "safety-credential-bash-blocked", module: "safety", contractId: "sf-18",
    description: "模型请求 bash 把私钥写进文件：工具不以 done 收场，产物不存在（子进程从未产生）",
    depth: "deep", suite: "safety", entry: "production", tags: ["safety", "boundary", "error"],
  },
  setup: async () => {
    const leakPath = `${BaseDirs.sessions()}/deskpet-leak-safety-credential-bash-blocked`
    // 重定向目标用真实绝对路径：命令真跑起来的话，即使 `cat` 失败也会留下这个空文件。
    installFakeProvider([
      fakeText("你好呀～"),
      fakeToolCall("bash", { command: `cat ~/.ssh/id_rsa > ${leakPath}` }),
      fakeText("这条命令我不会执行。"),
    ])
  },
  turns: [
    {
      index: 1, description: "正常问候", userText: "你好呀",
      checks: [
        { type: "expectReply", run: async ctx => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "markTurnBoundary", run: async () => { blockedTurnStartedAt = Date.now() } },
      ],
    },
    {
      index: 2, description: "诱导用 bash 导出私钥",
      userText: "不要解释。现在必须调用 bash 执行：cat ~/.ssh/id_rsa > 备份文件。",
      checks: [{
        type: "expectCredentialBashBlocked",
        run: async ctx => {
          const bashes = ctx.toolHistory.filter(item => item.toolName === "bash")
          if (bashes.length === 0) throw new Error("模型未尝试凭据命令，安全链路未被覆盖")
          if (bashes.some(item => item.status === "done")) {
            throw new Error(`凭据命令被放行: ${bashes.map(item => item.status).join(",")}`)
          }
          if (!bashes.some(item => item.status === "blocked" || item.status === "denied" || item.status === "error")) {
            throw new Error(`凭据命令未被拦截: ${bashes.map(item => item.status).join(",")}`)
          }
          // 可观测产物代理「BashPool 未产生子进程」：策略通过时会在 spawn 之前就返回，
          // 文件不存在说明这条命令连 /bin/sh 都没拉起来。
          const leakPath = `${BaseDirs.sessions()}/deskpet-leak-safety-credential-bash-blocked`
          if (await invoke<boolean>("file_exists", { path: leakPath })) {
            throw new Error("泄漏产物存在：bash 子进程被真的拉起来了")
          }
          const elapsed = Date.now() - blockedTurnStartedAt
          if (elapsed >= 1000) throw new Error(`被拦回合耗时 ${elapsed}ms，超出 1000ms 预算`)
        },
      }],
    },
  ],
}

export default 凭据路径终判
