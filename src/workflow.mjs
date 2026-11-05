import { match } from './matcher.mjs';
import { planSearch } from './search-plan.mjs';

const text = value => typeof value === 'string' && value.trim() !== '';
const routeChannels = {
  A: ['WEB'], B: ['MCP_TEXT'], C: ['MCP_TEXT', 'WEB'],
};
const provider = channel => channel === 'WEB' ? 'WEB' : 'MCP';

function matcherRow(row) {
  const { brand, model, mpn, viCode, siteProductId, series } = row.product;
  const category = row.product.category || row.analysis?.category?.value;
  const kind = row.original?.kind;
  const requirements = [...row.requirements];
  const clarify = !text(category) || requirements.length === 0 || kind === 'CLARIFY';
  for (const [key, value] of Object.entries({ viCode, siteProductId, series })) {
    if (text(value) && !requirements.some(requirement => requirement.key === key)) {
      requirements.push({ key, value });
    }
  }
  return {
    ...row, category: category || 'UNCLASSIFIED', group: row.group || category || 'UNCLASSIFIED',
    brand, model, mpn, requirements,
    kind: clarify ? 'CLARIFY' : kind === 'OPEN' && ![brand, model, mpn, viCode, siteProductId].some(text) ? 'OPEN' : 'STRICT',
    clarification: clarify ? row.original?.clarification || (!text(category)
      ? 'Уточните категорию товара и обязательные технические параметры.'
      : 'Уточните обязательные параметры товара.') : undefined,
  };
}

function candidateLocator(candidate, catalogHost) {
  const { siteProductId, viCode, url } = candidate ?? {};
  if (typeof siteProductId === 'string' && /^[1-9]\d*$/u.test(siteProductId)) return { siteProductId };
  if (text(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && [catalogHost, 'www.' + catalogHost].includes(parsed.hostname) &&
          parsed.pathname.startsWith('/product/') && !parsed.username && !parsed.password && !parsed.port) {
        parsed.search = '';
        parsed.hash = '';
        return { url: parsed.href };
      }
    } catch {
      return null;
    }
  }
  return text(viCode) ? { viCode } : null;
}

function boundedValue(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid ' + name);
  return value;
}

function providerError(error) {
  const code = error?.status ?? error?.code;
  if ([401, 403, 429, '401', '403', '429', 'CAPTCHA'].includes(code)) return String(code);
  if (['rate_limited', 'upstream_unavailable', 'internal_error'].includes(code)) return code;
  return error?.name === 'TimeoutError' ? 'DEADLINE' : 'PROVIDER_ERROR';
}

