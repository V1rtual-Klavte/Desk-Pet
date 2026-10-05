// ==========================================
// MCP 托管安装与直启 —— `npx -y <包> [args…]` 形态
// ==========================================
//
// 职责：识别 `npx -y <包> [args…]` 形态（`detect_npx_package`），首次用随包 npm 把包
// 装入数据根管理目录 `<data_dir>/mcp/npm/<server_id>/`，并解析出入口脚本的绝对路径
// （`ensure_installed`）；之后调用方（`mcp_bridge::mcp_spawn`）用随包 `node` 直启该入口，
// 省掉 npx / npm exec 包装层的常驻进程。
//
// 失败口径：任何安装或解析失败都**返回具体错误**（AppError），不猜、不静默兜底、不伪装
// 成功；调用方负责 `rust_warn!` 留痕并回退到原 npx 路径 —— 回退后的行为与改造前完全一致，
// 托管只是「能走通时的省资源路径」。
//
// 信任级：托管安装的输入是用户显式配置的 server 命令，与 npx（npm exec）同一条信任链；
// 不追加 `--ignore-scripts`（理由见 `install_args`），也不做额外的包签名校验。

use crate::error::{AppError, AppResult};
use crate::{rust_info, rust_warn};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use super::runtime_command::NodeRuntimePaths;

/// 管理目录清单文件名（相对 `<data_dir>/mcp/npm/<server_id>/`）。
const MANIFEST_FILE: &str = "manifest.json";

/// npm 失败输出带进错误前的截断上限（字符数）：够排障，不把整段安装日志灌进错误链。
const INSTALL_OUTPUT_LIMIT: usize = 2000;

/// 托管直启的解析结果。
#[derive(Debug)]
pub struct ResolvedEntry {
    /// 入口脚本的绝对路径（调用方以 `node <entry> <剩余参数…>` 直启）。
    pub entry: PathBuf,
}

/// 池内 per-server 安装锁表：同一 server 的并发 spawn 复用同一把锁，不重复安装。
///
/// 生命周期与 `McpPool` 绑定；锁按 server_id 惰性创建（池内 server 数量是个位数，不做回收）。
#[derive(Default)]
pub struct InstallLocks {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl InstallLocks {
    /// 取（必要时创建）该 server 的安装锁。锁中毒按本仓口径取回内层数据。
    pub fn lock_for(&self, server_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|error| error.into_inner());
        locks.entry(server_id.to_string()).or_default().clone()
    }
}

/// 识别 `npx -y <spec> [rest…]` / `npx --yes <spec> [rest…]` 形态，返回 `(spec, rest)`。
///
/// 只认这一种形状：首参必须是 `-y`/`--yes`，第二个参数必须是具体的包 spec（非空、不以 `-`
/// 开头）。其它 npx 用法（`-p`/`--package`、直接给可执行名、混入 npm 旗标等）一律返回 None ——
/// 托管目录只适用于「装一个包并跑它」的确定性形态，其余按原样执行。
pub fn detect_npx_package(args: &[String]) -> Option<(&str, &[String])> {
    let (first, rest) = args.split_first()?;
    if first != "-y" && first != "--yes" {
        return None;
    }
    let (spec, rest) = rest.split_first()?;
    if spec.is_empty() || spec.starts_with('-') {
        return None;
    }
    Some((spec.as_str(), rest))
}

