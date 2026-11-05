import { extractProductText } from './normalize-product.mjs';
import { evaluateCharacteristics } from './technical-checks.mjs';

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
      typeof item.name === 'string' && !item.name.startsWith('@')),
    { name: '@title', value: raw.name },
    { name: '@siteProductId', value: raw.id },
    ...(present(raw.sku) ? [{ name: '@viCode', value: raw.sku }] : []),
  ];
  const packContents = characteristics.filter(item =>
    item.name.trim().toLowerCase() === 'количество в упаковке');
  return {
    siteProductId: raw.id, viCode: raw.sku, title: raw.name, url: raw.url,
    category: analysis.category?.value ?? 'UNCLASSIFIED',
    brand: analysis.brands.length === 1 ? analysis.brands[0].value : undefined,
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

      return products.filter(raw => validId(raw.id) && present(raw.name)).map(raw => {
        return projectVerifiedProduct(raw, requirements, response.ref, response.at);
      });
    },
  };
}
