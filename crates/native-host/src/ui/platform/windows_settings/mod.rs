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
//! - 滚动由独立内容子窗的 `WS_VSCROLL` 承担，字段按滚动量位移并裁剪，竖栏与页脚固定；
//! - **标准编辑快捷键（复制/粘贴/剪切/全选）由系统 `EDIT` 控件原生承担**：Ctrl+C /
//!   Ctrl+V / Ctrl+X（多行 `ES_MULTILINE` 另有 Ctrl+A）。本模块不拦键盘消息，消息循环
//!   （`windows.rs`）也没有加速键表或 `IsDialogMessage`，所以这些键原样落到焦点控件。
//!   与 macOS 侧正相反 —— 那边应用无主菜单、标准编辑键无处派发，必须由
//!   `macos_widgets::handle_standard_edit_shortcut` 在窗口层接住（2026-10-07 实机问题）。
//! 本文件全部代码只在 UI 主线程运行。
//!
//! ## 主题接线（范围 c：设置窗）
//!
//! - **窗底**自绘（类的画刷留空，见 `windows.rs` 的附属窗类注册）：用
//!   `tokens().panel_bg`（**2026-10-07 改口径**，原为 `field_bg`）。理由：mac 设置窗
//!   是**蓝灰工作材质**、字段是白药丸（用户实拍 + mac 录制逐点核对）；原口径拿
//!   `field_bg`（近白）铺满整窗后，白色字段与窗底几乎同色，只剩 `WS_BORDER` 的两条
//!   深色横线 —— 实机观感就是用户报的「莫名其妙的**白底矩形**」。
//!   `panel_bg` 与聊天列/浮层同族（三套主题都是中性蓝灰），白字段落在它上面才读得出
//!   「输入面」；文字对比度仍由 `ink`/`dim` 单独保证。
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
//!   （内容面也接 `WM_MEASUREITEM`，字段区与列表高度分别显式设置）。
//! - **可编辑 `EDIT`**：`WM_CTLCOLOREDIT`（底 `field_bg`、字 `ink`、插入符随字色；控件
//!   面贴 `radii.sm` 圆角区域，见 [`apply_field_region`]）由
//!   `windows.rs` 的 `aux_wndproc` 按窗口 code 转发到 [`edit_ctlcolor`]（2026-10-06
//!   路由归位：原先用设置窗父窗子类兜住，是因为当时 `windows.rs` 不在改动范围内）。
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
//!   同时配置展开列表的窗口高度。**管理面行内下拉**（`RowAction::Pick`，
//!   音效事件行）复用同一条（[`build_panel_pick`]）：下拉箭头由系统绘制，不在文案里
//!   手拼「▾」（列表条目与字段区共用字符串表，拼字形会污染条目）。
//! - **可编辑 `EDIT` / 下拉清单**：`WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX` 由
//!   `windows.rs` 的 `aux_wndproc` 转发（这两条消息的消费者是控件父窗 —— 即设置窗
//!   本身；路由归位后不再需要父窗子类）。
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

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateCompatibleDC, CreateRoundRectRgn, DeleteDC, DeleteObject,
    DrawFocusRect, DrawTextW, EndPaint, InvalidateRect, RedrawWindow, ScreenToClient, SelectObject,
    SetBkColor, SetBkMode, SetTextColor, SetWindowRgn,
    DT_CALCRECT, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
    DT_WORDBREAK, FW_BOLD, FW_NORMAL, HDC, HFONT, PAINTSTRUCT, RDW_ALLCHILDREN,
    RDW_ERASE, RDW_INVALIDATE,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
