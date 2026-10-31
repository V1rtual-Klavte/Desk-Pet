//! 分派器集成测试：以空参真调命令面，钉住分派臂、参数名与错误保真。

use super::*;
use crate::host::native_ports::NativeAssetScope;
use crate::host::{FileDialogPort, LifecyclePort};
use crate::ipc::blob::parse_host_blob_marker;
use crate::ipc::protocol::RunScope;
use crate::ui::{MainThreadQueue, UiHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;

// ── 测试替身 ──

struct FakeWindowPort;

impl WindowPort for FakeWindowPort {
    fn show(&self, window: WindowId, _focus: bool) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn hide(&self, window: WindowId) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn focus(&self, window: WindowId) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn set_level(&self, window: WindowId, _level: crate::host::WindowLevel) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn present(&self, window: WindowId) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn visibility(&self, window: WindowId) -> AppResult<crate::host::WindowVisibility> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn set_position(&self, window: WindowId, _x: i32, _y: i32) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
    fn open_devtools(&self, window: WindowId) -> AppResult<()> {
        Err(AppError::Other(format!(
            "测试替身无窗口: {}",
            window.label()
        )))
    }
}

struct FakeDialogs;

impl FileDialogPort for FakeDialogs {
    fn pick_images(&self) -> AppResult<Vec<String>> {
        Ok(Vec::new())
    }
    fn pick_file(&self) -> AppResult<Option<String>> {
        Ok(None)
    }
    fn save_file(&self, _name: &str, _label: &str, _ext: &str) -> AppResult<Option<String>> {
        Ok(None)
    }
}

struct FakeLifecycle(Arc<AtomicUsize>);

impl LifecyclePort for FakeLifecycle {
    fn exit(&self, _code: i32) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn restart(&self) -> AppResult<()> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

/// 在别的线程创建队列：测试线程不是「UI 主线程」且没有唤醒器，
/// 凡触达原生 UI 的分派臂都会如实回「UI 尚未启动」，不会执行 AppKit/Win32。
fn isolated_ui_handle() -> UiHandle {
    std::thread::spawn(|| UiHandle::new(MainThreadQueue::new()))
        .join()
        .unwrap()
}

struct TestEnv {
    dispatcher: NativeDispatcher,
    root: PathBuf,
    blobs: BlobRegistry,
    scope: RunScope,
    lifecycle_calls: Arc<AtomicUsize>,
}

impl TestEnv {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "deskpet-dispatch-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        for dir in [
            "memory",
            "sessions",
            "personality",
            "profiles",
            "skills",
            "settings",
            "logs",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let paths = test_paths(&root);
        let lifecycle_calls = Arc::new(AtomicUsize::new(0));
        let dispatcher = NativeDispatcher::new(NativeDispatcherDeps {
            paths,
            caller: WindowId::Main,
            ui: isolated_ui_handle(),
            windows: Arc::new(FakeWindowPort),
            monitor: Arc::new(MonitorState::default()),
            mcp: Arc::new(mcp_bridge::McpPool::default()),
            bash: Arc::new(tool_exec::BashPool::default()),
            permits: Arc::new(tool_permit::ToolPermitPool::default()),
            dialogs: Arc::new(FakeDialogs),
            assets: Arc::new(NativeAssetScope::new()),
            lifecycle: Arc::new(FakeLifecycle(lifecycle_calls.clone())),
            host_link: Arc::new(HostLink::new()),
            audio: crate::audio::native_audio(isolated_ui_handle()),
        });
        Self {
            dispatcher,
            root,
            blobs: BlobRegistry::new(),
            scope: RunScope {
                app_epoch: "test-epoch".into(),
                node_epoch: 1,
                ..Default::default()
            },
            lifecycle_calls,
        }
    }

    fn call(&self, method: &str, args: Value) -> AppResult<Value> {
        self.dispatcher
            .dispatch_with(method, args, &self.blobs, &self.scope)
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        // SQLite 文件在 Windows 上可能仍被句柄持有；清理失败不影响断言。
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        data_root: root.to_path_buf(),
        memory: root.join("memory"),
        sessions: root.join("sessions"),
        personality: root.join("personality"),
        profiles: root.join("profiles"),
        skills: root.join("skills"),
        settings: root.join("settings"),
        logs: root.join("logs"),
        config_file: root.join("settings").join("CONFIG.yaml"),
        runtime_mode: "test",
        seed_personality_cards: root.join("seeds/personality/cards"),
        seed_profiles: root.join("seeds/profiles"),
        seed_skills: root.join("seeds/skills"),
    }
}

fn str_path(path: &Path) -> Value {
    Value::String(path.to_string_lossy().into_owned())
}

/// 从 `types.ts` 的 `HostCommandMap` 块里抽出命令名（行首恰好两格缩进的
/// snake_case 键）。冻结件就是唯一清单，Rust 侧不再维护第二份拷贝。
fn matrix_command_names() -> Vec<String> {
    const TYPES_TS: &str = include_str!("../../../../../src/services/host/types.ts");
    let start = TYPES_TS
        .find("export type HostCommandMap = {")
        .expect("types.ts 必须包含 HostCommandMap");
    let rest = &TYPES_TS[start..];
    let end = rest
        .find("\n}\n")
        .expect("HostCommandMap 块必须有顶层结束括号");
    let mut names = Vec::new();
    for line in rest[..end].lines() {
        // 恰好两格缩进（更深缩进的 args/result 字段与注释不算键行）。
        let Some(candidate) = line.strip_prefix("  ") else {
            continue;
        };
        if candidate.starts_with(' ')
            || candidate.starts_with("//")
            || candidate.starts_with("*")
        {
            continue;
        }
        let Some((key, _)) = candidate.split_once(": ") else {
            continue;
        };
        if !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            names.push(key.to_string());
        }
    }
    names
}