/// 保证包已装入管理目录，返回入口脚本。
///
/// 复用：`manifest.json` 存在且 `spec` 与本次一致、入口文件仍在 → 直接返回（不重装）。
/// 缺失 / spec 变化 / 入口丢失 / 清单损坏 → 用随包 npm 重装（重装是自愈路径）。
///
/// 并发：本函数自身不加锁；调用方应持 `InstallLocks::lock_for(server_id)` 的互斥锁进入，
/// 「同 server 不重复安装」由那把锁保证。
pub fn ensure_installed(
    node_runtime: &NodeRuntimePaths,
    data_dir: &Path,
    server_id: &str,
    spec: &str,
) -> AppResult<ResolvedEntry> {
    // 错误文案只带 server_id，不回显 spec：spec 可能是带凭据的 URL 形态，不落日志。
    let package = registry_package_name(spec).ok_or_else(|| {
        AppError::Config(format!(
            "MCP 托管安装：无法从参数解析 npm 注册表包名（server={server_id}）"
        ))
    })?;
    let dir = managed_dir(data_dir, server_id)?;

    // 1. 清单复用：spec 一致且入口文件仍在 → 直接返回。
    if let Some(manifest) = read_manifest(&dir) {
        if manifest.spec == spec {
            if let Some(entry) = existing_entry(&dir, &manifest.entry) {
                return Ok(ResolvedEntry { entry });
            }
            rust_warn!(
                "MCP 托管目录的入口文件缺失，将重装: {}: {}",
                dir.display(),
                manifest.entry
            );
        }
    }

    // 2. 安装到管理目录（随包 npm；环境不追加 server 的 env —— 安装不需要凭据）。
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::Io(format!("MCP 托管目录创建失败 {}: {error}", dir.display())))?;
    let npm_args = install_args(&dir, spec);
    let output = node_runtime
        .command("npm", &npm_args, None)?
        .stdin(Stdio::null())
        .output()
        .map_err(|error| AppError::Other(format!("MCP 托管安装：启动随包 npm 失败: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Other(format!(
            "MCP 托管安装失败（npm install {package}，{}）：{}",
            output.status,
            output_excerpt(&output)
        )));
    }

    // 3. 解析入口：`node_modules/<pkg>/package.json` 的 bin（字符串/单键对象）→ main。
    let package_dir = dir.join("node_modules").join(package);
    let package_json_path = package_dir.join("package.json");
    let text = std::fs::read_to_string(&package_json_path).map_err(|error| {
        AppError::Other(format!(
            "MCP 托管安装：读不到包清单 {}: {error}",
            package_json_path.display()
        ))
    })?;
    let package_json: Value = serde_json::from_str(&text).map_err(|error| {
        AppError::Other(format!(
            "MCP 托管安装：包清单不是合法 JSON {}: {error}",
            package_json_path.display()
        ))
    })?;
    let entry_in_package = entry_from_package_json(&package_json)?;
    let entry_relative = PathBuf::from("node_modules")
        .join(package)
        .join(entry_in_package);
    let entry = dir.join(&entry_relative);
    if !entry.is_file() {
        return Err(AppError::Other(format!(
            "MCP 托管安装：解析出的入口不存在: {}",
            entry.display()
        )));
    }

    // 4. 写清单：下次 spawn 在 spec 未变时直接复用。
    let manifest = InstallManifest {
        spec: spec.to_string(),
        package: package.to_string(),
        version: package_json
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        entry: entry_relative.to_string_lossy().into_owned(),
    };
    let manifest_path = dir.join(MANIFEST_FILE);
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| AppError::Other(format!("MCP 托管清单序列化失败: {error}")))?;
    std::fs::write(&manifest_path, encoded).map_err(|error| {
        AppError::Io(format!(
            "MCP 托管清单写入失败 {}: {error}",
            manifest_path.display()
        ))
    })?;

    rust_info!(
        "MCP 托管安装完成: {} <- {}{}",
        server_id,
        package,
        if manifest.version.is_empty() {
            String::new()
        } else {
            format!("@{}", manifest.version)
        }
    );
    Ok(ResolvedEntry { entry })
}

/// 托管安装的 npm 参数（形状固定，单测逐项钉住）。
///
/// 有意**不**加 `--ignore-scripts`：npx（npm exec）路径默认同样执行包的 install/postinstall
/// 生命周期脚本，用户显式配置了该 server，托管安装与 npx 是同一条信任链；加上它会让依赖
/// 原生构建的包在托管路径装不出来，等于静默换掉行为而不是省资源。
fn install_args(dir: &Path, spec: &str) -> Vec<String> {
    vec![
        "install".to_string(),
        "--prefix".to_string(),
        dir.to_string_lossy().into_owned(),
        // 一次性安装槽：不写 package.json / lockfile，不建 .bin 链接（入口由宿主解析），
        // 不跑 audit / fund（无信息价值、拖慢首次启动）。
        "--no-save".to_string(),
        "--no-package-lock".to_string(),
        "--no-bin-links".to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
        spec.to_string(),
    ]
}