// `SS_CENTER`（STATIC 水平居中样式）：windows-sys 0.52 把 `SS_*` 放在
// `Win32::System::SystemServices`（该 feature 已为本文件的其它符号开启）。
use windows_sys::Win32::System::SystemServices::SS_CENTER;
use windows_sys::Win32::UI::Controls::{
    GetComboBoxInfo, SetScrollInfo, COMBOBOXINFO, EM_GETPASSWORDCHAR, EM_GETSEL,
    EM_SETPASSWORDCHAR, EM_SETSEL, MEASUREITEMSTRUCT, ODS_COMBOBOXEDIT, ODS_DISABLED, ODS_FOCUS,
    ODS_GRAYED, ODS_SELECTED, ODT_BUTTON, ODT_COMBOBOX,
};
// 父窗子类（comctl32）已删除（2026-10-06）：WM_CTLCOLOREDIT / WM_CTLCOLORLISTBOX
// 的转发路由归位到 `windows.rs` 的 `aux_wndproc`（见该处注释与 `edit_ctlcolor`）。
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetAsyncKeyState, GetFocus, IsWindowEnabled, SetFocus, VK_CONTROL, VK_ESCAPE,
    VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClassNameW, GetClientRect, GetCursorPos, GetDlgItem, GetForegroundWindow, GetMessageW,
    GetParent, GetScrollInfo, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, IsDialogMessageW, IsWindow, KillTimer, MessageBoxW, MoveWindow, PeekMessageW,
    PostQuitMessage, RegisterClassW, SendMessageW, SetForegroundWindow, SetTimer,
    SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, TranslateMessage, BN_CLICKED,
    BS_DEFPUSHBUTTON, BS_OWNERDRAW, BS_TYPEMASK, CBN_SELCHANGE, CBN_SELENDOK, CBS_DROPDOWNLIST,
    CBS_HASSTRINGS, CBS_OWNERDRAWFIXED, CB_ADDSTRING, CB_GETCURSEL, CB_GETDROPPEDSTATE,
    CB_SETCURSEL, CB_SETITEMHEIGHT, CW_USEDEFAULT, ES_AUTOHSCROLL, ES_AUTOVSCROLL, ES_MULTILINE,
    ES_PASSWORD, ES_READONLY, ES_WANTRETURN, GWLP_USERDATA, GWL_STYLE, HTTRANSPARENT, HWND_TOP,
    IDCANCEL, IDOK, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, MSG,
    PM_REMOVE, SB_BOTTOM, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP, SB_THUMBPOSITION,
    SB_THUMBTRACK, SB_TOP, SB_VERT, SCROLLINFO, SIF_DISABLENOSCROLL, SIF_PAGE, SIF_POS, SIF_RANGE,
    SIF_TRACKPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOREDRAW, SWP_NOSIZE,
    SWP_NOZORDER, SW_HIDE, SW_SHOW, SW_SHOWNA, WM_CLOSE, WM_COMMAND, WM_CTLCOLORBTN,
    WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DRAWITEM, WM_ERASEBKGND,
    WM_GETFONT, WM_MEASUREITEM, WM_MOUSEWHEEL, WM_NCHITTEST, WM_PAINT, WM_SETFONT, WM_VSCROLL,
    WNDCLASSW, WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_CLIENTEDGE,
    WS_EX_CONTROLPARENT, WS_EX_DLGMODALFRAME, WS_POPUP, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    WS_VSCROLL,
};

