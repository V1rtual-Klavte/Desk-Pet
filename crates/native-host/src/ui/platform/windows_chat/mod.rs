//! Windows 聊天窗与查看器内容（W8a，Win32/RichEdit）。
//!
//! 实现路线（执行契约 §6.3 的“明确的 Windows 文本控件”方案，与 W0 探针的
//! Windows 聊天原型同路——`crates/ui-probe` 已随迁移完成删除）：**RichEdit 4.1（Msftedit.dll 的
//! `RICHEDIT50W`）+ RTF 流式装载（`EM_STREAMIN`/`SF_RTF`）** 承载段落/粗斜体/
//! 列表/引用/行内代码/表格/超链接；代码块用独立 RichEdit（`EM_SETTARGETDEVICE`
//! 关闭折行 + 横向滚动条）实现“可横向滚动”；输入区是多行 RichEdit（原生 IME），
//! `SetWindowSubclass` 挂键盘处理：Enter 发送 / Shift+Enter 换行 / IME 组合期间
//! 一律交还系统（候选窗按 `WM_IME_COMPOSITION + GCS_CURSORPOS` 钉到插入符）；
//! 历史图片按原生滚动视口切换占位/首帧预览；owner-draw 按钮用 `StretchDIBits` 绘制
//! `InlinePreviewManager` 帧，点击仍打开独立查看器。
//!
//! 与 macOS 侧的有意差异（2026-10-05 气泡重做批）：
//! - 气泡宽/对齐/上限与 macOS 共用 `panels` 的「贴合内容宽度」算法，
//!   泡底/描边按 `radii.md` 用 GDI 区域裁剪成圆角；只读正文由外层画布滚动；
//! - RichEdit 不能透明：气泡底色取 token 代表色（渐变取 base 与面板底合成），
//!   画布上的气泡填充与承载控件的 `EM_SETBKGNDCOLOR` 同值，接缝不可见；
//! - 输入区占位文案是自绘等价物（覆盖在 RichEdit 上的 STATIC + 命中穿透子类；
//!   输入控件不是标准 EDIT，`EM_SETCUEBANNER` 没有可依赖的公开语义）。
//! 链接点击“显示文本 → URL”按构建期登记的表回查（RichEdit 的 EN_LINK
//! 只给字符区间），并复用 [`resolve_link_click`] 做点击时二次白名单复核。
//! 链接控件必须设 `EM_SETEVENTMASK(ENM_LINK)` 才会收到 EN_LINK（`flush_prose`
//! 按“本控件确实带链接”逐个设置）；不设掩码的后果是点击无响应，而不是默认打开
//! —— Windows 侧没有 AppKit 那种“控件自己打开”的回落，fail-closed 是结构性的。
//!
//! **本文件的 Windows 分支在本机（macOS）只做离线类型核对，未在 Windows 编译/运行**
//! （`native-host` 的 bundled SQLite 需要 msvc 工具链，见原生宿主迁移过程记录 §9.4 第 19 条）。
//! 类型面的依据是 `windows-sys 0.52` 的注册表源码：0.52 里 `HWND` 是 `isize`；
//! RichEdit 的消息/通知取值（`EM_*`、`EN_LINK`、`ENM_LINK`）不在绑定中，本文件
//! 按 RichEdit 公开取值本地定义并注明。
//!
//! A3 增补：输入区「图片」按钮（`NativeFileDialog::pick_images`）与 legacy 文件拖入
//! （聊天窗/输入框/画布三个窗口 `DragAcceptFiles` → `WM_DROPFILES` → 待发送区），
//! 待发送条（元数据预览条，只读文件名/大小）在输入区之上、面板区之下占一行；
//! 撤选走条目按钮，发送/撤选/切会话的释放由聊天模型的 `pending_images` 快照驱动。
//!
//! A3 第二批（2026-10-05 图片通路批）：剪贴板粘贴图片 —— 输入框 `WM_PASTE` 由既有
//! 输入子类接管，`CF_DIBV5`/`CF_DIB`/`CF_BITMAP` 补 14 字节 BMP 容器头后交共享入口
//! `ui::chat::paste::add_pasted_image`（落盘/准入/待发送区都在共享层），`CF_HDROP`
//! （复制的文件）按拖入处理，其余交还 RichEdit 原生粘贴。「记住这条」第二形态
//! （同批）：**消息右键菜单** —— 有事件身份（仅用户消息）的正文/代码块 RichEdit 挂
//! `message_menu_subclass_proc`，`WM_CONTEXTMENU` 弹「复制 / 全选 / 分隔线 /
//! 记住这条」，派发仍走既有 `dispatch_panel_action` 唯一出口。
//! **以上两段与全文件一样：未在 Windows 编译/运行（本机 macOS 只做离线符号核对）。**
//!
//! 第二波镜像（2026-10-05，与 macOS 同批，**输入区结构已被第三波取代**——保留的
//! 是与第三波无关的条目）：
//! - 历史消息按空行拆成多条气泡（共享 `split_paragraphs`）；图片占位 chip
//!   走按钮 chip 族（`ButtonRole::Normal`
//!   = `--bbg/--bedge/--bsh`，与 macOS `Face::Chip` 同族）且宽受 `bubble_cap`；
//! - 正文 RTF 改为块间 `\par` 连接（末块后不追加）：`EM_GETLINECOUNT` 对尾随
//!   段落标记会多算一行（macOS `usedRectForTextContainer` 的同坑），旧写法让
//!   每个气泡底部多一条空行。禁用按钮 = 底 + 标题都降 50%（`paint_win::disabled_face`）。
//!
//! 第三波镜像（2026-10-05，与 macOS 同批）：**把手带 + 浮层 Inspector**。
//! - 「输入区上方一摞可展开抽屉」整体退场（`accessory_*` 不复存在）：用量/调试/投递
//!   收进**输入区上方一行把手带**（共享 `HANDLE_HEIGHT`：左侧圆点 + 中性通知文字；
//!   **过程状态文案只在顶栏显示、聊天窗底部不重复**（2026-10-05 用户规则）。
//!   中置一个上拉小箭头作为可拉起的视觉提示（共享 `handle_arrow_frame` 居中；
//!   朝向随开合翻面），**整条带可点** —— 自下而上是「输入行（贴底）→
//!   把手带 → 待发送条 → 流内面板栈 → 消息流」；
//! - 点把手带任意位置（含箭头；状态文字做命中穿透）开**浮层 Inspector**：
//!   遮罩与浮层盒是消息流区域上的**同一个子窗口**
//!   （`LAYER_CLASS`：绘制区 + 承载内容子控件），**不进布局流** —— 开合前后
//!   消息流的 y 与画布子控件位置完全不动（验收硬指标；`layout_panes_for` 不读浮层状态）；
//!   用量/调试/投递**三块同浮层**（顺序 = `panel_views()` 声明序），不再区分「打开哪一块」；
//! - **会话历史**是挂在标签条「历史」按钮下方的**锚定弹层**（同 `LAYER_CLASS` 的第二块
//!   层窗）：右对齐按钮、顶边贴标签条下沿、整体夹进窗口，点外部/再点按钮收起；
//!   它不进流内面板栈（挂栈里会跑到页面底部、与按钮隔着大半屏）；
//! - 浮层开合（`ChatSnapshot::inspector_open`）**直接吃快照**，
//!   平台层不自行推导、不维护镜像（快照就是唯一真相源）；
//! - 抽屉动作行退场后：「图片」按钮回到输入行（设计稿 `.inp` 的「图片 + 主按钮」），
//!   主按钮槽按运行态换内容（空闲 = 发送 / 运行中 = 停止；运行中仍可经 Enter 发送 ——
//!   插话/投递语义靠它）；按钮占固定宽、**输入框弹性吃剩余并保底 72**
//!   （`input_row_columns` 唯一摆放口径，窄聊天列不把输入框压成一条缝）；
//!   输入框与占位标签按设计稿贴 `radii.sm` 圆角区域；
//!   「↓ 新消息」改为**真有未读新消息且不在底部**才显示（不再只是「不在底部」）；
//!   顶部顶栏带（品牌/状态位/关闭「×」）归主窗的全窗宽顶栏（`windows_main.rs`；
//!   条内几何的唯一来源是 `crate::ui::titlebar`），本窗只画标签条与顶栏投影带；
//! - **与 macOS 的口径差异（就地注明）**：
//!   * 遮罩：GDI 子窗口之间没有 alpha 合成通路（真半透明要 Win8+ 的分层子窗口，
//!     与现有窗口层级/焦点易打架），取「`--scrimc` 口径色与面板底预合成的实色」——
//!     消息流被实色压暗/提亮（气泡被盖住而不是像 macOS 那样隐约透出）；
//!   * 浮层盒圆角：GDI 没有圆角填充原语，用 `CreateRoundRectRgn` + `SelectClipRgn`
//!     裁剪后走既有 `paint_win` 填充原语，描边用 `FrameRgn` 沿区域轮廓（含圆弧段）。

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, ClientToScreen, CombineRgn, CreateCompatibleDC, CreateRectRgn, CreateRoundRectRgn,
    DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRgn, FrameRgn, GetDIBits, GetPixel,
    InvalidateRect, RedrawWindow, ScreenToClient, SelectClipRgn, SelectObject, SetBkMode,
    SetTextColor, SetWindowRgn, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_BITFIELDS, BI_RGB,
    DIB_RGB_COLORS, FW_BOLD, FW_NORMAL, HBITMAP, HDC, HFONT, RDW_ALLCHILDREN, RDW_ERASE,
    RDW_INVALIDATE, RDW_UPDATENOW, RGN_DIFF, SRCCOPY,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_sys::Win32::UI::Controls::{
    SetScrollInfo, ShowScrollBar, ODS_DISABLED, ODS_GRAYED, ODS_SELECTED,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};
