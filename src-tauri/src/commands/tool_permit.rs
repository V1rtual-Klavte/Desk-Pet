// src-tauri/src/commands/tool_permit.rs
// ==========================================
// 应用级工具执行许可 —— 有界并发与效果互斥的唯一所有者
//
// 前端在工具真正执行前借用、真实结算后释放（ToolRouter 执行入口）。
// Rust 持有额度：shared_read 走有界共享，exclusive_effect 与其他执行互斥，
// 多个 WebView 共用同一所有者，不为每个窗口各建互不相知的锁。
//
// 共享读上限来自 `ai.loop.maxParallelTools`：前端在每个 run 开始前经
// `tool_permit_set_max_shared_readers` 下发，按运行生效；未下发时用内置默认值，
// 与历史常量一致。上限只约束额度，不改 Harness 的批次调度。
//
// 这里只管理额度与互斥，不接管 Pi 的批次调度；等待可取消，但没有超时自动
// 释放 —— 仍在运行的写任务不许因为等待超时被放开而与他人并发。
// ==========================================

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use tauri::async_runtime::{channel, Sender};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::{rust_debug, rust_warn};

/// 共享读上限的默认值与可配置范围（`ai.loop.maxParallelTools`）。宿主侧唯一的额度定义点：
/// 默认值就是历史常量，前端不复制一份，只把配置里的数字下发到这里。
const DEFAULT_MAX_SHARED_READERS: usize = 4;
const MIN_MAX_SHARED_READERS: usize = 1;
const MAX_MAX_SHARED_READERS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PermitKind {
    Shared,
    Exclusive,
}

impl PermitKind {
    fn parse(raw: &str) -> AppResult<Self> {
        match raw {
            "shared" => Ok(Self::Shared),
            "exclusive" => Ok(Self::Exclusive),
            other => Err(AppError::Tool(format!("未知的许可类型: {other}"))),
        }
    }
}

/// 排队中的等待者；许可被借出后不再保留。
struct Waiter {
    request_id: String,
    kind: PermitKind,
    tx: Sender<Outcome>,
}

enum Outcome {
    Granted,
    Cancelled,
}

/// 一个许可域的额度状态。域按应用数据根区分：Live Test 的临时数据根自带隔离域，
/// 测试流量不会占用或阻塞用户运行的额度。
struct Gate {
    shared_active: usize,
    exclusive_active: bool,
    queue: VecDeque<Waiter>,
    /// 已借出额度的归属：request_id → 类型，释放时据此归还。
    active: HashMap<String, PermitKind>,
    /// 共享读上限；由 `tool_permit_set_max_shared_readers` 在运行开始前下发，
    /// 未下发时等于历史常量，行为不变。
    max_shared_readers: usize,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            shared_active: 0,
            exclusive_active: false,
            queue: VecDeque::new(),
            active: HashMap::new(),
            max_shared_readers: DEFAULT_MAX_SHARED_READERS,
        }
    }
}

impl Gate {
    fn can_admit(&self, kind: PermitKind) -> bool {
        match kind {
            PermitKind::Shared => !self.exclusive_active && self.shared_active < self.max_shared_readers,
            PermitKind::Exclusive => !self.exclusive_active && self.shared_active == 0,
        }
    }

    fn take(&mut self, kind: PermitKind) {
        match kind {
            PermitKind::Shared => self.shared_active += 1,
            PermitKind::Exclusive => self.exclusive_active = true,
        }
    }

    fn give_back(&mut self, kind: PermitKind) {
        match kind {
            PermitKind::Shared => self.shared_active = self.shared_active.saturating_sub(1),
            PermitKind::Exclusive => self.exclusive_active = false,
        }
    }

    /// 就绪即放行队首；等待者已消失（调用被丢弃/窗口失联）时不保留额度。
    fn drain(&mut self) {
        while let Some(kind) = self.queue.front().map(|waiter| waiter.kind) {
            if !self.can_admit(kind) {
                return;
            }
            let Some(waiter) = self.queue.pop_front() else { return };
            self.take(waiter.kind);
            if waiter.tx.try_send(Outcome::Granted).is_err() {
                self.give_back(waiter.kind);
                continue;
            }
            self.active.insert(waiter.request_id, waiter.kind);
        }
    }

    /// 移除仍排队的等待者；已经借出的不算排队，返回 false。
    fn cancel(&mut self, request_id: &str) -> bool {
        let Some(index) = self.queue.iter().position(|waiter| waiter.request_id == request_id) else {
            return false;
        };
        let Some(waiter) = self.queue.remove(index) else { return false };
        // 接收端可能已经消失；发送失败按已取消处理。
        let _ = waiter.tx.try_send(Outcome::Cancelled);
        // 排在前面的独占等待者被取消后，额度可能已经可以放给后面的读；不补这次 drain
        // 会把它们永远留在队列里（没有别的归还事件再把它们唤醒）。
        self.drain();
        true
    }
}

#[derive(Default)]
pub struct ToolPermitPool {
    domains: Mutex<HashMap<String, Gate>>,
}

