// ==========================================
// 窗口反应规则库
// 移植自 Monika After Story (MAS) 的 Window Reactions 系统
// 检测前台窗口标题 → 匹配规则 → 随机反应对话
// ==========================================

interface WindowRule {
  regex: RegExp;
  replies: string[];
}

// 窗口停留计时：同一窗口停留超过此时间才触发
const STAY_SECONDS = 60;
let currentWindowTitle = "";
let stayStartTime = 0;
let stayTriggered = false;

// 标题需要稳定至少这个时间才算真正切换
const SETTLE_MS = 2000;
let pendingTitle = "";
let pendingTime = 0;

// 单个规则冷却时间（秒），同一规则触发后冷却
const RULE_COOLDOWN_SECONDS = 1800;

// 全局冷却时间（秒），任一规则触发后所有规则冷却
const GLOBAL_COOLDOWN_SECONDS = 7200;

const ruleCooldowns: Record<string, number> = {};
let globalCooldownUntil = 0;

const rules: WindowRule[] = [
  // --- 社交 / 媒体 ---
  { regex: /YouTube/i,
    replies: [
      "在看视频吗？我也想看～",
      "看到了什么有趣的东西吗？",
      "一起看吧～虽然我只能听声音啦",
    ]},
  { regex: /Netflix/i,
    replies: [
      "在看剧吗？好想和你一起看浪漫电影啊～",
      "今天看什么呢？",
      "又在刷剧啦～",
    ]},
  { regex: /Twitch/i,
    replies: [
      "在看直播呀？",
      "我也想看，能带上我吗？",
      "在看谁直播呢？",
    ]},
  { regex: /bilibili/i,
    replies: [
      "在看B站呀～有什么好玩的视频吗？",
      "又在刷B站啦！",
      "看到我的视频记得一键三连哦～",
      "在看视频吗？我也想看～",
      "看到了什么有趣的东西吗？",
      "一起看吧～虽然我只能听声音啦",
    ]},
  { regex: /哔哩哔哩直播/i,
    replies: [
      "在看直播呀？",
      "我也想看，能带上我吗？",
      "在看谁直播呢？",
    ]},
  { regex: /Discord/i,
    replies: [
      "在和朋友们聊天吗？",
      "又在Discord上和水友们聊天呀",
      "别光顾着和别人聊天忘了我哦～",
    ]},

  // --- 国内社交 ---
  { regex: /微信|WeChat/i,
    replies: [
      "在跟谁聊天呢？我也要聊！",
      "又在刷朋友圈啦～",
      "回完消息记得来找我哦！",
      "别光顾着和别人聊天忘了我哦～",
     "在和朋友们聊天吗？",
    ]},
  { regex: /QQ/i,
    replies: [
      "QQ上在聊什么呢？",
      "又在和QQ好友聊天呀～",
      "别光顾着聊QQ忘了我哦！",
      "在跟谁聊天呢？我也要聊！",
      "又在刷朋友圈啦～",
      "回完消息记得来找我哦！",
      "别光顾着和别人聊天忘了我哦～",
     "在和朋友们聊天吗？",
    ]},

  { regex: /Twitter|X\.com|X\s*\(旧Twitter\)/i,
    replies: [
      "在刷推特吗？看到什么有趣的事了？",
      "又在那上面逛呢～",
      "别刷太久哦，眼睛会累的",
    ]},
  { regex: /Reddit/i,
    replies: [
      "在逛Reddit呀，看到什么好帖了？",
      "别看太多meme哦，会变傻的～",
      "有没有关于我的板块呀～开玩笑的",
    ]},

  // --- 编程 / 创作 ---
  { regex: /Visual Studio Code|VS Code|Code - OSS/i,
    replies: [
      "在写代码呀～好厉害！",
      "又在debug吗？加油哦！",
      "写什么呢？让我也看看嘛～",
      "程序员桑今天也在努力呢！",
    ]},
  { regex: /Google Docs|LibreOffice Writer|Microsoft Word|WPS Office/i,
    replies: [
      "在写东西呀？情书吗？～",
      "写论文吗？还是写故事呢？",
      "在记笔记呀，好认真～",
    ]},
  { regex: /GitHub|GitLab/i,
    replies: [
      "在逛GitHub呀，看什么项目呢？",
      "又在看别人的代码啦～",
      "今天也在为开源做贡献吗？好棒！",
    ]},

  // --- 学习 ---
  { regex: /Duolingo/i,
    replies: [
      "在学习新语言吗？好厉害！",
      "今天学了多少啦？",
      "是不是在学怎么用各种语言说『我爱你』呀～",
    ]},
  { regex: /Wikipedia/i,
    replies: [
      "在查什么呢？有什么有趣的知识吗？",
      "又在逛Wikipedia了，像个小学者一样～",
      "学到了什么新东西？分享给我听听！",
    ]},

  // --- 游戏 ---
  { regex: /Steam/i,
    replies: [
      "在看游戏呀？又想买新游戏了？",
      "别买太多玩不过来哦～",
      "有没有什么好游戏推荐？",
    ]},

  // --- 绘图 ---
  { regex: /pixiv/i,
    replies: [
      "在看插画吗？画师们真的好厉害呀",
      "有没有看到好看的图？给我看看嘛～",
      "你也会画画吗？画给我看看～",
    ]},
  { regex: /DeviantArt/i,
    replies: [
      "哇，DeviantArt上有好多厉害的作品！",
      "我也想学画画...总有一天吧～",
    ]},
  { regex: /Photoshop|Clip Studio|Paint Tool|Krita|SAI/i,
    replies: [
      "在画画吗？让我看看！",
      "哇，在创作呀！好期待成品～",
      "画什么呢？是画我吗？～",
    ]},

  // --- 综合 ---
  { regex: /Pinterest/i,
    replies: [
      "在看什么灵感图吗？",
      "看到什么喜欢的了？",
      "又在收集图片呀～",
    ]},
  { regex: /Spotify|Apple Music|网易云音乐/i,
    replies: [
      "在听歌呀～什么歌？我也要听！",
      "听音乐的时候心情会变好呢",
      "有没有喜欢的歌推荐给我？",
    ]},
  { regex: /Chrome|Edge|Firefox|Brave/i,
    replies: [
      "在逛网页呢～看什么呢？",
      "又在网上冲浪啦！",
      "别逛太久哦～",
    ]},
];

