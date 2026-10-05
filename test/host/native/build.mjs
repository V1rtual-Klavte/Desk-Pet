// ==========================================
// 原生宿主 L4 的构建：宿主二进制 + test/e2e Scene runner 的 Node bundle
// ==========================================
//
// 执行契约 §8 W11：`scripts/e2e-test.mjs` 保留为命令入口，但启动的不再是
// `tauri dev`（Tauri WebView + test-e2e.html），而是：
//
//   1) `cargo build -p native-host --bin native-host`（debug 构建 → E2E 模式可用）
//   2) Vite SSR build 把 test/e2e 的 Node 宿主入口打成单文件 bundle（唯一 Node 内执行）
//   3) 启动器用随包 Node（packaging/dist/node，版本见 packaging/node-runtime.json）
//      跑该 bundle；宿主再经监督器用它拉起 Node
//
// 为什么用 Vite 而不是 esbuild 打这个 bundle：产品的服务层仍依赖 Vite 的两项
// 构建期语义 —— `import.meta.glob(..., { eager: true })`（personality 的 stages
// 模板）与 `.yaml` 资料导入（config 的 CONFIG.yaml 基底）。Vite SSR build 用与
// 产品窗口相同的 transform（vite.config.ts 的 yaml 插件与 @ alias）处理它们，
// 不另造一套 imitations；`node:assert/strict` 在 Node 里是可解析的真实模块，
// 但仍沿用仓库的 shim 别名以保持 E2E 依赖树与产品窗口一致。
//
// 目录分工（与既有 test/host/* 的关系）：
// - `test/host/*` 是 L2/L3 的 Node 适配层与共享设施（宿主桥 `NodeHostBridge` 直接
//   调用 `node-ipc.ts` 的命令面，不经 `@tauri-apps/*`）；
// - `test/host/native/` 是**真实宿主**的测试驱动：构建、私有通道、合成 CONFIG、
//   隔离启动与结果判据。它不实现产品 runtime，也不被产品代码 import。
//
// bundle 产物写在 `test/.tmp/native-host-e2e/`（gitignored，随测试临时产物回收；
// 前缀刻意不是 `e2e-`，避免被启动器的残留根回收逻辑当成数据根抢救/删除）。
//
// 本文件是开发工具（Node 脚本），直接 console 输出错误；不进产品构建。

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { build as viteBuild } from "vite"

/** 仓库根（本文件位于 test/host/native/）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "")

/** Node bundle 的构建输出目录（gitignored；见文件头命名说明）。 */
export const E2E_BUNDLE_DIR = join(REPO_ROOT, "test", ".tmp", "native-host-e2e")
/** Node bundle 的单文件产物。 */
export const E2E_BUNDLE_FILE = join(E2E_BUNDLE_DIR, "main.mjs")

/** cargo 产出的 debug 宿主二进制路径。 */
export function nativeHostBinaryPath() {
  return join(REPO_ROOT, "target", "debug", process.platform === "win32" ? "native-host.exe" : "native-host")
}

/** 随包 Node 可执行文件（发行闭包布局；测试不落到系统 Node）。 */
export function bundledNodePath() {
  const base = join(REPO_ROOT, "packaging", "dist", "node")
  const binary = process.platform === "win32" ? join(base, "node.exe") : join(base, "bin", "node")
  if (!existsSync(binary)) {
    throw new Error(
      `随包 Node 缺失：${binary}\n` +
        "先按 packaging/node-runtime.json 的锁定版本准备发行闭包（node + npm/npx + 运行库）；" +
        "L4 不依赖系统 Node。",
    )
  }
  return binary
}