// ── 矩阵覆盖（核心验收物）──

#[test]
fn types_ts的全部命令都有分派臂() {
    // 本用例对**每条命令**空参真调用一遍分派：其中 `apply_theme` 会走
    // `UiHandle::apply_theme` → `theme::store`（不经平台端口的进程级全局），
    // 与 `ui::theme` 的驻留断言共用同一份全局 —— 按那里的纪律拿同一把锁串行，
    // 否则会互踩出偶发红（空参收拢为默认主题，读方无感，写方互斥即可）。
    let _guard = crate::ui::theme::GLOBAL_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let names = matrix_command_names();
    // 计数以 `types.ts` 实际内容为准：MCP 桥裸行收发把 `mcp_send` 换成
    // `mcp_write` / `mcp_read`（净 +1），`profile_clone` 随「新建 Profile」改造删除
    // （-1），分项已复核为「107 冻结 + 21 扩展」。最近三条：设置页管理面
    // 带来的通用文件对话框 `pick_file_open` / `pick_file_save`（配置/资料导入导出与
    // Skill 上传选路径；图片过滤器的 `pick_profile_asset` 不适配）与自动呼出开关
    // `set_popup_auto_show`（`general.popup.autoPopupOnMessage`，宿主存 flag、由原生 UI
    // 自行裁决呼出）—— 补登记时一并把这条计数改到位。设置页 Card 管理本批追加
    // `personality_file_delete`（人格文件域删除，只删普通文件、拒绝链接叶子），
    // 分项随之变为「107 冻结 + 22 扩展」。
    // 本批追加 `memory_pending_source_count`（dreaming 开作业前查水位之后有无待处理来源；
    // 漏登记会让整理链条「跳过」变成未定义行为）—— 分项随之变为「107 冻结 + 23 扩展」。
    // 自带 MCP 批次追加凭据读写四条（`mcp_credential_set` / `_delete` / `_status` / `_get`：
    // 令牌存自有 SQLite、不写 CONFIG；漏登记会让「设置面写不进令牌」变成未知方法）
    // —— 分项随之变为「107 冻结 + 27 扩展」。
    // 本批追加 `chat_delete_session_images`（删会话连带清理托管聊天图片；漏登记会让
    // 删会话的图片清理成为未知方法，僵尸文件只能等 200 上限自然淘汰）—— 分项变为
    // 「107 冻结 + 28 扩展」。
    // 折叠批次追加 `session_write_text`（会话根专用写入路径：折叠结果超工具面 5 MiB
    // 时由它落地；漏登记会让折叠结果写不出去、`too-large` 无声回归）—— 分项变为
    // 「107 冻结 + 29 扩展」。
    // 会话原文索引追加五条 conversation_*，分项为「107 冻结 + 34 扩展」。
    // 统一调度批次追加 scheduler_state / schedule_query / schedule_change
    // （内部触发账本与用户任务受限命令）—— 计数更新为 145。
    assert_eq!(names.len(), 145, "HostCommandMap 条数（以 types.ts 为准）");
    for name in [
        "scheduler_state",
        "schedule_query",
        "schedule_change",
        "conversation_index_status",
        "conversation_index_replace",
        "conversation_index_prune",
        "conversation_search",
        "conversation_term_check",
        "conversation_context",
    ] {
        assert!(
            names.contains(&name.to_string()),
            "新会话检索命令未登记: {name}"
        );
    }
    assert!(names.contains(&"init_memory_files".to_string()));
    assert!(names.contains(&"e2e_memory_reset".to_string()));
    // A2 追加的两条必须在分派面上（本测试只对账「有臂」，行为见下方专项测试）。
    assert!(names.contains(&"apply_chat_projection".to_string()));
    assert!(names.contains(&"apply_titlebar_status".to_string()));
    // 音频重建的两条（见上）：漏登记会让「UI 承诺了不存在的能力」。
    assert!(names.contains(&"audio_play_wav".to_string()));
    assert!(names.contains(&"ui_set_sound_cues".to_string()));
    // 主题批次追加的一条：`appearance.theme` 的 Node → 宿主下发。
    // 漏登记会让「设置页选的主题推送不进来」，界面永远停在默认主题。
    assert!(names.contains(&"apply_theme".to_string()));
    // 本批追加的文件对话框两条（见上）：漏登记会让「Node 承诺了不存在的选路径能力」。
    assert!(names.contains(&"pick_file_open".to_string()));
    assert!(names.contains(&"pick_file_save".to_string()));
    // 本批追加的自动呼出开关（见上）：漏登记会让「设置里开了开关但推送无声失败」。
    assert!(names.contains(&"set_popup_auto_show".to_string()));

    let env = TestEnv::new("matrix");
    for name in &names {
        let outcome = env.call(name, json!({}));
        if let Err(error) = outcome {
            let message = error.to_string();
            assert!(
                !message.starts_with(OUTSIDE_MATRIX_PREFIX),
                "命令 {name} 没有分派臂：{message}"
            );
        }
    }
}

