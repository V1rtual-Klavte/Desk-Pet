// ==========================================
// update.json 契约：feed / 签名 release envelope / 校验链（W10b）
// ==========================================
//
// 执行契约 §4.5（docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md）定案：
// - 最终 Native 更新源为 `update.json`，**单一 schemaVersion**；
// - 签名 release envelope 覆盖 version、platform/arch、制品 SHA256/size、URL 与
//   应用标识；制品签名/哈希**另验证**；
// - 不是「只验下载文件却信任任意 manifest 版本」：envelope 本身就是被签名对象；
// - 低版本 / 错误平台 / 不完整组件集拒绝安装。
//
// 文档结构（两种文件，别混淆）：
//
// 1. **发布 feed**（发布出去的文件就叫 `update.json`；形状见
//    `packaging/update-feed.example.json`，真实文件由发布流程生成并逐条签名）：
//    ```json
//    {
//      "schemaVersion": 1,
//      "appIdentifier": "com.v1rtual.deskpet",
//      "generatedAt": "2026-10-04T12:00:00Z",        // 可选，仅记录
//      "releases": [
//        {
//          "envelope": "<被签名的原始 JSON 字符串>",
//          "signature": "<minisign 签名块>"
//        }
//      ]
//    }
//    ```
//    顶层字段不被签名覆盖、也不参与安装决策；安装决策只读**验签后的 envelope**。
//    签名是分离签名，覆盖 `envelope` 字段的**原始字节**（不做 JSON 重排/规范化，
//    避免 canonicalization 歧义）。
//
// 2. **客户端元数据**（`packaging/update.json`，编译期嵌入宿主；不是发布 feed）：
//    feed 地址与钉死的 minisign 公钥、尺寸上限、代码签名/公证状态记录。
//
// envelope（被签名字节解析后的形状）：
//    {
//      "appIdentifier": "com.v1rtual.deskpet",
//      "version": "0.17.0",
//      "platform": "macos",              // macos | windows
//      "arch": "aarch64",                // aarch64 | x86_64
//      "publishedAt": "…",               // 可选，仅记录
//      "notes": "…",                     // 可选，仅展示
//      "versionSet": { "app": "0.17.0", "node": "22.22.3" },
//      "components": [
//        { "kind": "app", "name": "…", "url": "https://…", "size": 123, "sha256": "…" }
//      ]
//    }
//
//    版本集合：`.app` 整目录包含对应 Node 与 JS（契约 §4.5）；Windows 安装器同样
//    更新完整版本集合。`versionSet` 是被签名的声明，helper 安装前把**包内**
//    `version-set.json` 与它逐项对照，两边不一致 = 不完整组件集，拒绝安装。
//
// 本模块只做纯解析/校验；取字节、验签实现、下载见同目录其余文件。
// 所有拒绝都返回带稳定 code 的 `AppError`（见下方 E_*；前端按 code 分支，不匹配文案）。

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// feed 与 envelope 的**唯一** schemaVersion（契约 §4.5「单一 schemaVersion」）。
/// 字段增删改一律提升本值：旧客户端遇到不认识的 schemaVersion 直接拒绝，不做兼容读取。
pub const UPDATE_SCHEMA_VERSION: u32 = 1;

/// 平台 / 架构字符串（envelope 与安装目标比对用的唯一字面量）。
pub const PLATFORM_MACOS: &str = "macos";
pub const PLATFORM_WINDOWS: &str = "windows";
pub const ARCH_AARCH64: &str = "aarch64";
pub const ARCH_X86_64: &str = "x86_64";

/// 组件 kind。macOS 是 `.app` 整包（含 Node、JS、helper），Windows 是 NSIS 安装器。
pub const KIND_APP: &str = "app";
pub const KIND_INSTALLER: &str = "installer";

/// 包内版本集合清单文件名（`.app` 为 `Contents/Resources/version-set.json`，
/// Windows 为安装根下的 `version-set.json`）；由打包流程写入，helper 逐项核对。
pub const VERSION_SET_FILE_NAME: &str = "version-set.json";

// ── 稳定错误码 ──
//
// AppError 是跨 crate 共享的错误表（error.rs 不在本包文件边界内），不为更新域新增
// 全局变体；`AppError::Remote` 的 code 字段本就是运行期错误码通道，序列化仍是
// {code, message}，前端按 code 分支、不匹配文案。码值为契约的一部分，新增必须在
// 这里登记、并同步 test/unit/release/update.test.ts 与文档。
pub const E_SCHEMA: &str = "UPDATE_SCHEMA";
pub const E_APP_ID: &str = "UPDATE_APP_ID";
pub const E_BAD_SIGNATURE: &str = "UPDATE_BAD_SIGNATURE";
pub const E_BAD_KEY: &str = "UPDATE_BAD_KEY";
pub const E_PLATFORM: &str = "UPDATE_PLATFORM";
pub const E_ARCH: &str = "UPDATE_ARCH";
pub const E_LOW_VERSION: &str = "UPDATE_LOW_VERSION";
pub const E_COMPONENTS: &str = "UPDATE_COMPONENTS";
pub const E_VERSION_SET: &str = "UPDATE_VERSION_SET";
pub const E_INSECURE_URL: &str = "UPDATE_INSECURE_URL";
pub const E_SIZE_MISMATCH: &str = "UPDATE_SIZE_MISMATCH";
pub const E_HASH_MISMATCH: &str = "UPDATE_HASH_MISMATCH";
pub const E_TOO_LARGE: &str = "UPDATE_TOO_LARGE";
pub const E_NETWORK: &str = "UPDATE_NETWORK";
pub const E_STATE: &str = "UPDATE_STATE";
pub const E_NO_PENDING: &str = "UPDATE_NO_PENDING";
pub const E_INSTALL_LAYOUT: &str = "UPDATE_INSTALL_LAYOUT";

