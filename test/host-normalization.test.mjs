import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRequest} from '../src/intake.mjs';
import {buildInterpretationRequest,applyInterpretation} from '../src/host-normalization.mjs';

function setup(text='Молоток кованый 800 г') {
 const snapshot=normalizeRequest({requestId:'r',policyVersion:'1.1.0',rows:[{text,quantity:2,unit:'шт'}]});
 const request=buildInterpretationRequest(snapshot);
 const source=(value)=>({field:'text',start:text.indexOf(value),end:text.indexOf(value)+value.length,text:value});
 const response={requestId:'r',actor:'codex-host',rows:[{
  key:request.rows[0].key,sourceDigest:request.rows[0].sourceDigest,mode:'OPEN',category:'молоток',
  requirements:[
   {key:'forged',value:'Кованый',field:'Кованый',test:{kind:'boolean',expected:true}},
   {key:'weight',value:'800 г',field:'Вес бойка',test:{kind:'number',expected:800,unit:'г'}},
  ],
  claims:[
   {role:'CATEGORY',source:source('Молоток')},
   {role:'REQUIREMENT',keys:['forged'],source:source('кованый')},
   {role:'REQUIREMENT',keys:['weight'],source:source('800 г')},
  ],
 }]};
 return {snapshot,request,response};
}
test('grounded host interpretation preserves the raw request and binds every technical test',()=>{
 const {snapshot,request,response}=setup();
 const original=JSON.stringify(snapshot);
 const result=applyInterpretation(snapshot,response,request);
 assert.equal(result.rows[0].interpretation.complete,true);
 assert.equal(result.rows[0].interpretation.mode,'OPEN');
 assert.equal(result.rows[0].requirements[1].sources[0].text,'800 г');
 assert.equal(JSON.stringify(snapshot),original);
 assert.deepEqual(result.rows[0].original,snapshot.rows[0].original);
});
test('uncovered technical text cannot silently become a complete interpretation',()=>{
 const {snapshot,request,response}=setup('Молоток кованый 800 г диэлектрический');
 response.rows[0].question='Уточните требования к изоляции молотка';
 const result=applyInterpretation(snapshot,response,request);
 assert.equal(result.rows[0].interpretation.complete,false);
 assert.equal(result.rows[0].interpretation.mode,'CLARIFY');
 assert.match(result.rows[0].interpretation.question,/изоляции/);
});
test('rejects changed sources, omitted rows, forged spans and technical words discarded as syntax',()=>{
 const {snapshot,request,response}=setup();
 const changed=structuredClone(snapshot);
 changed.rows[0].original.quantity=3;
 assert.throws(()=>applyInterpretation(changed,response,request),/stale/);
 assert.throws(()=>applyInterpretation(snapshot,{...response,rows:[]},request),/envelope/);
 const forged=structuredClone(response);
 forged.rows[0].claims[0].source.text='Кувалда';
 assert.throws(()=>applyInterpretation(snapshot,forged,request),/source span/);
 const discarded=structuredClone(response);
 discarded.rows[0].claims[1].role='SYNTAX';
 assert.throws(()=>applyInterpretation(snapshot,discarded,request),/discarded/);
});

test('an explicit clarification gate cannot be cleared by a complete host disposition',()=>{
 const {snapshot,response}=setup();
 snapshot.rows[0].original.kind='CLARIFY';
 const request=buildInterpretationRequest(snapshot);
 response.rows[0].sourceDigest=request.rows[0].sourceDigest;
 response.rows[0].question='Подтвердите исходное условие допуска';
 const result=applyInterpretation(snapshot,response,request);
 assert.equal(result.rows[0].interpretation.mode,'CLARIFY');
});
