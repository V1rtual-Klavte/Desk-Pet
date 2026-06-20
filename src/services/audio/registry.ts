// ==========================================
// 音效注册中心
// 所有音效在此定义，其他地方统一引用
// 设置页可预览全部音效并指定每个事件使用哪个音效
// ==========================================

import { getBoundaryLevel } from "./boundary";

// ── 共享 AudioContext ──
let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") { sharedCtx.resume().catch(() => {}); }
    return sharedCtx;
  }
  try {
    sharedCtx = new AudioContext();
    if (sharedCtx.state === "suspended") { sharedCtx.resume().catch(() => {}); }
    return sharedCtx;
  } catch { return null; }
}

// ── 音效定义类型 ──
export interface SoundDef {
  id: string;
  name: string;
  play: () => void;
}

// ── 音效库（所有可用音效）──
const soundLibrary: SoundDef[] = [
  // ── 关闭 ──
  {
    id: "none",
    name: "关闭",
    play: () => {},
  },

  // ── 弹出音效：轻快双音上行 ──
  {
    id: "popup_up",
    name: "轻快上行",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        const gain2 = ctx.createGain();
        osc1.type = "sine"; osc2.type = "sine";
        osc1.frequency.setValueAtTime(800, ctx.currentTime);
        osc1.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.10);
        osc2.frequency.setValueAtTime(1000, ctx.currentTime + 0.06);
        osc2.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.18);
        gain1.gain.setValueAtTime(0.12, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        gain2.gain.setValueAtTime(0.10, ctx.currentTime + 0.06);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
        osc1.connect(gain1); gain1.connect(ctx.destination);
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.06);
        osc1.stop(ctx.currentTime + 0.12); osc2.stop(ctx.currentTime + 0.20);
      } catch {}
    },
  },

  // ── 收回音效：温柔下行 ──
  {
    id: "retract_down",
    name: "温柔下行",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        const gain2 = ctx.createGain();
        osc1.type = "sine"; osc2.type = "sine";
        osc1.frequency.setValueAtTime(1400, ctx.currentTime);
        osc1.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.12);
        osc2.frequency.setValueAtTime(1100, ctx.currentTime + 0.06);
        osc2.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.20);
        gain1.gain.setValueAtTime(0.11, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
        gain2.gain.setValueAtTime(0.09, ctx.currentTime + 0.06);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
        osc1.connect(gain1); gain1.connect(ctx.destination);
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.06);
        osc1.stop(ctx.currentTime + 0.14); osc2.stop(ctx.currentTime + 0.22);
      } catch {}
    },
  },

  // ── 启动欢迎音效：温暖上行和弦 ──
  {
    id: "welcome_chord",
    name: "温暖和弦",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          const t = ctx.currentTime + i * 0.12;
          gain.gain.setValueAtTime(0.10, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t); osc.stop(t + 0.30);
        });
      } catch {}
    },
  },

  // ── 发送消息音效：轻快短促 ──
  {
    id: "send_short",
    name: "短促上行",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1200, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.08);
      } catch {}
    },
  },

  // ── 收到回复音效：柔和叮咚 ──
  {
    id: "reply_ding",
    name: "柔和叮咚",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        const gain2 = ctx.createGain();
        osc1.type = "sine"; osc1.frequency.value = 880;
        osc2.type = "sine"; osc2.frequency.value = 1320;
        gain1.gain.setValueAtTime(0.10, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        gain2.gain.setValueAtTime(0.08, ctx.currentTime + 0.10);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
        osc1.connect(gain1); gain1.connect(ctx.destination);
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.10);
        osc1.stop(ctx.currentTime + 0.12); osc2.stop(ctx.currentTime + 0.22);
      } catch {}
    },
  },

  // ── 表层提示音：轻快双音 ──
  {
    id: "surface_light",
    name: "轻快提示",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = "sine"; osc1.frequency.value = 1600;
        osc2.type = "sine"; osc2.frequency.value = 1800;
        gain.gain.setValueAtTime(0.14, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
        osc1.connect(gain); osc2.connect(gain);
        gain.connect(ctx.destination);
        osc1.start(ctx.currentTime);
        osc2.start(ctx.currentTime + 0.08);
        osc1.stop(ctx.currentTime + 0.08);
        osc2.stop(ctx.currentTime + 0.16);
      } catch {}
    },
  },

  // ── 中层提示音：轻微颤音 ──
  {
    id: "middle_tremolo",
    name: "轻微颤音",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1400, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.20);
        lfo.type = "sine"; lfo.frequency.value = 6;
        lfoGain.gain.value = 15;
        lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
        gain.gain.setValueAtTime(0.16, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
        osc.connect(gain); gain.connect(ctx.destination);
        lfo.start(ctx.currentTime); osc.start(ctx.currentTime);
        lfo.stop(ctx.currentTime + 0.21); osc.stop(ctx.currentTime + 0.21);
      } catch {}
    },
  },

  // ── 深层提示音：紊乱噪音 + 降调 ──
  {
    id: "deep_noise",
    name: "紊乱噪音",
    play: () => {
      const ctx = getCtx();
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(900, ctx.currentTime);
        osc.frequency.setValueAtTime(700, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(500, ctx.currentTime + 0.18);
        lfo.type = "sawtooth"; lfo.frequency.value = 10;
        lfoGain.gain.value = 25;
        lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.connect(gain); gain.connect(ctx.destination);
        lfo.start(ctx.currentTime); osc.start(ctx.currentTime);

        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.26), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.04, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        noise.connect(noiseGain); noiseGain.connect(ctx.destination);
        noise.start(ctx.currentTime);

        lfo.stop(ctx.currentTime + 0.26); osc.stop(ctx.currentTime + 0.26); noise.stop(ctx.currentTime + 0.26);
      } catch {}
    },
  },
];