/// 带稳定 code 的更新错误。
pub(crate) fn update_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::Remote {
        code: code.to_string(),
        message: message.into(),
    }
}

// ==========================================
// 版本号（semver 前置规则的最小实现）
// ==========================================

/// `MAJOR.MINOR.PATCH[-prerelease][+build]`。
///
/// 只实现 semver 的**优先级**规则（数字比较 + 预发布后缀），不支持范围表达式：
/// 更新域只需要「新版本 > 当前版本」与「按最高版本选候选」两个判断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// 预发布标识（`-` 之后按 `.` 切分）。空 = 正式版。
    pre: Vec<String>,
}

impl Version {
    pub fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
            pre: Vec::new(),
        }
    }

    pub fn parse(text: &str) -> AppResult<Self> {
        let invalid = || {
            update_error(
                E_SCHEMA,
                format!("版本号不符合 semver 优先级格式: {text:?}"),
            )
        };
        let text = text.trim();
        let (core_and_pre, _build) = match text.split_once('+') {
            Some((head, build)) => {
                if build.is_empty()
                    || !build
                        .split('.')
                        .all(|part| !part.is_empty() && part.chars().all(is_ident_char))
                {
                    return Err(invalid());
                }
                (head, Some(build))
            }
            None => (text, None),
        };
        let (core, pre) = match core_and_pre.split_once('-') {
            Some((core, pre)) => {
                let ids: Vec<String> = pre.split('.').map(ToString::to_string).collect();
                if ids
                    .iter()
                    .any(|id| id.is_empty() || !id.chars().all(is_ident_char))
                {
                    return Err(invalid());
                }
                (core, ids)
            }
            None => (core_and_pre, Vec::new()),
        };
        let mut parts = core.split('.');
        let mut next = || -> AppResult<u64> {
            let raw = parts.next().ok_or_else(invalid)?;
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            // 前导零拒绝：与 semver 一致，避免 "01" 被当成合法版本。
            if raw.len() > 1 && raw.starts_with('0') {
                return Err(invalid());
            }
            raw.parse::<u64>().map_err(|_| invalid())
        };
        let major = next()?;
        let minor = next()?;
        let patch = next()?;
        if parts.next().is_some() {
            return Err(invalid());
        }
        Ok(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    pub fn to_string_lossy(&self) -> String {
        self.to_string()
    }
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '.'
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| cmp_prerelease(&self.pre, &other.pre))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// semver 预发布优先级：无预发布 > 有预发布；逐标识比较，数字标识按数值、
/// 数字标识小于字母数字标识，字母数字标识按 ASCII 序；前缀相同时标识更多者更大。
fn cmp_prerelease(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.iter().zip(b.iter()) {
                let x_num = x.bytes().all(|c| c.is_ascii_digit());
                let y_num = y.bytes().all(|c| c.is_ascii_digit());
                let ord = match (x_num, y_num) {
                    (true, true) => x
                        .parse::<u64>()
                        .unwrap_or(u64::MAX)
                        .cmp(&y.parse::<u64>().unwrap_or(u64::MAX)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            a.len().cmp(&b.len())
        }
    }
}

// ==========================================
// 安装目标（编译期平台 + 架构）
// ==========================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pub platform: &'static str,
    pub arch: &'static str,
}

impl Target {
    /// 当前构建的目标。产品只发布 macOS/Windows 与 aarch64/x86_64。
    pub fn current() -> AppResult<Self> {
        let platform = if cfg!(target_os = "macos") {
            PLATFORM_MACOS
        } else if cfg!(target_os = "windows") {
            PLATFORM_WINDOWS
        } else {
            return Err(update_error(
                E_PLATFORM,
                "原生宿主只支持 macOS 与 Windows（执行契约 §1）",
            ));
        };
        let arch = if cfg!(target_arch = "aarch64") {
            ARCH_AARCH64
        } else if cfg!(target_arch = "x86_64") {
            ARCH_X86_64
        } else {
            return Err(update_error(E_ARCH, "更新只发布 aarch64 / x86_64 制品"));
        };
        Ok(Self { platform, arch })
    }

    pub fn key(self) -> String {
        format!("{}-{}", self.platform, self.arch)
    }
}

/// 该平台必须且只能声明的组件集合（契约 §4.5「不完整组件集拒绝安装」）。
pub fn required_component_kinds(platform: &str) -> AppResult<&'static [&'static str]> {
    match platform {
        PLATFORM_MACOS => Ok(&[KIND_APP]),
        PLATFORM_WINDOWS => Ok(&[KIND_INSTALLER]),
        other => Err(update_error(
            E_PLATFORM,
            format!("未知平台 {other:?}：组件集合无法裁定"),
        )),
    }
}

