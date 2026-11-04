import { readFileSync } from 'node:fs';

const [goldenPath, ...resultPaths] = process.argv.slice(2);
if (!goldenPath || resultPaths.length !== 3) {
  throw new Error('Usage: node src/benchmark.mjs golden.json A/result.json B/result.json C/result.json');
}
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const golden = read(goldenPath);
const expectedKeys = Object.keys(golden.rows);
const increment = (map, key) => map[key] = (map[key] ?? 0) + 1;

const strategies = resultPaths.map((path, index) => {
  const result = read(path);
  const keys = new Set(result.rows.map(row => row.key));
  if (result.requestId !== golden.requestId || result.policyVersion !== golden.policyVersion ||
      result.rows.length !== expectedKeys.length || expectedKeys.some(key => !keys.has(key))) {
    throw new Error('Benchmark run does not cover the same request, rows and policy: ' + path);
  }
  const falseExact = [];
  const missedGroups = new Map();
  const channelYield = Object.create(null);
  let calls = 0;
  for (const row of result.rows) {
    const validExact = row.status === 'EXACT' && golden.rows[row.key].exactIds.includes(row.card.siteProductId);
    if (row.status === 'EXACT' && !validExact) falseExact.push(row.key);
    if (!(validExact || row.approval === 'APPROVED')) {
      const reasons = missedGroups.get(row.group) ?? new Set();
      reasons.add(row.status === 'EXACT' ? 'FALSE_EXACT' : row.reason);
      missedGroups.set(row.group, reasons);
    }
    if (validExact) {
      const first = row.attempts.find(attempt => attempt.channel !== 'MCP_VERIFY' &&
        attempt.outcome === 'RESULT' && attempt.ids?.includes(row.card.siteProductId));
      increment(channelYield, first?.channel ?? 'UNATTRIBUTED');
    }
    calls += row.attempts.length;
  }
  const missingByReason = Object.create(null);
  for (const reasons of missedGroups.values()) for (const reason of reasons) increment(missingByReason, reason);
  return { strategy: 'ABC'[index], ...result.metrics,
    coverage: (result.metrics.groups - missedGroups.size) / result.metrics.groups,
    falseExact, calls, missingByReason, channelYield };
});
const winner = strategies.filter(item => item.falseExact.length === 0)
  .sort((a, b) => b.coverage - a.coverage || a.calls - b.calls ||
    Number(b.strategy === 'B') - Number(a.strategy === 'B'))[0];
console.log(JSON.stringify({ strategies, winner: winner?.strategy ?? null,
  targetMet: !!winner && winner.coverage >= winner.target }, null, 2));
