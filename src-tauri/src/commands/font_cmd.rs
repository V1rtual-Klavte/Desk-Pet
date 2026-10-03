// ==========================================
// 系统字体命令 —— 设置/外观的全局字体选择
// ==========================================

use crate::error::{AppError, AppResult};

/// 家族名归一：去首尾空白、丢空名、排序、大小写不敏感去重。
///
/// 抽成纯函数是为了让单测直接覆盖排序/去重规则本身，不依赖本机装了哪些字体。
fn normalize_family_names<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut result: Vec<String> = names
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    result.sort_unstable();
    result.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    result
}

/// 枚举本机已安装字体的家族名，供设置/外观的全局字体选择。
///
/// 枚举放在 Rust 侧：WebView 的 Local Font Access API 在 WKWebView 上不存在、
/// 在 WebView2 上需要用户授权，两端行为不一致；fontdb 直接扫描系统字体目录 /
/// 注册表，与 WebView 能力无关。扫描是同步阻塞 IO（数百毫秒级），放工作线程执行。
#[tauri::command]
pub async fn list_system_fonts() -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // families[0] 约定为英语名（字体缺失英文名时退回字体自带的首个名字）。
        normalize_family_names(
            db.faces()
                .filter_map(|face| face.families.first().map(|(name, _)| name.as_str())),
        )
    })
    .await
    .map_err(|e| AppError::Io(format!("字体枚举任务失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::normalize_family_names;

    #[test]
    fn normalize_sorts_dedups_and_drops_empty_names() {
        let input = ["Songti SC", "  ", "Arial", "Arial ", "noto sans", "Arial"];
        assert_eq!(
            normalize_family_names(input.into_iter()),
            vec!["Arial", "Songti SC", "noto sans"],
        );
    }

    #[test]
    fn normalize_dedups_case_insensitively_keeping_sorted_first() {
        let input = ["Arial", "ARIAL"];
        // 字节序下 "ARIAL" 排在 "Arial" 前，去重保留排序后的靠前者
        assert_eq!(normalize_family_names(input.into_iter()), vec!["ARIAL"]);
    }

    #[test]
    fn command_returns_non_empty_font_list_on_this_machine() {
        // 冒烟：macOS / Windows 的系统字体目录必然非空。断言覆盖「扫描 → 归一化 → 命令」
        // 整条链 —— 把命令实现改回空列表（或漏掉 load_system_fonts）这条就会红。
        let fonts = tauri::async_runtime::block_on(super::list_system_fonts())
            .expect("list_system_fonts 不应失败");
        assert!(!fonts.is_empty(), "系统字体列表不应为空");
    }
}
