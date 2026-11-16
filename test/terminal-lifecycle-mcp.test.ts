import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { unifiedExecManager, flushTerminalResults, restoreTerminalResults } from '../src/main/codex/manager.js';
import { resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import { inFlightToolCalls } from '../src/main/mcp/call-context.js';

let dir = '', endpoint: McpEndpoint | null = null, rpc = 0;
afterEach(async () => {
  await endpoint?.stop(); endpoint = null;
  await unifiedExecManager.terminateAllProcesses(); resetExecOwnershipForTests(); resetRecorderForTests();
  resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = '';
});
async function serve() {
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-lifecycle-')), []);
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  const cfg = defaultConfig(), roots = [{ name: 'probe', path: dir }];
  await saveConfig({ ...cfg, roots, readOnly: false, multiAgent: { ...cfg.multiAgent, allowUnattributedCalls: true } });
  await fs.writeFile(path.join(dir, 'probe.cjs'), `
const fs=require('node:fs'); const [mode,key]=process.argv.slice(2);
if(mode==='short'){console.log('OUT-'+key+'-α-🚀');console.error('ERR-'+key);process.exit(Number(key.split('-')[1])%17===0?7:0);}
else { console.log('START-'+key); let middle=false;
 const timer=setInterval(()=>{if(fs.existsSync('middle-'+key)&&!middle){middle=true;console.log('MIDDLE-'+key);}
 if(fs.existsSync('release-'+key)){console.log('FINISH-'+key);clearInterval(timer);}},25); }
`);
  endpoint = await startMcpServer(() => ({ roots, caps: cfg.capabilities, readOnly: false, sessionTools: false, agentTools: false }));
}
function request(client: string, name: string, args: Record<string, unknown>, requestId?: string, signal?: AbortSignal) {
  return fetch(endpoint!.url, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(requestId ? { 'x-request-id': requestId+'/hop' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': client } } }) });
}
async function call(client: string, name: string, args: Record<string, unknown>, requestId?: string) {
  const response = await request(client, name, args, requestId); expect(response.status).toBe(200);
  const raw = await response.text(); const data = raw.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
  const body = JSON.parse(data || raw); expect(body.error, raw).toBeUndefined(); return body.result as any;
}
const text = (r: any) => r.content?.filter((c: any) => c.type==='text').map((c: any) => c.text).join('\n') ?? '';
const success = (r: any) => expect(r.isError, text(r)).not.toBe(true);

it('runs 200 real commands across four concurrent HTTP clients while three live commands retain output, then reconnects with exact capabilities', async () => {
  await serve(); const long = [];
  for (let n=0;n<3;n++) {
    const r=await call('long-'+n,'exec_command',{cmd:`node probe.cjs long ${n}`,workdir:'/probe',yield_time_ms:1},'wfr_long_'+n);
    success(r); expect(r.structuredContent.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/); long.push(r.structuredContent);
  }
  const launched = Date.now(), seen = new Set<string>();
  await Promise.all(Array.from({length:4},(_,client)=>(async()=>{
    for(let n=0;n<50;n++) {
      const key=client+'-'+n, r=await call('short-client-'+client,'exec_command',{cmd:`node probe.cjs short ${key}`,workdir:'/probe',yield_time_ms:10000});
      success(r); expect(r.structuredContent.output).toContain('OUT-'+key+'-α-🚀'); expect(r.structuredContent.output).toContain('ERR-'+key);
      expect(r.structuredContent.exit_code).toBe(n%17===0?7:0); expect(r.structuredContent.session_id).toBeUndefined(); seen.add(key);
    }
  })()));
  expect(seen.size).toBe(200); expect(Date.now()-launched).toBeGreaterThan(0);
  const status=await call('observer','terminal_sessions',{action:'status'}); success(status);
  const capacity=JSON.parse(text(status)); expect(capacity.running).toBe(3); expect(capacity.activeUsed).toBe(3);
  expect(capacity.exitedRetained).toBeLessThanOrEqual(128); expect(capacity.completedBytes).toBeLessThanOrEqual(16*1024*1024);
  expect(text(status)).not.toContain('session_token'); expect(text(status)).not.toContain('probe.cjs');
  for(let n=0;n<3;n++) {
    const session=long[n], pair={session_id:session.session_id,session_token:session.session_token};
    const refused=await call('different-client','write_stdin',{session_id:pair.session_id,chars:''},'wfr_missing_'+n);
    expect(text(refused)).toContain('EXEC_SESSION_TOKEN_REQUIRED');
    const wrong=await call('different-client','terminal_sessions',{action:'cleanup',scope:'selected',discard_output:true,sessions:[{...pair,session_token:'x'.repeat(43)}]},'wfr_wrong_'+n);
    expect(text(wrong)).toContain('OWNER_MISMATCH');
    const liveCleanup=await call('long-'+n,'terminal_sessions',{action:'cleanup',scope:'selected',discard_output:true,sessions:[pair]},'wfr_cleanup_'+n);
    success(liveCleanup); expect(JSON.parse(text(liveCleanup))).toMatchObject({removed:0,skippedRunning:1,processesKilled:0});
    await fs.writeFile(path.join(dir,'release-'+n),'done');
    let output=session.output, final:any;
    for(let attempt=0;attempt<10;attempt++) {
      const r=await call('long-'+n,'write_stdin',{...pair,chars:'',yield_time_ms:1000},'wfr_poll_'+n+'_'+attempt); success(r);
      output+=r.structuredContent.output; if(typeof r.structuredContent.exit_code==='number'){final=r;break;}
    }
    expect(final,output).toBeDefined(); expect(output.match(new RegExp('START-'+n,'g'))?.length).toBe(1);
    expect(output.match(new RegExp('FINISH-'+n,'g'))?.length).toBe(1); expect(final.structuredContent.exit_code).toBe(0);
    const replay=await call('long-'+n,'write_stdin',{...pair,chars:''},'wfr_replay_'+n); success(replay);
    expect(replay.structuredContent.output).toBe(final.structuredContent.output);
  }
  // Simulate a quiescent connector relaunch using its real bounded durable owner; no live process is reset.
  expect(unifiedExecManager.terminalCapacity().activeUsed).toBe(0); expect(await flushTerminalResults()).toBe(true);
  const saved = await readDurable('terminal-results');
  for(const result of long) expect(JSON.stringify(saved)).not.toContain(result.session_token);
  await unifiedExecManager.terminateAllProcesses(); resetExecOwnershipForTests();
  await writeDurableNow('terminal-results', saved); await restoreTerminalResults();
  const pair={session_id:long[0].session_id,session_token:long[0].session_token};
  const recovered=await call('reconnected','write_stdin',{...pair,chars:''},'wfr_reconnected'); success(recovered);
  expect(recovered.structuredContent.output).toContain('FINISH-0'); expect(recovered.structuredContent.exit_code).toBe(0);
  const bad=await call('reconnected','write_stdin',{session_id:pair.session_id,session_token:'x'.repeat(43),chars:''},'wfr_bad_reconnect');
  expect(text(bad)).toContain('TOKEN_MISMATCH');
},180000);

it('reconciles an aborted poll without replaying the command or losing its unacknowledged output', async () => {
  await serve(); const started=await call('loss-client','exec_command',{cmd:'node probe.cjs long loss',workdir:'/probe',yield_time_ms:1},'wfr_loss_start'); success(started);
  const pair={session_id:started.structuredContent.session_id,session_token:started.structuredContent.session_token};
  const first=await call('loss-client','write_stdin',{...pair,chars:'',yield_time_ms:1},'wfr_first_poll'); success(first);
  const controller=new AbortController(), pending=request('loss-client','write_stdin',{...pair,chars:'',yield_time_ms:1000},'wfr_aborted_poll',controller.signal).then(r=>r.text());
  await new Promise(r=>setTimeout(r,100)); controller.abort(); await expect(pending).rejects.toThrow();
  await fs.writeFile(path.join(dir,'middle-loss'),'go');
  await expect.poll(()=>inFlightToolCalls(null),{timeout:10000}).toBe(0);
  const retry=await call('loss-client','write_stdin',{...pair,chars:'',yield_time_ms:1000},'wfr_retry_same_session'); success(retry);
  expect(retry.structuredContent.output).toContain('MIDDLE-loss');
  await fs.writeFile(path.join(dir,'release-loss'),'done');
  let rest=''; for(let n=0;n<5;n++){const r=await call('loss-client','write_stdin',{...pair,chars:'',yield_time_ms:1000},'wfr_loss_final_'+n);success(r);rest+=r.structuredContent.output;if(typeof r.structuredContent.exit_code==='number')break;}
  expect(rest).toContain('FINISH-loss'); expect(rest).not.toContain('MIDDLE-loss');
},30000);


it('returns the real command result with an explicit recovery warning when its durable cache cannot be saved', async () => {
  await serve();const blocked=path.join(dir,'state','terminal-results.json');
  await fs.mkdir(blocked,{recursive:true});
  const result=await call('disk-failure','exec_command',{cmd:'node probe.cjs short disk-1',workdir:'/probe',yield_time_ms:10000});success(result);
  expect(result.structuredContent.exit_code).toBe(0);expect(result.structuredContent.output).toContain('OUT-disk-1');
  expect(text(result)).toContain('remains in memory');expect(text(result)).toContain('do not rerun');
  await fs.rmdir(blocked);expect(await flushTerminalResults()).toBe(true);
  const retry=await call('disk-failure','write_stdin',{session_id:result.structuredContent.terminal_result.session_id,chars:''});success(retry);
  expect(retry.structuredContent.output).toContain('OUT-disk-1');
});
