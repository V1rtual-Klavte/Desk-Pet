#!/usr/bin/env node
/**
 * 测试纪律守卫：契约「测试纪律」10 条里**机制可判**的 5 条（规则 3 / 4 / 5 / 6 / 7）。
 *
 * 刻意不实现的三档：
 *   · 规则 1 / 2（断言是否观察真实证据、是否 change-detector）—— 只能靠 review。
 *     把它们写成正则只会给出「已经被自动检查了」的假保证。
 *   · 规则 8 / 9 / 10（跳过与超时不计通过、coverage point 与 caseId、预期失败显式声明）
 *     —— 由 dataset 校验与报告机制保证，不在这里重复实现。
 *
 * 规则表正文在 test/README.md；本文件是那张表的执行机制，不是第二个定义点。
 * 两种用法：
 *   · `node scripts/check-test-rules.mjs` —— 扫描 test/，命中即非零退出，格式 `文件:行: 规则N: 说明`
 *   · `import { scanSource, RULES }` —— 守卫自身的测试用（守卫失效必须被测出来，而不是假定生效）
 *
 * 扫描的是**源码文本**，所以会漏报：把违规写成变量拼接、动态 import、跨行拼接的路径都可能绕过。
 * 但宁可漏报也不误伤 —— 一条误伤会让下一个人放宽规则，而放宽掉的正是守卫本身。
 *
 * [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 规则表：只有机制可判的 5 条在这里。措辞与契约「测试纪律」一致。 */
export const RULES = [
  { id: 3, desc: "禁止在测试里读源码文本并断言其内容" },
  { id: 4, desc: "禁止手写 throw new Error 充当断言；用 expect" },
  { id: 5, desc: "禁止无断言的 it 块" },
  { id: 6, desc: "L2 单元层不得 import 带 IPC 的模块" },
  { id: 7, desc: "L3 集成层不得使用真实 Provider" },
];

/**
 * 规则 6 的判据范围：模块入口 —— import 它会**直接**加载一个自己 import
 * `@tauri-apps/api/*` 的模块（直接依赖，不做传递闭包）。
 *
 * 为什么不做传递闭包：闭包会把所有经 logger（它自己 invoke）间接触达 IPC 的纯模块都算进来，
 * 规则立刻失去区分力 —— 契约写明 L2 就是「纯逻辑 / 解析 / 注册表 / 边界」，注册表、解析器
 * 必须能 import。所以同一个域里的纯子模块**不**在这里：
 *   · `@/services/tool/registry`、`tool/policy`、`tool/router`（I/O 都在别的文件里）
 *   · `@/services/engine/pi/session-frame-buffer`、`session-fold`、`delivery`、`stream-text`
 *   · `@/services/session/{repo,manager,messages,read-model,store,history}`
 *   · `@/services/error`、`@/services/logger`（跨领域工具，AGENTS.md 要求错误处理经前者）
 * 精确到入口而不是整目录前缀，正是为了不误伤它们。
 *
 * 域的范围与 test/README.md 规则表的括注一致（pi runtime / 会话落盘 / 工具执行）。
 * 新增直接 import @tauri-apps/api/* 的入口时同步本表（派生命令：
 * `rg -l 'from "@tauri-apps/api/' src/`）。
 */
const IPC_MODULES = [
  { spec: "@/services/engine/pi", why: "pi barrel 会带出 runtime.ts" },
  { spec: "@/services/engine/pi/runtime", why: "agent harness 运行时：直接 invoke" },
  { spec: "@/services/session", why: "会话 barrel 会带出 persistence.ts" },
  { spec: "@/services/session/persistence", why: "会话 JSONL 落盘经 invoke（L3 的层签名）" },
  { spec: "@/services/tool", why: "工具 barrel 会带出执行许可" },
  { spec: "@/services/tool/execution-permit", why: "工具执行许可经 invoke" },
  { spec: "@/services/tool/pi", why: "工具侧 pi barrel 会带出 tauri-execution-env.ts" },
  { spec: "@/services/tool/pi/tauri-execution-env", why: "Tauri 执行环境：直接 invoke" },
  { spec: "@/services/tool/mcp", why: "MCP 走 stdio 子进程（Rust-only 边界）" },
  { spec: "@/services/tool/local", why: "本地工具实现经 invoke（bash / 系统路径）" },
  { spec: "@/services/tool/local-extra", why: "剪贴板 / 打开应用经 invoke（桌面能力）" },
];

