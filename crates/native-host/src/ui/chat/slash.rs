//! Slash 命令候选（W8b）：**命令表来自 Node 已注册的注册表投影**，本模块只做
//! 与 `src/services/engine/slash/registry.ts::search` 同义的模糊匹配与排序。
//!
//! 边界（执行契约 §6.3「UI 只消费」）：
//! - 命令的注册、执行、忙碌期准入策略全部在 Node（ingress / preProcess）；
//!   本模块不执行任何命令、不查表外字面量，也不把候选写进发送文本 ——
//!   选用候选只是把 `/<name>` 填回输入框，发送后仍由 Node 判定执行或透传。
//! - 匹配规则镜像 `registry.ts::search`：完全匹配 score=3、命令名前缀 score=2、
//!   命令名或描述包含 score=1，按分数降序（同分保持注册顺序）；大小写不敏感。
//!   规则改动以 Node 侧为真相源，本镜像随之修正。

use super::projection::SlashCommandView;

/// 一条命中的候选（分数与 `SlashMatch.score` 同义）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashMatchView {
    pub command: SlashCommandView,
    pub score: u8,
}

/// 在注册表投影里做模糊搜索（`partial` 不含前导 `/`）。
pub fn search(commands: &[SlashCommandView], partial: &str) -> Vec<SlashMatchView> {
    let lower = partial.to_lowercase();
    let mut results: Vec<SlashMatchView> = Vec::new();
    for command in commands {
        let name = command.name.to_lowercase();
        let score = if name == lower {
            3
        } else if name.starts_with(&lower) {
            2
        } else if name.contains(&lower) || command.description.to_lowercase().contains(&lower) {
            1
        } else {
            continue;
        };
        results.push(SlashMatchView {
            command: command.clone(),
            score,
        });
    }
    // 稳定排序：同分保持注册顺序（与 Node 侧 `Array.prototype.sort` 的稳定语义一致）。
    results.sort_by(|a, b| b.score.cmp(&a.score));
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands() -> Vec<SlashCommandView> {
        vec![
            SlashCommandView {
                name: "help".into(),
                description: "查看帮助".into(),
            },
            SlashCommandView {
                name: "clear".into(),
                description: "清空当前会话".into(),
            },
            SlashCommandView {
                name: "memory clean".into(),
                description: "清理记忆".into(),
            },
            SlashCommandView {
                name: "skill".into(),
                description: "启动技能".into(),
            },
        ]
    }

    #[test]
    fn 按分数排序且大小写不敏感() {
        let matches = search(&commands(), "CL");
        // "clear" 前缀命中 score=2；"memory clean" 的命令名里也含 "cl"（score=1）。
        // Node 侧 `registry.ts::search` 的 includes 口径同样命中两条 —— 期望不是 1 条。
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].command.name, "clear");
        assert_eq!(matches[0].score, 2, "前缀匹配 score=2");
        assert_eq!(matches[1].command.name, "memory clean");
        assert_eq!(matches[1].score, 1, "包含匹配 score=1");

        let matches = search(&commands(), "help");
        assert_eq!(matches[0].score, 3, "完全匹配 score=3");

        let matches = search(&commands(), "记忆");
        assert_eq!(matches[0].command.name, "memory clean");
        assert_eq!(matches[0].score, 1, "描述包含 score=1");
    }

    #[test]
    fn 同分保持注册顺序且未命中不返回() {
        let matches = search(&commands(), "e");
        let names: Vec<&str> = matches.iter().map(|m| m.command.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["help", "clear", "memory clean"],
            "同分保持注册顺序"
        );
        assert!(search(&commands(), "zzz").is_empty());
    }
}
