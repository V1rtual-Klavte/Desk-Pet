//! `ui::ports` 的线格式解析与路径拼接辅助。
//!
//! 回执/载荷的**形状契约**独立于端口实现：缺字段或类型不符即如实报错（不静默兜底）。

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ui::settings::panels::{
    self, McpServerForm, McpTransport, MemoryDetail, MemoryOverview, PanelRow,
};
use crate::ui::settings::{CardOption, CardStages, SettingsSnapshot, SettingsValue};

pub(super) fn required_f64(value: &Value, key: &str) -> AppResult<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| AppError::Config(format!("字段缺少或不是有限数值: {key}")))
}

/// profiles 域内相对路径 → 绝对路径（宿主保留最终路径裁决）。
///
/// `profiles_root` 来自 `AppPaths.profiles`（唯一数据根决定点，本模块不自行推算）。
/// 只接受纯 `Normal` 分段（拒绝绝对路径、`..`、`.`、空串与平台前缀）；文件存在性
/// 与凭据判定仍由消费点（渲染器 / Profile 命令）走既有 `AppPaths::validate_*`。
pub(super) fn join_profiles_path(profiles_root: &Path, relative: &str) -> AppResult<PathBuf> {
    let rel = Path::new(relative);
    if relative.is_empty()
        || rel.is_absolute()
        || !rel.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    Ok(profiles_root.join(rel))
}

/// `{ values: { key: bool|number|string } }` → [`SettingsSnapshot`]。
/// 键原样（CONFIG 路径），值只收三种标量；其它形状是协议违规，如实报错。
pub(crate) fn parse_settings_snapshot(value: &Value) -> AppResult<SettingsSnapshot> {
    let values = value
        .get("values")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Config("settings_read 回执缺少 values".into()))?;
    let mut snapshot = SettingsSnapshot::default();
    for (key, raw) in values {
        let parsed = match raw {
            Value::Bool(flag) => SettingsValue::Bool(*flag),
            Value::Number(number) => SettingsValue::Number(
                number
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| AppError::Config(format!("设置值不是有限数值: {key}")))?,
            ),
            Value::String(text) => SettingsValue::Text(text.clone()),
            _ => {
                return Err(AppError::Config(format!(
                    "设置值形状不受支持（只收 bool/number/string）: {key}"
                )))
            }
        };
        snapshot.values.insert(key.clone(), parsed);
    }
    Ok(snapshot)
}

pub(super) fn settings_value_to_json(value: &SettingsValue) -> AppResult<Value> {
    Ok(match value {
        SettingsValue::Bool(flag) => Value::Bool(*flag),
        SettingsValue::Number(number) => {
            serde_json::Number::from_f64(*number)
                .map(Value::Number)
                .ok_or_else(|| AppError::Config("设置值不是有限数值".into()))?
        }
        SettingsValue::Text(text) => Value::String(text.clone()),
    })
}

/// `{ active, cards: [{id,name,description}] }` → 选项列表（激活项由草稿值承载）。
pub(super) fn parse_card_options(value: &Value) -> AppResult<Vec<CardOption>> {
    let cards = value
        .get("cards")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("personality_cards 回执缺少 cards".into()))?;
    let mut options = Vec::with_capacity(cards.len());
    for card in cards {
        let id = card
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("人格卡缺少 id".into()))?;
        let name = card
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("人格卡缺少 name".into()))?;
        options.push(CardOption {
            id: id.to_string(),
            name: name.to_string(),
        });
    }
    Ok(options)
}

/// `{ profiles: [{id,name,description}] }` → Profile 选项（激活项由草稿值承载）。
pub(super) fn parse_profile_options(
    value: &Value,
) -> AppResult<Vec<crate::ui::settings::ProfileOption>> {
    let profiles = value
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("profile_list 回执缺少 profiles".into()))?;
    let mut options = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let id = profile
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("Profile 选项缺少 id".into()))?;
        options.push(crate::ui::settings::ProfileOption {
            id: id.to_string(),
            name: profile
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            description: profile
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(options)
}

/// `{ revision, statusText, items: [...], jobs: [...] }` → [`MemoryOverview`]。
///
/// 缺 `revision`/`statusText` 是协议违规（如实报错）；`items`/`jobs` 缺省按空数组
/// （「还没读到」与「确实是空」由 UI 域的 loaded 位区分）。
pub(super) fn parse_memory_overview(value: &Value) -> AppResult<MemoryOverview> {
    let revision = value
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_overview 回执缺少 revision".into()))?;
    let status_text = value
        .get("statusText")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("memory_overview 回执缺少 statusText".into()))?
        .to_string();
    let items = parse_optional_rows(value, "items")?;
    let jobs = parse_optional_rows(value, "jobs")?;
    Ok(MemoryOverview {
        revision,
        status_text,
        items,
        jobs,
    })
}

