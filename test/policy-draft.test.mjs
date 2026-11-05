import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareDrafts, contentHash, planRollback, validateDraft } from '../src/policy-draft.mjs';

const draft = () => JSON.parse(readFileSync(new URL('../config/vhm-policy.yaml', import.meta.url), 'utf8'));

function approve(policy) {
  policy.status = 'approved';
  policy.approval.reviewerId = 'owner';
  policy.approval.evidenceRef = 'docs/maestro.md';
  policy.approval.approvedContentHash = contentHash(policy);
  return policy;
}

test('draft loads and editable search limits produce an auditable diff', () => {
  const before = draft();
  const after = draft();
  after.search.candidateDepth = 8;
  const result = compareDrafts(before, after);
  assert.notEqual(result.from.contentHash, result.to.contentHash);
  assert.equal(result.activated, false);
  assert.deepEqual(result.changes, [{ path: '$.search.candidateDepth', before: 4, after: 8 }]);
});

test('rejects out-of-range limits and provider routes that bypass verification', () => {
  for (const change of [
    policy => { policy.search.candidateDepth = 0; },
    policy => { policy.search.candidateDepth = 21; },
    policy => { policy.search.deadlineMs = 999; },
    policy => { policy.search.regionId = 'unknown'; },
    policy => { policy.search.routes.C.splice(2, 1); },
    policy => { policy.search.routes.C.unshift('MCP_TEXT'); },
    policy => { policy.search.recovery.push('YANDEX_AUTHORIZED'); },
    policy => { policy.providers.pop(); },
    policy => { policy.providers.push('third-party'); },
    policy => { policy.commercial.preferredBrandIds.push('Tiyang'); },
    policy => { policy.matching.requireMcpCardVerification = false; },
    policy => { policy.approval.secret = 'inline-secret'; },
  ]) {
    const policy = draft();
    change(policy);
    assert.throws(() => validateDraft(policy));
  }
});

test('review hash binds revision and author and detects post-review modifications', () => {
  const policy = approve(draft());
  assert.equal(validateDraft(policy).status, 'approved');
  policy.search.candidateDepth = 5;
  assert.throws(() => validateDraft(policy), /hash/);
  policy.approval.approvedContentHash = contentHash(policy);
  policy.approval.reviewerId = policy.approval.actorId.toUpperCase();
  assert.throws(() => validateDraft(policy), /differ/);
});

test('rollback generates a read-only plan for the reviewed parent only', () => {
  const previous = approve(draft());
  const current = draft();
  current.revision = '0.2.0';
  current.approval.parentRevision = previous.revision;
  approve(current);
  const result = planRollback(current, previous);
  assert.equal(result.to.revision, previous.revision);
  assert.equal(result.activated, false);
  assert.throws(() => planRollback(current, draft()), /approved/);
  assert.throws(() => planRollback(previous, current), /parent/);
});