use crate::ui::settings::panels::{
    mcp_form_rows, mcp_save_from_values, renders_tools_panel, ListPanel, McpFieldControl,
    McpFieldRow, MemoryDetailState, MemoryEvidenceState, PanelRow, RowAction, RowPick,
    MCP_FORM_FIELD_COUNT,
};
use crate::ui::settings::schema::{Field, FieldKind, TABS};
use crate::ui::settings::{
    settings_ui, tab_index_for_tag, DocumentContent, DocumentState, DocumentTarget, MemoryPager,
    NoticeLevel, SettingsUi, SettingsValue, SettingsView, ShortcutModifiers, SwitchStates,
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
/// 「已记住」分页按钮 ID 段（`MEMORY_PAGE_ID_BASE + 动作下标`）。
/// 必须落在行按钮段（`ROW_ID_BASE..ROW_ID_BASE + 4096` = 3000..7096）之外
/// （口径同 `SECRET_ID_BASE` 的说明：分页按钮不走 `row_slots`，不占行下标空间）。
const MEMORY_PAGE_ID_BASE: i32 = 7500;
/// 记忆分页动作下标（ID = MEMORY_PAGE_ID_BASE + 下标）。
const MEMORY_PAGE_PREV: i32 = 0;
const MEMORY_PAGE_NEXT: i32 = 1;
/// 密钥揭示按钮 ID 段（`SECRET_ID_BASE + 双控件组下标`）。
/// 必须落在行按钮段（`ROW_ID_BASE..ROW_ID_BASE + 4096` = 3000..7096）之外，
/// 且在 `on_command` 里先于 `id >= FIELD_BASE` 兜底分支命中。
const SECRET_ID_BASE: i32 = 13_000;

// ── 左竖栏（设计稿 `.srail`；与 macOS 侧同值）──

/// 竖栏宽（内容坐标以竖栏右缘为 0 点，`layout` 是唯一的 RAIL_W 转换点）。
const RAIL_W: i32 = crate::ui::settings::layout::RAIL_W as i32;
/// 行按钮的左右内边距（设计稿 `padding: 9px 6px` 的横向值）。
const RAIL_PAD_X: i32 = 6;
/// 首行顶距（设计稿纵向 padding 9px）。
const RAIL_TOP: i32 = 9;
/// 行高与行距（设计稿行 padding 5px 9px + gap 1px 的可点区域近似）。
const RAIL_ITEM_H: i32 = 26;
const RAIL_ITEM_GAP: i32 = 1;


/// Bool 开关尺寸（设计稿 `.sw`：32×17；圆角 = 半高）。
const SWITCH_W: i32 = 32;
const SWITCH_H: i32 = 17;

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
const MULTILINE_H: i32 = 84;
/// 密钥揭示按钮宽（编辑框右移让位）。
const SECRET_BTN_W: i32 = 52;
/// 组合框条目文本的左右内边距（逻辑像素；自绘条目用）。
const COMBO_TEXT_PAD: i32 = 6;
/// 数值档位分段控件：段间间隙与段宽上下限（逻辑像素）。
const NUMBER_CHOICE_GAP: i32 = 2;
const NUMBER_CHOICE_SEG_MIN: i32 = 48;
const NUMBER_CHOICE_SEG_MAX: i32 = 96;
const NUMBER_CHOICE_SEG_PAD: i32 = 24;
const MARGIN: i32 = crate::ui::settings::layout::MARGIN as i32;
const SCROLL_STEP: i32 = 24;
/// 原生滚动裁剪面：字段属于此子窗，竖栏与页脚属于根窗（与 macOS NSScrollView 同边界）。
const CONTENT_CLASS: &str = "DeskPetSettingsContent";
/// ComboBox 的窗口高度包含展开列表，收起区高度另外由 CB_SETITEMHEIGHT 指定。
const COMBO_LIST_H: i32 = 216;
/// 所有设置下拉（字段、管理行、MCP 表单）共同的系统语义。
const COMBO_STYLE: u32 = WS_CHILD
    | WS_TABSTOP
    | CBS_DROPDOWNLIST as u32
    | CBS_HASSTRINGS as u32
    | CBS_OWNERDRAWFIXED as u32;
const WHEEL_DELTA: i32 = 120;
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
/// 展开的来源原话高度（只读滚动 EDIT，固定高度）：原话再长也只在框内滚动，
/// 不把页面撑开 —— 与 macOS `MEMORY_EVIDENCE_H` 同档（140 逻辑点）。
const MEMORY_EVIDENCE_H: i32 = 140;
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
        "用选中的备份覆盖记忆库",
        "当前记忆库会被替换为「备份列表」里选中那一份的内容；请先用「预览选中备份」确认版本。",
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
    // Win32 多行 EDIT 只把 CRLF 视为换行；域内文本统一为 LF。
    // 在显示边界补 CR，已有 CRLF 不重复补，UTF-16 的代理对原样保留。
    let mut output = Vec::with_capacity(value.len() + 1);
    let mut previous = 0;
    for unit in value.encode_utf16() {
        if unit == 10 && previous != 13 { output.push(13); }
        output.push(unit);
        previous = unit;
    }
    output.push(0);
    output
}

