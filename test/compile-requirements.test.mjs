import {readFileSync} from 'node:fs';
import {runStrictWorkflow} from '../src/workflow.mjs';
import {createViConnectors} from '../src/vi-connectors.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTechnicalRequirements } from '../src/compile-requirements.mjs';
import { normalizeRequest } from '../src/intake.mjs';

test('complete battery text produces source-grounded typed requirements automatically',()=>{
 const source={text:'Аккумулятор L1840S 18В, 4Ач, Li-Ion 4935478636 AEG',quantity:3,unit:'шт'};
 const result=compileTechnicalRequirements(source);
 assert.equal(result.complete,true);
 assert.equal(result.brand,'AEG');
 assert.deepEqual(result.requirements.map(r=>r.key),['not-set','not-kit','identity-0','identity-1','voltage','capacity','chemistry']);
 for(const requirement of result.requirements){
  const {start,end,text}=requirement.source;
  assert.equal(source.text.slice(start,end),text);
 }
 const row=normalizeRequest({requestId:'r',policyVersion:'1.1.0',rows:[source]}).rows[0];
 assert.equal(row.product.category,'АКБ');
 assert.equal(row.requirements.length,7);
 assert.equal(row.original.text,source.text);
});

test('platform and charge indicator stay required, unknown or negated clauses block automatic completeness',()=>{
 const source={text:'Аккумулятор BL1860B 6 Ач, индикатор заряда для LXT 18В Makita 632F69-8'};
 const result=compileTechnicalRequirements(source);
 assert.equal(result.complete,true);
 assert.ok(result.requirements.some(r=>r.key==='indicator'&&r.test.expected===true));
 assert.ok(result.requirements.some(r=>r.key==='platform'&&r.test.expected==='LXT'));
 for(const extra of [' без индикатора',' для другой платформы',' комплект 2 шт',' -',' не Li-Ion']){
  assert.equal(compileTechnicalRequirements({text:source.text+extra}).complete,false,extra);
 }
 assert.equal(compileTechnicalRequirements({...source,notes:['Требуется отдельный сертификат']}).complete,false);
 assert.equal(compileTechnicalRequirements({...source,brand:'AEG'}).complete,false);
});

test('explicitly provided requirements preserve the caller contract',()=>{
 const source={text:'Аккумулятор L1840S 18В, 4Ач, Li-Ion 4935478636 AEG',requirements:[]};
 const row=normalizeRequest({requestId:'r',policyVersion:'1.1.0',rows:[source]}).rows[0];
 assert.deepEqual(row.requirements,[]);
 assert.equal(row.compilation,null);
});

test('raw battery text reaches Matcher through the real adapter contract; a kit is rejected',async()=>{
 const source={text:'Аккумулятор L1840S 18В, 4Ач, Li-Ion 4935478636 AEG',quantity:3,unit:'шт'};
 const policy=JSON.parse(readFileSync(new URL('../policy/vi.json',import.meta.url),'utf8'));
 const snapshot=normalizeRequest({requestId:'r',policyVersion:policy.version,rows:[source]});
 for (const kit of [false,true]) {
  const connectors=createViConnectors({session:{summaryAccepted:true,instructionsVersion:'fixture'},
   persist:async()=> 'fixture#response',
   invoke:async method=>({structuredContent:method==='search_products'?{products:[{id:'10'}]}:{products:[{
     id:'10',sku:'20',url:'https://www.vseinstrumenti.ru/product/battery-10/',
     name:(kit?'Набор ':'')+'Аккумулятор L1840S 18В, 4Ач, Li-Ion 4935478636 AEG',
     characteristics:[{name:'Напряжение',value:'18',unit:'В'},
       {name:'Емкость аккумулятора',value:'4.0',unit:'А*ч'},{name:'Тип аккумулятора',value:'Li-Ion'}],
   }]}})});
  const run=await runStrictWorkflow({snapshot,policy,route:'B',maxCallsPerRow:2,connectors});
  assert.equal(run.result.metrics.exact,kit?0:1);
  assert.equal(run.result.rows[0].sourceQuantity,3);
 }
});
