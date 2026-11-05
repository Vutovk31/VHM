import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeRequest} from '../src/intake.mjs';
import {replayAcceptance} from '../src/replay-acceptance.mjs';
const policy=JSON.parse(readFileSync(new URL('../policy/vi.json',import.meta.url),'utf8'));
test('archived acceptance preserves provenance and requires actual verified records',()=>{
 const snapshot=normalizeRequest({requestId:'r',policyVersion:policy.version,rows:[{
  text:'Молоток',category:'молоток',quantity:2,unit:'шт',
  requirements:[{key:'weight',value:'800 г',field:'Вес бойка',test:{kind:'number',expected:800,unit:'г'}}],
 }]});
 const key=snapshot.rows[0].key;
 const record={verified:true,ref:'archive/10.json',raw:{id:'10',name:'Молоток Inforce 800 г',
  url:'https://www.vseinstrumenti.ru/product/molotok-10/',characteristics:[{name:'Вес бойка',value:'800',unit:'г'}]}};
 const run=replayAcceptance({policy,snapshot,route:'A',candidates:{[key]:[record]}});
 assert.equal(run.mode,'ARCHIVED_ACCEPTANCE_REPLAY');
 assert.deepEqual(run.sourceReferences,['archive/10.json']);
 assert.equal(run.result.rows[0].status,'EXACT');
 assert.equal(run.result.rows[0].sourceQuantity,2);
 assert.equal(run.result.rows[0].quantity,null);
 const unverified=replayAcceptance({policy,snapshot,route:'A',candidates:{[key]:[{...record,verified:false}]}});
 assert.notEqual(unverified.result.rows[0].status,'EXACT');
 assert.throws(()=>replayAcceptance({policy,snapshot,route:'B',candidates:{bad:[record]}}),/Unknown/);
});
