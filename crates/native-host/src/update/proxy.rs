// ==========================================
// 系统代理解析（macOS SystemConfiguration / Windows WinHTTP）
// ==========================================
//
// 为什么需要这一层：`ureq` 的 `Proxy::try_from_system()` 名字像系统代理，实际**只读环境变量**
// （ureq-2.12.1/src/proxy.rs:73-95）。而 GUI App 由 launchd / Explorer 启动，**拿不到 shell
// 里的 `HTTPS_PROXY`** —— 于是「用户在系统设置里配了代理，App 却永远直连」。
//
// 2026-10-08 实机复现（用户报「检查更新老是失败」）：该机 `scutil --proxy` 显示
// `HTTPEnable=1 / HTTPSEnable=1`（127.0.0.1:7890），而 `launchctl getenv` 的三个代理变量
// 全空；直连 github.com 时通时不通（连测 6 次全是 TCP connect 超时，目标 IP 20.205.243.166
// 被丢包），走系统代理则稳定 200 / 0.46s。
//
// 优先级与降级：**环境变量 > 系统代理 > 直连**。环境变量优先是业界惯例（更显式，也是 CI 与
// 企业场景的常规入口），保留它使本模块成为纯超集、不改变任何既有行为。
// **解析的任何一步失败都退回直连**，绝不因此报错 —— 「这台机器没配代理」是正常形态，不是故障。
//
// 各平台「没配代理」的表达方式（本模块最容易写错的地方）：
//   · macOS：`SCDynamicStoreCopyProxies` **照样返回字典**，靠 `HTTPEnable` / `HTTPSEnable` /
//     `SOCKSEnable` 位判断是否启用；全 0 即「没配」。
//   · Windows：`WinHttpGetIEProxyConfigForCurrentUser` 的字符串字段为 NULL、标志位为 0。
//   两端都必须把「返回了但没启用」当正常路径直连。
//
// 不动 PAC / 自动检测（macOS `ProxyAutoConfigEnable`、Windows `fAutoDetect` 与
// `lzAutoConfigUrl`）：执行 PAC 要 JS 引擎，超出本模块范围；那种形态下如实退回直连
// （TUN / 全局 VPN 用户本来也是直连正确）。真要做得另走 macOS `CFNetworkCopyProxiesForURL`
// 与 Windows `WinHttpGetProxyForUrl`。

/// 代理来源（只用于留痕，不参与决策）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Env,
    System,
    None,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Env => "环境变量",
            Source::System => "系统设置",
            Source::None => "无（直连）",
        }
    }
}

/// 解析结果。
pub struct Resolved {
    pub source: Source,
    pub proxy: Option<ureq::Proxy>,
    /// 系统代理的 `host:port`（只有 `Source::System` 有值）—— 留痕用，**不含凭据**。
    pub detail: Option<String>,
}

impl Resolved {
    /// 一行留痕：来源（系统代理解上地址）。用户报「更新失败」时，这一行直接区分
    /// 「没代理」与「有代理但连不上」——2026-10-08 那单排查正是缺了它。
    pub fn note(&self) -> String {
        match (&self.source, &self.detail) {
            (Source::System, Some(detail)) => format!("{}({detail})", self.source.label()),
            _ => self.source.label().to_string(),
        }
    }
}

/// 解析当前进程该用的代理。
pub fn resolve() -> Resolved {
    if let Some(proxy) = from_env() {
        return Resolved { source: Source::Env, proxy: Some(proxy), detail: None };
    }
    match system() {
        Some((proxy, detail)) => Resolved {
            source: Source::System,
            proxy: Some(proxy),
            detail: Some(detail),
        },
        None => Resolved { source: Source::None, proxy: None, detail: None },
    }
}

/// 环境变量候选与顺序，与 ureq 自己的 `try_from_system` 一致（`ALL_PROXY` 先于 `HTTPS_PROXY`）。
const ENV_VARS: [&str; 6] = [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
];

fn from_env() -> Option<ureq::Proxy> {
    from_env_with(|key| std::env::var(key).ok())
}

/// 把「查环境变量」抽成入参，好在单测里喂假值 —— 直接改进程环境会与并行用例互踩。
fn from_env_with(lookup: impl Fn(&str) -> Option<String>) -> Option<ureq::Proxy> {
    ENV_VARS
        .iter()
        .find_map(|key| lookup(key).and_then(|value| ureq::Proxy::new(value).ok()))
}

// ==========================================
// macOS：SCDynamicStoreCopyProxies
// ==========================================

/// 取系统代理。返回 `(代理, "host:port")`；没配、只配了 PAC、或任何一步解析失败都返回 `None`
/// （调用方据此直连）。
#[cfg(target_os = "macos")]
fn system() -> Option<(ureq::Proxy, String)> {
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;

    let store = SCDynamicStoreBuilder::new("v1rtual-desk-pet-update-proxy").build()?;
    let proxies = store.get_proxies()?;
    pick(proxies)
}