// ==========================================
// feed / envelope / 客户端元数据（serde 形状）
// ==========================================

/// 客户端元数据（`packaging/update.json`，编译期嵌入）。**不是**发布 feed。
///
/// 允许额外字段：该文件同时承载人读的说明字段（与 `packaging/node-runtime.json`
/// 同模式），代码只读下面这些已知键；必需键缺失/类型错仍是硬失败。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    pub schema_version: u32,
    pub app_identifier: String,
    /// 发布 feed 的稳定地址（GitHub Release 的 `latest/download/update.json`）。
    pub feed_url: String,
    /// 钉死的 minisign 公钥（key 文件第二行，base64；公钥不是密钥）。
    pub release_public_key: String,
    /// 公钥来源说明（记录性质，不参与决策）。
    #[serde(default)]
    pub release_public_key_origin: Option<String>,
    pub limits: FeedLimits,
    /// 代码签名/公证状态记录（契约 §4.5 要求如实记录；换打包器不会自动变成已签名）。
    pub code_signing: CodeSigningStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedLimits {
    /// feed 响应体上限（控制帧不是限制对象；这里防的是被塞巨大 JSON）。
    pub max_feed_bytes: u64,
    /// 单个制品上限（声明 size 超过它直接拒绝，不落盘）。
    pub max_artifact_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSigningStatus {
    pub macos_developer_id: bool,
    pub macos_notarized: bool,
    pub windows_authenticode: bool,
    #[serde(default)]
    pub note: Option<String>,
}

impl CodeSigningStatus {
    /// 启动日志用的一行摘要（如实记录，不美化成"已签名"）。
    pub fn summary(&self) -> String {
        format!(
            "macOS Developer ID={} 公证={} Windows Authenticode={}",
            yes_no(self.macos_developer_id),
            yes_no(self.macos_notarized),
            yes_no(self.windows_authenticode),
        )
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "是"
    } else {
        "否"
    }
}

/// 发布 feed（`update.json`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateFeed {
    pub schema_version: u32,
    pub app_identifier: String,
    /// 生成时间（记录性质；决策不读时钟，避免回放/时钟偏差影响）。
    #[serde(default)]
    pub generated_at: Option<String>,
    pub releases: Vec<FeedRelease>,
}

/// feed 里的一条 release：被签名的 envelope 原文 + 分离签名。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedRelease {
    /// envelope 的**原始 JSON 字节**（字符串形态交付，签名覆盖的正是这些字节）。
    pub envelope: String,
    /// minisign 签名块（两行 + trusted comment 行）。
    pub signature: String,
}

/// 被签名的 release envelope（契约 §4.5 的覆盖范围就在这些字段上）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseEnvelope {
    pub app_identifier: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    #[serde(default)]
    pub published_at: Option<String>,
    /// 发布说明（仅展示；不参与任何决策）。
    #[serde(default)]
    pub notes: Option<String>,
    /// 完整版本集合声明（Native / Node / JS 一起升级；契约 §4.5）。
    pub version_set: VersionSet,
    pub components: Vec<Component>,
}

/// 完整版本集合：一个 `.app` / 安装器里应同时生效的组件版本。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionSet {
    /// 应用（Native 宿主 + 随包资源）版本，必须等于 envelope.version。
    pub app: String,
    /// 随包 Node 版本，必须与包内 `version-set.json` 一致。
    pub node: String,
}

/// 包内版本集合清单（`.app` 为 `Contents/Resources/version-set.json`；
/// Windows 为安装根 `version-set.json`）。打包流程负责生成。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleVersionSet {
    pub app: String,
    pub node: String,
    /// Harness（JS）构建标识；记录 + 打包约束用（如 git 描述或构建号）。
    #[serde(default)]
    pub harness: Option<String>,
}

/// 一个制品组件。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Component {
    pub kind: String,
    /// 落 staging 的文件名（同时也是归档内/安装器的文件名语义）。
    pub name: String,
    pub url: String,
    pub size: u64,
    /// 小写十六进制 SHA-256。
    pub sha256: String,
}

impl Component {
    /// 单组件字段校验（不含集合完整性，集合见 [`validate_components`]）。
    pub fn validate(&self, limits: &FeedLimits) -> AppResult<()> {
        if self.kind.trim().is_empty() {
            return Err(update_error(E_COMPONENTS, "组件缺少 kind"));
        }
        validate_component_name(&self.name, &self.kind)?;
        if !self.url.starts_with("https://") || self.url.contains(char::is_whitespace) {
            return Err(update_error(
                E_INSECURE_URL,
                format!(
                    "组件 {} 的 URL 必须是 https:// 且不含空白: {:?}",
                    self.name, self.url
                ),
            ));
        }
        if self.size == 0 {
            return Err(update_error(
                E_COMPONENTS,
                format!("组件 {} 的 size 必须大于 0", self.name),
            ));
        }
        if self.size > limits.max_artifact_bytes {
            return Err(update_error(
                E_TOO_LARGE,
                format!(
                    "组件 {} 声明大小 {} 超过上限 {}",
                    self.name, self.size, limits.max_artifact_bytes
                ),
            ));
        }
        if !is_sha256_hex(&self.sha256) {
            return Err(update_error(
                E_COMPONENTS,
                format!("组件 {} 的 sha256 必须是 64 位小写十六进制", self.name),
            ));
        }
        Ok(())
    }
}

