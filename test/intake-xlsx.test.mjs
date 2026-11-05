import test from 'node:test';
import assert from 'node:assert/strict';
import { workbookIntake } from '../src/intake-xlsx.mjs';

const sheet = (name, data) => ({name, getRange: address => data[address]});
const workbook = sheets => ({worksheets:{items:sheets}});
const mapping = {requestId:'x',policyVersion:'1.1.0',sheets:[
  {name:'T',firstRow:4,lastRow:6,columns:{text:'B',quantity:'D'},defaults:{unit:'шт'}},
]};

test('workbook mapping keeps physical row identity and records skipped or unmapped input', () => {
  const source = workbook([
    sheet('T', {'B4:B6':{values:[['Бур'],['Бур'],['Итог']]},'D4:D6':{values:[[2],[2],[4]]}}),
    sheet('Reference', {}),
  ]);
  const result = workbookIntake(source,{...mapping,sheets:[{...mapping.sheets[0],skipRows:[6]}]});
  assert.deepEqual(result.rows.map(r=>[r.location,r.line,r.quantity,r.unit]), [['T',4,2,'шт'],['T',5,2,'шт']]);
  assert.notEqual(result.rows[0].key,result.rows[1].key);
  assert.deepEqual(result.remarks.map(x=>x.code), ['EXPLICITLY_EXCLUDED_ROW','UNMAPPED_WORKSHEET']);
});

test('unreadable formula is reported; data without product name fails closed', () => {
  const ranges = {'B4:B6':{values:[['Бур'],[null],[null]]},
    'D4:D6':{values:[['#REF!'],[null],[null]],formulas:[['=A4'],[null],[null]]}};
  const source = workbook([sheet('T',ranges)]);
  const result = workbookIntake(source,mapping);
  assert.equal(result.rows[0].quantity,null);
  assert.equal(result.remarks.find(x=>x.code==='EXCEL_CELL_UNVERIFIED').original,'#REF!');
  ranges['D4:D6'].values[1][0]=2;
  assert.throws(()=>workbookIntake(source,mapping),/Product name unavailable at T!5/);
});
