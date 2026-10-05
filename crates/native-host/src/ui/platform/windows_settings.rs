//! Windows 设置窗内容（W9a）：左竖栏五个 Tab（通用/外观/AI/工具/记忆）与各页原生控件。
//!
//! **未在 Windows 实机验证**（本机离线类型核对，见原生宿主迁移过程记录 §9.4 第 19 条）。
//! 结构与 macOS 同语义：schema 驱动控件、值来自 `SettingsUi` 草稿、保存先采全表
//! 再提交端口；未接线时控件禁用并给中性说明。
//!
//! 与 macOS 的已登记差异：
//! - 竖栏行按钮用 `BUTTON` 替代 `NSButton`（ownerdraw，`TabOn`/`TabOff` 两态面）；
//! - Bool 开关是 `BS_OWNERDRAW` 按钮 + 状态镜像表（不承载 `BM_SETCHECK` 语义）；
//! - 数字用 `EDIT` 文本输入（macOS 侧同类），不引入 Trackbar；
//! - 滚动由设置窗自身的 `WS_VSCROLL` 承担，内容控件按滚动量整体位移。
//! 本文件全部代码只在 UI 主线程运行。
//!
//! ## 主题接线（范围 c：设置窗）
//!
//! - **窗底**自绘（类的画刷留空，见 `windows.rs` 的附属窗类注册）：用
//!   `tokens().field_bg` 而不是 `panel_bg`。设置窗是整块「工作表」，没有聊天面板
//!   「浮在舞台上的玻璃/金属板」那套语义（纹理、外描边、投影、内立体线都不该铺满
//!   整窗）；`field_bg` 是三套主题里最「下沉」的中性工作面色（与输入框/待发 chip
//!   同族），`ink`/`dim` 文字与系统控件落在它上面的对比度在三套主题里都稳定。
//! - **左竖栏**：`rail_bg` 铺到右缘 1px `rail_edge` 分界线；行按钮是 ownerdraw
//!   （选中 `TabOn`、未选中 `TabOff`，圆角随 `radii.sm`）。
//! - **分隔线**取 `bar_edge`：底部固定条的上边线一条（原顶部 Tab 带随竖栏改造删除；
//!   2026-10-05 从 `rule` 收敛到与 macOS 页脚分隔线同款的 `bar_edge`）。
//! - **文字色**经 `WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN` 下发：控件创建时按
//!   [`TextRole`] 记录字色（`paint_win::set_text_color` 的既有存储约定），未记录的
//!   控件回落到 `ink`；禁用控件统一降为 `dim`。错误/警告行分别取 `danger` / `warn`。
//! - **按钮**：**全面自绘**（用户规则 2026-10-05）——全部按钮 ownerdraw：提交类动作
//!   （四个「保存」入口）走 `primary_*` 主按钮面、其余走 `btn_bg` 普通面（表见
//!   [`button_role`]）；禁用在 `paint_win` 的 `disabled_face` 里、键盘焦点环由
//!   [`draw_focus_ring`] 补（ownerdraw 没有系统焦点矩形），悬浮/圆角靠
//!   `paint_win::install_button` 的子类。层级感只靠 primary/normal 一档区分。
//! - **下拉**：`CBS_OWNERDRAWFIXED` + `WM_DRAWITEM`（[`draw_combo_item`]）：字段区取
//!   输入面族、清单条目取 `field_bg` + 选中覆盖；真下拉语义保留（键盘 / `CBN_*` /
//!   `CB_GETCURSEL` 等读写路径零改动）。条目高度用 `CB_SETITEMHEIGHT(-1, h)` 设定
//!   （`WM_MEASUREITEM` 不在设置窗分派里，见该样式的注释）。
//! - **可编辑 `EDIT`**：`WM_CTLCOLOREDIT`（底 `field_bg`、字 `ink`、插入符随字色）经
//!   设置窗的 comctl32 父类链补上（[`settings_subclass_proc`]；`aux_wndproc` 只转发
//!   STATIC/BTN 两路，而 `windows.rs` 不在本批所有权内）。
//! - **Bool 开关**：`paint_win::draw_switch` 自绘轨道+滑块；开/关读
//!   `settings::SwitchStates` 的状态镜像表（键 = 控件句柄整数）。
//! - **换主题**：GDI 画刷都在 `paint_win` 的主题缓存里，由 `windows.rs` 的广播先
//!   `release_theme_resources()`（`DeleteObject` 发生在那里）再调 [`apply_theme`]；
//!   本文件自己不持有需要释放的 GDI 对象，`apply_theme` 只重刷字色 + 重贴圆角 + 强制重绘。
//!
//! ## 通知分档（①，2026-10-05 用户规则「提示信息全在左下角，改成弹窗最好」）
//!
//! 共享层把通知分成 `NoticeLevel` 三档，平台按档呈现：
//!
//! - **Error → 模态弹窗**（必须看见并确认）：用系统 `MessageBoxW`（属主 = 设置窗），
//!   与 `confirm_dangerous` / 更新确认同一档；不选自建模态窗 —— 自建窗存在的理由是
//!   它要「复制详情 + 可滚动详情框」（`MessageBoxW` 给不了），本档只需要「一段文本 +
//!   必须确认」。系统对话框自带应用内模态（属主禁用）、DPI、键盘与任务栏语义。
//! - **Info / Warning → 顶部居中浮层**：设置窗的**子窗口**（不用顶层弹窗 —— 设置窗是
//!   `WS_EX_TOPMOST` 的层级窗，另开顶层窗就要处理「压在最上层 / 被设置窗盖住 /
//!   任务栏与 alt-tab」整套 z 序；子窗口不参与顶层 z 序，随设置窗移动/缩放/关闭）。
//!   浮层脱离布局流（绝对定位，内容不位移），几秒自动消失（`SetTimer` + `TIMERPROC`
//!   回调 —— 不要求设置窗过程函数转发 `WM_TIMER`），不吞点击（`WM_NCHITTEST` 回
//!   `HTTRANSPARENT`）。判新**只认 `notice_generation`、不比较文本**：同一句话连报
//!   两次时文本相等，靠文本比较会被误判成「还是那一条」而不再计时。
//! - 已有模态（错误弹窗 / 文档弹窗）在显时错误通知不嵌套抢弹：代际不记账，
//!   收尾后的下一次刷新补呈现（与 macOS `notice_modal_up` 同规）。
//!
//! 底部状态行不再承载通知，只留「未接线 / 正在保存 / 有 N 项未保存」这类常驻状态。
//! 快捷键录制是「模式」不是通知：提示固定留在状态行、录制期间不被刷新抹掉。
//!
//! ## 行编辑文档弹窗（②，同日用户规则「显示的东西有的在页面最底部」）
//!
//! 根因：文档区原先被无条件追加在 `build_panel_controls` 末尾，所以「当前卡阶段文案」
//! 与 `V1RTUAL.md` 编辑器永远在整页最下面。现在改为**独立模态编辑窗**（与 macOS
//! `present_document_dialog` 同口径）：文档**加载完成后**弹一次，保存是主操作、
//! 关闭/Esc/× 丢弃未保存编辑；打开/加载/保存/关闭全部复用 `SettingsUi` 的既有入口。
//! 目标匹配时另有**次要动作**（阶段文案「重新生成」/ MCP「测试连接」/ 只读 Card 模版
//! 「复制」）：不关弹窗，结果经共享层刷新回流或就地反馈 —— 新内容进编辑框、
//! Info/Warning 通知进说明行（模态期间唯一可见的反馈通道；Error 由模态门挡下、
//! 收尾后补弹）。详见「行编辑文档弹窗」小节。
//!
//! ## 全面自绘（③，用户规则 2026-10-05：「然后全面自绘」）
//!
//! 用户已确认 ③ 的静态核对结论（系统面在深色主题下不跟主题 = 覆盖面缺口），本批补齐：
//!
//! - **按钮全部 ownerdraw**（[`button_role`]：四个「保存」入口 `primary_*`、其余
//!   `btn_bg` 普通面）；禁用态走 `paint_win::disabled_face`，键盘焦点环由
//!   [`draw_focus_ring`] 补（ownerdraw 没有系统焦点矩形），悬浮/圆角由
//!   `paint_win::install_button` 的子类承担；`apply_theme` 对**所有**自绘按钮重贴
//!   `radii.btn`（开关半高胶囊、竖栏 `radii.sm` 各自单列）。
//! - **下拉全部 ownerdraw**：`CBS_OWNERDRAWFIXED` + [`draw_combo_item`]（字段区取
//!   输入面族、清单条目取 `field_bg` + 选中覆盖）。选这条路而不是「chip + 弹出菜单」：
//!   真下拉语义（键盘、`CBN_*`、`CB_GETCURSEL/CB_SETCURSEL/CB_GETLBTEXT`）原样保留，
//!   读/写值路径零改动；条目高度用 `CB_SETITEMHEIGHT(-1, h)` 程序化设定，
//!   绕开设置窗分派未转发的 `WM_MEASUREITEM`。**管理面行内下拉**（`RowAction::Pick`，
//!   音效事件行）复用同一条（[`build_panel_pick`]）：下拉箭头由系统绘制，不在文案里
//!   手拼「▾」（列表条目与字段区共用字符串表，拼字形会污染条目）。
//! - **可编辑 `EDIT` / 下拉清单**：`WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX` 由设置窗的
//!   comctl32 父类链补上（[`settings_subclass_proc`]）—— 这两条消息的消费者是控件
//!   父窗，而 `aux_wndproc` 只转发 STATIC/BTN 两路（`windows.rs` 不在本批所有权内）。
//! - **换主题广播**：`apply_theme` 覆盖新自绘面（按钮圆角/字色/重绘、弹窗、浮层）；
//!   组合框与输入框读 tokens 现值 + 失效重绘，不留旧主题色。
//! - **数值档位分段控件**（`NumberChoice`）：一个 ownerdraw 按钮画一排互斥圆角段
//!   （选中 `TabOn` / 未选中 `TabOff`，圆角 `radii.btn`），点击即选中并置脏；
//!   **档位只约束呈现、不约束取值** —— 存量 1.5 按最近档高亮但不写盘，直到用户点击
//!   （与共享层 `validate_value` 同口径）。详见「数值档位分段控件」小节。
//! - 层级感只靠 primary/normal 一档：不引入第三种视觉主色，「哪颗是提交」保持唯一答案。
//!
//! ## 字段提交时机（用户规则 2026-10-05：「灵动强度改了必须要回车，不行，
//! 弄成改了就能点保存」）
//!
//! 编辑框（数字 / 文本 / 多行）**编辑即置脏**：`EN_CHANGE` → 写草稿 → 底部「保存」
//! 随即可用。**校验与显示收口在失焦**（`EN_KILLFOCUS`）：解析不出（空串、「-」）时
//! 不写值、不清控件，失焦仍解析不出才把显示恢复成草稿现值；解析出的值越界按
//! `read_control` 的既有 clamp 收口（不是静默丢弃，也不给「abc → 0」的兜底）。
//! 聚焦中的编辑框不被刷新回声覆盖（用户输入在聚焦期间是权威）；解析出的值与草稿
//! 现值相同则不重复提交（程序化 `SetWindowTextW` 也可能补发 `EN_CHANGE`，否则自激）。
//! 三个判据都是纯函数：`parse_number_text` / `edit_commit_needed` / `commit_edit_value`。

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateCompatibleDC, CreateFontW, CreateRoundRectRgn, DeleteDC, DeleteObject,
    DrawFocusRect, DrawTextW, EndPaint, InvalidateRect, ScreenToClient, SelectObject, SetBkColor,
    SetBkMode, SetTextColor, SetWindowRgn, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CALCRECT,
    DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK,
    FW_BOLD, FW_NORMAL, HDC, HFONT, OUT_DEFAULT_PRECIS, PAINTSTRUCT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    EM_GETPASSWORDCHAR, EM_SETPASSWORDCHAR, EM_SETSEL, ODS_COMBOBOXEDIT, ODS_DISABLED, ODS_FOCUS,
    ODS_GRAYED, ODS_SELECTED, ODT_BUTTON, ODT_COMBOBOX,
};
// 父窗子类（comctl32；与 `paint_win` 给按钮装子类是同一机制）：
// 只为截住设置窗分派未转发的 WM_CTLCOLOREDIT / WM_CTLCOLORLISTBOX 两条配色消息。
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetAsyncKeyState, GetFocus, IsWindowEnabled, SetFocus, VK_CONTROL, VK_ESCAPE,
    VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetCursorPos, GetDlgItem, GetForegroundWindow, GetMessageW, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsDialogMessageW, IsWindow, KillTimer,
    MessageBoxW, MoveWindow, PeekMessageW, PostQuitMessage, RegisterClassW, SendMessageW,
    SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    TranslateMessage, BN_CLICKED, BS_DEFPUSHBUTTON, BS_OWNERDRAW, CBS_DROPDOWNLIST,
    CBS_OWNERDRAWFIXED, CB_ADDSTRING, CB_GETCURSEL, CB_GETDROPPEDSTATE, CB_SETCURSEL,
    CB_SETITEMHEIGHT, CBN_SELCHANGE, CBN_SELENDOK, CW_USEDEFAULT,
    ES_AUTOHSCROLL, ES_MULTILINE, ES_PASSWORD, ES_READONLY, ES_WANTRETURN, GWLP_USERDATA,
    GWL_STYLE, HTTRANSPARENT, HWND_TOP, IDCANCEL, IDOK, IDYES, MB_DEFBUTTON2, MB_ICONERROR,
    MB_ICONWARNING, MB_OK, MB_YESNO, MSG, PM_REMOVE, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN,
    SB_PAGEUP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, SW_SHOWNA, WM_CLOSE,
    WM_COMMAND, WM_CTLCOLORBTN, WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_CTLCOLORSTATIC, WM_DESTROY,
    WM_ERASEBKGND, WM_GETFONT,
    WM_NCHITTEST, WM_PAINT, WM_SETFONT, WNDCLASSW, WS_BORDER, WS_CAPTION, WS_CHILD,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_POPUP, WS_SYSMENU,
    WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

use crate::ui::settings::panels::{ListPanel, MemoryDetailState, PanelRow, RowAction, RowPick};
use crate::ui::settings::schema::{Field, FieldKind, TABS};
use crate::ui::settings::{
    settings_ui, tab_index_for_tag, DocumentState, DocumentTarget, NoticeLevel, SettingsValue,
    SettingsView, ShortcutModifiers, SwitchStates,
};
use crate::ui::theme;
use crate::ui::theme::paint_win::{self, ButtonRole, TextRole};
use crate::window::DPI_BASELINE;
use crate::{rust_debug, rust_info, rust_warn};

use super::windows_chat::DrawItemStruct;

/// 快捷键录制写回的修饰键 CONFIG 键（平台边界只此一处）。
const SHORTCUT_MODIFIERS_KEY: &str = "general.shortcut.winModifiers";
/// 录制的最长等待：无输入时不要无限占着主线程。
const SHORTCUT_CAPTURE_TIMEOUT_MS: u64 = 10_000;
/// 轮询间隔（按下边沿的检测粒度）。
const SHORTCUT_CAPTURE_POLL_MS: u64 = 15;

/// 编辑框通知码（`windows-sys` 0.52 的 Controls 面没有这两个常量，与聊天窗同款就地定义）。
/// `EN_CHANGE`：编辑即置脏（底部「保存」随即可用）；`EN_KILLFOCUS`：失焦 = 校验与显示收口。
const EN_CHANGE: u32 = 0x0300;
const EN_KILLFOCUS: u32 = 0x0200;

/// 控件 ID 基址（设置窗范围内唯一；与聊天窗 ID 段落不重叠）。
const FIELD_BASE: i32 = 1000;
const TAB_BASE: i32 = 400;
const SAVE_ID: i32 = 490;
const REFRESH_ID: i32 = 491;
const STATUS_ID: i32 = 492;
/// 管理面行动作按钮 ID 段（行开关/查看；`ROW_ID_BASE + row_slots 下标`）。
const ROW_ID_BASE: i32 = 3000;
/// 记忆详情按钮 ID 段（`DETAIL_ID_BASE + 动作下标`）。
const DETAIL_ID_BASE: i32 = 3500;
/// 管理面「刷新」按钮 ID 段（`PANEL_REFRESH_ID_BASE + 页面下标`）。
const PANEL_REFRESH_ID_BASE: i32 = 3600;
/// 密钥揭示按钮 ID 段（`SECRET_ID_BASE + 双控件组下标`）。
/// 必须落在行按钮段（`ROW_ID_BASE..ROW_ID_BASE + 4096` = 3000..7096）之外，
/// 且在 `on_command` 里先于 `id >= FIELD_BASE` 兜底分支命中。
const SECRET_ID_BASE: i32 = 13_000;

// ── 左竖栏（设计稿 `.srail`；与 macOS 侧同值）──

/// 竖栏宽（内容坐标以竖栏右缘为 0 点，`layout` 是唯一的 RAIL_W 转换点）。
const RAIL_W: i32 = 104;
/// 行按钮的左右内边距（设计稿 `padding: 9px 6px` 的横向值）。
const RAIL_PAD_X: i32 = 6;
/// 首行顶距（设计稿纵向 padding 9px）。
const RAIL_TOP: i32 = 9;
/// 行高与行距（设计稿行 padding 5px 9px + gap 1px 的可点区域近似）。
const RAIL_ITEM_H: i32 = 26;
const RAIL_ITEM_GAP: i32 = 1;

/// 内容区顶偏移（原顶部 Tab 带随竖栏改造删除；对齐设计稿 `.spane` 的 11px 上内边距）。
const CONTENT_TOP: i32 = 11;

/// Bool 开关尺寸（设计稿 `.sw`：32×17；圆角 = 半高）。
const SWITCH_W: i32 = 32;
const SWITCH_H: i32 = 17;

const BOTTOM_H: i32 = 46;
const ROW_H: i32 = 24;
const ROW_GAP: i32 = 6;
const HELP_H: i32 = 15;
const SECTION_GAP: i32 = 8;
/// 标签块与控件之间的横向间距（2026-10-05 行结构按设计稿 `.srow` 与 macOS 同式
/// 重排：控件右对齐、标签块吃剩余宽度；旧「右对齐标签列 158 + 控件中列」已退役）。
const ROW_LABEL_GAP: i32 = 12;
/// 行控件宽度分档（右缘统一对齐内容右缘；与 macOS `CTRL_W_*` 同值；Bool 取开关宽
/// `SWITCH_W`、Action 按文案 clamp(120, 200)，分档表见 [`field_control_size`]）。
const CTRL_W_POPUP: i32 = 200;
const CTRL_W_TEXT: i32 = 200;
const CTRL_W_NUMBER: i32 = 110;
const CTRL_W_INFO: i32 = 180;
const CTRL_W_MULTILINE: i32 = 220;
const CTRL_W_SHORTCUT: i32 = 180;
/// 多行输入框高度（沿用本侧旧值；macOS `MULTILINE_H` 为 84，高度差不影响行结构）。
const MULTILINE_H: i32 = 80;
/// 密钥揭示按钮宽（编辑框右移让位）。
const SECRET_BTN_W: i32 = 52;
/// 组合框条目文本的左右内边距（逻辑像素；自绘条目用）。
const COMBO_TEXT_PAD: i32 = 6;
/// 数值档位分段控件：段间间隙与段宽上下限（逻辑像素）。
const NUMBER_CHOICE_GAP: i32 = 2;
const NUMBER_CHOICE_SEG_MIN: i32 = 48;
const NUMBER_CHOICE_SEG_MAX: i32 = 96;
const NUMBER_CHOICE_SEG_PAD: i32 = 24;
const MARGIN: i32 = 14;
const SCROLL_STEP: i32 = 24;
/// 管理面行高：标题行 + 副标题行。
const PANEL_ROW_H: i32 = 38;
/// 管理面行内按钮宽。
const PANEL_BTN_W: i32 = 76;
/// 管理面行内下拉宽（`RowAction::Pick` 的主控件）：容下最长音效名（4 个全角字
/// ≈ 54px）+ 文本内边距 12 + 系统下拉箭头区（≈ 17）；行高不为下拉加高。
const PANEL_PICK_W: i32 = 100;
/// 记忆详情只读信息区高度。
const DETAIL_INFO_H: i32 = 78;
/// 记忆详情内容编辑框高度。
const DETAIL_EDIT_H: i32 = 72;
/// 记忆详情动作下标（ID = DETAIL_ID_BASE + 下标）。
const DETAIL_ACTION_SAVE: i32 = 0;
const DETAIL_ACTION_PIN: i32 = 1;
const DETAIL_ACTION_FORGET: i32 = 2;

/// 通知浮层窗口类名（设置窗的子窗口；与其它窗类互不干扰）。
const NOTICE_CLASS: &str = "DeskPetSettingsNotice";
/// 通知浮层自动消失时长（毫秒）——与 macOS `NSTimer` 的 3.2s 同值（「几秒」口径）。
const NOTICE_TOAST_MS: u32 = 3200;
/// 通知浮层的 `SetTimer` id（`TIMERPROC` 回调按它过滤；随窗口销毁自动失效）。
const NOTICE_TIMER_ID: usize = 0x4E54; // 'NT'
/// 通知浮层内边距与其文本最大显示宽度（逻辑像素；超宽折行）。
const NOTICE_PAD_X: i32 = 16;
const NOTICE_PAD_Y: i32 = 8;
const NOTICE_MAX_TEXT_W: i32 = 360;
/// 浮层顶偏移与最小宽度（与 macOS `show_toast` 同值：上距 8、最小宽 180）。
const NOTICE_TOP: i32 = 8;
const NOTICE_MIN_W: i32 = 180;

/// 需要原生确认的危险动作（键 → 标题 + 说明）；其余动作直接执行。
const DANGEROUS_ACTIONS: &[(&str, &str, &str)] = &[
    (
        "action.profileDelete",
        "删除当前 Profile",
        "会删除运行时 profiles 目录下的当前 Profile 及其素材；默认 Profile 与内置资源拒绝删除。",
    ),
    (
        "action.profileRestoreDefaults",
        "恢复默认资源",
        "会用随包默认覆盖同名 Card / Profile / Skill 的修改；自建资源保留。",
    ),
    (
        "action.cardDelete",
        "删除当前 Card",
        "会删除卡片文件与它的阶段文案、变量状态；激活中的卡需要先切到别的卡。",
    ),
    (
        "action.cardImport",
        "导入 Card",
        "id 取自卡片 frontmatter；已存在同名卡会被覆盖，原卡内容不保留。",
    ),
    (
        "action.memoryRestoreApply",
        "用最近备份覆盖记忆库",
        "当前记忆库会被替换为最近一次托管备份的内容；请先用「恢复预览」确认备份版本。",
    ),
];

/// 管理面刷新按钮的页面下标（ID = PANEL_REFRESH_ID_BASE + 下标）。
const REFRESH_TOOLS: i32 = 0;
const REFRESH_MEMORY: i32 = 1;
const REFRESH_SOUNDS: i32 = 2;

/// `SetBkMode` 的 TRANSPARENT：windows-sys 里 `Gdi::TRANSPARENT` 是 u32，该 API 要 i32
/// （与 `windows_chat.rs` 同款就地定义）。
const TRANSPARENT: i32 = 1;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn dpi_scale(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE);
    f64::from(dpi) / f64::from(DPI_BASELINE)
}

fn scaled(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale).round() as i32
}

// ==========================================
// 主题判定（纯逻辑：无 Win32 调用，可单测；表见文件末的测试小节）
// ==========================================

/// 设置窗里显式创建的按钮（按动作语义分类，不按 ID —— ID 段是实现细节）。
///
/// 「全面自绘」（用户规则 2026-10-05）后本表覆盖全部显式按钮：提交类贴 `primary_*`
/// 主按钮面、其余一律 `btn_bg` 普通面。schema 驱动的字段按钮（Action / 快捷键录制 /
/// 密钥揭示）不走本表，各自在创建点按 `ButtonRole::Normal` 上主题。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsButton {
    /// 整窗「保存」（底部固定条）。
    Save,
    /// 行编辑文档「保存文档」。
    SaveDocument,
    /// 记忆详情「保存纠正」。
    SaveCorrection,
    /// 底部「刷新」。
    Refresh,
    /// 管理面「刷新」（工具/记忆/音效页各一个）。
    PanelRefresh,
    /// 行编辑文档「关闭」。
    DocumentClose,
    /// 行编辑文档「重新生成」（阶段文案）。
    DocumentRegenerate,
    /// 行编辑文档「测试连接」（MCP 服务器）。
    DocumentTest,
    /// 行编辑文档「复制」（只读 Card 模版；不关弹窗）。
    DocumentCopy,
    /// 记忆详情「加入核心画像 / 移出核心画像」。
    MemoryPin,
    /// 记忆详情「忘记这条」。
    MemoryForget,
    /// 管理面行主按钮（已启用 / 已关闭 / 查看 / 试听）。
    RowPrimary,
    /// 管理面行次按钮（编辑 / 删除）。
    RowSecondary,
}

/// 按钮语义 → ownerdraw 角色（分档口径的单一实现点）。
///
/// 提交类动作（四个「保存」入口）走 `primary_*` 主按钮面；**其余全部** `btn_bg`
/// 普通面：系统面在深色主题下不跟主题（用户报「按钮的颜色错乱」的根因，已拍板
/// 全面自绘）。层级感只靠这一档区分 —— 不引入第三种视觉主色，
/// 「哪颗是提交」才有唯一答案。
fn button_role(button: SettingsButton) -> ButtonRole {
    match button {
        SettingsButton::Save | SettingsButton::SaveDocument | SettingsButton::SaveCorrection => {
            ButtonRole::Primary
        }
        SettingsButton::Refresh
        | SettingsButton::PanelRefresh
        | SettingsButton::DocumentClose
        | SettingsButton::DocumentRegenerate
        | SettingsButton::DocumentTest
        | SettingsButton::DocumentCopy
        | SettingsButton::MemoryPin
        | SettingsButton::MemoryForget
        | SettingsButton::RowPrimary
        | SettingsButton::RowSecondary => ButtonRole::Normal,
    }
}

/// 给控件记录语义字色（`WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN` 按控件读回；未记录 → `ink`）。
fn stamp_text(hwnd: HWND, role: TextRole) {
    if hwnd != 0 {
        paint_win::set_text_color(hwnd, paint_win::text_color(theme::tokens(), role));
    }
}

/// 主操作按钮转 ownerdraw（主题面 + 悬浮/圆角子类；角色写进控件，`WM_DRAWITEM` 读回）。
///
/// `radius` 显式给：竖栏行按钮取 `radii.sm`（设计稿 `--r1`），其余按钮取 `radii.btn`。
unsafe fn make_themed_button(hwnd: HWND, role: ButtonRole, scale: f64, radius: f32) {
    if hwnd == 0 {
        return;
    }
    // 样式位在 `GWL_STYLE` 上追加 `BS_OWNERDRAW`（BS_* 占低 4 位，与 WS_* 不重叠）。
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, style | (BS_OWNERDRAW as isize)) };
    paint_win::set_role(hwnd, role);
    paint_win::install_button(hwnd, scaled(radius.round() as i32, scale));
}

/// 按语义表给按钮上主题：全部转 ownerdraw（主/普通面由 [`button_role`] 决定）。
fn style_button(button: SettingsButton, hwnd: HWND, scale: f64) {
    unsafe { make_themed_button(hwnd, button_role(button), scale, theme::tokens().radii.btn) };
}

/// 控件是否由 `paint_win` 自绘的 ownerdraw 按钮（看 `GWL_STYLE` 的 `BS_OWNERDRAW` 位）。
///
/// 供主题广播重贴圆角用：全面自绘后按钮不在槽表里靠角色区分，一律按样式位识别
/// （开关是半高胶囊、竖栏行按钮取 `radii.sm`，调用点各自排除）。
fn is_themed_button(hwnd: HWND) -> bool {
    hwnd != 0 && (unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & (BS_OWNERDRAW as isize)) != 0
}

