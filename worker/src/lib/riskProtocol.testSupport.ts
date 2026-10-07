// Synthetic contract fixtures only; never evidence of production admission.
import { HMM_INPUT_CONTRACT } from './marketRiskRuntime'
import { canonicalRiskJson } from './riskPacketCodec'
import { createHash } from 'node:crypto'
export const fixtureProvenance=(date:string,qualityChecksum?:string,inferenceAsOf?:string)=>({inference_as_of:inferenceAsOf??date+'T14:00:00Z',risk_quality_checksum:qualityChecksum??fixtureQuality(date,10).checksum,input_contract:HMM_INPUT_CONTRACT,input_checksum:'a'.repeat(64),feature_date:date,
 model:{sha256:'b'.repeat(64),generation:'1',trained_at:date+'T00:00:00Z',input_contract:HMM_INPUT_CONTRACT}})
export const fixtureQuality=(date:string,score:number,currentClose=30000,previousClose=30000,previousDate?:string)=>{
 const days:string[]=[];for(let ms=Date.parse(date+'T00:00:00Z');days.length<21;ms-=86400000)if(![0,6].includes(new Date(ms).getUTCDay()))days.unshift(new Date(ms).toISOString().slice(0,10))
 if(previousDate)days[19]=previousDate
 const sessions=days.map((day,i)=>({date:day,close:i===20?currentClose:previousClose,source:'finlab.taiex_total_index'}))
 const content={schema_version:'market-risk-quality-v1',date,status:'complete',known_score:score,upper_score:score,missing:[],critical_missing:[],sources:{benchmark:{source:'finlab.taiex_total_index',sessions}}}
 const json=canonicalRiskJson(content)
 return {...content,json,checksum:createHash('sha256').update(json).digest('hex')}
}
export function verifiedFixture(input:any){
 const rows=[...input.marketRiskRows].sort((a,b)=>String(b.date).localeCompare(String(a.date))),latest=rows[0]
 const quality=latest?fixtureQuality(latest.date,latest.risk_score,latest.twii_close,rows[1]?.twii_close,rows[1]?.date):null
 return {quality,...input,
  regimeState:input.regimeState?{...input.regimeState,regime_evidence:{...input.regimeState.regime_evidence,hmm_provenance:fixtureProvenance(input.regimeState.run_date,input.quality?.checksum??quality?.checksum,input.regimeState.computed_at)}}:null}
}
