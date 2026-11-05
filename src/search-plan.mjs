const normalize = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

/**
 * Builds text variants from normalized product fields. Connector orchestration
 * decides which permitted channel can consume each variant.
 */
export function planSearch(row) {
  const { brand, model, mpn, name, category, viCode, siteProductId } = row.product;
  const queries = [];
  const seen = new Set();
  function add(strategy, parts) {
    const query = parts.map(normalize).filter(Boolean).join(' ');
    const key = query.toLocaleLowerCase('ru');
    if (query && !seen.has(key)) {
      queries.push({ strategy, query });
      seen.add(key);
    }
  }
  if (model) add('BRAND_MODEL', [brand, model]);
  if (mpn) {
    add('MPN_TEXT', [mpn]);
    if (brand) add('BRAND_MPN', [brand, mpn]);
  }
  add('NORMALIZED_NAME', [name]);
  const terms = row.requirements.map(requirement => requirement.value);
  if (category && terms.length) add('REQUIRED_ATTRIBUTES', [category, brand, ...terms]);
  const lookups = [
    ...(siteProductId && /^[1-9]\d*$/u.test(siteProductId) ? [{ kind: 'siteProductId', value: siteProductId }] : []),
    ...(viCode ? [{ kind: 'viCode', value: viCode }] : []),
  ];
  return { lookups, queries };
}