#[test]
fn 矩阵外的方法回明确错误而不是静默忽略() {
    let env = TestEnv::new("outside");
    let error = env.call("not_a_real_command", json!({})).unwrap_err();
    assert!(
        error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX),
        "{error}"
    );
}

// ── 参数名逐字对齐（camelCase）──

#[test]
fn 参数名必须与矩阵逐字一致() {
    let env = TestEnv::new("argnames");
    // 必填参数的另一个大小写形态一律 CONFIG 错误（不是被忽略后走默认值）。
    let snake = env.call(
        "profile_file_write",
        json!({ "profile_id": "p1", "relative_path": "a.txt", "content": [1] }),
    );
    assert_eq!(snake.unwrap_err().code(), "CONFIG");
    let camel = env.call(
        "profile_file_write",
        json!({ "profileId": "p1", "relativePath": "a.txt", "content": [1] }),
    );
    assert!(camel.is_ok(), "{camel:?}");

    // 数值参数名逐字：limit（tool_permit_set_max_shared_readers）。
    let wrong = env.call("tool_permit_set_max_shared_readers", json!({ "max": 4 }));
    assert_eq!(wrong.unwrap_err().code(), "CONFIG");
    let right = env.call("tool_permit_set_max_shared_readers", json!({ "limit": 4 }));
    assert_eq!(right.unwrap(), json!(4));
}

// ── 文件读写与 blob 往返 ──

#[test]
fn 文件读写往返且二进制结果走blob通道() {
    let env = TestEnv::new("fs");
    let target = env.root.join("workspace/hello.txt");

    let written = env
        .call(
            "file_write",
            json!({ "path": str_path(&target), "content": "你好，桌宠", "maxBytes": null }),
        )
        .unwrap();
    assert_eq!(written, json!({ "success": true }));

    let read = env
        .call(
            "file_read",
            json!({ "path": str_path(&target), "maxBytes": null }),
        )
        .unwrap();
    assert_eq!(read["content"], json!("你好，桌宠"));
    assert_eq!(read["size"], json!(15));

    let exists = env
        .call("file_exists", json!({ "path": str_path(&target) }))
        .unwrap();
    assert_eq!(exists, json!(true));

    // 二进制结果：结果是 $hostBlobRef 标记，句柄内容与写入字节一致。
    let marker = env
        .call("file_read_binary", json!({ "path": str_path(&target) }))
        .unwrap();
    let blob = parse_host_blob_marker(&marker).expect("二进制结果必须是 blob 标记");
    assert_eq!(blob.scope.app_epoch, env.scope.app_epoch);
    let bytes = env.blobs.open_read(&blob.id, &env.scope).unwrap();
    assert_eq!(&bytes[..], "你好，桌宠".as_bytes());
}