/// 管理目录 `<data_dir>/mcp/npm/<sanitized_server_id>/`；空名 / `.` / `..` 如实报错。
fn managed_dir(data_dir: &Path, server_id: &str) -> AppResult<PathBuf> {
    let name = sanitize_dir_name(server_id);
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::Config(format!(
            "MCP 托管安装：服务器名不能作为目录名（{server_id:?}）"
        )));
    }
    Ok(data_dir.join("mcp").join("npm").join(name))
}

/// 目录名 sanitize：只保留 `[A-Za-z0-9._-]`，其余字符替换为 `_`。
fn sanitize_dir_name(server_id: &str) -> String {
    server_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// 从 spec 解析 npm 注册表包名（`name` / `name@range` / `@scope/name[@range]`）。
///
/// 非注册表形态（URL、`file:`、`git+…`、`npm:` 别名等）返回 None：装出来的目录名无法从
/// spec 可靠推导，宁可让调用方回退 npx，也不猜一个包目录。
fn registry_package_name(spec: &str) -> Option<&str> {
    if spec.is_empty() || spec.contains(':') {
        return None;
    }
    let name = if let Some(scoped) = spec.strip_prefix('@') {
        // scoped：版本分隔符是第二个 @（首位 @ 是作用域前缀）
        match scoped.rfind('@') {
            Some(index) => &spec[..index + 1],
            None => spec,
        }
    } else {
        match spec.find('@') {
            Some(index) => &spec[..index],
            None => spec,
        }
    };
    let valid = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, package)) => {
                !scope.is_empty()
                    && !package.is_empty()
                    && scope.chars().all(is_package_name_char)
                    && package.chars().all(is_package_name_char)
                    && !package.starts_with('.')
                    && !package.starts_with('_')
            }
            None => false,
        },
        None => {
            !name.is_empty()
                && name.chars().all(is_package_name_char)
                && !name.starts_with('.')
                && !name.starts_with('_')
                && !name.starts_with('-')
        }
    };
    if valid {
        Some(name)
    } else {
        None
    }
}

fn is_package_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')
}

/// 管理目录清单（`manifest.json`）。
#[derive(serde::Serialize, serde::Deserialize)]
struct InstallManifest {
    /// 安装时使用的完整 spec（复用判定只看它）。
    spec: String,
    /// 从 spec 解析出的注册表包名。
    package: String,
    /// 装好的 package.json 的 version（信息性，排障用；缺省空串）。
    #[serde(default)]
    version: String,
    /// 入口脚本相对管理目录的路径（`node <dir>/<entry>` 直启）。
    entry: String,
}

/// 读管理目录清单。缺失返回 None（首次安装的正常路径）；读/解析失败留痕后按缺失处理 ——
/// 重装是自愈路径，不把损坏清单当有效状态继续用。
fn read_manifest(dir: &Path) -> Option<InstallManifest> {
    let path = dir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            rust_warn!(
                "MCP 托管清单不可读（按缺失处理，将重装）: {}: {}",
                path.display(),
                error
            );
            return None;
        }
    };
    match serde_json::from_str::<InstallManifest>(&text) {
        Ok(manifest) => Some(manifest),
        Err(error) => {
            rust_warn!(
                "MCP 托管清单解析失败（按缺失处理，将重装）: {}: {}",
                path.display(),
                error
            );
            None
        }
    }
}

/// 校验清单里的入口（安全相对路径 + 文件存在），返回绝对路径。
fn existing_entry(dir: &Path, entry: &str) -> Option<PathBuf> {
    let relative = clean_relative(entry)?;
    let absolute = dir.join(relative);
    if absolute.is_file() {
        Some(absolute)
    } else {
        None
    }
}

