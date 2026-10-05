//! 编辑器素材列表与跨层复制（HostLink 既有请求面）。
//!
//! 素材枚举/复制天然是 Node 侧的投影：文件列表经既有 `list_profile_files`
//! 命令（Rust 持有数据根与边界校验）、复制经 Profile 唯一读写路径，Node 还是
//! `appearance.activeProfile` 的唯一所有者。宿主 UI 只消费列表与结果，不自己
//! 枚举目录、不自己拼数据根。
//!
//! 方法与 Node 侧 `host-requests.ts` 的编辑器 I/O 分支成对维护；和 EditorPort 的
//! load/save/pick 一样汇入同一个 Node 分派器（`dispatchHostRequest`），不新增通道。
//! 阻塞请求只在非 UI 线程调用（调用方是 `EditorUi` 的刷新线程，与 load/save 同款）。
//!
//! 路径纪律（与 `editor_save` 的回传纪律同源）：列表里的 `path` 是**线格式**
//! `<profileId>/materials/L{n}/x.png`（保存/复制请求只认它）；`absolutePath` 由
//! Node 经 `runtimePath()` 拼出，仅用于本地渲染预览，绝不写回任何持久层。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ui::ports::{host_link, HOST_REQUEST_TIMEOUT};

use super::EditorAsset;

/// 列素材：Node 枚举当前激活 Profile 的 `materials/L*/` 图片素材。
pub const LIST_METHOD: &str = "editor_list_assets";
/// 跨层复制：把源素材复制进目标层目录，返回新素材（线格式 + 绝对路径）。
pub const COPY_METHOD: &str = "editor_copy_asset";

/// 素材列表：一次拉全（含其它层），由 UI 标记「本层 / 复制到本层」。
pub fn fetch_asset_list() -> AppResult<Vec<EditorAsset>> {
    let value = request(LIST_METHOD, json!({}))?;
    let assets = value
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("editor_list_assets 回执缺少 assets".into()))?;
    assets.iter().map(parse_asset).collect()
}

/// 跨层复制：`source_wire` 是列表里的线格式路径（任意层），结果落在 `<layer>` 层目录。
pub fn copy_asset_into_layer(layer: usize, source_wire: &str) -> AppResult<EditorAsset> {
    let value = request(
        COPY_METHOD,
        json!({ "layer": layer, "source": source_wire }),
    )?;
    parse_asset(&value)
}

fn request(method: &str, args: Value) -> AppResult<Value> {
    let link = host_link()
        .ok_or_else(|| AppError::Other("宿主 → Node 通道未接线，素材请求无法投递".into()))?;
    link.request(method, args, HOST_REQUEST_TIMEOUT)
}

/// 素材项解析：字段缺失/类型不符即报错（与 `editor_load` 的解析同纪律，不静默兜底）。
fn parse_asset(value: &Value) -> AppResult<EditorAsset> {
    let wire_path = value
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| AppError::Config("素材项缺少 path（线格式）".into()))?
        .to_string();
    let absolute_path = value
        .get("absolutePath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| AppError::Config("素材项缺少 absolutePath".into()))?;
    let layer = value
        .get("layer")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::Config("素材项缺少 layer".into()))? as usize;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::Config("素材项缺少 name".into()))?
        .to_string();
    Ok(EditorAsset {
        wire_path,
        absolute_path: PathBuf::from(absolute_path),
        layer,
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 素材项解析保留线格式与绝对路径的分野() {
        let value = json!({
            "path": "sugar-pink/materials/L2/body.png",
            "absolutePath": "/data/profiles/sugar-pink/materials/L2/body.png",
            "layer": 2,
            "name": "body.png",
        });
        let asset = parse_asset(&value).unwrap();
        assert_eq!(asset.wire_path, "sugar-pink/materials/L2/body.png");
        assert_eq!(
            asset.absolute_path,
            PathBuf::from("/data/profiles/sugar-pink/materials/L2/body.png")
        );
        assert_eq!(asset.layer, 2);
        assert_eq!(asset.name, "body.png");
    }

    #[test]
    fn 素材项缺字段如实报错() {
        assert!(parse_asset(&json!({ "absolutePath": "/x", "layer": 0, "name": "x" })).is_err());
        assert!(
            parse_asset(&json!({ "path": "p/materials/L0/x.png", "layer": 0, "name": "x" }))
                .is_err()
        );
        assert!(parse_asset(
            &json!({ "path": "p/materials/L0/x.png", "absolutePath": "/x", "name": "x" })
        )
        .is_err());
        assert!(
            parse_asset(&json!({ "path": "", "absolutePath": "/x", "layer": 0, "name": "x" }))
                .is_err()
        );
    }
}
