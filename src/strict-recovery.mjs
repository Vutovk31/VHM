import { runStrictWorkflow, resumeStrictWorkflow } from './workflow.mjs';

const protectedReasons = new Set(['401','403','429','CAPTCHA','rate_limited']);
const transientReasons = new Set(['DEADLINE','PROVIDER_ERROR','upstream_unavailable','internal_error']);

export function validateRecoveryOptions(options = {}) {
  const maxCycles = options.maxCycles ?? 8;
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > 12 ||
      Object.keys(options).some(key => key !== 'maxCycles')) throw new Error('Invalid recovery options');
  return { maxCycles };
}

function progressSignature(run) {
  return JSON.stringify(run.result.strictRetryNeeded.map(key => {
    const progress = run.evidence.rows[key]?.searchProgress;
    return [key, progress?.completedQueries, progress?.checkedLocators, progress?.pendingCandidates];
  }));
}

/** Bounded strict cycles, with durable revision publication before the next call. */
export async function runAutomaticStrict({ strictRun, recovery, onRevision, ...options }) {
  const { maxCycles } = validateRecoveryOptions(recovery);
  if (typeof onRevision !== 'function') throw new Error('Durable revision callback required');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const cycles = [];
  const transientRetries = new Map();
  let previous = strictRun;
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    let run = previous
      ? await resumeStrictWorkflow({ ...options, strictRun: previous })
      : await runStrictWorkflow(options);
    const pending = new Set(run.result.strictRetryNeeded);
    const recent = [...pending].flatMap(key => run.evidence.rows[key].attempts
      .slice(previous?.evidence.rows[key]?.attempts.length ?? 0).map(attempt => ({ key, ...attempt })));
    let stopReason = pending.size ? null : 'STRICT_FINISHED';
    if (pending.size) {
      if (recent.some(attempt => protectedReasons.has(attempt.reason))) stopReason = 'SOURCE_BLOCKED';
      else if (recent.some(attempt => attempt.reason === 'CONNECTOR_NOT_CONFIGURED')) stopReason = 'CONNECTOR_UNAVAILABLE';
      else {
        const transientRows = new Set(recent.filter(attempt => transientReasons.has(attempt.reason)).map(attempt => attempt.key));
        for (const key of transientRows) transientRetries.set(key, (transientRetries.get(key) ?? 0) + 1);
        if ([...transientRows].some(key => transientRetries.get(key) > options.policy.transientRetries)) {
          stopReason = 'TRANSIENT_RETRY_EXHAUSTED';
        } else if (!transientRows.size && previous && progressSignature(run) === progressSignature(previous)) {
          stopReason = 'NO_PROGRESS';
        }
      }
      if (!stopReason && cycle === maxCycles) stopReason = 'CYCLE_BUDGET';
    }
    cycles.push({ cycle, elapsedMs: run.execution.elapsedMs,
      calls: run.execution.rowTimings.reduce((sum, row) => sum + row.calls, 0),
      remainingRows: pending.size, stopReason });
    run = { ...run, recovery: { scope: 'INVOCATION', startedAt,
      elapsedMs: performance.now() - started, totalCalls: cycles.reduce((sum, item) => sum + item.calls, 0),
      cycles: structuredClone(cycles), cycle, maxCycles, stopReason,
      remainingRows: [...pending], transientRetries: Object.fromEntries(transientRetries) } };
    await onRevision(run);
    if (stopReason) return run;
    previous = run;
  }
}
