//! 设置窗的行编辑文档：按目标加载/保存分发、文档标题与备份选择投影。
//!
//! T2.8 从 `settings/mod.rs` 原样搬运文档与备份相关代码（含 `SettingsUi` 的
//! 文档生命周期方法），行为不变；两个跨平台源码门禁（`include_str!` 平台源码）
//! 也留在本文件 —— 与 `settings/mod.rs` 同目录，`../platform/...` 路径在 P3/P4
//! 平台文件转目录前保持不变。

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use crate::error::{AppError, AppResult};
use crate::rust_warn;

use super::panels::{self, McpServerSave};
use super::*;

// ── 本批：行编辑文档的加载/保存分发（端口方法按目标裁定；文本格式由 Node 定义）──

/// 行编辑文档的标题（唯一实现点）。
///
/// 是 [`SettingsUi`] 的方法而不是自由函数：`CardMarkdown` 按 card_id 取显示名
/// （改名后标题跟着新名字走），名字来自人格卡选项缓存 —— 取不到回落 id，
/// 不猜、不补默认名。
impl SettingsUi {
    fn document_title(&self, target: &DocumentTarget) -> String {
        match target {
            DocumentTarget::V1rtual => "V1RTUAL.md 用户指令".to_string(),
            DocumentTarget::CardStages => "当前卡阶段文案".to_string(),
            DocumentTarget::CardMarkdown { card_id } => {
                let name = self.card_options().and_then(|options| {
                    options
                        .iter()
                        .find(|card| &card.id == card_id)
                        .map(|card| card.name.clone())
                });
                match name {
                    Some(name) => format!("Card：{name}"),
                    None => format!("Card：{card_id}"),
                }
            }
            DocumentTarget::CardTemplate => "Card 模版（只读）".to_string(),
            DocumentTarget::McpServer { name } if name.is_empty() => {
                "MCP 服务器（新建）".to_string()
            }
            DocumentTarget::McpServer { name } => format!("MCP 服务器：{name}"),
            DocumentTarget::VariablePool => "变量池预览（只读）".to_string(),
        }
    }
}

/// 备份列表的选中归宿（纯函数，可测）：
/// 选中的那份仍在列表里则保持；已被清理/换目录（找不到）或尚未选过时回退**第一份**
/// （Node 按 mtime 倒序投影，第一份 = 最新一份）；空列表返回 None（没有可操作对象）。
pub fn resolve_backup_selection(rows: &[PanelRow], selected: Option<&str>) -> Option<String> {
    let first = rows.first()?.id.clone();
    match selected {
        Some(id) if rows.iter().any(|row| row.id == id) => Some(id.to_string()),
        _ => Some(first),
    }
}

/// 备份列表的提示行（纯函数，可测）。
///
/// Rows 由 Node 投影、顺序即展示顺序（最新在前）；提示只报**当前选中的对象**
/// （预览/应用的作用对象），空列表给「还没有备份」的中性指引 —— 不谎称有可恢复内容。
pub fn memory_backup_hint(rows: &[PanelRow], selected: Option<&str>) -> String {
    let Some(resolved) = resolve_backup_selection(rows, selected) else {
        return "还没有可恢复的备份：点上方「备份现在」生成一份。".to_string();
    };
    let title = rows
        .iter()
        .find(|row| row.id == resolved)
        .map(|row| row.title.clone())
        .unwrap_or(resolved);
    format!("当前选中：{title}（点行可切换）。用上方「预览选中备份 / 应用选中备份」操作这一份。")
}
/// Card 模版面板的首行引导语。
///
/// 与模版正文分开定义：正文的唯一来源是运行时 `cards/_template.md`（用户可改、可被
/// 恢复默认资源覆盖），引导语是产品文案，两边的变更理由不同。面板显示什么就复制什么，
/// 所以引导语和正文在这里拼成同一段文本，不在平台层各拼一遍。
const CARD_TEMPLATE_INTRO: &str =
    "可复制下面的模版，扔给 AI 生成。可以说：参照下面的模版，生成一份《明日方舟》里黍的人格卡";

