//! 受控富文本块协议（执行契约 §6.3）—— 平台无关的安全文本解析。
//!
//! 输入是聊天正文的纯文本（与今天 ChatPanel 里 `<span>` 插值的同一份字符串），
//! 输出是**数据**的块/跨度列表；平台层只按这份列表构造原生富文本
//! （AppKit attributed string / RichEdit RTF），本模块：
//!
//! - **不执行** HTML/脚本，不做任何求值：输出只有文本与样式位；
//! - **不为 Markdown 图片语法访问网络**：`![alt](url)` 只渲染为占位文本
//!   （图片内容只走附件占位协议，见 `placeholders.rs`）；
//! - 链接只保留 http/https/mailto 三种协议（[`sanitize_link`]），其余协议
//!   （`javascript:`、`file:`、`data:`……）降级为纯文本；真正的打开动作
//!   只发生在用户点击时、由平台层经宿主打开（见 `ui/platform/*_chat.rs`）。
//!   点击时还要**二次复核**（[`resolve_link_click`]）；macOS 平台层挂载的
//!   `NSLinkAttributeName` 只是惰性占位值（[`INERT_LINK_VALUE`]），真实目标
//!   另存自定义属性（[`LINK_TARGET_ATTRIBUTE`]）—— 即便某个视图漏设 delegate，
//!   AppKit 的默认打开也碰不到真实目标（「禁自动触发」由属性形态保证，
//!   不依赖某个回调被调到）。
//!
//! 支持的最小集合（§6.3 的固定清单）：段落/换行、粗体/斜体、有序/无序列表、
//! 引用块、行内代码、围栏代码块（可横向滚动）、链接、表格。不做完整 CommonMark，
//! 也不扩成 HTML/CSS 引擎。

/// 一个文本跨度：连续同格式的一段文字。
///
/// `link` 是已通过 [`sanitize_link`] 的 URL；平台层据此构造可点击形态
/// （macOS：惰性占位属性 + 目标属性；Windows：RTF 超链接域 + 显示文本→URL 回查表），
/// 打开动作在点击回调里经 [`resolve_link_click`] 复核后发生。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Span {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub link: Option<String>,
}

impl Span {
    /// 无格式纯文本跨度。
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }
}

/// 表格的一行；`header` 为真表示这是表头行（分隔行之后的续行都为假）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TableRow {
    pub header: bool,
    pub cells: Vec<Vec<Span>>,
}

/// 受控块。平台层按块构造原生富文本；代码块是唯一允许独立横向滚动的块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// 一个段落（一行文本；换行即新段落，与聊天正文的直排一致）。
    Paragraph(Vec<Span>),
    /// 列表项（`ordered=false` 为无序；`number` 为有序项显示编号，1 起）。
    ListItem {
        ordered: bool,
        number: u64,
        depth: u8,
        spans: Vec<Span>,
    },
    /// 引用块的一行。
    Quote(Vec<Span>),
    /// 围栏代码块：行不折行、由平台提供横向滚动。
    CodeBlock {
        lang: Option<String>,
        lines: Vec<String>,
    },
    /// 表格（原生网格布局）。
    Table { rows: Vec<TableRow> },
}

/// 无序列表允许的前缀标记。
const BULLET_MARKERS: [&str; 3] = ["- ", "* ", "+ "];

/// 列表最大缩进层级（超过按 3 处理；避免深层递归式缩进把正文挤没）。
const MAX_LIST_DEPTH: u8 = 3;

/// 围栏代码块信息串（语言名）的字符上限。
const MAX_LANG_LEN: usize = 24;

