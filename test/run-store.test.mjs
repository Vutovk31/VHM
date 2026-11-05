import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRun, saveRun } from '../src/run-store.mjs';
test('checkpoint preserves history and rejects stale concurrent or cross-request writes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vhm-checkpoint-'));
 const run={phase:'STRICT_COMPLETE',intake:{requestId:'r'},result:{requestId:'r'},evidence:{requestId:'r'}};
 try {
   assert.equal(await loadRun(directory),null);
   await saveRun(directory,run);
   const reads=await Promise.allSettled([saveRun(directory,{...run,phase:'STRICT_CLOSED'},1),saveRun(directory,run,1)]);
   assert.equal(reads.filter(r=>r.status==='fulfilled').length,1);
   assert.equal((await loadRun(directory)).revision,2);
   await assert.rejects(()=>saveRun(directory,run,1),/revision conflict/);
   assert.equal((await readdir(directory)).filter(n=>n.startsWith('revision-')).length,2);
   const other={phase:'STRICT_COMPLETE',intake:{requestId:'other'},result:{requestId:'other'},evidence:{requestId:'other'}};
   await assert.rejects(()=>saveRun(directory,other,2),/Request ID conflict/);
 } finally {
   await rm(directory,{recursive:true,force:true});
 }
});