/**
 * 规则 7 的判据：**按配置构造或直连真实模型网关**的调用。
 *
 * 刻意不列的东西与理由：
 *   · `installPiRuntimeProviderForTest` —— fake 与真实的装载点都是它，文本上分不出来；
 *   · `completePiText` —— 装了 fake 之后它走 fake，不是「使用真实 Provider」；
 *   · provider 名（openai / anthropic / …）—— 名字出现在注释、字符串、配置夹具里都合法，
 *     按名字判会变成噪声。
 * 因此本规则的强度是「挡住直连路径」，不是「证明没有任何路径能碰到网络」。
 */
const REAL_PROVIDER_CALLS = [
  { re: /\bgetPiModel\s*\(/, why: "getPiModel() 按配置构造真实 provider" },
  { re: /\bcreateConfiguredGateway\s*\(/, why: "createConfiguredGateway() 按配置构造真实 provider" },
  { re: /\bcreateProvider\s*\(/, why: "pi-ai 的 createProvider 构造真实 provider（替身用 fauxProvider）" },
  { re: /\bbuiltinProvider\s*\(/, why: "pi-ai 的内置 provider（真实 catalog）" },
];

/** 读文件 → 断言其内容的路径特征。`.md` 只在 src / docs 目录下才算源码文本。 */
const SOURCE_READ_HINT = /\.(?:ts|vue|rs|mjs|cjs)\b|\bsrc[/\\]|["'`]src["'`]|["'`]docs["'`]/;
/** `__dirname` / `__filename` 反查源码目录。 */
const DIRNAME_TO_SOURCE = /\b__(?:dirname|filename)\b[^\n]*(?:\bsrc[/\\]|["'`]src["'`])/;
/** 规则 5 认为「块内有断言」的调用。`assert` 前缀是为了命名断言函数（assertNoDuplicates 等）。 */
const ASSERTION_CALL = /\bexpect\b|\bexpectTypeOf\b|\bassert[\w.]*\s*\(/;

/** `/` 出现在这里时按正则字面量起点处理（区分除号）。 */
const REGEX_PREFIX_CHARS = "([{,;:=!&|?+-*%~^<>";
const REGEX_PREFIX_WORDS = [
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "yield", "await",
];

function isRegexStart(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  if (REGEX_PREFIX_CHARS.includes(source[i])) return true;
  let j = i;
  while (j >= 0 && /[\w$]/.test(source[j])) j -= 1;
  return REGEX_PREFIX_WORDS.includes(source.slice(j + 1, i + 1));
}

/** 从引号起扫到成对结束符；单/双引号不跨行，未闭合就停在本行末，避免把整个文件吞掉。 */
function scanQuoted(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== "`" && (ch === "\n" || ch === "\r")) return i;
    i += 1;
  }
  return source.length;
}

/** 从 `/` 起扫到成对结束符；发现换行说明这是除号，原样返回。 */
function scanRegexLiteral(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return start + 1;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return start + 1;
}

/**
 * 产出两个**等长**视图（行号与列位都不漂移）：
 *   · text —— 抹掉注释与正则字面量，保留字符串原文：判「import 了谁」「读的是哪个文件」
 *   · code —— 再把字符串与模板字面量的**内容**抹掉（引号保留）：判代码结构
 *
 * 为什么要抹：
 *   · 字符串里的 `throw` 不是 throw，字符串里的 `it(` 不是被 vitest 执行的测试块 ——
 *     不抹就会把「把违规样本写成字符串」的测试文件判成违规（本守卫自己的测试就是）；
 *   · 注释里写「不要 throw new Error」不该让文件变红。
 * 抹掉只可能漏报（假阴性），不会误伤（假阳性）。
 */
function maskSource(source) {
  const code = source.split("");
  const text = source.split("");
  /** 两个视图都抹（注释、正则字面量：谁都不该看见它们的内容）。 */
  const blankBoth = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (source[i] === "\n" || source[i] === "\r") continue;
      text[i] = " ";
      code[i] = " ";
    }
  };
  /** 只抹 code 视图（字符串内容：text 还要拿它判 import 了谁、读了哪个路径）。 */
  const blankCode = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (source[i] === "\n" || source[i] === "\r") continue;
      code[i] = " ";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blankBoth(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blankBoth(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const end = scanQuoted(source, i);
      blankCode(i + 1, end - 1);
      i = end;
    } else if (ch === "/" && isRegexStart(source, i)) {
      const end = scanRegexLiteral(source, i);
      blankBoth(i, end);
      i = end;
    } else {
      i += 1;
    }
  }
  return { code: code.join(""), text: text.join("") };
}

/** 括号配对：字符串 / 注释 / 正则都已抹掉，所以括号都是代码里的括号。 */
function matchParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 行号查询：预扫换行位置，命中点再多也不重复扫全文。 */
function lineLookup(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * 收集 `it(` / `test(` 调用的完整范围（括号配对），供规则 4 / 5 判测试体。
 * `it.each(表)("名字", …)` 的断言在**第二个**调用里，所以要接着往后取。
 * `(?<!\.)` 是必需的：`/regex/.test(x)` 里的 `test(` 也是方法调用，不是测试块。
 */
function testCallSpans(code) {
  const spans = [];
  const re = /\b(?<!\.)(?:it|test)(\.only|\.each)?\s*\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    let close = matchParen(code, open);
    if (close === -1) continue;
    if (match[1] === ".each") {
      const nextOpen = code.indexOf("(", close);
      const gap = nextOpen === -1 ? "" : code.slice(close + 1, nextOpen);
      if (nextOpen === -1 || /\S/.test(gap)) continue;
      close = matchParen(code, nextOpen);
      if (close === -1) continue;
    }
    spans.push({ index: match.index, end: close });
    re.lastIndex = close;
  }
  return spans;
}

/**
 * 把说明符归一到 `@/…` 形状，让规则 6 不依赖写法：`@/services/session`、
 * `@/services/session.ts` 与 `../../src/services/session` 指的是同一个模块。
 * 纯字符串运算，不碰平台的路径分隔符。
 */
function normalizeSpecifier(spec, relPath) {
  const stripped = spec.replace(/\.(?:ts|js|mjs|cjs|vue)$/, "");
  if (!stripped.startsWith(".")) return stripped;
  const segments = [...relPath.split("/").slice(0, -1), ...stripped.split("/")];
  const stack = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  const resolved = stack.join("/");
  return resolved.startsWith("src/") ? `@/${resolved.slice("src/".length)}` : stripped;
}

/**
 * 语句级的 `import type … from "…"` / `export type … from "…"`：转译后整句被抹掉，
 * 运行时**不会加载**那个模块，所以不算「import 了带 IPC 的模块」。
 * 注意 `import { type A } from "…"` 是另一回事：语句还在（为了副作用保真），模块照样加载。
 */
function isTypeOnlySpecifier(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("import"), before.lastIndexOf("export"));
  if (start === -1) return false;
  const head = text.slice(start, index);
  return /^(?:import|export)\s+type\b/.test(head) && !/\n\s*(?:import|export)\b/.test(head);
}

/** import / require 的模块说明符。 */
function moduleSpecifiers(text) {
  const found = [];
  const re = /\bfrom\s*(["'])([^"'\n]+)\1|\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\3|\bimport\s+(["'])([^"'\n]+)\5/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    found.push({ spec: match[2] ?? match[4] ?? match[6], index: match.index });
  }
  return found;
}

/**
 * 扫一个源文件，返回命中列表 `{ file, line, rule, note }`。
 * `relPath` 决定层次判定（`test/unit/**` 是 L2，`test/integration/**` 是 L3）。
 */
export function scanSource(relPath, source) {
  const hits = [];
  const { code, text } = maskSource(source);
  const lineAt = lineLookup(source);
  const push = (index, rule, note) => hits.push({ file: relPath, line: lineAt(index), rule, note });
  const isUnit = /(?:^|\/)unit\//.test(relPath);
  const isIntegration = /(?:^|\/)integration\//.test(relPath);

  const spans = testCallSpans(code);
  const inTestBody = index => spans.some(span => index > span.index && index < span.end);

  // 规则 4：手写 throw 充当断言。只判**测试体内部**的 throw —— 夹具解码器、前置检查这类
  // 辅助函数本来就会抛错（契约也明确 setup 失败不是错误），把模块级的 throw 一并算进来只会
  // 制造噪声。代价是「helper 里包一层 throw」能绕过去。
  for (const match of code.matchAll(/\bthrow\s+new\s+Error\b/g)) {
    if (!inTestBody(match.index)) continue;
    push(match.index, 4, "手写 throw new Error 充当断言（改用 expect）");
  }

  // 规则 3：读源码文本并断言其内容
  for (const match of text.matchAll(/\b(?:readFileSync|readFile)\s*\(/g)) {
    const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const close = rest.indexOf(")");
    const args = close === -1 ? rest : rest.slice(0, close);
    if (SOURCE_READ_HINT.test(args)) {
      push(match.index, 3, "读源码文件文本后断言其内容（应断言产品行为，不是源码字符串）");
    }
  }
  for (const match of code.matchAll(/\b(?:toMatchSnapshot|toMatchInlineSnapshot)\s*\(/g)) {
    push(match.index, 3, "快照断言锁定文本形态（change-detector，规则 2 的可判切片）");
  }
  for (const match of text.matchAll(/(["'`])([^"'`\n]*[?&]raw)\1/g)) {
    // 只判源码 / docs 路径：夹具（fixtures）用 ?raw 读入是正常做法，不该被这条规则拦下。
    if (SOURCE_READ_HINT.test(match[2])) push(match.index, 3, "以 ?raw 读入源码文本后断言（应断言产品行为）");
  }
  for (const match of text.matchAll(/\b__(?:dirname|filename)\b[^\n]*/g)) {
    if (DIRNAME_TO_SOURCE.test(match[0])) {
      push(match.index, 3, "经 __dirname 反查源码目录文本后断言");
    }
  }

  // 规则 6：L2 不得 import 带 IPC 的模块（`import type` 不算 —— 转译后它不加载模块）
  if (isUnit) {
    for (const found of moduleSpecifiers(text)) {
      if (isTypeOnlySpecifier(text, found.index)) continue;
      const spec = normalizeSpecifier(found.spec, relPath);
      const entry = IPC_MODULES.find(item => item.spec === spec);
      if (entry) push(found.index, 6, `L2 不得 import 带 IPC 的模块：${entry.spec}（${entry.why}）`);
    }
  }

  // 规则 7：L3 不得使用真实 Provider
  if (isIntegration) {
    for (const call of REAL_PROVIDER_CALLS) {
      for (const match of code.matchAll(new RegExp(call.re.source, "g"))) {
        push(match.index, 7, `L3 不得使用真实 Provider：${call.why}`);
      }
    }
  }

  // 规则 5：无断言的 it 块
  for (const span of spans) {
    const body = code.slice(span.index, span.end);
    if (!ASSERTION_CALL.test(body)) {
      push(span.index, 5, "it 块内没有断言（补 expect / expectTypeOf / 命名断言函数）");
    }
  }

  return hits.sort((a, b) => a.line - b.line || a.rule - b.rule);
}

/** 递归收集 `*.test.ts`（跳过符号链接，避免绕圈）。 */
function collectTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // 经符号链接路径调用时（macOS /tmp → /private/tmp），argv[1] 保留链接而 import.meta.url
    // 是真实路径——直接比较会静默跳过 main（守卫什么都没做却 exit 0）。按真实路径比较。
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const testDir = join(root, "test");
  // 还没有 test/ 不是违规：正常报零命中并以 0 退出，别把「文件不存在」演成守卫失败。
  const files = existsSync(testDir) ? collectTestFiles(testDir) : [];
  const hits = [];
  for (const file of files) {
    const relPath = relative(root, file).split(sep).join("/");
    hits.push(...scanSource(relPath, readFileSync(file, "utf8")));
  }
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: 规则${hit.rule}: ${hit.note}`);
  if (hits.length === 0) {
    console.log(`测试纪律扫描：零命中（规则 ${RULES.map(rule => rule.id).join(" / ")}；共 ${files.length} 个测试文件）`);
    return 0;
  }
  console.log(`测试纪律扫描：${hits.length} 处违规`);
  return 1;
}

if (isMain()) process.exit(main());
