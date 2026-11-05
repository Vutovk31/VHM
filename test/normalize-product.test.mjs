import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProductText } from '../src/normalize-product.mjs';

test('extracts suffixes and source spans without classifying manufacturer code as VI code', () => {
  const source = 'Аккумуляторный гайковёрт Makita DTW285Z, 18 В';
  const result = extractProductText(source);
  assert.equal(result.brands[0].value,'Makita');
  assert.equal(result.category.value,'гайковёрт');
  assert.equal(result.identifiers[0].value,'DTW285Z');
  assert.equal(result.identifiers[0].type,'UNKNOWN');
  assert.equal(source.slice(result.identifiers[0].source.start,result.identifiers[0].source.end),'DTW285Z');
  assert.deepEqual(result.measures.map(x=>[x.value,x.unit]),[['18','В']]);
});

test('ambiguous brand and dimensions retain evidence and review status', () => {
  const result=extractProductText('Бур по бетону CUTOP FIT 49-6260, 6х260 мм');
  assert.deepEqual(result.brands.map(x=>x.value),['CUTOP','FIT']);
  assert.ok(result.issues.includes('MULTIPLE_BRANDS_IN_SOURCE'));
  assert.equal(result.measures[0].value,'6x260');
  assert.equal(result.measures[0].meaning,'UNRESOLVED');
  assert.equal(result.completeness,'REQUIRES_TECHNICAL_REVIEW');
});

test('requires brand boundaries and keeps leading zeros', () => {
  assert.equal(extractProductText('Набор GROSSWORD 72T CrV').brands.length,0);
  assert.equal(extractProductText('WERA WE-005305').identifiers[0].value,'WE-005305');
  assert.deepEqual(extractProductText('Пассатижи CrV 180 мм').identifiers,[]);
});

test('size with Latin units is a measure and cannot become an identifier hint', () => {
  const result=extractProductText('WERA 190 i VDE, 6.0x125 mm WE-005305');
  assert.deepEqual(result.identifiers.map(x=>x.value),['WE-005305']);
  assert.equal(result.measures[0].value,'6.0x125');
});

test('press washer screws cannot be classified as a hydraulic press',()=>{
 assert.equal(extractProductText('Саморез с прессшайбой 4,2х13 ARNO INDUSTRIES').category.value,'саморез');
 assert.equal(extractProductText('Пресс гидравлический ручной ПРГ-70 КВТ').category.value,'пресс');
 assert.equal(extractProductText('Пресс-клещи КВТ').category.value,'пресс');
});
