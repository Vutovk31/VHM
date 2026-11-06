import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { normalizeRequest } from './intake.mjs';

const fields = new Set(['text', 'number', 'quantity', 'unit', 'group', 'notes', 'category',
  'brand', 'model', 'mpn', 'viCode', 'siteProductId', 'series']);
const empty = value => value === null || value === undefined || String(value).trim() === '';
const integer = value => Number.isSafeInteger(value) && value > 0;
const excelError = value => typeof value === 'string' &&
  /^#(?:REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NULL!|NUM!|SPILL!|CALC!)$/.test(value);

export function readMappedRows(sheet, mapping, getRange) {
  const { firstRow, lastRow, columns, skipRows = [], defaults = {} } = mapping;
  if (!integer(firstRow) || !integer(lastRow) || lastRow < firstRow || lastRow - firstRow >= 100_000) {
    throw new Error('Invalid row range: ' + sheet);
  }
  if (!columns?.text || Object.entries(columns).some(([key, col]) =>
    !fields.has(key) || typeof col !== 'string' || !/^[A-Z]{1,3}$/.test(col)) ||
    new Set(Object.values(columns)).size !== Object.keys(columns).length) {
    throw new Error('Invalid columns: ' + sheet);
  }
  const skip = new Set(skipRows);
  if (skipRows.some(line => !integer(line) || line < firstRow || line > lastRow)) {
    throw new Error('Invalid skipRows: ' + sheet);
  }
  if (Object.keys(defaults).some(key => !fields.has(key) || key === 'text')) {
    throw new Error('Invalid defaults: ' + sheet);
  }
  const entries = Object.entries(columns).map(([key, col]) => {
    const range = getRange(col + firstRow + ':' + col + lastRow);
    return [key, range.values, range.formulas];
  });
  const rows = [], remarks = [];
  for (let line = firstRow; line <= lastRow; line++) {
    if (skip.has(line)) {
      remarks.push({ code: 'EXPLICITLY_EXCLUDED_ROW', location: sheet, line });
      continue;
    }
    const index = line - firstRow;
    const cells = Object.fromEntries(entries.map(([key, values]) => [key, values[index]?.[0] ?? null]));
    const missing = entries.filter(([key, , formulas]) =>
      excelError(cells[key]) || (empty(cells[key]) && !empty(formulas?.[index]?.[0]))).map(([key]) => key);
    if (Object.values(cells).every(empty) && missing.length === 0) continue;
    if (empty(cells.text) || missing.includes('text')) {
      throw new Error('Product name unavailable at ' + sheet + '!' + line + '; review mapping or explicitly exclude row');
    }
    for (const field of missing) {
      remarks.push({ code: 'EXCEL_CELL_UNVERIFIED', location: sheet, line, field, original: cells[field] });
      cells[field] = null;
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (empty(cells[key]) && !missing.includes(key)) cells[key] = value;
    }
    rows.push({ ...cells, location: sheet, line });
  }
  return { rows, remarks };
}

export function workbookIntake(workbook, { sheets, ...context }) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.some(x => !x?.name) ||
      new Set(sheets.map(x => x.name)).size !== sheets.length) {
    throw new Error('Workbook requires unique mapped worksheets');
  }
  const available = new Map(workbook.worksheets.items.map(sheet => [sheet.name, sheet]));
  const parts = sheets.map(mapping => {
    const sheet = available.get(mapping.name);
    if (!sheet) throw new Error('Worksheet not found: ' + mapping.name);
    available.delete(mapping.name);
    return readMappedRows(mapping.name, mapping, address => sheet.getRange(address));
  });
  const snapshot = normalizeRequest({ ...context, rows: parts.flatMap(part => part.rows) });
  snapshot.remarks.push(...parts.flatMap(part => part.remarks),
    ...Array.from(available.keys(), location => ({ code: 'UNMAPPED_WORKSHEET', location })));
  return snapshot;
}

export async function loadWorkbookIntake(input, mapping) {
  const { FileBlob, SpreadsheetFile } = await import('@oai/artifact-tool');
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
  return workbookIntake(workbook, mapping);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, mappingPath, output] = process.argv.slice(2);
  if (!input || !mappingPath || !output) {
    throw new Error('Usage: node src/intake-xlsx.mjs input.xlsx mapping.json output.json');
  }
  const mapping = JSON.parse(readFileSync(mappingPath, 'utf8').replace(/^\uFEFF/u, ''));
  const snapshot = await loadWorkbookIntake(input, mapping);
  writeFileSync(output, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
}
