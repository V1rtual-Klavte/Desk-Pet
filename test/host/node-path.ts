// ==========================================
// Node 适配层 —— 顶替 @tauri-apps/api/path
// ==========================================
//
// 导出名必须与 `@tauri-apps/api/path` 的真实导出逐个对齐：这是**模块替换**（vite alias），
// 产品代码 `import { join } from "@tauri-apps/api/path"` 只要名字对不上，就会在模块加载期
// 直接报「没有这个导出」。计划 Task 9 里写的 `joinPath` / `resolvePath` 不是真实导出名
// （真实名字是 `join` / `resolve`，见 node_modules/@tauri-apps/api/path.d.ts），这里按真实名字实现。
//
// 这些函数是纯路径运算，Node 与 Tauri 语义一致，因此没有抛错表；两边都是 async，
// 这里保持 async 形状，连 `.then()` 这类用法也一致。
// 依赖桌面能力的函数（`resolveResource` 等）一概不实现 —— 被 import 时立刻失败，
// 不留在假实现下静默通过。
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