/// 按目标拉取文档内容（端口全部是既有请求面；本函数不解析文本）。
fn load_document(port: &dyn SettingsPort, target: &DocumentTarget) -> AppResult<DocumentContent> {
    match target {
        DocumentTarget::V1rtual => Ok(DocumentContent::Text(port.v1rtual_read()?)),
        DocumentTarget::CardStages => Ok(DocumentContent::Text(port.card_stages_read(None)?.text)),
        DocumentTarget::CardMarkdown { card_id } => {
            Ok(DocumentContent::Text(port.card_markdown_read(Some(card_id))?))
        }
        DocumentTarget::CardTemplate => Ok(DocumentContent::Text(format!(
            "{CARD_TEMPLATE_INTRO}\n\n{}",
            port.card_template()?
        ))),
        DocumentTarget::McpServer { name } => Ok(DocumentContent::McpForm(port.mcp_server_form(
            if name.is_empty() {
                None
            } else {
                Some(name.as_str())
            },
        )?)),
        DocumentTarget::VariablePool => Ok(DocumentContent::Text(port.card_variable_pool(None)?.text)),
    }
}

/// 文档保存载荷（文本目标 = 行编辑文本；MCP 目标 = 表单字段值）。
enum DocumentWrite {
    Text(String),
    Mcp(McpServerSave),
}

/// 保存成功后的新文档坐标 + 中性说明。
///
/// MCP 表单保存可能**改掉服务器名**（表单允许改名）：目标要换成新名字，重拉才不会
/// 去取一个已经不存在的旧名（那会把一次成功保存显示成「读取失败」）。
struct DocumentSaved {
    target: DocumentTarget,
    notice: String,
}

/// 按目标提交文档（文本目标的保存路径）；返回中性成功说明（内容校验失败如实抛出）。
fn save_text_document(
    port: &dyn SettingsPort,
    target: &DocumentTarget,
    content: &str,
) -> AppResult<DocumentSaved> {
    let notice = match target {
        DocumentTarget::V1rtual => {
            port.v1rtual_write(content)?;
            "V1RTUAL 指令已保存（下一个回合生效）".to_string()
        }
        DocumentTarget::CardStages => {
            port.card_stages_write(None, content)?;
            "阶段文案已保存（下一个回合生效）".to_string()
        }
        DocumentTarget::CardMarkdown { card_id } => {
            port.card_markdown_write(Some(card_id), content)?;
            "Card 已保存（下一个回合生效）".to_string()
        }
        DocumentTarget::McpServer { .. } => {
            return Err(AppError::Config(
                "MCP 服务器是表单编辑：文本保存路径已删除（走表单保存）".into(),
            ));
        }
        DocumentTarget::VariablePool | DocumentTarget::CardTemplate => {
            return Err(AppError::Config("只读预览不能保存".into()));
        }
    };
    Ok(DocumentSaved {
        target: target.clone(),
        notice,
    })
}

/// 按目标提交 MCP 表单（`mcp_save` 端口；逐字段校验在 Node，Rust 侧只保证线协议形状）。
fn save_mcp_document(
    port: &dyn SettingsPort,
    target: &DocumentTarget,
    save: &McpServerSave,
) -> AppResult<DocumentSaved> {
    let DocumentTarget::McpServer { .. } = target else {
        return Err(AppError::Config("当前文档不是 MCP 服务器表单".into()));
    };
    port.mcp_save(save)?;
    let renamed = !save.original_name.is_empty() && save.original_name != save.name;
    Ok(DocumentSaved {
        // 改名后文档跟到新名字（下一段编辑/测试都以新名为坐标）。
        target: DocumentTarget::McpServer {
            name: save.name.clone(),
        },
        notice: if renamed {
            format!("MCP 服务器已保存：{}（原名 {}）", save.name, save.original_name)
        } else {
            format!("MCP 服务器已保存：{}", save.name)
        },
    })
}

impl SettingsUi {
    // ── 本批：AI 页 ──

