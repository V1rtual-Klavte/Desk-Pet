// ==========================================
// 长期记忆服务（框架预留）
// ==========================================

export interface MemoryEntry {
  id: string;
  content: string;
  timestamp: number;
  tags?: string[];
  importance?: number; // 1-10，越高越重要
}

interface MemoryData {
  version: 1;
  entries: MemoryEntry[];
  updatedAt: number;
}

const STORAGE_KEY = "deskpet_memory";
const MAX_ENTRIES = 200;

/** 从 localStorage 加载记忆 */
function loadFromStorage(): MemoryData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, entries: [], updatedAt: 0 };
    const data = JSON.parse(raw) as MemoryData;
    return data.version === 1 ? data : { version: 1, entries: [], updatedAt: 0 };
  } catch {
    return { version: 1, entries: [], updatedAt: 0 };
  }
}

/** 保存到 localStorage */
function saveToStorage(data: MemoryData): void {
  try {
    data.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("[MemoryService] 存储失败:", e);
  }
}

let memoryData = loadFromStorage();

export const MemoryService = {
  /** 获取所有记忆条目 */
  list(): MemoryEntry[] {
    return [...memoryData.entries];
  },

  /** 添加一条记忆 */
  append(content: string, tags?: string[]): MemoryEntry {
    const entry: MemoryEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content,
      timestamp: Date.now(),
      tags,
      importance: 5,
    };
    memoryData.entries.push(entry);

    // 控制总条目数
    if (memoryData.entries.length > MAX_ENTRIES) {
      memoryData.entries = memoryData.entries.slice(-MAX_ENTRIES);
    }

    saveToStorage(memoryData);
    return entry;
  },

  /** 按关键词搜索记忆 */
  search(keyword: string): MemoryEntry[] {
    const kw = keyword.toLowerCase();
    return memoryData.entries.filter(
      (e) =>
        e.content.toLowerCase().includes(kw) ||
        e.tags?.some((t) => t.toLowerCase().includes(kw)),
    );
  },

  /** 获取最近 N 条记忆 */
  recent(count: number = 10): MemoryEntry[] {
    return memoryData.entries.slice(-count);
  },

  /** 删除指定记忆 */
  remove(id: string): boolean {
    const idx = memoryData.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    memoryData.entries.splice(idx, 1);
    saveToStorage(memoryData);
    return true;
  },

  /** 清空所有记忆 */
  clear(): void {
    memoryData.entries = [];
    saveToStorage(memoryData);
  },
};
