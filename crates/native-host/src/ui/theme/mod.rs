//! 主题域：三套预设的 token 表、纹理生成、当前主题的全局快照。
//!
//! ## 权属
//!
//! 与 [`crate::ui::font`] 同款分工：`appearance.theme` 的唯一裁定点在 CONFIG、
//! 由 Node 读取；**Rust 不读 CONFIG、不复制默认值**，只接收推送的主题 id，
//! 归一化后保存为不可变快照，再应用到各窗口。
//!
//! ## 为什么主题不是 Profile 的一部分
//!
//! 主题是产品级预设（三选一，不给用户改值），Profile 只管角色（灵动图层与素材）。
//! 两者正交：换 Profile 不换主题，换主题不换 Profile。Profile 原有的
//! `theme.colors` / `theme.shield` 与 `ui/` 位图已随本次改造删除。
//!
//! ## 只加载选中的主题
//!
//! token 表是三张 `static`（编译进二进制，没有「加载」这一步）；
//! **纹理**才是有代价的部分，按需生成、只留当前主题用到的那张，
//! 见 [`texture::retain_only`]。同一时刻最多一张大图驻留。

pub mod noise;
pub mod texture;
pub mod tokens;

// 平台绘制适配：把 token 转成各平台能直接执行的绘制原语。
// 两平台同分层、同命名（`paint.rs` / `paint_win.rs`），便于对照阅读；
// 内部实现按各自 API 走（AppKit+QuartzCore vs GDI），不强行统一签名。
#[cfg(target_os = "macos")]
pub mod paint;
// paint_win 整个模块两平台都编译：纯逻辑半段（颜色/几何/位图字节）平台无关，
// 单测要在开发机上真跑；GDI 调用被 `#[cfg(windows)]` 收在模块内部（见其模块文档）。
pub mod paint_win;

pub use texture::Tex;
pub use tokens::{
    Bevel, Elevation, Fill, InsetLine, Layer, Radii, Rgba, Shadow, Sheen, Stripe, ThemeId, Tokens,
};

use std::sync::{Mutex, MutexGuard};

static CURRENT: Mutex<ThemeId> = Mutex::new(ThemeId::Brushed);

/// 主题代际：每次真正换主题 +1。平台层据此判断「要不要重建已画好的东西」，
/// 避免每次推送都无条件重绘。
static GENERATION: Mutex<u64> = Mutex::new(0);

fn current_lock() -> MutexGuard<'static, ThemeId> {
    CURRENT.lock().unwrap_or_else(|error| error.into_inner())
}

fn generation_lock() -> MutexGuard<'static, u64> {
    GENERATION.lock().unwrap_or_else(|error| error.into_inner())
}

/// 当前主题（各平台窗口构建/重绘时读取；这是 Native 侧唯一读取点）。
pub fn current() -> ThemeId {
    *current_lock()
}

/// 当前主题的 token 表（等价于 `current().tokens()`，读起来短一点）。
pub fn tokens() -> &'static Tokens {
    current().tokens()
}

/// 当前主题代际。
pub fn generation() -> u64 {
    *generation_lock()
}

/// 解析 CONFIG 字符串为合法主题。
///
/// 未知值**收拢为默认**（拉丝金属），与本仓其他枚举的读取期规则一致：
/// 不写盘、不建旧值兼容映射、不报错中断启动。
pub fn normalize(raw: &str) -> ThemeId {
    ThemeId::parse(raw.trim()).unwrap_or_default()
}

/// 写入当前主题。返回是否发生了真正的切换（同一主题重复推送不改代际）。
///
/// 切换时会顺带把不属于新主题的纹理释放掉 —— 这是「只加载选中主题」的执行点。
pub fn store(id: ThemeId) -> bool {
    let mut current = current_lock();
    if *current == id {
        #[cfg(test)]
        trace_store(format!("noop {id:?}"));
        return false;
    }
    *current = id;
    *generation_lock() += 1;
    #[cfg(test)]
    trace_store(format!("set {id:?}"));
    drop(current);
    release_unused_textures(id);
    true
}

