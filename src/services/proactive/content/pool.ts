import type { PersonalityCard } from "@/services/personality"
import { getTopicWeights } from "@/services/observation"
import type { BehaviorSnapshot } from "@/services/behavior"
import type { ProactiveOwner, ProactiveSourceRef } from "../protocol"
import { source } from "../opportunities"
import { stableChoice } from "../time"

/** Role anecdotes are fictional Card narrative; app categories supply topics, never claims of user preference. */
export function contentPool(card:PersonalityCard,behavior:BehaviorSnapshot,owner:ProactiveOwner,day:string,usedTopicKeys:readonly string[]=[]) {
  type Choice={key:string;context:string;source:ProactiveSourceRef;targets:Array<{id:string;version:number}>}
  const cardSource=source("card",card.id,card.version,card.hash,owner)
  // Rotate the conceptual topic, not merely the day identity; persisted topicKey rejects 30-day repetition.
  const variations=["一个小观察","一个开放问题","一段角色小日常","一种相关方法","一个有趣概念","一个生活灵感",
    "一个轻松比喻","一段虚构散步","一个创造小练习","一个不同视角","一句温和邀请","一个审美观察","一个记忆中的细节","一段角色独白",
    "一件适合分享的小事","一个小故事开头","一个常识背后的缘由","一种放松方式","一个想象场景","一个小小好奇",
    "一段角色童年趣事","一个角色习惯","一种天气意象","一个音乐话题","一个书中主题","一个电影话题","一段日常灵感",
    "一件角色希望尝试的小事","一个故事里的选择","一个语言小发现","一种安排节奏的方法","一个手作想法"]
  const topics=getTopicWeights(card.id).filter(item=>item.topic.trim()&&Number.isFinite(item.weight)&&item.weight>0)
  const weightedPool=topics.flatMap(item=>variations.map(variant=>({item,variant,key:`topic:${item.topic}:${variant}`})))
    .filter(candidate=>!usedTopicKeys.includes(candidate.key))
  const randomChoice=(seed:string):Choice=>{
    const variant=variations[stableChoice(seed,variations.length)]!
    return {key:`role:${card.hash}:${variant}`,context:`角色设定作为虚构叙事依据：${card.sections.roleSetting}\n分享符合角色的小日常或有趣知识。内容自足，不声称操作过现实文件、桌面或外部应用；不伪造当前新闻。\n选题方向：${variant}`,source:cardSource,targets:[]}
  }
  let selected:Choice
  if(weightedPool.length&&stableChoice(`${day}:${card.hash}:topic-branch`,100)<80) {
    const total=weightedPool.reduce((sum,candidate)=>sum+candidate.item.weight/variations.length,0)
    const point=(stableChoice(`${day}:${card.hash}:topic-weight`,1_000_000)/1_000_000)*total
    let cumulative=0
    const candidate=weightedPool.find(item=>{cumulative+=item.item.weight/variations.length;return point<cumulative})??weightedPool[weightedPool.length-1]!
    const {item:topic,variant}=candidate
    selected={key:`topic:${topic.topic}:${variant}`,context:`分享一个围绕「${topic.topic}」的轻松话题。只把它当作讨论选材方向，不说这是用户的固定偏好，也不提取或补写个人事实。\n原讨论立场：${topic.stances.join("、")}；保留否定、中立、引用和假设语境，不能改写成喜爱或认可，负面话题避免热情推介。\n选题方向：${variant}`,
      source:source("behavior",`topic:${topic.topic}`,behavior.revision,`${behavior.revision}:${topic.topic}`,owner),targets:[]}
  } else {
    const available=variations.filter(variant=>!usedTopicKeys.includes(`role:${card.hash}:${variant}`))
    if(!available.length)return null
    selected=randomChoice(`${day}:${card.hash}:pure-random:${available[stableChoice(`${day}:${card.hash}:pure-random-choice`,available.length)]}`)
  }
  return selected
}
