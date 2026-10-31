//! 只在测试构建存在：`settings/mod.rs` 以 `#[cfg(test)] mod test_support;` 声明。
//!
//! 这里收拢拆分后仍被多个测试子模块共用的夹具（快照构造、记录提交的设置端口替身、
//! 有界等待），以及「未接线端口如实报错」这条不依赖任何业务状态的用例。
//! 条目对 `settings` 子树可见（`pub(super)`），不进入生产构建。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

use super::*;

pub(super) fn snapshot(pairs: &[(&str, SettingsValue)]) -> SettingsSnapshot {
    SettingsSnapshot {
        values: pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect(),
    }
}

pub(super) fn bool_snapshot(key: &str, value: bool) -> SettingsSnapshot {
    snapshot(&[(key, SettingsValue::Bool(value))])
}

/// 记录提交内容的设置端口替身；`fail` 控制写盘成败。
pub(super) struct RecordingPort {
    pub(super) fail: AtomicBool,
    pub(super) commits: Mutex<Vec<Vec<SettingEdit>>>,
}

impl SettingsPort for RecordingPort {
    fn fetch(&self) -> AppResult<SettingsSnapshot> {
        Err(AppError::Other("测试替身未实现 fetch".into()))
    }

    fn commit(&self, changes: &[SettingEdit]) -> AppResult<()> {
        self.commits
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(changes.to_vec());
        if self.fail.load(Ordering::SeqCst) {
            Err(AppError::Other("磁盘只读".into()))
        } else {
            Ok(())
        }
    }

    fn check_update(&self) -> AppResult<()> {
        Err(AppError::Other("测试替身未实现 check_update".into()))
    }
}

/// 有界等待后台线程把状态落进 UI（设置动作是「先返回、后台结算」语义）。
pub(super) fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !condition() {
        assert!(std::time::Instant::now() < deadline, "等待超时：{what}");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[test]
fn 未接线端口如实报错() {
    let port = NullSettingsPort;
    assert!(port.fetch().is_err());
    assert!(port.commit(&[]).is_err());
    assert!(port.check_update().is_err());
    // 人格卡列表同样如实报错（不返回空列表冒充「没有 Card」）。
    assert!(port.cards().is_err());
    // Profile 列表同理（未接线不冒充「没有 Profile」）。
    assert!(port.profiles().is_err());
}
