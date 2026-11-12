import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readdir, readFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRequest } from '../src/intake.mjs';
import { runAutomaticStrict } from '../src/strict-recovery.mjs';
import { saveRun, loadRun } from '../src/run-store.mjs';

const policy=JSON.parse(readFileSync(new URL('../policy/vi.json',import.meta.url)));
const snapshot=normalizeRequest({requestId:'auto-recovery',policyVersion:policy.version,rows:[{
  text:'Бур Brand M1 специальный',category:'бур',brand:'Brand',model:'M1',quantity:1,unit:'шт',
  requirements:[{key:'mount',value:'SDS-plus'}],
}]});
const card={siteProductId:'10',title:'Бур Brand M1',category:'бур',brand:'Brand',model:'M1',
  url:'https://www.vseinstrumenti.ru/product/bur-10/',stage:'EXACT',
  checks:{mount:{status:'PASS',ref:'fixture#mount'}},verification:{source:'MCP_VERIFY',ref:'fixture#card'}};

test('one invocation advances the saved queue and persists each immutable revision',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vhm-auto-'));
  let revision=0;
  const queries=[];
  try {
    const run=await runAutomaticStrict({policy,snapshot,route:'B',maxCallsPerRow:2,connectors:{
      searchMcp:async({query})=>{queries.push(query);return queries.length===1?[]:[{siteProductId:'10'}];},
      verifyMcp:async()=>[card],
    },onRevision:async run=>{revision=(await saveRun(directory,run,revision)).revision;}});
    assert.equal(revision,2);
    assert.equal(run.result.rows[0].status,'EXACT');
    assert.equal(run.recovery.stopReason,'STRICT_FINISHED');
    assert.equal(run.recovery.totalCalls,3);
    assert.equal(run.recovery.cycles.length,2);
    assert.ok(run.recovery.elapsedMs>=run.recovery.cycles.reduce((sum,cycle)=>sum+cycle.elapsedMs,0));
    assert.equal(new Set(queries).size,2);
    assert.equal((await loadRun(directory)).run.digest,run.digest);
    const first=JSON.parse(readFileSync(join(directory,'revision-00000001.json')));
    assert.equal(first.run.result.rows[0].status,'SEARCH_INCOMPLETE');
    assert.equal(first.run.recovery.stopReason,null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('source protections stop automatic cycles without retrying restricted access',async()=>{
  for(const reason of ['401','403','429','CAPTCHA','rate_limited']) {
    let calls=0;
    const revisions=[];
    const run=await runAutomaticStrict({policy,snapshot,route:'B',connectors:{
      searchMcp:async()=>{calls++;throw Object.assign(new Error('restricted'),{code:reason});},
    },onRevision:async run=>revisions.push(run)});
    assert.equal(calls,1);
    assert.equal(revisions.length,1);
    assert.equal(run.recovery.stopReason,'SOURCE_BLOCKED');
    assert.equal(run.result.rows[0].status,'SEARCH_INCOMPLETE');
  }
});

test('temporary outage gets exactly one automatic retry and leaves an explicit checkpoint',async()=>{
  let calls=0;
  const run=await runAutomaticStrict({policy,snapshot,route:'B',connectors:{
    searchMcp:async()=>{calls++;throw new Error('offline');},
  },onRevision:async()=>{}});
  assert.equal(calls,2);
  assert.equal(run.recovery.stopReason,'TRANSIENT_RETRY_EXHAUSTED');
  assert.equal(run.result.rows[0].partial,true);
  assert.equal(run.result.rows[0].attempts.filter(a=>a.outcome==='ERROR').length,2);
});

test('persist failure stops before further outbound calls and invalid configuration fails before calls',async()=>{
  let calls=0;
  const options={policy,snapshot,route:'B',maxCallsPerRow:2,
    connectors:{searchMcp:async()=>{calls++;return [];}},
    onRevision:async()=>{throw new Error('disk full');}};
  await assert.rejects(()=>runAutomaticStrict({...options,recovery:{maxCycles:99}}),/Invalid recovery/);
  assert.equal(calls,0);
  await assert.rejects(()=>runAutomaticStrict(options),/disk full/);
  assert.equal(calls,2);
});

test('cycle budget keeps untried queries pending rather than reporting not found',async()=>{
  const run=await runAutomaticStrict({policy,snapshot,route:'B',maxCallsPerRow:2,
    recovery:{maxCycles:1},connectors:{searchMcp:async()=>[]},onRevision:async()=>{}});
  assert.equal(run.recovery.stopReason,'CYCLE_BUDGET');
  assert.equal(run.result.rows[0].status,'SEARCH_INCOMPLETE');
  assert.deepEqual(run.result.approvalNeeded,[]);
});

test('Core CLI completes multiple strict cycles through the real file transport in one invocation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vhm-cli-auto-'));
  const output=join(directory,'out');
  let child;
  try {
    await writeFile(join(directory,'input.json'),JSON.stringify({requestId:'cli-auto',policyVersion:policy.version,rows:[{
      text:'Бур Brand M1 специальный ABC123',category:'бур',brand:'Brand',model:'M1',mpn:'ABC123',
      quantity:1,unit:'шт',requirements:[{key:'mount',value:'SDS-plus'}],
    }]}));
    await writeFile(join(directory,'session.json'),JSON.stringify({summaryAccepted:true,instructionsVersion:'1.7.0'}));
    const env={...process.env,VHM_EXPORT_XLSX:'0',VHM_HOST_DEADLINE_MS:'5000'};
    child=spawn(process.execPath,['src/run-core.mjs',join(directory,'input.json'),output,'C',join(directory,'session.json')],
      {cwd:new URL('..',import.meta.url),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',closed=false;
    child.stdout.on('data',data=>stdout+=data);
    child.stderr.on('data',data=>stderr+=data);
    const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{closed=true;resolve(code);});});
    const handled=new Set(),queries=[];
    const deadline=Date.now()+15000;
    while(!closed && Date.now()<deadline) {
      let files=[];
      try {files=await readdir(join(output,'host'));} catch(error) {if(error.code!=='ENOENT') throw error;}
      for(const file of files.filter(file=>file.endsWith('.request.json')&&!handled.has(file))) {
        const request=JSON.parse(await readFile(join(output,'host',file),'utf8'));
        assert.ok(['search_products','web_search'].includes(request.method));
        queries.push(JSON.stringify([request.method,request.args.query]));
        const pending=join(output,'host',request.id+'.test-pending');
        await writeFile(pending,JSON.stringify({id:request.id,result:{structuredContent:{products:[]}}}));
        await rename(pending,join(output,'host',request.id+'.response.json'));
        handled.add(file);
      }
      await delay(10);
    }
    assert.equal(closed,true,'CLI did not finish within fixture deadline');
    assert.equal(await completion,0,stderr);
    const summary=JSON.parse(stdout.trim());
    assert.ok(summary.revision>=2);
    assert.equal(summary.recovery.stopReason,'STRICT_FINISHED');
    assert.equal(queries.length,new Set(queries).size);
    const saved=await loadRun(output);
    assert.equal(saved.run.result.rows.length,1);
    assert.equal(saved.run.result.rows[0].status,'NOT_FOUND');
    assert.equal(saved.run.result.strictRetryNeeded.length,0);
    assert.ok(readFileSync(join(output,'result-1.json'),'utf8').includes('SEARCH_INCOMPLETE'));
  } finally {if(child && child.exitCode===null) child.kill();await rm(directory,{recursive:true,force:true});}
});