use windows_sys::Win32::UI::Input::Ime::{
    ImmGetCompositionStringW, ImmGetContext, ImmReleaseContext, ImmSetCandidateWindow,
    CANDIDATEFORM, CFS_CANDIDATEPOS, GCS_COMPSTR, GCS_CURSORPOS,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetActiveWindow, GetFocus, GetKeyState, SetFocus, VK_CONTROL, VK_DOWN, VK_ESCAPE,
    VK_RETURN, VK_SHIFT, VK_TAB, VK_UP, VK_V,
};
use windows_sys::Win32::UI::Shell::{
    DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, RemoveWindowSubclass,
    SetWindowSubclass, ShellExecuteW, HDROP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DestroyWindow, DispatchMessageW, GetAncestor, GetCaretPos, GetClientRect, GetCursorPos,
    GetMessageW, GetParent, GetScrollInfo, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, IsDialogMessageW, IsWindow, IsWindowVisible, KillTimer,
    MoveWindow, PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, SetForegroundWindow,
    SetTimer, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, TrackPopupMenu,
    TranslateMessage, WindowFromPoint, BS_DEFPUSHBUTTON, CBN_SELENDOK, CBS_DROPDOWNLIST,
    CB_ADDSTRING, CB_GETCURSEL, CB_SETCURSEL, CS_HREDRAW, CS_VREDRAW, ES_AUTOHSCROLL,
    ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, ES_WANTRETURN, GA_ROOT, GWL_STYLE, HMENU,
    HTTRANSPARENT, HWND_BOTTOM, HWND_TOP, IDCANCEL, IDOK, MF_SEPARATOR, MF_STRING, MSG, SB_BOTTOM,
    SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP, SB_THUMBPOSITION, SB_THUMBTRACK, SB_TOP,
    SB_VERT, SCROLLINFO, SIF_ALL, SIF_PAGE, SIF_POS, SIF_RANGE, SIZE_MINIMIZED, SM_CXSCREEN,
    SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, SW_SHOWNORMAL,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_APP, WM_CLOSE, WM_COMMAND, WM_CONTEXTMENU, WM_COPY,
    WM_CREATE, WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DRAWITEM,
    WM_DROPFILES, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION,
    WM_IME_STARTCOMPOSITION, WM_KEYDOWN, WM_KILLFOCUS, WM_LBUTTONDOWN, WM_MOUSEHWHEEL,
    WM_MOUSEWHEEL, WM_NCDESTROY, WM_NCHITTEST, WM_NOTIFY, WM_PAINT, WM_PASTE, WM_SETFOCUS,
    WM_SETFONT, WM_SIZE, WM_TIMER, WM_VSCROLL, WNDCLASSW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN,
    WS_CLIPSIBLINGS, WS_EX_CLIENTEDGE, WS_HSCROLL, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SYSMENU,
    WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

use crate::host::WindowId;
use crate::images::DecodedFrame;
use crate::ui::chat::panels::{
    bubble_cap, bubble_content_width, estimated_text_width, handle_arrow_frame,
    handle_status_width, role_label_text, BUBBLE_PAD_X, BUBBLE_PAD_Y, BUBBLE_SIDE_MARGIN,
    REMEMBER_MENU_ITEM_LABEL,
};
use crate::ui::chat::placeholders::placeholder_label;
use crate::ui::chat::richtext::{parse_blocks, resolve_link_click, Block, Span, TableRow};
use crate::ui::chat::{
    ChatRenderUpdate, MessageSnapshot, PanelAction, PanelLineStyle, PanelOutcome, Role,
    StatusSnapshot,
};
use crate::ui::theme::paint_win::{self, ButtonRole};
use crate::ui::theme::{self, Bevel, Tex as ThemeTex};
use crate::window::DPI_BASELINE;
use crate::{rust_debug, rust_warn};

// ==========================================
// 常量
// ==========================================

const CHAT_CLASS: &str = "DeskPetChatWindow";
const CANVAS_CLASS: &str = "DeskPetChatCanvas";

/// 子控件 ID（聊天窗范围内唯一）。
const INPUT_ID: i32 = 1001;
const STOP_ID: i32 = 1003;
/// 占位按钮 ID 基址（第 n 张图 = 基址 + n）。
const PLACEHOLDER_BASE: i32 = 2000;
const BS_OWNERDRAW: u32 = 0x000B;
/// `SS_OWNERDRAW`（WinUser.h 0x0000000D）：STATIC 自绘 —— 卡片底板由父窗在
/// `WM_DRAWITEM`（`ODT_STATIC` 段）里画。本地常量与 `BS_OWNERDRAW` 同款：
/// windows-sys 0.52 把它放在 `Win32_System_SystemServices`，本文件不依赖那一层
/// （值取 WinUser.h，已对注册表源码核对）。
const SS_OWNERDRAW: u32 = 0x0000000D;
/// `ODT_STATIC`（WinUser.h 5）：`WM_DRAWITEM` 里判别「这是自绘 STATIC」的 CtlType。
const ODT_STATIC: u32 = 5;
const BI_BITFIELDS_RGBA: u32 = 3;
const DT_CENTER: u32 = 0x00000001;
const DT_VCENTER: u32 = 0x00000004;
const DT_SINGLELINE: u32 = 0x00000020;
const DT_NOPREFIX: u32 = 0x00000800;
const DT_END_ELLIPSIS: u32 = 0x00008000;
/// `DrawTextW` 的右对齐 / 只量尺寸（windows-sys 0.52 未登记，与上面同款就地定义）。
const DT_LEFT: u32 = 0x00000000;
const DT_RIGHT: u32 = 0x00000002;
const DT_CALCRECT: u32 = 0x00000400;
/// 把手带状态文字：单行、左对齐、垂直居中（槽宽由共享 `handle_status_width` 收口）。
const STATUS_TEXT_FLAGS: u32 = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;
const TRANSPARENT: i32 = 1;
const ODT_BUTTON: u32 = 4;
/// W8b 面板按钮 ID 基址（第 n 个动作按钮 = 基址 + n）。
const PANEL_BASE: i32 = 3000;
/// 面板下拉（COMBOBOX）ID 基址：id = 基址 + 该下拉第一个选项在动作表里的下标，
/// 用户选定时叠加 `CB_GETCURSEL` 取其动作。段落在 `WM_COMMAND` 里必须排在
/// 开口段（`PENDING_BASE..` 等）之前匹配。
const PANEL_SELECT_BASE: i32 = 8000;

// ── A1：会话标签条（仅主窗聊天面板模式；独立聊天窗保留系统 chrome）──
//
// 顶部 26px 带（品牌 + 状态位 + 关闭「×」）归主窗的全窗宽顶栏
// （`windows_main.rs`；条内几何的单一来源是 `ui::titlebar`）。本窗只画/摆标签条，
// 且它接在顶栏带**下方**（画布顶部预留 = `ui::titlebar::HEIGHT` + 标签条）。

/// A3：发图入口按钮（第三波起在输入行；原生多选器）与待发送条目 ID 基址
/// （第 n 条 = 基址 + n）。
const BTN_PICK_IMAGES_ID: i32 = 1010;
const PENDING_BASE: i32 = 5000;
/// 底部行「发送」按钮与正文「↓ 新消息」跳转按钮 ID（旧壳 ChatPanel 的入口）。
const BTN_SEND_ID: i32 = 1011;
const BTN_JUMP_ID: i32 = 1012;
/// 标签条固定按钮：新建 / 历史。
const BTN_NEW_SESSION_ID: i32 = 1008;
const BTN_HISTORY_ID: i32 = 1009;
/// 会话标签按钮 ID 基址（第 n 个标签 = 基址 + n；关闭按钮在另一段）。
/// 两段范围在 `WM_COMMAND` 里排在 `PANEL_BASE..` 之前匹配。
const SESSION_TAB_BASE: i32 = 4000;
const SESSION_CLOSE_BASE: i32 = 4600;
/// 会话标签条高度（逻辑像素，按 DPI 缩放）；条内控件高度与按钮宽度。
const TABS_HEIGHT: i32 = 24;
const NAV_CONTROL_HEIGHT: i32 = 18;
const NAV_NEW_WIDTH: i32 = 22;
const NAV_HISTORY_WIDTH: i32 = 34;
/// 会话标签宽度上下限、关闭按钮宽度与「名字 | ×」之间的间隙
/// （2026-10-05：× 落进 pill 内部，间隙防止长名字贴住 ×）。
const TAB_MIN_WIDTH: i32 = 36;
const TAB_MAX_WIDTH: i32 = 92;
const TAB_CLOSE_WIDTH: i32 = 16;
const TAB_CLOSE_GAP: i32 = 4;

/// 输入子类向聊天窗请求“发送”的私有消息。
const WM_APP_SEND: u32 = WM_APP + 30;
/// 同步窗口消息重入时，借用释放后补画已验证的更新区域。
const WM_APP_REPAINT: u32 = WM_APP + 31;

/// W8b 面板本地期限的定时器 ID（SetTimer/KillTimer，一次性）。
const TIMER_DEADLINE: usize = 1;

/// 标准 Edit/RichEdit 通知：输入内容变化（windows-sys 0.52 未登记在 Controls 下，
/// 与既有 `EM_*` 本地定义同一理由）。
const EN_CHANGE: u16 = 0x0300;
/// RichEdit 选择范围（把光标移到末尾；windows-sys 0.52 未登记 RichEdit 取值）。
const EM_SETSEL: u32 = 0x00B1;

// ── 消息右键菜单（「记住这条」入口；气泡按钮退场后的第二形态）──

/// 菜单项命令 ID（只在本次弹出菜单生命周期内与 `TrackPopupMenu` 的返回值比对；
/// 不进 `WM_COMMAND`，与托盘菜单的 `CMD_*` 是两套，从 1 起 —— 0 是「未选中」）。
const MENU_COPY: usize = 1;
const MENU_SELECT_ALL: usize = 2;
const MENU_REMEMBER: usize = 3;
/// 菜单本地项文案（RichEdit 自带菜单「复制 / 全选」的等价物）。
/// 「记住这条」不在此定义：文案唯一来源是共享常量 [`REMEMBER_MENU_ITEM_LABEL`]。
const MENU_LABEL_COPY: &str = "复制";
const MENU_LABEL_SELECT_ALL: &str = "全选";

// ── 剪贴板粘贴图片（A3 图片通路第三条）──

/// 剪贴板格式取值（WinUser.h：`CF_BITMAP` 2 / `CF_DIB` 8 / `CF_HDROP` 15 /
/// `CF_DIBV5` 17；`CF_HDROP` 实际在 ShellApi.h）。windows-sys 0.52 只把它们登记在
/// `Win32_System_Ole` 面（feature 未开），与 `ui/clipboard.rs` 的 `CF_UNICODETEXT`
/// 本地定义同一理由：按公开取值本地定义并注明（值已对注册表源码逐条核对）。
const CF_BITMAP: u32 = 2;
const CF_DIB: u32 = 8;
const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;

/// 剪贴板内存块拷贝的**防御上限**（不是图片准入 —— 准入与文案在共享层
/// `ui/chat/paste.rs`，单张 15 MiB）：只防止畸形/恶意的剪贴板内存块把 UI 主线程
/// 拖进一次超大分配。超过即视为「该格式不可用」，依次尝试其余格式。
const CLIPBOARD_COPY_LIMIT: usize = 64 * 1024 * 1024;

/// A3：待发送条几何（逻辑像素，按 DPI 缩放；2026-10-05 第三波按设计稿 `.pend`
/// 对齐「5px 上下内边距 + 10px 左右内边距」）。
const PENDING_HEIGHT: i32 = 30;
const PENDING_CHIP_HEIGHT: i32 = 22;
const PENDING_PAD_X: i32 = 10;
const PENDING_ITEM_MIN_WIDTH: i32 = 64;
const PENDING_ITEM_MAX_WIDTH: i32 = 200;

/// A3 待发送条横向滚动（2026-10-06 用户实测「多张截图不能滚动、点不到」）：
/// 滚轮一格的横向位移、条内滚动指示条厚度（逻辑像素）。
///
/// 指示条画在既有 `PENDING_HEIGHT` 条内（**不新增高度** —— 输入区布局不跳）；
/// Windows 没有 macOS 的 overlay 滚动条，用条底细指示条代替（见 `paint_shell`）。
const PENDING_SCROLL_STEP: i32 = 40;
const PENDING_SCROLLBAR_THICKNESS: i32 = 2;
/// 缩略图距 chip 左缘的内缩（逻辑像素；图高由共享 `THUMB_BOX_HEIGHT` 定，垂直居中）。
const PENDING_THUMB_INSET_X: i32 = 4;

// ── 输入行（图片 / 停止 / 发送）与「↓ 新消息」跳转（逻辑像素，按 DPI 缩放）──

/// 输入行内的按钮宽度：发送 / 停止 / 图片。
///
/// 用户规则（2026-10-05）「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
/// 图片/停止/发送按钮占固定宽，整行不压缩输入框到不可用」：按钮按设计稿字宽收窄
/// （旧值 60/80/52 在窄聊天列把输入框挤到下限 40）；与 macOS 同批同口径
/// （`macos_chat::SEND/STOP/PICK_BUTTON_WIDTH`，两平台值一致）。
const SEND_BUTTON_WIDTH: i32 = 48;
const STOP_BUTTON_WIDTH: i32 = 46;
const PICK_BUTTON_WIDTH: i32 = 46;
const BOTTOM_BUTTON_GAP: i32 = 6;
const BOTTOM_RIGHT_MARGIN: i32 = 12;
/// 输入行按钮高度（与 macOS 的 BOTTOM_BUTTON_HEIGHT 同口径）。
const INPUT_BUTTON_HEIGHT: i32 = 24;
/// 输入框与右侧按钮列的间距（按钮在框**外**右侧，由输入框列算法同步扣掉 EDIT 宽度）。
const INPUT_BUTTON_MARGIN: i32 = 8;
/// 输入框宽度下限（2026-10-05 用户规则；旧下限 40 会把输入框压成「一条缝」，
/// 与 macOS `INPUT_FIELD_MIN_WIDTH` 同值）。窄到展不开时允许与按钮列重叠 ——
/// 宁可叠一点，也不把输入框压到不可用。
const INPUT_FIELD_MIN_WIDTH: i32 = 72;

// ── 把手带与浮层（2026-10-05 第二次改版：底部那排 chip 整体退场、只留一个把手）──

/// 浮层关闭「✕」的固定 ID（独立取值，不再从轨段推导）。
const INSPECTOR_CLOSE_ID: i32 = 1108;
/// 把手左侧状态文字的左内边距、状态点半径与点/文字间距
/// （沿用旧 meta 轨的设计稿口径 `.rstat`：点 6px、gap 6px）。
const HANDLE_STATUS_PAD_X: i32 = 10;
const HANDLE_STATUS_DOT_RADIUS: i32 = 3;
const HANDLE_STATUS_TEXT_GAP: i32 = 6;

// ── 浮层/弹层（消息流区域之上的绘制区 + 内容子控件；脱离布局流）──

/// 悬浮层承载窗口的类名：**浮层 Inspector 与会话历史弹层共用**（同一 wndproc 按
/// 窗口句柄分派；两者都是「遮罩 + 圆角盒 + 内容子控件」的同一形态）。
const LAYER_CLASS: &str = "DeskPetChatOverlayLayer";
/// 浮层**内容滚动裁剪窗**的窗口类名（2026-10-06 抽屉内部滚动）：`WS_VSCROLL` 容器，
/// 子控件 = 面板元素；窗口画盒底（`panel_bg`），部分可见的内容由客户区自然裁剪。
/// 与画布（`CANVAS_CLASS`）同属「滚动容器 + 子控件按偏移移动」一族，不共用类：
/// 画布的绘制/状态与聊天正文绑定，这里只需要盒底填充。系统滚动条（经典外观）落在
/// 裁剪窗右缘、内容超高时才出现 —— 出现的那些帧里内容最右约一个滚动条宽被它裁掉
/// （与画布同款口径；可控损失，不为它再收一道内容重排）。
const INSPECTOR_SCROLL_CLASS: &str = "DeskPetChatInspectorScroll";
/// 浮层盒与消息流区域边缘的距离（设计稿 `.insp{left:9px;right:9px;bottom:9px}`）。
const INSPECTOR_PAD: i32 = 9;
/// 浮层标题行高（设计稿 `.insph`：上下 9px 内边距 + 12px 标题行）。
const INSPECTOR_HEADER_HEIGHT: i32 = 30;
/// 浮层内容底部内边距（设计稿 `.insbody` 的 padding-bottom:12px）。
const INSPECTOR_BODY_PAD_BOTTOM: i32 = 10;
/// 关闭「✕」按钮边长。
const INSPECTOR_CLOSE_SIZE: i32 = 18;
/// 浮层内容裁剪窗与盒左右边缘的内缩（物理像素基准；让开 1px 盒描边 + 1px 内立体线 ——
/// 全宽裁剪窗会把这两条主题线在内容区整段盖掉）。
const INSPECTOR_SCROLL_INSET: i32 = 2;
/// 浮层滚动的行节距（逻辑 pt；与面板行高同值 —— 行是内容的最小视觉单位）。
const INSPECTOR_SCROLL_LINE: i32 = crate::ui::chat::panels::PANEL_METRICS.line_height as i32;
/// 遮罩透明度（设计稿两版口径：深色 `rgba(12,10,30,.44)` / 浅色 `rgba(240,245,252,.5)`）。
const INSPECTOR_SCRIM_ALPHA_DARK: f32 = 0.44;
const INSPECTOR_SCRIM_ALPHA_LIGHT: f32 = 0.5;

// ── 会话历史锚定弹层（挂在标签条「历史」按钮下方；脱离布局流）──

/// 弹层宽（逻辑像素；内容按「弹层宽 − 两侧内边距」布局）。
const HISTORY_POPOVER_WIDTH: i32 = 300;
/// 弹层与标签条下沿的间距（层顶再下移这一点，视觉上贴住按钮）。
const HISTORY_POPOVER_GAP_Y: i32 = 4;
/// 弹层盒的内边距（四边同值；内容坐标系原点 = 盒原点 + 本值）。
const HISTORY_POPOVER_PAD: i32 = 10;
/// 弹层最小宽/高（窗口极小时也不至于压没内容；超出部分由 `layout_panels` 截断）。
const HISTORY_POPOVER_MIN_WIDTH: i32 = 160;
const HISTORY_POPOVER_MIN_HEIGHT: i32 = 80;

/// 「↓ 新消息」：上翻历史时浮在正文右下角，点击回底（旧壳 `#ch-jump` 同义）。
const JUMP_BUTTON_WIDTH: i32 = 96;
const JUMP_BUTTON_HEIGHT: i32 = 24;
const JUMP_BUTTON_MARGIN: i32 = 12;

/// W8b 面板区：面板最高占客户区的比例（超出由 `panels::layout_panels`
/// 保序截断；面板永不挤掉输入区）。
const PANEL_MAX_FRACTION: f64 = 0.45;

// RichEdit 专有消息取值来自 richedit.h；通用 Edit 消息仍沿用 WinUser.h，
// EM_GETLINECOUNT 就是 0xBA（不能臆造 WM_USER 偏移）。
const WM_USER_MSG: u32 = 0x0400;
const EM_STREAMIN: u32 = WM_USER_MSG + 73; // 0x449
const EM_GETLINECOUNT: u32 = 0x00BA;
const EM_SETBKGNDCOLOR: u32 = WM_USER_MSG + 67; // 0x443
const EM_SETTARGETDEVICE: u32 = WM_USER_MSG + 72; // 0x448；wParam=0、lParam=1 关闭折行
const EM_GETTEXTRANGE: u32 = WM_USER_MSG + 75; // 0x44B
const EM_SETEVENTMASK: u32 = WM_USER_MSG + 69; // 0x445
const EN_LINK: u32 = 0x070B;
const ENM_LINK: usize = 0x0400_0000;
const SF_RTF: usize = 0x0002;

/// 逻辑尺寸与间距（按窗口 DPI 等比换算）。
const CHAT_WINDOW_WIDTH: i32 = 460;
const CHAT_WINDOW_HEIGHT: i32 = 640;
const CHAT_WINDOW_MIN_WIDTH: i32 = 360;
const CHAT_WINDOW_MIN_HEIGHT: i32 = 480;
/// 输入区高度（固定；不随内容自增，内部自滚）。2026-10-05：76 → 56，
/// 与 macOS 同口径（设计稿 `.inp` 是单行槽，不是大黑板）；第三波起行内是
/// 「聊天框 + 图片 + 主按钮（发送/停止同槽）」（摆放口径见 `input_row_columns`）。
const INPUT_HEIGHT: i32 = 56;
/// 输入框本体高度（输入区内垂直居中；设计稿 `.inp .ph` 的单行槽口径，与 macOS 同值）。
const INPUT_FIELD_HEIGHT: i32 = 40;
/// 输入框占位文案（设计稿 `.inp .ph` 的「说点什么…」；与 macOS 同文案）。
const INPUT_PLACEHOLDER: &str = "说点什么…";
const PANE_GAP: i32 = 8;
const MESSAGE_SPACING: i32 = 12;
const LABEL_HEIGHT: i32 = 16;
/// 正文行高（物理逻辑像素）。**必须跟 `resolve_ui_font_family` 选中的正文族在
/// RichEdit 下的自然行距一致**：DengXian 13px = 18px（MiSans 23 / 雅黑 25，见
/// `composer-fix-round4.md` 的实测表）。取大了气泡就会明显偏高——用户实拍
/// 「聊天气泡太大」的直接来源（旧值 19 + `rich_edit_height` 的 +8 余量，
/// 两行泡 64px vs mac 46px）。
const LINE_HEIGHT: f64 = 18.0;
/// 正文分段加载每页条数（与 macOS `TRANSCRIPT_PAGE_MESSAGES` 对称）：
/// 首屏只渲染尾段，上滑到顶静默补一页，直到第一条；回底丢弃旧段。
const TRANSCRIPT_PAGE_MESSAGES: usize = 20;
const CODE_BLOCK_MAX_HEIGHT: i32 = 240;
/// 输入区左缘留白（输入框本体与按钮列的布局基准，与 macOS 的 `8.0` 同值）。
const SIDE_MARGIN: i32 = 8;

// ── 气泡几何（留白/上下限/内边距与宽度算法是**平台无关**的，见
//    [`crate::ui::chat::panels`] 的 `BUBBLE_*` 与 `bubble_cap`/`bubble_content_width`；
//    2026-10-05 起两平台共用「贴合内容宽度」：用户泡右对齐、助手泡左对齐，
//    最宽 86%。本模块只保留平台侧的量测（估宽）与构建。）──

/// 气泡描边圈宽度（承载控件外圈留给画布画 1px 边 + 1px 立体线/内缘）。
const CARD_RING_INSET: i32 = 2;

// ── 主题接线：RichEdit 消息与 RTF 颜色表（索引固定，随 token 表刷新）──
//
// RichEdit 控件不能透明（除 `EM_SETBKGNDCOLOR` 外没有透明背景通路），所以「底色」
// 一律取 token 的 `base_color` 再与面板底合成（sRGB 近似；见 paint_win 模块头的取舍）。
// 前景色走 RTF 颜色表，索引固定如下；表体由 `rtf_palette` 按当前主题生成。
/// 链接的强调色（`accent`）。
const RTF_ACCENT: u32 = 1;
/// 次要文字（`dim`；引用块）。
const RTF_DIM: u32 = 2;
/// 主文字（`ink`）。
const RTF_INK: u32 = 3;
/// 用户气泡文字（`bubble_user_ink`）。
const RTF_USER_INK: u32 = 4;
/// 失败工具结果前景（`warn`）。
const RTF_WARN: u32 = 5;
/// 代码块文字（`tool_ink`）。
const RTF_TOOL_INK: u32 = 6;
/// 行内代码底纹（`field_bg` 合成面板底后的实色）。
const RTF_CODE_BG: u32 = 7;

/// RTF 正文半磅值（20 半磅 = 10pt）。RichEdit 的正文大小走 RTF，不走 `WM_SETFONT`；
/// 估宽必须用同一字号，否则 CJK 每字少算 0.333 逻辑像素，接近泡宽上限时末字被裁。
const RTF_BODY_HALF_POINTS: i32 = 20;
/// 正文逻辑像素（96 DPI）：20 半磅 = 10pt = 13.333px。
const RTF_BODY_LOGICAL_SIZE: f64 = 13.333_333_333_333_334;

/// `EM_SETCHARFORMAT`（RichEdit 取值 = WM_USER + 68；windows-sys 0.52 未登记）。
const EM_SETCHARFORMAT: u32 = WM_USER_MSG + 68; // 0x444
/// `SCF_ALL`：作用于全部文本（对空文本设置即成为默认格式）。
const SCF_ALL: usize = 0x0004;
/// `CFM_COLOR`：本次只改文字颜色。
const CFM_COLOR: u32 = 0x4000_0000;

/// 面板绘制区域（物理像素；`layout_panes_for` 写入、`WM_PAINT` 读取）。
/// 空矩形 = 该区不存在，不画。
#[derive(Clone, Copy)]
struct ChatPaintRects {
    /// 顶栏条（仅面板模式）。
    bar: RECT,
    /// 会话标签条（仅面板模式）。
    tabs: RECT,
    /// 面板叠加区。
    panels: RECT,
    /// 待发送条。
    pending: RECT,
    /// 把手带（`--fbg2` 底；状态点画在这里，箭头按钮是子控件）。
    handle: RECT,
    /// 把手带的状态文字槽（左半侧、圆点之后；绘制端按它左对齐 —— 与箭头同层，
    /// 子控件的不透明表面会让 composer 渐变透不过来，2026-10-07 实机）。
    handle_status: RECT,
    /// 把手箭头字形框（共享 `handle_arrow_frame` 的 10×10 逻辑框，物理像素；
    /// 三角在绘制端直接画，不再由子按钮承载）。
    handle_arrow: RECT,
    /// 输入区底条（`--ibg`：覆盖输入行 + 把手带 + 与上方条区之间的间距）。
    input_bar: RECT,
    /// 输入框槽位（边缘/立体线由聊天窗画，承载控件按 2px 内缩）。
    input_field: RECT,
}

impl ChatPaintRects {
    const EMPTY_RECT: RECT = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    /// 布局前的初值：全部为空（WM_PAINT 早于首次布局时不画任何条区）。
    const EMPTY: Self = Self {
        bar: Self::EMPTY_RECT,
        tabs: Self::EMPTY_RECT,
        panels: Self::EMPTY_RECT,
        pending: Self::EMPTY_RECT,
        handle: Self::EMPTY_RECT,
        handle_status: Self::EMPTY_RECT,
        handle_arrow: Self::EMPTY_RECT,
        input_bar: Self::EMPTY_RECT,
        input_field: Self::EMPTY_RECT,
    };
}

/// 消息流里的卡片框（用户/助手气泡的外框）。
///
/// 坐标是**内容坐标**（与画布子控件同一坐标系），绘制时按 `scroll_y` 偏移。
#[derive(Clone, Copy)]
struct CardFrame {
    rect: RECT,
    kind: CardKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CardKind {
    /// 用户气泡：`bubble_user_edge` / `bubble_user_bevel` / 接触投影。
    UserBubble,
    /// 助手轻气泡（2026-10-05 起有底）：`bubble_ai_bg` / `bubble_ai_edge`，
    /// 无立体线/无投影（泡体比用户泡安静，与 macOS `BubbleTheme::for_message`
    /// 的助手分支同语义），两侧气泡均取 `radii.md` 圆角。
    AssistantBubble,
}

// ==========================================
// 本地结构（0.52 未登记）
// ==========================================

#[allow(dead_code)]
// richedit.h 在这些结构周围使用 pshpack4.h；x64 下 callback 偏移为 12，
// 不能用默认 C 对齐（会变为 16，系统将读取错误的回调地址）。
#[repr(C, packed(4))]
struct EDITSTREAM {
    dw_cookie: usize,
    dw_error: u32,
    callback: Option<unsafe extern "system" fn(usize, *mut u8, i32, *mut i32) -> u32>,
}

/// `CHARFORMATW`（richedit.h；windows-sys 0.52 未登记 —— 与本文件其它 RichEdit 取值
/// 同一处理）。只用到 `cbSize`/`dwMask`/`crTextColor`，但布局必须与系统一致
/// （`szFaceName` 之前的 2 字节对齐也不能省；`cbSize` 填本结构大小 = 基础 CHARFORMAT 口径）。
#[allow(dead_code, non_snake_case)]
#[repr(C)]
struct CharFormatW {
    cbSize: u32,
    dwMask: u32,
    dwEffects: u32,
    yHeight: i32,
    yOffset: i32,
    crTextColor: u32,
    bCharSet: u8,
    bPitchAndFamily: u8,
    szFaceName: [u16; 32],
}

/// NMHDR 布局（HWND / UINT_PTR / UINT）。
#[allow(dead_code)]
#[repr(C)]
struct Nmhdr {
    hwnd_from: HWND,
    id_from: usize,
    code: u32,
}

#[allow(dead_code)]
#[repr(C, packed(4))]
struct ENLINK {
    nmhdr: Nmhdr,
    msg: u32,
    w_param: WPARAM,
    l_param: LPARAM,
    chrg: [i32; 2],
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct CHARRANGE {
    cp_min: i32,
    cp_max: i32,
}

#[repr(C)]
struct TEXTRANGEW {
    chrg: CHARRANGE,
    lpstr_text: *mut u16,
}

/// `MINMAXINFO`（0.52 未登记；只用 minTrackSize）。
#[allow(dead_code, non_snake_case)]
#[repr(C)]
struct MinMaxInfo {
    ptReserved: POINT,
    ptMaxSize: POINT,
    ptMaxPosition: POINT,
    ptMinTrackSize: POINT,
    ptMaxTrackSize: POINT,
}

// ==========================================
// 线程内状态（聊天窗、查看器各一份；全部只在 UI 主线程）
// ==========================================

struct ChildEntry {
    hwnd: HWND,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// `DRAWITEMSTRUCT`（本仓聊天侧一直用本地定义；字段布局与 winuser.h 一致）。
///
/// **单一真相源**：主窗顶栏（`windows_main`）也消费它，故 `pub(crate)` —— 不第二份。
#[allow(non_snake_case, dead_code)]
#[repr(C)]
pub(crate) struct DrawItemStruct {
    pub(crate) CtlType: u32,
    pub(crate) CtlID: u32,
    pub(crate) itemID: u32,
    pub(crate) itemAction: u32,
    pub(crate) itemState: u32,
    pub(crate) hwndItem: HWND,
    pub(crate) hDC: isize,
    pub(crate) rcItem: RECT,
    pub(crate) itemData: usize,
}

#[repr(C)]
struct RgbaBitmapInfo {
    header: BITMAPINFOHEADER,
    masks: [u32; 3],
}

#[derive(Clone)]
struct WinImageTarget {
    entry_id: String,
    image_index: u32,
    path: String,
    owner: crate::images::preview::PreviewOwner,
    hwnd: HWND,
    content_y: i32,
    height: i32,
    title: String,
    frame: Option<DecodedFrame>,
}

struct ChatWinState {
    hwnd: HWND,
    /// 主窗内聊天面板（W9a 产品形态）；false = 独立聊天窗（能力保留）。
    pane: bool,
    canvas: HWND,
    input: HWND,
    /// 输入区占位标签（自绘等价物；盖在输入框上、命中穿透，见 `build_children`）。
    input_placeholder: HWND,
    stop: HWND,
    fonts: Vec<HFONT>,
    /// 画布内容总高与当前滚动位置（物理像素）。
    content_height: i32,
    scroll_y: i32,
    /// 正文渲染窗口起点（`usize::MAX` = 尾段自动；上滑分页后指向最早消息下标）。
    message_window_start: usize,
    viewport_height: i32,
    /// 画布子控件及基准位置（滚动时按 scroll_y 重排）。
    children: Vec<ChildEntry>,
    /// 消息（不含流式尾巴）的总高；尾巴从该 y 起。
    base_height: i32,
    /// 流式尾巴控件（也登记在 children 里；这里只是标记）。
    tail: Option<HWND>,
    /// RichEdit 超链接表：控件 → (显示文本, URL)。
    links: HashMap<isize, Vec<(String, String)>>,
    /// 消息 RichEdit 控件 → 该条消息的记忆事件身份（右键菜单「记住这条」的唯一判据
    /// 来源 = `MessageSnapshot::remember_event_id`，不在这里判角色）。只有用户消息会
    /// 登记；与 `links` 同族，随 `rebuild_canvas` 一并清理（旧句柄不得留影）。
    message_menu_targets: HashMap<HWND, String>,
    /// 占位按钮 → (entryId, imageIndex)。
    image_targets: Vec<WinImageTarget>,
    active_session: Option<String>,
    view_generation: u64,
    /// 输入区是否处于 IME 组合中（Enter 必须交还系统）。
    composing: bool,
    /// 最近一次渲染的说话人名（流式尾巴复用）。
    speaker: String,
    // ── W8b 面板区 ──
    /// 面板子控件（父窗口是聊天窗本体；坐标相对面板区左上角）。
    panel_children: Vec<ChildEntry>,
    /// 面板区高度（layout_panes 与面板重建共用）。
    panel_height: i32,
    /// 面板按钮 ID → 动作（每次重建面板时整体替换）。
    panel_actions: Vec<PanelAction>,
    // ── 把手带（输入行上方一行；整条带可点开合浮层，箭头是居中视觉提示）──
    /// 把手带当前文案（**只含中性通知 `notice`**，见 [`handle_status_label`]）。
    /// 平台侧只存这一份：`paint_shell` 依据它决定圆点亮不亮 —— 圆点与文字
    /// 同生共死（空通知 = 空串 + 圆点不亮）；文案仍由 `update_status` 从快照写入。
    handle_status_label: String,
    // ── 浮层 Inspector（遮罩 + 浮层盒同一个子窗口；脱离布局流）──
    /// 浮层承载窗口：整块**消息流区域**（遮罩）+ 底部的浮层盒（绘制 + 内容子控件）。
    /// 独立子窗口而不是画在聊天窗上的原因：消息画布是子窗口，父窗口的绘制会被
    /// 子窗口盖住；遮罩必须盖住画布与其 RichEdit 才能阻断消息流的点击。
    inspector_layer: HWND,
    /// 浮层关闭「✕」（常驻控件，随浮层窗口显隐）。
    inspector_close: HWND,
    /// 浮层内容滚动裁剪窗（`INSPECTOR_SCROLL_CLASS`；常驻、随浮层显隐；
    /// 内容子控件的父窗口 = 它，滚动靠它裁剪 + 子控件按偏移移动）。
    inspector_scroll: HWND,
    /// 浮层内容子控件（父 = 滚动裁剪窗；坐标相对**内容原点**（滚动前），
    /// 布局时按滚动偏移平移）。
    inspector_children: Vec<ChildEntry>,
    /// 浮层内容**全高**（物理像素；按无上限摆放的 `layout_panels` 逻辑高换算 ——
    /// 内部滚动保证全部可达，不按上限跳过块）。
    inspector_content_height: i32,
    /// 浮层内容**可视区**高（物理像素；= min(全高, 上限)，布局时按盒几何夹取）。
    inspector_viewport_height: i32,
    /// 浮层内容纵向滚动偏移（物理像素；布局时统一钳制到 [0, 全高 − 可视高]）。
    inspector_scroll_y: i32,
    /// 浮层盒（浮层窗口客户区坐标；布局写入，绘制与「点盒外关闭」读取）。
    inspector_box: paint_win::Rect,
    /// 浮层是否开着，**直接来自 `ChatSnapshot::inspector_open`**（每次整帧同步；
    /// 布局在无快照的路径上读它）。平台层不翻转本地镜像 —— 开合由模型状态驱动。
    inspector_open: bool,
    // ── 会话历史锚定弹层（挂在标签条「历史」按钮下方；脱离布局流）──
    /// 弹层承载窗口（与浮层共用 `LAYER_CLASS`；盖住消息流区域，盒锚在层顶）。
    history_layer: HWND,
    /// 弹层内容子控件（父 = 弹层窗口；坐标相对盒内容原点）。
    history_children: Vec<ChildEntry>,
    /// 弹层盒高（物理像素；0 = 未开/无内容 → 层窗隐藏。「视图在不在快照里」
    /// 就是开合状态：模型只在 `history_open` 时推会话历史面板，不需要另存开关）。
    history_height: i32,
    /// 弹层盒（层窗客户区坐标；布局写入，绘制与「点盒外关闭」读取）。
    history_box: paint_win::Rect,
    // ── A3：聊天发图（选择/拖入 → 待发送区）──
    /// 输入行「图片」按钮（原生多选器入口；第三波起回到输入行）。
    pick_images: HWND,
    /// 输入区「发送」按钮（与 Enter 同一出口；空输入且无待发送图片时禁用）。
    send: HWND,
    /// 正文「↓ 新消息」跳转按钮（**真有未读新消息且不在底部**时才显示）。
    jump: HWND,
    /// 「↓ 新消息」的未读标记（平台显示态，2026-10-05 用户规则「真的算有新消息才
    /// 出现」）：**正文/流式版本号前进**且用户不在底部时置位（只看内容版本，
    /// 窗口缩放导致的重排不算）；滚/跳到视口底部清除；切会话清除。
    /// 只有这一个布尔事实，不发明未读数。
    jump_unread: bool,
    /// 上一次渲染消费的正文/流式版本号（未读判据的「有没有新内容」依据）。
    seen_transcript_revision: u64,
    seen_stream_revision: u64,
    /// 待发送条子控件（父窗口是聊天窗本体；坐标相对待发送条左上角）。
    pending_children: Vec<ChildEntry>,
    /// 待发送条高度（0 = 不显示；layout_panes_for 取用）。
    pending_height: i32,
    /// 待发送条目 ID 下标 → 原路径（每次重建整体替换）。
    pending_targets: Vec<String>,
    /// 待发送条内容总宽与横向滚动偏移（物理像素；重建/重排共用一套几何）。
    pending_content_w: i32,
    pending_scroll_x: i32,
    /// 上一次重建的条目数（新增条目时自动滚到最右，把刚加的图露出来）。
    pending_count: usize,
    /// 「本轮新增了条目」标志：`rebuild_pending` 置位、`layout_panes_for` 消费。
    pending_reveal_end: bool,
    // ── A1：会话标签条（仅 pane 模式；独立窗全为 0/空）──
    // 顶部顶栏带（品牌/状态位/关闭「×」）不在这里：归主窗的全窗宽顶栏。
    nav_new: HWND,
    nav_history: HWND,
    /// 标签条动态按钮（每次整帧重建时整体替换；y 由 layout 统一给）。
    tab_children: Vec<ChildEntry>,
    /// 会话按钮 ID 下标 → session id（切换与关闭按钮共用）。
    session_targets: Vec<String>,
    // ── 主题绘制（TOKEN 接线）──
    /// 条区矩形（`layout_panes_for` 每轮写入；`WM_PAINT` 读取）。
    paint: ChatPaintRects,
    /// 卡片框（用户/助手气泡；内容坐标，画布滚动时按 `scroll_y` 偏移）。
    card_frames: Vec<CardFrame>,
}

thread_local! {
    static CHAT: RefCell<Option<ChatWinState>> = const { RefCell::new(None) };
    static VIEWER: RefCell<Option<ViewerState>> = const { RefCell::new(None) };
    static DRAW_IMAGES: RefCell<HashMap<HWND, WinImageTarget>> = RefCell::new(HashMap::new());
    /// 待发送 chip 的缩略图（hwnd → 帧；`draw_themed_button` 的待发送分支读取）。
    /// 随控件换代：`rebuild_pending` 销毁条目时一并移除（旧句柄不留影）。
    static PENDING_THUMBS: RefCell<HashMap<HWND, DecodedFrame>> = RefCell::new(HashMap::new());
    static DEFERRED_PAINTS: RefCell<Vec<HWND>> = const { RefCell::new(Vec::new()) };
}

/// MoveWindow 的同步重绘可能发生在聊天重建持借用期间。仍完成 Begin/EndPaint，
/// 但排一次异步补画；否则空画后更新区被验证，条区/气泡底再也不会出现。
unsafe fn paint_chat_window(hwnd: HWND, paint: impl FnOnce(&ChatWinState, HDC)) {
    let mut ps = unsafe { std::mem::zeroed() };
    let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
    let painted = CHAT.with(|cell| {
        let Ok(slot) = cell.try_borrow() else {
            return false;
        };
        if let Some(state) = slot.as_ref() {
            paint(state, hdc);
        }
        true
    });
    unsafe { EndPaint(hwnd, &ps) };
    if !painted {
        DEFERRED_PAINTS.with(|pending| {
            let mut pending = pending.borrow_mut();
            if !pending.contains(&hwnd) {
                if unsafe { PostMessageW(hwnd, WM_APP_REPAINT, 0, 0) } != 0 {
                    pending.push(hwnd);
                } else {
                    rust_warn!("聊天窗口补绘消息投递失败");
                }
            }
        });
    }
}

fn repaint_deferred(hwnd: HWND) {
    discard_deferred_paint(hwnd);
    unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
}

fn discard_deferred_paint(hwnd: HWND) {
    DEFERRED_PAINTS.with(|pending| pending.borrow_mut().retain(|target| *target != hwnd));
}

struct ViewerState {
    hwnd: HWND,
    width: i32,
    height: i32,
    /// BGRA（StretchDIBits + BI_RGB，alpha 不参与合成）。
    bgra: Vec<u8>,
}

fn with_chat<F: FnOnce(&mut ChatWinState)>(f: F) {
    CHAT.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            if let Some(state) = state.as_mut() {
                f(state);
            }
        } else {
            // 有意跳过：只有“状态已被同一线程的可变借用占用”才会走到这里
            // （例如 RTF 流式回调嵌套在重建调用栈内）。留痕在 rust_debug，
            // 不改变任何 Win32 状态、也不吞用户数据。
            rust_debug!("聊天窗状态正被占用，本次访问跳过（重入保护）");
        }
    });
}

/// Rust 字符串 → UTF-16（含 NUL 结尾）。
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

/// 逻辑单位（面板布局几何）→ 物理像素。
fn scaled_f(value: f64, scale: f64) -> i32 {
    (value * scale).round() as i32
}

// ==========================================
// 子模块（大文件分层拆分；对外路径仍是 `windows_chat::…`）
// ==========================================

mod dialogs;
mod input;
mod layout;
mod paint;
mod panels;
#[cfg(test)]
mod tests;
mod transcript;
mod window;
mod wndproc;

// 拆分前的外部入口保持原路径（`platform/mod.rs` 以 `chat_imp` 别名导出）。
pub(crate) use dialogs::show_dialog;
pub(crate) use transcript::{
    apply_chat_font, apply_theme, chat_apply, clear_inline_previews, focus_main_pane_input,
    layout_main_pane, main_window_visibility_changed, mount_main_pane, set_main_pane_visible,
};
pub(crate) use window::{
    close_chat_window, close_viewer_window, install_viewer_content, note_viewer_destroyed,
    open_chat_window, open_viewer_window, paint_viewer, viewer_set_frame,
};
