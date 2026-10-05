//! 聊天历史图片的**占位**（执行契约 §5.3）。
//!
//! 占位只读文件元数据：文件名 + 大小 + 是否存在（`std::fs::metadata`）。
//! **不打开文件、不读字节、不解码、不生成缩略图**（这是「关闭自动预览时浏览
//! 历史零解码」的实现点）。可用性不逐条预读内容：格式/权限等失效原因在用户
//! 点击占位时由打开路径（`viewer.rs` → `images::preview::PreviewManager`
//! 的点击时刻复核）以明确原因返回。
//!
//! 自动预览开关（`appearance.chatImagePreview`，默认关闭）落地时，内联预览的
//! 加载/释放属于开关开启路径，不改变本文件「占位零解码」的语义。

use std::path::Path;

/// 一张历史图片的占位元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImagePlaceholder {
    /// 原路径（读模型里保存的路径，原样展示与打开）。
    pub path: String,
    /// 文件名（含扩展名；取不到文件名时退化为原路径）。
    pub file_name: String,
    /// 文件大小（字节）；元数据读取失败为 `None`。
    pub size_bytes: Option<u64>,
    /// 文件当前是否可用（仅凭元数据判定；内容失效留给点击时复核）。
    pub available: bool,
}

/// 由原路径构造占位。只调用 `metadata()`，不触碰文件内容。
pub fn placeholder_for(path: &str) -> ImagePlaceholder {
    let file_name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => ImagePlaceholder {
            path: path.to_string(),
            file_name,
            size_bytes: Some(metadata.len()),
            available: true,
        },
        _ => ImagePlaceholder {
            path: path.to_string(),
            file_name,
            size_bytes: None,
            available: false,
        },
    }
}

/// 占位的人类可读标注（平台层显示在消息流的 chip 上）。
///
/// 2026-10-05 chip 化收敛：去掉「· 点击查看」尾巴（chip 本身就是按钮，文案越短
/// 越像徽标、不再撑成一条横幅）；分隔符统一设计稿 `.pchip` 的 `·`。
pub fn placeholder_label(index: usize, placeholder: &ImagePlaceholder) -> String {
    if placeholder.available {
        format!(
            "图片 {} · {}（{}）",
            index + 1,
            placeholder.file_name,
            format_size(placeholder.size_bytes)
        )
    } else {
        // 「（不可用）」而非「（原文件不可用）」：chip 宽度有限，缩短后长文件名
        // 也大概率能完整显示（截断优先发生在文件名上，语义尾巴保住）。
        format!("图片 {} · {}（不可用）", index + 1, placeholder.file_name)
    }
}

/// 待发送区的条目标注（同样只读元数据；点击语义是「撤选」，不是「查看」）。
pub fn pending_label(placeholder: &ImagePlaceholder) -> String {
    format!(
        "{}（{}）✕",
        placeholder.file_name,
        format_size(placeholder.size_bytes)
    )
}

/// 文件大小的人类可读形态（历史占位与待发送区共用同一格式，不各写一份）。
fn format_size(size_bytes: Option<u64>) -> String {
    match size_bytes {
        Some(bytes) => format!("{:.1} KB", bytes as f64 / 1024.0),
        None => "大小未知".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 存在文件给出文件名与大小() {
        let dir =
            std::env::temp_dir().join(format!("deskpet-chat-placeholder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("照片.png");
        std::fs::write(&path, b"not really an image").unwrap();
        let placeholder = placeholder_for(&path.to_string_lossy());
        assert!(placeholder.available);
        assert_eq!(placeholder.file_name, "照片.png");
        // fixture 恰为 19 字节（"not really an image" = 3+1+6+1+2+1+5）；
        // 实现读的是真实元数据，此前断言把字节数数错成 18。
        assert_eq!(placeholder.size_bytes, Some(19));
        let label = placeholder_label(0, &placeholder);
        // chip 化文案：`图片 N · 文件名（大小）`（19 字节 = 0.0 KB）。
        assert_eq!(label, "图片 1 · 照片.png（0.0 KB）");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 缺失文件只标记不可用不做任何读取() {
        let placeholder = placeholder_for("/definitely/not/here/图片.png");
        assert!(!placeholder.available);
        assert_eq!(placeholder.file_name, "图片.png");
        assert!(placeholder.size_bytes.is_none());
        assert_eq!(
            placeholder_label(2, &placeholder),
            "图片 3 · 图片.png（不可用）"
        );
    }

    #[test]
    fn 待发送标注含文件名与大小且点击语义是撤选() {
        let placeholder = ImagePlaceholder {
            path: "/tmp/照片.png".into(),
            file_name: "照片.png".into(),
            size_bytes: Some(2048),
            available: true,
        };
        let label = pending_label(&placeholder);
        assert_eq!(label, "照片.png（2.0 KB）✕");
        assert!(!label.contains("点击查看"), "待发送区点击是撤选：{label}");
    }
}