/// 一个控件的槽位（ID = FIELD_BASE + 下标）。
struct WinSlot {
    hwnd: HWND,
    key: Option<&'static str>,
    kind: Option<FieldKind>,
    /// 内容坐标（逻辑像素；滚动时按 `scroll` 位移）。
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    /// 基础字号（全局字体变化时重建字体）。
    font_base: i32,
    /// 语义字色（`None` = 不记录，按 `ink` 回落；ownerdraw 按钮必须为 `None`：
    /// 该控件的 `GWLP_USERDATA` 被按钮角色占用，写字色会覆盖角色）。
    role: Option<TextRole>,
}

/// 非字段控件（不随滚动位移）。
struct FixedControls {
    tab_buttons: Vec<HWND>,
    status: HWND,
    refresh: HWND,
    save: HWND,
}

/// 管理面行动作槽（控件 ID = ROW_ID_BASE + 下标）。
struct WinRowSlot {
    panel: &'static str,
    row_id: String,
    action: RowAction,
    /// 槽位控件（下拉行读 `CB_GETCURSEL` 用；按钮行同样记下，保持槽位自包含）。
    control: HWND,
    /// 行内下拉的选项值表（下标 → `value`；`Pick` 行以外为空）。
    /// 控件字符串表只放 label；选中值由这张表按 `CB_GETCURSEL` 下标还原，
    /// **不**从显示文案反推（label 可重复/可变，value 才是写回值）。
    pick_values: Vec<String>,
}

/// 密钥字段的揭示（`ID = SECRET_ID_BASE + 下标`）：编辑框 + 按钮 + 当前是否明文。
struct WinSecretPair {
    edit: HWND,
    button: HWND,
    revealed: bool,
    /// 遮蔽用的字符（建控件时读回默认值 `EM_GETPASSWORDCHAR`，复遮蔽时写回同一字符）。
    password_char: usize,
}

struct SettingsState {
    hwnd: HWND,
    tab: usize,
    slots: Vec<WinSlot>,
    fixed: FixedControls,
    fonts: Vec<HFONT>,
    scroll: i32,
    content_height: i32,
    /// 密钥揭示按钮的控件组（随 Tab 重建整体清空）。
    secret_pairs: Vec<WinSecretPair>,
    /// 动态帮助行（字段键 → STATIC 控件；如 Bash 白名单的「N 个命令」）。
    dynamic_hints: Vec<(HWND, &'static str)>,
    /// 管理面（工具页 / 记忆页）区域的控件；随数据代数整体重建。
    panel_slots: Vec<WinSlot>,
    /// 已渲染的管理面数据代数（与 `SettingsUi::panel_generation` 对比）。
    panel_generation: u64,
    /// 管理面起始 / 终止 y（逻辑坐标）。
    panel_base_y: i32,
    panel_end_y: i32,
    /// 行动作槽（按钮 ID = ROW_ID_BASE + 下标）。
    row_slots: Vec<WinRowSlot>,
    /// 记忆详情的内容编辑框（0 = 无；保存纠正时读值，重建前暂存草稿）。
    detail_content: HWND,
    /// 通知浮层（①）：Info/Warning 的子窗口；0 = 尚未创建。
    notice_overlay: HWND,
    /// 浮层当前文本的量得尺寸（物理像素；窗口缩放时按它重新居中）。
    notice_measured: (i32, i32),
    /// 浮层创建失败（降级：通知回落到状态行；留痕在 [`create_notice_overlay`]）。
    notice_overlay_failed: bool,
    /// 已呈现过的通知代际（0 = 从未；Error 模态与 Info/Warning 浮层共用一条记录）。
    /// 判新只认代际，见 [`notice_action`]。
    presented_generation: u64,
    /// 某个模态（错误弹窗 / 文档弹窗）正在显：期间到达的错误通知不嵌套抢弹
    /// （与 macOS `notice_modal_up` 同规；收尾后由下一次刷新补呈现）。
    notice_modal_up: bool,
    /// 文档编辑弹窗正在显（模态期间到达的刷新不得重入呈现；与 macOS `doc_dialog_up` 同规）。
    doc_dialog_up: bool,
    /// 文档编辑弹窗句柄（0 = 无；换主题广播时重刷它的字色，见 `apply_theme`）。
    doc_dialog: HWND,
    /// 弹窗编辑框当前承载的文档内容（目标 + 文本）：模态期间文档被刷新（重新生成完成 /
    /// 保存回执）时据此把新内容写回编辑框；弹窗关闭即清。
    doc_dialog_content: Option<(DocumentTarget, String)>,
    /// 本次打开（`loaded` 的 false 相位起算）的文档已呈现过弹窗：
    /// 保存成功只重写文本、不重走读取中，同一份文档不会因保存回执再弹一次。
    doc_presented_this_open: bool,
    /// 上次「保存」提交时留下的草稿（保存失败重开同一文档时优先恢复用户编辑；
    /// 与 macOS `doc_draft` 同语义）。文档关闭即清。
    doc_draft: Option<(DocumentTarget, String)>,
    /// 快捷键录制模式进行中（状态行固定显示录制提示；见 [`capture_shortcut`]）。
    capturing_shortcut: bool,
}

thread_local! {
    static STATE: RefCell<Option<SettingsState>> = const { RefCell::new(None) };
    /// 开关控件的开/关状态镜像（绘制 / 读值 / 回写三处共用；类型与测试见
    /// `ui/settings::SwitchStates`）。独立于 `STATE`：`WM_DRAWITEM` 在绘制期同步到达，
    /// 走 `with_state` 会与正在持借用者的调用路径重入（AGENTS §5.1 的 RefCell 纪律）。
    static SWITCH_STATES: RefCell<SwitchStates> = RefCell::new(SwitchStates::default());
}

fn with_state<R>(f: impl FnOnce(&mut SettingsState) -> R) -> Option<R> {
    STATE.with(|cell| cell.borrow_mut().as_mut().map(|state| f(state)))
}

/// 创建字体：族名来自全局快照，缺省回落到 W8a 既有的中文 UI 字体。
fn make_font(scale: f64, base: i32, bold: bool) -> HFONT {
    let snapshot = crate::ui::font::snapshot();
    let logical = snapshot.scaled_size(f64::from(base), 13.5).round() as i32;
    let face = snapshot
        .family
        .clone()
        .unwrap_or_else(|| "Microsoft YaHei UI".to_string());
    unsafe {
        CreateFontW(
            -scaled(logical, scale),
            0,
            0,
            0,
            if bold {
                FW_BOLD as i32
            } else {
                FW_NORMAL as i32
            },
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            0,
            0,
            wide(&face).as_ptr(),
        )
    }
}

/// 设置窗建立后挂载内容（W5 的 open_aux 调用）。
pub(crate) fn install_settings_content(hwnd: HWND) {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = dpi_scale(hwnd);
    let mut fonts = Vec::new();
    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let bold = make_font(scale, 13, true);
    fonts.push(body);
    fonts.push(small);
    fonts.push(bold);

    let mut tab_buttons = Vec::new();
    // 左竖栏行按钮（位置由 layout 统一排；选中/未选中面在 refresh_values 按角色贴）。
    // WS_CLIPSIBLINGS（本文件全部子控件都带）：通知浮层要浮在兄弟控件之上，
    // 兄弟控件不画进浮层区域靠的就是这个样式（它是「被上层兄弟裁剪」的开关）。
    for (index, tab) in TABS.iter().enumerate() {
        let button = unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(tab.label).as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
                0,
                0,
                scaled(RAIL_W - RAIL_PAD_X * 2, scale),
                scaled(RAIL_ITEM_H, scale),
                hwnd,
                (TAB_BASE + index as i32) as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe { SendMessageW(button, WM_SETFONT, small as WPARAM, 1) };
        // ownerdraw：面由 `WM_DRAWITEM` 按 TabOn/TabOff 角色画；圆角取 `radii.sm`（--r1）。
        unsafe { make_themed_button(button, ButtonRole::TabOff, scale, theme::tokens().radii.sm) };
        tab_buttons.push(button);
    }
    // 状态行 + 刷新/保存。
    let status = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            scaled(MARGIN, scale),
            scaled(1, scale),
            scaled(240, scale),
            scaled(18, scale),
            hwnd,
            STATUS_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { SendMessageW(status, WM_SETFONT, small as WPARAM, 1) };
    // 状态行是信息通道（进展与错误共用一条），取说明色；专门的错误/警告行另算。
    stamp_text(status, TextRole::Hint);
    let refresh = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("刷新").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
            0,
            0,
            scaled(80, scale),
            scaled(26, scale),
            hwnd,
            REFRESH_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    let save = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("保存").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
            0,
            0,
            scaled(80, scale),
            scaled(26, scale),
            hwnd,
            SAVE_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SendMessageW(refresh, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(save, WM_SETFONT, body as WPARAM, 1);
    }
    style_button(SettingsButton::Refresh, refresh, scale);
    style_button(SettingsButton::Save, save, scale);

    STATE.with(|cell| {
        *cell.borrow_mut() = Some(SettingsState {
            hwnd,
            tab: 0,
            slots: Vec::new(),
            fixed: FixedControls {
                tab_buttons,
                status,
                refresh,
                save,
            },
            fonts,
            scroll: 0,
            content_height: 0,
            secret_pairs: Vec::new(),
            dynamic_hints: Vec::new(),
            panel_slots: Vec::new(),
            panel_generation: 0,
            panel_base_y: 0,
            panel_end_y: 0,
            row_slots: Vec::new(),
            detail_content: 0,
            notice_overlay: 0,
            notice_measured: (0, 0),
            notice_overlay_failed: false,
            presented_generation: 0,
            notice_modal_up: false,
            doc_dialog_up: false,
            doc_dialog: 0,
            doc_dialog_content: None,
            doc_presented_this_open: false,
            doc_draft: None,
            capturing_shortcut: false,
        });
    });
    // 父窗子类：补上设置窗分派未转发的 WM_CTLCOLOREDIT / WM_CTLCOLORLISTBOX
    // （可编辑输入框与下拉清单的主题配色；见 `settings_subclass_proc`）。
    unsafe {
        SetWindowSubclass(hwnd, Some(settings_subclass_proc), SETTINGS_SUBCLASS_ID, 0);
    }
    rebuild_tab();
    layout(hwnd);
    refresh_ui();
    settings_ui().ensure_font_families();
    settings_ui().ensure_cards();
    rust_info!("设置窗内容已建立（Windows：{} 个 Tab）", TABS.len());
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect: windows_sys::Win32::Foundation::RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left, rect.bottom - rect.top)
}

// ==========================================
// 主题绘制（窗底 / 分隔线 / 字色 / ownerdraw 按钮 / 主题广播）
// ==========================================

/// 窗底 + 左竖栏 + 底部 `bar_edge` 分隔线（WM_ERASEBKGND 与 WM_PAINT 共用；物理像素）。
///
/// 底取 `tokens().field_bg`（选型理由见模块头「主题接线」）；左竖栏止于底部固定条
/// 上缘（`rail_bg` + 右缘 1px `rail_edge`）；分隔线只剩底部固定条的上边线（原顶部
/// Tab 带随竖栏改造删除）。类画刷在 `windows.rs` 的附属窗类注册里已留空，
/// 这里的自绘是唯一的底来源（换主题不必重注册窗口类）。
pub(crate) fn paint_background(hwnd: HWND, hdc: HDC) {
    let (width, height) = client_size(hwnd);
    if width <= 0 || height <= 0 {
        return;
    }
    let tokens = theme::tokens();
    let scale = dpi_scale(hwnd);
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, width, height),
        &tokens.field_bg,
    );
    // 竖栏底：右缘分界线是 1px 独立矩形（主题 `Fill` 的 EdgeSide 只有上下边）。
    let rail_h = (height - scaled(BOTTOM_H, scale)).max(0);
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, scaled(RAIL_W, scale), rail_h),
        &tokens.rail_bg,
    );
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(scaled(RAIL_W - 1, scale), 0, 1, rail_h),
        tokens.rail_edge,
    );
    // 操作条上缘 1px `bar_edge` 分隔线（设计稿 `.sfoot` 的 border-top；与 macOS
    // `SettingsLayout.separator` 同款）：滚动内容与操作条之间有明确分界，不再出现
    // 「内容半行贴在操作条上」的观感。
    let bottom_rule_y = (height - scaled(BOTTOM_H, scale)).max(0);
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(0, bottom_rule_y, width, 1),
        tokens.bar_edge,
    );
}

/// `WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN`：字色按控件记录的角色取（未记录 → `ink`；
/// 禁用控件统一降为 `dim`），文字底透明、控件底回 `field_bg`（窗底色）。
///
/// 注意：可编辑 `EDIT` 走 [`edit_ctlcolor`]（由设置窗父类过程转发，见
/// [`settings_subclass_proc`]）；只读/禁用 `EDIT` 也发 `WM_CTLCOLORSTATIC`，
/// 会一并拿到主题字色。
pub(crate) fn on_ctlcolor(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    let enabled = unsafe { IsWindowEnabled(control) } != 0;
    let color = paint_win::text_color_of(control)
        .map(|color| if enabled { color } else { tokens.dim })
        .unwrap_or(if enabled { tokens.ink } else { tokens.dim });
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(color));
    }
    paint_win::solid_brush(tokens.field_bg.base_color()) as LRESULT
}

/// `WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX`（②「全面自绘」）：可编辑输入框与下拉清单
/// 的底色取 `field_bg`、字色取 `ink`（禁用降 `dim`）；EDIT 的插入符随字色。
///
/// 与 STATIC/BTN 的透明底不同：编辑类必须给**实色**底刷 + `SetBkColor`
/// （透明底在滚动/部分重绘时会拖出残影）。返回值是背景刷。
pub(crate) fn edit_ctlcolor(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    let enabled = unsafe { IsWindowEnabled(control) } != 0;
    let ink = if enabled { tokens.ink } else { tokens.dim };
    let base = tokens.field_bg.base_color();
    unsafe {
        SetTextColor(hdc, paint_win::colorref(ink));
        SetBkColor(hdc, paint_win::colorref(base));
    }
    paint_win::solid_brush(base) as LRESULT
}

/// 设置窗父类过程的子类 id（comctl32 子类链；与 `paint_win` 给按钮装的子类互不冲突）。
const SETTINGS_SUBCLASS_ID: usize = 0x53_47; // 'SG'

/// 设置窗父类过程（`install_settings_content` 时挂上）：只截两条绘制配色消息，
/// 其余消息原样交回 `DefSubclassProc`（链到 `windows.rs` 的 `aux_wndproc`）。
///
/// `WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX` 的消费者是**控件的父窗口**，而设置窗
/// 分派只转发 STATIC/BTN 两路（`windows.rs` 不在本批所有权内）—— 用控件库子类链
/// 补上这一环，机制与 `paint_win` 给按钮装子类完全相同。
unsafe extern "system" fn settings_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => edit_ctlcolor(wparam, lparam),
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// `WM_DRAWITEM`：ownerdraw 按钮 / 开关 / 组合框条目绘制。
/// 返回是否已处理（`false` = 不是本模块登记的自绘控件，交回 DefWindowProc）。
pub(crate) fn on_drawitem(lparam: LPARAM) -> bool {
    if lparam == 0 {
        return false;
    }
    let item = unsafe { &*(lparam as *const DrawItemStruct) };
    if item.CtlType == ODT_COMBOBOX {
        draw_combo_item(item);
        return true;
    }
    if item.CtlType != ODT_BUTTON {
        return false;
    }
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    // 开关没有按钮角色：在 `role_of` 判定之前按状态镜像分流（否则会被画成普通按钮面）。
    let switch = SWITCH_STATES.with(|states| {
        let states = states.borrow();
        states
            .contains(item.hwndItem as isize)
            .then(|| states.get(item.hwndItem as isize))
    });
    if let Some(on) = switch {
        unsafe { paint_win::draw_switch(item.hDC, rect, on, disabled) };
        draw_focus_ring(item, rect);
        return true;
    }
    // 数值档位段：没有按钮角色，按镜像表分流（同开关的处理位置）。
    let number_choice =
        NUMBER_CHOICES.with(|states| states.borrow().contains_key(&(item.hwndItem as isize)));
    if number_choice {
        draw_number_choice(item);
        draw_focus_ring(item, rect);
        return true;
    }
    let tokens = theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & ODS_SELECTED != 0;
    let face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = window_text(item.hwndItem);
    unsafe {
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            &label,
            pressed,
            disabled,
        )
    };
    draw_focus_ring(item, rect);
    true
}

/// 键盘焦点环（ownerdraw 没有系统焦点矩形，`ODS_FOCUS` 时自己补一条）：
/// `DrawFocusRect` 是 XOR 绘制，叠在主题面上任何底色都可见。
fn draw_focus_ring(item: &DrawItemStruct, rect: paint_win::Rect) {
    if item.itemState & ODS_FOCUS == 0 {
        return;
    }
    let ring = rect.deflate(3);
    if ring.is_empty() {
        return;
    }
    let win = RECT {
        left: ring.x,
        top: ring.y,
        right: ring.right(),
        bottom: ring.bottom(),
    };
    unsafe { DrawFocusRect(item.hDC, &win) };
}

/// ownerdraw 组合框条目（②）：字段区取 `field_*` 面色、下拉条目取 `field_bg` 底 +
/// 悬浮同款选中覆盖；文字 `ink`、禁用降 `dim`。条目文本仍由控件的字符串表提供
/// （`CB_GETLBTEXT` 照旧可用，读写路径零改动）。
fn draw_combo_item(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    if rect.is_empty() {
        return;
    }
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    // 字段区（收起态）判据：`itemID == -1`（下拉列表控件的静态字段区）或
    // `ODS_COMBOBOXEDIT`（edit 部分的标记，防御性一并认）。
    let field_area = item.itemID == u32::MAX || item.itemState & ODS_COMBOBOXEDIT != 0;
    let style = combo_item_style(
        tokens,
        item.itemState & ODS_SELECTED != 0,
        disabled,
        field_area,
    );
    unsafe {
        if let Some(bg) = &style.bg {
            paint_win::fill_rect(item.hDC, rect, bg);
        }
        if let Some(edge) = style.edge {
            paint_win::draw_frame(
                item.hDC,
                rect,
                edge,
                &style.bevel.unwrap_or(theme::Bevel::NONE),
            );
        }
        if let Some(overlay) = style.overlay {
            paint_win::fill_color(item.hDC, rect, overlay);
        }
        let font = SendMessageW(item.hwndItem, WM_GETFONT, 0, 0) as HFONT;
        let old = if font != 0 {
            SelectObject(item.hDC, font)
        } else {
            0
        };
        // 文本来源：条目行取该项字符串；`itemID == -1`（字段区 / 收起态）取控件文本
        // （`WM_GETTEXT` 对下拉选中的条目返回其文本，两平台读值口径同源）。
        let text = if item.itemID == u32::MAX {
            window_text(item.hwndItem)
        } else {
            combo_item_text(item.hwndItem, item.itemID as i32)
        };
        let pad = scaled(COMBO_TEXT_PAD, dpi_scale(item.hwndItem));
        let mut text_rect = item.rcItem;
        text_rect.left += pad;
        text_rect.right -= pad;
        SetBkMode(item.hDC, TRANSPARENT);
        SetTextColor(item.hDC, paint_win::colorref(style.ink));
        DrawTextW(
            item.hDC,
            wide(&text).as_ptr(),
            -1,
            &mut text_rect,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
        if old != 0 {
            SelectObject(item.hDC, old);
        }
    }
}

/// 组合框字段区 / 条目行各用哪一族按钮面（纯函数，可测）：字段区 = 输入面族
/// （`Pending`）、条目行 = 普通面（`Normal`，底另取 `field_bg` 平铺）。
fn combo_item_role(field_area: bool) -> ButtonRole {
    if field_area {
        ButtonRole::Pending
    } else {
        ButtonRole::Normal
    }
}

/// 组合框条目配色（纯函数，可测）：字段区（收起态）取输入面族、清单条目取
/// `field_bg` 底 + 选中行叠按钮悬浮同款覆盖；字色 `ink`、禁用降 `dim`。
fn combo_item_style(
    tokens: &'static theme::Tokens,
    selected: bool,
    disabled: bool,
    field_area: bool,
) -> ComboItemStyle {
    let face = paint_win::button_face(tokens, combo_item_role(field_area), false, false);
    ComboItemStyle {
        bg: if field_area {
            face.bg
        } else {
            Some(tokens.field_bg)
        },
        edge: if field_area { face.edge } else { None },
        bevel: if field_area { face.bevel } else { None },
        // 选中行不换底色、只叠一层悬浮同款覆盖（与按钮的悬浮口径同源）。
        overlay: if !field_area && selected {
            let hovered = paint_win::button_face(tokens, ButtonRole::Normal, true, false);
            hovered.overlay
        } else {
            None
        },
        ink: if disabled { tokens.dim } else { tokens.ink },
    }
}

/// 组合框条目配色结果（见 [`combo_item_style`]）。
struct ComboItemStyle {
    bg: Option<theme::Fill>,
    edge: Option<theme::Rgba>,
    bevel: Option<theme::Bevel>,
    overlay: Option<theme::Rgba>,
    ink: theme::Rgba,
}

/// 主题广播（`windows.rs::apply_theme` 调用）。
///
/// 顺序不变量：调用方已先 `paint_win::release_theme_resources()`（旧主题的画刷/纹理
/// 都在那里 `DeleteObject`），本函数只做「按新 token 重刷字色 + 强制重绘」；
/// 本文件自己不持有任何 GDI 对象，所以没有需要在这里释放的句柄。
pub(crate) fn apply_theme() {
    let applied = with_state(|state| {
        let tokens = theme::tokens();
        let scale = dpi_scale(state.hwnd);
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            if let Some(role) = slot.role {
                paint_win::set_text_color(slot.hwnd, paint_win::text_color(tokens, role));
            }
            // 全面自绘后每个按钮都是 ownerdraw：圆角随 `radii.btn` 重贴区域
            // （开关是半高胶囊、竖栏行按钮取 `radii.sm`，两者都不走这里）。
            let is_switch =
                SWITCH_STATES.with(|states| states.borrow().contains(slot.hwnd as isize));
            if !is_switch && is_themed_button(slot.hwnd) {
                paint_win::install_button(
                    slot.hwnd,
                    scaled(tokens.radii.btn.round() as i32, scale),
                );
            }
            unsafe { InvalidateRect(slot.hwnd, std::ptr::null(), 1) };
        }
        stamp_text(state.fixed.status, TextRole::Hint);
        // 固定条的按钮不在槽表里（创建于 install），半径刷新与失效在这里补。
        for control in [state.fixed.refresh, state.fixed.save] {
            if is_themed_button(control) {
                paint_win::install_button(control, scaled(tokens.radii.btn.round() as i32, scale));
            }
        }
        // 竖栏行按钮的圆角半径随 `radii.sm` 变化：重贴区域后再失效重绘。
        for control in state.fixed.tab_buttons.iter() {
            paint_win::install_button(*control, scaled(tokens.radii.sm.round() as i32, scale));
            unsafe { InvalidateRect(*control, std::ptr::null(), 1) };
        }
        // 文档弹窗（②）与通知浮层（①）不在槽表里：各自重刷字色/圆角/重绘
        //（弹窗只在它开着时才需要 —— 模态期间换主题是低频但真实存在的路径）。
        if state.doc_dialog != 0 {
            apply_theme_doc_dialog(state.doc_dialog, scale);
        }
        if state.notice_overlay != 0 {
            // 浮层绘制读 tokens 现值：重绘 + 按新 `radii.btn` 重贴圆角区域即完成换肤。
            refresh_notice_region(state.notice_overlay, scale);
            unsafe { InvalidateRect(state.notice_overlay, std::ptr::null(), 1) };
        }
        unsafe {
            InvalidateRect(state.fixed.status, std::ptr::null(), 1);
            InvalidateRect(state.fixed.refresh, std::ptr::null(), 1);
            InvalidateRect(state.fixed.save, std::ptr::null(), 1);
            InvalidateRect(state.hwnd, std::ptr::null(), 1);
        }
    });
    match applied {
        Some(()) => rust_info!("设置窗已按新主题重刷字色并重绘（Windows）"),
        None => rust_debug!("设置窗未打开，主题广播跳过"),
    }
}

// ==========================================
// 字段行几何（纯函数，可测；与 macOS `field_control_size` / `field_label_width` 同式）
// ==========================================

/// 字段行的控件尺寸（宽, 高）——宽度分档的单一实现点（`rebuild_tab` 与标签
/// 截断护栏测试同源）：控件右缘统一对齐内容右缘，Action 按钮按文案贴宽（120..200）。
fn field_control_size(field: &Field) -> (i32, i32) {
    match field.kind {
        FieldKind::Bool => (SWITCH_W, SWITCH_H),
        // 数值档位：一整排分段（计划宽度 = 各段估宽 + 间隙；绘制端按实际客户区均分）。
        FieldKind::NumberChoice { options } => (number_choice_planned_width(options), ROW_H),
        FieldKind::Number { .. } => (CTRL_W_NUMBER, ROW_H),
        FieldKind::Text { secret: false } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Text { secret: true } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Enum(_)
        | FieldKind::FontFamily
        | FieldKind::CardChoice
        | FieldKind::ProfileChoice => (CTRL_W_POPUP, ROW_H),
        FieldKind::Multiline => (CTRL_W_MULTILINE, MULTILINE_H),
        FieldKind::Info => (CTRL_W_INFO, ROW_H),
        FieldKind::Shortcut => (CTRL_W_SHORTCUT, ROW_H),
        FieldKind::Action => (
            // 按钮宽 ≈ 文案估宽 + 内边距（正文基线 13.5 = `make_font(.., 13, ..)` 的
            // 参考字号，与 macOS `BODY_BASE_SIZE` 同值）；clamp 档与 macOS 一致。
            (crate::ui::chat::panels::estimated_text_width(field.label, 13.5) + 28.0)
                .clamp(120.0, 200.0)
                .round() as i32,
            ROW_H,
        ),
        // 修饰键键位由录制控件按平台写 schema 键，不渲染独立控件。
        FieldKind::ShortcutModifiers => (0, 0),
    }
}

/// 标签块宽度（纯函数）：控件右对齐后标签块吃剩余宽度；与 `rebuild_tab` 同源，
/// 供截断护栏按默认窗宽断言。`content_width` 含两侧 `MARGIN`（与 macOS 的
/// `field_label_width` 入参同口径：完整内容区宽，函数内部再扣边距与间距）。
fn field_label_width(content_width: i32, ctrl_w: i32) -> i32 {
    let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
    (ctrl_x - ROW_LABEL_GAP - MARGIN).max(80)
}

// ==========================================
// 数值档位分段控件（NumberChoice；② 自绘族的新面）
// ==========================================
//
// 共享层口径照抄：**CONFIG 里仍是数字**，档位只约束**呈现**、不约束取值 ——
// 存量里可能的 1.5 / 0.8 按**最近档**高亮但**不写盘**，直到用户真点了某一段
// （共享层 `validate_value` 同样不按档位校验：拒绝存量中间值会把「打开设置再保存」
// 变成一次静默改写）。
//
// 控件是**一个** ownerdraw 按钮（一排互斥圆角段）：选中段取选中标签材质（`TabOn`）、
// 未选中段 `TabOff`、悬浮段叠按钮悬浮同款覆盖；点击落在哪一段用点击时的光标位置命中
// （`BN_CLICKED` 不带坐标），命中不了就什么都不做。呈现状态（档位表 + 高亮档）放独立
// 镜像表，理由同 `SWITCH_STATES`：`WM_DRAWITEM` 在绘制期同步到达，走 `with_state`
// 会与正在持借用者的调用路径重入（AGENTS §5.1 的 RefCell 纪律）。

