/**
 * Isolated native Chromium exercise for Work & updates.
 * Run: node test/renderer-work-native.cjs
 * No CoS main process, installed account, extension, browser profile or provider access.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 120_000
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error('Native fixture launcher:', result.error.stack || String(result.error));
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const sourceInputs = ['src/renderer/chat.ts','src/renderer/index.html','src/renderer/i18n.ts','src/renderer/styles.css',
  'src/renderer/main.ts','src/renderer/composer-drafts.ts','src/renderer/composer-target.ts',
  'src/shared/composer-drafts.ts','src/shared/support-report.ts',
  'src/shared/agent-plan.ts','src/shared/workflow.mts','extension/overlay.css'];
const sourceHash = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
const sourceBaseline = new Map(sourceInputs.map(name=>[name,sourceHash(name)]));
const outputRoot = path.join(root, 'outputs');
const output = process.env.COS41_RENDERER_NATIVE_OUTPUT
  ? path.resolve(process.env.COS41_RENDERER_NATIVE_OUTPUT)
  : path.join(outputRoot, 'chat41-renderer-native');
if (!output.startsWith(outputRoot + path.sep)) {
  throw new Error('Refusing native fixture output outside the existing project outputs folder.');
}
// Previous visual receipts are durable evidence. A changed-source review must
// use a new output folder instead of quietly replacing earlier screenshots.
if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
  throw new Error('Refusing to overwrite existing CoS41 native fixture screenshots: ' + output);
}
let nativeStage = 'electron startup';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cos-chat41-ui-')));

app.whenReady().then(async () => {
  nativeStage = 'creating Vite fixture';
  const { createServer } = await import('vite');
  const fixture = `
    const now = Date.now();
    const stored = value => ({ text: value, chars: value.length, truncated: false });
    const base = (id, title, at) => ({ id, title, conversationId: 'fixture-' + id,
      chatIds: ['fixture-' + id], startedAt: now-60000, updatedAt: at, endedAt: null,
      events: 2, userMessages: 1, toolCalls: 0, fileEdits: 0, linesAdded: 0, linesRemoved: 0,
      approximateFileChanges: false, lastFileChangeAt: null, lastToolCallAt: null,
      processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
      estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
      lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null });
    const prime = {...base('prime', 'Full production status integration with a long task title and real review notes', now),
      fileEdits: 2, linesAdded: 18, lastFileChangeAt: now-1500, lastToolCallAt: now-1500};
    const worker = {...base('worker', 'Finished independent worker review with durable evidence', now-1000),
      origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Review' },
      lastFinishReportAt: now-800, lastToolCallAt: now-1200};
    const final = {...base('oneoff', 'Retained one-off result with validation and remaining work', now-2000),
      lastAssistantFinalAt: now-600, lastTurnEndAt: now-400, lastToolCallAt: now-5000,
      lastTurnOutcome: 'completed'};
    const blocked = base('blocked', 'Provider login required for the exact account', now-3000);
    const older = {...base('older', 'Earlier held Loop outside the paged session catalog', now-3500),
      lastAssistantFinalAt: now-3100, lastTurnEndAt: now-3000,
      lastTurnOutcome:'completed'};
    const waiting = base('waiting', 'Waiting for worker report, not currently generating', now-4000);
    // Redacted durable event-boundary shape witnessed in two historical CoS
    // sessions: an older saved final followed by a newer stalled turn with no
    // final/tool outcome. Never import their actual authored message bodies.
    const stale = {...base('stalled', 'Stalled Goal due to a confirmed unmet condition', now-5000),
      lastTurnOutcome:'stalled', lastAssistantFinalAt:now-6000,
      lastToolCallAt:now-8000,lastTurnEndAt:now-1000,activeTurnId:null};
    const sessions = [prime, worker, final, blocked, waiting, stale];
    const result = stored('RESULT: Completed safe UI review.\\nCHANGES: Renderer-only status display.\\nVALIDATION: 250 retained renderer tests passed in the earlier source checkpoint.\\nBLOCKERS: New source still needs a qualified native install.');
    const reports = {
      [worker.id]: [{kind:'agent_message',seq:1,time:now-800,source:'app',agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',messageId:'report-worker',message:stored('[worker-1 finished] RESULT: Checked accessible controls.\\nVALIDATION: Synthetic worker fixture.\\nBLOCKERS: Prime receipt unconfirmed.')}],
      [final.id]: [{kind:'assistant_message',seq:2,time:now-600,source:'extension',messageId:'final-oneoff',final:true,state:'final',message:result}],
      [older.id]: [{kind:'assistant_message',seq:1,time:now-3100,source:'extension',messageId:'final-older',final:true,
        message:stored('Saved prior work is readable after this held Loop leaves the first page.')}],
      [stale.id]: [{kind:'tool_call',seq:422,time:now-8000,source:'mcp',turnId:'prior-turn',
          call:{callId:'stale-old-tool',tool:'read',outcome:'ok',attribution:'request_id',
            durationMs:12,args:stored('{}'),result:stored(''),summary:{kind:'read',title:'Previous result evidence',tone:'neutral'}}},
        {kind:'assistant_message',seq:429,time:now-6000,source:'extension',
          turnId:'prior-turn',messageId:'stale-previous-final',final:true,
          message:stored('Previously recorded valid final, not the stalled turn.')},
        {kind:'turn_start',seq:433,time:now-2000,source:'extension',turnId:'new-stalled-turn'},
        {kind:'turn_end',seq:436,time:now-1000,source:'extension',
          turnId:'new-stalled-turn',outcome:'stalled'}],
      [prime.id]: [{kind:'tool_call',seq:2,time:now-1500,source:'mcp',call:{callId:'tool-prime',tool:'apply_patch',outcome:'ok',attribution:'request_id',durationMs:42,args:stored('{}'),result:stored(''),changes:[{path:'src/renderer/chat.ts',added:18,removed:2,approximate:false}],summary:{kind:'edit',title:'Updated status projection',tone:'good'}}},
        {kind:'agent_message',seq:3,time:now-500,source:'app',agent:'prime',messageId:'report-worker',
          from:'worker-1',to:'prime',delivery:'delivered',
          message:stored('[worker-1 finished] RESULT: Exact worker report received by the owning Prime.')}]
    };
    const project = {id:'demo-project',name:'UI Review',path:'C:/synthetic-only',createdAt:1};
    const projection = (row, mode, state, reason, nextAction, recoverable=false) => ({
      sessionId:row.id,conversationId:row.conversationId,title:row.title,mode,state,reason,nextAction,
      nextRetryAt:null,lastWorkedAt:now-1500,activeWorkers:state==='waiting-workers'?1:0,
      recoverable,spinning:state==='working',recoveryStage:null });
    const automation = {observedAt:now,targetLanes:4,counts:{working:1,'waiting-workers':1,'waiting-main':0,
      recovering:0,stalled:1,paused:0,blocked:2},chats:[
      projection(prime,'loop','working','Exact local edit is active.','Continue the current turn.'),
      projection(blocked,'goal','blocked','Exact provider sign-in needed.','Sign in to the same account.'),
      projection(older,'loop','blocked','Existing provider account needs sign-in.','Sign in using the existing account.'),
      projection(waiting,'loop','waiting-workers','Waiting for worker.','Collect the exact report.'),
      projection(stale,'goal','stalled','Retry has exhausted the current recovery evidence.','Review the original blocker.',true)
    ]};
    const inputs = [{id:'fixture-ambiguous',sessionId:blocked.id,conversationId:blocked.conversationId,
      text:'Synthetic cancelled instruction',state:'cancelled',mode:'auto',dueAt:0,createdAt:now,
      model:null,reasoningEffort:null,owner:'historical-browser',sendAuthorizedAt:now-4000,
      error:'Delivery confirmation was not observed; the message may already have been sent.'}];
    const config = {roots:[],readOnly:true,capabilities:{},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark',automationProfile:'day'},
      sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:false,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}};
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.1.15',latest:null,stage:'idle',error:null,checkedAt:null}};
    const ok = data => Promise.resolve({ok:true,data});
    const reliabilityReview = ${JSON.stringify(process.env.COS41_RENDERER_FOCUSED_RELIABILITY === '1')};
    const fixtureAccount = {id:'fixture-account',nickname:'My exact account nickname',platform:'windows',
      enabled:true,active:true,runtimeMode:'isolated',runtimeRunning:true,runtimePrepared:true,
      browserPaired:false,browserAuth:'unknown',browserProfileDirectory:'Synthetic-only',coreTunnelId:null,
      hasRuntimeApiKey:false,connection:{state:'offline',core:{state:'off',lastSuccessfulRequestAt:null}},
      activeWorkers:0,queuedWorkers:0,pendingOperations:[],
      connector:{displayName:'Fixture',description:'Isolated native UI test',mcpUrl:null,status:'off',lastSuccessfulRequestAt:null,error:null}};
    if (reliabilityReview) {
      project.id='597ffccf-aabc-4fb6-823b-ebbe32b7c703';
      project.path='C:/Synthetic creative workspace/素材/long project folder';
      sessions.push({...base('reliability-chat','My exact task nickname',now+1),projectId:project.id});
      if(!localStorage.getItem('nativeDraftSnapshot')) localStorage.setItem('nativeDraftSnapshot',JSON.stringify({
        version:1,profileId:fixtureAccount.id,revision:1,selection:{sessionId:'reliability-chat',projectId:project.id},
        entries:[{key:'reliability-chat',generation:'7dcfc197-47ea-44f1-9ac3-4ecfba9f648c',
          text:'Saved authored draft before view reload',files:[],updatedAt:now}]}));
    }
    let notify = () => undefined;
    window.fixture = {automation, sessions, older, reports, inputs, config, notify:()=>notify(),
      controlActions:[], providerControls:{}, helperCustody:{},
      failReads:false, failOlderPrime:false, failHistoryFor:null,
      detailOverrides:{}, strictPaging:false, reads:[]};
    window.api = new Proxy({
      ...(reliabilityReview ? {
        getInstanceProfiles:()=>ok({activeProfileId:fixtureAccount.id,canManageProfiles:false,profiles:[fixtureAccount]}),
        loadComposerDrafts:()=>ok({snapshot:JSON.parse(localStorage.getItem('nativeDraftSnapshot')),warnings:[],reconciled:[]}),
        saveComposerDrafts:request=>{
          const prior=JSON.parse(localStorage.getItem('nativeDraftSnapshot'));
          if(request.profileId!==prior.profileId||request.expectedRevision!==prior.revision) return ok({saved:false,snapshot:prior});
          const snapshot={version:1,profileId:prior.profileId,revision:prior.revision+1,...request.snapshot};
          localStorage.setItem('nativeDraftSnapshot',JSON.stringify(snapshot));return ok({saved:true,snapshot});
        },
        collectSupportReport:async()=>{
          window.fixture.reportCollections=(window.fixture.reportCollections??0)+1;
          await new Promise(resolve=>setTimeout(resolve,60));
          return ok({schemaVersion:1,collectedAt:now,scope:'active-profile',collection:'partial',
            ...Object.fromEntries(['runtime','connection','companion','automation','lifecycle','queue','activity','events']
              .map(name=>[name,{state:'unavailable',reason:'not-ready'}]))});
        },
        writeClipboard:text=>{window.fixture.clipboard=text;return ok(true);}
      } : {}),
      sendInput:()=>{window.fixture.controlActions.push('sendInput');return ok({});},
      setSessionAutomation:()=>{window.fixture.controlActions.push('setSessionAutomation');return ok({});},
      setSessionsAutomation:()=>{window.fixture.controlActions.push('setSessionsAutomation');return ok({});},
      setSessionsAutomationPaused:()=>{window.fixture.controlActions.push('setSessionsAutomationPaused');return ok({});},
      retryInputBrowser:()=>{window.fixture.controlActions.push('retryInputBrowser');return ok({});},
      retryHelper:()=>{window.fixture.controlActions.push('retryHelper');return ok({});},
      retryPausedHelpers:()=>{window.fixture.controlActions.push('retryPausedHelpers');return ok({});},
      releaseSessionFinish:()=>{window.fixture.controlActions.push('releaseSessionFinish');return ok({});},
      stopSession:()=>{window.fixture.controlActions.push('stopSession');return ok({});},
      recoverStaleAutomationChats:()=>{window.fixture.controlActions.push('recoverStaleAutomationChats');return ok({});},
      setSessionBlocked:()=>{window.fixture.controlActions.push('setSessionBlocked');return ok({});},
      getState:()=>ok(state),listProjects:()=>ok([project]),listSidebarFolders:()=>ok([]),
      listSessions:()=>ok({sessions,total:sessions.length,activeId:null,pressure:[],blocked:[],
        automation,nextCursor:null,workerProgress:[]}),
      getSession:(id,query={})=>{
        window.fixture.reads.push({id,limit:query.limit??null,before:query.before??null});
        if(window.fixture.failReads)return Promise.resolve({ok:false,error:'Synthetic read unavailable'});
        if(window.fixture.failHistoryFor===id)
          return Promise.resolve({ok:false,error:'Synthetic session history interrupted'});
        if(id==='prime'&&query.before!==undefined&&window.fixture.failOlderPrime)
          return Promise.resolve({ok:false,error:'Synthetic older Prime page unavailable'});
        const source=reports[id]??[];
        const eligible=source.filter(row=>query.before===undefined||row.seq<query.before);
        const page=window.fixture.strictPaging||query.before!==undefined
          ?eligible.slice(-(query.limit??160)):eligible;
        return ok({summary:window.fixture.detailOverrides[id]??sessions.find(row=>row.id===id)??older,
          events:page,total:source.length,nextFrom:source.reduce((n,row)=>Math.max(n,row.seq+1),0)});
      },
      getSessionControls:id=>ok({sessionId:id,conversationId:sessions.find(row=>row.id===id)?.conversationId,
        plan:null,activeWork:null,automation:id==='stalled'?'goal':'off',
        objective:'',blocked:'',finishHeld:false,job:null}),
      listInputs:()=>ok(inputs),listPausedHelpers:()=>ok([]),getLog:()=>ok([]),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      onSessionChanged:callback=>{notify=callback;return ()=>undefined;},
      onSwarmChanged:()=>()=>undefined,onTaskProgress:()=>()=>undefined,onStateChanged:()=>()=>undefined
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const disableAnimation = document.createElement('style');
    disableAnimation.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.append(disableAnimation);
    window.fixtureReady = true;
  `;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    // This is a single loaded-source native review. Live HMR from another
    // CoS lane must not replace the rendered fixture halfway through a test.
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'work-review-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }] });
  let win;
  try {
    nativeStage = 'starting fixture server';
    await server.listen();
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { sandbox: true, backgroundThrottling: false, offscreen: true } });
    nativeStage = 'loading fixture into Electron';
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    for (let count = 0; count < 120; count++) {
      if (await js(`!!window.fixtureReady && !!document.querySelector('.work-overview-section[data-work-section="updates"] .work-overview-row')`)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await js('window.fixtureReady'), true, 'Fixture module did not load');
    async function exerciseWorkflowReceipt() {
    await js(`(() => { const pane=document.getElementById('workOverviewPane');
      if(pane.hidden || pane.dataset.workResultSession!=='oneoff')document.querySelector('.work-overview-row[data-session-id="oneoff"]').click(); })()`);
    nativeStage = 'recipe completion receipt';
    await js(`(() => {
      const now=Date.now(), session=fixture.sessions.find(row=>row.id==='oneoff');
      fixture.controlActions ??= [];
      fixture.inputs.push({id:'9c546932-85d1-4e65-8040-978b3c811114',sessionId:session.id,
        conversationId:session.conversationId,state:'sent',owner:'fixture-page',createdAt:now-30000,
        deliveredAt:now-25000,messageId:'06f7fe2c-3cdf-4fb6-8437-a1e08f6cfd4a',historyRecorded:true,
        text:'Recipe task',mode:'auto',dueAt:0,model:null,reasoningEffort:null,
        acceptedNativeFinal:{replyId:'d709f467-1b43-4314-8833-05dfae3ee04f',acceptedAt:now-5000},
        workflow:{runId:'ee9bb2c3-c1c0-4233-a153-c972e53a5023',recipeSha256:'a'.repeat(64),step:'verify-render',order:0,total:1,maxParallel:1,dependsOn:[],checks:[{kind:'file'},{kind:'command'}]},
        preparedContext:{authoredChars:100,deliveredChars:1200,skillBodySha256:[]},
        workflowReceipt:{version:1,replyId:'d709f467-1b43-4314-8833-05dfae3ee04f',checkedAt:now,status:'failed',checks:[
          {kind:'file',ok:true,detail:'Read back and verified.',path:'C:/Creative/long project name/output/render.mp4',sha256:'b'.repeat(64)},
          {kind:'command',ok:false,detail:'No original returned native exec receipt proves this exact command/cwd exited 0.'}]}});
      window.api.recheckWorkflow=id=>{fixture.controlActions.push('recipe-recheck:'+id);return Promise.resolve({ok:true,data:false});};
      fixture.notify();
    })()`);
    for(let i=0;i<200;i++){
      if(await js(`!!document.querySelector('#workOverviewPane .work-overview-recipe')`))break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const recipeView=await js(`(() => {
      const pane=document.querySelector('#workOverviewPane .work-overview-recipe');
      if(!pane)return {missing:true};
      pane.open=true; pane.scrollIntoView({block:'start'});
      return {text:pane.textContent,overflow:pane.scrollWidth-pane.clientWidth};
    })()`);
    assert.ok(recipeView.text?.includes('0/1 verified') && recipeView.text.includes('Checks failed') &&
      recipeView.text.includes('SHA-256') && recipeView.text.includes('Frozen message:') && recipeView.overflow<=1,JSON.stringify(recipeView));
    for (const [width,zoom,label] of [[1100,1,'desktop'],[640,1.5,'narrow-150pct'],[640,2,'narrow-200pct']]) {
      win.setSize(width,900);win.webContents.setZoomFactor(zoom);
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const geometry=await js(`(() => {const pane=document.querySelector('#workOverviewPane .work-overview-recipe');
        const host=document.getElementById('workOverviewPane');host.scrollTop+=pane.getBoundingClientRect().top-host.getBoundingClientRect().top-70;return {overflow:pane.scrollWidth-pane.clientWidth,
        documentOverflow:document.documentElement.scrollWidth-innerWidth};})()`);
      assert.ok(geometry.overflow<=1 && geometry.documentOverflow<=1,JSON.stringify({width,zoom,geometry}));
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      fs.writeFileSync(path.join(output,'work-recipe-receipt-'+label+'.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
    const recheckPresent=await js(`!!document.querySelector('[data-work-action^="recipe-recheck-"]')`);
    assert.ok(recheckPresent,'Exact recipe recheck action must survive responsive projection: '+JSON.stringify(await js(`({hidden:document.getElementById('workOverviewPane').hidden,session:document.getElementById('workOverviewPane').dataset.workResultSession,recipe:document.querySelector('.work-overview-recipe')?.textContent,actions:[...document.querySelectorAll('[data-work-action]')].map(node=>node.dataset.workAction),inputs:fixture.inputs.map(row=>({id:row.id,state:row.state,recipe:!!row.workflow}))})`)));
    await js(`document.querySelector('[data-work-action^="recipe-recheck-"]').click()`);
    for(let i=0;i<40;i++){
      if(await js(`document.querySelector('[data-work-action^="recipe-recheck-"]')?.textContent.includes('Recheck held')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(await js(`fixture.controlActions.filter(action=>action.startsWith('recipe-recheck:')).length`),1);
    assert.ok(await js(`document.querySelector('[data-work-action^="recipe-recheck-"]').textContent.includes('Recheck held')`));
    }
    if (process.env.COS41_RENDERER_FOCUSED_RELIABILITY === '1') {
      const waitFor = async (expression, label) => {
        for(let attempt=0;attempt<160;attempt++) {
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Reliability view did not settle: '+label);
      };
      await waitFor(`document.getElementById('chatInput').value==='Saved authored draft before view reload'`, 'saved draft and selection');
      const target=await js(`document.getElementById('composerTarget').textContent`);
      assert.ok(target.includes('My exact account nickname'),target);
      assert.ok(target.includes('My exact task nickname'),target);
      assert.ok(target.includes('素材/long project folder'),target);
      await js(`(() => { const input=document.getElementById('chatInput');input.value='Edited draft survives a native view reload';input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await waitFor(`JSON.parse(localStorage.getItem('nativeDraftSnapshot')).entries.some(row=>row.text==='Edited draft survives a native view reload')`, 'durable acknowledgement');
      assert.deepEqual(await js('fixture.controlActions'),[],'Restoring or editing must not dispatch or resume work');
      await new Promise(resolve => { win.webContents.once('did-finish-load',resolve); win.webContents.reload(); });
      await waitFor(`window.fixtureReady && document.getElementById('chatInput').value==='Edited draft survives a native view reload'`, 'draft after native reload');
      await js(`document.getElementById('inspectCurrentWork').click()`);
      await waitFor(`document.getElementById('workOverviewPane').dataset.workResultSession==='reliability-chat' && !document.getElementById('workOverviewPane').hidden`, 'existing Work evidence');
      assert.deepEqual(await js('fixture.controlActions'),[],'Inspecting a blocker must remain read-only');
      await js(`document.querySelector('#workOverviewPane [data-work-action="close"]').click()`);
      await js(`document.getElementById('copySupportReport').click();document.getElementById('copySupportReportActivity').click()`);
      assert.equal(await js(`document.getElementById('copySupportReportActivity').disabled`),true);
      await waitFor(`fixture.clipboard?.startsWith('Workspace support report') && !document.getElementById('copySupportReport').disabled`, 'partial diagnostics copy');
      assert.equal(await js('fixture.reportCollections'),1,'Concurrent report clicks must coalesce');
      for(const [zoom,name] of [[1,'reliability-desktop.png'],[2,'reliability-200pct.png']]) {
        win.webContents.setZoomFactor(zoom);
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await new Promise(resolve=>setTimeout(resolve,80));
        const bounds=await js(`(() => {const node=document.getElementById('composerTarget'),rect=node.getBoundingClientRect();return {client:node.clientWidth,scroll:node.scrollWidth,top:rect.top,bottom:rect.bottom,height:innerHeight};})()`);
        assert.ok(bounds.scroll<=bounds.client+1,JSON.stringify(bounds));
        assert.ok(bounds.top>=0&&bounds.bottom<=bounds.height,JSON.stringify(bounds));
        fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
      for(const [name,hash] of sourceBaseline) assert.equal(sourceHash(name),hash,'Source changed during reliability review: '+name);
      await exerciseWorkflowReceipt();
      await js(`(() => {
        const row=fixture.inputs.find(row=>row.workflow);
        row.workflowReceipt.status='verified';
        row.workflowReceipt.checks[0].bytes=23;
        row.workflowReceipt.checks[1].ok=true;
        window.api.openWorkflowOutput=(id,index,action)=>{
          fixture.controlActions.push('output:'+id+':'+index+':'+action);
          return Promise.resolve({ok:true,data:{action,status:action==='open'?'opened':'revealed'}});
        };
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-action$="-0-open"]') && !!document.querySelector('[data-work-action$="-0-reveal"]')`, 'verified output actions');
      await js(`document.querySelector('[data-work-action$="-0-open"]').click();document.querySelector('[data-work-action$="-0-reveal"]').click()`);
      assert.deepEqual(await js(`fixture.controlActions.filter(action=>action.startsWith('output:'))`),[
        'output:9c546932-85d1-4e65-8040-978b3c811114:0:open',
        'output:9c546932-85d1-4e65-8040-978b3c811114:0:reveal'
      ]);
      for(const [name,hash] of sourceBaseline) assert.equal(sourceHash(name),hash,'Source changed during reliability actions: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-hidden-Electron',draftRestoredAfterViewReload:true,
        exactNicknames:true,readOnlyStuckInspection:true,partialReportCopy:true,verifiedOutputActionWiring:true,zoom:[1,2],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_WORKFLOW === '1') {
      await exerciseWorkflowReceipt();
      for (const [name,hash] of sourceBaseline) assert.equal(sourceHash(name),hash,'Source changed during recipe fixture: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-hidden-Electron',recipeReceipts:true,failedChecksVisible:true,
        hashesAndPreparedContextVisible:true,readOnlyRecheckRefusal:true,output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_DEEP_TOOL_HISTORY === '1') {
      nativeStage='current B Core output with stepwise earlier tool history, interruption-safe disclosure and 200pct Work access';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<140;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native earlier tool history did not settle: '+label);
      };
      const captureFresh=async(name)=>{
        win.webContents.invalidate();
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.writeFileSync(path.join(output,name),
          (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      };
      const setup=await js(`(() => { try {
        const stored=value=>({text:value,chars:value.length,truncated:false});
        const now=Date.now(),prototype=fixture.sessions.find(row=>row.id==='oneoff');
        const id='native-deep-tool-history',providerA='native-tool-provider-A',providerB='native-tool-provider-B';
        const source={...prototype,id,title:'Current B tool output with earlier archived Core results',
          conversationId:providerB,chatIds:[providerA,providerB],origin:null,activeTurnId:null,
          lastTurnOutcome:'completed',lastAssistantFinalAt:now-2000,lastToolCallAt:now-3000,
          lastFinishReportAt:null,lastTurnEndAt:now-1000,updatedAt:now,toolCalls:3,fileEdits:0,
          finishTurn:{turnId:'exact-tool-B',conversationId:providerB,startedAt:now-6000,
            notified:false,released:true,decisionRevision:null,workSeq:0,decisionSeq:0,decisionInputRevision:null}};
        const tool=(seq,turnId,callId,conversationId,title,body)=>({kind:'tool_call',source:'mcp',seq,
          time:now-(155-seq)*20,turnId,call:{callId,tool:'read',outcome:'ok',attribution:'request_id',
            attributionMethod:'request_id',requestId:'req-'+callId,conversationId,durationMs:12,
            args:stored('{}'),result:stored(body),summary:{kind:'read',title,tone:'neutral'}}});
        const progress=seq=>({kind:'progress',seq,time:now-4000,source:'app',progressId:'tool-history-'+seq,
          message:stored('Later status evidence; not a tool result.')});
        const events=[tool(2,'old-A','tool-old-A',providerA,'Read prior A file',
            'CORE OUTPUT: previous provider A file remains saved.'),
          ...Array.from({length:52},(_,i)=>progress(i+3)),
          tool(55,'middle-C','tool-middle-C',providerB,'Read prior C config',
            'CORE OUTPUT: middle C config output remains saved.'),
          ...Array.from({length:32},(_,i)=>progress(i+56)),
          {kind:'turn_start',source:'extension',seq:90,time:now-6000,turnId:'exact-tool-B'},
          tool(100,'exact-tool-B','tool-current-B',providerB,'Read current B status',
            'CORE OUTPUT: current B tool output is the latest result.'),
          {kind:'assistant_message',source:'extension',seq:110,time:now-2000,turnId:'exact-tool-B',
            messageId:'native-tool-current-final',final:true,
            message:stored('RESULT: Current B final remains separate.')},
          ...Array.from({length:45},(_,i)=>progress(i+111))];
        const statusStalled={...prototype,id:'native-status-stalled',title:'Stalled recovery needs attention',
          conversationId:'native-status-stalled-provider',chatIds:['native-status-stalled-provider'],
          lastTurnOutcome:'stalled',lastTurnEndAt:now-1000,lastAssistantFinalAt:now-6000,updatedAt:now-900};
        const statusPending={...prototype,id:'native-status-pending-reply',title:'Reply pending recovery stage',
          conversationId:'native-status-pending-provider',chatIds:['native-status-pending-provider'],
          lastTurnOutcome:null,lastTurnEndAt:null,lastAssistantFinalAt:null,updatedAt:now-800};
        source.events=events.length;fixture.reports[id]=events;fixture.sessions.push(source,statusStalled,statusPending);
        fixture.automation.targetLanes+=2;fixture.automation.counts.stalled+=1;fixture.automation.counts.recovering+=1;
        fixture.automation.chats.push(
          {sessionId:statusStalled.id,conversationId:statusStalled.conversationId,title:statusStalled.title,
            mode:'loop',state:'stalled',reason:'Recovery evidence exhausted.',nextAction:'Review exact blocker.',
            nextRetryAt:null,lastWorkedAt:now-3000,activeWorkers:0,recoverable:true,spinning:false,recoveryStage:null},
          {sessionId:statusPending.id,conversationId:statusPending.conversationId,title:statusPending.title,
            mode:'loop',state:'recovering',reason:'A continuation reply is pending.',nextAction:'Check its exact delivery receipt.',
            nextRetryAt:null,lastWorkedAt:now-2000,activeWorkers:0,recoverable:true,spinning:false,recoveryStage:'pending-reply'});
        fixture.strictPaging=true;fixture.notify();
        return {ok:true,events:events.length,session:id};
      } catch(error) { return {ok:false,error:String(error),stack:error?.stack}; } })()`);
      assert.ok(setup.ok,JSON.stringify(setup));
      await waitFor(`!!document.querySelector('[data-work-section="updates"] [data-session-id="native-deep-tool-history"]')`,
        'Work row for current B tool history');
      const statusChips=await js(`(() => {
        const read=id=>{const node=document.querySelector('#workOverview [data-session-id="'+id+'"] .work-overview-state');
          const style=getComputedStyle(node),channels=value=>(value.match(/[0-9.]+/g)||[]).slice(0,3).map(Number);
          const luminance=value=>channels(value).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4)
            .reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
          const ink=luminance(style.color),surface=luminance(style.backgroundColor);
          return {text:node.textContent,classes:node.className,color:style.color,background:style.backgroundColor,
            contrast:(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05)};};
        return {stalled:read('native-status-stalled'),pendingReply:read('native-status-pending-reply')};
      })()`);
      assert.ok(statusChips.stalled.text==='needs attention'&&statusChips.stalled.classes.includes('is-failed')&&
        statusChips.pendingReply.text==='reply pending'&&statusChips.pendingReply.classes.includes('is-waiting')&&
        statusChips.stalled.contrast>=4.5&&statusChips.pendingReply.contrast>=4.5,JSON.stringify(statusChips));
      await js(`document.querySelector('#workOverview [data-session-id="native-status-stalled"]').scrollIntoView({block:'center'})`);
      await captureFresh('work-status-stalled-desktop.png');
      await js(`document.querySelector('#workOverview [data-session-id="native-status-pending-reply"]').scrollIntoView({block:'center'})`);
      await captureFresh('work-status-reply-pending-desktop.png');
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="native-deep-tool-history"]').click()`);
      await waitFor(`!!document.querySelector('#workOverviewPane [data-work-action="find-previous-tool-result"]') &&`+
        ` document.querySelector('#workOverviewPane .work-overview-tool-result')?.textContent.includes('current B tool output')`,
        'current B tool result and explicit older-output action');
      const initial=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),grid=pane.querySelector(':scope > .work-overview-pane-grid'),
          action=pane.querySelector('[data-work-action="find-previous-tool-result"]'),
          rect=action.getBoundingClientRect(),style=getComputedStyle(action);
        const channels=value=>(value.match(/[0-9.]+/g)||[]).slice(0,3).map(Number);
        const luminance=value=>channels(value).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4)
          .reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
        const ink=luminance(style.color),surface=luminance(style.backgroundColor);
        return {current:pane.querySelector('.work-overview-tool-result')?.textContent.includes('current B tool output'),
          prior:!!pane.querySelector('.work-overview-previous-tool-result'),
          olderReads:fixture.reads.filter(read=>read.id==='native-deep-tool-history'&&read.before!==null).length,
          button:action.textContent,paneWidth:pane.getBoundingClientRect().width,
          overflow:pane.scrollWidth-pane.clientWidth,adjacent:grid.nextElementSibling===action.parentElement,
          beforeOutput:!!(action.parentElement.compareDocumentPosition(pane.querySelector('.work-overview-tool-result'))&Node.DOCUMENT_POSITION_FOLLOWING),
          tapHeight:rect.height,contrast:(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05),border:style.borderTopStyle};
      })()`);
      assert.ok(initial.current&&!initial.prior&&initial.olderReads===0&&
        initial.button.includes('Find earlier tool result')&&initial.paneWidth>=450&&initial.overflow<=1&&
        initial.adjacent&&initial.beforeOutput&&initial.tapHeight>=28&&initial.contrast>=4.5&&
        initial.border==='solid',JSON.stringify(initial));
      await captureFresh('work-tool-lookup-action-desktop.png');
      await js(`(() => { const button=document.querySelector('#workOverviewPane [data-work-action="find-previous-tool-result"]');
        button.focus({preventScroll:true});button.click(); })()`);
      await waitFor(`document.querySelector('#workOverviewPane .work-overview-previous-tool-result')?.textContent.includes('middle C config output') &&`+
        ` document.querySelector('#workOverviewPane [data-work-action="find-previous-tool-result"]')?.textContent.includes('Find next earlier tool result')`,
        'middle C output and next-older navigation');
      const middle=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),previous=pane.querySelector('.work-overview-previous-tool-result');
        fixture.deepToolPrevious=previous;previous.open=true;
        return {current:pane.querySelector('.work-overview-tool-result').textContent.includes('current B tool output'),
          middle:previous.textContent.includes('middle C config output'),
          turn:previous.textContent.includes('not current native turn exact-tool-B'),
          focus:document.activeElement===previous.querySelector('summary'),
          reads:fixture.reads.filter(read=>read.id==='native-deep-tool-history'&&read.before!==null).length,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(middle.current&&middle.middle&&middle.turn&&middle.focus&&middle.reads>=1&&middle.overflow<=1,
        JSON.stringify(middle));
      await captureFresh('work-tool-middle-C-desktop.png');
      await js('fixture.notify()');
      await waitFor(`document.querySelector('#workOverviewPane .work-overview-previous-tool-result')===fixture.deepToolPrevious &&`+
        ` fixture.deepToolPrevious.open && document.activeElement===fixture.deepToolPrevious.querySelector('summary')`,
        'previous tool disclosure and keyboard focus survive refresh');
      const readsBefore=await js(`fixture.reads.filter(read=>read.id==='native-deep-tool-history'&&read.before!==null).length`);
      await js(`document.querySelector('#workOverviewPane [data-work-action="find-previous-tool-result"]').click()`);
      await waitFor(`document.querySelector('#workOverviewPane .work-overview-previous-tool-result')?.textContent.includes('previous provider A file')`,
        'previous-provider A tool result recovered');
      const older=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),previous=pane.querySelector('.work-overview-previous-tool-result');
        return {current:pane.querySelector('.work-overview-tool-result').textContent.includes('current B tool output'),
          oldA:previous.textContent.includes('previous provider A file'),provider:previous.textContent.includes('previous provider'),
          turn:previous.textContent.includes('not current native turn exact-tool-B'),
          focused:document.activeElement===previous.querySelector('summary'),
          reads:fixture.reads.filter(read=>read.id==='native-deep-tool-history'&&read.before!==null).length,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(older.current&&older.oldA&&older.provider&&older.turn&&older.focused&&
        older.reads>readsBefore&&older.overflow<=1,JSON.stringify(older));
      await js(`(() => {const previous=document.querySelector('#workOverviewPane .work-overview-previous-tool-result');
        previous.open=true;previous.querySelector('summary').scrollIntoView({block:'center'});})()`);
      await captureFresh('work-tool-previous-A-desktop.png');
      win.webContents.setZoomFactor(1.5);
      await waitFor('innerWidth>700&&innerWidth<1000','150pct tool-history Work view');
      await js(`document.querySelector('#workOverviewPane .work-overview-previous-tool-result summary').scrollIntoView({block:'center'})`);
      const zoom150=await js(`(() => {const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:pane.scrollWidth-pane.clientWidth,
          disclosure:!!pane.querySelector('.work-overview-previous-tool-result')};})()`);
      assert.ok(zoom150.disclosure&&zoom150.width>zoom150.viewport*.8&&zoom150.right<=zoom150.viewport+1&&
        zoom150.overflow<=1,JSON.stringify(zoom150));
      await captureFresh('work-tool-previous-A-150pct.png');
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','200pct narrow tool-history Work view');
      await js(`(() => {const pane=document.getElementById('workOverviewPane'),summary=pane.querySelector('.work-overview-previous-tool-result summary');
        summary.scrollIntoView({block:'center'});const frame=pane.getBoundingClientRect(),target=summary.getBoundingClientRect();
        pane.scrollTop+=target.top-(frame.top+frame.height/2);})()`);
      const zoom200=await js(`(() => {const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect(),
        previous=pane.querySelector('.work-overview-previous-tool-result'),summary=previous.querySelector('summary').getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,left:r.left,right:r.right,overflow:pane.scrollWidth-pane.clientWidth,
          bodyOverflow:document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth,
          text:previous.textContent.includes('previous provider A file'),visible:summary.top>=r.top+20&&summary.bottom<r.bottom,
          focused:document.activeElement===previous.querySelector('summary'),bounds:{top:summary.top,bottom:summary.bottom},panel:{top:r.top,bottom:r.bottom}};})()`);
      assert.ok(zoom200.viewport<=340&&zoom200.width>zoom200.viewport*.8&&zoom200.left>=0&&
        zoom200.right<=zoom200.viewport+1&&zoom200.overflow<=1&&zoom200.bodyOverflow<=1&&
        zoom200.text&&zoom200.visible&&zoom200.focused,JSON.stringify(zoom200));
      await captureFresh('work-tool-previous-A-200pct.png');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      const escaped=await js(`({closed:document.getElementById('workOverviewPane').hidden,
        focused:document.activeElement?.dataset?.sessionId,pendingInputs:fixture.inputs.length})`);
      assert.ok(escaped.closed&&escaped.focused==='native-deep-tool-history'&&escaped.pendingInputs===1,
        JSON.stringify(escaped));
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,
        'Source changed during isolated native tool-history review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-Electron-stepwise-Core-tool-history',
        initial,middle,older,zoom150,zoom200,escaped,
        screenshots:['work-tool-lookup-action-desktop.png','work-tool-middle-C-desktop.png',
          'work-tool-previous-A-desktop.png','work-tool-previous-A-150pct.png','work-tool-previous-A-200pct.png',
          'work-status-stalled-desktop.png','work-status-reply-pending-desktop.png'],statusChips,output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_DEEP_PREVIOUS === '1') {
      nativeStage='exact B with earlier A beyond 80 events, explicit history lookup and 200pct Work access';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<140;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native deep historical Work lookup did not settle: '+label);
      };
      const captureFresh=async(name)=>{
        // Offscreen Electron can return a cached bitmap after a DOM disclosure
        // toggles or a nested sheet scroll. Trigger a real repaint before each
        // snapshot; separately assert live DOM/geometry to avoid stale-image proof.
        win.webContents.invalidate();
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.writeFileSync(path.join(output,name),
          (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      };
      await js(`(() => {
        const now=Date.now(),prototype=fixture.sessions.find(row=>row.id==='oneoff');
        const id='native-deep-A-under-current-B';
        const source={...prototype,id,title:'Current verified B and earlier archived A results',
          conversationId:'native-deep-same-provider',chatIds:['native-deep-same-provider'],
          origin:null,activeTurnId:null,lastTurnOutcome:'completed',
          lastAssistantFinalAt:now-2000,lastToolCallAt:null,lastFinishReportAt:null,
          lastTurnEndAt:now-900,updatedAt:now,toolCalls:0,fileEdits:0,
          finishTurn:{turnId:'exact-current-B',conversationId:'native-deep-same-provider',
            startedAt:now-6000,notified:false,released:true,decisionRevision:null,
            workSeq:0,decisionSeq:0,decisionInputRevision:null}};
        const earlier='RESULT: Original native A validated a durable historical result.\\n'+
          'Earlier implementation facts and test evidence remain recorded. '.repeat(360)+
          '\\nBLOCKERS: Prior A cannot prove current B Send or completion.';
        const progress=seq=>({kind:'progress',seq,time:now-4000,source:'app',
          progressId:'later-native-progress-'+seq,
          message:{text:'Later progress, not a final.',chars:27,truncated:false}});
        const events=[
          {kind:'assistant_message',source:'extension',seq:2,time:now-16000,
            turnId:'older-original-A',messageId:'native-deep-saved-A-final',final:true,
            message:{text:earlier,chars:earlier.length,truncated:false}},
          ...Array.from({length:85},(_,i)=>progress(i+3)),
          {kind:'turn_start',source:'extension',seq:90,time:now-6000,turnId:'exact-current-B'},
          {kind:'assistant_message',source:'extension',seq:110,time:now-2000,
            turnId:'exact-current-B',messageId:'native-deep-current-B-final',final:true,
            message:{text:'RESULT: B current result with exact native turn association.',
              chars:57,truncated:false}},
          ...Array.from({length:45},(_,i)=>progress(i+111))
        ];
        source.events=events.length;
        fixture.reports[id]=events;fixture.sessions.push(source);fixture.strictPaging=true;
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-section="updates"] [data-session-id="native-deep-A-under-current-B"]')`,
        'Work row for exact current B');
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="native-deep-A-under-current-B"]').click()`);
      await waitFor(`!!document.querySelector('#workOverviewPane [data-work-action="find-previous-result"]') &&
        document.querySelector('#workOverviewPane .work-overview-result')?.textContent.includes('B current result')`,
        'current B visible and earlier A outside recent view');
      const initial=await js(`(() => ({
        prior:!!document.querySelector('#workOverviewPane .work-overview-previous-result'),
        current:document.querySelector('#workOverviewPane .work-overview-result')?.textContent.includes('B current result'),
        olderReads:fixture.reads.filter(read=>read.id==='native-deep-A-under-current-B'&&read.before!==null).length,
        button:document.querySelector('#workOverviewPane [data-work-action="find-previous-result"]')?.textContent,
        paneWidth:document.getElementById('workOverviewPane').getBoundingClientRect().width,
        horizontalOverflow:document.getElementById('workOverviewPane').scrollWidth-
          document.getElementById('workOverviewPane').clientWidth
      }))()`);
      const actionPlacement=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),
          grid=pane.querySelector(':scope > .work-overview-pane-grid'),
          action=pane.querySelector('[data-work-action="find-previous-result"]'),
          rect=action.getBoundingClientRect();
        action.scrollIntoView({block:'nearest'});
        const style=getComputedStyle(action);
        const channels=value=>(value.match(/[0-9.]+/g)||[]).slice(0,3).map(Number);
        const luminance=value=>{
          const linear=channels(value).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);
          return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
        };
        const ink=luminance(style.color),surface=luminance(style.backgroundColor);
        return {adjacent:grid.nextElementSibling===action.parentElement,
          beforeRecordedResult:action.parentElement.compareDocumentPosition(
            pane.querySelector('.work-overview-result'))&Node.DOCUMENT_POSITION_FOLLOWING,
          minTapHeight:rect.height,contrast:(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05),
          border:style.borderTopStyle};
      })()`);
      assert.ok(!initial.prior&&initial.current&&initial.olderReads===0&&
        initial.button.includes('Find earlier saved result')&&initial.paneWidth>=450&&
        initial.horizontalOverflow<=1&&actionPlacement.adjacent&&actionPlacement.beforeRecordedResult&&
        actionPlacement.minTapHeight>=28&&actionPlacement.contrast>=4.5&&
        actionPlacement.border==='solid',JSON.stringify({initial,actionPlacement}));
      await captureFresh('work-deep-lookup-action-desktop.png');
      await js(`(() => {
        const find=document.querySelector('#workOverviewPane [data-work-action="find-previous-result"]');
        find.focus({preventScroll:true});find.click();
      })()`);
      await waitFor(`!!document.querySelector('#workOverviewPane .work-overview-previous-result') &&
        document.querySelector('#workOverviewPane [data-work-action="find-previous-result"]')?.textContent.includes('Find next earlier result')`,
        'older A exact result recovered through explicit archived page');
      const recovered=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const previous=pane.querySelector('.work-overview-previous-result');
        fixture.deepHistorical=previous;
        const disclosure=previous.querySelector('summary');
        previous.open=true;
        return {current:pane.querySelector('.work-overview-result').textContent.includes('B current result'),
          older:previous.textContent.includes('Original native A validated'),
          marked:previous.textContent.includes('not current native turn exact-current-B'),
          initialChars:previous.querySelector('.work-overview-result-body').textContent.length,
          priorFocus:document.activeElement===disclosure,
          olderReads:fixture.reads.filter(read=>read.id==='native-deep-A-under-current-B'&&read.before!==null).length,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(recovered.current&&recovered.older&&recovered.marked&&
        recovered.initialChars===12000&&recovered.priorFocus&&recovered.olderReads>=1&&
        recovered.overflow<=1,JSON.stringify(recovered));
      await js(`(() => {
        const expand=fixture.deepHistorical.querySelector('[data-work-action="expand-previous-result"]');
        expand.focus({preventScroll:true});expand.click();fixture.deepHistoricalExpand=expand;
      })()`);
      await js(`fixture.notify()`);
      await waitFor(`document.querySelector('#workOverviewPane [data-work-action="expand-previous-result"]')?.getAttribute('aria-expanded')==='true'`,
        'expanded older A survives native Work refresh');
      const expanded=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const earlier=pane.querySelector('.work-overview-previous-result');
        return {same:earlier===fixture.deepHistorical,open:earlier.open,
          end:earlier.querySelector('.work-overview-result-body').textContent.includes('Prior A cannot prove current B'),
          chars:earlier.querySelector('.work-overview-result-body').textContent.length,
          focused:document.activeElement===fixture.deepHistoricalExpand,
          olderReads:fixture.reads.filter(read=>read.id==='native-deep-A-under-current-B'&&read.before!==null).length,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(expanded.same&&expanded.open&&expanded.end&&expanded.chars>12000&&
        expanded.focused&&expanded.olderReads===recovered.olderReads&&expanded.overflow<=1,
        JSON.stringify(expanded));
      await js(`fixture.deepHistorical.querySelector('summary').scrollIntoView({block:'center'})`);
      await captureFresh('work-deep-prior-A-desktop.png');
      win.webContents.setZoomFactor(1.5);
      await waitFor('innerWidth>700&&innerWidth<1000','150pct Work view');
      await js(`fixture.deepHistorical.querySelector('summary').scrollIntoView({block:'center'})`);
      const zoom150=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:pane.scrollWidth-pane.clientWidth,
          disclosure:!!pane.querySelector('.work-overview-previous-result')};
      })()`);
      assert.ok(zoom150.disclosure&&zoom150.width>zoom150.viewport*.8&&
        zoom150.right<=zoom150.viewport+1&&zoom150.overflow<=1,JSON.stringify(zoom150));
      await captureFresh('work-deep-prior-A-150pct.png');
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','200pct narrow Work view');
      await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const summary=fixture.deepHistorical.querySelector('summary');
        summary.scrollIntoView({block:'center'});
        const frame=pane.getBoundingClientRect(),target=summary.getBoundingClientRect();
        pane.scrollTop+=target.top-(frame.top+frame.height/2);
      })()`);
      const zoom200=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        const previous=pane.querySelector('.work-overview-previous-result');
        const previousSummary=previous.querySelector('summary').getBoundingClientRect();
        const focus=fixture.deepHistoricalExpand.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,left:r.left,right:r.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          bodyOverflow:document.getElementById('workOverviewBody').scrollWidth-
            document.getElementById('workOverviewBody').clientWidth,
          text:previous.textContent.includes('Prior A cannot prove current B'),
          previousVisible:previousSummary.top>=r.top+20&&previousSummary.bottom<r.bottom,
          previousTop:previousSummary.top,
          paneScroll: pane.scrollTop,
          focusAttached:document.activeElement===fixture.deepHistoricalExpand,
          focusBounds:{top:focus.top,bottom:focus.bottom},panel:{top:r.top,bottom:r.bottom}};
      })()`);
      assert.ok(zoom200.viewport<=340&&zoom200.width>zoom200.viewport*.8&&zoom200.left>=0&&
        zoom200.right<=zoom200.viewport+1&&zoom200.overflow<=1&&
        zoom200.bodyOverflow<=1&&zoom200.text&&zoom200.focusAttached&&zoom200.previousVisible,
        JSON.stringify(zoom200));
      await captureFresh('work-deep-prior-A-200pct.png');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
        type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27
      });
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
        type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27
      });
      const escaped=await js(`({
        closed:document.getElementById('workOverviewPane').hidden,
        focused:document.activeElement?.dataset?.sessionId,
        pendingInputs:fixture.inputs.length
      })`);
      assert.ok(escaped.closed&&escaped.focused==='native-deep-A-under-current-B'&&
        escaped.pendingInputs===1,JSON.stringify(escaped));
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,
        'Source changed during isolated native historical Work review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-Electron-bounded-past-result-navigation',
        initial,actionPlacement,recovered,expanded,zoom150,zoom200,escaped,
        screenshots:['work-deep-lookup-action-desktop.png','work-deep-prior-A-desktop.png','work-deep-prior-A-150pct.png',
          'work-deep-prior-A-200pct.png'],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_ARCHIVED_OUTPUTS === '1') {
      nativeStage='native saved Work expansion, keyboard navigation and uncertain companion wait';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<110;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native Work observation did not settle: '+label);
      };
      await js(`(() => {
        const now=Date.now(),example=fixture.sessions.find(row=>row.id==='oneoff');
        for(let index=0;index<12;index++){
          const id='native-archive-'+index,provider='native-archive-provider-'+index,at=now-index*35;
          const row={...example,id,title:'Previously saved workflow result '+index,
            conversationId:provider,chatIds:[provider],origin:null,lastToolCallAt:null,
            activeTurnId:null,updatedAt:at,lastAssistantFinalAt:at,
            lastTurnEndAt:at+10,lastTurnOutcome:'completed'};
          fixture.sessions.push(row);
          const body='RESULT: Earlier saved output '+index+' remains available after additional work.';
          fixture.reports[id]=[{kind:'assistant_message',seq:index+1,time:at,source:'extension',
            messageId:'native-archive-result-'+index,final:true,state:'final',
            message:{text:body,chars:body.length,truncated:false}}];
        }
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-action="more-updates"]') &&
        document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length===6`,
        'bounded initial results');
      const initial=await js(`({
        visible:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
        omittedWorker:!document.querySelector('[data-work-section="updates"] [data-session-id="worker"]'),
        more:document.querySelector('[data-work-action="more-updates"]')?.textContent
      })`);
      assert.ok(initial.visible===6&&initial.omittedWorker&&initial.more.includes('older'),JSON.stringify(initial));
      await js(`document.querySelector('[data-work-action="more-updates"]').click()`);
      const firstBatch=await js(`({
        count:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
        focus:document.activeElement?.dataset.sessionId,
        more:document.querySelector('[data-work-action="more-updates"]')?.textContent
      })`);
      assert.ok(firstBatch.count===12&&firstBatch.focus&&firstBatch.more.includes('older'),JSON.stringify(firstBatch));
      await js(`document.querySelector('[data-work-action="more-updates"]').click()`);
      const expanded=await js(`({
        count:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
        worker:!!document.querySelector('[data-work-section="updates"] [data-session-id="worker"]'),
        oneoff:!!document.querySelector('[data-work-section="updates"] [data-session-id="oneoff"]'),
        focus:document.activeElement?.dataset.sessionId,
        more:!!document.querySelector('[data-work-action="more-updates"]')
      })`);
      assert.ok(expanded.count>=15&&expanded.worker&&expanded.oneoff&&expanded.focus&&!expanded.more,
        JSON.stringify(expanded));
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="worker"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Checked accessible controls')`,
        'old exact worker output');
      await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const disclosure=pane.querySelector('.work-overview-result');
        disclosure.open=true;disclosure.querySelector('summary').focus({preventScroll:true});
      })()`);
      await js(`fixture.notify()`);
      await waitFor(`document.getElementById('workOverviewPane')?.querySelector('.work-overview-result')?.open`,
        'focused expanded worker report');
      const result=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const disclosure=pane.querySelector('.work-overview-result');
        return {opened:disclosure.open,focused:document.activeElement===disclosure.querySelector('summary'),
          workerResult:disclosure.textContent.includes('Checked accessible controls'),
          primeReceipt:pane.textContent.includes('Prime received this report')};
      })()`);
      assert.ok(result.opened&&result.focused&&result.workerResult&&result.primeReceipt,JSON.stringify(result));
      win.setSize(640,900);win.webContents.setZoomFactor(2);
      await waitFor('window.innerWidth<=340','200% zoom');
      await js(`document.getElementById('workOverviewPane').querySelector('[data-work-action="close"]').focus({preventScroll:true})`);
      const zoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        const root=document.getElementById('workOverviewBody');
        return {viewport:innerWidth,width:rect.width,left:rect.left,right:rect.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          listOverflow:root.scrollWidth-root.clientWidth,
          closeFocused:document.activeElement===pane.querySelector('[data-work-action="close"]')};
      })()`);
      assert.ok(zoom.viewport<=340&&zoom.width>zoom.viewport*.8&&zoom.left>=0&&
        zoom.right<=zoom.viewport+1&&zoom.overflow<=1&&zoom.listOverflow<=1&&
        zoom.closeFocused,JSON.stringify(zoom));
      fs.writeFileSync(path.join(output,'work-older-saved-report-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`document.querySelector('#workOverviewPane [data-work-action="close"]').click()`);

      // The real extension stylesheet is evaluated in this isolated Electron
      // renderer. Existing content.js stage contracts distinguish a timed
      // active helper stage from an untimed evidence/Chrome wait.
      const overlayCss=fs.readFileSync(path.join(root,'extension/overlay.css'),'utf8');
      await js(`(() => {
        const globalDisable=[...document.querySelectorAll('style')].find(
          tag=>tag.textContent.includes('*,*::before,*::after{animation:none!important'));
        globalDisable?.remove();
        const stylesheet=document.createElement('style');
        stylesheet.textContent=${JSON.stringify(overlayCss)};
        document.head.append(stylesheet);
        const stage=document.createElement('div');stage.className='clf-stage';
        stage.dataset.clfStageKind='goal';stage.id='synthetic-companion-stage';
        stage.style.cssText='position:fixed;left:12px;top:70px;margin:0;max-width:none;width:calc(100vw - 24px);z-index:2147483645';
        stage.innerHTML='<div class="clf-stage-head"><span class="clf-stage-title">Loop waiting for verified completion</span><span class="clf-stage-detail">No exact original native tool completion receipt; do not resend the saved message.</span><span class="clf-stage-timer" hidden></span></div><div class="clf-stage-steps"><div class="clf-stage-step" data-clf-step="now"><div class="clf-stage-track"></div><div class="clf-stage-name">Waiting for evidence</div></div></div>';
        document.body.append(stage);
      })()`);
      const waiting=await js(`(() => {
        const stage=document.getElementById('synthetic-companion-stage');
        const pseudo=getComputedStyle(stage.querySelector('.clf-stage-track'),'::after');
        const rect=stage.getBoundingClientRect();
        return {display:pseudo.display,animation:pseudo.animationName,viewport:innerWidth,
          width:rect.width,left:rect.left,right:rect.right,
          overflow:stage.scrollWidth-stage.clientWidth,
          readable:stage.textContent.includes('No exact original native tool completion receipt')};
      })()`);
      assert.ok(waiting.display==='none'&&waiting.animation==='none'&&waiting.readable&&
        waiting.left>=0&&waiting.right<=waiting.viewport+1&&waiting.overflow<=1,JSON.stringify(waiting));
      fs.writeFileSync(path.join(output,'companion-evidence-wait-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      const running=await js(`(() => {
        const stage=document.getElementById('synthetic-companion-stage');
        stage.querySelector('.clf-stage-timer').hidden=false;
        stage.querySelector('.clf-stage-title').textContent='ChatGPT helper actively drafting';
        const pseudo=getComputedStyle(stage.querySelector('.clf-stage-track'),'::after');
        return {display:pseudo.display,animation:pseudo.animationName,
          reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
      })()`);
      assert.ok(running.display==='block'&&
        (running.reducedMotion ? running.animation==='none' : running.animation==='clf-stage-run'),
        JSON.stringify(running));
      for(const [name,hash] of sourceBaseline)
        assert.equal(sourceHash(name),hash,'Concurrent source changed during isolated Work/overlay review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-Windows-Electron-Work-older-outputs-and-overlay',
        initial,firstBatch,expanded,result,zoom,waiting,running,
        screenshots:['work-older-saved-report-200pct.png','companion-evidence-wait-200pct.png'],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_TOOL_OUTPUT === '1') {
      nativeStage='isolated Electron closed Core output, interrupted history, same-provider turn B and 200pct access';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<140;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native Work tool-output evidence did not settle at '+label);
      };
      await js(`(() => {
        const now=Date.now(),sample=fixture.sessions.find(row=>row.id==='oneoff');
        const core={...sample,id:'saved-tool-only',title:'Retained Core result after a closed tab and interrupted history',
          conversationId:'native-saved-tool',chatIds:['native-saved-tool'],origin:null,
          fileEdits:0,lastFileChangeAt:null,lastAssistantFinalAt:null,toolCalls:1,
          lastToolCallAt:now-12000,lastTurnOutcome:'completed',lastTurnEndAt:now-6000,
          activeTurnId:null,endedAt:now-6000,updatedAt:now-5000};
        const later={...core,id:'saved-tool-after-B',title:'Previous Core tool after a newer B turn',
          conversationId:'native-provider-B',chatIds:['native-provider-B'],
          lastToolCallAt:now-18000,lastTurnEndAt:now-2000,updatedAt:now-1900,
          finishTurn:{turnId:'new-empty-B',conversationId:'native-provider-B',startedAt:now-5000,
            notified:false,released:true,decisionRevision:null,workSeq:0,decisionSeq:0,decisionInputRevision:null}};
        const output='RESULT: Original recorded Core proof from the closed chat.\\n'+
          'Recorded tool outcome and original file facts. '.repeat(430)+
          '\\nBLOCKERS: Source result alone does not establish installed or native completion.';
        fixture.reports[core.id]=[{kind:'tool_call',source:'mcp',seq:2,time:now-12000,
          turnId:'original-tool-turn',call:{callId:'native-retained-tool',tool:'read',
            conversationId:core.conversationId,attribution:'request_id',attributionMethod:'request_id',
            outcome:'ok',durationMs:35,args:{text:'{}',chars:2,truncated:false},
            result:{text:output,chars:output.length,truncated:true},
            summary:{kind:'read',title:'Recorded closed-tab source evidence',tone:'neutral'}}},
          ...Array.from({length:190},(_,i)=>({kind:'progress',source:'app',seq:i+3,
            time:now-10000+i*5,progressId:'latest-progress-'+i,
            message:{text:'Later progress without new tool output.',chars:39,truncated:false}}))];
        fixture.reports[later.id]=[
          {kind:'tool_call',source:'mcp',seq:2,time:now-18000,turnId:'original-A',
            call:{callId:'native-old-A-tool',tool:'read',conversationId:later.conversationId,
              attribution:'request_id',attributionMethod:'request_id',outcome:'ok',durationMs:25,
              args:{text:'{}',chars:2,truncated:false},
              result:{text:'RESULT: Saved earlier A tool remains historical.',chars:48,truncated:false},
              summary:{kind:'read',title:'Earlier A-only Core evidence',tone:'neutral'}}},
          {kind:'turn_start',source:'extension',seq:3,time:now-5000,turnId:'new-empty-B'},
          {kind:'turn_end',source:'extension',seq:4,time:now-2000,turnId:'new-empty-B',outcome:'completed'}];
        fixture.sessions.push(core,later);fixture.strictPaging=true;
        fixture.originalToolGetSession=window.api.getSession;
        fixture.failToolOlderOnce=true;
        window.api.getSession=(id,query={})=>
          id===core.id&&query.before!==undefined&&fixture.failToolOlderOnce
            ?(fixture.failToolOlderOnce=false,Promise.resolve({ok:false,error:'Synthetic interrupted older tool page'}))
            :fixture.originalToolGetSession(id,query);
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-section="updates"] [data-session-id="saved-tool-only"]')`,
        'closed tab tool-only Work row');
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="saved-tool-only"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Older tool result') &&
        !!document.querySelector('#workOverviewPane [data-work-action="retry-older"]')`,
        'interrupted first older-page lookup');
      const interrupted=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {older:pane.textContent.includes('temporarily unavailable'),
          action:!!pane.querySelector('[data-work-action="retry-older"]'),
          noBody:!pane.querySelector('.work-overview-tool-result'),
          toolRow:document.querySelector('[data-work-section="updates"] [data-session-id="saved-tool-only"]')?.textContent,
          noFalseFinal:!pane.textContent.includes('Final answer recorded')};
      })()`);
      assert.ok(interrupted.older&&interrupted.action&&interrupted.noBody&&interrupted.noFalseFinal&&
        interrupted.toolRow.includes('Recorded tool activity'),JSON.stringify(interrupted));
      await js(`document.querySelector('#workOverviewPane [data-work-action="retry-older"]').click()`);
      await waitFor(`!!document.querySelector('#workOverviewPane .work-overview-tool-result') &&
        !document.querySelector('#workOverviewPane [data-work-action="retry-older"]')`,
        'retrieved original tool beyond recent 80');
      const saved=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),result=pane.querySelector('.work-overview-tool-result');
        result.open=true;fixture.toolSection=result;fixture.toolBody=result.querySelector('.work-overview-result-body');
        return {summary:result.querySelector('summary').textContent,
          preview:fixture.toolBody.textContent.length,
          origin:fixture.toolBody.textContent.includes('Original recorded Core proof'),
          truncated:result.textContent.includes('Original recording was truncated'),
          expand:result.querySelector('[data-work-action="expand-tool-result"]')?.getAttribute('aria-expanded'),
          olderReads:fixture.reads.filter(entry=>entry.id==='saved-tool-only'&&entry.before!==null).length};
      })()`);
      assert.ok(saved.summary.includes('Read recorded tool result')&&saved.preview===12000&&
        saved.origin&&saved.truncated&&saved.expand==='false'&&saved.olderReads>=1,JSON.stringify(saved));
      await js(`(() => {
        const expand=fixture.toolSection.querySelector('[data-work-action="expand-tool-result"]');
        expand.focus({preventScroll:true});expand.click();
      })()`);
      const expanded=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),expand=fixture.toolSection.querySelector('[data-work-action="expand-tool-result"]');
        return {chars:fixture.toolBody.textContent.length,
          ending:fixture.toolBody.textContent.includes('BLOCKERS: Source result alone'),
          focus:document.activeElement===expand,expanded:expand.getAttribute('aria-expanded'),
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(expanded.chars>12000&&expanded.ending&&expanded.focus&&expanded.expanded==='true'&&
        expanded.overflow<=1,JSON.stringify(expanded));
      await js('fixture.notify()');
      await waitFor(`document.querySelector('#workOverviewPane [data-work-action="expand-tool-result"]')?.getAttribute('aria-expanded')==='true'`,
        'expanded saved tool stable after status refresh');
      const retained=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),result=pane.querySelector('.work-overview-tool-result');
        return {same:result===fixture.toolSection,body:result.querySelector('.work-overview-result-body')===fixture.toolBody,
          open:result.open,focused:document.activeElement===result.querySelector('[data-work-action="expand-tool-result"]'),
          olderReads:fixture.reads.filter(entry=>entry.id==='saved-tool-only'&&entry.before!==null).length};
      })()`);
      assert.ok(retained.same&&retained.body&&retained.open&&retained.focused&&
        retained.olderReads===saved.olderReads,JSON.stringify(retained));
      const desktop=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(desktop.viewport>=1000&&desktop.width>=450&&desktop.right<=desktop.viewport+1&&
        desktop.overflow<=1,JSON.stringify(desktop));
      win.webContents.setZoomFactor(1.5);
      await waitFor('innerWidth>700&&innerWidth<1000','150pct native view');
      const zoom150=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(zoom150.width>zoom150.viewport*.8&&zoom150.right<=zoom150.viewport+1&&
        zoom150.overflow<=1,JSON.stringify(zoom150));
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','200pct native view');
      await js(`(() => {
        const tool=document.querySelector('#workOverviewPane .work-overview-tool-result');
        tool.scrollIntoView({block:'center'});
      })()`);
      const zoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,left:r.left,right:r.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          bodyOverflow:document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth,
          focused:document.activeElement===fixture.toolSection.querySelector('[data-work-action="expand-tool-result"]')};
      })()`);
      assert.ok(zoom.width>zoom.viewport*.8&&zoom.left>=0&&zoom.right<=zoom.viewport+1&&
        zoom.overflow<=1&&zoom.bodyOverflow<=1&&zoom.focused,JSON.stringify(zoom));
      fs.writeFileSync(path.join(output,'work-full-tool-result-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="saved-tool-after-B"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Original A-only') ||
        document.getElementById('workOverviewPane')?.textContent.includes('Earlier A-only')`,
        'newer B turn leaves A tool historical');
      const turn=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),row=document.querySelector('[data-work-section="updates"] [data-session-id="saved-tool-after-B"]');
        return {older:row.textContent.includes('Previous tool activity retained'),
          noCurrent: pane.textContent.includes('Latest turn completed; no exact final or tool outcome recorded'),
          tool: pane.querySelector('.work-overview-tool-result summary')?.textContent,
          text: pane.querySelector('.work-overview-tool-result')?.textContent,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(turn.older&&turn.noCurrent&&turn.tool.includes('provider/turn unverified')&&
        turn.text.includes('Saved earlier A tool remains historical')&&turn.overflow<=1,JSON.stringify(turn));
      await js(`document.querySelector('#workOverviewPane .work-overview-tool-result').scrollIntoView({block:'start'})`);
      fs.writeFileSync(path.join(output,'work-previous-turn-tool-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      nativeStage='isolated native closed B result and expanded earlier A final, preserved keyboard focus';
      await js(`(() => {
        const now=Date.now(),owner=fixture.sessions.find(row=>row.id==='saved-tool-after-B');
        owner.lastAssistantFinalAt=now-1200;owner.lastToolCallAt=now-2300;
        owner.lastTurnEndAt=now-800;owner.lastTurnOutcome='completed';
        owner.fileEdits=1;owner.lastFileChangeAt=now-2300;owner.updatedAt=now;
        owner.finishTurn.startedAt=now-4700;
        const earlier='RESULT: Earlier A answer is preserved in full.\\n'+
          'Recorded earlier result and provenance. '.repeat(430)+
          '\\nBLOCKERS: This A output does not prove B was sent.';
        fixture.reports[owner.id]=[
          {kind:'assistant_message',source:'extension',seq:1,time:now-17000,turnId:'original-A',
            messageId:'saved-long-A-final',final:true,
            message:{text:earlier,chars:earlier.length,truncated:false}},
          {kind:'tool_call',source:'mcp',seq:2,time:now-15000,turnId:'original-A',
            call:{callId:'old-A-read',tool:'read',outcome:'ok',durationMs:20,args:{text:'{}',chars:2,truncated:false},
              result:{text:'Earlier tool evidence',chars:21,truncated:false},
              summary:{kind:'read',title:'Original A read',tone:'neutral'}}},
          {kind:'turn_start',source:'extension',seq:3,time:now-4700,turnId:'new-empty-B'},
          {kind:'tool_call',source:'mcp',seq:4,time:now-2300,turnId:'new-empty-B',
            call:{callId:'exact-new-B-edit',tool:'apply_patch',outcome:'ok',durationMs:30,
              args:{text:'{}',chars:2,truncated:false},
              result:{text:'Native fixture B changed its synthetic file',chars:43,truncated:false},
              changes:[{path:'synthetic/native-B.ts',added:5,removed:1,approximate:false}],
              summary:{kind:'edit',title:'Current B synthetic edit',tone:'good'}}},
          {kind:'assistant_message',source:'extension',seq:5,time:now-1200,turnId:'new-empty-B',
            messageId:'exact-B-final',final:true,
            message:{text:'RESULT: New B saved result with exact current turn.',chars:49,truncated:false}},
          {kind:'turn_end',source:'extension',seq:6,time:now-800,turnId:'new-empty-B',outcome:'completed'}
        ];
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('#workOverviewPane .work-overview-previous-result') &&
        document.querySelector('#workOverviewPane .work-overview-result')?.textContent.includes('New B saved result')`,
        'closed B preserves both current B and earlier A result');
      await js(`(() => {
        const previous=document.querySelector('#workOverviewPane .work-overview-previous-result');
        previous.open=true;fixture.olderFinalSection=previous;
        const expand=previous.querySelector('[data-work-action="expand-previous-result"]');
        expand.focus({preventScroll:true});expand.click();fixture.olderFinalExpand=expand;
      })()`);
      const closed=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const previous=pane.querySelector('.work-overview-previous-result');
        return {newResult:pane.querySelector('.work-overview-result')?.textContent.includes('New B saved result'),
          oldResult:previous.querySelector('.work-overview-result-body')?.textContent.includes('Earlier A answer'),
          oldLength:previous.querySelector('.work-overview-result-body')?.textContent.length,
          priorLabel:previous.querySelector('summary')?.textContent,
          bChange:[...pane.querySelectorAll('.work-overview-pane-field')]
            .find(row=>row.querySelector('b')?.textContent==='Changes')?.textContent,
          focus:document.activeElement===fixture.olderFinalExpand,
          expanded:fixture.olderFinalExpand.getAttribute('aria-expanded'),
          horizontalOverflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(closed.newResult&&closed.oldResult&&closed.oldLength>12000&&
        closed.priorLabel.includes('previous saved final answer')&&
        closed.bChange.includes('synthetic/native-B.ts')&&
        closed.focus&&closed.expanded==='true'&&closed.horizontalOverflow<=1,JSON.stringify(closed));
      await js('fixture.notify()');
      await waitFor(`document.querySelector('#workOverviewPane [data-work-action="expand-previous-result"]')?.getAttribute('aria-expanded')==='true'`,
        'focused A expansion survives native Work refresh');
      const olderStable=await js(`(() => ({
        same:document.querySelector('#workOverviewPane .work-overview-previous-result')===fixture.olderFinalSection,
        focus:document.activeElement===fixture.olderFinalExpand,
        open:fixture.olderFinalSection.open,
        overflow:document.getElementById('workOverviewPane').scrollWidth-document.getElementById('workOverviewPane').clientWidth
      }))()`);
      assert.ok(olderStable.same&&olderStable.focus&&olderStable.open&&olderStable.overflow<=1,JSON.stringify(olderStable));
      // The fixture used preventScroll to verify focus identity. For visual
      // inspection explicitly bring the focused disclosure into the same
      // scrollport, as a user navigating there by keyboard/click would do.
      await js(`fixture.olderFinalExpand.scrollIntoView({block:'center'})`);
      const olderVisible=await js(`(() => {
        const pane=document.getElementById('workOverviewPane').getBoundingClientRect(),
          target=fixture.olderFinalExpand.getBoundingClientRect();
        return {top:target.top,bottom:target.bottom,paneTop:pane.top,paneBottom:pane.bottom,
          targetVisible:target.top>=pane.top+20&&target.bottom<=pane.bottom,
          focused:document.activeElement===fixture.olderFinalExpand};
      })()`);
      assert.ok(olderVisible.targetVisible&&olderVisible.focused,JSON.stringify(olderVisible));
      fs.writeFileSync(path.join(output,'work-closed-B-with-expanded-prior-A-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      const sendBefore=await js('fixture.inputs.length');
      assert.equal(sendBefore,1,'Fixture must not create a second input or retry the original');
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,
        'Concurrent source changed during native tool-only Work review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-native-Work-tool-only-history-and-turn-provenance',
        interrupted,saved,expanded,retained,desktop,zoom150,zoom,turn,closed,olderStable,olderVisible,
        screenshots:['work-full-tool-result-200pct.png','work-previous-turn-tool-200pct.png',
          'work-closed-B-with-expanded-prior-A-200pct.png'],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_CUSTODY === '1') {
      nativeStage='isolated Electron historical approval, original failed Send and Work queue-outage recovery';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<130;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native Work custody did not settle at '+label);
      };
      await js(`(() => {
        const now=Date.now(),row=fixture.sessions.find(item=>item.id==='oneoff');
        row.title='Exact current work after earlier provider approval and failed delivery';
        row.activeTurnId='current-native-B';row.lastTurnOutcome=null;
        row.updatedAt=now;row.fileEdits=1;row.lastFileChangeAt=now-1000;
        row.finishTurn={turnId:'current-native-B',conversationId:row.conversationId,
          startedAt:now-3000,notified:false,released:true,
          decisionRevision:null,workSeq:0,decisionSeq:0,decisionInputRevision:null};
        const approval='ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.';
        fixture.reports.oneoff=[
          {kind:'assistant_message',seq:1,time:now-12000,source:'extension',
            turnId:'original-native-A',messageId:'native-previous-useful-final',final:true,
            message:{text:'RESULT: Previously verified source work remains available. NEXT: Review the original receipt without resending.',
              chars:110,truncated:false}},
          {kind:'progress',seq:2,time:now-9000,source:'app',
            progressId:'approval-wait:'+row.conversationId+':prior-turn-A',
            message:{text:approval,chars:approval.length,truncated:false}},
          {kind:'turn_start',seq:3,time:now-3000,source:'extension',turnId:'current-native-B'},
          {kind:'assistant_message',seq:4,time:now-2000,source:'extension',
            turnId:'current-native-B',messageId:'native-B-stream',state:'streaming',final:false,
            message:{text:'Working on B, no current final is recorded.',chars:44,truncated:false}}
        ];
        fixture.inputs.push(
          {id:'fixture-failed-original',sessionId:row.id,conversationId:row.conversationId,
            mode:'auto',text:'PRIVATE failed authorized original input',
            model:'gpt-6-thinking',reasoningEffort:'xhigh',state:'failed',owner:null,
            createdAt:now-7000,dueAt:0,sendAuthorizedAt:now-6900,
            recoveryFailure:{phase:'native_send_ambiguous',retrySafe:false,detail:'Native receipt absent'},
            error:'Original Send status not confirmed'},
          {id:'fixture-queued-after-failure',sessionId:row.id,conversationId:row.conversationId,
            mode:'auto',text:'PRIVATE saved next work not yet sent',
            model:'gpt-6-thinking',reasoningEffort:'xhigh',state:'queued',owner:null,
            createdAt:now-1000,dueAt:0});
        const original=window.api.getSessionControls;
        window.api.getSessionControls=id=>id==='oneoff'
          ?Promise.resolve({ok:true,data:{sessionId:id,conversationId:row.conversationId,
              activeTurnId:'current-native-B',automation:'off',plan:null,activeWork:null,
              blocked:'',finishHeld:false,objective:''}})
          :original(id);
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-section="updates"] [data-session-id="oneoff"]')`,
        'exact current task in updates');
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="oneoff"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Earlier-turn provider approval observed') &&
        document.getElementById('workOverviewPane')?.textContent.includes('Failed delivery · native Send unresolved') &&
        document.getElementById('workOverviewPane')?.textContent.includes('Saved input awaiting native Send')`,
        'historical approval and independent failed/queued delivery facts');
      const accurate=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=label=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===label)?.textContent??'';
        const approval=field('Status & next action');
        return {historical:approval.includes('Earlier-turn provider approval observed'),
          notCurrent:!approval.includes('Recorded separately: Provider tool approval observed'),
          failed:approval.includes('Failed delivery · native Send unresolved'),
          queued:approval.includes('Saved input awaiting native Send'),
          streaming:approval.includes('Streaming text recorded on this turn'),
          retained:!!pane.querySelector('.work-overview-result')?.textContent.includes('Previously verified source work'),
          current:field('Just did'),review:!!pane.querySelector('[data-work-action="delivery"]'),
          noPrivate:!pane.textContent.includes('PRIVATE failed')&&!pane.textContent.includes('PRIVATE saved next')};
      })()`);
      assert.ok(accurate.historical&&accurate.notCurrent&&accurate.failed&&accurate.queued&&
        accurate.streaming&&accurate.retained&&accurate.review&&accurate.noPrivate&&
        !accurate.current.includes('Previously verified source work'),JSON.stringify(accurate));
      const desktop=await js(`(() => {
        const r=document.getElementById('workOverviewPane').getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:document.getElementById('workOverviewPane').scrollWidth-
          document.getElementById('workOverviewPane').clientWidth};
      })()`);
      assert.ok(desktop.viewport>=1000&&desktop.width>=430&&desktop.right<=desktop.viewport+1&&desktop.overflow<=1,JSON.stringify(desktop));
      win.webContents.setZoomFactor(1.5);
      await waitFor('innerWidth>700&&innerWidth<1000','150pct current Work');
      const intermediate=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:r.width,right:r.right,overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(intermediate.width>intermediate.viewport*.8&&
        intermediate.right<=intermediate.viewport+1&&intermediate.overflow<=1,JSON.stringify(intermediate));
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','200pct Work');
      const narrow=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),r=pane.getBoundingClientRect();
        const button=pane.querySelector('[data-work-action="close"]');
        button.focus({preventScroll:true});
        return {viewport:innerWidth,width:r.width,left:r.left,right:r.right,overflow:pane.scrollWidth-pane.clientWidth,
          rootOverflow:document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth,
          focus:document.activeElement===button};
      })()`);
      assert.ok(narrow.width>narrow.viewport*.8&&narrow.left>=0&&narrow.right<=narrow.viewport+1&&
        narrow.overflow<=1&&narrow.rootOverflow<=1&&narrow.focus,JSON.stringify(narrow));
      await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        pane.scrollTop=pane.querySelector('.work-overview-pane-grid').offsetTop;
      })()`);
      fs.writeFileSync(path.join(output,'work-historical-approval-failed-original-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      const review=await js(`(() => {
        const button=document.querySelector('#workOverviewPane [data-work-action="delivery"]');
        button.focus({preventScroll:true});button.click();
        const queue=document.getElementById('deliveryQueuePanel');
        return {queue:queue.open,focus:document.activeElement===queue.querySelector('summary'),
          original:fixture.inputs.filter(row=>row.id==='fixture-failed-original')[0]?.state,
          follower:fixture.inputs.filter(row=>row.id==='fixture-queued-after-failure')[0]?.state};
      })()`);
      assert.deepEqual(review,{queue:true,focus:true,original:'failed',follower:'queued'});
      const unavailable=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const result=pane.querySelector('.work-overview-result');
        result.open=true;fixture.retainedResult=result;
        fixture.savedListInputs=window.api.listInputs;
        window.api.listInputs=()=>Promise.resolve({ok:false,error:'Synthetic queue read failure'});
        fixture.notify();return true;
      })()`);
      assert.ok(unavailable);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Latest delivery queue read unavailable') &&
        !!document.querySelector('#workOverviewPane [data-work-action="retry-delivery-read"]')`,
        'queue unavailable with retained saved answer');
      const loss=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {failedRead:pane.textContent.includes('Latest delivery queue read unavailable'),
          currentQueueClaim:pane.textContent.includes('Saved input awaiting native Send'),
          queueMeta:document.getElementById('workOverviewMeta')?.textContent,
          result:pane.querySelector('.work-overview-result')===fixture.retainedResult&&fixture.retainedResult.open,
          retry:!!pane.querySelector('[data-work-action="retry-delivery-read"]'),
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(loss.failedRead&&!loss.currentQueueClaim&&loss.result&&loss.retry&&loss.overflow<=1&&
        loss.queueMeta.includes('delivery status unknown')&&!loss.queueMeta.includes('1 queued'),JSON.stringify(loss));
      fs.writeFileSync(path.join(output,'work-queue-read-unavailable-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`(() => {
        window.api.listInputs=fixture.savedListInputs;
        const retry=document.querySelector('#workOverviewPane [data-work-action="retry-delivery-read"]');
        retry.focus({preventScroll:true});retry.click();
      })()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Saved input awaiting native Send') &&
        !document.querySelector('#workOverviewPane [data-work-action="retry-delivery-read"]')`,
        'explicit queue reread restores only original custody');
      const recovered=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {failed:pane.textContent.includes('Failed delivery · native Send unresolved'),
          queued:pane.textContent.includes('Saved input awaiting native Send'),
          queueMeta:document.getElementById('workOverviewMeta')?.textContent,
          historical:pane.textContent.includes('Earlier-turn provider approval observed'),
          retained:pane.querySelector('.work-overview-result')===fixture.retainedResult&&fixture.retainedResult.open,
          noSend:(fixture.inputs.filter(row=>row.id==='fixture-failed-original')[0]?.messageId===undefined),
          focus:document.activeElement?.dataset.workAction??null,
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(recovered.failed&&recovered.queued&&recovered.historical&&recovered.retained&&
        recovered.queueMeta.includes('1 queued')&&!recovered.queueMeta.includes('delivery status unknown')&&
        recovered.noSend&&recovered.overflow<=1&&recovered.focus==='close',JSON.stringify(recovered));
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,
        'Concurrent source changed during native Work custody review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-native-Work-approval-failed-delivery-queue-outage',
        accurate,desktop,intermediate,narrow,review,loss,recovered,
        screenshots:['work-historical-approval-failed-original-200pct.png',
          'work-queue-read-unavailable-200pct.png'],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_CURSOR === '1') {
      nativeStage='isolated native Work cursor, older outputs, provider control binding, 200% focus';
      const waitFor=async(expression,label)=>{
        for(let attempt=0;attempt<115;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        const diagnostics=await js(`(() => ({
          rows:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
          button:document.querySelector('[data-work-action="load-older-updates"]')?.textContent,
          disabled:document.querySelector('[data-work-action="load-older-updates"]')?.disabled,
          more:document.querySelector('[data-work-action="more-updates"]')?.textContent,
          requested:fixture.paging?.reads,
          focus:document.activeElement?.dataset.sessionId,
          work:document.getElementById('workOverviewMeta')?.textContent
        }))()`);
        throw new Error('Native Work cursor did not settle at '+label+' '+JSON.stringify(diagnostics));
      };
      await js(`(() => {
        const now=Date.now(),reference=fixture.sessions.find(row=>row.id==='oneoff');
        const first=Array.from({length:60},(_,index)=>{
          const id='paged-native-first-'+index,provider='paged-native-provider-'+index,
            at=now-index*50;
          return {...reference,id,title:'Retained source result '+index,
            conversationId:provider,chatIds:[provider],origin:null,activeTurnId:null,
            lastMessageAt:at,updatedAt:at,lastAssistantFinalAt:at,
            lastTurnEndAt:at+1,lastTurnOutcome:'completed'};
        });
        const worker={...reference,id:'paged-native-worker',title:'Older completed worker with preserved report',
          conversationId:'old-worker-provider',chatIds:['old-worker-provider'],
          origin:{kind:'worker',fromSessionId:'prime',agentId:'worker-1',task:'Verify old outputs'},
          lastMessageAt:now-70000,lastFinishReportAt:now-70000,
          lastToolCallAt:now-80000,lastAssistantFinalAt:null,lastTurnEndAt:null,
          activeTurnId:null};
        const oneoff={...reference,id:'paged-native-oneoff',title:'Earlier answer after provider rebind',
          conversationId:'provider-B',chatIds:['provider-A','provider-B'],origin:null,
          lastMessageAt:now-71000,lastAssistantFinalAt:now-71000,
          lastTurnEndAt:now-70900,lastToolCallAt:null,
          lastTurnOutcome:'completed',activeTurnId:null};
        const result='RESULT: Older worker finished verification; Prime receipt remains unverified.';
        fixture.reports[worker.id]=[{kind:'agent_message',seq:1,time:now-70000,
          source:'app',agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
          messageId:'paged-native-worker-report',message:{text:'[worker-1 finished] '+result,
            chars:result.length+20,truncated:false}}];
        const answer='RESULT: Exact saved one-off answer is still available after provider rebind.';
        fixture.reports[oneoff.id]=[{kind:'assistant_message',seq:2,time:now-71000,
          source:'extension',messageId:'paged-native-oneoff-final',final:true,state:'final',
          message:{text:answer,chars:answer.length,truncated:false}}];
        fixture.sessions.push(...first,worker,oneoff);
        const cursor={updatedAt:first[59].updatedAt,id:first[59].id};
        fixture.paging={first,older:[worker,oneoff],cursor,reads:[],provider:'A'};
        window.api.listSessions=(options={})=>{
          const page=options.cursor?fixture.paging.older:fixture.paging.first;
          fixture.paging.reads.push(options.cursor?'older':'first');
          return Promise.resolve({ok:true,data:{sessions:page,total:62,
            activeId:null,pressure:[],blocked:[],workerProgress:[],automation:fixture.automation,
            nextCursor:options.cursor?null:fixture.paging.cursor}});
        };
        const originalControls=window.api.getSessionControls;
        window.api.getSessionControls=id=>id===oneoff.id
          ? Promise.resolve({ok:true,data:{sessionId:id,
              conversationId:fixture.paging.provider==='A'?'provider-A':'provider-B',
              activeTurnId:fixture.paging.controlTurn??null,automation:'goal',objective:'Retain completed original work',
              blocked:'',finishHeld:false,
              plan:{plan:[{step:fixture.paging.provider==='A'
                ?'Historical A control-only plan':'Current provider B verified plan',
                status:'in_progress'}],checklist:[]},
              activeWork:{report:{delivered:{thresholdMs:7200000,messageId:'prior-report-only'}}}}})
          :originalControls(id);
        fixture.notify();
      })()`);
      await waitFor(`document.querySelector('[data-work-section="updates"] .work-overview-row')?.dataset.sessionId==='paged-native-first-0' &&
        !!document.querySelector('[data-work-action="more-updates"]')`,'current first-page only');
      const before=await js(`(() => ({
        rows:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
        loaded:fixture.paging.reads.filter(row=>row==='older').length,
        exactReads:fixture.reads.length
      }))()`);
      assert.ok(before.rows===6&&before.loaded===0,JSON.stringify(before));
      const expanded=await js(`(() => {
        const start=performance.now(),section=document.querySelector('[data-work-section="updates"]');
        for(let index=0;index<9;index++)section.querySelector('[data-work-action="more-updates"]').click();
        const button=section.querySelector('[data-work-action="load-older-updates"]');
        return {rows:section.querySelectorAll('.work-overview-row').length,
          loadButton:button?.textContent,focus:document.activeElement?.dataset.sessionId,
          elapsedMs:performance.now()-start,olderReads:fixture.paging.reads.filter(row=>row==='older').length,
          exactReads:fixture.reads.length};
      })()`);
      assert.ok(expanded.rows===60&&expanded.loadButton.includes('Load older saved sessions')&&
        expanded.olderReads===0&&expanded.exactReads===before.exactReads,JSON.stringify(expanded));
      await js(`(() => {const button=document.querySelector('[data-work-action="load-older-updates"]');
        button.focus({preventScroll:true});button.click()})()`);
      await waitFor(`document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length===62`,
        'explicit older cursor loaded');
      const paged=await js(`(() => ({
        rows:document.querySelectorAll('[data-work-section="updates"] .work-overview-row').length,
        olderReads:fixture.paging.reads.filter(row=>row==='older').length,
        focus:document.activeElement?.dataset.sessionId,
        worker:document.querySelector('[data-work-section="updates"] [data-session-id="paged-native-worker"]')?.textContent,
        oneoff:document.querySelector('[data-work-section="updates"] [data-session-id="paged-native-oneoff"]')?.textContent,
        exactReads:fixture.reads.length
      }))()`);
      assert.ok(paged.rows===62&&paged.olderReads===1&&paged.focus==='paged-native-worker'&&
        paged.worker.includes('Worker report saved')&&paged.oneoff.includes('provider unverified')&&
        paged.exactReads===before.exactReads,JSON.stringify(paged));
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="paged-native-worker"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Older worker finished verification')`,
        'exact older worker body');
      const workerProof=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const saved=pane.querySelector('.work-overview-result');
        saved.open=true;saved.querySelector('summary').focus({preventScroll:true});
        return {saved: saved.textContent.includes('Older worker finished verification'),
          open:saved.open,focus:document.activeElement===saved.querySelector('summary'),
          primeUnverified:pane.textContent.includes('No matching receipt in the most recent Prime history')||
            pane.textContent.includes('Prime receipt unavailable')};
      })()`);
      assert.ok(Object.values(workerProof).every(Boolean),JSON.stringify(workerProof));
      // Exact same-provider worker turn B is open, but its turn_start has
      // left the bounded recent window. A's untagged report must remain
      // inspectable without becoming B's current result or next action.
      await js(`(() => {
        const worker=fixture.paging.older.find(row=>row.id==='paged-native-worker');
        worker.activeTurnId='current-worker-B';worker.updatedAt=Date.now();
        worker.activityExpiresAt=Date.now()-1000;fixture.notify();
      })()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('no exact current-turn final or tool outcome') &&
        document.querySelector('#workOverviewPane .work-overview-result > summary')?.textContent==='Read previous saved worker report'`,
        'old untagged worker report remains historical after B starts outside the event page');
      const workerPriorTurn=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=name=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===name)?.textContent??'';
        return {justDid:field('Just did'),next:field('Next / blocker'),prime:field('Prime receipt'),
          saved:!!pane.querySelector('.work-overview-result')?.textContent.includes('Older worker finished verification'),
          historical:pane.querySelector('.work-overview-result > summary')?.textContent,
          announced:document.getElementById('workOverviewAnnouncement')?.textContent,
          noSends:fixture.inputs.length===1};
      })()`);
      assert.ok(workerPriorTurn.justDid.includes('no exact current-turn final')&&
        !workerPriorTurn.justDid.includes('Worker report saved for Prime')&&
        workerPriorTurn.historical==='Read previous saved worker report'&&
        workerPriorTurn.prime.includes('not attributed to the current native turn')&&
        workerPriorTurn.announced.includes('current turn association unverified')&&
        workerPriorTurn.saved&&workerPriorTurn.noSends,JSON.stringify(workerPriorTurn));
      win.setSize(640,900);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','native historical worker B at 200% zoom');
      const workerZoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:rect.width,left:rect.left,right:rect.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          bodyOverflow:document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth};
      })()`);
      assert.ok(workerZoom.viewport<=340&&workerZoom.width>workerZoom.viewport*.8&&
        workerZoom.left>=0&&workerZoom.right<=workerZoom.viewport+1&&
        workerZoom.overflow<=1&&workerZoom.bodyOverflow<=1,JSON.stringify(workerZoom));
      fs.writeFileSync(path.join(output,'work-prior-worker-turn-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`(() => {
        const worker=fixture.paging.older.find(row=>row.id==='paged-native-worker');
        const message='[worker-1 finished] RESULT: Exact B worker result saved after native turn evidence.';
        fixture.reports[worker.id].push({kind:'agent_message',seq:9,time:Date.now()-400,
          source:'app',agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
          turnId:'current-worker-B',messageId:'native-current-B-worker-report',
          message:{text:message,chars:message.length,truncated:false}});
        worker.lastFinishReportAt=Date.now()-400;worker.updatedAt=Date.now();fixture.notify();
      })()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Worker report saved for Prime: RESULT: Exact B worker result') &&
        document.querySelector('#workOverviewPane .work-overview-result > summary')?.textContent==='Read saved worker report'`,
        'exact B worker result replaces A as current while old A stays saved');
      const workerCurrentTurn=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const prime=[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent==='Prime receipt')?.textContent??'';
        return {saved:pane.querySelector('.work-overview-result')?.textContent.includes('Exact B worker result'),
          current:pane.textContent.includes('Worker report saved for Prime: RESULT: Exact B worker result'),
          priorInHistory:pane.querySelector('.work-overview-history')?.textContent.includes('current turn association unverified'),
          primeUnverified:(prime.includes('unverified')||prime.includes('unavailable'))&&
            !prime.includes('Prime received this report'),
          noSends:fixture.inputs.length===1};
      })()`);
      assert.ok(workerCurrentTurn.saved&&workerCurrentTurn.current&&
        workerCurrentTurn.priorInHistory&&workerCurrentTurn.primeUnverified&&
        workerCurrentTurn.noSends,JSON.stringify(workerCurrentTurn));
      // Late historical A reports can carry more than the 12K preview. Prove
      // the retained tail is reachable at 200% zoom without promoting A over
      // current B or reading/sending anything while toggling its disclosure.
      await js(`(() => {
        const row=fixture.paging.older.find(item=>item.id==='paged-native-worker');
        row.chatIds=['older-worker-provider-A',row.conversationId];
        const notes='reviewed line '.repeat(1050);
        const content='[worker-1 finished] RESULT: Previous A saved output. '+notes+
          '\\nBLOCKERS: Historical A tail; exact B remains current.';
        fixture.reports[row.id].push({kind:'agent_message',seq:10,time:Date.now()-200,
          source:'app',agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
          turnId:'previous-worker-A',messageId:'native-historical-A-worker-report',
          message:{text:content,chars:content.length,truncated:true}});
        row.updatedAt=Date.now();fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('#workOverviewPane .work-overview-historical-worker-result [data-work-action="expand-historical-result"]')`,
        'historical worker A long result displays explicit expansion');
      const historicalPreview=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const prior=pane.querySelector('.work-overview-historical-worker-result');
        const body=prior.querySelector('.work-overview-result-body');
        const button=prior.querySelector('[data-work-action="expand-historical-result"]');
        return {preview:body.textContent.length,expanded:button.getAttribute('aria-expanded'),
          note:prior.querySelector('.work-overview-result-limit')?.textContent,
          current:pane.textContent.includes('Worker report saved for Prime: RESULT: Exact B worker result')};
      })()`);
      assert.ok(historicalPreview.preview===12000&&historicalPreview.expanded==='false'&&
        historicalPreview.note.includes('Original recording was truncated')&&
        historicalPreview.current,JSON.stringify(historicalPreview));
      const historyReadCount=await js('fixture.reads.length');
      await js(`(() => {
        const prior=document.querySelector('#workOverviewPane .work-overview-historical-worker-result');
        prior.open=true;
        const button=prior.querySelector('[data-work-action="expand-historical-result"]');
        button.focus({preventScroll:true});button.click();
      })()`);
      const historicalExpanded=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const prior=pane.querySelector('.work-overview-historical-worker-result');
        const body=prior.querySelector('.work-overview-result-body');
        const button=prior.querySelector('[data-work-action="expand-historical-result"]');
        const rect=pane.getBoundingClientRect();
        return {chars:body.textContent.length,tail:body.textContent.endsWith('Historical A tail; exact B remains current.'),
          expanded:button.getAttribute('aria-expanded'),focus:document.activeElement===button,
          width:rect.width,overflow:pane.scrollWidth-pane.clientWidth,
          current:pane.textContent.includes('Worker report saved for Prime: RESULT: Exact B worker result')};
      })()`);
      assert.ok(historicalExpanded.chars>12000&&historicalExpanded.tail&&
        historicalExpanded.expanded==='true'&&historicalExpanded.focus&&
        historicalExpanded.width>=290&&historicalExpanded.overflow<=1&&historicalExpanded.current&&
        (await js('fixture.reads.length'))===historyReadCount,JSON.stringify(historicalExpanded));
      await js(`(() => {
        fixture.notify();
        const pane=document.getElementById('workOverviewPane');
        const prior=pane.querySelector('.work-overview-historical-worker-result');
        pane.scrollTop=pane.scrollHeight;
        prior.querySelector('.work-overview-result-body').scrollTop=100000;
      })()`);
      await waitFor(`document.querySelector('#workOverviewPane .work-overview-historical-worker-result [data-work-action="expand-historical-result"]')?.getAttribute('aria-expanded')==='true'`,
        'historical worker expansion persists through an evidence refresh');
      fs.writeFileSync(path.join(output,'work-long-historical-worker-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      win.setSize(1100,900);win.webContents.setZoomFactor(1);
      await waitFor('innerWidth>=1000','reset desktop fixture after worker boundary');
      await js(`document.querySelector('[data-work-section="updates"] [data-session-id="paged-native-oneoff"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Historical A control-only plan')`,
        'current B body with historical A controls');
      const boundary=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=name=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===name)?.textContent??'';
        return {source:field('Evidence source'),
          current:field('Current task'),previous:field('Control snapshot boundary'),
          saved:pane.textContent.includes('Exact saved one-off answer is still available'),
          retry:!!pane.querySelector('[data-work-action="retry-controls"]'),
          falseDelivery:pane.textContent.includes('Two-active-hour scope update delivered')};
      })()`);
      assert.ok(boundary.source.includes('provider-B')&&boundary.source.includes('provider-A')&&
        boundary.current.includes('unverified')&&boundary.previous.includes('Historical A control-only plan')&&
        boundary.saved&&boundary.retry&&!boundary.falseDelivery,JSON.stringify(boundary));
      const desktop=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        const selected=document.querySelector('[data-work-section="updates"] [data-session-id="paged-native-oneoff"]');
        return {viewport:innerWidth,width:rect.width,left:rect.left,right:rect.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          rowVisible:!!selected,expanded:selected?.getAttribute('aria-expanded')==='true',
          sourcePresent:pane.textContent.includes('Control snapshot boundary')};
      })()`);
      assert.ok(desktop.viewport>=1000&&desktop.width>=430&&desktop.left>=0&&
        desktop.right<=desktop.viewport+1&&desktop.overflow<=1&&desktop.rowVisible&&
        desktop.expanded&&desktop.sourcePresent,JSON.stringify(desktop));
      fs.writeFileSync(path.join(output,'work-paged-provider-boundary-desktop.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      win.webContents.setZoomFactor(1.5);
      await waitFor('innerWidth>700 && innerWidth<1000','150% zoom intermediate Work width');
      const zoom150=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:rect.width,left:rect.left,right:rect.right,
          position:getComputedStyle(pane).position,
          overflow:pane.scrollWidth-pane.clientWidth,
          sourcePresent:pane.textContent.includes('Control snapshot boundary')};
      })()`);
      assert.ok(zoom150.width>=zoom150.viewport*.8&&zoom150.left>=0&&
        zoom150.right<=zoom150.viewport+1&&zoom150.position==='fixed'&&
        zoom150.overflow<=1&&zoom150.sourcePresent,JSON.stringify(zoom150));
      fs.writeFileSync(path.join(output,'work-paged-provider-boundary-150pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      win.setSize(640,900);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','Work provider transition at 200% zoom');
      await js(`document.querySelector('#workOverviewPane [data-work-action="close"]').focus({preventScroll:true})`);
      const zoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        return {viewport:innerWidth,width:rect.width,left:rect.left,right:rect.right,
          overflow:pane.scrollWidth-pane.clientWidth,
          bodyOverflow:document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth,
          focus:document.activeElement===pane.querySelector('[data-work-action="close"]')};
      })()`);
      assert.ok(zoom.viewport<=340&&zoom.width>zoom.viewport*.8&&zoom.left>=0&&
        zoom.right<=zoom.viewport+1&&zoom.overflow<=1&&zoom.bodyOverflow<=1&&zoom.focus,JSON.stringify(zoom));
      fs.writeFileSync(path.join(output,'work-paged-provider-boundary-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`fixture.paging.provider='B';document.querySelector('#workOverviewPane [data-work-action="retry-controls"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Current provider B verified plan')`,
        'new exact B controls after explicit re-read');
      const corrected=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=name=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===name)?.textContent??'';
        return {current:field('Current task'),source:field('Evidence source'),
          olderBoundary:!!field('Control snapshot boundary'),
          originalResult:pane.textContent.includes('Exact saved one-off answer is still available'),
          retry:!!pane.querySelector('[data-work-action="retry-controls"]')};
      })()`);
      assert.ok(corrected.current.includes('Current provider B verified plan')&&
        corrected.source.includes('same-provider snapshot')&&!corrected.olderBoundary&&
        corrected.originalResult&&!corrected.retry,JSON.stringify(corrected));
      // Still on provider B, a later B native turn can start while the exact
      // controls IPC is returning an earlier turn A. The saved final and native
      // Send are genuine, but their original turn must never become B's latest
      // work. Exercise this after the archived page/provenance navigation.
      await js(`(() => {
        const row=fixture.paging.older.find(item=>item.id==='paged-native-oneoff');
        row.activeTurnId='same-provider-turn-B';row.updatedAt=Date.now();
        row.activityExpiresAt=Date.now()+20000;
        fixture.paging.controlTurn='previous-turn-A';
        fixture.reports[row.id][0].turnId='previous-turn-A';
        const at=Date.now()-7000;
        fixture.reports[row.id].push({kind:'user_message',seq:3,time:at,source:'app',
          turnId:'previous-turn-A',inputId:'same-provider-previous-send',
          messageId:'same-provider-original-native',inputDelivery:'confirmed',
          message:{text:'Previously sent original A question',chars:35,truncated:false}});
        fixture.inputs.push({id:'same-provider-previous-send',sessionId:row.id,
          conversationId:row.conversationId,mode:'auto',text:'Original A question',
          model:'gpt-6-thinking',reasoningEffort:'xhigh',state:'cancelled',
          owner:'old-original-owner',createdAt:at-1000,dueAt:0,deliveredAt:at,
          messageId:'same-provider-original-native'});
        fixture.notify();
      })()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Controls read for turn previous-turn-A of the same provider provider-B') &&
        document.getElementById('workOverviewPane')?.textContent.includes('current turn same-provider-turn-B') &&
        document.getElementById('workOverviewPane')?.textContent.includes('Original recorded turn previous-turn-A') &&
        document.getElementById('workOverviewPane')?.textContent.includes('same-provider-original-native')`,
        'same-provider prior-turn controls/native Send/results become historical');
      const sameTurnBoundary=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=name=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===name)?.textContent??'';
        return {justDid:field('Just did'),source:field('Evidence source'),
          current:field('Current task'),boundary:field('Control snapshot boundary'),
          delivery:field('Native delivery & answer'),
          saved:!!pane.querySelector('.work-overview-result')?.textContent.includes('Exact saved one-off answer'),
          retry:!!pane.querySelector('[data-work-action="retry-controls"]'),
          overflow:pane.scrollWidth-pane.clientWidth};
      })()`);
      assert.ok(sameTurnBoundary.justDid.includes('no exact current-turn final')&&
        !sameTurnBoundary.justDid.includes('Native input delivered')&&
        sameTurnBoundary.current.includes('unverified')&&
        sameTurnBoundary.boundary.includes('previous-turn-A')&&
        sameTurnBoundary.boundary.includes('same-provider-turn-B')&&
        sameTurnBoundary.delivery.includes('Native Send confirmed')&&
        sameTurnBoundary.delivery.includes('does not confirm native Send or answer for the current active turn')&&
        sameTurnBoundary.saved&&sameTurnBoundary.retry&&sameTurnBoundary.overflow<=1,JSON.stringify(sameTurnBoundary));
      fs.writeFileSync(path.join(output,'work-same-provider-prior-turn-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`fixture.paging.controlTurn='same-provider-turn-B';
        document.querySelector('#workOverviewPane [data-work-action="retry-controls"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('same-provider current-turn snapshot')`,
        'explicit retry binds matching B native-turn controls');
      const currentTurnCorrected=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const field=name=>[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(row=>row.querySelector('b')?.textContent===name)?.textContent??'';
        return {source:field('Evidence source'),current:field('Current task'),
          oldBoundary:!!field('Control snapshot boundary'),
          delivery:field('Native delivery & answer'),
          saved:!!pane.querySelector('.work-overview-result')?.textContent.includes('Exact saved one-off answer')};
      })()`);
      assert.ok(currentTurnCorrected.source.includes('same-provider current-turn snapshot')&&
        currentTurnCorrected.current.includes('Current provider B verified plan')&&
        !currentTurnCorrected.oldBoundary&&
        currentTurnCorrected.delivery.includes('does not confirm native Send or answer for the current active turn')&&
        currentTurnCorrected.saved,JSON.stringify(currentTurnCorrected));
      await js(`(() => {
        const final=fixture.reports['paged-native-oneoff'][0];
        final.message.text='RESULT: Exact saved one-off answer is still available. '+
          'recorded technical detail '.repeat(650)+
          '\\nNEXT: Exact saved final tail remains readable in Work.';
        final.message.chars=final.message.text.length;
        fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('#workOverviewPane [data-work-action="expand-current-result"]')`,
        'full saved one-off result expansion available at 200%');
      const mainPreview=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {chars:pane.querySelector('.work-overview-result-body')?.textContent.length,
          button:pane.querySelector('[data-work-action="expand-current-result"]')?.getAttribute('aria-expanded'),
          width:pane.getBoundingClientRect().width};
      })()`);
      assert.ok(mainPreview.chars===12000&&mainPreview.button==='false'&&mainPreview.width>=290,
        JSON.stringify(mainPreview));
      const beforeRevealReads=await js('fixture.reads.length');
      await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const detail=pane.querySelector('.work-overview-result');
        detail.open=true;
        const button=detail.querySelector('[data-work-action="expand-current-result"]');
        button.focus({preventScroll:true});button.click();
      })()`);
      const mainExpanded=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const body=pane.querySelector('.work-overview-result-body');
        const button=pane.querySelector('[data-work-action="expand-current-result"]');
        return {chars:body.textContent.length,
          tail:body.textContent.includes('NEXT: Exact saved final tail remains readable in Work.'),
          expanded:button.getAttribute('aria-expanded'),focus:document.activeElement===button,
          overflow:pane.scrollWidth-pane.clientWidth,
          currentSendUnknown:pane.textContent.includes('does not confirm native Send or answer for the current active turn')};
      })()`);
      assert.ok(mainExpanded.chars>12000&&mainExpanded.tail&&mainExpanded.expanded==='true'&&
        mainExpanded.focus&&mainExpanded.overflow<=1&&mainExpanded.currentSendUnknown&&
        (await js('fixture.reads.length'))===beforeRevealReads,JSON.stringify(mainExpanded));
      await js(`(() => {
        fixture.notify();
        const pane=document.getElementById('workOverviewPane');
        pane.scrollTop=pane.scrollHeight;
        pane.querySelector('.work-overview-result-body').scrollTop=100000;
      })()`);
      await waitFor(`document.querySelector('#workOverviewPane [data-work-action="expand-current-result"]')?.getAttribute('aria-expanded')==='true'`,
        'full saved final expansion persists through native Work update');
      fs.writeFileSync(path.join(output,'work-long-saved-final-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`document.querySelector('#workOverviewPane [data-work-action="expand-current-result"]').click()`);
      const mainCollapsed=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {chars:pane.querySelector('.work-overview-result-body').textContent.length,
          expanded:pane.querySelector('[data-work-action="expand-current-result"]').getAttribute('aria-expanded')};
      })()`);
      assert.deepEqual(mainCollapsed,{chars:12000,expanded:'false'});
      await js(`document.querySelector('#workOverviewPane [data-work-action="close"]').focus({preventScroll:true})`);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      const keyboard=await js(`({closed:document.getElementById('workOverviewPane').hidden,
        row:document.activeElement?.dataset.sessionId??null})`);
      assert.deepEqual(keyboard,{closed:true,row:'paged-native-oneoff'});
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,
        'Concurrent source changed during native paged Work review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-native-paged-Work-and-provider-boundary',
        before,expanded,paged,workerProof,workerPriorTurn,workerZoom,workerCurrentTurn,
        historicalPreview,historicalExpanded,boundary,desktop,zoom150,zoom,corrected,
        sameTurnBoundary,currentTurnCorrected,mainPreview,mainExpanded,mainCollapsed,keyboard,
        screenshots:['work-paged-provider-boundary-desktop.png','work-paged-provider-boundary-150pct.png',
          'work-paged-provider-boundary-200pct.png','work-same-provider-prior-turn-200pct.png',
          'work-prior-worker-turn-200pct.png','work-long-historical-worker-200pct.png',
          'work-long-saved-final-200pct.png'],output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_EXACT_OFF === '1') {
      nativeStage='native Work supervisor versus exact Off and provider-bound refresh';
      const waitFor=async(expression,where)=>{
        for(let attempt=0;attempt<100;attempt++){
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Work evidence did not settle at '+where);
      };
      const status=()=>js(`(() => {
        const row=document.querySelector('[data-work-section="current"] [data-session-id="blocked"]');
        const sidebar=document.querySelector('#sessionList [data-id="blocked"]');
        const pane=document.getElementById('workOverviewPane');
        return {state:row?.querySelector('.work-overview-state')?.textContent,
          tone:row?.querySelector('.work-overview-state')?.className,
          detail:row?.querySelector('.work-overview-detail')?.textContent,
          expanded:row?.getAttribute('aria-expanded'),
          meta:document.getElementById('workOverviewMeta')?.textContent,
          mode:sidebar?.querySelector('.sess-mode-badge')?.textContent??null,
          sidebarState:sidebar?.querySelector('.sess-automation-state')?.textContent,
          accessible:sidebar?.querySelector('.sess-automation-state')?.getAttribute('aria-label'),
          pane:!pane?.hidden?pane.textContent:'',
          focus:document.activeElement?.dataset.workAction??null};
      })()`);
      const before=await status();
      assert.equal(before.state,'blocked');
      assert.ok(before.meta.includes('2 blocked'),JSON.stringify(before));
      await js(`document.querySelector('[data-work-section="current"] [data-session-id="blocked"]').click()`);
      await waitFor(`document.querySelector('[data-work-section="current"] [data-session-id="blocked"] .work-overview-state')?.textContent==='off'`,
        'exact Off after Main controls');
      const verified=await status();
      assert.ok(verified.state==='off'&&verified.tone.includes('is-paused')&&
        verified.meta.includes('1 off')&&verified.meta.includes('1 blocked')&&
        verified.mode===null&&verified.sidebarState==='off'&&
        verified.accessible.includes('Off for this chat')&&
        verified.pane.includes('Goal/Loop Off for this chat')&&
        verified.pane.includes('A separate supervisor observation reports blocked')&&
        verified.pane.includes('Exact provider sign-in needed')&&
        verified.pane.includes('Latest exact controls: Goal/Loop Off for this chat')&&
        verified.pane.includes('Off for this chat; no new Goal/Loop turn is scheduled')&&
        !verified.pane.includes('Next / blockerSign in to the same account.'),
        JSON.stringify(verified));
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('innerWidth<=340','native 200% zoom');
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const zoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane'),rect=pane.getBoundingClientRect();
        const close=pane.querySelector('[data-work-action="close"]');
        close.focus({preventScroll:true});return {viewport:innerWidth,width:rect.width,
          left:rect.left,right:rect.right,overflow:pane.scrollWidth-pane.clientWidth,
          title:!!pane.querySelector('#workOverviewPaneTitle')?.textContent,
          labeled:!!close.getAttribute('aria-label'),closeFocused:document.activeElement===close};
      })()`);
      assert.ok(zoom.width>zoom.viewport*.8&&zoom.left>=0&&zoom.right<=zoom.viewport+1&&
        zoom.overflow<=1&&zoom.title&&zoom.labeled&&zoom.closeFocused,JSON.stringify(zoom));
      fs.writeFileSync(path.join(output,'work-exact-off-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      const closed=await js(`(() => ({
        paneClosed:document.getElementById('workOverviewPane').hidden,
        focusedRow:document.activeElement?.dataset.sessionId??null
      }))()`);
      assert.deepEqual(closed,{paneClosed:true,focusedRow:'blocked'});
      const retained=await status();
      assert.equal(retained.state,'off','Closing exact Work detail must not reinstate older Blocked');
      await js(`(() => {fixture.automation.observedAt=Date.now()+60000;fixture.notify()})()`);
      await waitFor(`document.querySelector('[data-work-section="current"] [data-session-id="blocked"] .work-overview-state')?.textContent==='blocked'`,
        'newer supervisor overrides prior Off');
      // The status-only Work repaint is immediate. Sidebar identity follows
      // the incumbent coalesced session-catalog read, which may arrive later.
      await waitFor(`document.querySelector('#sessionList [data-id="blocked"] .sess-automation-state')?.textContent==='blocked'`,
        'coalesced sidebar agrees with newer supervisor');
      const newer=await status();
      assert.ok(newer.meta.includes('2 blocked')&&!newer.meta.includes('1 off')&&newer.mode==='G',JSON.stringify(newer));
      await js(`(() => {const row=fixture.sessions.find(row=>row.id==='blocked');
        row.chatIds.push('fixture-blocked-successor');row.conversationId='fixture-blocked-successor';
        row.updatedAt=Date.now();fixture.notify()})()`);
      await waitFor(`document.querySelector('[data-work-section="current"] [data-session-id="blocked"] .work-overview-state')?.textContent==='unknown'`,
        'provider B old supervisor historical');
      await waitFor(`document.querySelector('#sessionList [data-id="blocked"] .sess-automation-state')?.textContent==='unknown'`,
        'coalesced sidebar retires provider A status');
      const rebound=await status();
      assert.ok(rebound.state==='unknown'&&rebound.mode===null&&
        rebound.detail.includes('Current conversation binding changed'),JSON.stringify(rebound));
      await js(`document.querySelector('[data-work-section="current"] [data-session-id="blocked"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Current-provider controls report Off, while the supervisor still references the previous provider')`,
        'new provider Off read with prior provider supervisor');
      const exactRebound=await status();
      assert.ok(exactRebound.pane.includes('Provider transition evidence')&&
        exactRebound.pane.includes('Current-provider controls report Off'),JSON.stringify(exactRebound));
      for(const [name,hash] of sourceBaseline)
        assert.equal(sourceHash(name),hash,'Source changed during native Work review: '+name);
      console.log(JSON.stringify({result:'PASS',kind:'isolated-native-Work-exact-Off',
        before,verified,zoom,closed,retained,newer,rebound,
        exactRebound:{state:exactRebound.state,boundary:exactRebound.pane.includes('Current-provider controls report Off')},
        screenshot:'work-exact-off-200pct.png',output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_AGED_STATUS === '1') {
      nativeStage = 'ordinary stale turn and historical result in isolated native Work';
      await js(`(() => {
        const now=Date.now(),base=fixture.sessions.find(item=>item.id==='prime');
        const silent={...base,id:'silent-ordinary',title:'Ordinary task with retained native turn evidence',
          conversationId:'fixture-silent-ordinary',chatIds:['fixture-silent-ordinary'],origin:null,
          activeTurnId:'silent-native-turn',lastTurnOutcome:null,lastTurnEndAt:null,
          lastToolCallAt:now-600000,lastAssistantFinalAt:null,lastFileChangeAt:null,
          fileEdits:0,linesAdded:0,linesRemoved:0,activityExpiresAt:null,updatedAt:now};
        const old={...silent,id:'past-ordinary',title:'Earlier failed ordinary chat with retained outcome',
          conversationId:'fixture-past-ordinary',chatIds:['fixture-past-ordinary'],
          activeTurnId:null,lastTurnOutcome:'failed',lastTurnEndAt:now-600000};
        fixture.sessions.push(silent,old);
        fixture.reports.silent= [{kind:'turn_start',source:'extension',seq:1,time:now-600000,
          turnId:'silent-native-turn'}];
        fixture.reports['past-ordinary']=[{kind:'turn_end',source:'extension',seq:1,
          time:now-600000,turnId:'past-ended-turn',outcome:'failed'}];
        fixture.notify();
      })()`);
      const waitFor=async(expression,where)=>{
        for(let i=0;i<100;i++) {
          if(await js(expression))return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Native Work evidence did not settle at '+where);
      };
      await waitFor(`!!document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"]') &&
        !!document.querySelector('[data-work-section="older"] [data-session-id="past-ordinary"]')`,'first bounded projection');
      const initial=await js(`(() => {
        const current=document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"]');
        const older=document.querySelector('[data-work-section="older"] [data-session-id="past-ordinary"]');
        return {open:current.querySelector('.work-overview-state')?.textContent,
          old:older.querySelector('.work-overview-state')?.textContent,
          openUnknown:!!current.querySelector('.work-overview-state.is-unknown'),
          oldFailed:!!older.querySelector('.work-overview-state.is-failed'),
          meta:document.getElementById('workOverviewMeta').textContent};
      })()`);
      assert.ok(initial.openUnknown&&initial.oldFailed&&initial.open==='turn open · evidence stale'&&
        initial.old==='last failed'&&initial.meta.includes('1 unverified open turn')&&
        initial.meta.includes('1 earlier outcome'),JSON.stringify(initial));
      await js(`document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"]').click()`);
      await waitFor(`document.getElementById('workOverviewPane')?.textContent.includes('Turn open with no recent work signal')`,'exact open-turn detail');
      await js(`(() => {const pane=document.getElementById('workOverviewPane');
        pane.querySelector('[data-work-action="close"]').focus({preventScroll:true});
        window.fixture.retainedPane=pane;window.fixture.retainedClose=pane.querySelector('[data-work-action="close"]');
      })()`);
      const movedAt=Date.now();
      await js(`(() => {const row=fixture.sessions.find(item=>item.id==='silent-ordinary');
        row.activeTurnId=null;row.lastTurnOutcome='failed';row.lastTurnEndAt=Date.now()-600000;
        row.updatedAt=Date.now();fixture.reports.silent.push({kind:'turn_end',source:'extension',
          seq:2,time:row.lastTurnEndAt,turnId:'silent-native-turn',outcome:'failed'});
        fixture.notify();
      })()`);
      await waitFor(`!document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"]') &&
        !!document.querySelector('[data-work-section="older"] [data-session-id="silent-ordinary"]')`,'silent turn ended as older failure');
      const oldTransitionMs=Date.now()-movedAt;
      const transition=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const older=document.querySelector('[data-work-section="older"] [data-session-id="silent-ordinary"]');
        const headline=[...pane.querySelectorAll('.work-overview-pane-field')]
          .find(field=>field.querySelector('b')?.textContent==='Just did')?.textContent??'';
        return {last:older.querySelector('.work-overview-state')?.textContent,
          keptPane:pane===fixture.retainedPane,focusedClose:document.activeElement===fixture.retainedClose,
          current:pane.textContent.includes('Last turn failed'),headline,
          oldMeta:document.getElementById('workOverviewMeta').textContent,
          priorResult:!!document.querySelector('[data-work-section="older"] [data-session-id="past-ordinary"]')};
      })()`);
      assert.ok(transition.last==='last failed'&&transition.keptPane&&transition.focusedClose&&
        transition.current&&transition.priorResult&&transition.oldMeta.includes('2 earlier outcomes')&&
        transition.headline.includes('Last recorded turn failed'),JSON.stringify(transition));
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      await waitFor('window.innerWidth<=340','native zoom 200%');
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const zoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const rect=pane.getBoundingClientRect();
        return {viewport:innerWidth,paneWidth:rect.width,left:rect.left,right:rect.right,
          position:getComputedStyle(pane).position,horizontalOverflow:pane.scrollWidth-pane.clientWidth,
          closeVisible:!!pane.querySelector('[data-work-action="close"]'),
          focusedClose:document.activeElement===fixture.retainedClose};
      })()`);
      assert.ok(zoom.position==='fixed'&&zoom.paneWidth>zoom.viewport*.8&&zoom.left>=0&&
        zoom.right<=zoom.viewport+1&&zoom.horizontalOverflow<=1&&zoom.closeVisible&&zoom.focusedClose,
        JSON.stringify(zoom));
      fs.writeFileSync(path.join(output,'work-historical-failure-200pct.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await js(`(() => {fixture.retainedOlder=document.querySelector('[data-work-section="older"] [data-session-id="silent-ordinary"]');
        fixture.notify()})()`);
      await new Promise(resolve=>setTimeout(resolve,500));
      const stable=await js(`(() => ({
        pane:document.getElementById('workOverviewPane')===fixture.retainedPane,
        row:document.querySelector('[data-work-section="older"] [data-session-id="silent-ordinary"]')===fixture.retainedOlder,
        focused:document.activeElement===fixture.retainedClose
      }))()`);
      assert.deepEqual(stable,{pane:true,row:true,focused:true},'Unchanged Work refresh detached focused evidence');
      await js(`(() => {const row=fixture.sessions.find(item=>item.id==='silent-ordinary');
        row.activeTurnId='fresh-native-turn';row.updatedAt=Date.now();row.activityExpiresAt=null;
        fixture.reports.silent.push({kind:'turn_start',source:'extension',seq:3,
          time:Date.now(),turnId:'fresh-native-turn'});fixture.notify();
      })()`);
      await waitFor(`!!document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"]') &&
        !document.querySelector('[data-work-section="older"] [data-session-id="silent-ordinary"]')`,'new exact turn retired older label');
      const reopen=await js(`(() => ({
        current:document.querySelector('[data-work-section="current"] [data-session-id="silent-ordinary"] .work-overview-state')?.textContent,
        pane:document.getElementById('workOverviewPane')===fixture.retainedPane,
        focus:document.activeElement===fixture.retainedClose
      }))()`);
      assert.ok(reopen.current==='turn open · evidence stale'&&reopen.pane&&reopen.focus,JSON.stringify(reopen));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
        {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      const keyboard=await js(`({
        closed:document.getElementById('workOverviewPane').hidden,
        focusedRow:document.activeElement?.dataset.sessionId
      })`);
      assert.deepEqual(keyboard,{closed:true,focusedRow:'silent-ordinary'});
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,'Concurrent source changed '+name);
      console.log(JSON.stringify({result:'PASS',kind:'focused-isolated-Chromium-ordinary-history',
        initial,transition,oldTransitionMs,zoom,stable,reopen,keyboard,
        screenshot:'work-historical-failure-200pct.png',output}));
      return;
    }
    if (process.env.COS_RENDERER_FOCUSED_LOOP_SETTINGS === '1') {
      nativeStage='Loop continuation setting at normal and 200% zoom';
      await js(`document.getElementById('chatSettingsBtn').click()`);
      await js(`document.getElementById('sidebarToggle').click()`);
      const samples=[];
      for(const [width,height,zoom] of [[1100,900,1],[640,1000,2]]) {
        win.setSize(width,height);win.webContents.setZoomFactor(zoom);
        for(let i=0;i<80;i++) {
          if(await js(`Math.abs(innerWidth-${width/zoom})<5`))break;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        await js(`document.getElementById('loopContinuationPolicy').scrollIntoView({block:'center'});document.getElementById('loopContinuationPolicy').focus()`);
        await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const sample=await js(`(() => {
          const select=document.getElementById('loopContinuationPolicy');
          const row=select.closest('.setting'),label=document.querySelector('label[for="loopContinuationPolicy"]');
          const r=select.getBoundingClientRect(),l=label.getBoundingClientRect(),rr=row.getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return {viewport:innerWidth,selectVisible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight&&hit===select,
            rowOverflow:row.scrollWidth-row.clientWidth,labelFits:l.left>=rr.left-1&&l.right<=rr.right+1,
            focus:document.activeElement===select,value:select.value,
            described:select.getAttribute('aria-describedby')==='loopContinuationPolicyHint',
            honest:label.textContent.includes('Unverified')&&label.textContent.includes('approvals')};
        })()`);
        assert.ok(sample.selectVisible&&sample.rowOverflow<=1&&sample.labelFits&&sample.focus&&sample.described&&sample.honest,JSON.stringify(sample));
        assert.ok(Math.abs(sample.viewport-width/zoom)<5,'Native zoom did not settle: '+JSON.stringify(sample));
        assert.equal(sample.value,'strict');samples.push({width,zoom,...sample});
      }
      const capture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      fs.writeFileSync(path.join(output,'loop-continuation-setting-200pct.png'),capture.toPNG());
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,'Source changed during native settings review: '+name);
      console.log(JSON.stringify({status:'passed',scope:'isolated-renderer-loop-setting',samples,
        sourceOnly:true,nativeAutonomyVerified:false,output}));
      return;
    }
    if (process.env.COS41_RENDERER_FOCUSED_CUSTODY === '1') {
      nativeStage='focused B worker status, historical A result and exact Prime receipt';
      await js(`(() => {
        const now=Date.now(),worker=fixture.sessions.find(item=>item.id==='worker');
        const prime=fixture.sessions.find(item=>item.id==='prime');
        worker.conversationId='focused-provider-B';
        worker.chatIds=['historical-provider-A','focused-provider-B'];
        worker.activeTurnId=null;worker.lastTurnOutcome='completed';
        worker.lastTurnEndAt=now-1500;worker.lastFinishReportAt=now-3000;
        worker.finishTurn={turnId:'B-result-turn',conversationId:'focused-provider-B',
          startedAt:now-9000,notified:false,released:true,
          decisionRevision:null,workSeq:0,decisionSeq:0,decisionInputRevision:null};
        fixture.reports.worker=[
          {kind:'tool_call',seq:1,time:now-7000,source:'mcp',turnId:'B-result-turn',
            call:{callId:'B-exact-request',conversationId:'focused-provider-B',
              attributionMethod:'request_id',tool:'read',outcome:'ok',durationMs:5,
              args:{text:'{}',chars:2,truncated:false},
              result:{text:'',chars:0,truncated:false},
              summary:{kind:'read',title:'Exact B work recorded',tone:'neutral'}}},
          {kind:'chat_error',seq:2,time:now-6000,source:'extension',
            turnId:'B-result-turn',reason:'model_cooldown',blocking:true,
            message:{text:'Provider B model held',chars:21,truncated:false}},
          {kind:'agent_message',seq:3,time:now-3000,source:'app',
            agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
            turnId:'B-result-turn',messageId:'B-current-worker-result',
            message:{text:'[worker-1 finished] RESULT: Current B worker report is retained and verifiable.',
              chars:80,truncated:false}},
          {kind:'agent_message',seq:4,time:now-500,source:'app',
            agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
            turnId:'A-old-turn',messageId:'historical-A-worker-result',
            message:{text:'[worker-1 finished] RESULT: Historical A report remains readable.',
              chars:72,truncated:false}}
        ];
        fixture.reports.prime.push({kind:'agent_message',seq:20,time:now-2500,
          source:'app',agent:'prime',from:'worker-1',to:'prime',delivery:'delivered',
          messageId:'B-current-worker-result',
          message:{text:'B report received by owning Prime',chars:32,truncated:false}});
        worker.events=4;prime.events=fixture.reports.prime.length;
        fixture.automation.chats.push({sessionId:worker.id,
          conversationId:'focused-provider-B',title:worker.title,mode:'goal',
          state:'waiting-main',reason:'Saved B report with verified source',
          nextAction:'Review retained worker result',nextRetryAt:null,
          lastWorkedAt:now-1000,activeWorkers:0,recoverable:false,
          spinning:false,recoveryStage:null});
        fixture.automation.counts['waiting-main']++;
        fixture.notify();
        document.querySelector('.work-overview-row[data-session-id="worker"]').click();
      })()`);
      for(let i=0;i<100;i++){
        if(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Current B worker report') &&
          document.querySelector('#workOverviewPane')?.textContent.includes('Prime received this report')`))break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const evidence=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        return {current:pane.querySelector('.work-overview-pane-field')?.textContent,
          receipt:pane.textContent.includes('Prime received this report'),
          currentResult:pane.querySelector('.work-overview-result-body')?.textContent,
          previous:pane.querySelector('.work-overview-historical-worker-result')?.textContent,
          history:pane.querySelector('.work-overview-history')?.textContent};
      })()`);
      assert.ok(evidence.current.includes('Current B worker report')&&evidence.receipt &&
        evidence.currentResult.includes('Current B worker report') &&
        evidence.previous.includes('Historical A report remains readable')&&
        evidence.history.includes('provider association unverified'),JSON.stringify(evidence));
      nativeStage='source-rendered account pause, provider approval and queued delivery at 200%';
      await js(`(() => {
        const prime=fixture.sessions.find(item=>item.id==='prime');
        fixture.config.ui.automationPaused=true;
        fixture.reports.prime.push({kind:'progress',source:'app',seq:25,time:Date.now(),
          progressId:'approval-wait:'+prime.conversationId+':native-fixture',
          message:{text:'ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.',
            chars:107,truncated:false}});
        fixture.inputs.push({id:'source-fixture-unsent',sessionId:prime.id,conversationId:prime.conversationId,
          state:'queued',owner:null,text:'Synthetic unsent native fixture content',mode:'after-turn',
          dueAt:Date.now(),createdAt:Date.now(),model:null,reasoningEffort:null});
        fixture.notify();
        document.querySelector('.work-overview-row[data-session-id="prime"]').click();
      })()`);
      for(let i=0;i<60;i++){
        if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field.is-work-attention')?.textContent.includes('Provider tool approval observed')`))break;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      const actionable=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const info=pane.querySelector('.work-overview-pane-field.is-work-attention')?.textContent??'';
        return {paused:info.includes('Account-wide automation pause ON'),
          approval:info.includes('Provider tool approval observed'),
          queued:info.includes('Saved input awaiting native Send'),
          next:info.includes('Delivery queue'),
          review:!!pane.querySelector('[data-work-action="delivery"]'),
          helperFalse:info.includes('Private helper custody unavailable'),
          leaked:pane.textContent.includes('Synthetic unsent native fixture content')};
      })()`);
      assert.deepEqual(actionable,{paused:true,approval:true,queued:true,next:true,review:true,helperFalse:false,leaked:false},
        'Existing Work facts must remain separate at the real rendered source boundary');
      win.setSize(640,1000);win.webContents.setZoomFactor(2);
      for(let i=0;i<50;i++){
        if(await js(`window.innerWidth<=340`))break;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const actionableZoom=await js(`(() => {
        const pane=document.getElementById('workOverviewPane');
        const rect=pane.getBoundingClientRect();
        const info=pane.querySelector('.work-overview-pane-field.is-work-attention');
        return {position:getComputedStyle(pane).position,viewport:window.innerWidth,
          width:rect.width,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
          overflow:pane.scrollWidth-pane.clientWidth,
          infoVisible:info.getBoundingClientRect().top<rect.bottom,
          actionVisible:!!pane.querySelector('[data-work-action="delivery"]')};
      })()`);
      assert.ok(actionableZoom.position==='fixed'&&actionableZoom.width>actionableZoom.viewport*.8&&
        actionableZoom.left>=0&&actionableZoom.right<=actionableZoom.viewport+1&&
        actionableZoom.overflow<=1&&actionableZoom.infoVisible&&actionableZoom.actionVisible,
        JSON.stringify(actionableZoom));
      const actionableCapture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      fs.writeFileSync(path.join(output,'work-actionable-status-200pct.png'),actionableCapture.toPNG());
      await js(`document.querySelector('#workOverviewPane [data-work-action="delivery"]').click()`);
      const deliveryFocus=await js(`(() => {
        const panel=document.getElementById('deliveryQueuePanel');
        return {expanded:panel.open,focus:document.activeElement===panel.querySelector('summary')};
      })()`);
      assert.deepEqual(deliveryFocus,{expanded:true,focus:true},JSON.stringify(deliveryFocus));
      await js(`(() => {
        fixture.config.ui.automationPaused=false;
        fixture.inputs.splice(fixture.inputs.findIndex(row=>row.id==='source-fixture-unsent'),1);
        fixture.notify();
        document.querySelector('.work-overview-row[data-session-id="worker"]').click();
      })()`);
      win.setSize(1100,900);win.webContents.setZoomFactor(1);
      const zoomEvidence=[];
      for(const [factor,label] of [[1.5,'150'],[2,'200']]){
        win.setSize(640,1000);win.webContents.setZoomFactor(factor);
        await new Promise(resolve=>setTimeout(resolve,220));
        // Reopen from the actual originating Work row at each zoom level.
        await js(`(() => {
          document.querySelector('#workOverviewPane button[data-work-action="close"]').click();
          const row=document.querySelector('.work-overview-row[data-session-id="worker"]');
          row.focus();row.click();
        })()`);
        for(let i=0;i<60;i++){
          if(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Current B worker report')`))break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        const dimension=await js(`(() => {
          const pane=document.getElementById('workOverviewPane');
          const rect=pane.getBoundingClientRect(),head=pane.querySelector('.work-overview-pane-head').getBoundingClientRect();
          return {cssViewport:innerWidth,zoom:devicePixelRatio,position:getComputedStyle(pane).position,
            background:getComputedStyle(pane).backgroundColor,
            width:rect.width,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,
            horizontalOverflow:pane.scrollWidth-pane.clientWidth,
            headingVisible:head.top>=rect.top&&head.bottom<rect.bottom,
            closeFocused:document.activeElement===pane.querySelector('button[data-work-action="close"]'),
            focusedElement:document.activeElement?.tagName+'#'+(document.activeElement?.id??'')+
              ':'+(document.activeElement?.dataset.workAction??document.activeElement?.dataset.sessionId??''),
            currentVisible:pane.querySelector('.work-overview-pane-field').getBoundingClientRect().top<rect.bottom};
        })()`);
        assert.ok(dimension.position==='fixed'&&dimension.background.startsWith('rgb(')&&
          dimension.width>dimension.cssViewport*.8&&
          dimension.left>=0&&dimension.right<=dimension.cssViewport+1&&
          dimension.horizontalOverflow<=1&&dimension.headingVisible&&dimension.currentVisible,
          'Work detail not fully inspectable at '+label+'%: '+JSON.stringify(dimension));
        const capture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
        fs.writeFileSync(path.join(output,'work-full-detail-'+label+'pct.png'),capture.toPNG());
        zoomEvidence.push(dimension);
      }
      await js(`document.querySelector('#workOverviewPane button[data-work-action="close"]').focus({preventScroll:true})`);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
        type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
        type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
      const keyboard=await js(`({
        closed:document.getElementById('workOverviewPane').hidden,
        focusedRow:document.activeElement?.dataset.sessionId
      })`);
      assert.deepEqual(keyboard,{closed:true,focusedRow:'worker'});
      for(const [name,hash] of sourceBaseline)assert.equal(sourceHash(name),hash,'Concurrent source changed '+name);
      console.log(JSON.stringify({result:'PASS',kind:'focused-isolated-Chromium',
        currentBReport:true,historicalAReport:true,primeReceipt:true,
        actionable,actionableZoom,deliveryFocus,geometry:zoomEvidence,keyboard,
        screenshots:['work-actionable-status-200pct.png','work-full-detail-150pct.png','work-full-detail-200pct.png'],
        output}));
      return;
    }
    nativeStage = 'production extension mode contrast in isolated Chromium';
    const overlayCss = fs.readFileSync(path.join(root,'extension','overlay.css'),'utf8');
    const modeContrast = await js(`(() => {
      const styles=document.createElement('style');
      styles.textContent=${JSON.stringify(overlayCss)};
      document.head.append(styles);
      const luminance=(value)=>{
        const rgb=(value.match(/\\d+/g)||[]).slice(0,3).map(Number);
        const linear=rgb.map(channel=>{
          const n=channel/255;
          return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;
        });
        return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
      };
      const results=[];
      for(const theme of ['dark','light'])for(const mode of ['goal','loop']){
        const stage=document.createElement('div');
        stage.className='clf-stage';
        stage.dataset.clfTheme=theme;
        const track=document.createElement('div');
        track.className='clf-menu-mode-track';
        track.dataset.clfValue=mode;
        track.setAttribute('role','radiogroup');
        const fill=document.createElement('span');
        fill.className='clf-menu-mode-fill';track.append(fill);
        for(const name of ['off','goal','loop']){
          const option=document.createElement('button');
          option.className='clf-menu-mode-option';
          option.setAttribute('role','radio');
          option.setAttribute('aria-checked',String(name===mode));
          option.textContent=name;track.append(option);
        }
        stage.append(track);
        document.body.append(stage);
        const selected=track.querySelector('[aria-checked="true"]');
        const text=getComputedStyle(selected).color;
        const background=getComputedStyle(fill).backgroundColor;
        const a=luminance(text),b=luminance(background);
        results.push({theme,mode,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),
          fontSize:getComputedStyle(selected).fontSize,checked:selected.getAttribute('aria-checked')});
        stage.remove();
      }
      styles.remove();
      return results;
    })()`);
    assert.equal(modeContrast.length,4);
    assert.ok(modeContrast.every(row=>row.checked==='true'&&row.fontSize==='13px'&&row.contrast>=4.5),
      'Selected Goal/Loop mode must remain readable in both themes: '+JSON.stringify(modeContrast));
    assert.equal(await js(`document.getElementById('workOverviewBody').textContent.includes('Reading current work…')`), false,
      'The initial Work & updates loading placeholder must retire once current status is painted');
    const workerRow = '.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="worker"]';
    await js(`document.querySelector('${workerRow}').click()`);
    for(let i=0;i<50;i++) {
      if(await js(`document.getElementById('workOverviewPane').textContent.includes('Prime received this report')`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const workerReceipt = await js(`(() => ({
      acknowledged:document.getElementById('workOverviewPane').textContent.includes('Prime received this report'),
      evidence:document.getElementById('workOverviewPane').textContent.includes('exact recipient receipt recorded'),
      retained:document.getElementById('workOverviewPane').textContent.includes('Checked accessible controls')
    }))()`);
    assert.deepEqual(workerReceipt,{acknowledged:true,evidence:true,retained:true},
      'The worker result and exact recipient ACK must display together: '+JSON.stringify(workerReceipt));
    await js(`(() => {
      const receipt=[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Prime receipt');
      receipt?.scrollIntoView({block:'center'});
      return !!receipt;
    })()`);
    await new Promise(resolve=>setTimeout(resolve,80));
    const workerReceiptImage = await win.webContents.capturePage(undefined, {stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-worker-prime-receipt.png'),workerReceiptImage.toPNG());
    nativeStage = 'injecting reused-worker failure fixture';
    await js(`(() => {
      const entry=fixture.sessions.find(row=>row.id==='worker');
      const stamp=Date.now();
      entry.lastToolCallAt=stamp+1;entry.lastTurnEndAt=stamp+2;entry.lastTurnOutcome='failed';
      entry.finishTurn={turnId:'worker-reused-failed-turn',conversationId:entry.conversationId,
        startedAt:stamp,notified:false,released:true,decisionRevision:null,workSeq:0,
        decisionSeq:0,decisionInputRevision:null};
      fixture.reports.worker.push(
        {kind:'turn_start',seq:2,time:stamp,source:'extension',turnId:'worker-reused-failed-turn'},
        {kind:'tool_call',seq:3,time:stamp+1,source:'mcp',turnId:'worker-reused-failed-turn',
          call:{callId:'worker-newer-rejected-call',tool:'read',outcome:'tool_rejected',
            attribution:'request_id',durationMs:2,args:{text:'{}',chars:2,truncated:false},
            result:{text:'',chars:0,truncated:false},
            summary:{kind:'read',title:'Worker later read denied',tone:'bad'}}},
        {kind:'turn_end',seq:4,time:stamp+2,source:'extension',turnId:'worker-reused-failed-turn',outcome:'failed'});
      fixture.notify();
    })()`);
    nativeStage = 'waiting for reused-worker status projection';
    await new Promise(resolve=>setTimeout(resolve,700));
    nativeStage = 'reading reused-worker status projection';
    const previousWorkerAfterFailure = await js(`(() => ({
      row:document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="worker"] .work-overview-state')?.textContent,
      current:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      previous:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      receipt:document.getElementById('workOverviewPane').textContent.includes('Prime received this report')
    }))()`);
    nativeStage = 'asserting reused-worker status projection';
    assert.equal(previousWorkerAfterFailure.row,'Previous worker report retained');
    assert.ok(previousWorkerAfterFailure.current.includes('Rejected') &&
      previousWorkerAfterFailure.current.includes('Worker later read denied'),JSON.stringify(previousWorkerAfterFailure));
    assert.equal(previousWorkerAfterFailure.previous,'Read previous saved worker report');
    assert.equal(previousWorkerAfterFailure.receipt,true,'The older confirmed Prime receipt remains only for that earlier report');
    const olderRow = '.work-overview-section[data-work-section="current"] .work-overview-row[data-session-id="older"]';
    assert.equal(await js(`!!document.querySelector('#sessionList [data-id="older"]')`), false,
      'The held older Loop must really be absent from the loaded sidebar page');
    assert.equal(await js(`!!document.querySelector('${olderRow}')`), true,
      'Supervisor status must remain visible for a held Loop beyond that page');
    await js(`document.querySelector('${olderRow}').click()`);
    for (let count=0;count<50;count++) {
      if (await js(`document.getElementById('workOverviewPane').textContent.includes('Saved prior work is readable')`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(await js(`document.getElementById('workOverviewPane').textContent.includes('Saved prior work is readable')`), true,
      'An older supervised session must show its exact retained result');
    await js(`document.querySelector('#workOverviewPane [data-work-action="open"]').click();fixture.notify()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.equal(await js(`document.getElementById('chatTitle').textContent.includes('Earlier held Loop')`),true,
      'Explicit Progress navigation must retain the older session through a hot list refresh');
    const row = '.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="oneoff"]';
    assert.ok(await js(`!!document.querySelector('${row}')`), 'One-off result must be retained');
    await js(`document.querySelector('${row}').click()`);
    for (let i = 0; i < 60; i++) {
      if (await js(`!!document.querySelector('.work-overview-result')`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await js(`document.querySelector('.work-overview-result summary')?.textContent`), 'Read recorded final answer');
    assert.equal(await js(`document.querySelectorAll('.work-overview-row[aria-expanded="true"]').length`), 1);
    const metrics = [];
    for (const [width, zoom] of [[1100, 1], [640, 1], [640, 1.5]]) {
      win.setSize(width, 900);
      win.webContents.setZoomFactor(zoom);
      await js(`document.getElementById('workOverview').scrollIntoView({block:'center'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const geometry = await js(`(() => {
        const overview=document.getElementById('workOverview');
        const detail=document.getElementById('workOverviewPane');
        const body=document.getElementById('workOverviewBody');
        const expanded=document.querySelector('.work-overview-row[aria-expanded="true"]');
        const a=overview.getBoundingClientRect(),b=detail.getBoundingClientRect();
        return {viewport:innerWidth, overview:[a.left,a.right], detail:[b.left,b.right],
          detailPosition:getComputedStyle(detail).position,
          overflow:body.scrollWidth-body.clientWidth,expanded:expanded?.dataset.sessionId,
          workText:document.getElementById('workOverviewMeta').textContent,
          hasResult:!!document.querySelector('.work-overview-result'),
          delivery:!!document.querySelector('.work-overview-row[data-work-kind="delivery"]')};
      })()`);
      assert.ok(geometry.overview[0]>=-1 && geometry.overview[1]<=geometry.viewport+1,
        'Work overview extends beyond viewport: '+JSON.stringify({width,zoom,geometry}));
      if (geometry.detailPosition === 'fixed') {
        const expectedMinimum = geometry.viewport >= 1000
          ? Math.min(560, geometry.viewport - Math.min(380, Math.max(260, geometry.viewport * .24)) - 20) - 1
          : geometry.viewport * .8;
        assert.ok(geometry.detail[0]>=0 && geometry.detail[1]<=geometry.viewport+1 &&
          geometry.detail[1]-geometry.detail[0]>=expectedMinimum,
          'Narrow Work detail is not contained and readable in its viewport: '+JSON.stringify({width,zoom,geometry}));
      } else {
        assert.ok(geometry.detail[0]>=geometry.overview[0]-1 && geometry.detail[1]<=geometry.overview[1]+1,
          'Wide Work detail overflows its Work overview: '+JSON.stringify({width,zoom,geometry}));
      }
      assert.ok(geometry.overflow<=1, 'Work detail has unexpected sideways overflow: '+JSON.stringify({width,zoom,geometry}));
      assert.equal(geometry.expanded, 'oneoff');
      assert.equal(geometry.hasResult, true);
      assert.equal(geometry.delivery, true);
      metrics.push({width,zoom,...geometry});
      if (zoom === 1) {
        await win.webContents.capturePage(undefined, {stayHidden:true,stayAwake:true});
        const image = await win.webContents.capturePage(undefined, {stayHidden:true,stayAwake:true});
        fs.writeFileSync(path.join(output, `work-${width}.png`), image.toPNG());
      }
    }
    const focus = await js(`(() => {const toggle=document.querySelector('.work-overview-result summary');toggle.focus();return document.activeElement===toggle})()`);
    assert.equal(focus, true, 'Result disclosure must be focusable');
    // Dispatch the actual Chromium input event to this hidden fixture's webContents.
    // It has its own ephemeral Electron userData and never activates the desktop.
    win.webContents.debugger.attach('1.3');
    const axTree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const axLabels = new Set((axTree.nodes ?? []).map(node => node.name?.value).filter(Boolean));
    assert.ok(axLabels.has('Read recorded final answer'), 'Result disclosure has no accessible name');
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    const keyboard = await js(`(() => ({closed:document.getElementById('workOverviewPane').hidden,
      target:document.activeElement?.dataset.sessionId}))()`);
    assert.deepEqual(keyboard, {closed:true,target:'oneoff'}, 'Chromium Escape must close and return row focus');

    await js(`fixture.failReads=true;document.querySelector('.work-overview-section[data-work-section="current"] [data-session-id="blocked"]').click()`);
    for (let i = 0; i < 50; i++) {
      if (await js(`document.getElementById('workOverviewPane').textContent.includes('Latest history could not be read')`)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await js(`document.getElementById('workOverviewPane').textContent.includes('Latest history could not be read')`), true);
    await js(`fixture.failReads=false;document.querySelector('#workOverviewPane [data-work-action="retry"]').click()`);
    for (let i = 0; i < 50; i++) {
      if (!await js(`document.getElementById('workOverviewPane').textContent.includes('could not be read')`)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await js(`document.getElementById('workOverviewPane').textContent.includes('could not be read')`), false,
      'A confirmed new history read should clear its previous failure');

    await js(`fixture.automation.chats[0].state='waiting-main';
      fixture.automation.chats[0].spinning=false;
      fixture.automation.chats[0].reason='Main chat waiting for next confirmed turn.';
      fixture.automation.counts.working=0;fixture.automation.counts['waiting-main']=1;
      fixture.notify();`);
    await new Promise(resolve => setTimeout(resolve, 700));
    const transition = await js(`(() => ({meta:document.getElementById('workOverviewMeta').textContent,
      state:document.querySelector('.work-overview-section[data-work-section="current"] [data-session-id="prime"] .work-overview-state')?.textContent,
      retainedOneOff:!!document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]')}))()`);
    assert.ok(transition.meta.includes('1 between turns') && !transition.meta.includes('1 working'),
      'Working status failed to retire after the supervisor moved between turns: '+JSON.stringify(transition));
    assert.equal(transition.state, 'between turns');
    assert.equal(transition.retainedOneOff, true);
    const accessibility = await js(`(() => ({
      title:document.getElementById('workOverview').querySelector('summary')?.textContent,
      namedRows:[...document.querySelectorAll('.work-overview-row')].filter(e=>e.getAttribute('aria-controls')==='workOverviewPane').length,
      recoveryDisabled:document.getElementById('recoverStaleAutomation').disabled,
      notices:document.getElementById('workOverviewMeta').textContent
    }))()`);
    assert.ok(accessibility.namedRows >= 2);
    assert.ok(accessibility.notices.includes('blocked') && accessibility.notices.includes('waiting workers'));
    // The stalled source turn has ended, so activeTurnId is intentionally null:
    // that must not erase the exact turn_start that supersedes an older final.
    await js(`document.querySelector('.work-overview-section[data-work-section="current"] [data-session-id="stalled"]').click()`);
    for (let i=0;i<50;i++) {
      if (await js(`document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent.includes('previous')`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const stalledHistorical = await js(`(() => ({
      justDid:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(e=>e.querySelector('b')?.textContent==='Just did')?.textContent,
      disclosure:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      blocked:document.getElementById('workOverviewPane').textContent.includes('Review the original blocker.')
    }))()`);
    assert.ok(stalledHistorical.justDid.includes('Latest turn stalled'), JSON.stringify(stalledHistorical));
    assert.ok(!stalledHistorical.justDid.includes('Recorded final: Previously'), JSON.stringify(stalledHistorical));
    assert.equal(stalledHistorical.disclosure,'Read previous recorded final answer');
    assert.equal(stalledHistorical.blocked,true);
    // Fresh hypothesis: after that older recorded final, another exact generation makes a
    // rejected tool call. The rejection owns CURRENT status while the older final remains readable.
    nativeStage = 'new failed turn with retained result';
    await js(`(() => {
      const entry=fixture.sessions.find(s=>s.id==='stalled');
      const stamp=Date.now();
      const earlierTool=fixture.reports.stalled.find(row=>row.kind==='tool_call');
      entry.lastTurnOutcome='failed';entry.lastToolCallAt=stamp+1;entry.lastTurnEndAt=stamp+2;
      fixture.reports.stalled.push(
        {kind:'turn_start',seq:437,time:stamp,source:'extension',turnId:'new-failed-turn'},
        {...earlierTool,seq:438,time:stamp+1,turnId:'new-failed-turn',
          call:{...earlierTool.call,callId:'newer-rejected-call',outcome:'tool_rejected',
            summary:{kind:'read',title:'Latest rejected evidence read',tone:'bad'}}},
        {kind:'turn_end',seq:439,time:stamp+2,source:'extension',turnId:'new-failed-turn',outcome:'failed'});
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    const newerFailed = await js(`(() => ({
      current:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      prior:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      previousResult:document.querySelector('#workOverviewPane .work-overview-result')?.textContent,
      history:document.querySelector('#workOverviewPane .work-overview-history')?.textContent
    }))()`);
    assert.ok(newerFailed.current.includes('Rejected') && newerFailed.current.includes('Latest rejected evidence read'), JSON.stringify(newerFailed));
    assert.ok(!newerFailed.current.includes('Recorded final'), JSON.stringify(newerFailed));
    assert.equal(newerFailed.prior,'Read previous recorded final answer');
    assert.ok(newerFailed.previousResult.includes('Previously recorded valid final'), JSON.stringify(newerFailed));
    assert.ok(newerFailed.history.includes('Rejected'), JSON.stringify(newerFailed));
    nativeStage = 'capturing prior result after failure';
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    await js(`(() => { const detail=document.getElementById('workOverviewPane');
      detail.querySelector('.work-overview-result').open=true;
      detail.scrollIntoView({block:'center'});
      return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); })()`);
    const failedCapture = await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-current-failure-prior-result.png'),failedCapture.toPNG());
    // A new exact outcome clears the previous label, without invoking any
    // recovery control or browser Send. This is native-source renderer only.
    await js(`(() => {
      const entry=fixture.sessions.find(s=>s.id==='stalled');
      const stamp=Date.now();
      entry.activeTurnId='recovered-turn';
      entry.lastAssistantFinalAt=stamp+1;
      fixture.reports.stalled.push(
        {kind:'turn_start',seq:440,time:stamp,source:'extension',turnId:'recovered-turn'},
        {kind:'assistant_message',seq:441,time:stamp+1,source:'extension',
          turnId:'recovered-turn',messageId:'recovered-result',final:true,
          message:{text:'Recovery has a new exact final.',chars:31,truncated:false}});
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    const recoveryProof = await js(`(() => ({
      justDid:document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent,
      disclosure:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent
    }))()`);
    assert.ok(recoveryProof.justDid.includes('Recorded final: Recovery has a new exact final.'), JSON.stringify(recoveryProof));
    assert.equal(recoveryProof.disclosure,'Read recorded final answer');
    // New hypothesis: a durable session returns to a new provider conversation after
    // another chat was selected. The former final stays readable but cannot own the
    // new turn's Just did label. Exercise the actual renderer at that transition.
    await js(`(() => {
      const original=fixture.sessions.find(row=>row.id==='prime');
      const stamp=Date.now();
      fixture.reports.prime.push({kind:'assistant_message',seq:3,time:stamp,
        source:'extension',turnId:'old-provider-turn',messageId:'old-provider-final',
        final:true,state:'final',message:{text:'Previous final is already saved.',chars:32,truncated:false}});
      original.lastAssistantFinalAt=stamp;original.lastTurnEndAt=stamp+1;
      original.lastTurnOutcome='completed';
      fixture.notify();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 650));
    await js(`document.querySelector('.work-overview-section[data-work-section="current"] [data-session-id="prime"]').click()`);
    for (let i=0; i<50; i++) {
      if (await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Recorded final: Previous final')`)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Recorded final: Previous final')`),true);
    await js(`document.querySelector('#sessionList [data-id="worker"]').click()`);
    await js(`(() => {
      const original=fixture.sessions.find(row=>row.id==='prime');
      original.conversationId='new-provider-prime';
      original.chatIds.push('new-provider-prime');
      original.activeTurnId='new-native-provider-turn';
      fixture.reports.prime.push({kind:'turn_start',seq:4,time:Date.now()+2,
        source:'extension',turnId:'new-native-provider-turn'});
      fixture.automation.chats[0].conversationId=original.conversationId;
      fixture.automation.chats[0].state='working';
      fixture.automation.chats[0].spinning=true;
      fixture.automation.chats[0].nextAction='Await current turn result.';
      fixture.automation.counts.working=1;
      fixture.automation.counts['waiting-main']=0;
      fixture.notify();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 650));
    await js(`document.querySelector('#sessionList [data-id="prime"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    const resumed = await js(`(() => ({
      label:document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent,
      disclosure:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      selected:document.getElementById('chatTitle').textContent,
      expanded:[...document.querySelectorAll('.work-overview-row[aria-expanded="true"]')].map(row=>row.dataset.sessionId)
    }))()`);
    assert.ok(resumed.label.includes('New turn started; no exact final or tool outcome yet.'),JSON.stringify(resumed));
    assert.equal(resumed.disclosure,'Read previous recorded final answer');
    assert.deepEqual(resumed.expanded,['prime']);
    await js(`(() => {
      const original=fixture.sessions.find(row=>row.id==='prime');
      const stamp=Date.now()+10;
      fixture.reports.prime.push({kind:'assistant_message',seq:5,time:stamp,
        source:'extension',turnId:'new-native-provider-turn',messageId:'new-provider-final',
        final:true,state:'final',message:{text:'Newest exact final belongs to the current provider.',chars:51,truncated:false}});
      original.lastAssistantFinalAt=stamp;
      fixture.notify();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 650));
    const newest = await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent ?? ''`);
    assert.ok(newest.includes('Recorded final: Newest exact final belongs to the current provider.'),newest);
    assert.ok(!newest.includes('Recorded final: Previous final'),newest);
    nativeStage = 'fresh exact detail after sidebar/provider binding lags';
    await js(`(() => {
      const listed=fixture.sessions.find(row=>row.id==='prime');
      const fresh=Object.assign({},listed,{
        conversationId:'newer-exact-provider',
        activeTurnId:'newer-exact-turn',
        chatIds:[...listed.chatIds,'newer-exact-provider'],
        lastTurnOutcome:null
      });
      fixture.detailOverrides.prime=fresh;
      listed.conversationId='old-provider-prime';
      listed.activeTurnId='old-provider-turn';
      fixture.reports.prime.push({kind:'turn_start',seq:6,time:Date.now()+20,
        source:'extension',turnId:'newer-exact-turn'});
      fixture.notify();
    })()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('New turn started; no exact final')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const fresherDetail=await js(`(() => ({
      current:document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent,
      label:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      previous:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent
    }))()`);
    assert.ok(fresherDetail.current.includes('New turn started; no exact final'),JSON.stringify(fresherDetail));
    assert.equal(fresherDetail.label,'Read previous recorded final answer');
    assert.ok(fresherDetail.previous.includes('Newest exact final belongs to the current provider'));
    await js(`(() => {
      const exact=fixture.detailOverrides.prime;
      const stamp=Date.now()+30;
      fixture.reports.prime.push({kind:'assistant_message',seq:7,time:stamp,
        source:'extension',turnId:'newer-exact-turn',messageId:'fresh-rebound-final',
        final:true,message:{text:'Exact newer bound turn now has its own final.',chars:45,truncated:false}});
      exact.activeTurnId=null;exact.lastAssistantFinalAt=stamp;
      exact.lastTurnEndAt=stamp+1;exact.lastTurnOutcome='completed';
      // The exact provider's finish owner survives clearing activeTurnId and is
      // the authoritative custody for an otherwise provider-less saved final.
      const opened=fixture.reports.prime.find(row=>row.kind==='turn_start'&&row.turnId==='newer-exact-turn');
      exact.finishTurn={turnId:'newer-exact-turn',conversationId:exact.conversationId,
        startedAt:opened.time,notified:false,released:true,decisionRevision:null,
        workSeq:0,decisionSeq:0,decisionInputRevision:null};
      fixture.notify();
    })()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Exact newer bound turn now has its own final')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Recorded final: Exact newer bound turn now has its own final')`),true);
    await js(`(() => {
      const listed=fixture.sessions.find(row=>row.id==='prime');
      Object.assign(listed,fixture.detailOverrides.prime);
      delete fixture.detailOverrides.prime;
      fixture.notify();
    })()`);
    nativeStage = 'completed empty turn status projection';
    await js(`(() => {
      const original=fixture.sessions.find(row=>row.id==='oneoff');
      const stamp=Date.now();
      original.finishTurn={turnId:'oneoff-empty-later',conversationId:original.conversationId,
        startedAt:stamp,notified:false,released:true,decisionRevision:null,workSeq:0,
        decisionSeq:0,decisionInputRevision:null};
      original.lastTurnOutcome='completed';original.lastTurnEndAt=stamp+1;original.activeTurnId=null;
      fixture.reports.oneoff.push(
        {kind:'turn_start',seq:10,time:stamp,source:'extension',turnId:'oneoff-empty-later'},
        {kind:'turn_end',seq:11,time:stamp+1,source:'extension',turnId:'oneoff-empty-later',outcome:'completed'});
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,650));
    const priorOneoffState = await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"] .work-overview-state')?.textContent`);
    assert.equal(priorOneoffState,'Previous final retained');
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    const completedWithoutResult = await js(`(() => ({
      current:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      result:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent
    }))()`);
    assert.ok(completedWithoutResult.current.includes('Latest turn completed; no exact final'),JSON.stringify(completedWithoutResult));
    assert.equal(completedWithoutResult.result,'Read previous recorded final answer');
    nativeStage = 'paged persisted one-off result beyond eighty events';
    await js(`(() => {
      fixture.strictPaging=true;
      const saved=fixture.sessions.find(row=>row.id==='oneoff');
      const newest=fixture.reports.oneoff;
      for(let i=0;i<172;i++)newest.push({kind:'progress',seq:i+12,time:Date.now()+i,
        source:'app',turnId:'oneoff-empty-later',progressId:'oneoff-later-progress-'+i,
        message:{text:'Later work, no final.',chars:21,truncated:false}});
      saved.events=newest.length;
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    // Reopen after leaving the inspected row. This discards its view-local result cache
    // and exercises the actual persisted before-cursor retrieval on a fresh inspection.
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="worker"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,80));
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]').click()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('RESULT: Completed safe UI review')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const pagedOneoff = await js(`(() => ({
      label:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      result:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      body:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent,
      olderReads:fixture.reads.filter(read=>read.id==='oneoff'&&read.before!==null).length
    }))()`);
    assert.ok(pagedOneoff.label.includes('Latest turn completed; no exact final'),JSON.stringify(pagedOneoff));
    assert.equal(pagedOneoff.result,'Read previous recorded final answer');
    assert.ok(pagedOneoff.body.includes('RESULT: Completed safe UI review'),JSON.stringify(pagedOneoff));
    assert.ok(pagedOneoff.olderReads>0,'The older saved answer must actually be retrieved through the before cursor');
    const priorReads=pagedOneoff.olderReads;
    await js(`fixture.notify()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.equal(await js(`fixture.reads.filter(read=>read.id==='oneoff'&&read.before!==null).length`),priorReads,
      'An unchanged result must not reread the full historical tail on a status refresh');

    nativeStage = 'paged worker report and matching older Prime receipt';
    nativeStage = 'injecting historical worker and Prime records';
    await js(`(() => {
      const worker=fixture.sessions.find(row=>row.id==='worker');
      const prime=fixture.sessions.find(row=>row.id==='prime');
      const stamp=Date.now();
      worker.lastToolCallAt=stamp+180;worker.lastTurnOutcome='failed';worker.activeTurnId=null;
      worker.finishTurn={turnId:'worker-deep-later',conversationId:worker.conversationId,
        startedAt:stamp,notified:false,released:true,decisionRevision:null,workSeq:0,decisionSeq:0,decisionInputRevision:null};
      for(let i=0;i<172;i++)fixture.reports.worker.push({kind:'tool_call',seq:i+6,time:stamp+i,
        source:'mcp',turnId:'worker-deep-later',call:{callId:'worker-deep-'+i,tool:'read',
        outcome:i===171?'tool_rejected':'ok',durationMs:1,attribution:'request_id',
        args:{text:'{}',chars:2,truncated:false},result:{text:'',chars:0,truncated:false},
        summary:{kind:'read',title:i===171?'Later worker denied':'Worker did another check',tone:'neutral'}}});
      worker.events=fixture.reports.worker.length;
      for(let i=0;i<172;i++)fixture.reports.prime.push({kind:'tool_call',seq:i+6,time:stamp+i,
        source:'mcp',turnId:'prime-deep-later',call:{callId:'prime-deep-'+i,tool:'read',
        outcome:'ok',durationMs:1,attribution:'request_id',args:{text:'{}',chars:2,truncated:false},
        result:{text:'',chars:0,truncated:false},summary:{kind:'read',title:'Prime later check',tone:'neutral'}}});
      prime.events=fixture.reports.prime.length;
      fixture.notify();
    })()`);
    nativeStage = 'awaiting historical worker and Prime status';
    await new Promise(resolve=>setTimeout(resolve,700));
    nativeStage = 'opening long-history worker detail';
    await js(`fixture.failOlderPrime=true`);
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="worker"]').click()`);
    nativeStage = 'Prime receipt lookup incomplete: exposed retry and preserved unknown delivery';
    for(let i=0;i<65;i++){
      if(await js(`document.getElementById('workOverviewPane').textContent.includes('Prime receipt unavailable')&&!!document.querySelector('#workOverviewPane [data-work-action="retry-older"]')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const unavailablePrime=await js(`(() => ({
      uncertain:document.getElementById('workOverviewPane').textContent.includes('Prime receipt unavailable'),
      retry:!!document.querySelector('#workOverviewPane [data-work-action="retry-older"]'),
      claimed:document.getElementById('workOverviewPane').textContent.includes('Prime received this report')
    }))()`);
    assert.deepEqual(unavailablePrime,{uncertain:true,retry:true,claimed:false},JSON.stringify(unavailablePrime));
    await js(`fixture.failOlderPrime=false;document.querySelector('#workOverviewPane [data-work-action="retry-older"]').click()`);
    nativeStage = 'waiting for paged worker and Prime receipt';
    for(let i=0;i<65;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent.includes('previous')&&document.getElementById('workOverviewPane').textContent.includes('Prime received this report')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    nativeStage = 'reading paged worker status';
    const pagedWorker = await js(`(() => ({
      current:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      saved:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      prime:document.getElementById('workOverviewPane').textContent.includes('Prime received this report'),
      workerReads:fixture.reads.filter(read=>read.id==='worker'&&read.before!==null).length,
      primeReads:fixture.reads.filter(read=>read.id==='prime'&&read.before!==null).length
    }))()`);
    nativeStage = 'checking paged worker evidence and zoom';
    assert.ok(pagedWorker.current.includes('Later worker denied'),JSON.stringify(pagedWorker));
    assert.equal(pagedWorker.saved,'Read previous saved worker report');
    assert.equal(pagedWorker.prime,true,'Receipt means the earlier report reached Prime; newer worker failure stays current');
    assert.ok(pagedWorker.workerReads>0&&pagedWorker.primeReads>0,JSON.stringify(pagedWorker));
    win.setSize(640,900);win.webContents.setZoomFactor(1.5);
    for (let i=0;i<45;i++) {
      if (await js(`window.innerWidth<500`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const zoomOverflow=await js(`document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth`);
    assert.ok(zoomOverflow<=1,'Long paged results overflow at narrow high zoom: '+zoomOverflow);
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    nativeStage = 'capturing long-history worker result';
    await js(`document.querySelector('#workOverviewPane .work-overview-result')?.scrollIntoView({block:'center'})`);
    // A hidden compositor can still be processing the preceding high-zoom resize.
    // Finish its two pending render frames before attempting the offscreen capture.
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const pagedCapture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-paged-worker-prime-receipt.png'),pagedCapture.toPNG());
    nativeStage = 'same-message final revision survives a later tail eviction';
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]').click()`);
    for(let i=0;i<50;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('RESULT: Completed safe UI review')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await js(`(() => {
      const original=fixture.reports.oneoff.find(event=>event.kind==='assistant_message'&&event.messageId==='final-oneoff');
      fixture.reports.oneoff.push({...original,seq:184,origin:original.seq,
        semanticUpdatedAt:Date.now(),message:{text:'RESULT: Final corrected one-off text, same provider ID.',chars:52,truncated:false}});
      fixture.sessions.find(row=>row.id==='oneoff').events=fixture.reports.oneoff.length;
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.equal(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Final corrected one-off text')`),true);
    await js(`(() => {
      for(let i=0;i<91;i++)fixture.reports.oneoff.push({kind:'progress',seq:i+185,
        time:Date.now()+i,source:'app',turnId:'oneoff-empty-later',progressId:'after-revision-'+i,
        message:{text:'New activity is not a final.',chars:28,truncated:false}});
      fixture.sessions.find(row=>row.id==='oneoff').events=fixture.reports.oneoff.length;
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    const revisedRetained=await js(`(() => ({
      corrected:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Final corrected one-off text'),
      obsolete:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Completed safe UI review'),
      originalSession:document.getElementById('workOverviewPane').textContent.includes('local session oneoff')
    }))()`);
    assert.deepEqual(revisedRetained,{corrected:true,obsolete:false,originalSession:true},
      'The latest saved revision must remain owned by its original session after another eighty newer events');
    nativeStage = 'cold retrieval chooses distinct newer final before late revision to prior result';
    await js(`(() => {
      const oneoff=fixture.sessions.find(row=>row.id==='oneoff');
      const original=fixture.reports.oneoff.find(event=>event.kind==='assistant_message'&&event.messageId==='final-oneoff');
      const later=Date.now()+5000;
      fixture.reports.oneoff.push({kind:'assistant_message',seq:276,origin:276,time:later,
        source:'extension',turnId:'later-distinct-final',messageId:'second-oneoff-result',
        final:true,message:{text:'SECOND distinct completed result is the newest saved output.',chars:59,truncated:false}});
      for(let i=0;i<105;i++)fixture.reports.oneoff.push({kind:'progress',seq:277+i,time:later+10+i,
        source:'app',turnId:'following-failed-turn',progressId:'after-second-final-'+i,
        message:{text:'This is later progress, not a final.',chars:36,truncated:false}});
      fixture.reports.oneoff.push({...original,seq:382,origin:original.seq,
        semanticUpdatedAt:later+300,message:{text:'Late revision to FIRST old result only.',chars:39,truncated:false}});
      for(let i=0;i<65;i++)fixture.reports.oneoff.push({kind:'progress',seq:383+i,time:later+320+i,
        source:'app',turnId:'following-failed-turn',progressId:'after-old-revision-'+i,
        message:{text:'No new completed output.',chars:24,truncated:false}});
      oneoff.lastAssistantFinalAt=later;oneoff.lastTurnOutcome='failed';
      oneoff.finishTurn={turnId:'following-failed-turn',conversationId:oneoff.conversationId,
        startedAt:later+1,notified:false,released:true,decisionRevision:null,
        workSeq:0,decisionSeq:0,decisionInputRevision:null};
      oneoff.events=fixture.reports.oneoff.length;
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,650));
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="worker"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,80));
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]').click()`);
    for(let i=0;i<75;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('SECOND distinct completed result')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const finalOriginOrder=await js(`(() => ({
      newest:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('SECOND distinct completed result'),
      erroneous:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('Late revision to FIRST'),
      source:document.getElementById('workOverviewPane').textContent.includes('local session oneoff'),
      label:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      oldestPageReads:fixture.reads.filter(r=>r.id==='oneoff'&&r.before!==null).length
    }))()`);
    assert.equal(finalOriginOrder.newest,true,JSON.stringify(finalOriginOrder));
    assert.equal(finalOriginOrder.erroneous,false,JSON.stringify(finalOriginOrder));
    assert.equal(finalOriginOrder.source,true,JSON.stringify(finalOriginOrder));
    assert.equal(finalOriginOrder.label,'Read previous recorded final answer');
    assert.ok(finalOriginOrder.oldestPageReads>0);
    nativeStage = 'triggering exact-session history outage after a confirmed result';
    await js(`(() => {
      const details=document.querySelector('#workOverviewPane .work-overview-result');
      details.open=true;
      details.querySelector('summary').focus();
      fixture.failHistoryFor='oneoff';
      fixture.notify();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,700));
    nativeStage = 'reading retained result and focus from the outage projection';
    const interruptedHistory=await js(`(() => ({
      warning:document.getElementById('workOverviewPane').textContent.includes('Latest history could not be read'),
      result:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent.includes('SECOND distinct completed result'),
      label:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      justDid:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      expanded:document.querySelector('#workOverviewPane .work-overview-result')?.open,
      focus:document.activeElement===document.querySelector('#workOverviewPane .work-overview-result summary'),
      retry:!!document.querySelector('#workOverviewPane [data-work-action="retry"]')
    }))()`);
    assert.deepEqual(interruptedHistory,{
      warning:true,result:true,label:'Read last confirmed recorded final answer',
      justDid:interruptedHistory.justDid,expanded:true,focus:true,retry:true
    },JSON.stringify(interruptedHistory));
    assert.ok(interruptedHistory.justDid.includes('Latest history unavailable'),JSON.stringify(interruptedHistory));
    assert.ok(!interruptedHistory.justDid.includes('Recorded final:'),JSON.stringify(interruptedHistory));
    nativeStage = 'measuring narrow high-zoom outage geometry';
    win.setSize(640,900);win.webContents.setZoomFactor(1.5);
    const outageOverflow=await js(`document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth`);
    assert.ok(outageOverflow<=1,'The retained result overflowed in a narrow outage view: '+outageOverflow);
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    nativeStage = 'capturing the retained result outage screenshot after compositor settling';
    await js(`document.querySelector('#workOverviewPane .work-overview-result')?.scrollIntoView({block:'center'})`);
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const outageImage=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-history-outage-retained.png'),outageImage.toPNG());
    nativeStage = 'switch sessions while one history source is unavailable, then recover';
    await js(`document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="worker"]').click()`);
    for(let i=0;i<45;i++){
      if(await js(`document.getElementById('workOverviewPane').textContent.includes('Saved for Prime')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(await js(`document.getElementById('workOverviewPane').textContent.includes('SECOND distinct completed result')`),false,
      'The interrupted first session must never contribute text to another selected pane');
    await js(`(() => {
      fixture.failHistoryFor=null;
      const row=fixture.sessions.find(s=>s.id==='oneoff');
      const when=Date.now()+1000;
      row.lastToolCallAt=when;row.lastTurnOutcome='failed';
      fixture.reports.oneoff.push({kind:'tool_call',seq:448,time:when,source:'mcp',
        turnId:'following-failed-turn',call:{callId:'recovered-rejected-read',tool:'read',
        outcome:'tool_rejected',durationMs:2,attribution:'request_id',
        args:{text:'{}',chars:2,truncated:false},result:{text:'',chars:0,truncated:false},
        summary:{kind:'read',title:'Newer read rejected after recovery',tone:'bad'}}});
      row.events=fixture.reports.oneoff.length;
      document.querySelector('.work-overview-section[data-work-section="updates"] [data-session-id="oneoff"]').click();
    })()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Newer read rejected after recovery')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const recoveredHistory=await js(`(() => ({
      current:document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent,
      previous:document.querySelector('#workOverviewPane .work-overview-result-body')?.textContent,
      label:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent,
      warning:document.getElementById('workOverviewPane').textContent.includes('Latest history could not be read')
    }))()`);
    assert.ok(recoveredHistory.current.includes('Rejected') &&
      recoveredHistory.current.includes('Newer read rejected after recovery'),JSON.stringify(recoveredHistory));
    assert.ok(recoveredHistory.previous.includes('SECOND distinct completed result'),JSON.stringify(recoveredHistory));
    assert.equal(recoveredHistory.label,'Read previous recorded final answer');
    assert.equal(recoveredHistory.warning,false);
    // Native renderer reopen against the same durable-looking fixture resets its
    // transient row selection but must keep the stalled turn's earlier final
    // historical. The fixture rehydrates; it is not an installed app restart.
    nativeStage = 'native renderer reload';
    await win.webContents.reload();
    for (let i=0;i<90;i++) {
      if (await js(`!!window.fixtureReady && !!document.querySelector('[data-session-id="stalled"]')`)) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await js(`document.querySelector('.work-overview-section[data-work-section="current"] [data-session-id="stalled"]').click()`);
    for (let i=0;i<50;i++) {
      if (await js(`document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent.includes('previous')`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const reopenedStalled = await js(`(() => ({
      justDid:document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent,
      disclosure:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent
    }))()`);
    assert.ok(reopenedStalled.justDid.includes('Latest turn stalled'), JSON.stringify(reopenedStalled));
    assert.equal(reopenedStalled.disclosure,'Read previous recorded final answer');
    nativeStage = 'current B provider error with delayed A error and unbound old worker report';
    await js(`(() => {
      const now=Date.now();
      const worker=fixture.sessions.find(row=>row.id==='worker');
      worker.conversationId='provider-B-native';
      worker.chatIds=['provider-A-native','provider-B-native'];
      worker.activeTurnId=null;worker.lastTurnOutcome='failed';worker.lastTurnEndAt=now-1500;
      worker.lastFinishReportAt=now-1000;worker.lastToolCallAt=now-6000;
      worker.finishTurn={turnId:'B-current-native',conversationId:'provider-B-native',
        startedAt:now-8000,notified:false,released:true,decisionRevision:null,
        workSeq:0,decisionSeq:0,decisionInputRevision:null};
      fixture.reports.worker=[
        {kind:'tool_call',seq:1,time:now-6000,source:'mcp',turnId:'B-current-native',
          call:{callId:'exact-native-B-call',tool:'read',conversationId:'provider-B-native',
            attribution:'request_id',attributionMethod:'request_id',durationMs:3,outcome:'ok',
            args:{text:'{}',chars:2,truncated:false},result:{text:'',chars:0,truncated:false},
            summary:{kind:'read',title:'Exact current B result',tone:'neutral'}}},
        {kind:'chat_error',seq:2,time:now-3000,source:'extension',
          turnId:'B-current-native',reason:'model_cooldown',blocking:true,
          message:{text:'Provider B exact model hold',chars:27,truncated:false}},
        {kind:'agent_message',seq:3,time:now-1000,source:'app',
          agent:'worker-1',from:'worker-1',to:'prime',delivery:'sent',
          messageId:'historical-native-worker-report',
          message:{text:'[worker-1 finished] RESULT: Report saved; current B attribution not proven.',
            chars:72,truncated:false}},
        {kind:'chat_error',seq:4,time:now-500,source:'extension',
          turnId:'historical-A-native-turn',reason:'model_cooldown',blocking:true,
          message:{text:'Late previous provider A model error',chars:36,truncated:false}}
      ];
      worker.events=fixture.reports.worker.length;
      fixture.automation.chats.push({sessionId:worker.id,conversationId:worker.conversationId,
        title:worker.title,mode:'goal',state:'blocked',
        reason:'B current native fixture hold',nextAction:'Review current B evidence',
        nextRetryAt:null,lastWorkedAt:now-1500,activeWorkers:0,recoverable:false,
        spinning:false,recoveryStage:null});
      fixture.automation.counts.blocked++;
      fixture.notify();
    })()`);
    await js(`document.querySelector('.work-overview-row[data-session-id="worker"]').click()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Provider error recorded: Provider B exact model hold')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const oldReportCustody=await js(`(() => {
      const pane=document.getElementById('workOverviewPane');
      const field=key=>[...pane.querySelectorAll('.work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent===key)?.textContent??'';
      return {latest:field('Just did'),provider:field('Provider evidence'),
        current:field('Current status'),prime:field('Prime receipt'),
        report:pane.querySelector('.work-overview-result summary')?.textContent,
        retained:pane.querySelector('.work-overview-result-body')?.textContent,
        history:pane.querySelector('.work-overview-history')?.textContent,
        spoken:document.getElementById('workOverviewAnnouncement')?.textContent};
    })()`);
    assert.ok(oldReportCustody.latest.includes('Provider error recorded: Provider B exact model hold'),JSON.stringify(oldReportCustody));
    assert.ok(oldReportCustody.provider.includes('Provider B exact model hold') &&
      !oldReportCustody.provider.includes('Late previous provider A'),JSON.stringify(oldReportCustody));
    assert.ok(oldReportCustody.current.includes('blocked'),JSON.stringify(oldReportCustody));
    assert.equal(oldReportCustody.report,'Read previous saved worker report');
    assert.ok(oldReportCustody.retained.includes('Report saved; current B attribution not proven.'),JSON.stringify(oldReportCustody));
    assert.ok(oldReportCustody.prime.includes('not attributed to the current provider turn') &&
      oldReportCustody.spoken.includes('current provider association unverified'),JSON.stringify(oldReportCustody));
    assert.ok(oldReportCustody.history.includes('provider association unverified'),JSON.stringify(oldReportCustody));
    win.setSize(640,900);win.webContents.setZoomFactor(1.5);
    await js(`(() => {
      document.querySelector('#workOverviewPane button[data-work-action="close"]').click();
      document.querySelector('.work-overview-row[data-session-id="worker"]').click();
    })()`);
    const custodyCapturePlacement=await js(`(() => {
      const pane=document.getElementById('workOverviewPane');
      pane.scrollTop=0;
      const rect=pane.getBoundingClientRect();
      const heading=pane.querySelector('.work-overview-pane-head').getBoundingClientRect();
      const close=pane.querySelector('button[data-work-action="close"]');
      return {position:getComputedStyle(pane).position,viewport:window.innerWidth,
        width:rect.width,height:rect.height,left:rect.left,top:rect.top,
        headingVisible:heading.top>=rect.top&&heading.bottom<rect.bottom,
        closeFocused:document.activeElement===close,
        activeAction:document.activeElement?.dataset?.workAction,
        mediaMatch:window.matchMedia('(max-width: 700px)').matches,
        overflow:pane.scrollWidth-pane.clientWidth,
        visible:rect.left>=0&&rect.right<=window.innerWidth+1&&rect.top>=0&&rect.bottom<=window.innerHeight+1};
    })()`);
    assert.ok(custodyCapturePlacement.visible && custodyCapturePlacement.position==='fixed' &&
      custodyCapturePlacement.width>custodyCapturePlacement.viewport*.8 &&
      custodyCapturePlacement.headingVisible&&custodyCapturePlacement.closeFocused,
      'Synthetic Work & updates pane is not visible in zoomed screenshot: '+JSON.stringify(custodyCapturePlacement));
    const lateCustodyOverflow=await js(`document.getElementById('workOverviewBody').scrollWidth-document.getElementById('workOverviewBody').clientWidth`);
    assert.ok(lateCustodyOverflow<=1,'Rebound worker evidence overflows at narrow high zoom: '+lateCustodyOverflow);
    await new Promise(resolve=>setTimeout(resolve,100));
    const custodyCapture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-rebound-worker-error-custody.png'),custodyCapture.toPNG());
    nativeStage = 'Work detail at 200% zoom, native keyboard close, and focus return';
    win.webContents.setZoomFactor(2);
    for (let i=0;i<45;i++) {
      if (await js(`window.innerWidth<=340`)) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const zoom200=await js(`(() => {
      const pane=document.getElementById('workOverviewPane');
      const rect=pane.getBoundingClientRect();
      return {position:getComputedStyle(pane).position,viewport:window.innerWidth,
        width:rect.width,height:rect.height,overlap:pane.scrollWidth-pane.clientWidth,
        headingVisible:pane.querySelector('.work-overview-pane-head').getBoundingClientRect().bottom<rect.bottom,
        closeFocused:document.activeElement===pane.querySelector('button[data-work-action="close"]')};
    })()`);
    assert.ok(zoom200.position==='fixed'&&zoom200.width>zoom200.viewport*.8 &&
      zoom200.overlap<=1&&zoom200.headingVisible&&zoom200.closeFocused,JSON.stringify(zoom200));
    const zoom200Capture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    fs.writeFileSync(path.join(output,'work-rebound-worker-error-200pct.png'),zoom200Capture.toPNG());
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27
    });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27
    });
    const zoom200Keyboard=await js(`({
      closed:document.getElementById('workOverviewPane').hidden,
      row:document.activeElement?.dataset.sessionId
    })`);
    assert.equal(zoom200Keyboard.closed,true,JSON.stringify(zoom200Keyboard));
    assert.equal(zoom200Keyboard.row,'worker',JSON.stringify(zoom200Keyboard));
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    await js(`document.querySelector('.work-overview-row[data-session-id="worker"]').click()`);
    nativeStage = 'exact current B worker report supersedes its own earlier provider error';
    await js(`(() => {
      fixture.reports.worker.find(row=>row.kind==='agent_message').turnId='B-current-native';
      fixture.notify();
    })()`);
    for(let i=0;i<60;i++){
      if(await js(`document.querySelector('#workOverviewPane .work-overview-pane-field')?.textContent.includes('Worker report saved for Prime')`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const exactBReport=await js(`(() => ({
      latest:[...document.querySelectorAll('#workOverviewPane .work-overview-pane-field')]
        .find(row=>row.querySelector('b')?.textContent==='Just did')?.textContent,
      report:document.querySelector('#workOverviewPane .work-overview-result summary')?.textContent
    }))()`);
    assert.ok(exactBReport.latest.includes('Worker report saved for Prime'),JSON.stringify(exactBReport));
    assert.equal(exactBReport.report,'Read saved worker report');
    await exerciseWorkflowReceipt();
    for (const [name,hash] of sourceBaseline) assert.equal(sourceHash(name),hash,
      'Concurrent source writer changed '+name+' during native fixture; results are not one source epoch');
    console.log(JSON.stringify({result:'PASS',kind:'isolated-hidden-Electron',metrics,modeContrast,keyboard,
      axResultLabel:true,readFailureRetry:true,transition,accessibility,
      providerRebind:{previousLabeled:true,oldResultRetained:true,newCurrentFinal:true},
      exactDetailAgainstOldSidebar:{earlierFinalWasPrevious:true,
        freshTurnNotMisattributed:true,newExactFinalVisible:true},
      newerFailed:{currentRejected:true,earlierFinalReadable:true,screenshot:'work-current-failure-prior-result.png'},
      completedWithoutResult:{previousFinalRetained:true,currentNotMisrepresented:true},
      pagedOneoff:{olderResultRecovered:true,stableRefresh:true,originCorrect:true},
      pagedWorker:{olderReportRecovered:true,exactPrimeReceipt:true,zoomOverflow},
      finalRevision:{sameMessageIdAndTime:true,latestTextRetained:true,originTracked:true},
      distinctResultRevision:{coldReopenCorrect:true,stableOriginPriority:true},
      interruptedHistory:{previousResultReadable:true,staleSuccessPrevented:true,
        retryVisible:true,keyboardFocus:true,narrowOverflow:outageOverflow,otherSessionIsolated:true,recoveredCurrentFailure:true},
      stalledResult:{previousLabeled:true,recoveryCurrent:true,reopenPrevious:true},
      pagedHeldLoop:{exactResult:true,progressNavigation:true},workerReceipt,
      delayedProviderCustody:{currentBErrorVisible:true,historicalAErrorRetained:true,
        unboundWorkerReportRetained:true,exactCurrentBReportVisible:true,
        accessibleUnknownLabel:true,narrowZoomOverflow:lateCustodyOverflow,
        sheet150:custodyCapturePlacement,sheet200:zoom200,keyboard200:zoom200Keyboard,
        screenshot:'work-rebound-worker-error-custody.png',
        screenshot200:'work-rebound-worker-error-200pct.png'},
      previousWorkerAfterFailure:{currentFailure:true,olderReportRetained:true,olderPrimeReceiptPreserved:true},output}));
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
}).catch(error => {
  console.error('Native fixture failed at '+nativeStage+':', error?.stack || String(error));
  if (error?.cause) console.error('Native fixture cause:', error.cause?.stack || String(error.cause));
  app.exit(1);
});
