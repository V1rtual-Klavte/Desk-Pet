// ==========================================
// Profile IO — 导入/导出/删除
// 内置 profile 从 public/profiles/ 读取
// 用户 profile 通过 Tauri fs 写入 AppData
// ==========================================

import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/core";
import { listProfiles, getProfile, getActiveProfile, type ProfileData } from "./loader";
import { createLogger } from "@/services/logger";

const log = createLogger("ProfileIO");

// ── 导出 Profile 为 Zip ──

/** 需要导出的 profile 目录中的文件列表 */
const PROFILE_FILES = [
  "profile.yaml",
  "character.yaml",
  "body.png",
  "preview.png",   // 可选
];

/** 递归列出 profile 目录中所有文件 */
async function listProfileFiles(profileId: string): Promise<string[]> {
  const files: string[] = [];

  // 基础文件
  for (const f of PROFILE_FILES) {
    const resp = await fetch(`/profiles/${profileId}/${f}`);
    if (resp.ok) files.push(f);
  }

  // frames/ 目录 — 通过 character.yaml 知道有哪些帧
  try {
    const charResp = await fetch(`/profiles/${profileId}/character.yaml`);
    if (charResp.ok) {
      const text = await charResp.text();
      // 从 YAML 文本中提取帧路径（简单解析，避免加载 js-yaml）
      const framePattern = /f:\s*"([^"]+)"|f:\s*'([^']+)'|f:\s*(\S+)/g;
      let match;
      while ((match = framePattern.exec(text)) !== null) {
        const f = match[1] || match[2] || match[3];
        if (f && f.startsWith("frames/")) files.push(f);
      }
    }
  } catch { /* ignore */ }

  // fonts/ 目录
  try {
    const resp = await fetch(`/profiles/${profileId}/fonts/zpix.ttf`);
    if (resp.ok) {
      for (const font of ["zpix.ttf", "PixelMplus10-Regular.ttf", "PixelMplus10-Bold.ttf"]) {
        files.push(`fonts/${font}`);
      }
    }
  } catch { /* ignore */ }

  // sounds/ 目录 — 扫描已知音效文件
  const knownSounds = [
    "welcome_chord.wav", "send_short.wav", "reply_ding.wav",
    "popup_up.wav", "retract_down.wav", "surface_light.wav",
    "middle_tremolo.wav", "deep_noise.wav",
  ];
  for (const s of knownSounds) {
    try {
      const resp = await fetch(`/profiles/${profileId}/sounds/${s}`);
      if (resp.ok) files.push(`sounds/${s}`);
    } catch { /* skip */ }
  }

  // ui/ 目录 — 扫描子目录
  for (const sub of ["windows", "Fromtemd", "jine", "photo"]) {
    try {
      // 尝试几个已知文件来检测目录是否存在
      const testPaths: Record<string, string[]> = {
        windows: ["operation_base.png", "button_close.png", "icon_desktop_yapoo.png"],
        Fromtemd: ["FHDbg.png", "button_start.png", "bios_logo.png"],
        jine: ["icon_cho.png", "icon_ame.png"],
        photo: [], // photo 目录可能为空或没有关键文件，跳过
      };
      for (const testFile of testPaths[sub] || []) {
        const resp = await fetch(`/profiles/${profileId}/ui/${sub}/${testFile}`);
        if (resp.ok) {
          // 目录存在，使用已知文件列表
          await listUiDir(profileId, sub, files);
          break;
        }
      }
    } catch { /* ignore */ }
  }

  return files;
}

