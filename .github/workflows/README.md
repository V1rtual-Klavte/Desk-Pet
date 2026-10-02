# 工作流说明

两条线，互不干扰。

| 工作流 | 什么时候跑 | 跑什么 | 出安装包吗 |
|---|---|---|---|
| `ci.yml` | 任何 push、任何 PR、手动 | 双平台验证（类型/编译 · Rust 单测 · L2 · L3 · 纪律扫描 · FLAKY 棘轮）+ `bundle-config` 配置校验 | **不会** |
| `release.yml` | 推 `v*` tag，或手动触发 | 双平台构建（macOS `.dmg` / Windows `.exe`）并发布到 GitHub Release | **会** |

---

## 平时：普通推送

```bash
git add -A
git commit -m "fix(xxx): 改了什么"
git push
```

只跑 `ci.yml`，**不打包、不发版**。两个 job（`verify` 双平台 + `bundle-config`）都要绿。

## 发版：四步

```bash
# 1. 统一版本号（一次改三处：tauri.conf.json / Cargo.toml / package.json）
pnpm run version:set 0.15.0

# 2. 同步 Cargo.lock 并确认编译
pnpm run test:types

# 3. 提交
git commit -am "chore(release): 0.15.0"

# 4. 打 tag 并推送
git tag v0.15.0
git push && git push origin v0.15.0
```

推完 tag，`release.yml` 开始跑：两个平台并行构建，各自把产物送进同一个 GitHub Release，
并生成自动更新用的 `latest.json`。

## ⚠️ 两条必须记住的规则

1. **tag 必须与 `tauri.conf.json` 的 `version` 一致**。`release.yml` 在构建**之前**就会跑
   `pnpm run check:bundle` 拦这一条 —— 改了版本没打 tag、或打了 tag 没改版本，都会失败并提示跑 `version:set`。
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

跑完检查三件事：Release 页面出现 `v0.15.0-rc.1`（标着 Pre-release）、两个平台都有产物、
`latest.json` 里 `darwin-aarch64` 与 `windows-x86_64` 都在。

## 手动触发

Actions 页面选 `Release` → Run workflow → 填一个**已存在**的 tag。用于重跑失败的发布。

## 失败了看什么

| 症状 | 原因 |
|---|---|
| `check:bundle` 报 tag 与 version 不一致 | 跑 `pnpm run version:set <tag 的版本>`，重新提交后再打 tag |
| 构建报签名错误 | 缺仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` |
| Release 里只有 Windows 产物 | macOS job 挂了，先看它的日志 |
| 本地 `pnpm tauri build` 报签名错误 | 本地不需要签名的构建用 `pnpm tauri build --no-sign` |

## 相关

- 设计口径与验收标准：[发布与打包契约](../../docs/plans/active/发布与打包契约.md)
- 逐任务实施记录：[发布与打包执行方案](../../docs/plans/active/发布与打包执行方案.md)
