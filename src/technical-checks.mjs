const text = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const units = new Map([
  ['мм', ['length', 1]], ['mm', ['length', 1]], ['см', ['length', 10]], ['м', ['length', 1000]],
  ['г', ['mass', 1]], ['g', ['mass', 1]], ['кг', ['mass', 1000]], ['kg', ['mass', 1000]],
  ['мл', ['volume', 1]], ['л', ['volume', 1000]],
  ['в', ['voltage', 1]], ['v', ['voltage', 1]], ['кв', ['voltage', 1000]],
  ['вт', ['power', 1]], ['w', ['power', 1]], ['квт', ['power', 1000]],
  ['ач', ['capacity', 1]], ['ah', ['capacity', 1]],
  ['нм', ['torque', 1]], ['nm', ['torque', 1]],
  ['шт', ['count', 1]], ['шт.', ['count', 1]], ['', ['dimensionless', 1]],
]);
const unit = value => units.get(text(value).replace(/[·*.\s]/gu, ''));
const boolean = value => {
  const v = text(value);
  if (['да', 'есть', 'true'].includes(v)) return true;
  if (['нет', 'false'].includes(v)) return false;
  return null;
};
const number = value => {
  const v = String(value ?? '').trim().replace(',', '.');
  return /^[-+]?\d+(?:\.\d+)?$/u.test(v) && Number.isFinite(Number(v)) ? Number(v) : null;
};

function check(actual, expected) {
  switch (expected.kind) {
    case 'boolean': {
      if (typeof expected.expected !== 'boolean') throw new Error('Boolean expected must be true or false');
      const value = boolean(actual.value);
      return value === null ? 'UNKNOWN' : value === expected.expected ? 'PASS' : 'FAIL';
    }
    case 'number': {
      if (typeof expected.expected !== 'number' || !Number.isFinite(expected.expected) ||
          typeof expected.unit !== 'string') throw new Error('Numeric expected and unit are required');
      const value = number(actual.value);
      const from = unit(actual.unit), to = unit(expected.unit);
      if (value === null || !from || !to || from[0] !== to[0]) return 'UNKNOWN';
      const left = value * from[1], right = expected.expected * to[1];
      if (!Number.isFinite(left) || !Number.isFinite(right)) return 'UNKNOWN';
      // Only numerical round-off is tolerated, not technical specification drift.
      return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8 ? 'PASS' : 'FAIL';
    }
    case 'text': {
      if (typeof expected.expected !== 'string' || !expected.expected.trim()) throw new Error('Text expected is required');
      return !text(actual.value) ? 'UNKNOWN' : text(actual.value) === text(expected.expected) ? 'PASS' : 'FAIL';
    }
    case 'token': {
      if (typeof expected.expected !== 'string' || !expected.expected.trim()) throw new Error('Token expected is required');
      const actualText = text(actual.value), token = text(expected.expected);
      if (!actualText) return 'UNKNOWN';
      let offset = actualText.indexOf(token);
      while (offset !== -1) {
        const before = actualText.slice(0, offset), after = actualText.slice(offset + token.length);
        if (!/[\p{L}\p{N}./-]$/u.test(before) && !/^[\p{L}\p{N}./-]/u.test(after)) return 'PASS';
        offset = actualText.indexOf(token, offset + 1);
      }
      return 'FAIL';
    }
    default: throw new Error('Unsupported technical test');
  }
}

/** Produces Matcher checks from raw characteristics with source references. */
export function evaluateCharacteristics(requirements, characteristics, ref) {
  if (!Array.isArray(requirements) || !Array.isArray(characteristics) || typeof ref !== 'string' || !ref.trim()) {
    throw new Error('Requirements, characteristics and evidence reference are required');
  }
  const result = Object.create(null);
  for (const requirement of requirements) {
    if (!requirement?.key || Object.hasOwn(result, requirement.key)) throw new Error('Requirement keys must be unique');
    const { field, test } = requirement;
    if (!test || typeof field !== 'string' || !field.trim()) {
      result[requirement.key] = { status: 'UNKNOWN', ref, detail: 'No structured technical test' };
      continue;
    }
    // Validate the expected representation even when the provider omitted the field.
    check({ value: null, unit: null }, test);
    const facts = characteristics.filter(item => text(item.name) === text(field));
    const outcomes = facts.map(fact => check(fact, test));
    const sameRepresentation = new Set(facts.map(fact => JSON.stringify([text(fact.value), text(fact.unit)]))).size <= 1;
    const status = outcomes.length && outcomes.every(value => value === 'PASS') ? 'PASS' :
      outcomes.length && outcomes.every(value => value === 'FAIL') && sameRepresentation ? 'FAIL' : 'UNKNOWN';
    result[requirement.key] = { status, ref, detail: JSON.stringify(facts.map(({value, unit}) => ({value, unit}))) };
  }
  return result;
}
