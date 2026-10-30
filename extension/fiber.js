/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * A collapsed connector row shows the word "Called tool" and
 * nothing else, but the React Fiber behind it already knows exactly which tool ran, under
 * which connector, and how many further calls that single row is standing in for. That
 * last part is why this file has to exist at all — the page renders one row for a run of
 * calls, not always to the same tool, so the visible rows are not a list of the calls, and
 * no amount of DOM reading from the isolated world can recover the ones it folded away.
 * The same bounded bridge also reads account-evaluated model choices and the installed
 * connector's public tool declarations. Neither path exports account/session objects or
 * invokes React action callbacks; the named serverId$ signal is read only for durable
 * conversation identity. The isolated world owns UI actions and operation claims.
 *
 * Everything here is written on the assumption that it is the least trusted code in the
 * extension:
 *
 *  · **It runs where the page can reach it.** ChatGPT could replace `JSON.parse`,
 *    `postMessage`, `Array.prototype.map` — anything this file touches. Native references
 *    are captured at load, before the page has had a chance to react to us, and the file
 *    is kept short so there is little to subvert.
 *  · **It emits an allowlist, never a filtered copy.** Only the named fields below cross
 *    into the extension. Copying the props and deleting the sensitive parts would be a
 *    denylist, and one renamed field would be a leak — the request JSON has been observed
 *    carrying tool arguments verbatim.
 *  · **It emits no argument values at all, and never materializes them as objects.**
 *    Tool arguments can contain private text and secrets. A bounded lexical validator
 *    checks complete request syntax while decoding only a unique root tool path. Other
 *    values stay raw character spans; no payload object decoder or serializer is used.
 *    The established path-first prefix still handles truncated native requests.
 *  · **It fails closed.** An unrecognised Fiber shape yields `null` for that row, which
 *    leaves the row exactly as ChatGPT drew it. Guessing would put a wrong tool name on a
 *    real call, which is worse than the generic label it replaced.
 *
 * The receiving side treats everything here as page-controlled evidence regardless: the
 * page can post these same messages itself. See the trust note in content.js.
 */