#[test]
fn profile与人格文件的字节参数从数字数组解码() {
    let env = TestEnv::new("bytes");

    // 模拟桥物化后的 `$wireBlob`：content 是 JSON number 数组。
    let written = env
        .call(
            "profile_file_write",
            json!({
                "profileId": "sugar-pink",
                "relativePath": "materials/L0/body.bin",
                "content": [0, 1, 2, 255]
            }),
        )
        .unwrap();
    assert_eq!(written, Value::Null);
    let marker = env
        .call(
            "profile_file_read",
            json!({ "profileId": "sugar-pink", "relativePath": "materials/L0/body.bin" }),
        )
        .unwrap();
    let blob = parse_host_blob_marker(&marker).unwrap();
    assert_eq!(
        &env.blobs.open_read(&blob.id, &env.scope).unwrap()[..],
        &[0, 1, 2, 255]
    );

    // 越界字节值如实报错，不截断。
    let bad = env.call(
        "personality_file_write",
        json!({ "path": "stages/x.json", "content": [256] }),
    );
    assert_eq!(bad.unwrap_err().code(), "CONFIG");

    let absolute = env
        .call(
            "personality_file_write",
            json!({ "path": "stages/x.json", "content": [123, 34, 125] }),
        )
        .unwrap();
    let absolute = std::path::PathBuf::from(absolute.as_str().unwrap());
    assert!(
        absolute.ends_with(Path::new("personality").join("stages").join("x.json")),
        "{absolute:?}"
    );

    let marker = env
        .call("personality_file_read", json!({ "path": "stages/x.json" }))
        .unwrap();
    let blob = parse_host_blob_marker(&marker).unwrap();
    assert_eq!(
        &env.blobs.open_read(&blob.id, &env.scope).unwrap()[..],
        b"{\"}"
    );

    let list = env
        .call("personality_file_list", json!({ "dirPath": "stages" }))
        .unwrap();
    assert_eq!(list, json!(["x.json"]));
}

// ── 路径与配置 ──

#[test]
fn 运行时路径解析与越权拒绝() {
    let env = TestEnv::new("paths");
    let resolved = env
        .call(
            "resolve_runtime_path",
            json!({ "scope": "sessions", "segments": ["a", "b.json"] }),
        )
        .unwrap();
    let expected = env
        .root
        .join("sessions")
        .join("a")
        .join("b.json")
        .to_string_lossy()
        .into_owned();
    assert_eq!(resolved, Value::String(expected));

    let escape = env.call(
        "resolve_runtime_path",
        json!({ "scope": "sessions", "segments": [".."] }),
    );
    assert_eq!(escape.unwrap_err().code(), "PATH_ESCAPE");
    let unknown = env.call(
        "resolve_runtime_path",
        json!({ "scope": "nope", "segments": [] }),
    );
    assert!(unknown.is_err());

    let paths = env.call("get_runtime_paths", json!({})).unwrap();
    assert_eq!(paths["runtimeMode"], json!("test"));
    assert!(paths["configFile"]
        .as_str()
        .unwrap()
        .ends_with("CONFIG.yaml"));
}

#[test]
fn 会话ui状态读写往返() {
    let env = TestEnv::new("session-ui");
    assert_eq!(
        env.call("read_session_ui_state", json!({})).unwrap(),
        Value::Null
    );
    env.call(
        "write_session_ui_state",
        json!({ "content": "{\"active\":null}" }),
    )
    .unwrap();
    assert_eq!(
        env.call("read_session_ui_state", json!({})).unwrap(),
        json!("{\"active\":null}")
    );
}

// ── 错误保真 ──