/** 构建 debug 原生宿主，返回二进制路径。失败时抛错（调用方按预检失败处理）。 */
export function buildNativeHost() {
  execFileSync("cargo", ["build", "-p", "native-host", "--bin", "native-host"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  const binary = nativeHostBinaryPath()
  if (!existsSync(binary)) {
    throw new Error(`cargo build 完成但没有产物：${binary}`)
  }
  return binary
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 场景文件清单（确定性排序；真相源仍是 test/e2e/scenes/ 目录本身）。 */
export function collectSceneFiles() {
  return walk(join(REPO_ROOT, "test", "e2e", "scenes"))
    .filter(file => file.endsWith(".scene.ts"))
    .sort()
}

/** 契约文件清单（确定性排序）。 */
export function collectContractFiles() {
  return readdirSync(join(REPO_ROOT, "test", "contracts"))
    .filter(name => name.endsWith(".contract.ts"))
    .sort()
    .map(name => join(REPO_ROOT, "test", "contracts", name))
}

function importSpecifier(fromDir, target) {
  return JSON.stringify(relative(fromDir, target).split(sep).join("/"))
}

/**
 * 生成 Node 宿主入口模块。
 *
 * 对应旧 WebView 入口的 `import.meta.glob(..., { eager: true })`：场景/契约集合的
 * 真相源是源目录，构建时扫描并生成显式 import 清单（不用手写清单）。
 *
 * 场景树在 WebView 退役后不再有「import `.vue` 的组件场景」：原 `真实组件分泡呈现`
 * 已改为服务级场景，`.vue` 剔除机制随之删除（没有消费者之后再保留启发式，
 * 只会让下一个读代码的人以为还有一类场景在等 W8 驱动）。
 */
export function generateE2eEntryModule(bundleDir = E2E_BUNDLE_DIR) {
  mkdirSync(bundleDir, { recursive: true })
  const sceneFiles = collectSceneFiles()
  const contractFiles = collectContractFiles()
  if (sceneFiles.length === 0) {
    throw new Error("test/e2e/scenes 下没有场景文件；拒绝生成空 Scene runner")
  }

  const lines = [
    "// @ts-nocheck —— 生成文件（test/host/native/build.mjs 产出，不提交）。",
    "// Vite 的 import.meta.glob(eager) 的 Node 等价物：显式 import 清单。",
    `import { runNativeLiveHost } from ${importSpecifier(bundleDir, join(REPO_ROOT, "test", "e2e", "native-main.ts"))}`,
    ...sceneFiles.map((file, index) => `import * as scene${index} from ${importSpecifier(bundleDir, file)}`),
    ...contractFiles.map((file, index) => `import * as contract${index} from ${importSpecifier(bundleDir, file)}`),
    "",
    `const sceneModules: Record<string, unknown>[] = [${sceneFiles.map((_, index) => `scene${index}`).join(", ")}]`,
    `const contractModules: Record<string, unknown>[] = [${contractFiles.map((_, index) => `contract${index}`).join(", ")}]`,
    "",
    "// 启动调用刻意不用顶层 await：本 bundle 是单文件内联动态导入（inlineDynamicImports），",
    "// 被动态导入的模块命名空间（piTools 等）是同一作用域、位置在本行之后的 const。",
    "// 顶层 await 会在它们初始化前让出模块求值，启动链的 microtask 访问即 TDZ",
    "// （2026-10-05：222 个场景全部 setup failed: Cannot access 'piTools' before initialization）。",
    "// 不用 await 时，模块同步初始化整体跑完才轮到 microtask；启动链的 socket 连接",
    "// 使事件循环保持活动，主流程的收尾与退出码由 runNativeLiveHost 自管",
    "// （见 test/e2e/native-main.ts 的头部说明）。",
    "runNativeLiveHost({ sceneModules, contractModules }).catch(error => {",
    '  console.error("[E2E] runNativeLiveHost 未捕获异常：", error)',
    "  process.exit(1)",
    "})",
    "",
  ]
  const entryPath = join(bundleDir, "e2e-entry.generated.mts")
  writeFileSync(entryPath, lines.join("\n"))
  return entryPath
}

/** bundle 里不允许残留 `import.meta.env`（Vite 的构建期注入必须在 build 时全部替换掉）。 */
function assertNoViteEnv(bundlePath) {
  const text = readFileSync(bundlePath, "utf8")
  const matches = text.match(/import\.meta\.env/g)
  if (matches) {
    throw new Error(
      `E2E bundle 残留 ${matches.length} 处 import.meta.env：` +
        "把源码迁到 HostBridge 配置（W3/W4），或在 vite.config.ts 的 define 里补齐",
    )
  }
}

/**
 * 「模块顶层出现 await 吗」的 AST 判定（守卫核心；导出供 L2 测试）。
 *
 * 不进入函数边界（函数体内的 await 是普通 async 逻辑），能识别 ExpressionStatement
 * 的 await、变量声明的 await 初始化、for await，以及 if / try 等嵌套块里的顶层 await。
 */
export function containsTopLevelAwait(node) {
  const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])
  function walk(current) {
    if (!current || typeof current !== "object") return false
    if (Array.isArray(current)) return current.some(walk)
    if (FUNCTION_TYPES.has(current.type)) return false
    if (current.type === "AwaitExpression") return true
    if (current.type === "ForOfStatement" && current.await) return true
    for (const [key, value] of Object.entries(current)) {
      if (key !== "type" && walk(value)) return true
    }
    return false
  }
  return walk(node)
}

/**
 * 构建期守卫：产物顶层不允许出现 await（「无顶层 await」不变量）。
 *
 * 单文件 bundle（inlineDynamicImports）把动态导入内联为**同作用域、位置靠后的
 * const 命名空间**（如 piTools）。没有顶层 await 时，模块同步初始化（含全部
 * 命名空间）在第一个 microtask 能跑之前整体完成，任何按需访问都安全；顶层
 * await 会在这些命名空间初始化前交还事件循环，启动链的 microtask 访问它们即
 * TDZ（ReferenceError: Cannot access 'piTools' before initialization）。
 *
 * 2026-10-05 实例：生成的入口 `await runNativeLiveHost(...)` 早于 piTools 定义，
 * 222 个场景全部 setup failed。守卫用 Rollup 自带 parse（ESTree）解析产物。
 * （导出供 L2 测试接线与判定断言。）
 */
export function noTopLevelAwaitGuard() {
  return {
    name: "e2e-no-top-level-await",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue
        const ast = this.parse(output.code)
        for (const statement of ast.body) {
          if (containsTopLevelAwait(statement)) {
            this.error(
              `${fileName} 顶层出现 await：单文件内联动态导入的 bundle 里，顶层 await 会让 microtask ` +
                "在 piTools 等命名空间初始化之前访问它们（TDZ）。请改为不经顶层 await 的启动形态" +
                "（见 buildE2eSceneBundle 注释与 test/e2e/native-main.ts 的收尾语义）。",
            )
          }
        }
      }
    },
  }
}