/// 文件名必须能安全地作为 staging 目录里的单层文件名（不允许路径语义）。
fn validate_component_name(name: &str, kind: &str) -> AppResult<()> {
    let bad = name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control);
    if bad {
        return Err(update_error(
            E_COMPONENTS,
            format!("组件文件名不安全: {name:?}（只允许单层普通文件名）"),
        ));
    }
    // 归档/安装器格式在契约里就固定，不靠扩展名猜：
    let expected = match kind {
        KIND_APP => ".tar.gz",
        KIND_INSTALLER => ".exe",
        _ => "",
    };
    if !expected.is_empty() && !name.ends_with(expected) {
        return Err(update_error(
            E_COMPONENTS,
            format!("组件 {name:?}（kind={kind}）必须以 {expected} 结尾"),
        ));
    }
    Ok(())
}

pub fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 组件集合完整性：必须**恰好**是平台要求的 kind 集合，无缺失、无重复、无未知。
pub fn validate_components(
    platform: &str,
    components: &[Component],
    limits: &FeedLimits,
) -> AppResult<()> {
    let required = required_component_kinds(platform)?;
    for kind in required {
        let count = components.iter().filter(|c| c.kind == *kind).count();
        if count != 1 {
            return Err(update_error(
                E_COMPONENTS,
                format!(
                    "组件集合不完整：平台 {platform} 要求恰好一个 {kind} 组件（实际 {count} 个）"
                ),
            ));
        }
    }
    for component in components {
        if !required.contains(&component.kind.as_str()) {
            return Err(update_error(
                E_COMPONENTS,
                format!(
                    "组件集合含未知 kind {:?}：平台 {platform} 只允许 {required:?}",
                    component.kind
                ),
            ));
        }
        component.validate(limits)?;
    }
    Ok(())
}

// ==========================================
// 校验链
// ==========================================

/// 一个已通过全部校验、可交付下载的候选版本。
#[derive(Debug, Clone)]
pub struct VerifiedRelease {
    pub version: Version,
    pub notes: Option<String>,
    pub envelope: ReleaseEnvelope,
    /// 被签名的 envelope 原始字节（安装状态文件原样保存，helper 复核签名用）。
    pub envelope_bytes: String,
    /// minisign 签名块原文（同上）。
    pub signature: String,
}

/// 解析客户端元数据（`packaging/update.json`）。编译期嵌入的文本一旦漂移，
/// 这里就是启动失败点（不静默回退默认值）。
pub fn parse_config(text: &str, expected_app_id: &str) -> AppResult<UpdateConfig> {
    let config: UpdateConfig = serde_json::from_str(text)
        .map_err(|e| update_error(E_SCHEMA, format!("packaging/update.json 解析失败: {e}")))?;
    if config.schema_version != UPDATE_SCHEMA_VERSION {
        return Err(update_error(
            E_SCHEMA,
            format!(
                "packaging/update.json schemaVersion={} 不受支持（期望 {}）",
                config.schema_version, UPDATE_SCHEMA_VERSION
            ),
        ));
    }
    if config.app_identifier != expected_app_id {
        return Err(update_error(
            E_APP_ID,
            format!(
                "packaging/update.json 的 appIdentifier={} 与应用标识 {} 不一致",
                config.app_identifier, expected_app_id
            ),
        ));
    }
    if !config.feed_url.starts_with("https://") {
        return Err(update_error(
            E_INSECURE_URL,
            format!("feedUrl 必须是 https://: {}", config.feed_url),
        ));
    }
    if config.limits.max_feed_bytes == 0 || config.limits.max_artifact_bytes == 0 {
        return Err(update_error(E_SCHEMA, "limits 的两个上限都必须大于 0"));
    }
    // 公钥可解码性是启动条件：真正验签时才发现坏公钥等于更新永远失败而无人知道。
    crate::update::verify::MinisignVerifier::new(&config.release_public_key)?;
    Ok(config)
}