/// 从装好的 package.json 解析入口脚本（相对包目录）：
/// `bin` 字符串 > `bin` 单键对象 > `main`；多键 bin 是歧义，如实报错不猜。
fn entry_from_package_json(package_json: &Value) -> AppResult<PathBuf> {
    let mut relative: Option<String> = None;
    match package_json.get("bin") {
        Some(Value::String(bin)) => {
            if !bin.trim().is_empty() {
                relative = Some(bin.clone());
            }
        }
        Some(Value::Object(bins)) => match bins.len() {
            // bin 空对象视为缺失，退回 main。
            0 => {}
            1 => {
                let (key, value) = bins.iter().next().expect("bin 恰有一个键");
                match value.as_str() {
                    Some(path) if !path.trim().is_empty() => relative = Some(path.to_string()),
                    _ => {
                        return Err(AppError::Config(format!(
                            "MCP 托管包 bin 的 {key} 入口不是非空字符串"
                        )))
                    }
                }
            }
            count => {
                return Err(AppError::Config(format!(
                    "MCP 托管包 bin 有 {count} 个入口（歧义，不猜）"
                )))
            }
        },
        Some(other) => {
            return Err(AppError::Config(format!(
                "MCP 托管包 bin 字段类型非法: {other}"
            )))
        }
        None => {}
    }
    let relative = match relative {
        Some(relative) => relative,
        None => package_json
            .get("main")
            .and_then(Value::as_str)
            .filter(|main| !main.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| AppError::Config("MCP 托管包既无 bin 也无 main 入口".into()))?,
    };
    clean_relative(&relative).ok_or_else(|| {
        AppError::Config(format!("MCP 托管包入口不是安全相对路径: {relative}"))
    })
}

/// 校验并规范化相对路径：只允许 Normal/CurDir 组件（拒绝绝对路径与 `..` 逃逸）。
fn clean_relative(relative: &str) -> Option<PathBuf> {
    let mut cleaned = PathBuf::new();
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if cleaned.as_os_str().is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// npm 失败输出摘录：优先 stderr，空则退回 stdout，并限长。
fn output_excerpt(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        stderr.into_owned()
    };
    let text = text.trim();
    if text.chars().count() > INSTALL_OUTPUT_LIMIT {
        let mut excerpt: String = text.chars().take(INSTALL_OUTPUT_LIMIT).collect();
        excerpt.push('…');
        excerpt
    } else {
        text.to_string()
    }
}

/// 跨模块复用的测试夹具（`mcp_bridge` 的托管直启集成用例也用）：
/// 假随包运行时（node = sh 转派器，npm-cli.js = 假安装器），只依赖 /bin/sh。
#[cfg(all(test, unix))]
pub(crate) mod test_support {
    use crate::commands::runtime_command::NodeRuntimePaths;
    use std::path::{Path, PathBuf};

    const FAKE_NODE: &str = "#!/bin/sh\nexec /bin/sh \"$@\"\n";

    const FAKE_NPM: &str = r#"#!/bin/sh
# 假 npm CLI（node 经 sh 转派到这里）：记录 argv 与调用次数；
# 把 fixture/ 复制进 --prefix 下 node_modules/fake-mcp-pkg（模拟 npm install）。
here="$(dirname "$0")"
printf '%s\n' "$@" > "$here/argv.txt"
printf 'invoked\n' >> "$here/calls.txt"
if [ -f "$here/fail" ]; then
  echo "npm error fake install failure" >&2
  exit 1
fi
prefix=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$a"; fi
  prev="$a"
done
if [ -z "$prefix" ]; then
  echo "npm error missing --prefix" >&2
  exit 2
fi
dest="$prefix/node_modules/fake-mcp-pkg"
mkdir -p "$dest"
cp -R "$here/fixture/." "$dest/"
"#;