/**
 * 用仓库的 Vite 配置做 SSR build，产出单文件 Node bundle。
 *
 * - `ssr: entry`：以 Node 为目标的单入口构建；`ssr.noExternal` 让依赖与产品同构
 *   地打进 bundle（只留 node 内建 external），运行时从 bundle 目录仍可解析。
 * - `inlineDynamicImports`：单一入口只有一个文件 —— 产品的动态 import 若被拆成
 *   多个 chunk，Rollup 对「循环 chunk 重导出」只有不可靠的排序保证；宿主只交付
 *   一个入口路径，单文件也让「bundle 目录不完整」不再是故障形态。
 * - 与单文件相伴的「无顶层 await」不变量：内联把动态导入目标变成同作用域里位置
 *   靠后的 const 命名空间，顶层 await 让出去的 microtask 会在其初始化前访问
 *   （TDZ）。产物由 noTopLevelAwaitGuard 构建期拦截，生成的入口以非 await 形态
 *   启动主流程。
 * - 构建后全量核对 `import.meta.env` 已被替换（见 assertNoViteEnv）。
 */
export async function buildE2eSceneBundle() {
  const entry = generateE2eEntryModule()
  mkdirSync(E2E_BUNDLE_DIR, { recursive: true })
  await viteBuild({
    configFile: join(REPO_ROOT, "vite.config.ts"),
    root: REPO_ROOT,
    logLevel: "warn",
    plugins: [noTopLevelAwaitGuard()],
    build: {
      ssr: entry,
      outDir: E2E_BUNDLE_DIR,
      emptyOutDir: true,
      // Node bundle 不需要静态资源目录副本：产物里只允许出现 main.mjs。
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      target: "node22.19",
      rollupOptions: {
        output: {
          format: "esm",
          entryFileNames: "main.mjs",
          inlineDynamicImports: true,
        },
      },
    },
    ssr: {
      // 与产品同构：依赖进 bundle（不依赖仓库 node_modules 在运行时可解析），
      // node 内建模块保持 external。
      noExternal: true,
      target: "node",
    },
  })
  if (!existsSync(E2E_BUNDLE_FILE)) {
    throw new Error(`Vite SSR build 完成但没有产物：${E2E_BUNDLE_FILE}`)
  }
  assertNoViteEnv(E2E_BUNDLE_FILE)
  return E2E_BUNDLE_FILE
}
