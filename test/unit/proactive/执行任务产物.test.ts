import { describe, expect, it } from "vitest"
import { validateWorkArtifact } from "@/services/user-tasks/work"
import type { PiSubAgentEvidence } from "@/services/engine/harness"
const now=Date.parse("2026-10-18T04:00:00Z")
const work={goal:"查询今天的新闻热点",inputs:[],capabilities:["search"],output:"三条热点附来源",completion:"取得本轮可核验来源"}
const artifact={text:"三条热点",completed:true,criterion:"取得本轮可核验来源",sources:[{url:"https://example.org/news",title:"新闻原文"}]}
const evidence:PiSubAgentEvidence={tools:[{toolName:"search",status:"done",sourceUrls:["https://example.org/news"],completedAt:now-1000}],incomplete:[],unconfirmedEffects:false}
describe("执行产物校验",()=>{
  it("来源须由真实回执支持，获取时间不能伪造为发布日期 [scheduled-artifact-provenance]",()=>{
    expect(validateWorkArtifact(artifact,{...work,goal:"整理资料"},evidence,now)).toEqual({text:"三条热点\n\n来源链接已于本轮获取，发布时间未核实。",completed:true,criterion:work.completion,
      sources:[{url:"https://example.org/news",title:"新闻原文",fetchedAt:now-1000,publicationDateVerified:false}]})
    expect(validateWorkArtifact({...artifact,sources:[{url:"https://fabricated.org/",title:"虚构来源"}]},work,evidence,now)).toBe("unverified_source")
    expect(validateWorkArtifact({...artifact,sources:[{...artifact.sources[0],publishedAt:"2026-10-18"}]},work,evidence,now)).toBe("unverified_source_date")
  })
  it("未完成、能力未用和过期回执不能包装为任务完成 [scheduled-artifact-failure]",()=>{
    expect(validateWorkArtifact({...artifact,completed:false},work,evidence,now)).toBe("completion_not_met")
    expect(validateWorkArtifact(artifact,work,{...evidence,tools:[]},now)).toBe("required_capability_not_used")
    expect(validateWorkArtifact(artifact,work,{...evidence,unconfirmedEffects:true},now)).toBe("incomplete_evidence")
    expect(validateWorkArtifact(artifact,work,{...evidence,tools:[{...evidence.tools[0],completedAt:now-3600_000}]},now)).toBe("required_capability_not_used")
  })
  it("今天新闻必须由工具回执证明当天发布，不能只凭本轮获取时间 [scheduled-artifact-news-freshness]",()=>{
    expect(validateWorkArtifact(artifact,work,evidence,now,"Asia/Shanghai")).toBe("freshness_unverified")
    const receipts={...evidence,tools:[{...evidence.tools[0],sources:[{url:"https://example.org/news",publishedAt:"2026-10-18T02:00:00Z"}]}]}
    expect(validateWorkArtifact(artifact,work,receipts,now,"Asia/Shanghai")).toEqual({text:"三条热点",completed:true,criterion:work.completion,
      sources:[{url:"https://example.org/news",title:"新闻原文",fetchedAt:now-1000,publishedAt:"2026-10-18T02:00:00Z",publicationDateVerified:true}]})
    expect(validateWorkArtifact(artifact,work,{...evidence,tools:[{...evidence.tools[0],sources:[{url:"https://example.org/news",publishedAt:"2026-10-17T02:00:00Z"}]}]},now,"Asia/Shanghai")).toBe("freshness_unverified")
  })
})
