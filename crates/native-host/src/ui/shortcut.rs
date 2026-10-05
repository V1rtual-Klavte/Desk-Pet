//! 全局快捷键的组合解析与平台编译 —— 零平台 token 的纯逻辑 + 键码表。
//!
//! 配置来源（执行契约 §6.2；W5 有意扩展 W0 命令矩阵的 `configure_global_shortcut`）：
//! Node 的 `src/services/config.ts` 是 CONFIG 的类型化消费者，**Rust 不复制默认值**。
//! Node 在启动与设置保存时把 `{ key, modifiers }` 推给宿主，`modifiers` 已由 Node
//! 按平台选好（`general.shortcut.macModifiers` 或 `winModifiers`）；宿主收到前不注册
//! 任何快捷键。名称到平台位/键码的映射在本模块完成（`Control`/`Command`/`Alt`/`Shift`
//! 两平台各自的键码）。
//!
//! 护栏（既定语义）：
//! - 至少一个修饰键 + 一个非修饰键的按键；把裸键注册成全局热键会全系统吞键 ——
//!   无效组合在解析阶段就返回结构化错误，由 `configure_global_shortcut` 如实回给 Node。
//! - 修改快捷键 = 重新推送：平台侧先注销旧注册再注册新的。
//! - 「重复按键」护栏不在这里：它属于呼出/收回状态机（见 [`super::state`] 的
//!   `TOGGLE_TAIL_MS` 与 `can_toggle`）。

use std::fmt;

/// 修饰键名称（CONFIG 的取值域：设置页录制写出的四种）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Control,
    /// macOS 的 Command；Windows 上的对应物是 Win 键（录制时 metaKey 记为 Command）。
    Command,
    Alt,
    Shift,
}

impl Modifier {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "Control" => Some(Self::Control),
            "Command" => Some(Self::Command),
            "Alt" => Some(Self::Alt),
            "Shift" => Some(Self::Shift),
            _ => None,
        }
    }
}

/// 解析错误：面向用户的说明文本（命令失败时进结构化 `CONFIG` 错误，不退化成静默）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutError {
    pub detail: String,
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for ShortcutError {}

fn err(detail: impl Into<String>) -> ShortcutError {
    ShortcutError {
        detail: detail.into(),
    }
}

/// 归一化后的快捷键（键名被规范成表内名称，修饰键按 CONFIG 顺序去重）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutSpec {
    pub key: String,
    pub modifiers: Vec<Modifier>,
}

/// 平台编译结果：虚拟键码 + 平台修饰位（Carbon modifier 位 / Win32 `MOD_*`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlatformShortcut {
    pub key_code: u32,
    pub modifiers: u32,
}

/// 解析 `{ key, modifiers }`（线格式即 CONFIG 的两个字段）。
///
/// 运行期收到之前不注册任何快捷键；解析失败返回结构化错误。
pub fn parse_spec(key: &str, modifiers: &[String]) -> Result<ShortcutSpec, ShortcutError> {
    let key = normalize_key(key)?;
    if modifiers.is_empty() {
        return Err(err(format!(
            "快捷键 {key} 缺少修饰键：拒绝把裸键注册为全局快捷键"
        )));
    }
    let mut parsed = Vec::with_capacity(modifiers.len());
    for name in modifiers {
        let modifier = Modifier::parse(name).ok_or_else(|| {
            err(format!(
                "未知修饰键 {name:?}（只接受 Control / Command / Alt / Shift）"
            ))
        })?;
        if !parsed.contains(&modifier) {
            parsed.push(modifier);
        }
    }
    Ok(ShortcutSpec {
        key,
        modifiers: parsed,
    })
}

/// 键名归一化：单字符统一大写（含空格）；命名键做别名折叠；拒绝修饰键本体。
/// 按大小写不敏感把用户写法折到键码表里的**规范拼写**（`"esc"` → `None`，
/// `"ARROWUP"` → `Some("ArrowUp")`，`"f1"` → `Some("F1")`）。
///
/// 只借表里的名字：键码仍由两条平台表唯一持有，这里不复制第二份。
fn canonical_named_key(folded: &str) -> Option<&'static str> {
    MACOS_KEYCODES
        .iter()
        .chain(WINDOWS_VIRTUAL_KEYS.iter())
        .map(|(name, _)| *name)
        .find(|name| name.to_ascii_lowercase() == folded)
}

