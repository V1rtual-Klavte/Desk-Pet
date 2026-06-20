// ==========================================
// 角色人格 —— 使用 Vite ?raw 构建时嵌入，支持 HMR 热更新
// ==========================================

import type { Character, CharacterState } from "./types";
import { registerPromptGetter } from "./config";
import { aiConfig } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("Character");

import angelkawaiiRaw from "@/services/ai/characters/angelkawaii.md?raw";
import ameRaw from "@/services/ai/characters/ame.md?raw";
import pchanRaw from "@/services/ai/characters/pchan.md?raw";

const promptMap: Record<string, string> = {
  angelkawaii: angelkawaiiRaw,
  ame: ameRaw,
  pchan: pchanRaw,
};

const builtInCharacters: Character[] = [
  { id: "angelkawaii", name: "KAngel", promptPath: "angelkawaii.md" },
  { id: "ame", name: "Ame", promptPath: "ame.md" },
  { id: "pchan", name: "P酱", promptPath: "pchan.md" },
];

const state: CharacterState = {
  currentId: "angelkawaii",
  characters: [...builtInCharacters],
};

registerPromptGetter(() => promptMap[state.currentId] || getDefaultPrompt());

export const CharacterService = {
  list(): Character[] { return [...state.characters]; },
  current(): Character {
    return state.characters.find(c => c.id === state.currentId) ?? state.characters[0];
  },
  switchCharacter(id: string): boolean {
    const char = state.characters.find(c => c.id === id);
    if (!char) { log.warn("角色不存在:", id); return false; }
    state.currentId = id;
    log.info("已切换到:", char.name);
    return true;
  },
  register(char: Character, prompt?: string): void {
    if (!state.characters.find(c => c.id === char.id)) state.characters.push(char);
    if (prompt) promptMap[char.id] = prompt;
  },
};

function getDefaultPrompt(): string {
  return aiConfig.defaultSystemPrompt;
}

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("人格已热更新");
  });
}