#[test]
fn 结构化错误码不经分派层退化() {
    let env = TestEnv::new("errors");
    // 凭据路径：词法优先，路径不存在也报 SENSITIVE_PATH。
    let sensitive = env
        .call(
            "file_read",
            json!({ "path": str_path(&env.root.join(".ssh/id_rsa")) }),
        )
        .unwrap_err();
    assert_eq!(sensitive.code(), "SENSITIVE_PATH");

    let missing = env
        .call("session_read_text", json!({ "path": "missing.jsonl" }))
        .unwrap_err();
    assert_eq!(missing.code(), "PATH_NOT_FOUND");

    let escape = env
        .call("session_read_text", json!({ "path": "../outside.jsonl" }))
        .unwrap_err();
    assert_eq!(escape.code(), "PATH_ESCAPE");

    // 已知有消费者按码分支的 MEMORY_CONFLICT 由域实现透出（此处验证未知 id 不 panic 且走结构化错误）。
    let bad_restore = env
        .call("memory_restore", json!({ "backupPath": "nope.sqlite3" }))
        .unwrap_err();
    assert_eq!(bad_restore.code(), "PATH_NOT_FOUND");
}

// ── 记忆：惰性打开 + actor 门禁映射 ──

#[test]
fn 记忆命令惰性打开存储且往返结构化() {
    let env = TestEnv::new("memory");
    let initialized = env.call("init_memory_files", json!({})).unwrap();
    assert_eq!(
        initialized,
        Value::String(env.root.join("memory").to_string_lossy().into_owned())
    );

    let status = env.call("memory_status", json!({})).unwrap();
    assert!(status["revision"].is_i64(), "{status}");
    let base = status["revision"].as_i64().unwrap();

    let revision = env
        .call(
            "memory_apply_change",
            json!({
                "operationId": "test-clear",
                "baseRevision": base,
                "action": "clear",
                "actor": "internal",
                "conversationFences": []
            }),
        )
        .unwrap();
    assert!(revision.is_i64());

    let listed = env.call("memory_list", json!({ "limit": 10 })).unwrap();
    assert_eq!(listed, json!([]));
    assert_eq!(
        env.call("memory_detail", json!({ "id": "nope" })).unwrap(),
        Value::Null
    );
}

// ── MCP 凭据：分派臂、camelCase 参数与「状态不回值」 ──

#[test]
fn mcp凭据命令往返且状态不回值() {
    let env = TestEnv::new("mcp-credentials");
    env.call(
        "mcp_credential_set",
        json!({ "server": "github", "var": "GITHUB_TOKEN", "value": "probe-token" }),
    )
    .unwrap();
    assert_eq!(
        env.call(
            "mcp_credential_get",
            json!({ "server": "github", "var": "GITHUB_TOKEN" })
        )
        .unwrap(),
        json!("probe-token")
    );
    // 名单命令只回变量名：值不得出现在 status 回执里。
    let status = env
        .call("mcp_credential_status", json!({ "server": "github" }))
        .unwrap();
    assert_eq!(status, json!(["GITHUB_TOKEN"]));
    assert!(!status.to_string().contains("probe-token"), "{status}");
    // 未设置也是成功回执（null），由 Node 按「变量缺失」如实失败。
    assert_eq!(
        env.call(
            "mcp_credential_get",
            json!({ "server": "github", "var": "OTHER" })
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        env.call(
            "mcp_credential_delete",
            json!({ "server": "github", "var": "GITHUB_TOKEN" })
        )
        .unwrap(),
        json!(true)
    );
    assert_eq!(
        env.call(
            "mcp_credential_delete",
            json!({ "server": "github", "var": "GITHUB_TOKEN" })
        )
        .unwrap(),
        json!(false)
    );
    // 空值拒绝走结构化 CONFIG（不静默存空、不折成成功）。
    assert_eq!(
        env.call(
            "mcp_credential_set",
            json!({ "server": "github", "var": "GITHUB_TOKEN", "value": "   " })
        )
        .unwrap_err()
        .code(),
        "CONFIG"
    );
}

#[test]
fn 记忆actor映射与既定窗口门禁一致() {
    // 主窗：LLM 记忆工具（绑定可信用户输入）。
    assert_eq!(
        memory_change_window_label(WindowId::Main, "current_input", "add", None).unwrap(),
        "main"
    );
    // 主窗：聊天气泡「记住这条」= user_ui_current（add + 可信会话）。
    assert_eq!(
        memory_change_window_label(WindowId::Main, "user_ui", "add", Some("s-1")).unwrap(),
        "main"
    );
    // 设置面治理动作（纠正/忘记/核心画像）。
    assert_eq!(
        memory_change_window_label(WindowId::Main, "user_ui", "update", None).unwrap(),
        "settings"
    );
    assert_eq!(
        memory_change_window_label(WindowId::Main, "internal", "clear", None).unwrap(),
        "main"
    );
    // E2E 隔离宿主：只放行 internal。
    assert_eq!(
        memory_change_window_label(WindowId::E2e, "internal", "clear", None).unwrap(),
        "e2e"
    );
    let error =
        memory_change_window_label(WindowId::E2e, "current_input", "add", None).unwrap_err();
    assert_eq!(error.code(), "MEMORY");
    // 未知 actor 不放宽。
    let error = memory_change_window_label(WindowId::Main, "chat", "add", None).unwrap_err();
    assert_eq!(error.code(), "MEMORY");
}

// ── 测试命令护栏 ──

#[test]
fn e2e命令在非隔离宿主如实拒绝() {
    let env = TestEnv::new("e2e");
    assert_eq!(
        env.call("e2e_memory_reset", json!({})).unwrap_err().code(),
        "CONFIG"
    );
    assert_eq!(
        env.call("e2e_memory_performance", json!({ "count": 1000 }))
            .unwrap_err()
            .code(),
        "CONFIG"
    );
    // 宿主级测试协议：明确报「E2E 私有」，不是「矩阵外」。
    let error = env.call("e2e_options", json!({})).unwrap_err();
    assert!(!error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX));
    assert_eq!(error.code(), "CONFIG");
}

