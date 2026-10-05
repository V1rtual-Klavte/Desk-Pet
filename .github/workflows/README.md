# 工作流说明

两条线，互不干扰。

| 工作流 | 什么时候跑 | 跑什么 | 出安装包吗 |
|---|---|---|---|
| `ci.yml` | 任何分支 push、任何 PR、手动（**`v*` tag 不跑**，见 `release.yml`） | 双平台验证（类型/编译 · Rust 单测 · L2 · L3 · 纪律扫描 · FLAKY 棘轮）+ `bundle-config` 配置校验 | **不会** |
| `release.yml` | 推 `v*` tag，或手动触发 | harness bundle（一次）→ 双平台打包（macOS `.app`/`.dmg`/`.app.tar.gz` · Windows NSIS `.exe`）→ 汇总出 `update.json` 并发布到 GitHub Release | **会** |

---

## 平时：普通推送

```bash
git add -A
git commit -m "fix(xxx): 改了什么"
git push
```

只跑 `ci.yml`，**不打包、不发版**。两个 job（`verify` 双平台 + `bundle-config`）都要绿。

## 发版：五步

```bash
# 1. 统一版本号（一次改三处：根 Cargo.toml 的 [workspace.package] / package.json / packaging/desktop.json）
pnpm run version:set 0.15.0

# 2. 同步 Cargo.lock 并确认编译
pnpm run test:types

# 3. 跑发布门禁（L0–L4：类型/编译 + 纪律/棘轮 + Rust 单测 + L2/L3 + 严格 Contract 与 3 trials 的 L4）
#    这是唯一跑严格 Contract + 3 trials 的 L4 门禁；L4 不进 CI，只能靠它
pnpm run test:release

# 4. 提交
git commit -am "chore(release): 0.15.0"

# 5. 打 tag 并推送
git tag v0.15.0
git push && git push origin v0.15.0
```

推完 tag，`release.yml` 开始跑：先在 ubuntu 上构建一次平台无关的 harness bundle，再两个平台
并行打包（cargo-packager），最后在 ubuntu 上汇总出自动更新用的 `update.json`（minisign 签名 +
现场验签）连同各平台产物一起发布；两个平台都成功才会建 Release。

## ⚠️ 两条必须记住的规则

1. **tag 必须与三处 `version` 一致**（真相源 = 根 `Cargo.toml` 的 `[workspace.package] version`；
   投影 = `package.json` 与 `packaging/desktop.json`）。`release.yml` 在构建**之前**就会跑
   `check:bundle` 拦这一条 —— 改了版本没打 tag、或打了 tag 没改版本，都会失败并提示跑 `version:set`。
2. **推 tag 要显式写 tag 名**：本仓的 tag 都是**轻量标签**（`git cat-file -t v0.14.5` 返回 `commit`），
   而 `git push --follow-tags` **只推注释标签**，轻量标签不会跟着上去。
   用 `git push origin v0.15.0` 最稳。

## 预发布冒烟（建议第一次正式发版前先跑一遍）

tag 里带 `-` 会发布成 **Pre-release**，不会被 `releases/latest` 选中，
所以**不会影响已安装用户的更新端点**：

```bash
pnpm run version:set 0.15.0-rc.1
pnpm run test:types
git commit -am "chore(release): 0.15.0-rc.1"
git tag v0.15.0-rc.1
git push && git push origin v0.15.0-rc.1
```

跑完检查三件事：Release 页面出现 `v0.15.0-rc.1`（标着 Pre-release）、两个平台都有产物、`update.json` 里 `macos/aarch64` 与 `windows/x86_64` 两条 release 都在。

## 手动触发

Actions 页面选 `Release` → Run workflow → 填一个**已存在**的 tag。用于重跑失败的发布。

## 失败了看什么

| 症状 | 原因 |
|---|---|
| `check:bundle` 报 tag 与 version 不一致 | 跑 `pnpm run version:set <tag 的版本>`，重新提交后再打 tag |
| `check:bundle` 报 `productName` 不是 ASCII | 产物文件名会带中文，GitHub 上传时**静默剥掉非 ASCII 字符**，发布侧随即匹配不上自己的产物名、**`update.json` 的组件条目被跳过** —— CI 全绿但用户永远收不到更新。`productName` 保持 ASCII，界面里的中文名来自 UI 资源，不受影响 |
| `update.json` 签名失败（update-feed: … 验签失败 / signer 报错） | 缺仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（release.yml 映射给 cargo-packager 的 minisign signer），或密钥与 `packaging/update.json` 内嵌公钥不是一对。私钥与口令只在仓库 Secrets 里，不写入任何文件 |
| Release 没建出来 / 只有部分平台产物 | `publish` 只在两个平台都成功后跑（不会发半份 `update.json`）；看挂掉那个 build job 的日志 |
| 打包报 create-dmg / DMG 相关错误 | macOS 侧预置的 create-dmg 校验失败或失效（固定 commit URL + sha256 在 release.yml 里；上游不可达时失败是刻意的） |
| 本机想验一次打包 | 依次跑 `pnpm run build:harness`、`node .github/scripts/stage-node.mjs`、`cargo build --release -p native-host --bin native-host --bin deskpet-update-helper`、`cargo packager --release --config packaging/desktop.json`（需先 `cargo install cargo-packager --version 0.11.8 --locked`）；产物在 `packaging/dist/` |

## 相关

- 产物位置、本地构建与常见失败：[工程参考](../../docs/current/development.md) 的「打包与发布」
- 设计口径与尚未验收项：`docs/history/implementation/发布与打包契约-2026-10-02基线.md`