    /// 写一个可执行脚本。
    pub fn write_executable(path: &Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, script).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// 搭假随包运行时：`root/node/bin/node` + `…/npm/bin/npm-cli.js`；安装物料由
    /// `install_fixture` 填充（假 npm 从脚本旁的 `fixture/` 复制）。
    pub fn write_fake_runtime(root: &Path) -> NodeRuntimePaths {
        let bin = root.join("node/bin");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&bin.join("node"), FAKE_NODE);
        let npm_bin = npm_bin_dir(root);
        std::fs::create_dir_all(npm_bin.join("fixture")).unwrap();
        write_executable(&npm_bin.join("npm-cli.js"), FAKE_NPM);
        NodeRuntimePaths::from_resource_dir(root)
    }

    fn npm_bin_dir(root: &Path) -> PathBuf {
        root.join("node/lib/node_modules/npm/bin")
    }

    /// 写假包的安装物料：package.json + 入口文件（装到 `<pkg>/…` 下的内容）。
    pub fn install_fixture(root: &Path, package_json: &str, files: &[(&str, &str)]) {
        let fixture = npm_bin_dir(root).join("fixture");
        std::fs::create_dir_all(&fixture).unwrap();
        std::fs::write(fixture.join("package.json"), package_json).unwrap();
        for (name, content) in files {
            let target = fixture.join(name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(target, content).unwrap();
        }
    }

    /// 让下一次假 npm 调用以失败退出（stderr 带固定文案供断言）。
    pub fn mark_install_failure(root: &Path) {
        std::fs::write(npm_bin_dir(root).join("fail"), b"").unwrap();
    }

    /// 假 npm 被调用的次数。
    pub fn npm_calls(root: &Path) -> usize {
        std::fs::read_to_string(npm_bin_dir(root).join("calls.txt"))
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }

    /// 假 npm 最后一次调用的 argv（逐行）。
    pub fn npm_argv(root: &Path) -> Vec<String> {
        std::fs::read_to_string(npm_bin_dir(root).join("argv.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

// ==========================================
// 单元测试 —— 形态识别 / 入口解析 / 假 npm 装配下的安装与复用
// ==========================================
//
// 纯逻辑（识别、包名、sanitize、bin/main 解析、安装锁）跨平台；安装/复用/失败路径
// 依赖假 npm 脚本（sh），按既有做法收窄到 `#[cfg(unix)]`。
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// 用例独占的仓库内临时目录：测试产物只落 `test/.tmp`（本 crate 位于
    /// `crates/native-host`），业务路径始终来自 AppPaths；drop 时清理。
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/.tmp")
                .join(format!(
                    "mcp-managed-{}-{}-{}",
                    tag,
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::SeqCst)
                ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // 测试夹具清理失败不改变用例结论
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_string()).collect()
    }

    // ── 形态识别与参数剥离（跨平台） ──

    #[test]
    fn npx形态识别只认_y与包在前的形状() {
        let input = args(&["-y", "pkg", "--flag", "x"]);
        let (spec, rest) = detect_npx_package(&input).unwrap();
        assert_eq!(spec, "pkg");
        assert_eq!(rest.to_vec(), args(&["--flag", "x"]));

        let input = args(&["--yes", "@scope/pkg@1.2"]);
        let (spec, rest) = detect_npx_package(&input).unwrap();
        assert_eq!(spec, "@scope/pkg@1.2");
        assert!(rest.is_empty());

        for shape in [
            vec![],
            args(&["-y"]),                 // 缺包 spec
            args(&["pkg"]),                // 没有 -y
            args(&["install", "--probe"]), // mcp_bridge 既有用例的形状：绝不能被识别
            args(&["-y", ""]),             // 空 spec
            args(&["-y", "--flag"]),       // spec 位置是旗标
            args(&["-n", "pkg"]),          // 不认识的旗标
        ] {
            assert!(detect_npx_package(&shape).is_none(), "{shape:?} 不得被识别");
        }
    }

    #[test]
    fn 注册表包名解析接受范围并拒绝非注册表形态() {
        assert_eq!(registry_package_name("pkg"), Some("pkg"));
        assert_eq!(registry_package_name("pkg@1.2.3"), Some("pkg"));
        assert_eq!(registry_package_name("@scope/pkg"), Some("@scope/pkg"));
        assert_eq!(registry_package_name("@scope/pkg@^1.2"), Some("@scope/pkg"));
        for rejected in [
            "",
            "https://example.com/pkg.tgz",
            "file:../local-pkg",
            "git+ssh://git@example.com/pkg.git",
            "npm:other-pkg",
            "@scope",     // scoped 缺包名
            "@",          // 只有前缀
            ".hidden",    // npm 包名不允许点/下划线/横杠开头
            "_hidden",
            "-flag",
            "中文包", // 非 ASCII
        ] {
            assert_eq!(registry_package_name(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn 托管目录名只保留安全字符且拒绝非法名() {
        assert_eq!(sanitize_dir_name("mcp-foo.bar_1"), "mcp-foo.bar_1");
        assert_eq!(sanitize_dir_name("mcp-宝可梦 server"), "mcp-____server");
        let data = Path::new("/data");
        assert_eq!(
            managed_dir(data, "mcp-foo bar").unwrap(),
            PathBuf::from("/data/mcp/npm/mcp-foo_bar")
        );
        for invalid in ["", ".", ".."] {
            assert!(managed_dir(data, invalid).is_err(), "{invalid:?} 必须被拒绝");
        }
    }

    #[test]
    fn package清单入口解析按bin与main优先级() {
        let parse = |value: Value| entry_from_package_json(&value);
        // bin 字符串
        assert_eq!(
            parse(serde_json::json!({ "bin": "cli.js" })).unwrap(),
            PathBuf::from("cli.js")
        );
        // bin 单键对象
        assert_eq!(
            parse(serde_json::json!({ "bin": { "whatever": "dist/cli.js" } })).unwrap(),
            PathBuf::from("dist/cli.js")
        );
        // bin 优先于 main
        assert_eq!(
            parse(serde_json::json!({ "bin": "./cli.js", "main": "index.js" })).unwrap(),
            PathBuf::from("cli.js")
        );
        // 缺 / 空 bin 退回 main
        assert_eq!(
            parse(serde_json::json!({ "main": "index.js" })).unwrap(),
            PathBuf::from("index.js")
        );
        assert_eq!(
            parse(serde_json::json!({ "bin": {}, "main": "index.js" })).unwrap(),
            PathBuf::from("index.js")
        );
        // 多键 bin 是歧义：如实报错，不猜
        let error = parse(serde_json::json!({ "bin": { "a": "a.js", "b": "b.js" } }))
            .expect_err("多键 bin 必须报错");
        assert!(error.to_string().contains("歧义"), "{error}");
        // 既无 bin 也无 main
        assert!(parse(serde_json::json!({})).is_err());
        // 类型非法 / 逃逸路径 / 空路径
        assert!(parse(serde_json::json!({ "bin": 3 })).is_err());
        assert!(parse(serde_json::json!({ "bin": { "a": 3 } })).is_err());
        assert!(parse(serde_json::json!({ "bin": "../escape.js" })).is_err());
        assert!(parse(serde_json::json!({ "bin": "/abs/cli.js" })).is_err());
        assert!(parse(serde_json::json!({ "bin": "  " })).is_err());
    }

    #[test]
    fn 安装锁同server复用同一把锁() {
        let locks = InstallLocks::default();
        let first = locks.lock_for("mcp-a");
        let again = locks.lock_for("mcp-a");
        let other = locks.lock_for("mcp-b");
        assert!(Arc::ptr_eq(&first, &again), "同 server 必须复用同一把锁");
        assert!(!Arc::ptr_eq(&first, &other), "不同 server 各自持锁");
        let guard = first.lock().unwrap_or_else(|error| error.into_inner());
        assert!(again.try_lock().is_err(), "持有中不得再次进入");
        drop(guard);
        assert!(again.try_lock().is_ok());
    }

    // ── 假 npm 装配下的安装 / 复用 / 失败（unix） ──

    /// 首次安装：argv 形状逐项钉住（含「与 npx 同信任级、不加 --ignore-scripts」），
    /// 清单落盘；第二次同 spec 复用清单不重装。
    #[cfg(unix)]
    #[test]
    fn 首次安装参数形状与清单复用() {
        let fixture = Fixture::new("install");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","version":"1.0.0","bin":"cli.js"}"#,
            &[("cli.js", "// entry")],
        );

        let resolved = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg").unwrap();
        let dir = data.join("mcp/npm/mcp-fake");
        let expected_entry = dir.join("node_modules/fake-mcp-pkg/cli.js");
        assert_eq!(resolved.entry, expected_entry);
        assert!(resolved.entry.is_file());

        let argv = super::test_support::npm_argv(fixture.path());
        let expected = vec![
            "install".to_string(),
            "--prefix".to_string(),
            dir.to_string_lossy().into_owned(),
            "--no-save".to_string(),
            "--no-package-lock".to_string(),
            "--no-bin-links".to_string(),
            "--no-audit".to_string(),
            "--no-fund".to_string(),
            "fake-mcp-pkg".to_string(),
        ];
        assert_eq!(argv, expected);
        assert!(
            !argv.iter().any(|arg| arg == "--ignore-scripts"),
            "托管安装与 npx 同信任级，不加 --ignore-scripts"
        );

        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["spec"], "fake-mcp-pkg");
        assert_eq!(manifest["package"], "fake-mcp-pkg");
        assert_eq!(manifest["version"], "1.0.0");
        assert_eq!(manifest["entry"], "node_modules/fake-mcp-pkg/cli.js");
        assert_eq!(super::test_support::npm_calls(fixture.path()), 1);

        // 同 spec 第二次：复用清单，不再调用 npm。
        let again = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg").unwrap();
        assert_eq!(again.entry, expected_entry);
        assert_eq!(
            super::test_support::npm_calls(fixture.path()),
            1,
            "spec 未变必须复用清单"
        );
    }

    /// spec 变化（如加了版本范围）必须重装，不能拿旧目录冒充。
    #[cfg(unix)]
    #[test]
    fn spec变化触发重装() {
        let fixture = Fixture::new("spec-change");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","version":"1.0.0","bin":"cli.js"}"#,
            &[("cli.js", "// entry")],
        );

        ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg").unwrap();
        ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg@2.0.0").unwrap();
        assert_eq!(super::test_support::npm_calls(fixture.path()), 2);
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(data.join("mcp/npm/mcp-fake/manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["spec"], "fake-mcp-pkg@2.0.0");
    }

    /// 安装失败返回具体错误（含 npm 输出），且不留下清单 —— 调用方据此 warn + 回退 npx。
    #[cfg(unix)]
    #[test]
    fn 安装失败返回具体错误且不写清单() {
        let fixture = Fixture::new("install-fail");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","bin":"cli.js"}"#,
            &[("cli.js", "// entry")],
        );
        super::test_support::mark_install_failure(fixture.path());

        let error = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg")
            .expect_err("安装失败必须报错");
        let text = error.to_string();
        assert!(
            text.contains("npm") && text.contains("fake install failure"),
            "错误必须带具体失败原因: {text}"
        );
        assert!(
            !data.join("mcp/npm/mcp-fake/manifest.json").exists(),
            "失败不得留下清单（否则下次会被当成已安装）"
        );
        assert_eq!(super::test_support::npm_calls(fixture.path()), 1);
    }

    /// 多键 bin 歧义如实报错（回退 npx，不猜入口），不写清单。
    #[cfg(unix)]
    #[test]
    fn 多键bin歧义如实报错() {
        let fixture = Fixture::new("bin-ambiguous");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","bin":{"a":"a.js","b":"b.js"}}"#,
            &[("a.js", "// a"), ("b.js", "// b")],
        );

        let error = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg")
            .expect_err("多键 bin 必须报错");
        assert!(error.to_string().contains("歧义"), "{error}");
        assert!(!data.join("mcp/npm/mcp-fake/manifest.json").exists());
    }

    /// 解析出的入口文件不存在：如实报错（entry 校验存在），不写清单。
    #[cfg(unix)]
    #[test]
    fn 入口文件缺失如实报错() {
        let fixture = Fixture::new("entry-missing");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","bin":"missing.js"}"#,
            &[],
        );

        let error = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg")
            .expect_err("入口不存在必须报错");
        assert!(error.to_string().contains("入口不存在"), "{error}");
    }

    /// 清单里的入口被删（如用户清理过目录）：视为需要重装，不拿失效清单启动。
    #[cfg(unix)]
    #[test]
    fn 清单入口丢失会重装() {
        let fixture = Fixture::new("entry-lost");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");
        super::test_support::install_fixture(
            fixture.path(),
            r#"{"name":"fake-mcp-pkg","version":"1.0.0","bin":"cli.js"}"#,
            &[("cli.js", "// entry")],
        );
        ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg").unwrap();
        std::fs::remove_file(data.join("mcp/npm/mcp-fake/node_modules/fake-mcp-pkg/cli.js"))
            .unwrap();

        let resolved = ensure_installed(&runtime, &data, "mcp-fake", "fake-mcp-pkg").unwrap();
        assert!(resolved.entry.is_file(), "重装后入口必须回来");
        assert_eq!(super::test_support::npm_calls(fixture.path()), 2);
    }

    /// 非注册表 spec（URL 等）不出目录、不装：如实报错，调用方回退 npx。
    #[cfg(unix)]
    #[test]
    fn 非注册表spec如实报错且不调npm() {
        let fixture = Fixture::new("non-registry");
        let runtime = super::test_support::write_fake_runtime(fixture.path());
        let data = fixture.path().join("data");

        let error = ensure_installed(&runtime, &data, "mcp-fake", "https://example.com/pkg.tgz")
            .expect_err("非注册表 spec 必须报错");
        assert!(error.to_string().contains("注册表包名"), "{error}");
        assert_eq!(super::test_support::npm_calls(fixture.path()), 0);
        assert!(!data.join("mcp/npm/mcp-fake").exists());
    }
}