/// 全局状态写操作的测试轨迹（定位并行互踩用；`reset_for_test` 时清空）。
#[cfg(test)]
pub(crate) static STORE_TRACE: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) fn trace_store(entry: String) {
    let mut trace = STORE_TRACE.lock().unwrap_or_else(|e| e.into_inner());
    // libtest 以测试名命名线程：轨迹里带上它，并行互踩一眼定位到调用者。
    let who = std::thread::current().name().unwrap_or("?").to_string();
    trace.push(format!("{entry} <- {who}"));
    // 轨迹只保留最近 64 条（失败现场在尾部）。
    let len = trace.len();
    if len > 64 {
        trace.drain(..len - 64);
    }
}

/// 释放当前主题用不到的纹理。返回释放的字节数（诊断与测试用）。
pub fn release_unused_textures(id: ThemeId) -> usize {
    texture::retain_only(&used_textures(id))
}

/// 某主题实际会用到哪几张纹理。
///
/// 从 token 表里**读出来**而不是写死一张常量表：将来给某套主题加纹理时，
/// 这里自动跟上，不会出现「加了纹理但切主题不释放」的漏。
pub fn used_textures(id: ThemeId) -> Vec<Tex> {
    let mut used = Vec::new();
    let tokens = id.tokens();
    if tokens.stage_grain.is_some() || tokens.panel_grain.is_some() {
        used.push(Tex::Grain);
    }
    // 舞台与面板两个纹理槽位都要扫到：只扫面板会让「切主题只驻留当前纹理」
    // 在铜绿（舞台也有斑块）上漏掉一张。
    for sheen in [tokens.stage_tex, tokens.panel_tex].into_iter().flatten() {
        for layer in sheen.0 {
            if let Layer::Tex { tex, .. } = layer {
                if !used.contains(tex) {
                    used.push(*tex);
                }
            }
        }
    }
    used
}

/// 预热当前主题的纹理（窗口首次打开时调用；已在缓存里则立即返回）。
///
/// 生成的像素是**唯一的磁盘外产物**，所以调用方应在绘制前先预热，
/// 免得首帧算噪声卡住主线程。
pub fn warm_up() {
    for tex in used_textures(current()) {
        texture::get(tex);
    }
}

/// 当前驻留纹理字节（诊断用；口径与 `RendererStats::resident_bytes` 同款）。
pub fn resident_bytes() -> usize {
    texture::resident_bytes()
}

/// 清空全局状态（测试用；产品路径不调用）。
#[cfg(test)]
pub(crate) fn reset_for_test() {
    {
        let mut trace = STORE_TRACE.lock().unwrap_or_else(|e| e.into_inner());
        trace.clear();
        trace.push(format!("reset（线程 {:?}）", std::thread::current().id()));
    }
    *current_lock() = ThemeId::Brushed;
    *generation_lock() = 0;
}