(() => {
  'use strict';

  /** Bumped when the descriptor shape changes, so a stale pair cannot half-understand. */
  const VERSION = 15;
  // The MAIN world survives an extension reload because the ChatGPT document survives it.
  // Recovery may therefore execute this file again in a page that still has an older helper
  // listener. Keep at most one owned listener across protocol versions: rejecting an old
  // reply does not prevent that old listener from redundantly scanning the whole document.
  const ACTIVE_HELPER = '__clfFiberHelper';
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** Only a successfully described connector row carries this scan reference. */
  const CONNECTOR = '[data-clf-fiber]';
  /**
   * A runaway guard on the climb, not a claim about how the page is shaped.
   *
   * This was 30, taken from an observed depth, and the live page put the group node at
   * exactly 30 — one past `up < MAX_CLIMB`. Every row of every chat then produced no
   * descriptor at all, silently, because failing closed is indistinguishable from a
   * browser where this helper never ran. What stops the climb now is `groupOf`'s own test
   * for the shape it wants; this number only keeps a detached or cyclic tree from looping.
   */
  const MAX_CLIMB = 80;
  // ChatGPT's committed React root can sit beyond the former 400-level limit (#969).
  // Keep both root/query walks bounded while accepting the current deeper native tree.
  const MAX_ROOT_DEPTH = 2048;
  const MAX_TEXT = 200;
  /** A page with more connector rows than this is not one we need to read exhaustively. */
  const MAX_ROWS = 400;
  /** Assistant turns whose message model is read for per-call evidence, newest first. */
  const MAX_TURNS = 6;
  // Shape-only diagnostics for a refused native parent recovery. At most six distinct
  // bounded frames per minute; no ids, tool names, arguments, result text or witness values.
  let nativeReferenceTraceAt = -Infinity;
  const nativeReferenceTraceKeys = new Set();
  /** Connector requests reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  // Native ancestry includes invocation AND result nodes for both MCP and Code Mode,
  // in addition to public items. The layout/item bound is not a native branch-depth bound.
  const MAX_NATIVE_PATH_NODES = MAX_ROWS + 4 * MAX_CALLS;
  /** Alternate app-shell exchanges carry both roles in one native turn container. */
  const SHELL_TURN = '[data-app-shell-main-surface] [data-thread-find-target="conversation"] [data-turn-key]';
  /** ChatGPT's current classic and alternate turn owners. */
  const TURN_SECTION = `section[data-testid^="conversation-turn"], ${SHELL_TURN}`;
  /** ChatGPT-rendered authored prose. Tool rows and this extension's own surfaces are excluded. */
  const MARKDOWN = '.markdown, [data-content-search-unit-key$=":assistant"] [data-markdown-text-style="assistant-message"]';
  const TOOL = 'span[class*="tool-message"], div.pointer-events-none.contents, div:has(> [data-testid="cot-v5-tool-icon-pile"])';
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';
  const MAX_RENDERED_HTML = 120_000;
  // A 15k–20k-token compaction answer is routinely 60k–90k characters. Capping public
  // assistant prose at 32k here made the canonical session transcript lose the back half
  // even though Compact & Resume itself carried the full DOM answer. One event still stays
  // comfortably below the 512 KiB bridge body cap alongside its bounded rendered HTML.
  // Safety guard only. Compact & Resume is specified in tokens (up to 30k), so this must be
  // comfortably larger than a normal handoff rather than acting as a second token budget.
  const MAX_RENDERED_TEXT = 256_000;
  /** Aggregate authored text/HTML copied through MAIN -> isolated world in one scan. */
  const MAX_RESPONSE_TEXT = MAX_TURNS * 512 * 1024;
  const MAX_TURN_TEXT = 512 * 1024;

  function budgetedText(value, budget, perValueLimit) {
    if (typeof value !== 'string' || !value || !budget || budget.remaining <= 0) return '';
    const limit = Math.max(0, Math.min(perValueLimit, budget.remaining));
    if (limit === 0) return '';
    const taken = value.slice(0, limit);
    budget.remaining -= taken.length;
    return taken;
  }
  /**
   * The connectors this app is reached through. Nothing else is ours to vouch for.
   *
   * There is more than one now: 1.7.1 split the model-facing surface into a Core and a
   * Desktop connector, so a single hardcoded name stopped matching *anything* the page
   * held — every call in every chat lost its page evidence at once and was filed outside
   * the conversation that made it. The name is not user input: ChatGPT takes `app_name`
   * from the `resource_name` this app serves in its own protected-resource metadata
   * (`server.ts`), so these are this app naming itself rather than labels somebody typed.
   * The pre-1.7.1 name stays so an older chat's evidence still reads.
   *
   * Exact names, never a prefix: `Chat On Steroids Backup` would be somebody else's
   * connector, and a prefix test would have this app vouch for its traffic.
   */
  const OUR_APPS = [
    'Luna Forge X7 Core', 'Luna Forge X7 Desktop', 'Luna Forge X7 Plugins',
    'Chat On Steroids Core', 'Chat On Steroids Desktop', 'Chat On Steroids Plugins', 'TobisComputer'
  ];

  // Proven IDs supplied by this paired account keep ownership stable across renames.
  const APP_ID = /^asdk_app_[A-Za-z0-9_-]{1,160}$/, LINK_ID = /^link_[A-Za-z0-9_-]{1,160}$/;
  const SURFACES = ['core', 'desktop', 'plugins'];
  let configuredApps = [], provenApps = [];
  function adoptAppIdentity(names, ids) {
    if (names && typeof names === 'object') configuredApps = SURFACES.map(surface =>
      typeof names[surface] === 'string' && names[surface].length <= 100 ? names[surface] : null);
    if (!Array.isArray(ids)) return;
    provenApps = ids.slice(0, 12).filter(app => app && typeof app.appId === 'string' && APP_ID.test(app.appId) && SURFACES.includes(app.surface))
      .map(app => ({ surface: app.surface, appId: app.appId,
        linkId: typeof app.linkId === 'string' && LINK_ID.test(app.linkId) ? app.linkId : null,
        name: typeof app.name === 'string' && app.name.length <= 64 ? app.name : null }));
  }
  function appIdOf(path) {
    if (typeof path !== 'string' || path[0] !== '/') return null;
    const id = path.split('/')[1];
    return APP_ID.test(id) ? id : null;
  }
  function linkIdOf(path) {
    if (typeof path !== 'string' || path[0] !== '/') return null;
    const parts = path.split('/');
    return parts.length >= 4 && LINK_ID.test(parts[2]) ? parts[2] : null;
  }
  function surfaceOfName(name) {
    const same = value => value && (name === value || name === value.replaceAll(' ', '_'));
    const configured = configuredApps.findIndex(same);
    if (configured >= 0) return SURFACES[configured];
    const learned = provenApps.find(app => same(app.name));
    if (learned) return learned.surface;
    const legacy = OUR_APPS.findIndex(same);
    return legacy < 0 ? null : SURFACES[legacy === 6 ? 0 : legacy % 3];
  }
  function ownByName(name, appId, linkId) {
    if (typeof name !== 'string') return false;
    const surface = surfaceOfName(name);
    if (!surface) return false;
    const known = provenApps.filter(app => app.surface === surface);
    if (!known.length) return true;
    if (appId) return known.some(app => app.appId === appId);
    if (linkId) return known.some(app => app.linkId === linkId);
    return true;
  }
  function ourApp(name) { return ownByName(name, null, null); }
  function ownResult(result) {
    if (!result) return false;
    const id = appIdOf(result.resource);
    return (id && provenApps.some(app => app.appId === id)) ||
      ownByName(result.app, id, linkIdOf(result.resource));
  }
  /** Core/Desktop/Plugins can each name a tool with the same final segment.
   * Require their recognized native connector surfaces to agree, in addition
   * to the exact link and tool. For legacy aliases without a recognized
   * surface, do not replace the existing stronger link proof with a guess. */
  function sameResultSurface(path, result) {
    if (typeof path !== 'string' || !result) return false;
    const cut = path.indexOf('/', 1);
    const asked = cut > 1 ? surfaceOfName(path.slice(1, cut)) : null;
    const returned = surfaceOfName(result.app);
    return !asked || !returned || asked === returned;
  }
  function ourPath(path) {
    if (typeof path !== 'string' || path[0] !== '/') return false;
    const id = appIdOf(path), link = linkIdOf(path);
    if (id && provenApps.some(app => app.appId === id)) return true;
    if (link && provenApps.some(app => app.linkId === link)) return true;
    const end = path.indexOf('/', 1);
    return end > 1 && ownByName(path.slice(1, end), id, link);
  }
  function ownServerName(name) {
    const names = [...OUR_APPS, ...configuredApps.filter(Boolean), ...provenApps.map(app => app.name).filter(Boolean)];
    return names.find(app => name === app || name === app.replaceAll(' ', '_')) || null;
  }
  /** Opaque app namespaces need the paired app/link proof, not a display-name comparison.
   * This joins request identity only; it never marks a tool result completed. */
  function nativeRequestServerMatches(path, server) {
    if (!path || !server) return false;
    const id = appIdOf(path);
    if (!id) return ownServerName(path.slice(1, path.indexOf('/', 1))) === server;
    const matches = provenApps.filter(app => app.appId === id);
    const link = linkIdOf(path);
    return matches.length === 1 && !!link && matches[0].linkId === link &&
      matches[0].surface === surfaceOfName(server);
  }
  function pluginsConnectorApp(name, appId) {
    return surfaceOfName(name) === 'plugins' || provenApps.some(app => app.surface === 'plugins' && app.appId === appId);
  }
  /**
   * The tool path at the very front of a request payload.
   *
   * Anchored, and it stops at the first quote, so it can only ever see the path — never a
   * key or value from `args`, including the `path` argument a file tool takes, which is a
   * second `"path"` later in the same string.
   */
  const PATH_HEAD = /^\s*\{\s*"path"\s*:\s*"([^"\\]{1,200})"/;
  const MAX_REQUEST_JSON_CHARS = 16 * 1024;
  const MAX_REQUEST_JSON_DEPTH = 32;

  /**
   * Validate JSON syntax without materializing its values. Only compare
   * root keys with "path" and decode that unique string (at most 200 characters).
   * All other strings, numbers, arrays and objects are skipped as raw syntax.
   * A path-first prefix may also end inside a valid skipped string or after a
   * nested value: EOF is distinct from a malformed token or ambiguous root key.
   */
  function validatedRequestPath(text, allowTruncated) {
    let at = 0, paths = 0, path = '', keyIsPath = false, incomplete = false;
    const space = () => {
      while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r')) at++;
    };
    const digit = () => text.charCodeAt(at) >= 48 && text.charCodeAt(at) <= 57;
    const hex = code => code >= 48 && code <= 57 ? code - 48
      : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
    const string = mode => {
      if (text[at++] !== '"') return false;
      let length = 0, matches = true;
      while (at < text.length) {
        let code = text.charCodeAt(at++);
        if (code === 34) {
          if (mode === 'key') keyIsPath = matches && length === 4;
          return true;
        }
        if (code < 32) return false;
        if (code === 92) {
          const escape = text.charCodeAt(at++);
          if (escape === 117) {
            code = 0;
            for (let n = 0; n < 4; n++) {
              const value = hex(text.charCodeAt(at++));
              if (value < 0) return false;
              if (mode !== 'skip') code = code * 16 + value;
            }
          } else if (escape === 34 || escape === 92 || escape === 47) code = escape;
          else if (escape === 98) code = 8;
          else if (escape === 102) code = 12;
          else if (escape === 110) code = 10;
          else if (escape === 114) code = 13;
          else if (escape === 116) code = 9;
          else return false;
        }
        if (mode === 'key') matches = matches && length < 4 && code === 'path'.charCodeAt(length);
        else if (mode === 'path') {
          if (length >= 200 || code < 32 || code === 127) return false;
          path += String.fromCharCode(code);
        }
        length++;
      }
      if (mode === 'skip') incomplete = true;
      return false;
    };
    const number = () => {
      if (text[at] === '-') at++;
      if (text[at] === '0') at++;
      else {
        if (!digit() || text[at] === '0') return false;
        while (digit()) at++;
      }
      if (text[at] === '.') {
        at++;
        if (!digit()) return false;
        while (digit()) at++;
      }
      if (text[at] === 'e' || text[at] === 'E') {
        at++;
        if (text[at] === '+' || text[at] === '-') at++;
        if (!digit()) return false;
        while (digit()) at++;
      }
      return true;
    };
    const value = depth => {
      if (depth > MAX_REQUEST_JSON_DEPTH) return false;
      space();
      if (text[at] === '"') return string('skip');
      if (text[at] === '{') return object(depth, false);
      if (text[at] === '[') {
        at++; space();
        if (text[at] === ']') { at++; return true; }
        while (value(depth + 1)) {
          space();
          if (at === text.length) { incomplete = true; return false; }
          if (text[at] === ']') { at++; return true; }
          if (text[at++] !== ',') return false;
        }
        return false;
      }
      for (const literal of ['true', 'false', 'null']) {
        if (text.startsWith(literal, at)) { at += literal.length; return true; }
      }
      return number();
    };
    const object = (depth, root) => {
      if (depth > MAX_REQUEST_JSON_DEPTH || text[at++] !== '{') return false;
      space();
      if (text[at] === '}') { at++; return true; }
      while (at < text.length) {
        space();
        if (!string(root ? 'key' : 'skip')) return false;
        const selected = root && keyIsPath;
        space();
        if (text[at++] !== ':') return false;
        space();
        if (selected) {
          if (++paths !== 1 || !string('path')) return false;
        } else if (!value(depth + 1)) return false;
        space();
        if (at === text.length) { incomplete = true; return false; }
        if (text[at] === '}') { at++; return true; }
        if (text[at++] !== ',') return false;
      }
      return false;
    };
    space();
    if (!object(0, true)) return allowTruncated && incomplete && paths === 1 && path.length > 0 ? path : null;
    space();
    return at === text.length && paths === 1 && path.length > 0 ? path : null;
  }

  /** Keep the established truncated path-first prefix. Other property orders require
   * complete bounded syntax; a nested path or a path inside a string never qualifies. */
  function requestPath(text) {
    if (typeof text !== 'string' || !text) return null;
    const head = PATH_HEAD.exec(text.slice(0, 512));
    if (text.length > MAX_REQUEST_JSON_CHARS) return head ? str(head[1]) : null;
    let end = text.length;
    while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t' || text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
    if (text[end - 1] !== '}') return head ? str(head[1]) : null;
    return validatedRequestPath(text, !!head);
  }
  /** A tool name we are willing to put on a row. */
  const NAME = /^[a-z0-9_.-]{1,64}$/i;

  // Captured before the page can swap them. If the page has already replaced one of these
  // at load time there is nothing to be done about it, but it cannot do so afterwards.
  const post = window.postMessage.bind(window);
  const own = Object.prototype.hasOwnProperty;

  /** A short, plain string or null. Never a number, object, or anything with a toString. */
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function int(value) {
    const raw = num(value);
    return raw === null ? 0 : Math.max(0, Math.min(999, Math.round(raw)));
  }

  /**
   * The React Fiber node for a DOM element.
   *
   * React hangs it off a property whose name carries a per-build random suffix, so the
   * key has to be discovered rather than named.
   */
  // One synchronous helper request owns these views. Never retain a React branch between
  // scans: alternate-shell mounts are aggressively reused and the DOM pointer may name the
  // previous side of a double-buffered tree after navigation.
  let currentPaths = null;
  function committedPath(fiber) {
    const path = [], seen = new Set();
    let at = fiber, base = null, paired = false;
    const view = (node, parent) => ({
      memoizedProps: node.memoizedProps,
      memoizedState: node.memoizedState,
      updateQueue: node.updateQueue,
      return: parent
    });
    const remember = (node, value) => {
      currentPaths?.set(node, value);
      if (node.alternate) currentPaths?.set(node.alternate, value);
    };
    while (at && path.length < MAX_ROOT_DEPTH) {
      if (seen.has(at)) return null;
      seen.add(at);
      const cached = currentPaths?.get(at);
      if (cached && cached.root.current === cached.current) { base = cached; break; }
      paired ||= !!at.alternate;
      if (at.tag === 3) {
        const root = at.stateNode, current = root?.current;
        if (!current || (current !== at && current !== at.alternate)) return null;
        base = { root, current, node: current, view: view(current, null) };
        remember(at, base);
        break;
      }
      path.push(at);
      at = at.return;
    }
    // Existing synthetic/legacy facades have no alternate/root bookkeeping. Preserve that
    // path exactly; only a real paired/numeric React branch must prove its committed root.
    if (!base) return !paired && !at && path.every(node => typeof node.tag !== 'number') ? fiber : null;
    let budget = 4096;
    for (let index = path.length - 1; index >= 0; index--) {
      const wanted = path[index];
      let selected = null;
      for (let child = base.node.child; child; child = child.sibling) {
        if (--budget < 0) return null;
        if (child !== wanted && child !== wanted.alternate) continue;
        if (selected) return null;
        selected = child;
      }
      if (!selected || base.root.current !== base.current) return null;
      base = { root: base.root, current: base.current, node: selected, view: view(selected, base.view) };
      remember(wanted, base);
    }
    return base.view;
  }

  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return committedPath(node[key]);
    }
    return null;
  }

  /**
   * The props of the node that renders exactly this row's group of messages.
   *
   * Two shapes are reachable by climbing from a row, and only one of them may be used.
   * The near one — observed live at depth 30 — carries `messages`, where `messages[0]` is
   * this row's own request and everything after it is other rows' business. The far one,
   * around depth 43, carries `allMessages`/`turn` for the *whole* turn; reading a row's
   * identity out of that means picking one of a turn's many requests by position, which is
   * how a row ends up labelled with a neighbour's tool. So the turn-level node is not a
   * fallback, it is a stop: reaching it means this row's group was not found, and a row
   * with no group keeps the label ChatGPT gave it.
   */
  function groupOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (Array.isArray(props.allMessages) || (props.turn && typeof props.turn === 'object')) return null;
      if (Array.isArray(props.messages) && props.messages.length > 0) return props;
    }
    return null;
  }
  /**
   * The complete message list for this logical turn, read separately from the row group.
   *
   * Row identity must never come from this list because it contains many requests. For
   * attribution cardinality, though, that is exactly the useful property: it lets us count
   * how many requests in the turn actually target TobisComputer instead of treating
   * ChatGPT's folded-row count as if api_tool metadata calls were local MCP calls.
   */
  function turnMessagesOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.messages)) return turn.messages;
      if (Array.isArray(props.allMessages)) return props.allMessages;
    }
    return null;
  }

  /**
   * ChatGPT's internal conversation identity attached to this Fiber branch.
   *
   * Absence and contradiction are deliberately different states. During navigation React can
   * leave props from chat A and chat B mounted on one branch for a tick. Returning plain null
   * for that shape used to make content.js treat the branch exactly like one that simply had
   * no conversation metadata, which let stale assistant messages from another chat be recorded
   * under the current URL. Preserve the conflict bit so the isolated world can fail closed.
   */
  function conversationEvidenceOf(fiber) {
    let found = null;
    const conversations = new Map();
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn && typeof props.turn === 'object' ? props.turn : null;
      // The mounted conversation.id can be a local WEB identity, not the /c id.
      // Its serverId$ signal is the read-only durable identity used by that same
      // conversation object. Read it once per object; never equate the local id
      // with the page route or infer ownership from the URL itself.
      const conversation = props.conversation && typeof props.conversation === 'object' ? props.conversation : null;
      if (conversation && !conversations.has(conversation)) {
        let serverId = null;
        try {
          const value = typeof conversation.serverId$ === 'function' ? conversation.serverId$() : null;
          if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) serverId = value;
        } catch { /* Unresolved signal carries no durable identity. */ }
        conversations.set(conversation, serverId);
      }
      const values = [props.clientThreadId, props.conversationId, conversation && conversation.id,
        conversations.get(conversation), turn && turn.clientThreadId, turn && turn.conversationId];
      for (let index = 0; index < values.length; index++) {
        const value = str(values[index]);
        // These are provider-local route/bootstrap identities, not server conversation ids.
        // The alternate shell can retain one beside the real UUID after /c/<id> has committed;
        // treating that pair as contradictory drops the exact request-id metadata for the whole
        // turn and makes every otherwise healthy Core call look unattributed. shellConversation()
        // already owns the exact local -> server join through the query cache, so local ids carry
        // no independent ownership weight here.
        if (!value || value.startsWith('WEB:') || value.startsWith('local-chatgpt:')) continue;
        if (found && found !== value) return { conversationId: null, conflict: true };
        found = value;
      }
    }
    return { conversationId: found, conflict: false };
  }

  /** An authored assistant message object, when a rendered prose node exposes one directly. */
  function messageOf(fiber) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const candidate = props.message;
      if (!candidate || typeof candidate !== 'object') continue;
      const author = candidate.author;
      const id = str(candidate.id);
      if (!id || !author || author.role !== 'assistant') continue;
      if (requestOf(candidate) || resultOf(candidate)) continue;
      if (found && found !== id) return null;
      found = id;
    }
    return found;
  }

  /**
   * ChatGPT's own name for what a public assistant message is *for*.
   *
   * The page model routes assistant prose down three named channels, and they are not
   * interchangeable. `final` is the answer. `commentary` is the running narration a
   * tool-using turn shows between calls. `analysis` is the model's private scratch, which
   * this extension never records and never shows.
   *
   * Read as a plain string, absent included: page data old enough to carry no channel at all
   * keeps behaving exactly as it did before this field was known, rather than being
   * reclassified by a default.
   */
  function channelOf(message) {
    return message && typeof message === 'object' ? str(message.channel) : '';
  }

  /**
   * Whether this message is ChatGPT's private reasoning scratch rather than something it
   * said. Recording it would put chain-of-thought in the transcript; letting it stand as the
   * turn's newest public prose is worse, and is measured below.
   */
  function analysisMessage(message) {
    return channelOf(message) === 'analysis';
  }

  /**
   * Whether this message is, by ChatGPT's own routing, incapable of being the answer.
   *
   * Live 2026-08-31, on a finished tool-heavy turn with the Stop control already gone, the
   * page model held: the answer on `channel:'final'` with `end_turn:true` and
   * `status:'finished_successfully'`, and *after* it an empty message on `channel:'analysis'`
   * left at `status:'in_progress'` forever. A trailing `commentary` message left at
   * `end_turn:false` behaves the same way. Neither is a turn that is still running and
   * neither can ever become the answer — so neither may stand in front of the message that
   * is one.
   */
  function neverTerminalChannel(message) {
    const channel = channelOf(message);
    return channel === 'analysis' || channel === 'commentary';
  }

  function hiddenMessage(message) {
    const meta = message && typeof message === 'object' ? message.metadata : null;
    return Boolean(
      meta &&
      typeof meta === 'object' &&
      (meta.is_visually_hidden_from_conversation === true || meta.is_visually_hidden === true)
    );
  }

  /** Whether one page-model message is ChatGPT's own reasoning/thought object. */
  function thoughtMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const author = message.author;
    const content = message.content;
    return Boolean(
      author &&
      author.role === 'assistant' &&
      content &&
      typeof content === 'object' &&
      content.content_type === 'thoughts' &&
      str(message.id)
    );
  }

  /**
   * ChatGPT's row-local identity for a rendered thought item.
   *
   * The live renderer exposes `memoizedProps.item = { type: 'thought', key:
   * 'thought-<message UUID>-<item index>', ... }` only a few Fibers above the visible row.
   * The UUID portion must resolve to an actual thought message in this turn; the full key is
   * retained because the suffix is page identity too and can distinguish two items owned by
   * one thought if ChatGPT ever emits them.
   */
  function thoughtItemOf(fiber, thoughtIds) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const item = props.item;
      if (!item || typeof item !== 'object' || item.type !== 'thought') continue;
      const key = str(item.key);
      if (!key) continue;
      const suffixAt = key.lastIndexOf('-');
      const suffix = suffixAt >= 0 ? key.slice(suffixAt + 1) : '';
      const owner = key.startsWith('thought-') && /^\d{1,6}$/.test(suffix) ? key.slice(8, suffixAt) : null;
      if (owner && !thoughtIds.has(owner)) continue;
      if (!owner) continue;
      if (found && found.messageId !== key) return null;
      found = { messageId: key, thoughtMessageId: owner };
    }
    return found;
  }

  /**
   * The public authored text carried by one ChatGPT assistant message, or null.
   *
   * Live turns contain many assistant-authored *internal* messages as well: connector
   * requests are `code`, and reasoning/tool-summary state is `thoughts`. The latter is the
   * shape that broke canonical prose capture in 1.8.1: a turn with 3 real text messages also
   * held 23 `thoughts` records, so the old positional fallback saw 26 candidate ids for 18
   * rendered Markdown nodes and (correctly) refused to guess. `content_type: text` is the
   * page model's explicit boundary for authored prose; `parts` then carries the raw Markdown
   * exactly as ChatGPT authored it.
   *
   * Do not fall back to arbitrary object/string fields. This helper runs in the page world
   * and its allowlist is a privacy boundary: only the public text payload crosses worlds.
   */
  function authoredText(message) {
    const content = message && typeof message === 'object' ? message.content : null;
    if (!content || typeof content !== 'object' || content.content_type !== 'text') return null;
    if (Array.isArray(content.parts)) {
      let value = '';
      for (let at = 0; at < content.parts.length; at++) {
        const part = content.parts[at];
        if (typeof part !== 'string') continue;
        if (value) value += '\n';
        value += part;
        if (value.length >= MAX_RENDERED_TEXT) break;
      }
      value = value.slice(0, MAX_RENDERED_TEXT);
      return value.length > 0 ? value : null;
    }
    return typeof content.text === 'string' && content.text.length > 0
      ? content.text.slice(0, MAX_RENDERED_TEXT)
      : null;
  }

  /**
   * Resolve ChatGPT's public content-reference wrapper to the exact authored source.
   *
   * Live helper turns started returning a finished public message whose entire text is:
   *
   *   ::chatgpt-content-reference{index="0" source_message_id="..."}
   *
   * The referenced text is still present in the same page-model turn, but is marked
   * visually hidden because the wrapper is what ChatGPT intends the conversation to show.
   * The DOM can therefore be blank even though the answer exists.  This is an explicit
   * provider-authored relationship, not a positional/text guess, so it is safe to follow
   * only when every boundary below agrees:
   *
   * - one whole-message directive names one exact source id;
   * - source and wrapper are assistant text records in this same turn snapshot;
   * - the source is neither tool traffic nor private analysis/commentary;
   * - branch metadata does not contradict the public wrapper;
   * - the source is complete, bounded, non-empty, and not another reference.
   *
   * The public wrapper keeps its own identity and terminal status. Only the authored text
   * is substituted, which keeps completion attribution exact while preventing an internal
   * transport token from reaching the desktop decision parser.
   */
  function contentReferenceSourceId(message) {
    const wrapperText = authoredText(message);
    if (!wrapperText) return null;
    const directive = wrapperText.trim().match(
      /^::chatgpt-content-reference\{([^{}\r\n]{1,1024})\}$/
    );
    if (!directive) return null;
    const sourceMatch = directive[1].match(
      /(?:^|\s)source_message_id="([A-Za-z0-9:_-]{1,200})"(?:\s|$)/
    );
    return sourceMatch ? sourceMatch[1] : null;
  }

  function referencedPublicText(message, messagesById) {
    const sourceId = contentReferenceSourceId(message);
    if (!sourceId || !(messagesById instanceof Map)) return null;
    const source = messagesById.get(sourceId);
    if (!source || source === message || typeof source !== 'object') return null;
    const author = source.author;
    if (!author || author.role !== 'assistant') return null;
    if (requestOf(source) || resultOf(source) || thoughtMessage(source)) return null;
    if (neverTerminalChannel(source)) return null;
    if (source.status && source.status !== 'finished_successfully') return null;
    const wrapperMeta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const sourceMeta = source.metadata && typeof source.metadata === 'object' ? source.metadata : null;
    if (
      turnIdentityContradicts(
        wrapperMeta ? str(wrapperMeta.working_turn_id) : null,
        sourceMeta ? str(sourceMeta.working_turn_id) : null
      ) ||
      turnIdentityContradicts(
        wrapperMeta ? str(wrapperMeta.turn_exchange_id) : null,
        sourceMeta ? str(sourceMeta.turn_exchange_id) : null
      )
    ) return null;
    const sourceText = authoredText(source);
    if (!sourceText || sourceText.trim().match(/^::chatgpt-content-reference\{/)) return null;
    return sourceText;
  }

  /** ChatGPT's own message creation time, normalized to epoch milliseconds when present. */
  function authoredTime(message) {
    const raw = message && typeof message === 'object' ? Number(message.create_time) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // The live model uses epoch seconds (often fractional). Accept milliseconds too so a
    // renderer change cannot move a valid timestamp ~54,000 years into the past.
    return Math.round(raw < 10_000_000_000 ? raw * 1000 : raw);
  }

  /** Whether two optional page turn identities contradict one another. */
  function turnIdentityContradicts(left, right) {
    return Boolean(left && right && left !== right);
  }

  /**
   * Stable public-assistant identity before the owning thought object necessarily mounts.
   *
   * ChatGPT can rotate the child text-message UUID while one commentary item streams, so the
   * raw message id is not identity. Three pieces of ChatGPT's own server-authored metadata
   * are: `working_turn_id` and `turn_exchange_id` name the branch, and `create_time` names
   * the message inside it. That tuple is the same before and after a reload, which the
   * previous `parent_id` tuple was not: rehydrating a conversation from the server re-parents
   * the text message, so every already-recorded message came back under a second key and the
   * transcript showed each one twice.
   *
   * No text, DOM position, or local observation time takes part. `create_time` here is
   * ChatGPT's own creation stamp for that exact message, read from the page model.
   *
   * `parent_id` remains the fallback identity for page data old enough to carry no
   * `create_time`. A bare parent_id is deliberately insufficient even then: Retry/Regenerate
   * branches can share a parent. With no turn/exchange discriminator at all there is no exact
   * identity to use, and the raw message id stands until one exists.
   */
  function assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime) {
    if ((workingTurnId || turnExchangeId) && createTime) {
      const stable = `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}`;
      if (stable.length <= 190) return stable;
    }
    if (!parentId || (!workingTurnId && !turnExchangeId)) return id;
    const value = `assistant:${parentId}:${workingTurnId || ''}:${turnExchangeId || ''}`;
    return value.length <= 190 ? value : id;
  }

  /** Public assistant messages in ChatGPT's own turn model, in model order. */
  function authoredAssistantMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    const logicalIds = new Set();
    const thoughtParents = new Map();
    const messagesById = new Map();
    if (!Array.isArray(messages)) return out;
    for (const candidate of messages) {
      if (thoughtMessage(candidate)) thoughtParents.set(str(candidate.id), candidate);
      const candidateId = candidate && typeof candidate === 'object' ? str(candidate.id) : null;
      if (candidateId && !messagesById.has(candidateId)) messagesById.set(candidateId, candidate);
    }
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      if (requestOf(message) || resultOf(message) || hiddenMessage(message)) continue;
      // Private reasoning, by ChatGPT's own routing. Never a transcript row.
      if (analysisMessage(message)) continue;
      const id = str(message.id);
      const authored = authoredText(message);
      const rawText = budgetedText(
        referencedPublicText(message, messagesById) || authored,
        budget,
        MAX_RENDERED_TEXT
      );
      if (!id || !rawText) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const parentId = meta ? str(meta.parent_id) : null;
      const workingTurnId = meta ? str(meta.working_turn_id) : null;
      const turnExchangeId = meta ? str(meta.turn_exchange_id) : null;
      const createTime = authoredTime(message);
      const authoredId = assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime);
      // Two messages of one branch sharing a creation millisecond would collide on that
      // identity. Keep the first and hand the later one the parent tuple instead, so a
      // collision costs a weaker key rather than a swallowed message.
      const collides = logicalIds.has(authoredId);
      let logicalId = collides ? assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, null) : authoredId;
      // The reload-durable identity needs no thought parent to be trustworthy.
      let stable = !collides && Boolean(createTime) && logicalId !== id && logicalId !== parentId;

      // Live streaming can replace the raw text-message UUID while the same commentary block
      // keeps growing. The page already supplies a stronger relation: public commentary is a
      // child of the thought object that owns that reasoning step. Use that thought id only
      // when the parent is actually present in this same turn model and its own turn metadata
      // does not contradict the child. No text, order, timing or DOM position participates.
      if (parentId) {
          const parent = thoughtParents.get(parentId);
          if (parent) {
          const parentMeta = parent.metadata && typeof parent.metadata === 'object' ? parent.metadata : null;
          const parentWorking = parentMeta ? str(parentMeta.working_turn_id) : null;
          const parentExchange = parentMeta ? str(parentMeta.turn_exchange_id) : null;
          if (!turnIdentityContradicts(workingTurnId, parentWorking) && !turnIdentityContradicts(turnExchangeId, parentExchange)) {
          // Keep the same exact tuple chosen above. If older page data has a thought parent
          // but no working/exchange metadata, parent_id itself is the stronger identity.
          if (logicalId === id) logicalId = parentId;
          stable = true;
          }
        }
      }
      // The parent fallback can itself collide when the page publishes two authored blocks
      // with the same relation and no creation stamp. Raw ids are weaker across reloads but
      // still strictly better than swallowing one of two distinct messages in this scan.
      if (logicalIds.has(logicalId)) {
        logicalId = id;
        stable = false;
      }
      // Keep the position from ChatGPT's own turn model. `messages` and native activity are
      // transported as separate arrays below for validation, so without this ordinal the
      // isolated-world recorder has no way to put them back together. That was visible on
      // the first interim update of a turn: the prose and the preceding thinking headline
      // often arrived in one scan, and content.js always emitted all prose before all
      // headlines regardless of the order ChatGPT actually rendered them.
      out.push({
        id,
        messageId: logicalId,
        role: 'assistant',
        stable,
        rawText,
        order: index,
        createTime
      });
      logicalIds.add(logicalId);
    }
    return out;
  }

  /**
   * Public user messages in ChatGPT's own turn model.
   *
   * The DOM usually exposes `data-message-id` for user prose, but the first message of a
   * brand-new chat can exist in the React model before that attribute is mounted. That is
   * exactly the gap where the live recorder used to miss the opening prompt and only recover
   * it after a reload. The model id is already ChatGPT's durable identity, so there is no
   * reason to make user capture depend on the DOM having caught up.
   */
  function authoredUserMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'user') continue;
      const id = str(message.id);
      const content = message.content;
      const multimodal = content?.content_type === 'multimodal_text' && Array.isArray(content.parts);
      const imageCount = multimodal ? content.parts.filter(part => part?.content_type === 'image_asset_pointer').length : 0;
      const attachments = imageCount > 0 && Array.isArray(message.metadata?.attachments)
        ? message.metadata.attachments.filter(file => file && typeof file.id === 'string' && file.id.length > 0 && file.id.length <= 100 &&
          typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 200 &&
          /^image\/[a-z0-9.+-]{1,80}$/i.test(file.mime_type) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 512 * 1024 * 1024)
          .slice(0, Math.min(4, imageCount)).map(file => ({ id: file.id, name: file.name, size: file.size, mimeType: file.mime_type })) : [];
      const authored = multimodal ? content.parts.filter(part => typeof part === 'string').join('\n') : authoredText(message);
      const rawText = budgetedText(authored, budget, MAX_RENDERED_TEXT) || '';
      if (!id || (!rawText && !attachments.length)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        messageId: id,
        role: 'user',
        stable: true,
        rawText,
        ...(attachments.length ? { attachments } : {}),
        order: index,
        createTime: authoredTime(message)
      });
    }
    return out;
  }

  /**
   * Whether ChatGPT's own message model says this turn reached a terminal successful end.
   *
   * Live 2026-08-19 evidence: an actively generating turn can already expose
   * `isFinalTurn:true`, and interim public messages can already have
   * `status:'finished_successfully'`; neither is completion. The final assistant message is
   * the one that additionally carries direct `end_turn:true`. Only that boolean plus the
   * assistant role/status crosses worlds. No private reasoning or finish payload is copied.
   */
  function turnEndMessageId(messages) {
    if (!Array.isArray(messages)) return null;
    // The latest public message that *could* be the answer is the current state of the assistant
    // turn. A Retry/Regenerate can leave the previous finished attempt in the same model while
    // a newer public message is active; searching for *any* older end_turn=true would
    // incorrectly keep the new attempt terminal forever. So the first such message from the
    // tail decides, fail closed.
    //
    // "Could be the answer" is ChatGPT's own routing, not a guess about content: a turn's
    // trailing `analysis` or `commentary` message is not a turn still in flight, it is a
    // message on a channel that never carries answers. Skipping those is what stops one empty
    // scratch message — live, an `analysis` row stuck at `status:'in_progress'` after the
    // Stop control had already gone — from hiding a completed answer forever, leaving the real
    // final prose recorded as partial and the turn permanently open. See neverTerminalChannel.
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      const content = message.content;
      if (!content || typeof content !== 'object' || !['text', 'multimodal_text', 'image'].includes(content.content_type)) continue;
      if (neverTerminalChannel(message)) continue;
      if (message.end_turn === true && message.status === 'finished_successfully') return str(message.id);
      return null;
    }
    return null;
  }

  /** Whitespace-only normalisation for an optional DOM decoration match. */
  function visibleText(value) {
    return typeof value === 'string' ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Public authored prose from ChatGPT's own message model, optionally decorated with the
   * rendered HTML of the matching visible block.
   *
   * Identity and raw Markdown come from the model, not the DOM. That is the important
   * invariant: a renderer refactor may cost rich HTML for one message, but can no longer make
   * the message disappear or mint a new identity for each streaming snapshot.
   *
   * HTML is decoration only. Prefer an explicit DOM/Fiber message id. Where the page no
   * longer exposes one, an exact whitespace-normalised text equality may attach a block, but
   * only when that match is unique on both sides. Markdown whose rendered text differs from
   * its raw source simply keeps `renderedHtml: ''` and the recorder still has the canonical
   * raw Markdown. Finally, the old positional fallback remains only for the fully balanced
   * case, where every remaining candidate has exactly one remaining visible block.
   */
  function renderedMessagesOf(sections, messages, budget) {
    const assistantCandidates = authoredAssistantMessages(messages, budget);
    const userCandidates = authoredUserMessages(messages, budget);
    if (assistantCandidates.length === 0 && userCandidates.length === 0) return [];

    const blocks = [];
    const blockSections = [];
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(MARKDOWN);
      } catch {
        continue;
      }
      for (let at = 0; at < found.length; at++) {
        const block = found[at];
        if (block.closest && (block.closest(TOOL) || block.closest(OWN_SURFACES))) continue;
        const parent = block.parentElement && block.parentElement.closest ? block.parentElement.closest(MARKDOWN) : null;
        if (parent && section.contains(parent)) continue;
        blocks.push(block);
        blockSections.push(sectionAt);
      }
    }

    const used = new Set();
    const ids = [];
    for (let at = 0; at < blocks.length; at++) {
      const block = blocks[at];
      let id = null;
      try {
        const holder = block.closest && block.closest('[data-message-id]');
        id = holder ? str(holder.getAttribute('data-message-id')) : null;
      } catch {
        id = null;
      }
      if (!id) {
        try {
          const fiber = fiberOf(block);
          if (fiber) id = messageOf(fiber);
        } catch {
          id = null;
        }
      }
      let known = false;
      for (let c = 0; c < assistantCandidates.length; c++) if (assistantCandidates[c].id === id) known = true;
      if (!known) id = null;
      if (id) used.add(id);
      ids.push(id);
    }

    const freeBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) freeBlocks.push(at);
    const freeCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) freeCandidates.push(assistantCandidates[c]);
    }

    // The live 2026-08-19 page no longer exposes a message id on authored Markdown blocks.
    // Attach HTML by exact visible text only when the equality is unique in both directions.
    for (let c = 0; c < freeCandidates.length; c++) {
      const candidate = freeCandidates[c];
      const wanted = visibleText(candidate.rawText);
      if (!wanted) continue;
      let match = -1;
      let count = 0;
      for (let b = 0; b < freeBlocks.length; b++) {
        const blockAt = freeBlocks[b];
        let text = '';
        try {
          text = visibleText(blocks[blockAt] && blocks[blockAt].textContent);
        } catch {
          text = '';
        }
        if (text !== wanted) continue;
        match = blockAt;
        count += 1;
      }
      if (count !== 1) continue;
      let candidateCount = 0;
      for (let other = 0; other < freeCandidates.length; other++) {
        if (visibleText(freeCandidates[other].rawText) === wanted) candidateCount += 1;
      }
      if (candidateCount !== 1) continue;
      ids[match] = candidate.id;
      used.add(candidate.id);
    }

    const remainingBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) remainingBlocks.push(at);
    const remainingCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) remainingCandidates.push(assistantCandidates[c]);
    }
    if (remainingBlocks.length === remainingCandidates.length) {
      for (let at = 0; at < remainingBlocks.length; at++) ids[remainingBlocks[at]] = remainingCandidates[at].id;
    }

    // One canonical record per model message whether or not HTML could be attached.
    const out = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      out.push({
        messageId: assistantCandidates[c].messageId,
        rawMessageId: assistantCandidates[c].id,
        role: 'assistant',
        stable: assistantCandidates[c].stable,
        order: assistantCandidates[c].order,
        createTime: assistantCandidates[c].createTime,
        rawText: assistantCandidates[c].rawText,
        renderedHtml: ''
      });
    }
    for (let c = 0; c < userCandidates.length; c++) {
      out.push({
        messageId: userCandidates[c].messageId,
        rawMessageId: userCandidates[c].id,
        role: 'user',
        stable: true,
        order: userCandidates[c].order,
        createTime: userCandidates[c].createTime,
        rawText: userCandidates[c].rawText,
        ...(userCandidates[c].attachments ? { attachments: userCandidates[c].attachments } : {}),
        renderedHtml: ''
      });
    }
    for (let at = 0; at < blocks.length; at++) {
      const id = ids[at];
      if (!id) continue;
      let target = -1;
      for (let c = 0; c < out.length; c++) if (out[c].rawMessageId === id) target = c;
      if (target < 0 || out[target].renderedHtml) continue;
      const block = blocks[at];
      let renderedHtml = '';
      try {
        // All of the markup or none of it. Cutting HTML at a character count cuts it mid-tag,
        // and ChatGPT's code blocks carry several hundred characters of wrapper chrome around
        // a few lines of code — so a cut lands inside one often, and everything after it is
        // lost while the visible remainder ends as an unclosed box. The canonical raw text is
        // always carried beside this, so an absent capture costs presentation, never content.
        const markup = block.innerHTML;
        renderedHtml =
          markup.length <= Math.min(MAX_RENDERED_HTML, budget.remaining)
            ? budgetedText(markup, budget, MAX_RENDERED_HTML)
            : '';
      } catch {
        renderedHtml = '';
      }
      if (renderedHtml) {
        out[target].renderedHtml = renderedHtml;
        // This is rendered ownership, not model identity: the message id above came from the
        // Fiber/model join, and this ordinal says which exact sibling section supplied its
        // unique visible block. content.js uses it only as corroboration for a completed-message
        // action when end_turn is missing; no unique rendered join means null/fail closed.
        out[target].sectionIndex = blockSections[at];
      }
    }
    out.sort((left, right) => left.order - right.order);
    return out;
  }

  /**
   * Visible ChatGPT-native activity, keyed by the thought object that owns the rendered row.
   *
   * The label is display data only. React may replace the DOM row or rewrite its text from
   * "Inspecting" to "Inspected"; neither can create a new record because the identity is the
   * page-model thought `message.id`. If two simultaneously rendered rows claim one thought
   * with different labels (a transition/reparent race), that scan is ambiguous and emits
   * neither version. The next stable scan reconciles it.
   */
  function nativeActivitiesOf(sections, messages) {
    const thoughtIds = new Set();
    const thoughtOrder = new Map();
    for (let at = 0; at < messages.length; at++) {
      if (!thoughtMessage(messages[at])) continue;
      const id = str(messages[at].id);
      if (id) {
        thoughtIds.add(id);
        thoughtOrder.set(id, at);
      }
    }
    if (thoughtIds.size === 0) return [];

    const held = [];
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(TOOL);
      } catch {
        continue;
      }
      const rows = [];
      const candidates = new Set(found);
      const nestedParents = new Set();
      for (let at = 0; at < found.length; at++) {
        const row = found[at];
        let parent = row && row.parentElement;
        while (parent && parent !== section) {
          if (candidates.has(parent)) nestedParents.add(parent);
          parent = parent.parentElement;
        }
      }
      for (let at = 0; at < found.length; at++) {
        if (!nestedParents.has(found[at])) rows.push(found[at]);
      }

      for (let at = 0; at < rows.length; at++) {
        const row = rows[at];
        try {
          if (row.closest && row.closest(OWN_SURFACES)) continue;
          if ((row.querySelector && row.querySelector(CONNECTOR)) || (row.closest && row.closest(CONNECTOR))) continue;
          if (row.querySelector && row.querySelector(MARKDOWN)) continue;
        } catch {
          continue;
        }
        const label = visibleText(row.textContent).slice(0, 300);
        if (!label || label.length > 300) continue;
        let activity = null;
        try {
          const fiber = fiberOf(row);
          if (fiber) activity = thoughtItemOf(fiber, thoughtIds);
        } catch {
          activity = null;
        }
        if (!activity) continue;

        let prior = null;
        for (let entryAt = 0; entryAt < held.length; entryAt++) {
          if (held[entryAt].messageId === activity.messageId) prior = held[entryAt];
        }
        if (!prior) {
          held.push({
            messageId: activity.messageId,
            label,
            order: thoughtOrder.get(activity.messageId),
            conflicted: false
          });
        } else if (prior.label !== label) {
          prior.conflicted = true;
        }
      }
    }
    const out = [];
    for (let at = 0; at < held.length; at++) {
      if (!held[at].conflicted) {
        out.push({ messageId: held[at].messageId, label: held[at].label, order: held[at].order });
      }
    }
    return out;
  }

  /**
   * The connector request this row stands for, or null if `message` is not one.
   *
   * A connector request is an assistant message whose `recipient` names the API tool
   * bridge. The tool is at the front of its content, which is *nearly* JSON: the live page
   * stores the payload truncated — `Unterminated string in JSON at position 741` on a
   * routine call — so parsing it fails on most rows, and the old fallback of naming the row
   * after the recipient turned every one of those into `call_tool`, a tool this app does
   * not have. The anchored path-first prefix survives those truncations. Complete bounded
   * JSON also supports other property orders; only its own unique root path leaves this reader.
   */
  function requestOf(message) {
    if (!message || typeof message !== 'object') return null;
    const author = message.author;
    if (!author || author.role !== 'assistant') return null;
    const recipient = str(message.recipient);
    if (!recipient || recipient.indexOf('api_tool') !== 0) return null;

    const content = Object.getOwnPropertyDescriptor(message, 'content')?.value;
    const text = content && typeof content === 'object' ? Object.getOwnPropertyDescriptor(content, 'text')?.value : null;
    const path = requestPath(text);

    // ChatGPT stamps every connector request with its own request id, and the same id
    // reaches the app on the MCP request itself — a deterministic join between the page and
    // the call, so two workers calling one tool at once need no timing heuristic to tell
    // apart. Allowlisted like everything else here — an opaque id, never arguments.
    const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    return {
      path,
      messageId: str(message.id),
      requestId: meta ? str(meta.request_id) : null,
      createTime: num(message.create_time)
    };
  }

  /**
   * Every request id ChatGPT has stamped anywhere in this turn.
   *
   * `callsOf` deliberately answers a narrow question — which rows are *this app's* connector
   * calls, so they can be labelled and rendered — and to answer it, it requires a readable
   * `api_tool` recipient and a parseable tool path. That filter is right for a tool row and
   * wrong for attribution, and the difference cost an entire class of calls.
   *
   * ChatGPT stamps `metadata.request_id` on the plain `recipient: "all"` message the moment a
   * turn starts a connector request, and only materializes the `api_tool` message once its
   * safety check clears — live 2026-08-21, forty seconds later, well past the app's fifteen
   * second evidence window. The id was on screen and readable the whole time; this file threw
   * it away because it was not yet attached to a row worth *drawing*. The app then filed the
   * call under `Unattributed activity`, refused identity-sensitive calls, and the chat looked
   * broken for reasons no log named.
   *
   * The request id is opaque, and the join it feeds is exact: id -> conversation, nothing
   * else. So harvest it from every message in the turn, with no opinion about recipient, path
   * or tool name, and let the app decide. Nothing here is rendered and nothing here is parsed
   * from `content.text` — this list carries three allowlisted primitives per entry and never
   * appears in the transcript.
   */
  function requestIdsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const message = messages[at];
      if (!message || typeof message !== 'object') continue;
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const requestId = meta ? str(meta.request_id) : null;
      if (!requestId || seen.has(requestId)) continue;
      seen.add(requestId);
      out.push({
        requestId,
        messageId: str(message.id),
        createTime: num(message.create_time)
      });
    }
    return out;
  }

  /** "/Chat On Steroids Core/link_…/read" -> "read", or null if that is not a name. */
  function toolName(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const tail = value.slice(value.lastIndexOf('/') + 1);
    return NAME.test(tail) ? tail : null;
  }

  /**
   * The tool a row ran, from both sources or neither.
   *
   * The request names it and so does the result — `invoked_resource.resource_uri`, which
   * is structured and needs no parsing. Where both are readable they must agree: two
   * sources naming different tools means the pairing is wrong, and a row labelled with the
   * wrong tool is worse than one left saying "Called tool". Where only one is readable it
   * is used, because an unanswered call has no result yet and a truncated payload has no
   * path.
   */
  function identify(request, result) {
    const asked = toolName(request.path);
    const answered = result ? toolName(result.resource) : null;
    if (asked && answered) return asked === answered ? asked : null;
    return asked || answered;
  }

  // Sightings contain identity metadata only. Main proves the request reached its own endpoint.
  function sightingsOf(messages) {
    const out = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (out.length >= 50) break;
      // The selected provider mapping also contains user messages. An unknown native
      // user role getter is not a connector sighting and must never be evaluated to
      // classify it; request identity is checked separately against own data fields.
      let author, role, name;
      try {
        author = message && typeof message === 'object' ? Object.getOwnPropertyDescriptor(message, 'author')?.value : null;
        role = author && typeof author === 'object' ? Object.getOwnPropertyDescriptor(author, 'role')?.value : null;
        name = author && typeof author === 'object' ? Object.getOwnPropertyDescriptor(author, 'name')?.value : null;
      } catch { continue; }
      if (role !== 'tool' || name !== 'api_tool.call_tool') continue;
      const result = resultOf(message), requestId = str(message.metadata?.request_id), appId = appIdOf(result?.resource);
      if (requestId && appId) out.push({ requestId, appId, linkId: linkIdOf(result.resource), appName: result.app });
    }
    return out;
  }
  /** The connector a result came back through, and whether it came back at all. */
  function resultOf(message) {
    if (!message || typeof message !== 'object') return null;
    // invoked_resource alone is not a returned native Core result. An
    // assistant/code-wrapper message may carry similar metadata without ever
    // finishing this connector's exact tool invocation. A legacy unnamed
    // tool result is still accepted when its role and recipient are correct.
    if (message.author?.role !== 'tool' || message.recipient !== 'all' ||
        (message.author.name && message.author.name !== 'api_tool.call_tool')) return null;
    const meta = message.metadata;
    const resource = meta && meta.invoked_resource;
    if (!resource || typeof resource !== 'object') return null;
    return { app: str(resource.app_name), resource: str(resource.resource_uri) };
  }
  /**
   * Read one Core SERVER-owned post-commit result receipt from the provider's
   * typed JSON tool-result envelope. Do not search arbitrary tool-response text:
   * it may echo a previous receipt with no corresponding durable execution.
   * The caller separately validates exact invocation/result parent, tool and
   * connector identity; this is not independently authenticated until a real
   * installed provider proves preservation of one of the exact carriers.
   * Nothing except this bounded opaque witness may leave this page context.
   */
  function coreResultReceipt(message, shapes = null) {
    // Fixed reason counts stay in the existing bounded diagnostic lane. They
    // are observations of this reader, not a claim that the provider dropped data.
    const decline = reason => { if (shapes) shapes[reason]++; return null; };
    if (!message || message.author?.role !== 'tool' ||
        message.author?.name !== 'api_tool.call_tool' || message.recipient !== 'all') return decline('identity');
    // A native result card may exist before ChatGPT actually finishes accepting
    // it. Its structured payload alone cannot be an ACK of that native message.
    // Legacy provider shapes without a status remain eligible only with all
    // the separate parent/resource/unique-durable-recorder proofs downstream.
    const status = Object.getOwnPropertyDescriptor(message, 'status');
    if (status && (!own.call(status, 'value') || status.value !== 'finished_successfully')) return decline('status');
    const data = Object.getOwnPropertyDescriptor(message, 'content');
    const content = data && own.call(data, 'value') ? data.value : null;
    const textField = content && typeof content === 'object' ? Object.getOwnPropertyDescriptor(content, 'text') : null;
    const raw = textField && own.call(textField, 'value') ? textField.value : null;
    if (typeof raw !== 'string' || !content || content.content_type !== 'code' || content.language !== 'json') {
      const parts = content && typeof content === 'object' ? Object.getOwnPropertyDescriptor(content, 'parts') : null;
      return decline(parts && own.call(parts, 'value') && Array.isArray(parts.value) ? 'parts' : 'content');
    }
    if (raw.length > 512 * 1024) return decline('oversized');
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value.isError !== undefined && typeof value.isError !== 'boolean')) return decline('envelope');
      // Only the provider's OUTER MCP CallToolResult is eligible. Never
      // recursively parse tool text, content.parts or nested JSON envelopes.
      if (!Array.isArray(value.content) || value.content.length > 256 ||
          value.content.some(part => !part || typeof part !== 'object' ||
            typeof part.type !== 'string' ||
            !['text', 'image', 'audio', 'resource', 'resource_link'].includes(part.type))) return decline('envelope');
      const validReceipt = receipt => receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
        receipt.version === 1 && typeof receipt.id === 'string' &&
        /^[a-f0-9]{48}$/.test(receipt.id) && Object.keys(receipt).length === 2;
      let structuredId = null, resourceId = null;
      if (own.call(value, 'structuredContent')) {
        if (!value.structuredContent || typeof value.structuredContent !== 'object' ||
            Array.isArray(value.structuredContent)) return decline('structured');
        if (own.call(value.structuredContent, 'cosResultReceipt')) {
          if (!validReceipt(value.structuredContent.cosResultReceipt)) return decline('receipt');
          structuredId = value.structuredContent.cosResultReceipt.id;
        }
      }
      for (const part of value.content) {
        if (part.type !== 'resource') continue;
        const resource = part.resource;
        if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
        const reservedUri = typeof resource.uri === 'string' && resource.uri.startsWith('urn:cos:result-receipt:');
        const reservedMime = resource.mimeType === 'application/vnd.chat-on-steroids.result-receipt+json';
        if (!reservedUri && !reservedMime) continue;
        // Malformed, duplicate or disagreeing own carriers are evidence of an
        // ambiguous projection, never a reason to prefer whichever one matches.
        if (resourceId || Object.keys(part).length !== 2 || Object.keys(resource).length !== 3 ||
            !reservedUri || !reservedMime || typeof resource.text !== 'string' || resource.text.length > 128)
          return decline('receipt');
        const receipt = JSON.parse(resource.text);
        if (!validReceipt(receipt) || resource.uri !== 'urn:cos:result-receipt:v1:' + receipt.id)
          return decline('receipt');
        resourceId = receipt.id;
      }
      if (structuredId && resourceId && structuredId !== resourceId) return decline('receipt');
      const receiptId = structuredId || resourceId;
      if (!receiptId) return decline(own.call(value, 'structuredContent') ? 'receipt' : 'structured');
      if (shapes) shapes.valid++;
      return receiptId;
    } catch {
      return decline('json');
    }
  }
  /** Exact number of this app's own invocations represented by the whole turn, or null. */
  function localCountOf(messages) {
    if (!Array.isArray(messages)) return null;
    const ids = [];
    let anonymous = 0;
    const remember = (id) => {
      if (!id) {
        anonymous += 1;
        return;
      }
      for (let at = 0; at < ids.length; at++) if (ids[at] === id) return;
      ids.push(id);
    };

    for (let at = 0; at < messages.length; at++) {
      const message = messages[at];
      const request = requestOf(message);
      if (request && ourPath(request.path)) {
        remember(request.messageId);
      }

      const result = resultOf(message);
      if (result && ownResult(result)) {
        const meta = message && typeof message === 'object' ? message.metadata : null;
        remember(meta && typeof meta === 'object' ? str(meta.parent_id) : null);
      }
    }
    return Math.min(999, ids.length + anonymous);
  }

  /**
   * One row's descriptor, or null when the shape is not the one we know.
   *
   * The representative call is `messages[0]` — the group's own request, and the one whose
   * name the row shows. It is also the *last* call of what the row stands for: ChatGPT's
   * own "Open tool call list" for a turn that ran five calls showed four rows whose
   * requests were calls two to five, with call one folded under the first row.
   *
   * The result is found by `parent_id`, never by position. Everything after `messages[0]`
   * is a result, but only the one whose `metadata.parent_id` is this request's id answered
   * *this* call; the rest are chained to requests that are not in this array at all.
   * Taking the nearest one instead — which is what scanning forward does — pairs a row with
   * whatever came back next, and that is the live symptom of a row headed `Search files`
   * sitting over another tool's output.
   */
  function describe(row, index) {
    const fiber = fiberOf(row);
    if (!fiber) return null;

    const group = groupOf(fiber);
    if (!group) return null;

    const turnMessages = turnMessagesOf(fiber);
    const localCount = localCountOf(turnMessages);
    const messages = group.messages;
    const request = requestOf(messages[0]);
    if (!request) return null;

    let result = null, resultProved = false, claimedResults = 0;
    if (request.messageId) {
      // An index loop and no array method: this walks page-owned data, and the page can
      // replace Array.prototype.find but it cannot replace the language.
      for (let at = 1; at < messages.length; at++) {
        const message = messages[at];
        const meta = message && typeof message === 'object' ? message.metadata : null;
        if (meta && typeof meta === 'object' && str(meta.parent_id) === request.messageId) {
          claimedResults++;
          const candidate = resultOf(message);
          if (!candidate) continue;
          const link = request.path ? linkIdOf(request.path) : null;
          const status = Object.getOwnPropertyDescriptor(message, 'status');
          const matching = request.path && ourPath(request.path) &&
            toolName(request.path) === toolName(candidate.resource) &&
            link && link === linkIdOf(candidate.resource) &&
            sameResultSurface(request.path, candidate) &&
            (!request.requestId || !str(meta.request_id) ||
              request.requestId === str(meta.request_id)) &&
            (!status || (own.call(status, 'value') && status.value === 'finished_successfully'));
          if (matching) { result = candidate; resultProved = true; }
          else if (!result) {
            // Preserve the legacy representative-row label when ChatGPT cut
            // the request path mid-string. This is presentation only: callsOf
            // still refuses to export a named invocation without its path.
            // When both paths exist but disagree, identify() deliberately
            // renders a neutral/unknown tool rather than inventing a match.
            result = candidate;
            resultProved = !request.path && ownResult(candidate) &&
              (!status || (own.call(status, 'value') && status.value === 'finished_successfully'));
          }
        }
      }
    }
    // A second native result naming this same parent is ambiguity, even if
    // only one has the expected resource. Do not turn a displayed row into
    // a completion ACK when the full turn's exact tool-message proof is absent.
    if (claimedResults !== 1) { result = null; resultProved = false; }

    /**
     * How many calls the row shows in place of, as the page counts them.
     *
     * Presentation cardinality and nothing else. The prop is named for a run of calls to
     * the same tool, but the live page folds different tools together — `list_resources`
     * under one `agents` call — so it says how many the row stands for, never which.
     */
    const hidden = int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null);
    const turnId = str(group.turnId);

    return {
      v: VERSION,
      index,
      tool: identify(request, result),
      path: request.path,
      app: result ? result.app : null,
      resource: result ? result.resource : null,
      messageId: request.messageId,
      turnId,
      conversationId: str(group.clientThreadId) || str(group.conversationId),
      createTime: request.createTime,
      hidden,
      // Turn-wide cardinality only. No request arguments or message bodies cross worlds.
      localCount,
      /** Whether the page has shown a result for the representative call yet. */
      answered: resultProved,
      own: result ? ownResult(result) : ourPath(request.path)
    };
  }

  /**
   * Every connector request this turn issued, one entry per call.
   *
   * This is the evidence the app's attribution was missing, and it was here the whole time.
   * The visible rows are a *rendering* of these messages: ChatGPT folds a run of calls into
   * one row and on a fast turn draws no row at all until well after the call was answered,
   * so counting rows counts fewer calls than the turn made. Everything the row count could
   * not account for was then filed outside the chat that made it — a single conversation
   * splitting itself into its real session plus a permanently growing pile of unattributed
   * work. The message list does not fold: each request is its own message, with its own id
   * and its own tool path, whatever the renderer decides to draw.
   *
   * Restricted to this app's own connector. A Gmail or Calendar request in the same turn is
   * some other integration's business, and vouching for it would put a stranger's call into
   * this app's session — the precise false match that made a bare connector row weak
   * evidence in the first place.
   *
   * The allowlist is the same one everything else here obeys, and is if anything tighter:
   * a message id, a tool name derived from the front of the path, the position in the turn
   * and whether a result has come back. No argument values, no result bodies, no reasoning,
   * no whole objects. `content.text` is never parsed — only the anchored path is read off
   * the front of it, exactly as `requestOf` already does.
   */
  /**
   * Native Code Mode chains child requests/results below one `functions.exec` call. A child's
   * parent id is chronology, not proof that the enclosing native result reached ChatGPT. Resolve
   * that exact enclosing call without exporting code, arguments, output, or other page objects.
   */
  function codeModeReceipts(messages) {
    const byId = new Map();
    for (const message of messages) {
      const id = str(message && message.id);
      if (id) byId.set(id, byId.has(id) ? null : message);
    }
    const owners = new Map();
    const conflictingResultParents = conflictingCoreResultParents(messages);
    const scope = message => {
      const meta = message && message.metadata;
      const request = str(meta && meta.request_id);
      const working = str(meta && meta.working_turn_id);
      const exchange = str(meta && meta.turn_exchange_id);
      return request && working && exchange ? `${request}\u0000${working}\u0000${exchange}` : null;
    };
    const ownerOf = message => {
      const trail = [], visited = new Set();
      let cursor = message, owner = null;
      while (cursor && trail.length < MAX_NATIVE_PATH_NODES) {
        const id = str(cursor.id);
        if (!id || byId.get(id) !== cursor || visited.has(id)) break;
        visited.add(id);
        const role = cursor.author && cursor.author.role;
        if (role === 'assistant' && cursor.recipient === 'functions.exec') {
          owner = { id, scope: scope(cursor), valid: cursor.status === 'finished_successfully' && !!scope(cursor) };
          break;
        }
        // An earlier completed enclosing call cannot own a later ordinary invocation.
        if (trail.length && role === 'tool' && cursor.author.name === 'functions.exec') break;
        if (owners.has(id)) { owner = owners.get(id); break; }
        if (!((role === 'assistant' && cursor.recipient === 'api_tool.call_tool') ||
            (role === 'tool' && cursor.recipient === 'all' &&
              (cursor.author.name === 'api_tool.call_tool' || cursor.author.name === 'functions.exec')))) break;
        trail.push(cursor);
        cursor = byId.get(str(cursor.metadata && cursor.metadata.parent_id));
      }
      for (let index = trail.length - 1; index >= 0; index--) {
        if (owner) owner = { ...owner, valid: owner.valid && scope(trail[index]) === owner.scope };
        owners.set(trail[index].id, owner);
      }
      return owner;
    };
    const completed = new Set();
    for (const message of messages) {
      if (message && message.author && message.author.role === 'tool' && message.author.name === 'functions.exec' &&
          message.recipient === 'all' && message.status === 'finished_successfully' && byId.get(message.id) === message &&
          !conflictingResultParents.has(str(message.metadata && message.metadata.parent_id))) {
        const owner = ownerOf(message);
        if (owner && owner.valid) completed.add(owner.id);
      }
    }
    const receipts = new Map();
    for (const message of messages) {
      const owner = ownerOf(message);
      if (owner) receipts.set(message.id, owner.valid && completed.has(owner.id));
    }
    return receipts;
  }

  /** One selected native Core request may have ONE returned tool message.
   * If a duplicate sibling has the same parent (even without structuredContent,
   * or bearing another tool/resource), the result owner is ambiguous. Only
   * bounded IDs leave this scan; never export private native result contents. */
  function conflictingCoreResultParents(messages) {
    const seen = new Set(), conflict = new Set();
    if (!Array.isArray(messages)) return conflict;
    const field = (value, key) => {
      if (!value || typeof value !== 'object') return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      return desc && own.call(desc, 'value') ? desc.value : null;
    };
    for (const message of messages) {
      try {
        const author = field(message, 'author');
        // Include a tool result that wrongly claims the same parent even if
        // its tool/resource differs. Two such messages are ambiguity, not a
        // choice of whichever sibling carries the right-looking receipt.
        if (field(author, 'role') !== 'tool' ||
            field(message, 'recipient') !== 'all') continue;
        const parent = str(field(field(message, 'metadata'), 'parent_id'));
        if (!parent) continue;
        if (seen.has(parent)) conflict.add(parent);
        seen.add(parent);
      } catch { /* Unknown native data cannot establish positive receipt authority. */ }
    }
    return conflict;
  }

  function callsOf(messages, codeReceipts = new Map()) {
    if (!Array.isArray(messages)) return { calls: [], complete: false };
    const out = [];
    let nativeRequests = 0;
    let unreadableNativeRequests = 0;
    const seen = new Set();
    const answered = new Set();
    const unfinishedResults = new Set();
    const receipts = new Map(), requests = new Map();
    const conflictingResultParents = conflictingCoreResultParents(messages);
    for (const message of messages) {
      const call = requestOf(message);
      if (call && ourPath(call.path)) nativeRequests++;
      // A native api_tool.call_tool invocation with an unreadable path may
      // belong to this Core. Its unknown resource is not evidence that the
      // selected answer ran no native calls. Do not guess an app/tool owner.
      if (message?.author?.role === 'assistant' && message?.recipient === 'api_tool.call_tool' &&
          (!call || !call.path)) unreadableNativeRequests++;
      if (call?.messageId) requests.set(call.messageId, requests.has(call.messageId) ? null : call);
    }
    // Results first, so a request can say whether its own answer has arrived. `parent_id`
    // is what pairs them; position does not, and pairing by position is how a row came to
    // sit over another tool's output.
    for (let at = 0; at < messages.length && answered.size < MAX_CALLS; at++) {
      const message = messages[at];
      const result = resultOf(message);
      if (!result || !ownResult(result)) continue;
      const meta = message && typeof message === 'object' ? message.metadata : null;
      const parent = meta && typeof meta === 'object' ? str(meta.parent_id) : null;
      const asked = parent ? requests.get(parent) : null;
      // A parent_id names the native request, not proof that this particular
      // tool/resource returned. A single wrong-tool or wrong-link result could
      // previously mark our Core call answered even though we correctly
      // withheld its structured receipt. Never credit native final/Loop
      // eligibility from that unmatched result. Keep legacy results with a
      // missing request_id eligible ONLY when their exact parent, tool and
      // connector link are independently consistent.
      const askedLink = asked?.path ? linkIdOf(asked.path) : null;
      if (!asked?.path || !ourPath(asked.path) ||
          toolName(asked.path) !== toolName(result.resource) ||
          !askedLink || askedLink !== linkIdOf(result.resource) ||
          !sameResultSurface(asked.path, result) ||
          (asked.requestId && str(meta?.request_id) && asked.requestId !== str(meta.request_id))) continue;
      if (parent) {
        const status = Object.getOwnPropertyDescriptor(message, 'status');
        if (status && (!own.call(status, 'value') || status.value !== 'finished_successfully'))
          unfinishedResults.add(parent);
        else {
          answered.add(parent);
          // A missing invocation ID may be captured from ONE exact, finished native result.
          // The parent/tool/link/surface checks above and duplicate-result veto remain binding;
          // never borrow a whole turn's workflow or overwrite a known invocation identity.
          const request = meta && Object.getOwnPropertyDescriptor(meta, 'request_id');
          if (!asked.requestId && !conflictingResultParents.has(parent) &&
              message.author.name === 'api_tool.call_tool' && status?.value === 'finished_successfully' &&
              request && own.call(request, 'value') && typeof request.value === 'string' &&
              /^[a-z0-9_-]{1,100}$/i.test(request.value)) asked.requestId = request.value;
        }
      }
      const receipt = coreResultReceipt(message);
      if (receipt && !conflictingResultParents.has(parent))
        receipts.set(parent, receipts.has(parent) ? null : receipt);
    }

    const duplicated = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const request = requestOf(messages[at]);
      if (!request || !ourPath(request.path)) continue;
      const tool = toolName(request.path);
      const id = request.messageId;
      if (!tool || !id) continue;
      // An id reported twice is an ambiguity, not a second call, and it is dropped on
      // *both* sides: keeping the first would still hand the app one identity standing
      // for two different requests, which is the same piece of evidence spent twice.
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
      // A matching native-result shape is not itself a completed provider
      // message. Fail closed before browser /correlations can credit a tool
      // result or allow exact-final/Loop eligibility on duplicate/unfinished
      // native parents. A later distinct, proved final may be considered only
      // on a new consistent observation; never replay the original call.
      const hasResult = !conflictingResultParents.has(id) && !unfinishedResults.has(id) &&
        (codeReceipts.has(id) ? codeReceipts.get(id) : answered.has(id));
      out.push({
        messageId: id,
        tool,
        order: 0,
        answered: hasResult,
        // ChatGPT's own id for the request, and its own timestamp for when the request was
        // created. The app's existing stamp is when the *extension* observed the row, which
        // is a poll tick and jitters per tab; these are the only values on either side that
        // say which request this is and when it was actually issued.
        requestId: request.requestId || (hasResult ? requests.get(id)?.requestId : null) || null,
        ...(hasResult && receipts.get(id) ? { resultReceiptId: receipts.get(id) } : {}),
        createTime: request.createTime
      });
    }

    const kept = [];
    for (let at = 0; at < out.length; at++) {
      if (duplicated.has(out[at].messageId)) continue;
      out[at].order = kept.length;
      kept.push(out[at]);
    }
    // This producer intentionally exports at most MAX_CALLS descriptors. A
    // clipped tail, duplicate native id or filtered unparseable tool cannot be
    // passed off as an exhaustive native inventory to the isolated reader.
    // Keep the safe prefix for request attribution, but withhold native final.
    return { calls: kept, complete: unreadableNativeRequests === 0 &&
      nativeRequests <= MAX_CALLS && nativeRequests === kept.length };
  }

  /** Read the query client mounted on this exact committed shell branch. */
  function shellQueries(fiber) {
    try {
      for (let at = fiber, up = 0; at && up < MAX_ROOT_DEPTH; up++, at = at.return) {
        const client = at.memoizedProps?.client;
        if (typeof client?.getQueryCache !== 'function') continue;
        const queries = client.getQueryCache()?.getAll();
        return Array.isArray(queries) && queries.length <= 512 ? queries : [];
      }
    } catch { /* Optional metadata must not cost the mounted transcript. */ }
    return [];
  }

  /** Exact server id named by one current-conversation cache query. */
  function shellQueryConversation(query) {
    const key = query?.queryKey;
    if (!Array.isArray(key) || key[0] !== 'chatgpt-conversation') return null;
    const keyed = typeof key[1] === 'string'
      ? key[1]
      : str(key[1]?.serverConversationId) || str(key[1]?.conversationId);
    const data = query?.state?.data;
    const stored = str(data?.conversation_id) || str(data?.conversationId) || str(data?.id);
    if (keyed && stored && keyed !== stored) return false;
    const value = stored || keyed;
    return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
      ? value : null;
  }

  /**
   * Join the current temporary shell's retained local id to its committed route.
   *
   * The 2026-09 alternate shell can keep `local-chatgpt:<id>` on both the rendered turn and
   * composer after a temporary helper has committed to `/c/<server-id>`. At the same time the
   * old `chatgpt-conversation-details` local/server query disappears, leaving only the exact
   * server-keyed conversation cache. That made a complete helper look blank forever.
   *
   * The route is not evidence by itself. Admit it only when all four independent current-page
   * facts agree: this is a temporary chat, the exact rendered shell turn carries `localId`, the
   * only composer carries that same id, and one current-conversation cache owns the route UUID.
   * Navigation churn then fails closed because an old turn and a new composer cannot agree.
   */
  function temporaryShellRouteConversation(queries, localId, section) {
    if (!localId?.startsWith('local-chatgpt:') || !section ||
        new URLSearchParams(location.search).get('temporary-chat') !== 'true') return null;
    const matched = location.pathname.match(/^\/c\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i);
    if (!matched) return null;
    const route = matched[1];
    const turnIds = new Set([...section.querySelectorAll('[data-chatgpt-selection-conversation-id]')]
      .map(node => str(node.getAttribute('data-chatgpt-selection-conversation-id'))).filter(Boolean));
    const composerIds = new Set([...document.querySelectorAll('[data-map-composer-conversation]')]
      .map(node => str(node.getAttribute('data-map-composer-conversation'))).filter(Boolean));
    if (turnIds.size !== 1 || !turnIds.has(localId) || composerIds.size !== 1 || !composerIds.has(localId)) return null;
    let owners = 0;
    for (const query of queries) {
      const server = shellQueryConversation(query);
      if (server === false) return null;
      if (server !== route) continue;
      const mapping = query?.state?.data?.mapping;
      if (!mapping || typeof mapping !== 'object') continue;
      owners++;
      if (owners > 1) return null;
    }
    return owners === 1 ? route : null;
  }

  /** Join a provisional shell id to a server id only when exact current-page evidence agrees. */
  function shellConversation(queries, localId, evidence, section) {
    if (evidence.conflict || !localId?.startsWith('local-chatgpt:')) return evidence;
    let found = evidence.conversationId;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'chatgpt-conversation-details' ||
          key[1]?.clientConversationId !== localId) continue;
      const server = key[1].serverConversationId;
      if (typeof server !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server)) continue;
      if (found && found !== server) return { conversationId: null, conflict: true };
      found = server;
    }
    const temporaryRoute = temporaryShellRouteConversation(queries, localId, section);
    if (temporaryRoute) {
      if (found && found !== temporaryRoute) return { conversationId: null, conflict: true };
      found = temporaryRoute;
    }
    return { conversationId: found, conflict: false };
  }

  /** The shell's current mounted mapping, fenced by this exact entry/turn/user object. */
  function shellLiveMapping(fiber, entry) {
    const user = entry.turn.items.find(item => item?.type === 'user-message');
    const userId = str(user?.messageId) || str(user?.serverMessageId);
    if (!userId) return null;
    const snapshots = new Map();
    const inspected = new WeakSet();
    const value = (object, key) => object && typeof object === 'object'
      ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    let conflict = false;
    const inspect = candidate => {
      if (!candidate || typeof candidate !== 'object' || inspected.has(candidate)) return;
      inspected.add(candidate);
      const conversation = value(candidate, 'renderedConversation'), turns = value(candidate, 'renderedTurns');
      const mapping = value(conversation, 'mapping');
      if (!mapping || !Array.isArray(turns) || turns.length > 4096 ||
          turns.filter(turn => turn?.id === entry.id && turn.turn === entry.turn).length !== 1) return;
      const node = value(mapping, userId), message = value(node, 'message');
      if (value(node, 'id') !== userId || value(message, 'id') !== userId || message.author?.role !== 'user') return;
      const prior = snapshots.get(mapping);
      if (prior && prior.renderedConversation.current_node !== conversation.current_node) conflict = true;
      snapshots.set(mapping, candidate);
    };
    let remaining = 2048;
    for (let at = fiber, up = 0; at && up < MAX_CLIMB && remaining > 0; up++, at = at.return) {
      if (at.memoizedProps?.conversationId !== entry.conversationId) continue;
      for (let hook = at.memoizedState; hook && remaining-- > 0; hook = hook.next) {
        const state = value(hook, 'memoizedState');
        inspect(state);
        if (Array.isArray(state)) inspect(state[0]);
      }
      const data = at.updateQueue?.memoCache?.data;
      if (!Array.isArray(data) || data.length > 32) continue;
      for (const row of data) {
        if (!Array.isArray(row) || row.length > 1024) continue;
        for (const item of row) { if (--remaining < 0) break; inspect(item); }
      }
    }
    return conflict || snapshots.size > 1 || remaining <= 0 ? false : snapshots.values().next().value || null;
  }

  function shellCurrentPath(snapshot, entry) {
    if (snapshot?.renderedTurns.at(-1)?.turn !== entry.turn) return [];
    const mapping = snapshot.renderedConversation.mapping, ids = [], seen = new Set();
    let id = snapshot.renderedConversation.current_node;
    for (let at = 0; at < MAX_NATIVE_PATH_NODES && typeof id === 'string' && id.length <= MAX_TEXT && !seen.has(id); at++) {
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) return [];
      seen.add(id);
      ids.push(id);
      if (message.author?.role === 'user') {
        const user = entry.turn.items.find(item => item?.type === 'user-message');
        return id === (user?.messageId || user?.serverMessageId) && entry.turn.messageIds.every(value => seen.has(value))
          ? ids.reverse() : [];
      }
      id = node.parent;
    }
    return [];
  }

  /**
   * One exact provider-owned terminal assistant record from a conversation mapping.
   *
   * This reader is intentionally narrower than the ordinary authored-text projection. It is
   * used only to corroborate the alternate shell's explicit `completed:false` anomaly, so every
   * field that grants terminal status must be an own data property. Accessors, multimodal rows,
   * missing routing, oversized text and any other native shape remain non-terminal.
   */
  function shellProviderTerminalAt(mapping, id) {
    try {
      const nodeDescriptor = mapping && typeof mapping === 'object'
        ? Object.getOwnPropertyDescriptor(mapping, id) : null;
      if (!nodeDescriptor) return undefined;
      if (!own.call(nodeDescriptor, 'value')) return null;
      const node = nodeDescriptor.value;
      const value = (object, key) => {
        const descriptor = object && typeof object === 'object'
          ? Object.getOwnPropertyDescriptor(object, key) : null;
        return descriptor && own.call(descriptor, 'value') ? descriptor.value : undefined;
      };
      const message = value(node, 'message'), author = value(message, 'author'), content = value(message, 'content');
      const parts = value(content, 'parts'), length = Array.isArray(parts) ? value(parts, 'length') : null;
      if (value(node, 'id') !== id || value(message, 'id') !== id || value(node, 'parent') == null ||
          value(author, 'role') !== 'assistant' || value(message, 'recipient') !== 'all' ||
          value(message, 'channel') !== 'final' || value(message, 'status') !== 'finished_successfully' ||
          value(message, 'end_turn') !== true || value(content, 'content_type') !== 'text' ||
          !Number.isSafeInteger(length) || length < 1 || length > MAX_ROWS) return null;
      let text = '';
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(parts, String(index));
        if (!descriptor || !own.call(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
        if (index) text += '\n';
        text += descriptor.value;
        if (text.length > MAX_RENDERED_TEXT) return null;
      }
      const parent = value(node, 'parent');
      return text ? { id, parent, text } : null;
    } catch {
      return null;
    }
  }

  /**
   * Corroborate one typed-shell `completed:false` final with its exact current provider record.
   *
   * This is a second positive receipt, not an override of the typed flag: the current branch,
   * live entry object, server conversation, assistant id/text/parent, cache copies, every Core
   * result and every enclosing Code Mode result must all agree. Prose, a missing Stop button,
   * an older finished branch, or an unanswered tool can never cross this boundary.
   */
  function shellProviderTerminalMessageId(fiber, queries, shell, conversation, calls, codeModeCalls, rejects) {
    const candidate = shell.terminalCandidate;
    if (!candidate) return null;
    shellDiagnostic(rejects, 'assistantTerminalReceiptChecked');
    if (conversation.conflict || !conversation.conversationId || shell.entry.turn.status !== 'complete' ||
        calls.some(call => call.answered !== true) || codeModeCalls.some(call => call.answered !== true)) return null;
    let live;
    try { live = shellLiveMapping(fiber, shell.entry); } catch { return null; }
    if (!live || live === false) return null;
    const path = shellCurrentPath(live, shell.entry);
    if (path.length < 2 || path.at(-1) !== candidate.id) return null;
    const mapping = live.renderedConversation.mapping;
    const terminal = shellProviderTerminalAt(mapping, candidate.id);
    if (!terminal || terminal.text !== candidate.text || terminal.parent !== path.at(-2)) return null;
    const pathMessages = [];
    for (const id of path) {
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value;
      if (node?.id !== id || node.message?.id !== id) return null;
      pathMessages.push(node.message);
    }
    const codeReceipts = codeModeReceipts(pathMessages);
    if (shell.executionIds.some(id => codeReceipts.get(id) !== true)) return null;
    for (const cachedMapping of shellCachedMappings(queries, conversation.conversationId)) {
      const cached = shellProviderTerminalAt(cachedMapping, candidate.id);
      if (cached === undefined) continue;
      if (!cached || cached.text !== terminal.text || cached.parent !== terminal.parent) return null;
    }
    shellDiagnostic(rejects, 'assistantTerminalReceiptMatched');
    return candidate.id;
  }

  /** Recover request ids only from exact shell message ids and their mounted/cache mapping. */
  function shellRequestMetadata(fiber, queries, shell, conversation, sightings = [], rejects = null) {
    // Diagnostic-only provenance belongs to this selected native parent, never the page total.
    for (const call of shell.calls) call.identityRefusalReasons = [];
    // One first-failing proof gate per unanswered call, reset with this descriptor scan.
    // Diagnostic only: neither the counters nor their absence authorize completion.
    const completionReasons = new Map();
    const vetoReceiptChecks = new Map();
    const note = (call, reason) => {
      if (call.answered !== true && !completionReasons.has(call.messageId)) completionReasons.set(call.messageId, reason);
    };
    for (const call of shell.calls) {
      const reference = shell.callSources.get(call.messageId);
      if (reference && reference.completionMissing !== true) note(call, 'callCompletionVeto');
    }
    const report = () => {
      for (const call of shell.calls) if (call.answered !== true) {
        const reason = completionReasons.get(call.messageId) || 'callReceiptMissing';
        const vetoCount = rejects?.callCompletionVeto;
        shellDiagnostic(rejects, reason);
        if (reason === 'callCompletionVeto' && vetoCount < MAX_ROWS) {
          const reference = shell.callSources.get(call.messageId);
          shellDiagnostic(rejects, reference?.completionShape);
          shellDiagnostic(rejects, reference?.completionStatus);
          if (vetoReceiptChecks.has(call.messageId)) {
            shellDiagnostic(rejects, 'callVetoReceiptChecked');
            if (vetoReceiptChecks.get(call.messageId) === true) shellDiagnostic(rejects, 'callVetoReceiptMatched');
          }
        }
      }
    };
    const noMetadata = reason => {
      // A later mapping/cache contradiction invalidates any staged match, not its inspection.
      for (const id of vetoReceiptChecks.keys()) vetoReceiptChecks.set(id, false);
      for (const call of shell.calls) note(call, reason);
      report();
      return [];
    };
    if (conversation.conflict) return noMetadata('callReceiptConflict');
    const entry = shell.entry;
    const ids = entry.turn.messageIds;
    if (!Array.isArray(ids) || ids.length > MAX_ROWS || new Set(ids).size !== ids.length) return noMetadata('callReceiptConflict');
    let live;
    try { live = shellLiveMapping(fiber, entry); } catch { return noMetadata('callLiveMappingMissing'); }
    if (live === false) return noMetadata('callLiveMappingConflict');
    if (!conversation.conversationId && !live) return noMetadata('callLiveMappingMissing');
    const matches = conversation.conversationId ? queries.filter(query => Array.isArray(query?.queryKey) && query.queryKey.length === 2 &&
      query.queryKey[0] === 'chatgpt-conversation' && shellQueryConversation(query) === conversation.conversationId) : [];
    if (matches.length > 1) return noMetadata('callReceiptConflict');
    const data = matches[0]?.state?.data;
    if (data?.conversation_id && data.conversation_id !== conversation.conversationId) return noMetadata('callReceiptConflict');
    const mapping = live?.renderedConversation?.mapping || data?.mapping;
    if (!mapping || typeof mapping !== 'object') return noMetadata('callLiveMappingMissing');
    const selected = new Set(ids), invocationIds = new Set(), unprovedInvocations = new Set(), sourceCounts = new Map();
    const currentPath = shellCurrentPath(live, entry), currentIds = new Set(currentPath), completed = new Set();
    for (const reference of shell.callSources.values()) if (reference.id)
      sourceCounts.set(reference.id, (sourceCounts.get(reference.id) || 0) + 1);
    const nativeField = (object, key) => {
      const descriptor = object && typeof object === 'object'
        ? Object.getOwnPropertyDescriptor(object, key) : null;
      return descriptor && own.call(descriptor, 'value') ? descriptor.value : undefined;
    };
    const messageAt = id => {
      const node = id && Object.getOwnPropertyDescriptor(mapping, id)?.value;
      return node?.id === id && node.message?.id === id ? node.message : null;
    };
    // Diagnose the selected provider invocation independently of its widget/result.
    // This counts only exact native message ids, never guesses attribution or completion.
    let selectedRequestIdsPresent = 0, selectedRequestIdsMissing = 0;
    for (const call of shell.calls) {
      if (!selected.has(call.messageId)) continue;
      const message = messageAt(call.messageId);
      if (!message || nativeField(nativeField(message, 'author'), 'role') !== 'assistant' ||
          nativeField(message, 'recipient') !== 'api_tool.call_tool') continue;
      const requestId = str(nativeField(nativeField(message, 'metadata'), 'request_id'));
      if (requestId) {
        selectedRequestIdsPresent++;
        shellDiagnostic(rejects, 'callRequestIdPresent');
      } else {
        selectedRequestIdsMissing++;
        shellDiagnostic(rejects, 'callRequestIdMissing');
      }
    }
    // A typed call can exist before ChatGPT mounts its result widget. Its request id
    // still joins to the exact MCP ingress, independently of whether it has finished.
    // Prove that id against this turn's native invocation and parent chain. Never let
    // this identity-only path satisfy the separate result/completion receipt gate.
    const typedUsers = shell.entry.turn.items.filter(item => item?.type === 'user-message');
    // A virtualized shell can omit its typed user item while retaining the exact
    // selected provider ids. Recover identity only when one concrete conversation
    // cache holds exactly one selected native user; never synthesize its text, a
    // user message or a turn start. The call's own native scope/parent walk below
    // still has to reach this very user before its request id is published.
    const selectedNativeUser = () => {
      if (typedUsers.length !== 0 || !conversation.conversationId || matches.length !== 1) return null;
      try {
        let found = null;
        for (const id of ids) {
          if (!str(id)) continue;
          const node = nativeField(mapping, id), message = nativeField(node, 'message');
          if (nativeField(node, 'id') !== id || nativeField(message, 'id') !== id ||
              nativeField(nativeField(message, 'author'), 'role') !== 'user') continue;
          if (found) return null;
          found = id;
        }
        return found;
      } catch { return null; }
    };
    const typedUserId = typedUsers.length === 1
      ? str(typedUsers[0].messageId) || str(typedUsers[0].serverMessageId) : selectedNativeUser();
    // Rendered entry IDs and native working/exchange IDs can use different namespaces.
    // Use a native namespace only when an independent, exact current final anchors
    // the entire mounted selected branch back to this typed native user. This
    // recovers request identity only; every result/Code Mode receipt is still
    // checked separately below before a call can become answered.
    const mountedNativeScope = (() => {
      if (!shell.calls.length || !live || !typedUserId || entry.turn.status !== 'complete' || !currentPath.length ||
          currentPath[0] !== typedUserId || !currentPath.every(id => selected.has(id))) return null;
      try {
        const finals = entry.turn.items.filter(item => item?.type === 'assistant-message' && item.phase === 'final_answer');
        if (finals.length !== 1) return null;
        const finalId = str(finals[0].messageId);
        if (!finalId || currentPath.at(-1) !== finalId) return null;
        const terminal = shellProviderTerminalAt(mapping, finalId);
        if (!terminal || shellItemText(finals[0]) !== terminal.text) return null;
        const finalMeta = nativeField(messageAt(finalId), 'metadata');
        const working = str(nativeField(finalMeta, 'working_turn_id'));
        const exchange = str(nativeField(finalMeta, 'turn_exchange_id'));
        if (!working || !exchange) return null;
        for (let at = 0; at < currentPath.length; at++) {
          const id = currentPath[at], node = nativeField(mapping, id), message = nativeField(node, 'message');
          if (nativeField(node, 'id') !== id || nativeField(message, 'id') !== id) return null;
          const role = nativeField(nativeField(message, 'author'), 'role');
          if (at === 0) { if (role !== 'user') return null; continue; }
          const metadata = nativeField(message, 'metadata');
          const cachedNode = nativeField(nativeField(data, 'mapping'), id);
          if (cachedNode && cachedNode !== node) {
            const cachedMessage = nativeField(cachedNode, 'message'), cachedMeta = nativeField(cachedMessage, 'metadata');
            if (nativeField(cachedNode, 'id') !== id || nativeField(cachedMessage, 'id') !== id ||
                nativeField(cachedNode, 'parent') !== nativeField(node, 'parent') ||
                ['parent_id', 'working_turn_id', 'turn_exchange_id', 'request_id'].some(key =>
                  nativeField(cachedMeta, key) !== nativeField(metadata, key))) return null;
          }
          if ((role !== 'assistant' && role !== 'tool') ||
              nativeField(node, 'parent') !== currentPath[at - 1] ||
              nativeField(metadata, 'parent_id') !== currentPath[at - 1] ||
              str(nativeField(metadata, 'working_turn_id')) !== working ||
              str(nativeField(metadata, 'turn_exchange_id')) !== exchange) return null;
        }
        return { working, exchange };
      } catch { return null; }
    })();
    const expectedWorkingTurn = mountedNativeScope?.working || shell.turnId;
    const expectedTurnExchange = mountedNativeScope?.exchange || typedUserId;
    const typedExecIds = new Set(shell.executionIds);
    // A parent can be visited by many selected calls. Cache only its allowlisted path
    // during this synchronous scan, never args or a result across provider mutations.
    const requestPaths = new WeakMap();
    const nativeRequestPath = message => {
      if (!message || typeof message !== 'object') return null;
      if (requestPaths.has(message)) return requestPaths.get(message);
      const path = requestPath(nativeField(nativeField(message, 'content'), 'text'));
      requestPaths.set(message, path);
      return path;
    };
    // Per-scan, bounded reason counts for the existing result-reference diagnostic. These
    // values are fixed enum names/counts only; the native IDs stay local to this scan.
    const identityRefusalReasons = {
      currentQuestionMissing: 0, currentQuestionUnselected: 0, currentQuestionConflict: 0,
      nativeInvocationMissing: 0, nativeInvocationMismatch: 0, requestIdMissing: 0,
      decodedPathMissing: 0, decodedPathForeign: 0, serverMissing: 0, serverMismatch: 0,
      toolMismatch: 0, workingTurnMissing: 0, workingTurnMismatch: 0,
      turnExchangeMissing: 0, turnExchangeMismatch: 0, nativeAncestryUnproved: 0,
      priorRequestIdMissing: 0, priorRequestIdMismatch: 0, priorResultResourceIncomplete: 0,
      priorToolScopeMismatch: 0
    };
    const identityRefusalByCall = new Map();
    let identityRefusalCalls = 0;
    const recordIdentityRefusal = (call, reasons) => {
      let seen = identityRefusalByCall.get(call.messageId);
      if (!seen) {
        seen = new Set();
        identityRefusalByCall.set(call.messageId, seen);
        identityRefusalCalls = Math.min(MAX_CALLS, identityRefusalCalls + 1);
      }
      for (const reason of reasons) {
        if (!own.call(identityRefusalReasons, reason) || seen.has(reason)) continue;
        seen.add(reason);
        identityRefusalReasons[reason] = Math.min(MAX_CALLS, identityRefusalReasons[reason] + 1);
      }
      call.identityRefusalReasons = [...seen];
    };
    const unreferencedInvocation = call => {
      const refuse = (reason, details = ['nativeAncestryUnproved']) => {
        shellDiagnostic(rejects, reason);
        recordIdentityRefusal(call, details);
        return false;
      };
      if (!typedUserId || !selected.has(typedUserId)) return refuse('callIdentityUserUnproved', [
        typedUserId ? 'currentQuestionUnselected' : 'currentQuestionMissing'
      ]);
      if (mountedNativeScope && (!selected.has(call.messageId) || !currentIds.has(call.messageId)))
        return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
      // The provider's optional mapping can contain accessors or malformed branches.
      // Only inspect own data fields and refuse that identity without losing this turn.
      try {
        const nodeAt = id => {
          const node = nativeField(mapping, id), message = nativeField(node, 'message');
          return nativeField(node, 'id') === id && nativeField(message, 'id') === id
            ? { node, message } : null;
        };
        const invocation = nodeAt(call.messageId)?.message;
        if (!invocation) return refuse('callIdentityNativeUnproved', ['nativeInvocationMissing']);
        const author = nativeField(invocation, 'author'), metadata = nativeField(invocation, 'metadata');
        const path = nativeRequestPath(invocation);
        const server = ownServerName(shell.callSources.get(call.messageId)?.server);
        const requestId = str(nativeField(metadata, 'request_id'));
        const workingTurn = str(nativeField(metadata, 'working_turn_id'));
        const turnExchange = str(nativeField(metadata, 'turn_exchange_id'));
        const pathServerMatches = nativeRequestServerMatches(path, server);
        const scopeReasons = [];
        if (nativeField(author, 'role') !== 'assistant' || nativeField(invocation, 'recipient') !== 'api_tool.call_tool')
          scopeReasons.push('nativeInvocationMismatch');
        if (!requestId) scopeReasons.push('requestIdMissing');
        if (!path) scopeReasons.push('decodedPathMissing');
        else if (!ourPath(path)) scopeReasons.push('decodedPathForeign');
        if (!server) scopeReasons.push('serverMissing');
        if (path && server && !pathServerMatches) scopeReasons.push('serverMismatch');
        if (path && toolName(path) !== call.tool) scopeReasons.push('toolMismatch');
        if (workingTurn !== expectedWorkingTurn) scopeReasons.push(workingTurn ? 'workingTurnMismatch' : 'workingTurnMissing');
        if (turnExchange !== expectedTurnExchange) scopeReasons.push(turnExchange ? 'turnExchangeMismatch' : 'turnExchangeMissing');
        if (scopeReasons.length) return refuse('callIdentityScopeUnproved', scopeReasons);
        // Later calls can follow a *previous* native tool result, whose parent is
        // its own invocation. This does not establish either call's completion: it
        // establishes only that the new call belongs to the same exact user turn.
        // Require both halves of each previous pair to be selected, typed and
        // scoped; an arbitrary cached tool response cannot assign another chat.
        const visited = new Set();
        let sawTypedExec = false, sawExecResult = false;
        let previousToolResult = null;
        let priorPairs = 0;
        let id = call.messageId;
        for (let depth = 0; depth < MAX_NATIVE_PATH_NODES && id && !visited.has(id); depth++) {
          visited.add(id);
          const row = nodeAt(id);
          if (!row) return refuse('callIdentityNativeUnproved', ['nativeAncestryUnproved']);
          const rowAuthor = nativeField(row.message, 'author'), rowMeta = nativeField(row.message, 'metadata');
          const role = nativeField(rowAuthor, 'role'), recipient = nativeField(row.message, 'recipient');
          if (id === typedUserId) {
            if (role !== 'user') return refuse('callIdentityParentUnproved', ['currentQuestionConflict']);
            if (previousToolResult !== null || (sawExecResult && !sawTypedExec))
              return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
            shellDiagnostic(rejects, 'callIdentityRecovered');
            if (priorPairs > 0) shellDiagnostic(rejects, 'callIdentityPriorPair');
            return true;
          }
          if (id !== call.messageId) {
            const isExec = role === 'assistant' && recipient === 'functions.exec' && typedExecIds.has(id);
            const isExecResult = role === 'tool' && nativeField(rowAuthor, 'name') === 'functions.exec' &&
              recipient === 'all';
            const isPreviousResult = role === 'tool' && nativeField(rowAuthor, 'name') === 'api_tool.call_tool' &&
              recipient === 'all' && selected.has(id) && previousToolResult === null;
            const priorCall = shell.calls.find(entry => entry.messageId === id);
            const previousPath = nativeRequestPath(row.message);
            const priorServer = ownServerName(shell.callSources.get(id)?.server);
            const previousServerMatches = nativeRequestServerMatches(previousPath, priorServer);
            const isPreviousInvocation = previousToolResult !== null && role === 'assistant' &&
              recipient === 'api_tool.call_tool' && selected.has(id) && Boolean(priorCall) &&
              previousPath && ourPath(previousPath) && priorServer && previousServerMatches &&
              toolName(previousPath) === priorCall.tool &&
              (!previousToolResult.resourceApp || ownServerName(previousToolResult.resourceApp) === priorServer) &&
              (!previousToolResult.resourceUri || (toolName(previousToolResult.resourceUri) === priorCall.tool &&
                linkIdOf(previousPath) && linkIdOf(previousPath) === linkIdOf(previousToolResult.resourceUri))) &&
              str(nativeField(rowMeta, 'request_id')) === previousToolResult.requestId;
            if (!isPreviousInvocation && previousToolResult !== null && role === 'assistant' &&
                recipient === 'api_tool.call_tool' && selected.has(id) && priorCall) {
              const previousScopeReasons = [];
              if (!previousPath) previousScopeReasons.push('decodedPathMissing');
              else if (!ourPath(previousPath)) previousScopeReasons.push('decodedPathForeign');
              if (!priorServer) previousScopeReasons.push('serverMissing');
              if (previousPath && priorServer && !previousServerMatches)
                previousScopeReasons.push('serverMismatch');
              if (previousPath && toolName(previousPath) !== priorCall.tool) previousScopeReasons.push('toolMismatch');
              if (previousToolResult.resourceApp && (!priorServer ||
                  ownServerName(previousToolResult.resourceApp) !== priorServer))
                previousScopeReasons.push('priorToolScopeMismatch');
              if (previousToolResult.resourceUri && !(toolName(previousToolResult.resourceUri) === priorCall.tool &&
                  linkIdOf(previousPath) && linkIdOf(previousPath) === linkIdOf(previousToolResult.resourceUri)))
                previousScopeReasons.push('priorToolScopeMismatch');
              const priorRequestId = str(nativeField(rowMeta, 'request_id'));
              if (!priorRequestId) previousScopeReasons.push('priorRequestIdMissing');
              else if (priorRequestId !== previousToolResult.requestId) previousScopeReasons.push('priorRequestIdMismatch');
              return refuse('callIdentityParentUnproved', previousScopeReasons.length
                ? previousScopeReasons : ['nativeAncestryUnproved']);
            }
            if (!isExec && !isExecResult && !isPreviousResult && !isPreviousInvocation)
              return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
            if (previousToolResult !== null && !isPreviousInvocation)
              return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
            if (isExec) sawTypedExec = true;
            if (isExecResult) sawExecResult = true;
            const rowWorkingTurn = str(nativeField(rowMeta, 'working_turn_id'));
            const rowTurnExchange = str(nativeField(rowMeta, 'turn_exchange_id'));
            const rowScopeReasons = [];
            if (rowWorkingTurn !== expectedWorkingTurn)
              rowScopeReasons.push(rowWorkingTurn ? 'workingTurnMismatch' : 'workingTurnMissing');
            if (rowTurnExchange !== expectedTurnExchange)
              rowScopeReasons.push(rowTurnExchange ? 'turnExchangeMismatch' : 'turnExchangeMissing');
            if (rowScopeReasons.length) return refuse('callIdentityScopeUnproved', rowScopeReasons);
            if (isPreviousResult) {
              const requestId = str(nativeField(rowMeta, 'request_id'));
              if (!requestId) return refuse('callIdentityScopeUnproved', ['priorRequestIdMissing']);
              const resource = nativeField(rowMeta, 'invoked_resource');
              const resourceApp = resource === undefined ? null : str(nativeField(resource, 'app_name'));
              const resourceUri = resource === undefined ? null : str(nativeField(resource, 'resource_uri'));
              if (resource !== undefined && (!resourceApp || !resourceUri))
                return refuse('callIdentityScopeUnproved', ['priorResultResourceIncomplete']);
              previousToolResult = { requestId, resourceApp, resourceUri };
            } else if (isPreviousInvocation) { previousToolResult = null; priorPairs++; }
          }
          const parent = str(nativeField(row.node, 'parent'));
          if (!parent || str(nativeField(rowMeta, 'parent_id')) !== parent)
            return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
          id = parent;
        }
      } catch { return refuse('callIdentityNativeUnproved', ['nativeAncestryUnproved']); }
      return refuse('callIdentityParentUnproved', ['nativeAncestryUnproved']);
    };
    const codeReceipts = codeModeReceipts(currentPath.map(messageAt));
    const conflictingResultParents = conflictingCoreResultParents(currentPath.map(messageAt));
    const codeContexts = new Map(), openExecutions = [];
    let codeParentsCoherent = true;
    for (const id of currentPath) {
      const message = messageAt(id), node = Object.getOwnPropertyDescriptor(mapping, id)?.value;
      const asked = message?.author?.role === 'assistant' && message.recipient === 'functions.exec';
      const returned = message?.author?.role === 'tool' && message.author.name === 'functions.exec' && message.recipient === 'all';
      if (asked || returned) codeParentsCoherent = codeParentsCoherent &&
        !!str(node.parent) && str(message.metadata?.parent_id) === node.parent;
      if (asked) openExecutions.push(id);
      // Only a concretely received enclosing result before the child can close this
      // structural context. Unknown intermediates or conflicting scopes do not make
      // an invocation ordinary merely because the metadata resolver could not join it.
      else if (returned && codeParentsCoherent && codeReceipts.get(id) === true) openExecutions.pop();
      codeContexts.set(id, openExecutions.slice());
    }
    for (const id of shell.executionIds) {
      const message = messageAt(id);
      if (message?.author?.role === 'assistant' && message.recipient === 'functions.exec') invocationIds.add(id);
    }
    const serverName = name => ownServerName(name);
    // Diagnostics may inspect only ordinary data fields. An unknown/accessor-backed native
    // shape stays uninspected; optional counters never evaluate extra page getters.
    const dataFields = (object, keys) => {
      if (!object || typeof object !== 'object') return false;
      try { return keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor ? own.call(descriptor, 'value') : !(key in object);
      }); } catch { return false; }
    };
    const missingReferenceCalls = shell.calls.filter(call => {
      const reference = shell.callSources.get(call.messageId);
      return reference && !reference.id && reference.referenceMissing;
    });
    const traceNativeReferenceRecovery = () => {
      try {
        const missing = missingReferenceCalls;
        if (missing.length || identityRefusalCalls) {
          const now = Date.now();
          if (now - nativeReferenceTraceAt >= 60_000) {
            nativeReferenceTraceAt = now;
            nativeReferenceTraceKeys.clear();
          }
          const nativeCalls = missing.filter(call => {
            const node = nativeField(mapping, call.messageId), message = nativeField(node, 'message');
            return nativeField(nativeField(message, 'author'), 'role') === 'assistant' &&
              nativeField(message, 'recipient') === 'api_tool.call_tool';
          }).length;
          // Shape-only custody diagnostics distinguish an absent native result
          // from a returned result whose post-commit witness did not survive the
          // provider transport. Never export result text, ids, paths or tokens.
          const resultParents = new Map();
          const resultShapes = { identity: 0, status: 0, parts: 0, content: 0, oversized: 0, json: 0, structured: 0, envelope: 0, receipt: 0, valid: 0 };
          let selectedToolResults = 0, witnessedToolResults = 0;
          for (const id of currentPath) {
            const node = nativeField(mapping, id), message = nativeField(node, 'message');
            if (nativeField(nativeField(message, 'author'), 'role') !== 'tool') continue;
            selectedToolResults++;
            const witnessed = Boolean(coreResultReceipt(message, resultShapes));
            if (witnessed) witnessedToolResults++;
            const parents = new Set([nativeField(node, 'parent'),
              nativeField(nativeField(message, 'metadata'), 'parent_id')].filter(value => typeof value === 'string'));
            for (const parent of parents) {
              const count = resultParents.get(parent) || { children: 0, witnesses: 0 };
              count.children++;
              if (witnessed) count.witnesses++;
              resultParents.set(parent, count);
            }
          }
          const missingWithChild = missing.filter(call => resultParents.has(call.messageId)).length;
          const missingWithWitness = missing.filter(call => resultParents.get(call.messageId)?.witnesses === 1).length;
          const shape = { diagnosticVersion: 4, typedCalls: shell.calls.length,
            missingReferences: missing.length, liveMapping: Boolean(live), currentPathNodes: currentPath.length,
            selectedMissingCalls: missing.filter(call => selected.has(call.messageId)).length,
            nativeMissingCalls: nativeCalls, typedUserPresent: Boolean(typedUserId),
            typedUserSelected: Boolean(typedUserId && selected.has(typedUserId)),
            selectedRequestIdsPresent, selectedRequestIdsMissing, identityRefusalCalls,
            selectedToolResults, witnessedToolResults, missingWithChild, missingWithWitness };
          const key = [shape.typedCalls, shape.missingReferences, shape.liveMapping, shape.currentPathNodes,
            shape.selectedMissingCalls, shape.nativeMissingCalls, shape.typedUserPresent, shape.typedUserSelected,
            selectedRequestIdsPresent, selectedRequestIdsMissing, identityRefusalCalls,
            ...Object.values(identityRefusalReasons), selectedToolResults, witnessedToolResults,
            missingWithChild, missingWithWitness, ...Object.values(resultShapes)].join(':');
          if (!nativeReferenceTraceKeys.has(key) && nativeReferenceTraceKeys.size < MAX_TURNS) {
            nativeReferenceTraceKeys.add(key);
            console.info('[Chat On Steroids] native result-reference recovery diagnostic' +
              ` version=4 calls=${shape.typedCalls} missing=${shape.missingReferences}` +
              ` liveMapping=${shape.liveMapping} pathNodes=${shape.currentPathNodes}` +
              ` selectedCalls=${shape.selectedMissingCalls} nativeCalls=${shape.nativeMissingCalls}` +
              ` typedUser=${shape.typedUserPresent} selectedUser=${shape.typedUserSelected}` +
              ` requestIdPresent=${selectedRequestIdsPresent} requestIdMissing=${selectedRequestIdsMissing}` +
              ` identityRefusals=${identityRefusalCalls} nativeScope=${Boolean(mountedNativeScope)}` +
              ` identityReasons=${Object.entries(identityRefusalReasons).map(([kind, count]) => kind + ":" + count).join(',')}` +
              ` selectedResults=${selectedToolResults} witnessedResults=${witnessedToolResults}` +
              ` missingWithChild=${missingWithChild} missingWithWitness=${missingWithWitness}` +
              ` resultShapes=${Object.entries(resultShapes).map(([kind, count]) => kind + ":" + count).join(",")}`);
          }
        }
      } catch { /* Optional diagnostics cannot change completion or inspect an unsupported getter. */ }
    };
    // A folded widget can omit its result pointer after the provider committed the result.
    // Recover only a single actual child of this exact invocation on the complete mounted
    // question path. This supplies a pointer to the SAME conjunction below, never completion
    // by request id, tool name, neighboring prose or a scan of unrelated cached branches.
    for (const call of shell.calls) {
      const reference = shell.callSources.get(call.messageId);
      if (!reference || reference.id || !reference.referenceMissing || !live ||
          !currentIds.has(call.messageId)) continue;
      const children = currentPath.filter(id => {
        const node = nativeField(mapping, id), message = nativeField(node, 'message');
        return nativeField(nativeField(message, 'author'), 'role') === 'tool' &&
          (nativeField(node, 'parent') === call.messageId ||
            nativeField(nativeField(message, 'metadata'), 'parent_id') === call.messageId);
      });
      if (children.length !== 1 || sourceCounts.has(children[0])) continue;
      // An absent widget is a stronger uncertainty than an omitted completion flag. Require
      // the existing post-commit opaque witness too; Main still owns its durable validation.
      const childNode = nativeField(mapping, children[0]);
      const childMessage = nativeField(childNode, 'message');
      if (!coreResultReceipt(childMessage) || !unreferencedInvocation(call)) continue;
      reference.id = children[0];
      sourceCounts.set(reference.id, 1);
      selected.add(reference.id);
    }
    for (const call of shell.calls) {
      const reference = shell.callSources.get(call.messageId);
      if (!reference?.id || !selected.has(reference.id) || sourceCounts.get(reference.id) !== 1) {
        // An unselected result widget is no better authority for the selected
        // invocation than a missing widget. Both must prove the same native
        // user/parent chain before its request id can reach the recorder. An
        // actual *conflict* between two widget owners remains unproved.
        if ((!reference?.id || sourceCounts.get(reference.id) === 1) && unreferencedInvocation(call))
          invocationIds.add(call.messageId);
        else unprovedInvocations.add(call.messageId);
        shellDiagnostic(rejects, !reference?.id ? 'callJoinReferenceMissing'
          : !selected.has(reference.id) ? 'callJoinReferenceUnselected' : 'callJoinReferenceConflict');
        note(call, reference?.id && sourceCounts.get(reference.id) > 1 ? 'callReceiptConflict' : 'callReceiptMissing');
        continue;
      }
      const result = messageAt(reference.id);
      if (result?.author?.role !== 'tool') {
        shellDiagnostic(rejects, result ? 'callJoinResultIdentity' : 'callJoinResultMissing');
        note(call, result ? 'callReceiptConflict' : 'callReceiptMissing'); continue;
      }
      const resource = resultOf(result);
      const invocation = messageAt(call.messageId);
      const path = requestOf(invocation)?.path, server = serverName(reference.server);
      const invocationNode = Object.getOwnPropertyDescriptor(mapping, call.messageId)?.value;
      const resultNode = Object.getOwnPropertyDescriptor(mapping, reference.id)?.value;
      const enclosing = codeContexts.get(call.messageId) || [];
      // One unchanged receipt conjunction owns both omitted-flag completion and shape-only
      // veto diagnostics. The latter never adds a call to `completed` or changes `answered`.
        const finishedReceiptMatches = () => currentIds.has(call.messageId) && currentIds.has(reference.id) &&
        invocation?.status === 'finished_successfully' && result.status === 'finished_successfully' &&
        invocation.recipient === 'api_tool.call_tool' && path &&
        serverName(path.slice(1, path.indexOf('/', 1))) === server && toolName(path) === call.tool &&
        result.author.name === 'api_tool.call_tool' && result.recipient === 'all' &&
        server && resource && ownResult(resource) && path && ourPath(path) &&
        serverName(resource.app) === server && toolName(resource.resource) === call.tool &&
        linkIdOf(path) && linkIdOf(path) === linkIdOf(resource.resource) &&
        resultNode.parent === call.messageId && str(result.metadata?.parent_id) === call.messageId &&
        invocationNode.parent && str(invocation.metadata?.parent_id) === invocationNode.parent &&
        ['request_id', 'working_turn_id', 'turn_exchange_id'].every(key =>
          str(invocation.metadata?.[key]) && invocation.metadata[key] === result.metadata?.[key]) &&
        codeParentsCoherent && enclosing.every(id => codeReceipts.get(id) === true) &&
          (!(enclosing.length || codeReceipts.has(call.messageId)) || codeReceipts.get(call.messageId) === true);
        // A typed shell may expose the actual returned tool result only through
        // its referenced mapping entry. Never infer ownership from workflow ID,
        // nearest sibling, a completed flag or an unselected widget.
        const safeReceiptShape = dataFields(invocation, ['status', 'recipient', 'metadata']) &&
          dataFields(result, ['status', 'author', 'recipient', 'metadata']) &&
          dataFields(result.author, ['name']) && dataFields(invocationNode, ['parent']) && dataFields(resultNode, ['parent']) &&
          dataFields(invocation.metadata, ['parent_id', 'request_id', 'working_turn_id', 'turn_exchange_id']) &&
          dataFields(result.metadata, ['parent_id', 'request_id', 'working_turn_id', 'turn_exchange_id']);
        const exactFinishedReceipt = safeReceiptShape && finishedReceiptMatches() &&
          !conflictingResultParents.has(call.messageId);
        const nativeReceipt = exactFinishedReceipt ? coreResultReceipt(result) : null;
        if ((completionReasons.get(call.messageId) !== 'callCompletionVeto' || reference.completionRecoverable) &&
            exactFinishedReceipt) {
          if (nativeReceipt) call.resultReceiptId = nativeReceipt;
        }
      if (completionReasons.get(call.messageId) === 'callCompletionVeto') {
        if (dataFields(invocation, ['status', 'recipient', 'metadata']) && dataFields(result, ['status', 'author', 'recipient', 'metadata']) &&
            dataFields(result.author, ['name']) && dataFields(invocationNode, ['parent']) && dataFields(resultNode, ['parent']) &&
            dataFields(invocation.metadata, ['parent_id', 'request_id', 'working_turn_id', 'turn_exchange_id']) &&
            dataFields(result.metadata, ['parent_id', 'request_id', 'working_turn_id', 'turn_exchange_id'])) {
          try { vetoReceiptChecks.set(call.messageId, Boolean(finishedReceiptMatches())); }
          catch { shellDiagnostic(rejects, 'callJoinDescriptorUnsupported'); }
        } else shellDiagnostic(rejects, 'callJoinDescriptorUnsupported');
      }
      if (resource && (serverName(resource.app) !== serverName(reference.server) || toolName(resource.resource) !== call.tool)) {
        note(call, 'callScopeConflict');
        continue;
      }
      if (invocation) {
        const asked = requestOf(invocation), path = asked?.path;
        if (invocation.recipient !== 'api_tool.call_tool' || !path ||
            serverName(path.slice(1, path.indexOf('/', 1))) !== serverName(reference.server) || toolName(path) !== call.tool) {
          note(call, 'callScopeConflict');
          continue;
        }
        for (const key of ['request_id', 'working_turn_id', 'turn_exchange_id']) {
          const a = str(invocation.metadata?.[key]), b = str(result.metadata?.[key]);
          if (a && b && a !== b) return noMetadata('callScopeConflict');
        }
        invocationIds.add(call.messageId);
      }
      reference.metadataId = reference.id;
      // Some typed steps omit `completed` or retain the initial false projection. Only
      // the exact finished native invocation/result can resolve those projections; a typed
      // pending/error status, malformed value or getter remains a veto. The
      // current mounted path, not a final answer or a cached result in another branch,
      // supplies the question/call/result relationship. Keep the enclosing Code Mode
      // receipt mandatory when this invocation belongs to functions.exec.
      if ((reference.completionMissing || (reference.completionRecoverable && nativeReceipt)) && exactFinishedReceipt) completed.add(call.messageId);
      else if (reference.completionMissing && call.answered !== true) {
        // Describe the existing conjunction's refusal without changing any proof gate.
        try { note(call, !live ? 'callLiveMappingMissing'
          : !currentIds.has(call.messageId) || !currentIds.has(reference.id) ? 'callPathMissing'
          : invocation?.status !== 'finished_successfully' || result.status !== 'finished_successfully' ? 'callNativePending'
          : result.author.name !== 'api_tool.call_tool' || result.recipient !== 'all' ? 'callReceiptConflict'
          : !server || !resource || !path ? 'callReceiptMissing'
          : !ownResult(resource) || !ourPath(path) || serverName(resource.app) !== server || toolName(resource.resource) !== call.tool ||
            !linkIdOf(path) || linkIdOf(path) !== linkIdOf(resource.resource) ||
            resultNode.parent !== call.messageId || str(result.metadata?.parent_id) !== call.messageId ||
            !invocationNode.parent || str(invocation.metadata?.parent_id) !== invocationNode.parent ||
            !['request_id', 'working_turn_id', 'turn_exchange_id'].every(key =>
              str(invocation.metadata?.[key]) && invocation.metadata[key] === result.metadata?.[key]) ? 'callScopeConflict'
          : 'callExecUnresolved'); }
        catch { note(call, 'callReceiptConflict'); }
      }
    }
    traceNativeReferenceRecovery();
    const out = [];
    for (const id of new Set([...ids, ...invocationIds, ...shellCurrentPath(live, entry)])) {
      // A selected native ID can precede its widget. Selection proves which
      // native row exists, not that the row belongs to this typed user: keep
      // its request key private until the same ancestry proof that admits the
      // unselected invocation has passed. Do not let the generic IDs loop
      // bypass a failed current-turn/parent/connector identity check.
      if (unprovedInvocations.has(id)) {
        if (selected.has(id)) shellDiagnostic(rejects, 'callIdentitySelectedWithheld');
        continue;
      }
      if (typeof id !== 'string' || !id || id.length > MAX_TEXT || !own.call(mapping, id)) continue;
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) continue;
      for (const sighting of sightingsOf([message])) if (sightings.length < 50 &&
        !sightings.some(prior => prior.requestId === sighting.requestId && prior.appId === sighting.appId)) sightings.push(sighting);
      const request = str(message.metadata?.request_id), cached = data?.mapping?.[id]?.message;
      if (live && cached?.id === id && request && cached.metadata?.request_id && cached.metadata.request_id !== request)
        return noMetadata('callReceiptConflict');
      out.push({ id, create_time: num(message.create_time), metadata: { request_id: request } });
    }
    // A result outside the turn's public IDs can still match its exact served request.
    const requests = new Set(out.map(entry => entry.metadata.request_id).filter(Boolean));
    const seen = new Set(sightings.map(entry => entry.requestId + ' ' + entry.appId));
    let visited = 0;
    for (const key in mapping) {
      if (++visited > 5000 || sightings.length >= 50 || !requests.size) break;
      if (!own.call(mapping, key)) continue;
      const node = Object.getOwnPropertyDescriptor(mapping, key)?.value, message = node?.message;
      if (node?.id !== key || message?.id !== key || !requests.has(str(message.metadata?.request_id))) continue;
      for (const sighting of sightingsOf([message])) {
        const identity = sighting.requestId + ' ' + sighting.appId;
        if (!seen.has(identity)) { seen.add(identity); sightings.push(sighting); }
      }
    }
    // Apply only after every mapping/cache contradiction check has passed.
    for (const call of shell.calls) if (completed.has(call.messageId)) call.answered = true;
    report();
    return out;
  }

  /**
   * Add only an explicitly referenced public shell source to the synthetic turn messages.
   *
   * The alternate shell can publish a final assistant item whose content is a
   * `chatgpt-content-reference`, while keeping the referenced text solely in the exact
   * conversation mapping. The normal shell item projection therefore sees the wrapper but
   * not its source. Resolve that one provider-owned edge without turning the conversation
   * mapping into a second transcript source:
   *
   * - the current public wrapper must name one exact source id;
   * - the mapping must belong to this exact mounted entry/conversation;
   * - the source must be finished public assistant text, never analysis/commentary/tool data;
   * - the cloned source is forced hidden so only the wrapper is emitted to the desktop.
   */
  function publicReferencedSource(source) {
    if (!source || typeof source !== 'object' || source.author?.role !== 'assistant') return false;
    if (requestOf(source) || resultOf(source) || thoughtMessage(source) || neverTerminalChannel(source)) return false;
    if (source.status && source.status !== 'finished_successfully') return false;
    // The current alternate shell omits `channel` on some finished public records. It still
    // carries the provider-owned public recipient. Never infer public visibility from an
    // absent channel alone: require either the explicit final channel or exact `all` recipient.
    if (source.channel !== 'final' && !(source.channel == null && source.recipient === 'all')) return false;
    return true;
  }

  /** Exact current-conversation mappings published under both observed query-key shapes. */
  function shellCachedMappings(queries, conversationId) {
    if (!conversationId) return [];
    const mappings = [];
    const seen = new Set();
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key[0] !== 'chatgpt-conversation') continue;
      const keyedConversation = shellQueryConversation(query);
      if (keyedConversation === false) continue;
      const data = query?.state?.data;
      const dataConversation = str(data?.conversation_id) || str(data?.conversationId) || str(data?.id);
      if (keyedConversation !== conversationId && dataConversation !== conversationId) continue;
      if (dataConversation && dataConversation !== conversationId) continue;
      const mapping = data?.mapping;
      if (!mapping || typeof mapping !== 'object' || seen.has(mapping)) continue;
      seen.add(mapping);
      mappings.push(mapping);
      if (mappings.length > 8) return [];
    }
    return mappings;
  }

  function shellMessagesWithReferencedSources(fiber, queries, shell, conversation) {
    const messages = shell.messages;
    if (!Array.isArray(messages) || conversation.conflict) return messages;
    const sourceIds = [];
    const seen = new Set();
    for (const message of messages) {
      const id = contentReferenceSourceId(message);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      sourceIds.push(id);
      if (sourceIds.length > MAX_CALLS) return messages;
    }
    if (sourceIds.length === 0) return messages;

    let live;
    try { live = shellLiveMapping(fiber, shell.entry); } catch { return messages; }
    if (live === false) return messages;
    const mappings = [];
    const seenMappings = new Set();
    const addMapping = mapping => {
      if (!mapping || typeof mapping !== 'object' || seenMappings.has(mapping)) return;
      seenMappings.add(mapping);
      mappings.push(mapping);
    };
    addMapping(live?.renderedConversation?.mapping);
    for (const mapping of shellCachedMappings(queries, conversation.conversationId)) addMapping(mapping);
    if (mappings.length === 0) return messages;

    const appended = [];
    for (const id of sourceIds) {
      const candidates = [];
      for (const mapping of mappings) {
        if (!own.call(mapping, id)) continue;
        const node = Object.getOwnPropertyDescriptor(mapping, id)?.value;
        const source = node?.message;
        if (node?.id !== id || source?.id !== id || !publicReferencedSource(source)) continue;
        const text = authoredText(source);
        if (!text || contentReferenceSourceId(source)) continue;
        candidates.push({ source, text });
      }
      if (candidates.length === 0) return messages;
      const text = candidates[0].text;
      if (candidates.some(candidate => candidate.text !== text)) return messages;
      const source = candidates[0].source;
      const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
      appended.push({
        ...source,
        metadata: { ...metadata, is_visually_hidden_from_conversation: true }
      });
    }
    return appended.length === sourceIds.length ? messages.concat(appended) : messages;
  }

  /** GPT-6's public DIL answer payload (upstream PR #1205, Haz4rdovisk).
   * Resolve only the item's exact self-reference; do not scrape a rendered error placeholder,
   * truncate a decision into a different answer, or import another message's/private payload.
   * Completion and turn ownership still come from shellTurnSource, never this text field.
   */
  function shellItemText(item) {
    const content = typeof item?.content === 'string' ? item.content : '';
    const id = str(item?.messageId);
    if (!id || item.type !== 'assistant-message' || item.phase !== 'final_answer' ||
        contentReferenceSourceId({ content: { content_type: 'text', parts: [content] } }) !== id) return content;
    const references = item.contentReferences;
    if (!Array.isArray(references) || references.length !== 1) return content;
    const reference = references[0], text = reference?.model_dil_v2?.fallbackMarkdown;
    if (reference?.type !== 'dil' || reference.source_message_id !== id ||
        typeof text !== 'string' || !text.trim() || text.length > MAX_RENDERED_TEXT ||
        /^\s*::chatgpt-content-reference\{/.test(text)) return content;
    return unescapeFallbackMarkdown(text);
  }

  // Upstream 78be0891: decode provider fallback punctuation, preserving fenced and inline code.
  function unescapeFallbackMarkdown(markdown) {
    let fence = null;
    return markdown.split('\n').map(line => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
        return line;
      }
      if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) { fence = marker; return line; }
      let out = '';
      for (let at = 0; at < line.length;) {
        const char = line[at];
        if (char === '\\' && /[!-\/:-@[-`{-~]/.test(line[at + 1] || '')) { out += line[at + 1]; at += 2; continue; }
        if (char === '`') {
          const run = /^`+/.exec(line.slice(at))[0];
          const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(line.slice(at + run.length));
          if (close) { const end = at + run.length + close.index + run.length; out += line.slice(at, end); at = end; continue; }
          out += run; at += run.length; continue;
        }
        out += char; at++;
      }
      return out;
    }).join('\n');
  }

  /** Translate the alternate shell's typed public items into the existing turn contract. */
  function shellDiagnostic(rejects, reason) {
    if (!rejects) return;
    // Optional capability counters only appear when observed.
    if (!Object.prototype.hasOwnProperty.call(rejects, reason)) {
      if (reason !== 'callRequestIdPresent' && reason !== 'callRequestIdMissing') return;
      rejects[reason] = 0;
    }
    rejects[reason] = Math.min(MAX_ROWS, rejects[reason] + 1);
  }

  function shellStableTurnId(entry, publicTurnKey) {
    const entryId = str(entry?.id), turnKey = str(publicTurnKey);
    if (!entryId || !turnKey) return null;
    if (entryId === turnKey) return entryId;
    // The live app shell currently keys an exchange by its exact native user-message id,
    // while the typed owner retains a distinct g-* turn id. Join only that one typed user
    // item; positional search/unit keys and a multi-user/discordant entry cannot authorize it.
    const users = entry.turn.items.filter(item => item?.type === 'user-message');
    if (users.length !== 1) return null;
    const messageId = str(users[0].messageId), serverMessageId = str(users[0].serverMessageId);
    if (messageId && serverMessageId && messageId !== serverMessageId) return null;
    return (messageId || serverMessageId) === turnKey ? entryId : null;
  }

  function shellTurnSource(fiber, section, turnId, rejects) {
    let entry = null;
    for (let at = fiber, up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      if (Array.isArray(at.memoizedProps?.entry?.turn?.items)) { entry = at.memoizedProps.entry; break; }
    }
    if (!entry) { shellDiagnostic(rejects, 'ownerMissing'); return null; }
    if (entry.turn.items.length > MAX_ROWS) { shellDiagnostic(rejects, 'itemsOverLimit'); return null; }
    const stableTurnId = shellStableTurnId(entry, turnId);
    if (!stableTurnId) { shellDiagnostic(rejects, 'stableKeyMismatch'); return null; }
    // Search-unit keys describe layout, including fallback-turn-N after a native reload.
    // They must not replace the exact stable turn identity proved against this Fiber entry.
    const layoutKey = str(section.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')) || turnId;
    const messages = [], calls = [], slots = [], seen = new Set(), callSources = new Map(), executionIds = [];
    let terminalCandidate = null;
    // Local fixed counts only; the original typed-user checks still own identity and prose.
    const userDiagnostics = { userTextEmpty: 0, userTextUnsupported: 0 };
    // The current shell can hoist a public commentary item out of its reasoning group.
    // Prefer that top-level item, where its rendered slot remains attributable.
    const topLevelAssistantIds = new Set(entry.turn.items
      .filter(item => item?.type === 'assistant-message')
      .map(item => str(item.messageId)).filter(Boolean));
    const remember = id => { if (!id || seen.has(id)) return false; seen.add(id); return true; };
    let work = 0;
    for (const [index, item] of entry.turn.items.entries()) {
      if (++work > MAX_ROWS) return null;
      if (item?.type === 'user-message' || item?.type === 'assistant-message') {
        const user = item.type === 'user-message';
        const id = str(item.messageId) || (user ? str(item.serverMessageId) : null);
        if (!id || !remember(id) || (user && item.serverMessageId && item.messageId && item.serverMessageId !== item.messageId)) {
          if (user) shellDiagnostic(rejects, 'userIdentityInvalid');
          return null;
        }
        const role = user ? 'user' : 'assistant', value = user ? item.message : shellItemText(item);
        if (user && typeof value !== 'string') userDiagnostics.userTextUnsupported++;
        else if (user && !value) userDiagnostics.userTextEmpty++;
        const final = !user && item.phase === 'final_answer';
        const completedValue = item.completed;
        const completed = final && completedValue === true && entry.turn.status === 'complete';
        if (final && completedValue === false && entry.turn.status === 'complete' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) &&
            typeof value === 'string' && value.length > 0 && value.length <= MAX_RENDERED_TEXT) {
          const descriptor = Object.getOwnPropertyDescriptor(item, 'completed');
          if (descriptor && own.call(descriptor, 'value') && descriptor.value === false)
            terminalCandidate = { id, text: value };
        }
        messages.push({
          id, author: { role }, content: { content_type: 'text', parts: [typeof value === 'string' ? value : ''] },
          channel: user ? null : final ? 'final' : 'commentary', end_turn: completed,
          status: completed ? 'finished_successfully' : 'in_progress', metadata: {}
        });
        const key = `${layoutKey}:${index}:${role}`;
        const nodes = [...section.querySelectorAll('[data-content-search-unit-key]')].filter(node =>
          node.closest('[data-turn-key]') === section && node.getAttribute('data-content-search-unit-key') === key);
        if (nodes.length === 1) slots.push({ node: nodes[0], id });
        continue;
      }
      const steps = item?.type === 'chatgpt-reasoning-group' && Array.isArray(item.items) ? item.items : [item];
      for (const step of steps) {
        if (++work > MAX_ROWS) return null;
        if (step?.type === 'assistant-message' && step !== item) {
          // Only these typed phases are known public output, never private analysis.
          // Nested text is progress evidence, not the final answer of this turn.
          if (step.phase !== 'final_answer' && step.phase !== 'commentary') continue;
          const id = str(step.messageId);
          if (!id || topLevelAssistantIds.has(id) || seen.has(id)) continue;
          const value = shellItemText(step);
          if (typeof value !== 'string' || !value.trim() || /^\s*::chatgpt-content-reference\{/.test(value)) continue;
          remember(id);
          messages.push({
            id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [value] },
            channel: 'commentary', end_turn: false,
            status: step.completed === true ? 'finished_successfully' : 'in_progress', metadata: {}
          });
          continue;
        }
        if (step?.type === 'dynamic-tool-call' && step.tool === 'exec') {
          const id = str(step.callId);
          if (!id || !remember(id) || executionIds.length >= MAX_CALLS) return null;
          executionIds.push(id);
          continue;
        }
        if (step?.type !== 'mcp-tool-call' || !ourApp(step.invocation?.server)) continue;
        const id = str(step.callId), tool = toolName(step.invocation?.tool);
        if (!id || !tool || !remember(id) || calls.length >= MAX_CALLS) return null;
        const completedProperty = Object.getOwnPropertyDescriptor(step, 'completed');
        const statusProperty = Object.getOwnPropertyDescriptor(step, 'status');
        const completedValue = completedProperty && own.call(completedProperty, 'value') ? completedProperty.value : undefined;
        const statusValue = statusProperty && own.call(statusProperty, 'value') ? statusProperty.value : undefined;
        const recoverableStatus = !statusProperty || (own.call(statusProperty, 'value') &&
          (statusValue === 'complete' || statusValue === 'finished_successfully'));
        const widgetProperty = Object.getOwnPropertyDescriptor(step, 'widgetStateSource');
        const widget = widgetProperty && own.call(widgetProperty, 'value') ? widgetProperty.value : undefined;
        const messageProperty = widget && typeof widget === 'object' ? Object.getOwnPropertyDescriptor(widget, 'messageId') : undefined;
        const referenceId = messageProperty && own.call(messageProperty, 'value') ? str(messageProperty.value) : null;
        const referenceMissing = !widgetProperty || (own.call(widgetProperty, 'value') &&
          (widget == null || (typeof widget === 'object' && (!messageProperty ||
            (own.call(messageProperty, 'value') && messageProperty.value == null)))));
        calls.push({ messageId: id, tool, order: calls.length, answered: completedValue === true, requestId: null, createTime: null });
        const reference = { id: referenceId, server: step.invocation.server, referenceMissing,
          completionMissing: !completedProperty && recoverableStatus,
          completionRecoverable: completedProperty && own.call(completedProperty, 'value') &&
            completedValue === false && recoverableStatus };
        // Optional metadata never evaluates accessors or changes the authority checks above.
        // Fixed buckets only: no private values or exceptions leave this producer.
        try {
          const completed = Object.getOwnPropertyDescriptor(step, 'completed');
          const status = Object.getOwnPropertyDescriptor(step, 'status');
          reference.completionShape = !completed ? 'callStatusVeto'
            : !own.call(completed, 'value') ? 'callCompletedMalformed'
            : completed.value === false ? 'callCompletedFalse'
            : completed.value === undefined ? 'callCompletedUndefined'
            : completed.value === null ? 'callCompletedNull' : 'callCompletedMalformed';
          const value = status && own.call(status, 'value') ? status.value : undefined;
          reference.completionStatus = !status ? 'callVetoStatusAbsent'
            : ['in_progress', 'pending', 'running'].includes(value) ? 'callVetoStatusPending'
            : value === 'error' ? 'callVetoStatusError'
            : value === 'done' ? 'callVetoStatusDone'
            : value === 'final' ? 'callVetoStatusFinal'
            : value === 'completed' ? 'callVetoStatusCompleted'
            : value === 'complete' ? 'callVetoStatusComplete'
            : value === 'finished' ? 'callVetoStatusFinished'
            : value === 'finished_successfully' ? 'callVetoStatusFinishedSuccessfully' : 'callVetoStatusUnknown';
        } catch {
          reference.completionShape = 'callCompletedMalformed';
          reference.completionStatus = 'callVetoStatusUnknown';
        }
        callSources.set(id, reference);
      }
    }
    return { entry, turnId: stableTurnId, messages, calls, slots, callSources, executionIds, terminalCandidate, userDiagnostics };
  }

  /**
   * Whether a node belongs to an earlier page ChatGPT keeps mounted but undisplayed in this tab.
   * After a Project resume the tab still holds the source chat that way; its turns name the
   * source conversation and must not be read as this page's (same rule as chatgpt-dom.js).
   */
  function onKeptPage(node) {
    for (let page = node?.closest?.('[data-app-shell-page-surface]'); page;
      page = page.parentElement?.closest('[data-app-shell-page-surface]')) {
      if (getComputedStyle(page).display === 'none') return true;
    }
    return false;
  }

  /**
   * The per-turn call evidence for the assistant turns currently on screen.
   *
   * Read from the turn sections rather than from the connector rows, because the case this
   * exists for is the turn that rendered *no* row: climbing from a row cannot reach a turn
   * that has none, which is exactly the turn whose calls went missing.
   */
  function turnsOf(scanToken, shellScan) {
    const out = [];
    let sections;
    try {
      sections = [...document.querySelectorAll(TURN_SECTION)].filter(section => {
        if (onKeptPage(section)) return false;
        return !section.matches?.(SHELL_TURN) ||
          !section.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`);
      });
    } catch {
      return out;
    }
    // A descriptor index is valid for one scan only. Stale stamps must disappear when a
    // still-mounted section becomes unreadable, but clearing every stamp up front is not
    // harmless: these attributes are observed by the isolated-world MutationObserver, so
    // remove+restore on every scan creates a self-sustaining scan/mutation loop. Build the
    // desired stamp set first, then change only attributes whose value actually differs.
    const desiredTurnStamps = new Map();
    const desiredMessageStamps = new Map();
    // An exchange whose user slot the shell did not render (see below, `data-clf-fiber-user`).
    const desiredUserStamps = new Map();
    const groups = [];
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      const shellSection = section.matches?.(SHELL_TURN) === true;
      const shellTurnKey = shellSection ? str(section.getAttribute('data-turn-key')) : null;
      const id = shellSection
        ? shellTurnKey && !/^fallback-turn-\d+$/.test(shellTurnKey) ? shellTurnKey
          : str(section.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key'))
        : str(section.getAttribute('data-turn-id'));
      const previous = groups[groups.length - 1];
      if (id && previous && previous.turnId === id && previous.shellSection === shellSection) previous.sections.push(section);
      else groups.push({ turnId: id, shellSection, sections: [section] });
    }
    const first = Math.max(0, groups.length - MAX_TURNS);
    const responseBudget = { remaining: MAX_RESPONSE_TEXT };
    for (let at = first; at < groups.length; at++) {
      const group = groups[at];
      const section = group.sections[0];
      let turnSections = group.sections;
      let entry = null;
      try {
        const shellSection = group.shellSection;
        if (shellSection) shellScan.selectorMatches = Math.min(MAX_ROWS, shellScan.selectorMatches + 1);
        const fiber = fiberOf(section);
        if (!fiber) {
          if (shellSection) shellDiagnostic(shellScan.rejects, 'fiberMissing');
          continue;
        }
        const shell = shellSection ? shellTurnSource(fiber, section, group.turnId, shellScan.rejects) : null;
        if (shellSection && !shell) continue;
        if (shell) shellScan.mapped = Math.min(MAX_ROWS, shellScan.mapped + 1);
        if (shell && group.sections.length > 1) {
          turnSections = [section];
          for (const candidate of group.sections.slice(1)) {
            shellScan.selectorMatches = Math.min(MAX_ROWS, shellScan.selectorMatches + 1);
            const candidateFiber = fiberOf(candidate);
            if (!candidateFiber) { shellDiagnostic(shellScan.rejects, 'fiberMissing'); continue; }
            const candidateShell = shellTurnSource(candidateFiber, candidate, group.turnId, shellScan.rejects);
            if (!candidateShell) continue;
            if (candidateShell.entry !== shell.entry || candidateShell.turnId !== shell.turnId) {
              shellDiagnostic(shellScan.rejects, 'stableKeyMismatch');
              continue;
            }
            shellScan.mapped = Math.min(MAX_ROWS, shellScan.mapped + 1);
            turnSections.push(candidate);
            shell.slots.push(...candidateShell.slots);
          }
        }
        const baseMessages = shell ? shell.messages : turnMessagesOf(fiber);
        const queries = shell ? shellQueries(fiber) : [];
        const conversation = shell
          ? shellConversation(queries, shell.entry.conversationId, conversationEvidenceOf(fiber), section)
          : conversationEvidenceOf(fiber);
        const messages = shell
          ? shellMessagesWithReferencedSources(fiber, queries, shell, conversation)
          : baseMessages;
        const codeReceipts = codeModeReceipts(messages || []);
        const nativeCodeParents = (messages || []).filter(message => message && message.author &&
          message.author.role === 'assistant' && message.recipient === 'functions.exec');
        const nativeCodeIds = nativeCodeParents.map(message => str(message.id));
        // A duplicate enclosing exec parent is the same ambiguity as two
        // native Core requests sharing one message id. Even if its count fits
        // the wire budget, the current native call census is NOT complete.
        // The isolated-world reader may retain an unambiguous prefix for
        // attribution, but no final/Loop decision can credit this parent.
        const codeParentsUnique = nativeCodeParents.length <= MAX_CALLS &&
          nativeCodeIds.every(id => id && id.length <= MAX_TEXT) &&
          new Set(nativeCodeIds).size === nativeCodeIds.length;
        const codeModeCalls = nativeCodeParents.slice(0, MAX_CALLS)
          .map(message => ({
            messageId: str(message.id),
            requestId: str(message.metadata && message.metadata.request_id),
            answered: codeReceipts.get(message.id) === true
          }));
        const classic = shell ? null : callsOf(messages, codeReceipts);
        const calls = shell ? shell.calls : classic.calls;
        const callEvidenceComplete = Boolean(shell || classic.complete) && codeParentsUnique;
        const shellSightings = [];
        const metadata = shell ? shellRequestMetadata(fiber, queries, shell, conversation, shellSightings, shellScan.rejects) : messages;
        const sightings = shell ? shellSightings : sightingsOf(metadata);
        const requests = requestIdsOf(metadata);
        if (shell) for (const call of calls) {
          const invocation = metadata.find(message => message.id === call.messageId);
          const reference = shell.callSources.get(call.messageId);
          const source = invocation?.metadata?.request_id ? invocation
            : metadata.find(message => message.id === reference?.metadataId) || invocation;
          call.requestId = source?.metadata?.request_id || null;
          call.createTime = source?.create_time ?? null;
          if (call.requestId) call.identityRefusalReasons = [];
        }
        const turnBudget = { remaining: Math.min(MAX_TURN_TEXT, responseBudget.remaining) };
        const before = turnBudget.remaining;
        const renderedMessages = renderedMessagesOf(turnSections, messages, turnBudget);
        // Shape-only projection observations, not question/final/Send/Goal authority.
        // Read only our freshly synthesized messages, never extra raw page getters or DOM prose.
        if (shell && !conversation.conflict) {
          const users = shell.messages.filter(message => message.author.role === 'user');
          if (users.length === 0) shellDiagnostic(shellScan.rejects, 'userTypedMissing');
          for (const key of ['userTextEmpty', 'userTextUnsupported'])
            for (let count = 0; count < shell.userDiagnostics[key]; count++) shellDiagnostic(shellScan.rejects, key);
          for (const user of users) {
            if (renderedMessages.some(message => message.role === 'user' && message.rawMessageId === user.id))
              shellDiagnostic(shellScan.rejects, 'userProjected');
            else if (user.content.parts[0]) shellDiagnostic(shellScan.rejects, 'userBudgetDropped');
          }
        }
        responseBudget.remaining -= before - turnBudget.remaining;
        const activities = nativeActivitiesOf(turnSections, messages);
        const directEndMessageId = turnEndMessageId(messages);
        const endMessageId = directEndMessageId || (shell
          ? shellProviderTerminalMessageId(fiber, queries, shell, conversation, calls, codeModeCalls, shellScan.rejects)
          : null);
        if (
          codeModeCalls.length === 0 && calls.length === 0 &&
          requests.length === 0 && sightings.length === 0 &&
          renderedMessages.length === 0 &&
          activities.length === 0 && !endMessageId
        ) continue;
        const index = out.length;
        entry = {
          index,
          turnId: shell ? shell.turnId : group.turnId,
          conversationId: conversation.conversationId,
          conversationConflict: conversation.conflict,
          ...(shell && !conversation.conversationId ? { requestOwnerRequired: true } : {}),
          endMessageId,
          calls,
          codeModeCalls,
          ...(callEvidenceComplete ? {} : { callEvidenceComplete: false }),
          requests,
          sightings,
          messages: renderedMessages,
          activities
        };
        // The isolated-world renderer needs to know which visible section this exact Fiber
        // turn descriptor came from. Remember the desired ephemeral scan index now and apply
        // it after the scan, so a stable scan produces no attribute mutation at all.
        for (let sectionAt = 0; sectionAt < turnSections.length; sectionAt++) {
          const stamped = turnSections[sectionAt];
          if (stamped) desiredTurnStamps.set(stamped, `${scanToken}:${index}`);
        }
        if (shell) {
          for (const slot of shell.slots) {
            desiredTurnStamps.set(slot.node, `${scanToken}:${index}`);
            if (!conversation.conflict)
              desiredMessageStamps.set(slot.node, `${scanToken}:${index}:${encodeURIComponent(slot.id)}`);
          }
          // A fresh chat can draw its first exchange with no user slot at all, while the page
          // model holds the exact user message (2026-10-02: a resumed chat, a Goal helper and a
          // Temporary Chat). Without a slot there was no user message to read, so no Send receipt
          // and no turn. Name that one exact provider id on the exchange; isolated readers accept
          // it only under this scan's turn stamp. Several user messages stay unnamed.
          const users = renderedMessages.filter(message => message.role === 'user');
          const userSlot = shell.slots.some(slot => /:user$/.test(slot.node.getAttribute('data-content-search-unit-key') || ''));
          if (!conversation.conflict && !userSlot && users.length === 1 && users[0].rawMessageId) {
            desiredUserStamps.set(section, `${scanToken}:${index}:${encodeURIComponent(users[0].rawMessageId)}`);
          }
          // Busy hint only, never a completion receipt or a Stop action target.
          const running = shell.entry.turn.status === 'in_progress' ? location.pathname : null;
          if (running && section.getAttribute('data-clf-shell-running') !== running)
            section.setAttribute('data-clf-shell-running', running);
          else if (!running) section.removeAttribute('data-clf-shell-running');
        }
      } catch {
        // One unreadable turn must not cost the others their evidence.
        entry = null;
      }
      // `data-turn-id` is presentation metadata, not transcript identity. ChatGPT's current
      // virtualized renderer can omit it from a perfectly readable assistant section while
      // the underlying turn model still exposes exact conversation/message/request ids.
      // Dropping that descriptor made opening or scrolling an old chat lose precisely those
      // messages until another render happened to restore the attribute. Keep the descriptor;
      // content.js will simply leave local turn ownership unset when the page turn id is null.
      if (entry) out.push(entry);
    }
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      try {
        if (!section || !section.getAttribute) continue;
        for (const node of section.querySelectorAll('[data-clf-fiber-message], [data-content-search-unit-key]')) {
          const wantedMessage = desiredMessageStamps.get(node);
          const currentMessage = node.getAttribute('data-clf-fiber-message');
          if (wantedMessage === undefined) {
            if (currentMessage !== null) node.removeAttribute('data-clf-fiber-message');
          } else if (currentMessage !== wantedMessage) node.setAttribute('data-clf-fiber-message', wantedMessage);
        }
        if (!desiredTurnStamps.has(section)) section.removeAttribute('data-clf-shell-running');
        const wantedUser = desiredUserStamps.get(section);
        const currentUser = section.getAttribute('data-clf-fiber-user');
        if (wantedUser === undefined) {
          if (currentUser !== null) section.removeAttribute('data-clf-fiber-user');
        } else if (currentUser !== wantedUser) section.setAttribute('data-clf-fiber-user', wantedUser);
        for (const stamped of [section, ...section.querySelectorAll('[data-content-search-unit-key]')]) {
          const wanted = desiredTurnStamps.get(stamped);
          const current = stamped.getAttribute('data-clf-fiber-turn');
          if (wanted === undefined) {
            if (current !== null && stamped.removeAttribute) stamped.removeAttribute('data-clf-fiber-turn');
          } else if (current !== wanted && stamped.setAttribute) {
            stamped.setAttribute('data-clf-fiber-turn', wanted);
          }
        }
      } catch {
        // One hostile/stale DOM node must not cost the remaining turns their evidence.
      }
    }
    return out;
  }

  /**
   * Answers a request from the isolated world.
   *
   * The rows are stamped with their index before the reply is sent, so the two worlds
   * agree on which descriptor belongs to which row without relying on both querying the
   * DOM at the same instant — React can re-render between the two.
   */
  function scan(nonce) {
    // The existing scan also refreshes mounted-picker evidence; no new poll timer.
    try { pickerSnapshot(); } catch { /* An unknown picker cannot affect recording. */ }
    // The request nonce already uniquely names this scan across the two worlds. Reuse it as
    // the ephemeral frame token rather than minting a second random value: every DOM stamp
    // can then prove both which descriptor index it names and which exact scan produced it.
    // A stamp from scan N is therefore unusable against descriptors from scan N+1 even when
    // React leaves the old DOM node mounted and both scans happen to use index 0.
    const scanToken = nonce;
    const rows = [];
    let turns = [];
    // Bounded shape-only counters let the paired isolated world distinguish a selector miss
    // from an unreadable Fiber owner. No ids, labels, message text or React values cross worlds.
    const shellScan = { selectorMatches: 0, mapped: 0,
      rejects: { fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
        // Observed zero is distinct from an older producer omitting the field.
        callRequestIdPresent: 0, callRequestIdMissing: 0,
        callCompletionVeto: 0, callLiveMappingMissing: 0, callLiveMappingConflict: 0, callPathMissing: 0,
        callReceiptMissing: 0, callReceiptConflict: 0, callNativePending: 0, callScopeConflict: 0, callExecUnresolved: 0,
        callVetoReceiptChecked: 0, callVetoReceiptMatched: 0,
        callJoinReferenceMissing: 0, callJoinReferenceUnselected: 0, callJoinReferenceConflict: 0,
        callJoinResultMissing: 0, callJoinResultIdentity: 0, callJoinDescriptorUnsupported: 0,
        callIdentityRecovered: 0, callIdentityPriorPair: 0,
        callIdentityUserUnproved: 0, callIdentityNativeUnproved: 0,
        callIdentityScopeUnproved: 0, callIdentityParentUnproved: 0,
        callIdentitySelectedWithheld: 0,
        assistantTerminalReceiptChecked: 0, assistantTerminalReceiptMatched: 0,
        callCompletedFalse: 0, callCompletedUndefined: 0, callCompletedNull: 0, callCompletedMalformed: 0, callStatusVeto: 0,
        callVetoStatusAbsent: 0, callVetoStatusPending: 0, callVetoStatusError: 0, callVetoStatusDone: 0,
        callVetoStatusFinal: 0, callVetoStatusCompleted: 0, callVetoStatusComplete: 0, callVetoStatusFinished: 0,
        callVetoStatusFinishedSuccessfully: 0, callVetoStatusUnknown: 0,
        userTypedMissing: 0, userIdentityInvalid: 0, userTextEmpty: 0,
        userTextUnsupported: 0, userBudgetDropped: 0, userProjected: 0 } };
    let scanOk = true;
    let found;
    try {
      // Inspect existing native tool containers, never translated control labels.
      // The row-local Fiber group is the authority; built-in tools fail describe().
      found = [...document.querySelectorAll(TOOL)].filter(row => !row.closest(OWN_SURFACES));
      for (const old of document.querySelectorAll(CONNECTOR)) old.removeAttribute('data-clf-fiber');
    } catch {
      return post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk: false, rows: [], turns, shellScan }, location.origin);
    }
    const limit = Math.min(found.length, MAX_ROWS);
    for (let index = 0; index < limit; index++) {
      const row = found[index];
      let descriptor = null;
      try {
        descriptor = describe(row, index);
      } catch {
        // One unreadable row must not cost the rest of the page its labels.
        descriptor = null;
      }
      try {
        if (descriptor) row.setAttribute('data-clf-fiber', `${scanToken}:${index}`);
      } catch {
        // If the page will not take the marker, the descriptor is unusable: drop it
        // rather than let the other side match it to a row by position.
        descriptor = null;
      }
      if (descriptor) rows.push(descriptor);
    }
    // Row stamps must exist before native activity projection excludes connectors.
    try {
      turns = turnsOf(scanToken, shellScan);
    } catch {
      turns = [];
      scanOk = false;
    }
    post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk, rows, turns, shellScan }, location.origin);
  }

  /** Picker data is account-evaluated state, never a scraped English announcement.
   * Copy only selection metadata; no conversation, account object or callbacks cross worlds. */
  function pickerSnapshot() {
    // The closed native trigger retains the same picker owner. Passive recording
    // must not depend on discovery opening its portal first.
    const form = document.querySelector('#prompt-textarea, form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')?.closest('form');
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const triggers = [...new Set([...(form?.querySelectorAll('button[aria-haspopup="menu"]') || []), ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const candidates = [];
    if (triggers.length <= 8) for (const trigger of triggers) {
      try {
        const picker = readPickerSnapshot(trigger) || readShellPickerSnapshot(trigger);
        if (picker) candidates.push({ node: trigger, picker });
      } catch { /* An unrelated native menu is not picker evidence. */ }
    }
    const specific = candidates.filter(candidate => candidate.node.matches(reported));
    const identified = specific.length === 1 ? specific[0] : candidates.length === 1 ? candidates[0] : null;
    const native = triggers.filter(trigger => trigger.matches(reported));
    const fallback = native.length === 1 ? native[0] : triggers.length === 1 ? triggers[0] : null;
    const node = document.querySelector('[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]') || identified?.node || fallback;
    let state = null;
    try { state = identified?.picker || readPickerSnapshot(node) || readShellPickerSnapshot(node); } catch { /* Unknown state invalidates prior proof. */ }
    // A recognized account denial must never fall through to label-only observation.
    const selected = state ? state.choices.find(choice => choice.bucket === state.currentBucket && choice.available)
      : (node && node === fallback ? closedPickerSelection(node) : null);
    const provenTrigger = identified?.node || (selected && node === fallback ? fallback : null);
    for (const trigger of triggers) {
      if (trigger !== provenTrigger) trigger.removeAttribute('data-clf-picker-route');
      else if (trigger.getAttribute('data-clf-picker-route') !== location.pathname) trigger.setAttribute('data-clf-picker-route', location.pathname);
      if (trigger !== node) for (const attribute of ['data-clf-selected-model', 'data-clf-selected-effort', 'data-clf-selected-route']) trigger.removeAttribute(attribute);
    }
    for (const [attribute, value] of [['data-clf-selected-model', selected?.id], ['data-clf-selected-effort', selected?.effort], ['data-clf-selected-route', selected && location.pathname]]) {
      if (!value) node?.removeAttribute(attribute);
      else if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    }
    return state;
  }
  /** Shell execution ids are provider identities, not localized presentation. */
  function shellProExecutionModel(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
  }
  /** A bare shell lane is not a provider family. Bind it to the selected native family. */
  function shellModelIdentity(value, family) {
    const model = typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
    return model?.toLowerCase() === 'pro' ? family : model;
  }
  // The native closed picker does not mount composerIntelligencePickerState.
  // Its own ancestor carries the current execution model; its visible label
  // carries the selected effort. These are observation, never catalog discovery.
  function closedPickerSelection(node) {
    const machine = node.getAttribute('data-selected-reasoning-effort');
    if (machine !== null) {
      const namedEffort = value => ({ instant:'none', minimal:'minimal', low:'low', medium:'medium', high:'high',
        'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[String(value || '').trim().toLowerCase()] || null;
      const machineEffort = ['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(machine) ? machine : null;
      let model = null, lane = null, family = null;
      for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
        // The new shell exposes the visible product lane separately from its transport effort:
        // Pro can report `medium`, while Extra High can report `max`. Prefer the lane label when
        // it belongs to the same exact model; retain the machine value as the older-shell fallback.
        const selected = fiber.memoizedProps?.selectedPowerSelection ?? fiber.memoizedProps?.selectedLabelCandidate;
        if (lane === null && selected) lane = {
          model: selected.model,
          effort: namedEffort(selected.labels?.effort ?? selected.sliderLabel)
        };
        const options = fiber.memoizedProps?.modelListConfig?.options;
        if (Array.isArray(options)) {
          const current = options.filter(option => option?.selected === true);
          if (current.length !== 1 || typeof current[0].id !== 'string' ||
              !/^[a-zA-Z0-9._ -]{1,80}$/.test(current[0].id) || current[0].id.trim() !== current[0].id ||
              (family && family !== current[0].id)) return null;
          family = current[0].id;
        }
        const current = fiber.memoizedProps?.currentModelId;
        if (current === undefined) continue;
        if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) return null;
        model = current;
      }
      const effort = (lane && lane.model === model && lane.effort) ||
        (shellProExecutionModel(model) ? 'pro' : machineEffort);
      if (!effort) return null;
      const identity = shellModelIdentity(model, family);
      return identity ? { id: identity, effort } : null;
    }
    // Latest omits the family prefix; explicit versions and Pro may retain it.
    // Adjacent native spans can yield "6Pro" rather than "6 Pro" in textContent.
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const selected = /^(?:(?:GPT[- ]?)?(\d+(?:\.\d+)?)\s*)?(instant|minimal|low|medium|high|extra\s*high|max|ultra|pro)$/i.exec(text);
    if (!selected) return null;
    const effort = ({ instant: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
      extrahigh: 'xhigh', max: 'max', ultra: 'ultra', pro: 'pro' })[selected[2].toLowerCase().replace(/\s/g, '')];
    let model = null;
    for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const current = fiber.memoizedProps?.currentModelId;
      if (current === undefined) continue;
      if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) return null;
      model = current;
    }
    if (!model) return null;
    // A visible version is a consistency check, never a source of execution ids.
    if (selected[1]) {
      const actual = /^gpt-?(\d+)(?:[.-](\d+))?(?:-|$)/i.exec(model);
      const [major, minor = '0'] = selected[1].split('.');
      if (!actual || Number(actual[1]) !== Number(major) || Number(actual[2] || 0) !== Number(minor) ||
          (effort === 'pro') !== /-pro$/i.test(model)) return null;
    }
    return { id: model, effort };
  }
  function readPickerSnapshot(node) {
    let fiber = node && fiberOf(node);
    for (let up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      // The September composer retains the unmounted menu as dropdownContent.
      // Read that exact native child too; opening it is unnecessary for observation.
      const owner = fiber.memoizedProps;
      const props = owner?.composerIntelligencePickerState ? owner : owner?.dropdownContent?.props;
      const state = props?.composerIntelligencePickerState, data = props?.modelsData;
      if (!state || !Array.isArray(data?.versions)) continue;
      if (data.versions.length > 20 || !Array.isArray(state.bucketSelections) || state.bucketSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      // Native version groups may have spaces; execution slugs retain their strict contract.
      const groupId = value => typeof value === 'string' && /^[a-zA-Z0-9._ -]{1,80}$/.test(value) && value.trim() === value && value.trim() ? value : null;
      const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 ? value.trim() : null;
      const namedEffort = value => ({ instant:'none', minimal:'minimal', low:'low', medium:'medium', high:'high',
        'extra high':'xhigh', max:'max', ultra:'ultra', pro:'pro' })[String(value || '').trim().toLowerCase()] || null;
      const effortOf = choice => {
        if (choice.category?.modelLane === 'pro') return 'pro';
        if (['auto', 'instant'].includes(choice.category?.modelLane)) return 'none';
        const productEffort = namedEffort(choice.labels?.effort ?? choice.sliderLabel);
        if (productEffort) return productEffort;
        if (choice.thinkingEffort === 'max' && choice.modelConfig?.isWorkModeModel === true) return 'max';
        return ({ min: 'low', standard: 'medium', extended: 'high', max: 'xhigh', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'ultra' })[choice.thinkingEffort] || null;
      };
      // Some account-evaluated denials carry the same exact reset time ChatGPT shows in the
      // picker. Copy only a bounded numeric timestamp from known availability fields; never
      // copy denial prose, account objects or provider callbacks across worlds.
      const retryAtOf = (...sources) => {
        const now = Date.now(), latest = now + 35 * 24 * 60 * 60_000;
        const timestamp = value => {
          let parsed = Number.NaN;
          if (typeof value === 'number' && Number.isFinite(value)) parsed = value < 10_000_000_000 ? value * 1000 : value;
          else if (typeof value === 'string' && value.length <= 64) parsed = Date.parse(value);
          return Number.isFinite(parsed) && parsed > now && parsed <= latest ? Math.floor(parsed) : null;
        };
        for (const source of sources) {
          if (!source || typeof source !== 'object') continue;
          for (const key of ['retryAt', 'resetAt', 'resetsAt', 'availableAt', 'nextAvailableAt', 'unavailableUntil']) {
            const value = Object.getOwnPropertyDescriptor(source, key)?.value;
            const parsed = timestamp(value);
            if (parsed) return parsed;
          }
        }
        return null;
      };
      // Titles are presentation, not entitlement or execution identity. Latest can
      // suppress the family shortLabel, or display only an effort such as High.
      const modelLabel = value => {
        const name = label(value);
        return name && !/^(instant|minimal|low|medium|high|extra\s*high|max|ultra|pro)$/i.test(name)
          ? (/^\d/.test(name) ? `GPT-${name}` : name) : null;
      };
      const choices = state.bucketSelections.map(choice => {
        const modelId = id(choice.modelSlug);
        const familyId = groupId(choice.category?.modelVersion) || modelId;
        const family = data.versions.find(version => version.id === familyId);
        const name = modelLabel(choice.category?.shortLabel) || modelLabel(choice.modelConfig?.title) || modelId;
        const denial = props.modelSwitcherDenialsBySlug?.[choice.modelSlug];
        const available = choice.availability?.status === 'available' && !denial;
        const retryAt = available ? null : retryAtOf(choice.availability, denial);
        return { bucket: choice.bucket, id: modelId,
          label: name, effort: effortOf(choice),
          familyId, familyLabel: modelLabel(family?.displayTextForIntelligence) || modelLabel(choice.modelConfig?.title) || name,
          available, ...(retryAt ? { retryAt } : {}) };
      });
      const versions = data.versions.filter(version => version.enabled === true).map(version => ({ id: groupId(version.id), label: label(version.displayTextForIntelligence) }));
      if (!versions.length || versions.some(v => !v.id || !v.label) || choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length) return null;
      const version = groupId(state.selectedVersionEntry?.id), currentBucket = state.currentBucket;
      if (!versions.some(v => v.id === version) || !choices.some(c => c.bucket === currentBucket)) return null;
      const selected = state.currentSelection;
      const chosen = choices.find(c => c.bucket === currentBucket);
      if (selected?.modelSlug !== chosen.id || effortOf(selected) !== chosen.effort) return null;
      return { version, currentBucket, versions, choices };
    }
    return null;
  }

  /** Alternate shell evaluated powers normalized into the existing picker wire contract. */
  function readShellPickerSnapshot(node) {
    for (let fiber = node && fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!Array.isArray(p?.powerSelections)) continue;
      const selected = p.selectedPowerSelection ?? p.selectedLabelCandidate, options = p.modelListConfig?.options;
      if (!selected || !Array.isArray(options) || options.length > 20 || p.powerSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      const group = value => typeof value === 'string' && /^[\p{L}\p{N}._ -]{1,80}$/u.test(value) && value.trim() === value ? value : null;
      const label = value => typeof value === 'string' && value.trim() && value.length <= 80 ? value.trim() : null;
      const effort = value => ({ none:'none', instant:'none', minimal:'minimal', min:'low', low:'low', standard:'medium', medium:'medium', extended:'high', high:'high', xhigh:'xhigh', 'extra high':'xhigh', max:'xhigh', ultra:'ultra', pro:'pro' })[value] || null;
      // The lane's visible label is its product identity. The new picker can expose `medium` for
      // Pro and `max` for Extra High as transport values, so those machine values cannot safely
      // name the lane by themselves.
      const effortOf = choice => {
        const model = id(choice?.model);
        return effort(String(choice?.labels?.effort ?? choice?.sliderLabel ?? '').trim().toLowerCase()) ||
          (model && model.endsWith('-pro') ? 'pro' : effort(choice?.reasoningEffort));
      };
      const current = options.filter(option => option?.selected === true);
      if (current.length !== 1) return null;
      const version = group(current[0].id);
      const versionLabel = label(current[0].label);
      const versions = options.filter(option => option && option.disabled !== true).map(option => ({ id: group(option.id), label: label(option.label) }));
      const modelName = value => { const name = label(value); return name && /^\d/.test(name) ? `GPT-${name}` : name; };
      const choices = p.powerSelections.map(choice => {
        const model = id(choice?.model), identity = shellModelIdentity(model, version);
        const laneOnly = identity && identity !== model;
        return {
          bucket: choice?.powerSettingIndex,
          id: identity,
          label: modelName(choice?.modelLabel) || (laneOnly ? versionLabel : null),
          familyId: laneOnly ? version : model,
          familyLabel: laneOnly ? versionLabel : modelName(choice?.modelLabel),
          effort: effortOf(choice),
          available: p.modelSelectionDisabled !== true && choice?.disabled !== true &&
            (!choice?.availability || choice.availability.status === 'available') && !p.modelSwitcherDenialsBySlug?.[choice?.model]
        };
      });
      if (!version || !versions.length || versions.some(item => !item.id || !item.label) || !choices.length ||
          choices.some(choice => !Number.isInteger(choice.bucket) || !choice.id || !choice.label || !choice.effort) ||
          new Set(versions.map(item => item.id)).size !== versions.length || new Set(choices.map(choice => choice.bucket)).size !== choices.length ||
          !versions.some(item => item.id === version)) return null;
      // Upstream #1194: native Instant/Thinking slugs share a family only when their
      // visible name and distinct efforts prove that relationship. Keep our observed
      // Extra High/Pro and bare-lane identities; never invent an unavailable selection.
      for (const name of new Set(choices.map(choice => choice.label))) {
        const lanes = choices.filter(choice => choice.label === name);
        if (lanes.length < 2 || new Set(lanes.map(choice => choice.effort)).size !== lanes.length) continue;
        const shared = lanes.map(choice => choice.id).reduce((a, b) => {
          let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i);
        }).replace(/[-._]+$/, '');
        if (!id(shared) || !/\d/.test(shared)) continue;
        for (const lane of lanes) lane.familyId = shared;
      }
      const matches = p.powerSelections.map((choice, index) => ({ choice, index })).filter(({ choice }) =>
        id(choice?.model) === id(selected.model) && effortOf(choice) === effortOf(selected));
      if (matches.length !== 1 || (selected.powerSettingIndex !== undefined && selected.powerSettingIndex !== choices[matches[0].index].bucket)) return null;
      return { version, currentBucket: choices[matches[0].index].bucket, versions, choices };
    }
    return null;
  }

  /**
   * Worst-case copy cost for one connector catalog read back from ChatGPT.
   *
   * The app can publish 250,000 UTF-8 bytes of Plugins declarations. copySchema charges
   * three bytes per character plus key overhead, so 900,000 bytes covers every catalog the
   * app may publish while the isolated-world projection keeps its separate 300,000-character cap.
   */
  const PLUGIN_SCHEMA_READ_BYTES = 900000;

  function copySchema(value, budget, depth = 0) {
    if (depth > 32 || --budget.nodes < 0) throw new Error('schema_bound');
    const spend = bytes => { budget.bytes -= bytes; if (budget.bytes < 0) throw new Error('schema_bound'); };
    if (value === null) { spend(4); return null; }
    if (typeof value === 'string') { spend(value.length * 3 + 2); return value; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { spend(32); return value; }
    if (!value || typeof value !== 'object') throw new Error('schema_shape');
    if (Array.isArray(value)) {
      if (value.length > budget.nodes) throw new Error('schema_bound');
      spend(value.length + 2); return value.map(item => copySchema(item, budget, depth + 1));
    }
    const keys = Object.keys(value);
    if (keys.length > budget.nodes) throw new Error('schema_bound');
    const result = Object.create(null);
    for (const key of keys) {
      spend(key.length * 3 + 4);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('schema_accessor');
      result[key] = copySchema(descriptor.value, budget, depth + 1);
    }
    return result;
  }

  /**
   * ChatGPT's full-page plugin settings keep the connector and its actions in React state a
   * few Fibers above each management button. Older/localized shells expose a loading prop;
   * newer shells can expose only the exact native Refresh tools label. Both paths still
   * require the route's exact connector owner and exclude menu/destructive controls.
   */
  function pagePluginSnapshot(appId) {
    const buttons = [...document.querySelectorAll('main button')].slice(0, 200);
    let connector = null, control = null;
    for (const button of buttons) {
      if (!button.getClientRects().length) continue;
      let fiber = fiberOf(button), loading = false, unsafe = false, owner = null;
      for (let up = 0; fiber && up < 16; up++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        if (up <= 2) {
          if (own.call(props, 'loading')) loading = true;
          if (own.call(props, 'aria-haspopup') || (typeof props.color === 'string' && /danger|destructive/i.test(props.color))) unsafe = true;
        }
        if (props.connector && typeof props.connector === 'object') { owner = props.connector; break; }
      }
      if (!owner || owner.id !== appId) continue;
      if (connector && connector !== owner) return null;
      connector = owner;
      const text = (button.textContent || '').trim().replace(/\s+/g, ' ');
      const label = (button.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      const semanticRefresh = /^refresh tools$/i.test(label || text);
      if ((loading || semanticRefresh) && !unsafe && !button.hasAttribute('aria-haspopup') &&
          !/\b(?:delete|remove|uninstall|disconnect)\b/i.test(`${text} ${label}`)) {
        if (control && control !== button) return null;
        control = button;
      }
    }
    if (!connector || !Array.isArray(connector.actions) || typeof connector.name !== 'string') return null;
    const externalPlugins = pluginsConnectorApp(connector.name, connector.id);
    // Core can include native computer/browser tools. This is an observation bound,
    // not authorization: the main process still compares the exact published schema.
    if ((!connector.actions.length && !externalPlugins) || connector.actions.length > (externalPlugins ? 257 : 64)) return null;
    const budget = { bytes: PLUGIN_SCHEMA_READ_BYTES, nodes: 20000 };
    // The full-page provider sends an empty model description when only the page description
    // is set. Preserve that actual declaration so the exact published-schema comparison works.
    const tools = connector.actions.map(action => ({ name: action.name, description: copySchema(action.description_model || action.description, budget), inputSchema: copySchema(action.params, budget) }));
    if (tools.some(tool => !NAME.test(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') ||
        new Set(tools.map(tool => tool.name)).size !== tools.length) return null;
    if (control && control.getAttribute('data-clf-plugin-refresh') !== appId) control.setAttribute('data-clf-plugin-refresh', appId);
    return { appId, connectorName: connector.name.slice(0, 100), versionId: str(connector.app_metadata?.version_id), tools, refreshAvailable: !!control };
  }

  function pluginSnapshot() {
    const pageRoute = /^\/(?:settings\/plugins-settings|plugins)\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.pathname);
    if (pageRoute && !location.hash) return pagePluginSnapshot(pageRoute[1]);
    const route = /^#settings\/Plugins\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.hash);
    if (!route) return null;
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(panel =>
      panel.getAttribute('aria-labelledby')?.endsWith('-trigger-Plugins') && !panel.hidden);
    if (panels.length !== 1) return null;
    const buttons = [...panels[0].querySelectorAll('button')].slice(0, 100);
    let result = null, control = null, observedActions = null, observedCard = null;
    for (const button of buttons) {
      let fiber = fiberOf(button);
      for (let up = 0; fiber && up < 24; up++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props) continue;
        if (props.reportEntity?.entityType === 'connector' && props.reportEntity.id === route[1] &&
            Array.isArray(props.details) && props.details.some(detail => detail.value === route[1]) &&
            button.getClientRects().length > 0) {
          if (observedCard && observedCard !== props) return null;
          observedCard = props;
          if (props.headerTrailingContent) {
            if (control && control !== button) return null;
            control = button;
          }
        }
        if (props.connector?.id !== route[1] || !Array.isArray(props.actions) || props.isLoadingActions === true) continue;
        if (props.actions === observedActions) continue;
        if (observedActions) return null;
        observedActions = props.actions;
        const externalPlugins = pluginsConnectorApp(props.connector.name, props.connector.id);
        if ((!props.actions.length && !externalPlugins) || props.actions.length > (externalPlugins ? 257 : 64) || typeof props.connector.name !== 'string') return null;
        const budget = { bytes: PLUGIN_SCHEMA_READ_BYTES, nodes: 20000 };
        const tools = props.actions.map(action => ({ name: action.name, description: copySchema(action.description_model ?? action.description, budget), inputSchema: copySchema(action.params, budget) }));
        if (tools.some(tool => !NAME.test(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') ||
            new Set(tools.map(tool => tool.name)).size !== tools.length) return null;
        result = { appId: route[1], connectorName: props.connector.name.slice(0, 100),
          versionId: str(props.connector.app_metadata?.version_id), tools };
      }
    }
    if (!result || !observedCard) return null;
    // Stamp only the native button wired to this connector's header action. Never
    // invoke page callbacks; the isolated world still owns the durable claim and click.
    if (control && control.getAttribute('data-clf-plugin-refresh') !== route[1]) control.setAttribute('data-clf-plugin-refresh', route[1]);
    return { ...result, refreshAvailable: !!control };
  }

  const listener = (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || ![ASK, 'clf-picker-ask', 'clf-plugin-ask'].includes(data.source)) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    adoptAppIdentity(data.apps, data.appIds);
    const previousPaths = currentPaths;
    currentPaths = new WeakMap();
    try {
    if (data.source === 'clf-plugin-ask') {
      let plugin = null;
      try { plugin = pluginSnapshot(); } catch { /* Unrecognized installed settings. */ }
      post({ source: 'clf-plugin-reply', nonce, v: 1, plugin }, location.origin);
      return;
    }
    if (data.source === 'clf-picker-ask') {
      let picker = null;
      try { picker = pickerSnapshot(); } catch { /* Unknown provider shape fails closed. */ }
      post({ source: 'clf-picker-reply', nonce, v: 1, picker }, location.origin);
      return;
    }
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk: false, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out and keeps ChatGPT's labels.
      }
    }
    } finally {
      currentPaths = previousPaths;
    }
  };
  // Re-execution is a repair, not a marker check. A stale primitive marker could survive
  // while its listener did not, so keep the actual listener and always replace it. The prior
  // owned registry spans protocol upgrades; the new reply still carries only this VERSION.
  const prior = window[ACTIVE_HELPER];
  if (prior && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Installing the replacement below is still the only useful recovery action.
    }
  }
  window.addEventListener('message', listener);
  window[ACTIVE_HELPER] = { version: VERSION, listener };
})();
