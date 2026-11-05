import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, parseRequestCsv } from '../src/intake.mjs';

const normalize = rows => normalizeRequest({requestId:'pilot',policyVersion:'1.1.0',rows});

test('CSV preserves physical source lines, multiline fields, duplicates and decimal comma', () => {
  const rows = parseRequestCsv('\uFEFFnumber;text;quantity;unit\r\n2;"Набор ""Ключ""\nHEX";3;набор\r\n\r\n4;Труба;2,5;м\r\n4;Труба;2,5;м', ';');
  const result = normalize(rows);
  assert.deepEqual(result.rows.map(r => r.line), [2, 5, 6]);
  assert.equal(result.rows[0].text, 'Набор "Ключ"\nHEX');
  assert.equal(result.rows[1].quantity, 2.5);
  assert.equal(new Set(result.rows.map(r => r.key)).size, 3);
  assert.equal(normalize(rows).rows[2].key, result.rows[2].key);
});

test('unknown unit and invalid amount stay unverified; identifiers retain their type and leading zeros', () => {
  const { rows, remarks } = normalize([{ text:'Набор 0012',quantity:'2–4',unit:'?',mpn:'0012',viCode:'0456' }]);
  assert.equal(rows[0].quantity, null);
  assert.equal(rows[0].unit, null);
  assert.equal(rows[0].original.quantity, '2–4');
  assert.equal(rows[0].product.mpn, '0012');
  assert.equal(rows[0].product.viCode, '0456');
  assert.equal(rows[0].product.siteProductId, '');
  assert.equal(remarks[0].code, 'QUANTITY_OR_UNIT_UNVERIFIED');
});

test('malformed input fails before silently omitting source rows', () => {
  assert.throws(() => parseRequestCsv('text,quantity\nx'), /Column count/);
  assert.throws(() => parseRequestCsv('text\n"x'), /Unclosed/);
  assert.throws(() => normalize([{text:'x',line:1},{text:'x',line:1}]), /Duplicate source locator/);
});