impl ToolPermitPool {
    /// 中毒按恢复处理：额度状态是纯计数，不承载会半写坏的业务数据。
    fn domains(&self) -> MutexGuard<'_, HashMap<String, Gate>> {
        self.domains.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn domain_key(paths: &AppPaths) -> String {
    paths.data_root.to_string_lossy().to_string()
}

/// 借一个许可。等待期间可被 `tool_permit_cancel` 取消；返回值表示是否真的拿到额度。
#[tauri::command]
pub async fn tool_permit_acquire(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    window: tauri::Window,
    request_id: String,
    kind: String,
    session_id: String,
    run_generation: i64,
    operation_id: String,
) -> AppResult<bool> {
    if request_id.trim().is_empty() {
        return Err(AppError::Tool("许可请求缺少 requestId".into()));
    }
    let kind = PermitKind::parse(&kind)?;
    let domain = domain_key(&paths);
    let label = window.label().to_string();

    let mut receiver = {
        let mut domains = pool.domains();
        let gate = domains.entry(domain).or_default();
        // 同一个 requestId 只能有一份额度：重复借用会让释放语义分裂。
        if gate.active.contains_key(&request_id) || gate.queue.iter().any(|waiter| waiter.request_id == request_id) {
            return Err(AppError::Tool(format!("许可请求重复: {request_id}")));
        }
        if gate.queue.is_empty() && gate.can_admit(kind) {
            gate.take(kind);
            gate.active.insert(request_id.clone(), kind);
            return Ok(true);
        }
        // 队列有等待者时不得插队，否则持续的读请求会让写任务饥饿。
        let (tx, rx) = channel::<Outcome>(1);
        gate.queue.push_back(Waiter { request_id: request_id.clone(), kind, tx });
        rx
    };

    let outcome = receiver.recv().await;
    match outcome {
        Some(Outcome::Granted) => {
            log_permit("借出", &label, &request_id, kind, &session_id, run_generation, &operation_id);
            Ok(true)
        }
        // 取消或接收端失效都按未取得额度处理。
        _ => Ok(false),
    }
}

/// 归还许可。必须在真实执行结算后调用，且只对已借出的 requestId 生效。
#[tauri::command]
pub fn tool_permit_release(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    request_id: String,
) -> AppResult<()> {
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let Some(gate) = domains.get_mut(&domain) else { return Ok(()) };
    let Some(kind) = gate.active.remove(&request_id) else {
        // 重复释放或未借出：不报错，也不能凭空增加额度。
        rust_warn!("工具许可释放时未找到记录: {request_id}");
        return Ok(());
    };
    gate.give_back(kind);
    gate.drain();
    Ok(())
}

/// 取消仍在排队的等待。已经借出的许可不能被这里取消，只能由执行方释放。
#[tauri::command]
pub fn tool_permit_cancel(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    request_id: String,
) -> AppResult<bool> {
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let Some(gate) = domains.get_mut(&domain) else { return Ok(false) };
    Ok(gate.cancel(&request_id))
}

/// 下发共享读上限（`ai.loop.maxParallelTools`）。前端与队列批量策略同一模式：每个 run
/// 开始前把当前配置交给所有者，按运行生效，运行期间不撤销已借出的额度。
///
/// 越界值报错而不是悄悄夹到边界：上限为 0 会让所有读永久排队，而夹边界会让设置页
/// 显示的值与实际生效值不一致。返回实际生效的上限。
#[tauri::command]
pub fn tool_permit_set_max_shared_readers(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    limit: usize,
) -> AppResult<usize> {
    if !(MIN_MAX_SHARED_READERS..=MAX_MAX_SHARED_READERS).contains(&limit) {
        return Err(AppError::Tool(format!(
            "共享读上限超出范围 {MIN_MAX_SHARED_READERS}-{MAX_MAX_SHARED_READERS}: {limit}"
        )));
    }
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let gate = domains.entry(domain).or_default();
    let previous = gate.max_shared_readers;
    gate.max_shared_readers = limit;
    // 提高上限时唤醒有序等待项；降低时不撤销在飞许可，新调用要等占用低于新上限。
    gate.drain();
    if previous != limit {
        rust_debug!("共享读上限下发: {previous} → {limit}");
    }
    Ok(gate.max_shared_readers)
}

/// 当前域额度快照，供诊断使用；不参与调度决策。
#[tauri::command]
pub fn tool_permit_snapshot(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
) -> AppResult<PermitSnapshot> {
    let domain = domain_key(&paths);
    let domains = pool.domains();
    let Some(gate) = domains.get(&domain) else {
        return Ok(PermitSnapshot {
            shared_active: 0,
            exclusive_active: false,
            queued: 0,
            max_shared_readers: DEFAULT_MAX_SHARED_READERS,
        });
    };
    Ok(PermitSnapshot {
        shared_active: gate.shared_active,
        exclusive_active: gate.exclusive_active,
        queued: gate.queue.len(),
        max_shared_readers: gate.max_shared_readers,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermitSnapshot {
    shared_active: usize,
    exclusive_active: bool,
    queued: usize,
    max_shared_readers: usize,
}

fn log_permit(
    phase: &str,
    window: &str,
    request_id: &str,
    kind: PermitKind,
    session_id: &str,
    run_generation: i64,
    operation_id: &str,
) {
    // 归属信息只进日志：许可是额度，不是授权证据。
    rust_debug!(
        "工具许可{phase}: {request_id} | {kind:?} | window={window} session={session_id} gen={run_generation} op={operation_id}"
    );
}
