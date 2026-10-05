/// <reference types="vite/client" />

// 全局环境声明（ambient declarations）：本文件不属于任何模块，也不绑定构建器，
// 只声明「以文本导入的资产」在两种构建下共同的模块形状。tsconfig.json 的 include
// 覆盖 src 与 test，两侧共用这一份。
//
// `*.yaml` / `*.yml` 的默认导出是**原始文本**（两种构建统一：Vite 的 vite-yaml-plugin
// 与 esbuild 的 `--loader:.yaml=text`）；解析方在消费点（config.ts 用 js-yaml），
// 模块形状不按 bundler 分叉。
//
// `vite/client` 引用服务的是 Vite 转换/打包管线里的形态（与产品运行方式无关）：
// - `*?raw` 模块（src/services/personality/stages-cache.ts 的 `./stages-prompt.md?raw`）；
// - `import.meta.glob`（L2/L3 的 caseId 收集器 test/host/caseid-reporter.ts，经 vitest
//   的 Vite 管线求值）。
// `import.meta.env` / `import.meta.hot` 的类型随之可得，但产品代码已不读（全仓只剩注释；
// L4 bundle 另有构建后零残留守卫）。
declare module "*.yaml" {
  const text: string;
  export default text;
}

declare module "*.yml" {
  const text: string;
  export default text;
}
