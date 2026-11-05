import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {match} from './matcher.mjs';
import {matcherRow} from './workflow.mjs';
import {projectVerifiedProduct} from './vi-connectors.mjs';

/** Rechecks archived candidates only. This function performs no discovery or provider calls. */
export function replayAcceptance({policy,snapshot,route,candidates}) {
  if (!['A','B','C'].includes(route) || !candidates || typeof candidates !== 'object') {
    throw new Error('Archived route and candidates are required');
  }
  const intake={...snapshot,rows:snapshot.rows.map(matcherRow)};
  const keys=new Set(intake.rows.map(row=>row.key));
  if (Object.keys(candidates).some(key=>!keys.has(key))) throw new Error('Unknown archived row key');
  const evidence={requestId:intake.requestId,policyVersion:intake.policyVersion,route,
    mode:'ARCHIVED_ACCEPTANCE_REPLAY',rows:Object.create(null)};
  const references=new Set();
  for (const row of intake.rows) {
    const records=candidates[row.key]??[];
    if (!Array.isArray(records)) throw new Error('Archived row candidates must be an array');
    const cards=records.map(record=>{
      if (typeof record.ref!=='string'||!record.ref.trim()||typeof record.verified!=='boolean') {
        throw new Error('Archived provenance is required');
      }
      references.add(record.ref);
      if (record.verified) return projectVerifiedProduct(record.raw,row.requirements,record.ref,record.observedAt??null);
      return {siteProductId:record.raw?.id,title:record.raw?.name,url:record.raw?.url};
    });
    evidence.rows[row.key]={cards,attempts:[{channel:route,outcome:cards.length?'RESULT':'MISS',
      phase:'ARCHIVED_ACCEPTANCE_REPLAY',ids:cards.map(card=>card.siteProductId).filter(Boolean)}]};
  }
  return {mode:'ARCHIVED_ACCEPTANCE_REPLAY',route,sourceReferences:[...references].sort(),
    result:match(policy,intake,evidence),evidence};
}
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [input,output]=process.argv.slice(2);
  if(!input||!output)throw new Error('Usage: node src/replay-acceptance.mjs input.json output.json');
  const payload=JSON.parse(readFileSync(input,'utf8').replace(/^\uFEFF/u,''));
  writeFileSync(output,JSON.stringify(replayAcceptance(payload),null,2),{flag:'wx'});
}