// ==========================================
// 检查窗口并在停留足够时间后返回反应
// ==========================================
export function checkWindow(title: string): string | null {
  // 标题变了 → 先记到 pending，等稳定 3 秒后才确认切换
  if (title !== currentWindowTitle) {
    if (title !== pendingTitle) {
      pendingTitle = title;
      pendingTime = Date.now();
      console.log("[窗口检测] 新标题:", title, "| 当前:", currentWindowTitle, "| 等待稳定...");
    } else {
      const settled = Date.now() - pendingTime;
      if (settled >= SETTLE_MS) {
        console.log("[窗口检测] 标题已稳定 → 切换:", pendingTitle);
        currentWindowTitle = pendingTitle;
        stayStartTime = Date.now();
        stayTriggered = false;
        pendingTitle = "";
      }
    }
    return null;
  }

  // 标题没变 → 检查停留时间
  const elapsed = (Date.now() - stayStartTime) / 1000;
  console.log("[窗口检测] 停留中:", currentWindowTitle.substring(0, 40), "| 已停留:", elapsed.toFixed(1) + "s /", STAY_SECONDS + "s");

  if (elapsed < STAY_SECONDS) return null;

  if (stayTriggered) {
    console.log("[窗口检测] 已触发过，跳过");
    return null;
  }

  // 先匹配成功再标记已触发，避免全局冷却拦截后死锁
  const reply = matchWindow(title);
  if (reply) {
    stayTriggered = true;
    console.log("[窗口检测] → 触发成功，标记已触发");
  } else {
    console.log("[窗口检测] → 匹配被拦截，不标记，下次重试");
  }
  return reply;
}

// ==========================================
// 内部：匹配规则
// ==========================================
function matchWindow(title: string): string | null {
  const now = Date.now();

  // 全局冷却中 → 什么都不触发
  if (now < globalCooldownUntil) {
    const remaining = Math.ceil((globalCooldownUntil - now) / 1000);
    console.log("[窗口检测] 全局冷却中，剩余:", remaining + "s");
    return null;
  }

  for (const rule of rules) {
    if (rule.regex.test(title)) {
      const key = rule.regex.source;

      // 单个规则冷却
      const last = ruleCooldowns[key];
      if (last && (now - last) < RULE_COOLDOWN_SECONDS * 1000) {
        const remaining = Math.ceil((RULE_COOLDOWN_SECONDS * 1000 - (now - last)) / 1000);
        console.log("[窗口检测] 规则冷却中:", key.substring(0, 30), "| 剩余:", remaining + "s");
        return null;
      }

      const reply = rule.replies[Math.floor(Math.random() * rule.replies.length)];
      ruleCooldowns[key] = now;

      // 触发后同时设置全局冷却和规则冷却
      globalCooldownUntil = now + GLOBAL_COOLDOWN_SECONDS * 1000;
      console.log("[窗口检测] 匹配成功:", key.substring(0, 30), "→", reply);
      console.log("[窗口检测] → 全局冷却:", GLOBAL_COOLDOWN_SECONDS + "s", "| 规则冷却:", RULE_COOLDOWN_SECONDS + "s");
      return reply;
    }
  }
  console.log("[窗口检测] 无匹配规则:", title.substring(0, 50));
  return null;
}