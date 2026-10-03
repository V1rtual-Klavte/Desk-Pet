import type { PersonalityCard } from "@/services/personality"
import type { BehaviorSnapshot } from "@/services/behavior"
import type { ProactiveOwner, ProactiveMemoryTarget, ProactiveSourceRef } from "../protocol"
import { source } from "../opportunities"
import { stableChoice } from "../time"

/** Role anecdotes are fictional Card narrative; app categories supply topics, never claims of user preference. */
export function contentPool(card:PersonalityCard,behavior:BehaviorSnapshot,owner:ProactiveOwner,day:string,usedTopicKeys:readonly string[]=[],memoryTargets:readonly ProactiveMemoryTarget[]=[]) {
  type Choice={key:string;context:string;source:ProactiveSourceRef;targets:Array<{id:string;version:number}>}
  const cardSource=source("card",card.id,card.version,card.hash,owner)
  const choices:Choice[]=[{key:`role:${card.hash}`,context:`角色设定作为虚构叙事依据：${card.sections.roleSetting}\n选择符合角色的小日常或有趣知识，禁止声称操作过现实文件、桌面或外部应用；不伪造当前新闻。`,source:cardSource,targets:[]}]
  for(const target of memoryTargets.filter(target=>target.kind==="preference"&&target.sourceIds.length).slice(0,2))choices.push({
    key:`interest:${target.id}:v${target.version}`,context:"根据 MemoryProvider 提供的这条用户明确偏好，分享一个相关轻话题或问一个开放问题；偏好正文缺失时不推断兴趣。",
    source:{kind:"memory",id:target.id,version:target.version,revision:target.version,scope:target.scope,scopeId:target.scopeId,fingerprint:`${target.id}:${target.version}`,validUntil:null},
    targets:[{id:target.id,version:target.version}],
  })
  if(behavior.quality.status==="reliable") {
    const category=Object.entries(behavior.apps.categoryShare).filter(([name,share])=>name!=="unknown"&&share>=.2).sort((a,b)=>b[1]-a[1])[0]?.[0]
    if(category) choices.push({key:`category:${category}`,context:`合格观测中 ${category} 类应用较常出现；可分享相关轻话题，不能直接当成用户已确认的兴趣。`,source:cardSource,targets:[]})
  }
  // Rotate the conceptual topic, not merely the day identity; persisted topicKey rejects 30-day repetition.
  const variations=["一个小观察","一个开放问题","一段角色小日常","一种相关方法","一个有趣概念","一个生活灵感",
    "一个轻松比喻","一段虚构散步","一个创造小练习","一个不同视角","一句温和邀请","一个审美观察","一个记忆中的细节","一段角色独白",
    "一件适合分享的小事","一个小故事开头","一个常识背后的缘由","一种放松方式","一个想象场景","一个小小好奇",
    "一段角色童年趣事","一个角色习惯","一种天气意象","一个音乐话题","一个书中主题","一个电影话题","一段日常灵感",
    "一件角色希望尝试的小事","一个故事里的选择","一个语言小发现","一种安排节奏的方法","一个手作想法"]
  const pool=choices.flatMap(item=>variations.map(variant=>({...item,key:`${item.key}:${variant}`,context:`${item.context}\n选题方向：${variant}`}))).filter(item=>!usedTopicKeys.includes(item.key))
  if(!pool.length)return null
  const selected=pool[stableChoice(`${day}:${card.hash}`,pool.length)]!
  return selected
}
