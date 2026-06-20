// ==========================================
// 长期记忆服务（localStorage 持久化）
// ==========================================

import { memoryConfig } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("Memory");

export interface MemoryEntry {
  id: string;
  content: string;
  timestamp: number;
  tags?: string[];
  importance?: number;
}

interface MemoryData {
  version: 1;
  entries: MemoryEntry[];
  updatedAt: number;
}

const STORAGE_KEY = "deskpet_memory";

function load(): MemoryData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, entries: [], updatedAt: 0 };
    const data = JSON.parse(raw) as MemoryData;
    return data.version === 1 ? data : { version: 1, entries: [], updatedAt: 0 };
  } catch { return { version: 1, entries: [], updatedAt: 0 }; }
}
function save(data: MemoryData): void {
  try {
    data.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { log.error("存储失败", e instanceof Error ? e : undefined); }
}

let memoryData = load();

export const MemoryService = {
  list(): MemoryEntry[] { return [...memoryData.entries]; },
  append(content: string, tags?: string[]): MemoryEntry {
    const entry: MemoryEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content, timestamp: Date.now(), tags, importance: 5,
    };
    memoryData.entries.push(entry);
    const max = memoryConfig.maxEntries;
    if (memoryData.entries.length > max) memoryData.entries = memoryData.entries.slice(-max);
    save(memoryData);
    return entry;
  },
  search(keyword: string): MemoryEntry[] {
    const kw = keyword.toLowerCase();
    return memoryData.entries.filter(e =>
      e.content.toLowerCase().includes(kw) || e.tags?.some(t => t.toLowerCase().includes(kw))
    );
  },
  recent(count = 10): MemoryEntry[] { return memoryData.entries.slice(-count); },
  remove(id: string): boolean {
    const idx = memoryData.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    memoryData.entries.splice(idx, 1);
    save(memoryData);
    return true;
  },
  clear(): void { memoryData.entries = []; save(memoryData); },
};