    /// 阶段文案重新生成；成功时把结果替换进已打开的阶段文档。
    pub fn regenerate_card_stages(&self) -> AppResult<()> {
        self.set_notice(Some("正在重新生成阶段文案…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-stages".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.card_stages_regenerate(None) {
                    Ok(stages) => {
                        {
                            let mut doc = Self::lock(&ui.document);
                            match doc.as_mut() {
                                Some(state) if state.target == DocumentTarget::CardStages => {
                                    state.content = DocumentContent::Text(stages.text);
                                    state.loaded = true;
                                }
                                _ => {
                                    *doc = Some(DocumentState {
                                        title: ui.document_title(&DocumentTarget::CardStages),
                                        target: DocumentTarget::CardStages,
                                        content: DocumentContent::Text(stages.text),
                                        loaded: true,
                                    });
                                }
                            }
                        }
                        let ui = settings_ui();
                        ui.note_document_changed();
                        ui.refresh();
                        ui.set_notice(Some(format!("阶段文案已重新生成（{}）", stages.card_id)));
                    }
                    Err(error) => {
                        settings_ui().set_error(format!("阶段文案生成失败：{error}"))
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("阶段文案线程创建失败: {error}"))),
        }
    }

    // ── 本批：行编辑文档（打开/保存/关闭） ──

    /// 文档区变化（打开/关闭/加载完成）：推进面板代数，让平台重建管理面（含文档区）。
    fn note_document_changed(&self) {
        Self::lock(&self.panels).generation += 1;
    }

    /// 当前文档快照（平台渲染）。
    pub fn document(&self) -> Option<DocumentState> {
        Self::lock(&self.document).clone()
    }

    /// 关闭文档（丢弃未保存编辑；不发请求）。
    pub fn close_document(&self) {
        *Self::lock(&self.document) = None;
        self.note_document_changed();
        self.refresh();
    }

    /// 打开文档并后台拉取内容；失败时关闭文档并给中性说明（不留旧文本冒充新内容）。
    pub fn open_document(&self, target: DocumentTarget) {
        *Self::lock(&self.document) = Some(DocumentState {
            title: self.document_title(&target),
            target: target.clone(),
            content: DocumentContent::empty(&target),
            loaded: false,
        });
        self.note_document_changed();
        self.refresh();
        self.spawn_document_load(target);
    }

    fn spawn_document_load(&self, target: DocumentTarget) {
        if self.document_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-doc-load".into())
            .spawn(move || {
                let result = load_document(port.as_ref(), &target);
                let ui = settings_ui();
                match result {
                    Ok(content) => {
                        let mut doc = Self::lock(&ui.document);
                        if let Some(state) = doc.as_mut() {
                            if state.target == target {
                                state.content = content;
                                state.loaded = true;
                            }
                        }
                        drop(doc);
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        let mut doc = Self::lock(&ui.document);
                        if doc.as_ref().map(|state| &state.target) == Some(&target) {
                            *doc = None;
                        }
                        drop(doc);
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_error(format!("内容读取失败：{error}"));
                    }
                }
            });
        if let Err(error) = spawn {
            self.document_in_flight.store(false, Ordering::SeqCst);
            rust_warn!("文档读取线程创建失败: {error}");
        }
    }

    /// 保存文本文档：后台走端口写入口；成功后重拉（显示的永远是已提交文本）。
    pub fn save_document(&self, content: &str) -> AppResult<()> {
        let Some(state) = self.document() else {
            return Err(AppError::Other("没有打开的文档".into()));
        };
        if state.target.is_read_only() {
            return Err(AppError::Config("只读预览不能保存".into()));
        }
        if matches!(state.target, DocumentTarget::McpServer { .. }) {
            // MCP 目标走表单保存（`save_mcp_form`）：文本入口在这里拒绝，避免
            // 「平台忘了建表单控件」时把一段文本静默送进表单保存路径。
            return Err(AppError::Config("MCP 服务器是表单编辑：请用表单保存".into()));
        }
        self.spawn_document_save(state.target, DocumentWrite::Text(content.to_string()))
    }

    /// 保存 MCP 表单：控件读值（key → 值）→ 线协议载荷 → 后台走 `mcp_save` 端口。
    pub fn save_mcp_form(&self, values: &BTreeMap<String, String>) -> AppResult<()> {
        let Some(state) = self.document() else {
            return Err(AppError::Other("没有打开的文档".into()));
        };
        let DocumentTarget::McpServer { name } = state.target.clone() else {
            return Err(AppError::Config("当前文档不是 MCP 服务器表单".into()));
        };
        // 线协议形状校验（缺字段/非法取值 → CONFIG）；域校验（重名、必填项）在 Node。
        let save = panels::mcp_save_from_values(&name, values)?;
        self.spawn_document_save(state.target, DocumentWrite::Mcp(save))
    }

    /// 保存文档的公共后台路径：连接/占用检查 → 端口写入 → 重拉权威内容 → 工具面板刷新。
    fn spawn_document_save(&self, target: DocumentTarget, write: DocumentWrite) -> AppResult<()> {
        if !self.connected.load(Ordering::SeqCst) {
            self.set_error("设置数据未接线，无法保存");
            return Ok(());
        }
        if self.document_in_flight.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次读写还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-doc-save".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = match &write {
                    DocumentWrite::Text(content) => save_text_document(port.as_ref(), &target, content),
                    DocumentWrite::Mcp(save) => save_mcp_document(port.as_ref(), &target, save),
                };
                match result {
                    Ok(saved) => {
                        // 目标换名后的新标题先取好（不握着文档锁再取选项锁）。
                        let renamed_title = ui.document_title(&saved.target);
                        // 重拉权威内容（Node 校验后的落盘值；MCP 改名后按新名字重拉）；
                        // 重拉失败保留刚提交的内容（文档仍是新目标）。
                        {
                            let mut doc = Self::lock(&ui.document);
                            if let Some(state) = doc.as_mut() {
                                if state.target == saved.target {
                                    if let Ok(fresh) = load_document(port.as_ref(), &saved.target) {
                                        state.content = fresh;
                                        state.loaded = true;
                                    }
                                } else if state.target == target {
                                    // 目标换了（改名）：状态也要跟到新坐标，否则后续保存/
                                    // 测试仍按旧名字发请求。
                                    state.title = renamed_title;
                                    state.target = saved.target.clone();
                                    if let Ok(fresh) = load_document(port.as_ref(), &saved.target) {
                                        state.content = fresh;
                                        state.loaded = true;
                                    }
                                }
                            }
                        }
                        if matches!(saved.target, DocumentTarget::McpServer { .. }) {
                            ui.spawn_tools_fetch();
                        }
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(saved.notice));
                    }
                    Err(error) => {
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_error(format!("保存失败（未写入）：{error}"));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.document_in_flight.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    /// 测试当前文档对应的 MCP 服务器连接（仅服务器已有名字的 MCP 文档可用）。
    pub fn test_document_mcp_server(&self) -> AppResult<()> {
        let Some(state) = self.document() else {
            return Err(AppError::Other("没有打开的文档".into()));
        };
        let DocumentTarget::McpServer { name } = state.target else {
            return Err(AppError::Config("当前文档不是 MCP 服务器".into()));
        };
        if name.is_empty() {
            return Err(AppError::Config(
                "新建服务器还没有名字：保存后再测试".into(),
            ));
        }
        self.set_notice(Some(format!("正在测试 {name} …")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-test".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_test(&name) {
                    Ok((true, message)) => ui.set_notice(Some(format!("{name}：{message}"))),
                    Ok((false, message)) => {
                        ui.set_error(format!("{name} 连接失败：{message}"))
                    }
                    Err(error) => ui.set_notice(Some(format!("连接测试未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("连接测试线程创建失败: {error}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ui::settings::panels::{PanelRow, RowAction};
    use crate::ui::settings::test_support::*;
    use crate::ui::settings::*;

    #[test]
    fn 保存回执不吞掉同字段的新编辑或其它字段的编辑() {
        let mut draft = SettingsDraft::default();
        draft.load(snapshot(&[
            ("ai.model", SettingsValue::Text("model-a".into())),
            ("appearance.chatImagePreview", SettingsValue::Bool(true)),
        ]));
        draft.set("ai.model", SettingsValue::Text("model-b".into())).unwrap();
        let submitted = draft.changes();
        draft.set("ai.model", SettingsValue::Text("model-c".into())).unwrap();
        draft.set("appearance.chatImagePreview", SettingsValue::Bool(false)).unwrap();
        draft.mark_saved(&submitted);
        assert_eq!(draft.committed_value("ai.model"), Some(&SettingsValue::Text("model-b".into())));
        assert_eq!(draft.value("ai.model"), Some(&SettingsValue::Text("model-c".into())));
        assert_eq!(draft.changes(), vec![
            SettingEdit { key: "ai.model".into(), value: SettingsValue::Text("model-c".into()) },
            SettingEdit { key: "appearance.chatImagePreview".into(), value: SettingsValue::Bool(false) },
        ]);
        draft.revert_all();
        assert_eq!(draft.value("ai.model"), Some(&SettingsValue::Text("model-b".into())));
        assert_eq!(draft.value("appearance.chatImagePreview"), Some(&SettingsValue::Bool(true)));
    }

    fn backup_row(id: &str, title: &str) -> PanelRow {
        PanelRow {
            id: id.to_string(),
            title: title.to_string(),
            subtitle: String::new(),
            action: RowAction::Choose,
            secondary: RowAction::None,
            enabled: false,
            pick: None,
        }
    }

    #[test]
    fn 备份选中归宿_缺省与失效都回退最新一份() {
        let rows = vec![
            backup_row("/b/new.sqlite3", "10-06 12:00"),
            backup_row("/b/old.sqlite3", "10-01 09:00"),
        ];
        // 未选过 = 最新一份（Node 行顺序即 mtime 倒序）。
        assert_eq!(
            resolve_backup_selection(&rows, None).as_deref(),
            Some("/b/new.sqlite3")
        );
        // 已选且仍在列表 = 保持（不被「回退最新」覆盖掉用户的选择）。
        assert_eq!(
            resolve_backup_selection(&rows, Some("/b/old.sqlite3")).as_deref(),
            Some("/b/old.sqlite3")
        );
        // 选中的那份被清理 = 回退最新一份（不指向不存在的路径）。
        assert_eq!(
            resolve_backup_selection(&rows, Some("/b/gone.sqlite3")).as_deref(),
            Some("/b/new.sqlite3")
        );
        // 空列表 = 没有可操作对象（调用方据此给中性指引，而不是拿空路径去恢复）。
        assert_eq!(resolve_backup_selection(&[], Some("/b/x.sqlite3")), None);
    }

    #[test]
    fn 备份提示行报当前选中或中性空指引() {
        let rows = vec![backup_row("/b/new.sqlite3", "10-06 12:00")];
        let hint = memory_backup_hint(&rows, Some("/b/new.sqlite3"));
        assert!(hint.contains("当前选中：10-06 12:00"), "{hint}");
        // 提示给人看的是展示标题，不是内部路径。
        assert!(!hint.contains("/b/new.sqlite3"), "{hint}");
        // 选中的那份失效 = 提示回退后的对象（与 resolve 同一口径，不谎报旧选择）。
        let fallback = memory_backup_hint(&rows, Some("/b/gone.sqlite3"));
        assert!(fallback.contains("10-06 12:00"), "{fallback}");
        let empty = memory_backup_hint(&[], None);
        assert!(empty.contains("还没有可恢复的备份"), "{empty}");
    }
    #[test]
    fn card文档标题按显示名回落id() {
        let ui = SettingsUi::new();
        *SettingsUi::lock(&ui.card_options) = Some(Arc::new(vec![CardOption {
            id: "sugar".to_string(),
            name: "糖糖".to_string(),
        }]));
        assert_eq!(
            ui.document_title(&DocumentTarget::CardMarkdown {
                card_id: "sugar".to_string(),
            }),
            "Card：糖糖",
            "标题显示卡名（编辑的是哪张卡一眼可见）"
        );
        assert_eq!(
            ui.document_title(&DocumentTarget::CardMarkdown {
                card_id: "gone".to_string(),
            }),
            "Card：gone",
            "选项缓存里找不到时回落 id，不猜别的名字"
        );
        assert_eq!(
            ui.document_title(&DocumentTarget::CardStages),
            "当前卡阶段文案"
        );
    }
    // ── 记忆页常驻说明的两平台守门 ──

    /// 记忆页说明文案加了必须真被渲染（防「常量加了没人渲染」）：
    /// 两平台源码都要引用 [`SettingsUi::MEMORY_TIP`]，且不在平台文件里复制字面量。
    ///
    /// `include_str!` 让两份平台源码成为编译期依赖（要的就是这个：删掉任一侧的
    /// 引用本用例立刻红）；本用例可在任意平台编译（只读源码文本，不调用平台 API）。
    /// 断言用 `concat!` 拆词，避免测试文件自身在外部按整词扫描时自命中。
    #[test]
    fn 两平台设置页都渲染记忆说明常量() {
        const MACOS: &str = include_str!("../platform/macos_settings.rs");
        const WINDOWS: &str = include_str!("../platform/windows_settings.rs");
        let needle = concat!("MEMORY", "_TIP");
        for (name, source) in [
            ("macos_settings.rs", MACOS),
            ("windows_settings.rs", WINDOWS),
        ] {
            assert!(
                source.contains(needle),
                "{name} 必须引用 {needle}（记忆说明加了没人渲染 = 用户看不到入口说明）"
            );
        }
    }

    // ── 记忆列表分页的两平台守门 ──

    /// 分页加了必须两平台都真渲染（防「一侧加了、另一侧照旧铺全量」）：
    /// 两平台源码都要引用 [`SettingsUi::memory_items_view`]。
    /// `include_str!` 与 `concat!` 拆词的理由同上（删掉任一侧引用本用例立刻红）。
    #[test]
    fn 两平台设置页都渲染记忆分页视图() {
        const MACOS: &str = include_str!("../platform/macos_settings.rs");
        const WINDOWS: &str = include_str!("../platform/windows_settings.rs");
        let needle = concat!("memory_items", "_view");
        for (name, source) in [
            ("macos_settings.rs", MACOS),
            ("windows_settings.rs", WINDOWS),
        ] {
            assert!(
                source.contains(needle),
                "{name} 必须引用 {needle}（分页加了不渲染 = 列表被截断在首页且无法翻页）"
            );
        }
    }
}