/// 一个数值档位控件的呈现状态（键 = 控件句柄整数）。
#[derive(Clone, Copy)]
struct NumberChoiceState {
    options: &'static [(&'static str, f64)],
    /// 高亮档下标（按草稿现值取最近档；`None` = 无值 / 空档位表）。
    selected: Option<usize>,
}

thread_local! {
    static NUMBER_CHOICES: RefCell<HashMap<isize, NumberChoiceState>> =
        RefCell::new(HashMap::new());
}

/// 登记档位控件状态（建控件时；句柄会被系统复用，销毁时注销）。
fn register_number_choice(
    control: HWND,
    options: &'static [(&'static str, f64)],
    selected: Option<usize>,
) {
    NUMBER_CHOICES.with(|states| {
        states
            .borrow_mut()
            .insert(control as isize, NumberChoiceState { options, selected });
    });
}

/// 注销档位控件状态（销毁控件时，与开关镜像同一纪律）。
fn unregister_number_choice(control: isize) {
    NUMBER_CHOICES.with(|states| states.borrow_mut().remove(&control));
}

/// 更新高亮档（刷新路径；不碰草稿值 —— 呈现与取值分离）。
fn set_number_choice_selected(control: HWND, selected: Option<usize>) {
    NUMBER_CHOICES.with(|states| {
        if let Some(state) = states.borrow_mut().get_mut(&(control as isize)) {
            state.selected = selected;
        }
    });
}

/// 档位字段的呈现（纯函数，可测）：草稿现值 → 高亮档下标，**不产生要写回的值**。
///
/// 「最近档」按绝对距离取最近、平手取**靠前**档（1.5 → 「弱」）；值缺失 → 无高亮。
/// 档位之外的存量值也按最近档高亮，**不改值**（用户没动它就不该被改写）。
fn number_choice_selected(options: &[(&str, f64)], value: Option<f64>) -> Option<usize> {
    let value = value?;
    let mut best: Option<(usize, f64)> = None;
    for (index, (_, option_value)) in options.iter().enumerate() {
        let distance = (value - option_value).abs();
        match best {
            Some((_, best_distance)) if best_distance <= distance => {}
            _ => best = Some((index, distance)),
        }
    }
    best.map(|(index, _)| index)
}

/// 段宽按客户区均分（纯函数，可测）：除不尽的余数落在最后一段；`count = 0` → 空。
fn number_choice_equal_widths(client_w: i32, count: usize) -> Vec<i32> {
    if count == 0 {
        return Vec::new();
    }
    let total = client_w.max(0);
    let each = total / count as i32;
    let mut widths = vec![each; count];
    if let Some(last) = widths.last_mut() {
        *last = total - each * (count as i32 - 1);
    }
    widths
}

/// 点击命中哪一段（纯函数，可测）：段宽数组 + 控件内 x（同单位）→ 段下标。
/// 段之间留 `NUMBER_CHOICE_GAP` 间隙，落在间隙或界外 → `None`（**不猜一个档写值**）。
fn number_choice_hit(widths: &[i32], x: i32) -> Option<usize> {
    let mut left = 0;
    for (index, width) in widths.iter().enumerate() {
        if x >= left && x < left + width {
            return Some(index);
        }
        left += width + NUMBER_CHOICE_GAP;
    }
    None
}

/// 一次激活（点击 / 键盘 Space）落在哪一段（纯函数，可测）。
///
/// 光标命中的段优先；命不中（键盘激活，或点进了 2px 段间间隙）→ 取当前高亮档的
/// **下一档**（循环）—— 让键盘用户也能换档（ownerdraw 按钮的 Space 会发 `BN_CLICKED`，
/// 但那时没有点击坐标）。`count = 0` / 无档位 → `None`（不写值）。
fn number_choice_activation(
    hit: Option<usize>,
    selected: Option<usize>,
    count: usize,
) -> Option<usize> {
    if let Some(index) = hit {
        return Some(index);
    }
    if count == 0 {
        return None;
    }
    Some(match selected {
        Some(index) => (index + 1) % count,
        None => 0,
    })
}

/// 控件的计划宽度（逻辑像素）：各段按文案估宽 + 内边距（clamp 到段宽上下限）+ 段间间隙。
///
/// 只用于给控件定尺寸；绘制/命中端按**实际客户区均分**（[`number_choice_equal_widths`]），
/// 免得 DPI 舍入让按下位置与画出的段错位。
fn number_choice_planned_width(options: &[(&str, f64)]) -> i32 {
    let segments: i32 = options
        .iter()
        .map(|(label, _)| {
            (crate::ui::chat::panels::estimated_text_width(label, 13.5)
                + f64::from(NUMBER_CHOICE_SEG_PAD))
            .clamp(
                f64::from(NUMBER_CHOICE_SEG_MIN),
                f64::from(NUMBER_CHOICE_SEG_MAX),
            )
            .round() as i32
        })
        .sum();
    let gaps = NUMBER_CHOICE_GAP * (options.len().saturating_sub(1) as i32);
    (segments + gaps).max(NUMBER_CHOICE_SEG_MIN)
}

/// 各段矩形（物理像素；相对控件客户区左上角）。
fn number_choice_segment_rects(hwnd: HWND) -> Vec<paint_win::Rect> {
    let (client_w, client_h) = client_size(hwnd);
    let count = NUMBER_CHOICES.with(|states| {
        states
            .borrow()
            .get(&(hwnd as isize))
            .map(|state| state.options.len())
            .unwrap_or(0)
    });
    let widths = number_choice_equal_widths(client_w, count);
    let mut left = 0;
    let mut rects = Vec::with_capacity(widths.len());
    for width in widths {
        rects.push(paint_win::Rect::new(left, 0, width, client_h));
        left += width + NUMBER_CHOICE_GAP;
    }
    rects
}

/// 点击时的命中段（光标 → 控件坐标 → [`number_choice_hit`]）；取不到光标 → `None`。
fn number_choice_clicked_index(hwnd: HWND) -> Option<usize> {
    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } == 0 || unsafe { ScreenToClient(hwnd, &mut point) } == 0
    {
        return None;
    }
    let widths: Vec<i32> = number_choice_segment_rects(hwnd)
        .iter()
        .map(|rect| rect.w)
        .collect();
    number_choice_hit(&widths, point.x)
}

/// 分段控件绘制：整组一圈中性描边；每段按选中/悬浮取面、文字居中（选中 `ink`、
/// 未选中 `dim`）；读 tokens 现值 —— 换主题后由 `apply_theme` 触发重绘。
fn draw_number_choice(item: &DrawItemStruct) {
    let state =
        NUMBER_CHOICES.with(|states| states.borrow().get(&(item.hwndItem as isize)).copied());
    let Some(state) = state else {
        return;
    };
    let tokens = theme::tokens();
    let rects = number_choice_segment_rects(item.hwndItem);
    if rects.is_empty() {
        return;
    }
    let group = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    let hovered = number_choice_clicked_index(item.hwndItem);
    let font = unsafe { SendMessageW(item.hwndItem, WM_GETFONT, 0, 0) } as HFONT;
    unsafe {
        let old = if font != 0 {
            SelectObject(item.hDC, font)
        } else {
            0
        };
        for (index, segment) in rects.iter().enumerate() {
            let selected = state.selected == Some(index);
            let face = paint_win::button_face(
                tokens,
                if selected {
                    ButtonRole::TabOn
                } else {
                    ButtonRole::TabOff
                },
                hovered == Some(index) && !selected,
                false,
            );
            let segment = segment.offset(group.x, group.y);
            if let Some(bg) = &face.bg {
                paint_win::fill_rect(item.hDC, segment, bg);
            }
            if let Some(overlay) = face.overlay {
                paint_win::fill_color(item.hDC, segment, overlay);
            }
            if let Some((label, _)) = state.options.get(index) {
                let mut text_rect = RECT {
                    left: segment.x,
                    top: segment.y,
                    right: segment.right(),
                    bottom: segment.bottom(),
                };
                SetBkMode(item.hDC, TRANSPARENT);
                SetTextColor(item.hDC, paint_win::colorref(face.ink));
                DrawTextW(
                    item.hDC,
                    wide(label).as_ptr(),
                    -1,
                    &mut text_rect,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                );
            }
        }
        // 整组描边：中性 `bar_edge`（与分隔线同族），让「分段组」在页面上有边界。
        paint_win::draw_frame(item.hDC, group, tokens.bar_edge, &theme::Bevel::NONE);
        if old != 0 {
            SelectObject(item.hDC, old);
        }
    }
}

/// 重建当前 Tab 的字段控件（旧控件销毁）。
fn rebuild_tab() {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    with_state(|state| {
        for slot in state.slots.drain(..) {
            unsafe { DestroyWindow(slot.hwnd) };
            // 句柄会被系统复用：销毁的开关 / 档位段必须注销，不能留陈旧状态项。
            SWITCH_STATES.with(|states| states.borrow_mut().unregister(slot.hwnd as isize));
            unregister_number_choice(slot.hwnd as isize);
        }
        // 密钥揭示按钮与动态帮助行的控件随槽位销毁：引用一并清空。
        state.secret_pairs.clear();
        state.dynamic_hints.clear();
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        // 逻辑坐标（摆放由 `layout` 统一按 DPI 缩放；创建时的物理初值会被覆盖）。
        // 内容坐标以竖栏右缘为 0 点（`layout` 是唯一的 RAIL_W 转换点），右侧留 MARGIN。
        let (width, _height) = client_size(hwnd);
        let logical_width = (f64::from(width) / scale).round() as i32;
        let content_w = (logical_width - RAIL_W - MARGIN * 2).max(120);
        // 内容区完整宽度（含两侧 MARGIN；与 macOS `build_field` 的 `width` 同口径）：
        // 控件右缘统一对齐 `content_width - MARGIN`，宽度分档见 [`field_control_size`]。
        let content_width = logical_width - RAIL_W;
        let tab = &TABS[state.tab];

        // 字体按槽的基础字号在创建时取用（这里固定用 13 号正文）。
        let body = *state.fonts.first().unwrap_or(&0);
        let small = *state.fonts.get(1).unwrap_or(&body);

        let mut y = 0i32;
        let mut slots: Vec<WinSlot> = Vec::new();
        for section in tab.sections {
            // 小节标题。
            let title = unsafe {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide(section.title).as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    MARGIN,
                    0,
                    content_w,
                    18,
                    hwnd,
                    0,
                    hinstance,
                    std::ptr::null(),
                )
            };
            unsafe {
                SendMessageW(
                    title,
                    WM_SETFONT,
                    *state.fonts.get(2).unwrap_or(&body) as WPARAM,
                    1,
                )
            };
            stamp_text(title, TextRole::Body);
            slots.push(WinSlot {
                hwnd: title,
                key: None,
                kind: None,
                x: MARGIN,
                y,
                w: content_w,
                h: 18,
                font_base: 13,
                role: Some(TextRole::Body),
            });
            y += 22;
            for field in section.fields {
                // 修饰键键位由录制控件按平台写入 schema 里的键，不渲染独立控件。
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue;
                }
                // 行结构（2026-10-05 按设计稿 `.srow` 与 macOS 同式重排）：标签块在**左**
                // （标签在上，帮助与动态提示在标签下、按标签块宽自动换行，`dim` 小字），
                // 控件在**右**、右缘统一对齐内容右缘，行内垂直居中；Action 行无左标签
                // （按钮文字即标题）。旧布置（右对齐标签列 + 控件挤在中列 + 帮助塞控件
                // 下）把全部文案压进中列，长帮助会截断。
                let (ctrl_w, ctrl_h) = field_control_size(field);
                let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
                let label_w = field_label_width(content_width, ctrl_w);
                // 帮助行数估算（与 macOS 同式）：估算是字形宽下界，×1.2 留富余再向上
                // 取整，clamp 1..=4；STATIC（SS_LEFT）按给定宽高自动换行，给足行数高度。
                let help_lines: usize = if field.help.is_empty() {
                    0
                } else {
                    let est = crate::ui::chat::panels::estimated_text_width(field.help, 11.0);
                    ((est / f64::from(label_w) * 1.2).ceil() as usize).clamp(1, 4)
                };
                // 动态帮助行（如 Bash 白名单计数）：文本在刷新路径按草稿现值重算；
                // 高度要参与左块估算，所以在这里先取一次。
                let dynamic_hint = crate::ui::settings::dynamic_field_hint(
                    field.key,
                    &settings_ui().view().values,
                );
                // 左块高度：标签 18 + 帮助（2 + N×行高）+ 动态提示一行；行高取控件高与
                // 左块高的较大者，控件在行内垂直居中。
                let mut block_h = if matches!(field.kind, FieldKind::Action) {
                    0
                } else {
                    18
                };
                if help_lines > 0 {
                    block_h += 2 + help_lines as i32 * HELP_H;
                }
                if dynamic_hint.is_some() {
                    block_h += 2 + HELP_H;
                }
                let row_h = ctrl_h.max(block_h).max(ROW_H);
                let ctrl_y = y + ((row_h - ctrl_h) / 2).max(0);

                // 标签文本含单位后缀（`display_label`，与 macOS 同源）。
                let label = unsafe {
                    CreateWindowExW(
                        0,
                        wide("STATIC").as_ptr(),
                        wide(&field.display_label()).as_ptr(),
                        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                        MARGIN,
                        0,
                        label_w,
                        18,
                        hwnd,
                        0,
                        hinstance,
                        std::ptr::null(),
                    )
                };
                unsafe { SendMessageW(label, WM_SETFONT, small as WPARAM, 1) };
                stamp_text(label, TextRole::Body);
                slots.push(WinSlot {
                    hwnd: label,
                    key: None,
                    kind: None,
                    x: MARGIN,
                    y: y + 2,
                    w: label_w,
                    h: 18,
                    font_base: 11,
                    role: Some(TextRole::Body),
                });

                let (class, style, text) = match field.kind {
                    // 自绘开关：不承载 BM_SETCHECK 语义（状态在 SWITCH_STATES 镜像表）。
                    FieldKind::Bool => (
                        "BUTTON",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                        field.label,
                    ),
                    FieldKind::Number { .. } => (
                        "EDIT",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
                        "",
                    ),
                    // 数值档位：一个 ownerdraw 按钮画整排互斥段（`paint_win::draw_*` 之外
                    // 的自绘面，绘制在 `on_drawitem` 的 `NUMBER_CHOICES` 分支）。
                    FieldKind::NumberChoice { .. } => (
                        "BUTTON",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                        "",
                    ),
                    // 密钥：遮蔽态由 `ES_PASSWORD` 承担；「显示/隐藏」按钮用
                    // `EM_SETPASSWORDCHAR` 在明文/复遮蔽之间切换（见 on_command 的揭示分支）。
                    FieldKind::Text { secret } => (
                        "EDIT",
                        WS_CHILD
                            | WS_VISIBLE
                            | WS_TABSTOP
                            | WS_BORDER
                            | ES_AUTOHSCROLL as u32
                            | (if secret { ES_PASSWORD as u32 } else { 0 }),
                        "",
                    ),
                    // 下拉（②「全面自绘」）：`CBS_OWNERDRAWFIXED` + 本例的 `WM_DRAWITEM`
                    // 分支画选中字段区与全部条目；**保留真下拉语义**（键盘、CBN_* 通知、
                    // `CB_GETCURSEL/CB_SETCURSEL/CB_GETLBTEXT` 全部照旧，读写路径零改动）。
                    // 条目高度用 `CB_SETITEMHEIGHT(-1, h)` 在创建后程序化设定 ——
                    // `WM_MEASUREITEM` 未被 windows.rs 的设置窗分派转发，CB_SETITEMHEIGHT
                    // 给 owner-draw-fixed 组合框同时设字段区与全部条目高度（文档行为），
                    // 不依赖那条消息。
                    FieldKind::Enum(_)
                    | FieldKind::FontFamily
                    | FieldKind::CardChoice
                    | FieldKind::ProfileChoice => (
                        "COMBOBOX",
                        WS_CHILD
                            | WS_VISIBLE
                            | WS_TABSTOP
                            | CBS_DROPDOWNLIST as u32
                            | CBS_OWNERDRAWFIXED as u32,
                        "",
                    ),
                    FieldKind::Multiline => (
                        "EDIT",
                        WS_CHILD
                            | WS_VISIBLE
                            | WS_TABSTOP
                            | WS_BORDER
                            | WS_VSCROLL
                            | ES_MULTILINE as u32
                            | ES_WANTRETURN as u32,
                        "",
                    ),
                    FieldKind::Info => ("STATIC", WS_CHILD | WS_VISIBLE, ""),
                    FieldKind::Shortcut => {
                        ("BUTTON", WS_CHILD | WS_VISIBLE | WS_TABSTOP, "录制快捷键")
                    }
                    // 上面已跳过；这里兜底不产生特殊样式。
                    FieldKind::ShortcutModifiers => ("STATIC", WS_CHILD, ""),
                    FieldKind::Action => {
                        ("BUTTON", WS_CHILD | WS_VISIBLE | WS_TABSTOP, field.label)
                    }
                };
                // 控件位置：右缘对齐内容右缘（ctrl_x）、行内垂直居中（ctrl_y）；
                // 密钥字段把揭示按钮的位置从控件宽里让出来（按钮贴控件组右缘）。
                let (field_w, field_h) = match field.kind {
                    FieldKind::Text { secret: true } => {
                        ((ctrl_w - SECRET_BTN_W - 4).max(40), ctrl_h)
                    }
                    _ => (ctrl_w, ctrl_h),
                };
                let control = unsafe {
                    CreateWindowExW(
                        0,
                        wide(class).as_ptr(),
                        wide(text).as_ptr(),
                        // WS_CLIPSIBLINGS：通知浮层要浮在字段控件之上（见安装处样式说明）。
                        style | WS_CLIPSIBLINGS,
                        ctrl_x,
                        0,
                        field_w,
                        field_h,
                        hwnd,
                        (FIELD_BASE + slots.len() as i32) as isize,
                        hinstance,
                        std::ptr::null(),
                    )
                };
                unsafe { SendMessageW(control, WM_SETFONT, body as WPARAM, 1) };
                if matches!(field.kind, FieldKind::Bool) {
                    // 圆角 = 半高（设计 `.sw` 的胶囊）；样式位已在创建时给。
                    paint_win::install_button(control, scaled(SWITCH_H / 2, scale));
                    SWITCH_STATES.with(|states| {
                        states.borrow_mut().register(control as isize, false);
                    });
                }
                if let FieldKind::NumberChoice { options } = field.kind {
                    // 高亮档按草稿现值取最近档（值缺失 = 无高亮）；呈现状态放镜像表
                    //（绘制期读它，不碰 STATE）。
                    let selected = number_choice_selected(
                        options,
                        settings_ui()
                            .view()
                            .values
                            .get(field.key)
                            .and_then(SettingsValue::as_number),
                    );
                    register_number_choice(control, options, selected);
                    // 整组一个圆角区域（`radii.btn`）；悬浮跟踪由 `install_button` 的子类承担。
                    paint_win::install_button(
                        control,
                        scaled(theme::tokens().radii.btn.round() as i32, scale),
                    );
                }
                if matches!(
                    field.kind,
                    FieldKind::Enum(_)
                        | FieldKind::FontFamily
                        | FieldKind::CardChoice
                        | FieldKind::ProfileChoice
                ) {
                    // 字段区与全部下拉条目同高（逻辑 ROW_H；见样式的注释）。
                    unsafe {
                        SendMessageW(
                            control,
                            CB_SETITEMHEIGHT,
                            -1isize as usize,
                            scaled(ROW_H, scale) as isize,
                        )
                    };
                }
                if matches!(field.kind, FieldKind::Action | FieldKind::Shortcut) {
                    // schema 驱动的动作按钮 / 快捷键录制按钮：全面自绘的普通面
                    // （ownerdraw + 悬浮/圆角子类；角色 Normal）。
                    unsafe {
                        make_themed_button(
                            control,
                            ButtonRole::Normal,
                            scale,
                            theme::tokens().radii.btn,
                        )
                    };
                }
                slots.push(WinSlot {
                    hwnd: control,
                    key: Some(field.key),
                    kind: Some(field.kind),
                    x: ctrl_x,
                    y: ctrl_y,
                    w: field_w,
                    h: field_h,
                    font_base: 13,
                    // 字段控件自身不记录字色：ownerdraw 按钮的 GWLP_USERDATA 被角色占用；
                    // STATIC / 只读 EDIT 经 WM_CTLCOLORSTATIC、可编辑 EDIT 经
                    // WM_CTLCOLOREDIT（父窗子类转发，见 `settings_subclass_proc`）
                    // 按 tokens 现场取色，下拉由 `WM_DRAWITEM` 自绘。
                    role: None,
                });
                if matches!(field.kind, FieldKind::Text { secret: true }) {
                    // 揭示按钮：与编辑框同排、放右侧；遮蔽字符在建控件时读回默认值
                    // （`EM_GETPASSWORDCHAR`），复遮蔽写回同一字符。
                    let password_char =
                        unsafe { SendMessageW(control, EM_GETPASSWORDCHAR, 0, 0) as usize };
                    let button = unsafe {
                        CreateWindowExW(
                            0,
                            wide("BUTTON").as_ptr(),
                            wide("显示").as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
                            0,
                            0,
                            SECRET_BTN_W,
                            ROW_H,
                            hwnd,
                            (SECRET_ID_BASE + state.secret_pairs.len() as i32) as isize,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(button, WM_SETFONT, body as WPARAM, 1) };
                    // 全面自绘：揭示按钮也是普通面（ownerdraw + 悬浮/圆角子类）。
                    unsafe {
                        make_themed_button(
                            button,
                            ButtonRole::Normal,
                            scale,
                            theme::tokens().radii.btn,
                        )
                    };
                    slots.push(WinSlot {
                        hwnd: button,
                        key: None,
                        kind: None,
                        // 贴控件组右缘（与输入框同一右缘）：窄窗口下按钮不被挤出内容区。
                        x: ctrl_x + ctrl_w - SECRET_BTN_W,
                        y: ctrl_y,
                        w: SECRET_BTN_W,
                        h: ROW_H,
                        font_base: 13,
                        role: None,
                    });
                    state.secret_pairs.push(WinSecretPair {
                        edit: control,
                        button,
                        revealed: false,
                        // ES_PASSWORD 控件的默认遮蔽字符（读不到时回落 ● U+25CF）。
                        password_char: if password_char == 0 {
                            0x25CF
                        } else {
                            password_char
                        },
                    });
                }
                // 左块文案：标签之下的帮助（换行）+ 动态提示一行；Action 行无标签，
                // 帮助直接从行首起（与 macOS 的 `block_y` 同式）。
                let mut block_y = if matches!(field.kind, FieldKind::Action) {
                    y + 2
                } else {
                    y + 20
                };
                if help_lines > 0 {
                    let help = unsafe {
                        CreateWindowExW(
                            0,
                            wide("STATIC").as_ptr(),
                            wide(field.help).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                            MARGIN,
                            0,
                            label_w,
                            help_lines as i32 * HELP_H,
                            hwnd,
                            0,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(help, WM_SETFONT, small as WPARAM, 1) };
                    stamp_text(help, TextRole::Hint);
                    slots.push(WinSlot {
                        hwnd: help,
                        key: None,
                        kind: None,
                        x: MARGIN,
                        y: block_y,
                        w: label_w,
                        h: help_lines as i32 * HELP_H,
                        font_base: 11,
                        role: Some(TextRole::Hint),
                    });
                    block_y += help_lines as i32 * HELP_H + 2;
                }
                // 动态帮助行（如 Bash 白名单计数）：静态 help 下一行，刷新时按草稿重算。
                if let Some(text) = dynamic_hint {
                    let hint = unsafe {
                        CreateWindowExW(
                            0,
                            wide("STATIC").as_ptr(),
                            wide(&text).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                            MARGIN,
                            0,
                            label_w,
                            HELP_H,
                            hwnd,
                            0,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(hint, WM_SETFONT, small as WPARAM, 1) };
                    stamp_text(hint, TextRole::Hint);
                    slots.push(WinSlot {
                        hwnd: hint,
                        key: None,
                        kind: None,
                        x: MARGIN,
                        y: block_y,
                        w: label_w,
                        h: HELP_H,
                        font_base: 11,
                        role: Some(TextRole::Hint),
                    });
                    state.dynamic_hints.push((hint, field.key));
                }
                // 行高推进收口到一处（行内元素不再各自推进 y）。
                y += row_h + ROW_GAP;
            }
            y += SECTION_GAP;
        }
        state.slots = slots;
        // 管理面（工具页 / 记忆页）：先释放旧 Tab 的面板控件，再按当前代数重建。
        state.panel_base_y = y;
        destroy_panel_area(state);
        build_panel_controls(state);
    });
}

// ==========================================
// 管理面（工具页 / 记忆页）
// ==========================================

/// 释放管理面区域：先把详情编辑框的未保存内容暂存进草稿，再销毁控件。
fn destroy_panel_area(state: &mut SettingsState) {
    if state.detail_content != 0 {
        let text = window_text(state.detail_content);
        settings_ui().stash_memory_content(&text);
    }
    for slot in state.panel_slots.drain(..) {
        unsafe { DestroyWindow(slot.hwnd) };
    }
    state.row_slots.clear();
    state.detail_content = 0;
    // 文档编辑弹窗（②）是独立顶层窗，不登记进面板槽，随模态循环整体开合，
    // 不参与页面面板区的重建/销毁，这里不动它。
}

/// 刷新路径的管理面同步：数据代数变化才重建（不打断正在编辑的文本框）。
///
/// 不再按 Tab 过滤：行编辑文档区对全部 Tab 渲染，文档打开/关闭也会推进代数。
fn sync_panels(state: &mut SettingsState) {
    if settings_ui().panel_generation() == state.panel_generation {
        return;
    }
    destroy_panel_area(state);
    build_panel_controls(state);
}

/// 创建一个管理面控件并登记进面板槽（逻辑坐标；摆放由 layout 统一按 DPI 缩放）。
///
/// `role` = 语义字色（STATIC 用；EDIT/按钮传 `None`，见 [`WinSlot::role`] 的约定）。
#[allow(clippy::too_many_arguments)]
fn create_panel_control(
    state: &mut SettingsState,
    class: &str,
    text: &str,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    font: HFONT,
    font_base: i32,
    role: Option<TextRole>,
    extra_style: u32,
    id: i32,
) -> HWND {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let base = match class {
        "BUTTON" => WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
        "EDIT" => {
            WS_CHILD
                | WS_VISIBLE
                | WS_BORDER
                | WS_CLIPSIBLINGS
                | ES_MULTILINE as u32
                | ES_WANTRETURN as u32
        }
        _ => WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
    };
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(text).as_ptr(),
            base | extra_style,
            x,
            y,
            w,
            h,
            state.hwnd,
            id as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1) };
    if let Some(role) = role {
        stamp_text(hwnd, role);
    }
    state.panel_slots.push(WinSlot {
        hwnd,
        key: None,
        kind: None,
        x,
        y,
        w,
        h,
        font_base,
        role,
    });
    hwnd
}

