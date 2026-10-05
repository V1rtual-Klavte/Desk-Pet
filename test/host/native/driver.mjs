// ==========================================
// 原生宿主的隔离启动与完成判据
// ==========================================
//
// 从 scripts/e2e-test.mjs 抽出的宿主驱动部分（执行契约 §2.2：`test/host/native/`
// 承载真实 Native 宿主测试驱动与隔离启动）：
//
// - `launchNativeHost`：直接拉起 cargo 产出的宿主二进制（不再经 `tauri dev`）。
//   非 Windows 上独立进程组启动，停止时整组信号；Windows 用 taskkill /T。
// - `judgeNativeVerdict`：完成协议判据 =「结果文件 + 进程退出码」。
//   结果文件首行 PASS 且退出码 0 才算通过；丢结果、只写文件不退 0、退出码为 0
//   但文件不是 PASS，都判失败。预检失败/超时由启动器在更外层处理，同样不得标通过。
//
// 本文件是开发工具（Node 脚本），直接 console 输出错误；不进产品构建。

import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

/** 拉起原生宿主（stdio 继承：宿主日志与 Node 的终端进度直接进启动器终端）。 */
export function launchNativeHost({ binary, env, cwd }) {
  return spawn(binary, [], {
    cwd,
    env,
    stdio: "inherit",
    // 非 Windows：独立进程组，停止时能整组回收（宿主 + 它拉起的 Node）。
    detached: process.platform !== "win32",
  })
}

/**
 * 生产进程组是否仍有存活成员。
 * macOS 对已退出组可能报 EPERM，按成员表判定而不是按信号结果。
 */
export function producerGroupAlive(child) {
  if (!child) return false
  const groups = execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 5000 })
  return groups.trim().split(/\s+/).some(group => Number(group) === child.pid)
}

/** 停止宿主进程组：非 Windows 发信号给整组；Windows taskkill /T /F。 */
export function stopChild(child, signal = "SIGTERM") {
  if (!child) return
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== "ESRCH" && !(error.code === "EPERM" && !producerGroupAlive(child))) throw error
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  }
}

/**
 * 完成协议判据：结果文件 + 退出码同时成立才算通过。
 *
 * 返回 `{ passed, reason }`；不通过时 reason 直接进启动器日志。
 */
export function judgeNativeVerdict({ resultPath, exitCode, signal }) {
  if (!existsSync(resultPath)) {
    return {
      passed: false,
      reason: `测试进程未生成结果文件 (exit=${exitCode}, signal=${signal ?? "none"})`,
    }
  }
  const text = readFileSync(resultPath, "utf8")
  if (!text.startsWith("PASS\n")) {
    return { passed: false, reason: "测试报告标记为失败" }
  }
  if (exitCode !== 0) {
    return {
      passed: false,
      reason: `结果文件为 PASS，但宿主退出码 ${exitCode ?? `signal ${signal}`} 非 0（丢结果或关停未干净不得标通过）`,
    }
  }
  return { passed: true }
}
