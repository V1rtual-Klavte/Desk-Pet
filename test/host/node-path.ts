// ==========================================
// Node 适配层 —— 执行环境路径运算（导出名与历史宿主 API 对齐）
// ==========================================
//
// 导出名沿用历史宿主 API（`@tauri-apps/api/path`）的清单：join / resolve / isAbsolute /
// normalize / dirname / basename / homeDir / tempDir —— 按真实导出名实现（是 `join` /
// `resolve`，不是 `joinPath` / `resolvePath`）。vitest 的 `@tauri-apps/*` 别名已删除
// （2026-10-06），本文件不经别名，由 node-host-bridge.ts（装配执行环境端口）与
// node-ipc.test.ts（导出名与语义对账）直接 import。
//
// 这些函数是纯路径运算，Node 与宿主语义一致，因此没有抛错表；两边都是 async，
// 这里保持 async 形状，连 `.then()` 这类用法也一致。
// 依赖桌面能力的函数（`resolveResource` 等）一概不实现 —— 不做假实现让调用静默通过。
import { homedir, tmpdir } from "node:os"
import * as nodePath from "node:path"

/** @tauri-apps/api/path homeDir() */
export const homeDir = async (): Promise<string> => homedir()

/** @tauri-apps/api/path tempDir() */
export const tempDir = async (): Promise<string> => tmpdir()

/** @tauri-apps/api/path join(...paths) */
export const join = async (...paths: string[]): Promise<string> => nodePath.join(...paths)

/** @tauri-apps/api/path resolve(...paths) */
export const resolve = async (...paths: string[]): Promise<string> => nodePath.resolve(...paths)

/** @tauri-apps/api/path isAbsolute(path) */
export const isAbsolute = async (path: string): Promise<boolean> => nodePath.isAbsolute(path)

/** @tauri-apps/api/path normalize(path) */
export const normalize = async (path: string): Promise<string> => nodePath.normalize(path)

/** @tauri-apps/api/path dirname(path) */
export const dirname = async (path: string): Promise<string> => nodePath.dirname(path)

/** @tauri-apps/api/path basename(path, ext?) */
export const basename = async (path: string, ext?: string): Promise<string> =>
  nodePath.basename(path, ext)