/** 列出 ui 子目录中的文件（完整已知文件表） */
async function listUiDir(profileId: string, subDir: string, files: string[]): Promise<void> {
  // ★ 完整文件表 — 基于实际磁盘扫描，覆盖所有现有素材
  const knownFiles: Record<string, string[]> = {
    windows: [
      "BaseButton.png", "BaseButtonDisabled.png", "BaseButtonHovered.png",
      "BaseButtonPressed.png", "bg_side_bar.png", "bg_stream_no_chair.png",
      "bg_stream_shield_gold.png", "button_close.png", "button_day.png",
      "button_maximize.png", "button_minimize.png", "button_start.png",
      "button_hidden.png", "haisin.png", "icon_desktop_yapoo.png",
      "icon_status_follower.png", "icon_status_love.png",
      "icon_status_love #40971.png", "icon_status_stress.png",
      "icon_status_yami.png", "operation_base.png", "operation_close.png",
      "operation_frame.png", "operation_line.png", "operation_live.png",
      "operation_pink.png", "settings_bg.png", "status_follow.png",
      "status_love.png", "status_retweet.png", "status_yami.png",
      "tinder_match.png", "title_brand.png",
      "windowbase_active.png", "windowbase_inactive.png",
    ],
    Fromtemd: [
      "BaseButton.png", "BaseButtonDisabled.png", "BaseButtonHovered.png",
      "BaseButtonPressed.png", "Bios_nso.png", "FHDbg.png", "Footer.png",
      "bios_logo.png", "boot_bios.png", "boot_logo.png", "button_day.png",
      "button_start.png", "icon_desktop_egosearch.png",
      "icon_desktop_folder_open1.png", "icon_desktop_folder_open2.png",
      "icon_desktop_folder_zip.png", "icon_desktop_internet.png",
      "icon_desktop_jine2.png", "icon_desktop_movie.png",
      "icon_desktop_text.png", "icon_desktop_twitter.png",
      "icon_desktop_youtube2.png", "icon_heart.png",
      "icon_status_follower.png", "icon_status_love #40971.png",
      "icon_status_love.png", "icon_status_stress.png",
      "icon_status_yami.png", "icon_taskbar_jine.png",
      "icon_taskbar_poketter.png", "icon_taskbar_taskmanager.png",
      "icon_trash_can.png", "login #22606.png", "login_bg.png",
      "operation_close.png", "operation_desktop.png", "operation_live.png",
      "operation_login.png", "pop_bubble.png",
      "tweet_selfie_cho_happy_001.png", "tweet_selfie_cho_happy_end.png",
      "tweet_selfie_cho_sleepy_001.png", "tweet_selfie_cho_sorrow_001.png",
    ],
    jine: [
      "Background.png", "CommentIcon.png", "InputFieldBackground.png",
      "JINEBG.png", "JINE_amechan.png", "JINE_button_tobottom.png",
      "JINE_date.png", "LineDateBG.png", "amechan.png", "bg_line_call.png",
      "bg_side_bar.png", "icon_ame.png", "icon_cho.png",
      "icon_internet.png", "icon_jine.png", "icon_jine_ame.png",
      "icon_menu.png", "icon_poketter.png", "icon_portfolio.png",
      "icon_settings.png", "icon_shadow.png", "icon_tautan.png",
      "icon_virtual.png", "icon_wiki.png", "logo.png",
      "menu_bg.png", "menu_user.png", "menu_user2.png",
      "netaChoose.png", "yomuCommentBox.png",
    ],
    photo: [
      "bank_126.png", "bank_129.png", "bank_134.png",
      "futaba.png", "futaba2.png", "insta.png", "news.png",
      "stream_cho_end.png",
      "tweet_selfie_cho_cosplay_001.png", "tweet_selfie_cho_cosplay_002.png",
      "tweet_selfie_cho_cosplay_003.png",
      "tweet_selfie_cho_grand_end_001.png", "tweet_selfie_cho_grand_end_003.png",
      "tweet_selfie_cho_grand_end_004.png",
      "tweet_selfie_cho_happa_001.png",
      "tweet_selfie_cho_happy_001.png", "tweet_selfie_cho_happy_002.png",
      "tweet_selfie_cho_happy_003.png", "tweet_selfie_cho_happy_005.png",
      "tweet_selfie_cho_happy_end.png",
      "tweet_selfie_cho_nuigurumi_001.png",
      "tweet_selfie_cho_otikomu_001.png",
      "tweet_selfie_cho_pray_001.png",
      "tweet_selfie_cho_sleepy_001.png",
      "tweet_selfie_cho_sorrow_001.png",
      "tweet_selfie_cho_start_001.png",
      "tweet_selfie_cho_yami_001.png", "tweet_selfie_cho_yami_002.png",
      "DSC_0150.png", "DSC_0180.png", "DSC_0187.png", "DSC_0248.png",
      "DSC_0303.png", "DSC_0306.png", "DSC_0316.png", "DSC_0356.png",
      "DSC_2152.png", "DSC_2180.png", "DSC_2184.png", "DSC_2191.png",
      "DSC_2193.png", "DSC_2205.png", "DSC_2208.png", "DSC_2216.png",
      "DSC_2222.png", "DSC_2225.png", "DSC_2231.png", "DSC_2242.png",
      "DSC_2247.png", "DSC_2311.png", "DSC_2357.png", "DSC_2360.png",
      "DSC_2366.png", "DSC_2375.png", "DSC_2387.png", "DSC_2396.png",
    ],
  };

  const list = knownFiles[subDir] || [];
  for (const f of list) {
    const resp = await fetch(`/profiles/${profileId}/ui/${subDir}/${f}`);
    if (resp.ok) files.push(`ui/${subDir}/${f}`);
  }
}

