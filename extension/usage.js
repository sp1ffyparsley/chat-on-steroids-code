/**
 * Passive, bounded page-response projection.
 *
 * Never reads request headers, cookies or credentials. Bounded resume JSON contributes only
 * the opaque conversation id needed to identify a failed stream. Besides
 * quota metadata, it observes the two opaque identifiers ChatGPT itself puts in the live
 * conversation event stream: `conversation_id` and `metadata.request_id`, plus the app/link
 * metadata of a complete connector result (never its content). The request id can
 * reach the stream tens of seconds before React publishes it, which is the difference between
 * an exact Core caller and CALLER_IDENTITY_REQUIRED. Resume requests also project their
 * opaque conversation id and HTTP status; the isolated recorder owns generation eligibility.
 */
(() => {
  'use strict';
  // Preserve app-owned navigation identity before ChatGPT's SPA strips the cos-* marker.
  // The isolated content script independently validates the elected tab and current page.
  try {
    const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1));
    const markers = {
      input: url.searchParams.get('cos-input') || hash.get('cos-input'),
      refresh: url.searchParams.get('cos-plugin-refresh') || hash.get('cos-plugin-refresh'),
      catalog: url.searchParams.get('cos-model-catalog') || hash.get('cos-model-catalog')
    };
    if (markers.input || markers.refresh || markers.catalog) {
      sessionStorage.setItem('cosBootMarkers', JSON.stringify(markers));
    }
  } catch { /* Marker capture is best-effort; downstream ownership still fails closed. */ }
  const OBSERVER_VERSION = 11;
  const prior = window.__cosUsageObserver;
  // An extension update re-executes this file in tabs that remain open. Replace the reader only
  // when the service worker explicitly asks; ordinary duplicate injection refreshes the current
  // observer without stacking fetch/socket wrappers.
  const replace = window.__cosUsageReplace === true;
  try { delete window.__cosUsageReplace; } catch { window.__cosUsageReplace = false; }
  if (!replace && prior?.version === OBSERVER_VERSION && typeof prior.refresh === 'function' && prior.refresh() === true) return;
  // A legacy boolean has no disposal handle. Reload is safer than stacking another reader.
  if (prior && typeof prior.dispose !== 'function') { window.__cosUsageObserverNeedsReload = true; return; }
  if (prior && (replace || prior.version !== OBSERVER_VERSION)) {
    // Republish retained origins before the old observer forgets them.
    try { window.dispatchEvent(new MessageEvent('message', { data: { type: 'cos-usage-request' }, origin: location.origin, source: window })); } catch { /* Best effort. */ }
  }
  prior?.dispose();
  let active = true;
  const nativePost = window.postMessage.bind(window);
  const post = (...args) => { if (active) nativePost(...args); };
  let latest = null;
  let latestDeleted = null;
  let requestOrder = 0, latestOrder = 0, sendCaptureOrder = 0;
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The alternate shell can expose either the older wfr_* workflow id or a bare UUID.
  const REQUEST = /^(?:wfr_[a-zA-Z0-9_-]{1,96}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  const CONVERSATION_FIELD = /(?:^|[,{\s])\"conversation_id\"\s*:\s*\"([0-9a-f-]{36})\"/gi;
  // Passive evidence only: no polling, and no full response survives a scan. Retain a
  // small replay window for document_start -> content-script readiness and deduplicate
  // repeated provider observations across responses as well as inside one stream.
  const origins = new Map();
  const originReaders = new Set();
  const readers = new Set();
  const ORIGIN_LISTEN_MS = 15 * 60_000;
  let lastOriginDiagnostic = '';
  // One shape-only report per failure transition, through the existing browser console.
  // Never retain response bodies, URLs, request ids, app names or exception messages here.
  function reportOriginObservation(outcome, counts = {}) {
    const key = outcome + ':' + (counts.identities > 0 ? 'observed' : 'none');
    if (lastOriginDiagnostic === key) return;
    lastOriginDiagnostic = key;
    try {
      console.info('[Chat On Steroids] request-origin observation', {
        observerVersion: OBSERVER_VERSION, outcome, ...counts
      });
    } catch { /* A page console failure must never affect native fetch or recovery. */ }
  }
  function publishOrigin(conversationId, requestIds, observedAt, sightings = []) {
    if (!active) return;
    const fresh = requestIds.filter(id => !origins.has(`${conversationId}:${id}`));
    for (const requestId of fresh) {
      if (origins.size >= 64) origins.delete(origins.keys().next().value);
      origins.set(`${conversationId}:${requestId}`, { conversationId, requestId, observedAt });
    }
    if (fresh.length) post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
    const newSightings = [];
    for (const sighting of sightings.slice(0, 16)) {
      const origin = origins.get(`${conversationId}:${sighting.requestId}`);
      if (!origin) continue;
      // Reuse the bounded origin replay window, including across HTTP -> Pro socket handoff.
      // A later tool result can name the app after its request origin was already published.
      const key = JSON.stringify([sighting.appId, sighting.linkId, sighting.appName]);
      const keys = origin.appKeys || (origin.appKeys = new Set());
      if (keys.has(key)) continue;
      if (keys.size >= 16) keys.delete(keys.values().next().value);
      keys.add(key);
      origin.sighting = sighting;
      newSightings.push(sighting);
    }
    if (newSightings.length) post({ type: 'cos-app-sighting', conversationId, sightings: newSightings }, location.origin);
  }
  const project = (data, observedAt, order) => {
    if (!data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; post(latest, location.origin);
  };
  async function inspect(response, observedAt, order) {
    if (!active) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    readers.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {}); }
  }
  /**
   * Reads bounded complete SSE events from a clone without changing the page's response.
   * Only a conversation id and server request metadata from the same event are projected.
   */
  // Upstream #1305: first-turn tool rows can be absent from Fiber. Only a complete
  // api_tool.call_tool result's resource metadata teaches an app, never model/tool content.
  const APP_RESOURCE = /^\/(asdk_app_[A-Za-z0-9_-]{1,160})\/(link_[A-Za-z0-9_-]{1,160})\/[^/\s]{1,200}$/;
  function appSightingsOf(message) {
    const metadata = message?.metadata;
    if (message?.author?.role !== 'tool' || message.author.name !== 'api_tool.call_tool' ||
        !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    const requestId = metadata.request_id;
    const match = typeof metadata.invoked_resource?.resource_uri === 'string'
      ? APP_RESOURCE.exec(metadata.invoked_resource.resource_uri) : null;
    if (typeof requestId !== 'string' || !REQUEST.test(requestId) || !match) return [];
    const name = metadata.invoked_resource.app_name;
    const appName = typeof name === 'string' && name.length <= 200 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name) ? name : null;
    return [{ requestId, appId: match[1], linkId: match[2], appName }];
  }
  function readOrigin(frame, stream = {}) {
      // A response/linked socket turn cannot recover contradictory ownership by
      // borrowing the next headerless request id. A fresh stream gets fresh state.
      if (stream.identityConflict === true) return;
      if (!frame || frame.length > 512 * 1024) { stream.header = null; return; }
      const lines = frame.split(/\r?\n/);
      const type = lines.filter(line => line.startsWith('event:')).at(-1)?.slice(6).trim() || 'message';
      let event;
      try {
        event = JSON.parse(lines.filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n'));
      } catch {
        if (type === 'delta' || type === 'delta_encoding') stream.header = null;
        if (type === 'delta_encoding') stream.encoding = false;
        return;
      }
      if (type === 'delta_encoding') {
        stream.encoding = event === 'v1';
        stream.header = stream.encoding ? { c: 0, p: '', o: 'add' } : null;
        return;
      }
      let body;
      if (type === 'delta' && stream.encoding === false) return;
      if (type === 'delta' && !stream.header && event?.p === '' && event?.o === 'add') {
        // Some handoffs omit the prologue but provide a complete self-contained root event.
        body = event.v;
      } else if (type === 'delta') {
        // Native v1 omits repeated headers. Inherit only the bounded format header, never a
        // prior message value, and accept only a complete root add/replace as identity evidence.
        if (!stream.header || !event || typeof event !== 'object' || Array.isArray(event)) {
          stream.header = null;
          return;
        }
        const field = key => Object.prototype.hasOwnProperty.call(event, key) ? event[key] : stream.header[key];
        const c = field('c'), p = field('p'), o = field('o');
        if (!Number.isInteger(c) || c < 0 || c > 1023 || typeof p !== 'string' || p.length > 1024 ||
            !['add', 'replace', 'append', 'patch', 'remove', 'truncate'].includes(o)) {
          stream.header = null;
          return;
        }
        stream.header = { c, p, o };
        if (p !== '' || (o !== 'add' && o !== 'replace')) return;
        body = event.v;
      } else {
        body = event?.o === 'add' && (event.p === '' || event.p === undefined) &&
          event.v && typeof event.v === 'object' && !Array.isArray(event.v) ? event.v : event;
      }
      const conversations = new Set();
      CONVERSATION_FIELD.lastIndex = 0;
      for (let match; (match = CONVERSATION_FIELD.exec(frame));) {
        if (CONVERSATION.test(match[1])) conversations.add(match[1]);
      }
      // ChatGPT can split the join across consecutive events in one response: the stream
      // handoff names the conversation, then input_message names only the request. Retain the
      // conversation inside this one response/equivalent socket envelope. A contradictory
      // conversation still poisons the join instead of letting response order become authority.
      if (conversations.size > 1) {
        stream.identityConflict = true; stream.conversationId = null; stream.header = null;
        return;
      }
      if (conversations.size === 1) {
        const seen = conversations.values().next().value;
        // Validate the complete event root BEFORE retaining any cross-frame hint.
        // A nested/quoted conversation id is never a seed for a later request id.
        if (body?.conversation_id !== seen) return;
        if (stream.conversationId && stream.conversationId !== seen) {
          stream.identityConflict = true; stream.conversationId = null; stream.header = null;
          return;
        }
        stream.conversationId = seen;
      }
      const conversationId = conversations.size === 1
        ? conversations.values().next().value
        : stream.conversationId;
      if (!conversationId) return;
      // Only server metadata in a complete JSON event owns a request id. A key in
      // quoted model text, tool arguments or an unrelated nested object is not proof.
      const requestIds = new Set([
        body?.metadata?.request_id,
        body?.message?.metadata?.request_id,
        body?.input_message?.metadata?.request_id
      ]
        .filter(id => typeof id === 'string' && REQUEST.test(id)));
      const sightings = appSightingsOf(body?.message);
      return requestIds.size ? { conversationId, requestIds: [...requestIds], sightings } : null;
  }
  async function inspectRequestOrigins(response, observedAt) {
    if (!active) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:conversation|f\/conversation(?:\/resume)?)$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    // Clone only the passive observation branch. A failed newest clone must not
    // retire a working older observer or alter the native fetch response.
    let reader;
    try { reader = response.clone().body?.getReader(); }
    catch { reportOriginObservation('clone_unavailable'); return; }
    if (!reader) { reportOriginObservation('body_unavailable'); return; }
    // Upstream #1865: old background responses can remain open indefinitely.
    // Preserve the two-reader bound while making room for the live turn.
    if (originReaders.size >= 2) {
      const oldest = originReaders.values().next().value;
      originReaders.delete(oldest);
      readers.delete(oldest);
      void oldest.cancel().catch(() => {});
    }
    originReaders.add(reader);
    readers.add(reader);
    const startedAt = Date.now();
    let outcome = 'completed';
    const timer = setTimeout(() => {
      outcome = 'observation_deadline';
      // Revoke passive publication before cancel can race an already resolving read.
      originReaders.delete(reader); readers.delete(reader);
      void reader.cancel().catch(() => {});
    }, ORIGIN_LISTEN_MS);
    const decoder = new TextDecoder(), emitted = new Set(), stream = {};
    let bytes = 0, frames = 0, buffer = '';
    const scan = (frame) => {
      if (frame.trim()) frames = Math.min(65_535, frames + 1);
      const origin = readOrigin(frame, stream);
      if (!origin) return;
      const fresh = origin.requestIds.filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      for (const id of fresh) emitted.add(id);
      publishOrigin(origin.conversationId, fresh, observedAt,
        origin.sightings.filter(sighting => emitted.has(sighting.requestId)));
    };
    try {
      while (active && originReaders.has(reader)) {
        const { done, value } = await reader.read();
        // cancel() can race an already resolving read. Retired observations
        // must not publish a late identity after a newer reader takes the slot.
        if (!active || !originReaders.has(reader)) return;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) { outcome = 'byte_limit'; return; }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scan(buffer.slice(0, split));
          if (stream.identityConflict) { outcome = 'identity_conflict'; return; }
          if (emitted.size >= 16) { outcome = 'identity_limit'; return; }
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) { outcome = 'frame_limit'; return; }
      }
      buffer += decoder.decode();
      scan(buffer);
      if (stream.identityConflict) outcome = 'identity_conflict';
    } catch {
      // Preserve cancellation/deadline custody; arbitrary exception text is never logged.
      if (outcome === 'completed') outcome = 'read_failed';
    } finally {
      clearTimeout(timer);
      if (!active) outcome = 'observer_disposed';
      else if (!originReaders.has(reader) && outcome !== 'observation_deadline') outcome = 'reader_retired';
      if (outcome !== 'completed' || emitted.size === 0) {
        reportOriginObservation(outcome === 'completed' ? 'completed_without_origin' : outcome, {
          bytes: Math.min(bytes, 4 * 1024 * 1024 + 1), frames, identities: emitted.size,
          elapsedMs: Math.min(ORIGIN_LISTEN_MS, Math.max(0, Date.now() - startedAt))
        });
      } else lastOriginDiagnostic = '';
      originReaders.delete(reader); readers.delete(reader);
      void reader.cancel().catch(() => {});
    }
  }
  let observedFetch = null, downstreamFetchForRestore = null;
  let observedWebSocket = null, downstreamSocketForRestore = null;
  const observedSockets = new WeakSet();
  function inspectSocketMessage(event, streams) {
    if (!active) { streams.clear(); return; }
    // Pro hands its HTTP stream to the native conversation-turn-stream socket. Header-only
    // events matter because later complete v1 values can inherit their bounded format header.
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) { streams.clear(); return; }
    let rows;
    try { rows = JSON.parse(event.data); } catch { streams.clear(); return; }
    if (!Array.isArray(rows) || rows.length > 32) { streams.clear(); return; }
    for (const row of rows) {
      const payload = row?.payload?.payload;
      if (row?.type !== 'message' || row.payload?.type !== 'conversation-turn-stream' ||
          typeof payload?.conversation_id !== 'string' || !CONVERSATION.test(payload.conversation_id)) continue;
      const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
      const key = opaque(payload.turn_id) ? `${payload.conversation_id}\u0000${payload.turn_id}` : null;
      if (payload.type === 'done') { if (key) streams.delete(key); continue; }
      if (payload.type !== 'stream-item') continue;
      if (typeof payload.encoded_item !== 'string' || payload.encoded_item.length > 512 * 1024) {
        if (key) streams.delete(key);
        continue;
      }
      const frames = payload.encoded_item.split(/\r?\n\r?\n/);
      if (frames.length > 16) { if (key) streams.delete(key); continue; }
      let stream = {};
      if (key && opaque(payload.stream_item_id) &&
          (payload.parent_stream_item_id === null || opaque(payload.parent_stream_item_id))) {
        const now = Date.now();
        let retained = streams.get(key);
        if (!retained || now < retained.at || now - retained.at > ORIGIN_LISTEN_MS) {
          if (!streams.has(key) && streams.size >= 8) streams.delete(streams.keys().next().value);
          retained = { at: now, header: null, last: null, seen: new Set() };
          streams.set(key, retained);
        }
        if (retained.seen.has(payload.stream_item_id)) continue;
        if (payload.parent_stream_item_id !== retained.last) retained.header = null;
        retained.last = payload.stream_item_id;
        if (retained.seen.size >= 128) retained.seen.delete(retained.seen.values().next().value);
        retained.seen.add(payload.stream_item_id);
        stream = retained;
      } else if (key) streams.delete(key);
      // The outer native socket envelope is exact conversation authority for every complete
      // event it carries. Seed the per-item reader with it so the new split input_message event,
      // which names only its request id, can still form the same exact pair.
      stream.conversationId = payload.conversation_id;
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const origin = readOrigin(frame, stream);
        if (stream.identityConflict) { reportOriginObservation('identity_conflict'); break; }
        if (origin?.conversationId === payload.conversation_id)
          publishOrigin(origin.conversationId, origin.requestIds, Date.now(), origin.sightings);
      }
    }
  }
  function installSocketObserver() {
    if (!active || typeof window.WebSocket !== 'function' || window.WebSocket === observedWebSocket) return;
    const downstreamSocket = window.WebSocket;
    downstreamSocketForRestore = downstreamSocket;
    observedWebSocket = new Proxy(downstreamSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        try {
          const url = new URL(socket.url);
          if (url.protocol === 'wss:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
              active && !observedSockets.has(socket)) {
            observedSockets.add(socket);
            const streams = new Map();
            // A retired observer must not keep one closure per future socket message.
            // Detach our own listeners, never close or replace the native socket.
            const detach = () => {
              streams.clear();
              socket.removeEventListener('message', onMessage);
              socket.removeEventListener('close', detach);
            };
            const onMessage = event => {
              if (!active) { detach(); return; }
              inspectSocketMessage(event, streams);
            };
            socket.addEventListener('message', onMessage);
            socket.addEventListener('close', detach);
          }
        } catch { /* Foreign/unsupported transport remains untouched. */ }
        return socket;
      }
    });
    window.WebSocket = observedWebSocket;
  }
  /**
   * Exact metadata from ChatGPT's own native Send request.
   *
   * Only provider model/id metadata leaves MAIN. Prompt content stays in the page world. The
   * single user id is also the receipt for a first question React can redraw away entirely.
   */
  function projectSendBody(text, observedAt) {
    if (!active || typeof text !== 'string' || text.length > 2_000_000) return false;
    try {
      const body = JSON.parse(text);
      const model = typeof body?.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.model) ? body.model : null;
      const users = (Array.isArray(body?.messages) ? body.messages : []).slice(0, 8)
        .filter(message => message?.author?.role === 'user' && typeof message.id === 'string' && CONVERSATION.test(message.id));
      const messageIds = users.map(message => message.id);
      if (model && messageIds.length) post({ type: 'cos-send-model', model, messageIds, observedAt }, location.origin);
      if (messageIds.length === 1) post({ type: 'cos-send-request', messageIds, observedAt }, location.origin);
      return messageIds.length === 1;
    } catch { return false; }
  }
  function noteSendRequest(args, observedAt) {
    if (!active) return;
    try {
      const input = args[0], init = args[1];
      const method = String(init?.method === undefined ? input?.method || 'GET' : init.method).toUpperCase();
      if (method !== 'POST') return;
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.origin !== location.origin || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      const order = ++sendCaptureOrder;
      // A non-null override wins even when its type is unsupported. Never read an
      // inherited Request body that native fetch will not actually dispatch.
      if (init?.body != null) { projectSendBody(init.body, observedAt); return; }
      if (typeof Request !== 'function' || !(input instanceof Request) || readers.size >= 8) return;
      const signal = init?.signal === undefined ? input.signal : init.signal;
      if (signal?.aborted || input.bodyUsed || input.body?.locked) return;
      // Clone BEFORE forwarding fetch: its Request constructor can synchronously
      // consume the original. Observation must never await or replace native fetch.
      const reader = input.clone().body?.getReader();
      if (!reader) return;
      const path = location.pathname;
      let expired = false, outcome = 'unavailable';
      readers.add(reader);
      const timer = setTimeout(() => { expired = true; outcome = 'deadline'; void reader.cancel().catch(() => {}); }, 10_000);
      const current = () => {
        if (expired) return false;
        if (!active) { outcome = 'observer-retired'; return false; }
        if (order !== sendCaptureOrder) { outcome = 'superseded'; return false; }
        if (location.pathname !== path) { outcome = 'route-changed'; return false; }
        if (signal?.aborted) { outcome = 'aborted'; return false; }
        const elapsed = Date.now() - observedAt;
        if (elapsed < 0 || elapsed > 10_000) { outcome = 'capture-clock'; return false; }
        return true;
      };
      void (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0, text = '';
        try {
          while (current()) {
            const { done, value } = await reader.read();
            if (!current()) return;
            if (done) { outcome = projectSendBody(text + decoder.decode(), observedAt) ? 'observed' : 'unrecognized'; return; }
            bytes += value.byteLength;
            if (bytes > 2_000_000) { outcome = 'oversized'; return; }
            text += decoder.decode(value, { stream: true });
          }
        } catch { outcome = 'unreadable'; }
        finally {
          clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {});
          console.info('[Chat On Steroids] native Request Send observation', { observerVersion: OBSERVER_VERSION, outcome });
        }
      })();
      return { cancel() { expired = true; outcome = 'native-fetch-failed'; void reader.cancel().catch(() => {}); } };
    } catch { /* An unrecognized provider request proves nothing; native fetch still runs. */ }
  }
  // Adapted from upstream #1311 (Haz4rdovisk). A 404 is not deletion: inspect only the
  // exact history/send request's bounded JSON detail.code. Capture its document route
  // synchronously; content's existing navigation epoch remains the action authority.
  function deletionRequest(args) {
    try {
      const init = args[1], method = String(init?.method || args[0]?.method || 'GET').toUpperCase();
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url, location.origin);
      if (url.origin !== location.origin) return null;
      const history = method === 'GET' ? /^\/backend-api\/conversation\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1] : null;
      const sentTo = method === 'POST' && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname) &&
        typeof init?.body === 'string' && init.body.length <= 2_000_000 ? JSON.parse(init.body)?.conversation_id : null;
      const conversationId = history || sentTo;
      const route = /\/c\/([0-9a-f-]{36})(?:\/|$)/i.exec(location.pathname)?.[1];
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId) || route?.toLowerCase() !== conversationId.toLowerCase()) return null;
      const request = { id: crypto.randomUUID(), conversationId: conversationId.toLowerCase(), requestedAt: Date.now(), endpoint: url.pathname };
      window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin,
        data: { type: 'cos-deletion-request', id: request.id, conversationId: request.conversationId, requestedAt: request.requestedAt } }));
      return request;
    } catch { return null; }
  }
  async function inspectDeleted(response, request) {
    if (!active || !request || response.status !== 404) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || url.pathname !== request.endpoint || !response.headers.get('content-type')?.includes('application/json')) return;
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    readers.add(reader);
    let expired = false, bytes = 0, text = ''; const decoder = new TextDecoder();
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!active || expired) return;
        if (done) break;
        bytes += value.byteLength; if (bytes > 16 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      const detail = JSON.parse(text + decoder.decode())?.detail;
      if (detail?.code !== 'conversation_deleted' || (detail.conversation_id !== undefined &&
          (typeof detail.conversation_id !== 'string' || detail.conversation_id.toLowerCase() !== request.conversationId))) return;
      latestDeleted = { type: 'cos-conversation-deleted', id: request.id, conversationId: request.conversationId,
        requestedAt: request.requestedAt, observedAt: Date.now() };
      post(latestDeleted, location.origin);
    } catch { /* An incomplete, oversized or unfamiliar answer proves nothing. */ }
    finally { clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {}); }
  }

  const inspectedResponses = new WeakSet();
  function resumeRequest(args) {
    try {
      const init = args[1];
      const method = String(init?.method || args[0]?.method || 'GET').toUpperCase();
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url, location.origin);
      if (method !== 'POST' || url.origin !== location.origin || url.pathname !== '/backend-api/f/conversation/resume' ||
          typeof init?.body !== 'string' || init.body.length > 16 * 1024) return null;
      const conversationId = JSON.parse(init.body)?.conversation_id;
      if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId)) return null;
      const request = { id: crypto.randomUUID(), conversationId };
      // Capture recorder custody before fetch can yield or navigation can replace the page.
      window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin,
        data: { type: 'cos-resume-request', ...request } }));
      return request;
    } catch { return null; }
  }
  const installFetchObserver = () => {
    if (!active || window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = window.fetch;
    downstreamFetchForRestore = downstreamFetch;
    observedFetch = function (...args) {
      // A page wrapper may retain this older function after observer replacement.
      // Preserve native arguments, this, Promise identity and exceptions verbatim.
      if (!active) return downstreamFetch.apply(this, args);
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      const sendCapture = noteSendRequest(args, observedAt);
      const resume = active ? resumeRequest(args) : null;
      const deletion = active ? deletionRequest(args) : null;
      let result;
      try { result = downstreamFetch.apply(this, args); }
      catch (error) { sendCapture?.cancel(); throw error; }
      if (sendCapture) void result.catch(() => sendCapture.cancel());
      if (!active) return result;
      void result.then((response) => {
        if (!active) return;
        let status = null, streamOpened = false;
        try {
          const url = new URL(response.url);
          if (url.origin === location.origin && url.pathname === '/backend-api/f/conversation/resume') {
            status = response.status;
            streamOpened = status === 200 && response.headers.get('content-type')?.includes('text/event-stream');
          }
        } catch { /* Unknown response identity cannot report a failure. */ }
        if (resume) post({ type: 'cos-resume-response', ...resume,
          status: inspectedResponses.has(response) ? null : status,
          ...(streamOpened && !inspectedResponses.has(response) ? { streamOpened: true } : {}) }, location.origin);
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspectDeleted(response, deletion).catch(() => {});
        void inspect(response, observedAt, order).catch(() => {});
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string' ? args[0].method : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch { return; }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
      }).catch(() => {
        // Network rejection retires request custody but cannot prove that a stream is gone.
        if (resume) post({ type: 'cos-resume-response', ...resume, status: null }, location.origin);
      });
      return result;
    };
    // ChatGPT installs its own fetch instrumentation after document_start. Keep that owner in
    // the chain and reattach once at the page-ready boundary; otherwise our flag remains set
    // while the live response observer has silently been replaced.
    window.fetch = observedFetch;
  };
  installFetchObserver();
  installSocketObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
    window.addEventListener('DOMContentLoaded', installSocketObserver, { once: true });
  }
  const request = (event) => {
    if (!active || event.source !== window || event.origin !== location.origin || event.data?.type !== 'cos-usage-request') return;
    if (latest) post(latest, location.origin);
    if (latestDeleted) post({ ...latestDeleted, bootReplay: true }, location.origin);
    // Newest first: old evidence must not fill content's 16-ID pending capacity
    // before the current workflow can enter it during document startup.
    for (const { conversationId, requestId, observedAt, sighting } of [...origins.values()].slice(-16).reverse()) {
      post({ type: 'cos-request-origin', conversationId, requestIds: [requestId], observedAt }, location.origin);
      if (sighting) post({ type: 'cos-app-sighting', conversationId, sightings: [sighting] }, location.origin);
    }
  };
  const hide = () => {
    sendCaptureOrder++; // Page retirement invalidates pending asynchronous body evidence.
    // Revoke passive publication before cancellation can resolve an in-flight read.
    // The original native response remains untouched.
    for (const reader of originReaders) {
      originReaders.delete(reader); readers.delete(reader);
      void reader.cancel().catch(() => {});
    }
    origins.clear(); latestDeleted = null;
  };
  window.addEventListener('message', request);
  window.addEventListener('pagehide', hide);
  window.__cosUsageObserver = {
    version: OBSERVER_VERSION,
    refresh() { installFetchObserver(); installSocketObserver(); return active; },
    current: () => active && window.fetch === observedFetch && window.WebSocket === observedWebSocket,
    dispose() {
      if (!active) return;
      active = false;
      // Remove only a wrapper we STILL own. Never overwrite instrumentation the
      // page installed later, or unwrap its private closure by guessing.
      try {
        if (window.fetch === observedFetch && downstreamFetchForRestore)
          window.fetch = downstreamFetchForRestore;
      } catch { reportOriginObservation('fetch_restore_unavailable'); }
      try {
        if (window.WebSocket === observedWebSocket && downstreamSocketForRestore)
          window.WebSocket = downstreamSocketForRestore;
      } catch { reportOriginObservation('socket_restore_unavailable'); }
      observedFetch = null; observedWebSocket = null;
      downstreamFetchForRestore = null; downstreamSocketForRestore = null;
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear(); originReaders.clear(); origins.clear(); latest = null; latestDeleted = null;
      window.removeEventListener('message', request);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('DOMContentLoaded', installFetchObserver);
      window.removeEventListener('DOMContentLoaded', installSocketObserver);
    }
  };
  reportOriginObservation('observer_started', {
    fetchAttached: window.fetch === observedFetch, socketAttached: window.WebSocket === observedWebSocket
  });
})();
