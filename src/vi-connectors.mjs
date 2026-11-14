import { extractProductText } from './normalize-product.mjs';
import { evaluateCharacteristics } from './technical-checks.mjs';
import { loadReviewedTechnicalEvidence, appliesToTechnicalCard } from './reviewed-technical-evidence.mjs';

const present = value => typeof value === 'string' && value.trim() !== '';
const validId = value => typeof value === 'string' && /^[1-9]\d*$/u.test(value);

function unpack(result) {
  if (result?.structuredContent) return result.structuredContent;
  const content = result?.content?.filter(item => item.type === 'text').map(item => item.text) ?? [];
  for (const value of content) {
    try { return JSON.parse(value); } catch { /* Try the next structured text block. */ }
  }
  throw new Error('VI MCP returned no structured payload');
}

export function projectVerifiedProduct(raw, requirements, ref, observedAt = null) {
  if (!validId(raw?.id) || !present(raw?.name) || !present(ref)) throw new Error('Raw product and evidence reference required');
  const analysis = extractProductText(raw.name);
  const characteristics = [
    ...(Array.isArray(raw.characteristics) ? raw.characteristics : []).filter(item =>
      typeof item.name === 'string' && !item.name.normalize('NFKC').trim().startsWith('@')).map(({name,value,unit})=>({name,value,unit})),
    { name: '@title', value: raw.name },
    ...(present(raw.category_path) ? [{ name: '@categoryPath', value: raw.category_path }] : []),
    { name: '@siteProductId', value: raw.id },
    ...(present(raw.sku) ? [{ name: '@viCode', value: raw.sku }] : []),
  ];
  const packContents = characteristics.filter(item =>
    item.name.trim().toLowerCase() === 'количество в упаковке');
  const brand = analysis.brands.length === 1 ? analysis.brands[0] : null;
  const suffix = brand ? raw.name.slice(brand.source.end).trim() : '';
  // A brand followed by a single mixed letter/digit identifier is a bounded title pattern.
  const model = /^(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/iu.test(suffix)
    ? suffix : undefined;
  return {
    siteProductId: raw.id, viCode: raw.sku, title: raw.name, url: raw.url,
    category: analysis.category?.value ?? 'UNCLASSIFIED',
    brand: brand?.value, observedModel: model,
    stage: 'EXACT', characteristics,
    checks: evaluateCharacteristics(requirements, characteristics, ref),
    verification: { source: 'MCP_VERIFY', ref: ref },
    ...(packContents.length ? { observedPackContents: { fields: packContents, ref } } : {}),
    stock: { status: raw.availability === 'in_stock' ? 'IN_STOCK_MCP' :
      raw.availability === 'out_of_stock' ? 'OUT_OF_STOCK' : 'UNKNOWN',
    city: 'Москва', ref: ref },
    observedPrice: typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0 ?
      { amount: raw.price, currency: 'RUB', at: observedAt, ref: ref } : null,
  };
}

export function createViConnectors({ invoke, persist, session }) {
  if (typeof invoke !== 'function' || typeof persist !== 'function' ||
      session?.summaryAccepted !== true || !present(session.instructionsVersion)) {
    throw new Error('Host MCP preflight and durable evidence writer are required');
  }
  let active = false;
  const technicalEvidence = loadReviewedTechnicalEvidence(session.reviewedTechnicalEvidence);
  const saleTerms = new Map();
  const reviewedTerms = session.reviewedSaleTerms ?? [];
  if (!Array.isArray(reviewedTerms)) throw new Error('reviewedSaleTerms must be an array');
  for (const entry of reviewedTerms) {
    if (!validId(entry?.siteProductId) || !present(entry.viCode) || !present(entry.reviewedBy) ||
        !present(entry.reviewedAt) || !Number.isFinite(Date.parse(entry.reviewedAt)) ||
        !present(entry.sourceUnit) || !present(entry.orderUnit) ||
        !Number.isFinite(entry.size) || entry.size <= 0 ||
        !Number.isSafeInteger(entry.orderMultiple) || entry.orderMultiple <= 0 ||
        !present(entry.url) || saleTerms.has(entry.siteProductId)) {
      throw new Error('Invalid or duplicate reviewed sale terms');
    }
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || !['www.vseinstrumenti.ru', 'vseinstrumenti.ru'].includes(url.hostname) ||
        url.port || url.username || url.password || !url.pathname.startsWith('/product/')) {
      throw new Error('Reviewed sale terms require an official VI product URL');
    }
    saleTerms.set(entry.siteProductId, entry);
  }

  async function call(method, args, signal) {
    signal?.throwIfAborted();
    if (active) throw new Error('VI MCP calls must be sequential');
    active = true;
    const at = new Date().toISOString();
    try {
      const result = await invoke(method, args, { signal });
      let data;
      try {
        data = unpack(result);
      } catch (error) {
        await persist({ method, args, at, region: 'Москва',
          instructionsVersion: session.instructionsVersion, error: true, data: result });
        throw error;
      }
      const error = result.isError ? data.error ?? data : null;
      const ref = await persist({ method, args, at, region: 'Москва',
        instructionsVersion: session.instructionsVersion, error: !!result.isError, data });
      if (!present(ref)) throw new Error('Evidence writer did not return a reference');
      if (error) {
        throw Object.assign(new Error('VI MCP provider error'), {
          code: error.code ?? 'internal_error', retryable: error.retryable === true,
          retryAfterSeconds: error.retry_after_seconds, evidenceRef: ref,
        });
      }
      signal?.throwIfAborted();
      return { data, ref, at };
    } finally {
      active = false;
    }
  }

  return {
    async searchMcp({ query, limit = 4, signal }) {
      if (!present(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('Invalid VI text search');
      }
      const { data } = await call('search_products', { query, limit }, signal);
      if (data.products !== null && !Array.isArray(data.products)) throw new Error('Invalid VI search response');
      return (data.products ?? []).filter(item => validId(item.id)).map(item => ({ siteProductId: item.id }));
    },

    async verifyMcp({ candidates, requirements = [], signal }) {
      if (!Array.isArray(candidates) || !candidates.length || candidates.length > 20) {
        throw new Error('Invalid VI verification candidates');
      }
      let response, products;
      if (candidates.every(candidate => validId(candidate.siteProductId))) {
        const ids = candidates.map(candidate => candidate.siteProductId);
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate VI verification IDs');
        response = await call('get_products', { ids }, signal);
        if (response.data.products !== null && !Array.isArray(response.data.products)) throw new Error('Invalid VI product batch');
        products = (response.data.products ?? []).filter(item => ids.includes(item.id));
      } else {
        if (candidates.length !== 1) throw new Error('VI URL and code verification requires a single candidate');
        const candidate = candidates[0];
        let args;
        if (present(candidate.url)) {
          const url = new URL(candidate.url);
          if (url.protocol !== 'https:' || !['vseinstrumenti.ru', 'www.vseinstrumenti.ru'].includes(url.hostname) ||
              !url.pathname.startsWith('/product/') || url.username || url.password || url.port) {
            throw new Error('Untrusted VI card URL');
          }
          args = { url: candidate.url };
        } else if (present(candidate.viCode)) args = { sku: candidate.viCode };
        else throw new Error('A typed VI locator is required');
        response = await call('get_product', args, signal);
        products = [response.data];
      }

      const cards = [];
      for (const raw of products.filter(raw => validId(raw.id) && present(raw.name))) {
        const card = projectVerifiedProduct(raw, requirements, response.ref, response.at);
        const reviewed = technicalEvidence.get(raw.id);
        if (appliesToTechnicalCard(reviewed,raw)) {
          const ref = await persist({method:'reviewed_technical_evidence',mcpRef:response.ref,review:reviewed});
          if (!present(ref)) throw new Error('Technical evidence persistence reference required');
          card.characteristics.push(...reviewed.facts.map(({name,value,unit})=>({name,value,unit,evidenceRef:ref})));
          card.checks = evaluateCharacteristics(requirements,card.characteristics,response.ref);
          card.reviewedTechnicalEvidence = {ref,sourceUrl:reviewed.source.url,sha256:reviewed.source.sha256};
        }
        const terms = saleTerms.get(raw.id);
        if (terms && terms.viCode === raw.sku && terms.url === raw.url) {
          const { size, sourceUnit, orderUnit, orderMultiple, url, reviewedBy, reviewedAt } = terms;
          card.pack = { size, sourceUnit, orderUnit, orderMultiple, ref: url, reviewedBy, reviewedAt };
        }
        cards.push(card);
      }
      return cards;
    },
  };
}
