import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { match } from '../src/matcher.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/vi.json', import.meta.url)));
const context = {requestId: 'synthetic', policyVersion: policy.version};
const strict = {key: 'sheet:12', number: 12, group: 'Инструмент', text: 'Перфоратор Model-A',
  category: 'Перфоратор', model: 'Model-A', kind: 'STRICT', quantity: 11, unit: 'шт', requirements: []};
const open = {...strict, key: 'sheet:15', number: 15, kind: 'OPEN', model: undefined, text: 'Перфоратор'};
const card = {siteProductId: '101', viCode: '204', mpn: 'SKU-A', title: 'Учебная карточка',
  model: 'Model-A', brand: 'Inforce', category: 'Перфоратор', stage: 'EXACT',
  url: 'https://www.vseinstrumenti.ru/product/synthetic-101/',
  verification: {source: 'MCP_VERIFY', ref: 'synthetic fixture'},
  assumptions: 'Условная комплектация',
  pack: {size: 10, sourceUnit: 'шт', orderUnit: 'уп.', ref: 'synthetic fixture'},
  stock: {status: 'IN_STOCK_MCP', city: 'Москва', ref: 'synthetic fixture'}};
const analog = {...card, stage: 'ANALOG', model: 'Model-B', differences: 'Другая модель'};
const run = (rows, records, extras = {}) =>
  match(policy, {...context, city: 'Сочи', rows}, {...context, rows: records, ...extras});

test('retains source rows and separates exact match, proposed product and regional delivery', () => {
  const duplicate = {...strict, key: 'sheet:16', number: 16};
  const result = run([strict, open, duplicate], {
    [strict.key]: {cards: [card]},
    [open.key]: {cards: [{...card, brand: 'Other', siteProductId: '100'}, card]},
  });
  assert.deepEqual(result.rows.map(row => row.status), ['EXACT', 'PRODUCT_PROPOSED', 'NOT_SEARCHED']);
  assert.equal(result.rows[1].card.siteProductId, '101');
  assert.match(result.rows[1].clientText, /^Предложен товар — .*Model-A$/);
  assert.equal(result.rows[0].quantity, 2);
  assert.equal(result.rows[0].delivery, 'NOT_CONFIRMED');
  assert.equal(result.metrics.coverage, 0);
  assert.equal(result.procurement.length, 1);
  assert.equal(result.hunter.length, 2);
  if (process.env.VHM_SMOKE_DIR) {
    mkdirSync(process.env.VHM_SMOKE_DIR, {recursive: true});
    writeFileSync(new URL('result.json', new URL('../runs/smoke/', import.meta.url)), JSON.stringify(result));
  }
});

test('fails closed on incompatible requirements, model substitutions and web-only cards', () => {
  const incompatible = {...strict, requirements: [{key: 'mount', value: 'SDS-plus'}]};
  const outcome = run([incompatible], {[strict.key]: {cards: [{...card, checks: {mount: {status: 'FAIL', ref: 'fixture'}}}]}});
  assert.equal(outcome.rows[0].status, 'NOT_FOUND');
  assert.equal(run([strict], {[strict.key]: {cards: [{...card, model: 'Other'}]}}).rows[0].status, 'NOT_FOUND');
  assert.equal(run([strict], {[strict.key]: {cards: [{...card, verification: null}]}}).rows[0].status, 'EXACT_UNVERIFIED');
});

test('scoped permission resumes the same request and SKU approval is separate', () => {
  const evidence = {[strict.key]: {cards: [analog]}};
  assert.throws(() => run([strict], evidence), /lacks permission/);
  const analogPermission = {...context, keys: [strict.key], decision: 'ALLOW_ANALOG_DISCOVERY', by: 'manager', at: 'fixture'};
  const options = {analogPermission};
  assert.equal(run([strict], evidence, options).rows[0].approval, 'PENDING');
  assert.equal(run([strict], evidence, options).procurement.length, 0);
  const approval = {...context, key: strict.key, siteProductId: card.siteProductId, by: 'customer', at: 'fixture'};
  assert.equal(run([strict], evidence, {...options, approvals: [approval]}).metrics.coverage, 1);
  assert.throws(() => run([strict], evidence, {analogPermission: {...analogPermission, requestId: 'another'}}), /Invalid analog permission/);
});

test('meters round up, delivery evidence is independent and source failure remains visible', () => {
  const row = {...strict, quantity: 11, unit: 'м'};
  const candidate = {...card, pack: {...card.pack, sourceUnit: 'м', orderUnit: 'бухта'},
    delivery: {status: 'CONFIRMED', city: 'Сочи', quantity: 1, ref: 'fixture'}};
  const result = run([row], {[row.key]: {cards: [candidate], attempts: [{channel: 'WEB', outcome: 'ERROR'}]}});
  assert.equal(result.rows[0].quantity, 2);
  assert.equal(result.rows[0].delivery, 'NOT_CONFIRMED');
  assert.equal(result.rows[0].partial, true);
});

test('approval of an open proposal contributes to coverage and procurement', () => {
  const approval = {...context, key: open.key, siteProductId: card.siteProductId, by: 'customer', at: 'fixture'};
  const result = run([open], {[open.key]: {cards: [card]}}, {approvals: [approval]});
  assert.equal(result.metrics.coverage, 1);
  assert.equal(result.procurement.length, 1);
});
