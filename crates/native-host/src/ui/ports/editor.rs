//! `EditorPort` 的宿主实现（经 [`HostLink`](super::HostLink) 与 Node 收发）。
//!
//! 读/写都走 Node 的既有 Profile 通路：本域不解析 `profile.yaml`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::parse::{join_profiles_path, required_f64};
use super::{HostLink, HOST_REQUEST_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::ui::editor::{EditorLayer, EditorPort, EditorProfile, EditorSave};

// ==========================================
// EditorPort 实现（经 HostLink 收发）
// ==========================================

/// 编辑器端口：读/写都经 Node 的既有 Profile 通路（本域不解析 Profile 文件）。
pub struct EditorPortImpl {
    link: Arc<HostLink>,
    /// `AppPaths.profiles` 的克隆（数据根唯一决定点，启动时取自 AppPaths）。
    profiles_root: PathBuf,
    /// 原生文件对话框（「换素材」与 `pick_profile_asset` 命令共用同一实现类型）。
    dialogs: Arc<dyn crate::host::FileDialogPort>,
}

impl EditorPortImpl {
    pub fn new(
        link: Arc<HostLink>,
        profiles_root: PathBuf,
        dialogs: Arc<dyn crate::host::FileDialogPort>,
    ) -> Self {
        Self {
            link,
            profiles_root,
            dialogs,
        }
    }
}

impl EditorPort for EditorPortImpl {
    fn load(&self) -> AppResult<EditorProfile> {
        let value = self
            .link
            .request("editor_load", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_editor_profile(&self.profiles_root, &value)
    }

    fn save(&self, save: &EditorSave) -> AppResult<()> {
        self.link.request(
            "editor_save",
            editor_save_payload(save),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn pick_asset(&self) -> AppResult<Option<String>> {
        // 与 `pick_profile_asset` 命令同一实现（`NativeFileDialog`，图片过滤器）：
        // 用户取消是正常结果 `Ok(None)`，不伪装成错误；UI 未启动时对话框实现如实报错。
        self.dialogs.pick_file()
    }
}

/// `editor_save` 的线载荷（抽成自由函数：这段是与 Node 的**形状契约**，必须可被
/// 单测直接盯住 —— 曾经在这里回传绝对路径，Node 的 `stripProfilePrefix` 失配后把
/// 绝对路径写进了 `profile.yaml`）。
fn editor_save_payload(save: &EditorSave) -> Value {
    let layers: Vec<Value> = save
        .layers
        .iter()
        .map(|layer| {
            json!({
                // 线格式路径（profiles 域内相对），与 `editor_load` 的出参形状对称。
                "path": layer.wire_path,
                // 换素材选中的外部来源：Node 据此复制进 Profile（入库）后才写 yaml；
                // 素材已在 Profile 内时为 null。
                "sourcePath": layer
                    .source_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
                "name": layer.name,
                "enabled": layer.enabled,
                "locked": layer.locked,
                "sensitivity": layer.sensitivity,
                "scale": layer.scale,
                "offsetXPercent": layer.offset_x_percent,
                "offsetYPercent": layer.offset_y_percent,
            })
        })
        .collect();
    json!({
        "profileId": save.profile_id,
        "layers": layers,
        "intensity": save.intensity,
        "effectEnabled": save.effect_enabled,
    })
}

fn parse_editor_profile(profiles_root: &Path, value: &Value) -> AppResult<EditorProfile> {
    let profile_id = value
        .get("profileId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 profileId".into()))?
        .to_string();
    // profileName 必填：Node 的类型是全必填，回落 profileId 会把「显示名丢了」的
    // 坏回执伪装成正常的 id 显示（与 parse_profile_options 的显示名回落不同 ——
    // 那里回落是 Node 类型本身允许的可选形状）。
    let profile_name = value
        .get("profileName")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 profileName".into()))?
        .to_string();
    let layers = value
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 layers".into()))?;
    let mut parsed = Vec::with_capacity(layers.len());
    for (index, layer) in layers.iter().enumerate() {
        let relative = layer
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // 空 path = 该层尚无素材（Profile 允许的空占位）：保持空路径，渲染器按
        // 禁用层跳过解码；非空路径经 profiles 域内相对路径校验后拼绝对路径。
        let path = if relative.is_empty() {
            PathBuf::new()
        } else {
            join_profiles_path(profiles_root, relative)?
        };
        parsed.push(EditorLayer {
            path,
            // 线格式路径原样留底：保存回传的是它，不是拼出来的绝对路径（见字段文档）。
            wire_path: relative.to_string(),
            // 载入的素材已在 Profile 内，无需入库复制。
            source_path: None,
            // name/enabled/locked 必填（Node 的 EditorLayerPayload 全必填）：缺字段
            // 静默按空串/false 兜底会让结点把坏回执当成「无名层」「禁用层」渲染。
            // 空串本身仍是合法值（空占位层：无素材即无名、disabled），只有缺键报错。
            name: layer
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Config(format!("editor_load 回执第 {index} 层缺少 name")))?
                .to_string(),
            enabled: layer
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    AppError::Config(format!("editor_load 回执第 {index} 层缺少 enabled"))
                })?,
            locked: layer
                .get("locked")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    AppError::Config(format!("editor_load 回执第 {index} 层缺少 locked"))
                })?,
            sensitivity: required_f64(layer, "sensitivity")?,
            scale: required_f64(layer, "scale")?,
            offset_x_percent: required_f64(layer, "offsetXPercent")?,
            offset_y_percent: required_f64(layer, "offsetYPercent")?,
        });
    }
    Ok(EditorProfile {
        profile_id,
        profile_name,
        layers: parsed,
        effect_enabled: value
            .get("effectEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("editor_load 回执缺少 effectEnabled".into()))?,
        intensity: required_f64(value, "intensity")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::ports::test_support::*;

    #[test]
    fn 编辑器端口载荷走域内相对路径() {
        let link = Arc::new(HostLink::new());
        let port = EditorPortImpl::new(
            link,
            test_profiles_root(),
            Arc::new(StubDialogs(Some("/tmp/asset.png"))),
        );
        // 按**生产形状**构造：`path` 是拼出来的绝对路径、`wire_path` 才是线格式。
        // （旧版本这里把 `path` 直接填成相对路径，于是"载荷走相对路径"的断言恒真，
        // 而生产上回传的是绝对路径 —— 测试绿、yaml 被写坏。）
        let input = crate::ui::editor::EditorLayer {
            path: test_profiles_root().join("sugar-pink/materials/L2/body.png"),
            wire_path: "sugar-pink/materials/L2/body.png".into(),
            source_path: None,
            name: "body.png".into(),
            enabled: true,
            locked: false,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 2.0,
            offset_y_percent: -3.0,
        };
        // 回归断言：载荷必须回传线格式路径，绝不回传绝对路径。
        let payload = editor_save_payload(&EditorSave {
            profile_id: "sugar-pink".into(),
            layers: vec![input.clone()],
            intensity: 1.2,
            effect_enabled: true,
        });
        let wire = payload["layers"][0]["path"].as_str().unwrap_or_default();
        assert_eq!(wire, "sugar-pink/materials/L2/body.png");
        assert_eq!(payload["layers"][0]["sourcePath"], Value::Null);
        assert!(
            !Path::new(wire).is_absolute(),
            "载荷 path 必须是 profiles 域内相对路径，不能是绝对路径"
        );
        // 未接线：请求如实失败。
        assert!(port
            .save(&EditorSave {
                profile_id: "sugar-pink".into(),
                layers: vec![input],
                intensity: 1.2,
                effect_enabled: true,
            })
            .is_err());
        // 换素材已接线到文件对话框：选中即透传绝对路径；取消是 Ok(None)，不是错误。
        assert_eq!(
            port.pick_asset().unwrap().as_deref(),
            Some("/tmp/asset.png")
        );
        let cancel = EditorPortImpl::new(
            Arc::new(HostLink::new()),
            test_profiles_root(),
            Arc::new(StubDialogs(None)),
        );
        assert_eq!(cancel.pick_asset().unwrap(), None);
    }

    #[test]
    fn 编辑器载入解析拼出绝对层路径() {
        let profiles_root = test_profiles_root();
        let value = json!({
            "profileId": "sugar-pink",
            "profileName": "Sugar Pink",
            "layers": [{
                "path": "sugar-pink/materials/L2/body.png",
                "name": "body.png",
                "enabled": true,
                "locked": false,
                "sensitivity": 0.8,
                "scale": 1.0,
                "offsetXPercent": 0.0,
                "offsetYPercent": 0.0
            }, {
                "path": "",
                "name": "",
                "enabled": false,
                "locked": false,
                "sensitivity": 1.2,
                "scale": 1.0,
                "offsetXPercent": 0.0,
                "offsetYPercent": 0.0
            }],
            "effectEnabled": false,
            "intensity": 0.5
        });
        let profile = parse_editor_profile(&profiles_root, &value).unwrap();
        assert_eq!(profile.profile_id, "sugar-pink");
        assert!(profile.layers[0]
            .path
            .ends_with("profiles/sugar-pink/materials/L2/body.png"));
        assert!(
            profile.layers[1].path.as_os_str().is_empty(),
            "空路径层保持空，交给禁用跳过"
        );
        assert!(!profile.effect_enabled);
        assert_eq!(profile.intensity, 0.5);

        // profileName / 图层 name/enabled/locked 缺键：协议违规，点名报错，不兜底成
        // id / 空串 / false（空串层名是合法事实，缺键不是）。
        let mut broken = value.clone();
        broken.as_object_mut().unwrap().remove("profileName");
        let error = parse_editor_profile(&profiles_root, &broken).unwrap_err();
        assert_missing_field(error, "profileName");
        for missing in ["name", "enabled", "locked"] {
            let mut broken = value.clone();
            broken["layers"][0].as_object_mut().unwrap().remove(missing);
            let error = parse_editor_profile(&profiles_root, &broken).unwrap_err();
            assert_missing_field(error, missing);
        }
    }
}
