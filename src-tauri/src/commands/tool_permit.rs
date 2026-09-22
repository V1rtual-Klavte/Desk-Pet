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
//
// 生命周期兜底：每次借出都记下借用者（窗口标签 + 页面实例 id，前端在页面加载时声明）。
// 同一窗口同一时刻只有一个活着的页面实例，前端页面重新加载（Vite 全量热重载、WebView
// 重建）后旧实例的 JS 上下文已经销毁，它既不会归还额度也不会再消费排队项 —— 新实例
// 上线时按这条事实一次性回收。回收只由“借用者已经不存在”触发，不看时间：在飞的
// exclusive_effect 不能被任何时间条件或全量重置放开。
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

/// 借用者身份：Rust 提供的窗口标签 + 前端本次页面加载的实例 id。
///
/// 窗口标签由 Rust 填，前端只补页面实例 id：同一个窗口同一时刻只有一个活着的页面实例，
/// 新实例声明上线时，同窗口下其它实例的额度与排队项都属于已经消失的借用者。
#[derive(Clone, PartialEq, Eq, Debug)]
struct Borrower {
    window: String,
    page: String,
}

impl Borrower {
    fn new(window: &str, page: &str) -> Self {
        Self { window: window.to_string(), page: page.to_string() }
    }

    /// 另一个借用者是否已被本身份取代：同窗口、不同页面实例。
    fn replaces(&self, other: &Self) -> bool {
        self.window == other.window && self.page != other.page
    }
}

/// 已借出的额度：类型与借用者，释放时据此归还。
struct ActiveLease {
    kind: PermitKind,
    borrower: Borrower,
}

/// 排队中的等待者；许可被借出后不再保留。
struct Waiter {
    request_id: String,
    kind: PermitKind,
    borrower: Borrower,
    tx: Sender<Outcome>,
}

enum Outcome {
    Granted,
    Cancelled,
}

/// 释放请求的结算结果。
enum ReleaseOutcome {
    /// 未借出、重复释放或已被回收：不报错，也不能凭空增加额度。
    NotFound,
    /// 调用方不是借出该额度的借用者：拒绝，额度保持不动。
    BorrowerMismatch,
    /// 已归还，等待者可被唤醒。
    Released,
}

