//! 设置窗的状态机与面板投影：构造/锁/生命周期/view/refresh/动作分发/通知/
//! 工具页/音效页/Profile 与人格卡/记忆页/字体与编辑器路由，以及分页与快捷键
//! 两组纯函数（T2.8 防碎片化：原 `pager.rs` / `shortcut.rs` 生产代码不足 250 行，
//! 并入本文件；数据 shape 仍在 `types.rs`）。
//!
//! 文件拆分只搬运原 `settings/mod.rs` 的 `impl SettingsUi` 方法块，行为不变；
//! 跨文件需要的私有项只提升到最小可见性（`pub(super)`）。

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::rust_debug;
use crate::rust_info;
use crate::rust_warn;
use crate::ui::font;
use crate::ui::MainThreadQueue;

use super::panels::{
    self, ListPanel, MemoryChange, MemoryChangeAction, MemoryDetailState, MemoryEvidenceState,
    PanelRow, RowAction,
};
use super::schema;
use super::{PanelState, SILENT_OBSERVATION_RUNNING};
use super::*;

// ── 「已记住」列表分页（2026-10-06 用户裁决：「多条记忆翻页或者别的机制，就显示五条一页」）──

/// 「已记住」列表每页条数。
pub const MEMORY_PAGE_SIZE: usize = 5;

/// 「已记住」的总页数（纯函数）：0 条 = 0 页，N 条 = ceil(N / [`MEMORY_PAGE_SIZE`])。
pub fn memory_page_count(total: usize) -> usize {
    total.div_ceil(MEMORY_PAGE_SIZE)
}

/// 把页码收进当前范围（纯函数）：clamp 到 `[1, 总页数]`；0 条时收成 1
/// （空列表按空态渲染，不显示分页行）。数据刷新后总页数变小走这里。
pub fn clamp_memory_page(page: usize, total: usize) -> usize {
    page.clamp(1, memory_page_count(total).max(1))
}

/// 第 `page` 页（1 起）在条目表里的切片范围（纯函数，先 clamp，越界页按收进后的页切）。
pub fn memory_page_bounds(page: usize, total: usize) -> std::ops::Range<usize> {
    let page = clamp_memory_page(page, total);
    let start = (page - 1) * MEMORY_PAGE_SIZE;
    start..(start + MEMORY_PAGE_SIZE).min(total)
}
/// 分页行数据（纯函数）：总条数 0 = `None`（空态沿用面板的「（没有条目）」文案，不加分页行）。
pub fn memory_pager(page: usize, total: usize) -> Option<MemoryPager> {
    if total == 0 {
        return None;
    }
    let page_count = memory_page_count(total);
    let page = clamp_memory_page(page, total);
    Some(MemoryPager {
        page,
        page_count,
        total,
        prev_enabled: page > 1,
        next_enabled: page < page_count,
        label: format!("第 {page} / {page_count} 页 · 共 {total} 条"),
    })
}
/// 管理动作的目标归宿（纯函数，可测）：当前激活项仍在选项列表里 → 用它；
/// 否则回退第一项；空列表 → None（没有可操作对象，调用方据此如实报错）。
///
/// 管理动作（Profile 的「重命名 / 导出 / 删除」、Card 的「编辑 / 重命名 / 导出 / 删除」）
/// 作用于当前激活项（「当前 Profile / 人格卡」下拉的草稿值）——切换激活仍是独立动作，
/// 走下拉 + 保存（`switchActiveProfile` / `switchPersonality` 唯一入口）。
pub fn resolve_option_selection(ids: &[String], preferred: Option<&str>) -> Option<String> {
    let first = ids.first()?.clone();
    if let Some(preferred) = preferred {
        if ids.iter().any(|candidate| candidate == preferred) {
            return Some(preferred.to_string());
        }
    }
    Some(first)
}

// ── 通用页辅助：只读显示投影 / 快捷键录制 / 尺寸预览 / 重启 ──

/// 录制结果写进草稿（自由函数：不依赖设置窗单例，草稿模型即可测试）。
///
/// 按键归一化与组合校验走 `ui::shortcut::parse_spec`（唯一校验点，至少一个修饰键
/// 的护栏也在那里）；两个键都写进草稿，由既有保存路径提交。
pub fn write_shortcut(
    draft: &mut SettingsDraft,
    key: &str,
    modifiers: ShortcutModifiers,
    modifiers_key: &str,
) -> AppResult<()> {
    let names = modifiers.names();
    let spec = crate::ui::shortcut::parse_spec(key, &names)
        .map_err(|error| AppError::Config(error.detail))?;
    draft.set("general.shortcut.key", SettingsValue::Text(spec.key))?;
    draft.set(modifiers_key, SettingsValue::Text(names.join("\n")))?;
    Ok(())
}

/// 只读展示字段的投影（`FieldKind::Info` 的显示文本；数据只来自快照，不补默认值）。
pub fn info_text(key: &str, values: &BTreeMap<String, SettingsValue>) -> String {
    match key {
        // 固定位置坐标：快照把 `{x, y}` 展开成 `.x` / `.y` 两个标量键；未设置时两键都缺。
        "general.popup.fixedPosition" => {
            let x = values
                .get("general.popup.fixedPosition.x")
                .and_then(SettingsValue::as_number);
            let y = values
                .get("general.popup.fixedPosition.y")
                .and_then(SettingsValue::as_number);
            match (x, y) {
                (Some(x), Some(y)) => format!("({}, {})", x as i64, y as i64),
                _ => "未设置".to_string(),
            }
        }
        other => {
            rust_debug!("只读展示字段 {other} 还没有投影规则（显示空文本）");
            String::new()
        }
    }
}

