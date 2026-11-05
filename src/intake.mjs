import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { extractProductText } from './normalize-product.mjs';
import { compileTechnicalRequirements } from './compile-requirements.mjs';

const tidy = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
const units = new Map([
  ['шт', 'шт'], ['штука', 'шт'], ['штук', 'шт'], ['pcs', 'шт'],
  ['набор', 'набор'], ['наборов', 'набор'], ['компл', 'компл'], ['комплект', 'компл'],
  ['уп', 'упак'], ['упак', 'упак'], ['упаковка', 'упак'], ['м', 'м'], ['мм', 'мм'],
  ['кг', 'кг'], ['л', 'л'], ['рулон', 'рулон'], ['бухта', 'бухта'],
]);

export function parseRequestCsv(text, delimiter = ',') {
  if (![',', ';', '\t'].includes(delimiter)) throw new Error('Unsupported delimiter');
  const records = [];
  let fields = [], field = '', quoted = false, closed = false;
  let line = 1, start = 1;
  function nextField() {
    fields.push(field);
    field = '';
    closed = false;
  }
  function nextRecord() {
    nextField();
    if (fields.some(value => value.trim())) records.push({ line: start, fields });
    fields = [];
  }
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += ch;
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        field += ch;
        if (ch === '\n') line++;
      }
    } else if (ch === delimiter) {
      nextField();
    } else if (ch === '\n') {
      nextRecord();
      start = ++line;
    } else if (ch === '"' && !field && !closed) {
      quoted = true;
    } else if (closed || ch === '"') {
      throw new Error('Invalid quoting at line ' + line);
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('Unclosed quoted field at line ' + start);
  if (field || fields.length || closed) nextRecord();
  const header = records.shift()?.fields.map(tidy) ?? [];
  if (!header.includes('text') || new Set(header).size !== header.length || header.includes('line')) {
    throw new Error('CSV requires unique headers and a text column. line is reserved');
  }
  return records.map(({ line, fields }) => {
    if (fields.length !== header.length) throw new Error('Column count mismatch at line ' + line);
    return { ...Object.fromEntries(header.map((key, index) => [key, fields[index]])), line };
  });
}

export function normalizeRequest({ requestId, policyVersion, city = '', rows, remarks: sourceRemarks = [] }) {
  if (!tidy(requestId) || !tidy(policyVersion) || !Array.isArray(rows) || !rows.length) {
    throw new Error('Request ID, policy version and rows are required');
  }
  const seen = new Set();
  if (!Array.isArray(sourceRemarks)) throw new Error('Request remarks must be an array');
  const remarks = [...sourceRemarks];
  const normalized = rows.map((source, index) => {
    const line = source.line ?? index + 1;
    const location = tidy(source.location) || 'input';
    if (!Number.isSafeInteger(line) || line < 1) throw new Error('Invalid source line');
    const key = createHash('sha256').update(JSON.stringify([requestId, location, line])).digest('hex');
    if (seen.has(key)) throw new Error('Duplicate source locator: ' + location + ':' + line);
    seen.add(key);
    if (typeof source.text !== 'string' || !tidy(source.text)) {
      throw new Error('Empty product name at ' + location + ':' + line);
    }
    const rawQuantity = tidy(source.quantity);
    const value = /^\d+(?:[.,]\d+)?$/u.test(rawQuantity) ? Number(rawQuantity.replace(',', '.')) : NaN;
    const quantity = Number.isFinite(value) && value > 0 ? value : null;
    const rawUnit = tidy(source.unit).toLowerCase().replace(/\.$/u, '');
    const unit = units.get(rawUnit) ?? '';
    if (quantity === null || !unit) remarks.push({ key, code: 'QUANTITY_OR_UNIT_UNVERIFIED' });
    const compiled = source.requirements === undefined ? compileTechnicalRequirements(source) : null;
    const product = {
      name: tidy(source.text), category: tidy(source.category) || (compiled?.complete ? compiled.category : ''),
      brand: tidy(source.brand) || (compiled?.complete ? compiled.brand : ''),
      model: tidy(source.model), mpn: tidy(source.mpn), viCode: tidy(source.viCode),
      siteProductId: tidy(source.siteProductId), series: tidy(source.series),
    };
    return {
      key, number: source.number ?? line, location, line, text: source.text,
      group: tidy(source.group) || null, quantity, unit: unit || null, original: { ...source },
      product, requirements: source.requirements ?? (compiled?.complete ? compiled.requirements : []),
      compilation: compiled,
      analysis: extractProductText(source.text),
    };
  });
  return { requestId, policyVersion, city: tidy(city), rows: normalized, remarks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, requestId, policyVersion, delimiter] = process.argv.slice(2);
  if (!input || !output || !requestId || !policyVersion) {
    throw new Error('Usage: node src/intake.mjs input.{csv,json} output.json requestId policyVersion [delimiter]');
  }
  const text = readFileSync(input, 'utf8').replace(/^\uFEFF/u, '');
  const payload = input.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseRequestCsv(text, delimiter);
  const source = Array.isArray(payload) ? { rows: payload } : payload;
  const snapshot = normalizeRequest({ ...source, requestId, policyVersion });
  writeFileSync(output, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
}