/// 一个许可域的额度状态。域按应用数据根区分：Live Test 的临时数据根自带隔离域，
/// 测试流量不会占用或阻塞用户运行的额度。
struct Gate {
    shared_active: usize,
    exclusive_active: bool,
    queue: VecDeque<Waiter>,
    /// 已借出额度的归属：request_id → 额度，释放时据此归还。
    active: HashMap<String, ActiveLease>,
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
            self.active.insert(waiter.request_id, ActiveLease { kind: waiter.kind, borrower: waiter.borrower });
        }
    }

    /// 回收同窗口下其它页面实例的额度与排队项：那些实例已经被 `current` 取代
    /// （页面重新加载），额度不可能再被归还、排队项不可能再被消费。
    ///
    /// 只按借用者身份判定，不看时间；同窗口的当前实例、其它窗口的借用者都不受影响。
    fn reclaim_other_borrowers(&mut self, current: &Borrower) -> PermitReclaim {
        let mut reclaimed = PermitReclaim::default();
        let stale: Vec<String> = self
            .active
            .iter()
            .filter(|(_, lease)| current.replaces(&lease.borrower))
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in stale {
            if let Some(lease) = self.active.remove(&request_id) {
                self.give_back(lease.kind);
                reclaimed.reclaimed_active += 1;
            }
        }
        // 排队项按原顺序留在队列里，只摘掉失效借用者的那些：FIFO 与等待可取消都不变。
        let mut kept = VecDeque::with_capacity(self.queue.len());
        while let Some(waiter) = self.queue.pop_front() {
            if current.replaces(&waiter.borrower) {
                // 接收端可能已经随页面消失；发送失败按已取消处理。
                let _ = waiter.tx.try_send(Outcome::Cancelled);
                reclaimed.reclaimed_queued += 1;
            } else {
                kept.push_back(waiter);
            }
        }
        self.queue = kept;
        // 回收出来的额度可能正好放行仍在等待的借用者。
        self.drain();
        reclaimed
    }

    /// 移除仍排队的等待者；已借出的、或不属于该借用者的都不算，返回 false。
    /// 只作用于调用方自己的排队项：其它窗口/页面不能取消别人的等待。
    fn cancel(&mut self, request_id: &str, borrower: &Borrower) -> bool {
        let Some(index) = self.queue.iter().position(|waiter| {
            waiter.request_id == request_id && &waiter.borrower == borrower
        }) else {
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

    /// 按借用者校验后归还额度：只有借出它的借用者能释放。
    /// 别的窗口/页面即使拿到 requestId 也不能归还（更不能借机放开在飞的独占效果）。
    fn release(&mut self, request_id: &str, borrower: &Borrower) -> ReleaseOutcome {
        let Some(lease) = self.active.get(request_id) else {
            return ReleaseOutcome::NotFound;
        };
        if &lease.borrower != borrower {
            return ReleaseOutcome::BorrowerMismatch;
        }
        if let Some(lease) = self.active.remove(request_id) {
            self.give_back(lease.kind);
            self.drain();
        }
        ReleaseOutcome::Released
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
    borrower_id: String,
    session_id: String,
    run_generation: i64,
    operation_id: String,
) -> AppResult<bool> {
    if request_id.trim().is_empty() {
        return Err(AppError::Tool("许可请求缺少 requestId".into()));
    }
    if borrower_id.trim().is_empty() {
        return Err(AppError::Tool("许可请求缺少 borrowerId".into()));
    }
    let kind = PermitKind::parse(&kind)?;
    let domain = domain_key(&paths);
    let label = window.label().to_string();
    let borrower = Borrower::new(&label, &borrower_id);

    let mut receiver = {
        let mut domains = pool.domains();
        let gate = domains.entry(domain).or_default();
        // 同一个 requestId 只能有一份额度：重复借用会让释放语义分裂。
        if gate.active.contains_key(&request_id) || gate.queue.iter().any(|waiter| waiter.request_id == request_id) {
            return Err(AppError::Tool(format!("许可请求重复: {request_id}")));
        }
        if gate.queue.is_empty() && gate.can_admit(kind) {
            gate.take(kind);
            gate.active.insert(request_id.clone(), ActiveLease { kind, borrower });
            return Ok(true);
        }
        // 队列有等待者时不得插队，否则持续的读请求会让写任务饥饿。
        let (tx, rx) = channel::<Outcome>(1);
        gate.queue.push_back(Waiter { request_id: request_id.clone(), kind, borrower, tx });
        rx
    };

    let outcome = receiver.recv().await;
    match outcome {
        Some(Outcome::Granted) => {
            log_permit("借出", &label, &borrower_id, &request_id, kind, &session_id, run_generation, &operation_id);
            Ok(true)
        }
        // 取消或接收端失效都按未取得额度处理。
        _ => Ok(false),
    }
}

/// 借用者上线：页面实例声明自己接管该窗口的额度归属，并一次性回收同一窗口下前一个
/// 页面实例留下的在飞额度与排队项。
///
/// 触点是页面加载（Vite 全量热重载、WebView 重建）：旧实例的 JS 上下文已经销毁，它
/// 无法再归还额度，后续工具会一直卡在额度上，直到进程退出。这里不做超时释放，也不
/// 触碰其它窗口或同一实例的额度 —— 在飞的 exclusive_effect 不能被回收放开。
#[tauri::command]
pub fn tool_permit_attach(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    window: tauri::Window,
    borrower_id: String,
) -> AppResult<PermitReclaim> {
    if borrower_id.trim().is_empty() {
        return Err(AppError::Tool("许可借用者缺少 borrowerId".into()));
    }
    let borrower = Borrower::new(window.label(), &borrower_id);
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let gate = domains.entry(domain).or_default();
    let reclaimed = gate.reclaim_other_borrowers(&borrower);
    if reclaimed.reclaimed_active > 0 || reclaimed.reclaimed_queued > 0 {
        // 生产环境出现孤儿额度意味着一个页面实例在持有额度时消失，按警告记录。
        rust_warn!(
            "工具许可回收失效借用者的额度: window={} page={} active={} queued={}",
            borrower.window,
            borrower.page,
            reclaimed.reclaimed_active,
            reclaimed.reclaimed_queued
        );
    }
    Ok(reclaimed)
}

/// 归还许可。必须在真实执行结算后调用，且只对借出它的借用者生效。
#[tauri::command]
pub fn tool_permit_release(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    window: tauri::Window,
    borrower_id: String,
    request_id: String,
) -> AppResult<()> {
    let borrower = Borrower::new(window.label(), &borrower_id);
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let Some(gate) = domains.get_mut(&domain) else { return Ok(()) };
    match gate.release(&request_id, &borrower) {
        ReleaseOutcome::Released => Ok(()),
        ReleaseOutcome::NotFound => {
            // 重复释放、未借出或已被回收：不报错，也不能凭空增加额度。
            rust_warn!("工具许可释放时未找到记录: {request_id}");
            Ok(())
        }
        ReleaseOutcome::BorrowerMismatch => {
            // 别的窗口/页面不能归还（或借机放开）他人的在飞额度。
            rust_warn!(
                "工具许可释放被借用者不符拒绝: window={} request={request_id}",
                borrower.window
            );
            Err(AppError::Tool("许可释放者与借用者不符".into()))
        }
    }
}

/// 取消仍在排队的等待。已经借出的许可不能被这里取消，只能由执行方释放；
/// 同样只对调用方自己的排队项生效。
#[tauri::command]
pub fn tool_permit_cancel(
    pool: State<'_, ToolPermitPool>,
    paths: State<'_, AppPaths>,
    window: tauri::Window,
    borrower_id: String,
    request_id: String,
) -> AppResult<bool> {
    let borrower = Borrower::new(window.label(), &borrower_id);
    let domain = domain_key(&paths);
    let mut domains = pool.domains();
    let Some(gate) = domains.get_mut(&domain) else { return Ok(false) };
    Ok(gate.cancel(&request_id, &borrower))
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

/// 借用者上线时的回收结果：失效借用者留下的在飞额度与排队项数量。
/// 归零表示同窗口下没有孤儿额度；非零是「一个页面实例带着额度消失」的证据。
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermitReclaim {
    reclaimed_active: usize,
    reclaimed_queued: usize,
}

fn log_permit(
    phase: &str,
    window: &str,
    page: &str,
    request_id: &str,
    kind: PermitKind,
    session_id: &str,
    run_generation: i64,
    operation_id: &str,
) {
    // 归属信息只进日志：许可是额度，不是授权证据。
    rust_debug!(
        "工具许可{phase}: {request_id} | {kind:?} | window={window} page={page} session={session_id} gen={run_generation} op={operation_id}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::async_runtime::Receiver;

    /// 直接构造额度归属，绕过 IPC：这里只验证 Gate 自己的回收判定。
    /// Live Test 只能从一个窗口发起调用，跨窗口隔离只有这层能覆盖。
    fn lease(gate: &mut Gate, request_id: &str, kind: PermitKind, window: &str, page: &str) {
        gate.take(kind);
        gate.active.insert(request_id.into(), ActiveLease { kind, borrower: Borrower::new(window, page) });
    }

    fn enqueue(gate: &mut Gate, request_id: &str, kind: PermitKind, window: &str, page: &str) -> Receiver<Outcome> {
        let (tx, rx) = channel::<Outcome>(1);
        gate.queue.push_back(Waiter { request_id: request_id.into(), kind, borrower: Borrower::new(window, page), tx });
        rx
    }

    #[test]
    fn reclaim_takes_only_the_stale_page_in_the_same_window() {
        let mut gate = Gate::default();
        lease(&mut gate, "stale-a", PermitKind::Shared, "main", "p1");
        lease(&mut gate, "stale-b", PermitKind::Shared, "main", "p1");
        // 其它窗口的借用者不是同一个身份，回收不能碰。
        lease(&mut gate, "sim-write", PermitKind::Exclusive, "sim", "p2");
        // 另一个窗口恰好用同一个页面实例 id：窗口标签是身份的一半，不能只看 id。
        lease(&mut gate, "sim-same-page", PermitKind::Shared, "sim", "p1");
        let mut stale_wait = enqueue(&mut gate, "stale-wait", PermitKind::Shared, "main", "p1");
        let mut live_wait = enqueue(&mut gate, "live-wait", PermitKind::Shared, "sim", "p2");

        let reclaimed = gate.reclaim_other_borrowers(&Borrower::new("main", "p2"));

        assert_eq!(reclaimed.reclaimed_active, 2, "同窗口旧实例的在飞额度应被回收");
        assert_eq!(reclaimed.reclaimed_queued, 1, "同窗口旧实例的排队项应被回收");
        assert_eq!(gate.shared_active, 1, "其它窗口的共享额度不受影响");
        assert!(gate.exclusive_active, "其它窗口的在飞独占效果不能被回收");
        assert!(gate.active.contains_key("sim-write") && gate.active.contains_key("sim-same-page"));
        assert!(matches!(stale_wait.try_recv(), Ok(Outcome::Cancelled)), "失效借用者的排队项按取消结算");
        assert!(live_wait.try_recv().is_err(), "仍在运行的借用者不能被顺手放行或取消");
        assert_eq!(gate.queue.len(), 1, "只摘掉失效借用者的排队项");
    }

    #[test]
    fn reclaim_never_touches_the_current_page_or_releases_in_flight_work() {
        let mut gate = Gate::default();
        lease(&mut gate, "write", PermitKind::Exclusive, "main", "p2");
        let mut waiting = enqueue(&mut gate, "waiting-read", PermitKind::Shared, "main", "p2");

        let reclaimed = gate.reclaim_other_borrowers(&Borrower::new("main", "p2"));

        assert_eq!((reclaimed.reclaimed_active, reclaimed.reclaimed_queued), (0, 0), "同一页面实例重复上线必须是空操作");
        assert!(gate.exclusive_active, "在飞的独占效果不能被回收");
        assert_eq!(gate.queue.len(), 1, "等待中的读不能在独占期间被放开");
        assert!(waiting.try_recv().is_err());
    }

    #[test]
    fn reclaimed_capacity_wakes_live_waiters_in_order() {
        let mut gate = Gate::default();
        gate.max_shared_readers = 1;
        lease(&mut gate, "stale", PermitKind::Shared, "main", "p1");
        let mut live_wait = enqueue(&mut gate, "live-wait", PermitKind::Shared, "sim", "p2");

        let reclaimed = gate.reclaim_other_borrowers(&Borrower::new("main", "p2"));

        assert_eq!(reclaimed.reclaimed_active, 1);
        assert!(matches!(live_wait.try_recv(), Ok(Outcome::Granted)), "回收出的额度应放行仍在等待的借用者");
        assert!(gate.active.contains_key("live-wait"));
        assert_eq!(gate.shared_active, 1);
    }

    #[test]
    fn release_and_cancel_only_apply_to_the_borrowing_page() {
        let mut gate = Gate::default();
        lease(&mut gate, "mine", PermitKind::Exclusive, "main", "p1");
        enqueue(&mut gate, "queued", PermitKind::Shared, "main", "p1");

        // 其它窗口即使拿到 requestId 也不能释放在飞额度或取消别人的排队项。
        let intruder = Borrower::new("sim", "p2");
        assert!(matches!(gate.release("mine", &intruder), ReleaseOutcome::BorrowerMismatch));
        assert!(gate.exclusive_active, "被拒绝的释放必须保持额度不动");
        assert!(!gate.cancel("queued", &intruder));
        assert_eq!(gate.queue.len(), 1, "其它借用者的排队项不能被取消");

        // 同窗口但不同页面实例（已失效的旧实例）同样不能动新实例的额度。
        let stale_page = Borrower::new("main", "p0");
        assert!(matches!(gate.release("mine", &stale_page), ReleaseOutcome::BorrowerMismatch));
        assert!(gate.exclusive_active);

        // 真正的借用者可以释放；释放后重复释放是 NotFound，不报错也不加额度。
        assert!(matches!(gate.release("mine", &Borrower::new("main", "p1")), ReleaseOutcome::Released));
        assert!(!gate.exclusive_active);
        assert!(matches!(gate.release("mine", &Borrower::new("main", "p1")), ReleaseOutcome::NotFound));
    }
}
