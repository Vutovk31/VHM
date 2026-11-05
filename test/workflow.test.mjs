import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequest } from '../src/intake.mjs';
import { runStrictWorkflow } from '../src/workflow.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/vi.json', import.meta.url)));
const source = {text:'Бур Brand M1',brand:'Brand',model:'M1',category:'бур',quantity:2,unit:'шт',
  requirements:[{key:'mount',value:'SDS-plus'}]};
const snapshot = rows => normalizeRequest({requestId:'flow',policyVersion:policy.version,city:'Москва',rows});
const card = {siteProductId:'10',viCode:'20',title:'Бур Brand M1',brand:'Brand',model:'M1',category:'бур',
  url:'https://www.vseinstrumenti.ru/product/bur-10/',stage:'EXACT',
  checks:{mount:{status:'PASS',ref:'fixture#mount'}},verification:{source:'MCP_VERIFY',ref:'fixture#response'}};

test('hybrid recovers a strict item automatically, preserves duplicate rows and logs evidence', async () => {
  const order=[];
  const result=await runStrictWorkflow({policy,snapshot:snapshot([source,source]),route:'C',maxCallsPerRow:4,
    connectors:{
      searchMcp:async()=>{order.push('MCP');return [{siteProductId:'11'}];},
      searchWeb:async()=>{order.push('WEB');return [{url:card.url}];},
      verifyMcp:async({candidates})=>{
        order.push('VERIFY');
        return candidates[0].siteProductId==='11'?[{...card,siteProductId:'11',url:'https://www.vseinstrumenti.ru/product/bur-11/',model:'M2'}]:[card];
      },
    }});
  assert.equal(result.result.metrics.exact,2);
  assert.equal(result.result.metrics.reportedRows,2);
  assert.deepEqual(order,['MCP','VERIFY','WEB','VERIFY','MCP','VERIFY','WEB','VERIFY']);
  assert.ok(Object.values(result.evidence.rows).every(r=>r.attempts.length===4));
});

test('MCP rate limit blocks further calls across rows and leaves the full result explicit', async () => {
  let calls=0;
  const result=await runStrictWorkflow({policy,snapshot:snapshot([source,source]),route:'B',connectors:{
    searchMcp:async()=>{calls++;throw Object.assign(new Error('limited'),{code:'rate_limited'});},
  }});
  assert.equal(calls,1);
  assert.equal(result.result.rows.length,2);
  assert.ok(result.result.rows.every(r=>r.status!=='EXACT'));
  assert.ok(Object.values(result.evidence.rows).every(r=>r.attempts.some(a=>a.reason==='rate_limited')));
});

test('verification cannot substitute unrelated identifiers or accept unverified cards', async () => {
  const result=await runStrictWorkflow({policy,snapshot:snapshot([source]),route:'B',connectors:{
    searchMcp:async()=>[{siteProductId:'11'}],
    verifyMcp:async()=>[card],
  }});
  assert.equal(result.result.metrics.exact,0);
  assert.equal(Object.values(result.evidence.rows)[0].cards.length,0);
});

test('incomplete normalization returns a clarification without calling a provider', async () => {
  let calls=0;
  const result=await runStrictWorkflow({policy,snapshot:snapshot([{text:'оснастка',quantity:1,unit:'шт'}]),
    route:'C',connectors:{searchMcp:async()=>{calls++;return []}}});
  assert.equal(calls,0);
  assert.equal(result.result.rows[0].status,'CLARIFICATION_REQUIRED');
});

test('automatic category and identifier hints permit discovery while technical acceptance remains unresolved', async () => {
  const queries=[];
  const result=await runStrictWorkflow({policy,snapshot:snapshot([{text:'Бур Brand M1',quantity:1,unit:'шт'}]),
    route:'B',maxCallsPerRow:2,connectors:{
      searchMcp:async({query})=>{queries.push(query);return [{siteProductId:'10'}]},
      verifyMcp:async()=>[card],
    }});
  assert.ok(queries.length>0);
  assert.equal(result.result.rows[0].status,'CLARIFICATION_REQUIRED');
  assert.equal(result.result.metrics.exact,0);
  assert.equal(Object.values(result.evidence.rows)[0].cards.length,1);
});
