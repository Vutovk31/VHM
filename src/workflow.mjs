import { match, verified } from './matcher.mjs';
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
  analogKeys = null, strictKeys = null, maxCallsPerRow = 8, deadlineMs = 30_000, candidateDepth = 4 }) {
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
  const verifiedDuplicates = new Map();

  for (let index = 0; index < intake.rows.length; index++) {
    const row = intake.rows[index];
    if (analogKeys && !analogKeys.has(row.key)) continue;
    if (strictKeys && !strictKeys.has(row.key)) continue;
    const record = evidence.rows[row.key] ??= { attempts: [], cards: [], candidateLocators: [] };
    record.candidateLocators ??= [];
    if (row.kind === 'CLARIFY' && !snapshot.rows[index].analysis?.category) continue;
    const signal = AbortSignal.timeout(deadlineMs);
    const seenLocators = new Set();
    const seenCards = new Set();
    let calls = 0;
    const rowStarted = performance.now();
    const searchPlan = analogKeys ? null : planSearch(snapshot.rows[index]);
    const queryKey = (channel, variant) => JSON.stringify([channel, variant.strategy, variant.query]);
    const plannedQueries = analogKeys ? [] : routeChannels[route].flatMap(channel =>
      searchPlan.queries.map(variant => queryKey(channel, variant)));
    const planDigest = analogKeys ? null : createHash('sha256').update(JSON.stringify([
      route, searchPlan, row.requirements, candidateDepth,
    ])).digest('hex');
    let progress = null;
    if (!analogKeys) {
      if (record.searchProgress && (record.searchProgress.version !== 1 ||
          record.searchProgress.planDigest !== planDigest)) {
        throw new Error('Saved search plan does not match the current requirements or depth');
      }
      progress = record.searchProgress ??= {
        version: 1, planDigest, status: 'PENDING',
        completedQueries: record.attempts.filter(attempt =>
          routeChannels[route].includes(attempt.channel) && ['RESULT', 'MISS'].includes(attempt.outcome))
          .map(attempt => queryKey(attempt.channel, attempt)),
        checkedLocators: record.candidateLocators.filter(locator => record.cards.some(card =>
          verified(card, policy.catalogHost) &&
          Object.entries(locator).every(([key, value]) => card[key] === value))),
        pendingCandidates: [],
      };
      for (const locator of record.candidateLocators) {
        if (!progress.checkedLocators.some(checked => JSON.stringify(checked) === JSON.stringify(locator)) &&
            !progress.pendingCandidates.some(pending => JSON.stringify(pending) === JSON.stringify(locator))) {
          progress.pendingCandidates.push(locator);
        }
      }
      for (const locator of progress.checkedLocators) seenLocators.add(JSON.stringify(locator));
      for (const card of record.cards) if (verified(card, policy.catalogHost)) seenCards.add(card.siteProductId);
    }
    const duplicateKey = !analogKeys && row.kind === 'STRICT' ? JSON.stringify([
      row.category, row.brand, row.model, row.mpn, searchPlan,
      row.requirements.map(({ sources, ...requirement }) => requirement),
    ]) : null;

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
      for (const locator of locators) {
        if (!record.candidateLocators.some(saved => JSON.stringify(saved) === JSON.stringify(locator))) {
          record.candidateLocators.push(locator);
        }
      }
      if (progress) for (const locator of locators) {
        if (!progress.pendingCandidates.some(pending => JSON.stringify(pending) === JSON.stringify(locator))) {
          progress.pendingCandidates.push(locator);
        }
      }
      if (!locators.length) return false;
      const ids = locators.filter(locator => locator.siteProductId);
      const batches = [...(ids.length ? [ids] : []), ...locators.filter(locator => !locator.siteProductId).map(locator => [locator])];
      const cards = [];
      for (const candidates of batches) {
        const response = await call('MCP_VERIFY', connectors.verifyMcp, { candidates,
          requirements: row.requirements, limit: candidates.length });
        cards.push(...response);
        const outcome = record.attempts.at(-1).outcome;
        if (progress && ['RESULT', 'MISS'].includes(outcome)) {
          for (const locator of candidates) {
            if (response.length && !response.some(card => verified(card, policy.catalogHost) &&
                Object.entries(locator).every(([key, value]) => card[key] === value))) continue;
            const locatorKey = JSON.stringify(locator);
            progress.checkedLocators.push(locator);
            progress.pendingCandidates = progress.pendingCandidates.filter(pending =>
              JSON.stringify(pending) !== locatorKey);
          }
        }
        if (calls >= maxCallsPerRow || signal.aborted || blocked.has('MCP')) break;
      }
      for (const card of cards.slice(0, locators.length)) {
        if (!card || (!analogKeys && card.stage === 'ANALOG') || seenCards.has(card.siteProductId)) continue;
        if (!locators.some(locator => Object.entries(locator).every(([key, value]) => card[key] === value))) continue;
        if (verified(card, policy.catalogHost)) seenCards.add(card.siteProductId);
        const typed = row.requirements.filter(requirement => requirement.test);
        const checks = typed.length && text(card.verification?.ref) ? evaluateCharacteristics(
          typed, card.characteristics ?? [], card.verification.ref) : {};
        const deviations = [];
        if (analogKeys) {
          for (const requirement of typed) {
            if (requirement.replaceable === true && checks[requirement.key]?.status === 'FAIL') {
              const facts = JSON.parse(checks[requirement.key].detail);
              const actual = facts.map(fact => [fact.value, fact.unit].filter(text).join(' ')).join(', ');
              deviations.push(`${requirement.field}: требуется ${requirement.value}, в карточке ${actual}`);
              checks[requirement.key] = { ...checks[requirement.key], status: 'DEVIATION',
                detail: JSON.stringify({ required: requirement.value, actual: checks[requirement.key].detail }) };
            }
          }
        }
        record.cards.push({ ...card, stage: analogKeys ? 'ANALOG' : card.stage,
          ...(analogKeys && deviations.length && ['brand', 'model', 'mpn'].every(key => !text(row[key]) || text(card[key])) ? {
            differences: [
              ...deviations,
              ...['brand', 'model', 'mpn'].filter(key => text(row[key]) && row[key] !== card[key])
                .map(key => `${{brand:'Бренд',model:'Модель',mpn:'Артикул'}[key]}: ${row[key]} → ${card[key]}`),
            ].join('\n'),
          } : {}),
          ...(row.kind === 'OPEN' && text(card.model ?? card.observedModel) ? {
            model: card.model ?? card.observedModel,
            assumptions: card.assumptions || 'Модель и характеристики, которые не заданы в заявке, выбраны по карточке ВИ.',
          } : {}),
          checks: { ...card.checks, ...checks } });
      }
      const result = match(policy, intake, evidence).rows[index];
      return analogKeys ? result.status === 'ANALOG_PROPOSED' :
        result.status === 'EXACT' || result.status === 'PRODUCT_PROPOSED';
    }

    try {
      const previous = duplicateKey && verifiedDuplicates.get(duplicateKey);
      if (previous) {
        record.cards.push(...structuredClone(previous.cards));
        record.candidateLocators.push(...structuredClone(previous.candidateLocators));
        record.attempts.push({ channel: 'REUSED_VERIFICATION', phase: 'STRICT', outcome: 'RESULT',
          sourceRowKey: previous.key, ids: previous.cards.map(card => card.siteProductId),
          refs: previous.cards.map(card => card.verification?.ref).filter(text) });
        continue;
      }
      const plan = analogKeys ? {
        lookups: [], queries: [{ strategy: 'ANALOG_REQUIRED_ATTRIBUTES',
          query: [row.category, ...row.requirements.filter(r => !r.replaceable).map(r => r.value)].join(' ') }],
      } : searchPlan;
      const canRecoverOnWeb = route === 'C' && typeof connectors.searchWeb === 'function';
      if (progress?.pendingCandidates.length) {
        let acceptedPending = false;
        while (progress.pendingCandidates.length) {
          const pendingCount = progress.pendingCandidates.length;
          if (await verify([...progress.pendingCandidates])) {
            acceptedPending = true;
            break;
          }
          if (calls >= maxCallsPerRow || signal.aborted || blocked.has('MCP') ||
              progress.pendingCandidates.length >= pendingCount) break;
        }
        if (acceptedPending || progress.pendingCandidates.length) continue;
      }
      if (route !== 'A' && plan.lookups.length && await verify(plan.lookups.map(({ kind, value }) => ({ [kind]: value })))) continue;
      let accepted = false;
      for (const channel of routeChannels[route]) {
        const fn = channel === 'WEB' ? connectors.searchWeb : connectors.searchMcp;
        const budget = channel === 'MCP_TEXT' && canRecoverOnWeb ? Math.max(2, maxCallsPerRow - 2) : maxCallsPerRow;
        for (const variant of plan.queries) {
          if (progress?.completedQueries.includes(queryKey(channel, variant))) continue;
          if (calls >= budget || signal.aborted || blocked.has('MCP')) break;
          const candidates = await call(channel, fn, { ...variant, limit: candidateDepth });
          if (progress && ['RESULT', 'MISS'].includes(record.attempts.at(-1).outcome)) {
            progress.completedQueries.push(queryKey(channel, variant));
          }
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
      else if (record.reason === 'CARD_VERIFICATION_UNAVAILABLE') delete record.reason;
    } finally {
      if (progress) {
        const decision = match(policy, intake, evidence).rows[index];
        const accepted = decision.status === 'EXACT' || decision.status === 'PRODUCT_PROPOSED';
        const queriesComplete = plannedQueries.every(key => progress.completedQueries.includes(key));
        progress.status = accepted || (queriesComplete && !progress.pendingCandidates.length)
          ? 'COMPLETE' : 'PENDING';
      }
      if (duplicateKey && calls > 0) {
        const decision = match(policy, intake, evidence).rows[index];
        const hasOrderSpecificEvidence = record.cards.some(card => card.delivery || card.price);
        if (decision.status === 'EXACT' && !decision.partial && decision.stock !== 'OUT_OF_STOCK' &&
            !hasOrderSpecificEvidence) {
          verifiedDuplicates.set(duplicateKey, {
            key: row.key, cards: record.cards, candidateLocators: record.candidateLocators,
          });
        }
      }
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

export async function resumeStrictWorkflow({ strictRun, ...options }) {
  const { policy } = options;
  if (strictRun?.phase !== 'STRICT_COMPLETE' ||
      strictRun.digest !== runDigest(policy, strictRun.intake, strictRun.evidence)) {
    throw new Error('A verified strict revision with the same policy is required');
  }
  const { strictRetryNeeded } = match(policy, strictRun.intake, strictRun.evidence);
  if (!strictRetryNeeded.length) throw new Error('No incomplete strict rows to resume');
  const evidence = structuredClone(strictRun.evidence);
  const run = await executeWorkflow({ ...strictRun.execution?.limits, ...options, snapshot: strictRun.snapshot, intake: strictRun.intake,
    evidence, route: evidence.route, strictKeys: new Set(strictRetryNeeded) });
  return { ...run, snapshot: strictRun.snapshot, phase: 'STRICT_COMPLETE',
    previousStrictDigest: strictRun.digest, digest: runDigest(policy, run.intake, run.evidence) };
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
