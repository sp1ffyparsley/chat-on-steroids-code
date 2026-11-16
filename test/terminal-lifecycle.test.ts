import { afterEach, expect, it } from 'vitest';
import { parseCommandBatchSections } from '../src/main/codex/command-batch.js';
import { UnifiedExecProcessManager, applyUnifiedExecEnv, type OutputPublication } from '../src/main/codex/unified-exec.js';

const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.terminateAllProcesses(); });
const publication = (): OutputPublication => ({ completedAt: null, failed: false });
async function command(manager: UnifiedExecProcessManager, clientKey: string, code: string, pub = publication(), yieldMs = 1, batchMarker?: string) {
  const processId = manager.allocateProcessId(clientKey);
  return manager.execCommand({ processId, clientKey, publication: pub, batchMarker,
    command: [process.execPath, '-e', code], shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'terminal lifecycle fixture', cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false, yieldTimeMs: yieldMs,
    maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 10_000 } });
}
const poll = (manager: UnifiedExecProcessManager, id: number, pub = publication()) => manager.writeStdin({
  processId: id, input: '', publication: pub, yieldTimeMs: 1, maxOutputTokens: undefined,
  truncationPolicy: { kind: 'tokens', tokens: 10_000 } });

it('releases completed capacity without losing unclaimed output, then replays a delivered final until bounded expiry', async () => {
  let now = Date.now();
  const manager = new UnifiedExecProcessManager(5000, { now: () => now }); managers.push(manager);
  const startPub = publication();
  const started = await command(manager, 'A', "setTimeout(() => { console.log('FINAL-α-🚀'); process.exit(7); }, 500)", startPub);
  const id = started.processId!; expect(id).not.toBeNull(); startPub.completedAt = now;
  await started.completion;
  await expect.poll(() => manager.terminalCapacity().activeUsed).toBe(0);
  expect(manager.terminalCapacity().exitedRetained).toBe(1);
  const finalPub = publication(), result = await poll(manager, id, finalPub);
  expect(result.rawOutput.toString('utf8')).toContain('FINAL-α-🚀'); expect(result.exitCode).toBe(7);
  finalPub.failed = true;
  const replayPub = publication(), replay = await poll(manager, id, replayPub);
  expect(replay.rawOutput).toEqual(result.rawOutput); expect(replay.exitCode).toBe(7);
  replayPub.completedAt = now;
  now += 120_001; manager.cleanupCompleted('expired');
  expect(manager.terminalCapacity().retained).toBe(0);
  await expect(poll(manager, id)).rejects.toThrow('Unknown process id');
});

it('never expires or cleans a genuinely running process, and rejects writing to a completed one', async () => {
  let now = Date.now(); const manager = new UnifiedExecProcessManager(5000, { now: () => now }); managers.push(manager);
  const start = await command(manager, 'B', "console.log('LIVE');setInterval(()=>{},1000)");
  now += 86_400_000; const cleaned = manager.cleanupCompleted('expired');
  expect(cleaned.removed).toBe(0); expect(manager.listProcesses().map(x => x.processId)).toContain(start.processId);
  const end = await command(manager, 'C', "console.log('DONE')", publication(), 30000);
  expect(end.exitCode).toBe(0);
  await expect(manager.writeStdin({ processId: end.resultProcessId!, input: 'must-not-write', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 10000 } })).rejects.toThrow('completed');
});

it('applies per-client admission without consuming another client\'s reserved share', async () => {
  const manager = new UnifiedExecProcessManager(5000); managers.push(manager);
  const ids = Array.from({ length: 8 }, () => manager.allocateProcessId('one-client'));
  await expect(command(manager, 'one-client', "console.log('must-not-start')")).rejects.toThrow('client');
  const other = await command(manager, 'another-client', "console.log('OTHER-OK')", publication(), 30000);
  expect(other.rawOutput.toString()).toContain('OTHER-OK');
  for (const id of ids) manager.releaseProcessId(id);
});