fn text_from_windows(units: &[u16]) -> String {
    String::from_utf16_lossy(units).replace("\r\n", "\n")
}

fn row_background(tokens: &theme::Tokens) -> theme::Rgba {
    // STATIC 的实色刷没有 alpha；与父内容面使用同一预合成色，避免白/黑标签板。
    paint_win::composite_over(tokens.strip_bg, tokens.panel_bg.base_color())
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
    /// 「已记住」翻页（上一页 / 下一页）。
    MemoryPager,
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
        | SettingsButton::RowSecondary
        | SettingsButton::MemoryPager => ButtonRole::Normal,
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
    hwnd != 0
        && (unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & BS_TYPEMASK as isize)
            == BS_OWNERDRAW as isize
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
    viewport: HWND,
    /// 已构建字段几何的逻辑宽；客户区宽变化时按同一 schema 重建。
    content_width: i32,
    wheel_remainder: i32,
    tab: usize,
    slots: Vec<WinSlot>,
    fixed: FixedControls,
    fonts: Vec<HFONT>,
    scroll: i32,
    content_height: i32,
    section_rules: Vec<i32>,
    row_backgrounds: Vec<paint_win::Rect>,
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
    /// MCP 表单的保存失败草稿（目标 + 控件值表；与 `doc_draft` 同语义，形状不同）。
    doc_form_draft: Option<(DocumentTarget, std::collections::BTreeMap<String, String>)>,
    /// 快捷键录制模式进行中（状态行固定显示录制提示；见 [`capture_shortcut`]）。
    capturing_shortcut: bool,
}

thread_local! {
    // 绘制镜像独立于 STATE：Win32 绘制会在排布借用期间同步重入。
    static CONTENT_DECORATIONS: RefCell<Vec<(paint_win::Rect, bool)>> = const { RefCell::new(Vec::new()) };
    static ROW_LABELS: RefCell<HashSet<HWND>> = RefCell::new(HashSet::new());
    static STATE: RefCell<Option<SettingsState>> = const { RefCell::new(None) };
    /// 开关控件的开/关状态镜像（绘制 / 读值 / 回写三处共用；类型与测试见
    /// `ui/settings::SwitchStates`）。独立于 `STATE`：`WM_DRAWITEM` 在绘制期同步到达，
    /// 走 `with_state` 会与正在持借用者的调用路径重入（AGENTS §5.1 的 RefCell 纪律）。
    static SWITCH_STATES: RefCell<SwitchStates> = RefCell::new(SwitchStates::default());
    /// `with_state` 被重入跳过的累计次数（只用于告警限流）。
    static SETTINGS_REENTRY_COUNT: Cell<u32> = const { Cell::new(0) };
    /// 程序回写控件时的同步通知不代表用户编辑，不能再借 STATE 或重新提交草稿。
    static SYNCING_CONTROLS: Cell<bool> = const { Cell::new(false) };
}

struct ControlSyncGuard(bool);

impl ControlSyncGuard {
    fn begin() -> Self {
        Self(SYNCING_CONTROLS.with(|syncing| syncing.replace(true)))
    }
}

impl Drop for ControlSyncGuard {
    fn drop(&mut self) {
        SYNCING_CONTROLS.with(|syncing| syncing.set(self.0));
    }
}