/// 构建管理面控件（从 `panel_base_y` 往下排；结束后更新终止 y 与内容高度）。
fn build_panel_controls(state: &mut SettingsState) {
    let scale = dpi_scale(state.hwnd);
    let (width, _) = client_size(state.hwnd);
    let logical_width = (f64::from(width) / scale).round() as i32;
    // 与 `rebuild_tab` 同一条内容宽口径（竖栏右侧的可排区域）。
    let content_w = (logical_width - RAIL_W - MARGIN * 2).max(120);
    let body = *state.fonts.first().unwrap_or(&0);
    let small = *state.fonts.get(1).unwrap_or(&body);
    let bold = *state.fonts.get(2).unwrap_or(&body);
    let mut y = state.panel_base_y;
    match TABS[state.tab].id {
        "tools" => {
            for (index, panel) in settings_ui().tools_panels().iter().enumerate() {
                // 「刷新」按钮挂在本页第一个面板的标题行（一次拉取覆盖三个面板）。
                let refresh = if index == 0 {
                    Some(REFRESH_TOOLS)
                } else {
                    None
                };
                y = build_panel(state, panel, refresh, content_w, y, body, small, bold);
            }
        }
        "memory" => {
            if let Some(status) = settings_ui().memory_status_text() {
                create_panel_control(
                    state,
                    "STATIC",
                    &status,
                    MARGIN,
                    y,
                    content_w,
                    18,
                    small,
                    11,
                    Some(TextRole::Hint),
                    0,
                    0,
                );
                y += 20;
            }
            let panels = settings_ui().memory_panels();
            if let Some(items) = panels.first() {
                y = build_panel(
                    state,
                    items,
                    Some(REFRESH_MEMORY),
                    content_w,
                    y,
                    body,
                    small,
                    bold,
                );
            }
            y = build_memory_detail(state, content_w, y, body, small, bold);
            if let Some(jobs) = panels.get(1) {
                y = build_panel(state, jobs, None, content_w, y, body, small, bold);
            }
        }
        // 本批：外观页的音效试听面板（行按钮 = 试听；分配编辑在文档区）。
        "appearance" => {
            for panel in settings_ui().sound_panels().iter() {
                y = build_panel(
                    state,
                    panel,
                    Some(REFRESH_SOUNDS),
                    content_w,
                    y,
                    body,
                    small,
                    bold,
                );
            }
        }
        _ => {}
    }
    // 行编辑文档不再追加在页尾（②）：打开中的文档走独立模态编辑窗
    // （`sync_document_dialog` + `present_document_dialog`），页面内容不被它顶长。
    state.panel_end_y = y;
    // 底部留白 26（2026-10-05，与 macOS 同一留白值）：滚到底时最后一行不贴页脚线
    // （旧 +8 会让末行半截贴在操作条上，观感即「显示不全」）。
    state.content_height = y + 26;
    state.panel_generation = settings_ui().panel_generation();
}

// ==========================================
// 行编辑文档弹窗（②）：独立模态编辑窗，随文档加载呈现
// ==========================================
//
// 用户规则「显示的东西有的在页面最底部」的根因是文档区原先被无条件追加在
// `build_panel_controls` 末尾；现在改为**独立模态编辑窗**，语义与 macOS 文档
// 预览面板（`present_document_panel`）逐条对齐 —— **载体刻意不同**：macOS 侧
// 2026-10-05 起改用非模态 NSPopover（同一预览器在模态 NSAlert 里被用户实机判为
// 「所有用到这个框的滑动都卡」），Windows 侧保留自建模态窗（属主禁用 + 嵌套消息
// 循环）：这里没有 AppKit 的模态合成路径，同源卡顿未证实，不为对称而对称改
// （Windows 实机未验证；若也复现滚动卡顿再按同形处置）。语义对齐项：
// - 只在内容**加载完成后**弹一次（[`document_should_present`]；「读取中」相位不弹，
//   保存回执只重写文本、不重走该相位，所以同一份文档不会因保存回执再弹）；
// - 「保存」是主操作（弹窗右缘、ownerdraw 主按钮面），只读文档只有「关闭」；
// - 任何非「保存」的收尾（关闭 / Esc / 标题栏 ×）都按关闭处理：`close_document()`
//   丢弃未保存编辑；
// - 「保存」先留草稿再提交：保存失败重开同一文档时草稿优先恢复（旧页面内编辑框语义）；
// - 弹窗是模态（属主禁用 + 本线程嵌套消息循环，与输入弹窗/聊天对话框同款）：
//   弹窗在显期间错误通知不嵌套抢弹（`notice_modal_up`），刷新也不重入呈现
//   （`doc_dialog_up`）；刷新带来的主题广播会重刷弹窗字色（见 `apply_theme`）。
//
// 数据路径全部复用 `SettingsUi` 既有入口（`open_document` / `save_document` /
// `close_document`），不重写。

/// 弹窗窗口类名（与设置窗/浮层/输入弹窗等互不干扰）。
const DOC_DIALOG_CLASS: &str = "DeskPetSettingsDocDialog";
/// 弹窗客户区尺寸（逻辑像素；与 macOS `DOC_DIALOG_W/H` 同值）。
const DOC_DIALOG_W: i32 = 520;
const DOC_DIALOG_H: i32 = 260;
/// 弹窗控件 id。**必须避开 IDOK(1)/IDCANCEL(2)**：`GetDlgItem` 按 id 取控件，
/// 撞号会让「保存」按钮的取回命中标题 STATIC（本文件曾踩过）。
const DOC_DIALOG_TITLE_ID: i32 = 101;
const DOC_DIALOG_HINT_ID: i32 = 102;
const DOC_DIALOG_EDIT_ID: i32 = 103;
/// 弹窗次要动作 id（阶段文案「重新生成」/ MCP「测试连接」/ Card 模版「复制」；不关弹窗）。
const DOC_DIALOG_REGENERATE_ID: i32 = 104;
const DOC_DIALOG_TEST_ID: i32 = 105;
const DOC_DIALOG_COPY_ID: i32 = 106;
/// 按钮尺寸（逻辑像素）。
const DOC_DIALOG_BTN_W_SAVE: i32 = 90;
const DOC_DIALOG_BTN_W_CLOSE: i32 = 70;
const DOC_DIALOG_BTN_W_REGENERATE: i32 = 96;
const DOC_DIALOG_BTN_W_TEST: i32 = 90;
/// 「复制」与「关闭」同宽（两个短标签按钮，行上同排）。
const DOC_DIALOG_BTN_W_COPY: i32 = 70;
const DOC_DIALOG_BTN_H: i32 = 26;

/// 弹窗按钮行（纯函数，逻辑像素）：从右缘往左排（首项贴右缘），返回每项左缘 x。
///
/// 顺序即输入顺序：保存（主操作）→ 关闭 → 次要动作（「重新生成」/「测试连接」）。
/// 只读文档没有保存；无匹配目标时自然少一项；统一留 8px 间距。
fn doc_dialog_button_row(client_w: i32, widths: &[i32]) -> Vec<i32> {
    let mut right = client_w - MARGIN;
    widths
        .iter()
        .map(|w| {
            let x = right - w;
            right = x - 8;
            x
        })
        .collect()
}

/// 文档弹窗是否该呈现（纯函数，可测；与 macOS `document_should_present` 同判据）：
/// 内容已加载 + 本次打开还没呈现过 + 没有在显弹窗。
fn document_should_present(loaded: bool, dialog_up: bool, presented_this_open: bool) -> bool {
    loaded && !dialog_up && !presented_this_open
}

/// 弹窗内部布局（纯函数，逻辑像素）：客户区尺寸 → 标题 / 说明 / 编辑框矩形与按钮行 y。
///
/// 按钮行贴弹窗底部，编辑框吃剩余高度 —— 弹窗尺寸只影响编辑框。
fn doc_dialog_layout(
    client: (i32, i32),
) -> (paint_win::Rect, paint_win::Rect, paint_win::Rect, i32) {
    let (w, h) = client;
    let content_w = (w - MARGIN * 2).max(60);
    let title = paint_win::Rect::new(MARGIN, MARGIN, content_w, 20);
    let hint = paint_win::Rect::new(MARGIN, MARGIN + 24, content_w, 32);
    let edit_y = MARGIN + 58;
    let buttons_y = (h - MARGIN - DOC_DIALOG_BTN_H).max(edit_y + 46);
    let edit = paint_win::Rect::new(MARGIN, edit_y, content_w, (buttons_y - 6 - edit_y).max(40));
    (title, hint, edit, buttons_y)
}

/// 弹窗次要动作的计划（纯函数，可测）：目标 →（标签, 控件 id, 按钮语义, 宽度）。
///
/// 只读文档不配「保存」；「重新生成」只属阶段文案、「测试连接」只属已有名字的 MCP
/// 服务器、「复制」只属只读的 CardTemplate（提示词全文供复制给外部 AI 生成新卡）。
/// 与 macOS `doc_dialog_buttons` 同一目标门控（那边是整表按钮计划，这边只列次要动作）。
fn doc_dialog_secondary(
    target: &DocumentTarget,
) -> Option<(&'static str, i32, SettingsButton, i32)> {
    match target {
        DocumentTarget::CardStages => Some((
            "重新生成",
            DOC_DIALOG_REGENERATE_ID,
            SettingsButton::DocumentRegenerate,
            DOC_DIALOG_BTN_W_REGENERATE,
        )),
        DocumentTarget::McpServer { name } if !name.is_empty() => Some((
            "测试连接",
            DOC_DIALOG_TEST_ID,
            SettingsButton::DocumentTest,
            DOC_DIALOG_BTN_W_TEST,
        )),
        DocumentTarget::CardTemplate => Some((
            "复制",
            DOC_DIALOG_COPY_ID,
            SettingsButton::DocumentCopy,
            DOC_DIALOG_BTN_W_COPY,
        )),
        _ => None,
    }
}

/// 弹窗在显期间的同步（②）：文档内容变了刷编辑框、浮层级通知写进说明行。
///
/// 模态期间的唯一可见反馈通道是弹窗自己：浮层挂在设置窗上会藏在弹窗后面，所以
/// Info / Warning 直接写说明行（说明行兼作模态内状态行）；Error 不在这里消费，
/// 由 `present_notice` 的模态门挡下、弹窗收尾后补弹（与 macOS 同规）。
///
/// 内容刷新会覆盖未保存编辑 —— 只发生在用户显式触发（重新生成完成 / 保存回执）
/// 之后，就地登记该口径。
fn sync_open_document_dialog(document: &DocumentState, view: &SettingsView) {
    with_state(|state| {
        if !state.doc_dialog_up || state.doc_dialog == 0 {
            return;
        }
        let dialog = state.doc_dialog;
        // 内容刷新（仅限同一目标；换目标是新一次打开，由呈现门处理）。
        let needs_content = document.loaded
            && match &state.doc_dialog_content {
                Some((target, content)) => {
                    target == &document.target && content != &document.content
                }
                None => false,
            };
        if needs_content {
            state.doc_dialog_content = Some((document.target.clone(), document.content.clone()));
            unsafe {
                let edit = GetDlgItem(dialog, DOC_DIALOG_EDIT_ID);
                if edit != 0 {
                    SetWindowTextW(edit, wide(&document.content).as_ptr());
                }
            }
        }
        // 浮层级通知 → 说明行（代际判新同源；Error 留给收尾后的模态补弹）。
        let Some(notice) = view.notice.as_deref().filter(|text| !text.is_empty()) else {
            return;
        };
        let action = notice_action(
            view.notice_level,
            view.notice_generation,
            state.presented_generation,
        );
        if action != NoticeAction::Toast {
            return;
        }
        state.presented_generation = view.notice_generation;
        unsafe {
            let hint = GetDlgItem(dialog, DOC_DIALOG_HINT_ID);
            if hint != 0 {
                SetWindowTextW(hint, wide(notice).as_ptr());
            }
        }
    });
}

/// 文档弹窗同步（`refresh_ui` 的固定一环；在长借用之外调用）。
fn sync_document_dialog(view: &SettingsView) {
    let Some(document) = settings_ui().document() else {
        // 文档关闭：复位本次打开的呈现标记并清掉失败草稿（与 macOS 同规）。
        with_state(|state| {
            state.doc_presented_this_open = false;
            state.doc_draft = None;
        });
        return;
    };
    // 弹窗在显：先把模态期间到达的刷新收进弹窗；再走呈现门（被 doc_dialog_up 挡住）。
    sync_open_document_dialog(&document, view);
    if !document.loaded {
        // 读取中：本次打开尚未呈现（同一文档重新打开也经这个 false 相位复位）。
        with_state(|state| state.doc_presented_this_open = false);
        return;
    }
    let should = with_state(|state| {
        document_should_present(
            document.loaded,
            state.doc_dialog_up,
            state.doc_presented_this_open,
        )
    })
    .unwrap_or(false);
    if !should {
        return;
    }
    // 先置位再进模态：模态期间到达的刷新（保存回执等）不得重入。
    with_state(|state| state.doc_presented_this_open = true);
    let draft = with_state(|state| {
        state
            .doc_draft
            .clone()
            .filter(|(target, _)| target == &document.target)
            .map(|(_, text)| text)
    })
    .flatten();
    present_document_dialog(&document, draft);
}

/// 弹窗存活状态（挂在窗口 `GWLP_USERDATA`；循环退出后由调用方收回所有权）。
struct DocDialogState {
    edit: HWND,
    /// 任一收尾路径置 true（消息循环的退出条件）。
    done: bool,
    /// 「保存」为 Some（正文照读）；关闭 / Esc / 标题栏 × 保持 None。
    text: Option<String>,
}

/// 弹出文档编辑窗（模态；调用方在 `with_state` 借用之外）。
fn present_document_dialog(document: &DocumentState, draft: Option<String>) {
    let Some((owner, scale)) = with_state(|state| (state.hwnd, dpi_scale(state.hwnd))) else {
        return;
    };
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(DOC_DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(doc_dialog_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
    unsafe { RegisterClassW(&wc) };

    // 客户区 → 外框尺寸；居中于属主（设置窗）。
    let client_w = scaled(DOC_DIALOG_W, scale);
    let client_h = scaled(DOC_DIALOG_H, scale);
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: client_w,
        bottom: client_h,
    };
    unsafe { AdjustWindowRectEx(&mut window_rect, style, 0, 0) };
    let window_w = window_rect.right - window_rect.left;
    let window_h = window_rect.bottom - window_rect.top;
    let mut owner_rect: RECT = unsafe { std::mem::zeroed() };
    let (x, y) = if unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (CW_USEDEFAULT, CW_USEDEFAULT)
    };
    let dialog = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide(&document.title).as_ptr(),
            style,
            x,
            y,
            window_w,
            window_h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if dialog == 0 {
        rust_warn!("文档编辑弹窗创建失败（本次文档没有编辑入口）");
        return;
    }

    // 弹窗自持字体（与输入弹窗同规）：模态期间全局字体广播不会动到它，退出时一并释放。
    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let bold = make_font(scale, 13, true);
    let read_only = document.target.is_read_only();
    let (title_rect, hint_rect, edit_rect, buttons_y) =
        doc_dialog_layout((DOC_DIALOG_W, DOC_DIALOG_H));
    let create = |class: &str,
                  text: &str,
                  id: i32,
                  font: HFONT,
                  rect: paint_win::Rect,
                  extra_style: u32|
     -> HWND {
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                wide(class).as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | extra_style,
                scaled(rect.x, scale),
                scaled(rect.y, scale),
                scaled(rect.w, scale),
                scaled(rect.h, scale),
                dialog,
                id as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        if hwnd != 0 && font != 0 {
            unsafe { SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1) };
        }
        hwnd
    };
    let title = create(
        "STATIC",
        &document.title,
        DOC_DIALOG_TITLE_ID,
        bold,
        title_rect,
        0,
    );
    stamp_text(title, TextRole::Body);
    let hint_text = if read_only {
        "只读预览（内容来自服务端）；关闭即释放。"
    } else {
        "内容格式由服务端校验：保存失败会如实说明且不写入；保存后立即生效。"
    };
    let hint = create("STATIC", hint_text, DOC_DIALOG_HINT_ID, small, hint_rect, 0);
    stamp_text(hint, TextRole::Hint);
    let initial = draft.unwrap_or_else(|| document.content.clone());
    let edit = create(
        "EDIT",
        &initial,
        DOC_DIALOG_EDIT_ID,
        body,
        edit_rect,
        WS_TABSTOP
            | WS_BORDER
            | WS_VSCROLL
            | ES_MULTILINE as u32
            | ES_WANTRETURN as u32
            | if read_only { ES_READONLY as u32 } else { 0 },
    );
    // 按钮行（从右往左：保存是主操作、贴右缘；关闭次之；目标匹配的次要动作再往左）。
    let secondary = doc_dialog_secondary(&document.target);
    let mut planned: Vec<(&str, i32, SettingsButton, i32)> = Vec::new();
    if !read_only {
        planned.push((
            "保存",
            IDOK,
            SettingsButton::SaveDocument,
            DOC_DIALOG_BTN_W_SAVE,
        ));
    }
    planned.push((
        "关闭",
        IDCANCEL,
        SettingsButton::DocumentClose,
        DOC_DIALOG_BTN_W_CLOSE,
    ));
    if let Some(extra) = secondary {
        planned.push(extra);
    }
    let widths: Vec<i32> = planned.iter().map(|(_, _, _, w)| *w).collect();
    let xs = doc_dialog_button_row(DOC_DIALOG_W, &widths);
    let mut close_button = 0;
    for ((label, id, kind, w), x) in planned.iter().zip(xs.iter()) {
        let extra_style = if *id == IDOK {
            WS_TABSTOP | BS_DEFPUSHBUTTON as u32
        } else {
            WS_TABSTOP
        };
        let button = create(
            "BUTTON",
            label,
            *id,
            body,
            paint_win::Rect::new(*x, buttons_y, *w, DOC_DIALOG_BTN_H),
            extra_style,
        );
        // 全部按钮 ownerdraw：保存贴主按钮面、其余普通面（`style_button` 按语义表定）。
        style_button(*kind, button, scale);
        if *id == IDCANCEL {
            close_button = button;
        }
    }

    let state = Box::into_raw(Box::new(DocDialogState {
        edit,
        done: false,
        text: None,
    }));
    unsafe { SetWindowLongPtrW(dialog, GWLP_USERDATA, state as isize) };
    // 模态：属主禁用 + 本线程嵌套消息循环（与输入弹窗同款）。Enter / Esc 由
    // `IsDialogMessageW` 归位到「保存 / 关闭」—— 编辑框是多行 + `ES_WANTRETURN`，
    // 回车留作换行、不抢默认按钮。
    with_state(|ui| {
        ui.doc_dialog = dialog;
        ui.doc_dialog_content = Some((document.target.clone(), initial.clone()));
        ui.doc_dialog_up = true;
        ui.notice_modal_up = true;
    });
    unsafe {
        EnableWindow(owner, 0);
        ShowWindow(dialog, SW_SHOW);
        SetForegroundWindow(dialog);
        if edit != 0 {
            SetFocus(edit);
        } else if close_button != 0 {
            SetFocus(close_button);
        }
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while !unsafe { (*state).done } {
        let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if ret <= 0 {
            // 0 = WM_QUIT：转交外层循环，不吞在弹窗里。
            if ret == 0 {
                unsafe { PostQuitMessage(msg.wParam as i32) };
            }
            break;
        }
        if unsafe { IsDialogMessageW(dialog, &msg) } == 0 {
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    if !unsafe { (*state).done } {
        // 非确定/取消路径退出（WM_QUIT / 属主先关）：补一次销毁再收回状态。
        unsafe {
            (*state).done = true;
            DestroyWindow(dialog);
        }
    }
    let state = unsafe { Box::from_raw(state) };
    with_state(|ui| {
        ui.doc_dialog = 0;
        ui.doc_dialog_content = None;
        ui.doc_dialog_up = false;
        ui.notice_modal_up = false;
    });
    unsafe {
        if IsWindow(owner) != 0 {
            EnableWindow(owner, 1);
            SetForegroundWindow(owner);
        }
        if body != 0 {
            DeleteObject(body);
        }
        if small != 0 {
            DeleteObject(small);
        }
        if bold != 0 {
            DeleteObject(bold);
        }
    }
    // 收尾（与 macOS 同规）：保存 → 留草稿 + 提交；其余（关闭 / Esc / ×）→ 丢弃并关档。
    match state.text {
        Some(text) => {
            with_state(|ui| ui.doc_draft = Some((document.target.clone(), text.clone())));
            if let Err(error) = settings_ui().save_document(&text) {
                settings_ui().set_error(format!("保存未启动：{error}"));
            }
        }
        None => {
            with_state(|ui| ui.doc_draft = None);
            settings_ui().close_document();
        }
    }
}

/// 弹窗窗口过程：保存读值、关闭/× 收尾，都在销毁前落进 [`DocDialogState`]。
unsafe extern "system" fn doc_dialog_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            if code == BN_CLICKED && id == DOC_DIALOG_COPY_ID {
                // 「复制」**不关弹窗**（与 macOS 侧同）：复制编辑框里**当前显示**的文本
                // （逐字一致），成功后按钮就地变「已复制」（与编辑器素材面板同款反馈）；
                // 失败如实留痕，不静默。写系统剪贴板不走 Node 的 IPC 命令面，见
                // `ui/clipboard.rs` 模块头（与模型工具的 `clipboard_write` 是两条路）。
                let state =
                    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState };
                if !state.is_null() {
                    let text = window_text(unsafe { (*state).edit });
                    if crate::ui::clipboard::write_text(hwnd, &text) {
                        let button = unsafe { GetDlgItem(hwnd, DOC_DIALOG_COPY_ID) };
                        if button != 0 {
                            unsafe { SetWindowTextW(button, wide("已复制").as_ptr()) };
                        }
                    } else {
                        rust_warn!("复制 Card 模版到剪贴板失败");
                    }
                }
                return 0;
            }
            if code == BN_CLICKED && (id == DOC_DIALOG_REGENERATE_ID || id == DOC_DIALOG_TEST_ID) {
                // 次要动作**不关弹窗**：结果经共享层刷新回流本弹窗 —— 重新生成的内容
                // 落进编辑框、连接回执落进说明行（见 `sync_open_document_dialog`）。
                match id {
                    DOC_DIALOG_REGENERATE_ID => {
                        if let Err(error) = settings_ui().regenerate_card_stages() {
                            settings_ui().set_error(format!("重新生成未启动：{error}"));
                        }
                    }
                    _ => {
                        if let Err(error) = settings_ui().test_document_mcp_server() {
                            settings_ui().set_error(format!("连接测试未启动：{error}"));
                        }
                    }
                }
                return 0;
            }
            if code == BN_CLICKED && (id == IDOK || id == IDCANCEL) {
                unsafe {
                    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                    if !state.is_null() {
                        if id == IDOK {
                            (*state).text = Some(window_text((*state).edit));
                        }
                        (*state).done = true;
                    }
                    DestroyWindow(hwnd);
                }
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                if !state.is_null() {
                    // 关闭 = 取消（text 保持 None）。
                    (*state).done = true;
                }
                DestroyWindow(hwnd);
            }
            0
        }
        // 属主被先行销毁（托盘关闭设置窗）时窗口可能被系统先收掉：置 done 让模态循环退出。
        WM_DESTROY => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                if !state.is_null() {
                    (*state).done = true;
                }
            }
            0
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => on_ctlcolor(wparam, lparam),
        // 可编辑输入框与下拉清单的主题配色（弹窗过程自己接，不经父窗分派）。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => edit_ctlcolor(wparam, lparam),
        WM_DRAWITEM => {
            if lparam != 0 && on_drawitem(lparam) {
                1
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_ERASEBKGND => {
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top),
                &theme::tokens().field_bg,
            );
            1
        }
        WM_PAINT => {
            // 无擦除标记的失效 / 换主题后的强制重绘走这里（与设置窗同款兜底）。
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                paint_win::fill_rect(
                    hdc,
                    paint_win::Rect::new(
                        0,
                        0,
                        client.right - client.left,
                        client.bottom - client.top,
                    ),
                    &theme::tokens().field_bg,
                );
                EndPaint(hwnd, &ps);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 主题广播下刷新文档弹窗（弹窗在显期间换主题）：重刷标签字色 + 主按钮圆角 + 重绘。
fn apply_theme_doc_dialog(dialog: HWND, scale: f64) {
    let tokens = theme::tokens();
    unsafe {
        let title = GetDlgItem(dialog, DOC_DIALOG_TITLE_ID);
        if title != 0 {
            paint_win::set_text_color(title, paint_win::text_color(tokens, TextRole::Body));
            InvalidateRect(title, std::ptr::null(), 1);
        }
        let hint = GetDlgItem(dialog, DOC_DIALOG_HINT_ID);
        if hint != 0 {
            paint_win::set_text_color(hint, paint_win::text_color(tokens, TextRole::Hint));
            InvalidateRect(hint, std::ptr::null(), 1);
        }
        // 弹窗按钮全部自绘：圆角随 `radii.btn` 重贴 + 重绘。
        for id in [
            IDOK,
            IDCANCEL,
            DOC_DIALOG_REGENERATE_ID,
            DOC_DIALOG_TEST_ID,
            DOC_DIALOG_COPY_ID,
        ] {
            let button = GetDlgItem(dialog, id);
            if button != 0 {
                if is_themed_button(button) {
                    paint_win::install_button(
                        button,
                        scaled(tokens.radii.btn.round() as i32, scale),
                    );
                }
                InvalidateRect(button, std::ptr::null(), 1);
            }
        }
        let edit = GetDlgItem(dialog, DOC_DIALOG_EDIT_ID);
        if edit != 0 {
            InvalidateRect(edit, std::ptr::null(), 1);
        }
        InvalidateRect(dialog, std::ptr::null(), 1);
    }
}

/// 一个管理面板（标题 + 可选刷新 + 说明 + 错误/告警 + 行）；返回新的 y。
#[allow(clippy::too_many_arguments)]
fn build_panel(
    state: &mut SettingsState,
    panel: &ListPanel,
    refresh: Option<i32>,
    content_w: i32,
    mut y: i32,
    body: HFONT,
    small: HFONT,
    bold: HFONT,
) -> i32 {
    let title_w = if refresh.is_some() {
        content_w - 90
    } else {
        content_w
    };
    create_panel_control(
        state,
        "STATIC",
        panel.title,
        MARGIN,
        y,
        title_w.max(120),
        20,
        bold,
        13,
        Some(TextRole::Body),
        0,
        0,
    );
    let scale = dpi_scale(state.hwnd);
    if let Some(page) = refresh {
        let button = create_panel_control(
            state,
            "BUTTON",
            "刷新",
            MARGIN + content_w - PANEL_BTN_W,
            y - 2,
            PANEL_BTN_W,
            26,
            body,
            13,
            None,
            0,
            PANEL_REFRESH_ID_BASE + page,
        );
        style_button(SettingsButton::PanelRefresh, button, scale);
    }
    y += 24;
    create_panel_control(
        state,
        "STATIC",
        &panel.hint,
        MARGIN,
        y,
        content_w,
        32,
        small,
        11,
        Some(TextRole::Hint),
        0,
        0,
    );
    y += 34;
    // 错误与警告各取自己的 token（`danger` / `warn`，见 paint_win::text_color）。
    if let Some(error) = &panel.error {
        create_panel_control(
            state,
            "STATIC",
            error,
            MARGIN,
            y,
            content_w,
            32,
            small,
            11,
            Some(TextRole::Error),
            0,
            0,
        );
        y += 34;
    } else if let Some(warning) = &panel.warning {
        create_panel_control(
            state,
            "STATIC",
            warning,
            MARGIN,
            y,
            content_w,
            32,
            small,
            11,
            Some(TextRole::Warning),
            0,
            0,
        );
        y += 34;
    }
    if panel.error.is_none() && panel.rows.is_empty() {
        let text = if panel.loaded {
            "（没有条目）"
        } else {
            "读取中…"
        };
        create_panel_control(
            state,
            "STATIC",
            text,
            MARGIN,
            y,
            content_w,
            16,
            small,
            11,
            Some(TextRole::Hint),
            0,
            0,
        );
        y += 18;
    }
    for row in &panel.rows {
        // 逐行累加：`build_panel_row` 曾返回行高常量，`y =` 赋值把第 2 行起的
        // 所有行都叠到同一个 y（与 macOS 侧同款缺陷，2026-10-05 对称修复）。
        // 行高不 +30 时长副标题会压到下一行；档位收口在 `panel_row_advance`
        // （下拉行 subtitle 恒空 = 单行紧凑，不为下拉加高）。
        build_panel_row(state, panel.id, row, content_w, y, body, small);
        y += panel_row_advance(&row.subtitle);
    }
    y + SECTION_GAP
}

/// 行主控件的渲染形态（纯函数，可测）：下拉行出组合框；开关/查看/试听出按钮；
/// Edit/Delete 在次按钮位、只读行没有主控件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowMainKind {
    Pick,
    Button,
    None,
}

