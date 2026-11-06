import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { normalizeRequest, parseRequestCsv } from './intake.mjs';
import { runStrictWorkflow, runAnalogWorkflow } from './workflow.mjs';
import { loadRun, saveRun } from './run-store.mjs';
import { createHostTransport } from './host-transport.mjs';
import { createViConnectors } from './vi-connectors.mjs';
import { createWebConnector } from './web-connector.mjs';
import { interpretThroughHost } from './host-normalization.mjs';
import { match } from './matcher.mjs';

const [input, outputDirectory, route, sessionFile, permissionFile] = process.argv.slice(2);
const approving = input === '--approve';
const exporting = input === '--export';
if (!input || !outputDirectory || (exporting ? route : approving ? !route || sessionFile : !['A','B','C'].includes(route) || !sessionFile)) {
  throw new Error('Usage: node src/run-core.mjs input.{json,csv,xlsx} output-directory A|B|C host-session.json [permission.json]\n' +
    '       node src/run-core.mjs --approve output-directory approval.json\n' +
    '       node src/run-core.mjs --export output-directory');
}
const read = async path => JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,''));
const directory = resolve(outputDirectory);
await mkdir(directory,{recursive:true});
const policy = await read(new URL('../policy/vi.json',import.meta.url));
const prior = await loadRun(directory);
async function exportRevision(checkpoint) {
  const { exportResult } = await import('./export.mjs');
  const reportDirectory = join(directory, 'report-' + checkpoint.revision);
  await mkdir(reportDirectory, { recursive: true });
  await exportResult(checkpoint.run.result, join(reportDirectory, 'report.xlsx'));
}
if (exporting) {
  if (!prior) throw new Error('Saved run required for export');
  await exportRevision(prior);
  process.exit(0);
}
let run;
if (approving) {
  const { revision, ...approval } = await read(route);
  const saved = prior?.run;
  if (saved?.phase === 'STRICT_COMPLETE' && saved.result.approvalNeeded.length) {
    throw new Error('Record the strict-only decision or finish analog discovery before approving a SKU');
  }
  const proposal = saved?.result.rows.find(row => row.key === approval.key);
  if (!prior || revision !== prior.revision || proposal?.approval !== 'PENDING' ||
      proposal.card?.siteProductId !== approval.siteProductId ||
      !Number.isFinite(Date.parse(approval.at))) {
    throw new Error('Approval must reference the current revision and its pending SKU');
  }
  const evidence = { ...saved.evidence, approvals: [...(saved.evidence.approvals ?? []), approval] };
  run = { ...saved, evidence, phase: 'PRODUCT_APPROVAL_RECORDED',
    result: match(policy, saved.intake, evidence) };
} else {
  const transport = await createHostTransport(join(directory,'host'));
  const session = await read(sessionFile);
  const connectors = { ...createViConnectors({...transport,session}),
    ...createWebConnector(transport) };
  const limits = { deadlineMs: Number(process.env.VHM_HOST_DEADLINE_MS ?? 30_000) };
  if (permissionFile) {
    if (!prior) throw new Error('Saved strict run is required for analog continuation');
    run = await runAnalogWorkflow({policy,strictRun:prior.run,permission:await read(permissionFile),route,connectors,...limits});
  } else {
    if (prior) throw new Error('A checkpoint already exists. Resume it or choose a new request directory');
    let snapshot;
    const extension = extname(input).toLowerCase();
    if (extension === '.csv') {
      const { requestId, city, delimiter } = session.input ?? {};
      const rows = parseRequestCsv(await readFile(input, 'utf8'), delimiter);
      snapshot = normalizeRequest({ requestId, city, policyVersion: policy.version, rows });
    } else if (extension === '.xlsx') {
      const { loadWorkbookIntake } = await import('./intake-xlsx.mjs');
      snapshot = await loadWorkbookIntake(input, { ...session.input, policyVersion: policy.version });
    } else {
      const source = await read(input);
      snapshot = source.rows?.[0]?.product ? source : normalizeRequest(source);
    }
    if (session.technicalNormalization === true) {
      snapshot = await interpretThroughHost(snapshot, transport, AbortSignal.timeout(300_000));
    }
    run = await runStrictWorkflow({policy,snapshot,route,connectors,...limits});
  }
}
const checkpoint = await saveRun(directory,run,prior?.revision??0);
await writeFile(join(directory,'result-'+checkpoint.revision+'.json'),
  JSON.stringify({ ...run.result, execution: run.execution },null,2),{flag:'wx'});
if (process.env.VHM_EXPORT_XLSX === '1') await exportRevision(checkpoint);
console.log(JSON.stringify({requestId:run.intake.requestId,revision:checkpoint.revision,
 phase:run.phase,metrics:run.result.metrics,approvalNeeded:run.result.approvalNeeded}));