/// 从 feed 字节选出**当前平台/架构**的最高可用候选。
///
/// 逐道关卡（每一条都是硬拒绝，见契约 §4.5）：
/// 1. feed schemaVersion 与 appIdentifier；
/// 2. 每条 release：先验签（envelope 原始字节），验签不过 → 整份 feed 拒绝（fail closed，
///    不跳过——被篡改的 feed 不能靠跳过坏条目"降级继续"）；
/// 3. envelope 解析 + appIdentifier；
/// 4. 平台/架构过滤：**不属于本目标**的条目跳过（feed 同时发布多平台），
///    属于本目标但版本/组件不合法的条目 → 整份 feed 拒绝（我们自己的制品坏了不能静默）；
/// 5. 版本号解析（不合法拒绝整份 feed——同一 app 的版本号格式必须统一）；
/// 6. 组件集合完整性 + 每个组件的字段格式（https/大小/哈希）；
/// 7. 选最高版本；所有候选都 ≤ 当前版本 → `Ok(None)`（不降级、不重装同版本）。
pub fn select_release(
    feed_bytes: &[u8],
    config: &UpdateConfig,
    target: Target,
    current: &Version,
    verifier: &dyn crate::update::verify::EnvelopeVerifier,
) -> AppResult<Option<VerifiedRelease>> {
    let feed: UpdateFeed = serde_json::from_slice(feed_bytes)
        .map_err(|e| update_error(E_SCHEMA, format!("update.json 解析失败: {e}")))?;
    if feed.schema_version != UPDATE_SCHEMA_VERSION {
        return Err(update_error(
            E_SCHEMA,
            format!(
                "update.json schemaVersion={} 不受支持（期望 {}）",
                feed.schema_version, UPDATE_SCHEMA_VERSION
            ),
        ));
    }
    if feed.app_identifier != config.app_identifier {
        return Err(update_error(
            E_APP_ID,
            format!(
                "update.json 的 appIdentifier={} 不是本应用（期望 {}）",
                feed.app_identifier, config.app_identifier
            ),
        ));
    }

    let mut best: Option<VerifiedRelease> = None;
    for release in &feed.releases {
        // ② 先验签：envelope 的内容在验签前一律不可信。
        verifier.verify(release.envelope.as_bytes(), &release.signature)?;
        let envelope: ReleaseEnvelope = serde_json::from_str(&release.envelope).map_err(|e| {
            update_error(
                E_SCHEMA,
                format!("envelope 解析失败（签名已通过，说明发布端 schema 漂移）: {e}"),
            )
        })?;
        // ③ 应用标识在签名覆盖范围内，这里再核一次。
        if envelope.app_identifier != config.app_identifier {
            return Err(update_error(
                E_APP_ID,
                format!(
                    "envelope 的 appIdentifier={} 不是本应用（期望 {}）",
                    envelope.app_identifier, config.app_identifier
                ),
            ));
        }
        // ④ 其他平台/架构的条目正常跳过（feed 是多平台合集）。
        if envelope.platform != target.platform || envelope.arch != target.arch {
            continue;
        }
        // ⑤⑥ 属于本目标的条目必须完全合法。
        let version = validate_install_candidate(&envelope, config, target)?;
        let candidate = VerifiedRelease {
            version,
            notes: envelope.notes.clone(),
            envelope,
            envelope_bytes: release.envelope.clone(),
            signature: release.signature.clone(),
        };
        // ⑦ 最高版本胜出；≤ 当前版本的条目留着但不入选（返回 None 即"已是最新"）。
        if candidate.version > *current
            && best
                .as_ref()
                .map(|b| candidate.version > b.version)
                .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }
    Ok(best)
}

/// 安装候选的硬校验：check 选中与 helper 安装前复核**共用同一条链**。
///
/// 拒绝项：应用标识不符、平台/架构不符（错误平台）、版本号不合法、
/// 版本 ≤ 当前版本（低版本/同版本拒绝安装）、版本集合不一致、组件集合不完整。
pub fn validate_install_candidate(
    envelope: &ReleaseEnvelope,
    config: &UpdateConfig,
    target: Target,
) -> AppResult<Version> {
    if envelope.app_identifier != config.app_identifier {
        return Err(update_error(
            E_APP_ID,
            format!(
                "envelope 的 appIdentifier={} 不是本应用（期望 {}）",
                envelope.app_identifier, config.app_identifier
            ),
        ));
    }
    if envelope.platform != target.platform {
        return Err(update_error(
            E_PLATFORM,
            format!(
                "envelope 平台 {} 与当前平台 {} 不符",
                envelope.platform, target.platform
            ),
        ));
    }
    if envelope.arch != target.arch {
        return Err(update_error(
            E_ARCH,
            format!(
                "envelope 架构 {} 与当前架构 {} 不符",
                envelope.arch, target.arch
            ),
        ));
    }
    let version = Version::parse(&envelope.version)?;
    if envelope.version_set.app != envelope.version {
        return Err(update_error(
            E_VERSION_SET,
            format!(
                "版本集合声明不一致：versionSet.app={} 与 version={} 不同",
                envelope.version_set.app, envelope.version
            ),
        ));
    }
    Version::parse(&envelope.version_set.node).map_err(|_| {
        update_error(
            E_VERSION_SET,
            format!(
                "版本集合的 node 版本不合法: {:?}",
                envelope.version_set.node
            ),
        )
    })?;
    validate_components(&envelope.platform, &envelope.components, &config.limits)?;
    Ok(version)
}

/// 低版本闸门（helper 安装前对**当前版本**复核；与 [`select_release`] 的 None 语义
/// 分开：这是拒绝安装，不是"已是最新"）。
pub fn ensure_newer(candidate: &Version, current: &Version) -> AppResult<()> {
    if candidate <= current {
        return Err(update_error(
            E_LOW_VERSION,
            format!("拒绝安装低版本/同版本更新：候选 {candidate}，当前 {current}"),
        ));
    }
    Ok(())
}

// ==========================================
// 包内版本集合核对（helper 安装前）
// ==========================================