fn row_main_kind(action: RowAction) -> RowMainKind {
    match action {
        RowAction::Pick => RowMainKind::Pick,
        RowAction::Toggle | RowAction::Select | RowAction::Preview | RowAction::Credential => {
            RowMainKind::Button
        }
        RowAction::Edit | RowAction::Delete | RowAction::None => RowMainKind::None,
    }
}

/// 行主按钮文案（纯函数，可测）。`Pick` 行不渲染按钮（主控件是行内下拉），与
/// `row_main_kind` 的 `Pick` 分支互证 —— 下拉行不许落到空标题按钮上。
fn row_button_title(action: RowAction, enabled: bool) -> &'static str {
    match action {
        RowAction::Toggle => {
            if enabled {
                "已启用"
            } else {
                "已关闭"
            }
        }
        RowAction::Select => "查看",
        RowAction::Preview => "试听",
        // 凭据输入行：主按钮打开原生输入框（值写入应用自有存储）。
        RowAction::Credential => "设置",
        RowAction::Pick | RowAction::Edit | RowAction::Delete | RowAction::None => "",
    }
}

/// 行次按钮（`action2`）文案（纯函数，可测）：试听是音效事件行的次动作
/// （静音行不带 action2，不渲染）；其余未登记的次动作恒为空。
fn row_secondary_title(action: RowAction) -> &'static str {
    match action {
        RowAction::Edit => "编辑",
        RowAction::Delete => "删除",
        RowAction::Preview => "试听",
        _ => "",
    }
}

/// 行高推进（纯函数，可测；与 macOS `panel_rows_span` 的行高表同档）：副标题为空
/// = 单行紧凑行（行内下拉行同此，不为下拉加高）；有副标题 +30 容纳副标题框
/// （标题下 19 起、高 45、最多三行）。
fn panel_row_advance(subtitle: &str) -> i32 {
    if subtitle.trim().is_empty() {
        PANEL_ROW_H
    } else {
        PANEL_ROW_H + 30
    }
}

/// 行内下拉的选中项下标（纯函数，可测）：按 `value` 在选项表里找 `selected`；
/// 找不到回退**第一项**（共享层口径：平台只回退呈现，不回写、不自造选中值）。
fn pick_selected_index(pick: &RowPick) -> usize {
    pick.options
        .iter()
        .position(|option| option.value == pick.selected)
        .unwrap_or(0)
}

/// 行内下拉当前选中项的值（`CB_GETCURSEL` 下标 → 选项表；无选中/越界返回 None，
/// 不猜一个值写回）。
fn pick_selected_value(control: HWND, values: &[String]) -> Option<String> {
    if control == 0 {
        return None;
    }
    let index = unsafe { SendMessageW(control, CB_GETCURSEL, 0, 0) };
    if index < 0 {
        return None;
    }
    values.get(index as usize).cloned()
}

/// 下拉选中通知是否代表「用户确选了一件」（值写回的唯一判据）：
/// - `CBN_SELENDOK`：从展开列表里选中并收合（鼠标点位 / Enter）；
/// - `CBN_SELCHANGE` 且列表**未展开**：收起态键盘直接换档（这条路径不补发 SELENDOK）。
/// 展开中游走（SELCHANGE + 列表已展开）与 Esc 取消（SELENDCANCEL）都不写值 ——
/// 取消不留半截写入，游走不会被放大成一串后台写。
fn pick_change_is_final(control: HWND, code: u32) -> bool {
    if control == 0 {
        return false;
    }
    if code == CBN_SELENDOK {
        return true;
    }
    code == CBN_SELCHANGE && unsafe { SendMessageW(control, CB_GETDROPPEDSTATE, 0, 0) == 0 }
}

/// 一行：标题 + 副标题（最多三行，超出裁切）+ 主控件（按钮/行内下拉）+ 次按钮。
fn build_panel_row(
    state: &mut SettingsState,
    panel: &'static str,
    row: &PanelRow,
    content_w: i32,
    y: i32,
    body: HFONT,
    small: HFONT,
) {
    let has_secondary = row.secondary != RowAction::None;
    // 主控件宽度：下拉行按下拉档（`PANEL_PICK_W`），按钮行/无主控件行按按钮档。
    let main_kind = row_main_kind(row.action);
    let main_w = if main_kind == RowMainKind::Pick {
        PANEL_PICK_W
    } else {
        PANEL_BTN_W
    };
    let buttons_w = if has_secondary {
        main_w + PANEL_BTN_W + 4
    } else {
        main_w
    };
    let text_w = (content_w - buttons_w - 8).max(120);
    create_panel_control(
        state,
        "STATIC",
        &row.title,
        MARGIN,
        y + 1,
        text_w,
        18,
        body,
        13,
        Some(TextRole::Body),
        0,
        0,
    );
    if !row.subtitle.is_empty() {
        // 副标题最多三行（框高 45 = 3×行高；STATIC 自动换行，超高裁切）——
        // 与 macOS `build_panel_row` 的 `wrapped_label(..., 3)` 同规格。
        create_panel_control(
            state,
            "STATIC",
            &row.subtitle,
            MARGIN,
            y + 19,
            text_w,
            45,
            small,
            11,
            Some(TextRole::Hint),
            0,
            0,
        );
    }
    let scale = dpi_scale(state.hwnd);
    let mut button_x = MARGIN + content_w - main_w;
    if has_secondary {
        // 次动作在左、主动作在右（编辑/删除走专用入口与原生确认；试听播当前分配）。
        let secondary_title = row_secondary_title(row.secondary);
        let index = state.row_slots.len() as i32;
        button_x -= PANEL_BTN_W + 4;
        let secondary = create_panel_control(
            state,
            "BUTTON",
            secondary_title,
            button_x,
            y + 6,
            PANEL_BTN_W,
            26,
            body,
            13,
            None,
            0,
            ROW_ID_BASE + index,
        );
        style_button(SettingsButton::RowSecondary, secondary, scale);
        state.row_slots.push(WinRowSlot {
            panel,
            row_id: row.id.clone(),
            action: row.secondary,
            control: secondary,
            pick_values: Vec::new(),
        });
        button_x += PANEL_BTN_W + 4;
    }
    match main_kind {
        RowMainKind::Pick => build_panel_pick(state, panel, row, button_x, y, body, scale),
        RowMainKind::Button => {
            let button_title = row_button_title(row.action, row.enabled);
            // 空标题到这里是形态表与文案表失配（防御跳过，不建无字按钮）。
            if !button_title.is_empty() {
                let index = state.row_slots.len() as i32;
                let primary = create_panel_control(
                    state,
                    "BUTTON",
                    button_title,
                    button_x,
                    y + 6,
                    PANEL_BTN_W,
                    26,
                    body,
                    13,
                    None,
                    0,
                    ROW_ID_BASE + index,
                );
                style_button(SettingsButton::RowPrimary, primary, scale);
                state.row_slots.push(WinRowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    control: primary,
                    pick_values: Vec::new(),
                });
            }
        }
        RowMainKind::None => {}
    }
}

/// 行内下拉主控件（`RowAction::Pick`）：复用字段区下拉的自绘机制
/// （`CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED` + `WM_DRAWITEM`），条目文案 = 选项
/// label，字段区显示当前选中项（找不到回退第一项）；下拉箭头由系统绘制，
/// 不额外在文案里拼「▾」（否则列表条目也会带上箭头字形）。
///
/// 选中归宿：`on_command` 的 [`pick_change_is_final`] 分支按 `CB_GETCURSEL`
/// 下标从 [`WinRowSlot::pick_values`] 还原 `value` 后走 `pick_panel_row`。
fn build_panel_pick(
    state: &mut SettingsState,
    panel: &'static str,
    row: &PanelRow,
    x: i32,
    y: i32,
    font: HFONT,
    scale: f64,
) {
    let Some(pick) = &row.pick else {
        // 共享层已保证 pick 载荷与动作成对（不成对解析报错）；这里防御不建控件，
        // 不留一颗点不动的空下拉。
        rust_warn!("行 {} 是下拉动作但没有 pick 载荷（不渲染）", row.id);
        return;
    };
    let index = state.row_slots.len() as i32;
    let combo = create_panel_control(
        state,
        "COMBOBOX",
        "",
        x,
        y + 6,
        PANEL_PICK_W,
        26,
        font,
        13,
        None,
        WS_TABSTOP as u32 | CBS_DROPDOWNLIST as u32 | CBS_OWNERDRAWFIXED as u32,
        ROW_ID_BASE + index,
    );
    // 字段区与条目同高（与字段区下拉同创建口径，见样式处的注释）。
    unsafe {
        SendMessageW(
            combo,
            CB_SETITEMHEIGHT,
            -1isize as usize,
            scaled(26, scale) as isize,
        )
    };
    for option in &pick.options {
        unsafe {
            SendMessageW(
                combo,
                CB_ADDSTRING,
                0,
                wide(&option.label).as_ptr() as isize,
            )
        };
    }
    // 选中值不在选项表时回退第一项（只影响呈现；不写回、不改选中值）。
    let selected = pick_selected_index(pick);
    unsafe { SendMessageW(combo, CB_SETCURSEL, selected, 0) };
    state.row_slots.push(WinRowSlot {
        panel,
        row_id: row.id.clone(),
        action: row.action,
        control: combo,
        pick_values: pick
            .options
            .iter()
            .map(|option| option.value.clone())
            .collect(),
    });
}

