import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequest } from '../src/intake.mjs';
import { runStrictWorkflow, runAnalogWorkflow } from '../src/workflow.mjs';

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
  assert.equal(result.execution.limits.maxCallsPerRow,4);
  assert.deepEqual(result.execution.rowTimings.map(r=>r.key),result.result.rows.map(r=>r.key));
  assert.deepEqual(result.execution.rowTimings.map(r=>r.calls),[4,4]);
  assert.ok(result.execution.elapsedMs >= result.execution.rowTimings.reduce((sum,r)=>sum+r.elapsedMs,0));
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
  assert.deepEqual(result.result.approvalNeeded,[]);
  assert.deepEqual(result.result.strictRetryNeeded,result.result.rows.map(r=>r.key));
});

test('a row deadline does not disable MCP for subsequent rows', async () => {
  let searches = 0;
  const run = await runStrictWorkflow({
    policy, snapshot: snapshot([source, source]), route: 'B', maxCallsPerRow: 2,
    connectors: {
      searchMcp: async () => {
        if (++searches === 1) throw new DOMException('Row timed out', 'TimeoutError');
        return [{siteProductId:'10'}];
      },
      verifyMcp: async () => [card],
    },
  });
  assert.equal(run.result.rows[0].attempts[0].reason, 'DEADLINE');
  assert.equal(run.result.rows[1].status, 'EXACT');
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
  assert.deepEqual(result.execution.rowTimings,[]);
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

test('typed requirements are rechecked against raw characteristics before Matcher acceptance', async () => {
  const row={...source,requirements:[{key:'capacity',value:'4 Ач',field:'Емкость',
    test:{kind:'number',expected:4,unit:'Ач'}}]};
  for (const [actual,exact] of [['2.0',0],['4.0',1]]) {
    const result=await runStrictWorkflow({policy,snapshot:snapshot([row]),route:'B',maxCallsPerRow:2,connectors:{
      searchMcp:async()=>[{siteProductId:'10'}],
      verifyMcp:async()=>[{...card,checks:{capacity:{status:'PASS',ref:'untrusted-precomputed'}},
        characteristics:[{name:'Емкость',value:actual,unit:'А*ч'}]}],
    }});
    assert.equal(result.result.metrics.exact,exact);
    const checked=Object.values(result.evidence.rows)[0].cards[0].checks.capacity;
    assert.equal(checked.ref,'fixture#response');
    assert.equal(checked.status,exact?'PASS':'FAIL');
  }
});

test('analog workflow uses scoped approval, preserves strict evidence and never approves a replacement', async () => {
  const strict=await runStrictWorkflow({policy,snapshot:snapshot([source,source]),route:'B',
    connectors:{searchMcp:async()=>[]}});
  const original=JSON.stringify(strict.evidence);
  const key=strict.intake.rows[0].key;
  const permission={requestId:strict.result.requestId,strictDigest:strict.digest,by:'manager',
    at:'2026-11-05T12:00:00Z',decision:'ALLOW_ANALOG_DISCOVERY',keys:[key]};
  let calls=0;
  const run=await runAnalogWorkflow({policy,strictRun:strict,permission,connectors:{
    searchMcp:async({query})=>{calls++;assert.equal(query,'бур SDS-plus');return [{siteProductId:'20'}]},
    verifyMcp:async()=>[{...card,siteProductId:'20',url:'https://www.vseinstrumenti.ru/product/bur-20/',
      brand:'Other',model:'M2',differences:'Другой бренд и модель, посадка подтверждена'}],
  }});
  assert.equal(calls,1);
  assert.equal(run.phase,'ANALOG_PROPOSALS_COMPLETE');
  assert.equal(run.result.rows[0].status,'ANALOG_PROPOSED');
  assert.equal(run.result.rows[0].approval,'PENDING');
  assert.equal(run.result.rows[1].status,'NOT_FOUND');
  assert.equal(run.result.procurement.length,0);
  assert.equal(JSON.stringify(strict.evidence),original);
  assert.equal(run.evidence.rows[key].attempts.at(-1).phase,'ANALOG');
});

test('stale permissions, resolved rows and technical mismatches cannot authorize analog acceptance', async () => {
  const strict=await runStrictWorkflow({policy,snapshot:snapshot([source]),route:'B',
    connectors:{searchMcp:async()=>[]}});
  const permission={requestId:strict.result.requestId,strictDigest:strict.digest,by:'manager',
    at:'2026-11-05T12:00:00Z',decision:'ALLOW_ANALOG_DISCOVERY',keys:[strict.intake.rows[0].key]};
  await assert.rejects(()=>runAnalogWorkflow({policy,strictRun:strict,permission:{...permission,strictDigest:'bad'}}),/permission/);
  let calls=0;
  const closed=await runAnalogWorkflow({policy,strictRun:strict,permission:{...permission,decision:'STRICT_ONLY'},
    connectors:{searchMcp:async()=>{calls++;return []}}});
  assert.equal(closed.phase,'STRICT_CLOSED');
  assert.equal(calls,0);
  const mismatch=await runAnalogWorkflow({policy,strictRun:strict,permission,connectors:{
    searchMcp:async()=>[{siteProductId:'20'}],
    verifyMcp:async()=>[{...card,siteProductId:'20',url:'https://www.vseinstrumenti.ru/product/bur-20/',
      model:'M2',differences:'Другая посадка',checks:{mount:{status:'FAIL',ref:'fixture#mount'}}}],
  }});
  assert.notEqual(mismatch.result.rows[0].status,'ANALOG_PROPOSED');
  const resolved=await runStrictWorkflow({policy,snapshot:snapshot([source]),route:'B',connectors:{
    searchMcp:async()=>[{siteProductId:'10'}],verifyMcp:async()=>[card],
  }});
  await assert.rejects(()=>runAnalogWorkflow({policy,strictRun:resolved,permission:{
    ...permission,strictDigest:resolved.digest,keys:[resolved.intake.rows[0].key]}}),/permission/);
});

test('only explicitly replaceable typed criteria can become a disclosed analog deviation', async () => {
  for (const replaceable of [false,true]) {
    const row={...source,requirements:[{key:'length',value:'Длина 125 мм',field:'Длина',
      test:{kind:'number',expected:125,unit:'мм'},replaceable}]};
    const strict=await runStrictWorkflow({policy,snapshot:snapshot([row]),route:'B',
      connectors:{searchMcp:async()=>[]}});
    const permission={requestId:strict.result.requestId,strictDigest:strict.digest,by:'manager',
      at:'2026-11-05T12:00:00Z',decision:'ALLOW_ANALOG_DISCOVERY',keys:[strict.intake.rows[0].key]};
    const run=await runAnalogWorkflow({policy,strictRun:strict,permission,connectors:{
      searchMcp:async()=>[{siteProductId:'20'}],
      verifyMcp:async()=>[{...card,siteProductId:'20',model:'M2',
        url:'https://www.vseinstrumenti.ru/product/bur-20/',
        characteristics:[{name:'Длина',value:'150',unit:'мм'}]}],
    }});
    assert.equal(run.result.rows[0].status==='ANALOG_PROPOSED',replaceable);
    assert.equal(run.result.rows[0].approval,replaceable?'PENDING':'NOT_REQUIRED');
    if (replaceable) assert.match(run.result.rows[0].card.differences,/Длина.*125.*150/u);
  }
});
