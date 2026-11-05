import { mkdir, readdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const phases = new Set(['STRICT_COMPLETE', 'STRICT_CLOSED', 'ANALOG_PROPOSALS_COMPLETE']);

export async function loadRun(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const revisions = entries.filter(name => /^revision-\d{8}\.json$/u.test(name)).sort();
  if (!revisions.length) return null;
  const record = JSON.parse(await readFile(join(directory, revisions.at(-1)), 'utf8'));
  if (record.revision !== Number(revisions.at(-1).slice(9,17)) || !phases.has(record.run?.phase)) {
    throw new Error('Invalid persisted run revision');
  }
  return record;
}

/** Saves immutable numbered checkpoints. The caller must supply the revision it read. */
export async function saveRun(directory, run, expectedRevision = 0) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 99_999_999 ||
      !phases.has(run?.phase) || !run?.intake?.requestId ||
      run.result?.requestId !== run.intake.requestId || run.evidence?.requestId !== run.intake.requestId) {
    throw new Error('Invalid workflow checkpoint');
  }
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.checkpoint-lock');
  const lock = await open(lockPath, 'wx');
  let pending;
  try {
    const current = await loadRun(directory);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Checkpoint revision conflict');
    if (current && current.run.intake.requestId !== run.intake.requestId) throw new Error('Request ID conflict');
    const record = { revision: expectedRevision + 1, at: new Date().toISOString(), run };
    const output = join(directory, 'revision-' + String(record.revision).padStart(8,'0') + '.json');
    pending = join(directory, '.pending-' + randomUUID());
    const handle = await open(pending, 'wx');
    try {
      await handle.writeFile(JSON.stringify(record, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, output);
    pending = null;
    return record;
  } finally {
    if (pending) await unlink(pending).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