/** 导出 profile 为 zip 并触发下载 */
export async function exportProfileZip(profileId: string): Promise<void> {
  const profile = getProfile(profileId);
  if (!profile) {
    log.error(`Profile "${profileId}" 不存在`);
    throw new Error(`Profile "${profileId}" 不存在`);
  }

  log.info(`导出 Profile: "${profileId}"`);
  const zip = new JSZip();
  const files = await listProfileFiles(profileId);

  for (const f of files) {
    try {
      const resp = await fetch(`/profiles/${profileId}/${f}`);
      if (resp.ok) {
        const blob = await resp.blob();
        zip.file(f, blob);
      }
    } catch (e) {
      log.warn(`跳过文件: ${f}`, e);
    }
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${profileId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  log.info(`Profile "${profileId}" 导出完成 (${files.length} 文件)`);
}

// ── 导入 Profile ──

export interface ImportResult {
  success: boolean
  profileId?: string
  error?: string
}

/** 从 zip 文件导入 profile */
export async function importProfileZip(file: File): Promise<ImportResult> {
  try {
    const zip = await JSZip.loadAsync(file);
    const profileYaml = zip.file("profile.yaml");
    const bodyPng = zip.file("body.png");

    if (!profileYaml) {
      return { success: false, error: "缺少 profile.yaml" };
    }
    if (!bodyPng) {
      return { success: false, error: "缺少 body.png" };
    }

    // 从文件名提取 profile ID
    const profileId = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    if (!profileId) {
      return { success: false, error: "无效的文件名" };
    }

    log.info(`导入 Profile: "${profileId}" (${Object.keys(zip.files).length} 文件)`);

    // 通过 Tauri 命令写入 AppData
    let count = 0;
    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      // 跳过 macOS 隐藏文件
      if (path.startsWith("__MACOSX") || path.includes("/._")) continue;

      const data = await zipEntry.async("uint8array");
      await invoke("profile_file_write", {
        profileId,
        relativePath: path,
        content: Array.from(data as Uint8Array),
      });
      count++;
    }

    log.info(`Profile "${profileId}" 导入完成 (${count} 文件)`);
    return { success: true, profileId };
  } catch (e: any) {
    log.error("导入失败:", e);
    return { success: false, error: e.message || String(e) };
  }
}

/** 删除用户 profile */
export async function deleteProfile(profileId: string): Promise<void> {
  const profile = getProfile(profileId);
  if (!profile) return;
  if (profile.meta.builtin) {
    throw new Error("内置 Profile 不可删除");
  }
  await invoke("profile_delete", { profileId });
  log.info(`Profile "${profileId}" 已删除`);
}