/// 解析一段聊天正文（一条消息的一个 part）为块列表。
///
/// 流式半截文本同样可解析：未闭合的围栏代码块按「到结尾为止」闭合，
/// 未闭合的行内标记到行尾自然结束。
pub fn parse_blocks(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut blocks = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();

        // ── 围栏代码块 ──
        if let Some(fence) = fence_marker(trimmed) {
            let lang = fence_lang(trimmed, fence);
            let mut body = Vec::new();
            index += 1;
            while index < lines.len() {
                let candidate = lines[index].trim_start();
                if is_fence(candidate, fence) {
                    index += 1;
                    break;
                }
                body.push(lines[index].to_string());
                index += 1;
            }
            blocks.push(Block::CodeBlock { lang, lines: body });
            continue;
        }

        // ── 表格：连续以 `|` 开头的行，且第 2 行是分隔行 ──
        if is_table_candidate(line) {
            let start = index;
            let mut run = Vec::new();
            while index < lines.len() && is_table_candidate(lines[index]) {
                run.push(lines[index]);
                index += 1;
            }
            if run.len() >= 2 && is_table_separator(run[1]) {
                let mut rows = Vec::new();
                let mut body_number = 0u64;
                for (row_index, row) in run.iter().enumerate() {
                    if row_index == 1 {
                        continue; // 分隔行不是内容
                    }
                    let cells: Vec<Vec<Span>> = split_table_cells(row)
                        .into_iter()
                        .map(|cell| parse_spans(&cell))
                        .collect();
                    rows.push(TableRow {
                        header: row_index == 0,
                        cells,
                    });
                    body_number += 1;
                }
                let _ = body_number;
                blocks.push(Block::Table { rows });
            } else {
                // 不是表格（缺少分隔行）：按普通段落逐行处理。
                for row in run {
                    blocks.push(Block::Paragraph(parse_spans(row.trim())));
                }
            }
            let _ = start;
            continue;
        }

        // ── 引用块 ──
        if let Some(rest) = quote_body(line) {
            blocks.push(Block::Quote(parse_spans(rest)));
            index += 1;
            continue;
        }

        // ── 列表 ──
        if let Some(item) = list_item(line) {
            blocks.push(item);
            index += 1;
            continue;
        }

        // ── 普通段落（空行产生空段落，渲染侧自行跳过）──
        blocks.push(Block::Paragraph(parse_spans(line)));
        index += 1;
    }
    blocks
}

/// 围栏标记（``` 或 ~~~ 开头的连续标记），返回其字符。
fn fence_marker(trimmed: &str) -> Option<char> {
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|c| *c == first).count();
    if run >= 3 {
        Some(first)
    } else {
        None
    }
}

fn is_fence(trimmed: &str, marker: char) -> bool {
    let run = trimmed.chars().take_while(|c| *c == marker).count();
    run >= 3
}

/// 围栏后的信息串（语言名）：只保留字母/数字/`_+-.#`，其余截断。
fn fence_lang(trimmed: &str, marker: char) -> Option<String> {
    let info = trimmed.trim_start_matches(marker).trim();
    let lang: String = info
        .chars()
        .take(MAX_LANG_LEN)
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-' | '.' | '#'))
        .collect();
    if lang.is_empty() {
        None
    } else {
        Some(lang)
    }
}

/// 表格候选行：去空白后以 `|` 开头。
fn is_table_candidate(line: &str) -> bool {
    line.trim().starts_with('|')
}

/// 分隔行：`|---|---|`（允许 `:` 对齐标记与空格）。
fn is_table_separator(line: &str) -> bool {
    let cells = split_table_cells(line);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let cell = cell.trim();
            let core = cell.trim_matches(':');
            !core.is_empty() && core.chars().all(|c| c == '-')
        })
}

/// 拆表格行：去掉首尾边界管，按 `|` 分列（不处理转义竖线，属固定样例之外的输入）。
fn split_table_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    inner
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

/// 引用行：`>` 或 `> ` 前缀，返回去掉一层引用的正文。
fn quote_body(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('>') {
        Some(rest.strip_prefix(' ').unwrap_or(rest))
    } else {
        None
    }
}

/// 列表行：`- `/`* `/`+ ` 或 `1. `/`1) `；缩进（空格 2 个 / 制表符 4 个为一级）决定层级。
fn list_item(line: &str) -> Option<Block> {
    let indent_columns = line
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum::<usize>();
    let depth = ((indent_columns / 2).min(MAX_LIST_DEPTH as usize)) as u8;
    let body = line.trim_start();

    for marker in BULLET_MARKERS {
        if let Some(rest) = body.strip_prefix(marker) {
            return Some(Block::ListItem {
                ordered: false,
                number: 0,
                depth,
                spans: parse_spans(rest.trim_end()),
            });
        }
    }

    let digits: String = body.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() && digits.len() <= 9 {
        let rest = &body[digits.len()..];
        let after = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "));
        if let Some(rest) = after {
            let number = digits.parse::<u64>().unwrap_or(1);
            return Some(Block::ListItem {
                ordered: true,
                number,
                depth,
                spans: parse_spans(rest.trim_end()),
            });
        }
    }
    None
}

