import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const schema = JSON.parse(readFileSync(new URL('../schemas/vhm-policy.schema.json', import.meta.url), 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Evaluates the keywords used by this checked-in schema. A new keyword needs
// an explicit implementation so extending the schema never silently weakens validation.
function check(value, rule, path) {
  const keywords = ['type', 'const', 'enum', 'pattern', 'minimum', 'maximum', 'properties', 'required',
    'additionalProperties', 'minItems', 'maxItems', 'items', 'uniqueItems', '$ref', 'anyOf'];
  assert(Object.keys(rule).every(key => keywords.includes(key)), 'Unsupported schema keyword at ' + path);
  if (rule.$ref) {
    const name = rule.$ref.replace(/^#\/\$defs\//, '');
    assert(Object.hasOwn(schema.$defs, name), 'Unknown schema definition ' + rule.$ref);
    check(value, schema.$defs[name], path);
  }
  if (rule.anyOf) {
    const matches = rule.anyOf.some(option => {
      try {
        check(value, option, path);
        return true;
      } catch (error) {
        if (!error.message.startsWith(path + ':')) throw error;
        return false;
      }
    });
    assert(matches, path + ': no allowed variant');
  }
  const types = { object, array: Array.isArray, string: v => typeof v === 'string',
    integer: Number.isSafeInteger, null: v => v === null };
  if (rule.type) {
    assert(Object.hasOwn(types, rule.type), 'Unsupported schema type ' + rule.type);
    assert(types[rule.type](value), path + ': expected ' + rule.type);
  }
  if (Object.hasOwn(rule, 'const')) assert(isDeepStrictEqual(value, rule.const), path + ': protected value differs');
  if (rule.enum) assert(rule.enum.some(item => isDeepStrictEqual(item, value)), path + ': unknown value');
  if (rule.pattern) assert(new RegExp(rule.pattern, 'u').test(value), path + ': invalid format');
  if (rule.minimum !== undefined) assert(value >= rule.minimum, path + ': below minimum');
  if (rule.maximum !== undefined) assert(value <= rule.maximum, path + ': above maximum');
  if (rule.required) for (const key of rule.required) assert(Object.hasOwn(value, key), path + ': missing ' + key);
  if (rule.properties) {
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties, key)) check(entry, rule.properties[key], path + '.' + key);
      else assert(rule.additionalProperties !== false, path + ': unexpected ' + key);
    }
  }
  if (rule.items) {
    assert(value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? Infinity),
      path + ': invalid item count');
    if (rule.uniqueItems) assert(new Set(value).size === value.length, path + ': duplicate item');
    value.forEach((entry, index) => check(entry, rule.items, path + '[' + index + ']'));
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function contentHash(policy) {
  const { status, approval, ...content } = policy;
  const { actorId, parentRevision } = approval;
  const revision = { ...content, author: { actorId, parentRevision } };
  return createHash('sha256').update(JSON.stringify(canonical(revision))).digest('hex');
}

const providerFor = {
  MCP_TEXT: 'vi-mcp-codex',
  MCP_VERIFY: 'vi-mcp-codex',
  WEB_DOMAIN: 'codex-web-domain',
  WEB_DOMAIN_RECOVERY: 'codex-web-domain',
};

export function validateDraft(policy) {
  const { $schema, title, $defs, ...shape } = schema;
  check(policy, shape, '$');
  const { search, providers, approval, revision, status } = policy;
  assert(approval.parentRevision !== revision, 'Revision cannot be its own parent');
  for (const [name, steps] of Object.entries(search.routes)) {
    assert(steps.at(-2) === 'MCP_VERIFY' && steps.at(-1) === 'DETERMINISTIC_ACCEPTANCE',
      name + ': MCP verification must immediately precede deterministic acceptance');
    assert(steps.length - 1 <= search.maxCallsPerRow, name + ': provider step count exceeds call budget');
    const first = name === 'A' ? 'WEB_DOMAIN' : 'MCP_TEXT';
    assert(steps[0] === first, name + ': first discovery step must be ' + first);
    assert(name !== 'C' || steps.includes('WEB_DOMAIN_RECOVERY'), 'C: hybrid web recovery is required');
    assert(!steps.includes('WEB_DOMAIN_RECOVERY') || steps.indexOf('MCP_TEXT') === 0,
      name + ': web recovery needs earlier MCP discovery');
    for (const step of steps.slice(0, -1)) {
      assert(providers.includes(providerFor[step]), name + ': missing declared provider for ' + step);
    }
  }
  assert(!search.recovery.includes('VI_SITE') && !search.recovery.includes('YANDEX_AUTHORIZED'),
    'Direct catalog and Yandex providers have no verified capability profile');
  if (search.recovery.includes('WEB_DOMAIN')) {
    assert(providers.includes('codex-web-domain'), 'Domain recovery requires the web provider');
  }
  const hash = contentHash(policy);
  const reviewed = status === 'approved' || status === 'retired';
  if (reviewed) {
    assert(approval.reviewerId && approval.evidenceRef, 'Reviewed revision needs reviewer and evidence references');
    assert(approval.actorId.toLowerCase() !== approval.reviewerId.toLowerCase(), 'Reviewer must differ from author');
    assert(approval.approvedContentHash === hash, 'Review hash does not match policy content');
  } else {
    assert(!approval.reviewerId && !approval.evidenceRef && !approval.approvedContentHash,
      'Draft or validated revision cannot carry approval metadata');
  }
  return { revision, status, contentHash: hash };
}

export function compareDrafts(previous, next) {
  const from = validateDraft(previous);
  const to = validateDraft(next);
  const changes = [];

  function compare(before, after, path) {
    if (isDeepStrictEqual(before, after)) return;
    if (object(before) && object(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of [...keys].sort()) compare(before[key], after[key], path + '.' + key);
    } else {
      changes.push({ path, before: before ?? null, after: after ?? null });
    }
  }

  compare(previous, next, '$');
  return { from, to, changes, activated: false };
}

export function planRollback(current, previous) {
  const audit = compareDrafts(current, previous);
  assert(current.status === 'approved' && previous.status === 'approved', 'Rollback requires two approved revisions');
  assert(current.approval.parentRevision === previous.revision, 'Rollback target must be the approved parent revision');
  return { ...audit, operation: 'rollback-plan', ownerActionRequired: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...paths] = process.argv.slice(2);
  try {
    const count = ['validate', 'dry-run'].includes(command) ? 1 : ['diff', 'rollback-plan'].includes(command) ? 2 : 0;
    assert(count > 0 && paths.length === count,
      'Usage: node src/policy-draft.mjs validate|dry-run FILE or diff|rollback-plan FROM TO');
    const [first, second] = paths.map(path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
    let report;
    if (command === 'diff') report = compareDrafts(first, second);
    else if (command === 'rollback-plan') report = planRollback(first, second);
    else {
      report = { ...validateDraft(first), activated: false };
      if (command === 'dry-run') {
        report.routes = first.search.routes;
        report.candidateDepth = first.search.candidateDepth;
        report.maxCallsPerRow = first.search.maxCallsPerRow;
        report.deadlineMs = first.search.deadlineMs;
        report.providerCallsMade = 0;
        report.runtimeEvidence = 'NOT_VERIFIED';
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
