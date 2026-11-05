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
