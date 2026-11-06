import { match } from './matcher.mjs';
import { planSearch } from './search-plan.mjs';
import { evaluateCharacteristics } from './technical-checks.mjs';
import { createHash } from 'node:crypto';

const text = value => typeof value === 'string' && value.trim() !== '';
const routeChannels = {
  A: ['WEB'], B: ['MCP_TEXT'], C: ['MCP_TEXT', 'WEB'],
};
const provider = channel => channel === 'WEB' ? 'WEB' : 'MCP';

export function matcherRow(row) {
  const { brand, model, mpn, viCode, siteProductId, series } = row.product;
  const category = row.product.category || row.analysis?.category?.value;
  const kind = row.interpretation?.mode ?? row.original?.kind;
  const requirements = [...row.requirements];
  const clarify = !text(category) || requirements.length === 0 || kind === 'CLARIFY';
  for (const [key, value] of Object.entries({ viCode, siteProductId, series })) {
    if (text(value) && !requirements.some(requirement => requirement.key === key)) {
      requirements.push(key === 'series' ? { key, value } : {
        key, value, field: key === 'viCode' ? '@viCode' : '@siteProductId',
        test: { kind: 'text', expected: value },
      });
    }
  }
  return {
    ...row, category: category || 'UNCLASSIFIED', group: row.group || category || 'UNCLASSIFIED',
    brand, model, mpn, requirements,
    kind: clarify ? 'CLARIFY' : kind === 'OPEN' && ![brand, model, mpn, viCode, siteProductId].some(text) ? 'OPEN' : 'STRICT',
    clarification: clarify ? row.interpretation?.question || row.original?.clarification || (!text(category)
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
async function executeWorkflow({ policy, snapshot, intake, evidence, route, connectors = {},
  analogKeys = null, maxCallsPerRow = 8, deadlineMs = 30_000, candidateDepth = 4 }) {
  if (!Object.hasOwn(routeChannels, route)) throw new Error('Invalid search route');
  boundedValue(maxCallsPerRow, 2, 12, 'call budget');
  boundedValue(deadlineMs, 1, 60_000, 'deadline');
  boundedValue(candidateDepth, 1, 20, 'candidate depth');
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();
  const rowTimings = [];

  for (const row of intake.rows) {
    evaluateCharacteristics(row.requirements.filter(requirement => requirement.test), [], 'requirement-validation');
  }
  match(policy, intake, evidence); // Validate the whole request before outbound calls.
  const blocked = new Map();

  for (let index = 0; index < intake.rows.length; index++) {
    const row = intake.rows[index];
    if (analogKeys && !analogKeys.has(row.key)) continue;
    const record = evidence.rows[row.key] ??= { attempts: [], cards: [], candidateLocators: [] };
    record.candidateLocators ??= [];
    if (row.kind === 'CLARIFY' && !snapshot.rows[index].analysis?.category) continue;
    const signal = AbortSignal.timeout(deadlineMs);
    const seenLocators = new Set();
    const seenCards = new Set();
    let calls = 0;
    const rowStarted = performance.now();

    async function call(channel, fn, payload) {
      const attempt = { channel, phase: analogKeys ? 'ANALOG' : 'STRICT', at: new Date().toISOString(), city: intake.city, ...payload };
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
        if (attempt.reason !== 'DEADLINE') blocked.set(provider(channel), attempt.reason);
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
      const ids = locators.filter(locator => locator.siteProductId);
      const batches = [...(ids.length ? [ids] : []), ...locators.filter(locator => !locator.siteProductId).map(locator => [locator])];
      const cards = [];
      for (const candidates of batches) {
        cards.push(...await call('MCP_VERIFY', connectors.verifyMcp, { candidates,
          requirements: row.requirements, limit: candidates.length }));
        if (calls >= maxCallsPerRow || signal.aborted || blocked.has('MCP')) break;
      }
      for (const card of cards.slice(0, locators.length)) {
        if (!card || (!analogKeys && card.stage === 'ANALOG') || seenCards.has(card.siteProductId)) continue;
        if (!locators.some(locator => Object.entries(locator).every(([key, value]) => card[key] === value))) continue;
        seenCards.add(card.siteProductId);
        const typed = row.requirements.filter(requirement => requirement.test);
        const checks = typed.length && text(card.verification?.ref) ? evaluateCharacteristics(
          typed, card.characteristics ?? [], card.verification.ref) : {};
        if (analogKeys) {
          for (const requirement of typed) {
            if (requirement.replaceable === true && checks[requirement.key]?.status === 'FAIL') {
              checks[requirement.key] = { ...checks[requirement.key], status: 'DEVIATION',
                detail: JSON.stringify({ required: requirement.value, actual: checks[requirement.key].detail }) };
            }
          }
        }
        record.cards.push({ ...card, stage: analogKeys ? 'ANALOG' : card.stage,
          checks: { ...card.checks, ...checks } });
      }
      const result = match(policy, intake, evidence).rows[index];
      return analogKeys ? result.status === 'ANALOG_PROPOSED' :
        result.status === 'EXACT' || result.status === 'PRODUCT_PROPOSED';
    }

    try {
      const plan = analogKeys ? {
        lookups: [], queries: [{ strategy: 'ANALOG_REQUIRED_ATTRIBUTES',
          query: [row.category, ...row.requirements.filter(r => !r.replaceable).map(r => r.value)].join(' ') }],
      } : planSearch(snapshot.rows[index]);
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
    } finally {
      rowTimings.push({ key: row.key, elapsedMs: performance.now() - rowStarted, calls });
    }
  }
  const result = match(policy, intake, evidence);
  return { intake, evidence, result, execution: {
    startedAt, elapsedMs: performance.now() - runStarted,
    limits: { maxCallsPerRow, deadlineMs, candidateDepth }, rowTimings,
  } };
}

function runDigest(policy, intake, evidence) {
  return createHash('sha256').update(JSON.stringify({ policy, intake, evidence })).digest('hex');
}

export async function runStrictWorkflow(options) {
  const { policy, snapshot, route } = options;
  const intake = { ...snapshot, rows: snapshot.rows.map(matcherRow) };
  const evidence = { requestId: intake.requestId, policyVersion: intake.policyVersion,
    route, rows: Object.create(null) };
  const run = await executeWorkflow({ ...options, intake, evidence });
  return { ...run, snapshot, phase: 'STRICT_COMPLETE',
    digest: runDigest(policy, run.intake, run.evidence) };
}

/** Continues a completed strict run only for explicitly authorized unresolved rows. */
export async function runAnalogWorkflow({ strictRun, permission, ...options }) {
  const { policy } = options;
  if (strictRun?.phase !== 'STRICT_COMPLETE' ||
      strictRun.digest !== runDigest(policy, strictRun.intake, strictRun.evidence)) {
    throw new Error('A verified strict run with the same policy is required');
  }
  const strictResult = match(policy, strictRun.intake, strictRun.evidence);
  if (!permission || permission.requestId !== strictResult.requestId ||
      permission.strictDigest !== strictRun.digest || !text(permission.by) ||
      !text(permission.at) || !Number.isFinite(Date.parse(permission.at)) ||
      !['STRICT_ONLY', 'ALLOW_ANALOG_DISCOVERY'].includes(permission.decision) ||
      !Array.isArray(permission.keys) || new Set(permission.keys).size !== permission.keys.length ||
      permission.keys.some(key => !strictResult.approvalNeeded.includes(key))) {
    throw new Error('Invalid or stale scoped analog permission');
  }
  const evidence = structuredClone(strictRun.evidence);
  evidence.analogPermission = structuredClone(permission);
  if (permission.decision === 'STRICT_ONLY' || !permission.keys.length) {
    return { ...strictRun, evidence, phase: 'STRICT_CLOSED', result: match(policy, strictRun.intake, evidence) };
  }
  const run = await executeWorkflow({ ...options, snapshot: strictRun.snapshot, intake: strictRun.intake,
    evidence, route: options.route ?? strictRun.evidence.route, analogKeys: new Set(permission.keys) });
  return { ...run, snapshot: strictRun.snapshot, phase: 'ANALOG_PROPOSALS_COMPLETE',
    strictDigest: strictRun.digest };
}