/// 借用设置窗状态执行 `f`；窗口未建立（STATE 为 None）时返回 `None`。
///
/// **不得在另一个 `with_state` 借用里调用**（含间接：闭包里调用的 helper 自己又借
/// STATE，如 [`layout`]）。窗口过程常常在持借用时同步收到消息（WM_DRAWITEM 在绘制期
/// 到达是既有例子，见 `SWITCH_STATES` 的说明），所以这里用 `try_borrow_mut()` 兜底：
/// 重入时不 panic —— panic 落在 `extern "system"` 回调里无法 unwind，Rust 直接 abort
/// （Windows 上进程静默消失，与 `windows.rs::with_ui` 同一族），而是按「这一次没有
/// 状态可用」返回 `None` 并留一条限流告警。**丢的那次内容不会自己回来**，所以正确
/// 写法仍是「先在借用里取出值，出借用再调用」，源码级守门测试盯着直接嵌套。
fn with_state<R>(f: impl FnOnce(&mut SettingsState) -> R) -> Option<R> {
    STATE.with(|cell| match cell.try_borrow_mut() {
        Ok(mut borrowed) => borrowed.as_mut().map(|state| f(state)),
        Err(_) => {
            SETTINGS_REENTRY_COUNT.with(|count| {
                let times = count.get() + 1;
                count.set(times);
                if times <= 5 || times % 100 == 0 {
                    rust_warn!("with_state 重入被跳过（外层借用未释放），累计 {times} 次");
                }
            });
            None
        }
    })
}

/// 创建字体：族名来自全局快照，缺省回落到 W8a 既有的中文 UI 字体。
fn make_font(scale: f64, base: i32, bold: bool) -> HFONT {
    let snapshot = crate::ui::font::snapshot();
    let logical = snapshot.scaled_size(f64::from(base), 13.5).round() as i32;
    let face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    paint_win::create_ui_font(-scaled(logical, scale), if bold { FW_BOLD as i32 } else { FW_NORMAL as i32 }, &face)
}