it('persists a lost partial response separately from its unread completed tail and never replays a command', async () => {
  const source = new UnifiedExecProcessManager(5000); managers.push(source);
  source.configureCustody({snapshot:()=>({testOwner:'A'})});
  const pub=publication(), start=await command(source,'A',"console.log('PREFIX-α');setTimeout(()=>console.log('TAIL-🚀'),600)",pub,100);
  expect(start.processId).not.toBeNull(); pub.failed=true; await start.completion;
  const snapshot=source.snapshotCompleted(); expect(snapshot.results).toHaveLength(1);
  const target=new UnifiedExecProcessManager(5000);managers.push(target);
  target.configureCustody({restore:(_id,value)=>JSON.stringify(value)===JSON.stringify({testOwner:'A'})});
  expect(target.restoreCompleted(snapshot)).toBe(1); const id=snapshot.results[0]!.id;
  const offerPub=publication(), page=await target.offerCompletedOutput(new Set([id]),offerPub,10000);
  expect(page?.output).toContain('TAIL-🚀');offerPub.failed=true;
  const final=await poll(target,id); expect(final.processId).toBeNull(); expect(final.exitCode).toBe(0);
  const joined=final.rawOutput.toString();
  expect(joined.match(/PREFIX-α/g)?.length).toBe(1);expect(joined.match(/TAIL-🚀/g)?.length).toBe(1);
  const malformed=structuredClone(snapshot);malformed.results.push({...malformed.results[0]!});
  const empty=new UnifiedExecProcessManager(5000);managers.push(empty);empty.configureCustody({restore:()=>true});
  expect(()=>empty.restoreCompleted(malformed)).toThrow('identity');expect(empty.terminalCapacity().retained).toBe(0);
});

it('does not count initial response delivery as final output collection and bounds completed output by client and bytes', async () => {
  let now=Date.now();const manager=new UnifiedExecProcessManager(5000,{now:()=>now,retention:{maxPerClient:2,maxBytes:4096}});managers.push(manager);
  const pub=publication(), start=await command(manager,'A',"setTimeout(()=>console.log('LATE'),1200)",pub);pub.completedAt=now;await start.completion;
  now+=120001;expect(manager.cleanupCompleted('expired').removed).toBe(0);
  await expect.poll(()=>manager.terminalCapacity().activeUsed).toBe(0);
  const result=await poll(manager,start.processId!);expect(result.rawOutput.toString()).toContain('LATE');
  for(let n=0;n<4;n++)await command(manager,'A',`console.log('RESULT-${n}-'+'x'.repeat(2000))`,publication(),10000);
  const capacity=manager.terminalCapacity();expect(capacity.activeUsed).toBe(0);expect(capacity.exitedRetained).toBeLessThanOrEqual(2);
  expect(capacity.completedBytes).toBeLessThanOrEqual(4096);expect(capacity.evictedCompleted).toBeGreaterThan(0);
  now+=3600001;manager.cleanupCompleted('expired');expect(manager.terminalCapacity().retained).toBe(0);
});

it('retains all unacknowledged chunks within one nested response while returning only each new chunk to its executor', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const pub=publication();
  const start=await command(manager,'nested',"console.log('FIRST');setTimeout(()=>console.log('SECOND'),350);setTimeout(()=>console.log('THIRD'),700)",pub,100);
  const id=start.processId!;let output=start.rawOutput.toString(), final=start;
  while(final.processId!==null){final=await poll(manager,id,pub);output+=final.rawOutput.toString();}
  for(const word of ['FIRST','SECOND','THIRD'])expect(output.match(new RegExp(word,'g'))?.length).toBe(1);
  pub.failed=true;const replay=await poll(manager,id);expect(replay.processId).toBeNull();
  for(const word of ['FIRST','SECOND','THIRD'])expect(replay.rawOutput.toString().match(new RegExp(word,'g'))?.length).toBe(1);
});

it('protects a completed result while its poll owns the lock and propagates process creation errors without leaking reservations', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const pub=publication();
  const started=await command(manager,'locked',"setTimeout(()=>console.log('LOCKED-RESULT'),450)",pub);pub.completedAt=Date.now();
  const reading=poll(manager,started.processId!);expect(manager.cleanupCompleted('selected',new Set([started.processId!])).removed).toBe(0);
  const result=await reading;expect(result.rawOutput.toString()).toContain('LOCKED-RESULT');
  const id=manager.allocateProcessId('failed');
  await expect(manager.execCommand({processId:id,clientKey:'failed',publication:publication(),command:['missing-executable-that-does-not-exist-r110'],shellType:'powershell',hookCommand:'missing fixture',cwd:process.cwd(),displayCwd:process.cwd(),env:process.env,tty:false,yieldTimeMs:1,maxOutputTokens:undefined,truncationPolicy:{kind:'tokens',tokens:10000}})).rejects.toThrow();
  await expect.poll(()=>manager.terminalCapacity().activeUsed).toBe(0);
});


// Windows closes inherited pipe handles with the leader; this specific stream-order case is POSIX-only.
it.skipIf(process.platform==='win32')('preserves a descendant stdout stream after its shell leader exits', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const pub=publication();
  const start=await command(manager,'draining',`require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>console.log('CHILD-TAIL'),1500)"],{stdio:'inherit'});process.exit(0);`,pub,250);
  expect({id:start.processId,raw:start.rawOutput.toString()}).toMatchObject({id:expect.any(Number)});pub.completedAt=Date.now();
  expect(manager.terminalCapacity().draining).toBe(1);
  expect(manager.cleanupCompleted('selected',new Set([start.processId!])).removed).toBe(0);
  let output=start.rawOutput.toString(),final=start;
  while(final.processId!==null){const next=publication();final=await poll(manager,start.processId!,next);output+=final.rawOutput.toString();next.completedAt=Date.now();}
  expect(output.match(/CHILD-TAIL/g)?.length).toBe(1);expect(final.exitCode).toBe(0);
  await expect.poll(()=>manager.terminalCapacity().activeUsed).toBe(0);
});