/// 把包内 `version-set.json` 与**已签名 envelope** 的声明逐项对照。
/// 不一致 = 不完整/混装组件集，拒绝安装（契约 §4.5）。
pub fn validate_bundle_version_set(
    bundle: &BundleVersionSet,
    envelope: &ReleaseEnvelope,
) -> AppResult<()> {
    if bundle.app != envelope.version || bundle.app != envelope.version_set.app {
        return Err(update_error(
            E_VERSION_SET,
            format!(
                "包内 version-set.json 的 app={} 与 envelope 声明不一致（version={}，versionSet.app={}）",
                bundle.app, envelope.version, envelope.version_set.app
            ),
        ));
    }
    if bundle.node != envelope.version_set.node {
        return Err(update_error(
            E_VERSION_SET,
            format!(
                "包内 version-set.json 的 node={} 与 envelope 声明 {} 不一致（Native/Node/JS 必须同集合）",
                bundle.node, envelope.version_set.node
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> UpdateConfig {
        serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "appIdentifier": "com.v1rtual.deskpet",
                "feedUrl": "https://example.com/update.json",
                "releasePublicKey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
                "limits": { "maxFeedBytes": 1048576, "maxArtifactBytes": 2147483648 },
                "codeSigning": {
                    "macosDeveloperId": false,
                    "macosNotarized": false,
                    "windowsAuthenticode": false,
                    "note": "test"
                }
            }"#,
        )
        .expect("测试配置必须可解析")
    }

    fn mac_target() -> Target {
        Target {
            platform: PLATFORM_MACOS,
            arch: ARCH_AARCH64,
        }
    }

    fn valid_component(kind: &str) -> Component {
        Component {
            kind: kind.to_string(),
            name: if kind == KIND_APP {
                "v1rtual-desk-pet-0.17.0-macos-aarch64.app.tar.gz".to_string()
            } else {
                "v1rtual-desk-pet-0.17.0-windows-x86_64-setup.exe".to_string()
            },
            url: "https://example.com/artifact".to_string(),
            size: 1024,
            sha256: "a".repeat(64),
        }
    }

    fn envelope(
        version: &str,
        platform: &str,
        arch: &str,
        components: Vec<Component>,
    ) -> ReleaseEnvelope {
        ReleaseEnvelope {
            app_identifier: "com.v1rtual.deskpet".to_string(),
            version: version.to_string(),
            platform: platform.to_string(),
            arch: arch.to_string(),
            published_at: None,
            notes: None,
            version_set: VersionSet {
                app: version.to_string(),
                node: "22.22.3".to_string(),
            },
            components,
        }
    }

    #[test]
    fn 版本比较遵循_semver_优先级() {
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(v("0.17.0") > v("0.16.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(v("0.16.0") < v("0.16.1"));
        assert!(v("0.16.0") == v("0.16.0"));
        // 预发布 < 正式版；预发布之间按标识比较
        assert!(v("0.17.0-alpha.1") < v("0.17.0"));
        assert!(v("0.17.0-alpha.1") < v("0.17.0-alpha.2"));
        assert!(v("0.17.0-alpha.10") > v("0.17.0-alpha.9"));
        assert!(v("0.17.0-alpha") < v("0.17.0-beta"));
        assert!(v("0.17.0-alpha.1") < v("0.17.0-alpha.1.1"));
        // build metadata 不参与比较
        assert!(v("0.17.0+build.7") == v("0.17.0"));
    }

    #[test]
    fn 非法版本号被拒绝() {
        for bad in [
            "0.17", "0.17.0.1", "a.b.c", "1.02.3", "1.2.3-", "1.2.3-+x", "",
        ] {
            assert!(Version::parse(bad).is_err(), "应拒绝: {bad:?}");
        }
    }

    #[test]
    fn 错误平台与错误架构被拒绝() {
        let config = test_config();
        let env = envelope(
            "0.17.0",
            PLATFORM_WINDOWS,
            ARCH_X86_64,
            vec![valid_component(KIND_INSTALLER)],
        );
        let err = validate_install_candidate(&env, &config, mac_target()).unwrap_err();
        assert_eq!(err.code(), E_PLATFORM);

        let env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_X86_64,
            vec![valid_component(KIND_APP)],
        );
        let err = validate_install_candidate(&env, &config, mac_target()).unwrap_err();
        assert_eq!(err.code(), E_ARCH);
    }

    #[test]
    fn 低版本与同版本拒绝安装() {
        let config = test_config();
        let env = envelope(
            "0.16.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP)],
        );
        // 候选 0.16.0 ≤ 当前 0.16.0：不构成更新
        let version = validate_install_candidate(&env, &config, mac_target()).unwrap();
        let err = ensure_newer(&version, &Version::parse("0.16.0").unwrap()).unwrap_err();
        assert_eq!(err.code(), E_LOW_VERSION);

        let older = Version::parse("0.15.9").unwrap();
        // 参数序是 (候选, 当前)：候选 0.15.9 比当前 0.16.0 旧 → 必须拒绝安装。
        let err = ensure_newer(&older, &Version::parse("0.16.0").unwrap()).unwrap_err();
        assert_eq!(err.code(), E_LOW_VERSION, "低版本必须拒绝");
    }

    #[test]
    fn 不完整组件集被拒绝() {
        let config = test_config();
        // 缺 app 组件
        let env = envelope("0.17.0", PLATFORM_MACOS, ARCH_AARCH64, vec![]);
        let err = validate_install_candidate(&env, &config, mac_target()).unwrap_err();
        assert_eq!(err.code(), E_COMPONENTS);

        // 重复 app 组件
        let env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP), valid_component(KIND_APP)],
        );
        let err = validate_install_candidate(&env, &config, mac_target()).unwrap_err();
        assert_eq!(err.code(), E_COMPONENTS);

        // 混入未知 kind
        let mut unknown = valid_component(KIND_APP);
        unknown.kind = "extra".to_string();
        let env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP), unknown],
        );
        let err = validate_install_candidate(&env, &config, mac_target()).unwrap_err();
        assert_eq!(err.code(), E_COMPONENTS);
    }

    #[test]
    fn 组件字段与包内版本集合校验() {
        let config = test_config();
        // URL 不是 https
        let mut component = valid_component(KIND_APP);
        component.url = "http://example.com/artifact".to_string();
        let env = envelope("0.17.0", PLATFORM_MACOS, ARCH_AARCH64, vec![component]);
        assert_eq!(
            validate_install_candidate(&env, &config, mac_target())
                .unwrap_err()
                .code(),
            E_INSECURE_URL
        );

        // sha256 形态不对
        let mut component = valid_component(KIND_APP);
        component.sha256 = "abc".to_string();
        let env = envelope("0.17.0", PLATFORM_MACOS, ARCH_AARCH64, vec![component]);
        assert_eq!(
            validate_install_candidate(&env, &config, mac_target())
                .unwrap_err()
                .code(),
            E_COMPONENTS
        );

        // size 超过上限
        let mut component = valid_component(KIND_APP);
        component.size = config.limits.max_artifact_bytes + 1;
        let env = envelope("0.17.0", PLATFORM_MACOS, ARCH_AARCH64, vec![component]);
        assert_eq!(
            validate_install_candidate(&env, &config, mac_target())
                .unwrap_err()
                .code(),
            E_TOO_LARGE
        );

        // 包内 version-set.json 与 envelope 不一致（不混装闸门）
        let env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP)],
        );
        let good = BundleVersionSet {
            app: "0.17.0".to_string(),
            node: "22.22.3".to_string(),
            harness: Some("build".to_string()),
        };
        assert!(validate_bundle_version_set(&good, &env).is_ok());
        let stale_js = BundleVersionSet {
            app: "0.17.0".to_string(),
            node: "22.22.3".to_string(),
            harness: None,
        };
        assert!(validate_bundle_version_set(&stale_js, &env).is_ok());
        let mixed = BundleVersionSet {
            app: "0.17.0".to_string(),
            node: "22.20.0".to_string(),
            harness: None,
        };
        assert_eq!(
            validate_bundle_version_set(&mixed, &env)
                .unwrap_err()
                .code(),
            E_VERSION_SET
        );
    }

    #[test]
    fn 组件文件名只允许安全单层名() {
        let limits = test_config().limits;
        for bad in [
            "../x.app.tar.gz",
            "a/b.app.tar.gz",
            ".hidden.app.tar.gz",
            "x\\y.app.tar.gz",
        ] {
            let mut component = valid_component(KIND_APP);
            component.name = bad.to_string();
            assert!(
                component.validate(&limits).is_err(),
                "应拒绝文件名: {bad:?}"
            );
        }
        let mut component = valid_component(KIND_APP);
        component.name = "ok.app.tar.gz".to_string();
        assert!(component.validate(&limits).is_ok());
    }

    #[test]
    fn 配置解析拒绝漂移() {
        let config = test_config();
        assert_eq!(config.app_identifier, "com.v1rtual.deskpet");
        assert_eq!(config.limits.max_feed_bytes, 1048576);
        assert!(!config.code_signing.macos_notarized);

        // schemaVersion 不符
        let drifted = serde_json::to_string(&serde_json::json!({
            "schemaVersion": 2,
            "appIdentifier": "com.v1rtual.deskpet",
            "feedUrl": "https://example.com/update.json",
            "releasePublicKey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
            "limits": { "maxFeedBytes": 1, "maxArtifactBytes": 1 },
            "codeSigning": {
                "macosDeveloperId": false, "macosNotarized": false, "windowsAuthenticode": false
            }
        }))
        .unwrap();
        assert_eq!(
            parse_config(&drifted, "com.v1rtual.deskpet")
                .unwrap_err()
                .code(),
            E_SCHEMA
        );

        // 应用标识不符
        let mismatched = drifted
            .replace("\"schemaVersion\":2", "\"schemaVersion\":1")
            .replace("com.v1rtual.deskpet", "com.other.app");
        assert_eq!(
            parse_config(&mismatched, "com.v1rtual.deskpet")
                .unwrap_err()
                .code(),
            E_APP_ID
        );

        // 公钥不可解码
        let bad_key = drifted
            .replace("\"schemaVersion\":2", "\"schemaVersion\":1")
            .replace(
                "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
                "not-base64!!!",
            );
        assert_eq!(
            parse_config(&bad_key, "com.v1rtual.deskpet")
                .unwrap_err()
                .code(),
            E_BAD_KEY
        );
    }

    // ── select_release：feed 层面的拒绝分支（用假验签器隔离真实密钥）──

    struct RejectAll;
    impl crate::update::verify::EnvelopeVerifier for RejectAll {
        fn verify(&self, _envelope: &[u8], _signature: &str) -> AppResult<()> {
            Err(update_error(E_BAD_SIGNATURE, "测试用拒绝"))
        }
    }

    struct AcceptAll;
    impl crate::update::verify::EnvelopeVerifier for AcceptAll {
        fn verify(&self, _envelope: &[u8], _signature: &str) -> AppResult<()> {
            Ok(())
        }
    }

    fn feed_with(entries: &[(&str, ReleaseEnvelope)]) -> Vec<u8> {
        let releases: Vec<serde_json::Value> = entries
            .iter()
            .map(|(signature, envelope)| {
                serde_json::json!({
                    "envelope": serde_json::to_string(envelope).unwrap(),
                    "signature": signature,
                })
            })
            .collect();
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "appIdentifier": "com.v1rtual.deskpet",
            "releases": releases,
        }))
        .unwrap()
    }

    #[test]
    fn feed_坏签名_整份拒绝() {
        let config = test_config();
        let current = Version::parse("0.16.0").unwrap();
        let feed = feed_with(&[(
            "sig",
            envelope(
                "0.17.0",
                PLATFORM_MACOS,
                ARCH_AARCH64,
                vec![valid_component(KIND_APP)],
            ),
        )]);
        let err = select_release(&feed, &config, mac_target(), &current, &RejectAll).unwrap_err();
        assert_eq!(err.code(), E_BAD_SIGNATURE);
    }

    #[test]
    fn feed_坏_schema_与错误_app_id_拒绝() {
        let config = test_config();
        let current = Version::parse("0.16.0").unwrap();
        let good_env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP)],
        );

        let bad_schema = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 99,
            "appIdentifier": "com.v1rtual.deskpet",
            "releases": [],
        }))
        .unwrap();
        assert_eq!(
            select_release(&bad_schema, &config, mac_target(), &current, &AcceptAll)
                .unwrap_err()
                .code(),
            E_SCHEMA
        );

        let bad_app = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "appIdentifier": "com.other.app",
            "releases": [{ "envelope": serde_json::to_string(&good_env).unwrap(), "signature": "sig" }],
        }))
        .unwrap();
        assert_eq!(
            select_release(&bad_app, &config, mac_target(), &current, &AcceptAll)
                .unwrap_err()
                .code(),
            E_APP_ID
        );
    }

    #[test]
    fn feed_选最高版本且跳过其他平台() {
        let config = test_config();
        let current = Version::parse("0.16.0").unwrap();
        let feed = feed_with(&[
            (
                "sig",
                envelope(
                    "0.16.5",
                    PLATFORM_MACOS,
                    ARCH_AARCH64,
                    vec![valid_component(KIND_APP)],
                ),
            ),
            (
                "sig",
                envelope(
                    "0.18.0",
                    PLATFORM_WINDOWS,
                    ARCH_X86_64,
                    vec![valid_component(KIND_INSTALLER)],
                ),
            ),
            (
                "sig",
                envelope(
                    "0.17.0",
                    PLATFORM_MACOS,
                    ARCH_AARCH64,
                    vec![valid_component(KIND_APP)],
                ),
            ),
        ]);
        let best = select_release(&feed, &config, mac_target(), &current, &AcceptAll)
            .unwrap()
            .expect("应有候选");
        assert_eq!(best.version.to_string(), "0.17.0");

        // 只有低版本的 feed：不是错误，是「已是最新」
        let stale = feed_with(&[(
            "sig",
            envelope(
                "0.16.0",
                PLATFORM_MACOS,
                ARCH_AARCH64,
                vec![valid_component(KIND_APP)],
            ),
        )]);
        assert!(
            select_release(&stale, &config, mac_target(), &current, &AcceptAll)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn feed_本平台坏条目整份拒绝() {
        let config = test_config();
        let current = Version::parse("0.16.0").unwrap();
        // 本平台条目缺组件 → 拒绝整份 feed（不能静默跳过自己的坏制品）
        let feed = feed_with(&[(
            "sig",
            envelope("0.17.0", PLATFORM_MACOS, ARCH_AARCH64, vec![]),
        )]);
        assert_eq!(
            select_release(&feed, &config, mac_target(), &current, &AcceptAll)
                .unwrap_err()
                .code(),
            E_COMPONENTS
        );
    }

    #[test]
    fn feed_版本号不合法拒绝() {
        let config = test_config();
        let current = Version::parse("0.16.0").unwrap();
        let feed = feed_with(&[(
            "sig",
            envelope(
                "0.17",
                PLATFORM_MACOS,
                ARCH_AARCH64,
                vec![valid_component(KIND_APP)],
            ),
        )]);
        assert_eq!(
            select_release(&feed, &config, mac_target(), &current, &AcceptAll)
                .unwrap_err()
                .code(),
            E_SCHEMA
        );
    }

    #[test]
    fn 版本集合声明不一致拒绝() {
        let config = test_config();
        let mut env = envelope(
            "0.17.0",
            PLATFORM_MACOS,
            ARCH_AARCH64,
            vec![valid_component(KIND_APP)],
        );
        env.version_set.app = "0.16.0".to_string();
        assert_eq!(
            validate_install_candidate(&env, &config, mac_target())
                .unwrap_err()
                .code(),
            E_VERSION_SET
        );
    }
}
