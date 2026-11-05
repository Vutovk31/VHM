import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const normalize = value => String(value ?? '').trim().toLowerCase().normalize('NFKC');
const present = value => typeof value === 'string' && value.trim() !== '';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const require = (condition, message) => { if (!condition) throw new Error(message); };

export function validatePolicy(policy) {
  require(/^\d+\.\d+\.\d+$/.test(policy.version), 'Invalid policy version');
  require(policy.catalogHost === 'vseinstrumenti.ru', 'Invalid VI domain');
  require(JSON.stringify(policy.route) === '["MCP","VI_SITE","WEB","MCP_VERIFY"]', 'Invalid pilot route');
  require(policy.transientRetries === 1 && policy.coverageTarget === 0.95, 'Invalid pilot limits');
  require(policy.preferredBrands.length && policy.preferredBrands.every(present) &&
    new Set(policy.preferredBrands.map(normalize)).size === policy.preferredBrands.length, 'Invalid preferred brands');
}

function verified(card, host) {
  if (card?.verification?.source !== 'MCP_VERIFY' || !present(card.verification.ref) ||
      !present(card.siteProductId) || !present(card.title)) return false;
  try {
    const url = new URL(card.url);
    return url.protocol === 'https:' && [host, 'www.' + host].includes(url.hostname) &&
      url.pathname.startsWith('/product/') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function checkRequirements(row, card, analog) {
  return row.requirements.every(requirement => {
    const check = card.checks?.[requirement.key];
    return present(check?.ref) && (check.status === 'PASS' ||
      (analog && requirement.replaceable === true && check.status === 'DEVIATION' && present(check.detail)));
  });
}

// Diagnostic only. Acceptance continues to use checkRequirements and exact below.
function candidateDiagnostics(policy, row, candidate, permit) {
  const reasons = [];
  const add = (code, field, actual, expected, ref = null) =>
    reasons.push({code, field, actual: actual ?? null, expected: expected ?? null, ref});
  if (!verified(candidate, policy.catalogHost)) add('VERIFICATION_MISSING', 'verification', candidate.verification?.source, 'MCP_VERIFY', candidate.verification?.ref);
  if (normalize(candidate.category) !== normalize(row.category)) add('CATEGORY_MISMATCH', 'category', candidate.category, row.category);
  if (candidate.stage === 'ANALOG' && !permit) add('ANALOG_PERMISSION_MISSING', 'stage', candidate.stage, 'EXACT');
  const analog = candidate.stage === 'ANALOG' && permit;
  if (!analog) for (const field of ['brand', 'model', 'mpn']) {
    if (present(row[field]) && normalize(row[field]) !== normalize(candidate[field]))
      add(present(candidate[field]) ? 'IDENTITY_MISMATCH' : 'IDENTITY_NOT_VERIFIED', field, candidate[field], row[field], candidate.verification?.ref);
  }
  for (const requirement of row.requirements) {
    const check = candidate.checks?.[requirement.key];
    const pass = present(check?.ref) && (check.status === 'PASS' ||
      (analog && requirement.replaceable === true && check.status === 'DEVIATION' && present(check.detail)));
    if (!pass) add(check?.status === 'FAIL' && present(check.ref) ? 'REQUIREMENT_MISMATCH' : 'REQUIREMENT_NOT_VERIFIED',
      requirement.key, check?.status, requirement.value, check?.ref);
  }
  if (row.kind === 'OPEN') {
    if (!present(candidate.model)) add('PROPOSAL_MODEL_MISSING', 'model', candidate.model, 'documented model');
    if (!present(candidate.assumptions)) add('PROPOSAL_ASSUMPTIONS_MISSING', 'assumptions', candidate.assumptions, 'explicit assumptions');
  }
  if (analog && !present(candidate.differences)) add('ANALOG_DIFFERENCES_MISSING', 'differences', candidate.differences, 'explicit differences');
  return {siteProductId: candidate.siteProductId ?? null, stage: candidate.stage ?? null,
    verificationRef: candidate.verification?.ref ?? null, reasons};
}

function quantityCheck(row, card) {
  const pack = card?.pack;
  const unknown = {status: 'NOT_VERIFIED', orderQuantity: null, excessQuantity: null};
  if (!present(pack?.ref) || !present(pack.orderUnit) || !present(pack.sourceUnit) ||
      !positive(pack.size) || !positive(row.quantity) ||
      normalize(row.unit) !== normalize(pack.sourceUnit) || present(row.quantityClarification)) return unknown;
  const multiple = pack.orderMultiple === undefined ? 1 : pack.orderMultiple;
  if (!Number.isSafeInteger(multiple) || multiple <= 0) return unknown;
  const count = Math.ceil(Number((row.quantity / pack.size / multiple).toPrecision(15))) * multiple;
  if (!Number.isSafeInteger(count) || count <= 0) return unknown;
  const supplied = count * pack.size;
  if (!Number.isFinite(supplied)) return unknown;
  const excessQuantity = Math.max(0, Number((supplied - row.quantity).toPrecision(15)));
  const hasExcess = excessQuantity > Math.max(supplied, row.quantity) * Number.EPSILON * 4;
  const evidence = {packSize: pack.size, orderUnit: pack.orderUnit, orderMultiple: multiple, ref: pack.ref};
  if (row.exactQuantity === true && hasExcess) {
    return {...unknown, ...evidence, status: 'EXACT_QUANTITY_CONFLICT',
      minimumOrderQuantity: count, excessQuantity};
  }
  return {...evidence, status: 'VERIFIED', orderQuantity: count, excessQuantity: hasExcess ? excessQuantity : 0};
}

function makeDecision(policy, row, record, permit, accepted, city) {
  const attempts = record.attempts ?? [];
  const cards = (record.cards ?? []).filter(card => verified(card, policy.catalogHost));
  const eligible = cards.filter(card => normalize(card.category) === normalize(row.category));
  const priority = card => present(card.vmtRef) ? 2 :
    Number(policy.preferredBrands.some(brand => normalize(brand) === normalize(card.brand)));
  const delivery = card => !present(row.deliveryClarification) && !!city && normalize(card?.delivery?.city) === normalize(city) &&
    card.delivery.status === 'CONFIRMED' && present(card.delivery.ref) &&
    positive(card.delivery.quantity) && quantityCheck(row, card).orderQuantity !== null &&
    card.delivery.quantity >= quantityCheck(row, card).orderQuantity;
  const price = card => !present(row.quoteClarification) && positive(card?.price?.amount) && card.price.currency === 'RUB' &&
    present(card.price.at) && present(card.price.ref) && present(card.price.orderUnit) &&
    normalize(card.price.orderUnit) === normalize(card.pack?.orderUnit) ? card.price.amount : null;
  const rank = (a, b) => priority(b) - priority(a) || Number(delivery(b)) - Number(delivery(a)) ||
    (price(a) ?? Infinity) - (price(b) ?? Infinity) || a.siteProductId.localeCompare(b.siteProductId);
  const exact = card => checkRequirements(row, card, false) &&
    ['brand', 'model', 'mpn'].every(key => !present(row[key]) || normalize(row[key]) === normalize(card[key]));
  let status = 'NOT_FOUND';
  let card;
  if (row.kind === 'CLARIFY') {
    status = 'CLARIFICATION_REQUIRED';
  } else if (row.kind === 'OPEN') {
    const proposals = eligible.filter(candidate => present(candidate.model) && present(candidate.assumptions) && checkRequirements(row, candidate, false)).sort(rank);
    card = accepted ? proposals.find(candidate => candidate.siteProductId === accepted.siteProductId) : proposals[0];
    if (card) status = 'PRODUCT_PROPOSED';
  } else {
    card = eligible.filter(candidate => candidate.stage !== 'ANALOG' && exact(candidate))
      .sort((a, b) => Number(delivery(b)) - Number(delivery(a)))[0];
    if (card) status = 'EXACT';
    if (permit && (!card || card.stock?.status === 'OUT_OF_STOCK' || accepted)) {
      const alternatives = eligible.filter(candidate => candidate.stage === 'ANALOG' && !exact(candidate) &&
        present(candidate.differences) && checkRequirements(row, candidate, true)).sort(rank);
      const alternative = accepted ? alternatives.find(candidate => candidate.siteProductId === accepted.siteProductId) : alternatives[0];
      if (alternative) {
        card = alternative;
        status = 'ANALOG_PROPOSED';
      }
    }
  }
  if (status === 'NOT_FOUND') {
    if ((record.cards ?? []).some(candidate => !verified(candidate, policy.catalogHost))) status = 'EXACT_UNVERIFIED';
    else if (!(record.cards ?? []).length && !attempts.some(attempt => attempt.outcome === 'RESULT' || attempt.outcome === 'MISS')) status = 'NOT_SEARCHED';
  }
  const proposed = ['ANALOG_PROPOSED', 'PRODUCT_PROPOSED'].includes(status);
  const approved = proposed && accepted?.siteProductId === card.siteProductId;
  if (accepted) require(approved, `Approval does not match an eligible proposal: ${row.key}`);
  const quantityVerification = quantityCheck(row, card);
  const quantity = quantityVerification.orderQuantity;
  const unitPrice = price(card);
  const approval = proposed ? (approved ? 'APPROVED' : 'PENDING') : 'NOT_REQUIRED';
  const supplyConfirmed = delivery(card) && !['CONFLICT', 'OUT_OF_STOCK'].includes(card?.stock?.status);
  return {
    ...row, sourceQuantity: row.quantity, status, approval, card: card ?? null, quantity, quantityVerification, unitPrice,
    amount: quantity !== null && unitPrice !== null && Number.isFinite(quantity * unitPrice)
      ? Math.round(quantity * unitPrice * 100) / 100 : null,
    stock: card?.stock?.status ?? 'UNKNOWN',
    delivery: supplyConfirmed ? 'CONFIRMED' : card?.delivery?.status === 'PICKUP_ONLY' &&
      !!city && normalize(card.delivery.city) === normalize(city) ? 'PICKUP_ONLY' : 'NOT_CONFIRMED',
    clientText: proposed ? `Предложен товар — ${card.title}, ${card.model ?? card.mpn ?? 'модель не указана'}` :
      status === 'EXACT' ? card.title : row.clarification ?? '',
    reason: card && !supplyConfirmed ? 'DELIVERY_UNVERIFIED' :
      status === 'CLARIFICATION_REQUIRED' ? 'MISSING_REQUIREMENTS' : record.reason ?? status,
    partial: attempts.some(attempt => ['ERROR', 'UNAVAILABLE'].includes(attempt.outcome)),
    candidateDiagnostics: (record.cards ?? []).map(candidate => ({
      ...candidateDiagnostics(policy, row, candidate, permit),
      selected: !!card && candidate === card,
    })),
    attempts,
  };
}

export function match(policy, intake, evidence) {
  validatePolicy(policy);
  require(present(intake.requestId) && intake.policyVersion === policy.version &&
    evidence.requestId === intake.requestId && evidence.policyVersion === policy.version, 'Request or policy mismatch');
  require(Array.isArray(intake.rows) && intake.rows.length > 0, 'Missing intake rows');
  const keys = new Set();
  for (const row of intake.rows) {
    require([row.key, row.group, row.text, row.category].every(present) && !keys.has(row.key), 'Invalid or duplicate source row');
    require(['STRICT', 'OPEN', 'CLARIFY'].includes(row.kind), 'Invalid row kind');
    require(Array.isArray(row.requirements) && row.requirements.every(item => present(item.key) && present(item.value)) &&
      new Set(row.requirements.map(item => item.key)).size === row.requirements.length, 'Invalid requirements');
    const identity = ['brand', 'model', 'mpn'].some(key => present(row[key]));
    require(row.kind !== 'STRICT' || identity || row.requirements.length > 0, 'Strict row needs requirements');
    require(row.kind !== 'OPEN' || !identity, 'Open row cannot have explicit identity');
    require(row.kind !== 'CLARIFY' || present(row.clarification), 'Clarification question missing');
    keys.add(row.key);
  }
  for (const key of Object.keys(evidence.rows ?? {})) require(keys.has(key), 'Evidence row not in intake');
  const permit = evidence.analogPermission;
  if (permit) {
    require(permit.requestId === intake.requestId && present(permit.by) && present(permit.at) &&
      ['STRICT_ONLY', 'ALLOW_ANALOG_DISCOVERY'].includes(permit.decision) &&
      Array.isArray(permit.keys) && permit.keys.every(key => keys.has(key)), 'Invalid analog permission');
  }
  const approvals = new Map();
  for (const approval of evidence.approvals ?? []) {
    require(approval.requestId === intake.requestId && keys.has(approval.key) && !approvals.has(approval.key) &&
      present(approval.siteProductId) && present(approval.by) && present(approval.at), 'Invalid product approval');
    approvals.set(approval.key, approval);
  }
  const rows = intake.rows.map(row => {
    const record = Object.hasOwn(evidence.rows ?? {}, row.key) ? evidence.rows[row.key] : {};
    const allowed = row.kind === 'STRICT' && permit?.decision === 'ALLOW_ANALOG_DISCOVERY' && permit.keys.includes(row.key);
    require(allowed || !(record.cards ?? []).some(card => card.stage === 'ANALOG'), `Analog discovery lacks permission: ${row.key}`);
    return makeDecision(policy, row, record, allowed, approvals.get(row.key), intake.city);
  });
  const groups = new Map();
  const procurement = [];
  const hunter = [];
  const approvalNeeded = [];
  for (const row of rows) {
    const closed = row.status === 'EXACT' || row.approval === 'APPROVED';
    groups.set(row.group, (groups.get(row.group) ?? true) && closed);
    if (closed && row.quantity && present(row.card.viCode)) {
      procurement.push(`${row.card.viCode} — ${row.card.title} — ${row.quantity} ${row.card.pack.orderUnit}`);
    }
    if (row.quantity && present(row.card?.title)) hunter.push(`${row.card.title} ${row.quantity} ${row.card.pack.orderUnit}`);
    if (row.kind === 'STRICT' && (row.status !== 'EXACT' || row.stock === 'OUT_OF_STOCK') &&
        permit?.decision !== 'STRICT_ONLY' && !permit?.keys.includes(row.key)) approvalNeeded.push(row.key);
  }
  const closedGroups = [...groups.values()].filter(Boolean).length;
  return {
    requestId: intake.requestId, policyVersion: policy.version, city: intake.city ?? '',
    remarks: intake.remarks ?? [], rows, procurement, hunter, approvalNeeded,
    metrics: {
      sourceRows: intake.rows.length, reportedRows: rows.length, groups: groups.size, closedGroups,
      coverage: closedGroups / groups.size, target: policy.coverageTarget,
      exact: rows.filter(row => row.status === 'EXACT').length,
      proposed: rows.filter(row => row.approval === 'PENDING').length,
      approved: rows.filter(row => row.approval === 'APPROVED').length,
      deliveryConfirmed: rows.filter(row => row.delivery === 'CONFIRMED').length,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [policy, intake, evidence, output] = process.argv.slice(2);
  const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  writeFileSync(output, JSON.stringify(match(read(policy), read(intake), read(evidence)), null, 2));
}
