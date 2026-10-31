//! `SettingsPort` 的宿主实现（经 [`HostLink`](super::HostLink) 与 Node 收发）。
//!
//! 配置真相源与写入口在 Node（见 `super` 的文件头）；本文件只做请求/回执翻译，
//! 回执解析在 `super::parse`。

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::parse::{
    card_id_args, parse_card_options, parse_card_stages, parse_mcp_server_form,
    parse_memory_detail, parse_memory_overview, parse_profile_options, parse_saved_path,
    required_text, settings_value_to_json,
};
// `parse_settings_snapshot` 走 `super` 的 re-export：平台层测试（macos_settings）也经
// `crate::ui::ports::parse_settings_snapshot` 取用它，保留单一取用路径。
use super::{parse_settings_snapshot, HostLink, HOST_REQUEST_TIMEOUT, USER_INTERACTION_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::ui::settings::panels::{
    self, McpServerForm, McpServerSave, MemoryChange, MemoryDetail, MemoryOverview, PanelRow,
    SkillCatalog,
};
use crate::ui::settings::{
    self, CardManageOp, CardManageOutcome, CardOption, CardStages, CardVariablePool,
    MemoryMaintenanceOp, ProfileManageOp, ProfileManageOutcome, SettingEdit, SettingsPort,
    SettingsSnapshot, SoundLibrary,
};

// ==========================================
// SettingsPort 实现（经 HostLink 收发）
// ==========================================

/// 设置端口：读 = `settings_read`、写 = `settings_commit`（Node 侧走既有原子保存路径）。
pub struct SettingsPortImpl {
    link: Arc<HostLink>,
}

impl SettingsPortImpl {
    pub fn new(link: Arc<HostLink>) -> Self {
        Self { link }
    }
}

impl SettingsPort for SettingsPortImpl {
    fn fetch(&self) -> AppResult<SettingsSnapshot> {
        let value = self
            .link
            .request("settings_read", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_settings_snapshot(&value)
    }

    fn commit(&self, changes: &[SettingEdit]) -> AppResult<()> {
        let mut wire_changes = Vec::with_capacity(changes.len());
        for edit in changes {
            wire_changes.push(json!({
                "key": edit.key,
                "value": settings_value_to_json(&edit.value)?,
            }));
        }
        self.link.request(
            "settings_commit",
            json!({ "changes": wire_changes }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn cards(&self) -> AppResult<Vec<CardOption>> {
        let value = self
            .link
            .request("personality_cards", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_card_options(&value)
    }

    fn profiles(&self) -> AppResult<Vec<crate::ui::settings::ProfileOption>> {
        let value = self
            .link
            .request("profile_list", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_profile_options(&value)
    }

    fn check_update(&self) -> AppResult<()> {
        settings::updates::check_interactive(true)
    }

    // ── 管理面（W9d）：工具页 ──

    fn mcp_servers(&self) -> AppResult<Vec<PanelRow>> {
        let value = self
            .link
            .request("tools_mcp_servers", json!({}), HOST_REQUEST_TIMEOUT)?;
        panels::parse_rows_field(&value)
    }

    fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> AppResult<()> {
        self.link.request(
            "tools_mcp_toggle",
            json!({ "id": name, "enabled": enabled }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_credential_set(&self, row_id: &str, value: &str) -> AppResult<()> {
        // 值经这条请求定向送到 Node（→ 宿主 `mcp_credential_set`）：不回显、不落 CONFIG；
        // 本层不写日志（凭据值不得进任何日志）。
        self.link.request(
            "mcp_credential_write",
            json!({ "id": row_id, "value": value }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn skills(&self) -> AppResult<SkillCatalog> {
        let value = self
            .link
            .request("tools_skills", json!({}), HOST_REQUEST_TIMEOUT)?;
        let rows = panels::parse_rows_field(&value)?;
        Ok(SkillCatalog {
            rows,
            index_error: value
                .get("indexError")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }

    fn set_skill_enabled(&self, relative_path: &str, enabled: bool) -> AppResult<()> {
        self.link.request(
            "tools_skill_toggle",
            json!({ "id": relative_path, "enabled": enabled }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn tool_policies(&self) -> AppResult<Vec<PanelRow>> {
        let value = self
            .link
            .request("tools_tool_policies", json!({}), HOST_REQUEST_TIMEOUT)?;
        panels::parse_rows_field(&value)
    }

    // ── 管理面（W9d）：记忆页 ──

    fn memory_overview(
        &self,
        scope: Option<&str>,
        scope_id: Option<&str>,
    ) -> AppResult<MemoryOverview> {
        let mut args = serde_json::Map::new();
        if let Some(scope) = scope {
            args.insert("scope".into(), Value::String(scope.to_string()));
        }
        if let Some(scope_id) = scope_id {
            args.insert("scopeId".into(), Value::String(scope_id.to_string()));
        }
        let value =
            self.link
                .request("memory_overview", Value::Object(args), HOST_REQUEST_TIMEOUT)?;
        parse_memory_overview(&value)
    }

    fn memory_item_detail(&self, id: &str) -> AppResult<MemoryDetail> {
        let value = self.link.request(
            "memory_item_detail",
            json!({ "id": id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        parse_memory_detail(&value)
    }

    fn memory_change(&self, change: &MemoryChange) -> AppResult<i64> {
        let mut args = json!({
            "action": change.action.as_wire(),
            "itemId": change.item_id,
            "expectedVersion": change.expected_version,
            "baseRevision": change.base_revision,
        });
        let object = args
            .as_object_mut()
            .ok_or_else(|| AppError::Other("记忆变更载荷构造失败".into()))?;
        if let Some(content) = &change.content {
            object.insert("content".into(), Value::String(content.clone()));
        }
        if let Some(pinned) = change.pinned {
            object.insert("pinned".into(), Value::Bool(pinned));
        }
        let value = self
            .link
            .request("memory_item_change", args, HOST_REQUEST_TIMEOUT)?;
        value
            .get("revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::Config("memory_item_change 回执缺少 revision".into()))
    }

    // ── 本批管理面（通用 / AI / 外观 / 工具 / 记忆）──

    fn defaults(&self) -> AppResult<SettingsSnapshot> {
        let value = self
            .link
            .request("settings_defaults", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_settings_snapshot(&value)
    }

    fn export_config(&self) -> AppResult<Option<String>> {
        // 含原生保存对话框：等待上限按用户尺度（见 USER_INTERACTION_TIMEOUT）。
        let value = self
            .link
            .request("config_export", json!({}), USER_INTERACTION_TIMEOUT)?;
        parse_saved_path(&value, "config_export")
    }

    fn import_config(&self) -> AppResult<bool> {
        let value = self
            .link
            .request("config_import", json!({}), USER_INTERACTION_TIMEOUT)?;
        Ok(value
            .get("imported")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("config_import 回执缺少 imported".into()))?)
    }

    fn v1rtual_read(&self) -> AppResult<String> {
        let value = self
            .link
            .request("v1rtual_read", json!({}), HOST_REQUEST_TIMEOUT)?;
        required_text(&value, "content", "v1rtual_read")
    }

    fn v1rtual_write(&self, content: &str) -> AppResult<()> {
        self.link.request(
            "v1rtual_write",
            json!({ "content": content }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn card_stages_read(&self, card_id: Option<&str>) -> AppResult<CardStages> {
        let value = self.link.request(
            "card_stages_read",
            card_id_args(card_id),
            USER_INTERACTION_TIMEOUT,
        )?;
        parse_card_stages(&value)
    }

    fn card_stages_write(&self, card_id: Option<&str>, text: &str) -> AppResult<()> {
        let mut args = card_id_args(card_id);
        args["text"] = Value::String(text.to_string());
        self.link
            .request("card_stages_write", args, USER_INTERACTION_TIMEOUT)?;
        Ok(())
    }

    fn card_stages_regenerate(&self, card_id: Option<&str>) -> AppResult<CardStages> {
        // 生成含模型调用：等待上限按用户尺度。
        let value = self.link.request(
            "card_stages_regenerate",
            card_id_args(card_id),
            USER_INTERACTION_TIMEOUT,
        )?;
        parse_card_stages(&value)
    }

    fn card_variable_pool(&self, card_id: Option<&str>) -> AppResult<CardVariablePool> {
        let value = self.link.request(
            "card_variable_pool",
            card_id_args(card_id),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(CardVariablePool {
            card_id: value
                .get("cardId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            text: required_text(&value, "text", "card_variable_pool")?,
        })
    }

    fn card_manage(&self, op: &CardManageOp) -> AppResult<CardManageOutcome> {
        let (args, timeout) = match op {
            // 新建/重命名/删除只改文件：通用请求上限。
            CardManageOp::Create { name } => (
                json!({ "op": "create", "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            CardManageOp::Rename { card_id, name } => (
                json!({ "op": "rename", "cardId": card_id, "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            CardManageOp::Delete(id) => (
                json!({ "op": "delete", "cardId": id }),
                HOST_REQUEST_TIMEOUT,
            ),
            // 导出/导入含原生文件对话框：等待上限按用户尺度。
            CardManageOp::Export(id) => (
                json!({ "op": "export", "cardId": id }),
                USER_INTERACTION_TIMEOUT,
            ),
            CardManageOp::Import => (json!({ "op": "import" }), USER_INTERACTION_TIMEOUT),
        };
        let value = self.link.request("card_manage", args, timeout)?;
        let cards = value
            .pointer("/list/cards")
            .ok_or_else(|| AppError::Config("card_manage 回执缺少 list.cards".into()))?;
        Ok(CardManageOutcome {
            message: required_text(&value, "message", "card_manage")?,
            cards: parse_card_options(&json!({ "cards": cards }))?,
        })
    }

    fn card_markdown_read(&self, card_id: Option<&str>) -> AppResult<String> {
        let value = self.link.request(
            "card_markdown_read",
            card_id_args(card_id),
            HOST_REQUEST_TIMEOUT,
        )?;
        required_text(&value, "text", "card_markdown_read")
    }

    fn card_markdown_write(&self, card_id: Option<&str>, text: &str) -> AppResult<()> {
        let mut args = card_id_args(card_id);
        args["text"] = Value::String(text.to_string());
        // 与 card_stages_write 同口径：都是保存文档，等待上限按用户尺度。
        self.link
            .request("card_markdown_write", args, USER_INTERACTION_TIMEOUT)?;
        Ok(())
    }

    fn card_template(&self) -> AppResult<String> {
        let value = self
            .link
            .request("card_template", json!({}), HOST_REQUEST_TIMEOUT)?;
        required_text(&value, "text", "card_template")
    }

    fn profile_manage(&self, op: &ProfileManageOp) -> AppResult<ProfileManageOutcome> {
        let (args, timeout) = match op {
            // 新建/重命名不经原生文件对话框：通用请求上限。
            ProfileManageOp::Create => (json!({ "op": "create" }), HOST_REQUEST_TIMEOUT),
            ProfileManageOp::Rename { profile_id, name } => (
                json!({ "op": "rename", "profileId": profile_id, "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            ProfileManageOp::Delete(id) => (
                json!({ "op": "delete", "profileId": id }),
                HOST_REQUEST_TIMEOUT,
            ),
            // 导出/导入含原生文件对话框：等待上限按用户尺度。
            ProfileManageOp::Export(id) => (
                json!({ "op": "export", "profileId": id }),
                USER_INTERACTION_TIMEOUT,
            ),
            ProfileManageOp::Import => (json!({ "op": "import" }), USER_INTERACTION_TIMEOUT),
            // 恢复默认资源要写回整棵资源树：给宽松上限，避免半途假超时。
            ProfileManageOp::RestoreDefaults => (
                json!({ "op": "restore_defaults" }),
                USER_INTERACTION_TIMEOUT,
            ),
        };
        let value = self.link.request("profile_manage", args, timeout)?;
        let profiles = value
            .pointer("/list/profiles")
            .ok_or_else(|| AppError::Config("profile_manage 回执缺少 list.profiles".into()))?;
        Ok(ProfileManageOutcome {
            message: required_text(&value, "message", "profile_manage")?,
            profiles: parse_profile_options(&json!({ "profiles": profiles }))?,
        })
    }

    fn sound_library(&self) -> AppResult<SoundLibrary> {
        let value = self
            .link
            .request("sound_library", json!({}), HOST_REQUEST_TIMEOUT)?;
        Ok(SoundLibrary {
            // rows 缺省 = 无事件行（协议上不是违规：事件清单是代码登记，空表如实呈现）。
            rows: match value.get("rows") {
                Some(rows) => panels::parse_rows(rows)?,
                None => Vec::new(),
            },
        })
    }

    fn sound_set_assignment(&self, event: &str, sound_id: &str) -> AppResult<()> {
        self.link.request(
            "sound_set_assignment",
            json!({ "event": event, "soundId": sound_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn sound_reset(&self) -> AppResult<()> {
        self.link
            .request("sound_reset", json!({}), HOST_REQUEST_TIMEOUT)?;
        Ok(())
    }

    fn sound_preview(&self, sound_id: &str) -> AppResult<()> {
        self.link.request(
            "sound_preview",
            json!({ "soundId": sound_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_server_form(&self, name: Option<&str>) -> AppResult<McpServerForm> {
        let args = match name {
            Some(name) => json!({ "name": name }),
            None => json!({ "name": Value::Null }),
        };
        let value = self
            .link
            .request("mcp_server_form", args, HOST_REQUEST_TIMEOUT)?;
        parse_mcp_server_form(&value)
    }

    fn mcp_save(&self, save: &McpServerSave) -> AppResult<()> {
        self.link.request(
            "mcp_save",
            json!({
                "originalName": save.original_name,
                "name": save.name,
                "transport": save.transport.as_wire(),
                "command": save.command,
                "args": save.args,
                "url": save.url,
                "env": save.env,
                "headers": save.headers,
                "enabled": save.enabled,
            }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_delete(&self, name: &str) -> AppResult<()> {
        self.link
            .request("mcp_delete", json!({ "name": name }), HOST_REQUEST_TIMEOUT)?;
        Ok(())
    }

    fn mcp_test(&self, name: &str) -> AppResult<(bool, String)> {
        // 真实连接可能等待子进程启动/握手：给 60s 上限（仍远离默认 10s）。
        let value =
            self.link
                .request("mcp_test", json!({ "name": name }), Duration::from_secs(60))?;
        Ok((
            // 缺 ok 不按「未成功」静默收场：测试结论的每个字段都是结果本身，
            // 缺失是协议违规，如实报错（Node 的 result 类型是 { ok, message } 全必填）。
            value
                .get("ok")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::Config("mcp_test 回执缺少 ok".into()))?,
            required_text(&value, "message", "mcp_test")?,
        ))
    }

    fn mcp_import(&self) -> AppResult<(u32, bool)> {
        let value = self
            .link
            .request("mcp_import", json!({}), USER_INTERACTION_TIMEOUT)?;
        // 取消与「导入 0 条」是两种结果，两字段都必须显式给出：缺 imported 静默按 0
        // 会与取消混淆，缺 canceled 静默按 false 会把取消说成导入成功。
        let imported = value
            .get("imported")
            .and_then(Value::as_u64)
            .ok_or_else(|| AppError::Config("mcp_import 回执缺少 imported".into()))?;
        let canceled = value
            .get("canceled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("mcp_import 回执缺少 canceled".into()))?;
        Ok((imported as u32, canceled))
    }

    fn mcp_export(&self) -> AppResult<Option<String>> {
        let value = self
            .link
            .request("mcp_export", json!({}), USER_INTERACTION_TIMEOUT)?;
        parse_saved_path(&value, "mcp_export")
    }

    fn skill_upload(&self) -> AppResult<Option<String>> {
        let value = self
            .link
            .request("skill_upload", json!({}), USER_INTERACTION_TIMEOUT)?;
        match value.get("name") {
            // 显式 null = 用户取消（Node 的类型是 `string | null`，取消必发 null）。
            Some(Value::Null) => Ok(None),
            Some(Value::String(name)) if !name.is_empty() => Ok(Some(name.clone())),
            // 缺 name 键 ≠ 取消：静默当取消会把协议违规吞成正常结果。
            None => Err(AppError::Config(
                "skill_upload 回执缺少 name（取消应显式发 null）".into(),
            )),
            Some(_) => Err(AppError::Config("skill_upload 回执的 name 形状非法".into())),
        }
    }

    fn skill_delete(&self, relative_path: &str) -> AppResult<()> {
        self.link.request(
            "skill_delete",
            json!({ "id": relative_path }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn memory_source_evidence(&self, source_id: &str) -> AppResult<String> {
        let value = self.link.request(
            "memory_source_evidence",
            json!({ "sourceId": source_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        let info = required_text(&value, "info", "memory_source_evidence")?;
        // 缺 evidence 不当作「空证据」：空串是 Node 显式发来的事实（证据确实为空），
        // 缺字段是协议违规 —— 两者在界面上必须可区分。
        let evidence = value
            .get("evidence")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("memory_source_evidence 回执缺少 evidence".into()))?
            .to_string();
        // original 的三态必须分开：显式 null 是「确实没有原话」这一事实（Node 的
        // 类型是 `string | null`，读取失败或条目已回收时发 null），缺键是协议违规 ——
        // 旧实现把两者混同成「原话已不可用」，坏回执会被伪装成正常的不可用结论。
        let original = match value.get("original") {
            Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text),
            Some(_) => {
                return Err(AppError::Config(
                    "memory_source_evidence 回执的 original 形状非法（应为 string 或 null）".into(),
                ))
            }
            None => {
                return Err(AppError::Config(
                    "memory_source_evidence 回执缺少 original（不可用时应显式发 null）".into(),
                ))
            }
        };
        Ok(format!(
            "【来源 {source_id}】\n{info}\n\n登记时的有界证据：\n{}\n\n会话原话：\n{}",
            if evidence.is_empty() {
                "（空）"
            } else {
                &evidence
            },
            match original {
                Some(text) => text.to_string(),
                None => "（原话已不可用：会话条目已回收或不再满足可信来源判定）".to_string(),
            }
        ))
    }

    fn memory_dreaming_sweep(&self) -> AppResult<String> {
        // 手动整理含模型调用（可能分钟级）：等待上限按用户尺度。
        let value =
            self.link
                .request("memory_dreaming_sweep", json!({}), USER_INTERACTION_TIMEOUT)?;
        required_text(&value, "message", "memory_dreaming_sweep")
    }

    fn silent_understanding_run_now(&self) -> AppResult<String> {
        // 手动了解含截图/读取与模型调用：等待上限按用户尺度。
        let value = self.link.request(
            "silent_understanding_run_now",
            json!({}),
            USER_INTERACTION_TIMEOUT,
        )?;
        required_text(&value, "message", "silent_understanding_run_now")
    }

    fn memory_maintenance(&self, op: MemoryMaintenanceOp) -> AppResult<String> {
        let op = match op {
            MemoryMaintenanceOp::Backup => "backup",
            MemoryMaintenanceOp::Export => "export",
            MemoryMaintenanceOp::RebuildIndex => "rebuild_index",
        };
        // 备份/重建是数据库级 IO：给宽松上限（不选对话框，故不用用户交互档）。
        let value = self.link.request(
            "memory_maintenance",
            json!({ "op": op }),
            Duration::from_secs(120),
        )?;
        required_text(&value, "message", "memory_maintenance")
    }

    fn memory_backup_list(&self) -> AppResult<Vec<PanelRow>> {
        let value =
            self.link
                .request("memory_backup_list", json!({}), HOST_REQUEST_TIMEOUT)?;
        // 行由 Node 投影（id = 备份绝对路径，title/subtitle = 时间/名称与大小）。
        panels::parse_rows_field(&value)
    }

    fn memory_restore(&self, preview_only: bool, backup_path: &str) -> AppResult<String> {
        let value = self.link.request(
            "memory_restore",
            json!({
                "op": if preview_only { "preview" } else { "apply" },
                // 作用对象 = 备份列表里选中的那一份（不再由 Node 隐式取「最新」）。
                "backupPath": backup_path,
            }),
            Duration::from_secs(120),
        )?;
        required_text(&value, "message", "memory_restore")
    }

    fn memory_job_cancel(&self, job_id: &str) -> AppResult<String> {
        let value = self.link.request(
            "memory_job_cancel",
            json!({ "jobId": job_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        required_text(&value, "message", "memory_job_cancel")
    }

    fn memory_job_resume(&self, job_id: &str) -> AppResult<String> {
        // 继续 = 恢复 review 作业并跑到收口（含模型调用，可能分钟级）：等待上限按用户尺度。
        let value = self.link.request(
            "memory_job_resume",
            json!({ "jobId": job_id }),
            USER_INTERACTION_TIMEOUT,
        )?;
        required_text(&value, "message", "memory_job_resume")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::ports::test_support::*;
    use crate::ui::settings::panels::McpTransport;
    use crate::ui::settings::SettingsValue;

    #[test]
    fn 设置端口提交形状与回执透出() {
        let link = Arc::new(HostLink::new());
        let port = SettingsPortImpl::new(link);
        // 未接线：如实失败，不伪造成功。
        assert!(port.fetch().is_err());
        assert!(port
            .commit(&[SettingEdit {
                key: "appearance.font.size".into(),
                value: SettingsValue::Number(16.0),
            }])
            .is_err());
        assert!(port.cards().is_err());
    }

    #[test]
    fn 管理面端口未接线时如实报错() {
        let port = SettingsPortImpl::new(Arc::new(HostLink::new()));
        assert!(port.profiles().is_err());
        assert!(port.mcp_servers().is_err());
        assert!(port.set_mcp_server_enabled("filesystem", true).is_err());
        assert!(port.skills().is_err());
        assert!(port.set_skill_enabled("demo", false).is_err());
        assert!(port.tool_policies().is_err());
        assert!(port.memory_overview(None, None).is_err());
        assert!(port.memory_item_detail("m1").is_err());
        assert!(port
            .memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Forget,
                item_id: "m1".into(),
                expected_version: 1,
                base_revision: 1,
                content: None,
                pinned: None,
            })
            .is_err());
    }

    #[test]
    fn 记忆变更载荷带可选字段且回执解析新版() {
        let (link, published, _) = test_link();
        let port = SettingsPortImpl::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Update,
                item_id: "m1".into(),
                expected_version: 2,
                base_revision: 5,
                content: Some("新内容".into()),
                pinned: Some(false),
            })
        });
        let (request_id, method, args) = wait_last_request(&published);
        assert_eq!(method, "memory_item_change");
        assert_eq!(args["action"], json!("update"));
        assert_eq!(args["itemId"], json!("m1"));
        assert_eq!(args["expectedVersion"], json!(2));
        assert_eq!(args["baseRevision"], json!(5));
        assert_eq!(args["content"], json!("新内容"));
        assert_eq!(args["pinned"], json!(false));
        assert!(link.complete(request_id, Ok(json!({ "revision": 11 }))));
        assert_eq!(waiting.join().unwrap().unwrap(), 11);

        // 缺 revision 的回执按协议违规报错，不返回假版本号。
        let (link, published, _) = test_link();
        let port = SettingsPortImpl::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Forget,
                item_id: "m1".into(),
                expected_version: 1,
                base_revision: 1,
                content: None,
                pinned: None,
            })
        });
        let (request_id, _, args) = wait_last_request(&published);
        assert_eq!(args["action"], json!("forget"));
        assert!(args.get("content").is_none(), "Forget 不带 content");
        assert!(link.complete(request_id, Ok(json!({}))));
        assert!(waiting.join().unwrap().is_err());
    }

    // ── 本批管理面（27 条 HostRequestMap 方法）的请求形状与回执解析 ──
    //
    // 方法名 + args 字段是宿主与 Node 两侧共用的线格式（TS `HostRequestMap`）：
    // 名字或字段写错不会报编译错，只会静默失联。因此每条的断言都把方法名与
    // args 全形状逐字钉死；回执侧对缺字段/类型不符如实报错（不静默兜底），
    // 远端错误保真透出（不吞、不伪造成功）。

    #[test]
    fn 通用页端口请求形状与回执解析() {
        let (link, published, _) = test_link();

        // settings_defaults：与 settings_read 同形（`{ values }`）。
        let snapshot = call_port(
            &link,
            &published,
            "settings_defaults",
            |link| SettingsPortImpl::new(link).defaults(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "values": { "appearance.chatImagePreview": true, "general.popup.chatWidth": 320 } })),
        )
        .unwrap();
        assert_eq!(
            snapshot.values.get("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(true))
        );
        assert_eq!(
            snapshot.values.get("general.popup.chatWidth"),
            Some(&SettingsValue::Number(320.0))
        );
        // 缺 values：协议违规如实报错，不返回空快照冒充「默认值全空」。
        assert!(call_port(
            &link,
            &published,
            "settings_defaults",
            |link| SettingsPortImpl::new(link).defaults(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // config_export：saved=false 是用户取消（Ok(None)），不是失败。
        let saved = call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true, "path": "/tmp/config-export.yaml" })),
        )
        .unwrap();
        assert_eq!(saved.as_deref(), Some("/tmp/config-export.yaml"));
        let canceled = call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": false, "path": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        // saved=true 但缺 path：协议违规，不返回假路径。
        assert!(call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true })),
        )
        .is_err());
        // 缺 saved：协议违规，不当取消也不当失败吞掉。
        assert!(call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // config_import：imported 必填布尔，类型不符如实报错。
        let imported = call_port(
            &link,
            &published,
            "config_import",
            |link| SettingsPortImpl::new(link).import_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": true })),
        )
        .unwrap();
        assert!(imported);
        assert!(call_port(
            &link,
            &published,
            "config_import",
            |link| SettingsPortImpl::new(link).import_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": "yes" })),
        )
        .is_err());
    }

    #[test]
    fn ai页文本与阶段文案端口请求形状() {
        let (link, published, _) = test_link();

        // v1rtual_read：content 必填；缺字段如实报错，不返回空指令。
        let content = call_port(
            &link,
            &published,
            "v1rtual_read",
            |link| SettingsPortImpl::new(link).v1rtual_read(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "content": "始终用中文回答" })),
        )
        .unwrap();
        assert_eq!(content, "始终用中文回答");
        assert!(call_port(
            &link,
            &published,
            "v1rtual_read",
            |link| SettingsPortImpl::new(link).v1rtual_read(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // v1rtual_write：全量文本回传。
        call_port(
            &link,
            &published,
            "v1rtual_write",
            |link| SettingsPortImpl::new(link).v1rtual_write("新的用户指令"),
            |args| assert_eq!(args, &json!({ "content": "新的用户指令" })),
            Ok(Value::Null),
        )
        .unwrap();

        // card_stages_read：cardId 缺省发 null；回执 cardId/text 必填。
        let stages = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": true, "text": "executing.thinking: 思考中…" })),
        )
        .unwrap();
        assert_eq!(stages.card_id, "yuki");
        assert!(stages.fallback);
        assert_eq!(stages.text, "executing.thinking: 思考中…");
        let stages = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(Some("angelkawaii")),
            |args| assert_eq!(args, &json!({ "cardId": "angelkawaii" })),
            Ok(json!({ "cardId": "angelkawaii", "fallback": false, "text": "x" })),
        )
        .unwrap();
        assert_eq!(stages.card_id, "angelkawaii");
        // 缺 text：协议违规，不返回空文案冒充成功。
        assert!(call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": true })),
        )
        .is_err());
        // 缺 fallback：协议违规，不按 false 把兜底文案冒充成 Card 文案。
        let error = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "text": "x" })),
        )
        .unwrap_err();
        assert_missing_field(error, "fallback");

        // card_stages_write：cardId + text；缺省卡发 null。
        call_port(
            &link,
            &published,
            "card_stages_write",
            |link| SettingsPortImpl::new(link).card_stages_write(Some("yuki"), "执行中: 思考中…"),
            |args| {
                assert_eq!(
                    args,
                    &json!({ "cardId": "yuki", "text": "执行中: 思考中…" })
                )
            },
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "card_stages_write",
            |link| SettingsPortImpl::new(link).card_stages_write(None, "x"),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null, "text": "x" })),
            Ok(Value::Null),
        )
        .unwrap();

        // card_stages_regenerate：与读取同参；回执按同一解析。
        let regenerated = call_port(
            &link,
            &published,
            "card_stages_regenerate",
            |link| SettingsPortImpl::new(link).card_stages_regenerate(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": false, "text": "新生成的文案" })),
        )
        .unwrap();
        assert_eq!(regenerated.text, "新生成的文案");
        assert!(!regenerated.fallback);
    }

    #[test]
    fn 变量池与记忆总览范围参数形状() {
        let (link, published, _) = test_link();

        // card_variable_pool：cardId 缺省发 null；回执 cardId 可空、text 必填。
        let pool = call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": Value::Null, "text": "mood: 开心\nenergy: 0.8" })),
        )
        .unwrap();
        assert_eq!(pool.card_id, None);
        assert!(pool.text.contains("mood: 开心"));
        let pool = call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(Some("yuki")),
            |args| assert_eq!(args, &json!({ "cardId": "yuki" })),
            Ok(json!({ "cardId": "yuki", "text": "x" })),
        )
        .unwrap();
        assert_eq!(pool.card_id.as_deref(), Some("yuki"));
        // 缺 text：协议违规，不返回空预览。
        assert!(call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(Some("yuki")),
            |args| assert_eq!(args, &json!({ "cardId": "yuki" })),
            Ok(json!({ "cardId": "yuki" })),
        )
        .is_err());

        // memory_overview 的 scope 透传：两键都传 / 只传 scope / 都不传（空对象）。
        let overview = call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(Some("session"), Some("session-1")),
            |args| assert_eq!(args, &json!({ "scope": "session", "scopeId": "session-1" })),
            Ok(json!({ "revision": 3, "statusText": "库版本 revision 3" })),
        )
        .unwrap();
        assert_eq!(overview.revision, 3);
        call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(Some("user"), None),
            |args| {
                assert_eq!(args.get("scope").and_then(Value::as_str), Some("user"));
                assert!(args.get("scopeId").is_none(), "scope_id 缺省时不发键");
            },
            Ok(json!({ "revision": 1, "statusText": "x" })),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(None, None),
            |args| assert_eq!(args, &json!({}), "不筛选时发空参数对象"),
            Ok(json!({ "revision": 1, "statusText": "x" })),
        )
        .unwrap();
    }

    #[test]
    fn profile管理动作逐条线格式() {
        let (link, published, _) = test_link();
        let outcome_reply = json!({
            "message": "已新建 新 Profile 1",
            "list": {
                "active": "sugar-pink",
                "profiles": [{ "id": "sugar-pink", "name": "Sugar Pink", "description": "粉糖" }]
            }
        });

        // 新建：不带 profileId；回执的列表进 Outcome（宿主据此刷新下拉选项）。
        let outcome = call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Create),
            |args| {
                assert_eq!(args, &json!({ "op": "create" }));
                assert!(args.get("profileId").is_none(), "create 不带 profileId");
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        assert_eq!(outcome.message, "已新建 新 Profile 1");
        assert_eq!(outcome.profiles.len(), 1);
        assert_eq!(outcome.profiles[0].id, "sugar-pink");

        // 重命名：id + 名字逐字上线。
        let renamed = call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Rename {
                    profile_id: "sugar-pink".into(),
                    name: "小雨".into(),
                })
            },
            |args| {
                assert_eq!(
                    args,
                    &json!({ "op": "rename", "profileId": "sugar-pink", "name": "小雨" })
                )
            },
            Ok(json!({
                "message": "已重命名为 小雨",
                "list": { "active": "sugar-pink", "profiles": [] }
            })),
        )
        .unwrap();
        assert_eq!(renamed.message, "已重命名为 小雨");

        call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Delete("other".into()))
            },
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Export("other".into()))
            },
            |args| assert_eq!(args, &json!({ "op": "export", "profileId": "other" })),
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        // export 的文件对话框等待上限在 USER_INTERACTION_TIMEOUT（形状之外的行为，
        // 这里只能钉形状；上限本身由常量消费点保证）。
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Import),
            |args| {
                assert_eq!(args, &json!({ "op": "import" }));
                assert!(args.get("profileId").is_none(), "import 不带 profileId");
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::RestoreDefaults),
            |args| {
                assert_eq!(args, &json!({ "op": "restore_defaults" }));
                assert!(
                    args.get("profileId").is_none(),
                    "restore_defaults 不带 profileId"
                );
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();

        // 缺 list.profiles：协议违规，不返回空列表冒充「没有 Profile」。
        assert!(call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link)
                .profile_manage(&ProfileManageOp::Delete("other".into())),
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(json!({ "message": "已删除" })),
        )
        .is_err());
        // 缺 message：协议违规。
        assert!(call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link)
                .profile_manage(&ProfileManageOp::Delete("other".into())),
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(json!({ "list": { "active": Value::Null, "profiles": [] } })),
        )
        .is_err());
    }

    #[test]
    fn 音效端口请求形状() {
        let (link, published, _) = test_link();

        // sound_library：rows 承载逐事件下拉（选项 + 选中值）；rows 缺省 = 无事件行。
        let library = call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({
                "rows": [{
                    "id": "welcome",
                    "title": "欢迎",
                    "action": "pick",
                    "action2": "preview",
                    "pick": {
                        "options": [
                            { "value": "none", "label": "静音" },
                            { "value": "chime", "label": "铃声" }
                        ],
                        "selected": "chime"
                    }
                }]
            })),
        )
        .unwrap();
        assert_eq!(library.rows.len(), 1);
        assert_eq!(
            library.rows[0].action,
            crate::ui::settings::panels::RowAction::Pick
        );
        assert_eq!(
            library.rows[0].secondary,
            crate::ui::settings::panels::RowAction::Preview
        );
        assert_eq!(library.rows[0].pick.as_ref().unwrap().selected, "chime");
        let bare = call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .unwrap();
        assert!(bare.rows.is_empty());
        // pick 动作缺 pick 载荷：协议违规（画不出可点的下拉）。
        assert!(call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "rows": [{ "id": "welcome", "title": "欢迎", "action": "pick" }] })),
        )
        .is_err());

        // sound_set_assignment / sound_reset / sound_preview：单事件写回、恢复默认、单条试听。
        call_port(
            &link,
            &published,
            "sound_set_assignment",
            |link| SettingsPortImpl::new(link).sound_set_assignment("welcome", "none"),
            |args| assert_eq!(args, &json!({ "event": "welcome", "soundId": "none" })),
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "sound_reset",
            |link| SettingsPortImpl::new(link).sound_reset(),
            |args| assert_eq!(args, &json!({})),
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "sound_preview",
            |link| SettingsPortImpl::new(link).sound_preview("chime"),
            |args| assert_eq!(args, &json!({ "soundId": "chime" })),
            Ok(Value::Null),
        )
        .unwrap();
    }

    #[test]
    fn mcp编辑与测试端口请求形状() {
        let (link, published, _) = test_link();

        // mcp_server_form：name 缺省发 null（新建模板）；回执逐字段解析。
        let form = call_port(
            &link,
            &published,
            "mcp_server_form",
            |link| SettingsPortImpl::new(link).mcp_server_form(None),
            |args| assert_eq!(args, &json!({ "name": Value::Null })),
            Ok(json!({
                "name": "", "transport": "stdio", "command": "npx", "args": "-y\npkg",
                "url": "", "env": "KEY=1", "headers": "", "enabled": true
            })),
        )
        .unwrap();
        assert_eq!(form.name, "");
        assert_eq!(form.transport, McpTransport::Stdio);
        assert_eq!(form.args, "-y\npkg");
        assert_eq!(form.env, "KEY=1");
        assert!(form.enabled);
        let form = call_port(
            &link,
            &published,
            "mcp_server_form",
            |link| SettingsPortImpl::new(link).mcp_server_form(Some("filesystem")),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({
                "name": "filesystem", "transport": "http", "command": "", "args": "",
                "url": "https://example.com/mcp", "env": "", "headers": "A=b", "enabled": false
            })),
        )
        .unwrap();
        assert_eq!(form.transport, McpTransport::Http);
        assert!(!form.enabled);
        // 缺字段 / 非法 transport：协议违规，如实报错（不静默收拢成 stdio 或空表单）。
        let error = call_port(
            &link,
            &published,
            "mcp_server_form",
            |link| SettingsPortImpl::new(link).mcp_server_form(Some("filesystem")),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({})),
        )
        .unwrap_err();
        assert_missing_field(error, "transport");
        let error = call_port(
            &link,
            &published,
            "mcp_server_form",
            |link| SettingsPortImpl::new(link).mcp_server_form(Some("filesystem")),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({
                "name": "filesystem", "transport": "sse", "command": "", "args": "",
                "url": "", "env": "", "headers": "", "enabled": true
            })),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("transport"),
            "非法 transport 的错误要点名字段: {error}"
        );

        // mcp_save：表单字段 + originalName 逐字段上线；mcp_delete：按名删除。
        // （保存载荷在闭包内组装：`call_port` 要求 'static，借用外层变量过不了。）
        call_port(
            &link,
            &published,
            "mcp_save",
            |link| {
                SettingsPortImpl::new(link).mcp_save(&McpServerSave {
                    original_name: "filesystem".to_string(),
                    name: "filesystem-2".to_string(),
                    transport: McpTransport::Http,
                    command: String::new(),
                    args: "-y\npkg".to_string(),
                    url: "https://example.com/mcp".to_string(),
                    env: "TOKEN=1".to_string(),
                    headers: "".to_string(),
                    enabled: false,
                })
            },
            |args| {
                assert_eq!(
                    args,
                    &json!({
                        "originalName": "filesystem", "name": "filesystem-2", "transport": "http",
                        "command": "", "args": "-y\npkg", "url": "https://example.com/mcp",
                        "env": "TOKEN=1", "headers": "", "enabled": false
                    })
                )
            },
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "mcp_delete",
            |link| SettingsPortImpl::new(link).mcp_delete("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(Value::Null),
        )
        .unwrap();

        // mcp_test：连接失败是结果不是异常；缺 message / 缺 ok 都是协议违规，如实报错。
        let (ok, message) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("filesystem"),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({ "ok": true, "message": "连接成功，发现 3 个工具" })),
        )
        .unwrap();
        assert!(ok);
        assert_eq!(message, "连接成功，发现 3 个工具");
        let (failed, message) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": false, "message": "服务器处于关闭状态：启用后再测试" })),
        )
        .unwrap();
        assert!(!failed);
        assert!(message.contains("关闭状态"));
        let (ok, _) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": false, "message": "连接失败（原因未提供）" })),
        )
        .unwrap();
        assert!(!ok, "连接失败是结果，不谎报连接成功");
        // 缺 ok：协议违规（Node 的结果类型是 `{ ok, message }` 全必填），如实报错，
        // 不静默按「未成功」收场 —— 那会把坏回执吞成正常的失败结论。
        let error = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "message": "连接失败（原因未提供）" })),
        )
        .unwrap_err();
        assert_missing_field(error, "ok");
        assert!(call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": true })),
        )
        .is_err());
    }

    #[test]
    fn mcp导入导出与skill端口回执() {
        let (link, published, _) = test_link();

        // mcp_import：导入条数与取消分开报。
        let (count, canceled) = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 3, "canceled": false })),
        )
        .unwrap();
        assert_eq!(count, 3);
        assert!(!canceled);
        let (count, canceled) = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 0, "canceled": true })),
        )
        .unwrap();
        assert_eq!(count, 0);
        assert!(canceled, "取消必须与「导入 0 条」分开呈现");
        // 缺 imported：协议违规，不按 0 冒充「导入 0 条」。
        let error = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "canceled": false })),
        )
        .unwrap_err();
        assert_missing_field(error, "imported");
        // 缺 canceled：协议违规，不按 false 把取消吞成成功。
        let error = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 3 })),
        )
        .unwrap_err();
        assert_missing_field(error, "canceled");

        // mcp_export：saved/path 与 config_export 同一纪律。
        let path = call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true, "path": "/tmp/mcp-servers.json" })),
        )
        .unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/mcp-servers.json"));
        let canceled = call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": false, "path": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        assert!(call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true })),
        )
        .is_err());

        // skill_upload：非空 name = 成功；null = 取消；空串/非字符串 = 协议违规。
        let name = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": "demo-skill" })),
        )
        .unwrap();
        assert_eq!(name.as_deref(), Some("demo-skill"));
        let canceled = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        assert!(call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": "" })),
        )
        .is_err());
        assert!(call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": 42 })),
        )
        .is_err());
        // 缺 name 键：协议违规，不当作「用户取消」静默收场（取消必发显式 null）。
        let error = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .unwrap_err();
        assert_missing_field(error, "name");

        // skill_delete：域内相对路径原样回传。
        call_port(
            &link,
            &published,
            "skill_delete",
            |link| SettingsPortImpl::new(link).skill_delete("demo/SKILL.md"),
            |args| assert_eq!(args, &json!({ "id": "demo/SKILL.md" })),
            Ok(Value::Null),
        )
        .unwrap();
    }

    #[test]
    fn 记忆维护与来源回看端口请求形状() {
        let (link, published, _) = test_link();

        // memory_source_evidence：sourceId 必填；info 必填，evidence/original 组装成展示文本。
        let text = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({
                "sourceId": "s-1",
                "available": true,
                "info": "来源：user/trusted_user　资格：可记忆",
                "evidence": "登记时的有界证据",
                "original": "会话里的完整原话"
            })),
        )
        .unwrap();
        assert!(text.contains("【来源 s-1】"));
        assert!(text.contains("登记时的有界证据"));
        assert!(text.contains("会话里的完整原话"));
        // original=null：如实标注「原话已不可用」，不拿证据冒充原话。
        let text = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "", "original": Value::Null })),
        )
        .unwrap();
        assert!(text.contains("（空）"), "空证据如实标注");
        assert!(text.contains("原话已不可用"), "原话缺失如实标注");
        // 缺 info：协议违规。
        assert!(call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "evidence": "e" })),
        )
        .is_err());
        // 缺 evidence：协议违规；空串是显式事实（界面显示「（空）」），缺字段不是。
        let error = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "original": "原话" })),
        )
        .unwrap_err();
        assert_missing_field(error, "evidence");
        // 缺 original 键：协议违规（显式 null 才是「确实没有原话」这一事实），如实
        // 报错并点名字段 —— 旧实现把缺键与 null 混同成「原话已不可用」。
        let error = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "e" })),
        )
        .unwrap_err();
        assert_missing_field(error, "original");
        // original 形状非法（非 string/null）：同样报错，不静默当作不可用。
        assert!(call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "e", "original": 42 })),
        )
        .is_err());

        // memory_dreaming_sweep：手动整理入口；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "message": "整理完成：提交 2 条" })),
        )
        .unwrap();
        assert_eq!(message, "整理完成：提交 2 条");
        assert!(call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "path": Value::Null })),
        )
        .is_err());

        // memory_maintenance：三个 op 的线格式逐字钉死；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Backup),
            |args| assert_eq!(args, &json!({ "op": "backup" })),
            Ok(json!({ "message": "一致性备份已写入：/data/backups/a.sqlite3" })),
        )
        .unwrap();
        assert!(message.contains("一致性备份"));
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Export),
            |args| assert_eq!(args, &json!({ "op": "export" })),
            Ok(json!({ "message": "只读导出已写入" })),
        )
        .unwrap();
        assert_eq!(message, "只读导出已写入");
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| {
                SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::RebuildIndex)
            },
            |args| assert_eq!(args, &json!({ "op": "rebuild_index" })),
            Ok(json!({ "message": "索引已重建（revision 12）" })),
        )
        .unwrap();
        assert!(message.contains("revision 12"));
        assert!(call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Backup),
            |args| assert_eq!(args, &json!({ "op": "backup" })),
            Ok(json!({ "path": "/data/backups/a.sqlite3" })),
        )
        .is_err());

        // memory_backup_list：行由 Node 投影（id = 路径），缺 rows 如实报错。
        let rows = call_port(
            &link,
            &published,
            "memory_backup_list",
            |link| SettingsPortImpl::new(link).memory_backup_list(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "rows": [
                { "id": "/data/memory/backups/a.sqlite3", "title": "10-06 12:00", "subtitle": "a.sqlite3 · 2.0 MB", "action": "choose" }
            ] })),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "/data/memory/backups/a.sqlite3");
        assert_eq!(rows[0].action, crate::ui::settings::panels::RowAction::Choose);
        assert!(call_port(
            &link,
            &published,
            "memory_backup_list",
            |link| SettingsPortImpl::new(link).memory_backup_list(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "backups": [] })),
        )
        .is_err());

        // memory_job_cancel / memory_job_resume：jobId 必填；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_job_cancel",
            |link| SettingsPortImpl::new(link).memory_job_cancel("job-1"),
            |args| assert_eq!(args, &json!({ "jobId": "job-1" })),
            Ok(json!({ "message": "作业已取消" })),
        )
        .unwrap();
        assert_eq!(message, "作业已取消");
        assert!(call_port(
            &link,
            &published,
            "memory_job_cancel",
            |link| SettingsPortImpl::new(link).memory_job_cancel("job-1"),
            |args| assert_eq!(args, &json!({ "jobId": "job-1" })),
            Ok(json!({ "status": "cancelled" })),
        )
        .is_err());
        let message = call_port(
            &link,
            &published,
            "memory_job_resume",
            |link| SettingsPortImpl::new(link).memory_job_resume("job-2"),
            |args| assert_eq!(args, &json!({ "jobId": "job-2" })),
            Ok(json!({ "message": "作业已继续" })),
        )
        .unwrap();
        assert_eq!(message, "作业已继续");

        // memory_restore：preview/apply 两种线格式 + 选中路径逐字回传；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(true, "/data/memory/backups/a.sqlite3"),
            |args| {
                assert_eq!(
                    args,
                    &json!({ "op": "preview", "backupPath": "/data/memory/backups/a.sqlite3" })
                )
            },
            Ok(json!({ "message": "预检通过：3 张表可恢复" })),
        )
        .unwrap();
        assert!(message.contains("预检通过"));
        let message = call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(false, "/data/memory/backups/b.sqlite3"),
            |args| {
                assert_eq!(
                    args,
                    &json!({ "op": "apply", "backupPath": "/data/memory/backups/b.sqlite3" })
                )
            },
            Ok(json!({ "message": "恢复完成（revision 13）" })),
        )
        .unwrap();
        assert!(message.contains("恢复完成"));
        assert!(call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(true, "/data/memory/backups/a.sqlite3"),
            |args| assert!(args.get("backupPath").is_some()),
            Ok(json!({ "revision": 3 })),
        )
        .is_err());
    }

    #[test]
    fn 远端错误码与文案原样透出不吞() {
        let (link, published, _) = test_link();

        // 写方法失败：结构化 code/message 保真（丢码等于改语义）。
        let error = call_port(
            &link,
            &published,
            "v1rtual_write",
            |link| SettingsPortImpl::new(link).v1rtual_write("x"),
            |args| assert_eq!(args, &json!({ "content": "x" })),
            Err(AppError::Remote {
                code: "MEMORY_CONFLICT".into(),
                message: "版本冲突".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "MEMORY_CONFLICT");
        assert!(error.to_string().contains("版本冲突"));

        // 读方法失败同理：不折叠成空结果、不伪造成功。
        let error = call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Err(AppError::Remote {
                code: "OTHER".into(),
                message: "模型不可用".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "OTHER");
        assert!(error.to_string().contains("模型不可用"));
    }
}
