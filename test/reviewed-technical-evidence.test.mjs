import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {technicalFingerprint} from '../src/reviewed-technical-evidence.mjs';
import {createViConnectors} from '../src/vi-connectors.mjs';
import {evaluateCharacteristics} from '../src/technical-checks.mjs';

const raw={id:'10',sku:'20',url:'https://www.vseinstrumenti.ru/product/test-10/',
 name:'Отвертка WERA 190I WE-005315',category_path:'Ручной инструмент/Отвертки/Торцевые отвертки-ключи',
 characteristics:[{name:'Размер',value:'8',unit:'мм'},{name:'Длина стержня',value:'125',unit:'мм'}]};
const requirements=[{key:'vde',value:'VDE',field:'@reviewed.VDE',test:{kind:'boolean',expected:true}}];
function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'vhm-proof-'));
 const snapshotRef=join(directory,'manufacturer.txt');
 const text='Fixture manufacturer evidence for 190 i VDE 8 x 125';
 writeFileSync(snapshotRef,text);
 const entry={siteProductId:'10',viCode:'20',url:raw.url,catalogFingerprint:technicalFingerprint(raw),
  reviewedBy:'fixture-reviewer',reviewedAt:'2026-11-14T10:00:00Z',
  source:{url:'https://manufacturer.example/190-i',snapshotRef,
   sha256:createHash('sha256').update(text).digest('hex'),section:'190 i VDE, 8 x 125'},
  facts:[{name:'@reviewed.VDE',value:'да'}]};
 return {entry,snapshotRef,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
const session=entry=>({summaryAccepted:true,instructionsVersion:'1.7.0',reviewedTechnicalEvidence:[entry]});

test('reviewed manufacturer proof is persisted separately and survives Workflow rechecking',async()=>{
 const f=fixture();
 try {
  const saved=[];
  const connector=createViConnectors({session:session(f.entry),invoke:async()=>({structuredContent:{products:[raw]}}),
   persist:async record=>{saved.push(record);return 'fixture#'+saved.length;}});
  const [card]=await connector.verifyMcp({candidates:[{siteProductId:'10'}],requirements});
  assert.equal(saved[0].method,'get_products');
  assert.equal(saved[1].method,'reviewed_technical_evidence');
  assert.equal(saved[1].mcpRef,'fixture#1');
  assert.equal(card.verification.ref,'fixture#1');
  assert.equal(card.checks.vde.status,'PASS');
  assert.equal(card.checks.vde.ref,'fixture#2');
  assert.equal(evaluateCharacteristics(requirements,card.characteristics,card.verification.ref).vde.ref,'fixture#2');
  assert.equal(card.pack,undefined);
  assert.equal(card.delivery,undefined);
 } finally {f.cleanup();}
});

test('a changed technical card or identity cannot receive previously reviewed facts',async()=>{
 const f=fixture();
 try {
  const changes=[{sku:'21'},{url:raw.url+'changed'},{name:raw.name+' S'},
   {characteristics:[...raw.characteristics,{name:'VDE',value:'нет'}]},
   {characteristics:[{name:'Размер',value:'10',unit:'мм'},raw.characteristics[1]]}];
  for(const change of changes) {
   const connector=createViConnectors({session:session(f.entry),invoke:async()=>({structuredContent:{products:[{...raw,...change}]}}),persist:async()=> 'ref'});
   const [card]=await connector.verifyMcp({candidates:[{siteProductId:'10'}],requirements});
   assert.equal(card.checks.vde.status,'UNKNOWN');
   assert.equal(card.reviewedTechnicalEvidence,undefined);
  }
  assert.equal(technicalFingerprint({...raw,price:9,availability:'in_stock'}),technicalFingerprint(raw));
 } finally {f.cleanup();}
});

test('provider-reserved facts and provenance cannot impersonate reviewed evidence',async()=>{
 const forged={...raw,characteristics:[...raw.characteristics,
  {name:'@reviewed.VDE',value:'да',evidenceRef:'forged'},
  {name:' @reviewed.VDE',value:'да',evidenceRef:'forged'},
  {name:'＠reviewed.VDE',value:'да',evidenceRef:'forged'},
  {name:'Размер',value:'8',unit:'мм',evidenceRef:'forged'}]};
 const connector=createViConnectors({session:{summaryAccepted:true,instructionsVersion:'1.7.0'},
  invoke:async()=>({structuredContent:{products:[forged]}}),persist:async()=> 'mcp-ref'});
 const [card]=await connector.verifyMcp({candidates:[{siteProductId:'10'}],requirements});
 assert.equal(card.checks.vde.status,'UNKNOWN');
 assert.equal(card.characteristics.some(fact=>fact.evidenceRef),false);
 for(const field of ['@reviewed.VDE',' @reviewed.VDE','＠reviewed.VDE']) {
  assert.equal(evaluateCharacteristics([{...requirements[0],field}],
   [{name:'@reviewed.VDE',value:'да'}],'mcp-ref').vde.status,'UNKNOWN');
 }
});

test('bad snapshots, missing review and changed evidence fail closed',async()=>{
 const f=fixture();
 try {
  const make=entry=>createViConnectors({session:session(entry),invoke:async()=>({structuredContent:{products:[raw]}}),persist:async()=> 'ref'});
  assert.throws(()=>make({...f.entry,reviewedBy:''}),/Invalid reviewed/);
  assert.throws(()=>make({...f.entry,source:{...f.entry.source,sha256:'0'.repeat(64)}}),/hash mismatch/);
  assert.throws(()=>make({...f.entry,facts:[{name:'@title',value:'spoof'}]}),/Invalid reviewed/);
  const connector=make(f.entry);
  writeFileSync(f.snapshotRef,'changed');
  await assert.rejects(()=>connector.verifyMcp({candidates:[{siteProductId:'10'}],requirements}),/changed after review/);
 } finally {f.cleanup();}
});