it('keeps an uncertain explicit final out of automatic empty-page acknowledgement', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const pub=publication();
  const result=await command(manager,'final-owner',"console.log('FINAL-CUSTODY')",pub,10000);pub.failed=true;
  const ids=new Set([result.resultProcessId!]);expect(manager.backgroundState(ids).exitedUnread).toEqual([]);
  expect(await manager.offerCompletedOutput(ids,publication(),100)).toBeNull();
  expect((await poll(manager,result.resultProcessId!)).rawOutput.toString()).toContain('FINAL-CUSTODY');
});

it('keeps raw batch framing and display bytes separate through failed nested publication and durable replay', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const pub=publication(),marker='abcdef012345678901234567';
  const first=`--- command 1/2 --- [clf-batch:${marker}]\nFIRST-SECTION\n--- exit code 0 --- [clf-batch:${marker}]\n`;
  const second=`--- command 2/2 --- [clf-batch:${marker}]\nSECOND-SECTION\n--- exit code 7 --- [clf-batch:${marker}]\n`;
  const start=await command(manager,'batch',`process.stdout.write(${JSON.stringify(first)});setTimeout(()=>{process.stdout.write(${JSON.stringify(second)});process.exitCode=7},900)`,pub,250,marker);
  const id=start.processId!;expect(id).not.toBeNull();let final=start;while(final.processId!==null)final=await poll(manager,id,pub);
  pub.failed=true;const replay=await poll(manager,id);
  expect(parseCommandBatchSections(replay.rawOutput.toString(),marker).map(x=>x.exitCode)).toEqual([0,7]);
  expect(replay.displayOutput?.toString()).not.toContain('[clf-batch:');expect(replay.displayOutput?.toString()).toContain('FIRST-SECTION');
  const target=new UnifiedExecProcessManager(5000);managers.push(target);target.configureCustody({restore:()=>true});
  expect(target.restoreCompleted(manager.snapshotCompleted())).toBe(1);const recovered=await poll(target,id);
  expect(recovered.rawOutput).toEqual(replay.rawOutput);expect(recovered.displayOutput).toEqual(replay.displayOutput);
});

it('skips busy completed output in automatic offer and ACK without joining the reader queue', async () => {
  const manager=new UnifiedExecProcessManager(5000);managers.push(manager);const startPub=publication();
  const start=await command(manager,'maintenance',"setTimeout(()=>console.log('BUSY-OUTPUT'),800)",startPub);startPub.completedAt=Date.now();await start.completion;
  await expect.poll(()=>manager.terminalCapacity().activeUsed).toBe(0);const ids=new Set([start.processId!]);
  const lock=(manager as any).processes.get(start.processId!).process.interactionLock;
  let unlock=await lock.lock();try{expect(await Promise.race([manager.offerCompletedOutput(ids,publication(),1000),new Promise(r=>setTimeout(()=>r('blocked'),100))])).toBeNull();}finally{unlock();}
  const offered=publication();expect((await manager.offerCompletedOutput(ids,offered,1000))?.output).toContain('BUSY-OUTPUT');offered.completedAt=Date.now()-1;
  unlock=await lock.lock();try{expect(await Promise.race([manager.acknowledgeCompletedOutput(ids,Date.now()),new Promise(r=>setTimeout(()=>r('blocked'),100))])).toEqual([]);}finally{unlock();}
  expect(await manager.acknowledgeCompletedOutput(ids,Date.now())).toEqual([start.processId]);
});

it('charges omission markers to the completed byte bound so every retained snapshot can be restored', async () => {
  const limit=1024*1024,manager=new UnifiedExecProcessManager(5000,{retention:{maxBytes:limit}});managers.push(manager);const pub=publication();
  const started=await command(manager,'bounded',"setTimeout(()=>process.stdout.write('x'.repeat(2*1024*1024)),1200)",pub);pub.completedAt=Date.now();await started.completion;
  await expect.poll(()=>manager.terminalCapacity().activeUsed).toBe(0);
  const snapshot=manager.snapshotCompleted(),target=new UnifiedExecProcessManager(5000,{retention:{maxBytes:limit}});managers.push(target);target.configureCustody({restore:()=>true});
  expect(()=>target.restoreCompleted(snapshot)).not.toThrow();
  expect(manager.terminalCapacity().completedBytes).toBeLessThanOrEqual(limit);expect(manager.terminalCapacity().evictedCompleted).toBe(1);
});
