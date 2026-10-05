// `.yaml` / `.yml` 的 Vite 转换插件。
//
// 提取成独立模块是因为有**两个**配置需要它：`vite.config.ts`（应用构建与 dev）
// 与 `vitest.config.ts`（L2/L3 快层）。快层测试会 import `@/services/config` 等
// 产品链路模块，而它们直接 import `.yaml`；缺这个插件时 vitest 会因 YAML 解析失败
// 而报错，表现为「一 import 配置就红」。
//
// 只保留一份定义：两个配置都从这里 import，不各自复制。
//
// 输出形状：**原始文本**（默认导出字符串），与 esbuild `--loader:.yaml=text` 一致 ——
// 消费点（config.ts）用 js-yaml 自行解析，模块形状不按 bundler 分叉。`load(raw)` 仍
// 在构建期执行：格式错误在这里失败，不让坏 YAML 进产物。
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import type { Plugin } from "vite";

export function yamlPlugin(): Plugin {
  return {
    name: "vite-plugin-yaml",
    transform(_code: string, id: string) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return;

      const raw = readFileSync(id, "utf-8");
      load(raw); // 构建期校验（返回值丢弃：交付形状是文本）
      return {
        code: `export default ${JSON.stringify(raw)}`,
        map: null,
      };
    },
  };
}