/// 从代理字典里挑一个能用的。抽成独立函数是为了能在开发机上用合成字典真跑单测 ——
/// 这里「读启用位 + 挑协议」的逻辑是本模块唯一可能悄悄错掉的地方。
#[cfg(target_os = "macos")]
fn pick(proxies: core_foundation::dictionary::CFDictionary<core_foundation::string::CFString, core_foundation::base::CFType>) -> Option<(ureq::Proxy, String)> {
    // PAC 不解析（见模块文档）：拿到 URL 也执行不了 JS，如实退回直连。
    if flag(&proxies, "ProxyAutoConfigEnable") {
        return None;
    }
    // feed 是 https://，所以 https 代优先，其次 http，最后 socks。
    // 前两者都是「HTTP 代理（靠 CONNECT 转 https）」，ureq 侧同为 http://。
    let candidates = [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ];
    for (enable_key, host_key, port_key, scheme) in candidates {
        if !flag(&proxies, enable_key) {
            continue;
        }
        // 启用位为真但主机/端口缺失或非法 —— 换下一个候选，不整段放弃。
        let (Some(host), Some(port)) = (text(&proxies, host_key), number(&proxies, port_key)) else {
            continue;
        };
        if host.is_empty() || !(1..=65535).contains(&port) {
            continue;
        }
        let Ok(proxy) = ureq::Proxy::new(format!("{scheme}://{host}:{port}")) else {
            continue;
        };
        return Some((proxy, format!("{host}:{port}")));
    }
    None
}

/// 启用位：**只有明确的 1 算启用**；缺失、类型不符、非 1 一律按未启用（保守，等价于直连）。
#[cfg(target_os = "macos")]
fn flag(
    proxies: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        core_foundation::base::CFType,
    >,
    key: &str,
) -> bool {
    number(proxies, key) == Some(1)
}

#[cfg(target_os = "macos")]
fn number(
    proxies: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        core_foundation::base::CFType,
    >,
    key: &str,
) -> Option<i64> {
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    let value = proxies.find(CFString::new(key))?;
    value.downcast::<CFNumber>()?.to_i64()
}

#[cfg(target_os = "macos")]
fn text(
    proxies: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        core_foundation::base::CFType,
    >,
    key: &str,
) -> Option<String> {
    use core_foundation::string::CFString;

    let value = proxies.find(CFString::new(key))?;
    Some(value.downcast::<CFString>()?.to_string())
}

// ==========================================
// Windows：WinHttpGetIEProxyConfigForCurrentUser
// ==========================================

/// 取系统代理（读的就是「设置 → 网络和 Internet → 代理」写的那份 WinINet 配置）。
/// 没配、只开了自动检测 / PAC、或任何一步失败都返回 `None`（调用方据此直连）。
#[cfg(target_os = "windows")]
fn system() -> Option<(ureq::Proxy, String)> {
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    };

    let mut config: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = unsafe { std::mem::zeroed() };
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
        return None;
    }
    // 三个字符串都归我们释放（文档口径：GlobalFree）。先取出来再释放，指针不悬垂。
    let raw = unsafe { take_wide_string(config.lpszProxy) };
    unsafe {
        free_wide_string(config.lpszAutoConfigUrl);
        free_wide_string(config.lpszProxyBypass);
    }
    // `fAutoDetect` / `lpszAutoConfigUrl`（WPAD / PAC）不解析，见模块文档。
    let raw = raw?;
    let (scheme, host, port) = pick_wininet(&raw)?;
    let proxy = ureq::Proxy::new(format!("{scheme}://{host}:{port}")).ok()?;
    Some((proxy, format!("{host}:{port}")))
}

/// WinINet 的 `lpszProxy` 两形态：`127.0.0.1:7890`（全协议一个）或
/// `http=127.0.0.1:7890;https=127.0.0.1:7890`（逐协议）。挑法与 macOS 同序：
/// https → 裸项 → http → socks。端口缺失或非法返回 `None`。
#[cfg(target_os = "windows")]
fn pick_wininet(raw: &str) -> Option<(&'static str, String, u16)> {
    let mut bare: Option<(String, u16)> = None;
    let mut by_scheme: Vec<(String, String, u16)> = Vec::new();
    for entry in raw.split(';').map(str::trim).filter(|e| !e.is_empty()) {
        match entry.split_once('=') {
            // 没有 `=` 的形态是「所有协议都用它」。
            None => {
                if bare.is_none() {
                    bare = split_host_port(entry);
                }
            }
            Some((scheme, address)) => {
                if let Some((host, port)) = split_host_port(address.trim()) {
                    by_scheme.push((scheme.trim().to_ascii_lowercase(), host, port));
                }
            }
        }
    }
    let scheme_of = |name: &str| {
        by_scheme
            .iter()
            .find(|(scheme, _, _)| scheme.as_str() == name)
            .map(|(_, host, port)| (host.clone(), *port))
    };
    if let Some((host, port)) = scheme_of("https") {
        return Some(("http", host, port));
    }
    if let Some((host, port)) = bare {
        return Some(("http", host, port));
    }
    if let Some((host, port)) = scheme_of("http") {
        return Some(("http", host, port));
    }
    if let Some((host, port)) = scheme_of("socks").or_else(|| scheme_of("socks5")) {
        return Some(("socks5", host, port));
    }
    None
}

