import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/browser-control.js', 'utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');

async function fixture(options: {
  status?:string; write?:boolean; allowed?:boolean; owner?:string;
  protectedPage?:boolean; reloadFails?:boolean; reloadStalls?:boolean; protectDuringCheck?:boolean; expireDuringCheck?:boolean;
} = {}) {
  const { status = 'unloaded', write = true, allowed = true, owner,
    protectedPage = false, reloadFails = false, reloadStalls = false } = options;
  let tabStatus = status;
  let protection = protectedPage;
  let issuedCommand: { expiresAt: number; [key: string]: unknown } | null = null;
  const calls:string[] = [];
  let saved = { cosBrowserControl:{
    browserId:randomUUID(), epoch:'epoch', receipt:null,
    tabs:owner ? [{tabId:17,owner,lease:'existing-lease'}] : [] as {tabId:number;owner:string;lease:string}[]
  }};
  const chrome = {
    storage:{session:{
      get:vi.fn(async()=>saved),
      set:vi.fn(async(next:typeof saved)=>{saved=next;})
    }},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{
      get:vi.fn(async()=>({id:17,url:'https://fixture.invalid/',title:'Fixture',status:tabStatus})),
      reload:vi.fn(async(tabId:number)=>{
        calls.push('reload:'+tabId);
        if(reloadFails) throw new Error('reload forbidden');
        if(!reloadStalls) tabStatus='complete';
      })
    },
    scripting:{executeScript:vi.fn(async()=>[])},
    debugger:{
      attach:vi.fn(async()=>{calls.push('attach');}),
      detach:vi.fn(async()=>{calls.push('detach');}),
      getTargets:vi.fn(async()=>[{tabId:17,attached:true}]),
      sendCommand:vi.fn(async(_target:unknown, method:string)=>{
        calls.push(method);
        if(method==='Page.enable' && tabStatus==='unloaded') throw new Error('discarded page cannot enable Page');
        if(method==='Page.getFrameTree') return {frameTree:{frame:{id:'frame',url:'https://fixture.invalid/'}}};
        if(method==='Page.createIsolatedWorld') return {executionContextId:1};
        if(method==='Runtime.evaluate') return {result:{value:{ok:true}}};
        return {};
      })
    }
  };
  const create = runInNewContext(`${source};createBrowserControl`,{
    browserPage:()=>({ok:true}),boundedBrowserValue:(x:unknown)=>x,
    browserFramePoint:(x:unknown)=>x,
    crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,URL
  });
  const transport=vi.fn(async(_path:string,init?:{body?:string})=>{
    const request=JSON.parse(init?.body || '{}');
    if(request.action==='check') {
      if(options.protectDuringCheck) protection=true;
      if(options.expireDuringCheck && issuedCommand) issuedCommand.expiresAt=Date.now();
      return {ok:true,data:{allowed}};
    }
    return {ok:true,data:{epoch:'epoch',policy:{read:true,write},requests:[]}};
  });
  const control=create(chrome,transport,()=>protection);
  await control.pump();
  const command=(action:string,who='session:mine')=>(issuedCommand={
    id:randomUUID(),epoch:'epoch',owner:who,conversationId:null,
    tool:'browser_tabs',args:{action,tabId:17},expiresAt:Date.now()+25000
  });
  return {chrome,control,command,calls,saved:()=>saved.cosBrowserControl};
}

afterEach(()=>vi.useRealTimers());

describe('explicit browser attach to Chrome discarded/unloaded tabs',()=>{
  it('revives only the existing unloaded tab before CDP Page.enable and releases its custody',async()=>{
    const {chrome,control,command,calls,saved}=await fixture();
    expect(await control.execute(command('attach'))).toMatchObject({value:{attached:true}});
    expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(17);
    expect(calls.indexOf('reload:17')).toBeLessThan(calls.indexOf('attach'));
    expect(calls.indexOf('attach')).toBeLessThan(calls.indexOf('Page.enable'));
    expect(await control.execute(command('release'))).toMatchObject({value:{released:true}});
    expect(saved().tabs).toEqual([]);
  });

  it('does not reload an already complete tab',async()=>{
    const {chrome,control,command}=await fixture({status:'complete'});
    expect(await control.execute(command('attach'))).toMatchObject({value:{attached:true}});
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    await control.execute(command('release'));
  });

  it('requires browser write permission before reloading',async()=>{
    const {chrome,control,command,saved}=await fixture({write:false});
    await expect(control.execute(command('attach'))).rejects.toThrow(/needs browser write permission/);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual([]);
  });

  it('rechecks live authorization before reloading',async()=>{
    const {chrome,control,command,saved}=await fixture({allowed:false});
    await expect(control.execute(command('attach'))).rejects.toThrow(/PERMISSION_REVOKED/);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual([]);
  });

  it('does not reload or detach a foreign-owned or protected tab',async()=>{
    const foreign=await fixture({owner:'session:other'});
    await expect(foreign.control.execute(foreign.command('attach'))).rejects.toThrow(/BROWSER_TAB_OWNED/);
    expect(foreign.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(foreign.chrome.debugger.detach).not.toHaveBeenCalled();
    const protectedTab=await fixture({protectedPage:true});
    await expect(protectedTab.control.execute(protectedTab.command('attach'))).rejects.toThrow(/BROWSER_EXECUTOR_TAB/);
    expect(protectedTab.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(protectedTab.chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it.each(['protection', 'expiry'] as const)('rechecks %s after the asynchronous reload authorization', async cause => {
    const fixtureState=await fixture({protectDuringCheck:cause==='protection',expireDuringCheck:cause==='expiry'});
    const {chrome,control,command,saved}=fixtureState;
    await expect(control.execute(command('attach'))).rejects.toThrow(cause==='protection'?/BROWSER_EXECUTOR_TAB/:/BROWSER_EXPIRED/);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual([]);
  });

  it('fails closed if Chrome cannot reload the tab',async()=>{
    const {chrome,control,command,saved}=await fixture({reloadFails:true});
    await expect(control.execute(command('attach'))).rejects.toThrow(/BROWSER_TAB_UNLOADED: reload failed/);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual([]);
  });

  it('times out on a stalled reload without claiming the debugger',async()=>{
    const {chrome,control,command,saved}=await fixture({reloadStalls:true});
    vi.useFakeTimers();
    const work=control.execute(command('attach'));
    const outcome=work.then((value:unknown)=>({value,error:''}),(cause:unknown)=>({value:null,error:String((cause as {message?:unknown})?.message ?? cause)}));
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await outcome).error).toMatch(/BROWSER_TAB_UNLOADED: reload was requested/);
    expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(17);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(saved().tabs).toEqual([]);
  });
});
