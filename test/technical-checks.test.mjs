import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCharacteristics } from '../src/technical-checks.mjs';
const req=(key,field,kind,expected,unit)=>({key,field,test:{kind,expected,unit}});
test('typed capacity handles literal separators and equivalent numeric units',()=>{
 const result=evaluateCharacteristics([
   req('capacity','Емкость','number',4,'А·ч'),req('length','Длина','number',1,'м'),
   req('hinge','Шарнир','boolean',true),
 ],[{name:'Емкость',value:'4.0',unit:'А*ч'},{name:'Длина',value:'1000',unit:'мм'},{name:'Шарнир',value:'есть'}],'response#10');
 assert.deepEqual(Object.values(result).map(x=>x.status),['PASS','PASS','PASS']);
 assert.equal(result.capacity.ref,'response#10');
});
test('missing, incompatible, contradictory or imprecise fields never pass',()=>{
 const requirement=[req('length','Длина','number',125,'мм')];
 for(const facts of [
   [],[{name:'Длина',value:'125',unit:'В'}],[{name:'Длина',value:'около 125',unit:'мм'}],
   [{name:'Длина',value:'125',unit:'мм'},{name:'Длина',value:'250',unit:'мм'}],
 ]) assert.equal(evaluateCharacteristics(requirement,facts,'response').length.status,'UNKNOWN');
 assert.equal(evaluateCharacteristics(requirement,[{name:'Длина',value:'124.9',unit:'мм'}],'response').length.status,'FAIL');
});
test('unstructured legacy requirements remain unknown and malformed structured tests fail',()=>{
 assert.equal(evaluateCharacteristics([{key:'x',value:'проверьте'}],[],'ref').x.status,'UNKNOWN');
 assert.throws(()=>evaluateCharacteristics([req('x','Длина','number','1','м')],[],'ref'),/Numeric/);
 assert.throws(()=>evaluateCharacteristics([req('x','Шарнир','boolean','да')],[],'ref'),/Boolean/);
});

test('identity tokens preserve model suffix boundaries and reject substring false friends',()=>{
 const requirement=[req('model','@title','token','DTW285Z')];
 assert.equal(evaluateCharacteristics(requirement,[{name:'@title',value:'Гайковерт Makita DTW285Z'}],'ref').model.status,'PASS');
 assert.equal(evaluateCharacteristics(requirement,[{name:'@title',value:'Гайковерт Makita DTW285ZRTJ'}],'ref').model.status,'FAIL');
 assert.equal(evaluateCharacteristics(requirement,[{name:'@title',value:'Гайковерт Makita XDTW285Z'}],'ref').model.status,'FAIL');
 assert.equal(evaluateCharacteristics(requirement,[{name:'@title',value:'Гайковерт Makita DTW285Z-RTJ'}],'ref').model.status,'FAIL');
});

test('explicit field units are usable and a conflicting unit label stays unknown',()=>{
 const requirements=[req('size','Размер min (мм)','number',7,'мм')];
 assert.equal(evaluateCharacteristics(requirements,[{name:'Размер min (мм)',value:'7'}],'ref').size.status,'PASS');
 assert.equal(evaluateCharacteristics(requirements,[{name:'Размер min (мм)',value:'0.7',unit:'см'}],'ref').size.status,'UNKNOWN');
});

test('declared semantic aliases and source model spacing do not permit suffix changes',()=>{
 const requirements=[req('shape','Форма','oneOf',['Г-образный','угловой']),
   req('model','@title','modelToken','BEWS18-125BL LI-502C')];
 const pass=evaluateCharacteristics(requirements,[{name:'Форма',value:'угловой'},
   {name:'@title',value:'AEG BEWS18-125BLLI-502C 4935464417'}],'ref');
 assert.equal(pass.shape.status,'PASS');
 assert.equal(pass.model.status,'PASS');
 const fail=evaluateCharacteristics(requirements,[{name:'Форма',value:'прямой'},
   {name:'@title',value:'AEG BEWS18-125BLLI-502C-X'}],'ref');
 assert.equal(fail.shape.status,'FAIL');
 assert.equal(fail.model.status,'FAIL');
 const material=evaluateCharacteristics([req('m','Материал рукояти','word','фиберглас')],[{name:'Материал рукояти',value:'стекловолокно/фиберглас'}],'ref');
 assert.equal(material.m.status,'PASS');
 assert.throws(()=>evaluateCharacteristics([req('m','@title','word','Model')],[],'ref'),/Identity/);
});