function finishBefore(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Executes only strict discovery and explicitly open product proposals. Connectors
 * are trusted adapters, responsible for authorization and building traceable checks.
 * Searches return locator arrays. verifyMcp returns Matcher card arrays with a
 * persisted MCP verification reference and structured checks for the requirements.
 */
export async function runStrictWorkflow({ policy, snapshot, route, connectors = {},
  maxCallsPerRow = 8, deadlineMs = 30_000, candidateDepth = 4 }) {
  if (!Object.hasOwn(routeChannels, route)) throw new Error('Invalid search route');
  boundedValue(maxCallsPerRow, 2, 12, 'call budget');
  boundedValue(deadlineMs, 1, 60_000, 'deadline');
  boundedValue(candidateDepth, 1, 20, 'candidate depth');

  const intake = { ...snapshot, rows: snapshot.rows.map(matcherRow) };
  const evidence = { requestId: intake.requestId, policyVersion: intake.policyVersion,
    route, rows: Object.create(null) };
  match(policy, intake, evidence); // Validate the whole request before outbound calls.
  const blocked = new Map();

  for (let index = 0; index < intake.rows.length; index++) {
    const row = intake.rows[index];
    const record = evidence.rows[row.key] = { attempts: [], cards: [], candidateLocators: [] };
    if (row.kind === 'CLARIFY' && !snapshot.rows[index].analysis?.category) continue;
    const signal = AbortSignal.timeout(deadlineMs);
    const seenLocators = new Set();
    const seenCards = new Set();
    let calls = 0;

    async function call(channel, fn, payload) {
      const attempt = { channel, at: new Date().toISOString(), city: intake.city, ...payload };
      record.attempts.push(attempt);
      if (signal.aborted || calls >= maxCallsPerRow || blocked.has(provider(channel)) || typeof fn !== 'function') {
        attempt.outcome = 'UNAVAILABLE';
        attempt.reason = signal.aborted ? 'DEADLINE' : calls >= maxCallsPerRow ? 'CALL_BUDGET' :
          blocked.get(provider(channel)) ?? 'CONNECTOR_NOT_CONFIGURED';
        return [];
      }
      calls++;
      const started = performance.now();
      try {
        const result = await finishBefore(() => fn({ ...payload, city: intake.city, signal }), signal);
        if (!Array.isArray(result)) throw new Error('Connector result must be an array');
        attempt.outcome = result.length ? 'RESULT' : 'MISS';
        attempt.ids = result.map(candidate => candidate?.siteProductId).filter(text);
        attempt.elapsedMs = performance.now() - started;
        return result;
      } catch (error) {
        attempt.outcome = 'ERROR';
        attempt.reason = providerError(error);
        attempt.elapsedMs = performance.now() - started;
        blocked.set(provider(channel), attempt.reason);
        return [];
      }
    }

    async function verify(candidates) {
      const locators = [];
      for (const candidate of candidates.slice(0, candidateDepth)) {
        const locator = candidateLocator(candidate, policy.catalogHost);
        if (!locator || seenLocators.has(JSON.stringify(locator))) continue;
        seenLocators.add(JSON.stringify(locator));
        locators.push(locator);
      }
      record.candidateLocators.push(...locators);
      if (!locators.length) return false;
      const cards = await call('MCP_VERIFY', connectors.verifyMcp, { candidates: locators,
        requirements: row.requirements, limit: locators.length });
      for (const card of cards.slice(0, locators.length)) {
        if (!card || card.stage === 'ANALOG' || seenCards.has(card.siteProductId)) continue;
        if (!locators.some(locator => Object.entries(locator).every(([key, value]) => card[key] === value))) continue;
        seenCards.add(card.siteProductId);
        record.cards.push(card);
      }
      const singleEvidence = { ...evidence, rows: { [row.key]: record } };
      const result = match(policy, { ...intake, rows: [row] }, singleEvidence).rows[0];
      return result.status === 'EXACT' || result.status === 'PRODUCT_PROPOSED';
    }

    const plan = planSearch(snapshot.rows[index]);
    const canRecoverOnWeb = route === 'C' && typeof connectors.searchWeb === 'function';
    if (route !== 'A' && plan.lookups.length && await verify(plan.lookups.map(({ kind, value }) => ({ [kind]: value })))) continue;
    let accepted = false;
    for (const channel of routeChannels[route]) {
      const fn = channel === 'WEB' ? connectors.searchWeb : connectors.searchMcp;
      const budget = channel === 'MCP_TEXT' && canRecoverOnWeb ? Math.max(2, maxCallsPerRow - 2) : maxCallsPerRow;
      for (const variant of plan.queries) {
        if (calls >= budget || signal.aborted || blocked.has('MCP')) break;
        const candidates = await call(channel, fn, { ...variant, limit: candidateDepth });
        if (await verify(candidates)) {
          accepted = true;
          break;
        }
        if (!fn || blocked.has(provider(channel))) break;
      }
      if (accepted) break;
    }
    if (blocked.has('MCP') && !record.attempts.some(attempt => attempt.reason === blocked.get('MCP'))) {
      record.attempts.push({ channel: 'MCP_VERIFY', outcome: 'UNAVAILABLE', reason: blocked.get('MCP') });
    }
    if (record.candidateLocators.length && !record.cards.length) record.reason = 'CARD_VERIFICATION_UNAVAILABLE';
  }
  return { intake, evidence, result: match(policy, intake, evidence) };
}
