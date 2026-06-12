import type { Character, CharacterState } from "../types/character";

// ==========================================
// 角色人格 —— 使用 Vite ?raw 构建时嵌入，支持 HMR 热更新
// ==========================================
import tangtangRaw from "@/features/chat/characters/tangtang.md?raw";
import ameRaw from "@/features/chat/characters/ame.md?raw";
import pchanRaw from "@/features/chat/characters/pchan.md?raw";

/** 角色 ID → 人格内容映射（HMR 时自动刷新） */
const promptMap: Record<string, string> = {
  tangtang: tangtangRaw,
  ame: ameRaw,
  pchan: pchanRaw,
};

// ==========================================
// 向 ai-config 注册动态 prompt 读取器
// 这样 getSystemPrompt() 永远拿到最新人格
// ==========================================
import { registerPromptGetter } from "../config/ai-config";

// 角色管理
const builtInCharacters: Character[] = [
  { id: "tangtang", name: "糖糖", promptPath: "tangtang.md" },
  { id: "ame", name: "Ame", promptPath: "ame.md" },
  { id: "pchan", name: "P酱", promptPath: "pchan.md" },
];

const state: CharacterState = {
  currentId: "tangtang",
  characters: [...builtInCharacters],
};

/** 注册动态获取器 —— 任何读 prompt 的地方都走这里，保证热更新生效 */
registerPromptGetter(() => {
  const prompt = promptMap[state.currentId];
  if (prompt) return prompt;
  console.warn("[CharacterService] 未找到人格:", state.currentId);
  return getDefaultPrompt();
});

export const CharacterService = {
  list(): Character[] {
    return [...state.characters];
  },

  current(): Character {
    return state.characters.find((c) => c.id === state.currentId)
      ?? state.characters[0];
  },

  switchCharacter(id: string): boolean {
    const char = state.characters.find((c) => c.id === id);
    if (!char) {
      console.warn("[CharacterService] 角色不存在:", id);
      return false;
    }
    state.currentId = id;
    console.log("[CharacterService] 已切换到:", char.name);
    return true;
  },

  register(char: Character, prompt?: string): void {
    if (!state.characters.find((c) => c.id === char.id)) {
      state.characters.push(char);
    }
    if (prompt) promptMap[char.id] = prompt;
  },
};

function getDefaultPrompt(): string {
  return [
    "你叫糖糖，是一个在直播的虚拟主播。",
    "性格活泼可爱、偶尔傲娇。",
    "请用简短的口语化中文回复，像在和朋友聊天一样。",
    "可以加表情，但不要用 markdown。",
  ].join("");
}

// ==========================================
// HMR 热更新
// ==========================================
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log(
      "[CharacterService] 人格已热更新，当前:",
      state.characters.find((c) => c.id === state.currentId)?.name ?? "unknown",
    );
  });
}

