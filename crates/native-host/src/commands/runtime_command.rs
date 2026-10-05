//! 随包 Node/npm/npx 的唯一命令解析口；不依赖机器全局安装或 .cmd/symlink 包装器。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub struct NodeRuntimePaths {
    node: PathBuf,
    npm: PathBuf,
    npx: PathBuf,
}

impl NodeRuntimePaths {
    pub fn from_resource_dir(resources: &Path) -> Self {
        let root = resources.join("node");
        #[cfg(windows)]
        let (node, modules) = (root.join("node.exe"), root.join("node_modules"));
        #[cfg(not(windows))]
        let (node, modules) = (root.join("bin/node"), root.join("lib/node_modules"));
        Self {
            node,
            // 逐段 join：`join("npm/bin/npm-cli.js")` 会把正斜杠原样带进 OsString，
            // Windows 下得到 `node_modules\npm/bin\...` 这种混合分隔符（能执行，但
            // 与同为该路径构造方的测试/日志口径不一致）；逐段 join 产出各平台的
            // 规范本机路径。
            npm: modules.join("npm").join("bin").join("npm-cli.js"),
            npx: modules.join("npm").join("bin").join("npx-cli.js"),
        }
    }

    /// 明确命名的标准 CLI 使用发行闭包；用户给出的其他/绝对命令仍按原语义执行。
    pub fn command(
        &self,
        program: &str,
        args: &[String],
        overrides: Option<&HashMap<String, String>>,
    ) -> AppResult<Command> {
        let alias = standard_node_command(program);
        let mut command = if let Some(alias) = alias {
            if !self.node.is_file() {
                return Err(AppError::Config(
                    "随包 Node 不存在，不能回退到系统 Node".into(),
                ));
            }
            let mut command = Command::new(&self.node);
            let script = match alias {
                "npm" => Some(&self.npm),
                "npx" => Some(&self.npx),
                _ => None,
            };
            if let Some(script) = script {
                if !script.is_file() {
                    return Err(AppError::Config(format!("随包 {alias} CLI 不存在")));
                }
                command.arg(script);
            }
            command
        } else {
            Command::new(program)
        };
        command.args(args);
        if let Some(overrides) = overrides {
            command.envs(overrides);
        }
        // 子脚本的 env node/npm 子进程同样能找到发行闭包；保留用户配置的其余 PATH。
        let configured_path = overrides
            .and_then(|env| {
                env.iter()
                    .find(|(key, _)| {
                        if cfg!(windows) {
                            key.eq_ignore_ascii_case("PATH")
                        } else {
                            key.as_str() == "PATH"
                        }
                    })
                    .map(|(_, value)| std::ffi::OsString::from(value))
            })
            .or_else(|| std::env::var_os("PATH"));
        let mut path_entries = vec![self
            .node
            .parent()
            .ok_or_else(|| AppError::Config("Node 路径缺少父目录".into()))?
            .to_path_buf()];
        if let Some(path) = configured_path {
            path_entries.extend(std::env::split_paths(&path));
        }
        command.env(
            "PATH",
            std::env::join_paths(path_entries)
                .map_err(|error| AppError::Config(format!("Node PATH 无效: {error}")))?,
        );
        Ok(command)
    }
}

pub fn standard_node_command(program: &str) -> Option<&'static str> {
    match program {
        "node" | "node.exe" => Some("node"),
        "npm" | "npm.cmd" | "npm.exe" => Some("npm"),
        "npx" | "npx.cmd" | "npx.exe" => Some("npx"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 标准命令与显式路径分开() {
        assert_eq!(standard_node_command("npx.cmd"), Some("npx"));
        assert_eq!(standard_node_command("node"), Some("node"));
        assert_eq!(standard_node_command("/custom/node"), None);
        assert_eq!(standard_node_command("C:\\custom\\node.exe"), None);
        assert_eq!(standard_node_command("bash"), None);
    }
    #[test]
    fn 随包缺失不回退全局node() {
        let runtime =
            NodeRuntimePaths::from_resource_dir(Path::new("/__deskpet_missing_runtime__"));
        assert!(runtime.command("node", &[], None).is_err());
        assert!(runtime.command("npx.cmd", &[], None).is_err());
        assert_eq!(
            runtime
                .command("other-tool", &[], None)
                .unwrap()
                .get_program(),
            "other-tool"
        );
    }

    #[test]
    fn 随包路径按平台闭包布局() {
        let runtime = NodeRuntimePaths::from_resource_dir(Path::new("/res"));
        let root = Path::new("/res").join("node");
        // 平台布局不同（Windows 是 node.exe + node_modules；macOS 是 bin/ + lib/node_modules）。
        #[cfg(windows)]
        {
            assert_eq!(runtime.node, root.join("node.exe"));
            assert_eq!(
                runtime.npm,
                root.join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js")
            );
            assert_eq!(
                runtime.npx,
                root.join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npx-cli.js")
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(runtime.node, root.join("bin").join("node"));
            assert_eq!(
                runtime.npm,
                root.join("lib")
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js")
            );
            assert_eq!(
                runtime.npx,
                root.join("lib")
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npx-cli.js")
            );
        }
    }

    #[test]
    fn 随包命令指向发行闭包并透传参数与环境() {
        // 假随包运行时：只要求文件存在（命令构造不执行它）。
        let root =
            std::env::temp_dir().join(format!("deskpet-node-runtime-{}", std::process::id()));
        let runtime = NodeRuntimePaths::from_resource_dir(&root);
        #[cfg(windows)]
        let (node_file, npm_script) = (
            root.join("node").join("node.exe"),
            root.join("node")
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js"),
        );
        #[cfg(not(windows))]
        let (node_file, npm_script) = (
            root.join("node").join("bin").join("node"),
            root.join("node")
                .join("lib")
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js"),
        );
        std::fs::create_dir_all(node_file.parent().unwrap()).unwrap();
        std::fs::write(&node_file, b"").unwrap();

        // CLI 脚本不存在：如实报错，不回退到系统 npm（闭包纪律）。
        let error = runtime.command("npm", &[], None).unwrap_err();
        assert_eq!(error.code(), "CONFIG");
        assert!(error.to_string().contains("随包 npm CLI 不存在"));

        // 脚本就位：程序 = 随包 node，闭包脚本在前、用户参数在后。
        std::fs::create_dir_all(npm_script.parent().unwrap()).unwrap();
        std::fs::write(&npm_script, b"").unwrap();
        let overrides = HashMap::from([("DESKPET_TEST_MARKER".to_string(), "1".to_string())]);
        let command = runtime
            .command("npm.cmd", &["install".to_string()], Some(&overrides))
            .unwrap();
        assert_eq!(command.get_program(), node_file.as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            vec![npm_script.as_os_str(), std::ffi::OsStr::new("install")],
            "闭包脚本在前，用户参数在后"
        );
        let envs: HashMap<_, _> = command
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(|value| value.to_os_string())))
            .collect();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("DESKPET_TEST_MARKER")),
            Some(&Some(std::ffi::OsString::from("1"))),
            "调用方覆盖的环境变量原样透传"
        );
        let path = envs
            .get(std::ffi::OsStr::new("PATH"))
            .cloned()
            .flatten()
            .expect("PATH 必须被显式设置");
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            entries.first(),
            Some(&node_file.parent().unwrap().to_path_buf()),
            "PATH 首位是随包 node 目录（子脚本的 node/npm 子进程不落到系统 PATH 前）"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
