// ==========================================
// behavior 派生域的目录与文件名（唯一真相源）
//
// 「behavior」这一层由两个模块共同写入：behavior/collector.ts（分段／日汇总／索引）
// 与 observation/store.ts（了解层 understanding.json）。两边都从这里取名字，
// 不再各自手写目录名与文件名。
// ==========================================

/** 数据根下的派生域目录名：`runtimePath("data", BEHAVIOR_DIR, …)`。 */
export const BEHAVIOR_DIR = "behavior"

/** 了解层存储文件名（观察整理的摘要记录；清除水位也记在它里面）。 */
export const UNDERSTANDING_FILE = "understanding.json"

/** 日汇总子目录名。 */
export const DAILY_DIR = "daily"

/** 分段子目录名。 */
export const SEGMENTS_DIR = "segments"

/** 分段索引文件名。 */
export const SEGMENT_INDEX_FILE = "index.json"