// ==========================================
// 行内跨度
// ==========================================

/// 链接协议白名单：只允许用户点击后由宿主打开的安全协议。
pub fn sanitize_link(url: &str) -> Option<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        // 控制字符会让平台 API 收到非预期内容，直接拒绝。
        if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return None;
        }
        Some(url.to_string())
    } else {
        None
    }
}

/// macOS 平台层挂给 `NSLinkAttributeName` 的**惰性占位值**。
///
/// AppKit 对 `NSLinkAttributeName` 的默认处理（delegate 未实现或未挂载时）是直接
/// 用 `NSWorkspace` 打开属性值。这里让该值永远是同一个**没有处理器**的固定协议，
/// 真实 URL 只存 [`LINK_TARGET_ATTRIBUTE`]：即便某处漏设 delegate，默认路径也只能
/// 尝试打开这个惰性值（`openURL` 失败）——**打不开任何真实目标**，fail-closed。
/// 「禁自动触发」因此由属性形态保证，而不是「某个回调被调到」。
/// （Windows 的 RichEdit 没有对应的默认打开行为，点击只产生 `EN_LINK` 通知，
/// 天然 fail-closed；两侧的二次复核共用 [`resolve_link_click`]。）
pub const INERT_LINK_VALUE: &str = "deskpet-link:inert";

/// 链接真实目标的自定义属性名（`NSAttributedString` 键）。
///
/// 只有聊天窗自己挂载它；点击回调只信这里读出的目标，不信 `NSLinkAttributeName`
/// 的值（后者永远是 [`INERT_LINK_VALUE`]）。
pub const LINK_TARGET_ATTRIBUTE: &str = "DeskPetLinkTarget";

/// 链接点击的放行裁决（纯函数；平台层点击回调与单元测试共用）。
///
/// - `target` = 点击位置读出的真实目标（macOS 读自定义属性；Windows 按「显示文本 →
///   URL」回查表取出）——目标必须能回查到，绝不自造「只有显示文本」的打开；
/// - 目标必须再次通过 [`sanitize_link`] 的白名单复核（点击时二次复核）。
///
/// 返回 `Some(url)` 是**唯一**允许交给宿主打开的值；`None` = 拒绝。
/// **拒绝时调用方也必须报告「已处理」**（macOS 返回 `YES`、Windows 直接吞掉通知），
/// 不能让系统回落到默认打开（契约 §6.3：链接仅用户点击后经宿主打开、禁自动触发）。
pub fn resolve_link_click(target: Option<&str>) -> Option<String> {
    target.and_then(sanitize_link)
}

