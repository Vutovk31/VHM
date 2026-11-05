import test from 'node:test';
import assert from 'node:assert/strict';
import {createViConnectors} from '../src/vi-connectors.mjs';
const session={summaryAccepted:true,instructionsVersion:'1.7.0'};
test('VI adapter persists raw evidence before exposing verified fields and keeps unknown supply explicit',async()=>{
 const saved=[], calls=[];
 const connectors=createViConnectors({session,persist:async record=>{saved.push(record);return 'evidence#'+saved.length},
   invoke:async(method,args)=>{
     calls.push([method,args]);
     return {structuredContent:method==='search_products'?{products:[{id:'10'}]}:{
       products:[{id:'10',name:'Аккумулятор Makita BL1860B',sku:'20',
       url:'https://www.vseinstrumenti.ru/product/akb-10/',availability:'in_stock',price:1000,
       characteristics:[{name:'Напряжение',value:'18',unit:'В'}]}]}};
   }});
 const candidates=await connectors.searchMcp({query:'Makita BL1860B',limit:4});
 const [card]=await connectors.verifyMcp({candidates,requirements:[
   {key:'voltage',field:'Напряжение',test:{kind:'number',expected:18,unit:'В'}}]});
 assert.equal(card.verification.ref,'evidence#2');
 assert.equal(card.checks.voltage.status,'PASS');
 assert.equal(card.stock.city,'Москва');
 assert.equal(card.delivery,undefined);
 assert.equal(card.price,undefined);
 assert.equal(card.observedPrice.amount,1000);
 assert.deepEqual(calls.map(x=>x[0]),['search_products','get_products']);
});
test('provider errors retain evidence and stable codes, invalid locators fail before invocation',async()=>{
 const saved=[];
 let calls=0;
 const connectors=createViConnectors({session,persist:async record=>{saved.push(record);return 'ref'},
   invoke:async()=>{calls++;return {isError:true,content:[{type:'text',text:'{"code":"rate_limited","retry_after_seconds":5}'}]}}});
 await assert.rejects(()=>connectors.searchMcp({query:'бур'}),e=>e.code==='rate_limited'&&e.evidenceRef==='ref');
 await assert.rejects(()=>connectors.verifyMcp({candidates:[{url:'https://evil.example/product/10/'}]}),/Untrusted/);
 assert.equal(calls,1);
 assert.equal(saved[0].error,true);
});
