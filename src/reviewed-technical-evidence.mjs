import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const present = value => typeof value === 'string' && value.trim() !== '';
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Excludes supply/pricing/reviews; any change to the reviewed technical card invalidates the binding. */
export function technicalFingerprint(raw) {
  const characteristics = (raw.characteristics ?? []).map(({name,value,unit}) => [name,value,unit ?? null])
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash(JSON.stringify([raw.id,raw.sku,raw.url,raw.name,raw.category_path ?? null,characteristics]));
}

export function loadReviewedTechnicalEvidence(entries = []) {
  if (!Array.isArray(entries) || entries.length > 2000) throw new Error('Invalid reviewed technical evidence');
  const result = new Map();
  for (const entry of entries) {
    if (!/^[1-9]\d*$/u.test(entry?.siteProductId) || !present(entry.viCode) || !present(entry.url) ||
        !present(entry.reviewedBy) || !present(entry.reviewedAt) || !Number.isFinite(Date.parse(entry.reviewedAt)) ||
        !digest(entry.catalogFingerprint) || !present(entry.source?.url) || !present(entry.source.snapshotRef) ||
        !digest(entry.source.sha256) || !present(entry.source.section) ||
        !Array.isArray(entry.facts) || !entry.facts.length || entry.facts.length > 20 ||
        new Set(entry.facts.map(fact=>fact.name)).size !== entry.facts.length ||
        entry.facts.some(fact=>!/^@reviewed\.[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(fact.name) ||
          !present(fact.value) || fact.value.length > 1024 || (fact.unit !== undefined && typeof fact.unit !== 'string')) ||
        result.has(entry.siteProductId)) throw new Error('Invalid reviewed technical evidence entry');
    const url = new URL(entry.source.url), cardUrl = new URL(entry.url);
    if ([url,cardUrl].some(url=>url.protocol!=='https:' || url.username || url.password || url.port) ||
        !['vseinstrumenti.ru','www.vseinstrumenti.ru'].includes(cardUrl.hostname) ||
        !cardUrl.pathname.startsWith('/product/')) throw new Error('Invalid technical evidence URL');
    if (hash(readFileSync(entry.source.snapshotRef)) !== entry.source.sha256) {
      throw new Error('Technical evidence snapshot hash mismatch');
    }
    result.set(entry.siteProductId,structuredClone(entry));
  }
  return result;
}

export function appliesToTechnicalCard(entry, raw) {
  if (!entry || entry.siteProductId !== raw.id || entry.viCode !== raw.sku || entry.url !== raw.url ||
      entry.catalogFingerprint !== technicalFingerprint(raw)) return false;
  if (hash(readFileSync(entry.source.snapshotRef)) !== entry.source.sha256) {
    throw new Error('Technical evidence snapshot changed after review');
  }
  return true;
}
