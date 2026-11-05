import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../src/intake.mjs';
import { planSearch } from '../src/search-plan.mjs';

function plan(source) {
  const {rows} = normalizeRequest({requestId:'pilot',policyVersion:'1.1.0',rows:[source]});
  return planSearch(rows[0]);
}

test('builds stable variants without reclassifying a manufacturer part number', () => {
  const result = plan({text:'Бур CUTOP 49-6260',brand:'CUTOP',mpn:'49-6260',category:'бур',
    requirements:[{key:'mount',value:'SDS-plus'}],notes:'do not send this',viCode:'15872404'});
  assert.deepEqual(result.lookups, [{kind:'viCode',value:'15872404'}]);
  assert.deepEqual(result.queries.map(q=>q.query),
    ['49-6260','CUTOP 49-6260','Бур CUTOP 49-6260','бур CUTOP SDS-plus']);
});

test('preserves explicit model suffix and deduplicates equivalent text queries', () => {
  const result = plan({text:'Makita DTW285Z',brand:'Makita',model:'DTW285Z',siteProductId:'bad'});
  assert.deepEqual(result, { lookups:[], queries:[{strategy:'BRAND_MODEL',query:'Makita DTW285Z'}] });
});

test('unstructured identifier hints generate text recovery without a typed lookup', () => {
  const result=plan({text:'Аккумуляторный гайковёрт Makita DTW285Z'});
  assert.deepEqual(result.lookups,[]);
  assert.equal(result.queries[0].query,'Makita DTW285Z');
  assert.equal(result.queries[0].strategy,'SOURCE_IDENTIFIER_TEXT');
});
