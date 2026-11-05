import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeRequest } from './intake.mjs';
import { runStrictWorkflow, runAnalogWorkflow } from './workflow.mjs';
import { loadRun, saveRun } from './run-store.mjs';
import { createHostTransport } from './host-transport.mjs';
import { createViConnectors } from './vi-connectors.mjs';
import { createWebConnector } from './web-connector.mjs';

const [input, outputDirectory, route, sessionFile, permissionFile] = process.argv.slice(2);
if (!input || !outputDirectory || !['A','B','C'].includes(route) || !sessionFile) {
  throw new Error('Usage: node src/run-core.mjs input.json output-directory A|B|C host-session.json [permission.json]');
}
const read = async path => JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,''));
const directory = resolve(outputDirectory);
await mkdir(directory,{recursive:true});
const policy = await read(new URL('../policy/vi.json',import.meta.url));
const transport = await createHostTransport(join(directory,'host'));
const connectors = { ...createViConnectors({...transport,session:await read(sessionFile)}),
  ...createWebConnector(transport) };
const limits = { deadlineMs: Number(process.env.VHM_HOST_DEADLINE_MS ?? 30_000) };
const prior = await loadRun(directory);
let run;
if (permissionFile) {
  if (!prior) throw new Error('Saved strict run is required for analog continuation');
  run = await runAnalogWorkflow({policy,strictRun:prior.run,permission:await read(permissionFile),route,connectors,...limits});
} else {
  if (prior) throw new Error('A checkpoint already exists. Resume it or choose a new request directory');
  const source = await read(input);
  const snapshot = source.rows?.[0]?.product ? source : normalizeRequest(source);
  run = await runStrictWorkflow({policy,snapshot,route,connectors,...limits});
}
const checkpoint = await saveRun(directory,run,prior?.revision??0);
await writeFile(join(directory,'result-'+checkpoint.revision+'.json'),JSON.stringify(run.result,null,2),{flag:'wx'});
console.log(JSON.stringify({requestId:run.intake.requestId,revision:checkpoint.revision,
 phase:run.phase,metrics:run.result.metrics,approvalNeeded:run.result.approvalNeeded}));
