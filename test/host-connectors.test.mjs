import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import {createHostTransport} from '../src/host-transport.mjs';
import {createWebConnector} from '../src/web-connector.mjs';

test('host bridge correlates atomic responses and rejects unsupported calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vhm-host-'));
 try{
  const transport=await createHostTransport(dir);
  const signal=AbortSignal.timeout(2000);
  const pending=transport.invoke('search_products',{query:'бур',limit:4},{signal});
  let request;
  for(let i=0;i<30&&!request;i++){
   const filename=(await readdir(dir)).find(name=>name.endsWith('.request.json'));
   if(filename)request=JSON.parse(await readFile(join(dir,filename),'utf8'));
   else await setTimeout(10);
  }
  assert.ok(request);
  await writeFile(join(dir,'reply.tmp'),JSON.stringify({id:request.id,result:{structuredContent:{products:[]}}}));
  await rename(join(dir,'reply.tmp'),join(dir,request.id+'.response.json'));
  assert.deepEqual(await pending,{structuredContent:{products:[]}});
  await assert.rejects(()=>transport.invoke('delete_product',{}, {signal}),/Unsupported/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('web adapter preserves discovery provenance and filters credentials and foreign hosts',async()=>{
 const records=[];
 const connector=createWebConnector({persist:async r=>{records.push(r);return 'web#1'},
 invoke:async(method,args)=>{
  assert.equal(method,'web_search');
  assert.equal(args.query,'site:vseinstrumenti.ru AEG BFL18-0');
  return {structuredContent:{products:[
    {url:'https://www.vseinstrumenti.ru/product/a-10/'},
    {url:'https://evil.example/product/a-11/'},
    {url:'https://token@www.vseinstrumenti.ru/product/a-12/'},
    {url:'https://www.vseinstrumenti.ru/product/a-10/'},
  ]}};
 }});
 assert.deepEqual(await connector.searchWeb({query:'AEG BFL18-0'}),[{url:'https://www.vseinstrumenti.ru/product/a-10/'}]);
 assert.equal(records[0].source,'WEB_DOMAIN');
});
