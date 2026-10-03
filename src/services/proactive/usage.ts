/** Unknown usage stays unknown; an estimate never becomes an actual Provider receipt. */
export function accountedUsage(value:{inputTokens?:number;outputTokens?:number;cacheRead?:number;cacheWrite?:number}|null|undefined):Record<string,number>|null {
  if(!value||typeof value.inputTokens!=="number"||typeof value.outputTokens!=="number")return null
  const numbers=[value.inputTokens,value.outputTokens,value.cacheRead??0,value.cacheWrite??0]
  if(numbers.some(token=>!Number.isFinite(token)||token<0))return null
  return {inputTokens:value.inputTokens,outputTokens:value.outputTokens,cacheRead:value.cacheRead??0,cacheWrite:value.cacheWrite??0,
    totalTokens:numbers.reduce((sum,token)=>sum+token,0)}
}