/// 进程级全局状态的测试锁（当前主题 / 代际 / 纹理驻留共用）。
///
/// `cargo test` 并行跑同一二进制里的用例，而 `store` / `warm_up` / 真跑 `apply_sheen`
/// 的绘制路径都会读写同一份全局（`tests` 的驻留断言直接数纹理缓存字节）。凡是要动
/// 这份全局的用例（含跨模块的绘制测试）先拿这把锁，否则会互踩出偶发红 ——
/// 这正是本文件状态机用例注释里说的"显式引入测试锁"。
#[cfg(test)]
pub(crate) static GLOBAL_STATE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未知主题收拢为默认() {
        assert_eq!(normalize("brushed"), ThemeId::Brushed);
        assert_eq!(normalize("chrome"), ThemeId::Chrome);
        assert_eq!(normalize("  verdigris  "), ThemeId::Verdigris);
        assert_eq!(normalize(""), ThemeId::Brushed);
        assert_eq!(normalize("dracula"), ThemeId::Brushed);
        assert_eq!(
            normalize("BRUSHED"),
            ThemeId::Brushed,
            "大小写不匹配也算未知"
        );
    }

    /// 全局状态机：代际推进 + 纹理驻留。
    ///
    /// **刻意写成一条**：这两件事共用同一份进程级状态（`CURRENT` / `GENERATION` /
    /// 纹理缓存），而 `cargo test` 默认并行跑同一个二进制里的用例 —— 拆成两条会
    /// 互相踩（`store` 改的是全局，另一条正读它）。跨模块真跑绘制路径的用例
    /// （会生成纹理的那类）也必须拿 [`GLOBAL_STATE_TEST_LOCK`] 串行。
    /// 纯函数（`normalize` / `used_textures`）另行独立成条。
    #[test]
    fn 全局主题状态机_代际与纹理驻留() {
        let _guard = GLOBAL_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let big = 900 * 900 * 4;
        reset_for_test();
        assert_eq!(generation(), 0);

        // 换主题 → 代际 +1；同主题重复推送 → 不动（平台层据此决定要不要重建）。
        assert!(store(ThemeId::Chrome), "首次切换应生效");
        assert_eq!(generation(), 1);
        assert_eq!(current(), ThemeId::Chrome);
        assert!(!store(ThemeId::Chrome), "同一主题重复推送不算切换");
        assert_eq!(generation(), 1, "代际不变，平台层不该重建");

        // 切到铜绿 → 大图算出来并驻留。
        assert!(store(ThemeId::Verdigris));
        assert_eq!(generation(), 2);
        warm_up();
        if resident_bytes() < big {
            let trace = STORE_TRACE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            panic!(
                "铜绿主题应驻留大图，实际 {} 字节（current={:?}，清单={:?}）；写操作轨迹：{trace:?}",
                resident_bytes(),
                current(),
                used_textures(current())
            );
        }

        // 切走 → 大图必须释放（「只加载选中的主题」的判据）。
        if !store(ThemeId::Brushed) {
            let trace = STORE_TRACE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            panic!("切到拉丝应生效（store 返回 false = 当前已是拉丝）；写操作轨迹：{trace:?}");
        }
        assert_eq!(generation(), 3);
        assert!(
            resident_bytes() < big,
            "切到拉丝后铜绿大图必须释放，实际仍有 {} 字节",
            resident_bytes()
        );

        reset_for_test();
    }

    /// 只有铜绿主题用大图；拉丝与铬主题的纹理清单里不该出现它。
    ///
    /// 舞台与面板两个槽位都要算数：铜绿的斑块槽位在 `stage_tex` 与 `panel_tex` 上各有一份
    /// 声明，扫描漏掉舞台会让切走铜绿时大图仍被当成「在用」而不释放。
    #[test]
    fn 纹理清单跟着主题走() {
        let brushed = used_textures(ThemeId::Brushed);
        assert!(brushed.contains(&Tex::Grain), "三套主题都叠细颗粒");
        assert!(
            !brushed.contains(&Tex::Verdigris),
            "拉丝面板是条纹，不用铜绿大图"
        );

        let chrome = used_textures(ThemeId::Chrome);
        assert!(
            !chrome.contains(&Tex::Verdigris),
            "铬面板是渐变，不用铜绿大图"
        );

        let verdigris = used_textures(ThemeId::Verdigris);
        assert!(
            verdigris.contains(&Tex::Verdigris),
            "铜绿的舞台与面板都叠斑块"
        );

        // 舞台纹理槽位：只有铜绿有（设计与 tokens 两侧同步）。
        assert!(ThemeId::Brushed.tokens().stage_tex.is_none());
        assert!(ThemeId::Chrome.tokens().stage_tex.is_none());
        assert!(ThemeId::Verdigris.tokens().stage_tex.is_some());
    }

    /// 三套 token 表的槽位齐全（不是部分字段有值、其余是黑）。
    #[test]
    fn 三套主题都填满了关键槽位() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            assert!(t.ink.a > 0.9, "{:?} 的主文字不该是透明的", id);
            assert!(t.accent.a > 0.9, "{:?} 的强调色不该是透明的", id);
            assert!(
                matches!(
                    t.panel_bg,
                    Fill::Solid(_) | Fill::Linear(_) | Fill::Striped { .. }
                ),
                "{:?} 的面板底必须是实色或渐变",
                id
            );
            assert!(t.radii.sm > 0.0 && t.radii.btn > 0.0, "{:?} 的圆角未填", id);
        }
    }

    /// 主题标识与 CONFIG 字符串逐字一致（HostCommandMap 两侧共用这份字面量）。
    #[test]
    fn 标识字符串与配置一致() {
        assert_eq!(ThemeId::Brushed.as_str(), "brushed");
        assert_eq!(ThemeId::Chrome.as_str(), "chrome");
        assert_eq!(ThemeId::Verdigris.as_str(), "verdigris");
        assert_eq!(ThemeId::Nightfall.as_str(), "nightfall");
        assert_eq!(ThemeId::Azurite.as_str(), "azurite");
        assert_eq!(ThemeId::ALL.len(), 5);
        for id in ThemeId::ALL {
            assert_eq!(ThemeId::parse(id.as_str()), Some(id), "往返必须自洽");
        }
    }
}