/** 获取完整音效库 */
export function getSoundLibrary(): SoundDef[] {
  return soundLibrary;
}

/** 按 ID 查找音效 */
export function getSoundById(id: string): SoundDef | undefined {
  return soundLibrary.find(s => s.id === id);
}

// ── 音效事件定义 ──
export interface SoundEvent {
  key: string;
  label: string;
  defaultSoundId: string;
}

/** 所有可配置音效事件 */
export const soundEvents: SoundEvent[] = [
  { key: "welcome", label: "启动欢迎", defaultSoundId: "welcome_chord" },
  { key: "send", label: "发送消息", defaultSoundId: "send_short" },
  { key: "reply", label: "收到回复", defaultSoundId: "reply_ding" },
  { key: "popup", label: "弹窗出现", defaultSoundId: "popup_up" },
  { key: "retract", label: "窗口收回", defaultSoundId: "retract_down" },
  { key: "surface", label: "表层提示", defaultSoundId: "surface_light" },
  { key: "middle", label: "中层提示", defaultSoundId: "middle_tremolo" },
  { key: "deep", label: "深层提示", defaultSoundId: "deep_noise" },
];

/** 事件 key → 默认音效 ID 速查表 */
const eventDefaults: Record<string, string> = {};
for (const e of soundEvents) eventDefaults[e.key] = e.defaultSoundId;

// ── 用户音效分配（localStorage）──
const ASSIGNMENTS_KEY = "deskpet_sound_assignments";

function loadAssignments(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || "{}");
  } catch {
    return {};
  }
}

/** 获取所有音效分配 */
export function getSoundAssignments(): Record<string, string> {
  const stored = loadAssignments();
  const result: Record<string, string> = {};
  for (const e of soundEvents) {
    result[e.key] = stored[e.key] || e.defaultSoundId;
  }
  return result;
}

/** 保存音效分配 */
export function saveSoundAssignments(assignments: Record<string, string>): void {
  try {
    localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
  } catch {}
}

// ── 统一播放入口 ──

/** 播放指定事件的音效（按用户分配，回退默认） */
export function playEventSound(eventKey: string): void {
  const assignments = loadAssignments();
  const soundId = assignments[eventKey] || eventDefaults[eventKey] || "none";
  if (soundId === "none") return;
  getSoundById(soundId)?.play();
}

/** 人格界限联动提示音（根据当前界限自动选择表/中/深层音效） */
export function playNotificationByBoundary(): void {
  const level = getBoundaryLevel();
  if (level <= 3) playEventSound("surface");
  else if (level === 4) playEventSound("middle");
  else playEventSound("deep");
}

// ── 向后兼容导出（供旧代码平滑迁移）──
// 直接播放默认音效（不打用户分配），供设置预览使用
export const playPopupSound = () => getSoundById("popup_up")?.play();
export const playRetractSound = () => getSoundById("retract_down")?.play();
export const playWelcomeSound = () => getSoundById("welcome_chord")?.play();
export const playSendSound = () => getSoundById("send_short")?.play();
export const playReplySound = () => getSoundById("reply_ding")?.play();
export const playSurfaceSound = () => getSoundById("surface_light")?.play();
export const playMiddleSound = () => getSoundById("middle_tremolo")?.play();
export const playDeepSound = () => getSoundById("deep_noise")?.play();