/// 记忆详情区（四态：未选中 / 读取中 / 失败 / 就绪）；返回新的 y。
fn build_memory_detail(
    state: &mut SettingsState,
    content_w: i32,
    mut y: i32,
    body: HFONT,
    small: HFONT,
    bold: HFONT,
) -> i32 {
    match settings_ui().memory_detail_state() {
        MemoryDetailState::None => y,
        MemoryDetailState::Loading => {
            create_panel_control(
                state,
                "STATIC",
                "条目详情读取中…",
                MARGIN,
                y,
                content_w,
                16,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y + 18
        }
        MemoryDetailState::Error(error) => {
            // 读取失败是如实展示的错误诊断：取 `danger`。
            create_panel_control(
                state,
                "STATIC",
                &error,
                MARGIN,
                y,
                content_w,
                32,
                small,
                11,
                Some(TextRole::Error),
                0,
                0,
            );
            y + 34
        }
        MemoryDetailState::Ready(detail) => {
            create_panel_control(
                state,
                "STATIC",
                "条目详情与纠正",
                MARGIN,
                y,
                content_w,
                20,
                bold,
                13,
                Some(TextRole::Body),
                0,
                0,
            );
            y += 24;
            // 只读信息块（多行 EDIT + 只读）。
            let info = create_panel_control(
                state,
                "EDIT",
                &detail.info,
                MARGIN,
                y,
                content_w,
                DETAIL_INFO_H,
                small,
                11,
                None,
                ES_READONLY as u32 | WS_VSCROLL,
                -1,
            );
            let _ = info;
            y += DETAIL_INFO_H + 6;
            // 内容编辑框（纠正草稿）。
            let content = create_panel_control(
                state,
                "EDIT",
                &detail.content,
                MARGIN,
                y,
                content_w,
                DETAIL_EDIT_H,
                body,
                13,
                None,
                WS_VSCROLL,
                -2,
            );
            state.detail_content = content;
            y += DETAIL_EDIT_H + 6;
            // 动作按钮：保存纠正 / 核心画像标记 / 忘记这条。
            let pin_title = if detail.pinned {
                "移出核心画像"
            } else {
                "加入核心画像"
            };
            let mut x = MARGIN;
            let buttons: [(&str, i32, SettingsButton, i32); 3] = [
                (
                    "保存纠正",
                    DETAIL_ACTION_SAVE,
                    SettingsButton::SaveCorrection,
                    90,
                ),
                (pin_title, DETAIL_ACTION_PIN, SettingsButton::MemoryPin, 110),
                (
                    "忘记这条",
                    DETAIL_ACTION_FORGET,
                    SettingsButton::MemoryForget,
                    90,
                ),
            ];
            let scale = dpi_scale(state.hwnd);
            for (label_text, action, kind, w) in buttons {
                let button = create_panel_control(
                    state,
                    "BUTTON",
                    label_text,
                    x,
                    y,
                    w,
                    26,
                    body,
                    13,
                    None,
                    0,
                    DETAIL_ID_BASE + action,
                );
                style_button(kind, button, scale);
                x += w + 8;
            }
            y += 30;
            create_panel_control(
                state,
                "STATIC",
                "忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。",
                MARGIN,
                y,
                content_w,
                32,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y += 34;
            create_panel_control(
                state,
                "STATIC",
                "历史版本与来源审计",
                MARGIN,
                y,
                content_w,
                20,
                bold,
                13,
                Some(TextRole::Body),
                0,
                0,
            );
            y += 24;
            if detail.history.is_empty() {
                create_panel_control(
                    state,
                    "STATIC",
                    "没有可显示的历史版本。",
                    MARGIN,
                    y,
                    content_w,
                    16,
                    small,
                    11,
                    Some(TextRole::Hint),
                    0,
                    0,
                );
                y += 18;
            }
            for row in &detail.history {
                create_panel_control(
                    state,
                    "STATIC",
                    &row.title,
                    MARGIN,
                    y + 1,
                    content_w,
                    18,
                    body,
                    13,
                    Some(TextRole::Body),
                    0,
                    0,
                );
                if !row.subtitle.is_empty() {
                    create_panel_control(
                        state,
                        "STATIC",
                        &row.subtitle,
                        MARGIN,
                        y + 19,
                        content_w,
                        30,
                        small,
                        11,
                        Some(TextRole::Hint),
                        0,
                        0,
                    );
                }
                y += 52;
            }
            y + SECTION_GAP
        }
    }
}

/// 按滚动量摆放全部控件（含固定控件）。
fn layout(hwnd: HWND) {
    with_state(|state| {
        let scale = dpi_scale(hwnd);
        let (width, height) = client_size(hwnd);
        // 字段控件与管理面控件按内容坐标 - scroll 摆放。
        // 内容横坐标的唯一转换点：内容坐标以竖栏右缘为 0 点，这里统一加 RAIL_W。
        let base_y = scaled(CONTENT_TOP, scale);
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            let y = base_y + scaled(slot.y - state.scroll, scale);
            let w = scaled(slot.w, scale);
            unsafe {
                MoveWindow(
                    slot.hwnd,
                    scaled(slot.x + RAIL_W, scale),
                    y,
                    w,
                    scaled(slot.h, scale),
                    1,
                );
            }
        }
        // 固定控件：状态行在底部、两个按钮靠右、Tab 按钮只调宽度。
        if state.fixed.status != 0 {
            unsafe {
                MoveWindow(
                    state.fixed.status,
                    scaled(MARGIN, scale),
                    height - scaled(30, scale),
                    (width - scaled(220, scale)).max(60),
                    scaled(18, scale),
                    1,
                )
            };
        }
        unsafe {
            MoveWindow(
                state.fixed.refresh,
                width - scaled(196, scale),
                height - scaled(36, scale),
                scaled(80, scale),
                scaled(26, scale),
                1,
            );
            MoveWindow(
                state.fixed.save,
                width - scaled(100, scale),
                height - scaled(36, scale),
                scaled(80, scale),
                scaled(26, scale),
                1,
            );
        }
        // 左竖栏行按钮：竖排（顶距 9、行距 26+1），不随滚动位移。
        for (index, button) in state.fixed.tab_buttons.iter().enumerate() {
            unsafe {
                MoveWindow(
                    *button,
                    scaled(RAIL_PAD_X, scale),
                    scaled(
                        RAIL_TOP + index as i32 * (RAIL_ITEM_H + RAIL_ITEM_GAP),
                        scale,
                    ),
                    scaled(RAIL_W - RAIL_PAD_X * 2, scale),
                    scaled(RAIL_ITEM_H, scale),
                    1,
                )
            };
        }
        // 文档编辑弹窗（②）是独立顶层窗（模态），不参与内容区摆位；页面内容不被它顶长。
        // 通知浮层（①）：随窗口宽度重新居中；最后置顶 —— 它要浮在页面控件之上。
        if state.notice_overlay != 0 {
            let (width, _) = client_size(hwnd);
            let (x, y, w, h) = notice_overlay_geometry(state.notice_measured, width, scale);
            unsafe {
                MoveWindow(state.notice_overlay, x, y, w, h, 1);
                SetWindowPos(
                    state.notice_overlay,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    });
}

/// 揭示按钮点击 →（下一次写入 `EM_SETPASSWORDCHAR` 的字符, 按钮标题）。
///
/// `revealed` = 当前是否明文：明文态点击 = 复遮蔽（写回建控件时读到的遮蔽字符、
/// 标题回「显示」）；遮蔽态点击 = 明文（密码字符 0、标题「隐藏」）。
fn secret_toggle(revealed: bool, password_char: usize) -> (usize, &'static str) {
    if revealed {
        (password_char, "显示")
    } else {
        (0, "隐藏")
    }
}

/// 通用原生确认（危险动作共用；默认按钮落在「否」）。
fn confirm_dangerous(hwnd: HWND, title: &str, text: &str) -> bool {
    let response = unsafe {
        MessageBoxW(
            hwnd,
            wide(text).as_ptr(),
            wide(title).as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    };
    response == IDYES
}

/// 按动作键做危险动作确认；非危险键恒为 true（继续执行）。
fn confirm_dangerous_for_key(hwnd: HWND, key: &str) -> bool {
    match DANGEROUS_ACTIONS.iter().find(|(k, _, _)| *k == key) {
        Some((_, title, text)) => confirm_dangerous(hwnd, title, text),
        None => true,
    }
}

// ── 单行文本输入弹窗（「重命名 Profile」等入口共用）──
//
// Win32 没有现成的输入框 API（`MessageBoxW` 只能确认），这里自建一个小模态窗：
// 创建前禁用属主窗（等价 MessageBox 的应用内模态），自跑嵌套消息循环；
// Enter（默认按钮）/ Esc（IDCANCEL）由 `IsDialogMessageW` 归位到确定/取消。
// **未在 Windows 实机验证**（本机离线类型核对，见本文件头）。

/// 输入弹窗的窗口类名（与设置/编辑器等窗类互不干扰）。
const PROMPT_CLASS: &str = "DeskPetPrompt";
/// 输入框控件 id；确定/取消用系统约定 id（Enter/Esc 的归位目标）。
const PROMPT_EDIT_ID: i32 = 4001;
const PROMPT_OK_ID: i32 = 1;
const PROMPT_CANCEL_ID: i32 = 2;

/// 弹窗存活状态（挂在窗口 GWLP_USERDATA；循环退出后由调用方收回所有权）。
struct PromptState {
    edit: HWND,
    /// 确定/取消/关闭任一收尾路径置 true（消息循环的退出条件）。
    done: bool,
    /// 确定为 Some（可为空串，合法性由调用方判定）；取消/关闭保持 None。
    text: Option<String>,
}

/// 输入弹窗窗口过程：确定读值、取消/关闭收尾，都在销毁前落进 [`PromptState`]。
unsafe extern "system" fn prompt_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            if code == BN_CLICKED && (id == PROMPT_OK_ID || id == PROMPT_CANCEL_ID) {
                unsafe {
                    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if !state.is_null() {
                        if id == PROMPT_OK_ID {
                            let len = GetWindowTextLengthW((*state).edit).max(0) as usize;
                            let mut buf = vec![0u16; len + 1];
                            GetWindowTextW((*state).edit, buf.as_mut_ptr(), buf.len() as i32);
                            (*state).text = Some(String::from_utf16_lossy(&buf[..len]));
                        }
                        (*state).done = true;
                    }
                    DestroyWindow(hwnd);
                }
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                if !state.is_null() {
                    // 关闭 = 取消（text 保持 None）。
                    (*state).done = true;
                }
                DestroyWindow(hwnd);
            }
            0
        }
        // 主题配色（与设置窗/文档弹窗同源）：窗底、标签、按钮、可编辑框。
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => on_ctlcolor(wparam, lparam),
        WM_CTLCOLOREDIT => edit_ctlcolor(wparam, lparam),
        WM_ERASEBKGND => {
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top),
                &theme::tokens().field_bg,
            );
            1
        }
        WM_PAINT => {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                paint_win::fill_rect(
                    hdc,
                    paint_win::Rect::new(
                        0,
                        0,
                        client.right - client.left,
                        client.bottom - client.top,
                    ),
                    &theme::tokens().field_bg,
                );
                EndPaint(hwnd, &ps);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 单行文本输入弹窗（模态；取消返回 None）。空串是合法输入（清空语义由调用方判定）。
pub(crate) fn prompt_text(
    title: &str,
    label: &str,
    initial: &str,
) -> crate::error::AppResult<Option<String>> {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide(PROMPT_CLASS);
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(prompt_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&wc);

        let owner = GetForegroundWindow();
        let scale = if owner == 0 { 1.0 } else { dpi_scale(owner) };
        let w = scaled(360, scale);
        let h = scaled(190, scale);
        // 居中于属主窗；取不到属主时交给系统默认位置。
        let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
        if owner != 0 {
            let mut rect = std::mem::zeroed();
            if GetWindowRect(owner, &mut rect) != 0 {
                x = rect.left + ((rect.right - rect.left) - w) / 2;
                y = rect.top + ((rect.bottom - rect.top) - h) / 2;
            }
        }
        let hwnd = CreateWindowExW(
            WS_EX_DLGMODALFRAME,
            class_name.as_ptr(),
            wide(title).as_ptr(),
            WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
            x,
            y,
            w,
            h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        );
        if hwnd == 0 {
            return Err(crate::error::AppError::Other("输入弹窗创建失败".into()));
        }

        let font = make_font(scale, 13, false);
        let label_w = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(label).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            scaled(18, scale),
            scaled(16, scale),
            w - scaled(36, scale),
            scaled(20, scale),
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(label_w, WM_SETFONT, font as WPARAM, 1);
        let edit = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            wide("EDIT").as_ptr(),
            wide(initial).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (ES_AUTOHSCROLL as u32),
            scaled(18, scale),
            scaled(44, scale),
            w - scaled(36, scale),
            scaled(24, scale),
            hwnd,
            PROMPT_EDIT_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(edit, WM_SETFONT, font as WPARAM, 1);
        let btn_w = scaled(84, scale);
        let btn_h = scaled(26, scale);
        let ok = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("确定").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (BS_DEFPUSHBUTTON as u32),
            w - scaled(28, scale) - btn_w * 2,
            h - scaled(52, scale),
            btn_w,
            btn_h,
            hwnd,
            PROMPT_OK_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(ok, WM_SETFONT, font as WPARAM, 1);
        let cancel = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("取消").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            w - scaled(18, scale) - btn_w,
            h - scaled(52, scale),
            btn_w,
            btn_h,
            hwnd,
            PROMPT_CANCEL_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(cancel, WM_SETFONT, font as WPARAM, 1);
        // 全面自绘：确定是弹窗的提交动作（主按钮面）、取消是普通面。
        make_themed_button(ok, ButtonRole::Primary, scale, theme::tokens().radii.btn);
        make_themed_button(cancel, ButtonRole::Normal, scale, theme::tokens().radii.btn);

        // 状态挂在窗口上；wndproc 读写它，循环退出后本函数收回所有权。
        let state = Box::into_raw(Box::new(PromptState {
            edit,
            done: false,
            text: None,
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);

        if owner != 0 {
            EnableWindow(owner, 0);
        }
        SetForegroundWindow(hwnd);
        SetFocus(edit);
        // 预填值全选：打开即可直接键入替换。
        SendMessageW(edit, EM_SETSEL, 0, -1);

        // 嵌套消息循环（模态）：直到 wndproc 置 done（窗口已销毁）或进程退出消息。
        let mut msg: MSG = std::mem::zeroed();
        while !(*state).done {
            let ret = GetMessageW(&mut msg, 0, 0, 0);
            if ret <= 0 {
                // 0 = WM_QUIT：转交外层循环，不吞在弹窗里。
                if ret == 0 {
                    PostQuitMessage(msg.wParam as i32);
                }
                break;
            }
            if IsDialogMessageW(hwnd, &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if !(*state).done {
            // 非确定/取消路径退出（WM_QUIT）：补一次销毁再收回状态。
            (*state).done = true;
            DestroyWindow(hwnd);
        }
        let state = Box::from_raw(state);
        if owner != 0 {
            EnableWindow(owner, 1);
        }
        Ok(state.text)
    }
}

/// WM_COMMAND：Tab 切换 / 字段动作 / 保存 / 刷新。
pub(crate) fn on_command(hwnd: HWND, wparam: WPARAM) -> bool {
    let id = (wparam & 0xFFFF) as i32;
    let code = ((wparam >> 16) & 0xFFFF) as u32;
    match id {
        SAVE_ID => {
            if let Err(error) = harvest_and_save() {
                settings_ui().set_notice(Some(format!("有字段未通过校验，未保存：{error}")));
            }
            refresh_ui();
            return true;
        }
        REFRESH_ID => {
            settings_ui().reload();
            refresh_ui();
            return true;
        }
        STATUS_ID => return false,
        _ if (TAB_BASE..TAB_BASE + 16).contains(&id) => {
            // 竖栏按钮 id = TAB_BASE + 下标；下标校验走两平台共用口。
            let Some(tab) = tab_index_for_tag((id - TAB_BASE) as isize) else {
                rust_warn!("竖栏按钮的 id 不映射任何 Tab（id={id}）");
                return true;
            };
            // 借 STATE 的操作必须逐段进行（`with_state` 不能再嵌套在另一个借用里）。
            let changed = with_state(|state| {
                if state.tab != tab {
                    state.tab = tab;
                    state.scroll = 0;
                    true
                } else {
                    false
                }
            });
            if changed.unwrap_or(false) {
                rebuild_tab();
                with_state(|state| layout(state.hwnd));
                refresh_ui();
            }
            if TABS[tab].id == "general" {
                // 坐标等字段由宿主拖动写回：进入通用页时静默重拉一次（不提示）。
                settings_ui().refresh_silently();
            }
            if TABS[tab].id == "appearance" {
                settings_ui().ensure_font_families();
                settings_ui().ensure_profiles();
                settings_ui().ensure_sound_panel();
            }
            if TABS[tab].id == "ai" {
                settings_ui().ensure_cards();
            }
            // 工具 / 记忆 Tab 的管理面首次进入时拉取（各自在途去重）。
            if TABS[tab].id == "tools" {
                settings_ui().ensure_tools_panels();
            }
            if TABS[tab].id == "memory" {
                settings_ui().ensure_memory();
            }
            return true;
        }
        // ── 管理面（W9d）：页面刷新 / 记忆详情动作 / 行动作 ──
        _ if (PANEL_REFRESH_ID_BASE..PANEL_REFRESH_ID_BASE + 16).contains(&id) => {
            match id - PANEL_REFRESH_ID_BASE {
                REFRESH_TOOLS => settings_ui().refresh_tools_panels(),
                REFRESH_MEMORY => settings_ui().refresh_memory(),
                REFRESH_SOUNDS => settings_ui().refresh_sound_panel(),
                _ => rust_warn!("管理面刷新没有对应页面（id={id}）"),
            }
            refresh_ui();
            return true;
        }
        _ if (DETAIL_ID_BASE..DETAIL_ID_BASE + 16).contains(&id) => {
            match id - DETAIL_ID_BASE {
                DETAIL_ACTION_SAVE => {
                    let text = with_state(|state| {
                        if state.detail_content != 0 {
                            Some(window_text(state.detail_content))
                        } else {
                            None
                        }
                    })
                    .flatten();
                    if let Some(text) = text {
                        if let Err(error) = settings_ui().memory_save_correction(&text) {
                            settings_ui().set_notice(Some(format!("纠正未提交：{error}")));
                        }
                    }
                }
                DETAIL_ACTION_PIN => {
                    if let Err(error) = settings_ui().memory_toggle_pinned() {
                        settings_ui().set_notice(Some(format!("核心画像标记未提交：{error}")));
                    }
                }
                DETAIL_ACTION_FORGET => {
                    // 危险操作：原生确认（与编辑器未保存确认同款 MessageBoxW；不依赖通用 dialog 服务）。
                    let response = unsafe {
                        MessageBoxW(
                            hwnd,
                            wide("遗忘只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份不受影响。\n确认忘记这条记忆？").as_ptr(),
                            wide("忘记这条记忆").as_ptr(),
                            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
                        )
                    };
                    if response == IDYES {
                        if let Err(error) = settings_ui().memory_forget() {
                            settings_ui().set_notice(Some(format!("遗忘未提交：{error}")));
                        }
                    } else {
                        rust_debug!("遗忘确认被用户取消（response={response}）");
                    }
                }
                _ => rust_warn!("记忆详情动作没有对应按钮（id={id}）"),
            }
            refresh_ui();
            return true;
        }
        _ if (ROW_ID_BASE..ROW_ID_BASE + 4096).contains(&id) => {
            let info = with_state(|state| {
                state
                    .row_slots
                    .get((id - ROW_ID_BASE) as usize)
                    .map(|slot| {
                        (
                            slot.row_id.clone(),
                            slot.panel,
                            slot.action,
                            slot.control,
                            slot.pick_values.clone(),
                        )
                    })
            })
            .flatten();
            if let Some((row_id, panel, action, control, pick_values)) = info {
                // 行内下拉的中间通知（展开 / 展开中游走 / 取消，判据见
                // `pick_change_is_final`）不写值，也不重排页面 —— 尾部的 `refresh_ui`
                // 会经 `layout` 对展开中的下拉重发 MoveWindow，可能打断展开与键盘游走。
                // 只有「确选」的那一次走到下面的写回。
                if action == RowAction::Pick && !pick_change_is_final(control, code) {
                    return true;
                }
                let outcome = match action {
                    RowAction::Toggle => settings_ui().toggle_panel_row(panel, &row_id),
                    RowAction::Select => {
                        settings_ui().open_memory_item(&row_id);
                        Ok(())
                    }
                    // 次动作按钮（MCP「编辑」、Skill「删除」）走本批的专用入口；
                    // 删除前先做原生确认。
                    RowAction::Delete
                        if confirm_dangerous(hwnd, "行删除", "删除该条目？此操作不可撤销。") =>
                    {
                        settings_ui().panel_secondary_action(panel, &row_id, action)
                    }
                    RowAction::Delete => {
                        rust_debug!("行删除确认被用户取消");
                        Ok(())
                    }
                    RowAction::Edit => settings_ui().panel_secondary_action(panel, &row_id, action),
                    // 试听是音效事件行的次按钮（action2）：行 id = 事件键，当前分配由
                    // 共享层从行快照的 `pick.selected` 取（平台不解析行数据；不改配置）。
                    RowAction::Preview => settings_ui().preview_panel_row(panel, &row_id),
                    // 凭据输入行（MCP 面板的「GitHub 令牌」）：弹原生输入框取值后定向写存储。
                    RowAction::Credential => settings_ui().prompt_panel_credential(panel, &row_id),
                    // 行内下拉（音效事件行）：按下标从选项值表还原 `value` 写回
                    // （`action == Pick` 且已过「确选」判据才会到这里）。
                    RowAction::Pick => match pick_selected_value(control, &pick_values) {
                        Some(value) => settings_ui().pick_panel_row(panel, &row_id, &value),
                        None => {
                            rust_debug!("行内下拉没有可还原的选中值（未写值；id={id}）");
                            Ok(())
                        }
                    },
                    RowAction::None => Ok(()),
                };
                if let Err(error) = outcome {
                    settings_ui().set_notice(Some(format!("操作未执行：{error}")));
                }
            } else {
                rust_warn!("管理面行动作没有对应槽（id={id}）");
            }
            refresh_ui();
            return true;
        }
        // ── 密钥揭示（编辑框 + 按钮双控件组）──
        _ if (SECRET_ID_BASE..SECRET_ID_BASE + 16).contains(&id) => {
            let index = (id - SECRET_ID_BASE) as usize;
            with_state(|state| {
                let Some(pair) = state.secret_pairs.get_mut(index) else {
                    rust_warn!("密钥揭示按钮没有对应控件组（id={id}）");
                    return;
                };
                // 明文 ⇄ 遮蔽：EM_SETPASSWORDCHAR 传 0 = 显示原文；传建控件时读回的
                // 遮蔽字符 = 恢复圆点。切回遮蔽后必须重绘（字符位置会重排）。
                let (password_char, title) = secret_toggle(pair.revealed, pair.password_char);
                pair.revealed = !pair.revealed;
                unsafe {
                    SendMessageW(pair.edit, EM_SETPASSWORDCHAR, password_char, 0);
                    InvalidateRect(pair.edit, std::ptr::null(), 1);
                    SetWindowTextW(pair.button, wide(title).as_ptr());
                    // ownerdraw 按钮的标题变了要显式失效（自绘读 `window_text`）。
                    InvalidateRect(pair.button, std::ptr::null(), 1);
                }
            });
            return true;
        }
        // 行编辑文档的动作不走设置窗：它们由文档编辑弹窗自己的窗口过程处理（②），
        // 不经过这里。
        _ if id >= FIELD_BASE => {
            let index = (id - FIELD_BASE) as usize;
            let slot_info = with_state(|state| {
                state
                    .slots
                    .get(index)
                    .map(|slot| (slot.hwnd, slot.key, slot.kind))
            })
            .flatten();
            let Some((control, key, kind)) = slot_info else {
                return false;
            };
            if let (Some(key), Some(kind)) = (key, kind) {
                if kind.is_action() {
                    // 依赖控件值的动作先采全表（输入框里的编辑也要进草稿）。
                    // 只剩「重启」——「预览尺寸」动作已随窗口尺寸那批设置项撤下
                    // （2026-10-05，schema 与共享层同批；见测试 `撤下的设置键不再出现在生产码里`）。
                    if matches!(key, "action.restart") {
                        if let Err(error) = harvest_controls() {
                            settings_ui()
                                .set_notice(Some(format!("有字段未通过校验，动作未执行：{error}")));
                            return true;
                        }
                    }
                    // 危险动作（删除/覆盖类）先走原生确认；取消 = 动作未执行。
                    if !confirm_dangerous_for_key(hwnd, key) {
                        return true;
                    }
                    if let Err(error) = settings_ui().run_action(key) {
                        settings_ui().set_notice(Some(format!("动作未执行：{error}")));
                    }
                    return true;
                }
                if matches!(kind, FieldKind::Shortcut) {
                    // 点击进入录制：模态轮询捕获真实按键（值不从控件读）。
                    capture_shortcut(hwnd);
                    refresh_ui();
                    return true;
                }
                if matches!(kind, FieldKind::Bool) {
                    // 自绘开关：点击（BN_CLICKED）与空格键都到此。先翻转镜像再提交；
                    // 提交失败回滚镜像 —— 视觉留在原态（成功则经 refresh 回写同一值）。
                    let next =
                        SWITCH_STATES.with(|states| states.borrow_mut().toggle(control as isize));
                    if let Err(error) = settings_ui().set_value(key, SettingsValue::Bool(next)) {
                        SWITCH_STATES
                            .with(|states| states.borrow_mut().set(control as isize, !next));
                        settings_ui().set_notice(Some(format!("输入无效：{error}")));
                    }
                    return true;
                }
                if let FieldKind::NumberChoice { options } = kind {
                    // 点击某一段即选中并置脏（与「编辑即置脏」同口径）：`BN_CLICKED`
                    // 不带坐标，用点击时的光标位置命中段；命中不了（落在段间间隙 / 界外 /
                    // 取不到光标）就什么都不做 —— 绝不猜一个档写下去。
                    let index = number_choice_activation(
                        number_choice_clicked_index(control),
                        NUMBER_CHOICES.with(|states| {
                            states
                                .borrow()
                                .get(&(control as isize))
                                .and_then(|state| state.selected)
                        }),
                        options.len(),
                    );
                    match index.and_then(|index| options.get(index)) {
                        Some((_, number)) => {
                            if let Err(error) =
                                settings_ui().set_value(key, SettingsValue::Number(*number))
                            {
                                settings_ui().set_notice(Some(format!("输入无效：{error}")));
                            }
                        }
                        None => rust_debug!("档位段激活没有对应档位（未写值）"),
                    }
                    return true;
                }
                // 编辑框：EN_CHANGE（编辑即置脏 —— 底部「保存」随即可用）；失焦
                // （EN_KILLFOCUS）是校验与显示收口时机（见 [`commit_edit_value`]）。
                // 下拉（CBN_SELCHANGE）走下面的即时提交兜底。
                let is_edit = matches!(
                    kind,
                    FieldKind::Number { .. } | FieldKind::Text { .. } | FieldKind::Multiline
                );
                if is_edit {
                    if code == EN_CHANGE {
                        commit_edit_value(control, kind, key, false);
                    } else if code == EN_KILLFOCUS {
                        commit_edit_value(control, kind, key, true);
                    }
                    return true;
                }
                if let Some(value) = read_control(control, kind) {
                    if let Err(error) = settings_ui().set_value(key, value) {
                        settings_ui().set_notice(Some(format!("输入无效：{error}")));
                    }
                }
            }
            return true;
        }
        _ => {}
    }
    let _ = hwnd;
    false
}

/// WM_VSCROLL：设置窗自身的垂直滚动（内容控件整体位移）。
pub(crate) fn on_vscroll(hwnd: HWND, wparam: WPARAM) {
    let code = (wparam & 0xFFFF) as i32;
    with_state(|state| {
        let scale = dpi_scale(hwnd);
        let (_, height) = client_size(hwnd);
        let view_h = (height - scaled(CONTENT_TOP, scale) - scaled(BOTTOM_H, scale)).max(40);
        let view_h_logical = (f64::from(view_h) / scale).round() as i32;
        let max_scroll = (state.content_height - view_h_logical).max(0);
        state.scroll = match code {
            SB_LINEUP => (state.scroll - SCROLL_STEP).max(0),
            SB_LINEDOWN => (state.scroll + SCROLL_STEP).min(max_scroll),
            SB_PAGEUP => (state.scroll - view_h_logical).max(0),
            SB_PAGEDOWN => (state.scroll + view_h_logical).min(max_scroll),
            _ => state.scroll,
        };
    });
    layout(hwnd);
}

/// WM_SIZE：重排。
pub(crate) fn on_size(hwnd: HWND) {
    layout(hwnd);
}

/// WM_DESTROY：释放字体与状态（窗口关闭即销毁资源）。
pub(crate) fn on_destroy() {
    // 句柄会被系统复用：窗口销毁即清空开关 / 档位段镜像，下次开窗不留陈旧项。
    SWITCH_STATES.with(|states| states.borrow_mut().clear());
    NUMBER_CHOICES.with(|states| states.borrow_mut().clear());
    STATE.with(|cell| {
        if let Some(state) = cell.borrow_mut().take() {
            for font in state.fonts {
                if font != 0 {
                    unsafe { DeleteObject(font) };
                }
            }
        }
    });
    settings_ui().note_window_closed();
    rust_info!("设置窗已关闭：控件与字体释放、草稿丢弃");
}

// ==========================================
// 通知分档呈现（①）：Error → 模态，Info/Warning → 顶部浮层
// ==========================================
//
// 手段选择与 z 序/焦点处理见文件头「通知分档」。这里只强调两条硬约束：
// - **判新只认 `notice_generation`**（不比较文本）：同一句话连报两次时文本相等；
// - 浮层的自动消失用 `SetTimer` + `TIMERPROC` 回调（不依赖设置窗过程函数转发
//   `WM_TIMER`），绘制/计时路径**不读设置窗 STATE**（绘制可能在任意借用之外到达）。

thread_local! {
    /// 浮层当前字体。自建窗口类不承担系统控件的 `WM_SETFONT` 存储语义
    /// （`DefWindowProc` 对非控件窗口不保证 `WM_SETFONT`/`WM_GETFONT` 往返），
    /// 自己记一份；与 `SWITCH_STATES` 独立于 `STATE` 的理由相同 ——
    /// 绘制路径不碰设置窗状态。
    static NOTICE_FONT: Cell<HFONT> = const { Cell::new(0) };
}

/// 浮层字体（0 = 未设置，绘制/量尺寸按系统默认字体兜底）。
fn notice_font() -> HFONT {
    NOTICE_FONT.with(Cell::get)
}

/// 一条新通知的呈现通道（纯函数结果；与 macOS `NoticeAction` 同表）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeAction {
    /// 已呈现过（同一代际）—— 不重复呈现。
    None,
    /// Info / Warning：顶部居中浮层，几秒自动消失。
    Toast,
    /// Error：模态弹窗，必须确认。
    Modal,
}

/// 按档位与代际决定怎么呈现（纯函数，可测；与 macOS `notice_action` 同判据）。
///
/// 判据只用**代际**：同一句话连报两次时文本相等，文本比较会把第二条当旧条吞掉。
fn notice_action(level: NoticeLevel, generation: u64, shown_generation: u64) -> NoticeAction {
    if generation == shown_generation {
        return NoticeAction::None;
    }
    match level {
        NoticeLevel::Error => NoticeAction::Modal,
        NoticeLevel::Info | NoticeLevel::Warning => NoticeAction::Toast,
    }
}

/// 浮层档位写进窗口 `GWLP_USERDATA` 的编码（自建窗口类，无其它占用约定）。
fn notice_level_code(level: NoticeLevel) -> isize {
    match level {
        NoticeLevel::Info => 1,
        NoticeLevel::Warning => 2,
        NoticeLevel::Error => 3,
    }
}

/// 编码 → 档位（未知值收拢 `Info`；槽位只有本文件写）。
fn notice_level_from_code(code: isize) -> NoticeLevel {
    match code {
        2 => NoticeLevel::Warning,
        3 => NoticeLevel::Error,
        _ => NoticeLevel::Info,
    }
}

/// 浮层几何（纯函数，物理像素输入输出；`scale` = 窗口 DPI 缩放）。
///
/// 宽度 = 文本量得宽 + 2×内边距（上下限：`NOTICE_MIN_W` .. 客户区宽 − 2×MARGIN），
/// 高度 = 文本高 + 2×内边距；水平居中于窗口客户区、纵向贴 `NOTICE_TOP`
/// （居中口径与最小宽度与 macOS `show_toast` 同值）。返回 (x, y, w, h)。
fn notice_overlay_geometry(
    measured: (i32, i32),
    client_w: i32,
    scale: f64,
) -> (i32, i32, i32, i32) {
    let (text_w, text_h) = measured;
    let margin = scaled(MARGIN, scale);
    let pad_x = scaled(NOTICE_PAD_X, scale);
    let pad_y = scaled(NOTICE_PAD_Y, scale);
    let max_w = (client_w - margin * 2).max(scaled(60, scale));
    let w = (text_w + pad_x * 2)
        .max(scaled(NOTICE_MIN_W, scale))
        .min(max_w);
    let h = text_h + pad_y * 2;
    let x = ((client_w - w) / 2).max(0);
    let y = scaled(NOTICE_TOP, scale);
    (x, y, w, h)
}

/// 通知分档呈现（`refresh_ui` 的最后一环；必须在 `with_state` 借用之外调用）。
fn present_notice(view: &SettingsView) {
    let Some(text) = view.notice.as_deref().filter(|text| !text.is_empty()) else {
        // 清空通知不呈现（`SettingsUi::set_notice_with` 只在非空时推进代际）。
        return;
    };
    let action = with_state(|state| {
        notice_action(
            view.notice_level,
            view.notice_generation,
            state.presented_generation,
        )
    });
    match action {
        Some(NoticeAction::None) => {}
        Some(NoticeAction::Modal) => {
            let modal_up = with_state(|state| state.notice_modal_up).unwrap_or(true);
            if modal_up {
                // 已有模态（错误弹窗 / 文档弹窗）在显：不抢弹、代际不记账 ——
                // 收尾后的下一次刷新补呈现（与 macOS 同规）。
                return;
            }
            let Some(settings_hwnd) = with_state(|state| state.hwnd) else {
                return;
            };
            with_state(|state| state.presented_generation = view.notice_generation);
            with_state(|state| state.notice_modal_up = true);
            show_error_modal(settings_hwnd, text);
            with_state(|state| state.notice_modal_up = false);
        }
        Some(NoticeAction::Toast) => {
            with_state(|state| {
                state.presented_generation = view.notice_generation;
                show_notice_overlay(state, text, view.notice_level);
            });
        }
        None => {} // 设置窗未开：本次不呈现（重开时按当时通知重新判新）
    }
}

/// 错误档模态：`MessageBoxW`（属主 = 设置窗；模态期属主禁用 = 应用内模态，必须确认）。
///
/// 返回值不参与决策：只有「确定」一个按钮。设置窗是 `WS_EX_TOPMOST` 的层级窗，
/// 系统把以它为属主的对话框提升到属主之上（与编辑器关闭确认同口径）。
/// 标题与 macOS `present_error_modal` 同文案；按钮文案是系统「确定」（macOS 为「知道了」），
/// 系统对话框给不了自定义按钮文案，就地登记。
fn show_error_modal(settings_hwnd: HWND, text: &str) {
    unsafe {
        MessageBoxW(
            settings_hwnd,
            wide(text).as_ptr(),
            wide("设置操作未完成").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// 显示/替换顶部浮层（Info/Warning）：懒创建 → 写入文本与档位 → 量尺寸摆位 → 重开计时。
///
/// 新的一条必须**重新计时**：先撤旧计时器再设新的（代际判新已经保证「同文重申」
/// 会走到这里，计时不能靠文本变化）。
fn show_notice_overlay(state: &mut SettingsState, text: &str, level: NoticeLevel) {
    if state.notice_overlay == 0 {
        match create_notice_overlay(state) {
            Some(overlay) => {
                state.notice_overlay = overlay;
                // 成功即解除降级（曾失败过也不让状态行继续兜底显示通知）。
                state.notice_overlay_failed = false;
            }
            None => {
                // 降级：浮层建不出来时通知回落到状态行（留痕在 create_notice_overlay）。
                state.notice_overlay_failed = true;
                return;
            }
        }
    }
    let overlay = state.notice_overlay;
    let scale = dpi_scale(state.hwnd);
    unsafe {
        SetWindowTextW(overlay, wide(text).as_ptr());
        SetWindowLongPtrW(overlay, GWLP_USERDATA, notice_level_code(level));
        KillTimer(overlay, NOTICE_TIMER_ID);
        let (client_w, _) = client_size(state.hwnd);
        let max_text_w = scaled(NOTICE_MAX_TEXT_W, scale);
        let measured = measure_notice_text(text, max_text_w);
        state.notice_measured = measured;
        let (x, y, w, h) = notice_overlay_geometry(measured, client_w, scale);
        MoveWindow(overlay, x, y, w, h, 1);
        refresh_notice_region(overlay, scale);
        // 子窗口显示不抢焦点；置顶（HWND_TOP）保证在兄弟控件之上。
        ShowWindow(overlay, SW_SHOWNA);
        SetWindowPos(
            overlay,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        InvalidateRect(overlay, std::ptr::null(), 1);
        SetTimer(
            overlay,
            NOTICE_TIMER_ID,
            NOTICE_TOAST_MS,
            Some(notice_timer_proc),
        );
    }
}

/// 懒创建浮层（设置窗的子窗口；失败返回 None 并在统一日志留痕）。
fn create_notice_overlay(state: &mut SettingsState) -> Option<HWND> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(NOTICE_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(notice_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出（与输入弹窗同规）。
    unsafe { RegisterClassW(&wc) };
    let overlay = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("").as_ptr(),
            // 初始隐藏（WS_VISIBLE 由 ShowWindow 加上）；WS_CLIPSIBLINGS 让更下层
            // 兄弟控件不画进浮层区域（见安装处的样式说明）。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            state.hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if overlay == 0 {
        rust_warn!("通知浮层创建失败，通知回落到状态行显示");
        return None;
    }
    // 浮层用设置窗的说明字号（与状态行同档；字体变化由 `apply_font` 重发）。
    let font = *state.fonts.get(1).unwrap_or(&0);
    if font != 0 {
        unsafe { SendMessageW(overlay, WM_SETFONT, font as WPARAM, 1) };
    }
    Some(overlay)
}

/// 量浮层文本（`DT_CALCRECT` + `DT_WORDBREAK`）：浮层字体下按最大宽度折行后的实际尺寸。
fn measure_notice_text(text: &str, max_w: i32) -> (i32, i32) {
    unsafe {
        let hdc = CreateCompatibleDC(0);
        if hdc == 0 {
            // 量不到时给一个保守的单行尺寸（几何函数的上下限会收口）。
            return (max_w.min(160), 18);
        }
        let font = notice_font();
        let old = if font != 0 {
            SelectObject(hdc, font)
        } else {
            0
        };
        let mut rect: RECT = std::mem::zeroed();
        rect.right = max_w.max(1);
        DrawTextW(
            hdc,
            wide(text).as_ptr(),
            -1,
            &mut rect,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
        );
        if old != 0 {
            SelectObject(hdc, old);
        }
        DeleteDC(hdc);
        (
            (rect.right - rect.left).max(1),
            (rect.bottom - rect.top).max(1),
        )
    }
}

/// 浮层圆角区域（半径随主题 `radii.btn`；`SetWindowRgn` 成功后区域归系统所有）。
fn apply_notice_region(overlay: HWND, w: i32, h: i32, scale: f64) {
    if overlay == 0 || w <= 0 || h <= 0 {
        return;
    }
    let radius = scaled(theme::tokens().radii.btn.round() as i32, scale).max(0);
    let region = unsafe { CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2) };
    if region == 0 {
        rust_warn!("通知浮层的圆角区域创建失败（本次显示为直角）");
        return;
    }
    if unsafe { SetWindowRgn(overlay, region, 1) } == 0 {
        // 失败时区域仍归调用方，必须自行释放（成功时系统接管）。
        unsafe { DeleteObject(region) };
        rust_warn!("通知浮层的圆角区域设置失败（本次显示为直角）");
    }
}

/// 按浮层当前客户区重贴圆角区域（换主题半径变化与尺寸变化共用）。
fn refresh_notice_region(overlay: HWND, scale: f64) {
    if overlay == 0 {
        return;
    }
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(overlay, &mut client) };
    apply_notice_region(
        overlay,
        client.right - client.left,
        client.bottom - client.top,
        scale,
    );
}

/// 浮层自动消失（`SetTimer` 的回调形式；不读 STATE、不依赖消息转发）。
unsafe extern "system" fn notice_timer_proc(hwnd: HWND, _msg: u32, id: usize, _time: u32) {
    if hwnd == 0 || id != NOTICE_TIMER_ID {
        return;
    }
    unsafe {
        KillTimer(hwnd, NOTICE_TIMER_ID);
        ShowWindow(hwnd, SW_HIDE);
    }
}

/// 浮层窗口过程：自绘主题面 + 语义字色；空操作消息按默认处理。
unsafe extern "system" fn notice_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                // 文本/档位存在窗口自身（不进设置窗 STATE）：绘制可能在任何借用之外
                // 到达，读 STATE 会有 RefCell 重入风险（AGENTS §9）。
                let text = window_text(hwnd);
                let level = notice_level_from_code(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
                paint_notice_overlay(hwnd, hdc, &text, level);
                EndPaint(hwnd, &ps);
            }
            0
        }
        // 浮层不打断操作：点击穿透到下面的兄弟控件（子窗口的命中测试由系统下发到这里）。
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_ERASEBKGND => 1,
        // 自建窗口类自己记字体（见 `NOTICE_FONT`）；文本仍走 `WM_SETTEXT`/`WM_GETTEXT`
        // （那一对是窗口通用语义，DefWindowProc 负责）。
        WM_SETFONT => {
            NOTICE_FONT.with(|font| font.set(wparam as HFONT));
            0
        }
        WM_GETFONT => notice_font() as LRESULT,
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 浮层绘制：`panel_bg` 做底 + 1px `bar_edge` 描边（在 `field_bg` 页底上明显分层；
/// 面与描边与 macOS `show_toast` 同源），文字 Info 取 `ink`、Warning 取 `warn`
/// （需求口径；与 macOS `toast_ink` 同表）。读 tokens 现值 —— 换主题后由
/// `apply_theme` 触发重绘，不留旧主题色。
fn paint_notice_overlay(hwnd: HWND, hdc: HDC, text: &str, level: NoticeLevel) {
    let tokens = theme::tokens();
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut client) };
    let rect = paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top);
    if rect.is_empty() {
        return;
    }
    paint_win::fill_rect(hdc, rect, &tokens.panel_bg);
    paint_win::draw_frame(hdc, rect, tokens.bar_edge, &theme::Bevel::NONE);
    let ink = match level {
        // Error 不走浮层（模态档）；防御性归到主文字色。
        NoticeLevel::Info | NoticeLevel::Error => tokens.ink,
        NoticeLevel::Warning => tokens.warn,
    };
    let font = notice_font();
    let old = if font != 0 {
        unsafe { SelectObject(hdc, font) }
    } else {
        0
    };
    let scale = dpi_scale(hwnd);
    let pad_x = scaled(NOTICE_PAD_X, scale);
    let pad_y = scaled(NOTICE_PAD_Y, scale);
    let mut text_rect: RECT = unsafe { std::mem::zeroed() };
    text_rect.left = pad_x;
    text_rect.top = pad_y;
    text_rect.right = (rect.right() - pad_x).max(pad_x + 1);
    text_rect.bottom = (rect.bottom() - pad_y).max(pad_y + 1);
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(ink));
        DrawTextW(
            hdc,
            wide(text).as_ptr(),
            -1,
            &mut text_rect,
            DT_WORDBREAK | DT_CENTER | DT_NOPREFIX,
        );
        if old != 0 {
            SelectObject(hdc, old);
        }
    }
}

/// 数据刷新（拉取完成/保存回执）。
pub(crate) fn refresh_ui() {
    let view = settings_ui().view();
    with_state(|state| refresh_values(state, &view));
    // 文档弹窗（②）与页面控件是两条独立通道：随文档加载状态开合（模态）。
    sync_document_dialog(&view);
    // 管理面重建会新建控件：统一重排一次（面板区按滚动量整体位移）。
    with_state(|state| layout(state.hwnd));
    // 通知分档（①）在借用之外：错误档要跑模态消息循环，不能再借 STATE。
    present_notice(&view);
}

fn refresh_values(state: &mut SettingsState, view: &SettingsView) {
    let connected = view.connected;
    for slot in state.slots.iter() {
        let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
            continue;
        };
        if kind.is_action() {
            unsafe { EnableWindow(slot.hwnd, 1) };
            continue;
        }
        // 聚焦中的编辑框不回声覆盖：用户输入在聚焦期间是权威（逐字置脏触发的刷新
        // 会把 clamp / 规范化后的值当场改写进控件，打字会被打断）；失焦提交后的
        // 下一次刷新再把规范化值写回。
        let editing = unsafe { GetFocus() == slot.hwnd }
            && matches!(
                kind,
                FieldKind::Number { .. } | FieldKind::Text { .. } | FieldKind::Multiline
            );
        if !editing {
            write_control(slot.hwnd, key, kind, view.values.get(key), view);
        }
        let editable = connected && !editing;
        unsafe { EnableWindow(slot.hwnd, if editable { 1 } else { 0 }) };
    }
    // 密钥揭示按钮不在字段槽的启用路径上：跟随连接态。
    for pair in state.secret_pairs.iter() {
        unsafe { EnableWindow(pair.button, if connected { 1 } else { 0 }) };
    }
    // 动态帮助行（如 Bash 白名单计数）：按草稿现值重算，提交后立即跟上。
    for (hint, key) in state.dynamic_hints.iter() {
        if let Some(text) = crate::ui::settings::dynamic_field_hint(key, &view.values) {
            unsafe { SetWindowTextW(*hint, wide(&text).as_ptr()) };
        }
    }
    // 状态行：不再承载通知（通知走浮层/模态，①），只留常驻的有信息量状态；
    // 浮层建不出来时（降级路径）才在这里兜底显示当前通知，不丢信息。
    if state.fixed.status != 0 {
        let text = if state.capturing_shortcut {
            "请按下新的组合键…（Esc 取消）".to_string()
        } else if !view.connected {
            "设置数据未接线（Node 设置读写端口就绪后自动生效）".to_string()
        } else if view.saving {
            "正在保存…".to_string()
        } else if !view.dirty.is_empty() {
            format!("有 {} 项未保存", view.dirty.len())
        } else if state.notice_overlay_failed {
            view.notice.clone().unwrap_or_default()
        } else {
            String::new()
        };
        unsafe { SetWindowTextW(state.fixed.status, wide(&text).as_ptr()) };
    }
    if state.fixed.save != 0 {
        let enabled = view.connected && !view.dirty.is_empty() && !view.saving;
        unsafe { EnableWindow(state.fixed.save, if enabled { 1 } else { 0 }) };
    }
    // 竖栏行按钮：按当前 Tab 贴选中/未选中面（幂等；换主题后由 apply_theme 再刷圆角）。
    for (index, button) in state.fixed.tab_buttons.iter().enumerate() {
        let role = if index == state.tab {
            ButtonRole::TabOn
        } else {
            ButtonRole::TabOff
        };
        paint_win::set_role(*button, role);
        unsafe { InvalidateRect(*button, std::ptr::null(), 1) };
    }
    // 管理面：数据代数变化时只重建面板区。
    sync_panels(state);
}

