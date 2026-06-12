/**
 * 角色/人格定义
 */
export interface Character {
  /** 角色唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 人格提示词文件路径（相对于 characters 目录） */
  promptPath: string;
}

/** 当前激活的角色状态 */
export interface CharacterState {
  currentId: string;
  characters: Character[];
}