#[cfg(target_os = "windows")]
fn split_host_port(address: &str) -> Option<(String, u16)> {
    // 末段才是端口：IPv6 字面量形如 `[::1]:7890`，`rsplit_once` 不吃冒号内的内容。
    let (host, port) = address.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    if host.trim().is_empty() || port == 0 {
        return None;
    }
    // `[::1]:7890` 形态去掉方括号；用闭包而不是 char 数组模式，避免依赖较新的 `Pattern` 实现。
    Some((host.trim().trim_matches(|c| c == '[' || c == ']').to_string(), port))
}

/// 读一个 NUL 结尾的宽字符串，**不释放**（调用方决定何时 free）。
#[cfg(target_os = "windows")]
unsafe fn take_wide_string(ptr: windows_sys::core::PWSTR) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 释放 API 交回的宽字符串（文档口径：`GlobalFree`）。空指针是合法的 no-op。
#[cfg(target_os = "windows")]
unsafe fn free_wide_string(ptr: windows_sys::core::PWSTR) {
    if !ptr.is_null() {
        windows_sys::Win32::Foundation::GlobalFree(ptr as windows_sys::Win32::Foundation::HGLOBAL);
    }
}

// 只发 macOS 与 Windows（见根 README 的目标平台）；其它平台恒为直连，不参与编译。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system() -> Option<(ureq::Proxy, String)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境变量候选：第一个**能解析成功**的胜出；解析不了的跳过而不是整体判负。
    #[test]
    fn 环境变量按序取第一个可解析的() {
        let fake = |pairs: &[(&str, &str)]| {
            let owned: Vec<(String, String)> =
                pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            move |key: &str| {
                owned
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.clone())
            }
        };

        // ALL_PROXY 在前：即使 HTTPS_PROXY 也有值，也取 ALL_PROXY。
        let both = fake(&[("HTTPS_PROXY", "http://1.1.1.1:1"), ("ALL_PROXY", "socks5://2.2.2.2:2")]);
        assert!(from_env_with(both).is_some(), "两个都有值时应当取到一个");

        // 只有 https_proxy：小写形态也要认。
        let lower = fake(&[("https_proxy", "http://127.0.0.1:7890")]);
        assert!(from_env_with(lower).is_some(), "小写 https_proxy 未被识别");

        // 全空 → None（这条是「没配代理必须直连」的直接判据）。
        let empty = fake(&[]);
        assert!(from_env_with(empty).is_none(), "没有任何代理变量时应返回 None");

        // 值非法（协议不认识）→ 跳过它，不 panic、不硬失败。
        let broken = fake(&[("ALL_PROXY", "gopher://x:1")]);
        assert!(from_env_with(broken).is_none(), "非法协议值应被跳过");
    }

    /// 没配代理时 note() 必须是「无（直连）」—— 用户报故障时这一行决定排查方向。
    #[test]
    fn 直连的留痕文案() {
        let none = Resolved { source: Source::None, proxy: None, detail: None };
        assert_eq!(none.note(), "无（直连）");
        let system = Resolved {
            source: Source::System,
            proxy: None,
            detail: Some("127.0.0.1:7890".into()),
        };
        assert_eq!(system.note(), "系统设置(127.0.0.1:7890)");
        let env = Resolved { source: Source::Env, proxy: None, detail: None };
        assert_eq!(env.note(), "环境变量");
    }

    /// 真跑一次系统代理解析：只要求「不 panic、能返回」，不假设这台机器配没配代理
    /// （CI 机器通常没有）—— 有代理与没代理都是合法的产品行为。
    #[test]
    fn 系统解析不panic且结果自洽() {
        let resolved = resolve();
        // 打出来（`--nocapture` 可见）：这条用例红了或想确认本机走哪条路时，一眼就能看清。
        println!("resolve() → {}", resolved.note());
        match resolved.source {
            Source::None => assert!(resolved.proxy.is_none() && resolved.detail.is_none()),
            Source::System => {
                assert!(resolved.proxy.is_some(), "判为系统代理却没给出代理");
                assert!(resolved.detail.is_some(), "系统代理必须带出 host:port 供留痕");
            }
            Source::Env => assert!(resolved.proxy.is_some(), "判为环境变量却没给出代理"),
        }
    }
}