/// 快捷键当前组合（键 + 平台修饰键列表；缺键返回 `None`，由平台展示为「未设置」）。
pub fn shortcut_parts(
    values: &BTreeMap<String, SettingsValue>,
    modifiers_key: &str,
) -> Option<(String, Vec<String>)> {
    let key = values
        .get("general.shortcut.key")
        .and_then(SettingsValue::as_text)?;
    if key.trim().is_empty() {
        return None;
    }
    let modifiers = values
        .get(modifiers_key)
        .and_then(SettingsValue::as_text)
        .map(|text| {
            text.split('\n')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some((key.to_string(), modifiers))
}

/// 字段的动态帮助行（当前只有 Bash 白名单的「N 个命令」计数）。
///
/// 计数取草稿现值（多行文本的非空行数，与运行时 `bashWhitelist` 的解析口径一致）；
/// 平台在字段静态 help 下方再渲染一行，并在刷新时重算（`None` = 该字段无动态行）。
pub fn dynamic_field_hint(key: &str, values: &BTreeMap<String, SettingsValue>) -> Option<String> {
    match key {
        "tools.bash.whitelist" => {
            let count = values
                .get(key)
                .and_then(SettingsValue::as_text)
                .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
                .unwrap_or(0);
            Some(format!("{count} 个命令"))
        }
        _ => None,
    }
}

// ── 平台控件共用（两平台同语义，纯逻辑放这里以便在开发机上跑单测）──

/// Tab 标签 → Tab 下标（平台控件 tag/id 的统一校验口）。
///
/// macOS 的竖栏行按钮 `tag` 就是下标；Windows 的按钮 `id = TAB_BASE + 下标`，
/// 调用方先减基址再进来。越界/负值一律 `None`（控件状态异常时不静默落到某个 Tab）。
pub fn tab_index_for_tag(tag: isize) -> Option<usize> {
    usize::try_from(tag)
        .ok()
        .filter(|index| *index < schema::TABS.len())
}

impl SettingsUi {
    pub(super) fn new() -> Self {
        Self {
            port: Mutex::new(Arc::new(NullSettingsPort)),
            draft: Mutex::new(SettingsDraft::default()),
            queue: OnceLock::new(),
            window_open: AtomicBool::new(false),
            loading: AtomicBool::new(false),
            fonts_loading: AtomicBool::new(false),
            saving: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            notice: Mutex::new(None),
            notice_level: Mutex::new(NoticeLevel::Info),
            notice_generation: Mutex::new(0),
            font_families: Mutex::new(None),
            cards_loading: AtomicBool::new(false),
            card_options: Mutex::new(None),
            profiles_loading: AtomicBool::new(false),
            profile_options: Mutex::new(None),
            panels: Mutex::new(PanelState::default()),
            memory_change_in_flight: AtomicBool::new(false),
            document: Mutex::new(None),
            memory_scope: Mutex::new(None),
            document_in_flight: AtomicBool::new(false),
        }
    }

    pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 平台在 UI 启动时安装主线程队列。
    pub fn install_main_queue(&self, queue: Arc<MainThreadQueue>) {
        if self.queue.set(queue).is_err() {
            rust_warn!("设置 UI 主线程队列重复安装（忽略后一次）");
        }
    }

    /// 注入设置端口（Node 接线就绪后调用）。
    pub fn install_port(&self, port: Arc<dyn SettingsPort>) {
        *Self::lock(&self.port) = port;
        self.connected.store(true, Ordering::SeqCst);
        rust_info!("设置端口已注入");
    }

    fn run_on_ui(&self, job: impl FnOnce() + Send + 'static) {
        match self.queue.get() {
            Some(queue) => queue.push(Box::new(job)),
            None => rust_warn!("设置 UI 未安装主线程队列，本次刷新调度被跳过"),
        }
    }

    /// 通知平台刷新整窗（平台自己取 [`Self::view`]）。
    pub(super) fn refresh(&self) {
        if self.window_open.load(Ordering::SeqCst) {
            self.run_on_ui(|| {
                let _ = crate::ui::platform::imp::settings_refresh();
            });
        }
    }

    // ── 打开 / 关闭 ──

    /// 打开设置窗（先建窗显示现状，再在后台拉取快照）。
    pub fn open_window(&self) {
        self.run_on_ui(|| {
            if let Err(error) = crate::ui::platform::imp::open_settings_window() {
                rust_warn!("设置窗口打开失败: {error}");
            }
        });
        self.window_open.store(true, Ordering::SeqCst);
        self.schedule_fetch(true);
    }

    /// 关闭设置窗后由平台回调：丢弃草稿、回滚字体预览、释放字体列表缓存。
    ///
    /// 字体是「即时预览」语义：有未保存的字体改动时，关闭要把全局快照回滚到
    /// 已提交基线（否则窗口关了、预览还留在控件上）。
    pub fn note_window_closed(&self) {
        self.window_open.store(false, Ordering::SeqCst);
        let mut draft = Self::lock(&self.draft);
        if draft.font_dirty() {
            let snapshot = draft.committed_font_snapshot();
            let applied = font::store(snapshot);
            rust_info!(
                "设置窗关闭：未保存的字体改动已回滚（family={:?}，size={:?}）",
                applied.family,
                applied.size
            );
            if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied) {
                rust_warn!("回滚字体应用失败: {error}");
            }
        }
        draft.revert_all();
        drop(draft);
        self.loading.store(false, Ordering::SeqCst);
        *Self::lock(&self.notice) = None;
        // §6.4：关闭即销毁 UI 资源 —— 字体族与人格卡列表都不跨窗口保留。
        *Self::lock(&self.font_families) = None;
        *Self::lock(&self.card_options) = None;
        *Self::lock(&self.profile_options) = None;
        // 管理面同样关闭即释放：列表、详情与未保存的内容草稿都不跨窗口保留。
        let mut panels = Self::lock(&self.panels);
        *panels = PanelState::default();
        drop(panels);
        self.memory_change_in_flight.store(false, Ordering::SeqCst);
        // 本批：行编辑文档与记忆范围筛选同样不跨窗口保留（§6.4 资源纪律）。
        *Self::lock(&self.document) = None;
        *Self::lock(&self.memory_scope) = None;
        self.document_in_flight.store(false, Ordering::SeqCst);
    }

    /// 重新拉取设置快照（「刷新」按钮；拉取期间保留本地草稿）。
    pub fn reload(&self) {
        if !self.connected.load(Ordering::SeqCst) {
            self.set_notice(Some(
                "设置数据未接线（Node 设置读写端口就绪后自动生效）".into(),
            ));
            return;
        }
        self.set_notice(Some("正在刷新…".into()));
        self.schedule_fetch(true);
    }

    /// 静默重拉（进入通用页时刷新坐标等被宿主写回的字段）：不提示「正在刷新」，
    /// 成功也不清通知 —— 别把更新候选等既有提示顺手抹掉。
    pub fn refresh_silently(&self) {
        if !self.connected.load(Ordering::SeqCst) {
            return;
        }
        self.schedule_fetch(false);
    }

    pub fn is_window_open(&self) -> bool {
        self.window_open.load(Ordering::SeqCst)
    }

    // ── 快照 / 控件动作（平台层调用，全部在主线程） ──

    /// 平台渲染取数。
    pub fn view(&self) -> SettingsView {
        let draft = Self::lock(&self.draft);
        SettingsView {
            values: draft.current_values().clone(),
            dirty: draft.dirty_keys().map(ToString::to_string).collect(),
            notice: Self::lock(&self.notice).clone(),
            notice_level: Self::lock(&self.notice_level).clone(),
            notice_generation: Self::lock(&self.notice_generation).clone(),
            connected: self.connected.load(Ordering::SeqCst),
            font_families: Self::lock(&self.font_families).clone(),
            card_options: Self::lock(&self.card_options).clone(),
            profile_options: Self::lock(&self.profile_options).clone(),
            saving: self.saving.load(Ordering::SeqCst),
        }
    }

    /// 控件改值：写入草稿；字体字段即时预览（全局快照 + 各窗口应用）。
    pub fn set_value(&self, key: &str, value: SettingsValue) -> AppResult<()> {
        let font_preview = {
            let mut draft = Self::lock(&self.draft);
            draft.set(key, value)?;
            if key.starts_with("appearance.font.") {
                Some(draft.font_snapshot())
            } else {
                None
            }
        };
        if let Some(snapshot) = font_preview {
            let applied = font::store(snapshot);
            if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied.clone()) {
                rust_warn!("字体预览应用失败: {error}");
            }
            rust_debug!(
                "字体预览已应用（family={:?}，size={:?}）",
                applied.family,
                applied.size
            );
        }
        self.refresh();
        Ok(())
    }

    /// 动作入口（如「检查更新」）。
    ///
    /// 依赖当前控件值的两个入口（`预览尺寸` / `重启`）要求平台层先采全表进草稿
    /// （用户在输入框里的编辑也算改动）；这里只消费草稿，不反读控件。
    pub fn run_action(&self, key: &str) -> AppResult<()> {
        match key {
            "action.checkUpdate" => self.check_update(),
            "action.restart" => self.restart_app(),
            "action.refreshProfiles" => self.refresh_profiles(),
            // ── 本批：通用页 ──
            "action.resetDefaults" => self.reset_defaults(),
            "action.exportConfig" => self.export_config(),
            "action.importConfig" => self.import_config(),
            // ── 本批：AI 页 ──
            "action.editV1rtual" => {
                self.open_document(DocumentTarget::V1rtual);
                Ok(())
            }
            "action.editCardStages" => {
                self.open_document(DocumentTarget::CardStages);
                Ok(())
            }
            "action.regenerateCardStages" => self.regenerate_card_stages(),
            "action.showVariablePool" => {
                self.open_document(DocumentTarget::VariablePool);
                Ok(())
            }
            // ── 本批：AI 页（Card 增删改查）──
            "action.cardCreate" => self.create_card(),
            "action.cardTemplate" => {
                self.open_document(DocumentTarget::CardTemplate);
                Ok(())
            }
            // 「编辑 / 重命名 / 导出 / 删除」的作用对象 = 当前激活卡（下拉草稿值）。
            "action.cardEdit" => self.open_card_document(),
            "action.cardRename" => self.rename_selected_card(),
            "action.cardExport" => self.card_manage(CardManageOp::Export(String::new())),
            "action.cardImport" => self.card_manage(CardManageOp::Import),
            "action.cardDelete" => self.card_manage(CardManageOp::Delete(String::new())),
            // ── 本批：外观页 ──
            "action.soundResetDefaults" => self.sound_reset_defaults(),
            "action.profileCreate" => self.profile_manage(ProfileManageOp::Create),
            // 「重命名 / 导出 / 删除」作用于当前激活 Profile（下拉草稿值）。
            "action.profileRename" => self.rename_selected_profile(),
            "action.profileDelete" => self.profile_manage(ProfileManageOp::Delete(String::new())),
            "action.profileExport" => self.profile_manage(ProfileManageOp::Export(String::new())),
            "action.profileImport" => self.profile_manage(ProfileManageOp::Import),
            "action.profileRestoreDefaults" => {
                self.profile_manage(ProfileManageOp::RestoreDefaults)
            }
            "action.openLayerEditor" => {
                // 与托盘/聊天「图层」按钮同一条入口（`EditorUi::open_window`）：
                // 窗口门禁与载入调度都在那里，不只是建窗。真正建窗在平台层，
                // 失败在编辑器域内留痕（与既有入口同语义，不在这里另造错误通道）。
                crate::ui::editor::editor_ui().open_window();
                Ok(())
            }
            // ── 本批：工具页 ──
            "action.mcpAddServer" => {
                self.open_document(DocumentTarget::McpServer {
                    name: String::new(),
                });
                Ok(())
            }
            "action.mcpImport" => self.mcp_import(),
            "action.mcpExport" => self.mcp_export(),
            "action.skillUpload" => self.skill_upload(),
            // ── 本批：记忆页 ──
            "action.memorySweep" => self.memory_sweep(),
            "action.silentObservationNow" => self.silent_observation_now(),
            "action.memoryBackup" => self.memory_maintenance(MemoryMaintenanceOp::Backup),
            "action.memoryExport" => self.memory_maintenance(MemoryMaintenanceOp::Export),
            "action.memoryRebuildIndex" => {
                self.memory_maintenance(MemoryMaintenanceOp::RebuildIndex)
            }
            "action.memoryRestorePreview" => self.memory_restore(true),
            "action.memoryRestoreApply" => self.memory_restore(false),
            "action.memoryScopeAll" => {
                self.set_memory_scope(None);
                Ok(())
            }
            "action.memoryScopeUser" => {
                self.set_memory_scope(Some("user"));
                Ok(())
            }
            "action.memoryScopeSession" => {
                self.set_memory_scope(Some("session"));
                Ok(())
            }
            other => Err(AppError::Other(format!("未知动作入口: {other}"))),
        }
    }

    // ── 本批：通用页（恢复默认 / 配置导入导出）──

    /// 「↺ 默认」：拉内置默认值填进草稿（保存前不落盘；失败如实提示）。
    pub fn reset_defaults(&self) -> AppResult<()> {
        if !self.connected.load(Ordering::SeqCst) {
            self.set_error("设置数据未接线，无法读取默认值");
            return Ok(());
        }
        self.set_notice(Some("正在读取默认值…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-defaults".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.defaults() {
                    Ok(snapshot) => {
                        let dirty = Self::lock(&ui.draft).apply_defaults(&snapshot.values);
                        ui.set_notice(Some(if dirty == 0 {
                            "当前配置已与默认值一致".to_string()
                        } else {
                            format!("已填入默认值（{dirty} 项待保存）")
                        }));
                    }
                    Err(error) => ui.set_error(format!("默认值读取失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("默认值线程创建失败: {error}"))),
        }
    }

    /// 「导出配置」：Node 弹保存对话框并写盘；取消是正常结果。
    pub fn export_config(&self) -> AppResult<()> {
        self.set_notice(Some("正在导出配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-config-export".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.export_config() {
                    Ok(Some(path)) => ui.set_notice(Some(format!("配置已导出：{path}"))),
                    Ok(None) => ui.set_notice(Some("已取消导出".into())),
                    Err(error) => ui.set_error(format!("配置导出失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("导出线程创建失败: {error}"))),
        }
    }

    /// 「导入配置」：Node 弹打开对话框、校验后替换 CONFIG 并写盘；成功后重拉快照。
    pub fn import_config(&self) -> AppResult<()> {
        self.set_notice(Some("正在导入配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-config-import".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.import_config() {
                    Ok(true) => {
                        ui.set_notice(Some("配置已导入并写盘".into()));
                        // 磁盘配置已被替换：重拉整表（保留用户未保存的草稿改动，与刷新同一条合并语义）。
                        ui.schedule_fetch(false);
                    }
                    Ok(false) => ui.set_notice(Some("已取消导入".into())),
                    Err(error) => ui.set_error(format!("配置导入失败（未写盘）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("导入线程创建失败: {error}"))),
        }
    }
}

impl SettingsUi {
    // ── 外观页（Profile 管理：动作作用于当前激活项）──

    /// Profile 管理动作：`id` 由平台在动作触发前填进 op（空 = 用**当前激活项**）。
    ///
    /// 平台的动作字段不携带参数，这里把空 id 解析成「当前 Profile」下拉的草稿值
    /// （失效时回退列表第一项），避免静默操作错对象。
    pub fn profile_manage(&self, op: ProfileManageOp) -> AppResult<()> {
        let op = match op {
            ProfileManageOp::Delete(id) if id.is_empty() => {
                ProfileManageOp::Delete(self.selected_profile_id()?)
            }
            ProfileManageOp::Export(id) if id.is_empty() => {
                ProfileManageOp::Export(self.selected_profile_id()?)
            }
            other => other,
        };
        self.set_notice(Some("正在处理 Profile…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-profile".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.profile_manage(&op) {
                    Ok(outcome) => {
                        *Self::lock(&ui.profile_options) = Some(Arc::new(outcome.profiles));
                        ui.set_notice(Some(outcome.message));
                    }
                    Err(error) => ui.set_notice(Some(format!("Profile 操作未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!(
                "Profile 操作线程创建失败: {error}"
            ))),
        }
    }

    /// 重命名当前激活的 Profile：先弹原生输入框取新名（取消 = 不写任何值），再走管理动作。
    ///
    /// 目标 id 与删除/导出同口径（当前激活项）；预填值从 `profile_options` 缓存取显示名，
    /// 缓存缺失时回落 id（不会猜一个不存在的名字）。
    fn rename_selected_profile(&self) -> AppResult<()> {
        let profile_id = self.selected_profile_id()?;
        let current = Self::lock(&self.profile_options)
            .as_ref()
            .and_then(|options| options.iter().find(|option| option.id == profile_id))
            .map(|option| option.name.clone())
            .unwrap_or_else(|| profile_id.clone());
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "重命名 Profile",
            "新显示名（目录名与素材不受影响）",
            &current,
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.profile_manage(ProfileManageOp::Rename { profile_id, name })
    }

    /// 管理动作的目标 Profile id：草稿里的激活 Profile（已失效时回退列表第一项）；
    /// 列表未加载或为空时如实报错（不猜一个不存在的 id）。
    fn selected_profile_id(&self) -> AppResult<String> {
        let ids: Vec<String> = Self::lock(&self.profile_options)
            .as_ref()
            .map(|options| options.iter().map(|option| option.id.clone()).collect())
            .unwrap_or_default();
        let active = Self::lock(&self.draft)
            .value("appearance.activeProfile")
            .and_then(SettingsValue::as_text)
            .map(ToString::to_string);
        resolve_option_selection(&ids, active.as_deref())
            .ok_or_else(|| AppError::Other("没有可操作的 Profile（列表未加载或为空）".into()))
    }

    // ── AI 页（Card 管理：动作作用于当前激活卡）──

    /// Card 管理动作：`id` 由平台在动作触发前填进 op（空 = 用**当前激活卡**）。
    /// 与 Profile 同口径，空 id 解析成激活卡（失效时回退列表第一张），避免静默操作错对象。
    pub fn card_manage(&self, op: CardManageOp) -> AppResult<()> {
        let op = match op {
            CardManageOp::Delete(id) if id.is_empty() => {
                CardManageOp::Delete(self.selected_card_id()?)
            }
            CardManageOp::Export(id) if id.is_empty() => {
                CardManageOp::Export(self.selected_card_id()?)
            }
            other => other,
        };
        self.set_notice(Some("正在处理 Card…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-card".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.card_manage(&op) {
                    Ok(outcome) => {
                        *Self::lock(&ui.card_options) = Some(Arc::new(outcome.cards));
                        ui.set_notice(Some(outcome.message));
                    }
                    Err(error) => ui.set_notice(Some(format!("Card 操作未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("Card 操作线程创建失败: {error}"))),
        }
    }

    /// 新建 Card：先弹原生输入框取角色名（取消 = 不写任何值），再走管理动作。
    ///
    /// id 不在这一层推导：显示名到 id 的清洗与撞名避让都在 Node 侧一次裁定，
    /// 免得宿主与 Node 各有一套推导规则、结果还会分叉。
    fn create_card(&self) -> AppResult<()> {
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "新建 Card",
            "角色名（会作为卡片 id 的来源；重名自动加后缀）",
            "",
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.card_manage(CardManageOp::Create { name })
    }

    /// 重命名选中的 Card：弹原生输入框取新显示名（取消 = 不写任何值）。
    ///
    /// 只改显示名，文件名与 id 不动 —— 阶段文案与变量状态都挂在 id 上，改名不该牵连它们。
    fn rename_selected_card(&self) -> AppResult<()> {
        let card_id = self.selected_card_id()?;
        let current = Self::lock(&self.card_options)
            .as_ref()
            .and_then(|options| options.iter().find(|option| option.id == card_id))
            .map(|option| option.name.clone())
            .unwrap_or_else(|| card_id.clone());
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "重命名 Card",
            "新显示名（文件名、阶段文案与变量状态不受影响）",
            &current,
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.card_manage(CardManageOp::Rename { card_id, name })
    }

    /// 管理动作的目标 Card id：草稿里的激活卡（已失效时回退列表第一张）；
    /// 列表未加载或为空时如实报错。
    fn selected_card_id(&self) -> AppResult<String> {
        let ids: Vec<String> = self
            .card_options()
            .map(|options| options.iter().map(|card| card.id.clone()).collect())
            .unwrap_or_default();
        let active = Self::lock(&self.draft)
            .value("ai.personality.active")
            .and_then(SettingsValue::as_text)
            .map(ToString::to_string);
        resolve_option_selection(&ids, active.as_deref())
            .ok_or_else(|| AppError::Other("没有可操作的 Card（列表未加载或为空）".into()))
    }

    /// 打开当前激活 Card 的本体文档（「人格」小节的编辑入口）。
    ///
    /// 文档绑定在打开时的 card_id 上：之后激活卡变了也不影响这份文档的读写坐标。
    fn open_card_document(&self) -> AppResult<()> {
        let card_id = self.selected_card_id()?;
        self.open_document(DocumentTarget::CardMarkdown { card_id });
        Ok(())
    }

    // ── 本批：工具页动作 ──

    fn mcp_import(&self) -> AppResult<()> {
        self.set_notice(Some("正在导入 MCP 配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-import".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_import() {
                    Ok((_, true)) => ui.set_notice(Some("已取消导入".into())),
                    Ok((count, false)) => {
                        ui.set_notice(Some(format!("已导入 {count} 个 MCP 服务器")));
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_error(format!("MCP 导入失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("MCP 导入线程创建失败: {error}"))),
        }
    }

    fn mcp_export(&self) -> AppResult<()> {
        self.set_notice(Some("正在导出 MCP 配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-export".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_export() {
                    Ok(Some(path)) => ui.set_notice(Some(format!("MCP 配置已导出：{path}"))),
                    Ok(None) => ui.set_notice(Some("已取消导出".into())),
                    Err(error) => ui.set_error(format!("MCP 导出失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("MCP 导出线程创建失败: {error}"))),
        }
    }

    fn skill_upload(&self) -> AppResult<()> {
        self.set_notice(Some("正在上传 Skill…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-skill-upload".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.skill_upload() {
                    Ok(Some(name)) => {
                        ui.set_notice(Some(format!("Skill 已上传：{name}")));
                        ui.spawn_tools_fetch();
                    }
                    Ok(None) => ui.set_notice(Some("已取消上传".into())),
                    Err(error) => ui.set_error(format!("Skill 上传失败（未写入）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("Skill 上传线程创建失败: {error}"))),
        }
    }

    /// 管理面凭据行（`RowAction::Credential`，当前只有 MCP 面板的「GitHub 令牌」）：
    /// 先弹原生输入框取值（取消 = 不写任何值），再经 [`SettingsPort::mcp_credential_set`]
    /// 定向写进应用自有存储。
    ///
    /// 纪律：令牌值不回显、不写 CONFIG、不进日志（通知与错误文案只带「令牌」这一对象，
    /// 不带值）；空输入在写之前拦下；行坐标由 Node 定义并解析（本层只校验行与动作，
    /// 不解析凭据语义）。
    pub fn prompt_panel_credential(&self, panel: &str, row_id: &str) -> AppResult<()> {
        if panel != panels::PANEL_MCP {
            return Err(AppError::Other(format!("面板 {panel} 没有凭据行")));
        }
        {
            let state = Self::lock(&self.panels);
            let Some(row) = state.mcp.iter().find(|row| row.id == row_id) else {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            if row.action != RowAction::Credential {
                return Err(AppError::Other(format!("行 {row_id} 不是凭据行")));
            }
        }
        let Some(value) = crate::ui::platform::imp::prompt_text(
            "GitHub 令牌",
            "粘贴 fine-grained、仅只读权限的 PAT（免费账号即可，无需 Copilot 席位）；令牌只写入本地数据库，不写入配置文件",
            "",
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        if value.trim().is_empty() {
            self.set_notice(Some("未输入令牌，未写入任何值".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存令牌…".into()));
        let port = Self::lock(&self.port).clone();
        let row_id = row_id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-credential".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_credential_set(&row_id, &value) {
                    Ok(()) => {
                        ui.set_notice(Some("GitHub 令牌已保存（仅存本地数据库）".into()));
                        // 状态行经由 Node 重读（已设置/未设置），界面不自行推进本地行状态。
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_error(format!("令牌未保存：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("令牌保存线程创建失败: {error}"))),
        }
    }

    /// 管理面行次动作（MCP 编辑/删除、Skill 删除）。
    pub fn panel_secondary_action(
        &self,
        panel: &str,
        row_id: &str,
        action: RowAction,
    ) -> AppResult<()> {
        match (panel, action) {
            (panels::PANEL_MCP, RowAction::Edit) => {
                self.open_document(DocumentTarget::McpServer {
                    name: row_id.to_string(),
                });
                Ok(())
            }
            (panels::PANEL_MCP, RowAction::Delete) => self.spawn_row_delete(panel, row_id, "删除"),
            (panels::PANEL_SKILLS, RowAction::Delete) => {
                self.spawn_row_delete(panel, row_id, "删除")
            }
            _ => Err(AppError::Other(format!("行 {row_id} 没有可执行的次动作"))),
        }
    }

    fn spawn_row_delete(&self, panel: &str, row_id: &str, label: &'static str) -> AppResult<()> {
        let (panel, row_id) = (panel.to_string(), row_id.to_string());
        self.set_notice(Some(format!("正在{label}…")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-row-delete".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = match panel.as_str() {
                    panels::PANEL_MCP => port.mcp_delete(&row_id),
                    panels::PANEL_SKILLS => port.skill_delete(&row_id),
                    _ => Err(AppError::Other("未知面板".into())),
                };
                match result {
                    Ok(()) => {
                        ui.set_notice(Some(format!("{row_id} 已{label}")));
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_error(format!("{label}失败（未改动）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("{label}线程创建失败: {error}"))),
        }
    }

    // ── 本批：记忆页动作 ──

    /// 记忆范围筛选（None = 全部）；设置后立即重拉条目列表。
    pub fn set_memory_scope(&self, scope: Option<&str>) {
        self.note_memory_scope_change(scope);
        self.spawn_memory_fetch();
        self.refresh();
    }

    /// 筛选取值变化点（2026-10-06 分页裁决）：值变了 = 换了一份清单 → 回第 1 页；
    /// 同值重复点击只重拉，不动页码。返回取值是否变化。
    fn note_memory_scope_change(&self, scope: Option<&str>) -> bool {
        let changed = {
            let mut current = Self::lock(&self.memory_scope);
            let next = scope.map(ToString::to_string);
            if *current == next {
                false
            } else {
                *current = next;
                true
            }
        };
        if changed {
            Self::lock(&self.panels).memory_page = 1;
        }
        changed
    }

    fn memory_sweep(&self) -> AppResult<()> {
        self.set_notice(Some("正在整理记忆（可能需要一段时间）…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-sweep".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_dreaming_sweep() {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        ui.spawn_memory_fetch();
                    }
                    Err(error) => ui.set_notice(Some(format!("记忆整理未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("记忆整理线程创建失败: {error}"))),
        }
    }

    fn silent_observation_now(&self) -> AppResult<()> {
        if SILENT_OBSERVATION_RUNNING.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次静默了解还没结束".into()));
            return Ok(());
        }
        self.set_notice(Some("正在静默了解…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-silent-observation".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.silent_understanding_run_now() {
                    Ok(message) => ui.set_notice(Some(message)),
                    Err(error) => ui.set_notice(Some(format!("静默了解未完成：{error}"))),
                }
                SILENT_OBSERVATION_RUNNING.store(false, Ordering::SeqCst);
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                SILENT_OBSERVATION_RUNNING.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("静默了解线程创建失败: {error}")))
            }
        }
    }

    fn memory_maintenance(&self, op: MemoryMaintenanceOp) -> AppResult<()> {
        self.set_notice(Some("正在执行记忆维护…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-maintenance".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_maintenance(op) {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        ui.spawn_memory_fetch();
                        // 新备份要出现在列表里（选中归宿由列表拉取统一收口到最新一份）。
                        if op == MemoryMaintenanceOp::Backup {
                            ui.spawn_backup_fetch();
                        }
                    }
                    Err(error) => ui.set_notice(Some(format!("记忆维护未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("记忆维护线程创建失败: {error}"))),
        }
    }

    /// 恢复预览 / 应用：作用对象 = **当前选中的那份备份**（不是「最新一份」隐式坐标）。
    fn memory_restore(&self, preview_only: bool) -> AppResult<()> {
        let Some(backup_path) = Self::lock(&self.panels).backup_selected.clone() else {
            self.set_notice(Some(
                "还没有可操作的备份：先在「备份列表」里点一份（或点「备份现在」生成一份）".into(),
            ));
            return Ok(());
        };
        self.set_notice(Some(
            if preview_only {
                "正在预检备份…"
            } else {
                "正在恢复备份…"
            }
            .into(),
        ));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-restore".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_restore(preview_only, &backup_path) {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        if !preview_only {
                            ui.spawn_memory_fetch();
                        }
                    }
                    Err(error) => ui.set_notice(Some(format!(
                        "{}未完成：{error}",
                        if preview_only {
                            "备份预检"
                        } else {
                            "恢复"
                        }
                    ))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("恢复线程创建失败: {error}"))),
        }
    }

    /// 展开/收起一条来源的原话（逐条回看入口）。
    ///
    /// 语义（「不无限膨胀」的边界）：**同时最多展开一条** —— 点未展开的行 = 展开该条
    /// （只取这一条证据，不预取其余）；点已展开的行 = 收起；点另一行 = 直接切换。
    /// 落地结果按来源坐标核对（Loading 阶段的坐标被换掉时丢弃，防陈旧回填）。
    pub fn open_memory_source(&self, source_id: &str) -> AppResult<()> {
        let expanded = {
            let mut state = Self::lock(&self.panels);
            let known = state
                .detail
                .as_ref()
                .is_some_and(|detail| detail.sources.iter().any(|row| row.id == source_id));
            if !known {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            }
            let collapse = state
                .evidence
                .as_ref()
                .is_some_and(|current| current.source_id() == source_id);
            state.evidence = if collapse {
                None
            } else {
                Some(MemoryEvidenceState::Loading {
                    source_id: source_id.to_string(),
                })
            };
            state.generation += 1;
            !collapse
        };
        self.refresh();
        if !expanded {
            return Ok(());
        }
        let port = Self::lock(&self.port).clone();
        let target = source_id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-evidence".into())
            .spawn(move || {
                let result = port.memory_source_evidence(&target);
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    // 只有在途的目标仍是这一条时才落地（用户在途换了行 = 结果作废）。
                    let still_open = matches!(
                        &state.evidence,
                        Some(MemoryEvidenceState::Loading { source_id }) if source_id == &target
                    );
                    if still_open {
                        state.evidence = Some(match result {
                            Ok(text) => MemoryEvidenceState::Ready {
                                source_id: target.clone(),
                                text,
                            },
                            Err(error) => MemoryEvidenceState::Error {
                                source_id: target.clone(),
                                error: format!("来源原话读取失败：{error}"),
                            },
                        });
                        state.generation += 1;
                    }
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            rust_warn!("来源原话线程创建失败: {error}");
            let mut state = Self::lock(&self.panels);
            let still_loading = matches!(
                &state.evidence,
                Some(MemoryEvidenceState::Loading { source_id: current }) if current.as_str() == source_id
            );
            if still_loading {
                state.evidence = None;
            }
            drop(state);
            self.refresh();
        }
        Ok(())
    }

    /// 记忆作业行的取消 / 继续（行主按钮；只有 Node 标记了动作的行会出现）。
    ///
    /// 语义按记忆域既有原语裁定、界面不发明新状态：
    /// - 取消 = `memory_job_cancel`（终止进行中的作业；终态与可取消性由 Rust 裁决）；
    /// - 继续 = `memory_job_resume`（恢复 review 阶段的受限作业并跑到收口，可能分钟级）。
    pub fn memory_job_action(&self, panel: &str, job_id: &str, action: RowAction) -> AppResult<()> {
        if panel != panels::PANEL_MEMORY_JOBS {
            return Err(AppError::Other(format!("面板 {panel} 没有作业动作")));
        }
        let (verb, start) = match action {
            RowAction::Cancel => ("取消", "正在取消作业…"),
            RowAction::Resume => ("继续", "正在继续作业（可能需要一段时间）…"),
            _ => return Err(AppError::Other(format!("行 {job_id} 没有作业动作"))),
        };
        self.set_notice(Some(start.into()));
        let port = Self::lock(&self.port).clone();
        let job_id = job_id.to_string();
        // 入口已按动作过滤：继续可能跑完整条 Review（模型调用），等待上限在端口内按用户交互档。
        let resume = matches!(action, RowAction::Resume);
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-job".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = if resume {
                    port.memory_job_resume(&job_id)
                } else {
                    port.memory_job_cancel(&job_id)
                };
                match result {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        // 作业状态列在 Rust 库里：以重拉为准，界面不自行推进行状态。
                        ui.refresh_memory();
                    }
                    Err(error) => ui.set_notice(Some(format!("作业未{verb}：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("作业动作线程创建失败: {error}"))),
        }
    }

    /// 强制重拉 Profile 列表（外部增删 Profile 后不用重开设置窗）。
    ///
    /// 清缓存后走既有 `ensure_profiles`（在途去重；失败经通知如实呈现）。
    pub fn refresh_profiles(&self) -> AppResult<()> {
        *Self::lock(&self.profile_options) = None;
        self.ensure_profiles();
        Ok(())
    }

    // `preview_popup_size` 删除记录（2026-10-05 用户规则「…以及预览尺寸，没必要留」）：
    // 动作字段与函数一并退场（平台侧的 `action.previewPopupSize` 分支同批删除）。
    // 窗口尺寸改用鼠标直接调（`set_popup_size` 运行期入口不变，拖动仍会写回 CONFIG）。

    // `number_value` 删除记录（2026-10-05）：它唯一的消费者是随「预览尺寸」一起退场的
    // `preview_popup_size` 已删。**注意它的语义**（按 schema 值域夹取；缺键即如实报错、
    // 不落兜底值）是这一族的正确口径 —— 将来再有「读草稿里的数值去驱动窗口/系统」的需求，
    // 按原样加回来，**不要**改成 `unwrap_or(默认值)`。

    /// 录制结果落草稿：按键归一化与组合校验走 `ui::shortcut::parse_spec`（唯一校验点，
    /// 至少一个修饰键的护栏也在那里）；修饰键按平台写入对应的 CONFIG 键。
    ///
    /// `modifiers_key` 由平台层传入（macOS=`general.shortcut.macModifiers`
    /// / Windows=`general.shortcut.winModifiers`）——平台边界只此一处。
    pub fn apply_shortcut(
        &self,
        key: &str,
        modifiers: ShortcutModifiers,
        modifiers_key: &str,
    ) -> AppResult<()> {
        write_shortcut(&mut Self::lock(&self.draft), key, modifiers, modifiers_key)?;
        self.refresh();
        Ok(())
    }

    /// 「重启」：先把草稿写盘（有改动时），成功后才走统一退出序列重启。
    ///
    /// 写盘失败不重启（旧设置面板同语义）：直接重启会把未落盘的改动丢掉，
    /// 用户以为是「重启后生效」，实际是改动没了。没有改动时直接重启。
    pub fn restart_app(&self) -> AppResult<()> {
        let changes = Self::lock(&self.draft).changes();
        if changes.is_empty() {
            self.set_notice(Some("正在重启…".into()));
            return updates::request_restart();
        }
        if self.saving.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次保存还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存并重启…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-restart".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.commit(&changes) {
                    Ok(()) => {
                        Self::lock(&ui.draft).mark_saved(&changes);
                        // 提交已完成：先落回 saving 态，重启失败时界面不卡在「保存中」。
                        ui.saving.store(false, Ordering::SeqCst);
                        // 重启失败不改写已保存的事实：文案只说「重启失败」。
                        if let Err(error) = updates::request_restart() {
                            ui.set_error(format!(
                                "设置已保存，但重启失败：{error}；可稍后手动重启"
                            ));
                        }
                    }
                    Err(error) => {
                        ui.saving.store(false, Ordering::SeqCst);
                        ui.set_error(format!("配置写盘失败，已取消重启：{error}"));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("重启线程创建失败: {error}")))
            }
        }
    }

    /// 手动检查更新（后台执行、结果以中性通知呈现）。
    ///
    /// 失败文案由 [updates::check_interactive] 带阶段前缀（检查 / 下载校验 / 重启），
    /// 这里原样呈现；成功时不覆写候选或安装提示。
    pub fn check_update(&self) -> AppResult<()> {
        self.set_notice(Some("正在检查更新…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-update".into())
            .spawn(move || match port.check_update() {
                Ok(()) => {} // 具体结果由 UpdatePort 交互流程留痕/呈现，不能覆盖候选与安装状态。
                Err(error) => settings_ui().set_notice(Some(format!("{error}"))),
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("更新检查线程创建失败: {error}"))),
        }
    }

    /// 保存：后台提交草稿改动；成功后才更新基线。
    pub fn save(&self) -> AppResult<()> {
        let changes = Self::lock(&self.draft).changes();
        if changes.is_empty() {
            self.set_notice(Some("没有需要保存的改动".into()));
            return Ok(());
        }
        if self.saving.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次保存还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-save".into())
            .spawn(move || match port.commit(&changes) {
                Ok(()) => {
                    let ui = settings_ui();
                    let pending = {
                        let mut draft = Self::lock(&ui.draft);
                        draft.mark_saved(&changes);
                        if !ui.window_open.load(Ordering::SeqCst) {
                            // 窗口已关闭：本次写盘仍成为基线，关闭时丢弃的编辑不能复活。
                            draft.revert_all();
                        }
                        draft.is_dirty()
                    };
                    // 保存成功 = 字体预览成为已提交基线（再应用一次，保证与磁盘一致）。
                    ui.run_on_ui(|| {
                        // 执行时读最新草稿，不能让排队的旧保存回执覆盖后续字体预览。
                        let snapshot = Self::lock(&settings_ui().draft).font_snapshot();
                        let applied = font::store(snapshot);
                        if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied) {
                            rust_warn!("保存后字体应用失败: {error}");
                        }
                    });
                    ui.saving.store(false, Ordering::SeqCst);
                    ui.set_notice(Some(if pending { "本次改动已保存，仍有新的未保存改动" } else { "已保存" }.into()));
                }
                Err(error) => {
                    let ui = settings_ui();
                    ui.saving.store(false, Ordering::SeqCst);
                    ui.set_error(format!("保存失败（改动保留在草稿里）：{error}"));
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    /// 中性通知（保存回执、未接线说明等）—— 走**顶部浮层**分档。
    ///
    /// 与 [`Self::set_error`] 是一对：这里只装「告知」，不装「失败」。
    /// 拿不准时用这个（宁可轻一档，也不该把回执弹成要确认的模态）。
    pub fn set_notice(&self, notice: Option<String>) {
        self.set_notice_with(NoticeLevel::Info, notice);
    }

    /// 错误通知 —— 走**模态弹窗**分档，用户必须确认。
    ///
    /// 判据：**这次操作没有成功**，且用户需要知道（保存失败、校验不过、动作未执行）。
    /// 纯告知性的（「已保存」「正在刷新」）用 [`Self::set_notice`]。
    pub fn set_error(&self, notice: impl Into<String>) {
        self.set_notice_with(NoticeLevel::Error, Some(notice.into()));
    }

    /// 警告通知 —— 走顶部浮层，但配色取 `warn`（未就绪 / 部分成功）。
    pub fn set_warning(&self, notice: impl Into<String>) {
        self.set_notice_with(NoticeLevel::Warning, Some(notice.into()));
    }

    fn set_notice_with(&self, level: NoticeLevel, notice: Option<String>) {
        *Self::lock(&self.notice_level) = level;
        *Self::lock(&self.notice) = notice;
        // 代际只对**非空**通知推进：清空通知（`set_notice(None)`）不该被平台
        // 当成「来了一条新通知」而去弹一次空浮层。
        if Self::lock(&self.notice).is_some() {
            *Self::lock(&self.notice_generation) += 1;
        }
        self.refresh();
    }

    /// 请求字体族列表（窗口打开时一次；已缓存则直接刷新界面）。
    pub fn ensure_font_families(&self) {
        if Self::lock(&self.font_families).is_some() {
            self.refresh();
            return;
        }
        // 枚举是数百毫秒级的同步 IO（fontdb 扫描），必须离开主线程。
        if self.fonts_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-fonts".into())
            .spawn(|| {
                let families = Arc::new(crate::commands::font_cmd::list_system_fonts());
                let ui = settings_ui();
                *Self::lock(&ui.font_families) = Some(families.clone());
                ui.fonts_loading.store(false, Ordering::SeqCst);
                rust_info!("系统字体枚举完成：{} 个族", families.len());
                ui.refresh();
            });
        if let Err(error) = spawn {
            self.fonts_loading.store(false, Ordering::SeqCst);
            rust_warn!("字体枚举线程创建失败: {error}");
        }
    }

    // ── 人格卡选项 ──

    /// 请求人格卡列表（窗口打开时一次；已缓存则直接刷新界面）。
    ///
    /// 选项来自 Node 的人格注册表（`SettingsPort::cards`，供「人格卡」下拉消费）；
    /// 未接线/失败时如实通知，不留假列表。工作线程执行（可能要走 IPC），
    /// 结果经主线程队列回投。
    pub fn ensure_cards(&self) {
        if Self::lock(&self.card_options).is_some() {
            self.refresh();
            return;
        }
        if self.cards_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-cards".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.cards() {
                    Ok(options) => {
                        *Self::lock(&ui.card_options) = Some(Arc::new(options));
                        ui.cards_loading.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        ui.cards_loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("人格卡列表不可用：{error}")));
                        rust_warn!("人格卡列表拉取失败: {error}");
                    }
                }
            });
        if let Err(error) = spawn {
            self.cards_loading.store(false, Ordering::SeqCst);
            rust_warn!("人格卡列表线程创建失败: {error}");
        }
    }

    /// 当前展示用的人格卡列表（平台控件重建选项时取，与 `view()` 同源）。
    pub fn card_options(&self) -> Option<Arc<Vec<CardOption>>> {
        Self::lock(&self.card_options).clone()
    }

    // ── Profile 选项（外观页，W9c 管理面第三步）──

    /// 请求激活 Profile 列表（外观页打开时一次；已缓存则直接刷新界面）。
    ///
    /// 选项来自 Node 的 Profile 域（`discoverAllProfiles` + `readProfileMeta` 的轻量读；
    /// 不把 Profile 内容带进设置窗，也不进内存缓存）。切换由 Node 走
    /// `switchActiveProfile` 唯一入口（激活、落盘、通知其它窗口一体收口）。
    pub fn ensure_profiles(&self) {
        if Self::lock(&self.profile_options).is_some() {
            self.refresh();
            return;
        }
        if self.profiles_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-profiles".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.profiles() {
                    Ok(options) => {
                        *Self::lock(&ui.profile_options) = Some(Arc::new(options));
                        ui.profiles_loading.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        ui.profiles_loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("Profile 列表不可用：{error}")));
                        rust_warn!("Profile 列表拉取失败: {error}");
                    }
                }
            });
        if let Err(error) = spawn {
            self.profiles_loading.store(false, Ordering::SeqCst);
            rust_warn!("Profile 列表线程创建失败: {error}");
        }
    }

    /// 当前展示用的 Profile 列表（平台控件重建选项时取，与 `view()` 同源）。
    pub fn profile_options(&self) -> Option<Arc<Vec<ProfileOption>>> {
        Self::lock(&self.profile_options).clone()
    }

    // ── 管理面（W9d）：工具页 ──

    /// 管理面数据代数：数据每次变化 +1；平台层只在代数变化时重建面板控件。
    pub fn panel_generation(&self) -> u64 {
        Self::lock(&self.panels).generation
    }

    /// 工具页的三个面板（渲染快照）。
    pub fn tools_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        vec![
            ListPanel {
                id: panels::PANEL_MCP,
                title: "MCP 服务器",
                hint: "按每服务器开关控制，全部关闭即不使用 MCP；启用的服务器在运行开始时借用、结束即释放（占用中的服务器拒绝开关）。".to_string(),
                error: state.mcp_error.clone(),
                warning: None,
                loaded: state.tools_loaded,
                rows: state.mcp.clone(),
            },
            ListPanel {
                id: panels::PANEL_SKILLS,
                title: "Skill",
                hint: "关闭只是停用（删除在文件系统处理）；开关写入 SKILL.md 的 enabled 字段，下一个回合生效。Skill 不额外授予工具权限。".to_string(),
                error: state.skills_error.clone(),
                warning: state.skills_index_error.clone(),
                loaded: state.tools_loaded,
                rows: state.skills.clone(),
            },
            ListPanel {
                id: panels::PANEL_POLICIES,
                title: "工具策略（声明）",
                hint: "只读：工具在代码里声明的默认策略，不代表本次运行的有效授权；实际执行仍按本次参数与权限终裁。".to_string(),
                error: state.policies_error.clone(),
                warning: None,
                loaded: state.tools_loaded,
                rows: state.policies.clone(),
            },
        ]
    }

    /// 首次进入工具页：拉取三个面板（一次后台任务、代数只 +1）。
    pub fn ensure_tools_panels(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.tools_loaded || state.tools_loading {
                return;
            }
        }
        self.spawn_tools_fetch();
    }

    /// 工具页「刷新」：强制重拉（在途去重，不叠加请求）。
    pub fn refresh_tools_panels(&self) {
        self.spawn_tools_fetch();
    }

    pub(super) fn spawn_tools_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.tools_loading {
                return;
            }
            state.tools_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-tools".into())
            .spawn(move || {
                // 三个面板各自成败：失败面板记原因，成功面板照常显示（互不拖累）。
                // 阻塞的 IPC 调用不在锁内进行（锁只用于装卸快照）。
                let mcp = port.mcp_servers();
                let skills = port.skills();
                let policies = port.tool_policies();
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match mcp {
                        Ok(rows) => {
                            state.mcp = rows;
                            state.mcp_error = None;
                        }
                        Err(error) => state.mcp_error = Some(format!("列表读取失败：{error}")),
                    }
                    match skills {
                        Ok(catalog) => {
                            state.skills = catalog.rows;
                            state.skills_index_error = catalog.index_error;
                            state.skills_error = None;
                        }
                        Err(error) => state.skills_error = Some(format!("列表读取失败：{error}")),
                    }
                    match policies {
                        Ok(rows) => {
                            state.policies = rows;
                            state.policies_error = None;
                        }
                        Err(error) => state.policies_error = Some(format!("列表读取失败：{error}")),
                    }
                    state.tools_loaded = true;
                    state.tools_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).tools_loading = false;
            rust_warn!("工具面板拉取线程创建失败: {error}");
        }
    }

    /// 逐项开关一个 MCP 服务器 / Skill：先读快照取反，后台走既有写入口，成功后重读面板。
    pub fn toggle_panel_row(&self, panel: &str, row_id: &str) -> AppResult<()> {
        let (panel, row_id, enabled) = {
            let state = Self::lock(&self.panels);
            let rows: Option<&Vec<PanelRow>> = match panel {
                panels::PANEL_MCP => Some(&state.mcp),
                panels::PANEL_SKILLS => Some(&state.skills),
                _ => None,
            };
            let Some(rows) = rows else {
                return Err(AppError::Other(format!("面板 {panel} 没有可切换的行")));
            };
            let Some(row) = rows.iter().find(|row| row.id == row_id) else {
                // 列表在用户点击的间隙被重读过：不猜状态，要求刷新。
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            if row.action != RowAction::Toggle {
                return Err(AppError::Other(format!("行 {row_id} 不是开关行")));
            }
            (panel.to_string(), row_id.to_string(), !row.enabled)
        };
        self.set_notice(Some("正在写入…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-toggle".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = match panel.as_str() {
                    panels::PANEL_MCP => port.set_mcp_server_enabled(&row_id, enabled),
                    panels::PANEL_SKILLS => port.set_skill_enabled(&row_id, enabled),
                    _ => Err(AppError::Other("未知面板".into())),
                };
                match result {
                    Ok(()) => {
                        ui.set_notice(Some(format!(
                            "{row_id} 已{}",
                            if enabled { "启用" } else { "关闭" }
                        )));
                        // 写入口可能改变列表内容（如自定义服务器被删/占用拒绝的后续状态）：
                        // 以 Node 重读为准，界面不自行推进本地行状态。
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_notice(Some(format!("开关未生效：{error}"))),
                }
            });
        if let Err(error) = spawn {
            return Err(AppError::Other(format!("开关线程创建失败: {error}")));
        }
        Ok(())
    }

    // ── 本批：外观页（音效试听面板）──

    /// 外观页的音效试听面板（渲染快照）。
    pub fn sound_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        vec![ListPanel {
            id: panels::PANEL_SOUNDS,
            title: "音效分配",
            hint: "点开行内下拉更改各事件音效（none = 静音，立即生效）；「试听」播放该事件当前分配，「↺ 恢复默认」清空自定义分配。".to_string(),
            error: state.sounds_error.clone(),
            warning: None,
            loaded: state.sounds_loaded,
            rows: state.sounds.clone(),
        }]
    }

    /// 首次进入外观页：拉取音效试听行（在途去重）。
    pub fn ensure_sound_panel(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.sounds_loaded || state.sounds_loading {
                return;
            }
        }
        self.spawn_sound_fetch();
    }

    /// 音效面板「刷新」/ 保存分配后重读。
    pub fn refresh_sound_panel(&self) {
        self.spawn_sound_fetch();
    }

    fn spawn_sound_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.sounds_loading {
                return;
            }
            state.sounds_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sounds".into())
            .spawn(move || {
                let result = port.sound_library();
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match result {
                        Ok(library) => {
                            state.sounds = library.rows;
                            state.sounds_error = None;
                        }
                        Err(error) => {
                            state.sounds_error = Some(format!("音效列表读取失败：{error}"))
                        }
                    }
                    state.sounds_loaded = true;
                    state.sounds_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).sounds_loading = false;
            rust_warn!("音效面板拉取线程创建失败: {error}");
        }
    }

    /// 试听一条音效（不改配置；失败如实提示）。
    fn preview_sound(&self, sound_id: &str) -> AppResult<()> {
        if sound_id.is_empty() {
            return Err(AppError::Config("试听缺少音效 id".into()));
        }
        self.set_notice(Some("正在试听…".into()));
        let port = Self::lock(&self.port).clone();
        let sound_id = sound_id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-preview".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_preview(&sound_id) {
                    Ok(()) => ui.set_notice(Some(format!("已试听：{sound_id}"))),
                    Err(error) => ui.set_error(format!("试听失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("试听线程创建失败: {error}"))),
        }
    }

    /// 面板行「试听」：播放该行当前分配的音效。
    ///
    /// 平台只回传行 id（= 事件键）；当前分配值从行快照的 `pick.selected` 取
    /// （平台不解析行数据）。`none`/缺行如实拒绝，不静默播别的。
    pub fn preview_panel_row(&self, panel: &str, row_id: &str) -> AppResult<()> {
        if panel != panels::PANEL_SOUNDS {
            return Err(AppError::Other(format!("面板 {panel} 没有可试听的行")));
        }
        let selected = {
            let state = Self::lock(&self.panels);
            let Some(row) = state.sounds.iter().find(|row| row.id == row_id) else {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            row.pick.as_ref().map(|pick| pick.selected.clone())
        };
        match selected {
            Some(sound_id) if sound_id != "none" && !sound_id.is_empty() => {
                self.preview_sound(&sound_id)
            }
            Some(_) => Err(AppError::Config("该事件当前是静音，没有可试听的内容".into())),
            None => Err(AppError::Other(format!("行 {row_id} 没有音效分配"))),
        }
    }

    /// 行内下拉选择一个值（当前只有音效事件行）：与 `toggle_panel_row` 同构 ——
    /// 先读快照校验行与动作，再后台走领域写入口；**不自行推进本地选中值**，
    /// 成功后以 Node 重读为准（失败如实提示，不把「没写进去」显示成已更新）。
    pub fn pick_panel_row(&self, panel: &str, row_id: &str, value: &str) -> AppResult<()> {
        if panel != panels::PANEL_SOUNDS {
            return Err(AppError::Other(format!("面板 {panel} 没有下拉行")));
        }
        {
            let state = Self::lock(&self.panels);
            let Some(row) = state.sounds.iter().find(|row| row.id == row_id) else {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            if row.action != RowAction::Pick {
                return Err(AppError::Other(format!("行 {row_id} 不是下拉行")));
            }
        }
        self.set_notice(Some("正在写入音效分配…".into()));
        let port = Self::lock(&self.port).clone();
        let row_id = row_id.to_string();
        let value = value.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-assign".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_set_assignment(&row_id, &value) {
                    Ok(()) => {
                        ui.set_notice(Some(format!("音效已更新：{row_id} → {value}")));
                        // 写入口改变行内容（选中值/试听可用性）：以 Node 重读为准。
                        ui.refresh_sound_panel();
                    }
                    Err(error) => ui.set_error(format!("音效分配未生效：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("音效分配线程创建失败: {error}"))),
        }
    }

    /// 音效「↺ 恢复默认」：把所有事件分配恢复为内置默认（清空分配覆盖）。
    ///
    /// 语义定义点在 Node（`sound_reset` 清空分配覆盖 = 全事件回默认）；这里只投
    /// 请求并重读面板，失败如实提示（不把「没写进去」显示成已恢复）。
    pub fn sound_reset_defaults(&self) -> AppResult<()> {
        self.set_notice(Some("正在恢复默认音效…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-reset".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_reset() {
                    Ok(()) => {
                        ui.set_notice(Some("音效分配已恢复默认".to_string()));
                        ui.refresh_sound_panel();
                    }
                    Err(error) => {
                        ui.set_error(format!("恢复默认音效失败（未写入）：{error}"))
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("音效恢复线程创建失败: {error}"))),
        }
    }

    // ── 管理面（W9d）：记忆页 ──

    /// 记忆页顶部的常驻说明（两条显式写入路径 + 来源边界）。
    ///
    /// 中性界面语言、非角色口吻；**两平台的唯一文案来源** ——
    /// `platform/{macos,windows}_settings.rs` 的「memory」分支都渲染这一份，
    /// 平台文件不复制字面量（源码守门见 `documents.rs` 测试）。刻意不进 `schema.rs`：
    /// 该文件在 observation 契约 sourceFiles 里，一条静态说明不值得翻契约 hash，
    /// 它也不随 CONFIG 变化。
    pub const MEMORY_TIP: &str = "要记住一条内容：在聊天里右键你自己的消息选『记住这条』，或直接说一句『记住……』（由模型判断是否写入）。助手与系统消息不能作为记忆来源。";

    /// 记忆页两个面板（条目 + 自动整理）。
    ///
    /// 「已记住」面板的行 = **当前页切片**（2026-10-06 用户裁决：五条一页）；
    /// 分页行数据见 [`Self::memory_items_view`]（平台渲染入口），
    /// 切片与页码 clamp 的唯一点见 `memory_items_page_locked`。
    pub fn memory_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        let overview = state.memory.clone().unwrap_or_else(MemoryOverview::empty);
        let (rows, _pager) = Self::memory_items_page_locked(&state);
        vec![
            Self::memory_items_panel(&state, rows),
            ListPanel {
                id: panels::PANEL_MEMORY_JOBS,
                // 面板名对齐旧壳的「自动整理」小节（下面的列表即「历史作业」）。
                title: "自动整理",
                hint: "整理由运行期自动触发（空闲或手动入口在聊天侧）；进行中的作业可在行上取消，受限的 Review 作业可继续，其余为历史终态（只读）。".to_string(),
                error: state.memory_error.clone(),
                warning: None,
                loaded: state.memory_loaded,
                rows: overview.jobs,
            },
        ]
    }

    /// 「已记住」面板组装（行 = 给定切片）：标题/说明/错误状态的唯一定义点。
    fn memory_items_panel(state: &PanelState, rows: Vec<PanelRow>) -> ListPanel {
        ListPanel {
            id: panels::PANEL_MEMORY_ITEMS,
            title: "已记住",
            hint: "纠正与遗忘立即提交（不走设置保存），遗忘只清应用管理的记忆与回灌资格：原始聊天、已导出文件与外部备份要另在会话管理或文件系统里处理。".to_string(),
            error: state.memory_error.clone(),
            warning: None,
            loaded: state.memory_loaded,
            rows,
        }
    }

    /// 「已记住」当前页的行与分页行（切片 + 页码 clamp 的唯一实现点；须持 `panels` 锁）。
    fn memory_items_page_locked(state: &PanelState) -> (Vec<PanelRow>, Option<MemoryPager>) {
        let total = state
            .memory
            .as_ref()
            .map(|overview| overview.items.len())
            .unwrap_or(0);
        let page = clamp_memory_page(state.memory_page, total);
        let rows = state
            .memory
            .as_ref()
            .map(|overview| overview.items[memory_page_bounds(page, total)].to_vec())
            .unwrap_or_default();
        (rows, memory_pager(page, total))
    }

    /// 「已记住」面板的当前页视图（切片 + 分页行；平台渲染入口）。
    ///
    /// 读取时把页码收进当前范围（0 条收成 1）：数据刷新 / 写操作重建列表后，
    /// 即使别的同步点漏了 clamp，渲染也不会越界（切片先 clamp 过）。
    pub fn memory_items_view(&self) -> MemoryItemsView {
        let mut state = Self::lock(&self.panels);
        let (rows, pager) = Self::memory_items_page_locked(&state);
        state.memory_page = pager.as_ref().map(|pager| pager.page).unwrap_or(1);
        MemoryItemsView {
            panel: Self::memory_items_panel(&state, rows),
            pager,
        }
    }

    /// 「已记住」翻页（`delta` = -1 / +1；平台只回传方向，边界收口在这里）。
    ///
    /// 首页再「上一页」、末页再「下一页」是 no-op（不推进代数、不刷新）；
    /// 实际翻页才推进代数并触发平台重建面板区。
    pub fn step_memory_page(&self, delta: isize) {
        let changed = {
            let mut state = Self::lock(&self.panels);
            let total = state
                .memory
                .as_ref()
                .map(|overview| overview.items.len())
                .unwrap_or(0);
            let current = clamp_memory_page(state.memory_page, total);
            let next = clamp_memory_page((current as isize + delta).max(1) as usize, total);
            if next == current {
                false
            } else {
                state.memory_page = next;
                state.generation += 1;
                true
            }
        };
        if changed {
            self.refresh();
        }
    }

    /// 可操作的整理作业行（带动作的行：可取消的进行中 / 可继续的受限作业）。
    ///
    /// macOS 记忆页只内联这一份（完整历史仍在「查看记录」弹层，2026-10-05 用户规则）；
    /// Windows 渲染完整作业面板，行按钮只在有动作的行出现 —— 两侧**动作集合同源**
    /// （都取 Node 行投影的 `action` 字段），这里只是过滤呈现，不按状态重算。
    pub fn memory_actionable_jobs(&self) -> Vec<PanelRow> {
        Self::lock(&self.panels)
            .memory
            .as_ref()
            .map(|overview| {
                overview
                    .jobs
                    .iter()
                    .filter(|row| row.action != RowAction::None)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 记忆状态行（「库版本 revision N · …」；未读到为 None）。
    /// 有范围筛选时前缀标注当前筛选（界面显示的筛选必须与实际查询一致）。
    pub fn memory_status_text(&self) -> Option<String> {
        let state = Self::lock(&self.panels);
        if !state.memory_loaded {
            return None;
        }
        let status = state
            .memory
            .as_ref()
            .map(|overview| overview.status_text.clone())
            .unwrap_or_default();
        let scope = match Self::lock(&self.memory_scope).as_deref() {
            Some("user") => "筛选：仅用户级　",
            Some("session") => "筛选：仅当前会话　",
            _ => "",
        };
        Some(format!("{scope}{status}"))
    }

    /// 详情区渲染状态（未选中 / 读取中 / 失败 / 就绪）。
    pub fn memory_detail_state(&self) -> MemoryDetailState {
        let state = Self::lock(&self.panels);
        if let Some(error) = &state.detail_error {
            return MemoryDetailState::Error(error.clone());
        }
        if let Some(detail) = &state.detail {
            return MemoryDetailState::Ready(panels::MemoryDetailView {
                item_id: detail.item_id.clone(),
                version: detail.version,
                pinned: detail.pinned,
                info: detail.info.clone(),
                content: state
                    .content_draft
                    .clone()
                    .unwrap_or_else(|| detail.content.clone()),
                history: detail.history.clone(),
            });
        }
        if state.detail_loading {
            MemoryDetailState::Loading
        } else {
            MemoryDetailState::None
        }
    }

    /// 记忆详情「来源原话」面板：当前选中条目有来源时才有这一节。
    ///
    /// 行 = 一条来源（`id` = sourceId，动作 select；Node 投影）；**不预取任何证据** ——
    /// 点行才取那一条，同时最多展开一条（见 [`MemoryEvidenceState`]）。
    pub fn memory_source_panel(&self) -> Option<ListPanel> {
        let state = Self::lock(&self.panels);
        let detail = state.detail.as_ref()?;
        if detail.sources.is_empty() {
            return None;
        }
        Some(ListPanel {
            id: panels::PANEL_MEMORY_SOURCES,
            title: "来源原话",
            hint: "点一行展开那条来源的登记证据与会话原话；再点同一行收起（一次只展开一条）。".to_string(),
            error: None,
            warning: None,
            loaded: true,
            rows: detail.sources.clone(),
        })
    }

    /// 展开中的来源原话（None = 没有展开；平台按三态分支渲染）。
    pub fn memory_evidence_state(&self) -> Option<MemoryEvidenceState> {
        Self::lock(&self.panels).evidence.clone()
    }

    /// 记忆页「备份列表」面板：托管目录里的备份逐份一行（最新在前），点行 = 选中。
    ///
    /// 行的 `enabled` 位叠加「当前选中」（选择是 UI 临时状态，不来自 Node 行投影）；
    /// 提示行报当前选中的对象（空列表给「还没有备份」的中性指引）。
    pub fn memory_backup_panel(&self) -> ListPanel {
        let state = Self::lock(&self.panels);
        let selected = state.backup_selected.clone();
        let rows: Vec<PanelRow> = state
            .backups
            .iter()
            .cloned()
            .map(|mut row| {
                row.enabled = Some(&row.id) == selected.as_ref();
                row
            })
            .collect();
        ListPanel {
            id: panels::PANEL_MEMORY_BACKUPS,
            title: "备份列表",
            hint: memory_backup_hint(&state.backups, selected.as_deref()),
            error: state.backups_error.clone(),
            warning: None,
            loaded: state.backups_loaded,
            rows,
        }
    }

    /// 选中一份托管备份（预览/应用的作用对象）；未知 id 如实拒绝（列表已更新时不驱动陈旧坐标）。
    pub fn select_memory_backup(&self, backup_id: &str) -> AppResult<()> {
        {
            let mut state = Self::lock(&self.panels);
            if !state.backups.iter().any(|row| row.id == backup_id) {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            }
            state.backup_selected = Some(backup_id.to_string());
            state.generation += 1;
        }
        self.refresh();
        Ok(())
    }

    /// 行选择（`RowAction::Select` / `Choose`）的归宿（按面板分发；平台只回传行坐标，
    /// 语义在这里）。
    ///
    /// - 条目面板 = 打开详情；
    /// - 来源面板 = 展开/收起该条原话；
    /// - 备份面板 = 把该行设为当前操作对象。
    pub fn panel_row_select(&self, panel: &str, row_id: &str) -> AppResult<()> {
        match panel {
            panels::PANEL_MEMORY_ITEMS => {
                self.open_memory_item(row_id);
                Ok(())
            }
            panels::PANEL_MEMORY_SOURCES => self.open_memory_source(row_id),
            panels::PANEL_MEMORY_BACKUPS => self.select_memory_backup(row_id),
            other => Err(AppError::Other(format!("面板 {other} 没有可选择的行"))),
        }
    }

    /// 首次进入记忆页：拉取总览（状态 + 条目 + 作业）与托管备份列表。
    pub fn ensure_memory(&self) {
        self.ensure_backups();
        {
            let state = Self::lock(&self.panels);
            if state.memory_loaded || state.memory_loading {
                return;
            }
        }
        self.spawn_memory_fetch();
    }

    /// 记忆页「刷新」：强制重拉总览与备份列表（各自在途去重）。
    pub fn refresh_memory(&self) {
        self.spawn_memory_fetch();
        self.spawn_backup_fetch();
    }

    /// 首次进入记忆页：拉取备份列表（`refresh_memory` 覆盖的是强制重拉路径）。
    fn ensure_backups(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.backups_loaded || state.backups_loading {
                return;
            }
        }
        self.spawn_backup_fetch();
    }

    fn spawn_backup_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.backups_loading {
                return;
            }
            state.backups_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-backups".into())
            .spawn(move || {
                let result = port.memory_backup_list();
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match result {
                        Ok(rows) => {
                            state.backups = rows;
                            state.backups_error = None;
                        }
                        // 读取失败保留上一次列表（错误独立呈现），不把旧列表清成「没有备份」。
                        Err(error) => {
                            state.backups_error = Some(format!("备份列表读取失败：{error}"))
                        }
                    }
                    state.backups_loaded = true;
                    state.backups_loading = false;
                    // 选中归宿：选中的一份消失（被清理/换目录）时回退最新一份，空列表清空选中。
                    state.backup_selected =
                        resolve_backup_selection(&state.backups, state.backup_selected.as_deref());
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).backups_loading = false;
            rust_warn!("备份列表拉取线程创建失败: {error}");
        }
    }

    fn spawn_memory_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.memory_loading {
                return;
            }
            state.memory_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let scope = Self::lock(&self.memory_scope).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory".into())
            .spawn(move || {
                let result = port.memory_overview(scope.as_deref(), None);
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match result {
                        Ok(overview) => {
                            // 刷新后条目集可能变小：把当前页收进新范围
                            // （保持当前页（clamp 后），不无脑回第 1 页）。
                            state.memory_page =
                                clamp_memory_page(state.memory_page, overview.items.len());
                            state.memory = Some(overview);
                            state.memory_error = None;
                        }
                        Err(error) => state.memory_error = Some(format!("记忆库读取失败：{error}")),
                    }
                    state.memory_loaded = true;
                    state.memory_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).memory_loading = false;
            rust_warn!("记忆面板拉取线程创建失败: {error}");
        }
    }

    /// 点开一条记忆：后台拉详情 + 历史；换条目先清旧详情与草稿。
    pub fn open_memory_item(&self, id: &str) {
        if id.is_empty() {
            return;
        }
        {
            let mut state = Self::lock(&self.panels);
            state.detail = None;
            state.detail_error = None;
            state.detail_loading = true;
            state.content_draft = None;
            // 换条目 = 上一份展开的原话不再属于当前上下文（来源坐标已变）。
            state.evidence = None;
            state.generation += 1;
        }
        self.refresh();
        let port = Self::lock(&self.port).clone();
        let id = id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-detail".into())
            .spawn(move || {
                let result = port.memory_item_detail(&id);
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    state.detail_loading = false;
                    match result {
                        Ok(detail) => state.detail = Some(detail),
                        Err(error) => state.detail_error = Some(format!("详情读取失败：{error}")),
                    }
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            let mut state = Self::lock(&self.panels);
            state.detail_loading = false;
            state.detail_error = Some(format!("详情线程创建失败: {error}"));
            drop(state);
            self.refresh();
        }
    }

    /// 平台在重建详情控件前暂存文本框内容（未保存编辑不因刷新丢失）。
    pub fn stash_memory_content(&self, content: &str) {
        let mut state = Self::lock(&self.panels);
        if state.detail.is_some() {
            state.content_draft = Some(content.to_string());
        }
    }

    /// 保存纠正：同一 id 写新版本（旧版本转 superseded，历史仍可查）。
    pub fn memory_save_correction(&self, content: &str) -> AppResult<()> {
        let (item_id, version, revision, committed) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (
                detail.item_id.clone(),
                detail.version,
                detail.revision,
                detail.content.clone(),
            )
        };
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(AppError::Config("记忆内容不能为空".into()));
        }
        if content == committed {
            self.set_notice(Some("内容没有变化，未提交".into()));
            return Ok(());
        }
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Update,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: Some(content),
                pinned: None,
            },
            "纠正",
        );
        Ok(())
    }

    /// 核心画像标记：只更新 pinned，保留完整草稿与来源。
    pub fn memory_toggle_pinned(&self) -> AppResult<()> {
        let (item_id, version, revision, pinned) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (
                detail.item_id.clone(),
                detail.version,
                detail.revision,
                detail.pinned,
            )
        };
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Update,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: None,
                pinned: Some(!pinned),
            },
            if pinned {
                "移出核心画像"
            } else {
                "加入核心画像"
            },
        );
        Ok(())
    }

    /// 遗忘一条记忆（平台层已做原生确认；本域只负责提交）。
    pub fn memory_forget(&self) -> AppResult<()> {
        let (item_id, version, revision) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (detail.item_id.clone(), detail.version, detail.revision)
        };
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Forget,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: None,
                pinned: None,
            },
            "遗忘",
        );
        Ok(())
    }

    /// 记忆治理变更的后台提交：成功后重读总览与详情（界面显示的永远是已提交状态）。
    fn spawn_memory_change(&self, change: MemoryChange, label: &'static str) {
        if self.memory_change_in_flight.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次记忆操作还在进行中".into()));
            return;
        }
        self.set_notice(Some(format!("正在提交{label}…")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-change".into())
            .spawn(move || {
                let ui = settings_ui();
                let outcome = port.memory_change(&change);
                let (reload_detail, notice) = match outcome {
                    Ok(revision) => {
                        let mut state = Self::lock(&ui.panels);
                        state.content_draft = None;
                        if change.action == MemoryChangeAction::Forget {
                            // 遗忘成功：条目已不在库里，收起详情。
                            state.detail = None;
                        }
                        let reload = state
                            .detail
                            .as_ref()
                            .map(|detail| detail.item_id.clone());
                        drop(state);
                        let notice = match change.action {
                            MemoryChangeAction::Forget => format!(
                                "已忘记这条记忆（revision {revision}）：原始聊天、已导出文件与外部备份不受影响"
                            ),
                            MemoryChangeAction::Update if change.pinned == Some(true) => {
                                format!("已加入核心画像（revision {revision}）")
                            }
                            MemoryChangeAction::Update if change.pinned == Some(false) => {
                                format!("已移出核心画像（revision {revision}）")
                            }
                            MemoryChangeAction::Update => {
                                format!("已提交纠正并同步运行记忆（revision {revision}）")
                            }
                        };
                        (reload, notice)
                    }
                    Err(error) => (None, format!("{label}未提交：{error}")),
                };
                // 成功后重读总览（无论成败，让界面回到已提交状态；重读失败各自记因）。
                let scope = Self::lock(&ui.memory_scope).clone();
                let overview = port.memory_overview(scope.as_deref(), None);
                {
                    let mut state = Self::lock(&ui.panels);
                    match overview {
                        Ok(overview) => {
                            state.memory = Some(overview);
                            state.memory_error = None;
                        }
                        Err(error) => {
                            state.memory_error = Some(format!("记忆库读取失败：{error}"))
                        }
                    }
                }
                if let Some(id) = reload_detail {
                    let mut state = Self::lock(&ui.panels);
                    match port.memory_item_detail(&id) {
                        Ok(detail) => state.detail = Some(detail),
                        Err(error) => {
                            state.detail_error = Some(format!("详情读取失败：{error}"))
                        }
                    }
                }
                {
                    let mut state = Self::lock(&ui.panels);
                    state.generation += 1;
                }
                ui.memory_change_in_flight.store(false, Ordering::SeqCst);
                ui.set_notice(Some(notice));
            });
        if let Err(error) = spawn {
            self.memory_change_in_flight.store(false, Ordering::SeqCst);
            self.set_error(format!("{label}线程创建失败: {error}"));
        }
    }

    // ── 后台拉取 ──

    fn schedule_fetch(&self, clear_notice: bool) {
        if self.loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-fetch".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.fetch() {
                    Ok(snapshot) => {
                        {
                            let mut draft = Self::lock(&ui.draft);
                            // 拉取期间用户已改的字段保留用户值（后到的旧快照不覆盖草稿）。
                            // 用界面单位的待保存值（与 `set` 同口径）；提交口径的
                            // `changes()` 已换成 CONFIG 单位，不能用于这里。
                            let pending = draft.pending_edits();
                            draft.load(snapshot);
                            for edit in pending {
                                if let Err(error) = draft.set(&edit.key, edit.value) {
                                    rust_debug!("拉取合并草稿失败（忽略该项）: {error}");
                                }
                            }
                        }
                        ui.loading.store(false, Ordering::SeqCst);
                        if clear_notice {
                            ui.set_notice(None);
                        }
                    }
                    Err(error) => {
                        ui.loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("设置数据未接线：{error}")));
                    }
                }
            });
        if let Err(error) = spawn {
            self.loading.store(false, Ordering::SeqCst);
            rust_warn!("设置拉取线程创建失败: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::ui::settings::panels::{self, MemoryOverview, PanelRow, RowAction};
    use crate::ui::settings::schema;
    use crate::ui::settings::test_support::*;
    use crate::ui::settings::*;
    use crate::ui::settings::PanelState;

    // ── 管理动作的目标解析（Profile / 人格卡）──

    #[test]
    fn 管理目标解析激活优先_失效回退首项() {
        let ids = vec!["a".to_string(), "b".to_string()];
        // 激活项在列表：用它（旧「当前 Profile / 当前 Card」口径不变）。
        assert_eq!(
            resolve_option_selection(&ids, Some("b")).as_deref(),
            Some("b")
        );
        // 激活项不在列表（如激活卡被外部改动）：回退第一项。
        assert_eq!(
            resolve_option_selection(&ids, Some("gone")).as_deref(),
            Some("a")
        );
        assert_eq!(resolve_option_selection(&ids, None).as_deref(), Some("a"));
        // 空列表 = 没有可操作对象（调用方如实报错，不猜 id）。
        assert_eq!(resolve_option_selection(&[], Some("a")), None);
    }

    /// 管理动作的目标解析（缺省回退激活项、失效回退第一项、空列表如实报错）。
    #[test]
    fn 管理目标缺省回退激活项_空列表如实报错() {
        let ui = SettingsUi::new();
        *SettingsUi::lock(&ui.card_options) = Some(Arc::new(vec![
            CardOption {
                id: "a".to_string(),
                name: "甲".to_string(),
            },
            CardOption {
                id: "b".to_string(),
                name: "乙".to_string(),
            },
        ]));
        SettingsUi::lock(&ui.draft).load(snapshot(&[(
            "ai.personality.active",
            SettingsValue::Text("b".to_string()),
        )]));
        // 管理动作回退激活卡（旧口径不变）。
        assert_eq!(ui.selected_card_id().unwrap(), "b");
        // 列表重读后激活卡不在其中（被删/外部改动）：回退第一张。
        *SettingsUi::lock(&ui.card_options) = Some(Arc::new(vec![CardOption {
            id: "a".to_string(),
            name: "甲".to_string(),
        }]));
        assert_eq!(ui.selected_card_id().unwrap(), "a");
        // 空列表与未加载：如实报错，不拿不存在的 id 去操作。
        *SettingsUi::lock(&ui.card_options) = Some(Arc::new(Vec::new()));
        assert!(ui.selected_card_id().is_err());
        *SettingsUi::lock(&ui.card_options) = None;
        assert!(ui.selected_card_id().is_err());
    }

    /// Profile 侧的同一口径（激活草稿 → 第一项；与 Card 共用纯函数）。
    #[test]
    fn profile管理目标跟随激活值() {
        let ui = SettingsUi::new();
        *SettingsUi::lock(&ui.profile_options) = Some(Arc::new(vec![
            ProfileOption {
                id: "sugar-pink".to_string(),
                name: "糖糖".to_string(),
                description: String::new(),
            },
            ProfileOption {
                id: "yuki".to_string(),
                name: "小雪".to_string(),
                description: String::new(),
            },
        ]));
        SettingsUi::lock(&ui.draft).load(snapshot(&[(
            "appearance.activeProfile",
            SettingsValue::Text("sugar-pink".to_string()),
        )]));
        assert_eq!(ui.selected_profile_id().unwrap(), "sugar-pink");
        // 激活的 Profile 从列表消失：回退第一项（不是拿陈旧 id 去操作）。
        *SettingsUi::lock(&ui.profile_options) = Some(Arc::new(vec![ProfileOption {
            id: "yuki".to_string(),
            name: "小雪".to_string(),
            description: String::new(),
        }]));
        assert_eq!(ui.selected_profile_id().unwrap(), "yuki");
        // 空列表：如实报错。
        *SettingsUi::lock(&ui.profile_options) = Some(Arc::new(Vec::new()));
        assert!(ui.selected_profile_id().is_err());
    }
    #[test]
    fn 快捷录制写两个键且缺修饰键被拒绝() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        let modifiers = ShortcutModifiers {
            control: true,
            command: true,
            alt: false,
            shift: false,
        };
        write_shortcut(&mut draft, "p", modifiers, "general.shortcut.macModifiers").unwrap();
        assert_eq!(
            draft.value("general.shortcut.key"),
            Some(&SettingsValue::Text("P".into())),
            "单字符按键大小写归一化由 parse_spec 收口"
        );
        assert_eq!(
            draft.value("general.shortcut.macModifiers"),
            Some(&SettingsValue::Text("Control\nCommand".into()))
        );

        // 缺修饰键：护栏在 parse_spec，草稿不留脏值。
        let mut bare_draft = SettingsDraft::default();
        bare_draft.load(SettingsSnapshot::default());
        assert!(write_shortcut(
            &mut bare_draft,
            "P",
            ShortcutModifiers::default(),
            "general.shortcut.macModifiers"
        )
        .is_err());
        assert!(!bare_draft.is_dirty());
    }

    #[test]
    fn 固定位置只读投影读x与y两个快照键() {
        let values = BTreeMap::from([
            (
                "general.popup.fixedPosition.x".to_string(),
                SettingsValue::Number(-1290.0),
            ),
            (
                "general.popup.fixedPosition.y".to_string(),
                SettingsValue::Number(88.0),
            ),
        ]);
        assert_eq!(
            info_text("general.popup.fixedPosition", &values),
            "(-1290, 88)"
        );
        assert_eq!(
            info_text("general.popup.fixedPosition", &BTreeMap::new()),
            "未设置"
        );
    }

    #[test]
    fn 快捷键显示投影按平台键拆分修饰键() {
        let values = BTreeMap::from([
            (
                "general.shortcut.key".to_string(),
                SettingsValue::Text("P".into()),
            ),
            (
                "general.shortcut.macModifiers".to_string(),
                SettingsValue::Text("Control\nCommand".into()),
            ),
        ]);
        let (key, modifiers) = shortcut_parts(&values, "general.shortcut.macModifiers").unwrap();
        assert_eq!(key, "P");
        assert_eq!(modifiers, vec!["Control", "Command"]);
        assert!(shortcut_parts(&BTreeMap::new(), "general.shortcut.macModifiers").is_none());
    }
    #[test]
    fn 重启先写盘_失败不重启_成功才标记已保存() {
        let ui = settings_ui();
        let port = Arc::new(RecordingPort {
            fail: AtomicBool::new(true),
            commits: Mutex::new(Vec::new()),
        });
        ui.install_port(port.clone());
        {
            let mut draft = ui.draft.lock().unwrap_or_else(|error| error.into_inner());
            draft.load(snapshot(&[(
                "appearance.chatImagePreview",
                SettingsValue::Bool(false),
            )]));
            draft
                .set("appearance.chatImagePreview", SettingsValue::Bool(true))
                .unwrap();
        }

        // 写盘失败：取消重启、草稿保留、saving 复位（可重试）。
        ui.restart_app().unwrap();
        wait_until(
            || {
                ui.view()
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.contains("配置写盘失败，已取消重启"))
            },
            "写盘失败通知",
        );
        assert_eq!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            1,
            "重启前必须把草稿改动提交一次"
        );
        let commit = port
            .commits
            .lock()
            .unwrap_or_else(|error| error.into_inner())[0]
            .clone();
        assert_eq!(commit.len(), 1);
        assert_eq!(commit[0].key, "appearance.chatImagePreview");
        assert_eq!(commit[0].value, SettingsValue::Bool(true));
        assert!(
            ui.draft
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_dirty(),
            "写盘失败时改动必须保留在草稿里"
        );
        assert!(!ui.saving.load(Ordering::SeqCst), "失败后 saving 必须复位");

        // 写盘成功：改动成为新基线；重启入口在测试进程未安装 → 如实报告「已保存但重启失败」。
        // （失败的改动仍留在草稿里，重试直接提交同一份待保存改动。）
        port.fail.store(false, Ordering::SeqCst);
        ui.restart_app().unwrap();
        wait_until(
            || {
                ui.view()
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.contains("设置已保存，但重启失败"))
            },
            "已保存但重启失败通知",
        );
        assert_eq!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            2,
            "第二次重启同样先提交"
        );
        assert!(
            !ui.draft
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_dirty(),
            "提交成功后才标记新基线"
        );
        assert!(!ui.saving.load(Ordering::SeqCst));
    }

    #[test]
    fn 无改动时重启不写盘只走重启入口() {
        let ui = SettingsUi::new();
        let port = Arc::new(RecordingPort {
            fail: AtomicBool::new(false),
            commits: Mutex::new(Vec::new()),
        });
        ui.install_port(port.clone());
        // 空草稿：直接重启；重启入口在测试进程未安装 → 如实报错（正是「走没走写盘」的判据）。
        let error = ui.restart_app().unwrap_err();
        assert!(error.to_string().contains("重启入口未初始化"));
        assert!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "没有改动时不得产生空提交"
        );
        assert_eq!(
            ui.view().notice.as_deref(),
            Some("正在重启…"),
            "空改动分支的通知不得是「正在保存并重启」"
        );
    }

    /// 竖栏标签映射：范围内才给出 Tab 下标，越界/负值一律拒绝。
    #[test]
    fn 竖栏标签在范围内才映射到_tab_下标() {
        for index in 0..schema::TABS.len() {
            assert_eq!(
                tab_index_for_tag(index as isize),
                Some(index),
                "tag={index} 应映射到下标 {index}"
            );
        }
        assert_eq!(tab_index_for_tag(-1), None, "负 tag 不得落到某个 Tab");
        assert_eq!(
            tab_index_for_tag(schema::TABS.len() as isize),
            None,
            "越界 tag 不得落到某个 Tab"
        );
        assert_eq!(tab_index_for_tag(isize::MAX), None);
    }

    /// 开关镜像表：登记/读取/翻转/回滚写/注销的全部状态迁移。
    #[test]
    fn 开关镜像表状态迁移() {
        let mut states = SwitchStates::default();
        // 未登记：contains 为假、读取兜底关。
        assert!(!states.contains(41));
        assert!(!states.get(41));

        states.register(41, false);
        assert!(states.contains(41));
        assert!(!states.get(41), "登记为关");

        states.set(41, true);
        assert!(states.get(41), "刷新回写开");

        // 翻转返回新状态并落表（点击提交路径）；失败回滚写回旧值。
        assert!(!states.toggle(41), "开→关");
        assert!(!states.get(41));
        assert!(states.toggle(41), "关→开");
        assert!(states.get(41));
        states.set(41, false); // 提交失败的回滚写法
        assert!(!states.get(41));

        states.unregister(41);
        assert!(!states.contains(41), "注销后从绘制分流里消失");

        // 句柄会被系统复用：整体清空后不留陈旧项。
        states.register(7, true);
        states.clear();
        assert!(!states.contains(7));
    }

    // ── 面板计数 / 动态帮助 ──

    #[test]
    fn bash_白名单计数只数非空行() {
        let values = BTreeMap::from([(
            "tools.bash.whitelist".to_string(),
            SettingsValue::Text("ls\n\n  cat  \ngrep".into()),
        )]);
        assert_eq!(
            dynamic_field_hint("tools.bash.whitelist", &values).as_deref(),
            Some("3 个命令")
        );
        // 缺键（快照未到）：计数如实为 0，不编造。
        assert_eq!(
            dynamic_field_hint("tools.bash.whitelist", &BTreeMap::new()).as_deref(),
            Some("0 个命令")
        );
        // 其它字段没有动态行。
        assert!(dynamic_field_hint("general.popup.mode", &values).is_none());
    }

    // ── 外观页：图层编辑器入口 ──

    /// 「图层编辑器」动作的接线：分发必须走到 [`crate::ui::editor::EditorUi::open_window`]
    /// ——与托盘/聊天「图层」按钮同一条入口（窗口门禁与载入调度都在那里）。
    ///
    /// 真正建窗的那一刀在平台层（`platform::imp::open_editor_window`）：单元测试进程
    /// 没有 UI 主线程队列，`EditorUi::run_on_ui` 会留痕跳过；这里钉到门禁被拉起为止，
    /// 实机建窗与渲染留给实机验证。编辑器单例是进程级全局：`open_window` 还会派发
    /// 载入线程，它在 `NullEditorPort` 上报错后把 notice 改写成「Profile 未接线…」——
    /// 与素材调度用例的「复制完成通知」共用同一只单值槽，异步改写形成丢失更新
    /// （全量并行必红）。两用例共用 [`crate::ui::editor::EDITOR_GLOBAL_TEST_LOCK`]
    /// 串行；本用例在放锁前等载入线程的改写落地，不把异步尾巴带出锁外。
    #[test]
    fn 图层编辑器动作路由到编辑器窗口门禁() {
        let _guard = crate::ui::editor::EDITOR_GLOBAL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let editor = crate::ui::editor::editor_ui();
        assert!(
            !editor.is_window_open(),
            "前置：编辑器窗口门禁初始必须是关闭态"
        );
        SettingsUi::new()
            .run_action("action.openLayerEditor")
            .expect("已接线的动作不得返回「未知动作入口」");
        assert!(
            editor.is_window_open(),
            "动作必须经 EditorUi::open_window 打开（窗口门禁 + 载入调度；建窗在平台层）"
        );
        assert!(
            SettingsUi::new().run_action("action.no_such_action").is_err(),
            "未知动作仍要被拒绝（新入口不得放宽兜底分支）"
        );
        // 载入线程的错误路径文案是确定性的：全测试二进制里没有用例安装全局编辑器端口
        // （`未接线端口如实报错` 用的是本地实例），`NullEditorPort` 恒定报错。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !editor
            .view()
            .notice
            .as_deref()
            .is_some_and(|notice| notice.contains("Profile 未接线"))
        {
            assert!(
                std::time::Instant::now() < deadline,
                "等待载入线程改写 notice 超时（open_window → schedule_load 的错误路径）"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    // ── 记忆「已记住」列表分页（2026-10-06 用户裁决：五条一页）──

    /// 页数与切片：N = 0/1/5/6/12 条按五条一页切，边界（5/6）不并入相邻页。
    #[test]
    fn 记忆分页按五条一页切片() {
        assert_eq!(memory_page_count(0), 0);
        assert_eq!(memory_page_count(1), 1);
        assert_eq!(memory_page_count(5), 1, "正好一页不产生空尾页");
        assert_eq!(memory_page_count(6), 2, "第 6 条起翻到第 2 页");
        assert_eq!(memory_page_count(12), 3);

        let items: Vec<usize> = (0..12).collect();
        assert_eq!(items[memory_page_bounds(1, 12)], [0, 1, 2, 3, 4]);
        assert_eq!(items[memory_page_bounds(2, 12)], [5, 6, 7, 8, 9]);
        assert_eq!(items[memory_page_bounds(3, 12)], [10, 11], "末页只取剩余的 2 条");
        // 6 条：末页 1 条；5 条：单页 5 条。
        assert_eq!(items[..6][memory_page_bounds(2, 6)], [5]);
        assert_eq!(items[..5][memory_page_bounds(1, 5)], [0, 1, 2, 3, 4]);
        // 0 条：空切片，不越界。
        assert!(items[memory_page_bounds(1, 0)].is_empty());
        // 越界页先收进范围再切（不会切出空页/全空）。
        assert_eq!(items[memory_page_bounds(9, 12)], [10, 11]);
    }

    /// 页码 clamp：数据刷新后总页数变小要收进范围；0 条收成 1。
    #[test]
    fn 记忆页码收进范围() {
        assert_eq!(clamp_memory_page(3, 1), 1, "总页数降到 1 时第 3 页收成第 1 页");
        assert_eq!(clamp_memory_page(3, 6), 2, "6 条只有 2 页，第 3 页收成第 2 页（不无脑回第 1 页）");
        assert_eq!(clamp_memory_page(2, 12), 2, "范围内保持不动");
        assert_eq!(clamp_memory_page(0, 12), 1, "缺省/0 页码收成第 1 页");
        assert_eq!(clamp_memory_page(1, 0), 1, "空列表页码仍是 1（空态不显示分页行）");
    }

    /// 分页行文案与按钮可用性：首页禁「上一页」、末页禁「下一页」、单页两枚都禁。
    #[test]
    fn 记忆分页行文案与按钮可用性() {
        assert!(memory_pager(1, 0).is_none(), "空列表不加分页行");
        let first = memory_pager(1, 12).expect("12 条有分页行");
        assert_eq!(first.page_count, 3);
        assert_eq!(first.label, "第 1 / 3 页 · 共 12 条");
        assert!(!first.prev_enabled && first.next_enabled, "首页：上一页禁用、下一页可用");
        let middle = memory_pager(2, 12).expect("12 条有分页行");
        assert!(middle.prev_enabled && middle.next_enabled, "中间页两枚都可用");
        let last = memory_pager(3, 12).expect("12 条有分页行");
        assert!(last.prev_enabled && !last.next_enabled, "末页：上一页可用、下一页禁用");
        let single = memory_pager(1, 5).expect("5 条是单页");
        assert!(
            !single.prev_enabled && !single.next_enabled,
            "单页两枚都禁用（没有可翻的方向）"
        );
        // 越界页先 clamp 再给可用性（不出现「第 5 / 2 页」）。
        let clamped = memory_pager(5, 6).expect("6 条有分页行");
        assert_eq!(clamped.page, 2);
        assert_eq!(clamped.label, "第 2 / 2 页 · 共 6 条");
        assert!(clamped.prev_enabled && !clamped.next_enabled);
    }

    fn memory_row(id: usize) -> PanelRow {
        PanelRow {
            id: format!("m{id}"),
            title: format!("记忆 {id}"),
            subtitle: String::new(),
            action: RowAction::Select,
            secondary: RowAction::None,
            enabled: false,
            pick: None,
        }
    }

    fn load_memory(ui: &SettingsUi, total: usize) {
        let mut state = SettingsUi::lock(&ui.panels);
        state.memory = Some(MemoryOverview {
            revision: 1,
            status_text: String::new(),
            items: (0..total).map(memory_row).collect(),
            jobs: Vec::new(),
        });
        state.memory_loaded = true;
    }

    /// 状态走查（本地实例，不触进程级单例）：默认第 1 页 → 翻到末页 → 边界 no-op →
    /// 数据变小后保持页并 clamp → 关窗重建回第 1 页。
    #[test]
    fn 记忆翻页状态随数据收进范围() {
        let ui = SettingsUi::new();
        load_memory(&ui, 12);

        let first = ui.memory_items_view();
        assert_eq!(first.pager.as_ref().map(|pager| pager.page), Some(1), "默认第 1 页");
        assert_eq!(first.panel.rows.len(), 5, "首页 5 条");
        assert_eq!(first.panel.rows[0].id, "m0");
        assert_eq!(
            first.panel.id,
            panels::PANEL_MEMORY_ITEMS,
            "切片面板仍是「已记住」面板（分页没有换面板）"
        );

        ui.step_memory_page(1);
        ui.step_memory_page(1);
        let last = ui.memory_items_view();
        assert_eq!(last.pager.as_ref().map(|pager| pager.page), Some(3));
        assert_eq!(
            last.panel.rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["m10", "m11"],
            "末页 = 12 条里的最后 2 条"
        );
        // 末页再「下一页」：no-op（不是报错，也不回绕到第 1 页）。
        ui.step_memory_page(1);
        assert_eq!(ui.memory_items_view().pager.map(|pager| pager.page), Some(3));
        // 首页再「上一页」：同样 no-op。
        ui.step_memory_page(-1);
        ui.step_memory_page(-1);
        assert_eq!(ui.memory_items_view().pager.map(|pager| pager.page), Some(1));

        // 刷新后条目集变小（12 → 6）：保持第 2 页对应的数据（先拨回第 3 页再缩）。
        ui.step_memory_page(1);
        ui.step_memory_page(1);
        load_memory(&ui, 6);
        let shrunk = ui.memory_items_view();
        assert_eq!(
            shrunk.pager.as_ref().map(|pager| pager.page),
            Some(2),
            "第 3 页收成第 2 页（保持页、不无脑回第 1 页）"
        );
        assert_eq!(shrunk.panel.rows[0].id, "m5", "第 2 页从第 6 条开始");
        assert_eq!(
            SettingsUi::lock(&ui.panels).memory_page,
            2,
            "读取时把收进范围后的页码写回状态"
        );

        // 关窗 = 面板状态整体释放：回默认第 1 页。
        *SettingsUi::lock(&ui.panels) = PanelState::default();
        load_memory(&ui, 12);
        assert_eq!(ui.memory_items_view().pager.map(|pager| pager.page), Some(1));
    }

    /// 筛选取值变化点：值变了回第 1 页；同值重复点击只重拉、不动页码。
    #[test]
    fn 记忆筛选变化回第一页_同值不重置() {
        let ui = SettingsUi::new();
        load_memory(&ui, 12);
        ui.step_memory_page(1);
        ui.step_memory_page(1);
        assert_eq!(ui.memory_items_view().pager.map(|pager| pager.page), Some(3));

        assert!(!ui.note_memory_scope_change(None), "None → None 不是变化");
        assert_eq!(
            ui.memory_items_view().pager.map(|pager| pager.page),
            Some(3),
            "同值筛选不动页码"
        );
        assert!(ui.note_memory_scope_change(Some("user")), "None → user 是变化");
        assert_eq!(
            ui.memory_items_view().pager.map(|pager| pager.page),
            Some(1),
            "取值变化 = 换清单 → 回第 1 页"
        );
        assert!(!ui.note_memory_scope_change(Some("user")), "user → user 不是变化");
        assert!(ui.note_memory_scope_change(None), "user → None 是变化");
    }
}