/// 控件所属窗口类名（`GetClassNameW`；取不到返回空串）。
fn window_class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..len as usize])
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
    state.row_backgrounds.clear();
    ROW_LABELS.with(|labels| labels.borrow_mut().clear());
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
                | ES_AUTOVSCROLL as u32
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
            if class == "COMBOBOX" {
                h + COMBO_LIST_H
            } else {
                h
            },
            state.viewport,
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
    let (width, _) = client_size(state.viewport);
    let logical_width = (f64::from(width) / scale).round() as i32;
    // 与 `rebuild_tab` 同一条内容宽口径（竖栏右侧的可排区域）。
    let content_w = (logical_width - MARGIN * 2).max(120);
    let body = *state.fonts.first().unwrap_or(&0);
    let small = *state.fonts.get(1).unwrap_or(&body);
    let bold = *state.fonts.get(2).unwrap_or(&body);
    let mut y = state.panel_base_y;
    match TABS[state.tab].id {
        "tools" => {
            // 「刷新」按钮挂在本页第一个**渲染中**面板的标题行（一次拉取覆盖全部面板）；
            // 撤下的面板（工具策略（声明））不参与计数 —— 与 macOS 同一条口径，
            // 规则本身在共享层 [`renders_tools_panel`]（用户规则 2026-10-05，两端同源）。
            let mut first = true;
            for panel in settings_ui()
                .tools_panels()
                .iter()
                .filter(|panel| renders_tools_panel(&panel.id))
            {
                let refresh = if first { Some(REFRESH_TOOLS) } else { None };
                first = false;
                y = build_panel(state, panel, refresh, content_w, y, body, small, bold);
            }
        }
        "memory" => {
            // 常驻说明（入口两条路径 + 来源边界；文案唯一来源 = 设置层共享常量，
            // 与 macOS 同一条 —— 不在平台文件里复制字面量）：排在页面最前面，
            // 随内容滚动。三行盒（h=45，与行副标题的三行档同高）—— 这条说明在
            // 默认窗宽下要折到 3 行，18pt 单行盒会把折行后的后半截截掉。
            create_panel_control(
                state,
                "STATIC",
                SettingsUi::MEMORY_TIP,
                MARGIN,
                y,
                content_w,
                45,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y += 47;
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
            // 「已记住」的行 = 当前页切片（2026-10-06 分页裁决）；分页行只在
            // 列表非空时出现（空态沿用面板的「（没有条目）」文案）。
            let items_view = settings_ui().memory_items_view();
            y = build_panel(
                state,
                &items_view.panel,
                Some(REFRESH_MEMORY),
                content_w,
                y,
                body,
                small,
                bold,
            );
            if let Some(pager) = &items_view.pager {
                y = build_memory_pager(state, content_w, y, pager, body, small);
            }
            y = build_memory_detail(state, content_w, y, body, small, bold);
            // 来源原话：逐条一行（点行展开那一条，再点收起），展开块固定高度可滚动。
            if let Some(sources) = settings_ui().memory_source_panel() {
                y = build_panel(state, &sources, None, content_w, y, body, small, bold);
                y = build_memory_evidence(state, content_w, y, small);
            }
            // 作业面板整列照旧（行按钮只在 Node 标了动作的行出现：取消 / 继续）；
            // macOS 只内联「可操作作业」、完整历史在弹层 —— 两边的动作集合同源。
            if let Some(jobs) = panels.get(1) {
                y = build_panel(state, jobs, None, content_w, y, body, small, bold);
            }
            // 备份列表：托管目录里的备份逐份一行；点行 = 选中（预览/应用的作用对象，
            // 按钮在页面顶部的「备份与恢复」小节）。
            y = build_panel(
                state,
                &settings_ui().memory_backup_panel(),
                None,
                content_w,
                y,
                body,
                small,
                bold,
            );
        }
        // 本批：音效试听面板（行按钮 = 试听；分配编辑在文档区）。
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

// ── MCP 表单弹窗（W5-B：字段控件取代整段 markdown 文档）──

/// 表单字段控件的 id 基址（按行序 +i；与文档弹窗固定 id 不重叠）。
const DOC_FORM_FIELD_ID_BASE: i32 = 200;
/// 表单行尺寸（逻辑像素）：单行行高 / 多行高度 / 标签列宽 / 行间距。
const DOC_FORM_ROW_H: i32 = 24;
const DOC_FORM_MULTILINE_H: i32 = 56;
const DOC_FORM_LABEL_W: i32 = 166;
const DOC_FORM_ROW_GAP: i32 = 6;

/// 行主控件的渲染形态（纯函数，可测）：下拉行出组合框；开关/查看/试听出按钮；
/// Edit/Delete 在次按钮位、只读行没有主控件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowMainKind {
    Pick,
    Button,
    None,
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

fn window_text(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; (len + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    text_from_windows(&buffer[..read as usize])
}

fn format_number(number: f64) -> String {
    if number.fract().abs() < f64::EPSILON {
        format!("{}", number as i64)
    } else {
        let text = format!("{number:.4}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}


// ── 拆分后的子模块与对外入口（windows.rs 只经本模块路径取用）──
mod dialogs;
mod events;
mod layout;
mod render;

// 面板生命周期仍在 `mod.rs`（documents.rs 的源码守门只拼本文件），
// 它按 Tab 调子模块的行构建与客户区测量，这两个 `use` 只在模块内使用。
use self::layout::client_size;
use self::render::{build_memory_detail, build_memory_evidence, build_memory_pager, build_panel};

#[cfg(test)]
mod tests;

pub(crate) use dialogs::prompt_text;
pub(crate) use events::{
    edit_ctlcolor, install_settings_content, on_command, on_ctlcolor, on_destroy, on_drawitem,
    on_mouse_wheel, on_size, on_vscroll, refresh_ui,
};
pub(crate) use render::{apply_font, apply_theme, paint_background};