fn normalize_key(key: &str) -> Result<String, ShortcutError> {
    if key.is_empty() {
        return Err(err("快捷键缺少按键"));
    }
    let trimmed = key.trim();
    if trimmed.is_empty() {
        // 单个空格是合法的 Space 写法（录制时 e.key === " "）。
        return Ok(" ".to_string());
    }
    if matches!(
        trimmed,
        "Control" | "Command" | "Alt" | "Shift" | "Cmd" | "Ctrl" | "Option" | "Meta"
    ) {
        return Err(err(format!(
            "快捷键 {trimmed:?} 只是修饰键，需要再给一个按键"
        )));
    }
    // 别名归一化**大小写不敏感**：CONFIG 是用户可手写的 YAML，`esc` / `Esc` / `ESCAPE`
    // 该落到同一个规范名；录制端（浏览器 `e.key`）给的是 `Enter`，键码表里的规范名是
    // `Return`，这一对也必须折起来。
    let folded = trimmed.to_ascii_lowercase();
    let canonical = match folded.as_str() {
        "enter" => "Return",
        "esc" | "escape" => "Escape",
        "space" | "spacebar" => " ",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        // 其余按平台键码表的规范名折（表是键码的唯一来源，这里只借它的名字，
        // 不复制第二份键表）；表里也没有的原样返回，由 `compile` 如实报「不支持该键」。
        other => canonical_named_key(other).unwrap_or(other),
    };
    if canonical.chars().count() == 1 {
        let ch = canonical.chars().next().unwrap();
        if ch.is_ascii() {
            return Ok(ch.to_ascii_uppercase().to_string());
        }
        return Err(err(format!("快捷键按键 {canonical:?} 不受支持")));
    }
    Ok(canonical.to_string())
}

/// 在指定键码表里查键（`None` = 该平台不支持该键）。
fn lookup(table: &[(&str, u32)], key: &str) -> Option<u32> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, code)| *code)
}

