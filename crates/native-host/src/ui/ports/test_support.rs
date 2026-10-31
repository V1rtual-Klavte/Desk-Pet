//! `ui::ports` 各测试模块共用的夹具（`HostLink` 替身、请求捕获、端口调用助手）。
//!
//! 只在测试构建存在：`super` 以 `#[cfg(test)] mod test_support;` 声明。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{HostLink, HOST_REQUEST_EVENT};
use crate::error::{AppError, AppResult};

pub(super) fn test_link() -> (
    Arc<HostLink>,
    Arc<Mutex<Vec<(String, Value)>>>,
    Arc<AtomicBool>,
) {
    let link = Arc::new(HostLink::new());
    let published: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let installed = Arc::new(AtomicBool::new(false));
    let sink = published.clone();
    let flag = installed.clone();
    link.install_sender(Arc::new(move |event: &str, payload: Value| {
        flag.store(true, Ordering::SeqCst);
        sink.lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((event.to_string(), payload));
        Ok(())
    }));
    (link, published, installed)
}

pub(super) fn last_request(published: &Arc<Mutex<Vec<(String, Value)>>>) -> (u64, String, Value) {
    // 请求可能由子线程投递（`请求结果按回执结算`）：这里**有界等待**它落进 sink。
    // 直接读会与线程调度抢跑 —— 主线程赢时 sink 还是空的，测试假红；
    // 等满期限仍为空才是真失败（没有投递这件事本身）。
    let deadline = Instant::now() + Duration::from_secs(2);
    let (event, payload) = loop {
        if let Some(entry) = published
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last()
            .cloned()
        {
            break entry;
        }
        assert!(Instant::now() < deadline, "必须已投递一条事件");
        std::thread::yield_now();
    };
    assert_eq!(event, HOST_REQUEST_EVENT);
    (
        payload
            .get("requestId")
            .and_then(Value::as_u64)
            .expect("requestId"),
        payload
            .get("method")
            .and_then(Value::as_str)
            .expect("method")
            .to_string(),
        payload.get("args").cloned().unwrap_or(Value::Null),
    )
}

/// 等请求投递（并发下 `last_request` 可能先于工作线程执行）。
pub(super) fn wait_last_request(
    published: &Arc<Mutex<Vec<(String, Value)>>>,
) -> (u64, String, Value) {
    for _ in 0..500 {
        {
            let list = published.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((event, payload)) = list.last().cloned() {
                assert_eq!(event, HOST_REQUEST_EVENT);
                return (
                    payload
                        .get("requestId")
                        .and_then(Value::as_u64)
                        .expect("requestId"),
                    payload
                        .get("method")
                        .and_then(Value::as_str)
                        .expect("method")
                        .to_string(),
                    payload.get("args").cloned().unwrap_or(Value::Null),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("等待宿主请求投递超时");
}

/// 文件对话框替身：`pick_file` 返回注入值（`None` = 用户取消）。
///
/// 元组字段对同域测试模块可见：编辑器测试按生产形状构造替身。
pub(super) struct StubDialogs(pub(super) Option<&'static str>);

impl crate::host::FileDialogPort for StubDialogs {
    fn pick_images(&self) -> AppResult<Vec<String>> {
        Err(AppError::Other("测试替身未实现 pick_images".into()))
    }

    fn pick_file(&self) -> AppResult<Option<String>> {
        Ok(self.0.map(ToString::to_string))
    }

    fn save_file(
        &self,
        _suggested_name: &str,
        _filter_label: &str,
        _extension: &str,
    ) -> AppResult<Option<String>> {
        Err(AppError::Other("测试替身未实现 save_file".into()))
    }
}

/// 调一次端口方法并结算回执：等请求投递 → `check_args` 断言线格式 → 结算
/// `reply` → 返回调用结果（测试线程与端口调用线程分离，与既有用例同构）。
///
/// 每次调用前清空记录：`last_request` 等的是「投递一条事件」，多次调用共用
/// 一个 sink 时，若不清空会读到上一次的请求（假绿）。上一条请求在本函数返回
/// 前已经投递并结算完毕，不会有迟到的旧事件。
pub(super) fn call_port<T: Send + 'static>(
    link: &Arc<HostLink>,
    published: &Arc<Mutex<Vec<(String, Value)>>>,
    expect_method: &str,
    call: impl FnOnce(Arc<HostLink>) -> AppResult<T> + Send + 'static,
    check_args: impl FnOnce(&Value),
    reply: AppResult<Value>,
) -> AppResult<T> {
    published
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
    let thread_link = link.clone();
    let handle = std::thread::spawn(move || call(thread_link));
    let (request_id, method, args) = last_request(published);
    assert_eq!(
        method, expect_method,
        "请求方法名是两侧共用的线格式，逐字钉死"
    );
    check_args(&args);
    assert!(link.complete(request_id, reply), "回执必须结算到在途请求");
    handle.join().expect("端口调用线程不得 panic")
}

/// 断言回执解析失败是「协议违规 + 点名缺失字段」，而不只是「报了某个错」：
/// 错误码必须归 CONFIG，文案必须含字段名 —— 否则用户看到错误也不知道是
/// 哪一侧发了坏回执。
pub(super) fn assert_missing_field(error: AppError, field: &str) {
    assert_eq!(error.code(), "CONFIG", "缺字段是协议违规，必须归 CONFIG");
    assert!(
        error.to_string().contains(field),
        "错误文案要点名缺失字段 {field}，实际: {error}"
    );
}

pub(super) fn test_profiles_root() -> PathBuf {
    PathBuf::from("/tmp/deskpet-test/data/profiles")
}