/// 采全表控件值进草稿（保存与依赖当前值的动作共用；编辑框里的编辑也进草稿）。
///
/// 先在**一次借用**里把 (键, 值) 全部读出来，再在借用之外逐条提交：`set_value` 会
/// 同步走到 `SettingsUi::refresh()` → `refresh_ui()`（主线程内联执行），若在
/// `with_state` 借用里调用会重入 `STATE` 的 `RefCell`（AGENTS §9 的 RefCell 纪律）。
fn harvest_controls() -> crate::error::AppResult<()> {
    let collected: Vec<(&'static str, SettingsValue)> = with_state(|state| {
        state
            .slots
            .iter()
            .filter_map(|slot| {
                let (key, kind) = (slot.key?, slot.kind?);
                if kind.is_action() {
                    return None;
                }
                read_control(slot.hwnd, kind).map(|value| (key, value))
            })
            .collect()
    })
    .unwrap_or_default();
    for (key, value) in collected {
        settings_ui().set_value(key, value)?;
    }
    Ok(())
}

/// 保存前采全表，再提交。
fn harvest_and_save() -> crate::error::AppResult<()> {
    harvest_controls()?;
    settings_ui().save()
}

/// 录制快捷键：模态轮询捕获（不新增窗口类/键盘钩子）。
///
/// 录制期间禁用设置窗输入（打字不会落进任何编辑框），用 `GetAsyncKeyState` 全局
/// 轮询按键边沿；只轮询键码表里的键 —— 表外按键本就无法注册，不捕获是如实行为。
/// 退出条件：捕获有效组合 / Esc 取消 / 超时。
fn capture_shortcut(hwnd: HWND) {
    unsafe { EnableWindow(hwnd, 0) };
    // 录制是「模式」不是通知：提示留在状态行、录制期间不被刷新抹掉（`refresh_values`
    // 按 `capturing_shortcut` 固定该文案）—— 浮层的「几秒自动消失」语义不适合模式提示。
    with_state(|state| state.capturing_shortcut = true);
    refresh_ui();
    let mut was_down: HashSet<u16> = HashSet::new();
    // 开始录制时已按下的键不算新边沿（用户可能正按着修饰键）。
    for (_, vk) in crate::ui::shortcut::WINDOWS_VIRTUAL_KEYS {
        if key_down(*vk as i32) {
            was_down.insert(*vk as u16);
        }
    }
    let deadline = Instant::now() + Duration::from_millis(SHORTCUT_CAPTURE_TIMEOUT_MS);
    let mut captured: Option<(String, ShortcutModifiers)> = None;
    let mut cancelled = false;
    while Instant::now() < deadline {
        // 泵消息保持界面可绘制；窗口已禁用，不会有新的输入消息。
        pump_messages();
        let modifiers = current_modifiers();
        if key_down(i32::from(VK_ESCAPE)) && !modifiers.any() {
            cancelled = true;
            break;
        }
        for (name, vk) in crate::ui::shortcut::WINDOWS_VIRTUAL_KEYS {
            let down = key_down(*vk as i32);
            let was = was_down.contains(&(*vk as u16));
            if down && !was {
                // Esc 已在上面按取消处理；其余按键到此即一个可注册的候选。
                captured = Some(((*name).to_string(), modifiers));
            }
            if down {
                was_down.insert(*vk as u16);
            } else {
                was_down.remove(&(*vk as u16));
            }
        }
        if captured.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(SHORTCUT_CAPTURE_POLL_MS));
    }
    unsafe { EnableWindow(hwnd, 1) };
    with_state(|state| state.capturing_shortcut = false);
    match captured {
        Some((key, modifiers)) => {
            match settings_ui().apply_shortcut(&key, modifiers, SHORTCUT_MODIFIERS_KEY) {
                Ok(()) => settings_ui().set_notice(Some("新快捷键已录入，保存后生效".into())),
                Err(error) => settings_ui().set_notice(Some(format!("快捷键未更新：{error}"))),
            }
        }
        None if cancelled => {
            settings_ui().set_notice(Some("已取消录制，快捷键未改动".into()));
            rust_debug!("快捷键录制被 Esc 取消");
        }
        None => settings_ui().set_notice(Some("快捷键录制超时（未捕获按键）".into())),
    }
    refresh_ui();
}

/// `GetAsyncKeyState` 高位 = 当前按下。
fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// 当前修饰键（Win 键按 Command 口径写入 `winModifiers`）。
fn current_modifiers() -> ShortcutModifiers {
    ShortcutModifiers {
        control: key_down(i32::from(VK_CONTROL)),
        command: key_down(i32::from(VK_LWIN)) || key_down(i32::from(VK_RWIN)),
        alt: key_down(i32::from(VK_MENU)),
        shift: key_down(i32::from(VK_SHIFT)),
    }
}

/// 泵掉本线程消息队列（录制期间保持窗口可绘制）。
fn pump_messages() {
    let mut message: MSG = unsafe { std::mem::zeroed() };
    while unsafe { PeekMessageW(&mut message, 0, 0, 0, PM_REMOVE) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// 数字字段文本 → 值（纯函数，可测；`read_control` 与编辑提交共用同一实现点）。
///
/// 解析不出 / 非有限值（空串、「-」、`1e999`）→ `None`：**不给兜底值**（不把「abc」
/// 静默写成 0）；越界按既有口径 clamp 到 `[min, max]`。
fn parse_number_text(text: &str, min: f64, max: f64) -> Option<f64> {
    let raw: f64 = text.trim().parse().ok()?;
    if !raw.is_finite() {
        return None;
    }
    Some(raw.clamp(min, max))
}

/// 编辑提交的决策（纯函数，可测）：解析出的值 + 草稿现值 → 是否需要写草稿。
///
/// 判据只有「值是否真的变了」：相同值不重复提交 —— 程序化 `SetWindowTextW` 也可能
/// 补发 `EN_CHANGE`，重复提交就是「写值 → 通知 → 再写」自激。
fn edit_commit_needed(current: Option<&SettingsValue>, parsed: &SettingsValue) -> bool {
    current != Some(parsed)
}

/// 编辑框的值提交（`on_blur=false` = `EN_CHANGE` 编辑中；`true` = `EN_KILLFOCUS` 失焦）。
///
/// 口径（用户规则 2026-10-05：「改了必须要回车，不行，弄成改了就能点保存」）：
/// - **编辑即置脏**：能解析出值时立刻写草稿，底部「保存」随即可用；
/// - **中间态不判非法**：空串 / 只敲了「-」等解析不出的输入**不写草稿、不清控件**
///   （不要一边打字一边判非法、更不要静默把「abc」写成 0）；失焦仍解析不出时，
///   把显示恢复成草稿现值（校验与显示都在失焦收口）；
/// - 解析出且与草稿现值相同：**不重复提交** —— 程序化 `SetWindowTextW` 也可能补发
///   `EN_CHANGE`，去掉这一层就是「写值 → 通知 → 再写」自激；
/// - 失焦提交沿用既有口径：越界按 `read_control` 的 clamp 收口、校验不过走通知；
///   编辑中途的校验失败只记 `rust_debug!`（每敲一个字都弹窗会变成噪音）。
fn commit_edit_value(control: HWND, kind: FieldKind, key: &str, on_blur: bool) {
    let Some(value) = read_control(control, kind) else {
        if on_blur {
            rust_debug!("失焦的值不可解析，显示恢复为草稿现值（{key}）");
            refresh_ui();
        }
        return;
    };
    let needed = {
        let view = settings_ui().view();
        edit_commit_needed(view.values.get(key), &value)
    };
    if !needed {
        return;
    }
    if let Err(error) = settings_ui().set_value(key, value) {
        if on_blur {
            settings_ui().set_notice(Some(format!("输入无效：{error}")));
        } else {
            rust_debug!("编辑中的值未通过校验（{key}）：{error}");
        }
    }
}

fn read_control(hwnd: HWND, kind: FieldKind) -> Option<SettingsValue> {
    if hwnd == 0 {
        return None;
    }
    unsafe {
        match kind {
            FieldKind::Bool => {
                // 自绘开关不承载 `BM_GETCHECK`：状态只存在于镜像表。
                SWITCH_STATES
                    .with(|states| Some(SettingsValue::Bool(states.borrow().get(hwnd as isize))))
            }
            FieldKind::Number { min, max, .. } => {
                parse_number_text(&window_text(hwnd), min, max).map(SettingsValue::Number)
            }
            FieldKind::Text { .. } | FieldKind::Multiline => {
                Some(SettingsValue::Text(window_text(hwnd)))
            }
            FieldKind::Enum(choices) => {
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                let choice = choices.get(index.max(0) as usize)?;
                Some(SettingsValue::Text(choice.value.to_string()))
            }
            FieldKind::FontFamily => {
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    Some(SettingsValue::Text(String::new()))
                } else {
                    Some(SettingsValue::Text(window_text(hwnd)))
                }
            }
            FieldKind::CardChoice => {
                // 值 = Card id（不是显示名）：首个占位项「（未设置）」映射为空串。
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    return Some(SettingsValue::Text(String::new()));
                }
                let options = crate::ui::settings::settings_ui().card_options();
                let option = options
                    .as_ref()
                    .and_then(|list| list.get((index - 1) as usize))?;
                Some(SettingsValue::Text(option.id.clone()))
            }
            FieldKind::ProfileChoice => {
                // 值 = Profile id（不是显示名）：首个占位项「（未设置）」映射为空串。
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    return Some(SettingsValue::Text(String::new()));
                }
                let options = crate::ui::settings::settings_ui().profile_options();
                let option = options
                    .as_ref()
                    .and_then(|list| list.get((index - 1) as usize))?;
                Some(SettingsValue::Text(option.id.clone()))
            }
            // 只读展示与录制控件都不从控件读值（录制结果在 capture_shortcut 写入）。
            FieldKind::Info | FieldKind::Shortcut | FieldKind::ShortcutModifiers => None,
            // 档位段是草稿值的**视图**：不从控件读值（采全表/保存都不得顺手改写它 ——
            // 存量 1.5 打开设置再保存必须原样保留；只有点击分段才写）。
            FieldKind::NumberChoice { .. } => None,
            FieldKind::Action => None,
        }
    }
}

/// 下拉框第 `index` 项的文本（`CB_GETLBTEXTLEN` + `CB_GETLBTEXT`；越界/失败返回空串）。
unsafe fn combo_item_text(hwnd: HWND, index: i32) -> String {
    let len = SendMessageW(hwnd, 0x0149 /* CB_GETLBTEXTLEN */, index as usize, 0);
    if len < 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    SendMessageW(
        hwnd,
        0x0148, /* CB_GETLBTEXT */
        index as usize,
        buf.as_mut_ptr() as isize,
    );
    String::from_utf16_lossy(&buf[..len as usize])
}

/// 下拉框条目与期望标题不一致（数量或内容）→ 需重建。
///
/// **只比数量会漏掉改名**（数量不变、标题过期），过期标题与按 id 的取值错位：
/// 用户按看到的名字选中，读回的却是另一个 id（macOS 侧同款判据）。
unsafe fn combo_choice_stale(hwnd: HWND, desired: &[String]) -> bool {
    // CB_GETCOUNT 按 Win32 语义是 int；`SendMessageW` 的返回宽是 LRESULT=isize，
    // 收回到 i32 才能直接喂给 `combo_item_text` 的索引参数（CB_ERR=-1 走首条比较即判过期）。
    let count = SendMessageW(hwnd, 0x0146 /* CB_GETCOUNT */, 0, 0) as i32;
    count as usize != desired.len()
        || (0..count).any(|i| combo_item_text(hwnd, i) != desired[i as usize])
}

fn write_control(
    hwnd: HWND,
    key: &str,
    kind: FieldKind,
    value: Option<&SettingsValue>,
    view: &crate::ui::settings::SettingsView,
) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        match kind {
            FieldKind::Bool => {
                // 自绘开关：状态写镜像表 + 失效重绘（`WM_DRAWITEM` 从镜像表读）。
                let checked = value.and_then(SettingsValue::as_bool).unwrap_or(false);
                SWITCH_STATES.with(|states| states.borrow_mut().set(hwnd as isize, checked));
                InvalidateRect(hwnd, std::ptr::null(), 1);
            }
            FieldKind::Number { min, .. } => {
                let number = value.and_then(SettingsValue::as_number).unwrap_or(min);
                SetWindowTextW(hwnd, wide(&format_number(number)).as_ptr());
            }
            FieldKind::NumberChoice { options } => {
                // 只更新高亮档（按草稿现值取最近档）——**不写值**：档位只约束呈现，
                // 存量 1.5 在这里只被「显示成最近档」，草稿原样保留。
                let selected =
                    number_choice_selected(options, value.and_then(SettingsValue::as_number));
                set_number_choice_selected(hwnd, selected);
                InvalidateRect(hwnd, std::ptr::null(), 1);
            }
            FieldKind::Text { .. } | FieldKind::Multiline => {
                let text = value.and_then(SettingsValue::as_text).unwrap_or("");
                SetWindowTextW(hwnd, wide(text).as_ptr());
            }
            FieldKind::Enum(choices) => {
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                let index = choices
                    .iter()
                    .position(|choice| choice.value == current)
                    .unwrap_or(0);
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::FontFamily => {
                let families = view.font_families.clone();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                let expected_len = families.as_ref().map(|list| list.len() + 1).unwrap_or(1);
                let actual = SendMessageW(hwnd, 0x0146 /* CB_GETCOUNT */, 0, 0);
                if actual as usize != expected_len {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    SendMessageW(
                        hwnd,
                        CB_ADDSTRING,
                        0,
                        wide("（系统默认）").as_ptr() as isize,
                    );
                    if let Some(families) = &families {
                        for family in families.iter() {
                            SendMessageW(hwnd, CB_ADDSTRING, 0, wide(family).as_ptr() as isize);
                        }
                    }
                }
                if current.is_empty() {
                    SendMessageW(hwnd, CB_SETCURSEL, 0, 0);
                } else {
                    let index = SendMessageW(
                        hwnd,
                        0x0158, /* CB_FINDSTRINGEXACT */
                        -1isize as usize,
                        wide(current).as_ptr() as isize,
                    );
                    if index >= 0 {
                        SendMessageW(hwnd, CB_SETCURSEL, index as usize, 0);
                    }
                }
            }
            FieldKind::CardChoice => {
                let options = crate::ui::settings::settings_ui().card_options();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 期望标题 = 占位 + 选项显示名；按内容判重建（不只比条数，见 combo_choice_stale）。
                let mut desired: Vec<String> = vec!["（未设置）".to_string()];
                if let Some(list) = &options {
                    desired.extend(list.iter().map(|option| option.name.clone()));
                }
                if combo_choice_stale(hwnd, &desired) {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    for title in &desired {
                        SendMessageW(hwnd, CB_ADDSTRING, 0, wide(title).as_ptr() as isize);
                    }
                }
                // 按 id 定位（显示名可能重复/变更）：找不到时回到「未设置」。
                let index = if current.is_empty() {
                    0
                } else {
                    options
                        .as_ref()
                        .and_then(|list| list.iter().position(|option| option.id == current))
                        .map(|position| position as usize + 1)
                        .unwrap_or(0)
                };
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::ProfileChoice => {
                let options = crate::ui::settings::settings_ui().profile_options();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 与 CardChoice 同款内容判据：改名 / 列表变化都要重建（条数相同也重建）。
                let mut desired: Vec<String> = vec!["（未设置）".to_string()];
                if let Some(list) = &options {
                    desired.extend(list.iter().map(|option| option.name.clone()));
                }
                if combo_choice_stale(hwnd, &desired) {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    for title in &desired {
                        SendMessageW(hwnd, CB_ADDSTRING, 0, wide(title).as_ptr() as isize);
                    }
                }
                // 按 id 定位（显示名可能重复/变更）：找不到时回到「未设置」。
                let index = if current.is_empty() {
                    0
                } else {
                    options
                        .as_ref()
                        .and_then(|list| list.iter().position(|option| option.id == current))
                        .map(|position| position as usize + 1)
                        .unwrap_or(0)
                };
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::Info => {
                let text = crate::ui::settings::info_text(key, &view.values);
                SetWindowTextW(hwnd, wide(&text).as_ptr());
            }
            FieldKind::Shortcut => {
                SetWindowTextW(hwnd, wide(&shortcut_display(view)).as_ptr());
            }
            FieldKind::ShortcutModifiers => {}
            // 动作入口不走值刷新（`refresh_values` 在动作分支直接 continue 并单独刷标题）。
            FieldKind::Action => {}
        }
    }
}

/// 快捷键的组合展示（Windows 键位名；未知修饰键名原样显示）。
fn shortcut_display(view: &crate::ui::settings::SettingsView) -> String {
    let Some((key, modifiers)) =
        crate::ui::settings::shortcut_parts(&view.values, SHORTCUT_MODIFIERS_KEY)
    else {
        return "录制快捷键".to_string();
    };
    let mut parts: Vec<String> = modifiers
        .iter()
        .map(|modifier| match modifier.as_str() {
            "Control" => "Ctrl".to_string(),
            "Command" => "Win".to_string(),
            "Alt" => "Alt".to_string(),
            "Shift" => "Shift".to_string(),
            other => other.to_string(),
        })
        .collect();
    parts.push(key);
    parts.join("+")
}

fn window_text(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; (len + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..read as usize])
}