/// `{ revision, itemId, version, pinned, info, content, history: [...] }` → [`MemoryDetail`]。
pub(super) fn parse_memory_detail(value: &Value) -> AppResult<MemoryDetail> {
    let item_id = value
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 itemId".into()))?
        .to_string();
    let revision = value
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 revision".into()))?;
    let version = value
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 version".into()))?;
    Ok(MemoryDetail {
        item_id,
        revision,
        version,
        // pinned/info/content 与 itemId/version 同口径：Node 的类型是全必填
        // （MemoryItemDetailPayload）。缺字段静默按 false/空串兜底会把「核心画像
        // 标记丢了」「详情是空的」这类坏回执伪装成正常结果，界面据此下错判断。
        pinned: value
            .get("pinned")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 pinned".into()))?,
        info: required_text(value, "info", "memory_item_detail")?,
        content: required_text(value, "content", "memory_item_detail")?,
        // 来源行缺省 = 没有可回看的来源（读取时机差异，不是协议违规）；
        // 行形状与其它管理面行同一套解析（协议违规如实报错，不静默丢行）。
        sources: parse_optional_rows(value, "sources")?,
        history: parse_optional_rows(value, "history")?,
    })
}

fn parse_optional_rows(value: &Value, key: &str) -> AppResult<Vec<PanelRow>> {
    match value.get(key) {
        Some(rows) => panels::parse_rows(rows),
        None => Ok(Vec::new()),
    }
}

// ── 本批管理面的解析辅助 ──

/// 取必填文本字段；缺字段/形状不符是协议违规，如实报错（不补空串冒充成功）。
pub(super) fn required_text(value: &Value, key: &str, method: &str) -> AppResult<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Config(format!("{method} 回执缺少文本字段 {key}")))
}

/// `{ cardId? }` 的公共参数（None = Node 取激活卡）。
pub(super) fn card_id_args(card_id: Option<&str>) -> Value {
    match card_id {
        Some(card_id) => json!({ "cardId": card_id }),
        None => json!({ "cardId": Value::Null }),
    }
}

pub(super) fn parse_card_stages(value: &Value) -> AppResult<CardStages> {
    Ok(CardStages {
        card_id: required_text(value, "cardId", "card_stages")?,
        // fallback 是「当前文案是否 Card 不可用时的兜底」这一事实本身，缺字段
        // 静默按 false 会把兜底文案冒充成 Card 文案（Node 侧两个方法都必发此字段）。
        fallback: value
            .get("fallback")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("card_stages 回执缺少 fallback".into()))?,
        text: required_text(value, "text", "card_stages")?,
    })
}

/// `mcp_server_form` 回执 → 表单（逐字段解析；缺字段/非法取值是协议违规，如实报错）。
pub(super) fn parse_mcp_server_form(value: &Value) -> AppResult<McpServerForm> {
    let transport_raw = required_text(value, "transport", "mcp_server_form")?;
    let transport = McpTransport::parse(&transport_raw).ok_or_else(|| {
        AppError::Config(format!("mcp_server_form 的 transport 取值非法: {transport_raw}"))
    })?;
    // enabled 缺字段静默按 false 会把「启用的服务器」显示成关闭态（表单默认值语义不同），
    // 与 Node 侧全必填的回执类型对齐：缺了就是协议违规。
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Config("mcp_server_form 回执缺少布尔字段 enabled".into()))?;
    Ok(McpServerForm {
        name: required_text(value, "name", "mcp_server_form")?,
        transport,
        command: required_text(value, "command", "mcp_server_form")?,
        args: required_text(value, "args", "mcp_server_form")?,
        url: required_text(value, "url", "mcp_server_form")?,
        env: required_text(value, "env", "mcp_server_form")?,
        headers: required_text(value, "headers", "mcp_server_form")?,
        enabled,
    })
}