// ── 生命周期与宿主请求回执 ──

#[test]
fn 重启命令走生命周期端口且回执按请求号结算() {
    let env = TestEnv::new("restart");
    assert_eq!(env.call("app_restart", json!({})).unwrap(), Value::Null);
    assert_eq!(
        env.lifecycle_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    // 未知请求号：按「已超时」归宿丢弃并留痕，不作为错误上报。
    let late = env.call(
        "host_request_result",
        json!({ "requestId": 999, "ok": true, "result": {} }),
    );
    assert_eq!(late.unwrap(), Value::Null);

    // ok=false 缺 error.code 时按 OTHER 保底，且不 panic。
    let failed = env.call(
        "host_request_result",
        json!({ "requestId": 1, "ok": false }),
    );
    assert!(failed.is_ok());
}

#[test]
fn 未接通的窗口命令如实报错而不是伪造成功() {
    let env = TestEnv::new("windows");
    // 观察快照对窗口读取失败按「不可见/非前台」的既有语义降级（monitor/visibility.rs），
    // 但命令本身仍要成功返回快照。
    let activity = env.call("get_runtime_activity", json!({})).unwrap();
    assert_eq!(activity["isPetVisible"], json!(false));

    // 直接依赖窗口端口的命令：端口失败必须如实透出，不伪造成功。
    assert!(env.call("enhance_settings_window", json!({})).is_err());
    assert!(env.call("enhance_layer_editor_window", json!({})).is_err());
    assert!(env.call("open_devtools", json!({})).is_err());
    // compute_popup_position 的窗口增强失败只留痕（不升级为错误），但参数缺省仍必须报错。
    assert_eq!(
        env.call("compute_popup_position", json!({}))
            .unwrap_err()
            .code(),
        "CONFIG"
    );
}

// ── A2：会话投影与顶栏状态推送 ──

#[test]
fn 会话投影走整帧解析臂且失败如实报错() {
    let env = TestEnv::new("a2-projection");
    // 合法会话侧帧：解析成功并落到聊天单例（测试环境无 UI 队列，只留痕不报错）。
    let applied = env
        .call(
            "apply_chat_projection",
            json!({
                "sessionId": "s1",
                "sessions": [{"id": "s1", "name": "新会话", "createdAt": 0, "interrupted": false}]
            }),
        )
        .unwrap();
    assert_eq!(applied, Value::Null);

    // 缺 sessionId：如实报解析错误（不是矩阵外、不静默丢帧）。
    let broken = env
        .call("apply_chat_projection", json!({ "sessions": [] }))
        .unwrap_err();
    assert!(
        broken.to_string().contains("聊天读模型投影解析失败"),
        "{broken}"
    );
    assert_eq!(broken.code(), "OTHER");
}

#[test]
fn 顶栏状态推送未启动ui时如实报错() {
    let env = TestEnv::new("a2-titlebar");
    // 本测试环境原生 UI 未启动（隔离队列无唤醒器）：平台刷新如实报错，
    // 与其它窗口命令同一口径，不伪造成功。文本/空白回落语义由
    // `ui/titlebar.rs` 的单测覆盖；这里只验证分派臂的参数与透出。
    let outcome = env.call("apply_titlebar_status", json!({ "text": null }));
    let error = outcome.unwrap_err();
    assert!(
        !error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX),
        "{error}"
    );
}