fn format_number(number: f64) -> String {
    if number.fract().abs() < f64::EPSILON {
        format!("{}", number as i64)
    } else {
        let text = format!("{number:.4}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// 全局字体变化：重建字体并重新下发（控件保持不重建）。
pub(crate) fn apply_font() {
    with_state(|state| {
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        for font in state.fonts.drain(..) {
            if font != 0 {
                unsafe { DeleteObject(font) };
            }
        }
        let body = make_font(scale, 13, false);
        let small = make_font(scale, 11, false);
        let bold = make_font(scale, 13, true);
        state.fonts = vec![body, small, bold];
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            let font = if slot.font_base <= 11 { small } else { body };
            unsafe { SendMessageW(slot.hwnd, WM_SETFONT, font as WPARAM, 1) };
        }
        if state.detail_content != 0 {
            unsafe { SendMessageW(state.detail_content, WM_SETFONT, body as WPARAM, 1) };
        }
        for hwnd in state.fixed.tab_buttons.iter() {
            // 竖栏行按钮的字号基线是「小号」（与 macOS 的 HELP_BASE_SIZE 同口径）。
            unsafe { SendMessageW(*hwnd, WM_SETFONT, small as WPARAM, 1) };
        }
        unsafe {
            SendMessageW(state.fixed.status, WM_SETFONT, small as WPARAM, 1);
            SendMessageW(state.fixed.refresh, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.fixed.save, WM_SETFONT, body as WPARAM, 1);
        }
        // 文档编辑弹窗（②）自持字体（与输入弹窗同规），不随这里重发；
        // 通知浮层（①）与设置窗共用字体句柄：重发字体，并按新度量重新摆位。
        if state.notice_overlay != 0 {
            let overlay = state.notice_overlay;
            unsafe { SendMessageW(overlay, WM_SETFONT, small as WPARAM, 1) };
            let text = window_text(overlay);
            let (client_w, _) = client_size(state.hwnd);
            let measured = measure_notice_text(&text, scaled(NOTICE_MAX_TEXT_W, scale));
            state.notice_measured = measured;
            let (x, y, w, h) = notice_overlay_geometry(measured, client_w, scale);
            unsafe { MoveWindow(overlay, x, y, w, h, 1) };
            refresh_notice_region(overlay, scale);
        }
    });
    rust_debug!("设置窗字体已按全局快照刷新");
}

// ==========================================
// 纯逻辑单测（无 Win32 调用；本模块只在 Windows 编译，macOS 上跑不到 —— 见 AGENTS §2。
// 同表在 macOS 可跑的部分：`paint_win` 的 `文字角色映射到各自_token` 与
// `主按钮面全套取_primary_族`；本文件用例由 CI 的 verify (windows-latest) 执行。）
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 提交类贴主按钮面其余走普通面() {
        // 全面自绘：每个显式按钮都有 ownerdraw 角色（不再有「保持系统外观」的档）。
        for kind in [
            SettingsButton::Save,
            SettingsButton::SaveDocument,
            SettingsButton::SaveCorrection,
        ] {
            assert_eq!(
                button_role(kind),
                ButtonRole::Primary,
                "{kind:?} 是提交类动作，应贴 primary 面"
            );
        }
        for kind in [
            SettingsButton::Refresh,
            SettingsButton::PanelRefresh,
            SettingsButton::DocumentClose,
            SettingsButton::DocumentRegenerate,
            SettingsButton::DocumentTest,
            SettingsButton::DocumentCopy,
            SettingsButton::MemoryPin,
            SettingsButton::MemoryForget,
            SettingsButton::RowPrimary,
            SettingsButton::RowSecondary,
        ] {
            assert_eq!(
                button_role(kind),
                ButtonRole::Normal,
                "{kind:?} 是普通动作，应走 btn_bg 普通面（不再有系统外观档）"
            );
        }
    }

    /// 组合框条目配色（② 全面自绘）：字段区取输入面族、条目取 `field_bg`、
    /// 选中行有覆盖、文字取 ink / 禁用降 dim；三套主题都成立。
    #[test]
    fn 组合框条目配色取输入面族与主文字色() {
        for id in theme::ThemeId::ALL {
            let tokens = id.tokens();
            // 字段区（收起态）= 输入面族（Pending = field_bg + field_edge + field_bevel）。
            let field = combo_item_style(tokens, false, false, true);
            assert_eq!(
                format!("{:?}", field.bg),
                format!("{:?}", Some(tokens.field_bg)),
                "{id:?} 字段区底必须取 field_bg（Fill 无 PartialEq，按 Debug 结构比对）"
            );
            assert_eq!(field.edge, Some(tokens.field_edge), "{id:?}");
            assert!(field.bevel.is_some(), "{id:?} 字段区应带输入面族内立体线");
            assert_eq!(field.ink, tokens.ink, "{id:?}");
            assert!(field.overlay.is_none(), "{id:?} 字段区不叠选中覆盖");
            // 清单条目：field_bg 底、无描边；选中行叠悬浮同款覆盖。
            let item = combo_item_style(tokens, false, false, false);
            assert_eq!(
                format!("{:?}", item.bg),
                format!("{:?}", Some(tokens.field_bg)),
                "{id:?} 条目底取 field_bg"
            );
            assert_eq!(item.edge, None, "{id:?} 条目不带字段描边");
            assert!(item.overlay.is_none(), "{id:?} 未选中条目无覆盖");
            let selected = combo_item_style(tokens, true, false, false);
            assert!(
                selected.overlay.is_some(),
                "{id:?} 选中行必须有可见的选中覆盖"
            );
            // 禁用：文字降 dim（底不变）。
            let disabled = combo_item_style(tokens, false, true, true);
            assert_eq!(disabled.ink, tokens.dim, "{id:?} 禁用文字降 dim");
            assert_ne!(
                tokens.ink, tokens.dim,
                "{id:?} ink 与 dim 同值 = 禁用态不可检"
            );
        }
    }

    /// 弹窗按钮行（②）：从右缘往左排、间距 8、末项不出左缘；只读（无保存）少一项。
    #[test]
    fn 弹窗按钮行贴右缘从右往左排() {
        // 保存 → 关闭（只读文档）。
        let xs = doc_dialog_button_row(DOC_DIALOG_W, &[DOC_DIALOG_BTN_W_CLOSE]);
        assert_eq!(xs, vec![DOC_DIALOG_W - MARGIN - DOC_DIALOG_BTN_W_CLOSE]);
        // 关闭 → 复制（只读 Card 模版）：复制是次要动作、排在关闭左侧，两按钮都放得下。
        let xs = doc_dialog_button_row(
            DOC_DIALOG_W,
            &[DOC_DIALOG_BTN_W_CLOSE, DOC_DIALOG_BTN_W_COPY],
        );
        assert_eq!(xs.len(), 2);
        assert_eq!(xs[0] + DOC_DIALOG_BTN_W_CLOSE, DOC_DIALOG_W - MARGIN);
        assert_eq!(xs[0] - 8 - DOC_DIALOG_BTN_W_COPY, xs[1]);
        assert!(xs[1] > MARGIN, "复制按钮不得压出左缘");
        // 保存 → 关闭 → 重新生成。
        let xs = doc_dialog_button_row(
            DOC_DIALOG_W,
            &[
                DOC_DIALOG_BTN_W_SAVE,
                DOC_DIALOG_BTN_W_CLOSE,
                DOC_DIALOG_BTN_W_REGENERATE,
            ],
        );
        assert_eq!(xs.len(), 3);
        // 首项贴右缘。
        assert_eq!(xs[0] + DOC_DIALOG_BTN_W_SAVE, DOC_DIALOG_W - MARGIN);
        // 项间距 8、顺序严格从右往左。
        assert_eq!(xs[0] - 8 - DOC_DIALOG_BTN_W_CLOSE, xs[1]);
        assert_eq!(xs[1] - 8 - DOC_DIALOG_BTN_W_REGENERATE, xs[2]);
        assert!(xs[2] > MARGIN, "次要动作不得压出左缘（弹窗宽度要能容下）");
    }

    /// 撤下的设置键不得再出现在**生产段**（schema 撤项后平台侧残留引用 = 死分支 /
    /// 死夹具 —— 本批点名的同类坑：漏改平台调用点）。名单随共享层撤项同批维护。
    ///
    /// 源级守门（只跑在 Windows CI）：`_chat.rs` 的同款做法是切到 `#[cfg(test)]` 之前。
    #[test]
    fn 撤下的设置键不再出现在生产码里() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/windows_settings.rs"
        ));
        let production = &src[..src.find("#[cfg(test)]").expect("必须有测试段")];
        for key in [
            "action.previewPopupSize",
            "general.popup.mode",
            "general.popup.fixedPosition",
            "general.popup.defaultSize",
            "general.popup.chatWidth",
        ] {
            assert!(
                !production.contains(key),
                "撤下的设置项 {key} 仍被生产码引用（死分支/死夹具）"
            );
        }
    }

    /// 数值档位（NumberChoice）：按**最近档**高亮但**不产生要写回的值** ——
    /// 存量 1.5 打开设置只被显示成最近档，草稿原样保留（用户没点就不该被改写）。
    #[test]
    fn 数值档位按最近档高亮且不写值() {
        let options: &[(&str, f64)] = &[("弱", 1.0), ("强", 2.0)];
        // 正常值命中各自档位。
        assert_eq!(number_choice_selected(options, Some(1.0)), Some(0));
        assert_eq!(number_choice_selected(options, Some(2.0)), Some(1));
        // 平手取**靠前**档（1.5 距两档等距 → 「弱」）。
        assert_eq!(number_choice_selected(options, Some(1.5)), Some(0));
        // 档位之外的存量值：按最近档高亮、不改值（返回值里没有任何「值」可写）。
        assert_eq!(number_choice_selected(options, Some(1.9)), Some(1));
        assert_eq!(number_choice_selected(options, Some(0.8)), Some(0));
        assert_eq!(number_choice_selected(options, Some(99.0)), Some(1));
        // 值缺失 / 空档位表：无高亮（不猜一个档）。
        assert_eq!(number_choice_selected(options, None), None);
        assert_eq!(number_choice_selected(&[], Some(1.0)), None);
    }

    /// 数值档位命中（点击语义）：段内命中各自下标；段间间隙与界外不命中
    /// （不猜一个档写值）。
    #[test]
    fn 数值档位命中段与间隙() {
        let widths = number_choice_equal_widths(100, 2);
        assert_eq!(widths, vec![50, 50]);
        assert_eq!(number_choice_hit(&widths, 0), Some(0));
        assert_eq!(number_choice_hit(&widths, 49), Some(0));
        // 50..52 是段间间隙（NUMBER_CHOICE_GAP = 2）→ 不命中。
        assert_eq!(number_choice_hit(&widths, 50), None);
        assert_eq!(number_choice_hit(&widths, 51), None);
        assert_eq!(number_choice_hit(&widths, 52), Some(1));
        assert_eq!(number_choice_hit(&widths, 101), Some(1));
        // 界外（负数 / 超出总宽）不命中。
        assert_eq!(number_choice_hit(&widths, -1), None);
        assert_eq!(number_choice_hit(&widths, 102), None);
        assert_eq!(number_choice_hit(&[], 0), None);
    }

    /// 激活规则：光标命中哪段就选哪段；命不中（键盘 Space / 点进间隙）→ 下一档循环。
    #[test]
    fn 数值档位激活命不中时循环下一档() {
        // 光标命中优先（点哪段选哪段）。
        assert_eq!(number_choice_activation(Some(1), Some(0), 2), Some(1));
        assert_eq!(number_choice_activation(Some(0), Some(1), 2), Some(0));
        // 命不中 + 已有高亮 → 下一档（循环：最后一档回到第一档）。
        assert_eq!(number_choice_activation(None, Some(0), 2), Some(1));
        assert_eq!(number_choice_activation(None, Some(1), 2), Some(0));
        // 命不中 + 无高亮 → 第一档。
        assert_eq!(number_choice_activation(None, None, 2), Some(0));
        // 空档位表 → 不写值。
        assert_eq!(number_choice_activation(None, Some(0), 0), None);
        assert_eq!(number_choice_activation(Some(0), Some(0), 0), Some(0));
    }

    /// 段宽均分：除不尽的余数落在最后一段（总宽守恒）。
    #[test]
    fn 数值档位段宽均分余数落末段() {
        assert_eq!(number_choice_equal_widths(100, 3), vec![33, 33, 34]);
        assert_eq!(number_choice_equal_widths(101, 2), vec![50, 51]);
        assert_eq!(number_choice_equal_widths(0, 2), vec![0, 0]);
        assert!(number_choice_equal_widths(100, 0).is_empty());
        // 总宽守恒（含间隙前的段宽和 = 客户区宽）。
        let widths = number_choice_equal_widths(97, 4);
        assert_eq!(widths.iter().sum::<i32>(), 97);
    }

    /// 弹窗控件 id 不得与系统约定 id（IDOK / IDCANCEL）撞号：
    /// `GetDlgItem` 按 id 取控件，撞号会让「保存」按钮的取回命中标题 STATIC。
    #[test]
    fn 弹窗控件_id_不撞系统_id() {
        for id in [
            DOC_DIALOG_TITLE_ID,
            DOC_DIALOG_HINT_ID,
            DOC_DIALOG_EDIT_ID,
            DOC_DIALOG_REGENERATE_ID,
            DOC_DIALOG_TEST_ID,
            DOC_DIALOG_COPY_ID,
        ] {
            assert_ne!(id, IDOK, "弹窗控件 id 撞 IDOK");
            assert_ne!(id, IDCANCEL, "弹窗控件 id 撞 IDCANCEL");
        }
    }

    /// 弹窗次要动作计划：目标门控与 macOS `doc_dialog_buttons` 同表 ——
    /// 「复制」只属只读的 Card 模版，其它只读目标（VariablePool / MemoryEvidence）
    /// 不得借到；「重新生成 / 测试连接」的既有门控保持原样。
    #[test]
    fn 弹窗次要动作只给匹配目标() {
        assert_eq!(
            doc_dialog_secondary(&DocumentTarget::CardTemplate)
                .expect("Card 模版应有复制动作")
                .0,
            "复制",
            "Card 模版（只读）：次要动作是复制"
        );
        let copy = doc_dialog_secondary(&DocumentTarget::CardTemplate).unwrap();
        assert_eq!(copy.1, DOC_DIALOG_COPY_ID);
        assert_eq!(copy.2, SettingsButton::DocumentCopy);
        // 其它只读目标没有次要动作（不关弹窗的附加动作一个都不给）。
        for target in [
            DocumentTarget::VariablePool,
            DocumentTarget::MemoryEvidence,
        ] {
            assert!(
                doc_dialog_secondary(&target).is_none(),
                "{target:?} 不应出现次要动作"
            );
        }
        // 可编辑目标里只有既有两处匹配；复制不得借给它们。
        for target in [
            DocumentTarget::V1rtual,
            DocumentTarget::CardMarkdown,
            DocumentTarget::McpServer { name: String::new() },
        ] {
            assert!(
                doc_dialog_secondary(&target).is_none(),
                "{target:?} 不应出现次要动作"
            );
        }
        assert_eq!(
            doc_dialog_secondary(&DocumentTarget::CardStages).unwrap().0,
            "重新生成"
        );
        assert_eq!(
            doc_dialog_secondary(&DocumentTarget::McpServer {
                name: "github".into()
            })
            .unwrap()
            .0,
            "测试连接"
        );
    }

    /// 组合框条目行/字段区用面（纯函数）：字段区走输入面族、条目行走普通面。
    #[test]
    fn 组合框字段区用输入面族() {
        assert_eq!(combo_item_role(true), ButtonRole::Pending);
        assert_eq!(combo_item_role(false), ButtonRole::Normal);
        assert_ne!(combo_item_role(true), combo_item_role(false));
    }

    /// 颜色编码字节序（AGENTS §9 的 GDI 两字节序）：`COLORREF` 是 `0x00BBGGRR`
    /// —— 红在最末字节。本文件所有颜色都经 `paint_win::colorref`，这条钉住该口径。
    #[test]
    fn 色值编码是_bgr_字节序() {
        // #FF8800 → 蓝 0x00、绿 0x88、红 0xFF。
        assert_eq!(
            paint_win::colorref(theme::Rgba::hex(0xFF_88_00)),
            0x0000_88FF,
            "COLORREF 必须按 0x00BBGGRR 排布（红在最末字节）"
        );
        // 往返一致。
        let color = theme::Rgba::hex(0x12_34_56);
        assert_eq!(
            paint_win::rgba_from_colorref(paint_win::colorref(color)),
            color
        );
    }

    /// 竖栏行按钮：几何与 id 段都按设计稿/`on_command` 的范围约定钉住。
    #[test]
    fn 竖栏行按钮几何与_id_段一致() {
        // 行宽 = 竖栏宽 − 2×横向内边距（设计稿 104 − 2×6 = 92）。
        assert_eq!(RAIL_W - RAIL_PAD_X * 2, 92);
        // 行排布：顶距 9、行距 26+1（与 macOS 的 rail_item_y 同式）。
        assert_eq!(RAIL_TOP + 4 * (RAIL_ITEM_H + RAIL_ITEM_GAP), 117);
        // TAB_BASE 段宽 16 必须容下全部 Tab（on_command 的 `..TAB_BASE + 16` 保护）。
        assert!(
            (TABS.len() as i32) < 16,
            "Tab 数超过 TAB_BASE 段宽 = 分派分支会漏"
        );
    }

    /// 密钥揭示切换：两个方向的密码字符必须不同（0=明文；复遮蔽写回原遮蔽字符）。
    #[test]
    fn 密钥揭示切换在明文与遮蔽间往返() {
        let masked = secret_toggle(false, 0x25CF);
        assert_eq!(masked, (0, "隐藏"), "遮蔽态点击应切到明文");
        let revealed = secret_toggle(true, 0x25CF);
        assert_eq!(
            revealed,
            (0x25CF, "显示"),
            "明文态点击应恢复建控件时读到的遮蔽字符"
        );
        assert_ne!(masked.0, revealed.0, "明文与遮蔽的密码字符不得同值");
        // 遮蔽字符缺省回落也要能往返（读不到默认值时用 ●）。
        assert_eq!(secret_toggle(true, 0x25CF).0, 0x25CF);
    }

    /// 标签截断护栏（2026-10-05 行结构重排后按新几何，与 macOS 同表）：schema 全表
    /// 标签在**默认窗宽的标签块**内都放得下（标签块宽 = 内容宽 − 控件宽 − 间距，
    /// 控件宽度分档见 [`field_control_size`]）。
    ///
    /// Windows 标签用 `small` 基线（11），估算口径与 macOS 一致（保守的字符宽度近似：
    /// 全角 ≈ 1em、ASCII ≈ 0.6em，不是字体度量）；Action 行无左标签（按钮文字即标题），
    /// 改为断言其按钮文案不超出按钮宽度上限。
    #[test]
    fn 全部字段标签在标签块内完整显示() {
        /// 标签用 `small` 基线（11）、按钮文案用正文基线（13.5）：估算口径与
        /// `field_control_size` 同源（保守的字符宽度近似：全角 ≈ 1em、ASCII ≈ 0.6em）。
        const LABEL_FONT_BASE: f64 = 11.0;
        const BODY_FONT_BASE: f64 = 13.5;
        fn estimated_width(text: &str, base: f64) -> f64 {
            text.chars()
                .map(|ch| {
                    let wide = matches!(ch, '\u{1100}'..='\u{FFEF}');
                    if wide {
                        base
                    } else {
                        base * 0.6
                    }
                })
                .sum()
        }
        // 默认窗宽 540（windows.rs `WindowId::Settings` 默认值）→ 内容区完整宽 =
        // 窗宽 − 竖栏（`rebuild_tab` 的 `content_width` 同口径）。
        let content_width = 540 - RAIL_W;
        for tab in TABS {
            for section in tab.sections {
                for field in section.fields {
                    if matches!(field.kind, FieldKind::ShortcutModifiers) {
                        continue; // 不渲染独立控件
                    }
                    if matches!(field.kind, FieldKind::Action) {
                        // Action 行无左标签（按钮文字即标题），断言文案不超出按钮宽度上限。
                        let estimated = estimated_width(field.label, BODY_FONT_BASE);
                        assert!(
                            estimated + 28.0 <= 200.5,
                            "{}/{} 的动作「{}」估算宽度 {estimated:.1}px 超出按钮宽度上限 200px",
                            tab.id,
                            section.title,
                            field.label
                        );
                        continue;
                    }
                    let estimated = estimated_width(&field.display_label(), LABEL_FONT_BASE);
                    let (ctrl_w, _) = field_control_size(field);
                    let label_w = field_label_width(content_width, ctrl_w);
                    assert!(
                        estimated <= f64::from(label_w) - 4.0,
                        "{}/{} 的标签「{}」估算宽度 {estimated:.1}px 超出标签块 {label_w}px",
                        tab.id,
                        section.title,
                        field.label
                    );
                }
            }
        }
    }

    /// 通知分档（①）：错误绝不降级成浮层、回执绝不弹模态（与 macOS `notice_action` 同表）。
    #[test]
    fn 通知分档归位() {
        // 同一代际：三个档位都不重复呈现。
        for level in [NoticeLevel::Error, NoticeLevel::Info, NoticeLevel::Warning] {
            assert_eq!(
                notice_action(level, 7, 7),
                NoticeAction::None,
                "{level:?} 同一代际不得重复呈现"
            );
        }
        assert_eq!(notice_action(NoticeLevel::Error, 8, 7), NoticeAction::Modal);
        assert_eq!(notice_action(NoticeLevel::Info, 8, 7), NoticeAction::Toast);
        assert_eq!(
            notice_action(NoticeLevel::Warning, 8, 7),
            NoticeAction::Toast
        );
    }

    /// 判新只认代际、不比较文本：同一句话连报两次（文本相等）也必须算新通知 ——
    /// 否则浮层不会重新计时（需求点名的缺陷）。
    #[test]
    fn 同一句话连报两次仍按新通知处理() {
        // 第一次呈现：代际 1（已呈现代际 0）。
        assert_eq!(
            notice_action(NoticeLevel::Info, 1, 0),
            NoticeAction::Toast,
            "第一次通知必须算新"
        );
        // 已呈现代际 1 之后，同一文本、新代际 2 —— 必须再算新（分档照旧）。
        // 判据里根本没有文本：函数形状上就没有「按文本判旧」这条路的入口。
        assert_eq!(
            notice_action(NoticeLevel::Info, 2, 1),
            NoticeAction::Toast,
            "同文本 + 新代际 = 新通知，必须重新呈现/重新计时"
        );
        // 同一条（代际未前进）不重复呈现。
        assert_eq!(
            notice_action(NoticeLevel::Info, 2, 2),
            NoticeAction::None,
            "同一条通知不得重复呈现"
        );
    }

    /// 文档弹窗的呈现门（②）：只在内容已加载、没有在显弹窗、且本次打开未呈现过时才弹
    /// （与 macOS `document_should_present` 同判据）。
    #[test]
    fn 文档弹窗只在加载完成后弹一次() {
        assert!(document_should_present(true, false, false), "加载完成应弹");
        assert!(!document_should_present(false, false, false), "读取中不弹");
        assert!(
            !document_should_present(true, true, false),
            "已有弹窗在显不重入"
        );
        assert!(
            !document_should_present(true, false, true),
            "本次打开已呈现过不重弹（保存回执只重写文本，不再弹）"
        );
    }

    /// 浮层档位编码往返：三个档位互不相同且可还原（Warning 绝不落回 Info）。
    #[test]
    fn 浮层档位编码可往返() {
        for level in [NoticeLevel::Info, NoticeLevel::Warning, NoticeLevel::Error] {
            assert_eq!(
                notice_level_from_code(notice_level_code(level)),
                level,
                "{level:?} 编码往返失败"
            );
        }
        let codes = [
            notice_level_code(NoticeLevel::Info),
            notice_level_code(NoticeLevel::Warning),
            notice_level_code(NoticeLevel::Error),
        ];
        assert_ne!(codes[0], codes[1], "Info 与 Warning 编码同值");
        assert_ne!(codes[1], codes[2], "Warning 与 Error 编码同值");
        // 未知编码收拢 Info（槽位只有本文件写，这条只是防御）。
        assert_eq!(notice_level_from_code(99), NoticeLevel::Info);
    }

    /// 浮层几何（①）：居中于窗口客户区（与 macOS `show_toast` 同式）、贴 `NOTICE_TOP`、
    /// 宽度被客户区宽收口、且随 DPI 等比缩放。
    #[test]
    fn 浮层几何居中于客户区且宽度收口() {
        // 常规：文本 200×34，窗宽 540（逻辑）→ 宽 = 文本 + 2×内边距。
        let (x, y, w, h) = notice_overlay_geometry((200, 34), 540, 1.0);
        assert_eq!((w, h), (200 + NOTICE_PAD_X * 2, 34 + NOTICE_PAD_Y * 2));
        assert_eq!(y, NOTICE_TOP);
        // 水平居中：左缘 = (客户区宽 − 浮层宽) / 2。
        assert_eq!(x, (540 - w) / 2);
        assert_eq!(x + w / 2, 540 / 2, "浮层中线必须对齐窗口中线");
        // 窄文本给最小宽度（不缩成一条）。
        let (_, _, narrow_w, _) = notice_overlay_geometry((10, 20), 540, 1.0);
        assert_eq!(narrow_w, NOTICE_MIN_W);
        // 超宽文本被客户区宽（窗宽 − 2×MARGIN）收口，仍居中。
        let (wide_x, _, wide_w, _) = notice_overlay_geometry((900, 20), 540, 1.0);
        assert_eq!(wide_w, 540 - MARGIN * 2);
        assert_eq!(wide_x, MARGIN);
        // 2× DPI：几何整体等比（物理像素），不会一半逻辑一半物理。
        let (x2, y2, w2, h2) = notice_overlay_geometry((400, 68), 1080, 2.0);
        assert_eq!((x2, y2, w2, h2), (x * 2, y * 2, w * 2, h * 2));
    }

    /// 文档弹窗内部布局（②）：标题/说明/编辑框自上而下不重叠，按钮行贴底且编辑框吃剩余高度。
    #[test]
    fn 文档弹窗内部布局不重叠且按钮贴底() {
        let client = (DOC_DIALOG_W, DOC_DIALOG_H);
        let (title, hint, edit, buttons_y) = doc_dialog_layout(client);
        assert_eq!((title.x, title.y), (MARGIN, MARGIN));
        assert!(title.bottom() <= hint.y, "标题与说明不得重叠");
        assert!(hint.bottom() <= edit.y, "说明与编辑框不得重叠");
        // 按钮行贴底：按钮底 + 边距 = 弹窗客户区高。
        assert_eq!(buttons_y + DOC_DIALOG_BTN_H + MARGIN, client.1);
        // 编辑框与按钮行之间留 6px 间隙且吃满剩余高度。
        assert_eq!(edit.bottom() + 6, buttons_y);
        assert!(edit.h > 0);
        // 弹窗变高 → 编辑框变高、按钮行下移（其余不动）。
        let taller = (DOC_DIALOG_W, DOC_DIALOG_H + 106);
        let (title2, hint2, edit2, buttons_y2) = doc_dialog_layout(taller);
        assert_eq!((title2, hint2), (title, hint));
        assert_eq!(buttons_y2, buttons_y + (taller.1 - client.1));
        assert_eq!(edit2.h, edit.h + (taller.1 - client.1));
        // 极小程序区：编辑框有下限（不出现负高度/控件被顶出）。
        let (_, _, tiny_edit, _) = doc_dialog_layout((200, 120));
        assert!(tiny_edit.h >= 40, "编辑框高度必须有下限");
        assert!(tiny_edit.w > 0);
        // 按钮右缘不越出弹窗右缘（保存/关闭都贴内容右缘，两按钮之间留 8px）。
        let save_x = DOC_DIALOG_W - MARGIN - DOC_DIALOG_BTN_W_SAVE;
        let close_x = save_x - 8 - DOC_DIALOG_BTN_W_CLOSE;
        assert!(close_x > MARGIN, "关闭按钮必须在编辑框右侧仍有位置");
        assert!(save_x + DOC_DIALOG_BTN_W_SAVE <= DOC_DIALOG_W - MARGIN);
    }

    /// 字段提交时机（编辑即置脏组）：数字解析不兜底、越界按 clamp 收口。
    #[test]
    fn 数字字段解析不兜底且越界收口() {
        // 中间态 / 非法输入：不产生值（绝不是 0）。
        assert_eq!(
            parse_number_text("", 1.0, 2.0),
            None,
            "空串是中间态，不判非法、不写值"
        );
        assert_eq!(parse_number_text("-", 1.0, 2.0), None, "只敲了负号不算值");
        assert_eq!(
            parse_number_text("abc", 1.0, 2.0),
            None,
            "非数字不得兜底成 0"
        );
        assert_eq!(parse_number_text("1e999", 1.0, 2.0), None, "非有限值不写");
        // 正常解析（含首尾空白）。
        assert_eq!(parse_number_text(" 1.5 ", 1.0, 2.0), Some(1.5));
        // 越界 clamp（沿用既有 `read_control` 口径）。
        assert_eq!(parse_number_text("99", 1.0, 2.0), Some(2.0));
        assert_eq!(parse_number_text("0.1", 1.0, 2.0), Some(1.0));
    }

    /// 编辑提交只在值真的变了时写草稿（防程序化 `SetWindowTextW` 的 `EN_CHANGE` 自激）。
    #[test]
    fn 编辑提交只在值变化时写草稿() {
        let current = SettingsValue::Number(1.5);
        assert!(edit_commit_needed(
            Some(&current),
            &SettingsValue::Number(2.0)
        ));
        assert!(!edit_commit_needed(
            Some(&current),
            &SettingsValue::Number(1.5)
        ));
        // 文本字段同判据（值相等不重复提交）。
        assert!(!edit_commit_needed(
            Some(&SettingsValue::Text("x".into())),
            &SettingsValue::Text("x".into())
        ));
        assert!(edit_commit_needed(
            Some(&SettingsValue::Text("x".into())),
            &SettingsValue::Text("xy".into())
        ));
        // 草稿里没有这个键（防御性）：第一次提交要写。
        assert!(edit_commit_needed(None, &SettingsValue::Number(1.5)));
    }

    #[test]
    fn 文字角色取对_token_且错误警告不对调() {
        for id in theme::ThemeId::ALL {
            let tokens = id.tokens();
            assert_eq!(
                paint_win::text_color(tokens, TextRole::Body),
                tokens.ink,
                "{id:?}"
            );
            assert_eq!(
                paint_win::text_color(tokens, TextRole::Hint),
                tokens.dim,
                "{id:?}"
            );
            assert_eq!(
                paint_win::text_color(tokens, TextRole::Error),
                tokens.danger,
                "{id:?} 错误文字必须取 danger"
            );
            assert_eq!(
                paint_win::text_color(tokens, TextRole::Warning),
                tokens.warn,
                "{id:?} 警告文字必须取 warn"
            );
            assert_ne!(
                tokens.danger, tokens.warn,
                "{id:?} danger 与 warn 同值 = 对调不可检"
            );
        }
    }

    /// 行内下拉（`Pick`）的主控件是下拉、不是（空标题）按钮 —— 挡住「下拉行落到
    /// 按钮位 = 主控件消失」的退化；文案表与形态表互证。
    #[test]
    fn 行内下拉主控件按下拉渲染且不落空按钮() {
        assert_eq!(row_main_kind(RowAction::Pick), RowMainKind::Pick);
        assert_eq!(
            row_button_title(RowAction::Pick, false),
            "",
            "Pick 行的主控件是下拉，不占按钮文案"
        );
        // 按钮档文案表：开关两态 / 查看 / 试听（试听作主按钮用于无 pick 的旧行）。
        assert_eq!(row_main_kind(RowAction::Toggle), RowMainKind::Button);
        assert_eq!(row_button_title(RowAction::Toggle, true), "已启用");
        assert_eq!(row_button_title(RowAction::Toggle, false), "已关闭");
        assert_eq!(row_button_title(RowAction::Select, false), "查看");
        assert_eq!(row_button_title(RowAction::Preview, false), "试听");
        // 凭据行（MCP「GitHub 令牌」）：主控件是按钮、文案「设置」（不落空按钮）。
        assert_eq!(row_main_kind(RowAction::Credential), RowMainKind::Button);
        assert_eq!(row_button_title(RowAction::Credential, false), "设置");
        assert_eq!(row_main_kind(RowAction::None), RowMainKind::None);
        // 次按钮文案：音效事件行的 action2 = 试听（次按钮位上的 Preview）。
        assert_eq!(row_secondary_title(RowAction::Preview), "试听");
        assert_eq!(row_secondary_title(RowAction::Edit), "编辑");
        assert_eq!(row_secondary_title(RowAction::Delete), "删除");
        assert_eq!(row_secondary_title(RowAction::None), "");
        // 值写回判据：无控件（防御路径）绝不写值。
        assert!(!pick_change_is_final(0, CBN_SELENDOK));
        assert!(!pick_change_is_final(0, CBN_SELCHANGE));
    }

    /// 行内下拉选中项查找与回退（共享层口径）：按 `value` 命中；不在表里回退
    /// 第一项（只回退呈现，不回写、不串项）。
    #[test]
    fn 行内下拉选中项回退第一项且不串项() {
        use crate::ui::settings::panels::RowOption;
        fn pick(selected: &str) -> RowPick {
            RowPick {
                options: vec![
                    RowOption {
                        value: "none".into(),
                        label: "静音".into(),
                    },
                    RowOption {
                        value: "chime_short".into(),
                        label: "风铃".into(),
                    },
                    RowOption {
                        value: "welcome_chord".into(),
                        label: "温暖和弦".into(),
                    },
                ],
                selected: selected.to_string(),
            }
        }
        // 命中：下标指向的 label 必须是被选中的那一项（字段区显示的就是它）。
        let current = pick("chime_short");
        assert_eq!(pick_selected_index(&current), 1);
        assert_eq!(current.options[pick_selected_index(&current)].label, "风铃");
        assert_eq!(
            current.options[pick_selected_index(&current)].value,
            "chime_short"
        );
        // 选中值不在选项表（列表更新/旧值）→ 回退第一项，不 panic、不猜别的项。
        let stale = pick("removed_sound");
        assert_eq!(pick_selected_index(&stale), 0);
        assert_eq!(stale.options[pick_selected_index(&stale)].label, "静音");
        // 第一项自身命中（idx 0 不等于「没找到」）。
        let first = pick("none");
        assert_eq!(pick_selected_index(&first), 0);
    }

    /// 行高推进（与 macOS `panel_rows_span` 的行高表同档）：副标题为空 = 单行紧凑；
    /// 行内下拉行（subtitle 恒空）不得为下拉加高。
    #[test]
    fn 行高按副标题分档且下拉行保持紧凑() {
        use crate::ui::settings::panels::RowOption;
        assert_eq!(panel_row_advance(""), PANEL_ROW_H);
        assert_eq!(panel_row_advance("  "), PANEL_ROW_H, "空白副标题同空串口径");
        assert_eq!(panel_row_advance("说明"), PANEL_ROW_H + 30);
        let pick_row = PanelRow {
            id: "reply".into(),
            title: "收到回复".into(),
            subtitle: String::new(),
            action: RowAction::Pick,
            secondary: RowAction::Preview,
            enabled: false,
            pick: Some(RowPick {
                options: vec![RowOption {
                    value: "none".into(),
                    label: "静音".into(),
                }],
                selected: "none".into(),
            }),
        };
        assert_eq!(panel_row_advance(&pick_row.subtitle), PANEL_ROW_H);
        // 下拉主控件宽必须容下最长选项标签 + 箭头区（100 > 4×13.5 + 12 + 17）。
        assert!(PANEL_PICK_W >= 54 + 12 + 17, "下拉宽容不下四字标签 + 箭头");
    }
}
