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
use crate::{rust_debug, rust_info, rust_warn};

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

fn rect_is_empty(rect: &RECT) -> bool {
    rect.right <= rect.left || rect.bottom <= rect.top
}

fn rect_eq(a: &RECT, b: &RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

fn rect_w(rect: &RECT) -> i32 {
    (rect.right - rect.left).max(0)
}

fn rect_h(rect: &RECT) -> i32 {
    (rect.bottom - rect.top).max(0)
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
// 主题接线（颜色只从 `crate::ui::theme` 取；本文件不留第二份定义）
// ==========================================

/// 主题按钮：切换成 ownerdraw（自绘替代系统主题按钮）+ 写角色 + 装悬浮/圆角子类。
///
/// 创建后立即调用；半径取 `radii.btn` 的 DPI 值。用 `GWL_STYLE` 追加 `BS_OWNERDRAW`
/// 而不是在每处 `CreateWindowExW` 写样式：调用点只有「这是主题按钮」这一个事实，
/// 样式位（i32/u32 的符号差异）留在本函数一处处理。
///
/// **贴皮时机与 macOS 的对照（就地注明）**：Windows 按钮不存在「贴皮只盖旧尺寸」
/// 一类问题 —— 面/边/字在每次 `WM_DRAWITEM` 按控件**当前**矩形（`rcItem`）立即
/// 绘制；持久化的只有 `SetWindowRgn` 的圆角区域，由 `paint_win` 的按钮子类在
/// `WM_SIZE` 重贴（`apply_round_region`，创建后改尺寸的调用点因此天然安全）。
/// macOS 侧是 CALayer 子层按贴皮当时的 bounds 建、帧变化不跟随（本轮实机根因），
/// 平台手法不同，结果口径一致即可，不要照搬 macOS 的补贴守卫。
unsafe fn make_themed_button(hwnd: HWND, role: ButtonRole, scale: f64) {
    unsafe { make_themed_button_r(hwnd, role, scale, theme::tokens().radii.btn) };
}

/// 同上，半径显式给（chip 类小件用 `radii.sm`；0 = 不裁圆角）。
unsafe fn make_themed_button_r(hwnd: HWND, role: ButtonRole, scale: f64, radius: f32) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style | (BS_OWNERDRAW as isize));
    }
    paint_win::set_role(hwnd, role);
    paint_win::install_button(hwnd, scaled(radius.round() as i32, scale));
}

/// 给 STATIC 记录字色（`WM_CTLCOLORSTATIC` 按控件读回；见 paint_win 的存储约定）。
fn stamp_ink(hwnd: HWND, color: crate::ui::theme::Rgba) {
    paint_win::set_text_color(hwnd, color);
}

/// token 填充的代表色（渐变取 base）与面板底合成后的实色（sRGB 近似，见
/// paint_win 模块头的取舍）。**单一来源**：承载控件的 `EM_SETBKGNDCOLOR`
/// （[`rich_bg`]）与画布上的卡片/气泡填充用同一个值，控件与画布的接缝不可见。
fn flat_over_panel(fill: &crate::ui::theme::Fill) -> crate::ui::theme::Rgba {
    paint_win::composite_over(fill_mid(fill), theme::tokens().panel_bg.base_color())
}

/// 渐变 token 在「只能吃单色」的出口（RichEdit 底、`WM_CTLCOLOR` 画刷）上的代表色：
/// 取**渐变中点**而不是首档。
///
/// 首档（[`crate::ui::theme::Fill::base_color`]）是渐变的顶部色，拿它当代表色会系统性
/// 偏亮 —— 2026-10-07 实拍：Chrome 输入框 `--fbg` 首档是纯白，RichEdit 直接吃成
/// (255,255,255) 的方白块，而 mac 侧同一控件是 `#FFFFFF→#E7EFF7` 的竖向渐变
/// （录制实测均值 ≈(237,243,248)，`test/.tmp/win-ui-align/ref/theme-1/frame-0101.png`）。
/// 取中点后单色块与 mac 的观感对齐；气泡同族（`--aibg` 等）走同一口径。
fn fill_mid(fill: &crate::ui::theme::Fill) -> crate::ui::theme::Rgba {
    use crate::ui::theme::{Fill, Rgba};
    fn sample(stops: &[(f32, Rgba)], t: f32) -> Rgba {
        let Some(&(_, first)) = stops.first() else {
            return Rgba::black_alpha(1.0);
        };
        if stops.len() == 1 {
            return first;
        }
        let mut prev = (0.0_f32, first);
        for &(pos, color) in &stops[1..] {
            if t <= pos {
                let span = (pos - prev.0).max(f32::EPSILON);
                let k = ((t - prev.0) / span).clamp(0.0, 1.0);
                return Rgba::rgba(
                    prev.1.r + (color.r - prev.1.r) * k,
                    prev.1.g + (color.g - prev.1.g) * k,
                    prev.1.b + (color.b - prev.1.b) * k,
                    prev.1.a + (color.a - prev.1.a) * k,
                );
            }
            prev = (pos, color);
        }
        prev.1
    }
    match fill {
        Fill::Solid(color) => *color,
        Fill::Linear(stops) | Fill::Striped { stops, .. } => sample(stops, 0.5),
        // 径向渐变的兜底色沿用 `base_color` 的口径（末档），与 GDI 端的实色兜底一致。
        Fill::Radial { .. } => fill.base_color(),
    }
}

/// RichEdit 底色 = token 的代表色与面板底合成（RichEdit 不能透明，渐变只能取
/// 代表色；见 [`flat_over_panel`]）。
fn rich_bg(fill: &crate::ui::theme::Fill) -> u32 {
    paint_win::colorref(flat_over_panel(fill))
}

/// `RECT`（windows-sys）→ [`paint_win::Rect`]。
fn win_rect_of(rect: &RECT) -> paint_win::Rect {
    paint_win::Rect::new(rect.left, rect.top, rect_w(rect), rect_h(rect))
}

/// 中性提示底：把 `color` 以 `alpha` 叠到面板底上（RichEdit 无 alpha，先合成实色）。
fn rich_bg_alpha(color: crate::ui::theme::Rgba, alpha: f32) -> u32 {
    let panel = theme::tokens().panel_bg.base_color();
    paint_win::colorref(paint_win::composite_over(color.with_alpha(alpha), panel))
}

/// 遮罩色（浮层打开时压住消息流）：token 表没有 `--scrimc`（设计稿注明它是页面级
/// 扩展变量、只服务设计稿页面），按设计稿两版口径从 `tokens.dark` 分档派生 ——
/// 深色近黑、浅色近白。色值只此一处（两个常量带设计稿出处）。
fn scrim_color(tokens: &'static theme::Tokens) -> theme::Rgba {
    if tokens.dark {
        theme::Rgba::black_alpha(INSPECTOR_SCRIM_ALPHA_DARK)
    } else {
        theme::Rgba::white_alpha(INSPECTOR_SCRIM_ALPHA_LIGHT)
    }
}

/// 遮罩的实色（GDI 子窗口之间没有 alpha 合成通路；与面板底预合成后整面填实色，
/// 就地注明的近似 —— 消息流被压暗/提亮而不是像 macOS 那样隐约透出）。
fn scrim_flat(tokens: &'static theme::Tokens) -> theme::Rgba {
    paint_win::composite_over(scrim_color(tokens), tokens.panel_bg.base_color())
}

/// 当前主题的 RTF 颜色表（`{\colortbl;...}`；索引见 `RTF_*` 常量）。
struct RtfPalette {
    table: String,
}

fn rtf_palette() -> RtfPalette {
    let t = theme::tokens();
    let entry = |c: crate::ui::theme::Rgba| {
        format!(
            "\\red{}\\green{}\\blue{};",
            (c.r.clamp(0.0, 1.0) * 255.0).round() as u32,
            (c.g.clamp(0.0, 1.0) * 255.0).round() as u32,
            (c.b.clamp(0.0, 1.0) * 255.0).round() as u32,
        )
    };
    let code_bg = paint_win::composite_over(t.field_bg.base_color(), t.panel_bg.base_color());
    RtfPalette {
        table: format!(
            "{{\\colortbl;{}{}{}{}{}{}{}}}",
            entry(t.accent),
            entry(t.dim),
            entry(t.ink),
            entry(t.bubble_user_ink),
            entry(t.warn),
            entry(t.tool_ink),
            entry(code_bg),
        ),
    }
}

/// 聊天窗底：面板底 + 纹理层 + 细颗粒 + 各条区（子控件随后覆盖）。
///
/// **未在 Windows 实机验证**（同模块头约定）。
unsafe fn paint_shell(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.hwnd, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    // 先影后物：面板投影先画（`elevation_bands` 是外扩矩形），面板底填覆盖其内侧；
    // 层序与 macOS `paint_backdrop` 一致（影 → 底 → 纹理 → 颗粒 → 描边/立体线）。
    paint_win::draw_elevation(hdc, full, &t.panel_shadow);
    paint_win::fill_rect(hdc, full, &t.panel_bg);
    if let Some(sheen) = t.panel_tex {
        paint_win::draw_sheen(hdc, full, &sheen);
    }
    if let Some(alpha) = t.panel_grain {
        paint_win::draw_texture(hdc, full, ThemeTex::Grain, alpha);
    }
    unsafe {
        let scale = dpi_scale(state.hwnd);
        // 顶栏带（本窗这份 = 投影承载面 + 带底衬）+ 标签条（仅主窗面板模式；
        // 独立聊天窗保留系统 chrome）。
        // 标签条先画：顶栏投影（下一条）的露头 1px 要落在它上面（先物后影）。
        if !rect_is_empty(&state.paint.tabs) {
            let tabs = win_rect_of(&state.paint.tabs);
            paint_win::fill_color(hdc, tabs, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(tabs.x, tabs.bottom() - 1, tabs.w, 1),
                t.bar_edge,
            );
            // 条区自绘按钮的「所在面」实色 = 条区**实际画出来的**像素（含 sheen/颗粒
            // 与 `strip_bg` 叠加）。不采样就只能拿 `panel_bg` 猜 —— 它比条区暗 ~35
            // 灰阶，ownerdraw 按钮的圆角补角会在四角留下深色方块（用户 2026-10-07
            // 实拍「按钮黑色方角」）。同一函数里刚画完，取到的就是最终可见色。
            unsafe {
                // 探针取**条区中部**：`tabs.x + 2` 落在聊天列左缘的描边/立体线上，
                // 采到的是比条底亮 ~5 灰阶的边线色 —— 自绘按钮的圆角补角用它就会
                // 在药丸四周露出一个浅色矩形（用户 2026-10-07 实拍「新会话后面有
                // 矩形灰底」）。
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (tabs.x + tabs.w / 2, tabs.y + tabs.h / 2),
                    &[state.nav_new, state.nav_history],
                );
                let tab_hwnds: Vec<HWND> = state.tab_children.iter().map(|c| c.hwnd).collect();
                // 同一探针口径：条区中部（`tabs.x + 2` 会采到左缘描边色，见上）。
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (tabs.x + tabs.w / 2, tabs.y + tabs.h / 2),
                    &tab_hwnds,
                );
            }
        }
        if !rect_is_empty(&state.paint.bar) {
            let bar = win_rect_of(&state.paint.bar);
            // 顶栏外投影（`--barsh` 的非 inset 部分；只有铜绿有声明的 `var(--contact)`）。
            // **画在这里而不是顶栏自己的窗口**：顶栏子窗口不能把 GDI 像素画到客户区外，
            // 而聊天窗 DC 向下延伸到标签条 —— 投影带落在条下 1px 处、叠在标签条上可见
            //（先物后影：上面已先画过标签条）。
            // 条底/立体线/下边线/圆点与投影同为这条带的主题绘制（2026-10-06 接线）：
            // 顶栏子窗口在最上另画一份同带内容（它盖住本窗这 26px），本窗这份是
            // 投影的承载面与带底衬；几何/取值都来自 `ui::titlebar` 与主题 token，
            // 不落第二份定义。
            // 舞台列那一半（分层渲染表面，不参与 GDI 主题绘制）没有对应画点，如实登记差异。
            paint_win::draw_elevation(hdc, bar, &t.bar_shadow);
            paint_win::fill_rect(hdc, bar, &t.bar_bg);
            paint_win::draw_bevel(hdc, bar, &t.bar_bevel);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(bar.x, bar.bottom() - 1, bar.w, 1),
                t.bar_edge,
            );
            // 状态位前的强调圆点（`--acc`；设计稿 `.status i` 在状态文字左侧）。
            // 起点与状态位锚点同源（`ui::titlebar::status_x`）。
            paint_win::draw_dot(
                hdc,
                scaled_f(crate::ui::titlebar::status_x(), scale) - scaled(10, scale),
                bar.y + bar.h / 2,
                scaled_f(crate::ui::titlebar::DOT_SIZE / 2.0, scale),
                t.accent,
                t.bar_bg.base_color(),
            );
        }
        if !rect_is_empty(&state.paint.panels) {
            let panels = win_rect_of(&state.paint.panels);
            paint_win::fill_color(hdc, panels, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(panels.x, panels.y, panels.w, 1),
                t.bar_edge,
            );
        }
        // composer 的整块面（`--ibg`）先铺：macOS 侧它覆盖**待发送条 + 把手带 +
        // 输入行**（`macos_chat.rs::relayout_panes` 的 `composer_top_from_bands`），
        // 把手带不再是独立的一条灰带 —— 它就是 composer 的上部（用户 2026-10-07
        // 实拍「输入框上面那个和 mac 根本不一样」）。条区内其它元素（待发送条、
        // 把手状态、箭头）都画在这块面之上，顺序不能反。
        if !rect_is_empty(&state.paint.input_bar) {
            let input_bar = win_rect_of(&state.paint.input_bar);
            paint_win::fill_rect(hdc, input_bar, &t.input_bar_bg);
            // 输入行按钮的所在面同理：按**输入行中心那一行**的实色采样（composer 是
            // 竖向渐变，按钮四角跨十几像素，取按钮中心行最接近）。
            let row_h = scaled(INPUT_HEIGHT, scale);
            let row_y = input_bar.bottom() - row_h + row_h / 2;
            unsafe {
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (input_bar.x + 2, row_y),
                    &[state.stop, state.pick_images, state.send],
                );
            }
        }
        if !rect_is_empty(&state.paint.pending) {
            // 待发送条（设计稿 `.pend`：`--fbg2` 底 + **底边** `--bare` 与输入行分隔）；
            // 它是 composer 的顶块（composer 面已在上面铺过）—— 顶边线用 `--iedge`
            //（设计稿 `.composer` 的 `border-top`），底边线与「无待发送条时」画在
            // 输入条顶的那条线同源。
            let pending = win_rect_of(&state.paint.pending);
            paint_win::fill_color(hdc, pending, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(pending.x, pending.y, pending.w, 1),
                t.input_bar_edge,
            );
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(pending.x, pending.bottom() - 1, pending.w, 1),
                t.bar_edge,
            );
            // 横向滚动指示（2026-10-06「多张截图不能滚动」的可见性提示）：只在内容
            // 超宽时画 —— 条底极细的 track + 按滚动比例的 thumb，**画在既有条高之内**
            //（不新增布局高度，输入区不会因它跳动）。Windows 没有 macOS 的 overlay
            // 滚动条，这条细指示是「右边还有、可以滚」的用户可见信号。
            if state.pending_content_w > pending.w {
                let thickness = scaled(PENDING_SCROLLBAR_THICKNESS, scale).max(1);
                let track_y = pending.bottom() - thickness - scaled(1, scale);
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(pending.x, track_y, pending.w, thickness),
                    t.bar_edge,
                );
                let ratio = f64::from(pending.w) / f64::from(state.pending_content_w);
                // 下限兜底：thumb 不小于 4 倍厚度，但不允许超过条宽（极窄条不 panic）。
                let min_thumb = (thickness * 4).min(pending.w).max(thickness);
                let thumb_w =
                    ((f64::from(pending.w) * ratio).round() as i32).clamp(min_thumb, pending.w);
                let max_scroll = (state.pending_content_w - pending.w).max(1);
                let progress =
                    (f64::from(state.pending_scroll_x) / f64::from(max_scroll)).clamp(0.0, 1.0);
                let travel = (pending.w - thumb_w).max(0);
                let thumb_x = pending.x + (f64::from(travel) * progress).round() as i32;
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(thumb_x, track_y, thumb_w, thickness),
                    t.dim,
                );
            }
        }
        if !rect_is_empty(&state.paint.input_bar) {
            let input_bar = win_rect_of(&state.paint.input_bar);
            // composer 上边线（设计稿 `.rail{border-top:1px solid var(--bare)}`）：
            // macOS 用**亮边** `bar_edge` 贴住 composer 上沿（`macos_chat.rs` 的
            // `apply_line(Top, bar_edge)`，用户规则「这个白边应该贴着下面」）。
            // 旧实现画的是 `input_bar_edge`（同主题下明显更深的灰蓝），实机上就是
            // 输入框上方那道扎眼的分隔线。
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(input_bar.x, input_bar.y, input_bar.w, 1),
                t.bar_edge,
            );
        }
        // 把手带（composer 上部那条行）：**不画底、不画线**，只画左侧状态点与
        // 状态文字、中置上拉箭头 —— 与 macOS「把手带只是「状态文字 + 箭头 +
        // 整条可点」的行」同口径。三件全部**单面绘制**：子控件（STATIC/按钮）
        // 是不透明表面，各自会把自己那块铺成异色板（2026-10-07 实机：「灰板 +
        // 白方块 + 竖条箭头」）。带区仍有独立命中区（开合浮层），只是不着色。
        // 带坐在 composer 顶段（渐变首档附近）：圆点边缘的预合成底与箭头的
        // 半透明 ink 都按这个实色近似（GDI 画刷没有 alpha，与 mac 的
        // `ink.with_alpha(0.72)` / CALayer 合成同口径的实色等价）。
        let composer_flat = t.input_bar_bg.base_color();
        if !rect_is_empty(&state.paint.handle) {
            let handle = win_rect_of(&state.paint.handle);
            // 圆点与文字同生共死（与 macOS `update_status` 的 `setHidden` 同口径）：
            // 没有通知时不亮一个看起来像「在线」的常亮点。
            if handle_status_dot_visible(&state.handle_status_label) {
                paint_win::draw_dot(
                    hdc,
                    scaled(HANDLE_STATUS_PAD_X + HANDLE_STATUS_DOT_RADIUS, scale),
                    handle.y + handle.h / 2,
                    scaled(HANDLE_STATUS_DOT_RADIUS, scale),
                    t.accent,
                    composer_flat,
                );
            }
            // 状态文字：只显示中性通知（[`handle_status_label`]），左对齐在
            // 圆点之后；字体与字色复用静态文字的小号/`dim` 口径。
            if !state.handle_status_label.is_empty() && !rect_is_empty(&state.paint.handle_status) {
                let font = state.fonts.get(1).copied().unwrap_or(0);
                let old = if font != 0 {
                    unsafe { SelectObject(hdc, font) }
                } else {
                    0
                };
                let text = wide(&state.handle_status_label);
                // `DrawTextW` 收 windows-sys 的 `RECT`（不是 `paint_win::Rect`）。
                let mut rect = {
                    let r = win_rect_of(&state.paint.handle_status);
                    RECT {
                        left: r.x,
                        top: r.y,
                        right: r.right(),
                        bottom: r.bottom(),
                    }
                };
                unsafe {
                    SetBkMode(hdc, TRANSPARENT);
                    SetTextColor(hdc, paint_win::colorref(t.dim));
                    DrawTextW(hdc, text.as_ptr(), -1, &mut rect, STATUS_TEXT_FLAGS);
                    if old != 0 {
                        SelectObject(hdc, old);
                    }
                }
            }
        }
        // 上拉箭头（▴ 合着 / ▾ 开着）：画的是三角而不是字形 —— 字体对 U+25B4/25BE
        // 的覆盖不可靠（2026-10-07 实机：▴ 被画成一根竖条），且子按钮的面会盖住
        // composer 渐变。字形框仍来自共享 `handle_arrow_frame`（10×10 居中）。
        if !rect_is_empty(&state.paint.handle_arrow) {
            let glyph = win_rect_of(&state.paint.handle_arrow);
            let up = handle_arrow_up(state.inspector_open);
            // 三角按 mac 录制的**实测量级**收小：录制帧里 ▴ 的 bbox 只有
            // 5×4px（藏在共享 `handle_arrow_frame` 的 10×10 字形框里居中），
            // 颜色是对应的 `dim`（实测 (99,108,121) ≈ dim 预合成在 composer 上）。
            // 旧实现按整框铺满 + `ink` 72% 预合成，实机明显比 mac 大一倍、黑一档。
            let half_w = (glyph.w / 5).max(2);
            let half_h = (glyph.h / 5).max(2);
            let cx = glyph.x + glyph.w / 2;
            let cy = glyph.y + glyph.h / 2;
            let (a, b, c) = if up {
                (
                    (cx, cy - half_h),
                    (cx - half_w, cy + half_h),
                    (cx + half_w, cy + half_h),
                )
            } else {
                (
                    (cx, cy + half_h),
                    (cx - half_w, cy - half_h),
                    (cx + half_w, cy - half_h),
                )
            };
            paint_win::fill_triangle(hdc, [a, b, c], t.dim);
        }
        if !rect_is_empty(&state.paint.input_field) {
            let field = win_rect_of(&state.paint.input_field);
            // 圆角取 `radii.sm`（设计稿 `.inp .ph` 的 `--r1`，2026-10-05 用户规则
            // 「圆角一律取 radii」）；承载 RichEdit 与占位 STATIC 贴同半径区域，
            // 直角不会盖住圆弧描边（见 `apply_input_round_regions`）。
            // 承载控件已按 2px 内缩（布局里做），描边与立体线在环形区露出来。
            paint_round_input_field(hdc, field, scaled_f(f64::from(t.radii.sm), scale));
        }
        // 面板外描边（中性 `outline`，同 macOS：设计稿 `.chat` 的边界是 `--outline`）
        // + 内立体线（`panel_bevel`）；画在最后 = macOS CALayer border 的最外层。
        // 条内按钮的投影（`paint_button_shadows`）先于描边：它只落在条面上，
        // 不压面板描边。
        let mut shadow_targets: Vec<HWND> = vec![state.nav_new, state.nav_history];
        shadow_targets.extend(state.tab_children.iter().map(|child| child.hwnd));
        shadow_targets.extend([state.stop, state.pick_images, state.send]);
        shadow_targets.extend(state.pending_children.iter().map(|child| child.hwnd));
        paint_button_shadows(hdc, state.hwnd, &shadow_targets);
        paint_win::draw_frame(hdc, full, t.outline, &t.panel_bevel);
    }
}

/// 正文画布底：面板底 + 纹理 + 消息流内阴影 + 卡片框（内容坐标按 `scroll_y` 偏移）。
unsafe fn paint_canvas_shell(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.canvas, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    paint_win::fill_rect(hdc, full, &t.panel_bg);
    if let Some(sheen) = t.panel_tex {
        paint_win::draw_sheen(hdc, full, &sheen);
    }
    if let Some(alpha) = t.panel_grain {
        paint_win::draw_texture(hdc, full, ThemeTex::Grain, alpha);
    }
    if let Some(inset) = t.log_inset {
        paint_win::draw_inset(hdc, full, &inset, true);
    }
    // 聊天列的左右外描边（`--outline`）：画布从聊天窗客户区 x=0 起、横跨整列，
    // `paint_shell` 末尾 `draw_frame(full, …)` 的左右两列被它盖住 —— 于是
    // **舞台列与聊天列之间那条分界线**（mac 侧由 `DIVIDER_WIDTH` 分隔条右缘
    // 的 1px `outline` 承担，见 `macos_main::paint_divider`）与右窗沿都会丢
    //（用户 2026-10-07 实拍「细分割线没了」）。这里按同一 token 补回，不另造常量。
    paint_win::fill_color(hdc, paint_win::Rect::new(0, 0, 1, full.h), t.outline);
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(full.w - 1, 0, 1, full.h),
        t.outline,
    );
    for frame in &state.card_frames {
        let rect = paint_win::Rect::new(
            frame.rect.left,
            frame.rect.top - state.scroll_y,
            rect_w(&frame.rect),
            rect_h(&frame.rect),
        );
        if rect.is_empty() || rect.bottom() < 0 || rect.y > full.h {
            continue;
        }
        match frame.kind {
            CardKind::UserBubble => {
                paint_win::draw_elevation(hdc, rect, &t.bubble_user_shadow);
                // 泡底由画布填（泡内留白区不再被承载控件盖住，见 `create_rtf_control`
                // 的 inset）：与控件底同值，接缝不可见。
                let rounded = unsafe {
                    with_round_box(
                        hdc,
                        rect,
                        scaled_f(f64::from(t.radii.md), dpi_scale(state.canvas)),
                        t.bubble_user_edge,
                        || {
                    paint_win::fill_color(hdc, rect, flat_over_panel(&t.bubble_user_bg));
                    paint_win::draw_bevel(hdc, rect.deflate(1), &t.bubble_user_bevel);
                        },
                    )
                };
                if !rounded {
                    // 绘制期逐控件回落（保留方角描边）：静默——降噪 2026-10-08 用户裁定
                    // （稳态留痕会随重绘刷屏）；绘制端回落由实机像素取证覆盖。
                    paint_win::draw_frame(hdc, rect, t.bubble_user_edge, &t.bubble_user_bevel);
                }
            }
            CardKind::AssistantBubble => {
                // 轻气泡：无投影、无立体线（`Bevel::NONE`），只有底 + 描边。
                let rounded = unsafe {
                    with_round_box(
                        hdc,
                        rect,
                        scaled_f(f64::from(t.radii.md), dpi_scale(state.canvas)),
                        t.bubble_ai_edge,
                        || {
                    paint_win::fill_color(hdc, rect, flat_over_panel(&t.bubble_ai_bg));
                        },
                    )
                };
                if !rounded {
                    // 绘制期逐控件回落（保留方角描边）：静默——降噪 2026-10-08 用户裁定
                    // （稳态留痕会随重绘刷屏）；绘制端回落由实机像素取证覆盖。
                    paint_win::draw_frame(hdc, rect, t.bubble_ai_edge, &Bevel::NONE);
                }
            }
        }
    }
    // 「↓ 新消息」按钮（聊天窗的子窗，悬在画布之上）的接触影：它下方可见的表面
    // 就是这条画布，母通道按同一口径补（同 `paint_button_shadows` 的 why）。
    paint_button_shadows(hdc, state.canvas, &[state.jump]);
}

// ==========================================
// 浮层 Inspector：绘制与窗口过程（几何/派发的纯逻辑见下方「纯函数」段）
// ==========================================

/// 浮层窗口绘制：先整面遮罩、再（投影 + 圆角浮层盒）。
///
/// **未在 Windows 实机验证**（同模块头约定）。两处 GDI 近似就地注明：
/// - 遮罩是**实色**（子窗口之间没有 alpha 合成通路；颜色 = `--scrimc` 口径色
///   与面板底预合成，见 [`scrim_flat`]）；
/// - 盒的投影先按方角矩形画，再用遮罩色把盒矩形整个抹一遍、最后补圆角盒 ——
///   不然投影的方角会从圆角外侧的缺口露出来（盒外沿以方角矩形为界，与设计稿
///   「阴影只在盒外」一致；多一次实色填充，代价可忽略）。
unsafe fn paint_inspector_layer(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.inspector_layer, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    let scrim = scrim_flat(t);
    let scale = dpi_scale(state.hwnd);
    unsafe {
        // 1) 遮罩：整个消息流区域压一层实色。
        paint_win::fill_color(hdc, full, scrim);
        let panel_box = state.inspector_box;
        if panel_box.is_empty() {
            return;
        }
        // 2) 投影 + 抹掉盒矩形（先影后物；理由见函数注释）。
        paint_win::draw_elevation(hdc, panel_box, &t.panel_shadow);
        paint_win::fill_color(hdc, panel_box, scrim);
        // 3) 圆角盒（底 + 标题行 + 内立体线 + 沿轮廓的 1px 描边）。
        // 圆角取 `radii.md`（设计稿 `.insp{border-radius:var(--r2)}` 的「大件」档）。
        paint_inspector_box(
            hdc,
            panel_box,
            scaled_f(f64::from(t.radii.md), scale),
            scaled(INSPECTOR_HEADER_HEIGHT, scale),
        );
        // 浮层内自绘按钮的接触影：按钮自己的 DC 画不出窗口外（见
        // `paint_button_shadows`），由层窗这条父通道补。
        let mut targets: Vec<HWND> = vec![state.inspector_close];
        targets.extend(state.inspector_children.iter().map(|child| child.hwnd));
        paint_button_shadows(hdc, state.inspector_layer, &targets);
    }
}

/// 会话历史弹层绘制：与浮层同款（整面遮罩 + 圆角盒），只是盒**没有标题行**
/// （标题由面板内容自己给：「会话历史」是视图的第一行）且锚在层顶。
/// 手法与近似同 [`paint_inspector_layer`]（实色遮罩、方角投影先画后抹）。
unsafe fn paint_history_layer(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.history_layer, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    let scrim = scrim_flat(t);
    let scale = dpi_scale(state.hwnd);
    unsafe {
        paint_win::fill_color(hdc, full, scrim);
        let panel_box = state.history_box;
        if panel_box.is_empty() {
            return;
        }
        paint_win::draw_elevation(hdc, panel_box, &t.panel_shadow);
        paint_win::fill_color(hdc, panel_box, scrim);
        // header_h = 0：不画标题行（内容自带标题行）。
        paint_inspector_box(hdc, panel_box, scaled_f(f64::from(t.radii.md), scale), 0);
        // 弹层内自绘按钮的接触影（父通道；同 `paint_inspector_layer`）。
        let targets: Vec<HWND> = state
            .history_children
            .iter()
            .map(|child| child.hwnd)
            .collect();
        paint_button_shadows(hdc, state.history_layer, &targets);
    }
}

/// 圆角浮层盒：GDI 没有圆角填充原语，用 `CreateRoundRectRgn` + `SelectClipRgn`
/// 裁剪后走既有 `paint_win` 原语（渐变/alpha 通路不变），描边走 `FrameRgn`
/// （区域轮廓自带四角圆弧段）——与 ownerdraw 按钮的 `SetWindowRgn` 同属「区域裁剪」
/// 这一族，不引入新依赖。区域建失败退化为方角绘制（留痕不静默）。
///
/// **实机核验点**（本机无 Windows 工具链）：`AlphaBlend`/`GradientFill` 是否遵守
/// DC 的圆角裁剪区 —— GDI 绘制原语统一受裁剪约束，预期成立；若不成立，症状是
/// 盒底/标题行在四角溢出一圈方角。**不赌裁剪行为**：绘制后由
/// [`corner_notch_over_scrim`] 把「方角内、圆弧外」的缺口刷回遮罩色。
///
/// 与 macOS 的对照（就地注明）：macOS 实机见过的「浮层左上角灰色矩形」根因是
/// 绘制子层按贴皮当时的 bounds 建、之后只改 frame 不重贴；Windows 是立即模式
/// 逐帧重画（每次 WM_PAINT 按当前盒几何重铺遮罩 + 盒），没有可残留的子层 ——
/// 同形不同源，这里的净化只针对上面那条裁剪核验点。
unsafe fn paint_inspector_box(hdc: HDC, panel_box: paint_win::Rect, radius: i32, header_h: i32) {
    let t = theme::tokens();
    if panel_box.is_empty() {
        return;
    }
    let ok = unsafe {
        with_round_box(hdc, panel_box, radius, t.outline, || {
            // 盒底（`--pbg`，Fill 的渐变/条纹通路与面板其余部分一致）。
            paint_win::fill_rect(hdc, panel_box, &t.panel_bg);
            // 标题行（设计稿 `.insph`：`--bar` 底 + `--bare` 底线 + `--barsh` 内立体线）。
            let head_h = header_h.clamp(0, panel_box.h);
            if head_h > 0 {
                let head = paint_win::Rect::new(panel_box.x, panel_box.y, panel_box.w, head_h);
                paint_win::fill_rect(hdc, head, &t.bar_bg);
                paint_win::draw_bevel(hdc, head, &t.bar_bevel);
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(head.x, head.bottom() - 1, head.w, 1),
                    t.bar_edge,
                );
            }
            // 盒内立体线（`--pshadow` 的 inset 段，与面板同一份 `panel_bevel`）。
            paint_win::draw_bevel(hdc, panel_box.deflate(1), &t.panel_bevel);
        })
    };
    if !ok {
        // 绘制期逐帧回落（退化为方角绘制）：静默——降噪 2026-10-08 用户裁定
        // （稳态留痕会随每次重绘刷屏）；绘制端回落由实机像素取证覆盖。
        unsafe { paint_win::draw_frame(hdc, panel_box, t.outline, &Bevel::NONE) };
        return;
    }
    // 四角净化（见函数注释）：圆弧外侧露出的方角缺口统一刷回遮罩色。
    unsafe { corner_notch_over_scrim(hdc, panel_box, radius) };
}

/// 圆角盒的「四角净化」：把**方角矩形内、圆角区域外**的四个缺口重刷成遮罩色。
///
/// 为什么需要：盒体绘制里含**渐变填充**（标题行 `bar_bg`）与 **alpha 立体线**，
/// 它们是否严格遵守 `SelectClipRgn` 的圆角裁剪是本文件登记的实机核验点（本机无
/// Windows 工具链）；圆弧外侧的缺口本来应是「盒外的遮罩色」（方角抹除步骤留下的），
/// 但若上述原语不受裁剪，方角就会从圆弧外侧露出来（用户报告「弹层左上角矩形
/// 残影」的形态）。这里不赌行为：按「方角 − 圆角」的差集把缺口再刷一遍 ——
/// 与盒外同色，圆弧外侧无论裁剪是否生效都只会是遮罩色。
///
/// 区域建不出去/差集失败（极罕见，内存压力）时跳过本帧、保持绘制顺序原样：
/// 这是纯加固步骤，不吞内容也不改盒体本身的绘制；逐帧绘制路径不刷 warn 级，
/// 留痕走统一的 `rust_debug!`（同族的盒体绘制 `with_round_box` 的建失败回落
/// 自 2026-10-08 起也已静默降噪，见那里的注释）。
unsafe fn corner_notch_over_scrim(hdc: HDC, rect: paint_win::Rect, radius: i32) {
    unsafe {
        // 区域边界与 `with_round_box` 同口径（右/下各 +1：GDI 区域不含右/下边界，
        // 两形取差集得到的正是四个角缺口）。
        let square = CreateRectRgn(rect.x, rect.y, rect.right() + 1, rect.bottom() + 1);
        let round = CreateRoundRectRgn(
            rect.x,
            rect.y,
            rect.right() + 1,
            rect.bottom() + 1,
            (radius * 2).max(1),
            (radius * 2).max(1),
        );
        // 差集的目标区域先给一个占位（CombineRgn 会整体替换它）。
        let notch = CreateRectRgn(0, 0, 1, 1);
        if square == 0 || round == 0 || notch == 0 {
            rust_debug!("浮层四角净化区域创建失败，本帧跳过（框体保持既有裁剪行为）");
        } else if CombineRgn(notch, square, round, RGN_DIFF) != 0 {
            // 非 0 = 有效结果（NULLREGION / SIMPLEREGION / COMPLEXREGION 都可用；
            // 0 = ERROR，此时区域未更新，不刷）。
            FillRgn(
                hdc,
                notch,
                paint_win::solid_brush(scrim_flat(theme::tokens())),
            );
        } else {
            rust_debug!("浮层四角净化差集失败（CombineRgn = ERROR），本帧跳过");
        }
        for region in [square, round, notch] {
            if region != 0 {
                DeleteObject(region);
            }
        }
    }
}

/// 圆角盒的两段式绘制（GDI 没有圆角填充原语）：`CreateRoundRectRgn` + `SelectClipRgn`
/// 后在裁剪内执行 `draw_inside`（既有 `paint_win` 填充原语，渐变/alpha 通路不变）；
/// 撤裁剪后用 `FrameRgn` 沿区域轮廓描 1px `edge`（四角圆弧段由区域自带）。
///
/// 返回是否成功建区；区域创建失败（极罕见）时 `draw_inside` 照常执行（方角绘制，
/// 不静默丢内容），由调用方补方角描边。
/// **实机核验点**（本机无 Windows 工具链）：`AlphaBlend`/`GradientFill` 是否遵守
/// DC 的圆角裁剪区 —— GDI 绘制原语统一受裁剪约束，预期成立；若不成立，症状是
/// 内容在四角溢出一圈方角（兜底：改 `FillRgn` + 实色的平铺口径）。
unsafe fn with_round_box(
    hdc: HDC,
    rect: paint_win::Rect,
    radius: i32,
    edge: crate::ui::theme::Rgba,
    draw_inside: impl FnOnce(),
) -> bool {
    if rect.is_empty() {
        return false;
    }
    let region = unsafe {
        CreateRoundRectRgn(
            rect.x,
            rect.y,
            rect.right() + 1,
            rect.bottom() + 1,
            (radius * 2).max(1),
            (radius * 2).max(1),
        )
    };
    if region != 0 {
        unsafe { SelectClipRgn(hdc, region) };
    }
    draw_inside();
    if region != 0 {
        // 撤裁剪再补轮廓描边；随后释放区域（此时已不参与任何绘制，可安全删除）。
        unsafe {
            SelectClipRgn(hdc, 0);
            let brush = paint_win::solid_brush(edge);
            FrameRgn(hdc, region, brush, 1, 1);
            DeleteObject(region);
        }
        true
    } else {
        false
    }
}

/// 输入框槽的圆角绘制（底 + 描边 + 内立体线；设计稿 `.inp .ph` 的 `--r1`）。
/// 圆角手法同 [`with_round_box`]；**未在 Windows 实机验证**（同模块头约定）。
unsafe fn paint_round_input_field(hdc: HDC, rect: paint_win::Rect, radius: i32) {
    let t = theme::tokens();
    let ok = unsafe {
        with_round_box(hdc, rect, radius, t.field_edge, || {
            paint_win::fill_rect(hdc, rect, &t.field_bg);
            paint_win::draw_bevel(hdc, rect.deflate(1), &t.field_bevel);
        })
    };
    if !ok {
        unsafe { paint_win::draw_frame(hdc, rect, t.field_edge, &t.field_bevel) };
    }
}

/// 给承载控件贴圆角窗口区域（`SetWindowRgn`；半径物理像素，0/失败不动）。
///
/// 与 `paint_win::install_button` 的区域装配同一份所有权约定（成功时区域归系统、
/// 失败时自释放）；那边服务 ownerdraw 按钮、这里服务输入区与只读正文，不复制
/// 其整段子类装配。尺寸没变的重复调用是幂等的，但会触发一次重绘 —— 调用点只在
/// 几何/主题变化时进（见 `layout_panes_for` 的 `strips_changed` 分支与 `apply_theme`）。
unsafe fn set_round_region(hwnd: HWND, radius_px: i32) {
    unsafe {
        if hwnd == 0 || radius_px <= 0 {
            return;
        }
        // 用**窗口矩形**而不是客户区：区域坐标是窗口坐标系，输入框带
        // `WS_EX_CLIENTEDGE`（客户区比窗口小 2px×2），按客户区尺寸会裁掉右/下边。
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        if w <= 0 || h <= 0 {
            return;
        }
        let r = radius_px.min(w / 2).min(h / 2).max(1);
        let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, r * 2, r * 2);
        if region == 0 {
            return;
        }
        if SetWindowRgn(hwnd, region, 1) == 0 {
            DeleteObject(region);
        }
    }
}

/// 输入框与占位标签的圆角区域（`radii.sm`）——与 `paint_round_input_field` 的圆角
/// 同半径；不贴区域时 RichEdit 的直角会盖住父窗口画的圆弧描边。
///
/// 推翻旧口径的依据（就地注明）：`paint_win` 模块头曾说「RichEdit 承载件不做圆角」
/// （区域裁剪怕与滚动条/IME 候选窗互相干扰）；2026-10-05 用户规则要求输入区与设计稿
/// 一致、圆角一律取 radii —— 输入框是 40pt 单行槽，被裁掉的只有四角（滚动条在右缘，
/// 角落裁掉的是它自己的底，无交互面损失）；IME 候选窗是独立弹出窗，不受控件区域
/// 裁剪。**实机核验点**：输入框右缘滚动条四角、以及光标贴角时的观感。
unsafe fn apply_input_round_regions(state: &ChatWinState, scale: f64) {
    let radius = scaled((theme::tokens().radii.sm.round() as i32).max(1), scale).max(1);
    unsafe {
        set_round_region(state.input, radius);
        // 占位标签盖在输入框上；不裁它的直角会从圆角外补出一小块方角底。
        set_round_region(state.input_placeholder, radius);
    }
}

/// 悬浮层窗口过程（浮层 Inspector 与会话历史弹层**共用** `LAYER_CLASS`，
/// 按窗口句柄分派到各自的绘制与关闭路径）：
/// 遮罩点击（盒外）关闭 + 承载控件的通知转发回聊天窗。
///
/// 内容子控件（标题/✕/面板元素/历史条目）的父窗口是这里，`WM_COMMAND`/
/// `WM_DRAWITEM`/`WM_NOTIFY` 按既有消息路由转回 `chat_wndproc`（✕ 的 id 段与
/// 面板按钮的 `PANEL_BASE`/`PANEL_SELECT_BASE` 段都在那里统一分派）。
/// **未在 Windows 实机验证**（同模块头约定）。
unsafe extern "system" fn overlay_layer_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底全部由 WM_PAINT 画（遮罩是整面实色）；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| {
                    if hwnd == state.history_layer {
                        paint_history_layer(state, hdc);
                    } else {
                        paint_inspector_layer(state, hdc);
                    }
                });
            }
            0
        }
        WM_APP_REPAINT => {
            repaint_deferred(hwnd);
            0
        }
        WM_NCDESTROY => {
            discard_deferred_paint(hwnd);
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        // 编辑类控件（可编辑框/下拉清单）的主题配色：`WM_CTLCOLOREDIT` /
        // `WM_CTLCOLORLISTBOX` 的消费者是**控件的父窗口**（组合框的展开清单也由
        // 承载它的父窗接，不随 `WM_COMMAND` 的转发链上走）—— 三处承载容器（流内 =
        // 聊天窗、浮层 = 滚动裁剪窗、历史 = 本层窗）各接各的，缺一处，对应容器里的
        // 下拉/输入框就回落系统经典外观。配色统一转给 `windows_settings` 的
        // `edit_ctlcolor`（唯一实现点，不在本文件另开第二份）；只接这两条消息，
        // 其余 CTLCOLOR 种类仍走默认处理。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            super::windows_settings::edit_ctlcolor(wparam, lparam)
        }
        WM_COMMAND => {
            unsafe { SendMessageW(GetParent(hwnd), WM_COMMAND, wparam, lparam) };
            0
        }
        WM_DRAWITEM => {
            unsafe { SendMessageW(GetParent(hwnd), WM_DRAWITEM, wparam, lparam) };
            0
        }
        WM_NOTIFY => {
            unsafe { SendMessageW(GetParent(hwnd), WM_NOTIFY, wparam, lparam) };
            0
        }
        // 点盒之外的遮罩区 = 收起（遮罩只罩消息流；哪一层收到点，就收哪一层）。
        WM_LBUTTONDOWN => {
            let x = i32::from((lparam & 0xFFFF) as u16 as i16);
            let y = i32::from(((lparam >> 16) & 0xFFFF) as u16 as i16);
            // (是不是历史层, 是否点在盒外) 一次借用取齐；窗口不在时按不关处理。
            let (history, closes) = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| {
                        if hwnd == state.history_layer {
                            (true, !rect_contains(state.history_box, x, y))
                        } else {
                            (false, !rect_contains(state.inspector_box, x, y))
                        }
                    })
                    .unwrap_or((false, false))
            });
            if closes {
                unsafe {
                    if history {
                        close_history_ui();
                    } else {
                        close_inspector_ui();
                    }
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 把手上拉箭头点击：把翻转交给模型（语义在 `ChatModel::toggle_inspector` 一处），
/// 再按**动作后的新快照**整帧重建 —— 平台层不翻转任何本地状态
/// （`ChatSnapshot::inspector_open` 就是开合的唯一输入，见字段注释）。
/// 模型随后排的刷新因版本号未变会被丢弃，这里的立即重建才是当帧生效点。
///
/// 入口只有一个：整条把手带的 `WM_LBUTTONDOWN`（箭头是同一块面上的绘制，
/// 不再有子按钮 —— 两个入口曾在同一次点击里开完又关，见 `build_children` 注释）。
unsafe fn toggle_inspector_ui() {
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::ToggleInspector) {
        // 纯显示动作在共享层提前返回、正常到不了这里；失败如实留痕（不重建，
        // 界面保持与模型一致）。
        rust_warn!("浮层开合动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 收起浮层（✕ / 点遮罩；同入口再点走 [`toggle_inspector_ui`]）。
unsafe fn close_inspector_ui() {
    let open = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|state| state.inspector_open)
            .unwrap_or(false)
    });
    if !open {
        return; // 已经收着：空操作（与共享层 `close_inspector` 同义）
    }
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseInspector) {
        rust_warn!("浮层收起动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 收起会话历史弹层（点盒外；「历史」按钮再点由既有 `ToggleSessionHistory` 收起，
/// 面板里的「关闭」按钮发 `CloseSessionHistory`）。
unsafe fn close_history_ui() {
    let open = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|state| state.history_height > 0)
            .unwrap_or(false)
    });
    if !open {
        return; // 已经收着：空操作
    }
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseSessionHistory) {
        rust_warn!("会话历史收起动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

// ==========================================
// 把手带与悬浮层的纯函数（几何 / 区间 / 文案；Win32 调用不在这段）
// ==========================================

/// 底部锚定的条区几何（物理像素；输入都已按 DPI 换算）。
///
/// **浮层的开合不在这份几何里**：浮层是消息流区域上的独立子窗口，条区链
/// （轨 → 输入行 → 待发送条 → 面板 → 画布）只由窗口尺寸与各条高度决定 ——
/// 这是验收硬指标「浮层开合前后消息流 y 不变」在结构上的保证（平台层不把
/// `inspector_open` 喂进这里；源码级守门测试钉住）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BottomStack {
    /// 输入行上缘（**贴客户区底**：2026-10-05 第二次改版后输入框是最底一条）。
    input_y: i32,
    /// 把手带上缘（输入行正上方那个横条）。
    handle_y: i32,
    /// 待发送条上缘（`pending_h == 0` 时 = 把手带上方一个间距，不画）。
    pending_y: i32,
    /// 功能面板区下缘。
    panel_bottom: i32,
    /// 功能面板区上缘。
    panel_top: i32,
    /// 正文画布下缘。
    canvas_bottom: i32,
}

fn bottom_stack(
    height: i32,
    input_h: i32,
    handle_h: i32,
    pending_h: i32,
    panel_h: i32,
    gap: i32,
) -> BottomStack {
    // 自下而上：输入行（贴底）→ 把手带 → 待发送条 → 功能面板 → 正文。
    let input_y = height - input_h;
    let handle_y = input_y - handle_h;
    let pending_y = handle_y - gap - pending_h;
    let panel_bottom = if pending_h > 0 {
        pending_y - gap
    } else {
        pending_y
    };
    let panel_top = panel_bottom - panel_h;
    // 正文下沿与 mac `chat_bands` 的 `scroll_y` 逐档对齐：
    // - 有流内面板 → 面板上沿之上留一个 `PANE_GAP`；
    // - 有待发送条 → 直接贴条的上沿（条在 composer 面里，不另留缝）；
    // - 都没有 → **贴把手带上沿**（旧实现贴 `pending_y` = 把手带上方 8px，
    //   实机就是「上拉条上方那条灰线与 composer 之间空一截」，用户 2026-10-07 实拍）。
    let canvas_bottom = if panel_h > 0 {
        panel_top - gap
    } else if pending_h > 0 {
        pending_y
    } else {
        handle_y
    };
    BottomStack {
        input_y,
        handle_y,
        pending_y,
        panel_bottom,
        panel_top,
        canvas_bottom,
    }
}

/// 把条内自绘按钮的投影**画在父窗通道里**（按钮自己的 DC 画不出窗口矩形之外）。
///
/// mac 侧投影是 CALayer 的层外扩散（药丸「浮」在面上）；Windows 的子窗口只能把
/// 投影画进自己矩形内，外沿那圈被裁掉、内侧又贴着药丸边 —— 实机读成一条贴边硬环
/// （用户 2026-10-07 实拍）。父窗先画一遍同口径投影：落在按钮矩形**之外**的部分
/// 才是可见增量（矩形内会被按钮自己的面盖住），与 mac 的层外软晕同观感。
///
/// 每个按钮的角色/圆角都从它自己的登记取（`role_of` / `button_radius_of`），不落
/// 第二份角色表；投影先画、按钮后画（子窗永远在父窗之上），顺序天然正确。
unsafe fn paint_button_shadows(hdc: HDC, owner: HWND, controls: &[HWND]) {
    let t = theme::tokens();
    for &control in controls {
        if control == 0 {
            continue;
        }
        // 隐藏的控件不画投影：隐藏窗口照样有矩形（`GetWindowRect` 有效），不判可见
        // 就会在它原来的位置上留一枚**没有按钮的灰药丸** —— 实机症状就是用户
        // 2026-10-07 实拍的「上拉条上面一个莫名其妙的灰色气泡」（画布给隐藏的
        // 「新消息」跳转按钮一直补接触影，按钮本身已 SW_HIDE）。
        if unsafe { IsWindowVisible(control) } == 0 {
            continue;
        }
        let role = paint_win::role_of(control);
        let face = paint_win::button_face(t, role, false, false);
        if face.shadow.contact.is_none() && face.shadow.ambient.is_none() {
            continue; // 无投影角色（TabOff/Link/Pending…）不画
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(control, &mut rect) } == 0 {
            continue;
        }
        let mut top_left = POINT {
            x: rect.left,
            y: rect.top,
        };
        unsafe { ScreenToClient(owner, &mut top_left) };
        let target = paint_win::Rect::new(
            top_left.x,
            top_left.y,
            rect.right - rect.left,
            rect.bottom - rect.top,
        );
        if target.is_empty() {
            continue;
        }
        let radius = paint_win::button_radius_of(control);
        // 单层接触影（见 `draw_contact_shadow` 的 why）：按钮的投影在 mac 是层外
        // 扩散，分层版在这里会四周压出硬环。
        if let Some(contact) = face.shadow.contact {
            unsafe { paint_win::draw_contact_shadow(hdc, target, radius, &contact) };
        }
    }
}

/// RTF `\fonttbl` 里的正文字体族（与控件字体同源）：RTF 文本的字体族由 fonttbl
/// 决定，`WM_SETFONT` 管不到它 —— 两处若各写一份族名，就会「控件换了族、正文还
/// 停在旧族」（行距/字形不一致）。
fn rtf_body_font_family() -> String {
    let snapshot = crate::ui::font::snapshot();
    snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family)
}

/// `GetPixel` 取 DC 上一点的实色（COLORREF → `Rgba`）；越界/裁剪外返回 `None`。
unsafe fn sample_dc_color(hdc: HDC, x: i32, y: i32) -> Option<theme::Rgba> {
    let value = unsafe { GetPixel(hdc, x, y) };
    (value != u32::MAX).then(|| paint_win::rgba_from_colorref(value))
}

/// 采样条区实色并登记给条上的自绘按钮（圆角补角用「它们实际坐的面」）。
///
/// ownerdraw 按钮的圆角是**画出来的**（窗口区域 `SetWindowRgn` 实机不生效，见
/// `paint_win::apply_round_region`），四角那块 `矩形 − 圆角矩形` 由
/// `paint_win::draw_button` 补底色 —— 补错色就是四角深色方块（`panel_bg` 比条区
/// 实际色暗 ~35 灰阶，用户 2026-10-07 实拍「按钮黑色方角」）。条区刚画完时从同一
/// DC 取一点，拿到的就是最终可见色（含 sheen/颗粒/叠层），不另建色值定义点。
///
/// **逐控件按自己的中心采样**：条面带 sheen（横向渐变），整条共用一个探针点时
/// 远离探针的按钮会差 ~7 灰阶 —— 实机就是「药丸后面一块比条底亮的矩形」
/// （用户 2026-10-07 实拍「新会话」）。`fallback` 只在控件矩形取不到时用。
unsafe fn register_band_surface(_hdc: HDC, owner: HWND, _fallback: (i32, i32), controls: &[HWND]) {
    // **不能用 `GetPixel` 采 DC**：WM_PAINT 期间 DC 被更新区裁剪，采样点落在
    // 更新区之外就返回 `CLR_INVALID` —— 实机日志显示每个按钮的采样都失败，表面色
    // 从未登记上，四角只能落回与条底差 ~35 灰阶的 `bg_base`（用户实拍「药丸后面
    // 一块矩形灰底」）。改成从 token 直接算：条底面 = `strip_bg` 叠在面板底渐变上，
    // 行位置取控件中心那一行。
    let tokens = theme::tokens();
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(owner, &mut client) };
    let height = f64::from((client.bottom - client.top).max(1));
    for &control in controls {
        if control == 0 {
            continue;
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        // 表面上下两行：按钮矩形顶/底边换算成面板渐变的 t，条色 `strip_bg` 叠在
        // 面板底之上 —— 补角按这段渐变铺，四角与条底逐像素同色。
        let (top_y, bottom_y) = if unsafe { GetWindowRect(control, &mut rect) } != 0 {
            let mut point = POINT {
                x: (rect.left + rect.right) / 2,
                y: rect.top,
            };
            unsafe { ScreenToClient(owner, &mut point) };
            let span = f64::from(rect.bottom - rect.top).max(1.0);
            (f64::from(point.y), f64::from(point.y) + span)
        } else {
            (0.0, height)
        };
        let sample = |y: f64| {
            let t = (y / height).clamp(0.0, 1.0);
            paint_win::composite_over(tokens.strip_bg, paint_win::fill_sample(&tokens.panel_bg, t))
        };
        paint_win::set_surface_rows(control, sample(top_y), sample(bottom_y));
    }
}

/// 输入行各列的摆放（纯函数，可测；物理像素，Win32 客户区坐标）。
///
/// 用户规则（2026-10-05）：「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
/// 图片/停止/发送按钮占固定宽，整行不压缩输入框到不可用」。按钮宽度只来自常量
/// （不随行宽变），输入框吃剩余并保底 [`INPUT_FIELD_MIN_WIDTH`] —— 旧口径把输入框
/// 下限压到 40、按钮又宽（60/80/52），窄聊天列（主窗聊天列最小 120pt）会把输入框
/// 压成一条缝（macOS 侧 265pt 实机同症，见 `macos_chat::input_row_columns`）。
///
/// 平台结构差异（就地注明）：macOS 是「发送 + 停止」两枚独立按钮（停止仅运行中出现），
/// Windows 是**单主按钮槽**（空闲 = 发送 / 运行中 = 停止，槽宽取两者较宽者，换态不挤动
/// 输入框）—— 因此这里没有 `stop_visible` 维度，其余口径与 macOS 同构。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InputRowColumns {
    /// 输入框宽度（弹性；保底 `INPUT_FIELD_MIN_WIDTH`）。
    field_width: i32,
    /// 主按钮槽左缘（发送/停止同槽）。
    primary_x: i32,
    /// 「图片」按钮左缘（常驻）。
    pick_x: i32,
}

fn input_row_columns(width: i32, scale: f64) -> InputRowColumns {
    let right_margin = scaled(BOTTOM_RIGHT_MARGIN, scale);
    let slot_w = scaled(SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH), scale);
    let pick_w = scaled(PICK_BUTTON_WIDTH, scale);
    let gap = scaled(BOTTOM_BUTTON_GAP, scale);
    let button_margin = scaled(INPUT_BUTTON_MARGIN, scale);
    let side_margin = scaled(SIDE_MARGIN, scale);
    let min_field = scaled(INPUT_FIELD_MIN_WIDTH, scale);
    let primary_x = (width - right_margin - slot_w).max(0);
    let pick_x = (primary_x - gap - pick_w).max(0);
    // 输入框右缘 = 「图片」左缘再让出与按钮列的间距（旧 INPUT_BUTTON_RESERVE 同算式）。
    let field_width = (pick_x - button_margin - side_margin).max(min_field);
    InputRowColumns {
        field_width,
        primary_x,
        pick_x,
    }
}

/// 浮层盒几何（浮层窗口客户区坐标）：左右各留 `pad_x`、底边锚在层底上方 `pad_y`，
/// 高按内容（`wanted_h`）、上限是层高减上下留白。
fn overlay_box_rect(
    layer_w: i32,
    layer_h: i32,
    wanted_h: i32,
    pad_x: i32,
    pad_y: i32,
) -> paint_win::Rect {
    let w = (layer_w - pad_x * 2).max(1);
    let max_h = (layer_h - pad_y * 2).max(1);
    let h = wanted_h.clamp(1, max_h);
    let y = (layer_h - pad_y - h).max(0);
    paint_win::Rect::new(pad_x, y, w, h)
}

/// 浮层内容滚动区（裁剪窗）的可视高（物理像素）：盒高扣掉标题行与底部内边距
/// （下限 1）。**唯一算式**：盒摆放、裁剪窗摆放、滚动条页大小与偏移钳制都读它，
/// 不各自重算（纯函数，可测）。
fn inspector_body_view_height(panel_box: paint_win::Rect, scale: f64) -> i32 {
    (panel_box.h
        - scaled(INSPECTOR_HEADER_HEIGHT, scale)
        - scaled(INSPECTOR_BODY_PAD_BOTTOM, scale))
    .max(1)
}

/// 把手箭头的朝向：浮层收着 = 上拉（▴）、开着 = 可往下收（▾）。
/// 朝向表示「点一下会发生什么」（旧 meta 轨 chip 的翻面口径）；绘制端按它选三角的
/// 顶点方向（共享 `handle_arrow_label` 的字形口径，Windows 画几何、不依赖字体覆盖）。
fn handle_arrow_up(inspector_open: bool) -> bool {
    !inspector_open
}

/// 把手带的状态文案：**只取中性系统回执 `notice`**（用户规则 2026-10-05：
/// **过程状态文案（阶段/工具）只在顶栏显示**，聊天窗底部不重复）。空通知 = 空串。
///
/// 旧实现的 `or_else(|| status.text.clone())` 兜底把过程文案也漏到把手带，
/// 已删除（纯函数 + 单测钉住；`update_status` 是唯一消费者）。
fn handle_status_label(status: &StatusSnapshot) -> String {
    status.notice.clone().unwrap_or_default()
}

/// 圆点与文字同生共死（与 macOS `update_status` 的 `dot.setHidden(text.is_empty())`
/// 同口径）：没有真实文案时不亮一个看起来像「在线」的常亮点。
fn handle_status_dot_visible(label: &str) -> bool {
    !label.is_empty()
}

/// 会话历史弹层的盒几何（弹层层窗客户区坐标）：**右缘对齐锚点**（「历史」按钮
/// 右缘）、顶边贴层顶下 `gap_y`；宽高按内容，**整体夹进窗口**（`anchor_right`
/// 太靠左/内容超高时裁到边界内，不滚出窗口）。
fn history_popover_rect(
    layer_w: i32,
    layer_h: i32,
    anchor_right: i32,
    wanted_w: i32,
    wanted_h: i32,
    gap_y: i32,
) -> paint_win::Rect {
    let w = wanted_w.clamp(1, layer_w.max(1));
    let x = (anchor_right - w).clamp(0, (layer_w - w).max(0));
    let max_h = (layer_h - gap_y).max(1);
    let h = wanted_h.clamp(1, max_h);
    let y = gap_y.min((layer_h - h).max(0)).max(0);
    paint_win::Rect::new(x, y, w, h)
}

/// 点是否落在矩形内（`paint_win::Rect` 是右/下开区间）。
fn rect_contains(rect: paint_win::Rect, x: i32, y: i32) -> bool {
    x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom()
}

/// 控件 -> （承载窗, 承载窗自己的绘制例程）：ownerdraw 按钮的「底」重放源。
///
/// 只认两种归属，其余窗口（浮层 / 历史弹层 / 文档弹窗）本轮不接、返回 `None`：
/// - 聊天窗自己的子控件（新会话 / 加号 / 历史 / 图片 / 发送 / 停止 / 待发送 chip）
///   走 `paint_shell`（聊天窗客户区坐标）；
/// - 悬在正文画布上的「新消息」跳转按钮与画布内 chip 走 `paint_canvas_shell`
///   （原点由 `control_rect_in_parent(control, state.canvas)` 换算，见调用点）。
///
/// `state.jump` 的父窗是聊天窗、底却是画布：归属按**控件语义**判定、不按父窗，
/// 否则会把画布上的内容重放成聊天窗的面（药丸四角会与其下消息内容对不上）。
fn button_backdrop_owner(
    state: &ChatWinState,
    control: HWND,
) -> Option<(HWND, unsafe fn(&ChatWinState, HDC))> {
    if control == 0 {
        return None;
    }
    let parent = unsafe { GetParent(control) };
    if control == state.jump || parent == state.canvas {
        return Some((state.canvas, paint_canvas_shell));
    }
    if parent == state.hwnd {
        return Some((state.hwnd, paint_shell));
    }
    None
}

/// 把控件矩形里的**真实底**（承载窗自己画的像素）贴到控件 DC 上。
///
/// 这是本轮「灰色矩形底」的唯一修法：ownerdraw 子控件是不透明表面，矩形里的一切
/// 都得控件自己画；旧口径用 `strip_bg` 合成 `panel_bg` 的近似值补底 / 补角，而真实
/// 条底还叠了 sheen / 颗粒 / 投影，实测差 20+ 灰阶（2026-10-07 实机：加号按钮四角
/// `(192,202,212)` vs 相邻条区 `(223,230,238)`）。重放走承载窗**自己的绘制例程**，
/// 四角与周围逐像素同色。
///
/// 失败（`CHAT` 重建持借期间、控件不属于这两个承载窗、位图建不出）返回 `false`：
/// 调用方按旧近似口径画完（该回落 2026-10-08 起静默降噪，见
/// `paint_win::blit_backdrop` 内注释），不静默变形。
unsafe fn blit_button_backdrop(item: &DrawItemStruct, rect: paint_win::Rect) -> bool {
    let control = item.hwndItem;
    CHAT.with(|cell| {
        // 重建 / 布局持借期间不重入（仓库 UI 借用纪律：RefCell 不得重入）。
        let Ok(slot) = cell.try_borrow() else {
            return false;
        };
        let Some(state) = slot.as_ref() else {
            return false;
        };
        let Some((owner, painter)) = button_backdrop_owner(state, control) else {
            return false;
        };
        let Some(origin) = paint_win::control_rect_in_parent(control, owner) else {
            return false;
        };
        unsafe {
            paint_win::blit_backdrop(item.hDC, rect, (origin.x, origin.y), |hdc| {
                painter(state, hdc)
            })
        }
    })
}

/// ownerdraw 按钮统一绘制（聊天窗与画布共用；角色/悬浮从控件自身读）。
unsafe fn draw_themed_button(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & ODS_SELECTED != 0;
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    let mut face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = unsafe { read_window_text(item.hwndItem) };
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    // 待发送 chip（有缩略图）：图前文后分区摆放（与 macOS 的 `ImageLeading` 同形）——
    // 底/边/按下态照常走 `draw_button`，标题由这里手工摆（缩略图占掉左侧一段）。
    let thumb = PENDING_THUMBS.with(|images| images.borrow().get(&item.hwndItem).cloned());
    if let Some(frame) = thumb {
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        unsafe {
            draw_pending_chip(
                item.hDC,
                item.hwndItem,
                rect,
                &face,
                &label,
                &frame,
                pressed,
                disabled,
                backdrop,
            )
        };
        return;
    }
    // 无缩略图的待发送 chip（缩略图未就绪 / 不可用）：底照常走 `draw_button`，文案也
    // 必须走 `draw_pending_label` —— 否则末尾的 ✕ 会被 `DT_END_ELLIPSIS` 吃掉。
    if role == ButtonRole::Pending {
        let scale = dpi_scale(item.hwndItem);
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        unsafe {
            paint_win::draw_button(
                item.hDC,
                item.hwndItem,
                rect,
                &face,
                "",
                pressed,
                disabled,
                backdrop,
            );
            draw_pending_label(
                item.hDC,
                rect,
                &face,
                &label,
                rect.x + scaled(PENDING_THUMB_INSET_X, scale),
                scale,
                pressed,
            );
        }
        return;
    }
    let backdrop = unsafe { blit_button_backdrop(item, rect) };
    unsafe {
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            &label,
            pressed,
            disabled,
            backdrop,
        )
    };
}

/// 待发送 chip 的文案绘制：共享 `pending_label` 的形态是「文件名（大小）✕」，
/// 而 chip 正文用 `DT_END_ELLIPSIS` —— 文件名一长，末尾的 ✕ 就被省略号一起吃掉
/// （2026-10-07 用户实拍「有了但是没有 ×」）。这里把 ✕ 摘出来固定贴右缘画，
/// 正文在左侧剩余宽度里省略：撤选提示永远可见，且宽度仍来自共享文案（不另拼一份）。
unsafe fn draw_pending_label(
    hdc: HDC,
    rect: paint_win::Rect,
    face: &paint_win::ButtonFace,
    label: &str,
    text_left: i32,
    scale: f64,
    pressed: bool,
) {
    let (title, close) = match label.rfind('✕') {
        Some(index) => (&label[..index], &label[index..]),
        None => (label, ""),
    };
    let inset = scaled(PENDING_THUMB_INSET_X, scale);
    let shift = i32::from(pressed);
    let mut right = rect.right() - inset;
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(face.ink));
    }
    if !close.is_empty() {
        // 量 ✕ 自身宽度（很短，本身不省略），给它留出固定位置。
        let mut measure = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let text = wide(close);
        unsafe {
            DrawTextW(
                hdc,
                text.as_ptr(),
                -1,
                &mut measure,
                DT_SINGLELINE | DT_NOPREFIX | DT_CALCRECT,
            )
        };
        let close_w = (measure.right - measure.left).max(1);
        let mut close_rect = RECT {
            left: right - close_w,
            top: rect.y + shift,
            right,
            bottom: rect.bottom() + shift,
        };
        unsafe {
            DrawTextW(
                hdc,
                text.as_ptr(),
                -1,
                &mut close_rect,
                DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_RIGHT,
            )
        };
        right -= close_w + scaled(2, scale);
    }
    if right <= text_left || title.is_empty() {
        return;
    }
    let mut title_rect = RECT {
        left: text_left,
        top: rect.y + shift,
        right,
        bottom: rect.bottom() + shift,
    };
    let text = wide(title);
    unsafe {
        DrawTextW(
            hdc,
            text.as_ptr(),
            -1,
            &mut title_rect,
            DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        )
    };
}

/// 带缩略图的待发送 chip：底/边照 `draw_button`（标题传空），缩略图贴左、文案摆在
/// 图右侧的剩余宽度里（单行、尾部省略）。整条仍是撤选命中区 —— 只有绘制方式不同。
///
/// 待发送 chip 恒可用（点击即撤选），不复制 `draw_button` 的禁用色推导；本函数也
/// 只由 `PENDING_THUMBS` 注册的待发送条目命中。
unsafe fn draw_pending_chip(
    hdc: HDC,
    hwnd: HWND,
    rect: paint_win::Rect,
    face: &paint_win::ButtonFace,
    label: &str,
    frame: &DecodedFrame,
    pressed: bool,
    disabled: bool,
    backdrop_painted: bool,
) {
    unsafe {
        paint_win::draw_button(
            hdc,
            hwnd,
            rect,
            face,
            "",
            pressed,
            disabled,
            backdrop_painted,
        );
        let scale = dpi_scale(hwnd);
        let (thumb_w, thumb_h) =
            crate::ui::chat::pending_strip::thumb_display_size(frame.width, frame.height);
        let image_w = scaled(thumb_w.max(1) as i32, scale).max(1);
        let image_h = scaled(thumb_h.max(1) as i32, scale).max(1);
        let image_x = rect.x + scaled(PENDING_THUMB_INSET_X, scale);
        let image_y = rect.y + (rect.h - image_h) / 2;
        // 与 `draw_inline_button` 同一 DIB 口径（自下而上用负高、RGBA 掩码按小端读）。
        let mut info = RgbaBitmapInfo {
            header: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: frame.width as i32,
                biHeight: -(frame.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_BITFIELDS_RGBA,
                biSizeImage: frame.rgba.len() as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            masks: [0x0000_00FF, 0x0000_FF00, 0x00FF_0000],
        };
        StretchDIBits(
            hdc,
            image_x,
            image_y,
            image_w,
            image_h,
            0,
            0,
            frame.width as i32,
            frame.height as i32,
            frame.rgba.as_ptr().cast(),
            (&mut info as *mut RgbaBitmapInfo).cast::<BITMAPINFO>(),
            DIB_RGB_COLORS,
            SRCCOPY,
        );
        // 文案：缩略图右侧到 chip 右缘之间（✕ 固定贴右缘，见 `draw_pending_label`）。
        draw_pending_label(
            hdc,
            rect,
            face,
            label,
            image_x + image_w + scaled(4, scale),
            scale,
            pressed,
        );
    }
}

/// 卡片底板（`PanelElement::Card` 的自绘 STATIC）绘制：`--fbg` 底 + `--bedge`
/// 细边 + `--r1` 圆角（小件半径，与 chip 同档）。
///
/// 底**不能**用 `panel_bg`（与弹层底同色就看不出边界了）：`field_bg` 是输入框 /
/// 待发 chip 一族的次级面，五套主题里都与面板底有明确极性差（暗主题凹一格、
/// 亮主题抬起一张白卡）。圆角手法与浮层盒同款（[`with_round_box`]：区域裁剪 +
/// `FrameRgn` 沿轮廓描边）；区域建失败时退化为方角并**留痕**（不静默丢内容）。
///
/// **未在 Windows 实机验证**（同模块头约定）：本机编不出 Windows 分支。实机核验点
/// 有三处 —— 自绘 STATIC 的 `WM_DRAWITEM`(ODT_STATIC) 通路、底板的 z 序
/// （`SetWindowPos(HWND_BOTTOM)` 是否确实垫在行/按钮之下）、`WS_CLIPSIBLINGS`
/// 下底板重绘不盖住上方兄弟。
unsafe fn draw_themed_card(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    let scale = dpi_scale(item.hwndItem);
    let radius = scaled((tokens.radii.sm.round() as i32).max(1), scale).max(1);
    let ok = unsafe {
        with_round_box(item.hDC, rect, radius, tokens.btn_edge, || {
            paint_win::fill_rect(item.hDC, rect, &tokens.field_bg);
        })
    };
    if !ok {
        // 区域创建失败（极罕见）：底已在裁剪前照常画出，这里补方角描边。
        // 绘制期逐控件回落：静默——降噪 2026-10-08 用户裁定（稳态留痕会随重绘刷屏）；
        // 绘制端回落由实机像素取证覆盖。
        unsafe { paint_win::draw_frame(item.hDC, rect, tokens.btn_edge, &Bevel::NONE) };
    }
}

/// `WM_CTLCOLORSTATIC`：字色取控件上记录的主题色（未记录 → `ink`），底透明。
unsafe fn ctlcolor_static(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    // 「坐在别的底上」的 STATIC 要返回所在表面的底色作背景刷（STATIC 会用它
    // 擦自己的客户区；返回面板底会补出一块异色板）：
    // - 输入区占位标签盖在 RichEdit 上 → 输入框的合成底色（`rich_bg(&field_bg)` 同值）；
    // - 浮层标题行**没有标题文字**（标题没有共享来源，不自己造；行内只有 ✕）→
    //   不需要额外分支：默认面板底画刷即盒底同色。
    // 把手带的状态文字不再是 STATIC：子窗口的不透明表面会把 composer 渐变挡成一块
    // 灰板（2026-10-07 实机），改由 `paint_shell` 单面绘制。
    let placeholder = CHAT.with(|cell| {
        cell.try_borrow()
            .ok()
            .and_then(|cell| cell.as_ref().map(|state| state.input_placeholder))
            .unwrap_or(0)
    });
    let color = paint_win::text_color_of(control).unwrap_or(tokens.ink);
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(color));
    }
    if control != 0 && control == placeholder {
        return paint_win::solid_brush(flat_over_panel(&tokens.field_bg)) as LRESULT;
    }
    paint_win::solid_brush(tokens.panel_bg.base_color()) as LRESULT
}

/// 输入框主题：底色 + 全文字色（`WM_SETFONT` 会重置默认字体格式，所以字体刷新后要重来一遍）。
unsafe fn apply_input_theme(state: &ChatWinState) {
    if state.input == 0 {
        return;
    }
    let t = theme::tokens();
    unsafe {
        SendMessageW(
            state.input,
            EM_SETBKGNDCOLOR,
            0,
            rich_bg(&t.field_bg) as LPARAM,
        );
        // 只改颜色（CFM_COLOR）：不动高度/字面，字体仍由 WM_SETFONT 管。
        let mut format: CharFormatW = std::mem::zeroed();
        format.cbSize = std::mem::size_of::<CharFormatW>() as u32;
        format.dwMask = CFM_COLOR;
        format.crTextColor = paint_win::colorref(t.ink);
        SendMessageW(
            state.input,
            EM_SETCHARFORMAT,
            SCF_ALL,
            &mut format as *mut CharFormatW as LPARAM,
        );
    }
}

// ==========================================
// 平台入口（`ui/chat` 经 `platform::chat_imp` 调用，全部在主线程）
// ==========================================

/// 打开（或前移）聊天窗；不存在即创建并全量渲染。
///
/// 主窗聊天面板已挂载时（W9a 产品形态）不再开第二个聊天面：前移主窗并留痕。
pub(crate) fn open_chat_window() {
    let existing = CHAT.with(|cell| cell.borrow().as_ref().map(|state| (state.hwnd, state.pane)));
    if let Some((hwnd, pane)) = existing {
        unsafe {
            if pane {
                rust_info!("主窗聊天面板已挂载，独立聊天窗请求转为前移主窗（同窗合成优先）");
                let parent = GetParent(hwnd);
                if parent != 0 {
                    SetForegroundWindow(parent);
                }
            } else {
                ShowWindow(hwnd, SW_SHOW);
                SetForegroundWindow(hwnd);
            }
        }
        if !pane {
            crate::ui::chat::set_chat_window_open(true);
            crate::ui::chat::set_chat_window_visible(true);
        }
        return;
    }
    match unsafe { create_chat_window() } {
        Ok(()) => {
            crate::ui::chat::set_chat_window_open(true);
            crate::ui::chat::set_chat_window_visible(true);
        }
        Err(error) => rust_warn!("聊天窗创建失败: {error}"),
    }
}

/// 关闭聊天窗（关闭即释放控件与字体，可再次打开；主窗面板走 `set_main_pane_visible`）。
pub(crate) fn close_chat_window() {
    let hwnd = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .and_then(|state| if state.pane { None } else { Some(state.hwnd) })
    });
    match hwnd {
        Some(hwnd) => unsafe {
            DestroyWindow(hwnd);
        },
        None => rust_debug!("独立聊天窗未打开，关闭请求忽略"),
    }
}

// ==========================================
// 主窗内聊天面板（W9a：一体主窗布局）
// ==========================================

/// 把聊天面板挂进主窗（子窗口 + 同一套控件；不新建顶层窗）。
pub(crate) fn mount_main_pane(parent: HWND) {
    if CHAT.with(|cell| cell.borrow().is_some()) {
        rust_debug!("聊天面板已存在，忽略重复挂载");
        return;
    }
    if let Err(error) = unsafe { ensure_chat_classes() } {
        rust_warn!("聊天面板类注册失败: {error}");
        return;
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(CHAT_CLASS).as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            200,
            200,
            parent,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        rust_warn!("聊天面板子窗口创建失败");
        return;
    }
    crate::ui::chat::chat_ui().set_main_pane_open(true);
    let visible = unsafe { IsWindowVisible(hwnd) != 0 };
    crate::ui::chat::set_main_pane_visible(visible);
    rust_info!("聊天面板已挂入主窗（Windows：子窗口 + 同一套控件）");
}

/// 主窗布局驱动面板矩形（MoveWindow 会触发面板的 WM_SIZE → 重排 + 重建）。
pub(crate) fn layout_main_pane(parent: HWND, x: i32, y: i32, width: i32, height: i32) {
    let pane = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .filter(|state| state.pane)
            .map(|state| state.hwnd)
    });
    let Some(pane) = pane else { return };
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MoveWindow(pane, x, y, width, height, 1);
    }
    let _ = parent;
}

/// 聊天列展开/收起（收起只隐藏；展开时按最新投影重建）。
pub(crate) fn set_main_pane_visible(_parent: HWND, visible: bool) {
    let pane = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .filter(|state| state.pane)
            .map(|state| state.hwnd)
    });
    let Some(pane) = pane else { return };
    if !visible {
        crate::ui::chat::set_main_pane_visible(false);
    }
    unsafe {
        ShowWindow(pane, if visible { SW_SHOW } else { SW_HIDE });
    }
    if !visible {
        // 收起时停掉面板期限定时器（聊天面不在时不需要本地收纳；展开时重建会重新布点）。
        with_chat(|state| unsafe {
            KillTimer(state.hwnd, TIMER_DEADLINE);
            release_canvas(state);
            crate::ui::chat::sync_inline_visible("main-chat", Vec::new());
        });
    }
    if visible {
        crate::ui::chat::set_main_pane_visible(true);
    }
}

/// 呼出后聚焦主窗聊天输入框（对齐 macOS 与旧壳 `handleDockPopup` 的 `focusInput`）。
///
/// 只在面板可见（主窗在屏、聊天列展开）时聚焦：桌宠形态下面板隐藏，既不把面板
/// 拉出来，也不对隐藏控件硬聚焦。`SetFocus` 无返回值 —— 读回当前焦点核实，
/// 拿不到焦点就如实返回 false，由呼出路径留痕（不假装成功；与 macOS 口径一致）。
pub(crate) fn focus_main_pane_input() -> bool {
    let target: Option<HWND> = CHAT.with(|cell| {
        let slot = cell.borrow();
        let state = match slot.as_ref() {
            Some(state) => state,
            None => return None,
        };
        if !state.pane || state.input == 0 {
            return None;
        }
        if unsafe { IsWindowVisible(state.hwnd) } == 0 {
            return None;
        }
        Some(state.input)
    });
    let Some(input) = target else {
        rust_debug!("呼出聚焦跳过：聊天面板未挂载或当前不可见");
        return false;
    };
    // 线程前提：本函数只在呼出路径调用（UI 线程、SetForegroundWindow 之后），
    // SetFocus 的「前台线程」条件成立。
    unsafe { SetFocus(input) };
    if unsafe { GetFocus() } == input {
        rust_debug!("呼出已聚焦聊天输入框");
        true
    } else {
        rust_warn!("呼出聚焦聊天输入框失败（SetFocus 未生效）");
        false
    }
}

pub(crate) fn clear_inline_previews() {
    with_chat(|state| {
        for target in &mut state.image_targets {
            target.frame = None;
            DRAW_IMAGES.with(|images| {
                if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                    draw.frame = None;
                }
            });
            unsafe { InvalidateRect(target.hwnd, std::ptr::null(), 1) };
        }
    });
}

/// 主窗收起/呼出只改变顶层窗口可见性，保持聊天列开合状态并相应释放/恢复可见图片。
pub(crate) fn main_window_visibility_changed(visible: bool, chat_column_expanded: bool) {
    if visible {
        let parent = CHAT.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|state| state.pane)
                .map(|state| unsafe { GetParent(state.hwnd) })
                .unwrap_or(0)
        });
        if parent != 0 {
            set_main_pane_visible(parent, chat_column_expanded);
        }
    } else {
        crate::ui::chat::set_main_pane_visible(false);
        with_chat(|state| {
            if state.pane {
                for target in &mut state.image_targets {
                    target.frame = None;
                    DRAW_IMAGES.with(|images| {
                        if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                            draw.frame = None;
                        }
                    });
                }
                crate::ui::chat::sync_inline_visible("main-chat", Vec::new());
            }
        });
    }
}

/// 主题切换：重建设备级配色（RTF 颜色表/按钮面/静态字色在创建时固化）+ 重画窗底。
///
/// 主题 GDI 缓存由 `windows.rs` 的广播先统一释放（`paint_win::release_theme_resources`），
/// 这里负责把「按旧 token 画好的东西」全部重建，并用新 token 刷新输入框与固定文字。
pub(crate) fn apply_theme() {
    let exists = CHAT.with(|cell| cell.borrow().is_some());
    if !exists {
        rust_debug!("聊天窗未打开，主题切换仅释放缓存（由广播统一做）");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
    with_chat(|state| unsafe {
        apply_input_theme(state);
        // ownerdraw 的窗口区域（SetWindowRgn）不随重绘更新，而 radii 跨主题不同
        // （sm/btn：brushed 4/5、chrome 8/9、verdigris 4/5）：按各按钮创建时的半径
        // 重贴区域（配对与创建处一致：浮层 ✕/＋/历史 用 `--r1`，其余主按钮/次要按钮
        // 用 `--r3`）。
        let scale = dpi_scale(state.hwnd);
        for (control, radius) in [
            (state.send, theme::tokens().radii.btn),
            (state.jump, theme::tokens().radii.btn),
            (state.pick_images, theme::tokens().radii.btn),
            (state.stop, theme::tokens().radii.btn),
            (state.inspector_close, theme::tokens().radii.sm),
            (state.nav_new, theme::tokens().radii.sm),
            (state.nav_history, theme::tokens().radii.sm),
        ] {
            paint_win::install_button(control, scaled(radius.round() as i32, scale));
        }
        // 输入区承载件的圆角区域（radius 跨主题不同：sm 4/8/4）。
        apply_input_round_regions(state, scale);
        stamp_ink(state.input_placeholder, theme::tokens().dim);
        InvalidateRect(state.input_placeholder, std::ptr::null(), 1);
        InvalidateRect(state.hwnd, std::ptr::null(), 1);
        InvalidateRect(state.canvas, std::ptr::null(), 1);
        // 悬浮层窗口画的是主题材质（遮罩/盒底/描边），必须重画；重绘直接吃本次
        // 整帧重建刚写好的盒几何（上面 `chat_apply(Full)` 已跑过布局）。
        // **不要把盒几何归零**：归零会让这一帧的 WM_PAINT 按空盒只铺遮罩、
        // 盒体要等下一次布局才回来（实机表现：切主题后浮层只剩一层遮罩）。
        // macOS 侧同族根因是「贴皮子层只按宿主尺寸守卫、没人按浮层自身帧重贴」
        // （见 `macos_chat::repaint_floating_chrome_if_resized`）；Windows 是立即
        // 模式逐帧重画，重绘守卫就收在 `layout_inspector_layer` 的盒几何比较 +
        // 这里的主题重绘，不存在子层残留。
        if state.inspector_layer != 0 {
            InvalidateRect(state.inspector_layer, std::ptr::null(), 1);
        }
        if state.history_layer != 0 {
            InvalidateRect(state.history_layer, std::ptr::null(), 1);
        }
    });
    rust_info!("聊天窗已按新主题重建（Windows）");
}

/// 全局字体快照变化：重建字体并下发（消息视图按新字体重建）。
pub(crate) fn apply_chat_font() {
    let scale = CHAT.with(|cell| cell.borrow().as_ref().map(|state| dpi_scale(state.hwnd)));
    let Some(scale) = scale else { return };
    with_chat(|state| {
        let snapshot = crate::ui::font::snapshot();
        let ui_face = snapshot
            .family
            .clone()
            .unwrap_or_else(paint_win::resolve_ui_font_family);
        // 统一走 `paint_win::create_ui_font`（**灰度抗锯齿**）：系统缺省的
        // DEFAULT_QUALITY 会打开 ClearType，浅底小字上出现橙/蓝彩边（实机与 mac
        // 录制对比明显「脏」，2026-10-07）；顶栏已先行走这条路径。
        let make = |height: f64, weight: i32, face: &str| {
            paint_win::create_ui_font(-scaled(height.round() as i32, scale), weight, face)
        };
        let body = make(snapshot.scaled_size(13.0, 13.5), FW_NORMAL as i32, &ui_face);
        let small = make(snapshot.scaled_size(11.0, 13.5), FW_NORMAL as i32, &ui_face);
        let bold = make(snapshot.scaled_size(13.0, 13.5), FW_BOLD as i32, &ui_face);
        let mono = make(
            snapshot.scaled_size(12.0, 13.5),
            FW_NORMAL as i32,
            "Consolas",
        );
        for font in state.fonts.drain(..) {
            if font != 0 {
                unsafe { DeleteObject(font) };
            }
        }
        state.fonts = vec![body, small, bold, mono];
        unsafe {
            SendMessageW(state.input, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.input_placeholder, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.stop, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.pick_images, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.send, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.jump, WM_SETFONT, small as WPARAM, 1);
            // 浮层关闭键是常驻小号控件（标题行没有标题文字）。
            SendMessageW(state.inspector_close, WM_SETFONT, small as WPARAM, 1);
            for child in &state.pending_children {
                SendMessageW(child.hwnd, WM_SETFONT, small as WPARAM, 1);
            }
            // A1：标签条固定按钮与动态按钮跟着全局字体刷新（顶栏不在这里：
            // 全窗宽顶栏子窗口有自己的字体路径，见 windows_main::apply_titlebar_font）。
            if state.pane {
                for control in [state.nav_new, state.nav_history] {
                    SendMessageW(control, WM_SETFONT, small as WPARAM, 1);
                }
                for child in &state.tab_children {
                    SendMessageW(child.hwnd, WM_SETFONT, small as WPARAM, 1);
                }
            }
        }
        // WM_SETFONT 会重置默认字符格式：字色随字体一起重下发。
        unsafe { apply_input_theme(state) };
    });
    // 消息视图按新字体重建（字体在建控件时固化）。
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
    rust_info!("聊天字体已按全局快照刷新（Windows）");
}

/// 渲染更新（主线程队列调度；窗口不在时按 debug 丢弃 —— ChatUi 已按 window_open 门禁）。
pub(crate) fn chat_apply(update: ChatRenderUpdate) {
    let visible = CHAT.with(|cell| {
        cell.borrow().as_ref().is_some_and(|state| {
            crate::ui::chat::is_surface_visible(if state.pane { "main-chat" } else { "chat" })
        })
    });
    if !visible {
        return;
    }
    match update {
        ChatRenderUpdate::Full(snapshot) => {
            with_chat(|state| unsafe { apply_full(state, &snapshot) })
        }
        ChatRenderUpdate::StreamOnly { text } => {
            with_chat(|state| unsafe { update_tail(state, text.as_deref()) })
        }
        ChatRenderUpdate::StatusOnly(status) => with_chat(|state| update_status(state, &status)),
    }
    // 浮层/弹层子树的补画：层窗开合只走 `ShowWindow`，**状态借用期内**同步派回的
    // WM_PAINT 会被重入保护跳过（更新区已被 BeginPaint 验证），而仅当盒几何变化时
    // 才有的那次 `InvalidateRect` 又救不回来 —— 实机表现是「点一下浮层闪一下就
    // 没有了」，只有外部强制重绘才出现（2026-10-07 逐像素取证）。这里在借用之外
    // 补一次整棵子树的失效（含子控件），让浮层随开合真正上屏。
    invalidate_overlay_layers();
}

/// 浮层 / 会话历史弹层的整棵子树失效（在状态借用**之外**调用，见 [`chat_apply`]）。
fn invalidate_overlay_layers() {
    let (inspector, history) = CHAT.with(|cell| {
        cell.try_borrow()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .map(|state| (state.inspector_layer, state.history_layer))
            })
            .unwrap_or((0, 0))
    });
    // `RDW_UPDATENOW`：浮层开合只走 `ShowWindow`，同步派回的那次 WM_PAINT 会在
    // 状态借用期内被重入保护跳过（BeginPaint 已把更新区验证掉）；只 `RDW_INVALIDATE`
    // 的异步失效实机表现为「点一下浮层闪一下就没有了」，而外部同参数 +
    // `RDW_UPDATENOW` 的强制重绘能让浮层立刻上屏（2026-10-07 逐像素取证）。
    // 本函数在状态借用**之外**调用，同步绘制不会撞重入保护。
    for layer in [inspector, history] {
        if layer == 0 || unsafe { IsWindowVisible(layer) } == 0 {
            continue;
        }
        let ok = unsafe {
            RedrawWindow(
                layer,
                std::ptr::null(),
                0,
                RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW,
            )
        };
        if ok == 0 {
            // 绘制期逐帧回落（本帧浮层可能不重画）：静默——降噪 2026-10-08 用户裁定
            // （稳态留痕会随每次刷新刷屏）；本函数的 `RDW_UPDATENOW` 取舍由 2026-10-07
            // 实机逐像素取证覆盖（见上方注释），失败再现时临时加回日志/探针。
        }
    }
}

/// 整帧应用：面板区 → 顶栏/标签条 → 待发送条 → 布局 → 正文画布 → 期限定时器
/// （顺序有依赖：面板/待发送区高度决定画布位置；按钮先建，布局再统一定位）。
unsafe fn apply_full(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        // 浮层开合直接取快照（唯一真相源在模型；平台不翻转本地状态）。
        state.inspector_open = snapshot.inspector_open;
        if state.active_session != snapshot.active_session {
            state.active_session = snapshot.active_session.clone();
            state.view_generation = state.view_generation.wrapping_add(1);
            // 换会话 = 换了一份正文：未读标记跟着清（新会话从头看起）。
            state.jump_unread = false;
            crate::ui::chat::sync_inline_visible(
                if state.pane { "main-chat" } else { "chat" },
                Vec::new(),
            );
        }
        rebuild_panels(state, snapshot);
        rebuild_tabs(state, snapshot);
        rebuild_pending(state, snapshot);
        layout_panes_for(state);
        rebuild_canvas(state, snapshot);
        arm_deadline_timer(state);
    }
}

/// A3 待发送条重建（选择后、发送前的预览条）。
///
/// 发送成功 / 撤选 / 切会话都会让快照里的 `pending_images` 变化并经整帧刷新
/// 回到这里 —— 条目随快照整体替换，不另存第二份选择态。
///
/// 2026-10-06 用户实测两件事落在这里：
/// - 条目带**缩略图**（粘贴的图要看得见）：像素来自共享 `pending_strip` 缓存，
///   未就绪先按文字形态显示、就绪后由工作线程重推快照自动补上 —— **本函数不解码**；
/// - 条目超出条宽时**横向可滚**（子控件按内容坐标建，`layout_panes_for` 统一平移；
///   滚轮在 `scroll_pending_from_wheel`），新增条目自动滚到最右露出刚加的图。
unsafe fn rebuild_pending(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        for child in state.pending_children.drain(..) {
            DestroyWindow(child.hwnd);
            // 缩略图注册表随控件换代（owner-draw 按 hwnd 查表，旧句柄不留影）。
            PENDING_THUMBS.with(|images| {
                images.borrow_mut().remove(&child.hwnd);
            });
        }
        state.pending_targets.clear();
        // 条内集合就是缩略图缓存的保留集：撤选/发送/切会话后，条外像素立即下岗。
        crate::ui::chat::retain_pending_thumbs(&snapshot.pending_images);
        if snapshot.pending_images.is_empty() {
            state.pending_height = 0;
            state.pending_content_w = 0;
            state.pending_scroll_x = 0;
            state.pending_count = 0;
            state.pending_reveal_end = false;
            update_send_enabled(state); // 待发送区变化 = 「发送」可用态的输入之一
            return; // 空 = 已释放（控件不必存在）
        }
        let scale = dpi_scale(state.hwnd);
        let hinstance = GetModuleHandleW(std::ptr::null());
        let height = scaled(PENDING_HEIGHT, scale);
        let chip_h = scaled(PENDING_CHIP_HEIGHT, scale);
        // 条目高 = chip 高、在条内垂直居中（设计稿 `.pend` 的 5px 上下内边距），
        // 左起 `PENDING_PAD_X`（`.pend` 的 10px 左右内边距）。
        let chip_y = ((height - chip_h) / 2).max(0);
        let mut x = scaled(PENDING_PAD_X, scale);
        let mut thumbs: Vec<(HWND, DecodedFrame)> = Vec::new();
        for (index, image) in snapshot.pending_images.iter().enumerate() {
            let label = crate::ui::chat::pending_label(image);
            // 缩略图只查缓存/登记任务（解码在 `deskpet-pending-thumb` 工作线程）；
            // 未就绪（Loading/Unavailable）按纯文案走 —— 不显示半个图。
            let thumb = match crate::ui::chat::pending_thumb(image) {
                crate::ui::chat::PendingThumbStatus::Ready(frame) => {
                    let (thumb_w, thumb_h) = crate::ui::chat::pending_strip::thumb_display_size(
                        frame.width,
                        frame.height,
                    );
                    Some((frame, thumb_w, thumb_h))
                }
                _ => None,
            };
            let text_width = crate::ui::chat::panels::estimated_text_width(&label, 12.0);
            let thumb_width = thumb
                .as_ref()
                .map(|(_, width, _)| f64::from(*width))
                .unwrap_or(0.0);
            let logical = crate::ui::chat::pending_strip::chip_width(
                text_width,
                thumb_width,
                f64::from(PENDING_ITEM_MIN_WIDTH),
                f64::from(PENDING_ITEM_MAX_WIDTH),
            )
            .round() as i32;
            let width = scaled(logical, scale);
            let hwnd = CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(&label).as_ptr(),
                WS_CHILD | WS_VISIBLE,
                x,
                chip_y,
                width,
                chip_h,
                state.hwnd,
                (PENDING_BASE + index as i32) as HMENU,
                hinstance,
                std::ptr::null(),
            );
            if hwnd != 0 {
                make_themed_button_r(hwnd, ButtonRole::Pending, scale, theme::tokens().radii.sm);
                if let Some((frame, _, _)) = thumb {
                    thumbs.push((hwnd, frame));
                }
                state.pending_children.push(ChildEntry {
                    hwnd,
                    x,
                    y: chip_y,
                    w: width,
                    h: chip_h,
                });
                if let Some(font) = state.fonts.get(1) {
                    SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
                }
            }
            state.pending_targets.push(image.path.clone());
            x += width + scaled(6, scale);
        }
        PENDING_THUMBS.with(|images| {
            let mut images = images.borrow_mut();
            for (hwnd, frame) in thumbs {
                images.insert(hwnd, frame);
            }
        });
        // 内容总宽走共享几何（与 macOS 同一口径；单位 = 物理像素，各输入同单位）。
        let widths: Vec<f64> = state
            .pending_children
            .iter()
            .map(|child| f64::from(child.w))
            .collect();
        state.pending_content_w = crate::ui::chat::pending_strip::strip_content_width(
            &widths,
            f64::from(scaled(PENDING_PAD_X, scale)),
            f64::from(scaled(6, scale)),
        )
        .round() as i32;
        // 新增条目（张数变多）→ 由 layout 滚到最右，把刚加的图露出来。
        let count = snapshot.pending_images.len();
        if count > state.pending_count {
            state.pending_reveal_end = true;
        }
        state.pending_count = count;
        state.pending_height = height;
        update_send_enabled(state); // 待发送区变化 = 「发送」可用态的输入之一
                                    // 条内容变化（增删条目/滚动偏移）也要重画条底的滚动指示；条目控件自身的
                                    // 重绘范围不含那条细线。几何未变时 layout 不会整窗作废，这里显式作废条区
                                    //（首次重建时 `paint.pending` 还是空矩形，作废零面积 = no-op，随后 layout
                                    // 因条区从无到有整窗作废一次）。
        InvalidateRect(state.hwnd, &state.paint.pending, 0);
    }
}

/// 滚轮 → 待发送条横向滚动；返回是否消费本次滚轮。
///
/// 只有「光标在待发送条内」且「内容宽超过条宽」才消费（不抢画布/其它控件的滚轮）。
/// 判定用 `GetCursorPos` 换算到客户区而不是看焦点：子按钮持焦点时滚轮消息同样转到
/// 本窗，按光标位置判与「鼠标在哪就滚哪」的直觉一致。滚动量与钳制走共享
/// `pending_strip::clamp_scroll`，重排复用 `layout_panes_for`（唯一摆放口径）。
fn scroll_pending_from_wheel(hwnd: HWND, msg: u32, wparam: WPARAM) -> bool {
    unsafe {
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point) == 0 {
            return false;
        }
        ScreenToClient(hwnd, &mut point);
        let target = CHAT.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|state| !rect_is_empty(&state.paint.pending))
                .map(|state| (win_rect_of(&state.paint.pending), state.pending_content_w))
        });
        let Some((pending, content_w)) = target else {
            return false;
        };
        let max_scroll = (content_w - pending.w).max(0);
        if max_scroll == 0 || !rect_contains(pending, point.x, point.y) {
            return false;
        }
        // 滚轮增量在**高字**（低字是按键标志）；纵向轮向下 = 往右看（露出右侧条目），
        // 横向轮向右 = 往右看 —— 与 macOS 触控板横扫/滚轮的方位一致。
        let delta = i32::from(((wparam >> 16) & 0xFFFF) as u16 as i16);
        if delta == 0 {
            return false;
        }
        let direction = if msg == WM_MOUSEHWHEEL { delta } else { -delta };
        let step = scaled(PENDING_SCROLL_STEP, dpi_scale(hwnd)) * direction / 120;
        // 高分辨率滚轮（±小于一格）至少给 1 像素，避免整格没有反应。
        let shift = if step == 0 {
            direction.signum()
        } else {
            step.clamp(-max_scroll, max_scroll)
        };
        with_chat(|state| {
            state.pending_scroll_x = (state.pending_scroll_x + shift).clamp(0, max_scroll);
            // 唯一摆放口径：重排由 `layout_panes_for` 统一做（含偏移钳制与 reveal）。
            layout_panes_for(state);
            // 指示条 thumb 位置随滚动变，而它不在条目控件的重绘范围里：显式作废条区。
            InvalidateRect(state.hwnd, &state.paint.pending, 0);
        });
        true
    }
}

/// A3：读一次 HDROP 里的全部文件路径（**不释放** HDROP —— 释放责任归调用方：
/// `WM_DROPFILES` 的句柄必须由 `DragFinish` 归还，剪贴板 `CF_HDROP` 的句柄归
/// 剪贴板所有、不能 `DragFinish`）。只取路径，不读文件内容。
unsafe fn read_hdrop_paths(hdrop: HDROP) -> Vec<String> {
    unsafe {
        let count = DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let written = DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), length + 1);
            if written == 0 {
                continue;
            }
            paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
        }
        paths
    }
}

/// 拖入/粘贴文件路径的统一归宿（准入与图像域判定在工作线程；失败走中性通知，
/// 与既有拖入行为同一条）。
fn enqueue_dropped_paths(paths: Vec<String>) {
    if let Err(error) = crate::ui::chat::add_dropped_images(paths) {
        crate::ui::chat::set_notice(Some(format!("图片未添加：{error}")));
    }
}

/// A3：读取一次 `WM_DROPFILES` 的文件路径并交待发送区（准入在工作线程）。
///
/// `hdrop` 必须在消息处理内消费（`DragFinish` 归还）；只取路径，不读文件内容。
unsafe fn handle_dropped_files(hdrop: HDROP) {
    unsafe {
        let paths = read_hdrop_paths(hdrop);
        DragFinish(hdrop);
        enqueue_dropped_paths(paths);
    }
}

// ══════════ 剪贴板粘贴图片（A3 图片通路第三条：选择器 / 拖入 / 粘贴）══════════

/// 剪贴板读取结果（**必须在 `OpenClipboard` 期间取完**：句柄随关闭失效）。
enum ClipboardPayload {
    /// 已是可解码图片字节（DIB 系已补 14 字节 BMP 容器头）。
    Image(Vec<u8>),
    /// 复制的文件路径（与拖入同一条准入/待发送区通路）。
    Files(Vec<String>),
    /// 没有图片也没有文件：交还 RichEdit 原生粘贴。
    None,
}

/// 处理一次输入框粘贴（`WM_PASTE`）：返回 `true` = 已消费（调用方吞掉消息），
/// `false` = 交还 RichEdit 原生粘贴。
///
/// `OpenClipboard` / `CloseClipboard` 严格配对：打开到关闭之间没有提前 return，
/// 读取的中间失败都以 [`ClipboardPayload::None`] 汇合到同一条关闭路径。
unsafe fn paste_clipboard_payload(owner: HWND) -> bool {
    unsafe {
        if OpenClipboard(owner) == 0 {
            // 剪贴板正被别的进程占用：不拦，交还 RichEdit 自己再试（原生路径）。
            return false;
        }
        let payload = read_clipboard_payload();
        CloseClipboard();
        match payload {
            ClipboardPayload::Image(bytes) => {
                match crate::ui::chat::paste::add_pasted_image(bytes) {
                    Ok(()) => {}
                    // 廉价拒绝（空/超大/格式/张数/端口未就绪）：中性文案就地展示；
                    // 转码/落盘/授权与晚到失败由粘贴工作线程经 set_notice 回报
                    // （不在平台层起线程，也不在这里做重活）。
                    Err(text) => crate::ui::chat::set_notice(Some(text)),
                }
                true
            }
            ClipboardPayload::Files(paths) => {
                enqueue_dropped_paths(paths);
                true
            }
            ClipboardPayload::None => false,
        }
    }
}

/// 读一次剪贴板（调用方已完成 `OpenClipboard`）：图片优先
/// （`CF_DIBV5` → `CF_DIB` → `CF_BITMAP`），其次复制的文件（`CF_HDROP`）。
unsafe fn read_clipboard_payload() -> ClipboardPayload {
    unsafe {
        if let Some(bytes) = clipboard_image_bytes() {
            return ClipboardPayload::Image(bytes);
        }
        if IsClipboardFormatAvailable(CF_HDROP) != 0 {
            let handle = GetClipboardData(CF_HDROP);
            if handle != 0 {
                // CF_HDROP 的句柄就是 HDROP：DragQueryFileW 直接读（不 DragFinish）。
                let paths = read_hdrop_paths(handle as HDROP);
                if !paths.is_empty() {
                    return ClipboardPayload::Files(paths);
                }
            }
        }
        ClipboardPayload::None
    }
}

/// 剪贴板里的图片 → 可解码的 BMP 文件字节（无图片给 `None`）。
/// 调用方必须已 `OpenClipboard`（句柄只在剪贴板打开期间有效）。
unsafe fn clipboard_image_bytes() -> Option<Vec<u8>> {
    unsafe {
        // 顺序即优先级：DIBV5（带 alpha 的现代格式）→ DIB（40 字节头最常见）。
        for format in [CF_DIBV5, CF_DIB] {
            if IsClipboardFormatAvailable(format) == 0 {
                continue;
            }
            let handle = GetClipboardData(format);
            if handle == 0 {
                continue;
            }
            let block = handle as HGLOBAL;
            let pointer = GlobalLock(block);
            if pointer.is_null() {
                continue;
            }
            let size = GlobalSize(block);
            if size > CLIPBOARD_COPY_LIMIT {
                // 畸大内存块：解锁后换下一个格式（准入在共享层，这里只兜分配）。
                GlobalUnlock(block);
                continue;
            }
            // 拷出为 Rust 字节（真正的解码在粘贴工作线程，不占 UI 主线程）。
            let bytes = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
            // 只读快照、不改剪贴板归属；`GlobalUnlock` 对可移动内存成功时同样返回 0
            // （要配 GetLastError 才能区分），这里如实忽略返回值。
            GlobalUnlock(block);
            if let Some(bmp) = bmp_container_from_dib(&bytes) {
                return Some(bmp);
            }
        }
        // CF_BITMAP：句柄是 HBITMAP（不是内存块），经 GetDIBits 取回 DIB。
        if IsClipboardFormatAvailable(CF_BITMAP) != 0 {
            let handle = GetClipboardData(CF_BITMAP);
            if handle != 0 {
                return bitmap_handle_to_bmp(handle as HBITMAP);
            }
        }
        None
    }
}

/// `CF_BITMAP` 的 HBITMAP → 32bpp BI_RGB 的 DIB → BMP 字节（与 DIB 路径共用补头）。
unsafe fn bitmap_handle_to_bmp(hbm: HBITMAP) -> Option<Vec<u8>> {
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return None;
        }
        // 第一步只查尺寸：`biSize` 预填、`lpvBits = NULL`、`cLines = 0` 时 GetDIBits
        // 把宽高写回 `BITMAPINFOHEADER`（MSDN GetDIBits 备注的查询用法）。
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        GetDIBits(
            dc,
            hbm,
            0,
            0,
            std::ptr::null_mut(),
            &mut info,
            DIB_RGB_COLORS,
        );
        let width = info.bmiHeader.biWidth;
        let height = info.bmiHeader.biHeight;
        if width <= 0 || height <= 0 {
            // 负高 = 顶置（downward）DIB；CF_BITMAP 不是该形态，如实拒绝。
            DeleteDC(dc);
            return None;
        }
        // 统一请求 32bpp BI_RGB：GetDIBits 自行做格式转换（含调色板位图），
        // 输出无色表 —— 补 BMP 头时不必再算色表字节数。
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        info.bmiHeader.biSizeImage = 0;
        let pixel_bytes = width as usize * height as usize * 4;
        let mut pixels = vec![0u8; pixel_bytes];
        let copied = GetDIBits(
            dc,
            hbm,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteDC(dc);
        if copied == 0 {
            return None;
        }
        // 40 字节头 + 像素 = DIB 块；与 CF_DIB 路径共用同一个容器补头。
        let header = std::slice::from_raw_parts(
            std::ptr::addr_of!(info.bmiHeader) as *const u8,
            std::mem::size_of::<BITMAPINFOHEADER>(),
        );
        let mut dib = Vec::with_capacity(header.len() + pixel_bytes);
        dib.extend_from_slice(header);
        dib.extend_from_slice(&pixels);
        bmp_container_from_dib(&dib)
    }
}

/// DIB 内存块 → BMP 文件字节：补 14 字节 `BITMAPFILEHEADER`。
///
/// 结构依据：剪贴板给的是「设备无关位图」（`BITMAPINFOHEADER` / `BITMAPV4HEADER` /
/// `BITMAPV5HEADER` + 可选色表 + 像素），而 BMP 文件在 14 字节文件头之后就是同一份
/// DIB —— 补头只需写两处字段、其余清零：
/// - 偏移 0..2 = `"BM"`；偏移 2..6 `bfSize` = 14 + DIB 全长；偏移 6..10 两个保留
///   字段 = 0；偏移 10..14 `bfOffBits` = 14 + `biSize` + 色表字节数。
/// - `biSize` = DIB 内存块的前 4 字节（40/108/124 对应 V3/V4/V5；解码端
///   image crate 0.25 三种头都认）。
/// - `BITMAPINFOHEADER` 的固定偏移（V4/V5 是它的扩展，字段偏移相同）：`biBitCount`
///   14..16、`biCompression` 16..20、`biClrUsed` 32..36。色表字节数：bpp ≤ 8 时
///   项数 = `biClrUsed` 非 0 取它、否则 `1 << bpp`（每项 4 字节）；40 字节头 +
///   `BI_BITFIELDS` 时头后跟 3 个掩码 DWORD（12 字节）；V4/V5 的掩码含在头内，不算。
///
/// 返回 `None` = 头不合法（`biSize` < 40 或色表越过缓冲）：调用方按「不是可解码
/// 图片」处理，绝不拼一个解码必然失败的假文件去骗准入。
fn bmp_container_from_dib(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 4 {
        return None;
    }
    let bi_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]);
    if bi_size < 40 || bi_size as usize > dib.len() {
        return None;
    }
    let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]);
    let palette_bytes = if bit_count <= 8 {
        let entries = if clr_used != 0 {
            clr_used.min(256)
        } else {
            1u32 << bit_count
        };
        entries as usize * 4
    } else if compression == BI_BITFIELDS && bi_size == 40 {
        12
    } else {
        0
    };
    let off_bits = 14 + bi_size as usize + palette_bytes;
    if off_bits > 14 + dib.len() {
        return None;
    }
    let file_size = 14 + dib.len();
    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]); // bfReserved1 / bfReserved2
    bmp.extend_from_slice(&(off_bits as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

/// 按当前最早的面板期限布一次一次性定时器（无期限时停表）。
fn arm_deadline_timer(state: &ChatWinState) {
    unsafe {
        KillTimer(state.hwnd, TIMER_DEADLINE);
    }
    if let Some(next) = crate::ui::chat::next_deadline_ms() {
        let now = crate::ui::platform::now_ms();
        let delay = next.saturating_sub(now).max(20);
        unsafe {
            SetTimer(
                state.hwnd,
                TIMER_DEADLINE,
                delay.min(u64::from(u32::MAX)) as u32,
                None,
            );
        }
    }
}

// ==========================================
// W8b 面板区（计划/权限/队列/中断/slash 候选）+ 把手带 + 浮层 Inspector
// ==========================================

/// 重建面板子控件（快照里的渲染块 → 按 `layout_panels` 的 frame 建控件）。
///
/// 摆放几何（换行、越界夹取、空间不足跳过整块）来自平台无关的
/// [`crate::ui::chat::panels::layout_panels`]：本函数只按 frame 建控件。
/// 旧实现把摆放规则在这里重写了一份（行内按钮不换行 + 高度不够即终止），
/// 与 macOS 侧不对称，且越界按钮会被窗口边缘裁掉、尾随控件被静默丢弃
/// （用户报告的「档位控件点不动」根因之一）。
///
/// 2026-10-05 第三波：老版上拉抽屉（用量/调试/投递 chip 堆）退场 ——
/// - 流内只留决策 / Transient（判定走共享层 `surface()`，平台层不另写 matches!）；
/// - Inspector 面的三块（用量/调试/投递）收进同一个浮层（把手箭头开合），
///   只在 `snapshot.inspector_open` 时建内容（[`partition_panels`]）。
unsafe fn rebuild_panels(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    use crate::ui::chat::panels::layout_panels;

    unsafe {
        for child in state.panel_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        for child in state.inspector_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        for child in state.history_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        state.panel_actions.clear();
        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let width = (client.right - client.left).max(scaled(120, scale));
        let height = (client.bottom - client.top).max(0);
        // 布局全程用逻辑单位（与 macOS 同一份几何）；物理换算只在建控件时做。
        let logical_width = f64::from(width) / scale;
        // 宿主尚未布局（高度为 0）时不设上限，等 relayout 后按真实高度截断显示
        // （与 macOS `rebuild_panels` 的 host_height 守卫同口径）。
        let max_height = if height > 0 {
            f64::from(height) * PANEL_MAX_FRACTION / scale
        } else {
            f64::INFINITY
        };
        // 分区：Inspector 面全进浮层（三块同浮层，顺序 = 声明序）；是否**显示**
        // 由 `snapshot.inspector_open` 决定（见下面 overlay 段），路由与显隐分开。
        let groups = partition_panels(&snapshot.panels);
        let mut actions: Vec<PanelAction> = Vec::new();
        if groups.flow.is_empty() {
            state.panel_height = 0;
        } else {
            let layout = layout_panels(&groups.flow, logical_width, max_height);
            if layout.truncated {
                // 功能面板区上限是 45% 客户区高度（面板不挤掉输入区）；layout_panels
                // 保序跳过放不下的块（整块跳过，不留半截控件），这里留痕不静默。
                rust_debug!(
                    "面板区空间不足：已跳过部分块（保序摆放；max_height={:.0}px）",
                    f64::from(height) * PANEL_MAX_FRACTION
                );
            }
            place_panel_elements(
                state,
                PanelGroup::Functional,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.panel_height = scaled_f(layout.height, scale);
        }
        if !snapshot.inspector_open || groups.overlay.is_empty() {
            // 浮层收着（或三块都没内容）：不建内容控件 —— 层窗由
            // `layout_inspector_layer` 隐藏，遮罩也不出现。
            state.inspector_content_height = 0;
            state.inspector_viewport_height = 0;
            state.inspector_scroll_y = 0;
        } else {
            // 浮层内容宽 = 浮层盒宽（窗口宽 − 左右各 9pt）；**可视高**上限与流内面板
            // 同口径（客户区 45%），再扣掉标题行与底部内边距。
            let box_width =
                (f64::from(width) - f64::from(scaled(INSPECTOR_PAD * 2, scale))) / scale;
            let max_content = if height > 0 {
                (f64::from(height) * PANEL_MAX_FRACTION / scale
                    - f64::from(INSPECTOR_HEADER_HEIGHT + INSPECTOR_BODY_PAD_BOTTOM))
                .max(24.0)
            } else {
                f64::INFINITY
            };
            // 内容**全量摆放**（不设高度上限）：上限只决定可视区高，其余靠裁剪窗的
            // 内部滚动到达 —— 旧的「按上限摆放」会把放不下的块按序跳过（超长的
            // 「注册明细」全展开即触发，内容谁也到不了）。滚动几何走共享
            // `panel_scroll_geometry`（与 macOS 同一口径）。
            let layout = layout_panels(&groups.overlay, box_width, f64::INFINITY);
            let geometry =
                crate::ui::chat::panels::panel_scroll_geometry(layout.height, max_content);
            if geometry.max_offset > 0.0 {
                // 超可视高：内容由内部滚动可达（留痕不静默；这里不再有「丢块」的截断）。
                rust_debug!(
                    "浮层内容超可视高：已启用内部滚动（content={:.0} view={:.0}）",
                    geometry.content_height,
                    geometry.view_height
                );
            }
            place_panel_elements(
                state,
                PanelGroup::Inspector,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.inspector_content_height = scaled_f(geometry.content_height, scale);
            state.inspector_viewport_height = scaled_f(geometry.view_height, scale);
            // 滚动偏移保留（投影刷新频繁，不重置到顶）；越界由布局里统一钳制。
        }
        if groups.anchored.is_empty() {
            state.history_height = 0;
        } else {
            // 弹层内容宽 = 弹层宽 − 两侧内边距；高度上限同「客户区 45%」（内容超出由
            // `layout_panels` 保序截断，弹层在布局里还会被夹进窗口）。
            let pad = f64::from(HISTORY_POPOVER_PAD);
            let max_content = if height > 0 {
                (f64::from(height) * PANEL_MAX_FRACTION / scale - pad * 2.0).max(24.0)
            } else {
                f64::INFINITY
            };
            let layout = layout_panels(
                &groups.anchored,
                f64::from(HISTORY_POPOVER_WIDTH) - pad * 2.0,
                max_content,
            );
            if layout.truncated {
                rust_debug!(
                    "会话历史弹层空间不足：已跳过部分块（保序摆放；max_height={max_content:.0}pt）"
                );
            }
            place_panel_elements(
                state,
                PanelGroup::History,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.history_height =
                scaled_f(layout.height, scale) + scaled(HISTORY_POPOVER_PAD * 2, scale);
        }
        state.panel_actions = actions;
    }
}

/// 按呈现面把面板分到三组（判定走共享层的 `PanelKind::surface()`，平台层不写 matches!）：
/// - 决策 / Transient（slash 候选）→ 流内，永远可见；
/// - Inspector（用量 / 调试 / 投递）→ **同一个浮层**，三块全放（顺序 = 声明序）；
///   浮层开合由 `ChatSnapshot::inspector_open` 决定（不再区分「打开的是哪一块」）——
///   内容不落流内，这是「开合前后消息流 y 不变」的结构保证之一；
/// - Anchored（会话历史 → 「历史」按钮）→ 锚定弹层，**不进流内面板栈**（挂在栈里会
///   跑到页面底部、与触发它的按钮隔着大半屏，就是用户报告的「弹窗在下面」）。
struct PanelGroups {
    flow: Vec<crate::ui::chat::panels::PanelView>,
    overlay: Vec<crate::ui::chat::panels::PanelView>,
    anchored: Vec<crate::ui::chat::panels::PanelView>,
}

fn partition_panels(views: &[crate::ui::chat::panels::PanelView]) -> PanelGroups {
    use crate::ui::chat::panels::PanelSurface;
    let mut groups = PanelGroups {
        flow: Vec::new(),
        overlay: Vec::new(),
        anchored: Vec::new(),
    };
    for view in views {
        match view.kind.surface() {
            PanelSurface::Inspector => groups.overlay.push(view.clone()),
            PanelSurface::Anchored(_) => groups.anchored.push(view.clone()),
            PanelSurface::Decision | PanelSurface::Transient => groups.flow.push(view.clone()),
        }
    }
    groups
}

/// 面板子控件的归属容器（流内 / 浮层 / 历史弹层；三组共用同一动作表）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum PanelGroup {
    /// 流内面板（计划/权限/中断/队列/slash 候选）：永远可见，父 = 聊天窗。
    Functional,
    /// 浮层内容（当前开着的用量/调试/投递）：父 = 浮层窗口，随浮层显隐。
    Inspector,
    /// 会话历史弹层内容：父 = 弹层窗口，随弹层显隐。
    History,
}

/// 把 `layout_panels` 产出的元素摆进目标容器（流内面板栈与浮层内容栈共用；
/// 与 macOS `place_panel_elements` 同构）。
unsafe fn place_panel_elements(
    state: &mut ChatWinState,
    group: PanelGroup,
    elements: &[crate::ui::chat::panels::PanelElement],
    actions: &mut Vec<PanelAction>,
    scale: f64,
) {
    use crate::ui::chat::panels::PanelElement;

    unsafe {
        // 三组的承载窗口与内容坐标系不同（x/y 偏移在重建时算好，布局只做整盒平移）：
        // - Functional：父 = 聊天窗，坐标相对面板区上缘（`layout_panes_for` 平移）；
        // - Inspector：父 = 滚动裁剪窗（锚在盒内标题行之下、左右内缩让开描边），
        //   坐标相对**内容原点**（滚动前）：x 减掉内缩量、y 不再含标题行偏移，
        //   纵向滚动偏移在 `apply_inspector_scroll` 里统一平移；
        // - History：父 = 弹层窗口，四周都让开盒内边距（内容按「弹层宽 − 2×pad」
        //   布局，原点在 pad 处）。
        let (parent, content_dx, content_dy) = match group {
            PanelGroup::Functional => (state.hwnd, 0, 0),
            PanelGroup::Inspector => (
                state.inspector_scroll,
                -scaled(INSPECTOR_SCROLL_INSET, scale),
                0,
            ),
            PanelGroup::History => {
                let pad = scaled(HISTORY_POPOVER_PAD, scale);
                (state.history_layer, pad, pad)
            }
        };
        // 承载窗口没建起来时整组跳过（父句柄 0 会造出顶层窗，绝不允许）。
        if parent == 0 {
            rust_warn!(
                "悬浮层窗口不可用：面板内容未建（{} 个元素被跳过）",
                elements.len()
            );
            return;
        }
        // 卡片底板窗（`PanelElement::Card`）：建完**整批**后统一压到兄弟 z 序最底
        // （见循环后的 `SetWindowPos`）。
        let mut card_hwnds: Vec<HWND> = Vec::new();
        for element in elements {
            match element {
                PanelElement::Card { frame } => {
                    // 卡片底板 = 自绘 STATIC（`SS_OWNERDRAW`）：底与描边由父窗的
                    // `WM_DRAWITEM`/`ODT_STATIC` 段画（`draw_themed_card`），几何照
                    // `layout_panels` 的 frame 摆（平台不重算）。
                    // `WS_CLIPSIBLINGS`：底板在 z 序最底，重绘时把上方重叠的兄弟
                    // （行标签/按钮）从更新区裁掉，不会盖住它们（与输入框占位同款）。
                    let card = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        "",
                        0,
                        WS_CHILD | WS_VISIBLE | SS_OWNERDRAW | WS_CLIPSIBLINGS,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    if card != 0 {
                        card_hwnds.push(card);
                    }
                }
                PanelElement::Line { text, style, frame } => {
                    let label = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        text,
                        0,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    send_font(state, label, 1);
                    stamp_ink(label, panel_line_color(*style));
                }
                PanelElement::Button {
                    label,
                    action,
                    link,
                    frame,
                } => {
                    let id = PANEL_BASE + actions.len() as i32;
                    let control = create_panel_child(
                        state,
                        group,
                        parent,
                        "BUTTON",
                        label,
                        id,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    send_font(state, control, 0);
                    // 文字链（无底无边、仅文字）与 chip 按钮的分档在绘制层（paint_win）。
                    let role = if *link {
                        ButtonRole::Link
                    } else {
                        ButtonRole::Normal
                    };
                    make_themed_button_r(control, role, scale, theme::tokens().radii.sm);
                    actions.push(action.clone());
                }
                PanelElement::Select {
                    label,
                    options,
                    selected,
                    label_frame,
                    frame,
                } => {
                    let text = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        label,
                        0,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(label_frame.x, scale),
                        content_dy + scaled_f(label_frame.y, scale),
                        scaled_f(label_frame.width, scale),
                        scaled_f(label_frame.height, scale),
                    );
                    send_font(state, text, 1);
                    stamp_ink(text, theme::tokens().ink);
                    // 下拉：id = PANEL_SELECT_BASE + 选项动作基址；用户选定（CBN_SELENDOK）
                    // 时取 CB_GETCURSEL 叠加基址，见 WM_COMMAND 的 PANEL_SELECT_BASE 段。
                    // **圆角口径差异（就地注明）**：COMBOBOX 是系统控件，给它贴
                    // `SetWindowRgn` 会把展开的清单一起裁掉（清单是组合框的子窗口），
                    // 且开合期动态换区域要额外接 CBN_DROPDOWN/CBN_CLOSEUP。全应用
                    // 的下拉（流内面板/设置窗/编辑器）都是同一份系统外观；
                    // **主题色**已接线：三个承载父窗过程（聊天窗/浮层滚动裁剪窗/层窗）
                    // 把 `WM_CTLCOLOREDIT`/`WM_CTLCOLORLISTBOX` 转给
                    // `windows_settings::edit_ctlcolor`，这里不单独开第二条路径；
                    // 登记过的后续项只剩**圆角**（仍是系统下拉外观）。
                    let base = actions.len() as i32;
                    let combo = create_panel_child(
                        state,
                        group,
                        parent,
                        "COMBOBOX",
                        "",
                        PANEL_SELECT_BASE + base,
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        // 高度含下拉清单（显示域高度由字体决定；照编辑器下拉的先例——
                        // windows_editor.rs 的素材下拉同样给足高度）。**实机核验点**：
                        // 未展开时窗口矩形整体参与命中测试，超高部分可能遮挡相邻控件
                        // （本机不可编译验证；若实机发现下拉「点不动」，优先查这里，
                        // 备选方案是创建后 SetWindowRgn 只留显示域）。
                        scaled_f(frame.height + 160.0, scale),
                    );
                    send_font(state, combo, 0);
                    for option in options {
                        SendMessageW(
                            combo,
                            CB_ADDSTRING,
                            0,
                            wide(&option.label).as_ptr() as LPARAM,
                        );
                    }
                    SendMessageW(combo, CB_SETCURSEL, *selected, 0);
                    for option in options {
                        actions.push(option.action.clone());
                    }
                }
            }
        }
        // 卡片底板统一压到兄弟 z 序最底 —— 底板必须**垫在**内容下（元素顺序已把它
        // 排在内部元素之前，但子窗创建后的默认 z 序不保证：占位标签那处已实证
        // 「不能只靠创建顺序」）。配合 `WS_CLIPSIBLINGS`，底板重绘不会盖住上面的行/按钮。
        for card in card_hwnds {
            SetWindowPos(
                card,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            // 自绘 STATIC 只在自身更新区非空时才把 `WM_DRAWITEM` 转给父窗：显式作废
            // 一次，建窗后立刻有底，不依赖父窗后续重绘的先后（不擦除：底会填满整框）。
            InvalidateRect(card, std::ptr::null(), 0);
        }
    }
}

// ==========================================
// A1：会话标签条
// ==========================================

/// 重建标签条动态按钮（会话说整表来自投影；每次都整体替换）。
///
/// 活跃标签用「▸ 」前缀标记（Win32 BUTTON 没有跨版本可靠的按下态；用文字标记
/// 等价表达高亮语义）；中断标记用「 !」后缀（等价于圆点角标）。
/// 顶栏（品牌/状态位/关闭「×」）不在这里：它归主窗的全窗宽顶栏（`windows_main.rs`），
/// 状态位文本由 `windows.rs::refresh_titlebar` 直接推给那一份展示副本。
unsafe fn rebuild_tabs(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        if !state.pane {
            return;
        }
        for child in state.tab_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        state.session_targets.clear();
        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let width = client.right - client.left;
        let nav_h = scaled(NAV_CONTROL_HEIGHT, scale);
        let right_reserve = scaled(NAV_NEW_WIDTH + NAV_HISTORY_WIDTH + 12, scale);
        let mut x = scaled(4, scale);
        for tab in &snapshot.sessions {
            let name_width = tab_name_width(&tab.name, scale);
            // 2026-10-05 用户规则「会话 tab 的 × 应该在气泡里面」：pill 加宽到
            // 「名字 + 间隙 + ×」，× 落在 pill **内部**的右格 —— 选中标签的材质
            // 从背后包住 ×（原先 × 是 pill 外的独立控件，高亮包不住它）。
            let close_w = if tab.closable {
                scaled(TAB_CLOSE_WIDTH, scale)
            } else {
                0
            };
            let close_gap = if tab.closable {
                scaled(TAB_CLOSE_GAP, scale)
            } else {
                0
            };
            let tab_w = name_width + close_gap + close_w;
            if x + tab_w + scaled(2, scale) > width - right_reserve {
                // 空间不够：右侧「+」「历史」入口优先，其余标签本帧不显示。
                break;
            }
            // 标签文字就是会话名：macOS `rebuild_tabs` 不给选中标签加任何前缀
            // （选中语义由 pill 底表达）。旧实现在这里用「▸ 」当按下态标记，
            // 与 mac 的字面不一致，已删除。
            let mut title = tab.name.clone();
            if tab.interrupted {
                title.push_str(" !");
            }
            let index = state.session_targets.len();
            // 选中标签的底是 mac 的 pill 视图（完整渐变 + 描边 + 立体线 + 投影），
            // 不是按钮面 —— 角色见 `ButtonRole::TabPill`。
            let tab_role = if tab.active {
                ButtonRole::TabPill
            } else {
                ButtonRole::TabOff
            };
            create_nav_child(
                state,
                &title,
                SESSION_TAB_BASE + index as i32,
                x,
                tab_w,
                nav_h,
                tab_role,
            );
            if tab.closable {
                // × 用**无底**角色（TabOff）：选中时 pill 的材质/高亮包住它，不再
                // 出现「实底小方块压在 pill 上」的 pill 外观感。id 段不变。
                create_nav_child(
                    state,
                    "×",
                    SESSION_CLOSE_BASE + index as i32,
                    x + name_width + close_gap,
                    close_w,
                    nav_h,
                    ButtonRole::TabOff,
                );
            }
            x += tab_w + scaled(2, scale);
            state.session_targets.push(tab.id.clone());
        }
    }
}

/// 标签条动态按钮：创建并登记到 `tab_children`（父窗口是聊天窗本体；
/// 坐标由 `layout_nav` 统一摆放）。
unsafe fn create_nav_child(
    state: &mut ChatWinState,
    text: &str,
    id: i32,
    x: i32,
    w: i32,
    h: i32,
    role: ButtonRole,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(text).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            x,
            0,
            w,
            h,
            state.hwnd,
            id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        // 小号字体（标签条控件同口径）。
        if let Some(font) = state.fonts.get(1) {
            SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
        }
        make_themed_button_r(hwnd, role, dpi_scale(state.hwnd), theme::tokens().radii.sm);
        state.tab_children.push(ChildEntry {
            hwnd,
            x,
            y: 0,
            w,
            h,
        });
        hwnd
    }
}

/// 标签名称宽度（字符宽度估算 → 夹取；与 macOS `session_tab_name_width` 同口径）。
fn tab_name_width(name: &str, scale: f64) -> i32 {
    let logical = (crate::ui::chat::panels::estimated_text_width(name, 11.0) + 16.0)
        .clamp(f64::from(TAB_MIN_WIDTH), f64::from(TAB_MAX_WIDTH));
    scaled(logical.round() as i32, scale)
}

/// 派发一个面板动作并按**动作后的新快照**整帧重建。
///
/// **为什么要立即重建**（用户报告「投递在下拉栏选完之后显示不刷新，必须收回再打开
/// 才更新」的根因与修法）：显示类本地动作只改模型 + `schedule_refresh()`，而刷新走
/// **版本号比对** —— 当时代码里的本地 setter 没有 bump `panel_revision`，`drain_refresh`
/// 便认为「面板没变」把刷新丢掉，界面停在旧状态（重新打开浮层只是碰巧撞上别的
/// 重建时机）。这里在派发后无条件重建：与 `toggle_inspector_ui` / `close_history_ui`
/// 的既有模式一致，覆盖**所有**动作（今后再有忘记 bump 的本地 setter 也不会漏）。
/// 代价：本来就会 bump 的动作（展开开关 / slash 填入 / 会话历史 / 计划权限回执等）
/// 会多一次整帧重建——用户点击频率低、重建在毫秒级，可接受。
/// 更省的做法是共享层给本地 setter 补 `panel_revision += 1`（本体 `ChatModel`，
/// 本平台层不改；已登记在交付报告）。
unsafe fn dispatch_panel_action(action: PanelAction) {
    unsafe { handle_panel_outcome(crate::ui::chat::apply_panel_action(action)) };
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 面板动作结果的统一归宿（只由 [`dispatch_panel_action`] 调用；失败如实通知）。
unsafe fn handle_panel_outcome(result: crate::error::AppResult<PanelOutcome>) {
    match result {
        Ok(PanelOutcome::FillInput(text)) => {
            let input = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.input));
            if let Some(input) = input {
                let length = text.encode_utf16().count() as WPARAM;
                unsafe {
                    SetWindowTextW(input, wide(&text).as_ptr());
                    SendMessageW(input, EM_SETSEL, length, length as LPARAM);
                }
            }
            crate::ui::chat::set_notice(None);
        }
        // 提问「其它」：不改文本，只把焦点交回输入框（用户下一条消息就是自由回答）。
        // 复用呼出路径的聚焦实现（可见性判断与留痕都在它内部；未在 Windows 实机验证）。
        Ok(PanelOutcome::FocusInput) => {
            let focused = focus_main_pane_input();
            if !focused {
                rust_debug!("提问「其它」后聚焦跳过：聊天面板未挂载或当前不可见");
            }
            crate::ui::chat::set_notice(None);
        }
        Ok(PanelOutcome::None) => crate::ui::chat::set_notice(None),
        // 动作成功的中性瞬时回执（旧壳 showDeliveryNote 的迁移）。
        Ok(PanelOutcome::Notice(text)) => crate::ui::chat::set_notice(Some(text)),
        Err(error) => {
            // 派发失败不做乐观 UI 变更；错误详情（远端错误可能较长）走模态对话框，
            // 用户可复制反馈，不用一行 notice 埋掉（见 ui::chat::dialog）。
            crate::ui::chat::dialog::show_failure(
                "操作未送达",
                "本次操作没有送达，界面未做改动。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
}

/// 面板子控件创建（父窗口由 `parent` 给：流内 = 聊天窗本体、浮层 = 浮层窗口；
/// 按 `group` 登记到对应子控件表，不随画布滚动）。
#[allow(clippy::too_many_arguments)]
unsafe fn create_panel_child(
    state: &mut ChatWinState,
    group: PanelGroup,
    parent: HWND,
    class: &str,
    title: &str,
    control_id: i32,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(title).as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent,
            control_id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        if hwnd != 0 {
            let entry = ChildEntry {
                hwnd,
                x,
                y,
                w: width,
                h: height,
            };
            match group {
                PanelGroup::Functional => state.panel_children.push(entry),
                PanelGroup::Inspector => state.inspector_children.push(entry),
                PanelGroup::History => state.history_children.push(entry),
            }
        }
        hwnd
    }
}

/// `PanelLineStyle` → 主题字色（Normal/Dim/Warn/Ok → ink/dim/warn/ok）。
fn panel_line_color(style: PanelLineStyle) -> crate::ui::theme::Rgba {
    let t = theme::tokens();
    match style {
        PanelLineStyle::Normal => t.ink,
        PanelLineStyle::Dim => t.dim,
        PanelLineStyle::Warn => t.warn,
        PanelLineStyle::Ok => t.ok,
    }
}

/// slash 补全填入（把 `/<name>` 写回输入框并把光标移到末尾；不执行命令）。
unsafe fn autofill_selected_slash(input: HWND) {
    let Some(fill) = crate::ui::chat::slash_autofill() else {
        return;
    };
    let length = fill.encode_utf16().count() as WPARAM;
    unsafe {
        SetWindowTextW(input, wide(&fill).as_ptr());
        SendMessageW(input, EM_SETSEL, length, length as LPARAM);
    }
    // 程序化填入后显式刷新（与 `send_from_input` 清空后的口径一致：不依赖
    // RichEdit 对 `SetWindowTextW` 是否补发 EN_CHANGE）——占位要立即收起。
    with_chat(|state| update_send_enabled(state));
}

/// 打开（或前移）独立查看器窗（`WindowId::Viewer`，W5 的附属窗设施）。
pub(crate) fn open_viewer_window() {
    match super::windows::open_aux_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已打开/前移"),
        Err(error) => rust_warn!("查看器窗口打开失败: {error}"),
    }
}

/// 关闭查看器窗（未打开时按 debug 记录）。
pub(crate) fn close_viewer_window() {
    match super::windows::close_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已关闭"),
        Err(error) => rust_debug!("查看器窗口无需关闭: {error}"),
    }
}

/// 查看器内容挂载（`windows.rs` 的 `open_aux` 在创建 `WindowId::Viewer` 后调用）。
pub(crate) fn install_viewer_content(hwnd: HWND) {
    VIEWER.with(|cell| {
        *cell.borrow_mut() = Some(ViewerState {
            hwnd,
            width: 0,
            height: 0,
            bgra: Vec::new(),
        });
    });
    rust_info!("查看器内容已挂载（等待 PreviewManager 首帧）");
}

/// 查看器帧更新（首帧与动画帧都走这里）。
pub(crate) fn viewer_set_frame(frame: DecodedFrame) {
    // RGBA → BGRA（BI_RGB 32bpp；查看器不做 alpha 合成，逐帧转换成本可接受）。
    let mut bgra = Vec::with_capacity(frame.rgba.len());
    for pixel in frame.rgba.chunks_exact(4) {
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    VIEWER.with(|cell| {
        let mut viewer = cell.borrow_mut();
        let Some(viewer) = viewer.as_mut() else {
            rust_debug!("查看器帧到达但窗口未开/已关，丢弃");
            return;
        };
        viewer.width = frame.width as i32;
        viewer.height = frame.height as i32;
        viewer.bgra = bgra;
        unsafe { InvalidateRect(viewer.hwnd, std::ptr::null(), 1) };
    });
}

/// 查看器窗口绘制（`windows.rs` 的 aux_wndproc 在 WM_PAINT 调用）。
pub(crate) fn paint_viewer(hwnd: HWND) {
    unsafe {
        let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        VIEWER.with(|cell| {
            let viewer = cell.borrow();
            let Some(viewer) = viewer.as_ref() else {
                return;
            };
            if viewer.bgra.is_empty() || viewer.width <= 0 || viewer.height <= 0 {
                return;
            }
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: viewer.width,
                biHeight: -viewer.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            StretchDIBits(
                hdc,
                0,
                0,
                client.right - client.left,
                client.bottom - client.top,
                0,
                0,
                viewer.width,
                viewer.height,
                viewer.bgra.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
        });
        EndPaint(hwnd, &ps);
    }
}

/// 查看器窗口销毁（`windows.rs` 的 aux_wndproc 在 WM_DESTROY 调用）。
pub(crate) fn note_viewer_destroyed() {
    VIEWER.with(|cell| *cell.borrow_mut() = None);
    crate::ui::chat::note_viewer_window_closed();
}

// ==========================================
// 窗口创建与布局
// ==========================================

/// 注册聊天窗/画布类并装载 RichEdit（顶层窗与主窗面板共用同一份）。
unsafe fn ensure_chat_classes() -> Result<(), String> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 类名的 UTF-16 缓冲必须先绑定再取指针（临时 Vec 会立刻析构，指针悬垂）。
    let chat_class = wide(CHAT_CLASS);
    let canvas_class = wide(CANVAS_CLASS);
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = Some(chat_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = chat_class.as_ptr();
        if RegisterClassW(&wc) == 0 {
            return Err("RegisterClassW（聊天窗）失败".into());
        }
        let mut canvas: WNDCLASSW = std::mem::zeroed();
        canvas.style = CS_HREDRAW | CS_VREDRAW;
        canvas.lpfnWndProc = Some(canvas_wndproc);
        canvas.hInstance = hinstance;
        canvas.lpszClassName = canvas_class.as_ptr();
        if RegisterClassW(&canvas) == 0 {
            return Err("RegisterClassW（聊天画布）失败".into());
        }
        // 浮层 Inspector 的承载窗口类（遮罩 + 浮层盒绘制 + 承载内容子控件）。
        let inspector_class = wide(LAYER_CLASS);
        let mut inspector: WNDCLASSW = std::mem::zeroed();
        inspector.style = CS_HREDRAW | CS_VREDRAW;
        inspector.lpfnWndProc = Some(overlay_layer_wndproc);
        inspector.hInstance = hinstance;
        inspector.lpszClassName = inspector_class.as_ptr();
        if RegisterClassW(&inspector) == 0 {
            return Err("RegisterClassW（浮层 Inspector）失败".into());
        }
        // 浮层内容滚动裁剪窗的窗口类（`WS_VSCROLL` 容器；只画盒底）。
        let scroll_class = wide(INSPECTOR_SCROLL_CLASS);
        let mut scroll: WNDCLASSW = std::mem::zeroed();
        scroll.lpfnWndProc = Some(inspector_scroll_wndproc);
        scroll.hInstance = hinstance;
        scroll.lpszClassName = scroll_class.as_ptr();
        if RegisterClassW(&scroll) == 0 {
            return Err("RegisterClassW（浮层滚动窗）失败".into());
        }
    }

    // RichEdit 4.1 需要先装载 Msftedit.dll；失败即如实报错（不静默降级成纯文本壳）。
    let lib = unsafe { LoadLibraryW(wide("Msftedit.dll").as_ptr()) };
    if lib == 0 {
        return Err("Msftedit.dll 装载失败，RichEdit 不可用".into());
    }
    Ok(())
}

unsafe fn create_chat_window() -> Result<(), String> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    unsafe { ensure_chat_classes()? };

    let system_dpi = unsafe { GetDpiForSystem().max(DPI_BASELINE) };
    let startup_scale = f64::from(system_dpi) / f64::from(DPI_BASELINE);
    let width = scaled(CHAT_WINDOW_WIDTH, startup_scale);
    let height = scaled(CHAT_WINDOW_HEIGHT, startup_scale);
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let x = (screen_w - width) / 2;
    let y = (screen_h - height) / 2;

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(CHAT_CLASS).as_ptr(),
            wide("聊天 - 虚拟桌宠").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            width,
            height,
            0,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        return Err("聊天窗 CreateWindowExW 失败".into());
    }
    // 独立顶层窗（父句柄 0） + 高于主窗的层级。W9a：经 `WindowId::Chat` 查表
    // （`creation_level` 是唯一映射，不在这里复制档位）。
    let level = crate::ui::creation_level(WindowId::Chat);
    unsafe {
        crate::window::platform::apply_windows_window_level(hwnd, level);
        SetForegroundWindow(hwnd);
    }
    Ok(())
}

/// 创建子控件（WM_CREATE 时调用，与原型同构）。
///
/// `pane` 由父窗口判定：有父窗口 = 主窗内聊天面板（W9a），无父窗口 = 独立聊天窗。
unsafe fn build_children(hwnd: HWND) {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = dpi_scale(hwnd);
    let pane = unsafe { GetParent(hwnd) } != 0;

    // ── 画布（可滚动堆叠容器，承载消息 RichEdit 与占位按钮）──
    let canvas = unsafe {
        CreateWindowExW(
            0,
            wide(CANVAS_CLASS).as_ptr(),
            wide("").as_ptr(),
            // `WS_CLIPSIBLINGS`：画布与浮层/弹层是重叠兄弟窗。缺它时画布重绘会把
            // 自己画进**上层浮层**的区域（本文件同类问题已有定论，见占位标签与
            // 面板底板的同款注释），实机症状就是「浮层开了、内容也对，但屏幕上
            // 被画布盖回原样」——只有外部强制重绘浮层才看得见（2026-10-07）。
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            100,
            100,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── 输入区（多行 RichEdit，原生 IME；Enter 语义在子类里）──
    let input = unsafe {
        CreateWindowExW(
            // 不挂 WS_EX_CLIENTEDGE：那是系统给的单像素下沉立体边框，与 macOS 的
            // 圆角输入槽差得远（用户 2026-10-07 实拍「原生样式、丑」）。输入槽的
            // 圆角底/描边由聊天窗自己的 `paint_input_slot` 画在控件之下。
            0,
            wide("RICHEDIT50W").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD
                | WS_VISIBLE
                // 不挂 WS_VSCROLL：多行输入右侧会多出一条原生滚动条（含上下箭头），
                // macOS 侧没有这条；超长文本靠 `ES_AUTOVSCROLL` 跟随插入符滚动。
                // 占位标签是叠在输入框上的兄弟控件：本控件开 `WS_CLIPSIBLINGS` 后，
                // 重绘时会把上方的重叠兄弟（占位 STATIC）从更新区裁掉，不会把它盖住。
                | WS_CLIPSIBLINGS
                | ES_MULTILINE as u32
                | ES_AUTOVSCROLL as u32
                | ES_WANTRETURN as u32,
            0,
            0,
            100,
            scaled(INPUT_HEIGHT, scale),
            hwnd,
            INPUT_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── 输入区占位（「说点什么…」）：自绘等价物 ──
    //
    // 输入控件是多行 RichEdit（不是标准 EDIT），`EM_SETCUEBANNER` 对 RichEdit
    // 没有可依赖的公开语义（且失配时是静默无效，不会报错），所以用**覆盖式
    // STATIC**：建在输入框之后，并显式抬到兄弟 z 序最上（`winuser` 文档：子窗口
    // 创建后默认落在 z 序**最底**，不能只靠创建顺序）；可见性由 `update_send_enabled`
    // 按文本是否为空驱动（与 macOS 的 `textDidChange` → 占位刷新同源）；命中穿透由
    // `hit_transparent_subclass_proc` 的 `HTTRANSPARENT` 保证（点占位文字聚焦输入框，
    // 与 macOS 的 `hitTest:` 同义；把手带状态文字复用同一子类）。
    let input_placeholder = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(INPUT_PLACEHOLDER).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            120,
            scaled(18, scale),
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SetWindowSubclass(input_placeholder, Some(hit_transparent_subclass_proc), 2, 0);
        // 抬到兄弟 z 序最上（见上：子窗口默认最底；否则输入框重绘会盖住占位）。
        SetWindowPos(
            input_placeholder,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }

    // 把手带的状态文字不建 STATIC：它是 composer 面上的一行字，子窗口的不透明
    // 表面会把渐变挡成一块灰板（2026-10-07 实机），改由 `paint_shell` 单面绘制，
    // 几何槽在 `layout_panes_for` 的 `paint.handle_status`（文案口径见
    // [`handle_status_label`]：只显示中性系统通知 `notice`）。

    // ── 停止按钮（运行中显示；运行态由 `deskpet-run-state` 回推）──
    let stop = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("停止").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(STOP_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            STOP_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        // 设计稿 `.btn`（第三波起停止是输入行的主按钮）：`--sbg` 族 + 按钮圆角 `--r3`。
        make_themed_button_r(stop, ButtonRole::Primary, scale, theme::tokens().radii.btn);
        ShowWindow(stop, SW_HIDE);
    }

    // ── A3：发图入口按钮（选择 → 待发送区；2026-10-05 第三波起回到输入行，
    //    设计稿 `.inp` 的「图片 + 主按钮」；抽屉退场后不再随展开态隐藏）──
    let pick_images = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("图片").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(PICK_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            BTN_PICK_IMAGES_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { make_themed_button(pick_images, ButtonRole::Normal, scale) };

    // ── 「发送」按钮（与 Enter 同一出口：WM_APP_SEND → send_from_input）──
    let send = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("发送").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(SEND_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            BTN_SEND_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { make_themed_button(send, ButtonRole::Primary, scale) };
    // 初始输入为空且无待发送图片：与旧壳 disabled 条件一致。
    unsafe { EnableWindow(send, 0) };

    // ── 「↓ 新消息」跳转按钮（浮在正文画布右下角；上翻历史时由滚动位置驱动）──
    let jump = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("↓ 新消息").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            JUMP_BUTTON_WIDTH,
            JUMP_BUTTON_HEIGHT,
            hwnd,
            BTN_JUMP_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        make_themed_button(jump, ButtonRole::Normal, scale);
        ShowWindow(jump, SW_HIDE);
    }

    // 把手上拉箭头同样**单面绘制**（见 `paint_shell` 的三角段）：它曾是
    // `ButtonRole::TabOff` 的子按钮，按钮自己的表面色会在带中央补出一块方板，
    // 且同一次点击会既进聊天窗的 `WM_LBUTTONDOWN` 又进按钮的 `WM_COMMAND`
    //（开完立刻被关掉 —— 用户 2026-10-07 实拍「点一下闪一下就消失」）。

    // ── 浮层 Inspector 的承载窗口（遮罩 + 浮层盒 = 同一个子窗口）──
    //
    // 生命周期：随聊天窗常驻、默认隐藏（开合只 ShowWindow/SetWindowPos，不反复建窗）。
    // 层级：在这里创建（画布与跳转按钮之后）= 兄弟窗口里更上层，消息画布与其 RichEdit
    // 全在它之下 —— 遮罩才盖得住内容、点得到（父窗口的绘制盖不住子窗口，这正是
    // 遮罩要独立成窗的原因）；弹出时再 `SetWindowPos(HWND_TOP)` 兜一层防重建打乱。
    // 内容子控件（标题 / ✕ / 面板元素）都是它的子窗口，随它显隐并被它裁剪。
    let inspector_layer = unsafe {
        CreateWindowExW(
            0,
            wide(LAYER_CLASS).as_ptr(),
            wide("").as_ptr(),
            // 不带 WS_VISIBLE：开合由 layout_panes_for 驱动。
            // `WS_CLIPSIBLINGS`：与画布重叠，重绘互不越界（见画布创建处的同款注释）。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            10,
            10,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 关闭「✕」（常驻，命中走 WM_COMMAND 的专段）。标题文案没有共享来源（三块内容
    // 合进一个浮层后不再有「打开的是哪一块」），**不自己造**：标题行只保留右侧 ✕。
    // 浮层窗口创建失败（极罕见）时不建这个子控件（父为 0 会变成顶层窗口，绝不允许），
    // 留痕后浮层功能整体禁用（句柄 0 在布局里被跳过）。
    let inspector_close = if inspector_layer != 0 {
        let close = unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("✕").as_ptr(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                10,
                10,
                inspector_layer,
                INSPECTOR_CLOSE_ID as HMENU,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe {
            // 关闭键是弱化的文字入口（设计稿 `.insx`：默认无底、悬浮才出底）。
            // 半径取 `radii.sm`（与 macOS 浮层关闭键同档，见交付报告的两平台对照）。
            make_themed_button_r(close, ButtonRole::TabOff, scale, theme::tokens().radii.sm);
        }
        close
    } else {
        rust_warn!("浮层窗口创建失败：关闭键与浮层内容不可用");
        0
    };

    // ── 浮层内容的滚动裁剪窗（2026-10-06 抽屉内部滚动）──
    // 挂在浮层窗口之下：`WS_VSCROLL` + `WS_CLIPCHILDREN` —— 面板元素是它的子窗口，
    // 部分滚出可视区的控件由客户区自然裁剪（不再整条藏起），滚动条只在内容超可视高
    // 时出现（见 `apply_inspector_scroll`）。独立子窗口而不是把元素直接挂浮层窗口的
    // 原因：浮层窗口盖住整块消息流区域（含盒外的遮罩），内容必须有**自己的**裁剪
    // 边界；滚动条也必须落在盒内而不是层窗右缘。
    let inspector_scroll = if inspector_layer != 0 {
        let scroll = unsafe {
            CreateWindowExW(
                0,
                wide(INSPECTOR_SCROLL_CLASS).as_ptr(),
                wide("").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_VSCROLL,
                0,
                0,
                10,
                10,
                inspector_layer,
                0,
                hinstance,
                std::ptr::null(),
            )
        };
        // 初始无滚动；内容超可视高时由 `apply_inspector_scroll` 打开。
        unsafe { ShowScrollBar(scroll, SB_VERT, 0) };
        scroll
    } else {
        0
    };

    // ── 会话历史弹层的承载窗口（同 `LAYER_CLASS`：遮罩 + 圆角盒 + 内容子控件）──
    //
    // 与浮层的关系：两层都盖住消息流区域、互斥性由模型状态决定（历史开合 = 视图在不在
    // 快照里）；两层同时开着时后弹的（历史创建在后）压在上面，点掉一层即露出另一层。
    // 内容子控件全部在重建时新建，随弹层显隐；本窗口常驻（只 Show/Hide）。
    let history_layer = unsafe {
        CreateWindowExW(
            0,
            wide(LAYER_CLASS).as_ptr(),
            wide("").as_ptr(),
            // 不带 WS_VISIBLE：开合由 layout_history_layer 驱动；同款 `WS_CLIPSIBLINGS`。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            10,
            10,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── A1：标签条的固定控件（仅主窗面板模式；独立窗全为 0）──
    // 顶部顶栏带（品牌/状态位/关闭「×」）不在这里：归主窗的全窗宽顶栏
    // （`windows_main.rs::create_titlebar`）。
    let mut nav_new: HWND = 0;
    let mut nav_history: HWND = 0;
    if pane {
        let make_nav = |text: &str, id: i32| unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                10,
                10,
                hwnd,
                id as HMENU,
                hinstance,
                std::ptr::null(),
            )
        };
        nav_new = make_nav("+", BTN_NEW_SESSION_ID);
        nav_history = make_nav("历史", BTN_HISTORY_ID);
        // `.tabadd` / `.tabhist` 用小圆角 `--r1`（与 macOS `Face::Chip` 对称）。
        make_themed_button_r(nav_new, ButtonRole::Normal, scale, theme::tokens().radii.sm);
        make_themed_button_r(
            nav_history,
            ButtonRole::Normal,
            scale,
            theme::tokens().radii.sm,
        );
    }

    // 系统字体（与 Windows 端既有口径一致：微软雅黑 UI / 等宽 Consolas）。
    // 灰度抗锯齿（`create_ui_font`）：与顶栏/全局字体同一路径，不用 ClearType
    //（浅底小字彩边，2026-10-07 实机）。
    let make_font = |height: i32, weight: i32, face: &str| {
        paint_win::create_ui_font(-scaled(height, scale), weight, face)
    };
    // 全局字体快照（`appearance.font` 的投影）：族名缺省回落 W8a 既有的中文 UI 字体，
    // 字号按「正文 13」基线同比缩放；等宽体保持 Consolas（代码块语义不随全局族名改）。
    let snapshot = crate::ui::font::snapshot();
    let ui_face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    let body_size = snapshot.scaled_size(13.0, 13.5).round() as i32;
    let small_size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    let mono_size = snapshot.scaled_size(12.0, 13.5).round() as i32;
    let body = make_font(body_size, FW_NORMAL as i32, &ui_face);
    let small = make_font(small_size, FW_NORMAL as i32, &ui_face);
    let bold = make_font(body_size, FW_BOLD as i32, &ui_face);
    let mono = make_font(mono_size, FW_NORMAL as i32, "Consolas");

    unsafe {
        SendMessageW(input, WM_SETFONT, body as WPARAM, 1);
        // 占位与输入文本同字体（macOS 占位与输入框同为 14pt）；字色 dim（次要文字）。
        SendMessageW(input_placeholder, WM_SETFONT, body as WPARAM, 1);
        stamp_ink(input_placeholder, theme::tokens().dim);
        SendMessageW(stop, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(pick_images, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(send, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(jump, WM_SETFONT, small as WPARAM, 1);
        // 关闭键是小号 chrome（标题行没有标题文字）。
        SendMessageW(inspector_close, WM_SETFONT, small as WPARAM, 1);
        if pane {
            // A1：标签条按钮用小号字体（导航条是次要 chrome）。
            for control in [nav_new, nav_history] {
                SendMessageW(control, WM_SETFONT, small as WPARAM, 1);
            }
        }
        // 输入区的 Enter 语义（发送/换行/IME 组合）经子类接管。
        SetWindowSubclass(input, Some(input_subclass_proc), 1, 0);
    }

    CHAT.with(|cell| {
        *cell.borrow_mut() = Some(ChatWinState {
            hwnd,
            pane,
            canvas,
            input,
            input_placeholder,
            stop,
            fonts: vec![body, small, bold, mono],
            content_height: 0,
            scroll_y: 0,
            viewport_height: 0,
            children: Vec::new(),
            base_height: 0,
            tail: None,
            links: HashMap::new(),
            message_menu_targets: HashMap::new(),
            image_targets: Vec::new(),
            active_session: None,
            view_generation: 0,
            composing: false,
            // 说话人名由投影（人格域）提供；未收到投影前不显示名，不留硬编码角色名兜底。
            speaker: String::new(),
            panel_children: Vec::new(),
            panel_height: 0,
            panel_actions: Vec::new(),
            handle_status_label: String::new(),
            inspector_layer,
            inspector_close,
            inspector_scroll,
            inspector_children: Vec::new(),
            inspector_content_height: 0,
            inspector_viewport_height: 0,
            inspector_scroll_y: 0,
            inspector_box: paint_win::Rect::new(0, 0, 0, 0),
            inspector_open: false,
            history_layer,
            history_children: Vec::new(),
            history_height: 0,
            history_box: paint_win::Rect::new(0, 0, 0, 0),
            pick_images,
            send,
            jump,
            jump_unread: false,
            seen_transcript_revision: 0,
            seen_stream_revision: 0,
            pending_children: Vec::new(),
            pending_height: 0,
            pending_targets: Vec::new(),
            pending_content_w: 0,
            pending_scroll_x: 0,
            pending_count: 0,
            pending_reveal_end: false,
            nav_new,
            nav_history,
            tab_children: Vec::new(),
            session_targets: Vec::new(),
            paint: ChatPaintRects::EMPTY,
            card_frames: Vec::new(),
        });
    });
    // 输入框主题（底色 + 字色；WM_SETFONT 之后应用，避免被默认格式覆盖）。
    with_chat(|state| unsafe { apply_input_theme(state) });
    // A3：文件拖入（拖进聊天窗 / 输入区 / 正文 → 待发送区）。三个窗口都注册
    // legacy 拖放（WM_DROPFILES），落点就近由各自窗口过程处理。
    unsafe {
        DragAcceptFiles(hwnd, 1);
        DragAcceptFiles(input, 1);
        DragAcceptFiles(canvas, 1);
    }

    layout_panes();
    unsafe {
        SetFocus(input);
    }
    rust_info!("聊天窗已创建（Win32/RichEdit；输入框已取焦点）");
}

/// 主窗与底部面板的位置（窗口尺寸变化时调用）。
fn layout_panes() {
    with_chat(|state| unsafe { layout_panes_for(state) });
}

/// 布局本体（apply_full 在已持有 state 的闭包里也调用）。
unsafe fn layout_panes_for(state: &mut ChatWinState) {
    unsafe {
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let scale = dpi_scale(state.hwnd);
        let (width, height) = (client.right - client.left, client.bottom - client.top);
        if width <= 0 || height <= 0 {
            return;
        }
        // 状态文字槽 = 单行文字高（在把手带内垂直居中）。
        let status_h = scaled(LABEL_HEIGHT, scale);
        let input_h = scaled(INPUT_HEIGHT, scale);
        // 把手带高来自共享常量（两平台同值）。
        let handle_h = scaled_f(crate::ui::chat::panels::HANDLE_HEIGHT, scale);
        let gap = scaled(PANE_GAP, scale);
        let pending_h = state.pending_height.max(0);
        let panel_h = state
            .panel_height
            .min((f64::from(height) * PANEL_MAX_FRACTION) as i32)
            .max(0);
        // 布局是**底部锚定**（与 macOS `relayout_panes` 同序）：
        // 输入行（贴底）→ 把手带 → 待发送条 → 功能面板 → 正文。
        // 2026-10-05 第二次改版：底部那排 chip 撤掉，输入框往下贴住窗口底，
        // 输入框上方一行是**把手带**（左侧圆点 + 中性通知文字；中置上拉小箭头，
        // **整条带可点**开合浮层）。
        // **浮层 Inspector 不在这条链里**（它挂在消息流区域之上，开合不改任何
        // 条区的 y —— 验收硬指标「开合前后 log 的 y 不变」）；条区算术收口在
        // 纯函数 [`bottom_stack`]（可单测，见文件尾测试）。
        // 注意：Win32 子窗口坐标 y 自客户区**顶部**向下，因此这些位置由
        // `height - ...` 反推。
        let stack = bottom_stack(height, input_h, handle_h, pending_h, panel_h, gap);
        let (input_y, handle_y, pending_y) = (stack.input_y, stack.handle_y, stack.pending_y);
        let (panel_bottom, panel_top, canvas_bottom) =
            (stack.panel_bottom, stack.panel_top, stack.canvas_bottom);
        // 把手带的箭头**字形框**（共享 `handle_arrow_frame`：10×10、水平+垂直居中）：
        // 绘制端按它画三角；命中不在这里 —— 整条带都是开合区（`WM_LBUTTONDOWN`）。
        let arrow_glyph = {
            let glyph = handle_arrow_frame(f64::from(width) / scale);
            RECT {
                left: scaled_f(glyph.x, scale),
                top: handle_y + scaled_f(glyph.y, scale),
                right: scaled_f(glyph.x + glyph.width, scale),
                bottom: handle_y + scaled_f(glyph.y + glyph.height, scale),
            }
        };
        // A3：待发送条（有选择时）在输入行之上、功能面板区之下；无选择时高度为 0。
        // 2026-10-06 横向可滚：子控件 x 记的是**内容坐标**，这里按滚动偏移平移；
        // 越界偏移钳回（撤选/变窄后不留空白滚动区），新增条目滚到最右露出刚加的图。
        let max_scroll = (state.pending_content_w - width).max(0);
        state.pending_scroll_x = state.pending_scroll_x.clamp(0, max_scroll);
        if state.pending_reveal_end {
            state.pending_reveal_end = false;
            if let Some(last) = state.pending_children.last() {
                state.pending_scroll_x = crate::ui::chat::pending_strip::clamp_scroll(
                    crate::ui::chat::pending_strip::reveal_offset(
                        f64::from(last.x),
                        f64::from(last.w),
                        f64::from(width),
                    ),
                    f64::from(state.pending_content_w),
                    f64::from(width),
                )
                .round() as i32;
            }
        }
        for child in &state.pending_children {
            MoveWindow(
                child.hwnd,
                child.x - state.pending_scroll_x,
                pending_y + child.y,
                child.w,
                child.h,
                1,
            );
        }
        for child in &state.panel_children {
            MoveWindow(
                child.hwnd,
                child.x,
                panel_top + child.y,
                child.w,
                child.h,
                1,
            );
        }
        // A1：顶部 26px 顶栏带 + 标签条占顶部（仅面板模式；条高来自共享模块）。
        let nav_h_px = scaled_f(crate::ui::titlebar::HEIGHT, scale) + scaled(TABS_HEIGHT, scale);
        let canvas_top = if state.pane { nav_h_px } else { 0 };
        MoveWindow(
            state.canvas,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(40),
            1,
        );
        // 输入行各列（`input_row_columns` 是唯一摆放口径：按钮固定宽、输入框弹性
        // 吃剩余并保底 `INPUT_FIELD_MIN_WIDTH`）。输入框本体（设计稿 `.inp .ph` 的
        // 单行槽）：高 40、在输入区内垂直居中；承载控件再按 2px 内缩 —— 外圈留给
        // 聊天窗画的 field_edge + field_bevel（承载控件不能透出父窗口的绘制）。
        let cols = input_row_columns(width, scale);
        let input_inset = scaled(CARD_RING_INSET, scale);
        let field_h = scaled(INPUT_FIELD_HEIGHT, scale);
        let field_y = input_y + (input_h - field_h) / 2;
        let field_left = scaled(SIDE_MARGIN, scale);
        let field_w = cols.field_width;
        MoveWindow(
            state.input,
            field_left + input_inset,
            field_y + input_inset,
            (field_w - input_inset * 2).max(scaled(20, scale)),
            (field_h - input_inset * 2).max(scaled(16, scale)),
            1,
        );
        // 占位标签对齐输入文本的首行（自绘等价物，位置未实机校准：按控件内缩 +
        // `WS_EX_CLIENTEDGE` 的非客户边 + 首行文字起点近似；macOS 用
        // `textContainerInset(8,8)` 对齐）。
        if state.input_placeholder != 0 {
            MoveWindow(
                state.input_placeholder,
                field_left + input_inset + scaled(6, scale),
                field_y + input_inset + scaled(3, scale),
                (field_w - input_inset * 2 - scaled(13, scale)).max(scaled(20, scale)),
                scaled(18, scale),
                1,
            );
        }
        // 状态文字：把手带**左半侧**、圆点之后（点 + 文字，垂直居中）；可用宽来自
        // 共享 `handle_status_width(width)`（箭头居中后它只给左半侧：
        // `(宽 − 30)/2 − 4`，窄窗可能压到 0），再扣掉左侧点与间距；
        // 单行省略由绘制端的 `DT_END_ELLIPSIS` 承担。**单面绘制**：文字槽只记几何，
        // 没有 STATIC 子控件（它的不透明表面会把 composer 渐变挡成灰板）。
        let status_text_x = scaled(
            HANDLE_STATUS_PAD_X + HANDLE_STATUS_DOT_RADIUS * 2 + HANDLE_STATUS_TEXT_GAP,
            scale,
        );
        let status_text_w = scaled_f(handle_status_width(f64::from(width) / scale), scale)
            - scaled(HANDLE_STATUS_DOT_RADIUS * 2 + HANDLE_STATUS_TEXT_GAP, scale);
        let handle_status = RECT {
            left: status_text_x,
            top: handle_y + (handle_h - status_h).max(0) / 2,
            right: status_text_x + status_text_w.max(scaled(24, scale)),
            bottom: handle_y + (handle_h - status_h).max(0) / 2 + status_h,
        };
        // 输入行内右侧：「图片」+ 主按钮槽（设计稿 `.inp` 的「图片 + 主按钮」）。
        // 主按钮槽里空闲显示「发送」、运行中显示「停止」（`update_status` 切换），
        // 两者都比槽窄、在槽内水平居中；运行中仍可经 Enter 发送（插话/投递语义）。
        // 列位置全部来自 `input_row_columns`（唯一摆放口径，不再就地重算）。
        let input_btn_h = scaled(INPUT_BUTTON_HEIGHT, scale);
        let input_btn_y = input_y + (input_h - input_btn_h) / 2;
        let slot_w = scaled(SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH), scale);
        let send_w = scaled(SEND_BUTTON_WIDTH, scale);
        let stop_w = scaled(STOP_BUTTON_WIDTH, scale);
        MoveWindow(
            state.send,
            cols.primary_x + (slot_w - send_w) / 2,
            input_btn_y,
            send_w,
            input_btn_h,
            1,
        );
        MoveWindow(
            state.stop,
            cols.primary_x + (slot_w - stop_w) / 2,
            input_btn_y,
            stop_w,
            input_btn_h,
            1,
        );
        MoveWindow(
            state.pick_images,
            cols.pick_x,
            input_btn_y,
            scaled(PICK_BUTTON_WIDTH, scale),
            input_btn_h,
            1,
        );
        // 「↓ 新消息」浮在正文画布右下角（后建按钮在层级上方；可见性随滚动驱动）。
        let jump_w = scaled(JUMP_BUTTON_WIDTH, scale);
        let jump_h = scaled(JUMP_BUTTON_HEIGHT, scale);
        let jump_x = (width - scaled(JUMP_BUTTON_MARGIN, scale) - jump_w).max(0);
        let jump_y = (canvas_bottom - scaled(JUMP_BUTTON_MARGIN, scale) - jump_h).max(canvas_top);
        MoveWindow(state.jump, jump_x, jump_y, jump_w, jump_h, 1);
        // 浮层与会话历史弹层是**独立的各一步**：都只吃上面算好的画布矩形
        // （单向依赖：悬浮层跟随消息流，消息流不看悬浮层）。验收硬指标
        // 「开合前后 log 的 y 不变」由此在结构上成立 —— 本函数不得读取任何
        // 悬浮层状态字段（源码级守门测试按端口黑名单钉住）。
        unsafe { layout_inspector_layer(state, width, canvas_top, canvas_bottom, scale) };
        unsafe { layout_history_layer(state, width, canvas_top, canvas_bottom, scale) };
        if state.pane {
            layout_tabs(state, width, scale);
        }
        // 主题绘制区域（物理像素、客户区坐标；WM_PAINT 逐条读取，空矩形 = 不画）。
        let mut paint = ChatPaintRects::EMPTY;
        if state.pane {
            // 顶部 26px 带：本窗只在该矩形上画顶栏**外投影**（条底由全窗宽顶栏子窗口
            // 自己画）；标签条接在它下方。
            paint.bar = RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: scaled_f(crate::ui::titlebar::HEIGHT, scale),
            };
            paint.tabs = RECT {
                left: 0,
                top: paint.bar.bottom,
                right: width,
                bottom: nav_h_px,
            };
        }
        if panel_h > 0 {
            paint.panels = RECT {
                left: 0,
                top: panel_top,
                right: width,
                bottom: panel_bottom,
            };
        }
        if pending_h > 0 {
            paint.pending = RECT {
                left: 0,
                top: pending_y,
                right: width,
                bottom: pending_y + pending_h,
            };
        }
        // 把手带（输入行上方一行；**无底色、无分隔线**，只有状态点/文字与 ▴ ——
        // 与 macOS 模块头同口径；带区仍有独立命中区，开合浮层）。
        paint.handle = RECT {
            left: 0,
            top: handle_y,
            right: width,
            bottom: handle_y + handle_h,
        };
        paint.handle_status = handle_status;
        paint.handle_arrow = arrow_glyph;
        // 输入区底条（主题 `--ibg`）：**composer 的整块面**，上沿与 macOS
        // `composer_top_from_bands` 同源：**覆盖待发送条（若有）+ 把手带 + 输入行**
        // 一整块（`macos_chat.rs::relayout_panes` 的注释「composer 从消息流下沿一直
        // 铺到窗口底，一整块面」）。旧实现无条时从把手带**下沿**开始铺，带区落在
        // 面上之外 —— 实机就是「输入框上方多出一条灰带」（用户 2026-10-07 实拍）。
        let composer_top = if pending_h > 0 { pending_y } else { handle_y };
        paint.input_bar = RECT {
            left: 0,
            top: composer_top,
            right: width,
            bottom: height,
        };
        // 输入行按钮的「所在面」实色（`draw_button` 的圆角补角用）：按 composer
        // 渐变在**按钮行中心**取样 —— 用整块面的首档色会在按钮四角漏出一圈浅晕
        //（2026-10-07 实机：禁用「发送」四周一圈比 composer 浅的环）。
        let composer_h = (height - composer_top).max(1);
        let row_t = f64::from((input_y + input_h / 2 - composer_top).clamp(0, composer_h))
            / f64::from(composer_h);
        let row_surface = paint_win::fill_sample(&theme::tokens().input_bar_bg, row_t);
        for control in [state.stop, state.pick_images, state.send] {
            paint_win::set_surface_color(control, row_surface);
        }
        // 输入框槽位 = 上面 MoveWindow 的同一几何（单行槽、右侧让给三个按钮）。
        paint.input_field = RECT {
            left: field_left,
            top: field_y,
            right: field_left + field_w,
            bottom: field_y + field_h,
        };
        let strips_changed = !rect_eq(&state.paint.bar, &paint.bar)
            || !rect_eq(&state.paint.tabs, &paint.tabs)
            || !rect_eq(&state.paint.panels, &paint.panels)
            || !rect_eq(&state.paint.pending, &paint.pending)
            || !rect_eq(&state.paint.handle, &paint.handle)
            || !rect_eq(&state.paint.handle_status, &paint.handle_status)
            || !rect_eq(&state.paint.handle_arrow, &paint.handle_arrow)
            || !rect_eq(&state.paint.input_bar, &paint.input_bar)
            || !rect_eq(&state.paint.input_field, &paint.input_field);
        state.paint = paint;
        if strips_changed {
            // 条区几何变了才重绘窗口底（避免每次整帧都重画条纹/颗粒）。
            InvalidateRect(state.hwnd, std::ptr::null(), 0);
            // 承载控件的圆角区域不随重绘更新（输入框尺寸随窗口宽变），几何变了重贴一次。
            apply_input_round_regions(state, scale);
        }
        let mut canvas_client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut canvas_client);
        state.viewport_height = canvas_client.bottom - canvas_client.top;
    }
}

/// 浮层窗口与盒内控件的摆放（**单向依赖**：输入是上面算好的画布矩形 ——
/// 浮层跟随消息流，消息流不看浮层）。
///
/// - 层窗口盖住消息流区域（= 画布矩形）；隐藏时只收起来、几何照常同步；
/// - 弹出的那一刻抬到同级最上兜一层（面板子控件每次整帧重建会造新的兄弟窗口，
///   遮罩必须始终压在消息画布子树之上，见 `build_children` 的层级注释）；
/// - 浮层盒底边锚在层底边上方 `INSPECTOR_PAD`（设计稿 `.insp{bottom:9px}`），
///   左右各留同宽，高度按内容（[`overlay_box_rect`] 封顶）；
/// - 盒几何变化才重画层（内容子控件自己重绘；换入口但高度相同时只有标题文字变）。
unsafe fn layout_inspector_layer(
    state: &mut ChatWinState,
    width: i32,
    canvas_top: i32,
    canvas_bottom: i32,
    scale: f64,
) {
    unsafe {
        if state.inspector_layer == 0 {
            return;
        }
        MoveWindow(
            state.inspector_layer,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(1),
            1,
        );
        let open = state.inspector_open;
        ShowWindow(state.inspector_layer, if open { SW_SHOW } else { SW_HIDE });
        if !open {
            state.inspector_box = paint_win::Rect::new(0, 0, 0, 0);
            return;
        }
        SetWindowPos(
            state.inspector_layer,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let layer_h = canvas_bottom - canvas_top;
        // 盒高按**可视区**高收口（内容全高只决定滚动范围，不再决定盒高；内容超可视
        // 高的部分由裁剪窗内部滚动到达）。
        let wanted_h = state.inspector_viewport_height
            + scaled(INSPECTOR_HEADER_HEIGHT, scale)
            + scaled(INSPECTOR_BODY_PAD_BOTTOM, scale);
        let pad = scaled(INSPECTOR_PAD, scale);
        let panel_box = overlay_box_rect(width, layer_h, wanted_h, pad, pad);
        // 盒内摆放：标题行（右侧 ✕）与内容滚动裁剪窗（子控件在裁剪窗里按滚动偏移摆）。
        let head_h = scaled(INSPECTOR_HEADER_HEIGHT, scale);
        let close_size = scaled(INSPECTOR_CLOSE_SIZE, scale);
        let close_inset = scaled(6, scale);
        MoveWindow(
            state.inspector_close,
            panel_box.x + panel_box.w - close_inset - close_size,
            panel_box.y + (head_h - close_size).max(0) / 2,
            close_size,
            close_size,
            1,
        );
        // 裁剪窗：盒内标题行之下、左右内缩让开盒描边与内立体线；可视高 = 盒内可用高
        // （盒被几何夹小——面板/待发送条挤占画布高度——时以盒为准，滚动范围随之收紧）。
        if state.inspector_scroll != 0 {
            let inset = scaled(INSPECTOR_SCROLL_INSET, scale);
            let view_h = inspector_body_view_height(panel_box, scale);
            MoveWindow(
                state.inspector_scroll,
                panel_box.x + inset,
                panel_box.y + head_h,
                (panel_box.w - inset * 2).max(1),
                view_h,
                1,
            );
            // 钳制偏移 + 子控件随偏移平移 + 滚动条信息（唯一落地）。
            apply_inspector_scroll(state, view_h);
        }
        if state.inspector_box != panel_box {
            state.inspector_box = panel_box;
            InvalidateRect(state.inspector_layer, std::ptr::null(), 0);
        }
    }
}

/// 浮层内容的滚动落地（**唯一实现点**：滚动指令与重排都走它）：钳制偏移、
/// 按偏移平移内容子控件（部分可见的由裁剪窗客户区自然裁剪，完全在外的藏起免得
/// 白画）、刷新滚动条信息（范围/页大小/位置；内容不超高时收起滚动条）。
///
/// 与画布滚动（`apply_scroll`）同族：子控件坐标记的是**内容坐标**，这里按偏移平移；
/// 裁剪窗自己的 `WM_PAINT` 只重铺盒底，被移空的区域随之复原。
unsafe fn apply_inspector_scroll(state: &mut ChatWinState, view_h: i32) {
    unsafe {
        let max_scroll = (state.inspector_content_height - view_h).max(0);
        let scroll_y = state.inspector_scroll_y.clamp(0, max_scroll);
        state.inspector_scroll_y = scroll_y;
        for child in &state.inspector_children {
            // 与可视区相交即显示（部分可见交给裁剪窗的客户区裁剪；完全在外的
            // 藏起，不让它们白占重绘）。
            let visible = child.y + child.h > scroll_y && child.y < scroll_y + view_h;
            ShowWindow(child.hwnd, if visible { SW_SHOW } else { SW_HIDE });
            if visible {
                MoveWindow(child.hwnd, child.x, child.y - scroll_y, child.w, child.h, 1);
            }
        }
        let mut info: SCROLLINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMin = 0;
        info.nMax = state.inspector_content_height.max(1);
        info.nPage = view_h.max(1) as u32;
        info.nPos = scroll_y;
        SetScrollInfo(state.inspector_scroll, SB_VERT, &info, 1);
        ShowScrollBar(state.inspector_scroll, SB_VERT, i32::from(max_scroll > 0));
        // 子控件移走后的空档归裁剪窗自己重铺（盒底实色、`WS_CLIPCHILDREN` 把子控件
        // 排除在重绘区外，整块失效最省心且每帧重排重复作废的代价可忽略）。
        InvalidateRect(state.inspector_scroll, std::ptr::null(), 0);
    }
}

/// 浮层滚动条 / 滚轮的行滚动指令入口（`WM_VSCROLL` 到 [`inspector_scroll_command`]）。
/// 重排收口在 `layout_panes_for`（唯一摆放口径）—— 与待发送条的滚轮路径同款。
fn inspector_scroll_command(command: i32) {
    with_chat(|state| unsafe {
        let scale = dpi_scale(state.hwnd);
        let line = scaled(INSPECTOR_SCROLL_LINE, scale);
        let view_h = inspector_body_view_height(state.inspector_box, scale);
        let page = (view_h - line).max(line);
        match command {
            SB_LINEUP => state.inspector_scroll_y -= line,
            SB_LINEDOWN => state.inspector_scroll_y += line,
            SB_PAGEUP => state.inspector_scroll_y -= page,
            SB_PAGEDOWN => state.inspector_scroll_y += page,
            SB_TOP => state.inspector_scroll_y = 0,
            SB_BOTTOM => state.inspector_scroll_y = state.inspector_content_height,
            SB_THUMBTRACK | SB_THUMBPOSITION => {
                let mut info: SCROLLINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
                info.fMask = SIF_ALL;
                GetScrollInfo(state.inspector_scroll, SB_VERT, &mut info);
                state.inspector_scroll_y = info.nTrackPos.max(0);
            }
            _ => {}
        }
        // 唯一摆放口径：钳制 + 子控件平移 + 滚动条信息都在 `layout_panes_for` →
        // `layout_inspector_layer` → `apply_inspector_scroll` 里完成。
        layout_panes_for(state);
    });
}

/// 滚轮 → 浮层内容纵向滚动；返回是否消费本次滚轮。
///
/// 只有「浮层开着、内容超可视高」且「光标命中的窗口是滚动裁剪窗（或其子控件）」
/// 才消费（不抢画布/待发送条/正文的滚轮；浮层盒盖在消息流之上，光标在盒内时正文
/// 本来也不该动）。判定用 `GetCursorPos` + `WindowFromPoint`（含父链上溯）—— 与
/// 待发送条同一条「鼠标在哪就滚哪」口径；用 z 序命中而不是几何包含，是为了让
/// 压在裁剪窗之上的浮层（历史弹层）与下拉弹窗不被穿透。
fn scroll_inspector_from_wheel(msg: u32, wparam: WPARAM) -> bool {
    // 横向轮在浮层没有既有语义：不消费（落回既有路径）。
    if msg != WM_MOUSEWHEEL {
        return false;
    }
    unsafe {
        let target = CHAT.with(|cell| {
            cell.borrow().as_ref().and_then(|state| {
                let scale = dpi_scale(state.hwnd);
                let view_h = inspector_body_view_height(state.inspector_box, scale);
                (state.inspector_open
                    && state.inspector_scroll != 0
                    && state.inspector_content_height > view_h)
                    .then_some(state.inspector_scroll)
            })
        });
        let Some(scroll) = target else { return false };
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point) == 0 {
            return false;
        }
        // 光标命中按**窗口 z 序**判（不是几何包含）：浮层与历史弹层可能重叠、
        // 下拉弹窗/控件也可能盖在裁剪窗上 —— 那些情况下滚轮不该穿过去滚抽屉。
        // 从命中窗口沿父链上溯，裁剪窗在链上才消费。
        let mut hit = WindowFromPoint(point);
        let mut over_scroll = false;
        while hit != 0 {
            if hit == scroll {
                over_scroll = true;
                break;
            }
            hit = GetParent(hit);
        }
        if !over_scroll {
            return false;
        }
        // 滚轮增量在**高字**（低字是按键标志）；一格 = 120，走行指令（与画布同款
        // 三行一步的粒度）。
        let delta = i32::from(((wparam >> 16) & 0xFFFF) as u16 as i16);
        let lines = (delta / 120).clamp(-5, 5) * 3;
        if lines == 0 {
            return false;
        }
        let command = if lines > 0 { SB_LINEUP } else { SB_LINEDOWN };
        for _ in 0..lines.abs() {
            SendMessageW(scroll, WM_VSCROLL, command as WPARAM, 0);
        }
        true
    }
}

/// 浮层滚动裁剪窗的窗口过程：盒底重铺 + 滚动指令 + 子控件的通知转发回聊天窗。
///
/// 与画布 `canvas_wndproc` 同族（滚动容器）：子控件（面板按钮/下拉/行标签）的
/// `WM_COMMAND`/`WM_DRAWITEM`/`WM_NOTIFY` 先到本窗，转发给父（浮层窗口，再转聊天窗，
/// 分派段在 `chat_wndproc` 统一收口）；`WM_CTLCOLORSTATIC` 就地按既有口径上色。
unsafe extern "system" fn inspector_scroll_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底由 WM_PAINT 铺（盒底实色）；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                paint_win::fill_rect(
                    hdc,
                    paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client)),
                    &theme::tokens().panel_bg,
                );
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_VSCROLL => {
            inspector_scroll_command((wparam & 0xFFFF) as i32);
            0
        }
        WM_MOUSEWHEEL => {
            // 焦点在子控件时的滚轮消息会转到本窗：按行滚动（与画布同粒度）。
            // 增量在 **wParam 高字**（低字是按键标志；lParam 是屏幕坐标）—— 与
            // `windows_editor::on_mouse_wheel` / `scroll_pending_from_wheel` 同口径。
            let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
            let lines = (i32::from(delta) / 120).clamp(-5, 5);
            for _ in 0..lines.abs() {
                inspector_scroll_command(if lines > 0 { SB_LINEUP } else { SB_LINEDOWN });
            }
            0
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        // 同 `overlay_layer_wndproc`：编辑类控件的 CTLCOLOR 消费者是控件父窗
        // （浮层面板元素挂在本滚动裁剪窗上），就地接住并转给同一实现点。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            super::windows_settings::edit_ctlcolor(wparam, lparam)
        }
        WM_COMMAND => {
            unsafe { SendMessageW(GetParent(hwnd), WM_COMMAND, wparam, lparam) };
            0
        }
        WM_DRAWITEM => {
            unsafe { SendMessageW(GetParent(hwnd), WM_DRAWITEM, wparam, lparam) };
            0
        }
        WM_NOTIFY => {
            unsafe { SendMessageW(GetParent(hwnd), WM_NOTIFY, wparam, lparam) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 「历史」按钮的右缘（聊天窗客户区坐标）。
///
/// 直接问控件自己的窗口矩形（`GetWindowRect` + `ScreenToClient`），**不重算**
/// `layout_nav` 的 `width − history_w − 4` —— 那会造出第二份几何定义点；
/// 控件不在（独立窗 / 未挂载）时回落到窗口右缘内缩 4。
fn history_button_right(state: &ChatWinState, width: i32, scale: f64) -> i32 {
    unsafe {
        if state.nav_history != 0 {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(state.nav_history, &mut rect) != 0 {
                let mut point = POINT {
                    x: rect.right,
                    y: rect.bottom,
                };
                if ScreenToClient(state.hwnd, &mut point) != 0 {
                    return point.x;
                }
            }
        }
    }
    width - scaled(4, scale)
}

/// 会话历史弹层的摆放（**单向依赖**：只吃画布矩形与「历史」按钮右缘 —— 弹层跟随
/// 布局，布局不看弹层）。
///
/// - 层窗口盖住消息流区域（与浮层同款：遮罩只罩消息流，不罩输入区/标签条，
///   所以「点外部关闭」的点落在消息流上；也正因此**不能**盖标签条 —— 否则
///   「历史」按钮点不到、无法再点收起）；
/// - 盒顶边贴标签条下沿（层顶 + `HISTORY_POPOVER_GAP_Y`）、右缘对齐按钮右缘、
///   宽高按内容并整体夹进层内（[`history_popover_rect`]）；
/// - 弹出的那一刻抬到同级最上（重建会造新兄弟窗口，遮罩必须压在画布子树之上）；
/// - 盒几何变化才重画层；伸到盒外的内容整条藏起（同浮层口径）。
unsafe fn layout_history_layer(
    state: &mut ChatWinState,
    width: i32,
    canvas_top: i32,
    canvas_bottom: i32,
    scale: f64,
) {
    unsafe {
        if state.history_layer == 0 {
            return;
        }
        MoveWindow(
            state.history_layer,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(1),
            1,
        );
        let open = state.history_height > 0;
        ShowWindow(state.history_layer, if open { SW_SHOW } else { SW_HIDE });
        if !open {
            state.history_box = paint_win::Rect::new(0, 0, 0, 0);
            return;
        }
        SetWindowPos(
            state.history_layer,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let anchor_right = history_button_right(state, width, scale);
        let wanted_w =
            scaled(HISTORY_POPOVER_WIDTH, scale).max(scaled(HISTORY_POPOVER_MIN_WIDTH, scale));
        let wanted_h = state
            .history_height
            .max(scaled(HISTORY_POPOVER_MIN_HEIGHT, scale));
        let panel_box = history_popover_rect(
            width,
            canvas_bottom - canvas_top,
            anchor_right,
            wanted_w,
            wanted_h,
            scaled(HISTORY_POPOVER_GAP_Y, scale),
        );
        for child in &state.history_children {
            let inside = child.y + child.h <= panel_box.h;
            ShowWindow(child.hwnd, if inside { SW_SHOW } else { SW_HIDE });
            MoveWindow(
                child.hwnd,
                panel_box.x + child.x,
                panel_box.y + child.y,
                child.w,
                child.h,
                1,
            );
        }
        if state.history_box != panel_box {
            state.history_box = panel_box;
            InvalidateRect(state.history_layer, std::ptr::null(), 0);
        }
    }
}

/// A1：会话标签条的控件摆放（仅面板模式；标签按钮的 x/w 由 `rebuild_tabs` 给出，
/// y 在这里统一落到条内垂直居中位置）。
///
/// 顶栏（品牌/状态位/关闭「×」）不在这里：它归主窗的全窗宽顶栏子窗口
/// （`windows_main.rs::layout_titlebar_children`），本窗只在带下方摆标签条。
unsafe fn layout_tabs(state: &mut ChatWinState, width: i32, scale: f64) {
    unsafe {
        let titlebar_h = scaled_f(crate::ui::titlebar::HEIGHT, scale);
        let tabs_h = scaled(TABS_HEIGHT, scale);
        let nav_h = scaled(NAV_CONTROL_HEIGHT, scale);
        // 标签条：动态标签在左（x 已在 rebuild 时算好），「+」「历史」靠右。
        let tab_y = titlebar_h + (tabs_h - nav_h) / 2;
        let history_w = scaled(NAV_HISTORY_WIDTH, scale);
        let new_w = scaled(NAV_NEW_WIDTH, scale);
        let history_x = (width - history_w - scaled(4, scale)).max(0);
        let new_x = (history_x - new_w - scaled(4, scale)).max(0);
        MoveWindow(state.nav_history, history_x, tab_y, history_w, nav_h, 1);
        MoveWindow(state.nav_new, new_x, tab_y, new_w, nav_h, 1);
        for child in &state.tab_children {
            MoveWindow(child.hwnd, child.x, tab_y, child.w, child.h, 1);
        }
    }
}

// ==========================================
// 窗口过程
// ==========================================

unsafe extern "system" fn chat_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底全部由 WM_PAINT 的 paint_shell 画（类刷为空刷）；吞掉擦除以避免闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| paint_shell(state, hdc));
            }
            0
        }
        WM_APP_REPAINT => {
            repaint_deferred(hwnd);
            0
        }
        WM_NCDESTROY => {
            discard_deferred_paint(hwnd);
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        // 同 `overlay_layer_wndproc`：编辑类控件的 CTLCOLOR 消费者是控件父窗
        // （流内面板元素挂在本窗上），就地接住并转给同一实现点。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            super::windows_settings::edit_ctlcolor(wparam, lparam)
        }
        WM_DRAWITEM => {
            if lparam != 0 {
                let item = unsafe { &*(lparam as *const DrawItemStruct) };
                if item.CtlType == ODT_BUTTON {
                    unsafe { draw_themed_button(item) };
                    return 1;
                }
                if item.CtlType == ODT_STATIC {
                    // 面板卡片底板（`PanelElement::Card` 建的自绘 STATIC）。
                    unsafe { draw_themed_card(item) };
                    return 1;
                }
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CREATE => {
            unsafe { build_children(hwnd) };
            0
        }
        WM_SIZE => {
            // 宽度变化会改变正文换行高度与面板按钮排布。共用可见面门禁；隐藏期间
            // 只更新模型，面板重新显示时由共享边沿投递最新 Full。
            let standalone =
                CHAT.with(|cell| cell.borrow().as_ref().is_some_and(|state| !state.pane));
            if standalone && crate::ui::chat::chat_ui().is_window_open() {
                // `WPARAM` 是 `usize`、`SIZE_MINIMIZED` 是 `u32`：显式转型，不靠推断
                //（漏了它本机编不出来 —— Windows 分支在 macOS 上被 cfg 掉）。
                let visible = wparam != SIZE_MINIMIZED as usize && unsafe { IsWindowVisible(hwnd) != 0 };
                let was_visible = crate::ui::chat::is_surface_visible("chat");
                if !visible {
                    with_chat(|state| unsafe { release_canvas(state) });
                }
                crate::ui::chat::set_chat_window_visible(visible);
                if was_visible && visible {
                    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
                }
            } else {
                chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
            }
            0
        }
        WM_LBUTTONDOWN => {
            // 把手带**整条可点**（2026-10-05 第三波）：点带内任意位置开合浮层。
            // 状态文字与箭头都是同一块面上的绘制（没有子控件），所以这是**唯一**
            // 的开合入口 —— 一次点击只翻转一次。带外一律交回默认处理。
            let x = i32::from((lparam & 0xFFFF) as u16 as i16);
            let y = i32::from(((lparam >> 16) & 0xFFFF) as u16 as i16);
            let in_handle = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| rect_contains(win_rect_of(&state.paint.handle), x, y))
                    .unwrap_or(false)
            });
            if in_handle {
                unsafe { toggle_inspector_ui() };
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_GETMINMAXINFO => {
            let info = unsafe { &mut *(lparam as *mut MinMaxInfo) };
            let scale = dpi_scale(hwnd);
            info.ptMinTrackSize = POINT {
                x: scaled(CHAT_WINDOW_MIN_WIDTH, scale),
                y: scaled(CHAT_WINDOW_MIN_HEIGHT, scale),
            };
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let notification = ((wparam >> 16) & 0xFFFF) as u16;
            // 输入内容变化（含程序化填入/清空）：驱动 slash 候选与「发送」按钮可用态。
            if id == INPUT_ID && notification == EN_CHANGE {
                // EN_CHANGE 已携带发通知的 RichEdit 句柄，不回借 CHAT：设置字体/
                // 文字可能同步进入这里，而外层仍在持有聊天布局状态。
                refresh_input_state(lparam as HWND);
                return 0;
            }
            match id {
                STOP_ID => match crate::ui::chat::dispatch_stop() {
                    Ok(()) => crate::ui::chat::set_notice(None),
                    Err(error) => crate::ui::chat::set_notice(Some(format!("停止失败：{error}"))),
                },
                // ── 浮层（2026-10-05 第二次改版；两段都在开口段之前匹配）──
                // 浮层关闭「✕」（浮层窗口把 WM_COMMAND 转到这里）。
                INSPECTOR_CLOSE_ID => unsafe { close_inspector_ui() },
                // 「发送」按钮：与 Enter 同一出口（WM_APP_SEND → send_from_input）。
                BTN_SEND_ID => unsafe {
                    PostMessageW(hwnd, WM_APP_SEND, 0, 0);
                },
                // 「↓ 新消息」：回正文底部（可见性由 apply_scroll 统一驱动）。
                BTN_JUMP_ID => canvas_scroll(SB_BOTTOM),
                // ── A1：标签条按钮（两段范围先于 PANEL_BASE 匹配；顶栏「×」不在这里，
                // 它归全窗宽顶栏子窗口自己的 WM_COMMAND）──
                BTN_NEW_SESSION_ID => match crate::ui::chat::dispatch_new_session() {
                    Ok(()) => crate::ui::chat::set_notice(None),
                    Err(error) => {
                        crate::ui::chat::set_notice(Some(format!("新建会话失败：{error}")));
                    }
                },
                BTN_HISTORY_ID => unsafe {
                    dispatch_panel_action(crate::ui::chat::PanelAction::ToggleSessionHistory)
                },
                // A3：发图入口（原生多选器；工作线程，结果经统一图片域准入后进待发送区）。
                BTN_PICK_IMAGES_ID => {
                    if let Err(error) = crate::ui::chat::pick_images() {
                        crate::ui::chat::set_notice(Some(format!("打开图片选择器失败：{error}")));
                    }
                }
                SESSION_TAB_BASE..SESSION_CLOSE_BASE => {
                    let index = (id - SESSION_TAB_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.session_targets.get(index).cloned())
                    });
                    match target {
                        Some(session_id) => {
                            match crate::ui::chat::dispatch_switch_session(&session_id) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => {
                                    crate::ui::chat::set_notice(Some(format!(
                                        "切换会话失败：{error}"
                                    )));
                                }
                            }
                        }
                        None => rust_warn!("会话标签 id={id} 没有对应会话（渲染已换代）"),
                    }
                }
                // 面板下拉（COMBOBOX）：只认 SELENDOK（用户选定）—— SELCHANGE 在
                // 键盘游走时也发，动作会重复触发。id = PANEL_SELECT_BASE + 基址，
                // 选中下标叠加基址取动作。本段必须先于下方开口段（`PENDING_BASE..`
                // 等）匹配。
                PANEL_SELECT_BASE.. => {
                    if notification != CBN_SELENDOK as u16 {
                        return 0;
                    }
                    let base = (id - PANEL_SELECT_BASE) as usize;
                    let control = lparam as HWND;
                    let selected =
                        unsafe { SendMessageW(control, CB_GETCURSEL, 0, 0) }.max(0) as usize;
                    let action = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.panel_actions.get(base + selected).cloned())
                    });
                    match action {
                        // 下拉选中（投递 / 思考强度 / 安全策略）经统一助手派发并立即重建 ——
                        // 投递是本地动作且模型未 bump 版本号，不立即重建就会「选完不刷新」。
                        Some(action) => unsafe { dispatch_panel_action(action) },
                        None => rust_warn!(
                            "面板下拉 id={id} 选中 {selected} 没有对应动作（渲染已换代）"
                        ),
                    }
                }
                // A3：待发送条目点击 = 撤选（表在 rebuild_pending 时整体替换）。
                // 本段必须先于下方开口的 `SESSION_CLOSE_BASE..`（4600..）匹配。
                PENDING_BASE.. => {
                    let index = (id - PENDING_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.pending_targets.get(index).cloned())
                    });
                    match target {
                        Some(path) => crate::ui::chat::remove_pending_image(&path),
                        None => rust_warn!("待发送条目 id={id} 没有对应路径（渲染已换代）"),
                    }
                }
                SESSION_CLOSE_BASE.. => {
                    let index = (id - SESSION_CLOSE_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.session_targets.get(index).cloned())
                    });
                    match target {
                        Some(session_id) => {
                            match crate::ui::chat::dispatch_close_session(&session_id) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => {
                                    crate::ui::chat::set_notice(Some(format!(
                                        "关闭会话失败：{error}"
                                    )));
                                }
                            }
                        }
                        None => rust_warn!("会话标签关闭 id={id} 没有对应会话（渲染已换代）"),
                    }
                }
                // 面板按钮（W8b）：ID 指向本次渲染的动作表。
                PANEL_BASE.. => {
                    let index = (id - PANEL_BASE) as usize;
                    let action = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.panel_actions.get(index).cloned())
                    });
                    match action {
                        Some(action) => unsafe { dispatch_panel_action(action) },
                        None => rust_warn!("面板按钮 id={id} 没有对应动作（渲染已换代）"),
                    }
                }
                PLACEHOLDER_BASE.. => {
                    let index = (id - PLACEHOLDER_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.image_targets.get(index))
                            .map(|target| (target.entry_id.clone(), target.image_index))
                    });
                    match target {
                        Some((entry_id, image_index)) => {
                            match crate::ui::chat::open_viewer(&entry_id, image_index) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => crate::ui::chat::set_notice(Some(format!(
                                    "图片无法打开：{error}"
                                ))),
                            }
                        }
                        None => rust_warn!("图片占位按钮 id={id} 没有对应目标（渲染已换代）"),
                    }
                }
                _ => {}
            }
            0
        }
        WM_TIMER => {
            if wparam == TIMER_DEADLINE {
                // 到点收纳（tick 会经刷新调度回到 apply_full → 重新布点）。
                // 在 with_chat 之外调用，避免重入借用被跳过。
                crate::ui::chat::tick_deadlines();
                with_chat(|state| arm_deadline_timer(state));
            }
            0
        }
        WM_NOTIFY => {
            // RichEdit 的超链接通知（EN_LINK）：只处理用户点击（WM_LBUTTONUP）。
            let header = unsafe { &*(lparam as *const Nmhdr) };
            if header.code == EN_LINK {
                let link = unsafe { &*(lparam as *const ENLINK) };
                if link.msg == 0x0202 {
                    unsafe { handle_link_click(link) };
                }
            }
            0
        }
        WM_APP_SEND => {
            send_from_input();
            0
        }
        WM_DROPFILES => {
            // A3：文件拖入聊天窗（正文底/空白）→ 待发送区。
            unsafe { handle_dropped_files(wparam as HDROP) };
            0
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            // 浮层开着、光标在抽屉内容上且内容超高时先滚抽屉（消费本次滚轮；
            // 与待发送条同一条「鼠标在哪就滚哪」口径，不抢别的区域的滚轮）。
            if unsafe { scroll_inspector_from_wheel(msg, wparam) } {
                return 0;
            }
            // 2026-10-06 多张截图可达性：滚轮落在待发送条上时横向滚条（光标在哪就滚
            // 哪；子按钮持焦点时滚轮消息也会转到本窗）。不在条内/没超宽则不消费，
            // 落回既有语义。
            if unsafe { scroll_pending_from_wheel(hwnd, msg, wparam) } {
                return 0;
            }
            if msg == WM_MOUSEHWHEEL {
                // 横向轮在别的区域没有既有语义：交回默认处理。
                return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
            }
            // 焦点在输入区时的滚轮也滚正文：转发为行滚动给画布。
            let canvas = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.canvas));
            if let Some(canvas) = canvas {
                // 滚轮增量在 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
                // y 坐标 —— 2026-10-06 前误读 lParam，步长随窗口在屏幕上的位置漂移）。
                let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
                let lines = (i32::from(delta) / 120).clamp(-5, 5) * 3;
                let command = if lines > 0 { SB_LINEUP } else { SB_LINEDOWN };
                for _ in 0..lines.abs() {
                    unsafe {
                        SendMessageW(canvas, WM_VSCROLL, command as WPARAM, 0);
                    }
                }
            }
            0
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            // 聊天窗是附属窗：销毁不得退出应用（不 PostQuitMessage）。
            let mut close_inspector = false;
            with_chat(|state| unsafe {
                // `inspector_open` 是 bool（三块同浮层后不再有「打开的是哪一块」的信息）。
                close_inspector = state.inspector_open;
                KillTimer(state.hwnd, TIMER_DEADLINE);
                DRAW_IMAGES.with(|images| {
                    let mut images = images.borrow_mut();
                    for target in &state.image_targets {
                        images.remove(&target.hwnd);
                    }
                });
                for child in &state.panel_children {
                    DestroyWindow(child.hwnd);
                }
                for child in &state.inspector_children {
                    DestroyWindow(child.hwnd);
                }
                for child in &state.history_children {
                    DestroyWindow(child.hwnd);
                }
                // 悬浮层窗口（浮层标题/✕ 是浮层窗口的子窗口，随它一起销毁）。
                if state.inspector_layer != 0 {
                    DestroyWindow(state.inspector_layer);
                }
                if state.history_layer != 0 {
                    DestroyWindow(state.history_layer);
                }
                for child in &state.pending_children {
                    DestroyWindow(child.hwnd);
                }
                // 缩略图注册表随控件一起清（窗口重建后 HWND 可能被复用，旧句柄
                // 留下的帧会挂到新按钮上）。
                PENDING_THUMBS.with(|images| images.borrow_mut().clear());
                for child in &state.children {
                    DestroyWindow(child.hwnd);
                }
                for font in &state.fonts {
                    DeleteObject(*font);
                }
            });
            let was_pane = CHAT.with(|cell| {
                let pane = cell
                    .borrow()
                    .as_ref()
                    .map(|state| state.pane)
                    .unwrap_or(false);
                *cell.borrow_mut() = None;
                pane
            });
            if was_pane {
                // 主窗面板随主窗销毁（宿主退出）：聊天面关闭，但查看器资源由
                // 退出序列统一释放（`on_host_exit`）。
                crate::ui::chat::chat_ui().set_main_pane_open(false);
            } else {
                crate::ui::chat::note_chat_window_closed();
            }
            // 关窗 = 浮层收起：把共享层的开合状态同步归零。平台镜像随窗口状态表
            // 一起销毁（上一行的 `*cell.borrow_mut() = None`），不归零会让模型留下
            // 一个「开着」的陈旧值 —— 重开窗时平台从 None 起步、两边错拍。
            // 这里已经释放了 CHAT 借用；动作只改模型 + 排一次（会被窗口门禁丢掉的）
            // 刷新，失败如实留痕。
            if close_inspector {
                if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseInspector)
                {
                    rust_warn!("聊天窗销毁时同步收起浮层失败: {error}");
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn send_from_input() {
    let input = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.input));
    let Some(input) = input else { return };
    let text = unsafe { read_window_text(input) };
    // 待发送区（选择/拖入的图片）随本次发送一并提交；空文本 + 有图也允许发送。
    let images = crate::ui::chat::pending_image_paths();
    if text.trim().is_empty() && images.is_empty() {
        return;
    }
    match crate::ui::chat::dispatch_send_text(&text, images) {
        Ok(()) => {
            unsafe { SetWindowTextW(input, wide("").as_ptr()) };
            crate::ui::chat::set_notice(None);
        }
        Err(error) => {
            // 发送失败：输入与待发送图片已保留。错误详情可能是较长的传输/远端诊断，
            // 走模态对话框（详情可复制）而不是一行几秒即收起的 notice。
            crate::ui::chat::dialog::show_failure(
                "消息未发送",
                "消息没有送达；输入内容与待发送图片已保留。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
    // 程序化清空后显式刷新（SetWindowTextW 通常也会发 EN_CHANGE，这里不依赖它）。
    with_chat(|state| update_send_enabled(state));
}

/// 同步「发送」按钮可用态：输入非空或以有待发送图片（与 Enter 的准入同源）。
fn update_send_enabled(state: &ChatWinState) {
    let text = unsafe { read_window_text(state.input) };
    // 占位标签的可见性与发送可用态同源（都由输入文本决定）、同触发点（EN_CHANGE
    // 与各程序化清空/填入点一起刷新）——与 macOS `update_send_enabled` 同构。
    if state.input_placeholder != 0 {
        // 占位是**叠在输入框上**的兄弟控件，只要输入框里有东西（文字 / IMM 组合串）
        // 就会盖住它。判定口径与 macOS 同源（`macos_chat::update_send_enabled`：
        // `placeholder.setHidden(!empty)`，`empty` **只**看输入文本）—— 输入框空着
        // 就显示占位，聚焦与否不影响（用户 2026-10-07 实拍：mac 里点进输入框后
        // 「说点什么…」仍在，Windows 一聚焦就消失）。TSF 拼音的组合串由输入法自己
        // 画在插入点，不写进控件文本，占位留在下面与 macOS 的表现一致。
        let empty = text.is_empty();
        unsafe {
            ShowWindow(
                state.input_placeholder,
                if empty { SW_SHOW } else { SW_HIDE },
            );
            // 占位是**叠在输入框上**的兄弟控件：藏掉它以后输入框不会自动重画，
            // 露出来的仍是占位那几笔像素 —— 用户实拍「被『说点什么…』挡住了」，
            // 文字其实已经在下面，只是被占位的残影盖着。显式作废输入框区域，
            // 让 RichEdit 把这一块重画一遍。
            if state.input != 0 {
                InvalidateRect(state.input, std::ptr::null(), 1);
            }
        }
    }
    let enabled = !text.trim().is_empty() || crate::ui::chat::chat_ui().has_pending_images();
    unsafe { EnableWindow(state.send, i32::from(enabled)) };
    // 自绘按钮的禁用态不保证被 EnableWindow 主动重绘：显式失效一次（禁用样式立即生效）。
    unsafe { InvalidateRect(state.send, std::ptr::null(), 1) };
}

/// 「视作在正文底部」的容差（物理像素；沿用 `rebuild_canvas` 既有的 24，口径一处）。
const JUMP_BOTTOM_TOLERANCE: i32 = 24;

/// 视口是否在正文底部（纯函数；`scroll_y + viewport_h` 贴到内容底差容差内）。
fn scroll_at_bottom(scroll_y: i32, viewport_h: i32, content_h: i32) -> bool {
    scroll_y + viewport_h >= content_h - JUMP_BOTTOM_TOLERANCE
}

/// 「↓ 新消息」可见性（2026-10-05 用户规则）：**真有未读新消息且不在底部**才显示——
/// 只有「不在底部」不再是理由（旧口径让它在只是上翻历史时也常驻、压在消息文字上）。
fn update_jump_visibility(state: &ChatWinState) {
    let max_scroll = (state.content_height - state.viewport_height).max(0);
    let at_bottom = scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
    let show = state.jump_unread && !at_bottom && max_scroll > 0;
    unsafe { ShowWindow(state.jump, if show { SW_SHOW } else { SW_HIDE }) };
}

/// 读取控件文本（主窗顶栏的自绘按钮也复用，故 `pub(crate)`）。
pub(crate) unsafe fn read_window_text(hwnd: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer: Vec<u16> = vec![0; (length + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), length + 1) };
    let slice = &buffer[..read.max(0) as usize];
    String::from_utf16_lossy(slice)
}

/// 输入内容变化的统一刷新出口：占位标签可见性、「发送」可用态与 slash 候选
/// 同源刷新（`EN_CHANGE` 分支与「RichEdit 原生粘贴不补发 EN_CHANGE」的两处
/// 显式补刷新共用，避免判定复制第二份）。
fn refresh_input_state(input: HWND) {
    if input == 0 {
        return;
    }
    let text = unsafe { read_window_text(input) };
    crate::ui::chat::note_input_text(&text);
    with_chat(|state| update_send_enabled(state));
}

/// 「只做视觉、不拦鼠标」子类的统一实现（两处装同一条：**输入区占位标签**与
/// **把手带状态文字**）：命中测试一律穿透（`HTTRANSPARENT` 让消息落到同线程的
/// 下层窗口 —— 占位标签落输入框、状态文字落聊天窗的把手带点击段），其余消息
/// 原样交还 —— 与 macOS `ChatInputPlaceholder` 的 `hitTest:` 返回 nil 同义
/// （不穿透时：点占位文字无法聚焦输入框、点状态文字不会开合浮层）。
unsafe extern "system" fn hit_transparent_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(hit_transparent_subclass_proc), 2);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 输入区子类：Enter 发送 / Shift+Enter 换行 / IME 组合期间交还系统。
unsafe extern "system" fn input_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_KEYDOWN => {
            // Ctrl+V：**RichEdit 自己处理 Ctrl+V，不会发 WM_PASTE**。
            // 2026-10-07 实机用诊断日志确认：粘贴图片时本文件的 `WM_PASTE` 分支
            // 一次都没被执行，图片被 RichEdit 当成内嵌对象插进了正文（用户实拍
            // 「截图粘贴进去还是这鬼样子、没进上面的可滚动图片区」）。所以在按键
            // 这一层就拦：剪贴板是图片/文件 → 转交待发送区并吃掉按键；纯文本原样
            // 落回 RichEdit 的原生粘贴。`WM_PASTE` 分支保留（右键菜单粘贴走它）。
            if wparam == VK_V as WPARAM && unsafe { GetKeyState(i32::from(VK_CONTROL)) } < 0 {
                if unsafe { paste_clipboard_payload(hwnd) } {
                    return 0;
                }
                // 文本粘贴：交还 RichEdit 自己插字，**它不补发 EN_CHANGE**
                // （2026-10-07 实机：粘贴文字后 `[诊断·输入]` 一条都没有，占位标签
                // 一直压在文字上；打字却有 EN_CHANGE）。先让它把粘贴做完，再显式
                // 补一次刷新 —— 与 EN_CHANGE 共用同一出口，不复制判定。
                let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
                refresh_input_state(hwnd);
                return result;
            }
            let composing = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| state.composing)
                    .unwrap_or(false)
            });
            if !composing {
                // ── slash 候选键盘导航（与 ChatPanel 的 key() 同义）──
                let slash_open = crate::ui::chat::slash_visible();
                if slash_open {
                    match wparam {
                        w if w == VK_DOWN as WPARAM => {
                            crate::ui::chat::slash_move(1);
                            return 0;
                        }
                        w if w == VK_UP as WPARAM => {
                            crate::ui::chat::slash_move(-1);
                            return 0;
                        }
                        w if w == VK_ESCAPE as WPARAM => {
                            crate::ui::chat::slash_dismiss();
                            return 0;
                        }
                        w if w == VK_TAB as WPARAM => {
                            unsafe { autofill_selected_slash(hwnd) };
                            return 0;
                        }
                        _ => {}
                    }
                }
                if wparam == VK_RETURN as WPARAM {
                    let shift_down = unsafe { GetKeyState(i32::from(VK_SHIFT)) } < 0;
                    if !shift_down {
                        if slash_open {
                            // 候选打开时 Enter 先补全（再按一次才发送）。
                            unsafe { autofill_selected_slash(hwnd) };
                        } else {
                            // 交给聊天窗处理“发送”（不在子类里直接碰其他控件，保持单一出口）。
                            unsafe {
                                PostMessageW(GetParent(hwnd), WM_APP_SEND, 0, 0);
                            }
                        }
                        return 0;
                    }
                }
            }
        }
        WM_IME_STARTCOMPOSITION => {
            CHAT.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    state.composing = true;
                }
            });
            // 组合期要立刻收起占位：候选/拼音串画在输入框里，而占位是**叠在输入框上**
            // 的兄弟控件 —— 不收就正好盖住正在输入的字（用户实拍「被『说点什么…』挡住」）。
            with_chat(|state| update_send_enabled(state));
        }
        WM_IME_ENDCOMPOSITION => {
            CHAT.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    state.composing = false;
                }
            });
            // 组合结束：上屏了就有文本（占位继续收着），被取消则文本为空（占位回来）。
            with_chat(|state| update_send_enabled(state));
        }
        WM_IME_COMPOSITION => {
            if (lparam as usize & (GCS_CURSORPOS as usize)) != 0 {
                unsafe { position_candidate_window(hwnd) };
            }
        }
        WM_PAINT => {
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            // TSF 系输入法（本机的微软拼音）**不发 `WM_IME_*`** —— 上面两个分支收不到，
            // 组合期占位就一直压在拼音串上（用户实拍「被『说点什么…』挡住」）。组合串
            // 只能查 IMM 上下文，这里借输入框自己的重绘时机对一次状态；**只在翻转时**
            // 刷新：`update_send_enabled` 里会 InvalidateRect 输入框，无条件刷新会与
            // WM_PAINT 互相触发成死循环。
            let composing = unsafe { ime_composing(hwnd) };
            let flipped = CHAT.with(|cell| {
                let mut cell = cell.borrow_mut();
                match cell.as_mut() {
                    Some(state) if state.composing != composing => {
                        state.composing = composing;
                        true
                    }
                    _ => false,
                }
            });
            if flipped {
                with_chat(|state| update_send_enabled(state));
            }
            return result;
        }
        WM_DROPFILES => {
            // A3：拖进输入区的文件 → 待发送区（接管 RichEdit 自带的拖放处理）。
            unsafe { handle_dropped_files(wparam as HDROP) };
            return 0;
        }
        WM_PASTE => {
            // A3 第三条（2026-10-05 图片通路批）：剪贴板里有图片或复制的文件就接管
            // （Ctrl+V 经 RichEdit 生成 WM_PASTE），其余交还 RichEdit 原生粘贴 ——
            // 文本粘贴行为不变。复用本子类，不挂第二个（守门测试断言）。
            if unsafe { paste_clipboard_payload(hwnd) } {
                return 0;
            }
            // 文本粘贴（右键菜单「粘贴」走这条）：同 Ctrl+V 分支 —— RichEdit
            // 不补发 EN_CHANGE，粘贴完成后显式刷新占位与「发送」可用态。
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            refresh_input_state(hwnd);
            return result;
        }
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(input_subclass_proc), 1);
        },
        // 焦点边沿要重算占位（见 `update_send_enabled`：聚焦即收起，避免盖住 IME 组合串）。
        WM_SETFOCUS | WM_KILLFOCUS => {
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            with_chat(|state| update_send_enabled(state));
            return result;
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 输入法是否正在组合（`GCS_COMPSTR` 非空 = 有未上屏的拼音/候选串）。
///
/// 为什么不用消息：TSF 系输入法（本机微软拼音）**不发 `WM_IME_STARTCOMPOSITION`**，
/// 那两条分支收不到；IMM 上下文里的组合串是唯一可靠的读数。
unsafe fn ime_composing(input: HWND) -> bool {
    let himc = unsafe { ImmGetContext(input) };
    if himc == 0 {
        return false;
    }
    let len = unsafe { ImmGetCompositionStringW(himc, GCS_COMPSTR, std::ptr::null_mut(), 0) };
    unsafe { ImmReleaseContext(input, himc) };
    len > 0
}

/// 组合输入时把 IME 候选框钉到插入符（真实候选窗跟随需人工确认）。
unsafe fn position_candidate_window(input: HWND) {
    unsafe {
        let himc = ImmGetContext(input);
        if himc == 0 {
            return;
        }
        let mut point = POINT { x: 0, y: 0 };
        GetCaretPos(&mut point);
        ClientToScreen(input, &mut point);
        let mut form: CANDIDATEFORM = std::mem::zeroed();
        form.dwIndex = 0;
        form.dwStyle = CFS_CANDIDATEPOS;
        form.ptCurrentPos = point;
        ImmSetCandidateWindow(himc, &form);
        ImmReleaseContext(input, himc);
    }
}

// ==========================================
// 消息右键菜单（「记住这条」入口；气泡按钮退场后的第二形态）
// ==========================================

/// 消息 RichEdit 的右键子类（散文泡与代码块同挂；无身份的控制不挂 —— 右键仍是
/// RichEdit 自带菜单）。`WM_CONTEXTMENU` 的处理顺序是硬要求：**先在闭包里把事件
/// 身份克隆出来、结束 `CHAT` 借用，再弹菜单** —— `TrackPopupMenu` 内部有嵌套消息
/// 泵，跨它持借用会让随后的整帧重建（`with_chat` 是 `try_borrow_mut`）悄悄不发生。
unsafe extern "system" fn message_menu_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_CONTEXTMENU => {
            let event_id = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .and_then(|state| state.message_menu_targets.get(&hwnd).cloned())
            });
            if let Some(event_id) = event_id {
                unsafe { show_message_menu(hwnd, lparam, &event_id) };
                return 0;
            }
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(message_menu_subclass_proc), 3);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 弹一次消息右键菜单并执行选中项（只在有记忆身份时调用；无身份的控制走
/// RichEdit 自带菜单，见 [`message_menu_subclass_proc`]）。
///
/// - 菜单 = 复制 / 全选 / 分隔线 / [`REMEMBER_MENU_ITEM_LABEL`]（「记住这条」的
///   文案唯一来源是共享常量，平台文件不写字面量）；
/// - `lparam == -1` 是键盘（Shift+F10 / 菜单键）唤出、没有鼠标点，用控件矩形
///   左上角兜底定位；其余取低 16 位 x / 高 16 位 y（有符号，按 WinUser.h 的
///   `GET_X_LPARAM` 口径）；
/// - 派发复用 [`dispatch_panel_action`]（内置「派发后立即整帧重建」；该出口在
///   production 里必须恰好一处 —— 守门测试断言）。
unsafe fn show_message_menu(hwnd: HWND, lparam: LPARAM, event_id: &str) {
    unsafe {
        let menu = CreatePopupMenu();
        if menu == 0 {
            return;
        }
        // `AppendMenuW` 复制字符串（临时 `wide` 即可；与托盘菜单的写法一致）。
        AppendMenuW(menu, MF_STRING, MENU_COPY, wide(MENU_LABEL_COPY).as_ptr());
        AppendMenuW(
            menu,
            MF_STRING,
            MENU_SELECT_ALL,
            wide(MENU_LABEL_SELECT_ALL).as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(
            menu,
            MF_STRING,
            MENU_REMEMBER,
            wide(REMEMBER_MENU_ITEM_LABEL).as_ptr(),
        );
        let (x, y) = if lparam == -1 {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) != 0 {
                (rect.left, rect.top)
            } else {
                (0, 0)
            }
        } else {
            let raw = lparam as i32;
            (
                (raw & 0xFFFF) as u16 as i16 as i32,
                ((raw >> 16) & 0xFFFF) as u16 as i16 as i32,
            )
        };
        // 先置前台再弹菜单（点击别处菜单才会收起；与托盘菜单同款）。菜单挂在控件
        // 所在窗口链的顶层窗口上（面板模式 / 独立聊天窗都取根祖先）。
        SetForegroundWindow(GetAncestor(hwnd, GA_ROOT));
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            x,
            y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
        // 嵌套消息泵期间可能发生整帧重建（本控件被销毁）：菜单收起后先核对控件
        // 还在，免得把复制/全选发给死句柄（event_id 已克隆，不依赖控件）。
        if IsWindow(hwnd) == 0 {
            return;
        }
        match command as usize {
            MENU_COPY => {
                SendMessageW(hwnd, WM_COPY, 0, 0);
            }
            MENU_SELECT_ALL => {
                // 标准 EDIT/RichEdit 全选：wParam = 0、lParam = -1（全选到末尾）。
                SendMessageW(hwnd, EM_SETSEL, 0, -1);
            }
            MENU_REMEMBER => {
                dispatch_panel_action(PanelAction::RememberMessage {
                    event_id: event_id.to_string(),
                });
            }
            _ => {} // 0 = 取消（点空白 / ESC）；其余 ID 不存在。
        }
    }
}

// ==========================================
// 画布：滚动与子控件堆叠
// ==========================================

unsafe extern "system" fn canvas_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 画布底由 WM_PAINT（paint_canvas_shell）统一画；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| paint_canvas_shell(state, hdc));
            }
            0
        }
        WM_APP_REPAINT => {
            repaint_deferred(hwnd);
            0
        }
        WM_NCDESTROY => {
            discard_deferred_paint(hwnd);
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        WM_DRAWITEM => {
            if lparam != 0 {
                let item = unsafe { &*(lparam as *const DrawItemStruct) };
                if item.CtlType == ODT_BUTTON {
                    // 图片占位（有帧数据）走既有专用绘制；其余所有按钮走主题面。
                    if draw_inline_button(item) {
                        return 1;
                    }
                    unsafe { draw_themed_button(item) };
                    return 1;
                }
            }
            0
        }
        WM_VSCROLL => {
            canvas_scroll((wparam & 0xFFFF) as i32);
            0
        }
        WM_MOUSEWHEEL => {
            // 滚轮增量在 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
            // y 坐标 —— 2026-10-06 前误读 lParam，步长随窗口在屏幕上的位置漂移）。
            let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
            let lines = (i32::from(delta) / 120).clamp(-5, 5);
            for _ in 0..lines.abs() {
                canvas_scroll(if lines > 0 { SB_LINEUP } else { SB_LINEDOWN });
            }
            0
        }
        WM_SIZE => {
            with_chat(|state| unsafe {
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(state.canvas, &mut client);
                state.viewport_height = client.bottom - client.top;
                apply_scroll(state);
            });
            0
        }
        WM_DROPFILES => {
            // A3：拖进正文画布的文件 → 待发送区。
            unsafe { handle_dropped_files(wparam as HDROP) };
            0
        }
        WM_NOTIFY => {
            // RichEdit 子控件的通知先到画布，这里转发给聊天窗统一处理。
            unsafe {
                SendMessageW(GetParent(hwnd), WM_NOTIFY, wparam, lparam);
            }
            0
        }
        WM_COMMAND => {
            // 画布子控件（图片占位按钮）的通知先到画布，
            // 转发给聊天窗统一处理（与 WM_NOTIFY 同一路由；chat_wndproc 有目标表）。
            unsafe {
                SendMessageW(GetParent(hwnd), WM_COMMAND, wparam, lparam);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn canvas_scroll(command: i32) {
    with_chat(|state| unsafe {
        let scale = dpi_scale(state.hwnd);
        let line = scaled(LINE_HEIGHT as i32, scale);
        let page = (state.viewport_height - line).max(line);
        match command {
            SB_LINEUP => state.scroll_y -= line,
            SB_LINEDOWN => state.scroll_y += line,
            SB_PAGEUP => state.scroll_y -= page,
            SB_PAGEDOWN => state.scroll_y += page,
            SB_TOP => state.scroll_y = 0,
            SB_BOTTOM => state.scroll_y = state.content_height,
            SB_THUMBTRACK | SB_THUMBPOSITION => {
                let mut info: SCROLLINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
                info.fMask = SIF_ALL;
                GetScrollInfo(state.canvas, SB_VERT, &mut info);
                state.scroll_y = info.nTrackPos.max(0);
            }
            _ => {}
        }
        apply_scroll(state);
    });
}

/// 按 scroll_y 重排子控件并更新滚动条（子控件随 scroll_y 上移）。
unsafe fn apply_scroll(state: &mut ChatWinState) {
    unsafe {
        let max_scroll = (state.content_height - state.viewport_height).max(0);
        let scroll_y = state.scroll_y.clamp(0, max_scroll);
        state.scroll_y = scroll_y;
        // 到达底部即清未读（「↓ 新消息」随之收起；未读的唯一清除点）。
        if scroll_at_bottom(scroll_y, state.viewport_height, state.content_height) {
            state.jump_unread = false;
        }
        for child in &state.children {
            MoveWindow(child.hwnd, child.x, child.y - scroll_y, child.w, child.h, 1);
        }
        let mut info: SCROLLINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMin = 0;
        info.nMax = state.content_height.max(1);
        info.nPage = state.viewport_height.max(1) as u32;
        info.nPos = scroll_y;
        SetScrollInfo(state.canvas, SB_VERT, &info, 1);
        ShowScrollBar(state.canvas, SB_VERT, i32::from(max_scroll > 0));
    }
    // 子控件随 scroll_y 移动、卡片框也要跟着重画：画布整体失效（bErase=0，
    // WM_PAINT 全量重画，不需要系统擦除）。
    unsafe { InvalidateRect(state.canvas, std::ptr::null(), 0) };
    update_jump_visibility(state);
    sync_inline_visible(state);
}

fn sync_inline_visible(state: &mut ChatWinState) {
    let top = state.scroll_y;
    let bottom = top + state.viewport_height;
    let mut visible = Vec::new();
    for target in &mut state.image_targets {
        if target.content_y < bottom && target.content_y + target.height > top {
            visible.push(crate::ui::chat::InlineVisibleImage {
                owner: target.owner.clone(),
                path: target.path.clone(),
            });
        } else if target.frame.take().is_some() {
            DRAW_IMAGES.with(|images| {
                if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                    draw.frame = None;
                }
            });
            unsafe { InvalidateRect(target.hwnd, std::ptr::null(), 1) };
        }
    }
    crate::ui::chat::sync_inline_visible(if state.pane { "main-chat" } else { "chat" }, visible);
}

fn draw_inline_button(item: &DrawItemStruct) -> bool {
    let target = DRAW_IMAGES.with(|images| images.borrow().get(&item.hwndItem).cloned());
    let Some(target) = target else { return false };
    unsafe {
        // 图片占位 chip：底/描边走按钮 chip 族（`--bbg/--bedge/--bsh`；2026-10-05
        // 从输入框族改回按钮族，与 macOS `Face::Chip` 对齐 —— 输入框族在消息流里
        // 像一条通栏横幅「和主题不符」，评审实机证据）；图片与标题叠在上面。
        let tokens = theme::tokens();
        let face = paint_win::button_face(
            tokens,
            ButtonRole::Normal,
            paint_win::button_hovered(item.hwndItem),
            item.itemState & ODS_SELECTED != 0,
        );
        let rect = paint_win::Rect::new(
            item.rcItem.left,
            item.rcItem.top,
            item.rcItem.right - item.rcItem.left,
            item.rcItem.bottom - item.rcItem.top,
        );
        // 图片占位 chip 挂画布：底走画布真实像素重放（与消息流背景对齐）。
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            "",
            false,
            false,
            backdrop,
        );
        SetBkMode(item.hDC, TRANSPARENT);
        SetTextColor(item.hDC, paint_win::colorref(tokens.ink));
        let mut text_rect = item.rcItem;
        if let Some(frame) = target.frame {
            if frame.width > 0 && frame.height > 0 {
                // chip 尺寸 = 缩放图宽 + 16、图高 + 32（见 `build_message_controls`）：
                // 预览图在 chip 内居中，标题在图下方（与 macOS 的 ImageAbove 同位）。
                let available_width = (item.rcItem.right - item.rcItem.left - 16).max(1);
                let available_height = (item.rcItem.bottom - item.rcItem.top - 32).max(1);
                let image_height = available_height
                    .min(available_width * frame.height as i32 / frame.width as i32)
                    .max(1);
                let image_width = (image_height * frame.width as i32 / frame.height as i32).max(1);
                let image_top = item.rcItem.top + 8;
                let image_left = item.rcItem.left
                    + ((item.rcItem.right - item.rcItem.left - image_width) / 2).max(0);
                let mut info = RgbaBitmapInfo {
                    header: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: frame.width as i32,
                        biHeight: -(frame.height as i32),
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_BITFIELDS_RGBA,
                        biSizeImage: frame.rgba.len() as u32,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    },
                    // Little-endian DIB masks read RGBA bytes as R=low, G=next, B=third.
                    masks: [0x0000_00FF, 0x0000_FF00, 0x00FF_0000],
                };
                StretchDIBits(
                    item.hDC,
                    image_left,
                    image_top,
                    image_width,
                    image_height,
                    0,
                    0,
                    frame.width as i32,
                    frame.height as i32,
                    frame.rgba.as_ptr().cast(),
                    (&mut info as *mut RgbaBitmapInfo).cast::<BITMAPINFO>(),
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
                text_rect.top = image_top + image_height + 2;
            }
        }
        let text = wide(&target.title);
        // chip 是贴合内容宽度的单行件（宽 = 估宽 + 22）：单行 + 尾部省略与 macOS
        // 的按钮标题截断同义（旧版满宽大按钮才需要 WORDBREAK）。
        DrawTextW(
            item.hDC,
            text.as_ptr(),
            -1,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
    }
    true
}

// ==========================================
// 消息列表重建（RTF）
// ==========================================

/// 全量重建画布内容（投影整帧；流式更新只换尾巴）。
unsafe fn rebuild_canvas(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        // 观测计数（dev A/B）：一次整帧重建（与 macOS `rebuild` 对称）。
        crate::ui::chat::stream_metrics::note_full_rebuild();
        let previous_content = state.content_height;
        let was_at_bottom =
            scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
        release_canvas(state);

        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut client);
        let canvas_width = (client.right - client.left).max(scaled(200, scale));
        // 说话人名只来自投影（人格域 `activeCardName`）；没有就不显示名 ——
        // 不留硬编码角色名兜底（空串标签渲染为空文本）。
        let speaker = snapshot.speaker.clone().unwrap_or_default();
        state.speaker = speaker.clone();

        let mut y = scaled(6, scale);
        for message in &snapshot.messages {
            y = build_message_controls(state, message, &speaker, canvas_width, y, scale);
        }
        state.base_height = y;
        if let Some(text) = snapshot.streaming.as_deref() {
            y = build_tail_controls(state, text, canvas_width, y, scale);
        }
        state.content_height = y + scaled(8, scale);
        // 未读判据（2026-10-05 用户规则）：**正文/流式版本号前进**（真的有新内容，
        // 窗口缩放导致的重排不算）、用户不在底部、且内容确实变长 = 有新内容落到
        // 视口外；在底部时下面会把滚动贴回底部，不记未读。
        let fresh_content = snapshot.transcript_revision != state.seen_transcript_revision
            || snapshot.stream_revision != state.seen_stream_revision;
        if !was_at_bottom && fresh_content && state.content_height > previous_content {
            state.jump_unread = true;
        }
        state.seen_transcript_revision = snapshot.transcript_revision;
        state.seen_stream_revision = snapshot.stream_revision;
        update_status(state, &snapshot.status);
        if was_at_bottom {
            state.scroll_y = (state.content_height - state.viewport_height).max(0);
        }
        apply_scroll(state);
        // 卡片框（气泡外框）在画布上，重建后要整块重画。
        InvalidateRect(state.canvas, std::ptr::null(), 0);
    }
}

/// 隐藏/重建时释放聊天正文控件与平台像素登记；模型快照仍是正文的唯一来源。
unsafe fn release_canvas(state: &mut ChatWinState) {
    unsafe {
        for child in &state.children {
            DestroyWindow(child.hwnd);
        }
        state.children.clear();
        state.links.clear();
        state.message_menu_targets.clear();
        DRAW_IMAGES.with(|images| {
            let mut images = images.borrow_mut();
            for target in &state.image_targets {
                images.remove(&target.hwnd);
            }
        });
        state.image_targets.clear();
        state.card_frames.clear();
        state.tail = None;
        state.content_height = 0;
        state.base_height = 0;
        state.scroll_y = 0;
    }
}

/// 一条消息：角色标签 + 每个可见泡（散文段/代码块）+ 图片占位按钮。
unsafe fn build_message_controls(
    state: &mut ChatWinState,
    message: &MessageSnapshot,
    speaker: &str,
    canvas_width: i32,
    mut y: i32,
    scale: f64,
) -> i32 {
    unsafe {
        // 展示层只放真正的聊天记录（2026-10-05 用户规则：「别把工具和思考放到展示
        // 层，展示只放真正的聊天记录」）：工具结果条目整条不渲染（工具调用卡与
        // 思考块同样已退场——见下方删除记录），只有正文泡/图片算可渲染内容。
        if message.role == Role::Tool {
            return y;
        }
        // 可见性判定与平台无关：正文泡/图片任一存在即渲染；纯工具调用/纯思考的
        // 条目（无正文无图）整条跳过（`has_renderable_content` 已收窄口径）。
        if !message.has_renderable_content() {
            return y;
        }
        // 工具失败结果：中性系统行（标签加「失败」后缀 + 弱提示底色），不伪装角色台词。
        let failed_tool = message.is_failed_tool_result();
        // 「记住这条」右键菜单的事件身份：只有用户消息有（共享判据，平台层不判角色）；
        // 同一条消息的多个控件（各段气泡、代码块）共用同一个身份。
        let remember = message.remember_event_id();
        // 说话人标签：用户条目不摆「你」（右对齐气泡自明身份）、助手无角色名时不摆
        // 空标签 —— 与 macOS 共用 `role_label_text`（两平台同一口径）。
        if let Some(label_text) = role_label_text(message.role, speaker, failed_tool) {
            let label = create_child(
                state,
                "STATIC",
                &label_text,
                0,
                WS_CHILD | WS_VISIBLE,
                scaled_f(BUBBLE_SIDE_MARGIN, scale),
                y,
                canvas_width - scaled_f(BUBBLE_SIDE_MARGIN * 2.0, scale),
                scaled(LABEL_HEIGHT, scale),
            );
            send_font(state, label, 1); // 小号字
                                        // 说话人标签：次要文字；失败工具行用 warn（与正文前景同族）。
            stamp_ink(
                label,
                if failed_tool {
                    theme::tokens().warn
                } else {
                    theme::tokens().dim
                },
            );
            y += scaled(LABEL_HEIGHT, scale) + 3;
        }

        // 气泡列：留白/上限/下限/内边距与宽度算法是两平台共用的 `panels` 口径
        // （2026-10-05 起用户泡右对齐、助手泡左对齐，最宽 86%）；本模块只做
        // 平台侧的量测（估宽）与构建。代码块与气泡同列。
        // 「记住这条」入口的当前形态（2026-10-05 二改）：泡内按钮已删除，入口改由
        // **消息右键菜单**承接（`message_menu_subclass_proc`，只对用户消息挂项；
        // 自动路径仍在 Node 记忆域，与展示层无关）。
        let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
        let cap = scaled_f(bubble_cap(f64::from(canvas_width) / scale), scale);
        let column_x = margin;

        for part in message.visible_parts.iter() {
            if part.trim().is_empty() {
                continue;
            }
            // 段级拆分（2026-10-05 用户规则，与 macOS `build_message_view` 同口径）：
            // 一个 part 里的空行分段拆成多条气泡 —— 历史里已提交的单泡多段记录
            // （拟人化开启前的）也一条条显示，不再「一坨」。含代码块（```）的正文
            // 不拆（split_paragraphs 内部裁定），技术内容保持整条。
            let paragraphs = crate::ui::chat::panels::split_paragraphs(part);
            for paragraph in &paragraphs {
                let blocks = parse_blocks(paragraph);
                let has_code = blocks
                    .iter()
                    .any(|block| matches!(block, Block::CodeBlock { .. }));
                // 连续散文块合并进一个 RichEdit（= 一条气泡）；代码块各自一个
                // （独立横向滚动）。
                let mut segment: Vec<Block> = Vec::new();
                for block in blocks {
                    match block {
                        Block::CodeBlock { lang, lines } => {
                            flush_prose(
                                state,
                                &mut segment,
                                message.role,
                                failed_tool,
                                canvas_width,
                                &mut y,
                                column_x,
                                cap,
                                has_code,
                                remember,
                                scale,
                            );
                            // 代码块与气泡同列（含代码时泡宽 = 上限，代码块撑满该列）；
                            // 用户条目的列随泡右对齐。
                            let code_x = if message.role == Role::User {
                                (canvas_width - margin - cap).max(margin)
                            } else {
                                column_x
                            };
                            let (_, height) = create_code_control(
                                state, &lang, &lines, code_x, y, cap, remember, scale,
                            );
                            y += height + scaled(4, scale);
                        }
                        other => segment.push(other),
                    }
                }
                flush_prose(
                    state,
                    &mut segment,
                    message.role,
                    failed_tool,
                    canvas_width,
                    &mut y,
                    column_x,
                    cap,
                    has_code,
                    remember,
                    scale,
                );
                y += scaled(4, scale);
            }
        }

        for (index, placeholder) in message.images.iter().enumerate() {
            let image_index = index as u32;
            let owner = crate::images::preview::PreviewOwner {
                window_id: if state.pane { "main" } else { "chat" }.into(),
                view_generation: state.view_generation,
                session_id: state.active_session.clone().unwrap_or_default(),
                entry_id: message.id.clone(),
                image_index,
            };
            let mut title = placeholder_label(index, placeholder);
            let mut frame = None;
            match crate::ui::ports::inline_preview().state_of(&owner) {
                Some(crate::images::inline::InlinePreviewState::Ready(ready)) => {
                    frame = Some(ready)
                }
                Some(crate::images::inline::InlinePreviewState::Loading) => {
                    title.push_str("（预览加载中）");
                }
                Some(crate::images::inline::InlinePreviewState::Unavailable { reason }) => {
                    title.push_str(&format!("（预览失败：{reason}）"));
                }
                None => {}
            }
            // 占位 chip（设计稿 `.chip` 的 `--bbg/--bedge/--bsh` 按钮族，与 macOS
            // `Face::Chip` 同族；2026-10-05 前是输入框族——评审实测它在消息流里
            // 像一条通栏横幅「和主题不符」）：贴合内容宽度、高 24；宽度上限与气泡
            // 同受 `bubble_cap`（86% 列宽）限制。带内联预览帧时仍走预览路径
            //（宽 = 缩放图宽 + 16、高 = 图高 + 32）。
            let chip_max = bubble_cap(f64::from(canvas_width) / scale).max(64.0);
            let mut chip_w = scaled_f(
                (estimated_text_width(&title, 11.0) + 22.0).clamp(64.0, chip_max),
                scale,
            );
            let mut button_h = scaled(24, scale);
            if let Some(ready) = frame.as_ref() {
                let cap_logic = f64::from(cap) / scale;
                let shrink = (cap_logic / f64::from(ready.width.max(1)))
                    .min(180.0 / f64::from(ready.height.max(1)))
                    .min(1.0);
                let image_height = (f64::from(ready.height) * shrink).max(1.0);
                chip_w = scaled_f(
                    (f64::from(ready.width) * shrink + 16.0).clamp(64.0, chip_max),
                    scale,
                );
                button_h = scaled_f(image_height + 32.0, scale);
            }
            // 用户条目的图片随气泡列右对齐；其余左对齐（与气泡同列）。
            let chip_x = if message.role == Role::User {
                (canvas_width - margin - chip_w).max(margin)
            } else {
                column_x
            };
            let button_y = y;
            let control_id = PLACEHOLDER_BASE + state.image_targets.len() as i32;
            let control = create_child(
                state,
                "BUTTON",
                &title,
                control_id,
                WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
                chip_x,
                y,
                chip_w,
                button_h,
            );
            if control != 0 {
                // 按钮 chip 族（`--bbg/--bedge/--bsh` + 小圆角 `--r1`；`ButtonRole::Normal`
                // 就是 bbg 族，与 macOS 的 `Face::Chip` 逐 token 对应）。
                make_themed_button_r(control, ButtonRole::Normal, scale, theme::tokens().radii.sm);
                let target = WinImageTarget {
                    entry_id: message.id.clone(),
                    image_index,
                    path: placeholder.path.clone(),
                    owner,
                    hwnd: control,
                    content_y: button_y,
                    height: button_h,
                    title,
                    frame,
                };
                DRAW_IMAGES.with(|images| {
                    images.borrow_mut().insert(control, target.clone());
                });
                state.image_targets.push(target);
                unsafe { InvalidateRect(control, std::ptr::null(), 1) };
            }
            y += button_h + scaled(4, scale);
        }

        y += scaled(MESSAGE_SPACING, scale);
        y
    }
}

// `build_remember_entry` 删除记录（2026-10-05 用户规则「我的消息去掉『记住这条』按钮，
// 要么我叫他记住，要么自动」）：平台侧入口按钮、`REMEMBER_BASE` 动作段、
// `remember_targets` 事件表与 `draw_themed_button` 的泡内配色分支一并删除；
// 记忆能力本身不动 —— `PanelAction::RememberMessage` → `ChatIntent::RememberMessage`
// → Node 的 "remember-message" 通道保留（显式路径由用户/命令触发，自动路径在 Node
// 记忆域）；`MessageSnapshot.event_id` 仍是投影数据。
// 二改（2026-10-05 图片通路批收尾）：入口以**消息右键菜单**形态恢复 ——
// `MessageSnapshot::remember_event_id` 判据 + `message_menu_subclass_proc` 菜单，
// 泡内文字按钮与动作段不恢复（守门测试继续禁）。

// `build_thinking_controls` 删除记录（2026-10-05）：思考块（折叠 chip/展开正文）
// 随用户规则「别把工具和思考放到展示层，展示只放真正的聊天记录」整体退场，
// 连同 `THINKING_BASE` 动作段、`thinking_targets`/`thinking_expanded` 状态与
// chip「贴合宽度」量测一起删除。

// `build_tool_card_controls` 删除记录（2026-10-05）：工具调用卡随「展示层只放
// 真正的聊天记录」用户规则退场；运行中的工具活动**不在聊天窗底部呈现**
// （2026-10-05 用户规则：过程状态文案只在顶栏显示；把手带只显示中性通知）。

/// 把已累积的散文块渲染成 RTF 控件（段结束时调用）。
///
/// **贴合内容宽度**（与 macOS `build_bubble_view` 同一算法，量测手段不同）：
/// `cap` 只是上限，实际泡宽取正文自然宽（估宽）；用户泡右对齐、其余与列左缘
/// 对齐。正文仍按上限宽度排版（RichEdit 自己的折行），泡宽只影响控件/外框摆位。
///
/// 2026-10-05 用户规则「我的消息去掉『记住这条』按钮，要么我叫他记住，要么自动」：
/// 入口宽度参数给 `bubble_content_width` 的 footer 位传 0（共享算法的「无入口」值），
/// 泡底不再留入口高度，平台侧的入口按钮与事件表已整体删除（二改：入口改由消息
/// 右键菜单承接，见 `show_message_menu`；`remember` 参数就是给子类挂项用的）。
#[allow(clippy::too_many_arguments)]
unsafe fn flush_prose(
    state: &mut ChatWinState,
    segment: &mut Vec<Block>,
    role: Role,
    failed_tool: bool,
    canvas_width: i32,
    y: &mut i32,
    column_x: i32,
    cap: i32,
    has_code: bool,
    // 「记住这条」右键菜单的事件身份（仅用户消息有；控件挂子类用，见
    // `message_menu_subclass_proc`）。
    remember: Option<&str>,
    scale: f64,
) {
    if segment.is_empty() {
        return;
    }
    // 空段落（含代码块 part 的尾随换行解析出的空行）不成泡：只有空段落的段被
    // 跳过，不画一个只有空行的空白气泡框（macOS 侧这类空行并进同一条气泡，
    // Windows 的代码块是独立控件 —— 就地注明这一平台差异）。
    if !segment_has_text(segment) {
        segment.clear();
        return;
    }
    // 主题底 + 前景色索引（RichEdit 不能透明：底色 = token 代表色合成面板底）。
    // 卡片与 macOS `BubbleTheme::for_message` 对齐：用户泡 = 气泡族（立体线 + 投影），
    // 助手 = 轻气泡（`bubble_ai_*`，无立体线/投影），系统条目落面板底
    // （工具结果条目整条不渲染 —— 2026-10-05 展示层只放聊天记录；下方 `Role::Tool`
    // 分支只为 match 完整性保留，与 macOS `BubbleTheme::for_role` 同口径）。
    let tokens = theme::tokens();
    let (background, ink, card) = if failed_tool {
        // 失败工具结果：warn 12% 作底、warn 作前景（中性提示，不伪装角色台词）。
        (rich_bg_alpha(tokens.warn, 0.12), RTF_WARN, None)
    } else {
        match role {
            Role::User => (
                rich_bg(&tokens.bubble_user_bg),
                RTF_USER_INK,
                Some(CardKind::UserBubble),
            ),
            Role::Assistant => (
                rich_bg(&tokens.bubble_ai_bg),
                RTF_INK,
                Some(CardKind::AssistantBubble),
            ),
            // 系统条目与 mac 同口径（`macos_chat::BubbleTheme::for_role` 的
            // `Role::System`）：**无卡、无底、`dim` 字** —— 旧实现给 ink 字 +
            // 面板底，系统消息在消息流里读成「一条正常发言」。承载控件不能透明，
            // 底仍取面板色（与画布同值、接缝不可见），只把字色改到 `dim`。
            Role::System => (rich_bg(&tokens.panel_bg), RTF_DIM, None),
            Role::Tool => (rich_bg(&tokens.panel_bg), RTF_INK, None),
        }
    };
    // 泡宽：内容自然宽（逐行估宽的最大值）夹在上下限之间；含代码块时直接给上限
    // （`bubble_content_width` 的共享口径；footer 位传 0 = 无入口）。
    let used = prose_estimated_width(segment, 13.0);
    let cap_logic = f64::from(cap) / scale;
    let bubble_w = scaled_f(bubble_content_width(used, has_code, 0.0, cap_logic), scale);
    let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
    let x = if role == Role::User {
        (canvas_width - margin - bubble_w).max(margin)
    } else {
        column_x
    };
    let (rtf, links) = prose_to_rtf_colored(segment, ink);
    segment.clear();
    let (control, height) = unsafe {
        create_rtf_control(
            state, &rtf, x, *y, bubble_w, background, card, remember, scale, false,
        )
    };
    if control != 0 && !links.is_empty() {
        // EN_LINK 是**控件级事件掩码**：不设掩码时点击链接不会发任何通知，也不会有
        // 任何默认打开行为（RichEdit 没有 AppKit 那样的「控件自己打开」回落）；
        // 掩码按「本控件确实带链接」逐个设置 —— 两侧都不依赖全局状态。
        unsafe {
            SendMessageW(control, EM_SETEVENTMASK, 0, ENM_LINK as LPARAM);
        }
        state.links.insert(control, links);
    }
    *y += height + scaled(2, scale);
}

/// 散文段是否有可渲染的文本（只有空段落的段不成泡 —— 例如含代码块 part 的
/// 尾随换行解析出的空行；空泡会画出一个只有空行的空白气泡框。macOS 的尾随
/// 空行并进同一条气泡，Windows 的代码块是独立控件，这类尾随空段落单独成段，
/// 就地注明这一平台差异）。
fn segment_has_text(blocks: &[Block]) -> bool {
    blocks.iter().any(|block| match block {
        Block::Paragraph(spans) | Block::ListItem { spans, .. } | Block::Quote(spans) => {
            spans.iter().any(|span| !span.text.is_empty())
        }
        Block::Table { rows } => rows.iter().any(|row| !row.cells.is_empty()),
        Block::CodeBlock { .. } => true,
    })
}

/// 散文段自然宽粗估（逻辑单位，逐行取最大）。
///
/// Windows 侧没有 macOS `prose_used_width`（TextKit 排版量测）的等价通路 ——
/// RichEdit 没有「已排版内容宽度」的直接查询。这里用共享口径
/// [`estimated_text_width`]（CJK 1.0×字号、其余 0.6×字号）逐行估算后取最大；
/// 量测手段不同，结果只用于「贴合内容」的泡宽，不参与视觉断言。
fn prose_estimated_width(blocks: &[Block], base_size: f64) -> f64 {
    let mut widest = 0.0_f64;
    for block in blocks {
        let line = match block {
            Block::Paragraph(spans) => spans_text(spans),
            Block::ListItem {
                ordered,
                number,
                depth,
                spans,
            } => {
                let marker = if *ordered {
                    format!("{number}. ")
                } else {
                    "• ".to_string()
                };
                let indent = "  ".repeat(usize::from(*depth));
                format!("{indent}{marker}{}", spans_text(spans))
            }
            Block::Quote(spans) => format!("> {}", spans_text(spans)),
            Block::Table { rows } => {
                for row in rows {
                    let cells: Vec<String> =
                        row.cells.iter().map(|cell| spans_text(cell)).collect();
                    widest = widest.max(estimated_text_width(&cells.join(" | "), base_size));
                }
                continue;
            }
            // 代码块不进散文量测（含代码块时泡宽直接取上限，见 `bubble_content_width`）。
            Block::CodeBlock { .. } => continue,
        };
        widest = widest.max(estimated_text_width(&line, base_size));
    }
    widest
}

/// 跨度文本拼接（估宽用；不解析格式，粗估足够）。
fn spans_text(spans: &[Span]) -> String {
    let mut text = String::new();
    for span in spans {
        text.push_str(&span.text);
    }
    text
}

/// 纯文本的自然宽粗估（逻辑单位，逐行取最大）——流式尾巴等未分块的文本用。
fn estimated_natural_width(text: &str, base_size: f64) -> f64 {
    text.split('\n')
        .map(|line| estimated_text_width(line, base_size))
        .fold(0.0_f64, f64::max)
}

/// 创建画布子控件并登记（返回句柄；同时写入 children 表）。
#[allow(clippy::too_many_arguments)]
unsafe fn create_child(
    state: &mut ChatWinState,
    class: &str,
    title: &str,
    control_id: i32,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(title).as_ptr(),
            style,
            x,
            y,
            width,
            height,
            state.canvas,
            control_id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        if hwnd != 0 {
            state.children.push(ChildEntry {
                hwnd,
                x,
                y,
                w: width,
                h: height,
            });
        }
        hwnd
    }
}

fn send_font(state: &ChatWinState, hwnd: HWND, font_index: usize) {
    if hwnd == 0 {
        return;
    }
    if let Some(font) = state.fonts.get(font_index) {
        unsafe {
            SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
        }
    }
}

/// 一个散文段（RTF）控件。
///
/// 它计入外框（气泡）高度：有外框时返回「控件高 + 上下内缩」作为气泡高，
/// 没有外框（系统/失败条目）时就是控件自身的高度。
///
/// `remember` = 该条消息的「记住这条」事件身份（仅用户消息有）：有值时给控件挂
/// [`message_menu_subclass_proc`] 并登记右键菜单目标表；无值（助手/系统/流式
/// 尾巴）不挂 —— 右键照走 RichEdit 自带菜单。
#[allow(clippy::too_many_arguments)]
unsafe fn create_rtf_control(
    state: &mut ChatWinState,
    rtf: &str,
    x: i32,
    y: i32,
    width: i32,
    background: u32,
    card: Option<CardKind>,
    remember: Option<&str>,
    scale: f64,
    code: bool,
) -> (HWND, i32) {
    unsafe {
        // 卡片（用户/助手气泡）：承载控件内缩，外圈留给画布的 `draw_frame`
        // （1px 描边 + 1px 内侧立体线；RichEdit 不能透明，只能让出边界）。
        // 气泡再让出 `BUBBLE_PAD_X/PAD_Y`（与 macOS 同源的泡内边距）—— 留白区由
        // 画布的气泡填充遮住（与控件底同色），不再露出面板底。
        let (inset_x, inset_y) = match card {
            // 纵向内缩 = 边框留白 2 + **平台补偿后的泡内边距**：mac 侧的
            // `BUBBLE_PAD_Y`（7）量的是**无行距余量的文本 extent**，而 Windows 的
            // RichEdit 行盒自带 ~4px 行距余量（13px DengXian 行距 18、墨迹 12）——
            // 直接复用 7 会让两行泡高到 62px（mac 46px，用户实拍「气泡太大」）。
            // 7 - 4 = 3 才能与 mac 的泡高对齐（36 + 2×(2+3) = 46）。
            Some(CardKind::UserBubble) | Some(CardKind::AssistantBubble) => (
                scaled_f(2.0 + BUBBLE_PAD_X, scale),
                scaled_f(2.0 + BUBBLE_PAD_Y - 4.0, scale),
            ),
            None => (0, 0),
        };
        let inner_w = (width - inset_x * 2).max(scaled(20, scale));
        let mut style = WS_CHILD | WS_VISIBLE | ES_MULTILINE as u32 | ES_READONLY as u32;
        if code {
            style |= WS_HSCROLL | WS_VSCROLL | ES_AUTOHSCROLL as u32 | ES_AUTOVSCROLL as u32;
        }
        let control = create_child(
            state,
            "RICHEDIT50W",
            "",
            0,
            style,
            x + inset_x,
            y + inset_y,
            inner_w,
            scaled(28, scale),
        );
        if control == 0 {
            return (0, scaled(28, scale));
        }
        if let Some(event_id) = remember {
            // 有事件身份的消息 RichEdit 挂右键子类（子类 id = 3，与输入区 1、
            // 命中穿透 2 同族；每个控件各自登记——同一消息的多个控件共用身份）。
            SetWindowSubclass(control, Some(message_menu_subclass_proc), 3, 0);
            state
                .message_menu_targets
                .insert(control, event_id.to_string());
        }
        send_font(state, control, if code { 3 } else { 0 });
        SendMessageW(control, EM_SETBKGNDCOLOR, 0, background as LPARAM);
        if code {
            // 关闭折行（RichEdit 官方做法：wParam=0、lParam=1），再装内容。
            SendMessageW(control, EM_SETTARGETDEVICE, 0, 1);
        }
        stream_rtf(control, rtf);
        let height = rich_edit_height(control, scale);
        if card.is_some() && !code {
            // 正文按完整高度落位后才贴圆角区域；没有内部滚动条，滚动/选择由
            // RichEdit 与外层 canvas 保持原生语义。输入框的 IME 路径不经过这里。
            MoveWindow(control, x + inset_x, y + inset_y, inner_w, height, 0);
            set_round_region(
                control,
                scaled_f(f64::from(theme::tokens().radii.md), scale),
            );
        }
        if let Some(entry) = state
            .children
            .iter_mut()
            .find(|entry| entry.hwnd == control)
        {
            entry.h = height;
        }
        if let Some(kind) = card {
            // 外框槽位 = 承载控件矩形外扩 inset（内容坐标，绘制按 scroll_y 偏移）。
            state.card_frames.push(CardFrame {
                rect: RECT {
                    left: x,
                    top: y,
                    right: x + width,
                    bottom: y + inset_y + height + inset_y,
                },
                kind,
            });
            return (control, height + inset_y * 2);
        }
        (control, height)
    }
}

/// 代码块控件（等宽、不折行、独立横向滚动）。
unsafe fn create_code_control(
    state: &mut ChatWinState,
    lang: &Option<String>,
    lines: &[String],
    x: i32,
    y: i32,
    width: i32,
    remember: Option<&str>,
    scale: f64,
) -> (HWND, i32) {
    let mut text = String::new();
    if let Some(lang) = lang {
        text.push_str(&format!("[{lang}]\n"));
    }
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    let palette = rtf_palette();
    let rtf = format!(
        "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f1\\fmodern Consolas;}}}}{}\\pard\\f1\\fs20\\cf{RTF_TOOL_INK} {}\\par}}",
        palette.table,
        rtf_escape(&text)
    );
    let (control, measured) = unsafe {
        create_rtf_control(
            state,
            &rtf,
            x,
            y,
            width,
            rich_bg(&theme::tokens().field_bg),
            None,
            remember,
            scale,
            true,
        )
    };
    if control == 0 {
        return (0, measured);
    }
    // 高度按行数（不折行）并封顶；超出部分由控件自身纵向滚动（WS_VSCROLL 未开，
    // 超长代码块以横向滚动为主，纵向截断属已知未验证项）。
    let line_height = scaled(LINE_HEIGHT as i32, scale);
    let height = ((lines.len().max(1) as i32 + 1) * line_height + scaled(8, scale))
        .min(scaled(CODE_BLOCK_MAX_HEIGHT, scale));
    if let Some(entry) = state
        .children
        .iter_mut()
        .find(|entry| entry.hwnd == control)
    {
        entry.h = height;
    }
    (control, height)
}

/// RichEdit 高度：行数 × 行高 + 内边距（RichEdit 没有直接的“内容高度”查询，
/// 这是 Windows 端的近似口径；未实机验证，见模块头注释）。
///
/// **尾随换行的坑（2026-10-05，与 macOS 对齐）**：`EM_GETLINECOUNT` 把文本末尾
/// 的孤立段落标记算成一条空行（RichEdit 的已知行为；macOS 的
/// `usedRectForTextContainer` 同坑 —— TextKit 的「额外行片段」，修法见
/// `macos_chat::text_layout_extent`）。本端的口径是**生成端保证不额外追加**
/// （`prose_to_rtf_colored` 的块间 `\par` 连接、流式尾巴同款）：
/// 生成后的文本行数与 macOS 的「逐块一行」模型逐行对应（空段落 = 一条空行，
/// 尾随换行的空行与 macOS 一样算 k-1 条），因此这里用 `EM_GETLINECOUNT` 的
/// 原始计数即可，不需要“末行为空再减一”的绕法。**新增 RTF 生成点时不要让
/// 正文以追加的 `\par` 收尾**，否则气泡底部会多一条空行。
unsafe fn rich_edit_height(control: HWND, scale: f64) -> i32 {
    // 观测计数（dev A/B）：一次 RichEdit 行数查询 = 本平台的「强制文本排版」
    // （与 macOS `text_layout_extent` 的计数对称）。
    crate::ui::chat::stream_metrics::note_text_layout();
    let lines: i32 = unsafe { SendMessageW(control, EM_GETLINECOUNT, 0, 0) } as i32;
    let line_height = scaled(LINE_HEIGHT as i32, scale);
    // 余量从 8 收到 2：`EM_GETLINECOUNT × 行距` 已经覆盖了默认行距下的最后一行
    // （含降部），8px 的旧余量在气泡里表现为「文字下面空一大截」（用户实拍
    // 「气泡太大」）。2px 只兜住四舍五入误差。
    (lines.max(1) * line_height) + scaled(2, scale)
}

/// 流式尾巴（说话人标签 + 一个 RichEdit，末尾补竖线光标）。
///
/// 与助手条目同构：轻气泡（`BubbleTheme::for_message(Assistant)` 同语义），
/// 泡宽贴合内容（含末尾竖线光标一起量）；说话人无角色名时不摆空标签。
unsafe fn build_tail_controls(
    state: &mut ChatWinState,
    text: &str,
    canvas_width: i32,
    y: i32,
    scale: f64,
) -> i32 {
    unsafe {
        let speaker = state.speaker.clone();
        let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
        let mut y = y;
        if let Some(label_text) = role_label_text(Role::Assistant, &speaker, false) {
            let label = create_child(
                state,
                "STATIC",
                &label_text,
                0,
                WS_CHILD | WS_VISIBLE,
                margin,
                y,
                canvas_width - scaled_f(BUBBLE_SIDE_MARGIN * 2.0, scale),
                scaled(LABEL_HEIGHT, scale),
            );
            send_font(state, label, 1);
            stamp_ink(label, theme::tokens().dim);
            y += scaled(LABEL_HEIGHT, scale) + 3;
        }
        let tail_text = format!("{text}▍");
        let cap = scaled_f(bubble_cap(f64::from(canvas_width) / scale), scale);
        let used = estimated_natural_width(&tail_text, 13.0);
        let bubble_w = scaled_f(
            bubble_content_width(used, false, 0.0, f64::from(cap) / scale),
            scale,
        );
        let palette = rtf_palette();
        // 末行后不追加 `\par`（同 `prose_to_rtf_colored` 的口径：尾随段落标记
        // 会被 `EM_GETLINECOUNT` 多算一行）；尾巴文本自带的光标 `▍` 落在末行上。
        let rtf = format!(
            "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f0\\fnil\\fcharset134 {};}}}}{}\\pard\\f0\\fs20\\cf{RTF_INK} {}}}",
            rtf_body_font_family(),
            palette.table,
            rtf_escape(&tail_text)
        );
        let (control, height) = create_rtf_control(
            state,
            &rtf,
            margin,
            y,
            bubble_w,
            rich_bg(&theme::tokens().bubble_ai_bg),
            Some(CardKind::AssistantBubble),
            // 流式尾巴不是已提交的消息，没有事件身份：不挂右键菜单。
            None,
            scale,
            false,
        );
        state.tail = if control != 0 { Some(control) } else { None };
        y + height
    }
}

/// 增量更新流式尾巴（`StreamOnly`）：只重建尾巴区的控件。
unsafe fn update_tail(state: &mut ChatWinState, text: Option<&str>) {
    unsafe {
        // 观测计数（dev A/B）：一次尾巴重建（与 macOS `update_tail` 对称）。
        crate::ui::chat::stream_metrics::note_tail_rebuild();
        let previous_content = state.content_height;
        let was_at_bottom =
            scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
        let base = state.base_height;
        // 尾巴区的旧控件（y ≥ base）先销毁；消息区控件保持不动。
        let mut kept: Vec<ChildEntry> = Vec::new();
        for child in state.children.drain(..) {
            if child.y >= base {
                DestroyWindow(child.hwnd);
            } else {
                kept.push(child);
            }
        }
        state.children = kept;
        state.tail = None;
        // 尾巴也是卡片（助手轻气泡）：旧帧随旧控件一起清掉（帧的 top 落在尾巴区）。
        state.card_frames.retain(|frame| frame.rect.top < base);

        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut client);
        let canvas_width = (client.right - client.left).max(scaled(200, scale));
        let y = match text {
            Some(text) if !text.trim().is_empty() => {
                build_tail_controls(state, text, canvas_width, base, scale)
            }
            _ => base,
        };
        state.content_height = y + scaled(8, scale);
        // 流式尾巴变长也算「有新内容」（用户上翻时视口外的生长同样值得一个入口）。
        if !was_at_bottom && state.content_height > previous_content {
            state.jump_unread = true;
        }
        if was_at_bottom {
            state.scroll_y = (state.content_height - state.viewport_height).max(0);
        }
        apply_scroll(state);
    }
}

/// 把手带状态行：**只显示中性系统回执 `notice`**（文案口径见 [`handle_status_label`]）；
/// 圆点、文字与箭头都画在聊天窗底面上（单面绘制），文案或圆点可见性变化时补一次
/// 把手带重绘。
fn update_status(state: &mut ChatWinState, status: &StatusSnapshot) {
    let text = handle_status_label(status);
    let dot_was = handle_status_dot_visible(&state.handle_status_label);
    let dot_now = handle_status_dot_visible(&text);
    let text_changed = text != state.handle_status_label;
    unsafe {
        // 主按钮槽按运行态换内容（2026-10-05 用户规则「与 demo 一致」）：运行中
        // 显示「停止」、收起「发送」（同一槽位；运行中仍可经 Enter 发送）。
        ShowWindow(state.stop, if status.running { SW_SHOW } else { SW_HIDE });
        ShowWindow(state.send, if status.running { SW_HIDE } else { SW_SHOW });
        if (dot_was != dot_now || text_changed) && !rect_is_empty(&state.paint.handle) {
            InvalidateRect(state.hwnd, &state.paint.handle, 0);
        }
    }
    state.handle_status_label = text;
}

// ==========================================
// RTF 生成（受控块 → RTF；所有内容经转义，不执行任何宏）
// ==========================================

/// 受控块 → RTF（散文段）。返回 (rtf, 链接表[(显示文本, URL)])。
///
/// 固定表头：f0 = 微软雅黑 UI（正文）、f1 = Consolas（行内代码/代码块）；
/// 颜色表由 `rtf_palette` 按当前主题生成，索引见 `RTF_*` 常量。
/// `default_color` 是整段的默认前景色索引（段首显式下发，引用块收尾也回到它
/// 而不是重置为黑；块内显式颜色如链接 `\cf{RTF_ACCENT}` 不受影响）。
///
/// **块之间以 `\par` 连接，末块之后不再追加**（2026-10-05，与 macOS 的行数口径
/// 对齐）：`EM_GETLINECOUNT` 会把文本末尾的孤立段落标记算成一条空行（Windows
/// 上的已知行为；macOS 的 `usedRectForTextContainer` 同坑 —— 「额外行片段」，
/// 见 `macos_chat::text_layout_extent`）。旧实现每块都追加 `\par`，于是**每个
/// 气泡**的估算行数都比实际多一行（底部多一条空行）；连接式生成后控件文本的
/// 行数与 macOS 的「逐块一行」模型逐行对应（空段落 = 一条空行）。**新增生成
/// 点时不要让正文以 `\par` 收尾**，否则 `rich_edit_height` 会重新多算一行。
///
/// 正文行距**没有**写 `\sl`：RichEdit 会把 `\sl` 夹到「字体自然行高」以上
/// （2026-10-07 实机：`\sl260\slmult0`(13pt) 对 10pt 正文毫无效果，`\sl1200`
/// 立刻生效 ⇒ 小值被夹住）。要做成 mac 那样更紧的行距只能换字体族，
/// 见 `docs`/报告里的登记；这里保持默认口径。
fn prose_to_rtf_colored(blocks: &[Block], default_color: u32) -> (String, Vec<(String, String)>) {
    let mut links = Vec::new();
    let mut chunks: Vec<String> = Vec::new();
    for block in blocks {
        let mut chunk = String::new();
        match block {
            Block::Paragraph(spans) => {
                chunk.push_str("\\pard\\f0\\fs20 ");
                chunk.push_str(&format!("\\cf{default_color} "));
                push_spans_rtf(&mut chunk, spans, &mut links);
            }
            Block::ListItem {
                ordered,
                number,
                depth,
                spans,
            } => {
                let indent = 360 * (i32::from(*depth) + 1);
                let marker = if *ordered {
                    format!("{number}.")
                } else {
                    "·".to_string()
                };
                chunk.push_str(&format!("\\pard\\fi-360\\li{indent} "));
                chunk.push_str(&format!("\\cf{default_color} "));
                chunk.push_str(&rtf_escape(&marker));
                chunk.push_str("\\tab ");
                push_spans_rtf(&mut chunk, spans, &mut links);
            }
            Block::Quote(spans) => {
                chunk.push_str(&format!("\\pard\\li720\\ri360\\cf{RTF_DIM} "));
                push_spans_rtf(&mut chunk, spans, &mut links);
                chunk.push_str(&format!("\\cf{default_color}"));
            }
            Block::Table { rows } => {
                push_table_rtf(&mut chunk, rows, &mut links);
            }
            Block::CodeBlock { .. } => {}
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
    }
    let body = chunks.join("\\par ");
    let palette = rtf_palette();
    let rtf = format!(
        "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f0\\fnil\\fcharset134 {};}}{{\\f1\\fmodern Consolas;}}}}{}{body}}}",
        rtf_body_font_family(),
        palette.table
    );
    (rtf, links)
}

fn push_spans_rtf(out: &mut String, spans: &[Span], links: &mut Vec<(String, String)>) {
    for span in spans {
        if span.code {
            // 行内代码：等宽 + 主题代码底纹（索引随颜色表定）。
            out.push_str(&format!("\\f1\\highlight{RTF_CODE_BG} "));
            out.push_str(&rtf_escape(&span.text));
            out.push_str("\\highlight0\\f0 ");
            continue;
        }
        if let Some(link) = &span.link {
            let url = link.replace('\\', "\\\\").replace('"', "\\\"");
            out.push_str(&format!(
                "{{\\field{{\\*\\fldinst{{HYPERLINK \"{url}\"}}}}{{\\fldrslt{{\\ul\\cf{RTF_ACCENT} {}}}}}}}",
                rtf_escape(&span.text)
            ));
            links.push((span.text.clone(), link.clone()));
            continue;
        }
        if span.bold {
            out.push_str("\\b ");
        }
        if span.italic {
            out.push_str("\\i ");
        }
        out.push_str(&rtf_escape(&span.text));
        if span.bold {
            out.push_str("\\b0 ");
        }
        if span.italic {
            out.push_str("\\i0 ");
        }
    }
}

fn push_table_rtf(out: &mut String, rows: &[TableRow], links: &mut Vec<(String, String)>) {
    let columns = rows.iter().map(|row| row.cells.len()).max().unwrap_or(0);
    if columns == 0 {
        return;
    }
    let column_width = 3000;
    for row in rows {
        out.push_str("\\trowd\\trgaph108\\trleft-108");
        for index in 0..columns {
            out.push_str(&format!("\\cellx{}", column_width * (index as i32 + 1)));
        }
        for column in 0..columns {
            let empty: Vec<Span> = Vec::new();
            let spans = row.cells.get(column).unwrap_or(&empty);
            out.push_str("\\intbl ");
            if row.header {
                out.push_str("\\b ");
            }
            push_spans_rtf(out, spans, links);
            if row.header {
                out.push_str("\\b0 ");
            }
            out.push_str("\\cell ");
        }
        out.push_str("\\row ");
    }
}

/// RTF 文本转义：控制字转义、换行成段、非 ASCII 走 `\uN?`（UTF-16 码元，带符号）。
fn rtf_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for unit in text.encode_utf16() {
        match unit {
            0x5C => out.push_str("\\\\"),
            0x7B => out.push_str("\\{"),
            0x7D => out.push_str("\\}"),
            0x0A => out.push_str("\\par "),
            0x0D => {}
            0x09 => out.push_str("\\tab "),
            unit if (0x20..0x7F).contains(&unit) => out.push(unit as u8 as char),
            unit => out.push_str(&format!("\\u{}?", unit as i16 as i32)),
        }
    }
    out
}

struct RtfStream<'a> {
    bytes: &'a [u8],
    position: usize,
}

/// EM_STREAMIN 在 SendMessageW 返回前同步读完 cookie，局部缓冲与游标覆盖
/// 整个回调生命周期。这里不能回借 CHAT：调用者正在重建消息并持有其可变借用。
unsafe fn stream_rtf(control: HWND, rtf: &str) {
    let mut source = RtfStream {
        bytes: rtf.as_bytes(),
        position: 0,
    };
    let mut stream = EDITSTREAM {
        dw_cookie: &mut source as *mut RtfStream<'_> as usize,
        dw_error: 0,
        callback: Some(rtf_stream_callback),
    };
    unsafe {
        SendMessageW(
            control,
            EM_STREAMIN,
            SF_RTF,
            &mut stream as *mut EDITSTREAM as LPARAM,
        );
    }
    let error = stream.dw_error;
    if error != 0 {
        rust_warn!("RichEdit RTF 装载返回错误码 {error}");
    }
}

unsafe extern "system" fn rtf_stream_callback(
    cookie: usize,
    buffer: *mut u8,
    capacity: i32,
    written: *mut i32,
) -> u32 {
    if cookie == 0 || written.is_null() || capacity < 0 || (capacity > 0 && buffer.is_null()) {
        return 1;
    }
    let source = unsafe { &mut *(cookie as *mut RtfStream<'_>) };
    let remaining = source.bytes.len().saturating_sub(source.position);
    let count = remaining.min(capacity as usize);
    if count > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(source.bytes.as_ptr().add(source.position), buffer, count)
        };
        source.position += count;
    }
    unsafe { *written = count as i32 };
    0
}

// ==========================================
// 链接点击
// ==========================================

/// 点击 RichEdit 超链接：按 (显示文本 → URL) 表找目标，白名单复核后交宿主打开。
unsafe fn handle_link_click(link: &ENLINK) {
    let target_control = link.nmhdr.hwnd_from;
    let range = CHARRANGE {
        cp_min: link.chrg[0],
        cp_max: link.chrg[1],
    };
    let display = unsafe { read_range_text(target_control, range) };
    let url = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .and_then(|state| state.links.get(&target_control))
            .and_then(|links| {
                links
                    .iter()
                    .find(|(text, _)| *text == display)
                    .map(|(_, url)| url.clone())
            })
    });
    let Some(url) = url else {
        rust_debug!("RichEdit 链接点击但回查表里没有目标（拒绝打开）：{display:?}");
        return;
    };
    // 与 macOS 同一条纯函数裁决（点击时二次白名单复核；有单测）。
    // 拒绝路径不需要「报告已处理」的对称动作：Windows 上打开动作只存在于本函数，
    // RichEdit 点击本身没有默认打开回落（fail-closed 是结构性的）。
    let Some(safe) = resolve_link_click(Some(url.as_str())) else {
        rust_warn!("链接协议不在白名单，拒绝打开: {url}");
        return;
    };
    let operation = wide("open");
    let file = wide(&safe);
    unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
    rust_info!("用户点击链接 → 宿主打开: {safe}");
}

unsafe fn read_range_text(control: HWND, range: CHARRANGE) -> String {
    let mut buffer: Vec<u16> = vec![0; (range.cp_max - range.cp_min).max(0) as usize + 2];
    let mut request = TEXTRANGEW {
        chrg: range,
        lpstr_text: buffer.as_mut_ptr(),
    };
    let copied = unsafe {
        SendMessageW(
            control,
            EM_GETTEXTRANGE,
            0,
            &mut request as *mut TEXTRANGEW as LPARAM,
        )
    };
    let length = copied.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length.min(buffer.len())])
}

// ==========================================
// 通用提示对话框（`ui::chat::dialog` 的平台实现）
// ==========================================
//
// 为什么不用 MessageBoxW：它只能提供系统固定按钮，无法承载「复制详情」按钮与
// 可滚动的详情框（本能力的旧壳出口就是「详情 + 一键复制」）。这里按 W8a 聊天窗
// 的既有做法自建一个模态窗：系统 STATIC/EDIT/BUTTON 控件 + 本线程模态消息循环
// （属主窗禁用，模态语义同 MessageBox）；剪贴板走共享层 `ui::clipboard`
// （OpenClipboard + CF_UNICODETEXT），不新开 PowerShell 子进程 —— Node 侧那条
// `clipboard_write` 命令是 IPC 面（且以子进程实现），UI 自身的用户动作不依赖它。

/// 对话框窗口类名（与聊天窗/画布类并列注册）。
const DIALOG_CLASS: &str = "DeskPetChatDialog";
/// 复制按钮控件 ID（「确定/取消」用系统 IDOK/IDCANCEL）。
const DIALOG_COPY_ID: i32 = 101;

/// 对话框布局（逻辑像素，按窗口 DPI 同比缩放）。
const DLG_CLIENT_W: i32 = 420;
const DLG_MARGIN: i32 = 14;
const DLG_TITLE_H: i32 = 22;
const DLG_MESSAGE_H: i32 = 40;
const DLG_DETAIL_H: i32 = 120;
const DLG_BUTTON_H: i32 = 26;
const DLG_BUTTON_W: i32 = 96;
const DLG_GAP: i32 = 8;

/// 弹开中的对话框状态（同一时刻至多一个；只在 UI 主线程读写）。
struct ChatDialog {
    /// 对话框窗口（由模态循环结束后统一销毁：循环内不拆自己的窗）。
    hwnd: HWND,
    /// 弹开期间被禁用的属主窗（0 = 无属主，比如前台没有本线程窗口）。
    owner: HWND,
    /// 详情原文（复制目标；不从 EDIT 控件读回，保持单一来源）。
    detail: Option<String>,
    copy_button: HWND,
    /// 用户已选定（确定/取消/标题栏关闭）：模态循环据此退出。
    closed: bool,
}

thread_local! {
    static CHAT_DIALOG: RefCell<Option<ChatDialog>> = const { RefCell::new(None) };
    /// 对话框窗口类是否已注册（进程内一次；失败在显示时如实报出）。
    static DIALOG_CLASS_READY: Cell<bool> = const { Cell::new(false) };
}

/// 弹出提示对话框（UI 主线程；`ui::chat::dialog` 经主线程队列调用到这里）。
///
/// 详情存在时显示只读详情框 + 「复制详情」按钮；Enter/Esc 经 `IsDialogMessageW`
/// 映射到「确定/关闭」，与系统对话框习惯一致。
pub(crate) fn show_dialog(spec: crate::ui::chat::dialog::DialogSpec) {
    if CHAT_DIALOG.with(|cell| cell.borrow().is_some()) {
        rust_warn!("已有提示对话框在显示，忽略本次请求：{}", spec.title);
        return;
    }
    if let Err(error) = unsafe { run_modal_dialog(spec) } {
        rust_warn!("提示对话框创建失败：{error}");
    }
}

/// 注册对话框窗口类（幂等）。
fn ensure_dialog_class() -> Result<(), String> {
    if DIALOG_CLASS_READY.with(Cell::get) {
        return Ok(());
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 类名缓冲先绑定再取指针（临时 Vec 会立刻析构，指针悬垂；与 ensure_chat_classes 同规）。
    let class_name = wide(DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = Some(dialog_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类刷留空：底色由 WM_ERASEBKGND 按主题画（换主题不必重注册窗口类）。
    wc.hbrBackground = 0;
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err("RegisterClassW（提示对话框）失败".into());
    }
    DIALOG_CLASS_READY.with(|ready| ready.set(true));
    Ok(())
}

unsafe fn run_modal_dialog(spec: crate::ui::chat::dialog::DialogSpec) -> Result<(), String> {
    ensure_dialog_class()?;
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let owner = unsafe { GetActiveWindow() };
    let scale = if owner != 0 {
        dpi_scale(owner)
    } else {
        // 无属主（前台没有本线程窗口）：GetDpiForWindow(0) 无意义，退回系统 DPI。
        f64::from(unsafe { GetDpiForSystem() }.max(DPI_BASELINE)) / f64::from(DPI_BASELINE)
    };

    // ── 布局 ──
    let client_w = scaled(DLG_CLIENT_W, scale);
    let margin = scaled(DLG_MARGIN, scale);
    let gap = scaled(DLG_GAP, scale);
    let title_h = scaled(DLG_TITLE_H, scale);
    let message_h = scaled(DLG_MESSAGE_H, scale);
    let detail_h = scaled(DLG_DETAIL_H, scale);
    let button_h = scaled(DLG_BUTTON_H, scale);
    let button_w = scaled(DLG_BUTTON_W, scale);
    let content_w = client_w - margin * 2;

    let title_y = margin;
    let message_y = title_y + title_h + gap;
    let detail_y = message_y + message_h + gap;
    let button_y = if spec.detail.is_some() {
        detail_y + detail_h + gap
    } else {
        message_y + message_h + gap
    };
    let client_h = button_y + button_h + margin;

    // 客户区 → 外框尺寸；属主存在时居中于属主，否则居中于主屏。
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU;
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
    let (x, y) = if owner != 0 && unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (
            (unsafe { GetSystemMetrics(SM_CXSCREEN) } - window_w) / 2,
            (unsafe { GetSystemMetrics(SM_CYSCREEN) } - window_h) / 2,
        )
    };

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(DIALOG_CLASS).as_ptr(),
            wide(&spec.title).as_ptr(),
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
    if hwnd == 0 {
        return Err("提示对话框 CreateWindowExW 失败".into());
    }

    // 全局字体快照与聊天窗同口径（对话框不成为第二个字体定义点）。
    // 灰度抗锯齿（`create_ui_font`）：对话框与主界面同一字体口径，不用 ClearType。
    let make_font = |height: i32, weight: i32, face: &str| {
        paint_win::create_ui_font(-scaled(height, scale), weight, face)
    };
    let snapshot = crate::ui::font::snapshot();
    let ui_face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    let body_size = snapshot.scaled_size(13.0, 13.5).round() as i32;
    let detail_size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    let body = make_font(body_size, FW_NORMAL as i32, &ui_face);
    let bold = make_font(body_size, FW_BOLD as i32, &ui_face);
    let mono = make_font(detail_size, FW_NORMAL as i32, "Consolas");

    // ── 子控件 ──
    let title = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(&spec.title).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            title_y,
            content_w,
            title_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 正文标签：STATIC 默认左对齐 + 自动换行（SS_LEFT=0）。
    let message = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(&spec.message).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            message_y,
            content_w,
            message_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    let detail_edit = match spec.detail.as_deref() {
        Some(detail) => unsafe {
            CreateWindowExW(
                WS_EX_CLIENTEDGE,
                wide("EDIT").as_ptr(),
                wide(detail).as_ptr(),
                WS_CHILD
                    | WS_VISIBLE
                    | WS_VSCROLL
                    | WS_TABSTOP
                    | ES_MULTILINE as u32
                    | ES_READONLY as u32
                    | ES_AUTOVSCROLL as u32,
                margin,
                detail_y,
                content_w,
                detail_h,
                hwnd,
                0,
                hinstance,
                std::ptr::null(),
            )
        },
        None => 0,
    };
    let ok_x = client_w - margin - button_w;
    let copy_x = ok_x - gap - button_w;
    let ok = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("确定").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
            ok_x,
            button_y,
            button_w,
            button_h,
            hwnd,
            IDOK as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    let copy_button = if spec.detail.is_some() {
        unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("复制详情").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                copy_x,
                button_y,
                button_w,
                button_h,
                hwnd,
                DIALOG_COPY_ID as HMENU,
                hinstance,
                std::ptr::null(),
            )
        }
    } else {
        0
    };
    unsafe {
        SendMessageW(title, WM_SETFONT, bold as WPARAM, 1);
        SendMessageW(message, WM_SETFONT, body as WPARAM, 1);
        if detail_edit != 0 {
            SendMessageW(detail_edit, WM_SETFONT, mono as WPARAM, 1);
        }
        if copy_button != 0 {
            SendMessageW(copy_button, WM_SETFONT, body as WPARAM, 1);
        }
        SendMessageW(ok, WM_SETFONT, body as WPARAM, 1);
    }

    // ── 模态循环 ──
    CHAT_DIALOG.with(|cell| {
        *cell.borrow_mut() = Some(ChatDialog {
            hwnd,
            owner,
            detail: spec.detail.clone(),
            copy_button,
            closed: false,
        });
    });
    if owner != 0 {
        unsafe { EnableWindow(owner, 0) };
    }
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(ok);
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    loop {
        let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if ret == 0 {
            // 取到 WM_QUIT（应用退出中）：交还外层循环，不吞掉退出语义。
            unsafe { PostQuitMessage(msg.wParam as i32) };
            break;
        }
        if ret == -1 {
            break;
        }
        if unsafe { IsDialogMessageW(hwnd, &msg) } == 0 {
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let closed = CHAT_DIALOG.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|dialog| dialog.closed)
                .unwrap_or(true)
        });
        if closed {
            break;
        }
    }

    // 收尾：状态先摘除，再销毁窗口/恢复属主（顺序固定，避免半拆状态被消息重入读到）。
    let dialog = CHAT_DIALOG.with(|cell| cell.borrow_mut().take());
    if let Some(dialog) = dialog {
        unsafe {
            DestroyWindow(dialog.hwnd);
            if dialog.owner != 0 && IsWindow(dialog.owner) != 0 {
                EnableWindow(dialog.owner, 1);
                SetForegroundWindow(dialog.owner);
            }
            DeleteObject(body);
            DeleteObject(bold);
            DeleteObject(mono);
        }
    }
    Ok(())
}

/// 标记对话框已选定（窗口由模态循环结束后统一销毁）。
fn close_chat_dialog() {
    CHAT_DIALOG.with(|cell| {
        if let Some(dialog) = cell.borrow_mut().as_mut() {
            dialog.closed = true;
        }
    });
}

unsafe extern "system" fn dialog_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            if id == DIALOG_COPY_ID {
                let copy_button = CHAT_DIALOG.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|dialog| dialog.copy_button)
                        .unwrap_or(0)
                });
                let detail = CHAT_DIALOG.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|dialog| dialog.detail.clone())
                });
                if let Some(detail) = detail {
                    // 共享层是安全函数（unsafe 收在 `ui::clipboard` 内部），不要再包 unsafe。
                    if crate::ui::clipboard::write_text(hwnd, &detail) {
                        // 就地反馈（旧壳点详情变「✓ 已复制」的同款语义）：不关窗，可继续操作。
                        unsafe { SetWindowTextW(copy_button, wide("已复制").as_ptr()) };
                    } else {
                        rust_warn!("复制详情到剪贴板失败");
                    }
                }
                0
            } else if id == IDOK || id == IDCANCEL {
                close_chat_dialog();
                0
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_CLOSE => {
            close_chat_dialog();
            0
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        WM_ERASEBKGND => {
            // 对话框底：面板底色（与聊天窗同源；错误诊断保持中性、不套角色配色）。
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                win_rect_of(&client),
                &theme::tokens().panel_bg,
            );
            1
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

// ==========================================
// 纯逻辑单测（无 Win32 调用；本模块只在 Windows 编译，macOS 上跑不到 —— 见 AGENTS §2。
// 本文件用例由 CI 的 verify (windows-latest) 执行；同表纯函数另在开发机做过
// 逐字镜像验证（先桩后实现，先红后绿），见交付报告。）
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::chat::panels::{PanelKind, PanelSurface, PanelView};
    use crate::ui::theme::ThemeId;

    /// ownerdraw 按钮必须走**承载窗底重放**：token 近似补角/补底正是用户 2026-10-07
    /// 实拍「按钮后面一块灰色矩形底」的根因（近似色比条区真实像素暗 20+ 灰阶）。
    /// 源码级守门（与 `windows_settings` 的同名测试同款）：四条绘制入口都得先
    /// `blit_button_backdrop` 再画药丸。
    #[test]
    fn ownerdraw按钮走承载窗底重放() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/windows_chat.rs"
        ));
        let production = &src[..src.find("#[cfg(test)]").expect("必须有测试段")];
        assert!(
            production.contains("unsafe fn blit_button_backdrop("),
            "缺少承载窗底重放实现（底必须来自父窗真实像素）"
        );
        assert_eq!(
            production
                .matches("let backdrop = unsafe { blit_button_backdrop(item, rect) };")
                .count(),
            4,
            "四条绘制入口（通用按钮 / 待发送 chip / 无缩略图 chip / 画布内图片 chip）都必须重放底"
        );
    }

    /// 接触影不得画隐藏控件：隐藏窗口照样有矩形（`GetWindowRect` 有效），
    /// `paint_button_shadows` 不看可见性就会在原位留一枚**没有按钮的灰药丸** ——
    /// 用户 2026-10-07 实拍「上拉条上面一个莫名其妙的灰色气泡」正是隐藏的
    /// 「↓ 新消息」按钮被画布一直补投影。
    #[test]
    fn 接触影跳过隐藏控件() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/windows_chat.rs"
        ));
        let production = &src[..src.find("#[cfg(test)]").expect("必须有测试段")];
        let start = production
            .find("unsafe fn paint_button_shadows")
            .expect("paint_button_shadows 必须存在");
        let body = &production[start..(start + 900).min(production.len())];
        assert!(
            body.contains("IsWindowVisible(control)"),
            "投影前必须判控件可见性（否则隐藏按钮留下一枚无字灰药丸）"
        );
    }

    #[test]
    fn richedit_结构遵循_sdk_四字节对齐() {
        assert_eq!(std::mem::align_of::<EDITSTREAM>(), 4);
        assert_eq!(
            std::mem::offset_of!(EDITSTREAM, callback),
            std::mem::size_of::<usize>() + 4
        );
        assert_eq!(
            std::mem::size_of::<EDITSTREAM>(),
            2 * std::mem::size_of::<usize>() + 4
        );
        assert_eq!(
            std::mem::offset_of!(ENLINK, w_param),
            std::mem::size_of::<Nmhdr>() + 4
        );
    }

    #[test]
    fn rtf_流式装载不回借聊天布局状态() {
        unsafe {
            assert_ne!(LoadLibraryW(wide("Msftedit.dll").as_ptr()), 0);
            let control = CreateWindowExW(
                0,
                wide("RICHEDIT50W").as_ptr(),
                wide("").as_ptr(),
                WS_POPUP | ES_MULTILINE as u32,
                0,
                0,
                320,
                100,
                0,
                0,
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            assert_ne!(control, 0, "必须真实建立 RichEdit 来验证同步流式回调");
            let expected = "正文：hello 中文";
            let rtf = format!("{{\\rtf1\\ansi {}}}", rtf_escape(expected));
            CHAT.with(|cell| {
                let _rebuild_borrow = cell.borrow_mut();
                stream_rtf(control, &rtf);
                assert_eq!(read_window_text(control), expected);
                assert_eq!(SendMessageW(control, EM_GETLINECOUNT, 0, 0), 1);
                SetWindowTextW(control, wide("first\r\nsecond").as_ptr());
                assert_eq!(SendMessageW(control, EM_GETLINECOUNT, 0, 0), 2);
            });
            DestroyWindow(control);
        }
    }

    #[test]
    fn rtf_回调分段推进到真正的文件末尾() {
        let bytes = b"12345";
        let mut source = RtfStream { bytes, position: 0 };
        let cookie = &mut source as *mut RtfStream<'_> as usize;
        let mut buffer = [0u8; 3];
        let mut written = -1;
        unsafe {
            assert_eq!(
                rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
                0
            );
            assert_eq!(written, 3);
            assert_eq!(&buffer, b"123");
            assert_eq!(
                rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
                0
            );
            assert_eq!(written, 2);
            assert_eq!(&buffer[..2], b"45");
            assert_eq!(
                rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
                0
            );
            assert_eq!(written, 0);
        }
    }

    /// 生产代码段（`#[cfg(test)]` 之前）——源码级守门断言都在这段上做，
    /// 否则会命中测试自己的字面量（那种断言永远为真、等于没写）。
    fn production_source() -> &'static str {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/windows_chat.rs"
        ));
        let end = src.find("#[cfg(test)]").expect("必须有测试段");
        &src[..end]
    }

    /// 从源码里截出某个函数的函数体（大括号配对；守门断言用）。
    fn function_body<'a>(src: &'a str, signature: &str) -> Option<&'a str> {
        let start = src.find(signature)?;
        let open = src[start..].find('{')? + start;
        let mut depth = 0usize;
        for (offset, ch) in src[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&src[open..open + offset + 1]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// 浮层盒：底边锚定、左右留边、高度按内容且有上限。
    #[test]
    fn 浮层盒_底边锚定且高度封顶() {
        let panel_box = overlay_box_rect(400, 500, 120, 9, 9);
        assert_eq!(panel_box, paint_win::Rect::new(9, 500 - 9 - 120, 382, 120));
        let capped = overlay_box_rect(400, 300, 500, 9, 9);
        assert_eq!(capped.h, 300 - 18);
        assert_eq!(capped.bottom(), 300 - 9);
        let tiny = overlay_box_rect(10, 10, 999, 9, 9);
        assert!(tiny.w >= 1 && tiny.h >= 1, "退化尺寸不得产生负宽高");
    }

    /// 「点浮层外关闭」的命中判定：盒内（含空白）不关，盒外关；右/下开区间。
    #[test]
    fn 浮层点击_盒内不关盒外关() {
        let panel_box = paint_win::Rect::new(9, 100, 200, 150);
        assert!(rect_contains(panel_box, 9, 100));
        assert!(rect_contains(panel_box, 208, 249));
        assert!(!rect_contains(panel_box, 208, 250));
        assert!(!rect_contains(panel_box, 8, 150));
        assert!(!rect_contains(panel_box, 100, 250));
    }

    /// 遮罩按主题明暗分档（深色近黑 / 浅色近白），且与面板底实色合成后可见。
    #[test]
    fn 遮罩色随主题明暗分档且与面板底可辨() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let scrim = scrim_color(t);
            assert!(
                scrim.a > 0.3 && scrim.a < 0.7,
                "{id:?} 遮罩透明度越界: {}",
                scrim.a
            );
            if t.dark {
                assert!(
                    scrim.r <= 0.05 && scrim.g <= 0.05 && scrim.b <= 0.1,
                    "{id:?} 深色遮罩应近黑"
                );
            } else {
                assert!(
                    scrim.r >= 0.9 && scrim.g >= 0.9 && scrim.b >= 0.9,
                    "{id:?} 浅色遮罩应近白"
                );
            }
            let flat = scrim_flat(t);
            let panel = t.panel_bg.base_color();
            let delta =
                (flat.r - panel.r).abs() + (flat.g - panel.g).abs() + (flat.b - panel.b).abs();
            assert!(
                delta > 0.03,
                "{id:?} 遮罩合成后与面板底太接近（Δ={delta:.3}）"
            );
        }
    }

    /// 圆角三档来自 token（chip 用 `sm`、浮层盒用 `md`；0 会让圆角静默失效）。
    #[test]
    fn 圆角三档来自_token() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            assert!(
                t.radii.sm > 0.0 && t.radii.md > 0.0 && t.radii.btn > 0.0,
                "{id:?} 圆角未填"
            );
        }
    }

    /// 面板分区：**全部决策面**（计划/恢复计划/权限/中断/队列）与 Transient（slash）
    /// 永远在流内 —— 权限弹窗等必须始终可见，不许被悬浮层抢走；**三块 Inspector
    /// （用量/调试/投递）全进同一个浮层**（顺序 = 声明序，不再区分「打开的是哪一块」）；
    /// **会话历史进锚定弹层、不进流内面板栈**（挂在栈里会跑到页面底部）。
    #[test]
    fn 面板分区_流内与浮层各归其位() {
        let decisions = [
            PanelKind::Plan,
            PanelKind::RecoveredPlan,
            PanelKind::Permission,
            PanelKind::Interrupted,
            PanelKind::Queue,
        ];
        let mut views: Vec<PanelView> = decisions.iter().map(|k| PanelView::new(*k)).collect();
        views.push(PanelView::new(PanelKind::SlashCandidates));
        views.push(PanelView::new(PanelKind::SessionHistory));
        views.push(PanelView::new(PanelKind::Usage));
        views.push(PanelView::new(PanelKind::DebugBar));
        views.push(PanelView::new(PanelKind::Delivery));

        let groups = partition_panels(&views);
        // 决策面全部在流内（含权限 —— 静态核对结论就钉在这条断言上）。
        for kind in decisions {
            assert!(
                groups.flow.iter().any(|v| v.kind == kind),
                "{kind:?} 必须留在流内（必须可见的决策面）"
            );
        }
        assert_eq!(groups.flow.len(), 6); // 5 决策 + slash
        assert!(groups
            .flow
            .iter()
            .all(|v| !matches!(v.kind.surface(), PanelSurface::Inspector)));
        // 三块 Inspector 全进浮层，且保序（用量 → 调试 → 投递 = 声明序）。
        assert_eq!(groups.overlay.len(), 3);
        let overlay_kinds: Vec<PanelKind> = groups.overlay.iter().map(|v| v.kind).collect();
        assert_eq!(
            overlay_kinds,
            vec![PanelKind::Usage, PanelKind::DebugBar, PanelKind::Delivery]
        );
        assert_eq!(groups.anchored.len(), 1);
        assert_eq!(groups.anchored[0].kind, PanelKind::SessionHistory);
    }

    /// 把手箭头：朝向随浮层开合翻面（收着 = 上拉 ▴、开着 = 可往下收 ▾）。
    /// Windows 画的是**几何三角**（字体对这些字形的覆盖不可靠，实机把 ▴ 画成
    /// 竖条），所以这里钉的是朝向布尔，不是文案。
    #[test]
    fn 把手箭头_朝向随开合翻面() {
        assert!(handle_arrow_up(false), "浮层收着 = 上拉 ▴");
        assert!(!handle_arrow_up(true), "浮层开着 = 可往下收 ▾");
    }

    /// 把手箭头字形框由**共享** `handle_arrow_frame` 给出：水平+垂直居中
    /// （用户规则「上拉栏的箭头居中」）；绘制端在框内画三角，命中区是整条带。
    #[test]
    fn 把手箭头_共享字形框居中() {
        for logical_width in [200.0, 360.0, 460.0, 800.0] {
            let glyph = handle_arrow_frame(logical_width);
            // 共享几何第二版：字形**水平+垂直都居中**（用户规则「上拉栏的箭头居中」）。
            assert!(
                (glyph.x + glyph.width / 2.0 - logical_width / 2.0).abs() <= 0.5,
                "宽 {logical_width}: 共享字形必须居中"
            );
            assert!(
                (glyph.y + glyph.height / 2.0 - crate::ui::chat::panels::HANDLE_HEIGHT / 2.0).abs()
                    <= 0.5,
                "字形在带内垂直居中"
            );
            assert!(glyph.x >= 0.0, "字形不许滚出左缘");
        }
        // 状态文字只占**左半侧**（箭头居中后中间那段让给箭头）；窄窗可压到 0。
        let left = crate::ui::chat::panels::handle_status_width(460.0);
        assert!(left < 230.0, "状态文字不许压过中线（实得 {left}）");
        assert_eq!(crate::ui::chat::panels::handle_status_width(10.0), 0.0);
    }

    /// 用户规则（2026-10-05）：**过程状态文案只在顶栏显示** —— 把手带文案只取
    /// 中性通知 `notice`，空通知 = 空串；`text`（阶段/工具文案）不得漏到底部
    /// （旧实现的 `or(text)` 兜底是这条规则的反例）。
    #[test]
    fn 把手带状态文案只取通知() {
        let mut status = StatusSnapshot {
            text: Some("正在调用工具".into()),
            ..StatusSnapshot::default()
        };
        assert_eq!(
            handle_status_label(&status),
            "",
            "过程文案（text）不得漏到把手带"
        );
        status.notice = Some("已发送".into());
        assert_eq!(handle_status_label(&status), "已发送");
        assert!(
            !handle_status_label(&status).contains("工具"),
            "通知与过程文案不得拼接"
        );
        status.notice = None;
        assert_eq!(handle_status_label(&status), "", "空通知 = 空串");
    }

    /// 圆点与文字同生共死（与 macOS `update_status` 的 `dot.setHidden(text.is_empty())`
    /// 同口径，不 trim）。
    #[test]
    fn 圆点与文字同生共死() {
        assert!(!handle_status_dot_visible(""));
        assert!(handle_status_dot_visible("已发送"));
    }

    /// 把手带文案不再落过程文案 —— 源码级守门（防止 `update_status` 退回
    /// `status.text` 兜底；文案口径必须收口到纯函数，圆点可见性变化必须补重绘）。
    #[test]
    fn 把手带文案不落过程文案_源码守门() {
        let production = production_source();
        let body = function_body(production, "fn update_status").expect("update_status 必须存在");
        assert!(
            !body.contains("status.text") && !body.contains("or_else"),
            "update_status 不得回落过程文案（status.text）：把手带只显示 notice"
        );
        assert!(
            body.contains("handle_status_label"),
            "把手带文案口径必须经纯函数 handle_status_label"
        );
        assert!(
            body.contains("handle_status_dot_visible") && body.contains("InvalidateRect"),
            "圆点可见性变化必须补把手带重绘（圆点画在聊天窗底上）"
        );
    }

    /// 把手带**整条可点**（2026-10-05 第三波）：聊天窗必须接住带内空白处的按下
    /// 并开合浮层；带上的状态文字与箭头都是**单面绘制**（没有会咬掉命中的子控件，
    /// 也没有会在同一次点击里开完又关的第二条通道）。
    #[test]
    fn 把手带整条可点_源码守门() {
        let production = production_source();
        let wndproc = function_body(production, "unsafe extern \"system\" fn chat_wndproc")
            .expect("chat_wndproc 必须存在");
        assert!(
            wndproc.contains("WM_LBUTTONDOWN")
                && wndproc.contains("toggle_inspector_ui")
                && wndproc.contains("state.paint.handle"),
            "聊天窗必须按把手带矩形接住按下并开合浮层"
        );
        assert!(
            !production.contains("BTN_HANDLE_ID"),
            "把手带不许再挂子按钮（一次点击进两条开合通道 = 开完又关）"
        );
        assert!(
            production.contains("paint.handle_arrow") && production.contains("fill_triangle"),
            "上拉箭头必须由聊天窗单面绘制（几何三角 + 共享字形框）"
        );
    }

    /// 浮层四角净化（对治「弹层左上角矩形残影」）：圆角盒绘制后必须按
    /// 「方角 − 圆角」差集把缺口刷回遮罩色 —— 不赌 `GradientFill`/`AlphaBlend`
    /// 对 DC 圆角裁剪区的遵守（本机无 Windows 工具链的实机核验点）。
    #[test]
    fn 浮层四角净化_源码守门() {
        let production = production_source();
        let body = function_body(production, "unsafe fn paint_inspector_box")
            .expect("paint_inspector_box 必须存在");
        assert!(
            body.contains("corner_notch_over_scrim"),
            "圆角盒绘制后必须补四角净化（方角不得从圆弧外侧露出）"
        );
        let notch = function_body(production, "unsafe fn corner_notch_over_scrim")
            .expect("corner_notch_over_scrim 必须存在");
        assert!(
            notch.contains("CombineRgn") && notch.contains("RGN_DIFF") && notch.contains("FillRgn"),
            "净化必须走「方角 − 圆角」差集填充"
        );
        assert!(
            notch.contains("scrim_flat"),
            "缺口必须刷回遮罩色（与盒外同色）"
        );
    }

    /// 底部锚定条区几何（2026-10-05 第二次改版）：**输入行贴底**、把手带在其上，
    /// 待发送条/面板依次向上让位。
    ///
    /// 2026-10-07 与 mac `chat_bands` 逐档对齐后的正文下沿：**无插入带时贴把手带
    /// 上沿**（旧口径留一个 `PANE_GAP`，实机就是上拉条上方多一截空档，用户实拍）；
    /// 有待发送条时贴条的上沿；有流内面板时面板上方留一个 `PANE_GAP`。
    #[test]
    fn 底部条区几何_输入贴底_把手带在其上() {
        let gap = 8;
        let stack = bottom_stack(640, 56, 22, 0, 0, gap);
        assert_eq!(stack.input_y, 584, "输入行贴客户区底");
        assert_eq!(stack.handle_y, 562);
        assert_eq!(stack.handle_y + 22, stack.input_y, "把手带紧贴输入行上方");
        assert_eq!(
            stack.canvas_bottom, 562,
            "无插入带时正文下沿贴把手带上沿（不再留 PANE_GAP，与 mac chat_bands 同档）"
        );

        let with_pending = bottom_stack(640, 56, 22, 30, 0, gap);
        assert_eq!(with_pending.pending_y, 524);
        assert_eq!(with_pending.panel_bottom, 516);
        assert_eq!(
            with_pending.canvas_bottom, 524,
            "有待发送条时正文下沿贴条的上沿（条在 composer 面里，不另留缝）"
        );

        let with_panel = bottom_stack(640, 56, 22, 0, 60, gap);
        assert_eq!(with_panel.panel_bottom, 554);
        assert_eq!(with_panel.panel_top, 494);
        assert_eq!(with_panel.canvas_bottom, 486);
    }

    /// 会话历史弹层几何：右缘对齐锚点、顶边贴层顶下 gap、整体夹在窗口内
    /// （「滚出窗口时要夹住」）。纯函数，先红后绿的镜像验证见交付报告。
    #[test]
    fn 历史弹层几何_右对齐并夹在窗口内() {
        // 常规：右缘对齐「历史」按钮右缘（anchor 380）、宽 300 → x = 80；顶边 = gap。
        let panel_box = history_popover_rect(400, 500, 380, 300, 120, 4);
        assert_eq!(panel_box, paint_win::Rect::new(80, 4, 300, 120));
        // 锚点太靠左：x 夹到 0（不许滚出左缘）。
        assert_eq!(history_popover_rect(400, 500, 50, 300, 120, 4).x, 0);
        // 内容宽超过窗口：裁到窗口宽、x = 0。
        let wide = history_popover_rect(400, 500, 380, 500, 120, 4);
        assert_eq!((wide.x, wide.w), (0, 400));
        // 内容高超过层高：底边夹进层内（h = 层高 − gap）。
        let tall = history_popover_rect(400, 500, 380, 300, 999, 4);
        assert_eq!((tall.y, tall.h), (4, 496));
        assert!(tall.bottom() <= 500);
        // 退化尺寸不 panic、不出负值。
        let tiny = history_popover_rect(0, 0, 0, 0, 0, 0);
        assert!(tiny.w >= 1 && tiny.h >= 1);
    }

    /// 「↓ 新消息」的底部判据：贴底（容差内）才算在底部 —— 未读只在「不在底部」
    /// 才可能保留（按钮不再因「只是上翻历史」而出现）。
    #[test]
    fn 底部容差_贴底才算在底部() {
        assert!(!scroll_at_bottom(0, 400, 1000));
        assert!(!scroll_at_bottom(500, 400, 1000));
        assert!(scroll_at_bottom(576, 400, 1000));
        assert!(scroll_at_bottom(600, 400, 1000));
        // 内容不足一屏：任何位置都算在底部（不产生未读）。
        assert!(scroll_at_bottom(0, 400, 300));
    }

    /// 旧顶栏（被全窗宽顶栏覆盖的聊天列副本）已删除：控件、命中转发、文本刷新
    /// 路径与条内几何算式都不得回潮；顶部 26px 带仍按共享条高预留（标签条接在
    /// 全窗宽顶栏下方）。断言词拆开拼接，避免测试文本自己命中扫描。
    /// 与 macOS `macos_chat.rs` 的同名守卫对称 —— 本文件在 macOS 上不参与编译，
    /// 由 CI 的 windows job 执行（本机只做离线核对，见模块头）。
    #[test]
    fn 聊天列不再自建顶栏() {
        let production = production_source();
        for (name, needle) in [
            ("状态位控件常量", concat!("const TITLEBAR", "_STATUS_ID")),
            ("顶栏关闭按钮常量", concat!("const BTN_HIDE", "_ID")),
            ("品牌槽宽算式", concat!("fn titlebar_brand", "_width")),
            ("状态位起点算式", concat!("fn titlebar_status", "_x")),
            ("品牌文案常量", concat!("const TITLEBAR", "_BRAND_TEXT")),
            ("顶栏文本刷新副本", concat!("fn apply_titlebar", "_text")),
            ("顶栏命中转发", concat!("pane_titlebar", "_screen_hit")),
        ] {
            assert_eq!(
                production.matches(needle).count(),
                0,
                "旧顶栏实现残留「{name}」：{needle}"
            );
        }
        assert!(
            production.contains(concat!("crate::ui::titlebar::", "HEIGHT")),
            "顶部预留与标签条必须消费共享条高（顶部带归全窗宽顶栏）"
        );
    }

    /// 输入行弹性（2026-10-05 用户规则；与 macOS `input_row_columns` 同口径）：
    /// 按钮占固定宽、不随行宽变；输入框吃剩余宽度，**任何行宽下都不低于下限**
    /// （旧下限 40 会把输入框压成一条缝）；窄行允许输入框与按钮列重叠（保内容可用）。
    #[test]
    fn 输入行弹性_输入框吃剩余且保底() {
        // 宽行（460）：输入框拿剩余，按钮贴右缘。
        let wide = input_row_columns(460, 1.0);
        assert_eq!(
            wide.primary_x,
            460 - BOTTOM_RIGHT_MARGIN - SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH)
        );
        assert_eq!(
            wide.pick_x,
            wide.primary_x - BOTTOM_BUTTON_GAP - PICK_BUTTON_WIDTH
        );
        assert_eq!(
            wide.field_width,
            wide.pick_x - INPUT_BUTTON_MARGIN - SIDE_MARGIN,
            "输入框 = 行宽 − 按钮列 − 间距（弹性）"
        );
        // 主聊天列最小宽 120pt（windows_main::CHAT_MIN_WIDTH，scale=1 即物理宽）：
        // 旧常量在这里只能给 ≈40 的输入框；现在按钮收窄 + 保底 72。
        for width in [120, 160, 265, 360] {
            let cols = input_row_columns(width, 1.0);
            assert!(
                cols.field_width >= INPUT_FIELD_MIN_WIDTH,
                "宽 {width}：输入框 {} 低于下限 {INPUT_FIELD_MIN_WIDTH}",
                cols.field_width
            );
            assert!(cols.primary_x >= 0 && cols.pick_x >= 0, "不许出负坐标");
        }
        // 按钮宽度都是常量：换行宽不改变按钮尺寸（只挪位置）。
        let narrow = input_row_columns(160, 1.0);
        assert_eq!(
            wide.primary_x - wide.pick_x,
            narrow.primary_x - narrow.pick_x
        );
        // DPI 2 倍：下限与按钮一起同比放大（不靠魔法数）。
        let hidpi = input_row_columns(530, 2.0);
        assert!(hidpi.field_width >= INPUT_FIELD_MIN_WIDTH * 2);
    }

    /// 待发送条几何自洽（改常量时先红）：chip 在条内上下各留 4px 内边距
    /// （设计稿 `.pend` 的 5px 口径取 4）。
    #[test]
    fn 待发送条上下内边距() {
        assert_eq!(
            PENDING_HEIGHT - PENDING_CHIP_HEIGHT,
            8,
            "待发送条上下各留 4px 内边距"
        );
    }

    /// 验收硬指标「悬浮层开合前后消息流 y 不变」的源码级守门：
    /// 条区几何（`layout_panes_for`）不得读取任何悬浮层状态；浮层与历史弹层只分别由
    /// `layout_inspector_layer` / `layout_history_layer` 单向跟随画布矩形。
    /// 改坏这条会在 CI 直接红。
    #[test]
    fn 浮层不参与布局流_源码守门() {
        let production = production_source();
        let body = function_body(production, "unsafe fn layout_panes_for")
            .expect("layout_panes_for 必须存在");
        assert!(
            !body.contains("state.inspector")
                && !body.contains("inspector_open")
                && !body.contains("state.history"),
            "layout_panes_for 读取了悬浮层状态：开合会牵动消息流 y（违反验收硬指标）"
        );
        // 反向护栏：两层窗口的摆放确实还在布局里（单向跟随画布矩形）。
        assert!(
            body.contains("layout_inspector_layer(state")
                && body.contains("layout_history_layer(state"),
            "悬浮层的摆放必须由 layout_panes_for 单向驱动"
        );
    }

    /// 浮层内容可视高：盒高扣掉标题行与底部内边距，下限 1（盒被夹小后不为负/零）。
    #[test]
    fn 浮层内容可视高按盒几何收口() {
        let scale = 1.0;
        let panel = paint_win::Rect::new(9, 100, 382, 30 + 10 + 200);
        assert_eq!(inspector_body_view_height(panel, scale), 200);
        // 盒比头+底内边距还矮：下限 1（不产生 0/负的可视高）。
        let tiny = paint_win::Rect::new(9, 100, 382, 20);
        assert_eq!(inspector_body_view_height(tiny, scale), 1);
        // DPI 2：两条内边距随比例放大（不是魔法数）。
        let hidpi = paint_win::Rect::new(9, 100, 764, (30 + 10 + 200) * 2);
        assert_eq!(inspector_body_view_height(hidpi, 2.0), 400);
    }

    /// 抽屉内部滚动（2026-10-06）的源码级守门：内容子控件必须挂在滚动裁剪窗上、
    /// 抽屉内容必须**全量摆放**（不按上限跳过块）、滚动落地必须收口到唯一函数
    /// （钳制 + 子控件平移 + 滚动条信息）、聊天窗滚轮分派必须接上「光标在哪滚哪」。
    /// 改坏任一条会在 CI 直接红。**未在 Windows 实机验证**（本机只做离线核对）。
    #[test]
    fn 浮层内部滚动接线_源码守门() {
        let production = production_source();
        assert!(
            production.contains("INSPECTOR_SCROLL_CLASS"),
            "滚动裁剪窗的窗口类缺失（注册与创建都要有）"
        );
        let rebuild =
            function_body(production, "unsafe fn rebuild_panels").expect("rebuild_panels 必须存在");
        assert!(
            rebuild.contains("f64::INFINITY"),
            "抽屉内容必须全量摆放（不设高度上限；按上限摆放会静默丢块）"
        );
        assert!(
            rebuild.contains("panel_scroll_geometry("),
            "重建必须按共享滚动几何取可视高（与 macOS 同口径）"
        );
        let place = function_body(production, "unsafe fn place_panel_elements")
            .expect("place_panel_elements 必须存在");
        assert!(
            place.contains("state.inspector_scroll"),
            "面板元素必须挂到滚动裁剪窗（挂在浮层窗口上会缺裁剪边界）"
        );
        let layout = function_body(production, "unsafe fn layout_inspector_layer")
            .expect("layout_inspector_layer 必须存在");
        assert!(
            layout.contains("apply_inspector_scroll("),
            "滚动落地必须收口到 apply_inspector_scroll（钳制/平移/滚动条唯一实现点）"
        );
        let wheel = function_body(production, "unsafe extern \"system\" fn chat_wndproc")
            .expect("chat_wndproc 必须存在");
        assert!(
            wheel.contains("scroll_inspector_from_wheel("),
            "聊天窗滚轮分派必须接上浮层滚动（否则焦点在输入区时光标在抽屉上滚不动）"
        );
    }

    /// 正文滚轮增量必须读 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
    /// y 坐标 —— 读错会让步长随窗口在屏幕上的位置漂移）。2026-10-06 修正
    /// `chat_wndproc` 与 `canvas_wndproc` 两处后立的源码守门：改回 lParam 口径
    /// CI（Windows）直接红。**未在 Windows 实机验证**（本机只做离线核对）。
    #[test]
    fn 正文滚轮增量读wparam高字_源码守门() {
        let production = production_source();
        for signature in [
            "unsafe extern \"system\" fn chat_wndproc",
            "unsafe extern \"system\" fn canvas_wndproc",
        ] {
            let body = function_body(production, signature).expect("窗口过程必须存在");
            assert!(
                body.contains("((wparam >> 16) & 0xFFFF) as u16 as i16"),
                "{signature} 的滚轮增量没读 wParam 高字（lParam 高字是屏幕坐标，会让步长随窗口屏幕位置漂移）"
            );
        }
        assert!(
            !production.contains("delta = ((lparam >> 16)"),
            "滚轮增量不得读 lParam 高字（那是光标屏幕坐标，不是轮增量）"
        );
    }

    /// 编辑类控件配色（2026-10-06）：`PanelElement::Select` 的系统 COMBOBOX 与
    /// 可编辑框的 `WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX` 由**控件父窗**消费
    /// （组合框的展开清单也由承载它的父窗接）—— 三个承载容器（聊天窗 / 浮层滚动
    /// 裁剪窗 / 层窗）缺一处，那一组的下拉与输入框就回落系统经典外观。配色统一
    /// 转给 `windows_settings::edit_ctlcolor`（唯一实现点，本文件不得另开第二份）。
    /// **未在 Windows 实机验证**（本机只做离线核对，见模块头）。
    #[test]
    fn 编辑类控件配色三父窗都接_源码守门() {
        let production = production_source();
        for signature in [
            "unsafe extern \"system\" fn chat_wndproc",
            "unsafe extern \"system\" fn inspector_scroll_wndproc",
            "unsafe extern \"system\" fn overlay_layer_wndproc",
        ] {
            let body = function_body(production, signature).expect("窗口过程必须存在");
            assert!(
                body.contains("WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX =>"),
                "{signature} 缺编辑类控件 CTLCOLOR 臂（对应容器里的下拉/输入框会回落系统外观）"
            );
            assert!(
                body.contains("super::windows_settings::edit_ctlcolor(wparam, lparam)"),
                "{signature} 必须把编辑类控件配色转给唯一实现点（windows_settings::edit_ctlcolor）"
            );
        }
        assert!(
            !production.contains("SetBkColor"),
            "编辑类控件配色不得在本文件另开第二份实现（SetBkColor 是 edit_ctlcolor 的私有细节）"
        );
    }

    /// 面板动作派发必须走 [`dispatch_panel_action`]（派发 + 立即整帧重建）——
    /// 「投递在下拉里选完之后显示不刷新」的根因是当时的本地动作没有 bump 版本号、
    /// 刷新被版本比对丢掉；修法是平台派发后无条件重建。这条守门防止某条分派路径
    /// 退回「只派发不重建」。
    #[test]
    fn 面板动作派发都走立即重建() {
        let production = production_source();
        let helper = function_body(production, "unsafe fn dispatch_panel_action")
            .expect("dispatch_panel_action 必须存在");
        assert!(helper.contains("apply_panel_action"), "助手必须派发动作");
        assert!(
            helper.contains("chat_apply(ChatRenderUpdate::Full"),
            "助手必须立即整帧重建（否则版本比对会把刷新丢掉）"
        );
        // 裸派发只允许出现在助手自身那一处；分派臂一律走助手。
        assert_eq!(
            production
                .matches("handle_panel_outcome(crate::ui::chat::apply_panel_action")
                .count(),
            1,
            "面板动作不许绕过 dispatch_panel_action（会丢「选完不刷新」的修复）"
        );
        assert!(
            production.matches("dispatch_panel_action(").count() >= 4,
            "三个分派点（面板按钮 / 面板下拉 / 历史按钮）都该走助手"
        );
    }

    /// 第二版改版的删净守门：底部那排 chip / 轨段 / 原生投递菜单的**符号一个都不许
    /// 留在生产代码里**（共享层已物理删除这些类型；留下会编译不过或有 unused 告警）。
    /// 断言在 production 段上做（测试自己的字面量不算）。
    ///
    /// 变更记录（2026-10-05 图片通路批收尾）：禁用表**移除**了 `TrackPopupMenu` /
    /// `CreatePopupMenu` —— 二者不再是旧轨菜单的专属符号：消息右键菜单（「记住这条」
    /// 的第二形态）按计划使用同一组菜单 API。禁的是**旧轨**（`RAIL_*`、
    /// `open_rail_menu`、`MenuTarget` 等）而不是菜单 API 本身；菜单 API 的新用法由
    /// 下一条「消息右键菜单接线_源码守门」正向钉住（旧轨的删净部分一条未放宽）。
    #[test]
    fn 旧轨与菜单代码已删净_源码守门() {
        let production = production_source();
        for needle in [
            "RAIL_BASE",
            "RAIL_END",
            "RAIL_METRICS",
            "rail_children",
            "rail_targets",
            "rail_status_width",
            "rebuild_rail",
            "rail_target_index",
            "rail_chip_role",
            "open_rail_menu",
            "menu_item_id",
            "menu_index_for_command",
            "rail_entries_from",
            "delivery_label_rail",
            "RailTarget",
            "InspectorPane",
            "MenuTarget",
            "layout_rail",
            "尚未接线",
        ] {
            assert!(
                !production.contains(needle),
                "生产代码里还留着已删符号：{needle}"
            );
        }
        // 把手带是浮层唯一入口（单面绘制）：必须保留带区按下段与共享箭头几何。
        assert!(
            production.contains("rect_contains(win_rect_of(&state.paint.handle)")
                && production.contains("handle_arrow_frame"),
            "把手开合必须接线（带区命中 + 共享 handle_arrow_frame）"
        );
        // 浮层开合直接吃快照（平台不维护镜像）。
        let rebuild =
            function_body(production, "unsafe fn rebuild_panels").expect("rebuild_panels 必须存在");
        assert!(
            rebuild.contains("snapshot.inspector_open"),
            "浮层显隐必须吃快照的 inspector_open"
        );
    }

    /// 「记住这条」右键菜单接线守门（第二形态：气泡按钮退场后入口由消息右键承接）。
    /// Windows 形态 = 消息 RichEdit 挂子类接管 `WM_CONTEXTMENU` + 自建弹出菜单 +
    /// 经唯一出口 `dispatch_panel_action` 派发；文案必须引用共享常量
    /// `REMEMBER_MENU_ITEM_LABEL`（平台文件不许硬编码字面量）；事件身份表与消息菜单
    /// 目标表必须在 `release_canvas` 里一并清理，且 `rebuild_canvas` 必须经它
    /// （旧控件句柄不得留影成死菜单）。
    #[test]
    fn 消息右键菜单接线_源码守门() {
        let production = production_source();
        for needle in [
            "WM_CONTEXTMENU",
            "message_menu_subclass_proc",
            "SetWindowSubclass(control, Some(message_menu_subclass_proc), 3, 0)",
            "CreatePopupMenu",
            "AppendMenuW",
            "TrackPopupMenu",
            "TPM_RETURNCMD",
            "PanelAction::RememberMessage",
        ] {
            assert!(
                production.contains(needle),
                "消息右键菜单接线缺失：{needle}"
            );
        }
        assert!(
            production.contains("wide(REMEMBER_MENU_ITEM_LABEL)"),
            "菜单项文案必须来自共享常量 REMEMBER_MENU_ITEM_LABEL（唯一来源）"
        );
        assert!(
            !production.contains("\"记住这条\""),
            "平台文件不许硬编码「记住这条」字符串字面量（唯一来源见共享常量）"
        );
        // 两张表在 `release_canvas` 里一并清（`message_menu_targets` 紧挨 `links`）：
        // 释放路径只有这一条 —— 重建走它、隐藏与关闭也走它，比「只在重建里清」覆盖更宽。
        // 所以这里钉的是**整条链**：rebuild → release_canvas → 两张表都清。
        let release =
            function_body(production, "unsafe fn release_canvas").expect("release_canvas 必须存在");
        assert!(
            release.contains("state.message_menu_targets.clear()"),
            "释放画布必须清掉消息菜单目标表（旧控件句柄不得留影成死菜单）"
        );
        assert!(
            release.contains("state.links.clear()"),
            "释放画布必须清掉事件身份表（与消息菜单目标表同批清）"
        );
        let rebuild =
            function_body(production, "unsafe fn rebuild_canvas").expect("rebuild_canvas 必须存在");
        assert!(
            rebuild.contains("release_canvas(state)"),
            "重建画布必须经 release_canvas，否则控件释放与两张表的清理会被绕过"
        );
        assert_eq!(
            production
                .matches("handle_panel_outcome(crate::ui::chat::apply_panel_action")
                .count(),
            1,
            "记忆动作不许绕过 dispatch_panel_action（出口必须唯一，见上一条守门）"
        );
    }

    /// 输入框粘贴图片接线守门（A3 图片通路第三条：选择器 / 拖入 / 粘贴）：
    /// `WM_PASTE` 必须由**既有输入子类**接管（不挂第二个子类）、图片字节必须走共享
    /// 入口 `add_pasted_image`（落盘/准入/路径都不在平台层）、剪贴板严格配对关闭。
    /// 反向：平台文件不许出现托管目录常量（路径归 Rust 命令域）。
    #[test]
    fn 粘贴接线_源码守门() {
        let production = production_source();
        for needle in [
            "WM_PASTE",
            "OpenClipboard",
            "CloseClipboard",
            "GetClipboardData",
            "add_pasted_image",
            "bmp_container_from_dib",
        ] {
            assert!(production.contains(needle), "粘贴接线缺失：{needle}");
        }
        // CF_* 是本地定义（windows-sys 0.52 只在未启用的 System_Ole 面登记它们）：
        // 值逐条钉住，防止手滑改错格式号（错号 = 静默取不到数据）。
        for needle in [
            "const CF_BITMAP: u32 = 2",
            "const CF_DIB: u32 = 8",
            "const CF_HDROP: u32 = 15",
            "const CF_DIBV5: u32 = 17",
        ] {
            assert!(
                production.contains(needle),
                "剪贴板格式常量被改坏：{needle}"
            );
        }
        let input_proc = function_body(
            production,
            "unsafe extern \"system\" fn input_subclass_proc",
        )
        .expect("input_subclass_proc 必须存在");
        assert!(
            input_proc.contains("WM_PASTE"),
            "粘贴必须由既有输入子类接管（不挂第二个子类）"
        );
        assert_eq!(
            production
                .matches("SetWindowSubclass(input, Some(input_subclass_proc)")
                .count(),
            1,
            "输入控件不许挂第二个子类"
        );
        // 路径归 Rust 命令域：平台文件不出现托管目录常量。
        for needle in ["PASTED_DIR", "SCREENSHOT_DIR", "screenshots/"] {
            assert!(
                !production.contains(needle),
                "平台文件出现托管路径常量（路径归 Rust 命令域）：{needle}"
            );
        }
        assert!(
            !production.contains("\"记住这条\""),
            "平台文件不许硬编码菜单文案字面量（唯一来源 = 共享常量）"
        );
    }

    /// DIB → BMP 容器补头的偏移口径（纯逻辑，Windows CI 上跑）：`bfOffBits` =
    /// 14 + `biSize` + 色表字节数；40 字节头 + `BI_BITFIELDS` 另加 3 个掩码 DWORD；
    /// 头不合法必须拒绝（不拼一个解码必然失败的假文件去骗准入）。
    #[test]
    fn dib补BMP容器头的偏移() {
        // 造一个「头字段可摆、缓冲足够」的 DIB：长度 = 头 + 2 KiB 余量。
        fn dib(bit_count: u16, compression: u32, clr_used: u32, bi_size: u32) -> Vec<u8> {
            let mut data = vec![0u8; bi_size.max(40) as usize + 2048];
            data[0..4].copy_from_slice(&bi_size.to_le_bytes());
            data[14..16].copy_from_slice(&bit_count.to_le_bytes());
            data[16..20].copy_from_slice(&compression.to_le_bytes());
            data[32..36].copy_from_slice(&clr_used.to_le_bytes());
            data
        }
        let off = |b: &[u8]| u32::from_le_bytes([b[10], b[11], b[12], b[13]]) as usize;
        let size = |b: &[u8]| u32::from_le_bytes([b[2], b[3], b[4], b[5]]) as usize;

        let source = dib(24, 0, 0, 40);
        let bmp = bmp_container_from_dib(&source).unwrap();
        assert_eq!(off(&bmp), 14 + 40, "24bpp 无色表");
        assert_eq!(size(&bmp), 14 + source.len(), "bfSize = 14 + DIB 全长");
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(&bmp[14..], &source[..], "DIB 原样跟在 14 字节文件头后");

        // ≤8bpp：biClrUsed = 0 → 1<<bpp 项、每项 4 字节；非 0 用它。
        assert_eq!(
            off(&bmp_container_from_dib(&dib(8, 0, 0, 40)).unwrap()),
            14 + 40 + 1024
        );
        assert_eq!(
            off(&bmp_container_from_dib(&dib(8, 0, 16, 40)).unwrap()),
            14 + 40 + 64
        );
        // 40 字节头 + BI_BITFIELDS：掩码 3×DWORD 紧随头后（V4/V5 在头内，不再加）。
        assert_eq!(
            off(&bmp_container_from_dib(&dib(32, 3, 0, 40)).unwrap()),
            14 + 40 + 12
        );
        assert_eq!(
            off(&bmp_container_from_dib(&dib(32, 3, 0, 124)).unwrap()),
            14 + 124
        );
        // 头不合法：biSize < 40 或超出缓冲 → 拒绝。
        assert!(bmp_container_from_dib(&[]).is_none());
        assert!(bmp_container_from_dib(&[0, 0, 0, 0]).is_none());
        let full = dib(24, 0, 0, 40);
        let truncated = &full[..20];
        assert!(bmp_container_from_dib(truncated).is_none());
    }
}