impl ShortcutSpec {
    /// 编译成本平台注册所需的键码与修饰位。
    pub fn compile(&self) -> Result<PlatformShortcut, ShortcutError> {
        #[cfg(target_os = "macos")]
        {
            let key_code = macos_key_code(&self.key)
                .ok_or_else(|| err(format!("macOS 不支持按键 {:?}", self.key)))?;
            Ok(PlatformShortcut {
                key_code,
                modifiers: carbon_modifier_bits(&self.modifiers),
            })
        }
        #[cfg(target_os = "windows")]
        {
            let key_code = windows_virtual_key(&self.key)
                .ok_or_else(|| err(format!("Windows 不支持按键 {:?}", self.key)))?;
            Ok(PlatformShortcut {
                key_code,
                modifiers: windows_modifier_bits(&self.modifiers),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = self;
            Err(err("原生宿主只支持 macOS 与 Windows"))
        }
    }
}

// ==========================================
// 键码表
// ==========================================

/// macOS Carbon 虚拟键码（`kVK_*`，HIToolbox Events.h）。
pub const MACOS_KEYCODES: &[(&str, u32)] = &[
    ("A", 0x00),
    ("S", 0x01),
    ("D", 0x02),
    ("F", 0x03),
    ("H", 0x04),
    ("G", 0x05),
    ("Z", 0x06),
    ("X", 0x07),
    ("C", 0x08),
    ("V", 0x09),
    ("B", 0x0B),
    ("Q", 0x0C),
    ("W", 0x0D),
    ("E", 0x0E),
    ("R", 0x0F),
    ("Y", 0x10),
    ("T", 0x11),
    ("1", 0x12),
    ("2", 0x13),
    ("3", 0x14),
    ("4", 0x15),
    ("6", 0x16),
    ("5", 0x17),
    ("=", 0x18),
    ("9", 0x19),
    ("7", 0x1A),
    ("-", 0x1B),
    ("8", 0x1C),
    ("0", 0x1D),
    ("]", 0x1E),
    ("O", 0x1F),
    ("U", 0x20),
    ("[", 0x21),
    ("I", 0x22),
    ("P", 0x23),
    ("Return", 0x24),
    ("L", 0x25),
    ("J", 0x26),
    ("'", 0x27),
    ("K", 0x28),
    (";", 0x29),
    ("\\", 0x2A),
    (",", 0x2B),
    ("/", 0x2C),
    ("N", 0x2D),
    ("M", 0x2E),
    (".", 0x2F),
    ("Tab", 0x30),
    (" ", 0x31),
    ("`", 0x32),
    ("Backspace", 0x33),
    ("Escape", 0x35),
    ("Delete", 0x75),
    ("Home", 0x73),
    ("End", 0x77),
    ("PageUp", 0x74),
    ("PageDown", 0x79),
    ("ArrowLeft", 0x7B),
    ("ArrowRight", 0x7C),
    ("ArrowDown", 0x7D),
    ("ArrowUp", 0x7E),
    ("F1", 0x7A),
    ("F2", 0x78),
    ("F3", 0x63),
    ("F4", 0x76),
    ("F5", 0x60),
    ("F6", 0x61),
    ("F7", 0x62),
    ("F8", 0x64),
    ("F9", 0x65),
    ("F10", 0x6D),
    ("F11", 0x67),
    ("F12", 0x6F),
];

/// Windows 虚拟键码（`VK_*`）。
pub const WINDOWS_VIRTUAL_KEYS: &[(&str, u32)] = &[
    ("A", 0x41),
    ("B", 0x42),
    ("C", 0x43),
    ("D", 0x44),
    ("E", 0x45),
    ("F", 0x46),
    ("G", 0x47),
    ("H", 0x48),
    ("I", 0x49),
    ("J", 0x4A),
    ("K", 0x4B),
    ("L", 0x4C),
    ("M", 0x4D),
    ("N", 0x4E),
    ("O", 0x4F),
    ("P", 0x50),
    ("Q", 0x51),
    ("R", 0x52),
    ("S", 0x53),
    ("T", 0x54),
    ("U", 0x55),
    ("V", 0x56),
    ("W", 0x57),
    ("X", 0x58),
    ("Y", 0x59),
    ("Z", 0x5A),
    ("0", 0x30),
    ("1", 0x31),
    ("2", 0x32),
    ("3", 0x33),
    ("4", 0x34),
    ("5", 0x35),
    ("6", 0x36),
    ("7", 0x37),
    ("8", 0x38),
    ("9", 0x39),
    (" ", 0x20),
    ("Return", 0x0D),
    ("Tab", 0x09),
    ("Backspace", 0x08),
    ("Escape", 0x1B),
    ("Delete", 0x2E),
    ("Home", 0x24),
    ("End", 0x23),
    ("PageUp", 0x21),
    ("PageDown", 0x22),
    ("ArrowLeft", 0x25),
    ("ArrowUp", 0x26),
    ("ArrowRight", 0x27),
    ("ArrowDown", 0x28),
    ("=", 0xBB),
    ("-", 0xBD),
    ("[", 0xDB),
    ("]", 0xDD),
    ("'", 0xDE),
    (";", 0xBA),
    ("\\", 0xDC),
    (",", 0xBC),
    (".", 0xBE),
    ("/", 0xBF),
    ("`", 0xC0),
    ("F1", 0x70),
    ("F2", 0x71),
    ("F3", 0x72),
    ("F4", 0x73),
    ("F5", 0x74),
    ("F6", 0x75),
    ("F7", 0x76),
    ("F8", 0x77),
    ("F9", 0x78),
    ("F10", 0x79),
    ("F11", 0x7A),
    ("F12", 0x7B),
];

pub fn macos_key_code(key: &str) -> Option<u32> {
    lookup(MACOS_KEYCODES, key)
}

pub fn windows_virtual_key(key: &str) -> Option<u32> {
    lookup(WINDOWS_VIRTUAL_KEYS, key)
}

/// Carbon modifier 位（HIToolbox：cmdKey/shiftKey/optionKey/controlKey）。
pub const CARBON_CMD: u32 = 0x0100;
pub const CARBON_SHIFT: u32 = 0x0200;
pub const CARBON_OPTION: u32 = 0x0800;
pub const CARBON_CONTROL: u32 = 0x1000;

pub fn carbon_modifier_bits(modifiers: &[Modifier]) -> u32 {
    modifiers
        .iter()
        .map(|m| match m {
            Modifier::Command => CARBON_CMD,
            Modifier::Shift => CARBON_SHIFT,
            Modifier::Alt => CARBON_OPTION,
            Modifier::Control => CARBON_CONTROL,
        })
        .fold(0, |acc, bit| acc | bit)
}

/// Win32 `MOD_*` 位（与 `windows-sys` 的常量同值，这里不依赖目标平台依赖）。
pub const WIN_MOD_ALT: u32 = 0x0001;
pub const WIN_MOD_CONTROL: u32 = 0x0002;
pub const WIN_MOD_SHIFT: u32 = 0x0004;
pub const WIN_MOD_WIN: u32 = 0x0008;

pub fn windows_modifier_bits(modifiers: &[Modifier]) -> u32 {
    modifiers
        .iter()
        .map(|m| match m {
            Modifier::Command => WIN_MOD_WIN,
            Modifier::Shift => WIN_MOD_SHIFT,
            Modifier::Alt => WIN_MOD_ALT,
            Modifier::Control => WIN_MOD_CONTROL,
        })
        .fold(0, |acc, bit| acc | bit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析mac默认组合() {
        let spec = parse_spec("P", &["Control".into(), "Command".into()]).unwrap();
        assert_eq!(spec.key, "P");
        assert_eq!(spec.modifiers, vec![Modifier::Control, Modifier::Command]);
    }

    #[test]
    fn 解析windows默认组合() {
        let spec = parse_spec("P", &["Control".into(), "Alt".into()]).unwrap();
        assert_eq!(spec.modifiers, vec![Modifier::Control, Modifier::Alt]);
    }

    #[test]
    fn 单字符小写被归一化为大写() {
        let spec = parse_spec("p", &["Shift".into()]).unwrap();
        assert_eq!(spec.key, "P");
    }

    #[test]
    fn 别名与命名键归一化() {
        assert_eq!(
            parse_spec("Enter", &["Command".into()]).unwrap().key,
            "Return"
        );
        assert_eq!(
            parse_spec("esc", &["Control".into()]).unwrap().key,
            "Escape"
        );
        assert_eq!(
            parse_spec("ArrowUp", &["Shift".into()]).unwrap().key,
            "ArrowUp"
        );
        assert_eq!(parse_spec(" ", &["Shift".into()]).unwrap().key, " ");
        assert_eq!(parse_spec("Space", &["Shift".into()]).unwrap().key, " ");
    }

    #[test]
    fn 护栏_缺修饰键被拒绝() {
        let e = parse_spec("P", &[]).unwrap_err();
        assert!(e.detail.contains("缺少修饰键"), "{e}");
    }

    #[test]
    fn 护栏_空按键被拒绝() {
        assert!(parse_spec("", &["Control".into()]).is_err());
        assert!(
            parse_spec("   ", &["Control".into()]).is_ok(),
            "单个空格是 Space 的合法写法"
        );
    }

    #[test]
    fn 护栏_修饰键不能当按键() {
        let e = parse_spec("Control", &["Shift".into()]).unwrap_err();
        assert!(e.detail.contains("只是修饰键"), "{e}");
        assert!(parse_spec("Command", &["Shift".into()]).is_err());
    }

    #[test]
    fn 护栏_未知修饰键被拒绝() {
        let e = parse_spec("P", &["Hyper".into()]).unwrap_err();
        assert!(e.detail.contains("未知修饰键"), "{e}");
    }

    #[test]
    fn 护栏_未知按键在编译期报错而不是静默注册() {
        let spec = parse_spec("F99", &["Control".into()]).unwrap();
        // 表里没有 F99：两端都必须拒绝。
        assert!(spec.compile().is_err());
        assert!(macos_key_code("F99").is_none());
        assert!(windows_virtual_key("F99").is_none());
    }

    #[test]
    fn 修饰键去重且与顺序无关() {
        let spec = parse_spec("D", &["Shift".into(), "Control".into(), "Shift".into()]).unwrap();
        assert_eq!(spec.modifiers, vec![Modifier::Shift, Modifier::Control]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac默认组合编译为carbon键码与修饰位() {
        let spec = parse_spec("P", &["Control".into(), "Command".into()]).unwrap();
        let compiled = spec.compile().unwrap();
        assert_eq!(compiled.key_code, 0x23, "kVK_ANSI_P");
        assert_eq!(compiled.modifiers, CARBON_CONTROL | CARBON_CMD);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac功能键与方向键映射到carbon键码() {
        assert_eq!(macos_key_code("F5"), Some(0x60));
        assert_eq!(macos_key_code("ArrowLeft"), Some(0x7B));
        assert_eq!(
            macos_key_code("Delete"),
            Some(0x75),
            "Delete 是前向删除，Backspace 才是 0x33"
        );
        assert_eq!(macos_key_code("Backspace"), Some(0x33));
    }

    #[cfg(windows)]
    #[test]
    fn windows默认组合编译为虚拟键码与修饰位() {
        let spec = parse_spec("P", &["Control".into(), "Alt".into()]).unwrap();
        let compiled = spec.compile().unwrap();
        assert_eq!(compiled.key_code, 0x50);
        assert_eq!(compiled.modifiers, WIN_MOD_CONTROL | WIN_MOD_ALT);
    }

    #[cfg(windows)]
    #[test]
    fn windows的command名称映射到win修饰位() {
        let spec = parse_spec("D", &["Command".into()]).unwrap();
        assert_eq!(spec.compile().unwrap().modifiers, WIN_MOD_WIN);
    }
}