/// 解析一行文本为跨度列表（粗体 `**`/`__`、斜体 `*`/`_`、行内代码、链接、图片占位）。
pub fn parse_spans(text: &str) -> Vec<Span> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans: Vec<Span> = Vec::new();
    let mut buffer = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut code = false;
    let mut index = 0usize;

    macro_rules! flush {
        () => {
            if !buffer.is_empty() {
                spans.push(Span {
                    text: std::mem::take(&mut buffer),
                    bold,
                    italic,
                    code,
                    link: None,
                });
            }
        };
    }

    while index < chars.len() {
        let ch = chars[index];

        // 反斜杠转义：`\*` 等原样输出、不触发标记。
        if ch == '\\' && index + 1 < chars.len() && is_escapable(chars[index + 1]) {
            buffer.push(chars[index + 1]);
            index += 2;
            continue;
        }

        if code {
            if ch == '`' {
                flush!();
                code = false;
                index += 1;
            } else {
                buffer.push(ch);
                index += 1;
            }
            continue;
        }

        if ch == '`' {
            flush!();
            code = true;
            index += 1;
            continue;
        }

        // 图片：`![alt](url)` —— 只占位，不取图、不联网。
        if ch == '!' && index + 1 < chars.len() && chars[index + 1] == '[' {
            if let Some((alt, _url, next)) = parse_link_at(&chars, index + 1) {
                flush!();
                spans.push(Span {
                    text: format!("[图片：{}]", alt),
                    code: true,
                    ..Span::default()
                });
                index = next;
                continue;
            }
        }

        // 链接：`[text](url)`；非法协议降级为纯文本，URL 原样展示但不可点击。
        if ch == '[' {
            if let Some((label, url, next)) = parse_link_at(&chars, index) {
                flush!();
                match sanitize_link(&url) {
                    Some(safe) => {
                        for mut span in parse_spans(&label) {
                            span.link = Some(safe.clone());
                            spans.push(span);
                        }
                    }
                    None => {
                        for mut span in parse_spans(&label) {
                            span.link = None;
                            spans.push(span);
                        }
                        if !url.trim().is_empty() {
                            spans.push(Span::plain(format!("（{}）", url.trim())));
                        }
                    }
                }
                index = next;
                continue;
            }
        }

        if ch == '*' {
            let run = chars[index..].iter().take_while(|c| **c == '*').count();
            let next_char = chars.get(index + run).copied();
            let next_is_space = next_char.map(|c| c.is_whitespace()).unwrap_or(true);
            // 标记后是空白/行尾：不能**开启**样式（`* 星号` 保持字面量），
            // 但**可以关闭**当前样式 —— `*斜*`（行尾收尾）与 `*斜* 后续`（空白前收尾）
            // 的收尾标记都落在空白/行尾前，此前一律当字面量留在样式泡里。
            let closes = if run >= 2 { bold } else { italic };
            if run >= 1 && (!next_is_space || closes) {
                flush!();
                if run >= 2 {
                    bold = !bold;
                }
                if run >= 2 && run % 2 == 1 {
                    italic = !italic;
                } else if run == 1 {
                    italic = !italic;
                }
                index += run;
                continue;
            }
        }

        if ch == '_' {
            let run = chars[index..].iter().take_while(|c| **c == '_').count();
            let prev = if index == 0 {
                None
            } else {
                chars.get(index - 1).copied()
            };
            let next = chars.get(index + run).copied();
            let intraword = prev.map(|c| c.is_alphanumeric()).unwrap_or(false)
                && next.map(|c| c.is_alphanumeric()).unwrap_or(false);
            let next_is_space = next.map(|c| c.is_whitespace()).unwrap_or(true);
            // 与 `*` 同一条规则：行尾/空白前的下划线不能开启样式，但可以关闭
            // （`_斜_` 的收尾在行尾、`_斜_ 后续` 的收尾在空白前）。
            let closes = if run >= 2 { bold } else { italic };
            if !intraword && (!next_is_space || closes) {
                flush!();
                if run >= 2 {
                    bold = !bold;
                } else {
                    italic = !italic;
                }
                index += run;
                continue;
            }
        }

        buffer.push(ch);
        index += 1;
    }

    if code {
        // 未闭合的行内代码：恢复为普通文本样式（流式半截可读，不吞字符）。
        code = false;
    }
    flush!();
    spans
}

fn is_escapable(ch: char) -> bool {
    matches!(
        ch,
        '\\' | '*' | '_' | '`' | '[' | ']' | '(' | ')' | '!' | '|' | '>' | '-'
    )
}