/// `{ saved, path }` → `Option<path>`（saved=false = 用户取消，不是失败）。
pub(super) fn parse_saved_path(value: &Value, method: &str) -> AppResult<Option<String>> {
    let saved = value
        .get("saved")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Config(format!("{method} 回执缺少 saved")))?;
    if !saved {
        return Ok(None);
    }
    match value.get("path") {
        Some(Value::String(path)) if !path.is_empty() => Ok(Some(path.clone())),
        _ => Err(AppError::Config(format!("{method} 回执已保存但缺少 path"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::ports::test_support::*;

    #[test]
    fn 设置快照解析只收三种标量() {
        let snapshot = parse_settings_snapshot(&json!({
            "values": { "appearance.chatImagePreview": false, "appearance.font.size": 17, "general.shortcut.key": "P" }
        }))
        .unwrap();
        assert_eq!(
            snapshot.values.get("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(false))
        );
        assert_eq!(
            snapshot.values.get("appearance.font.size"),
            Some(&SettingsValue::Number(17.0))
        );
        assert_eq!(
            snapshot.values.get("general.shortcut.key"),
            Some(&SettingsValue::Text("P".into()))
        );

        // 数组/对象值（客户端不该发）如实报错，不静默吞。
        assert!(
            parse_settings_snapshot(&json!({ "values": { "tools.bash.whitelist": ["ls"] } }))
                .is_err()
        );
        assert!(parse_settings_snapshot(&json!({ "nope": {} })).is_err());
    }

    #[test]
    fn profile选项解析保留id与显示名() {
        let options = parse_profile_options(&json!({
            "active": "sugar-pink",
            "profiles": [
                { "id": "sugar-pink", "name": "Sugar Pink", "description": "粉糖" },
                { "id": "plain" }
            ]
        }))
        .unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].id, "sugar-pink");
        assert_eq!(options[0].name, "Sugar Pink");
        assert_eq!(options[1].name, "plain", "缺显示名回落 id");
        assert!(parse_profile_options(&json!({ "active": null })).is_err());
        assert!(parse_profile_options(&json!({ "profiles": [{ "name": "无 id" }] })).is_err());
    }

    #[test]
    fn 记忆总览解析保留状态行与两类行() {
        let overview = parse_memory_overview(&json!({
            "revision": 7,
            "statusText": "库版本 revision 7 · 3 条当前记忆 · 2 个整理作业",
            "items": [
                { "id": "m1", "title": "喜欢猫", "subtitle": "fact · user · v2", "action": "select", "enabled": true }
            ],
            "jobs": [
                { "id": "j1", "title": "review · completed", "subtitle": "作业 j1" }
            ]
        }))
        .unwrap();
        assert_eq!(overview.revision, 7);
        assert!(overview.status_text.contains("revision 7"));
        assert_eq!(overview.items.len(), 1);
        assert_eq!(
            overview.items[0].action,
            crate::ui::settings::panels::RowAction::Select
        );
        assert_eq!(overview.jobs.len(), 1);
        assert_eq!(
            overview.jobs[0].action,
            crate::ui::settings::panels::RowAction::None
        );

        // 缺 revision / statusText：协议违规，如实报错（不补默认值）。
        assert!(parse_memory_overview(&json!({ "statusText": "x" })).is_err());
        assert!(parse_memory_overview(&json!({ "revision": 1 })).is_err());
        // 缺 items/jobs 按空数组（读取时机差异，不是协议违规）。
        let sparse = parse_memory_overview(&json!({ "revision": 1, "statusText": "x" })).unwrap();
        assert!(sparse.items.is_empty() && sparse.jobs.is_empty());
    }

    #[test]
    fn 记忆详情解析包含版本与历史行() {
        let detail = parse_memory_detail(&json!({
            "revision": 9,
            "itemId": "m1",
            "version": 3,
            "pinned": true,
            "info": "类型：fact",
            "content": "喜欢猫",
            "history": [
                { "id": "m1:1", "title": "v1 · superseded", "subtitle": "旧内容" }
            ]
        }))
        .unwrap();
        assert_eq!(detail.item_id, "m1");
        assert_eq!(detail.revision, 9);
        assert_eq!(detail.version, 3);
        assert!(detail.pinned);
        assert_eq!(detail.history.len(), 1);
        assert_eq!(detail.history[0].id, "m1:1");

        // 缺 itemId/version：协议违规如实报错。
        assert!(parse_memory_detail(&json!({ "revision": 1, "version": 1 })).is_err());
        assert!(parse_memory_detail(&json!({ "revision": 1, "itemId": "m1" })).is_err());

        // 缺 pinned/info/content：协议违规，如实报错并点名字段（不按 false/空串兜底）。
        let full = json!({
            "revision": 9,
            "itemId": "m1",
            "version": 3,
            "pinned": true,
            "info": "类型：fact",
            "content": "喜欢猫",
        });
        for missing in ["pinned", "info", "content"] {
            let mut broken = full.clone();
            broken.as_object_mut().unwrap().remove(missing);
            let error = parse_memory_detail(&broken).unwrap_err();
            assert_missing_field(error, missing);
        }
    }
}