/// 在 `chars[start] == '['` 处解析 `[label](url)`；返回 (label, url, 下一位置)。
fn parse_link_at(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    debug_assert_eq!(chars.get(start), Some(&'['));
    let mut depth = 0i32;
    let mut close = None;
    for (offset, ch) in chars[start..].iter().enumerate() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(start + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let mut paren_depth = 0i32;
    let mut url_end = None;
    for (offset, ch) in chars[close + 1..].iter().enumerate() {
        match ch {
            '(' => paren_depth += 1,
            ')' => {
                paren_depth -= 1;
                if paren_depth == 0 {
                    url_end = Some(close + 1 + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let url_end = url_end?;
    let label: String = chars[start + 1..close].iter().collect();
    let url: String = chars[close + 2..url_end].iter().collect();
    Some((label, url, url_end + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 段落与换行逐行成块() {
        let blocks = parse_blocks("第一行\n第二行\n\n第四行");
        assert_eq!(
            blocks,
            vec![
                Block::Paragraph(vec![Span::plain("第一行")]),
                Block::Paragraph(vec![Span::plain("第二行")]),
                Block::Paragraph(vec![]),
                Block::Paragraph(vec![Span::plain("第四行")]),
            ]
        );
    }

    #[test]
    fn 粗体斜体行内代码() {
        let spans = parse_spans("普通**粗**与*斜*和`code()`");
        assert_eq!(
            spans,
            vec![
                Span {
                    text: "普通".into(),
                    ..Span::default()
                },
                Span {
                    text: "粗".into(),
                    bold: true,
                    ..Span::default()
                },
                Span {
                    text: "与".into(),
                    ..Span::default()
                },
                Span {
                    text: "斜".into(),
                    italic: true,
                    ..Span::default()
                },
                Span {
                    text: "和".into(),
                    ..Span::default()
                },
                Span {
                    text: "code()".into(),
                    code: true,
                    ..Span::default()
                },
            ]
        );
    }

    #[test]
    fn 中文紧邻星号仍可识别强调() {
        let spans = parse_spans("这是*重点*内容");
        assert_eq!(spans.len(), 3);
        assert!(spans[1].italic);
        assert_eq!(spans[1].text, "重点");
    }

    #[test]
    fn 单词内部下划线不触发斜体() {
        let spans = parse_spans("foo_bar_baz 与 _斜_");
        assert!(spans[0].text.contains("foo_bar_baz"));
        assert!(!spans[0].italic);
        assert!(spans.iter().any(|span| span.italic && span.text == "斜"));
        // 收尾标记后是空白同样是「闭合」而不是字面量（共享同一条判断：
        // 空白/行尾前不能开启样式，但可以关闭）。
        let spans = parse_spans("*斜* 后续");
        assert!(spans.iter().any(|span| span.italic && span.text == "斜"));
        assert!(spans
            .iter()
            .any(|span| !span.italic && span.text.contains("后续")));
    }

    #[test]
    fn 未闭合行内标记在行尾自然结束且字符不丢() {
        let spans = parse_spans("**没闭合的粗体");
        let joined: String = spans.iter().map(|span| span.text.clone()).collect();
        assert_eq!(joined, "没闭合的粗体");
    }

    #[test]
    fn 反斜杠转义不触发标记() {
        let spans = parse_spans(r"\*不是斜体\*");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "*不是斜体*");
        assert!(!spans[0].italic);
    }

    #[test]
    fn 链接只保留安全协议且不自动打开() {
        let spans = parse_spans("看[这里](https://example.com/a)和[那边](javascript:alert(1))");
        let linked: Vec<&Span> = spans.iter().filter(|span| span.link.is_some()).collect();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].link.as_deref(), Some("https://example.com/a"));
        assert_eq!(linked[0].text, "这里");
        // 不安全协议：文本保留、URL 以纯文本出现、没有可点击链接。
        let joined: String = spans.iter().map(|span| span.text.clone()).collect();
        assert!(joined.contains("javascript:alert(1)"));
        assert!(spans.iter().all(
            |span| span.link.is_none() || span.link.as_deref().unwrap().starts_with("https://")
        ));
    }

    #[test]
    fn 危险协议一律拒绝() {
        assert!(sanitize_link("javascript:alert(1)").is_none());
        assert!(sanitize_link("file:///etc/passwd").is_none());
        assert!(sanitize_link("data:text/html,x").is_none());
        assert!(sanitize_link("/relative/path").is_none());
        assert!(sanitize_link("https://例子.测试/路径").is_some());
        assert!(sanitize_link("mailto:a@b.c").is_some());
        assert!(
            sanitize_link("http://a b/c").is_none(),
            "带空白字符的 URL 拒绝"
        );
    }

    #[test]
    fn 链接点击裁决只放行白名单目标() {
        // 唯一放行形态：目标能回查到且是白名单协议。
        assert_eq!(
            resolve_link_click(Some("https://example.com/a")),
            Some("https://example.com/a".to_string())
        );
        assert_eq!(
            resolve_link_click(Some("mailto:a@b.c")),
            Some("mailto:a@b.c".to_string())
        );
        // 目标缺失（例如只点到惰性占位属性）→ 拒绝，不回落任何属性值。
        assert_eq!(resolve_link_click(None), None);
        // 点击时二次复核：非白名单协议一律拒绝。
        assert_eq!(resolve_link_click(Some("javascript:alert(1)")), None);
        assert_eq!(resolve_link_click(Some("file:///etc/passwd")), None);
        assert_eq!(resolve_link_click(Some("http://a b/c")), None);
    }

    #[test]
    fn 惰性占位值不能通过白名单复核() {
        // macOS 上「漏设 delegate → AppKit 默认打开属性值」这条兜底路径只可能碰到
        // INERT_LINK_VALUE；它不是可打开目标 = 兜底路径打开不了任何真实目标。
        assert!(sanitize_link(INERT_LINK_VALUE).is_none());
        assert!(resolve_link_click(Some(INERT_LINK_VALUE)).is_none());
    }

    #[test]
    fn markdown图片语法只占位不联网() {
        let spans = parse_spans("前面![猫咪](https://example.com/cat.png)后面");
        let joined: String = spans.iter().map(|span| span.text.clone()).collect();
        assert!(joined.contains("[图片：猫咪]"));
        assert!(!joined.contains("example.com/cat.png"), "URL 不得进入正文");
        assert!(spans.iter().all(|span| span.link.is_none()));
    }

    #[test]
    fn 无序与有序列表带层级() {
        let blocks = parse_blocks("- 一\n  - 二层\n1. 甲\n2) 乙");
        assert_eq!(
            blocks[0],
            Block::ListItem {
                ordered: false,
                number: 0,
                depth: 0,
                spans: vec![Span::plain("一")]
            }
        );
        assert_eq!(
            blocks[1],
            Block::ListItem {
                ordered: false,
                number: 0,
                depth: 1,
                spans: vec![Span::plain("二层")]
            }
        );
        assert_eq!(
            blocks[2],
            Block::ListItem {
                ordered: true,
                number: 1,
                depth: 0,
                spans: vec![Span::plain("甲")]
            }
        );
        assert_eq!(
            blocks[3],
            Block::ListItem {
                ordered: true,
                number: 2,
                depth: 0,
                spans: vec![Span::plain("乙")]
            }
        );
    }

    #[test]
    fn 引用块逐行成块() {
        let blocks = parse_blocks("> 引用一\n> 引用二");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], Block::Quote(vec![Span::plain("引用一")]));
        assert_eq!(blocks[1], Block::Quote(vec![Span::plain("引用二")]));
    }

    #[test]
    fn 围栏代码块含语言与内容() {
        let blocks = parse_blocks("```rust\nfn main() {}\nlet x = 1;\n```\n尾声");
        assert_eq!(
            blocks[0],
            Block::CodeBlock {
                lang: Some("rust".into()),
                lines: vec!["fn main() {}".into(), "let x = 1;".into()]
            }
        );
        assert_eq!(blocks[1], Block::Paragraph(vec![Span::plain("尾声")]));
    }

    #[test]
    fn 未闭合围栏按半截可读处理() {
        let blocks = parse_blocks("```\n流式半截");
        assert_eq!(
            blocks[0],
            Block::CodeBlock {
                lang: None,
                lines: vec!["流式半截".into()]
            }
        );
    }

    #[test]
    fn 表格识别表头与数据行() {
        let blocks = parse_blocks("| 场景 | 能力 |\n|---|---|\n| 聊天 | 富文本 |");
        match &blocks[0] {
            Block::Table { rows } => {
                assert_eq!(rows.len(), 2);
                assert!(rows[0].header);
                assert!(!rows[1].header);
                assert_eq!(rows[0].cells[0], vec![Span::plain("场景")]);
                assert_eq!(rows[1].cells[1], vec![Span::plain("富文本")]);
            }
            other => panic!("应为表格，得到 {other:?}"),
        }
    }

    #[test]
    fn 缺少分隔行的竖线行回退为段落() {
        let blocks = parse_blocks("| 不是 | 表格 |\n| 第二 | 行 |");
        assert!(blocks
            .iter()
            .all(|block| matches!(block, Block::Paragraph(_))));
    }

    #[test]
    fn 空输入与纯空白不产生内容() {
        assert_eq!(parse_blocks(""), vec![Block::Paragraph(vec![])]);
        let spans = parse_spans("");
        assert!(spans.is_empty());
    }
}
