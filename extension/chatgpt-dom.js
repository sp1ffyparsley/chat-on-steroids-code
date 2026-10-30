/**
 * Everything that knows what ChatGPT's page looks like.
 *
 * This is the only file that will break when ChatGPT changes, which is why it is the
 * only file allowed to contain a selector. Every function returns a safe empty value
 * instead of throwing, so a redesign degrades the companion to "records nothing new"
 * rather than breaking the page the user is working in.
 *
 * Anchors used, in order of how directly the live page exposes them:
 *   · turn/message data-* attributes when present (data-turn-id, data-message-id,
 *     data-message-author-role, data-interrupted, data-testid)
 *   · `.markdown` for assistant prose when the current renderer supplies no assistant
 *     data-message-id; progress markdown under data-interrupted is excluded
 *   · the id #prompt-textarea on the composer, and the send/stop/dictation buttons beside
 *     it, which is where our own composer control is anchored
 *   · one structural tool-message class substring, plus a display-contents row shape that
 *     is confirmed structurally (short header line, no prose) before it is believed
 *
 * None of these are a public ChatGPT API. In the live 2026-08-15 page one logical
 * assistant request can also be split into several sections sharing data-turn-id, so
 * turns are grouped before messages, progress or tool blocks are counted. Hashed
 * CSS-module class names are never matched because they are intentionally ephemeral.
 */

// Recovery may reinject this adapter before the previous recorder is retired.
// Restore its native tab metadata while its original ownership snapshot still exists.
if (typeof CLF_DOM !== 'undefined') CLF_DOM?.setTabStatus?.(null);
var CLF_DOM = (() => {
  const SHELL_TURN = '[data-app-shell-main-surface] [data-thread-find-target="conversation"] [data-turn-key]';
  const SHELL_UNIT = '[data-content-search-unit-key]';
  const CLASSIC_TURN = 'section[data-testid^="conversation-turn"]';
  const TURN = `${CLASSIC_TURN}, ${SHELL_TURN}`;
  const PICKER = '[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]';
  // ChatGPT has used both shapes in the live renderer: the older tool-message span
  // and, as of 2026-08-15, a display-contents row wrapping the visible tool label.
  // Keep both explicit structural anchors; hashed CSS-module names remain off limits.
  const TOOL_LEGACY = 'span[class*="tool-message"]';
  const STATUS_V5 = 'div:has(> [data-testid="cot-v5-tool-icon-pile"])';
  const TOOL = `${TOOL_LEGACY}, div.pointer-events-none.contents, ${STATUS_V5}`;
  // MAIN-world scan stamps only a row whose own message group proves api_tool.
  // A translated label or a generic built-in tool button never establishes identity.
  const CONNECTOR = '[data-clf-fiber]';
  const STOP =
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
    'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i], form[data-chatgpt-composer] button[type="submit"]';
  /** The composer's own trailing controls, where the send and dictation buttons live. */
  const TRAILING =
    '[data-testid="composer-trailing-actions"], [data-testid="composer-footer-actions"], ' +
    '[class~="[grid-area:trailing]"]';
  const SPEECH =
    'button[data-testid="composer-speech-button"], button[data-testid="composer-dictate-button"], ' +
    'button[aria-label^="Dictate" i], button[aria-label^="Voice" i], ' +
    'button[aria-label="Start dictation" i], button[aria-label="Start Voice" i]';
  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const text = (node, cap = 256_000) =>
    node ? (node.textContent || '').replace(/ /g, ' ').trim().slice(0, cap) : '';

  // ChatGPT rich-link previews can inject presentation nodes inside an otherwise
  // unchanged editor (#1792/#1795). Read only prompt bytes; literal markup typed
  // by the person stays text. This never changes native connector-token identity.
  const NOT_PROMPT = 'style, script, noscript, template';
  const editorText = node => {
    if (!node || node.matches?.(NOT_PROMPT)) return '';
    if (!node.querySelector?.(NOT_PROMPT) || typeof node.cloneNode !== 'function') return node.textContent ?? '';
    const clone = node.cloneNode(true);
    for (const injected of clone.querySelectorAll(NOT_PROMPT)) injected.remove();
    return clone.textContent ?? '';
  };

  /**
   * Structural shell identity for diagnostics only.
   *
   * Seeing both renderers in one document is intentionally unknown: React can leave the outgoing
   * tree mounted while the replacement commits. Picking one in that interval would turn stale DOM
   * into incident evidence. A known shell still says nothing about model/tool availability by
   * itself; content.js combines it only with a fresh successful/definitively failed MAIN scan.
   */
  function shellKind() {
    return safe(() => {
      const classic = document.querySelector(CLASSIC_TURN) !== null;
      const alternate = document.querySelector(SHELL_TURN) !== null;
      if (classic === alternate) return 'unknown';
      return alternate ? 'alternate' : 'classic';
    }, 'unknown');
  }

  // Read-only mirror of shared/operator-prompt.mts for this classic content script.
  // Generation and durable freezing belong to Main; the browser can only refuse Send.
  // Readback only: never regenerate trivia or alter an already-frozen legacy input.
  const OPERATOR_PROMPT_QUESTIONS = [
    'What color is the sky?', 'How many days are in a week?', 'What is your favorite season?',
    'Where do birds build nests?', 'Why do leaves change color?', 'What makes a rainbow?',
    'How do seeds grow?', 'Where does rain come from?', 'What do bees collect?',
    'How do fish breathe?', 'Why does ice float?', 'What causes ocean waves?',
    'How do clocks measure time?', 'Where do stars appear at night?', 'What shapes can clouds form?'
  ];
  const OPERATOR_PROMPT_HEADER_PREFIX = '[[COS_OPERATOR_QUESTIONS:';
  const OPERATOR_PROMPT_MAX_QUESTIONS = 2;
  const OPERATOR_PROMPT_HEADER_QUESTIONS = [
    'What is the most useful next step for this task given the verified context, and what evidence will show that it worked?',
    'Which existing implementation and verified results should be reused to avoid duplicate work while preserving the full task requirements?'
  ];
  const OPERATOR_PROMPT_FOOTER = 'IGNORE THE FIRST SENTENCE ABOVE.';
  function operatorPromptHeader(questionCount = 1) {
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > OPERATOR_PROMPT_MAX_QUESTIONS)
      throw new Error('Operator prompt header must contain one or two task questions');
    return `${OPERATOR_PROMPT_HEADER_PREFIX}${questionCount}]] ${OPERATOR_PROMPT_HEADER_QUESTIONS.slice(0, questionCount).join(' ')}`;
  }
  function operatorPromptStart(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    const firstBreak = normalized.indexOf('\n');
    const newline = firstBreak >= 0 && normalized[firstBreak - 1] === '\r' ? '\r\n' : '\n';
    const header = firstBreak < 0 ? normalized : normalized.slice(0, firstBreak - (newline.length - 1));
    if (header === operatorPromptHeader(1) || header === operatorPromptHeader(2))
      return { normalized, firstBreak, newline };
    const questions = header.endsWith('.') ? header.slice(0, -1).split(', ') : [];
    if (questions.length !== 10 || new Set(questions).size !== 10 ||
        questions.some(question => !OPERATOR_PROMPT_QUESTIONS.includes(question))) return null;
    return { normalized, firstBreak, newline };
  }
  function operatorPromptBody(value) {
    const start = operatorPromptStart(value);
    if (!start) return value;
    const suffix = start.newline + OPERATOR_PROMPT_FOOTER;
    if (start.firstBreak < 0 || !start.normalized.endsWith(suffix) ||
        start.normalized.length < start.firstBreak + 1 + suffix.length) return value;
    return start.normalized.slice(start.firstBreak + 1, -suffix.length);
  }
  function promptEnvelopeValid(value) {
    const body = operatorPromptBody(value);
    return typeof value === 'string' && value === value.trim() && body !== value &&
      !!body.trim() && !operatorPromptStart(body);
  }
  /** Read-only startup/health probe. No randomness, draft edits, native actions or settings. */
  function promptEnvelopeReady() {
    const body = 'CoS prompt envelope self-check';
    const prepared = `${operatorPromptHeader(1)}\n${body}\n${OPERATOR_PROMPT_FOOTER}`;
    const paired = `${operatorPromptHeader(2)}\n${body}\n${OPERATOR_PROMPT_FOOTER}`;
    const legacy = `${OPERATOR_PROMPT_QUESTIONS.slice(0, 10).join(', ')}.\n${body}\n${OPERATOR_PROMPT_FOOTER}`;
    return promptEnvelopeValid(prepared) && operatorPromptBody(prepared) === body &&
      promptEnvelopeValid(paired) && operatorPromptBody(paired) === body &&
      promptEnvelopeValid(legacy) && operatorPromptBody(legacy) === body &&
      !promptEnvelopeValid(body) && !promptEnvelopeValid(prepared + '\nExtra text') &&
      !promptEnvelopeValid(prepared.replace(`\n${body}\n`, `\n${prepared}\n`));
  }
  // A legacy adapter's own self-check can succeed while it only accepts the
  // old ten-question format. Advertise the exact contract this adapter checks;
  // this is readiness evidence only, never permission to alter or send a draft.
  function promptEnvelopeProtocol() {
    return promptEnvelopeReady() ? 2 : 0;
  }
  /** Voice transcription is local to this page. Freeze its wrapper once before draft capture. */
  function preparePromptEnvelope(value) {
    if (promptEnvelopeValid(value)) return value;
    if (typeof value !== 'string' || !value.trim()) throw new Error('Voice prompt is empty; nothing was sent');
    if (value.trimStart().startsWith(OPERATOR_PROMPT_HEADER_PREFIX))
      throw new Error('Voice prompt wrapper is malformed; nothing was sent');
    const prepared = `${operatorPromptHeader(1)}\n${value}\n${OPERATOR_PROMPT_FOOTER}`;
    if (!promptEnvelopeValid(prepared) || operatorPromptBody(prepared) !== value)
      throw new Error('Voice prompt wrapper validation failed; nothing was sent');
    return prepared;
  }

  // Wire framing matches shared/user-prompt.ts; neither reader changes provider text.
  const promptContinuation = value => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(value)?.[0] ?? '';
  function userPromptText(value) {
    value = operatorPromptBody(value.replace(/\r\n?/g, '\n'));
    const identity = promptContinuation(value);
    const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(value.slice(identity.length));
    if (!header) return null;
    const end = identity.length + header[0].length + Number(header[1]);
    const boundary = '\n[[/COS_CONTEXT]]\n\n';
    return value.startsWith(boundary, end) ? identity + value.slice(end + boundary.length) : null;
  }
  function presentUserPrompts(readUserText) {
    return safe(() => {
      for (const raw of document.querySelectorAll(
        `[data-message-author-role="user"] :is(.whitespace-pre-wrap, .markdown):not([data-clf-user-text]), ` +
        `${SHELL_TURN} [data-content-search-unit-key$=":user"] [data-user-message-bubble] .whitespace-pre-wrap:not([data-clf-user-text])`
      )) {
        // Both native renderers can consume Markdown bytes. Parse the same
        // exact-id source used by receipts/recording, never reconstructed HTML.
        const classic = raw.closest('[data-message-author-role="user"]');
        const holder = classic || raw.closest(SHELL_UNIT);
        const id = messageIdOf(holder);
        const source = !classic && (!id || !readUserText) ? null : readUserText
          ? readUserText({ role: 'user', id, node: raw.closest(TURN), text: messageText(holder, 'user') })
          : raw.textContent;
        // The native editor can prepend a blank paragraph to the exact provider
        // source. Ignore that outer whitespace only for display; the frame's
        // internal length/boundary and all receipt/recording bytes stay exact.
        const authored = typeof source === 'string' ? userPromptText(source.trimStart()) : null;
        let display = raw.nextElementSibling?.matches('[data-clf-user-text]') ? raw.nextElementSibling : null;
        if (authored === null) {
          raw.removeAttribute('data-clf-prompt-hidden'); display?.remove(); continue;
        }
        if (!display) {
          display = document.createElement('div');
          display.setAttribute('data-clf-user-text', '');
          display.className = 'whitespace-pre-wrap';
          display.dir = 'auto';
          raw.after(display);
        }
        if (display.textContent !== authored) display.textContent = authored;
        if (!raw.hasAttribute('data-clf-prompt-hidden')) raw.setAttribute('data-clf-prompt-hidden', '');
      }
    });
  }

  /**
   * Visible page text with every CLF-owned surface removed first.
   *
   * The synthetic stream is mounted inside an assistant turn. On the live page ChatGPT's
   * reasoning container can later expand/reparent around that mount, so reading the outer
   * container's textContent naively feeds our own rendered transcript back into the recorder.
   * That is the exact loop that produced twenty copies of the same assistant update. Clone
   * and strip our nodes before extracting page text. Unknown/fake DOMs fall back safely.
   */
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot, [data-clf-user-text]';
  // Provider-owned anchors only. A generic dialog or prose saying "Allow" is not a card.
  const APPROVAL_CARD = '[data-codex-approval-surface="true"], [data-codex-approval-surface=""], ' +
    '[data-testid="tool-approval-card"], [data-testid="mcp-approval-card"]';
  const APPROVAL_EXCLUDED = `${OWN_SURFACES},.markdown,[data-markdown-text-style],pre,code,blockquote,` +
    '[contenteditable],[data-message-author-role="user"],[data-content-search-unit-key$=":user"]';

  /**
   * Removes this extension's own rendered surfaces from a clone, in place.
   *
   * Every read of assistant DOM has to do this, not just pageText: our stream is mounted
   * inside the turn, so anything that reads the turn and feeds the result back into the
   * stream compounds on each repaint — one copy, then two, then three.
   */
  function stripOwn(clone) {
    if (!clone || typeof clone.querySelectorAll !== 'function') return clone;
    for (const own of clone.querySelectorAll(OWN_SURFACES)) own.remove();
    return clone;
  }

  function pageText(node, cap = 256_000) {
    return safe(() => {
      if (!node) return '';
      if (typeof node.cloneNode !== 'function') return text(node, cap);
      return text(stripOwn(node.cloneNode(true)), cap);
    }, '');
  }

  /** How an accessible page hides a live region from sight while keeping it announced. */
  const SCREEN_READER_ONLY = '.sr-only, .visually-hidden, [data-testid="visually-hidden"]';

  /**
   * Whether a node is rendered for a person to read, rather than only announced.
   *
   * The one thing this separates is a visible banner from a screen-reader-only live region.
   * Both are `role="alert"`; only one of them is an error the user saw.
   *
   * Two independent signals, because either alone is brittle: the conventional hiding class,
   * and a box clipped to the couple of pixels that hiding leaves behind.
   *
   * Anything else counts as displayed, including a box of zero size — that is what a DOM
   * with no layout engine reports for every node, and a DOM that cannot answer must not be
   * able to delete evidence of a real transport failure. The turn-outcome check reads this
   * same list, and silently losing an error there turns a failed turn into a completed one.
   */
  function displayed(node) {
    return safe(() => {
      if (!node) return true;
      if (typeof node.closest === 'function' && node.closest(SCREEN_READER_ONLY)) return false;
      if (typeof node.getBoundingClientRect !== 'function') return true;
      const rect = node.getBoundingClientRect();
      if (!rect) return true;
      const clipped = (size) => size > 0 && size <= 8;
      return !(clipped(rect.width) || clipped(rect.height));
    }, true);
  }

  /**
   * Conservative provider-auth state for browser delivery custody.
   *
   * Positive provider-owned controls are the only authority. Authored messages, the composer,
   * and CoS surfaces are excluded so text such as "sign in" can never pause or resume work.
   * Unknown is intentionally sticky on the app side: a provider DOM change must not turn missing
   * evidence into permission to release queued messages.
   */
  function authenticationState() {
    return safe(() => {
      const eligible = (node) => Boolean(
        node &&
        !node.closest?.(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) &&
        (typeof node.getClientRects !== 'function' || node.getClientRects().length > 0)
      );
      const profile = [
        ...document.querySelectorAll('[data-testid="accounts-profile-button"],[aria-label="Open profile menu"]')
      ].find(eligible);

      const login = [...document.querySelectorAll(
        '[data-testid="login-button"],button[aria-label="Log in"],button[aria-label="Sign in"],a[href]'
      )].find((node) => {
        if (!eligible(node)) return false;
        if (node.matches?.('[data-testid="login-button"],button[aria-label="Log in"],button[aria-label="Sign in"]')) return true;
        if (!node.matches?.('a[href]')) return false;
        try {
          const url = new URL(node.getAttribute('href') || '', location.href);
          const host = url.hostname.toLowerCase();
          const pathname = url.pathname.toLowerCase();
          return (host === 'chatgpt.com' || host.endsWith('.openai.com')) &&
            (pathname.includes('/auth/login') || pathname.includes('/log-in') || pathname.includes('/login') || pathname.includes('/signin'));
        } catch {
          return false;
        }
      });
      if (login) return 'signed-out';
      // The signed-out sidebar also ships plain buttons without test ids/aria labels.
      // Keep this fallback within native navigation, never authored message/composer content.
      const navigationLogin = [...document.querySelectorAll(
        'aside button,nav button,header button,[data-testid="sidebar"] button,[id="stage-slideover-sidebar"] button'
      )].find((node) => eligible(node) && /^(log in|sign in)$/i.test((node.textContent || '').trim()));
      return navigationLogin ? 'signed-out' : profile ? 'signed-in' : 'unknown';
    }, 'unknown');
  }
  /**
   * ChatGPT sometimes renders transport failures inside the same `.markdown` shape as
   * a final assistant answer. Treating "Message delivery timed out … Retry" as model
   * prose makes a broken/reloaded turn look completed. role=alert remains the primary
   * signal; these are narrow fallbacks for failure copy observed on the live site.
   */
  /**
   * Authored message text, without ChatGPT's controls around it.
   *
   * Reading the whole `[data-message-id].textContent` also captures UI chrome. The live
   * page reproduced stored messages ending `Show moreShow less`, which polluted session
   * history and compaction. Prefer ChatGPT's content subtrees; strip controls only as a
   * fallback for an unfamiliar renderer shape.
   */
  function messageText(node, role) {
    return safe(() => {
      if (!node) return '';
      if (role === 'user') {
        // Only blocks that nothing else here already contains. `querySelectorAll` also
        // returns a match nested inside an earlier match, and `text()` reads a whole
        // subtree, so an inner block was read twice: once as part of its container and
        // once on its own. The recorded message then carried that passage twice, and every
        // reader comparing authored text against what was submitted saw a message longer
        // than the one it sent. `node` itself never counts as a container: the query cannot
        // return it, and treating it as one would empty this preferred path.
        const parts = [...node.querySelectorAll('.whitespace-pre-wrap')]
          .filter((part) => {
            const outer = part.parentElement && part.parentElement.closest &&
              part.parentElement.closest('.whitespace-pre-wrap');
            return !outer || outer === node || !(node.contains && node.contains(outer));
          })
          .filter(part => !part.hasAttribute?.('data-clf-user-text'))
          .map((part) => text(part))
          .filter(Boolean);
        if (parts.length > 0) return parts.join('\n');
      }
      if (role === 'assistant') {
        const parts = [...node.querySelectorAll('.markdown')]
          .filter((part) => !(part.closest && part.closest('[data-interrupted]')))
          .filter((part) => !(part.closest && part.closest(TOOL)))
          .map((part) => text(part))
          .filter(Boolean);
        if (parts.length > 0) return parts.join('\n\n');
      }
      // Structural test fakes and a future partial DOM shim may not implement cloneNode.
      // The live browser always does, but falling back to the node's own text is safer than
      // turning an otherwise valid authored message into an empty string. Real ChatGPT
      // still takes the clone/remove path, which is what strips Show more / Show less.
      if (typeof node.cloneNode !== 'function') return role === 'assistant' ? '' : text(node);
      const clone = node.cloneNode(true);
      // Our own surfaces first, and this is not defensive tidying. A live assistant
      // container with no authored `.markdown` fell through to here and returned the whole
      // node — which contains the stream this extension drew into that very turn. The
      // recorder stored `▣Listed open windows … ›_Ran …` as the assistant's final answer.
      // Anything that reads a turn and feeds the result back into the stream compounds on
      // every repaint, so the strip has to happen before any fallback, not only in
      // pageText().
      stripOwn(clone);
      for (const control of clone.querySelectorAll('button, [role="button"], [data-testid*="copy"], [data-testid*="feedback"], [data-testid="assistant-message-reaction"]')) {
        control.remove();
      }
      // Everything the preferred path above excludes, excluded here too — otherwise the
      // fallback is not a fallback, it is a different and much laxer rule that fires
      // exactly when the strict one found nothing.
      //
      // Tool rows are ChatGPT's chrome, not its prose, and are reported separately as
      // page_tool activity; reading them here turned one answer into a transcript of its
      // own tool labels. Commentary is not the answer either: a turn that narrated its
      // work and then produced no prose would otherwise have its narration promoted to
      // `final: true`, which is what closes a turn and what a recovery later trusts.
      //
      // Nothing authored left is the honest record. An assistant final is the one thing a
      // reader takes as "what it said", so absence beats a plausible-looking invention.
      if (role === 'assistant') {
        for (const row of clone.querySelectorAll(TOOL)) row.remove();
        for (const commentary of clone.querySelectorAll('[data-interrupted]')) commentary.remove();
      }
      return text(clone);
    }, '');
  }

  /**
   * What ChatGPT itself has put into a section, as a value comparable with a later reading.
   *
   * Deliberately not `textContent`. content.js uses "this section's text changed since the
   * baseline" as evidence that the generation now running is writing into it — and this
   * extension rewrites the visible label of tool rows *inside assistant sections* as steps
   * land (`applyLabel`, `applyPageLabel`). Raw text therefore changes in sections ChatGPT
   * has not touched, and our own relabel of an old row was enough to bind a finished
   * section to the new generation and file this turn's work under the previous answer.
   *
   * So it is built only from signals this extension does not write: authored prose, and how
   * many tool rows the page is showing. A relabel moves neither. New prose or a new row
   * moves one, which is precisely the page-authored activity the caller is asking about.
   */
  function sectionSignature(node) {
    return safe(() => {
      if (!node || typeof node.querySelectorAll !== 'function') return '0|0|';
      // Structural, so it survives a relabel: this extension rewrites what a row *says*,
      // never how many there are. A row appearing is page activity; "Inspecting" becoming
      // "Inspected" is ours.
      const rows = [...node.querySelectorAll(TOOL)].filter(
        (row) => !(row.closest && row.closest(OWN_SURFACES))
      ).length;
      let authored = '';
      if (typeof node.cloneNode === 'function') {
        // Everything ChatGPT put here, with the two things this extension writes taken out:
        // its own surfaces, and the tool rows whose labels it rewrites. Commentary counts —
        // it is usually the *first* thing a new generation writes, and a signature made of
        // final prose and rows alone stayed identical through the whole commentary phase,
        // so a generation writing into an already-mounted section could not be recognised
        // and its visible commentary was never recorded at all.
        const clone = stripOwn(node.cloneNode(true));
        for (const row of clone.querySelectorAll(TOOL)) row.remove();
        authored = text(clone);
      } else {
        authored = [...node.querySelectorAll('.markdown')]
          .filter((part) => !(part.closest && (part.closest(TOOL) || part.closest(OWN_SURFACES))))
          .map((part) => text(part))
          .join('\n');
      }
      return `${rows}|${authored.length}|${authored.slice(-96)}`;
    }, '0|0|');
  }

  /** Current short provider card that directs the user to OpenAI support. */
  function openAiSupportFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /^something went wrong\.? please contact,? open\s*ai support\.?(?: retry)?$/i.test(line);
  }

  /** Current provider placeholder for an answer body that failed to render. */
  function messageDisplayFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /^unable to display this message due to an error\.?(?: retry)?$/i.test(line);
  }

  /** A provider-owned whole-page conversation load failure with one native Retry control. */
  function conversationLoadFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /^(?:could not load (?:this |the )?chatgpt conversation|unable to load (?:this |the )?(?:chatgpt )?conversation)\.?(?: retry| try again)?$/i.test(line);
  }

  /**
   * ChatGPT's whole-page conversation-load failure, represented by its one Retry control.
   *
   * The provider gives this card no stable test id or role. Keep the proof structural and
   * locale-independent: an existing /c/ route, no composer or mounted turn, a small main
   * surface, and exactly one enabled visible button. This must never match an ordinary chat.
   */
  function conversationLoadRetryControl() {
    return safe(() => {
      if (!conversationId() || composer() || document.querySelector(`${TURN},[data-turn-key]`)) return null;
      const area = document.querySelector('[data-app-shell-focus-area="main"]') || document.querySelector('main');
      if (!area) return null;
      // The failed-load shell now retains an empty pending-conversation textarea and
      // disabled composer controls. It is not a mounted conversation or an authored draft.
      const editors = [...area.querySelectorAll('[contenteditable="true"],textarea,[role="textbox"]')];
      if (editors.some(node => !node.matches('textarea#pending-conversation-input') || composerHasDraft(node))) return null;
      if (area.querySelector('form') && editors.length !== 1) return null;
      const value = (area.textContent || '').replace(/\s+/g, ' ').trim();
      if (!value || value.length > 300) return null;
      const buttons = [...area.querySelectorAll('button')].filter(button =>
        !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        !button.closest(`${OWN_SURFACES},[hidden],[inert],[aria-hidden="true"]`) && button.getClientRects().length > 0);
      if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return null;
      const failure = retryFailure(buttons[0]);
      return failure && conversationLoadFailure(failure.text) ? buttons[0] : null;
    }, null);
  }

  /** The provider's failed continuation surface, with or without a native Retry button. */
  function resumeStreamFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /^resume stream unavailable\.?(?: retry| try again)?$/i.test(line);
  }

  function transportFailure(value, providerNode = null) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    if (/^(?:a entrega da mensagem atingiu o tempo limite(?:\. tente novamente\.?)?|conexão interrompida\.? aguardando a resposta completa\.?)(?: tentar novamente)?$/i.test(line)) return true;
    // This new wording is native error chrome only, never authored answer/quotation text.
    if (/^error in input stream\.?(?: retry)?$/i.test(line) && providerNode &&
        typeof providerNode.closest === 'function' && typeof providerNode.querySelector === 'function') {
      const authored = `${OWN_SURFACES},.markdown,blockquote,pre,code,[data-message-author-role="user"],[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`;
      if (!providerNode.closest(`${authored},[hidden],[inert],[aria-hidden="true"]`) &&
          !providerNode.querySelector(`${authored},[data-message-author-role]`)) return true;
    }
    return openAiSupportFailure(line) || messageDisplayFailure(line) || conversationLoadFailure(line) ||
      resumeStreamFailure(line) ||
      /^invalid url \(\s*post\s+\/api\/f\/conversation\/resume\s*\)\.?(?: retry)?$/i.test(line) ||
      /^(?:message delivery timed out(?:\. please try again(?: later)?\.?)?|connection interrupted\.? (?:waiting|please wait) for the complete answer\.?|chatgpt stream recovery polling timed out\.?|stream cache expired\.?|failed to fetch\.?|unknown error occurred\.?|there was an error generating (?:a|the) response\.?|error in message stream\.?|network error\.?|a network error occurred(?:\. (?:if this issue persists please contact us through our help center at help\.openai\.com\.?|please check your connection and try again\.?)?)?\.?|something went wrong\.?|something went wrong while generating the response(?:\. if this issue persists please contact us through our help center at help\.openai\.com\.?)?\.?)(?: retry)?$/i.test(line);
  }

  /**
   * A model-specific capacity failure, distinct from the account-wide access-limit dialog.
   *
   * ChatGPT currently renders this as a small failed-answer surface (usually with Retry),
   * but its exact punctuation has changed. Keep the vocabulary narrow and require either the
   * provider's explicit "cooldown" term or a model/Pro-qualified temporary-unavailability
   * sentence. This is never run over authored markdown, so a user discussing cooldowns cannot
   * grant an automatic browser action.
   */
  function modelCooldownFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    if (!line || line.length >= 500 || /^too many requests\b/i.test(line)) return false;
    return /\b(?:this |the )?model(?: is|'s)?(?: currently)? on cooldown\b/i.test(line) ||
      /\b(?:pro|model)\b.{0,120}\btemporarily unavailable\b.{0,120}\b(?:retry|try again|later|high demand)\b/i.test(line) ||
      /\btemporarily unavailable\b.{0,120}\b(?:pro|model)\b.{0,120}\b(?:retry|try again|later|high demand)\b/i.test(line);
  }

  /**
   * ChatGPT's terminal conversation-length notice.
   *
   * This is deliberately a phrase intersection rather than a loose "limit" search. The
   * caller runs it only over native provider chrome outside authored Markdown, and the text
   * must name this chat/conversation, a maximum/reached condition and the new-chat action.
   * A user or assistant discussing context limits therefore cannot move the local session.
   */
  function conversationLimitFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    if (!line || line.length >= 700) return false;
    const conversation = /\b(?:this|the current)\s+(?:chat|conversation)\b|\bconversation(?:'s| has| is)\b/i.test(line);
    const exhausted = /\b(?:reached|hit|at)\b.{0,80}\b(?:the )?(?:maximum|max(?:imum)?|length|limit)\b|\b(?:maximum|max(?:imum)?)\s+(?:conversation\s+)?length\b|\b(?:chat|conversation)\s+(?:has\s+)?(?:reached|hit)\s+(?:its|the)\s+limit\b/i.test(line);
    const replacement = /\b(?:start(?:ing)?|creat(?:e|ing)|open(?:ing)?|continue(?: talking)? in|move to|use)\b.{0,90}\bnew\s+(?:chat|conversation)\b|\bnew\s+(?:chat|conversation)\b.{0,90}\b(?:start|create|open|continue|move|use)\b/i.test(line);
    return conversation && exhausted && replacement;
  }

  /** A non-alert terminal card anchored by its provider-owned New Chat control. */
  function conversationLimitCard(button) {
    return safe(() => {
      // Most page buttons are unrelated. Reject them from cheap attributes/textContent before
      // forcing a rendered-text read; retryFailure() shares this button scan below.
      const quick = (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '')
        .replace(/\s+/g, ' ').trim();
      if (!/^(?:start|create|open|continue in) (?:a )?new (?:chat|conversation)$/i.test(quick)) return null;
      const label = (button.getAttribute('aria-label') || button.getAttribute('title') || button.innerText || button.textContent || '')
        .replace(/\s+/g, ' ').trim();
      if (!/^(?:start|create|open|continue in) (?:a )?new (?:chat|conversation)$/i.test(label) || !displayed(button)) return null;
      let node = button.parentElement;
      for (let up = 0; node && up < 8 && node !== document.body; up++, node = node.parentElement) {
        if (node.closest && node.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role="user"]`)) return null;
        const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (value.length >= 700) return null;
        if (displayed(node) && conversationLimitFailure(value)) return { text: value, node };
      }
      return null;
    }, null);
  }

  /**
   * A visible transport-failure card whose wrapper carries no alert role.
   *
   * The live 2026-09-03 renderer put the full help-center failure beside an exact Retry
   * button, outside assistant markdown and without `role="alert"`. The accessible live
   * region announced unrelated toast text instead, so the real failure never reached the
   * session and recovery waited for the two-minute silence fallback. Start from the page's
   * semantic control and climb only to the nearest whole recognised notice; never search
   * arbitrary page prose for error wording.
   */
  function retryFailure(button) {
    return safe(() => {
      // Localized controls have no trustworthy action vocabulary. Exclude large/common page
      // chrome from their structural observation before any rendered-text read; exact English
      // Retry/Try again remains the existing provider-owned action anchor in those surfaces.
      const quick = (button.textContent || '').replace(/\s+/g, ' ').trim();
      const quickEnglish = /^(?:retry|try again)$/i.test(quick);
      if (!quickEnglish && button.closest('nav, aside, header, form, [role="navigation"], [role="menu"]')) return null;
      const label = (button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim();
      const english = /^(?:retry|try again)$/i.test(label);
      if (!label || !displayed(button)) return null;
      if (english) {
        if (button.closest('.markdown, [data-message-author-role="user"]')) return null;
      } else if (button.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role], [hidden], [inert], [aria-hidden="true"]`)) {
        return null;
      }
      let node = button.parentElement;
      for (let up = 0; node && up < 8 && node !== document.body; up++, node = node.parentElement) {
        if (node.closest && node.closest(OWN_SURFACES)) return null;
        // `innerText` can force style/layout over an entire sidebar. Bound cheap raw text first.
        const content = node.textContent || '';
        if (content.length >= 500) return null;
        const value = (node.innerText || content).replace(/\s+/g, ' ').trim();
        if (value.length >= 500) return null;
        if (!displayed(node)) continue;
        if (english) {
          if (transportFailure(value, node)) return { text: value, node, retry: button };
          // Some cards render the button label as part of the wrapper text although the failure
          // vocabulary itself ends before it. Exact English still grants the existing handle.
          let notice = '';
          if (value.endsWith(label)) {
            notice = value.slice(0, -label.length).trim();
            if (notice && transportFailure(notice, node)) return { text: notice, node, retry: button };
          }
          if (modelCooldownFailure(value) || (notice && modelCooldownFailure(notice))) {
            return { text: notice || value, node, retry: button, reason: 'model_cooldown', recoverable: false };
          }
          continue;
        }
        // A localized label identifies no action. It may reveal a roleless provider occurrence
        // only when the complete small card ends in that label and owns exactly one visible
        // button. Return no Retry handle: the existing fenced reload owner remains authoritative.
        const visibleButtons = [...node.querySelectorAll('button')].filter(control =>
          !control.closest('[hidden], [inert], [aria-hidden="true"]') && displayed(control));
        if (visibleButtons.length !== 1 || visibleButtons[0] !== button || !value.endsWith(label)) continue;
        const notice = value.slice(0, -label.length).trim();
        if (notice && transportFailure(notice, node)) return { text: notice, node };
      }
      return null;
    }, null);
  }

  /**
   * The conversation a ChatGPT path names, or null when it names none.
   *
   * A conversation inside a Project is routed as `/g/<project>/c/<id>`, so anchoring at
   * `/c/` recognised only chats at the site root. Everything downstream — the app session,
   * the ownership registry, caller attribution — is keyed on this id, so in a Project the
   * page was never recognised as being on a conversation at all.
   *
   * Deliberately not a loose `/c/<id>` search anywhere in the path: `/share/c/<id>` is a
   * public read-only snapshot of someone's conversation, not a conversation this document
   * can own, record or bind. One optional `/g/<slug>` segment is the whole exception.
   */
  function conversationFromPath(pathname) {
    return safe(() => {
      const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(String(pathname || ''));
      return match ? match[1] : null;
    }, null);
  }

  /** The conversation this tab is on, or null for a chat that has not been sent yet. */
  function conversationId() {
    return safe(() => conversationFromPath(location.pathname), null);
  }

  /** Human ChatGPT title when one has actually been generated; never conversation identity. */
  function conversationTitle() {
    return safe(() => {
      let value = (document.title === decoratedTabTitle ? nativeTabTitle : document.title || '').trim();
      if (!value) return '';
      value = value.replace(/\s*(?:[-|·]\s*)ChatGPT\s*$/i, '').trim();
      if (!value || /^(?:ChatGPT|New chat)$/i.test(value)) return '';
      return value.slice(0, 200);
    }, '');
  }

  // A projection of existing automation state, never a new execution or recovery owner.
  const nativeTabIcons = new Map();
  let nativeTabTitle = '', decoratedTabTitle = '', tabStatusIcon = null;
  let tabIconObserver = null, tabIconProjection = null;
  function setTabStatus(mode, activity = '') {
    const styles = { goal: ['Goal', '#15803d', 'G'], loop: ['Loop', '#1d4ed8', 'L'],
      worker: ['Worker', '#475569', 'W'], chat: ['Chat', '#475569', '1'],
      'one-off': ['One-off', '#475569', '1'], 'page-error': ['Page error', '#92400e', '!'],
      'page-working': ['Page unavailable; Core active', '#1d4ed8', 'C'],
      'page-unknown': ['Page unavailable; activity unknown', '#92400e', '?'], error: ['Attention', '#b91c1c', '!'] };
    const style = styles[mode];
    if (!style) {
      tabIconObserver?.disconnect(); tabIconObserver = null; tabIconProjection = null;
      for (const [node, prior] of nativeTabIcons) {
        if (node.isConnected && node.getAttribute('href') === prior.applied) {
          node.setAttribute('href', prior.href);
          if (prior.type === null) node.removeAttribute('type'); else node.setAttribute('type', prior.type);
        }
      }
      nativeTabIcons.clear();
      tabStatusIcon?.remove(); tabStatusIcon = null;
      if (decoratedTabTitle && (document.title === decoratedTabTitle || document.title === decoratedTabTitle.trimEnd())) {
        document.title = nativeTabTitle;
      }
      decoratedTabTitle = ''; nativeTabTitle = '';
      return;
    }
    if (document.title !== decoratedTabTitle) {
      // A status refresh can cross an isolated-world reinjection or a brief cleanup/repaint gap.
      // The visible title may still carry our exact prior prefix even though this adapter no
      // longer has the matching `decoratedTabTitle` string. Never stack one CoS status inside
      // the next; the prefix is app-owned presentation, so strip only that exact vocabulary.
      nativeTabTitle = document.title.replace(
        /^CoS (?:Goal|Loop|Worker|Chat|One-off|Attention|Page error|Page unavailable; Core active|Page unavailable; activity unknown)(?: · (?:Working|Waiting|Recovering))? ·(?: |$)/,
        ''
      );
    }
    const activityLabel = activity === 'working' ? 'Working' : activity === 'waiting' ? 'Waiting'
      : activity === 'recovering' ? 'Recovering' : '';
    decoratedTabTitle = `CoS ${style[0]}${activityLabel ? ` · ${activityLabel}` : ''} · ${nativeTabTitle}`;
    if (document.title !== decoratedTabTitle) document.title = decoratedTabTitle;
    // Keep the mode letter/color stable while making motion state visible in the favicon
    // itself: a dot means work is moving; pause bars mean the chat is still/waiting. This is
    // presentation only and uses the same activity fact already shown in the tab title.
    const activityMark = activity === 'working'
      ? '<circle cx="25" cy="7" r="3" fill="white"/>'
      : activity === 'waiting'
        ? '<path d="M23 4h2v6h-2zm4 0h2v6h-2z" fill="white"/>'
        : activity === 'recovering'
          ? '<path d="M22 8a5 5 0 1 1 3 4" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M21 4h5v5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="7" fill="${style[1]}" stroke="white" stroke-width="2"/><text x="16" y="23" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="23" fill="white">${style[2]}</text>${activityMark}</svg>`;
    const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const icons = [...document.head.querySelectorAll('link[rel~="icon"]')];
    if (!icons.length) {
      tabStatusIcon = document.createElement('link'); tabStatusIcon.rel = 'icon';
      document.head.append(tabStatusIcon); icons.push(tabStatusIcon);
    }
    for (const node of icons) {
      if (node !== tabStatusIcon) {
        const prior = nativeTabIcons.get(node);
        if (!prior || node.getAttribute('href') !== prior.applied)
          nativeTabIcons.set(node, { href: node.getAttribute('href') || '', type: node.getAttribute('type'), applied: href });
        else prior.applied = href;
      }
      if (node.getAttribute('href') !== href) node.setAttribute('href', href);
      if (node.type !== 'image/svg+xml') node.type = 'image/svg+xml';
    }
    for (const node of nativeTabIcons.keys()) if (!node.isConnected) nativeTabIcons.delete(node);
    tabIconProjection = { mode, activity, href };
    // React can replace/reset head icons without a transcript mutation. Repair only
    // our existing projection, not the conversation or any delivery state. Comparing
    // actual attributes makes our own mutations inert and avoids a polling timer.
    if (!tabIconObserver && typeof MutationObserver === 'function') {
      tabIconObserver = new MutationObserver(() => {
        const projection = tabIconProjection;
        if (!projection) return;
        const currentIcons = [...document.head.querySelectorAll('link[rel~="icon"]')];
        if (!currentIcons.length || currentIcons.some(node =>
          node.getAttribute('href') !== projection.href || node.type !== 'image/svg+xml')) {
          setTabStatus(projection.mode, projection.activity);
        }
      });
      tabIconObserver.observe(document.head, { childList: true, subtree: true,
        attributes: true, attributeFilter: ['href', 'rel', 'type'] });
    }
  }

  /**
   * Logical conversation turns, newest last.
   *
   * ChatGPT can render one assistant request as several sibling `section` elements
   * carrying the same data-turn-id. Treating each section as a turn makes a five-call
   * request look like several partial requests, so every one fails content.js's
   * one-block-per-call safety check and the page is left with a wall of "Called tool".
   * Group only consecutive sections that explicitly share role + id. A user question
   * separates responses even when ChatGPT reuses the same page id. Recording and
   * presentation must agree on that boundary; otherwise one final descriptor is joined
   * to both the old and current local generation and loses its completion owner.
   * Id-less sections stay independent because merging those would be a guess.
   */
  /**
   * What this layer has already read out of a section, kept until the section changes.
   *
   * The content script reads the whole transcript once a second, and several times over: the
   * recorder's message scan, the presentation pass per assistant turn, the progress and tool
   * row lookups. Each of those walked every section and took the text of every message on the
   * page again — six to eight full walks a second, on a page that only ever changes in one
   * place. On a 300-turn chat that was most of a second of main thread per second, and the
   * 2026-09-03 prime, over 300k tokens, sat unresponsive for three minutes after every reload.
   *
   * A section's rows, tool blocks and progress boxes are therefore read once and kept on the
   * element. A MutationObserver of our own drops the entry for any section whose subtree or
   * relevant attributes change, and — because a test, or React inside one frame, can mutate
   * and read back before the observer's microtask runs — its pending records are drained
   * synchronously before every cached read. Sections we never see mutate cost nothing after
   * their first read; the one being streamed into is re-read as it grows, as it always was.
   */
  const sectionCache = new WeakMap();
  let cacheObserver = null;
  let cacheObserverFailed = false;
  const CACHE_ATTRIBUTES = [
    'class',
    'data-interrupted',
    'data-message-id',
    'data-message-author-role',
    'data-turn',
    'data-turn-id',
    'data-testid',
    'aria-label',
    'data-turn-key',
    'data-content-search-turn-key',
    'data-content-search-unit-key',
    'data-clf-fiber-turn',
    'data-clf-fiber-message'
  ];

  function invalidateFrom(record) {
    const target = record && record.target;
    if (!target) return;
    const element = target.nodeType === 1 ? target : target.parentElement;
    const section = element && typeof element.closest === 'function' ? element.closest(TURN) : null;
    if (section) sectionCache.delete(section);
    const slot = element?.closest?.(SHELL_UNIT);
    if (slot) sectionCache.delete(slot);
  }

  function ensureCacheObserver() {
    if (cacheObserver) return true;
    if (cacheObserverFailed) return false;
    try {
      if (typeof MutationObserver !== 'function' || !document.body) return false;
      cacheObserver = new MutationObserver((records) => {
        for (const record of records) invalidateFrom(record);
      });
      cacheObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: CACHE_ATTRIBUTES
      });
      return true;
    } catch {
      cacheObserverFailed = true;
      cacheObserver = null;
      return false;
    }
  }

  /** The memo for one section, valid as of now. Null when caching is unavailable. */
  function memoOf(section) {
    if (!section || !ensureCacheObserver()) return null;
    for (const record of cacheObserver.takeRecords()) invalidateFrom(record);
    let memo = sectionCache.get(section);
    if (!memo) {
      memo = { rows: null, parts: null, blocks: null, boxes: null, interrupted: null, answers: null };
      sectionCache.set(section, memo);
    }
    return memo;
  }

  /** The explicit messages of one section: id, the role attribute, text. */
  function sectionRows(section) {
    const memo = memoOf(section);
    if (memo && memo.rows) return memo.rows;
    const rows = [];
    const explicit = [...section.querySelectorAll('[data-message-id]')];
    const shell = [...(section.matches?.(SHELL_UNIT) ? [section] : []), ...section.querySelectorAll(SHELL_UNIT)];
    const seen = new Set();
    for (const node of [...explicit, ...shell]) {
      if (seen.has(node)) continue;
      seen.add(node);
      const id = messageIdOf(node);
      if (!id) continue;
      const roleAttr = node.getAttribute('data-message-author-role') || shellRole(node);
      const readable = roleAttr === 'user' || roleAttr === 'assistant';
      rows.push({ id, roleAttr, text: readable ? messageText(node, roleAttr) : null, node });
    }
    if (memo) memo.rows = rows;
    return rows;
  }

  const shellRole = node => /:(user|assistant)$/.exec(node?.getAttribute?.('data-content-search-unit-key') || '')?.[1] || '';
  function turnIdOf(section) {
    if (!section?.matches?.(SHELL_TURN)) return section?.getAttribute?.('data-turn-id') || null;
    // The new shell's content-search key can be only a positional fallback (fallback-turn-0,
    // fallback-turn-1, ...). The exchange's own data-turn-key is the stable UUID identity and
    // must win so virtualization cannot silently move recorded work to another turn.
    const key = section.getAttribute('data-turn-key');
    if (key && !/^fallback-turn-\d+$/.test(key)) return key;
    return section.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key') || null;
  }
  function messageIdOf(node) {
    const explicit = node?.getAttribute?.('data-message-id');
    if (explicit) return explicit;
    // A shell unit key is a layout key, not a provider message id. Trust only the exact
    // same-scan MAIN stamp produced from the typed shell item.
    const section = node?.closest?.(SHELL_TURN), turn = section?.getAttribute('data-clf-fiber-turn');
    const stamp = node?.getAttribute?.('data-clf-fiber-message');
    if (!turn || node?.getAttribute?.('data-clf-fiber-turn') !== turn || !stamp?.startsWith(`${turn}:`)) return null;
    try { return decodeURIComponent(stamp.slice(turn.length + 1)) || null; } catch { return null; }
  }

  /** The authored markdown blocks of one section, for a turn without explicit messages. */
  function sectionParts(section) {
    const memo = memoOf(section);
    if (memo && memo.parts) return memo.parts;
    const parts = [];
    for (const markdown of section.querySelectorAll('.markdown')) {
      if (markdown.closest && markdown.closest('[data-interrupted]')) continue;
      if (markdown.closest && markdown.closest(TOOL)) continue;
      if (markdown.closest && markdown.closest(OWN_SURFACES)) continue;
      const value = text(markdown);
      if (value && parts[parts.length - 1] !== value) parts.push(value);
    }
    if (memo) memo.parts = parts;
    return parts;
  }

  /**
   * Whether a node belongs to an earlier page ChatGPT keeps mounted but undisplayed. A Project
   * redirect can retain its prior page surface with a complete editor, header, and turn tree;
   * those nodes are not candidates on the page the user can currently see.
   */
  function onKeptPage(node) {
    for (let page = node?.closest?.('[data-app-shell-page-surface]'); page;
      page = page.parentElement?.closest('[data-app-shell-page-surface]')) {
      if (getComputedStyle(page).display === 'none') return true;
    }
    return false;
  }
  /**
   * The exact page-model user id of a shell exchange whose user slot is not rendered.
   *
   * MAIN names it with `data-clf-fiber-user` (fiber.js) only when the page model holds exactly
   * one user message for the exchange. It counts only under the exchange's current turn stamp,
   * like every other MAIN stamp: a stale or foreign one reads as no user message at all.
   */
  function unrenderedUserIdOf(section) {
    const turn = section?.getAttribute?.('data-clf-fiber-turn'), stamp = section?.getAttribute?.('data-clf-fiber-user');
    if (!turn || !stamp?.startsWith(`${turn}:`)) return null;
    try { return decodeURIComponent(stamp.slice(turn.length + 1)) || null; } catch { return null; }
  }
  function turns() {
    return safe(() => {
      const out = [];
      let previous = null;
      const classic = [...document.querySelectorAll(CLASSIC_TURN)];
      const shell = [...document.querySelectorAll(SHELL_TURN)];
      // The provider normally mounts one shell family at a time. If a transition momentarily
      // exposes both, the union query restores true document order. Keeping the ordinary
      // classic query separate also preserves compatibility with older/test DOM facades that
      // implement that stable selector but not selector-list discovery.
      const discovered = classic.length && shell.length ? [...document.querySelectorAll(TURN)]
        : classic.length ? classic : shell;
      for (const node of discovered) {
        if (onKeptPage(node)) continue;
        // Classic conversation sections are already semantic top-level owners and historically
        // pass through untouched. The nesting fence exists for the alternate shell only, where
        // quoted/search-unit markup can repeat shell-looking attributes below the real exchange.
        if (node.matches?.(SHELL_TURN) &&
            node.closest?.(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`)) continue;
        const id = turnIdOf(node);
        if (node.matches?.(SHELL_TURN)) {
          const users = [...node.querySelectorAll('[data-content-search-unit-key$=":user"]')]
            .filter(slot => slot.closest('[data-turn-key]') === node);
          const answered = [...node.querySelectorAll('[data-chatgpt-agent-turn-start], [data-content-search-unit-key$=":assistant"]')]
            .find(candidate => candidate.closest('[data-turn-key]') === node);
          // Multiple user slots are ambiguous and stay unread. A missing slot is not: ChatGPT
          // can retain the exact page-model user id while drawing only the answer. MAIN stamps
          // that one id under this exact exchange/scan; text still comes from the same model.
          const unrendered = users.length ? null : unrenderedUserIdOf(node);
          if (users.length > 1 || !id || (!users.length && !answered && !unrendered)) continue;
          if (users.length) out.push({ node: users[0], nodes: [users[0]], id, role: 'user' });
          else if (unrendered) out.push({ node, nodes: [node], id, role: 'user', unrenderedUserId: unrendered });
          if (answered) out.push({ node, nodes: [node], id, role: 'assistant' });
          previous = null;
          continue;
        }
        const role = node.getAttribute('data-turn');
        if (previous && id && previous.id === id && previous.role === role) {
          previous.nodes.push(node);
          continue;
        }
        previous = { node, nodes: [node], id, role };
        out.push(previous);
      }
      return out;
    }, []);
  }

  const presentationTurns = () => turns();

  const turnNodes = (turn) =>
    turn && Array.isArray(turn.nodes) && turn.nodes.length > 0 ? turn.nodes : turn && turn.node ? [turn.node] : [];

  /** Selector ownership stays here: callers ask semantic turn questions, never copy TURN. */
  function turnContainer(node) {
    return safe(() => node && typeof node.closest === 'function' ? node.closest(TURN) : null, null);
  }
  function turnMutationRelevant(node) {
    return safe(() => {
      if (!node || node.nodeType !== 1) return false;
      return Boolean(node.matches?.(TURN) || node.closest?.(TURN) || node.querySelector?.(TURN));
    }, false);
  }

  /**
   * Visible messages, newest last.
   *
   * textContent rather than innerText on purpose: a long user message is visually
   * clamped by ChatGPT, and the clamped part is exactly the part a five-hour session
   * cannot afford to lose.
   */
  // Read only the native badge beneath its exact stable user-message node. A
  // neighbouring assistant, quoted markup or recycled turn id cannot own it.
  const reactionSegments = new Intl.Segmenter('en', { granularity: 'grapheme' });
  function userMessageReaction(message) {
    if (message.role !== 'user' || !message.id || !message.node) return undefined;
    const holders = [...message.node.querySelectorAll('[data-message-author-role="user"][data-message-id]')];
    if (message.node.matches?.('[data-message-author-role="user"][data-message-id]')) holders.push(message.node);
    const owned = holders.filter(node => node.getAttribute('data-message-id') === message.id);
    if (owned.length !== 1) return undefined;
    const badges = [...owned[0].querySelectorAll('[data-testid="assistant-message-reaction"][role="img"]')]
      .filter(node => node.closest('[data-message-id]') === owned[0] && !node.closest('.markdown, .whitespace-pre-wrap'));
    if (!badges.length) return null;
    if (badges.length !== 1) return undefined;
    const emoji = badges[0].textContent?.trim() || '';
    // Keep aligned with shared/message-reaction.ts (extension ships unbundled).
    return emoji.length <= 32 && /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u200d\ufe0f\u20e3\u{e0020}-\u{e007f}0-9#*])+$/u.test(emoji) &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji) &&
      [...reactionSegments.segment(emoji)].length === 1 ? emoji : undefined;
  }

  function messages() {
    return safe(() => {
      const out = [];
      const seen = new Set();
      for (const [index, turn] of turns().entries()) out.push(...messagesIn(turn, index, seen));
      return out;
    }, []);
  }

  /**
   * The messages of exactly one turn.
   *
   * Split out of messages() rather than duplicated because callers that need turn-scoped
   * evidence — "did *this* turn produce an answer" — must read the page the same way the
   * whole-conversation scan does, including the no-data-message-id fallback below. Asking
   * that question by filtering messages() on `turnId` is not the same thing: sections
   * ChatGPT renders without a turn id all report `turnId: null`, so the filter silently
   * merges every id-less turn into one.
   *
   * `seen` is shared by the whole-conversation scan so a message id rendered in two
   * sections is reported once. On its own each turn gets a fresh one.
   */
  function messagesIn(turn, index = 0, seen = new Set()) {
    return safe(() => {
      const out = [];
      const nodes = turnNodes(turn);
      let explicit = 0;
      // No slot to read: the id is the page model's, and content.js takes the exact text from
      // that same page model (userMessageSource), never from what happens to be on screen.
      if (turn.role === 'user' && turn.unrenderedUserId) {
        if (seen.has(turn.unrenderedUserId)) return out;
        seen.add(turn.unrenderedUserId);
        return [{ id: turn.unrenderedUserId, role: 'user', text: '', turnId: turn.id, node: nodes[0], interrupted: false }];
      }
      for (const section of nodes) {
        for (const row of sectionRows(section)) {
          if (seen.has(row.id)) continue;
          const role = row.roleAttr || turn.role;
          if (role !== 'user' && role !== 'assistant') continue;
          if (section.closest?.(SHELL_TURN) && role !== turn.role) continue;
          seen.add(row.id);
          explicit++;
          out.push({
            id: row.id,
            role,
            // Read with the section's own role attribute when it has one; a node that carries
            // none is read under the turn's role, which the cache cannot know in advance.
            text: row.text !== null ? row.text : messageText(row.node, role),
            turnId: turn.id,
            node: section,
            interrupted: interrupted(turn)
          });
        }
      }

      // The current ChatGPT renderer no longer gives streaming assistant prose a
      // data-message-id. Final prose is still exposed as `.markdown`; live progress
      // prose is also `.markdown`, but lives under `[data-interrupted]`. Only use the
      // fallback when there is no explicit assistant message and only collect
      // markdown outside progress/tool containers. content.js itself waits until the
      // turn has stopped generating before recording this as the final answer.
      if (turn.role === 'assistant' && explicit === 0 && !nodes[0]?.matches?.(SHELL_TURN)) {
        const parts = [];
        for (const section of nodes) {
          for (const value of sectionParts(section)) {
            if (parts[parts.length - 1] !== value) parts.push(value);
          }
        }
        if (parts.length > 0) {
          // The live renderer can leave several assistant-authored markdown blocks in one
          // logical turn: interim commentary messages followed by the actual final answer.
          // Joining them all promoted the whole visible work log to one "final answer" and
          // later re-recorded those interim messages under an older reused page turn id.
          // The final answer is the last authored markdown block. Canonical transcript
          // identity/content is captured from ChatGPT's message model by fiber.js; this DOM
          // fallback is used only for local lifecycle/compaction decisions.
          const value = parts[parts.length - 1];
          if (!transportFailure(value)) {
            out.push({
              id: `assistant:${turn.id || index}`,
              role: 'assistant',
              text: value,
              turnId: turn.id,
              node: nodes[0] || null,
              interrupted: interrupted(turn)
            });
          }
        }
      }
      return out;
    }, []);
  }

  /** A pre-Send draft lease lasts only for this operation and these exact DOM nodes. */
  function captureComposerDraft(value, stillCurrent = () => true, withdrawalCurrent = stillCurrent) {
    let box = composer(), host = composerBox() || composerActions()?.host;
    const scopedWithdrawal = withdrawalCurrent !== stillCurrent;
    const coreFingerprint = () => {
      const editor = composer(), scope = editor?.closest('form') || editor;
      const nodes = [...scope?.querySelectorAll('[app-mention-path]') || []];
      if (!nodes.length) return { nodes, shape: '' };
      const core = nativeConnectorMention();
      return nodes.length === 1 && core ? { nodes, shape: JSON.stringify([
        core.appId, core.connectorName, nodes[0].getAttribute('app-mention-path'),
        nodes[0].getAttribute('app-mention-display-name'), nodes[0].getAttribute('contenteditable'), nodes[0].textContent
      ]) } : null;
    };
    const capturedCore = scopedWithdrawal ? coreFingerprint() : null;
    const coreNodes = capturedCore?.nodes;
    const sameCore = () => {
      if (!scopedWithdrawal) return true;
      const current = coreFingerprint();
      return Boolean(capturedCore && current && current.shape === capturedCore.shape &&
        current.nodes.every((node, at) => node === coreNodes[at]));
    };
    let rebound = false;
    // Native rich-text normalization moves line breaks into paragraph structure.
    // Keep the same text comparison used by send receipts; editor identity and
    // trusted edits still revoke the lease even when a user only changes spacing.
    const compact = text => String(text || '').replace(/\s+/g, '');
    const insertedText = compact(editorText(box));
    let touched = false;
    let files = [];
    const events = ['input', 'change', 'keydown', 'pointerdown', 'paste', 'drop'];
    const changed = event => { if (event.isTrusted) touched = true; };
    for (const name of events) host?.addEventListener(name, changed, true);
    const same = () => !touched && stillCurrent() && composer() === box && box?.isConnected && compact(editorText(box)) === insertedText;
    const ownsAttachments = () => {
      if (!same() || !host) return false;
      const current = [...host.querySelectorAll('button[aria-label]')].filter(node => composerFileName(node));
      return current.length === files.length && current.every(node => files.includes(node)) &&
        !host.querySelector('[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]');
    };
    return {
      attachments(nodes) { if (same()) files = [...nodes]; },
      current: ownsAttachments,
      async clear() {
        if (!ownsAttachments() || !host || !sameCore()) return false;
        const current = [...host.querySelectorAll('button[aria-label]')].filter(node => composerFileName(node));
        if (current.length !== files.length || current.some(node => !files.includes(node)) ||
            host.querySelector('[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]')) return false;
        for (const node of current) {
          if (!same() || !node.isConnected) return false;
          node.click();
        }
        if (current.length) await new Promise(resolve => {
          let observer, timer;
          const finish = () => { observer?.disconnect(); clearTimeout(timer); resolve(); };
          const check = () => { if (!same() || !hasComposerAttachments()) finish(); };
          observer = new MutationObserver(check);
          observer.observe(host, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(finish, 1500); check();
        });
        return same() && !hasComposerAttachments() && sameCore() && clearPromptExact(value,
          scopedWithdrawal ? () => same() && sameCore() && !hasComposerAttachments() : undefined);
      },
      /*
       * React can remount the composer between insertion and native Send while preserving the
       * exact authored text. Follow that replacement once, and only while no trusted edit or
       * attachment can have changed ownership. Callers expose this only before Send
       * authorization, where a second native press is still impossible.
       */
      rebind() {
        if (rebound || touched || files.length || !stillCurrent() || same()) return false;
        const next = composer(), nextHost = composerBox() || composerActions()?.host;
        if (!next?.isConnected || next === box || compact(editorText(next)) !== insertedText || hasComposerAttachments()) return false;
        for (const name of events) host?.removeEventListener(name, changed, true);
        box = next;
        host = nextHost;
        rebound = true;
        for (const name of events) host?.addEventListener(name, changed, true);
        return same();
      },
      /** Withdraw only this live app draft; an opt-in cleanup lease never grants Send. */
      withdraw() {
        if (rebound || touched || files.length || !withdrawalCurrent() || hasComposerAttachments()) return false;
        let current = composer();
        if (!current?.isConnected || compact(editorText(current)) !== insertedText ||
            (scopedWithdrawal && current !== box) || !sameCore()) return false;
        if (current !== box) {
          const nextHost = composerBox() || composerActions()?.host;
          for (const name of events) host?.removeEventListener(name, changed, true);
          box = current;
          host = nextHost;
          rebound = true;
          for (const name of events) host?.addEventListener(name, changed, true);
        }
        // Native focus can synchronously replace the editor or its structured token. Recheck
        // the entire opt-in cleanup lease after focus rather than deleting the replacement.
        if (scopedWithdrawal) box.focus();
        current = composer();
        if (touched || !withdrawalCurrent() || current !== box || !box?.isConnected || !sameCore() ||
            compact(editorText(box)) !== insertedText || hasComposerAttachments()) return false;
        return clearPromptExact(value, scopedWithdrawal ? () => !touched && withdrawalCurrent() &&
          composer() === box && box?.isConnected && sameCore() && !hasComposerAttachments() : undefined);
      },
      dispose() { for (const name of events) host?.removeEventListener(name, changed, true); }
    };
  }

  /** A native control must belong to the rendered composer, never quoted history or a stale hidden tree. */
  function renderedComposerNode(node) {
    if (!node?.isConnected || node.closest(`${OWN_SURFACES}, ${TURN}, [data-message-author-role], [hidden], [aria-hidden="true"], [inert]`)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }

  const CONNECTOR_APP_ID = /^asdk_app_[a-zA-Z0-9_-]{1,160}$/;
  const connectorLabel = value => String(value || '').replace(/\s+/g, ' ').trim();
  const connectorNameKey = value => connectorLabel(value).normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /** The one narrow display-name rewrite observed when ChatGPT recreates a named Core app. */
  function recreatedConnectorName(expected, observed) {
    if (connectorNameKey(expected) === connectorNameKey(observed)) return true;
    const qualified = /^(.*?)\s+[—–-]\s+.+?\s+(Core)$/iu.exec(connectorLabel(expected));
    return Boolean(qualified && connectorNameKey(observed) ===
      `${connectorNameKey(qualified[1])} ${connectorNameKey(qualified[2])}`);
  }

  /** The one structured native app token owned by this composer, independent of cached labels. */
  function nativeConnectorMention() {
    return safe(() => {
      const box = composer();
      if (!box) return null;
      const scope = box.closest('form') || box;
      const mentions = [...scope.querySelectorAll('[app-mention-path]')]
        .filter(renderedComposerNode);
      if (mentions.length !== 1) return null;
      const mention = mentions[0];
      const path = mention.getAttribute('app-mention-path') || '';
      const appId = path.startsWith('app://') ? path.slice(6) : '';
      const connectorName = connectorLabel(mention.getAttribute('app-mention-display-name'));
      return CONNECTOR_APP_ID.test(appId) && connectorName &&
        mention.getAttribute('contenteditable') === 'false' ? { node: mention, appId, connectorName } : null;
    }, null);
  }

  function nativeConnectorMentionIdentity() {
    const mention = nativeConnectorMention();
    return mention ? { appId: mention.appId, connectorName: mention.connectorName } : null;
  }

  /** One exact structured native app token in this composer form, never authored text with the same name. */
  function connectorMentionIdentity(connectorName) {
    if (!connectorName) return null;
    const identity = nativeConnectorMentionIdentity();
    return identity && identity.connectorName === connectorLabel(connectorName)
      ? { appId: identity.appId } : null;
  }

  /** Whether the exact structured token also matches a previously observed app identity. */
  function connectorMentionSelected(connectorName, appId) {
    if (!CONNECTOR_APP_ID.test(appId) || !connectorLabel(connectorName)) return false;
    const identity = nativeConnectorMentionIdentity();
    // ChatGPT can render the installed connector's name as a lowercase slug. The
    // already-proven app ID remains mandatory; normalize only label punctuation/case.
    // Name-only discovery deliberately stays exact and cannot adopt another app ID.
    return identity?.appId === appId &&
      connectorNameKey(identity.connectorName) === connectorNameKey(connectorName);
  }

  /** Authored draft text with the form-owned exact native connector token excluded. */
  function composerAuthoredText(connectorName, appId) {
    return safe(() => {
      const box = composer();
      const mention = nativeConnectorMention();
      // ChatGPT freezes an app's display label per conversation even when the user later
      // renames that exact app. Reading retained authored bytes is therefore app-ID-bound,
      // while selection and empty-token insertion above remain label-strict. The caller must
      // still prove these bytes equal its exact claimed input before it may retain or Send them.
      if (!box || !CONNECTOR_APP_ID.test(appId) || !connectorLabel(connectorName) ||
          mention?.appId !== appId) return null;
      const clone = box.cloneNode(true);
      const mentions = [...clone.querySelectorAll('[app-mention-path]')];
      // A token inside the editor is part of its text serialization and must be removed.
      // A token beside the editor is already excluded by cloning only the editable region.
      if (mentions.length > 1 || (mentions.length === 1 &&
          mentions[0].getAttribute('app-mention-path') !== `app://${appId}`)) return null;
      mentions[0]?.remove();
      // Do not read innerText from this detached clone. Chromium can return an empty string
      // for detached rendered-text queries even while its ProseMirror paragraphs still contain
      // the complete authored draft. Read its stable structure instead: ChatGPT can keep the
      // whole draft in one P whose inline spans are separated by BR nodes, so top-level
      // textContent loses authored line breaks. Ignore non-rendered provider metadata rather
      // than admitting script/style text as part of the user's draft.
      const renderedText = node => {
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        const name = node.nodeName;
        if (name === 'BR') return '\n';
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(name) || node.hidden ||
            node.hasAttribute('hidden') || node.hasAttribute('inert') ||
            node.getAttribute('aria-hidden') === 'true' || node.style?.display === 'none' ||
            node.style?.visibility === 'hidden') return '';
        let value = [...node.childNodes].map(renderedText).join('');
        if (/^(P|DIV|LI|PRE|BLOCKQUOTE)$/.test(name) && !value.endsWith('\n')) value += '\n';
        return value;
      };
      const text = [...clone.childNodes].map(renderedText).join('');
      // Native mention insertion can leave a provider-owned zero-width boundary beside
      // the removed chip. Strip only boundaries; never rewrite zero-width authored text.
      return text.trim().replace(/^[\u200B\u2060\uFEFF]+|[\u200B\u2060\uFEFF]+$/g, '');
    }, null);
  }

  /** Inserts authored text beside an already selected exact native app token. */
  function insertPromptWithConnector(value, connectorName, appId, failure = () => undefined) {
    const reject = reason => {
      safe(() => failure(reason), undefined);
      return false;
    };
    try {
      const box = composer();
      if (!box || !connectorMentionSelected(connectorName, appId)) return reject('connector_missing');
      if (composerAuthoredText(connectorName, appId) !== '') return reject('existing_draft');
      const mentions = [...box.querySelectorAll('[app-mention-path]')]
        .filter(node => node.getAttribute('app-mention-path') === `app://${appId}`);
      // A form-sibling token does not occupy the editable region, so the ordinary exact-empty
      // insertion path already preserves it. An editor-owned token needs an insertion range
      // after that one immutable chip rather than select-all, which would delete Core itself.
      if (mentions.length === 0) return insertPrompt(value, false, failure);
      if (mentions.length !== 1 || value === '') return reject('connector_boundary');
      const mention = mentions[0];
      box.focus();
      const selection = document.getSelection();
      if (!selection || !box.isConnected || composer() !== box || document.activeElement !== box)
        return reject('composer_not_focused');
      const range = document.createRange();
      range.setStartAfter(mention);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!selection.rangeCount || !box.contains(selection.anchorNode) || !box.contains(selection.focusNode))
        return reject('selection_changed');
      const paragraph = document.createElement('p');
      const host = box.matches('[data-composer-markdown]') && box.closest('form[data-chatgpt-composer]')
        ? document.createElement('span') : paragraph;
      if (host !== paragraph) {
        host.setAttribute('data-prompt-literal-paste', '');
        paragraph.append(host);
      }
      value.split('\n').forEach((line, index) => {
        if (index) host.append(document.createElement('br'));
        host.append(document.createTextNode(line));
      });
      if (!document.execCommand('insertHTML', false, paragraph.innerHTML)) return reject('native_edit_rejected');
      const exact = box.isConnected && composer() === box && connectorMentionSelected(connectorName, appId) &&
        composerAuthoredText(connectorName, appId)?.replace(/\s+/g, '') === String(value).replace(/\s+/g, '');
      return exact ? true : reject('text_mismatch');
    } catch {
      return reject('insertion_exception');
    }
  }

  /** The provider's structurally primary app-name slot, never a subtitle/description. */
  function connectorMenuPrimaryLabel(button) {
    const primary = [...button.querySelectorAll('span')]
      .find(node => !node.children.length && connectorLabel(node.textContent));
    return connectorLabel(primary?.textContent);
  }

  /** Exact visible installed-app row in ChatGPT's native composer menu. */
  function connectorMenuOption(connectorName) {
    return safe(() => {
      const wanted = connectorLabel(connectorName);
      if (!wanted) return null;
      const options = [...document.querySelectorAll('button[data-list-navigation-item="true"]')]
        .filter(button => renderedComposerNode(button) && connectorMenuPrimaryLabel(button) === wanted);
      return options.length === 1 ? options[0] : null;
    }, null);
  }

  /** The one structural Add control owned by the current composer. */
  function connectorMenuControl() {
    const form = composer()?.closest('form');
    if (!form) return null;
    const controls = [...form.querySelectorAll('button[data-composer-navigation-target="add-context"]')]
      .filter(button => renderedComposerNode(button) && button.closest('form') === form &&
        !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    return controls.length === 1 ? controls[0] : null;
  }

  /** The captured Add control's one rendered plugins section and its private scroll viewport. */
  function connectorMenuRevealContext(control, form) {
    if (!form || !control?.isConnected || composer()?.closest('form') !== form ||
        control.closest('form') !== form || connectorMenuControl() !== control) return null;
    const sections = [...document.querySelectorAll('[data-mention-section-id="plugins"]')]
      .filter(renderedComposerNode);
    if (sections.length !== 1) return null;
    const scrollAreas = [...document.querySelectorAll('[data-mention-list-scroll-area]')]
      .filter(scrollArea => renderedComposerNode(scrollArea) && scrollArea.contains(sections[0]));
    if (scrollAreas.length !== 1) return null;
    const context = { control, scrollArea: scrollAreas[0], section: sections[0] };
    // When the provider exposes an ownership edge, require it. Older menu builds omit
    // aria-controls, so their unique rendered structural context remains the authority.
    const controlledId = control.getAttribute('aria-controls');
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (!controlled || (controlled !== context.scrollArea && !controlled.contains(context.scrollArea))) return null;
    }
    return context;
  }

  function connectorOptionInsideViewport(option, scrollArea) {
    const optionRect = option.getBoundingClientRect();
    const viewportRect = scrollArea.getBoundingClientRect();
    if (![optionRect.top, optionRect.bottom, optionRect.height,
      viewportRect.top, viewportRect.bottom, viewportRect.height].every(Number.isFinite) ||
        optionRect.height <= 0 || viewportRect.height <= 0) return false;
    return optionRect.top >= viewportRect.top && optionRect.bottom <= viewportRect.bottom;
  }

  /**
   * A transaction-local reader that reveals, then rescans, only the exact installed-app row.
   *
   * ChatGPT can mount the plugins section with its exact row below a tiny virtualized viewport.
   * Never scroll the page or search labels outside this menu. Two distinct structural actions
   * are enough: one can hydrate the section, and one can reveal the resulting exact row. An
   * unchanged structural fingerprint is a cooldown: it cannot dispatch the same scroll twice.
   */
  function connectorMenuOptionReader(connectorName) {
    const wanted = connectorLabel(connectorName);
    const form = composer()?.closest('form') || null;
    const control = form ? connectorMenuControl() : null;
    const baseline = control ? connectorMenuRevealContext(control, form) : null;
    let ownedContext = baseline && (control.getAttribute('aria-controls') ||
      control.getAttribute('aria-expanded') === 'true') ? baseline : null;
    // An already-open picker in older shells can omit aria-controls/aria-expanded and keep its
    // exact row unmounted below the virtual viewport. Close and reopen only this composer's same
    // Add control to create a transaction-local ownership edge; never adopt the pre-existing
    // document-wide menu merely because it is unique.
    let reopenPhase = baseline && !ownedContext ? 'close' : '';
    let actions = 0, lastAction = null;
    let pendingScrollRebind = null, scrollRebinds = 0;
    const adoptOwnedScrollRemount = (context, option) => {
      const pending = pendingScrollRebind;
      if (!pending || scrollRebinds >= 1 || !context) return false;
      const viewportChanged = context.scrollArea !== pending.scrollArea;
      const sectionChanged = context.section !== pending.section;
      if (!viewportChanged && !sectionChanged) return false;
      // Only the direct replacement of nodes retired by this reader's own menu-local scroll
      // may inherit its context. A still-mounted old viewport/section is competing evidence.
      if ((viewportChanged && pending.scrollArea.isConnected) ||
          (sectionChanged && pending.section.isConnected) ||
          control.getAttribute('aria-expanded') === 'false' ||
          Math.abs(context.scrollArea.scrollTop - pending.nextTop) > 1) {
        pendingScrollRebind = null;
        return false;
      }
      // Hydration may mount the replacement viewport before its exact row. Pin that one
      // structural replacement so a later unrelated remount cannot spend the scroll receipt.
      if (!pending.replacement) pending.replacement = context;
      else if (pending.replacement.scrollArea !== context.scrollArea ||
          pending.replacement.section !== context.section) {
        pendingScrollRebind = null;
        return false;
      }
      if (!option) return false;
      if (!context.section.contains(option) || !connectorOptionInsideViewport(option, context.scrollArea)) {
        pendingScrollRebind = null;
        return false;
      }
      ownedContext = context;
      pendingScrollRebind = null;
      scrollRebinds += 1;
      return true;
    };
    return () => safe(() => {
      if (!wanted || !form || !control) return null;
      const option = connectorMenuOption(wanted);
      const context = connectorMenuRevealContext(control, form);
      if (!context) {
        if (reopenPhase === 'closing') {
          control.click();
          reopenPhase = 'opening';
        }
        return null;
      }
      if (!ownedContext) {
        if (baseline && reopenPhase === 'close') {
          control.click();
          reopenPhase = 'closing';
          return null;
        }
        if (baseline && reopenPhase === 'closing') return null;
        // `opening` proves this same captured composer control completed one close/reopen cycle;
        // a provider may reuse the same popup nodes, so node replacement is not required.
        ownedContext = context;
        reopenPhase = '';
      } else if (context.scrollArea !== ownedContext.scrollArea || context.section !== ownedContext.section) {
        if (!adoptOwnedScrollRemount(context, option)) return null;
      }
      const { scrollArea, section } = context;
      if (option && !section.contains(option)) return null;
      if (option && connectorOptionInsideViewport(option, scrollArea)) {
        pendingScrollRebind = null;
        return option;
      }
      if (actions >= 2) return null;

      const viewportRect = scrollArea.getBoundingClientRect();
      const targetRect = (option || section).getBoundingClientRect();
      const viewportHeight = scrollArea.clientHeight || viewportRect.height;
      const maxTop = Math.max(0, scrollArea.scrollHeight - viewportHeight);
      if (!viewportHeight || !viewportRect.height || !targetRect.height || !maxTop) return null;
      const currentTop = scrollArea.scrollTop;
      let nextTop = currentTop;
      if (option) {
        if (targetRect.top < viewportRect.top) nextTop += targetRect.top - viewportRect.top;
        else if (targetRect.bottom > viewportRect.bottom) nextTop += targetRect.bottom - viewportRect.bottom;
      } else if (targetRect.top >= viewportRect.bottom) {
        nextTop += targetRect.top - viewportRect.top;
      } else if (targetRect.bottom > viewportRect.bottom) {
        nextTop += Math.max(1, Math.floor(viewportHeight * 0.8));
      } else if (targetRect.top < viewportRect.top) {
        nextTop += targetRect.top - viewportRect.top;
      }
      // Provider popup bounds can be fractional CSS pixels. Rounding toward the
      // current offset leaves the exact row clipped by a fraction, then the next
      // scan computes the same offset and stalls forever. Round in the reveal
      // direction instead; keep the full-visibility and bounded-action checks.
      nextTop = Math.max(0, Math.min(maxTop,
        nextTop > currentTop ? Math.ceil(nextTop) : Math.floor(nextTop)));
      if (nextTop === currentTop) return null;
      const action = { scrollArea, section, option, nextTop,
        scrollHeight: scrollArea.scrollHeight, clientHeight: scrollArea.clientHeight };
      if (lastAction && Object.keys(action).every(key => action[key] === lastAction[key])) {
        // A rounded CSS offset can quantize short of this same still-clipped row. Only
        // the previous owned action's unchanged, measured shortfall may spend the remaining
        // reveal action on a distinct farther offset; full visibility still decides acceptance.
        const direction = Math.sign(lastAction.nextTop - lastAction.fromTop);
        if (!option || !Number.isFinite(currentTop) || lastAction.observedTop !== currentTop || !direction ||
            direction * (currentTop - lastAction.fromTop) < 0 || direction * (nextTop - currentTop) <= 0) return null;
        const farther = Math.max(0, Math.min(maxTop, nextTop + direction));
        if (farther === nextTop) return null;
        action.nextTop = nextTop = farther;
      }

      actions += 1;
      lastAction = { ...action, fromTop: currentTop };
      scrollArea.scrollTop = nextTop;
      lastAction.observedTop = scrollArea.scrollTop;
      pendingScrollRebind = { scrollArea, section, nextTop, replacement: null };
      scrollArea.dispatchEvent(new Event('scroll'));

      // A scroll event can synchronously replace either the virtual row or the menu container.
      // Re-establish every structural and exact-name invariant. One replacement can inherit
      // this reader only through the exact bounded scroll receipt above.
      const rescanned = connectorMenuOption(wanted);
      const rescannedContext = connectorMenuRevealContext(control, form);
      if (rescannedContext && (rescannedContext.scrollArea !== ownedContext.scrollArea ||
          rescannedContext.section !== ownedContext.section) &&
          !adoptOwnedScrollRemount(rescannedContext, rescanned)) return null;
      if (!rescanned || !rescannedContext) return null;
      if (rescannedContext.scrollArea !== ownedContext.scrollArea ||
          rescannedContext.section !== ownedContext.section ||
          !rescannedContext.section.contains(rescanned) ||
          !connectorOptionInsideViewport(rescanned, rescannedContext.scrollArea)) return null;
      pendingScrollRebind = null;
      return rescanned;
    }, null);
  }

  /**
   * Clicks one already-proven app row and returns a reader for only the token that click creates.
   *
   * The provider may normalize both the token label and app id when it recreates an app, so those
   * values alone cannot prove causality. Instead this transaction observes the exact clicked row
   * leaving its menu and one new structured token entering the current composer after the click.
   * A pre-existing/interleaved foreign token, a row that stays open, duplicate tokens, or user
   * input cancels the receipt. The caller still owns route/draft/time bounds.
   */
  function selectConnectorMenuOption(option, connectorName, expectedAppId) {
    return safe(() => {
      const wanted = connectorLabel(connectorName);
      const form = composer()?.closest('form') || null;
      const control = form ? connectorMenuControl() : null;
      const context = control ? connectorMenuRevealContext(control, form) : null;
      if (!wanted || !CONNECTOR_APP_ID.test(expectedAppId) || !form || !control || !context ||
          connectorMenuOption(wanted) !== option ||
          !context.section.contains(option) || !connectorOptionInsideViewport(option, context.scrollArea) ||
          nativeConnectorMention()) return null;
      const route = location.href;
      const initialComposer = composer();
      if (!initialComposer || initialComposer.closest('form') !== form) return null;
      // Keep mutation-time ownership even when React replaces the editor before the observer
      // callback. A detached target that belonged to this captured form is still causal history;
      // remounting the composer must not erase an interleaved foreign token.
      const ownedFormNodes = new WeakSet([form, ...form.querySelectorAll('*')]);
      // Capture only the menu-owned ancestor chain. Stop before the first common ancestor that
      // also owns the composer form, so a document/app-shell mutation cannot impersonate exact
      // menu retirement while viewport or portal-wrapper hiding remains record-local proof.
      const menuAuthorityNodes = new Set();
      for (let node = option; node && node !== document.body && node !== document.documentElement;
        node = node.parentElement) {
        if (node !== option && node.contains(form)) break;
        menuAuthorityNodes.add(node);
      }
      let disposed = false;
      let interrupted = false;
      let optionRetired = false;
      const addedMentions = new Set();
      const acceptedMentions = new Set();
      const mentionsIn = node => {
        if (!(node instanceof Element)) return [];
        return [...(node.matches('[app-mention-path]') ? [node] : []),
          ...node.querySelectorAll('[app-mention-path]')];
      };
      const mentionIdentity = node => {
        if (!(node instanceof Element)) return null;
        const path = node.getAttribute('app-mention-path') || '';
        const appId = path.startsWith('app://') ? path.slice(6) : '';
        const connectorName = connectorLabel(node.getAttribute('app-mention-display-name'));
        return CONNECTOR_APP_ID.test(appId) && connectorName &&
          node.getAttribute('contenteditable') === 'false' ? { node, appId, connectorName } : null;
      };
      const containsOption = node => node === option || node instanceof Element && node.contains(option);
      const exactOptionsIn = node => {
        if (!(node instanceof Element)) return [];
        return [...(node.matches('button[data-list-navigation-item="true"]') ? [node] : []),
          ...node.querySelectorAll('button[data-list-navigation-item="true"]')]
          .filter(button => button !== option && connectorMenuPrimaryLabel(button) === wanted);
      };
      const interrupt = () => { interrupted = true; };
      const authorityCurrent = () => location.href === route && composer()?.closest('form') === form &&
        control.isConnected && control.closest('form') === form && connectorMenuControl() === control;
      const capturedOptionActive = () => option.isConnected && renderedComposerNode(option) &&
        context.section.contains(option) && connectorMenuPrimaryLabel(option) === wanted;
      const optionAuthorityAmbiguous = () => authorityCurrent() && capturedOptionActive() &&
        connectorMenuOption(wanted) !== option;
      const semanticallyRetired = () => authorityCurrent() && !capturedOptionActive();
      const authorityMutation = record => {
        const target = record.target;
        if (!(target instanceof Node)) return false;
        const touchesOption = target === option || option.contains(target) ||
          target instanceof Element && menuAuthorityNodes.has(target);
        if (!touchesOption) return false;
        if (record.type === 'attributes') return ['hidden', 'aria-hidden', 'inert', 'style', 'class']
          .includes(record.attributeName || '');
        return record.type === 'characterData' || record.type === 'childList';
      };
      const recordSemanticallyRetires = (record, records, index) => {
        if (!authorityCurrent() || !option.isConnected || !context.section.contains(option) ||
            !authorityMutation(record)) return false;
        // MutationObserver exposes final DOM, not the intermediate DOM after each record. Only
        // the last row-authority mutation in this callback may consult that final state. This
        // prevents a later hide/recycle from being applied retroactively to an earlier token.
        if (records.slice(index + 1).some(authorityMutation)) return false;
        return !capturedOptionActive();
      };
      const readReceipt = () => {
        if (disposed || interrupted || !authorityCurrent()) {
          interrupted = true;
          return null;
        }
        if (optionAuthorityAmbiguous()) {
          interrupted = true;
          return null;
        }
        // Retirement is not sticky authority. If React removes and then remounts the same
        // captured row before observation, the menu is still open and the click has no durable
        // causal boundary for any token that appeared alongside that transient removal.
        if (optionRetired && capturedOptionActive()) {
          interrupted = true;
          return null;
        }
        const mention = nativeConnectorMention();
        return mention && addedMentions.has(mention.node) && optionRetired && acceptedMentions.has(mention.node)
          ? { appId: mention.appId, connectorName: mention.connectorName }
          : null;
      };
      const observeRecords = records => {
        if (disposed || interrupted) return;
        let retiredThisBatch = false;
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          if (!authorityCurrent()) {
            interrupted = true;
            break;
          }
          // A second exact structural row is ambiguity even if React removes it again before
          // this callback runs. Its MutationRecord is the causal evidence; final DOM state is
          // intentionally insufficient.
          for (const node of record.addedNodes || []) if (exactOptionsIn(node).length) {
            interrupted = true;
            break;
          }
          if (interrupted) break;
          // A single replacement record is atomic: retirement is processed before anything
          // that replacement adds. Across separate records their order is preserved, so a
          // foreign/normalized token inserted while the exact row was still live contaminates
          // this transaction even if another script removes the row immediately afterwards.
          for (const node of record.removedNodes || []) if (containsOption(node)) {
            optionRetired = true;
            retiredThisBatch = true;
          }
          if (!optionRetired && optionAuthorityAmbiguous()) {
            interrupted = true;
            break;
          }
          // Retirement is semantic as well as physical: hiding, recycling, relabelling or
          // moving the captured exact row out of its captured menu all retire that row. A
          // duplicate while it remains active was handled above as ambiguity instead.
          if (!optionRetired && recordSemanticallyRetires(record, records, index)) {
            optionRetired = true;
            retiredThisBatch = true;
          }
          const recordInForm = record.type === 'childList' && ownedFormNodes.has(record.target);
          if (recordInForm) for (const node of record.addedNodes || []) {
            if (!(node instanceof Node)) continue;
            ownedFormNodes.add(node);
            if (node instanceof Element) for (const descendant of node.querySelectorAll('*')) {
              ownedFormNodes.add(descendant);
            }
          }
          if (!recordInForm) continue;
          for (const node of record.addedNodes || []) for (const mentionNode of mentionsIn(node)) {
            addedMentions.add(mentionNode);
            const mention = mentionIdentity(mentionNode);
            const compatibleName = mention && (mention.connectorName === wanted ||
              recreatedConnectorName(wanted, mention.connectorName));
            const expectedIdentity = compatibleName && mention.appId === expectedAppId;
            const clickNormalizedIdentity = compatibleName && mention.appId !== expectedAppId &&
              retiredThisBatch;
            if (!mention || (!expectedIdentity && (!optionRetired || !clickNormalizedIdentity))) {
              // A settings-pinned app id is independent identity proof: React may commit its
              // token before retiring the picker row. readReceipt still requires that exact
              // row to retire before acceptance. A recreated/unpinned id has no such proof and
              // retains the stricter retirement-first, same-batch migration boundary.
              interrupted = true;
              continue;
            }
            // The bridge app id remains durable across observer batches. A provider-created id
            // or narrow name normalization is allowed only in the exact retirement batch from
            // this click; a same-label token arriving later cannot inherit the old transaction.
            acceptedMentions.add(mentionNode);
          }
          if (interrupted) break;
        }
        // A semantic retirement with no record-local proof becomes usable only by a future
        // observer batch. It can never authorize a token that appeared earlier in this batch.
        if (!interrupted && !optionRetired && semanticallyRetired()) optionRetired = true;
        readReceipt();
      };
      const observer = new MutationObserver(observeRecords);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        document.removeEventListener('pointerdown', interrupt, true);
        document.removeEventListener('keydown', interrupt, true);
      };
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true
      });
      document.addEventListener('pointerdown', interrupt, true);
      document.addEventListener('keydown', interrupt, true);
      option.click();
      // Process synchronous provider mutations in their recorded order before another script
      // can interleave. Asynchronous React commits continue through the same observer contract.
      observeRecords(observer.takeRecords());
      return {
        read: readReceipt,
        dispose
      };
    }, null);
  }

  /** Opens only the current composer's structural Add-context menu. */
  function openConnectorMenu(connectorName) {
    return safe(() => {
      const control = connectorMenuControl();
      if (!control) return false;
      const form = composer()?.closest('form');
      if (connectorMenuOption(connectorName) || connectorMenuRevealContext(control, form)) return true;
      control.click();
      return true;
    }, false);
  }

  function nativeComposerControls(selector) {
    const form = composer()?.closest('form');
    return [...(form || document).querySelectorAll(selector)].filter(button =>
      renderedComposerNode(button) && (!form || button.closest('form') === form));
  }

  const STOP_SQUARE = /^\s*M4\.5 5\.75/;
  function localeFreeStopControls() {
    const form = composer()?.closest('form');
    if (!form) return [];
    return [...form.querySelectorAll('button[class*="size-token-button-composer"][class*="bg-composer-primary"]')]
      .filter(button => {
        if (!renderedComposerNode(button) || button.closest('form') !== form || button.hasAttribute('data-state')) return false;
        const paths = button.querySelectorAll('svg path');
        return paths.length === 1 && STOP_SQUARE.test(paths[0].getAttribute('d') || '');
      });
  }

  function stopControls() {
    const modern = composer()?.closest('form')?.hasAttribute('data-chatgpt-composer');
    const labelled = nativeComposerControls(modern ? `${STOP}, button[type="button"][aria-label="Stop"]` : STOP);
    return labelled.length > 0 ? labelled : localeFreeStopControls();
  }

  /**
   * A provider-owned offer to move this exact turn into ChatGPT Work.
   *
   * The 2026-09-24 web shell can pause a normal chat behind a short modal after Send. The
   * modal's primary action moves the task into Work, while its countdown resumes ordinary
   * ChatGPT. COS must never click that migration action or declare the turn finished during
   * the pause. Match the visible provider dialog and both pieces of its own copy together;
   * authored prose mentioning Work is never authority.
   */
  function workModeInterstitial() {
    return safe(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(node => {
      if (node.closest(`${OWN_SURFACES}, ${TURN}, [data-message-author-role], .markdown, [hidden], [inert], [aria-hidden="true"]`) ||
          !node.getClientRects().length) return false;
      const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      return value.length < 4000 && /\bwork mode is (?:the )?better fit\b/i.test(value) &&
        /\bcontinue in chatgpt work\b/i.test(value);
    }) || null, null);
  }

  function latestRunningShell() {
    return [...document.querySelectorAll(SHELL_TURN)].filter(node =>
      !node.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`) &&
      !onKeptPage(node)).at(-1);
  }

  // Stop is witnessed once at the existing capture listener. All busy-state consumers
  // (lifecycle, model selection, compaction and Send) must read the same evidence. This
  // overrides only the stopped exchange's cached hint, never an actual native control.
  let stoppedShell = null;
  function clearStoppedTurn() { stoppedShell = null; }

  function shellQuestion(node) {
    const users = [...node.querySelectorAll('[data-content-search-unit-key$=":user"]')]
      .filter(slot => slot.closest('[data-turn-key]') === node);
    return users.length === 1 ? messageIdOf(users[0]) : unrenderedUserIdOf(node);
  }

  function noteStopClick(target) {
    const stop = stopButton();
    if (!stop || !(target instanceof Node) || !stop.contains(target) || stop.disabled ||
        stop.getAttribute('aria-disabled') === 'true') return false;
    const shell = latestRunningShell();
    const latest = turns().at(-1);
    stoppedShell = shell && latest?.role === 'assistant' && latest.node === shell && turnIdOf(shell)
      ? { path: location.pathname, node: shell, turn: turnIdOf(shell), question: shellQuestion(shell), settled: false }
      : null;
    return true;
  }

  /** Restore only an exact durable Stop; a cached shell hint is not a new generation. */
  function restoreStoppedTurn(questionId, expectedTurnId) {
    return safe(() => {
      if (typeof questionId !== 'string' || !questionId || stopControls().length || workModeInterstitial()) return false;
      const shell = latestRunningShell();
      const latest = turns().at(-1);
      if (!shell || !shell.isConnected || latest?.role !== 'assistant' || latest.node !== shell ||
          !turnIdOf(shell) || shellQuestion(shell) !== questionId ||
          (expectedTurnId && turnIdOf(shell) !== expectedTurnId)) return false;
      stoppedShell = { path: location.pathname, node: shell, turn: turnIdOf(shell), question: questionId, settled: true };
      return true;
    }, false);
  }

  /** Stop is a busy hint only; the exact provider terminal still owns turn completion. */
  function generating() {
    return safe(() => {
      const latest = latestRunningShell();
      if (stoppedShell && (stoppedShell.path !== location.pathname || stoppedShell.node !== latest ||
          stoppedShell.turn !== turnIdOf(latest) || stoppedShell.question !== shellQuestion(latest) ||
          turns().at(-1)?.node !== latest)) clearStoppedTurn();
      // The provider resumes this turn in ordinary ChatGPT after its countdown. Holding the
      // turn open here prevents Goal/Loop from writing through the modal or mistaking the
      // temporary absence of Stop for a completed answer.
      if (workModeInterstitial()) return true;
      if (stopControls().length > 0) {
        // A new native generation, even Retry of the same question, cannot inherit a
        // settled Stop. While the original Stop remains mounted it is still busy.
        if (stoppedShell?.settled) clearStoppedTurn();
        return true;
      }
      if (stoppedShell) {
        stoppedShell.settled = true;
        return false;
      }
      // Live Chrome: the shell retains in_progress after resume/network/delivery failures,
      // although Stop is gone and the current native alert offers Retry.
      // That cached hint cannot veto the provider's explicit failure. Keep real Stop
      // above authoritative and never use historical cards or authored quotations.
      if (latest && [...latest.querySelectorAll('[role="alert"]')].some(node =>
        !node.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-message-author-role="user"],[contenteditable],[hidden],[inert],[aria-hidden="true"]`) &&
        node.closest(SHELL_TURN) === latest && displayed(node) &&
        transportFailure(node.innerText || node.textContent || '', node))) return false;
      return latest?.getAttribute('data-clf-shell-running') === location.pathname;
    }, false);
  }

  // Shared only inside this extension's isolated document world. Adapter reinjection must
  // not reset a pending click's retry budget. Weak keys release removed cards naturally.
  const approvalAutomation = globalThis.__CLF_NATIVE_APPROVAL__ ||= {
    cards: new WeakMap(), running: false, diagnostics: new Map()
  };
  // A keyed native request keeps its budget when React replaces the element. Bound
  // this optional index independently of document lifetime; anonymous cards use weak keys.
  approvalAutomation.identities ||= new Map();
  const APPROVAL_RETRY_MS = 1500;
  const APPROVAL_MAX_ATTEMPTS = 3;
  const APPROVAL_BURST_LIMIT = 16;
  // Exact, one-time labels only; never match "Always allow", scopes or substrings.
  // Other languages need an explicit provider action attribute, not a positional guess.
  const APPROVAL_ONCE_LABEL = /^(?:allow(?: once| one time)?|zulassen|einmal zulassen|autoriser(?: une fois)?|permitir(?: una vez| uma vez)?|consenti(?: una volta)?|toestaan|eenmalig toestaan|一度だけ許可|今回のみ許可|允许(?:一次)?|允許(?:一次)?|한 번 허용)$/iu;
  const APPROVAL_ONCE_ACTIONS = new Set(['allow-once', 'approve-once']);
  const APPROVAL_ONCE_TEST_IDS = new Set(['allow-once-button', 'approve-once-button']);

  function approvalAttemptState(card) {
    const existing = approvalAutomation.cards.get(card);
    if (existing) return existing;
    const attribute = ['data-approval-id', 'data-request-id', 'data-tool-call-id']
      .find(name => card.hasAttribute(name));
    const id = attribute ? card.getAttribute(attribute) : null;
    const key = id && id.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(id)
      ? `${location.pathname}:${attribute}:${id}` : null;
    const state = (key && approvalAutomation.identities.get(key)) ||
      { path: location.pathname, attempts: 0, at: 0, key };
    if (key && !approvalAutomation.identities.has(key)) {
      if (approvalAutomation.identities.size >= 128)
        approvalAutomation.identities.delete(approvalAutomation.identities.keys().next().value);
      approvalAutomation.identities.set(key, state);
    }
    approvalAutomation.cards.set(card, state);
    return state;
  }

  /** Fixed diagnostics only: no tool arguments, page text, URLs or private error payloads. */
  function approvalDiagnostic(code) {
    const now = Date.now();
    const last = approvalAutomation.diagnostics.get(code);
    if (last !== undefined && now - last < 30_000) return;
    approvalAutomation.diagnostics.set(code, now);
    try {
      console.warn(`[Chat On Steroids] Native approval: ${code}; inspect the native card if it remains pending.`);
    } catch { /* Logging must not break recording or release a wait. */ }
  }

  function approvalVisible(node) {
    if (!node?.isConnected || node.closest(`${APPROVAL_EXCLUDED},[hidden],[inert],[aria-hidden="true"]`) ||
        onKeptPage(node) || !displayed(node)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden' || style.opacity === '0') return false;
    }
    return [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  }

  function pendingApprovalCard(card) {
    if (/^(?:approved|denied|resolved|completed)$/i.test(card.getAttribute('data-state') || '')) {
      // A provider-confirmed resolution may precede reuse of this same container.
      // Hiding/remounting a pending card does not replenish its click budget.
      const state = approvalAutomation.cards.get(card);
      if (state?.key && approvalAutomation.identities.get(state.key) === state) state.resolved = true;
      approvalAutomation.cards.delete(card);
      return false;
    }
    return approvalVisible(card);
  }

  /** A broken card stays unknown without preventing inspection of its healthy siblings. */
  function pendingApprovalCards() {
    const cards = [];
    let unknown = false;
    try {
      for (const card of document.querySelectorAll(APPROVAL_CARD)) {
        try {
          if (!pendingApprovalCard(card)) continue;
          // Bind loading/disabled cards before a route change can retain their DOM.
          approvalAttemptState(card);
          cards.push(card);
        } catch {
          unknown = true;
          approvalDiagnostic('card inspection failed');
        }
      }
    } catch { unknown = true; approvalDiagnostic('DOM scan failed'); }
    return { cards, unknown };
  }

  function approvalWaiting() {
    const { cards, unknown } = pendingApprovalCards();
    // Detection is read-only, including when called by Send, Goal and background probes.
    // Disabled/loading cards still hold continuation until the provider clears them.
    return unknown || cards.length > 0;
  }

  /** Used by the existing recorder observer, including button/visibility attribute changes. */
  function approvalMutationRelevant(node) {
    try {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return !!element && !element.closest(APPROVAL_EXCLUDED) &&
        !!(element.closest(APPROVAL_CARD) || element.querySelector(APPROVAL_CARD));
    } catch { approvalDiagnostic('mutation inspection failed'); return false; }
  }

  /** Keyboard hints decorate the native split button; they are not its accessible action. */
  function approvalLabelText(node) {
    const label = node.cloneNode(true);
    for (const hint of label.querySelectorAll('kbd,[hidden],[inert],[aria-hidden="true"],svg')) hint.remove();
    return label.textContent || '';
  }

  function approvalButton(card) {
    const buttons = [...card.querySelectorAll('button,[role="button"]')].filter(button =>
      button.closest(APPROVAL_CARD) === card && approvalVisible(button));
    const candidates = buttons.filter(button => {
      const actions = ['data-approval-action', 'data-action'].map(name => button.getAttribute(name)).filter(Boolean);
      const testId = button.getAttribute('data-testid');
      const labelledBy = button.getAttribute('aria-labelledby')?.trim().split(/\s+/);
      if (labelledBy && (labelledBy.length > 8 || labelledBy.some(id => !document.getElementById(id)))) return false;
      const label = ((labelledBy ? labelledBy.map(id => approvalLabelText(document.getElementById(id))).join(' ') : null) ||
        button.getAttribute('aria-label') || approvalLabelText(button))
        .normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (/^(?:always allow|allow for (?:this |the )?(?:chat|conversation)|deny|disallow|cancel|do not allow|don't allow|ablehnen|toujours autoriser|rechazar|negar)$/iu.test(label) ||
          /^allow .+ for (?:this |the )?(?:chat|conversation)$/iu.test(label) ||
          /^(?:deny|reject|always-allow|allow-always|allow-conversation)(?:-button)?$/.test(testId || '')) return false;
      // All explicit machine actions must agree; labels cannot override a Deny action.
      if (actions.length) return actions.every(action => APPROVAL_ONCE_ACTIONS.has(action));
      if (APPROVAL_ONCE_TEST_IDS.has(testId)) return true;
      return APPROVAL_ONCE_LABEL.test(label);
    });
    // Ambiguity is a pending card, never permission to select the first control.
    return candidates.length === 1 ? candidates[0] : null;
  }

  function approvalButtonReady(button) {
    if (!approvalVisible(button) || button.matches(':disabled') || button.hasAttribute('disabled') ||
        button.closest('[aria-disabled="true"]') ||
        button.closest('[aria-busy="true"]') || getComputedStyle(button).pointerEvents === 'none') return false;
    // Do not click through a modal/overlay. Offscreen cards wait for native layout/visibility.
    if (typeof document.elementFromPoint === 'function') {
      const rect = button.getClientRects()[0];
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !button.contains(hit)) return false;
    }
    return true;
  }

  /**
   * Personal-fork automation, invoked only by the elected live recorder. A click is an
   * attempt, never an answered receipt. Existing observer/ticks retry an intercepted click
   * at most three times with backoff; no new timer, synthetic event or background clicker.
   */
  function autoApproveIfNeeded(stillCurrent) {
    if (typeof stillCurrent !== 'function' || approvalAutomation.running) return 0;
    let attempts = 0;
    approvalAutomation.running = true;
    try {
      if (window.top !== window || !stillCurrent()) return 0;
      const path = location.pathname;
      const { cards } = pendingApprovalCards();
      for (const card of cards) {
        try {
          if (!stillCurrent() || location.pathname !== path) break;
          if (!pendingApprovalCard(card)) continue;
          const button = approvalButton(card);
          if (!button) { approvalDiagnostic('one-time action missing or ambiguous'); continue; }
          if (!approvalButtonReady(button)) continue;
          const now = Date.now();
          const previous = approvalAttemptState(card);
          if (previous.path !== path) continue;
          if (previous.resolved) continue;
          if (previous.attempts >= APPROVAL_MAX_ATTEMPTS) {
            approvalDiagnostic('retry limit reached');
            continue;
          }
          if (previous.attempts > 0 && now - previous.at < APPROVAL_RETRY_MS * previous.attempts) continue;
          // Revalidate immediately before dispatch, after all DOM reads and hit testing.
          if (!stillCurrent() || location.pathname !== path || !pendingApprovalCard(card) ||
              approvalButton(card) !== button || !approvalButtonReady(button)) continue;
          // Anonymous replacement nodes cannot prove a shared request id. Bound their
          // dispatch rate too, using existing ticks rather than a new retry timer.
          if (!approvalAutomation.burst || now - approvalAutomation.burst.at >= 1000 || now < approvalAutomation.burst.at)
            approvalAutomation.burst = { at: now, count: 0 };
          if (approvalAutomation.burst.count >= APPROVAL_BURST_LIMIT) {
            approvalDiagnostic('click burst held');
            break;
          }
          approvalAutomation.burst.count++;
          previous.attempts++;
          previous.at = now;
          attempts++;
          try { button.click(); approvalDiagnostic('allow-once click dispatched'); }
          catch { approvalDiagnostic('allow-once click failed'); }
        } catch { approvalDiagnostic('card inspection failed'); }
      }
    } catch { approvalDiagnostic('automation failed'); }
    finally { approvalAutomation.running = false; }
    return attempts;
  }

  function stopButton() {
    return safe(() => {
      const buttons = stopControls();
      return buttons.length === 1 ? buttons[0] : null;
    }, null);
  }

  /** Whether the native ChatGPT composer still owns an active voice/dictation capture. */
  function dictating() {
    return safe(() => {
      const form = composer()?.closest('form');
      if (!form) return false;
      return [...form.querySelectorAll(
        'button[data-testid="composer-speech-button"], button[data-testid="composer-dictate-button"], ' +
        'button[data-testid="composer-speech-stop-button"], button[data-testid="composer-dictate-stop-button"]'
      )].some(button => {
        const state = (button.getAttribute('data-state') || '').toLowerCase();
        const label = (button.getAttribute('aria-label') || '').toLowerCase();
        return button.getAttribute('aria-pressed') === 'true' ||
          ['active', 'listening', 'recording'].includes(state) ||
          /^(stop|finish|cancel) (dictation|voice)/.test(label);
      });
    }, false);
  }

  /** Only a visible, enabled native Stop control may end a proven turn. */
  function stopGeneration(stillCurrent) {
    if (typeof stillCurrent !== 'function' || !stillCurrent()) return false;
    const button = stopButton();
    if (!button || !button.isConnected || button.disabled || button.getAttribute('aria-disabled') === 'true' ||
        button.hidden || button.closest('[hidden],[inert]') || button.getClientRects().length === 0) return false;
    const style = getComputedStyle(button);
    if (style.display === 'none' || style.visibility === 'hidden' || !stillCurrent()) return false;
    button.click();
    return true;
  }

  /** The page-owned Send control, exposed so content.js can witness an actual submission. */
  function sendButton() {
    return safe(() => {
      const buttons = nativeComposerControls(SEND);
      return buttons.length === 1 ? buttons[0] : null;
    }, null);
  }

  // File tiles can appear while ChatGPT is still processing them and disables Send
  // through ARIA only. Upload readiness and the final click must use the same gate.
  function sendButtonEnabled(button) {
    return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }

  /**
   * The live progress line of a turn.
   *
   * ChatGPT keeps its running commentary inside the block it also marks with
   * data-interrupted, so that attribute doubles as the anchor for both.
   */
  function progressLine(turn) {
    return safe(() => {
      const parts = [];
      for (const section of turnNodes(turn)) {
        // Outermost containers only. These boxes nest, and reading whichever one came last
        // in document order made this value flip between the whole reasoning block and
        // whatever inner box was newest. A shrink is not a prefix of what came before, so
        // the delta below could only report it as brand-new text — which is exactly how the
        // same commentary line came to be printed two and three times.
        for (const box of progressRoots(section)) {
          const lines = pageText(box, 32_000)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length > 0) parts.push(lines.join('\n'));
        }
      }
      return parts.length > 0 ? parts.join('\n').slice(0, 8000) : null;
    }, null);
  }

  /**
   * The outermost commentary containers of one section, in document order.
   *
   * Outermost only. These boxes nest, and a scan that returns the inner ones too reports
   * the same sentence under two identities — which is how one caption came to be recorded,
   * and drawn, several times over.
   */
  /**
   * The identity a commentary root inherits from the prose block it swallowed, if any.
   *
   * The two families of item here are told apart by where the text sits: prose blocks are
   * `.markdown` *outside* a `[data-interrupted]` container, commentary is what is inside
   * one. ChatGPT moves text across that line mid-answer — it mounts the markdown first and
   * wraps it a moment later — and the same visible words were then reported twice, once
   * under each family's stamp. The commentary chain revises itself correctly, so what the
   * user saw was a frozen truncated prefix of their answer sitting above the answer:
   * "Yeah bro, I'll stay on the **current" and then the whole paragraph, in one turn.
   *
   * It is one block of text, so it gets one identity: the stamp the prose block already
   * carries from this same generation. Only when the root has exactly one stamped block —
   * two would make the inheritance a guess, and a guess here merges two different things
   * into one row.
   */
  function adoptedProseId(box, namespace) {
    if (!box || !box.querySelectorAll) return '';
    let found = '';
    for (const node of box.querySelectorAll('[data-clf-assistant-prose-id]')) {
      const stamp = node.getAttribute('data-clf-assistant-prose-id') || '';
      if (stamp.indexOf(`${namespace}#`) !== 0) continue;
      if (found) return '';
      found = stamp;
    }
    return found;
  }

  function progressRoots(section) {
    return [...section.querySelectorAll('[data-interrupted]')].filter(
      (node) => !(node.parentElement && node.parentElement.closest && node.parentElement.closest('[data-interrupted]'))
    );
  }

  /**
   * Stamps a list of nodes with per-generation identities, reusing a stamp only within the
   * generation that minted it.
   *
   * The namespace is the caller's generation key, and that is the whole point. Stamping
   * with ChatGPT's `data-turn-id` looked equivalent and was not: live, the page reuses the
   * id `request-<conversation>-0` for turn after turn, and it reuses the commentary
   * container node itself across turns as well. So a stamp minted on turn one was still
   * sitting on the node during turn four, every turn's commentary was recorded under one
   * identity, and the recorder folded four different captions into one row at the position
   * of the first. A stamp from another generation is therefore treated as absent.
   *
   * Within a generation the stamp is what ties identity to the node's own lifecycle: React
   * keeping the node — including reparenting it — keeps the id, and a container ChatGPT
   * genuinely replaces gets a new one. The ordinal is only how an unstamped node is *named*;
   * two nodes carrying the same stamp (React cloned a subtree) are separated rather than
   * merged, because merging them would put two different things in one row.
   */
  function stampIdentities(nodes, attribute, key, letter) {
    const namespace = `${key}#`;
    const taken = new Set();
    const ids = [];
    for (const node of nodes) {
      const stamp = node && node.getAttribute ? node.getAttribute(attribute) : null;
      if (stamp && stamp.indexOf(namespace) === 0 && !taken.has(stamp)) {
        taken.add(stamp);
        ids.push(stamp);
      } else {
        ids.push(null);
      }
    }
    let next = 0;
    for (let at = 0; at < nodes.length; at++) {
      if (ids[at]) continue;
      let id = `${namespace}${letter}${next++}`;
      while (taken.has(id)) id = `${namespace}${letter}${next++}`;
      taken.add(id);
      ids[at] = id;
      try {
        nodes[at].setAttribute(attribute, id);
      } catch {
        // A DOM that will not take the stamp still gets a usable id for this pass; it
        // simply cannot keep it across a redraw. One row per redraw is the old failure,
        // so the caller's own per-id state is what actually holds the line here.
      }
    }
    return ids;
  }

  /**
   * One commentary container's text, with the streaming double-write collapsed.
   *
   * `textContent` of a live commentary container is not the sentence on screen. While
   * ChatGPT streams, the container holds the raw markdown buffer *and* the parsed render of
   * the same words at the same time, so reading it naively returns
   * `…**that screenshot basically confirms` immediately followed by
   * `…that screenshot basically confirms the gate theory`. That is a real duplication in
   * what the page exposes, not a bug in how it is read, and every layer downstream that
   * tried to reconcile snapshots against each other was reconciling text that already said
   * everything twice.
   *
   * Two collapses, because the page produces the duplication in two shapes.
   *
   * Within a line, because there is very often no newline between the two copies at all.
   * The recorded example is a single line reading
   * `Yep bro, **that screenshot basically confirmsYep bro, that screenshot basically
   * confirms the gate theory` — the raw buffer runs straight into the rendered copy, and a
   * deduper that only looks across lines cannot see it. So a line that begins with a long
   * prefix which then starts again immediately is cut back to the second copy, which is the
   * complete one: the buffer is always the shorter, earlier half.
   *
   * Then across lines, where a block contained in one already kept — or containing one —
   * collapses to the longer of the two.
   *
   * Markdown punctuation is ignored for both comparisons; the text kept is always the
   * page's own, never a rewritten one. The prefix has to be long to count, because prose
   * legitimately repeats short openings and this must never eat a real sentence.
   */
  const MARKDOWN_CHAR = /[*_`#>~[\]()]/;
  const SPACE_CHAR = /\s/;
  const bareText = (value) => value.replace(/[*_`#>~[\]()]/g, '').replace(/\s+/g, ' ').trim();

  /** Shortest repeated opening that is taken as a streaming double-write rather than prose. */
  const MIN_ECHO_CHARS = 12;

  /**
   * Where the segment starting at `from` is immediately restated, or -1.
   *
   * A restatement has to be exact and back-to-back — `plain.slice(from, cut)` repeated at
   * `cut` — so this never fires on prose that merely opens the same way twice. The candidate
   * positions are the places the segment's own opening occurs again, which is a handful of
   * indices rather than every one; a commentary line can be thousands of characters long and
   * this runs on every container on every tick. The nearest candidate wins, because the
   * shortest restated segment is the one that was interrupted earliest.
   */
  function echoCut(plain, from) {
    const probe = plain.slice(from, from + MIN_ECHO_CHARS);
    if (probe.length < MIN_ECHO_CHARS) return -1;
    for (let at = plain.indexOf(probe, from + MIN_ECHO_CHARS); at > from; at = plain.indexOf(probe, at + 1)) {
      const width = at - from;
      if (at + width > plain.length) break;
      // Two words at minimum. A repeated single long word is a word, not a double-write.
      if (plain.slice(from, at).indexOf(' ') < 0) continue;
      if (plain.slice(from, at) === plain.slice(at, at + width)) return at;
    }
    return -1;
  }

  /**
   * A line the page wrote over itself while streaming, reduced to its last and fullest pass.
   *
   * Measured live: ChatGPT's commentary container briefly holds the paragraph it is replacing
   * alongside the replacement, and `innerText` runs the two together without a newline. The
   * result is not `A + A` but a chain of ever-longer prefixes — `**Schritt 3 erled` then
   * `Schritt 3 erledigt: Die ersten 15 Zeilen` then the same sentence carried further — all on
   * one line, which is how a single interim message came to be stored reading itself three and
   * four times over. Only `A + A` was recognised before, so none of that chain was caught.
   *
   * Each pass is a prefix of the one after it, so stripping the restated segment repeatedly
   * peels the chain from the front and leaves the last pass. Markdown punctuation is ignored
   * for the comparison; the text kept is always the page's own, never a rewritten one, and a
   * line the page did not double is returned untouched.
   */
  function dropEcho(line) {
    // React can briefly mount the old streaming buffer immediately beside the new one with
    // no separator at all. The smallest live reproducer was `I’veI’ve gotI’ve got ...`:
    // the old long-echo guard intentionally ignored the four-character first pass, so the
    // corruption survived and every later snapshot compounded it. Peel only *immediate*
    // duplicate prefixes whose join has no whitespace; normal prose such as `ha ha` keeps
    // its separating space and is therefore untouched. Repeating this also handles the
    // growing-prefix chain: A + AB + ABC -> AB + ABC -> ABC.
    let compact = line;
    for (;;) {
      let cut = -1;
      const max = Math.min(200, Math.floor(compact.length / 2));
      for (let width = 3; width <= max; width++) {
        const prefix = compact.slice(0, width);
        if (/\s$/.test(prefix) || /^\s/.test(compact.slice(width))) continue;
        if (compact.slice(width).startsWith(prefix)) {
          cut = width;
          break;
        }
      }
      if (cut < 0) break;
      compact = compact.slice(cut);
    }
    line = compact;
    if (line.length < MIN_ECHO_CHARS * 2) return line;
    const chars = [];
    const origin = [];
    for (let at = 0; at < line.length; at++) {
      const ch = line[at];
      if (MARKDOWN_CHAR.test(ch)) continue;
      if (SPACE_CHAR.test(ch)) {
        if (chars.length === 0 || chars[chars.length - 1] === ' ') continue;
        chars.push(' ');
        origin.push(at);
        continue;
      }
      chars.push(ch);
      origin.push(at);
    }
    const plain = chars.join('');
    let from = 0;
    for (let cut = echoCut(plain, from); cut > from; cut = echoCut(plain, from)) from = cut;
    return from === 0 ? line : line.slice(origin[from]).trim();
  }

  function commentaryText(node) {
    const blocks = pageText(node, 32_000)
      .split('\n')
      .map((line) => dropEcho(line.trim()))
      .filter(Boolean);
    const kept = [];
    for (const block of blocks) {
      const plain = bareText(block);
      if (!plain) continue;
      let merged = false;
      for (let at = 0; at < kept.length; at++) {
        const held = bareText(kept[at]);
        if (held.indexOf(plain) >= 0) {
          merged = true;
          break;
        }
        if (plain.indexOf(held) >= 0) {
          kept[at] = block;
          merged = true;
          break;
        }
      }
      if (!merged) kept.push(block);
    }
    return kept.join('\n').slice(0, 8000);
  }

  /**
   * This turn's visible commentary, as identified items rather than as one blob of text.
   *
   * `progressLine()` answers "what does the whole reasoning area say right now", which is
   * the wrong question for recording. ChatGPT grows one caption block in place, reparents
   * it, shrinks it during a re-layout and grows it again; a caller comparing consecutive
   * blobs can only see "the text changed" and has to guess whether that is new commentary
   * or the same commentary redrawn. It guessed wrong, repeatedly, and every wrong guess
   * became another stored event and another row on screen.
   *
   * `key` is the caller's generation key — see stampIdentities for why it may not be
   * ChatGPT's turn id.
   */
  function progressItems(turn, key) {
    return safe(() => {
      const namespace = key || (turn && turn.id) || 'turn';
      const boxes = [];
      for (const section of turnNodes(turn)) boxes.push(...progressRoots(section));
      const ids = stampIdentities(boxes, 'data-clf-progress-id', namespace, 'p');

      const out = [];
      for (let at = 0; at < boxes.length; at++) {
        const value = commentaryText(boxes[at]);
        if (value) out.push({ id: adoptedProseId(boxes[at], namespace) || ids[at], text: value });
      }
      return out;
    }, []);
  }

  function interrupted(turn) {
    return safe(
      () =>
        turnNodes(turn).some((section) => {
          const memo = memoOf(section);
          if (memo && memo.interrupted !== null) return memo.interrupted;
          const value = section.querySelector('[data-interrupted="true"]') !== null;
          if (memo) memo.interrupted = value;
          return value;
        }),
      false
    );
  }

  /** Marks ChatGPT's own progress/reasoning containers so our CSS can make them legible. */
  function markProgress(turn) {
    return safe(() => {
      let marked = 0;
      for (const section of turnNodes(turn)) {
        for (const box of section.querySelectorAll('[data-interrupted]')) {
          if (!box.hasAttribute('data-clf-progress')) marked++;
          box.setAttribute('data-clf-progress', '1');
        }
      }
      return marked;
    }, 0);
  }

  /**
   * Is this candidate really one tool row?
   *
   * `div.pointer-events-none.contents` is a layout shape, not a semantic one: ChatGPT uses
   * display-contents wrappers in several places, and matching the class alone once counted
   * containers that hold a whole answer. A tool row is a short header line — no prose, no
   * nested tool row — so require that shape rather than trusting the class.
   *
   * A block we have already relabelled is always accepted. Expanding one puts its output
   * inside, which would otherwise make our own row stop looking like a tool row and let
   * its call be handed to a different block on the next repaint.
   */
  function isToolBlock(node) {
    if (node.hasAttribute && node.hasAttribute('data-clf-call')) return true;
    // A row that carries the tool-call control is a tool row whatever its size. Expanding
    // one puts its result — markdown and all — inside it, and the length/markdown test
    // below would then stop recognising it. Judging by the control instead of by the body
    // is what keeps an expanded connector result out of the chronology as prose.
    if (node.querySelector && node.querySelector(CONNECTOR)) return true;
    if (node.closest && node.closest(CONNECTOR)) return true;
    if (node.querySelector && node.querySelector('.markdown')) return false;
    const label = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return label.length > 0 && label.length <= 200;
  }

  /**
   * Collapse nested selector matches without comparing every node with every other node.
   * Long chats can contain hundreds of activity rows; the old `filter(...some(...))`
   * shape turned every transcript pass into quadratic containment work.
   */
  function collapseNested(found, keepInnermost) {
    if (found.length < 2) return found;
    const candidates = new Set(found);
    if (keepInnermost) {
      const containsCandidate = new Set();
      for (const node of found) {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (candidates.has(parent)) containsCandidate.add(parent);
        }
      }
      return found.filter((node) => !containsCandidate.has(node));
    }
    return found.filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (candidates.has(parent)) return false;
      }
      return true;
    });
  }

  /** The tool-call blocks of one logical turn, across every split section, in DOM order. */
  function toolBlocks(turn) {
    return safe(
      () =>
        turnNodes(turn).flatMap((section) => {
          const memo = memoOf(section);
          if (memo && memo.blocks) return memo.blocks;
          const current = [...section.querySelectorAll(TOOL)];
          const found = (current.length > 0 ? current : [...section.querySelectorAll(TOOL_LEGACY)]).filter(
            isToolBlock
          );
          // The two shapes nest — the display-contents wrapper can sit inside the legacy
          // span — and relabelling both would put our icon and title inside our own row.
          // Keep the innermost, which is the element that actually carries the label.
          const blocks = collapseNested(found, true);
          if (memo) memo.blocks = blocks;
          return blocks;
        }),
      []
    );
  }

  /**
   * Whether this block is a connector (API tool) row rather than a built-in one.
   *
   * Structural, not textual: the row carries the control named by CONNECTOR, and built-in
   * rows — "Searched the web", canvas, image generation — do not. That makes it stable
   * across locales and immune to the label games a name-frequency guess is open to.
   *
   * It says "a connector", not "this connector". The provider's identity — the account
   * name, the tool name, the request path — exists in ChatGPT's client state and appears
   * in the expanded card and the side panel, but nothing in the collapsed row carries it,
   * so a Gmail or Calendar row is indistinguishable from this app's from here. Callers
   * that use this as evidence must treat it as narrowing, not as proof of provider.
   */
  /**
   * Visible assistant activity in the exact DOM order ChatGPT drew it.
   *
   * Chat On Steroids remains authoritative for its own call labels/results. This only supplies
   * the missing chronology: a visible commentary paragraph can sit between two calls, and
   * the recorder clock cannot recover that after a fast turn. ChatGPT's completed DOM can.
   */
  function activityItems(turn) {
    return safe(() => {
      const out = [];
      let markerBase = 0;
      for (const section of turnNodes(turn)) {
        const roots = [...section.querySelectorAll('[data-interrupted]')].filter((node) => {
          const parent = node.parentElement && node.parentElement.closest
            ? node.parentElement.closest('[data-interrupted]')
            : null;
          return !parent;
        });

        for (const root of roots) {
          // ChatGPT's reasoning is one outer data-interrupted container. Its inner
          // display-contents activity rows are the *actual chronology slots*; plain text
          // between them is the visible commentary. Replacing those rows with sentinels in
          // a clone gives us the ordering without having to depend on hashed prose classes.
          // Strip our own stream before reading a single character of this subtree. Without
          // it, every repaint reads back what we rendered last time and republishes it.
          const clone = stripOwn(root.cloneNode(true));
          const found = [...clone.querySelectorAll(TOOL)].filter(isToolBlock);
          const slots = collapseNested(found, true);
          if (slots.length === 0) {
            const value = (clone.innerText || clone.textContent || '').trim();
            if (value) out.push({ kind: 'progress', text: value });
            continue;
          }

          const markers = [];
          slots.forEach((node, index) => {
            const token = `\n[[CLF_ACTIVITY_${markerBase + index}]]\n`;
            markers.push(token.trim());
            node.replaceWith(document.createTextNode(token));
          });
          markerBase += slots.length;

          const text = (clone.innerText || clone.textContent || '').replace(/\u00a0/g, ' ');
          const pattern = /\[\[CLF_ACTIVITY_(\d+)\]\]/g;
          let at = 0;
          let match;
          while ((match = pattern.exec(text)) !== null) {
            const prose = text.slice(at, match.index).trim();
            if (prose) out.push({ kind: 'progress', text: prose });
            out.push({ kind: 'tool' });
            at = match.index + match[0].length;
          }
          const tail = text.slice(at).trim();
          if (tail) out.push({ kind: 'progress', text: tail });
        }
      }
      return out;
    }, []);
  }

  /**
   * Whether this row is one of our own connector calls rather than something ChatGPT did.
   *
   * The answer is remembered on the row once it is known, and that is the point. The only
   * live marker is the control ChatGPT puts in a connector row, and it does not survive
   * everything the page does to that row: a collapse, a relabel, a React replacement of the
   * button can all take it away. A row that loses its marker then reads as ChatGPT-native,
   * and the call this app already recorded first-hand — with its arguments, outcome and
   * duration — gets written down a second time as an anonymous page caption.
   *
   * Being wrong in this direction is cheap and the other direction is not: a row wrongly
   * remembered as ours is one missing native caption, while a row wrongly read as native is
   * a duplicate of work already in the log.
   */
  function isConnectorBlock(node) {
    return safe(() => {
      if (!node) return false;
      if (node.getAttribute && node.getAttribute('data-clf-local') === '1') return true;
      const found = !!node.querySelector(CONNECTOR) || !!node.closest(CONNECTOR);
      if (found) markLocalBlock(node);
      return found;
    }, false);
  }

  /**
   * Records that a row belongs to this connector, for callers who know it from elsewhere.
   *
   * The Fiber pass can prove it — a request whose resource path is this app's — and that
   * proof outlives the DOM control, so it is worth keeping on the row.
   */
  function markLocalBlock(node) {
    return safe(() => {
      if (!node || !node.setAttribute) return false;
      node.setAttribute('data-clf-local', '1');
      return true;
    }, false);
  }

  /**
   * Whether this node is a connector row or contains one.
   *
   * Separate from isConnectorBlock because the questions are different: that one asks what
   * a known tool row is, and answers upwards as well, while this one asks whether an
   * arbitrary node that just appeared brought any evidence with it. React inserts whole
   * subtrees, so the row is as often a descendant of what was added as it is the node
   * itself, and only looking at the node would miss it.
   */
  function hasConnectorRow(node) {
    return safe(() => !!node && node.nodeType === 1 && (node.matches(CONNECTOR) || !!node.querySelector(CONNECTOR)), false);
  }

  /**
   * The connector rows inside a root, outermost first and counted once each.
   *
   * The evidence path asks this rather than filtering toolBlocks(), and that is deliberate.
   * toolBlocks() exists for *relabelling*, so it has to find the element that carries the
   * visible title, which means the display-contents/tool-message shapes and a heuristic
   * about what a row looks like. Attribution needs none of that: it only needs to know how
   * many connector calls this page has shown, and the one anchor that says so is CONNECTOR.
   * Depending on the relabelling shapes for it meant a renderer change that moved the title
   * silently turned every call in the browser into an unplaceable one.
   *
   * Nested matches are collapsed to the outermost, so a row whose control is labelled twice
   * — the wrapper and the button inside it — is still one call.
   */
  function connectorRows(root) {
    return safe(() => {
      const scope = root || document;
      const found = [...scope.querySelectorAll(CONNECTOR)];
      if (scope.nodeType === 1 && scope.matches(CONNECTOR)) found.unshift(scope);
      return collapseNested(found, false);
    }, []);
  }

  /**
   * The exact MAIN-world scan reference stamped on this block's connector row, or null.
   *
   * An index alone is not identity: React can leave a row stamped `0` from an earlier scan
   * while the next scan also has a completely different descriptor at index 0. The helper
   * therefore stamps `{scanToken,index}` and callers must match both. Numeric/legacy stamps
   * deliberately fail closed rather than being reinterpreted against a newer frame.
   */
  function fiberRef(block) {
    return safe(() => {
      if (!block) return null;
      const marked =
        (block.closest && block.closest('[data-clf-fiber]')) ||
        (block.querySelector && block.querySelector('[data-clf-fiber]'));
      if (!marked) return null;
      const value = marked.getAttribute('data-clf-fiber');
      if (!value) return null;
      const split = value.lastIndexOf(':');
      if (split <= 0 || split === value.length - 1) return null;
      const scanToken = value.slice(0, split);
      const rawIndex = value.slice(split + 1);
      if (scanToken.length > 64 || !/^\d+$/.test(rawIndex)) return null;
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) return null;
      return { scanToken, index };
    }, null);
  }

  /**
   * The single text node inside a tool block that reads "Called tool".
   *
   * Found structurally — the first text-bearing leaf of the block's header button —
   * rather than by matching the English string, so it also works in other languages.
   */
  function toolLabel(block) {
    return safe(() => {
      const marked = block.querySelector('[data-clf-label]');
      if (marked) return marked;
      const header = block.querySelector('button') || block;
      for (const node of header.querySelectorAll('*')) {
        if (node.children.length === 0 && (node.textContent || '').trim().length > 0) {
          node.setAttribute('data-clf-label', '1');
          return node;
        }
      }
      return null;
    }, null);
  }

  /**
   * Visible error banners plus narrowly recognised transport-failure markdown.
   *
   * Occurrences, not strings. The same wording failing twice is two failures, and the
   * caller has to be able to tell them apart: keyed on text alone, "Message delivery timed
   * out" on turn nine was indistinguishable from the same banner on turn three, so the
   * second one was never recorded and — because the outcome check consults the same
   * filter — the failed turn could be written down as completed instead.
   *
   * What gives an occurrence its identity is the node it is rendered in, plus the turn it
   * belongs to when it is inside one. A toast lives outside every turn, so it has no
   * turnId; its node is still its identity.
   *
   * "Visible" is load-bearing and used to be assumed rather than checked. ChatGPT announces
   * ordinary UI state through screen-reader-only `role="alert"` live regions, so a session
   * accumulated "Reasoning details opened", "Actions refreshed." and "Dictation is active
   * and in use" as recorded chat errors — 60 of them against 5 real transport failures in
   * one run — and every error count the app showed was inflated by them. An offscreen
   * announcement is not a banner. Neither is this extension's own surface, which was
   * recording "Chat On Steroids Desktop is now connected" as a ChatGPT failure.
   */
  const acknowledgedAccessNotices = new WeakSet();
  let lastAccessNotice = null;
  function accessNoticeSince(since) {
    return Number.isFinite(since) && since > 0 && lastAccessNotice?.path === location.pathname &&
      lastAccessNotice.at >= since ? lastAccessNotice.text : '';
  }
  function errors() {
    return safe(() => {
      const out = [];
      // De-duplicate representations of one rendered failure, never its wording. ChatGPT can
      // leave an older identical Retry card mounted while rendering the current one. A global
      // text set collapsed those two occurrences and, depending on DOM order, retained only the
      // historical control. Keep separate nodes separate; merge only the same node/control or a
      // containing native card, preferring the representation that carries exact Retry authority.
      const sameOccurrence = (left, right) => {
        const a = left?.node;
        const b = right?.node;
        if (!a || !b) return false;
        if (a === b || (left.retry && left.retry === right.retry)) return true;
        return Boolean(a.contains?.(b) || b.contains?.(a));
      };
      const addOccurrence = (candidate) => {
        // A conversation-load card describes the view, not the backend generation.
        // Live Core work can continue behind this exact native notice. Retain Retry
        // evidence, but never use this card alone to end or complete that generation.
        if (conversationLoadFailure(candidate.text)) candidate = { ...candidate, diagnosticOnly: true };
        const index = out.findIndex(existing => sameOccurrence(existing, candidate));
        if (index < 0) {
          out.push(candidate);
          return;
        }
        const existing = out[index];
        if (candidate.retry && !existing.retry) {
          out[index] = { ...existing, retry: candidate.retry,
            recoverable: existing.reason || existing.blocking
              ? existing.recoverable === true
              : candidate.recoverable === true || existing.recoverable === true };
        }
      };
      // Live provider access throttling is a dialog, not a broken transport. Match
      // its semantic heading and notice together; quoted assistant prose is not it.
      for (const node of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
        if (node.closest(OWN_SURFACES) || node.closest('.markdown, [data-message-author-role]') ||
            node.closest('[hidden],[inert],[aria-hidden="true"]') || !node.getClientRects().length) continue;
        const heading = node.querySelector('h1,h2,h3,[role="heading"]');
        const headingText = (heading?.textContent || '').trim();
        const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        const english = /^too many requests$/i.test(headingText) && /temporarily limited.*access/i.test(value) && /few minutes/i.test(value);
        const korean = headingText === '요청이 너무 많습니다' && value.includes('데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다.') && value.includes('몇 분 후 다시 시도해 주세요.');
        const conversationLimit = conversationLimitFailure(value);
        if (value.length >= 700 || (!english && !korean && !conversationLimit)) continue;
        const notice = value.startsWith(headingText) ? `${headingText} ${value.slice(headingText.length).trim()}` : value;
        if (conversationLimit) {
          addOccurrence({ text: notice, node, turnId: null, recoverable: false, blocking: true, reason: 'conversation_limit' });
          lastAccessNotice = { text: notice.slice(0, 200), at: Date.now(), path: location.pathname };
          continue;
        }
        addOccurrence({ text: notice, node, turnId: null, recoverable: false, blocking: true,
          reason: 'access_throttle_notice' });
        lastAccessNotice = { text: notice.slice(0, 200), at: Date.now(), path: location.pathname };
        // Acknowledge this identified informational notice once. The returned
        // blocking diagnostic survives the click; it grants no retry authority.
        const buttons = [...node.querySelectorAll('button')].filter(button =>
          displayed(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
          (korean ? button.textContent.trim() === '알겠습니다' : /^got it$/i.test(button.textContent.trim())));
        if (!acknowledgedAccessNotices.has(node) && buttons.length === 1) {
          acknowledgedAccessNotices.add(node); buttons[0].click();
        }
      }
      for (const node of document.querySelectorAll('[role="alert"], [role="status"]')) {
        const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        // Observed native account check: a visible status outside authored content,
        // with Send disabled. Its countdown is notice text, never resume authority.
        const reliabilityCheck = /^we['’]re doing a quick check to keep chatgpt reliable\. try again in \d{1,3} minutes?\.?(?:\s*retry)?$/i.test(value) &&
          !node.closest(`${OWN_SURFACES}, ${TURN}, [data-testid^="conversation-turn"], [data-turn-key], .markdown, [data-message-author-role], [data-markdown-text-style], [data-content-search-unit-key], [contenteditable]`);
        // Live alternate shell (2026-10-03) renders its interrupted-stream card as a
        // status, outside authored message bodies. Most statuses are ordinary progress,
        // not failures: admit only these exact native notices through the existing error owner.
        // In particular, a quote in a user/assistant body or our Loop overlay grants nothing.
        if (node.getAttribute('role') === 'status' &&
            (!node.closest('main, [data-app-shell-focus-area="main"]') ||
              node.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role], [data-markdown-text-style], [data-content-search-unit-key], [contenteditable], [hidden], [inert], [aria-hidden="true"]`) ||
              (!reliabilityCheck && !/^connection interrupted\.? (?:waiting|please wait) for the complete answer\.?$/i.test(
                (node.textContent || '').replace(/\s+/g, ' ').trim())))) continue;
        if (node.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
        if (out.some(error => error.blocking && error.node.contains(node))) continue;
        if (node.closest && node.closest(OWN_SURFACES)) continue;
        if (!displayed(node)) continue;
        if (value.length <= 2 || value.length >= 500) continue;
        // Observed native helper alert. This is an account
        // restriction, not transport failure; never grant its adjacent Retry authority.
        const hourlyLimit = /^you['’]ve reached our limit of messages per hour\. please try again later\.?(?:\s*retry)?$/i.test(value);
        // Current native 5.5 quota alert (October11) omits both the model and
        // reset time. It is still a provider hold, not a transport retry grant.
        const usageLimit = /^you['’]ve hit your limit\. please try again later\.?(?:\s*retry)?$/i.test(value);
        const unusualActivity = /^our systems have detected unusual activity coming from your system\. please try again later\.?(?:\s*retry)?$/i.test(value);
        if ((hourlyLimit || usageLimit || reliabilityCheck || unusualActivity) &&
            !node.closest('.markdown, [data-message-author-role], [contenteditable], [data-clf-user-text]')) {
          // The hourly-limit alert includes a Retry button, but quota is not transport failure.
          // Keep the provider notice, never its button label or Retry authority.
          addOccurrence({ text: value.replace(/\s*retry$/i, ''), node, turnId: null, recoverable: false,
            blocking: true, reason: 'account_restricted' });
          continue;
        }
        // Native model rejection observed October14, before any accepted user receipt.
        // Preserve the provider's notice through the existing error owner without classifying
        // transport, cooldown, account quota or terminal proof. Its Retry grants no action.
        const modelUnavailable = node.getAttribute('role') === 'alert' && /^model not found\.?(?:\s*retry)?$/i.test(value);
        if (modelUnavailable) {
          const authored = `${OWN_SURFACES},.markdown,blockquote,pre,code,[data-message-author-role],[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`;
          if (!node.closest(authored) && !node.querySelector(authored) &&
              node.getClientRects().length > 0 && composerCssVisible(node)) {
            addOccurrence({ text: value.replace(/\s*retry$/i, ''), node, turnId: null, recoverable: false, diagnosticOnly: true });
          }
          continue;
        }
        // Provider live regions also announce successful settings/actions changes. Only the
        // existing transport classifier makes an announcement a chat error. A failed send
        // can precede an assistant section, so recognized failures still need no turn id.
        const cooldown = modelCooldownFailure(value);
        const conversationLimit = conversationLimitFailure(value);
        if (conversationLimit && node.closest('.markdown, [data-message-author-role]')) continue;
        if (messageDisplayFailure(value) && node.closest('.markdown, [data-message-author-role="user"]')) continue;
        if (!transportFailure(value, node) && !cooldown && !conversationLimit) continue;
        const retry = [...(node.parentElement?.querySelectorAll('button') || [])].filter(button =>
          displayed(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
          /^(?:retry|try again)$/i.test((button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim()));
        addOccurrence({ text: value, node, turnId: null, recoverable: !cooldown && !conversationLimit,
          ...(conversationLimit ? { reason: 'conversation_limit', blocking: true } :
            cooldown ? { reason: 'model_cooldown' } : {}),
          ...(!conversationLimit && retry.length === 1 ? { retry: retry[0] } : {}) });
      }
      // The current full-width failure card has no alert role. Its exact Retry control is
      // the stable semantic anchor; retryFailure() accepts only the nearest complete notice
      // whose whole text is already in the narrow transport-failure vocabulary above.
      for (const button of document.querySelectorAll('button')) {
        const failure = retryFailure(button);
        if (failure) addOccurrence({ ...failure, turnId: null, recoverable: failure.recoverable !== false });
        const terminal = conversationLimitCard(button);
        if (!terminal) continue;
        addOccurrence({ ...terminal, turnId: null, recoverable: false, blocking: true, reason: 'conversation_limit' });
      }
      const observedTurns = turns();
      const latestTurn = observedTurns.at(-1);
      const latestSection = turnNodes(latestTurn).at(-1);
      for (const turn of observedTurns) {
        if (turn.role !== 'assistant') continue;
        for (const section of turnNodes(turn)) {
          // Current Dil renderer failure is presentation, not a model/tool terminal.
          // Its semantic marker and exact assistant section own the occurrence; the
          // words alone (including quotations or an older same-id section) grant nothing.
          if (turn === latestTurn && section === latestSection) {
            for (const node of section.querySelectorAll('[data-dil-render-failed][role="status"]')) {
              const root = node.closest('[data-dil-message-id]');
              const authored = `${OWN_SURFACES},.markdown,blockquote,pre,code,[data-markdown-text-style],[data-message-author-role="user"],[data-content-search-unit-key$=":user"],[data-clf-user-text],[contenteditable]`;
              if (!root || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(root.getAttribute('data-dil-message-id') || '') ||
                  root.closest(TURN) !== section || node.closest(TURN) !== section ||
                  node.closest(`${authored},[hidden],[inert],[aria-hidden="true"]`) || node.querySelector(authored) ||
                  !composerCssVisible(node) || !displayed(node)) continue;
              const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
              if (!/^this response couldn['’]t load\.?$/i.test(value)) continue;
              addOccurrence({ text: value, node, turnId: turn.id, turn,
                recoverable: false, diagnosticOnly: true, displayFailure: true });
            }
          }
          // ChatGPT may replace an answer body with a provider-owned display-error surface
          // that has no native Retry control. Promote only semantic error chrome outside
          // authored Markdown; the existing bounded recovery owner will use its single reload
          // fallback rather than reconstructing and potentially duplicating the user's prompt.
          if (!out.some(error => messageDisplayFailure(error.text) && section.contains(error.node))) {
            for (const node of section.querySelectorAll('[role="alert"], [data-testid*="error"]')) {
              if (node.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role="user"], [hidden], [inert], [aria-hidden="true"]`) ||
                  node.closest(TURN) !== section || !displayed(node)) continue;
              const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
              if (!messageDisplayFailure(value)) continue;
              addOccurrence({ text: value, node, turnId: turn.id, turn, recoverable: true });
            }
          }
          // Native Pro failure header observed in Chrome, 2026-09-12: an
          // expandable button outside authored markdown, not an alert/Retry card.
          // Keep every occurrence's node identity; old failed turns remain rendered.
          for (const button of section.querySelectorAll('button[aria-expanded]')) {
            if (button.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role="user"], [hidden], [inert], [aria-hidden="true"]`) ||
                button.closest(TURN) !== section || !displayed(button) ||
                (button.textContent || '').trim() !== 'Thinking failed') continue;
            let hidden = false;
            for (let parent = button; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { hidden = true; break; }
            }
            if (hidden) continue;
            addOccurrence({ text: 'Thinking failed', node: button, turnId: turn.id, turn,
              reason: 'thinking_failed', recoverable: false });
          }
          // Model cooldown is a failed answer, not the account-wide "Too many requests"
          // dialog above. It can appear as an expandable native header without an alert role.
          // Look only in provider chrome outside authored markdown and retain the exact latest
          // turn plus native Retry/Regenerate control for the bounded fallback ladder.
          if (!out.some(error => error.reason === 'model_cooldown' && section.contains(error.node))) {
            for (const node of section.querySelectorAll('[role="alert"], button[aria-expanded], [data-testid*="error"]')) {
              if (node.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role="user"], [hidden], [inert], [aria-hidden="true"]`) ||
                  node.closest(TURN) !== section || !displayed(node)) continue;
              const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
              if (!modelCooldownFailure(value)) continue;
              const controls = [...section.querySelectorAll('button')].filter(button =>
                displayed(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
                /^(?:retry|try again|regenerate(?: response)?)$/i.test(
                  (button.getAttribute('aria-label') || button.getAttribute('title') || button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim()
                ));
              addOccurrence({ text: value, node, turnId: turn.id, turn, reason: 'model_cooldown',
                recoverable: false, ...(controls.length === 1 ? { retry: controls[0] } : {}) });
            }
          }
          if (!out.some(error => error.reason === 'conversation_limit' && section.contains(error.node))) {
            for (const node of section.querySelectorAll('[role="alert"], button[aria-expanded], [data-testid*="error"]')) {
              if (node.closest(`${OWN_SURFACES}, .markdown, [data-message-author-role="user"], [hidden], [inert], [aria-hidden="true"]`) ||
                  node.closest(TURN) !== section || !displayed(node)) continue;
              const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
              if (!conversationLimitFailure(value)) continue;
              addOccurrence({ text: value, node, turnId: turn.id, turn, reason: 'conversation_limit',
                recoverable: false, blocking: true });
            }
          }
          for (const markdown of section.querySelectorAll('.markdown')) {
            const value = text(markdown, 500).replace(/\s+/g, ' ').trim();
            // The short support wording is provider chrome only. In authored Markdown it is
            // indistinguishable from a quotation, so only an alert or exact native Retry card
            // may promote it to a failure with browser-action authority.
            if (!value || openAiSupportFailure(value) || messageDisplayFailure(value) || !transportFailure(value)) continue;
            addOccurrence({ text: value, node: markdown, turnId: turn.id, turn, recoverable: true });
          }
        }
      }
      return out;
    }, []);
  }

  /** Reject stale model-transition editors hidden only by their computed CSS. */
  function composerCssVisible(node) {
    return safe(() => {
      if (!node || onKeptPage(node)) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
    }, false);
  }

  function composer() {
    return safe(() => {
      const classic = [...document.querySelectorAll('#prompt-textarea')].filter(composerCssVisible);
      if (classic.length) return classic.length === 1 ? classic[0] : null;
      // The rich editor can remount before its form regains data-chatgpt-composer. Accept its
      // stable editor marker only while the non-hidden candidate remains unique.
      const candidates = [...document.querySelectorAll(
        'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
        'form [data-composer-markdown][contenteditable="true"][role="textbox"]'
      )]
        .filter(node => !node.closest(`${OWN_SURFACES},[data-turn-key],.markdown,[hidden],[aria-hidden="true"],[inert]`) &&
          composerCssVisible(node));
      return candidates.length === 1 ? candidates[0] : null;
    }, null);
  }

  /**
   * Whether ChatGPT's editing host is presently safe to receive a new user message.
   *
   * This deliberately says nothing about whether *our* recorder still considers the previous
   * turn open; content.js owns that stronger lifecycle state. It is the page-native half of the
   * same proof: a connected/editable composer, no Stop/generation control, and no user draft.
   * Keeping the emptiness check here also makes it impossible for a revival waiter to "reserve"
   * the composer by inserting its text before the page is actually ready.
   */
  function composerSubmitReady() {
    return safe(() => {
      const box = composer();
      if (!composerWritable()) return false;
      if (generating() || stopButton()) return false;
      if ((editorText(box) || '').trim() !== '') return false;
      return true;
    }, false);
  }

  /** A visible editor can still be read-only while ChatGPT mounts or changes models. */
  function composerWritable() {
    const box = composer();
    return !!box?.isConnected && box.getAttribute('aria-disabled') !== 'true' &&
      box.getAttribute('contenteditable') !== 'false';
  }

  function pendingHomeComposers() {
    return [...document.querySelectorAll('textarea#pending-home-input')].filter(node =>
      !node.closest(`${OWN_SURFACES},[data-turn-key],.markdown,[hidden],[aria-hidden="true"],[inert]`) && composerCssVisible(node));
  }

  function composerHasDraft(node) {
    return Boolean((node.value || node.textContent || '').trim()) || node.getAttribute('data-has-text') === 'true';
  }

  /** Page half of idle-tab retirement, never a Send/reuse readiness signal. Background still
   * owns command retirement, document identity, selection, pins and the app-created tab proof.
   * An abandoned home may never hydrate its real editor; its exact empty pending textarea can
   * prove emptiness without pretending it can accept a message.
   */
  function emptyComposerForClose(deletedConversationId = null) {
    return safe(() => {
      const box = composer();
      const pendingCount = document.querySelectorAll('textarea#pending-home-input').length;
      // During hydration both hosts can coexist; the new rich editor being empty does not
      // prove the pending textarea's user draft was transferred. Wait for one stable host.
      if (box) return pendingCount === 0 && !composerHasDraft(box);
      // Only Main's exact deletion intent may retire a composer-less named error page.
      // Reuse the provider-owned hard-load-error proof, never generic red/error state.
      if (deletedConversationId !== null) {
        const route = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})\/?$/i.exec(location.pathname);
        if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(location.origin) || location.hash ||
            typeof deletedConversationId !== 'string' || route?.[1] !== deletedConversationId ||
            conversationId() !== deletedConversationId || authenticationState() === 'signed-out' || generating() ||
            document.querySelector(`${TURN},[data-turn-key],[data-message-author-role],[data-message-id],.markdown`) ||
            !conversationLoadRetryControl()) return false;
        // Missing/hidden editors are not empty drafts. The one observed visible pending
        // conversation textarea is allowed only when empty; every other editor vetoes.
        const editors = [...document.querySelectorAll('textarea,[contenteditable],[role="textbox"],input:not([type]),input[type="text"],input[type="search"]')]
          .filter(node => !node.closest(OWN_SURFACES));
        if (editors.length > 1 || editors.some(node => !node.matches('textarea#pending-conversation-input') ||
            node.closest('[hidden],[aria-hidden="true"],[inert]') || !composerCssVisible(node) ||
            !node.getClientRects().length || composerHasDraft(node))) return false;
        return !hasAttachmentsIn(document) && ![...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length);
      }
      if (location.pathname !== '/' || conversationId() || turns().length) return false;
      if (pendingCount !== 1) return false;
      const pending = pendingHomeComposers()[0];
      const main = pending?.closest('main');
      if (!main || pending.getAttribute('data-pending-input-initialized') !== 'true' ||
          pending.getAttribute('data-has-text') !== 'false' || composerHasDraft(pending)) return false;
      if (main.querySelector('form,[contenteditable="true"],#prompt-textarea') || hasAttachmentsIn(main)) return false;
      return ![...main.querySelectorAll('input[type="file"]')].some(input => input.files?.length);
    }, false);
  }

  /** Diagnostic facts only: never treat the provider's pre-hydration textarea as Send authority.
   * No authored text, DOM, file names, URLs or arbitrary provider labels leave this adapter.
   * Read on failure/status requests, not on a new polling loop.
   */
  function composerDiagnostics() {
    return safe(() => {
      const box = composer();
      const pending = pendingHomeComposers();
      const button = sendButton();
      return {
        host: box ? 'native' : pending.length === 1 ? 'pending-home' : pending.length ? 'ambiguous' : 'missing',
        writable: composerWritable(),
        draft: Boolean(box && composerHasDraft(box)) || pending.some(composerHasDraft),
        attachments: hasComposerAttachments(),
        send: !button ? 'missing' : sendButtonEnabled(button) ? 'enabled' : 'disabled'
      };
    }, { host: 'unreadable', writable: false, draft: false, attachments: false, send: 'unknown' });
  }

  /**
   * Native model changes can close their picker before React replaces/re-enables the editor.
   * Selection is not ready for Send until the current document exposes a writable composer.
   */
  function waitComposerWritable(stillCurrent = () => true, timeout = 15000) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = () => {
        if (!stillCurrent()) return finish(false);
        if (composerWritable()) finish(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      const timer = setTimeout(() => finish(false), timeout);
      check();
    });
  }

  /** The composer as a whole, used as the root to watch for React replacing it. */
  function composerBox() {
    return safe(() => {
      const box = composer();
      if (!box) return null;
      return box.closest('form') || box.parentElement || null;
    }, null);
  }

  /** A mounted editor behind Settings is not an available model-discovery surface. */
  function composerVisible() {
    const box = composer();
    return !!box && !box.closest('[hidden],[aria-hidden="true"],[inert]') && box.getClientRects().length > 0;
  }

  /**
   * Whether the page is currently drawn light or dark: `'light'` or `'dark'`.
   *
   * Not `prefers-color-scheme`. ChatGPT's appearance setting is its own — it can be pinned
   * to Light on a dark Windows and the other way round — so asking the operating system
   * gives our injected menu the opposite surface from the page it is sitting on. Not the
   * `html` class either: the theme classes are ChatGPT's and would be one more name to
   * break. What is asked instead is the paint: the composer's own background, which is the
   * surface our control physically sits on, climbing until an ancestor is actually opaque
   * (the composer's inner layers are transparent over the one that carries the colour).
   */
  function pageTheme() {
    return safe(() => {
      for (let node = composerBox() || document.body; node; node = node.parentElement) {
        const found = luminance(getComputedStyle(node).backgroundColor);
        if (found !== null) return found < 0.5 ? 'dark' : 'light';
      }
      const declared = getComputedStyle(document.documentElement).colorScheme || '';
      return declared.indexOf('dark') >= 0 ? 'dark' : 'light';
    }, 'dark');
  }

  /** Perceived brightness of a painted colour, or null if it paints nothing at all. */
  function luminance(color) {
    const parts = String(color).match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    // A transparent layer shows what is behind it, so it is not this node's answer.
    if (parts.length > 3 && Number(parts[3]) === 0) return null;
    const [red, green, blue] = parts.slice(0, 3).map(Number);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  }

  /**
   * Where a control of ours belongs in the composer: `{ host, before }`.
   *
   * ChatGPT gives its trailing button row no stable id, so the anchor is the send button
   * (or the stop button that replaces it while generating, or the dictation button when
   * the composer is empty and there is no send button at all). Our control goes *before*
   * that anchor, so send stays the rightmost thing in the composer — moving the primary
   * action of the page is not ours to do.
   */
  function composerActions() {
    return safe(() => {
      // Upstream cc470407: ChatGPT may omit the trailing-row marker and change
      // the microphone sprite's weight. Scope the anchor to the native composer
      // form, not translated labels or microphone icons in conversation prose.
      const anchor = sendButton() || stopButton() || nativeComposerControls(SPEECH)[0] ||
        nativeComposerControls('button')
        .find(button => !button.closest(OWN_SURFACES) && [...button.querySelectorAll('svg use')].some(use => {
          const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
          return href.slice(href.lastIndexOf('#')).startsWith('#microphone-');
        }));
      const explicit = anchor ? anchor.closest(TRAILING) : [...(composerBox() || document).querySelectorAll(TRAILING)].find(renderedComposerNode);
      if (!anchor) return explicit ? { host: explicit, before: null } : null;

      // The row that holds several controls, not the wrapper around this one button.
      // Capped: climbing all the way to <body> because every ancestor happens to have one
      // child would put our control somewhere it has no business being.
      // The native trailing area owns both the model picker and submit controls.
      // Voice now has a nested wrapper with two children (button + description),
      // so child count alone would stop below the model picker and never find it.
      let host = explicit || anchor.parentElement;
      for (let up = 0; up < 3 && host && host !== explicit && host.children.length < 2 && host.parentElement; up++) {
        host = host.parentElement;
      }
      if (!host) return null;
      let before = anchor;
      while (before && before.parentElement !== host) before = before.parentElement;
      return { host, before: before || null };
    }, null);
  }

  /**
   * The node holding the text of the chat's first user message, if there is one.
   *
   * Only ever asked for on a chat this app opened, where the first user message is the
   * instruction the app typed. Returns the message element itself, so the caller folds
   * away the text and nothing structural around it.
   */
  function firstUserMessage() {
    return safe(() => {
      for (const turn of turns()) {
        for (const section of turnNodes(turn)) {
          for (const row of sectionRows(section)) {
            const role = row.roleAttr || turn.role;
            if (role === 'assistant') return null;
            if (role === 'user') return row.node;
          }
        }
      }
      return null;
    }, null);
  }

  /**
   * Where a panel of ours belongs *above* the composer: `{ host, before }`.
   *
   * Outside the composer's own container rather than inside it. A block element inside
   * ChatGPT's input row fights the row's layout, and a click that lands anywhere in there
   * is turned into "focus the textarea" — so a panel with text to read and scroll cannot
   * live there.
   */
  function composerStack() {
    return safe(() => {
      const box = composerBox();
      if (!box || !box.parentElement) return null;
      return { host: box.parentElement, before: box };
    }, null);
  }

  /**
   * Stable mount point for the extension-owned activity stream of one assistant turn.
   * The stream is a sibling of ChatGPT's own activity, so replacing a tool/reasoning
   * subtree cannot take the local transcript with it.
   */
  function turnMount(turn) {
    return safe(() => {
      const sections = turnNodes(turn);
      const host = sections[0] || null;
      if (!host) return null;

      // Where ChatGPT itself put this turn's activity. Anchoring there is the whole point:
      // the stream stands in for that block, so it has to occupy the same place in the
      // turn. Mounting at the top of the section instead — which is what this did — lifted
      // every reconstructed call and caption above the commentary and prose they belong
      // between, and made a long turn read as if all the work happened first.
      for (const section of sections) {
        for (const box of progressRoots(section)) {
          if (box.closest && box.closest(OWN_SURFACES)) continue;
          if (box.parentElement) return { host: box.parentElement, before: box };
        }
      }

      // No activity block yet. The answer is the only other fixed landmark, and the stream
      // belongs above it: everything in the stream happened before the turn could answer.
      for (const section of sections) {
        for (const prose of section.querySelectorAll('.markdown')) {
          if (prose.closest && (prose.closest(TOOL) || prose.closest(OWN_SURFACES))) continue;
          if (prose.parentElement) return { host: prose.parentElement, before: prose };
        }
      }

      // Neither: append, rather than prepend. An assistant section with tool rows and no
      // reasoning box renders those rows first, and the stream stands after them.
      return { host, before: null };
    }, null);
  }

  /**
   * Does this progress box also contain the turn's answer?
   *
   * ChatGPT's reasoning container can expand and reparent around content that started
   * outside it, so a `[data-interrupted]` subtree is not reliably progress-only. Hiding
   * one that has grown to hold the final prose is what leaves a turn showing "Worked for
   * 45s" above an empty gap with no answer under it.
   */
  function holdsAnswer(box) {
    return safe(() => {
      const prose = [...box.querySelectorAll('.markdown')].filter(
        (node) => !(node.closest && node.closest(TOOL)) && !(node.closest && node.closest(OWN_SURFACES))
      );
      return prose.some((node) => text(node).length > 0);
    }, true);
  }

  /** Hides/restores only ChatGPT's own visible progress boxes for this logical turn. */
  function hideProgress(turn, hidden) {
    return safe(() => {
      for (const section of turnNodes(turn)) {
        const memo = memoOf(section);
        if (memo && !memo.answers) memo.answers = new Map();
        const boxes = memo && memo.boxes ? memo.boxes : [...section.querySelectorAll('[data-interrupted]')];
        if (memo) memo.boxes = boxes;
        for (const box of boxes) {
          // Restoring is always safe; hiding is not. A box carrying the answer stays.
          let holds = memo ? memo.answers.get(box) : undefined;
          if (holds === undefined) {
            holds = holdsAnswer(box);
            if (memo) memo.answers.set(box, holds);
          }
          if (hidden && !holds) box.setAttribute('data-clf-native-hidden', '1');
          else box.removeAttribute('data-clf-native-hidden');
        }
      }
    }, undefined);
  }

  /** Whether one CSS size is an actual bound rather than content-driven layout. */
  function boundedCssSize(value, allowZero = false) {
    const size = String(value || '').trim().toLowerCase();
    if (!size || ['auto', 'none', 'normal', 'initial', 'inherit', 'unset', 'revert', 'revert-layer'].includes(size)) return false;
    const numeric = /^(-?(?:\d+\.?\d*|\.\d+))(?:px|rem|em|vh|dvh|svh|lvh|%)$/i.exec(size);
    if (numeric) return allowZero ? Number(numeric[1]) >= 0 : Number(numeric[1]) > 0;
    // calc()/clamp()/min()/max() and provider variables are still authored bounds. Intrinsic
    // content keywords are not: those grow with the native row and are safe for a sibling.
    return /^(?:calc|min|max|clamp|var)\(/.test(size) &&
      !/^(?:min-content|max-content|fit-content|stretch)$/.test(size);
  }

  /**
   * The nearest per-turn host whose geometry can be retained by ChatGPT's virtualizer.
   *
   * Current ChatGPT builds do not use one stable wrapper shape. A row may have its numeric
   * height on a grandparent through a class rule, or be translated/absolutely positioned with
   * its size held by the virtualizer. In all of those layouts adding a synthetic sibling can
   * paint below the row without extending the transcript scroll range. Walk only ancestors that
   * contain this logical turn and stop before the shared transcript owner; a fixed viewport that
   * contains another turn is not mistaken for a virtual row.
   */
  function boundedVirtualizedTurnHost(turn) {
    return safe(() => {
      const sections = turnNodes(turn).filter(node => node?.isConnected);
      if (sections.length === 0) return null;
      const owned = new Set(sections);
      for (const section of sections) {
        let candidate = section;
        for (let depth = 0; candidate && depth < 8; depth++, candidate = candidate.parentElement) {
          if (candidate === document.body || candidate === document.documentElement) break;
          const nativeTurns = [...candidate.querySelectorAll(TURN)];
          if (nativeTurns.some(node => !owned.has(node))) break;

          const inline = candidate.style || {};
          let computed = null;
          try { computed = getComputedStyle(candidate); } catch { /* An unreadable row is not a safe mount. */ }
          if (!computed) return candidate;
          const position = String(computed.position || inline.position || '').toLowerCase();
          const transform = String(computed.transform || inline.transform || '').toLowerCase();
          const translate = String(computed.translate || inline.translate || '').toLowerCase();
          const contain = String(computed.contain || inline.contain || '').toLowerCase();
          const positioned = position === 'absolute' || position === 'fixed';
          const translated = Boolean((transform && transform !== 'none') || (translate && translate !== 'none'));
          // `content` containment excludes size containment; only `size` and `strict` reserve
          // a bounded block that cannot safely grow with our sibling activity projection.
          const contained = /(?:^|\s)(?:size|strict)(?:\s|$)/.test(contain);
          const inlineBound = boundedCssSize(inline.height, true) || boundedCssSize(inline.maxHeight, true);
          // Chrome's legacy getComputedStyle() can resolve an authored `height:auto` to its used
          // pixel height. Typed OM retains the computed keyword and avoids classifying every
          // ordinary content-sized row as fixed; keep the legacy value as the fail-safe fallback.
          let typed = null;
          try { typed = candidate.computedStyleMap?.(); } catch { /* Fall back below. */ }
          const typedHeight = typed ? String(typed.get('height') || '') : '';
          const typedMaxHeight = typed ? String(typed.get('max-height') || '') : '';
          const computedBound = typed
            ? boundedCssSize(typedHeight) || boundedCssSize(typedMaxHeight)
            : boundedCssSize(computed.height) || boundedCssSize(computed.maxHeight);
          const measuredBound = Number(candidate.clientHeight) > 0 &&
            Number(candidate.scrollHeight) > Number(candidate.clientHeight) + 1;
          // A normal assistant section has a finite used height by definition. Its own authored
          // size/position can still make it a virtual row, but only ancestors use computed or
          // measured bounds as row-container evidence.
          const ancestorBound = candidate !== section && (computedBound || measuredBound);
          if (inlineBound || ancestorBound || positioned || translated || contained) return candidate;
        }
      }
      return null;
    }, null);
  }

  /**
   * Mounts app-owned activity without replacing ChatGPT's answer.
   *
   * The classic transcript keeps the root beside the native assistant node. That stable sibling
   * is deliberate: React can transiently move/reuse the assistant node across a later user row,
   * and the already-recorded stream must not travel with it. The current virtualizer is different:
   * each turn lives in an inline fixed-height item whose ResizeObserver measures the turn node.
   * A sibling stream then overflows the fixed item, overlaps later messages and leaves the scroll
   * range too short. Such a row is therefore an unsafe mount: the caller must preserve ChatGPT's
   * native activity instead. React still solely owns prose/code/actions.
   */
  function replaceActivity(turn, root, replaced) {
    return safe(() => {
      const sections = turnNodes(turn);
      if (sections.length === 0) return false;
      // Defense in depth for callers racing a provider layout change. Never insert a stream in
      // a bounded/positioned row; importantly, do this before stamping native content as hidden.
      if (replaced && root && boundedVirtualizedTurnHost(turn)) return false;
      for (const section of sections) {
        if (replaced) section.setAttribute('data-clf-turn-replaced', '1');
        else section.removeAttribute('data-clf-turn-replaced');
      }
      const first = sections[0];
      const item = first && first.parentElement;
      const embedded = Boolean(root && sections.some((section) => root.parentElement === section));
      if (replaced && root && (!root.isConnected || embedded) && item) item.insertBefore(root, first);
      return true;
    }, false);
  }

  // User-authorized residue policy for delivery only, never tab retirement. Preserve structured
  // content, handoffs, attachments and explicit control words even when their text is short.
  function composerHasProtectedDraft() {
    const box = composer();
    const text = (editorText(box) || '').trim();
    if (hasComposerAttachments()) return true;
    if (!text) return false;
    // The user also authorizes replacing up to three accidental plain words.
    // Keep the original 24-character cap and reject line breaks/punctuation.
    return text.length > 24 || !/^[\p{L}\p{N}]+(?:[ \t]+[\p{L}\p{N}]+){0,2}$/u.test(text) ||
      /(?:^|\s)(?:stop|pause|cancel|wait|no|handoff|resume|continue)(?:$|\s)/i.test(text) ||
      Boolean(nativeConnectorMentionIdentity());
  }

  /** Types into the composer; dedicated fresh-chat automation may replace an autosaved draft. */
  /**
   * Puts `value` in the composer.
   *
   * `mode` says what to do with text already there: `false` preserves protected drafts but
   * replaces authorized short residue; `true` explicitly replaces, and `'append'` appends.
   */
  function insertPrompt(value, mode = false, failure = () => undefined) {
    const box = composer();
    const reject = reason => {
      // A bounded predicate survives tab retirement without exposing authored data.
      safe(() => failure(reason), undefined);
      return false;
    };
    try {
      if (!box) return reject('composer_missing');
      const existing = (editorText(box) || '').trim();
      if (value === '' && mode !== true) return false;
      // A failed Send may leave this exact delivery in the composer. That residue is not a
      // user draft: retrying it produces the same bytes. Keep protecting every different draft.
      const sameAsValue = String(existing).replace(/\s+/g, '') === String(value || '').replace(/\s+/g, '');
      if (existing !== '' && mode === false && !sameAsValue && composerHasProtectedDraft()) return reject('existing_draft');
      box.focus();
      const selection = document.getSelection();
      if (!selection) return reject('selection_missing');
      if (existing !== '') {
        selection.selectAllChildren(box);
        if (mode === 'append') {
          selection.collapseToEnd();
          value = `\n${value}`;
        }
      } else selection.selectAllChildren(box);
      if (!box.isConnected || composer() !== box) return reject('editor_replaced');
      if (document.activeElement !== box) return reject('composer_not_focused');
      if (!selection.rangeCount || !box.contains(selection.anchorNode) || !box.contains(selection.focusNode)) return reject('selection_changed');
      if ((editorText(box) || '').trim() !== existing) return reject('existing_draft');
      // One native HTML edit uses the actual browser selection, including on a
      // freshly mounted editor whose custom paste handler can consume and drop
      // synthetic clipboard events. Insert inline content into the editor's own
      // paragraph: an extra block wrapper is not part of the authored prompt.
      // Text nodes keep markup literal; there is no paste fallback.
      const paragraph = document.createElement('p');
      // The alternate shell's Markdown serializer otherwise escapes text and hard breaks.
      // Its native literal-paste mark preserves the submitted bytes without reconstructing
      // Markdown or changing the classic editor path.
      const host = box.matches('[data-composer-markdown]') && box.closest('form[data-chatgpt-composer]')
        ? document.createElement('span') : paragraph;
      if (host !== paragraph) {
        host.setAttribute('data-prompt-literal-paste', '');
        paragraph.append(host);
      }
      value.split('\n').forEach((line, index) => {
        if (index) host.append(document.createElement('br'));
        host.append(document.createTextNode(line));
      });
      if (value === '') host.append(document.createElement('br'));
      if (!document.execCommand('insertHTML', false, paragraph.innerHTML)) return reject('native_edit_rejected');
      const compact = text => String(text || '').replace(/\s+/g, '');
      const expected = mode === 'append' ? existing + value : value;
      if (!box.isConnected || composer() !== box) return reject('editor_replaced');
      if (compact(editorText(box)) !== compact(expected)) return reject('text_mismatch');
      return true;
    } catch {
      return reject('insertion_exception');
    }
  }

  /** Clears only app-owned text that still exactly matches the value it inserted. */
  function clearPromptExact(value, stillCurrent = null) {
    return safe(() => {
      const box = composer();
      const compact = (text) => String(text || '').replace(/\s+/g, '');
      if (!box || (stillCurrent && !stillCurrent()) || compact(editorText(box)) !== compact(value)) return false;
      box.focus();
      if (stillCurrent && (!stillCurrent() || composer() !== box || compact(editorText(box)) !== compact(value))) return false;
      document.execCommand('selectAll', false);
      if (stillCurrent) {
        const selection = document.getSelection();
        if (!stillCurrent() || composer() !== box || compact(editorText(box)) !== compact(value) ||
            document.activeElement !== box || !selection?.rangeCount ||
            !box.contains(selection.anchorNode) || !box.contains(selection.focusNode)) return false;
        for (let index = 0; index < selection.rangeCount; index++) {
          const range = selection.getRangeAt(index);
          if (!box.contains(range.startContainer) || !box.contains(range.endContainer)) return false;
        }
      }
      document.execCommand('delete', false);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return (editorText(box) || '').trim() === '';
    }, false);
  }

  async function send({ acceptanceTimeoutMs = 30000, stillCurrent = () => true, matchesUser = null, observeEvidence = null, clearAcceptedDraft = true, beforeSend = null, onNativeClickAttempt = null, acceptUserReceipt = null, observeUserReceipt = null, submittedText = null, readDraftText = null, matchesDraft = null, explain = null, sentRequest = null, whileGenerating = false } = {}) {
    // Diagnostic only: name the first reason this exact native Send was refused without changing
    // its ownership, deadlines, or single-click behavior.
    let refusalExplained = false;
    const refused = (why) => {
      if (!refusalExplained) {
        refusalExplained = true;
        try { explain?.(why); } catch { /* Diagnostics never change Send. */ }
      }
      return false;
    };
    try {
      const box = composer();
      if (!box || !box.isConnected) return refused('editor-missing');
      if (!stillCurrent()) return refused('chat-changed');
      if (errors().some(error => error.reason === 'account_restricted')) return refused('account-restricted');
      // Only receipt-owned native steering may use ChatGPT's running-turn Send.
      // Ordinary automatic pickup still requires an idle page. A cleared composer
      // or a changed Stop control is never acceptance for a running-turn message.
      const busy = () => !whileGenerating && generating();
      if (whileGenerating ? !acceptUserReceipt : generating() || stopButton()) return refused('page-busy');
      if (box.getAttribute('aria-disabled') === 'true' || box.getAttribute('contenteditable') === 'false') return refused('editor-disabled');
      // Rich editors use adjacent paragraphs for newlines; textContent concatenates
      // their words. Preserve those boundaries when matching the rendered user message.
      const draftText = () => (typeof readDraftText === 'function' ? String(readDraftText() ?? '') :
        (typeof box.innerText === 'string' ? box.innerText : [...box.childNodes]
          .map((node) => editorText(node) + (/^(P|DIV|BR)$/.test(node.nodeName) ? '\n' : '')).join('')).trim());
      const submitted = typeof submittedText === 'string' ? submittedText : draftText();
      if (!submitted) return refused('draft-empty');
      // Mandatory for every caller, including older callers that supplied an opt-out.
      if (!promptEnvelopeValid(submitted)) return refused('prompt-envelope-missing');
      // Most sends keep byte-for-byte draft ownership. A caller that has already
      // authenticated a richer structured composer may supply the same narrow
      // comparator it used to prove that draft. Recheck it before authorization
      // and again immediately before the one native click.
      const unchangedDraft = () => safe(() => {
        const actual = draftText();
        // A compatibility comparator cannot waive the actual editor's envelope.
        return promptEnvelopeValid(actual) && (typeof matchesDraft === 'function'
          ? matchesDraft(actual, submitted) === true : actual === submitted);
      }, false);
      const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const expected = compact(submitted);
      const beforeConversation = conversationId();
      const beforeGenerating = generating();
      const beforeStop = stopButton();
      const priorUsers = messages().filter((message) => message.role === 'user');
      const priorUserNodes = new Set(priorUsers.map((message) => message.node));
      const priorUserIds = new Set(priorUsers.map((message) => message.id).filter(Boolean));
      let submittedMessageObserved = false;
      let clickedAt = null;

      // click()/dispatchEvent() only prove that JavaScript ran, not that ChatGPT accepted a
      // prompt. Observe for a page-owned consequence instead of sleeping and re-sampling on a
      // clock. Composer clear and a freshly rendered matching user message are direct submit
      // evidence. Navigation alone is not acceptance: the user can open an unrelated chat
      // while an already-clicked submit is still pending. A fresh chat's assigned id is
      // accepted only with the exact new user message, not a Stop button in another chat.
      const accepted = () => {
        const currentConversation = conversationId();
        if (beforeConversation && currentConversation !== beforeConversation) return false;
        const visible = messages();
        for (let at = visible.length - 1; at >= 0; at--) {
          const message = visible[at];
          if (message.role !== 'user') continue;
          if (!priorUserNodes.has(message.node) && !priorUserIds.has(message.id) && (matchesUser ? matchesUser(message, submitted) : compact(message.text) === expected)) {
            if (acceptUserReceipt && !acceptUserReceipt(message, currentConversation)) continue;
            // Some callers need to retain the exact provider row/conversation that proved a
            // fresh Send without making that row the *only* form of native acceptance. This is
            // deliberately observation-only: composer-clear/Stop semantics below stay unchanged,
            // while the caller can later refuse to bind a conversation unless this exact receipt
            // was witnessed. Receipt-owned desktop delivery still uses acceptUserReceipt above.
            if (observeUserReceipt) {
              try { observeUserReceipt(message, currentConversation); } catch {}
            }
            submittedMessageObserved = true;
            return true;
          }
        }
        // A fresh chat can redraw its first exchange without ever exposing the question row.
        // ChatGPT's own provider request still names that exact user message. The caller keeps
        // route/epoch ownership and may accept only the first such request after this click.
        if (acceptUserReceipt && sentRequest && clickedAt !== null) {
          const sent = safe(() => sentRequest(clickedAt), null);
          if (sent && !priorUserIds.has(sent.id) &&
              acceptUserReceipt({ id: sent.id, role: 'user', sentRequest: true }, currentConversation)) return true;
        }
        // Receipt-owned delivery must settle on this exact native row. Composer clear
        // or Stop alone cannot hand off a receipt, and a later DOM read can lose it.
        if (acceptUserReceipt || currentConversation !== beforeConversation) return false;
        const current = composer();
        if (current === box && box.isConnected && (editorText(current) || '').trim() === '') return true;
        if (!beforeGenerating && generating()) return true;
        if (!beforeStop && stopButton()) return true;
        return false;
      };

      return await new Promise((resolve) => {
        let done = false;
        let attempted = false;
        let authorizing = false;
        let observer = null;
        let timer = null;
        let unsubscribeEvidence = null;
        const finish = (value, why = attempted ? 'not-accepted' : 'send-not-ready') => {
          if (done) return;
          if (!value) refused(why);
          done = true;
          if (observer) observer.disconnect();
          if (unsubscribeEvidence) unsubscribeEvidence();
          if (timer !== null) clearTimeout(timer);
          // A fresh matching user row proves this text was accepted. Some provider
          // transitions retain that same draft; leaving it lets the next Loop append
          // to and resend the entire bootstrap. Preserve replaced editors/new drafts.
          if (clearAcceptedDraft && value && submittedMessageObserved && stillCurrent() && composer() === box)
            clearPromptExact(submitted);
          resolve(value);
        };
        const check = () => {
          if (done) return;
          if (!stillCurrent() || (beforeConversation && conversationId() !== beforeConversation)) return finish(false, 'chat-changed');
          if (attempted) {
            if (accepted()) finish(true);
            return;
          }
          // React can enable/mount Send after accepting our editor input. Observe that
          // readiness through this same bounded operation; neither a guessed Enter nor
          // an unrelated Stop/composer-clear is evidence that this draft was submitted.
          if (conversationId() !== beforeConversation || composer() !== box || !box.isConnected ||
              !unchangedDraft() || busy()) return finish(false, busy() ? 'page-busy' : 'draft-changed');
          if (box.getAttribute('aria-disabled') === 'true' || box.getAttribute('contenteditable') === 'false') return;
          // ChatGPT can mount the exact account-throttle dialog after an app-owned worker
          // bootstrap has already reached the composer. That dialog sits above the page and
          // keeps native Send disabled, so merely observing the button strands the complete
          // worker prompt in the editor until this operation times out. `errors()` recognizes
          // and acknowledges only the exact visible provider notice (never assistant prose or
          // an arbitrary OK button). Keep this one-shot Send pre-click while the notice closes;
          // the dialog/button mutation wakes this same observer and re-proves the unchanged
          // route, editor and draft before it is allowed to click Send once.
          const notices = errors();
          if (notices.some(error => error.reason === 'account_restricted')) return finish(false, 'account-restricted');
          if (notices.some(error => error.reason === 'access_throttle_notice')) return;
          const button = sendButton();
          if (!sendButtonEnabled(button)) return;
          if (authorizing) return;
          const click = () => {
            if (done) return;
            if (errors().some(error => error.reason === 'account_restricted')) return finish(false, 'account-restricted');
            // Authorization can await the app. The exact editor, text and native control
            // must still be the ones it authorized; a late answer cannot revive this send.
            if (!stillCurrent() || conversationId() !== beforeConversation || composer() !== box ||
                !box.isConnected || !unchangedDraft() || busy() || sendButton() !== button ||
                !sendButtonEnabled(button) || box.getAttribute('aria-disabled') === 'true' ||
                box.getAttribute('contenteditable') === 'false') return finish(false, 'send-not-ready');
            // The caller's irreversible-delivery custody must cross the same synchronous
            // boundary as the native click. Authorization alone is earlier and revocable;
            // invoking this witness only after every final DOM guard lets an authorized
            // remount remain positively unsent while a thrown/swallowed click stays ambiguous.
            try { onNativeClickAttempt?.(); } catch { return finish(false, 'send-not-ready'); }
            attempted = true;
            // A native Send is single-shot, but its synchronous receipt wait is still bounded.
            // If ChatGPT does not publish the exact user row in time, the caller keeps the
            // already-authorized delivery ambiguous and may reconcile that same receipt later;
            // this owner must never keep the whole page busy forever or click Send again.
            clickedAt = Date.now();
            try { button.click(); } catch { return finish(false); }
            check(); // Synchronous navigation/cancellation during click also re-proves ownership.
          };
          if (!beforeSend) return click();
          authorizing = true;
          // Claim/dispatch authority belongs at readiness, not before a possibly long
          // disabled-Send wait. This is still one attempt under the existing deadline.
          try { Promise.resolve(beforeSend(() => !done && stillCurrent())).then(allowed => allowed === true ? click() : finish(false, 'not-authorized'), () => finish(false, 'not-authorized')); }
          catch { finish(false, 'not-authorized'); }
        };

        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
        if (observeEvidence) unsubscribeEvidence = observeEvidence(check);
        // Readiness and acceptance share one deadline below the app's command lease. Timing out
        // after an attempted receipt-owned Send means "receipt not proven yet", never "unsent".
        const timeout = Number.isFinite(acceptanceTimeoutMs) ? Math.max(1, Math.min(30000, acceptanceTimeoutMs)) : 30000;
        timer = setTimeout(() => { if (attempted) check(); if (!done) finish(false); }, timeout);
        check();
      });
    } catch {
      return false;
    }
  }

  /** Native ChatGPT photo input, observed as #upload-photos. Sending waits for every tile. */
  function composerFileName(button) {
    // Current file tiles have a filename-labelled open button and a translated
    // remove control. Count only that exact second button, independently of wording (#1944).
    const attachmentHost = button.closest('[data-composer-attachments]');
    const tileParent = button.parentElement;
    if (attachmentHost && tileParent && tileParent !== attachmentHost) {
      const actions = [...tileParent.querySelectorAll('button')];
      if (actions.length === 2 && actions[1] === button) {
        const open = actions[0], name = open.getAttribute('aria-label');
        const removal = (button.getAttribute('aria-label') || '').trim();
        const labelled = [...tileParent.querySelectorAll('span')].some(node =>
          !node.children.length && node.textContent === name);
        if (name && removal && removal !== name.trim() && labelled &&
            open.closest('[data-composer-attachments]') === attachmentHost) return name;
      }
    }
    const group = button.closest('[role="group"][aria-label]');
    if (group?.querySelector('[data-default-action="true"] button')) {
      const actions = [...group.querySelectorAll('button')].filter(node => !node.closest('[data-default-action="true"]'));
      return actions.length === 1 && actions[0] === button ? group.getAttribute('aria-label') : undefined;
    }
    return /^Remove file(?: \d+)?: (.+)$/.exec(button.getAttribute('aria-label') || '')?.[1];
  }
  function hasComposerAttachments() {
    const host = composerBox() || composerActions()?.host;
    return hasAttachmentsIn(host);
  }
  function hasAttachmentsIn(host) {
    return !!host && (!!host.querySelector('[data-inline-file-uploading], [role="progressbar"]') ||
      [...host.querySelectorAll('button[aria-label]')].some(button => composerFileName(button)));
  }
  function composerAttachmentNames() {
    const host = composerBox() || composerActions()?.host;
    return host ? [...host.querySelectorAll('button[aria-label]')].map(composerFileName).filter(Boolean).slice(0, 20).sort() : [];
  }
  let ownApps = [], configuredNames = {};
  const surfaces = ['core', 'desktop', 'plugins'];
  const legacyNames = ['Luna Forge X7 Core', 'Luna Forge X7 Desktop', 'Luna Forge X7 Plugins',
    'Chat On Steroids Core', 'Chat On Steroids Desktop', 'Chat On Steroids Plugins'];
  function setConnectorNames(value) {
    configuredNames = {};
    for (const surface of surfaces) if (typeof value?.[surface] === 'string' && value[surface].length <= 100)
      configuredNames[surface] = value[surface];
  }
  function setConnectorApps(value) {
    const next = [];
    for (const surface of surfaces) for (const app of (Array.isArray(value?.[surface]) ? value[surface] : []).slice(0, 4)) {
      if (!app || typeof app.appId !== 'string' || !/^asdk_app_[A-Za-z0-9_-]{1,160}$/.test(app.appId)) continue;
      next.push({ surface, appId: app.appId,
        linkId: typeof app.linkId === 'string' && /^link_[A-Za-z0-9_-]{1,160}$/.test(app.linkId) ? app.linkId : null,
        name: typeof app.name === 'string' && app.name.length <= 64 ? app.name : null });
    }
    const changed = JSON.stringify(next) !== JSON.stringify(ownApps);
    ownApps = next;
    return changed;
  }
  const connectorApps = () => ownApps.map(app => ({ ...app }));
  const connectorNames = () => ({ ...configuredNames });
  function provenAppsFor(name) {
    const matching = new Set(surfaces.filter(surface => configuredNames[surface] === name));
    for (const app of ownApps) if (app.name === name) matching.add(app.surface);
    if (legacyNames.includes(name)) matching.add(surfaces[legacyNames.indexOf(name) % 3]);
    // A shared display name cannot choose between independently enrolled surfaces.
    if (matching.size > 1) return null;
    return ownApps.filter(app => matching.has(app.surface));
  }
  function ownSnapshot(snapshot, name) {
    const proven = provenAppsFor(name);
    return proven !== null && (proven.length ? proven.some(app => app.appId === snapshot.appId) : snapshot.connectorName === name);
  }
  /** Observed ChatGPT Plugins settings surface. Missing/ambiguous structure is not proof. */
  async function pluginRefreshView(connectorName, expectedTools = [], expectedAppId = null) {
    const proven = provenAppsFor(connectorName);
    const exactSurfaces = new Set(ownApps.filter(app => app.appId === expectedAppId).map(app => app.surface));
    if (exactSurfaces.size > 1 || (proven === null && exactSurfaces.size !== 1)) return null;
    const externalPlugins = exactSurfaces.size ? exactSurfaces.has('plugins') :
      connectorName === configuredNames.plugins || ['Luna Forge X7 Plugins', 'Chat On Steroids Plugins'].includes(connectorName) ||
      proven?.some(app => app.surface === 'plugins');
    const snapshot = await new Promise(resolve => {
      const nonce = crypto.randomUUID();
      const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        const data = event.data;
        if (event.source === window && event.origin === location.origin && data?.source === 'clf-plugin-reply' && data.nonce === nonce && data.v === 1) finish(data.plugin);
      };
      const timer = setTimeout(() => finish(null), 1500);
      window.addEventListener('message', receive); window.postMessage({ source: 'clf-plugin-ask', nonce, apps: connectorNames(), appIds: connectorApps() }, location.origin);
    });
    const route = /^#settings\/Plugins\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.hash) ||
      (!location.hash ? /^\/(?:settings\/plugins-settings|plugins)\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.pathname) : null);
    if (!snapshot || snapshot.appId !== route?.[1] || (expectedAppId ? snapshot.appId !== expectedAppId : !ownSnapshot(snapshot, connectorName)) ||
        !Array.isArray(snapshot.tools) || (snapshot.tools.length < 1 && !externalPlugins) || snapshot.tools.length > (externalPlugins ? 257 : 64) || JSON.stringify(snapshot.tools).length > 300000 ||
        snapshot.tools.some(tool => !tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(tool.name) || typeof tool.description !== 'string' || tool.inputSchema?.type !== 'object') ||
        new Set(snapshot.tools.map(tool => tool.name)).size !== snapshot.tools.length) return null;
    const buttons = [...document.querySelectorAll('button[data-clf-plugin-refresh]')].filter(button => button.getAttribute('data-clf-plugin-refresh') === snapshot.appId && button.getClientRects().length > 0);
    return typeof snapshot.refreshAvailable === 'boolean' && buttons.length === (snapshot.refreshAvailable ? 1 : 0) ? { appId: snapshot.appId, connectorName: snapshot.connectorName, versionId: typeof snapshot.versionId === 'string' ? snapshot.versionId.slice(0, 200) : null,
      tools: snapshot.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), refresh: buttons[0] || null } : null;
  }
  function pluginInstalledButtons(connectorName) {
    const proven = provenAppsFor(connectorName);
    if (proven === null) return null;
    const names = [connectorName, ...proven.map(app => app.name).filter(Boolean)];
    const named = node => names.includes(text(node));
    return safe(() => {
      // The newer shell lists installed plugins on the /settings/plugins-settings page itself.
      if (location.pathname === '/settings/plugins-settings' && !location.hash) {
        const main = document.querySelector('main');
        if (!main || (!proven.length && !legacyNames.includes(connectorName) &&
            !Object.values(configuredNames).includes(connectorName))) return null;
        const rows = [...main.querySelectorAll('button,a[href]')].filter(row => {
          if (!row.isConnected || row.disabled || row.getAttribute('aria-disabled') === 'true' ||
              row.closest(`${OWN_SURFACES}, ${TURN}, [data-message-author-role], .markdown, [contenteditable], [hidden], [inert], [aria-hidden="true"]`) ||
              row.getClientRects().length === 0 || !composerCssVisible(row)) return false;
          const nameMatches = [...row.querySelectorAll('*')].some(node => !node.children.length && named(node));
          if (row.tagName !== 'A') return nameMatches;
          // Installed rows now use links. Only this settings page's exact app-detail route
          // can discover an identity; public catalog, legacy hash and foreign links cannot.
          try {
            const destination = new URL(row.getAttribute('href'), location.href);
            const route = /^\/settings\/plugins-settings\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(destination.pathname);
            return destination.origin === location.origin && !destination.hash && !!route &&
              (proven.length ? proven.some(app => app.appId === route[1]) : nameMatches);
          } catch { return false; }
        });
        return rows.length ? rows : null;
      }
      const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(panel => panel.getClientRects().length > 0 &&
        panel.getAttribute('aria-labelledby')?.endsWith('-trigger-Plugins'));
      if (panels.length !== 1) return null;
      // Installed settings rows are buttons, not the links in the /plugins catalog.
      // Match the name's own leaf so adjacent permission text cannot alter identity.
      const rows = [...panels[0].querySelectorAll('button')].filter(button => !button.disabled && button.getClientRects().length > 0 &&
        button.querySelector('[data-testid="plugin-icon-wrapper"]'));
      if (!rows.length) return null;
      return rows.filter(button => [...button.querySelectorAll('*')].some(node => !node.children.length && named(node)));
    }, null);
  }
  function pluginManagementIdle() {
    return safe(() => ![...document.querySelectorAll('textarea,input:not([type="hidden"]),[contenteditable="true"]')].some(node => node.getClientRects().length > 0 && String(node.value || node.textContent || '').trim()), false);
  }
  async function uploadImages(images, stillCurrent = () => true, draft = null, files = []) {
    if (files.length) images = [...(images || []), ...files];
    if (!images?.length) return true;
    if (!Array.isArray(images) || images.length > 20 || !stillCurrent() || hasComposerAttachments()) return false;
    const input = document.querySelector(files.length ? 'input#upload-files[type="file"]' : 'input#upload-photos[type="file"][accept="image/*"]');
    if (!input) return false;
    const priorTiles = new Set((composerBox() || composerActions()?.host)?.querySelectorAll('button[aria-label]') || []);
    const transfer = new DataTransfer();
    try {
      for (const image of images) {
        if (image instanceof File) { transfer.items.add(image); continue; }
        if (typeof image.name !== 'string' || !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) || image.dataUrl.length > 512100) return false;
        const raw = atob(image.dataUrl.split(',')[1]);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        transfer.items.add(new File([bytes], image.name, { type: 'image/webp' }));
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { return false; }
    return new Promise((resolve) => {
      let observer, timer;
      let ownedTiles = null;
      const finish = (ok) => { observer?.disconnect(); clearTimeout(timer); resolve(ok); };
      const check = () => {
        if (!stillCurrent()) return finish(false);
        const host = composerBox() || composerActions()?.host;
        if (!host) return;
        // ChatGPT's remove control names the complete filename. Each requested image
        // needs its own new tile; a substring or an old same-name tile is no upload ACK.
        const tiles = [...host.querySelectorAll('button[aria-label]')].filter((button) => !priorTiles.has(button) && composerFileName(button));
        // Every attached file must belong to this input. A newly added user attachment
        // cannot be silently included just because the requested subset finished uploading.
        if (tiles.length > images.length) return finish(false);
        if (!ownedTiles) {
          const unmatched = [...tiles];
          if (images.every((image) => {
            const index = unmatched.findIndex((button) => composerFileName(button) === image.name);
            if (index < 0) return false;
            unmatched.splice(index, 1);
            return true;
          })) ownedTiles = tiles;
        }
        if (!ownedTiles) return;
        // The provider can rename report.md to report(1).md during processing.
        // Bind once by exact original names, then retain those exact remove controls.
        if (tiles.length !== ownedTiles.length || tiles.some(node => !ownedTiles.includes(node))) return finish(false);
        if (!host.querySelector('[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]') && sendButtonEnabled(sendButton())) {
          draft?.attachments(ownedTiles);
          finish(true);
        }
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(false), files.length ? 600000 : 60000);
      check();
    });
  }

  const normalizeModelLabel = value => String(value || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  /** One bounded read through the existing MAIN-world helper; no provider API or setters. */
  function readPickerState() {
    return new Promise(resolve => {
      const nonce = crypto.randomUUID();
      const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.source !== 'clf-picker-reply' || data.nonce !== nonce || data.v !== 1) return;
        const state = data.picker;
        const groupId = value => typeof value === 'string' && /^[\p{L}\p{N}._: -]{1,80}$/u.test(value) && value.trim() === value && value.trim();
        const valid = state && typeof state.version === 'string' && Number.isInteger(state.currentBucket) &&
          Array.isArray(state.versions) && state.versions.length > 0 && state.versions.length <= 48 &&
          state.versions.every(v => groupId(v.id) && typeof v.label === 'string' && v.label.length > 0 && v.label.length <= 80) &&
          Array.isArray(state.choices) && state.choices.length > 0 && state.choices.length <= 48 &&
          state.choices.every(c => Number.isInteger(c.bucket) && typeof c.id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(c.id) && typeof c.label === 'string' && c.label.length > 0 && c.label.length <= 80 &&
            groupId(c.familyId) && typeof c.familyLabel === 'string' && c.familyLabel.length > 0 && c.familyLabel.length <= 80 &&
            ['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(c.effort) && typeof c.available === 'boolean' &&
            (c.retryAt === undefined || (Number.isSafeInteger(c.retryAt) && c.retryAt > Date.now() && c.retryAt <= Date.now() + 35 * 24 * 60 * 60_000))) &&
          new Set(state.versions.map(v => v.id)).size === state.versions.length && new Set(state.choices.map(c => c.bucket)).size === state.choices.length &&
          state.versions.some(v => v.id === state.version) && state.choices.some(c => c.bucket === state.currentBucket);
        if (valid && state.lanes !== undefined && !(Array.isArray(state.lanes) && state.lanes.length <= 48 &&
            state.lanes.every(Number.isInteger) && new Set(state.lanes).size === state.lanes.length &&
            state.choices.every(c => state.lanes.includes(c.bucket)))) delete state.lanes;
        finish(valid ? state : null);
      };
      const timer = setTimeout(() => finish(null), 1500);
      window.addEventListener('message', receive);
      window.postMessage({ source: 'clf-picker-ask', nonce, apps: connectorNames(), appIds: connectorApps() }, location.origin);
    });
  }
  /** UI only transports a requested selection. Provider state proves identity and availability. */
  function modelPickerTrigger() {
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const candidates = [...new Set([...(composer()?.closest('form')?.querySelectorAll('button[aria-haspopup="menu"]') || []),
      ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const observed = candidates.filter(node => node.getAttribute('data-clf-picker-route') === location.pathname);
    // Alternate native anchors are actionable only after MAIN identified their model owner.
    return observed.length === 1 ? observed[0] : candidates.length === 1 && !candidates[0].matches(reported) ? candidates[0] : null;
  }
  // Version rows can include a retirement caption below their primary label.
  // Match the leading label subtree, not the whole row or an arbitrary substring
  // in its description. Duplicate primary labels still fail closed at the caller.
  function pickerVersionLabelMatches(row, label) {
    const text = value => String(value || '').replace(/\s+/g, ' ').trim();
    const expected = text(label);
    let node = row;
    for (let depth = 0; node && depth < 8; depth++) {
      if (text(node.textContent) === expected) return true;
      node = [...node.childNodes].find(child => text(child.textContent) &&
        (child.nodeType === Node.TEXT_NODE || (child.nodeType === Node.ELEMENT_NODE &&
          !child.matches('svg,[hidden],[aria-hidden="true"],[inert]'))));
    }
    return false;
  }
  function modelPickerAccess(stillCurrent, options = {}) {
    const shown = node => node && !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.getClientRects().length > 0;
    const picker = () => document.querySelector(PICKER);
    const trigger = modelPickerTrigger;
    let motion = null;
    let firstFailure = null;
    const failed = reason => { firstFailure ??= reason; return null; };
    const remaining = timeout => Math.max(0, Math.min(timeout,
      Number.isFinite(options.deadline) ? options.deadline - Date.now() : timeout));
    const openPicker = () => {
      const panel = picker();
      return panel && panel.closest('[role="menu"],[role="dialog"]')?.getAttribute('data-state') !== 'closed' ? panel : null;
    };
    const wait = (read, timeout = 3000) => new Promise(resolve => {
      let reading = false, dirty = false, done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = async () => {
        if (done) return;
        if (!stillCurrent()) return finish(null);
        if (reading) { dirty = true; return; }
        reading = true;
        try { let value = read(); if (value?.then) value = await value; if (stillCurrent() && value) finish(value); }
        catch { finish(null); }
        finally { reading = false; if (dirty && !done) { dirty = false; void check(); } }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(null), remaining(timeout)); void check();
    });
    const state = async predicate => {
      const found = await wait(async () => { const value = await readPickerState(); return value && (!predicate || predicate(value)) ? value : null; });
      return found || failed(predicate ? 'selection_unconfirmed' : 'snapshot_missing');
    };
    // Reading native state also lets MAIN stamp the exact alternate-shell trigger owner.
    const readyTrigger = () => wait(async () => { await readPickerState(); return trigger(); },
      Number.isFinite(options.observationMs) ? Math.min(15000, Math.max(0, options.observationMs)) : 15000);
    const key = (node, value) => {
      if (!node || !stillCurrent()) return false;
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') { failed('choice_unavailable'); return false; }
      node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true })); return true;
    };
    return {
      state,
      failure: () => firstFailure,
      async open() {
        if (!stillCurrent()) return null;
        // Native Presence waits for the menu's exit animation. Chrome can suspend
        // that animation in a hidden window, retaining a closed picker and its
        // focus scope indefinitely. Suppress only this owned picker animation for
        // this operation; native state still closes/unmounts it and proves release.
        motion = document.createElement('style');
        motion.textContent = '[role="menu"]:has(> [data-testid="composer-intelligence-picker-content"]),[role="dialog"]:has([data-testid="composer-intelligence-picker-content"]),[role="menu"]:has([data-model-picker-view]),[role="menu"][data-model-picker-view]{animation:none!important}';
        document.head.append(motion);
        // A cold home editor mounts before its native Chat/Work picker. Workers
        // enter here directly, without the New Chat reuse/catalog preparation.
        // Wait for that surface, then use the same owned Chat transition before
        // interpreting account choices. Work's picker is not a denied Chat model.
        const ready = await readyTrigger();
        if (!ready) return failed('trigger_missing');
        if (ready.disabled || ready.getAttribute('aria-disabled') === 'true') return failed('choice_unavailable');
        if (!await prepareChatModelSurface(stillCurrent)) return failed('surface_unconfirmed');
        // A retained exit-animation node is not an open native menu.
        if (!openPicker()) {
          const button = await readyTrigger();
          if (!button) return failed('trigger_missing');
          if (!key(button, 'Enter') || !await wait(openPicker)) return failed('snapshot_missing');
        }
        return state();
      },
      async close() {
        try {
          if (!stillCurrent()) return false;
          const panel = picker();
          if (!panel) return true;
          const dialog = panel.closest('[role="dialog"]'), active = document.activeElement;
          if (!shown(panel) && !shown(dialog)) return true;
          // Escape belongs inside the picker focus trap, not to its outside trigger.
          // A dispatched key is only an attempt: native unmount/animation owns closure.
          if (!key(panel.contains(active) || dialog?.contains(active) ? active : panel, 'Escape')) return false;
          const closed = Boolean(await wait(() => !shown(picker()) && (!dialog?.isConnected || !shown(dialog))));
          // Rebind passive model proof to the surviving closed trigger after a portal unmount.
          if (closed && stillCurrent()) await readPickerState();
          return closed && stillCurrent();
        } finally { motion?.remove(); motion = null; }
      },
      async version(version) {
        const before = await state(); if (!before) return null;
        const versionRows = () => [...(picker()?.querySelectorAll('[role="menuitemradio"]') || [])].filter(shown);
        // The native advanced picker now renders version radios beside Power,
        // rather than replacing its effort view. Keep the older two-view contract,
        // and accept inline rows only with the observed advanced + Power surface.
        const effortView = () => !versionRows().length ||
          (picker()?.getAttribute('data-model-picker-view') === 'advanced' &&
            [...picker().querySelectorAll('[role="menuitem"][aria-keyshortcuts]')].filter(node =>
              shown(node) && node.getAttribute('aria-keyshortcuts').includes('ArrowRight')).length === 1);
        if (before.version === version && effortView()) return before;
        const label = before.versions.find(v => v.id === version)?.label;
        if (!label) return null;
        // The picker may already show the version list (including a checked row).
        // Select that row to return to its effort view; never assume the slider is open.
        if (!versionRows().length) {
          const toggle = [...picker().querySelectorAll('[role="menuitem"][aria-expanded], [role="menuitem"][data-model-picker-view-toggle]')].filter(shown);
          if (toggle.length !== 1) return null;
          toggle[0].click();
        }
        const option = await wait(() => {
          const rows = versionRows().filter(node => pickerVersionLabelMatches(node, label));
          return rows.length === 1 ? rows[0] : null;
        });
        if (!key(option, 'Enter')) return null;
        return state(next => next.version === version && effortView());
      },
      async bucket(bucket) {
        let current = await state();
        const press = direction => {
          const controls = [...(picker()?.querySelectorAll('[role="menuitem"][aria-keyshortcuts]') || [])]
            .filter(node => shown(node) && node.getAttribute('aria-keyshortcuts').includes('ArrowRight'));
          return controls.length === 1 && key(controls[0], direction);
        };
        for (let count = 0; current && count < 48; count++) {
          if (current.currentBucket === bucket) return current;
          const order = current.lanes ?? current.choices.map(c => c.bucket);
          const from = order.indexOf(current.currentBucket), to = order.indexOf(bucket);
          if (from < 0 || to < 0) return null;
          const step = to > from ? 1 : -1, direction = step > 0 ? 'ArrowRight' : 'ArrowLeft';
          let at = from + step;
          if (!press(direction)) return null;
          while (at !== to && !current.choices.some(c => c.bucket === order[at])) {
            if (!await wait(async () => !await readPickerState()) || !press(direction)) return null;
            at += step;
          }
          const version = current.version, expected = order[at];
          current = await state(next => next.version === version && next.currentBucket === expected);
        }
        return null;
      }
    };
  }
  // The current native picker or closed trigger carries the MAIN-world snapshot.
  // The route stamp prevents a retained composer from lending another chat proof.
  function visibleModelSelection() {
    const node = document.querySelector(PICKER) || modelPickerTrigger();
    if (node?.getAttribute('data-clf-selected-route') !== location.pathname) return null;
    const model = node?.getAttribute('data-clf-selected-model'), reasoningEffort = node?.getAttribute('data-clf-selected-effort');
    return model && /^[a-zA-Z0-9._-]{1,80}$/.test(model) && ['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(reasoningEffort)
      ? { model, reasoningEffort } : null;
  }
  /** Account model discovery belongs to Chat; Work mounts a different picker.
   * The caller owns one idle document and verifies draft/epoch before and after this transition. */
  async function prepareChatModelSurface(stillCurrent = () => true) {
    const radios = () => [...document.querySelectorAll('[role="radio"][data-tpp-toggle-value]')]
      .filter(node => !node.closest(OWN_SURFACES) && node.getClientRects().length > 0);
    const state = () => {
      const nodes = radios(), chat = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'chatgpt'),
        work = nodes.filter(node => node.getAttribute('data-tpp-toggle-value') === 'work');
      return chat.length === 1 && work.length === 1 ? { chat: chat[0], work: work[0] } : null;
    };
    if (!stillCurrent()) return false;
    const before = state();
    // Existing ordinary conversations do not expose the new-chat surface toggle.
    if (!before) return radios().length === 0;
    if (before.chat.getAttribute('aria-checked') === 'true') return true;
    if (before.work.getAttribute('aria-checked') !== 'true' || before.chat.disabled || before.chat.getAttribute('aria-disabled') === 'true') return false;
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = () => {
        if (!stillCurrent()) return finish(false);
        const next = state();
        if (next?.chat.getAttribute('aria-checked') === 'true' && next.work.getAttribute('aria-checked') === 'false') finish(true);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      const timer = setTimeout(() => finish(false), 5000);
      before.chat.click(); check();
    });
  }
  const modelValues = model => [model?.model, model?.id, model?.label, model?.familyId, model?.familyLabel,
    ...(Array.isArray(model?.aliases) ? model.aliases : [])].filter(value => typeof value === 'string');
  // Decimal and legacy slugs such as GPT-5.6 / gpt-5-6-thinking are not GPT-6.
  const modelMajor = (value, number) => new RegExp(`(?:^|[^a-z0-9])gpt[\\s._-]*${number}(?:$|[^0-9])`, 'i').test(value) ||
    new RegExp(`^${number}(?:$|[^0-9])`, 'i').test(value);
  const modelMinor = (value, major, minor) =>
    new RegExp(`(?:^|[^a-z0-9])gpt[\\s._-]*${major}[\\s._-]*${minor}(?:$|[^0-9])`, 'i').test(value) ||
    new RegExp(`^${major}[\\s._-]*${minor}(?:$|[^0-9])`, 'i').test(value);
  const preferredModelTier = model => {
    const names = modelValues(model);
    // GPT-6 Pro is currently surfaced as Astra on some ChatGPT accounts. It is one
    // family/rung here, not a speculative GPT-7 family. Decimal and lane aliases for
    // GPT-5.6 remain distinct from GPT-6.
    if (names.some(value => /astra/i.test(value) || modelMajor(value, 6))) return 'gpt6';
    if (names.some(value => modelMinor(value, 5, 6))) return 'gpt56';
    if (names.some(value => modelMinor(value, 5, 5))) return 'gpt55';
    return null;
  };

  function preferredModelSelections(models, requestedEffort = 'high') {
    if (!Array.isArray(models)) return [];
    const available = (wantedTier, effort) => models.find(model => preferredModelTier(model) === wantedTier &&
      Array.isArray(model.efforts) && model.efforts.includes(effort));
    // Production automation stays on GPT-6. Preserve a known higher effort during migration;
    // unavailable quality is a wait condition, not permission to choose an older model.
    const efforts = requestedEffort === 'pro' ? ['pro'] : requestedEffort === 'xhigh' ? ['xhigh'] : ['high', 'xhigh'];
    return [
      ...efforts.map(effort => [available('gpt6', effort), effort])
    ].filter(([model]) => model).map(([model, effort]) => ({ model: model.id, label: model.label, effort, aliases: model.aliases || [] }));
  }

  function sameModelSelection(choice, selection) {
    if (!choice || !selection?.model || choice.effort !== selection.reasoningEffort) return false;
    const currentModel = normalizeModelLabel(selection.model);
    return [choice.model, choice.label, ...choice.aliases]
      .some(value => normalizeModelLabel(value) === currentModel);
  }

  function collectModelChoices(result, availability, state) {
    for (const choice of state.choices) {
      const status = choice.available ? 'available' : 'unavailable';
      const evidence = { model: choice.id, label: choice.label, effort: choice.effort, status,
        ...(choice.retryAt ? { retryAt: choice.retryAt } : {}) };
      const key = `${choice.id}\u0000${choice.effort}`, previous = availability.get(key);
      if (!previous || status === 'available' && previous.status !== 'available' ||
          (status === 'unavailable' && previous.status === status && evidence.retryAt &&
            (!previous.retryAt || evidence.retryAt < previous.retryAt))) {
        availability.set(key, evidence);
      }
      if (!choice.available) continue;
      const entry = result.get(choice.familyId) || { id: choice.familyId, label: choice.familyLabel, efforts: [], aliases: [] };
      if (!entry.efforts.includes(choice.effort)) entry.efforts.push(choice.effort);
      if (!entry.aliases.includes(choice.id)) entry.aliases.push(choice.id);
      result.set(choice.familyId, entry);
    }
  }
  async function inspectModelCatalogState(stillCurrent = () => true, failure = () => {}) {
    const ui = modelPickerAccess(stillCurrent), original = await ui.open();
    if (!original) { await ui.close(); failure('picker_unavailable'); return null; }
    const result = new Map(), availability = new Map();
    let retryAt = null;
    let restored = false, closed = false;
    try {
      // One observation per version, not one mutation per effort. Computed choices
      // include account/workspace denials which the raw global preset list does not prove.
      for (const version of original.versions) {
        const state = await ui.version(version.id);
        if (!state) throw new Error('model_unconfirmed');
        collectModelChoices(result, availability, state);
        for (const choice of state.choices) {
          if (choice.available || !choice.retryAt || !['pro', 'xhigh'].includes(choice.effort) || !preferredModelTier(choice)) continue;
          retryAt = retryAt === null ? choice.retryAt : Math.min(retryAt, choice.retryAt);
        }
      }
    } catch { failure('model_unconfirmed'); result.clear(); availability.clear(); }
    finally {
      if (stillCurrent() && await ui.version(original.version)) {
        const state = await ui.bucket(original.currentBucket);
        const previous = original.choices.find(c => c.bucket === original.currentBucket);
        const selected = state?.choices.find(c => c.bucket === state.currentBucket);
        restored = selected?.id === previous.id && selected?.effort === previous.effort;
      }
      closed = await ui.close();
    }
    if (!restored) failure('restore_failed');
    if (!closed) failure('picker_close_failed');
    return restored && closed && stillCurrent() && result.size
      ? { models: [...result.values()], availability: [...availability.values()], retryAt } : null;
  }

  async function inspectModelSettings(stillCurrent = () => true, failure = () => {}) {
    const result = await inspectModelCatalogState(stillCurrent, failure);
    return result?.models.length ? result.models : null;
  }
  async function inspectModelCatalogEvidence(stillCurrent = () => true, failure = () => {}) {
    const result = await inspectModelCatalogState(stillCurrent, failure);
    return result?.models.length ? { models: result.models, availability: result.availability } : null;
  }
  async function selectModelSettings(model, effort, stillCurrent = () => true, options = {}) {
    if (!model && !effort) return true;
    // Optional diagnostics stay inside the incumbent selector. Fixed reason codes contain
    // no provider copy, model labels, draft text or snapshots. Legacy callers retain Boolean
    // results; exact helper callers can share one original deadline across two observations.
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    const selectionCurrent = () => stillCurrent() && Date.now() < deadline;
    const remaining = timeout => Math.max(0, Math.min(timeout, deadline - Date.now()));
    const ui = modelPickerAccess(selectionCurrent, options);
    let success = false, refusal = null;
    const refused = fallback => {
      refusal ??= ui.failure() || fallback;
      return false;
    };
    try {
      if (!selectionCurrent()) return refused('selection_unconfirmed');
      const original = await ui.open();
      if (!original) {
        if (!await ui.close()) refusal = 'picker_not_closed';
        return refused('selection_unconfirmed');
      }
      // Do not traverse versions when the native picker already proves the exact requested pair.
      // Apart from being unnecessary work, selecting another version and restoring it can remount
      // the composer or reset reasoning even though the user's requested High/Extra High is already
      // selected. Close the picker, re-prove the live route and editing host, and leave it alone.
      const current = original.choices.find(choice => choice.bucket === original.currentBucket);
      if (current?.available && (current.id === model || current.familyId === model || !model) &&
          (!effort || current.effort === effort)) {
        const closed = await ui.close();
        if (!closed) refusal = 'picker_not_closed';
        if (!closed || !selectionCurrent()) return refused('picker_not_closed');
        success = await waitComposerWritable(selectionCurrent, remaining(15000));
        return success || refused('composer_unwritable');
      }
      let selected = false, closed = false;
      try {
        // Exact provider slug is preferred. Existing saved display slugs may resolve only to an
        // actually observed family; never to an account default or another model.
        const name = normalizeModelLabel(model);
        const deniedRequestedChoice = state => options.exact === true && state.choices.some(choice =>
          (choice.id === model || choice.familyId === model ||
            (name && (normalizeModelLabel(choice.familyLabel) === name || normalizeModelLabel(choice.label) === name))) &&
          (!effort || choice.effort === effort) && choice.available === false);
        // A complete native snapshot can positively deny the exact requested pair. That
        // denial must survive an unrelated version's missing/hydrating snapshot below.
        if (deniedRequestedChoice(original)) return refused('choice_denied');
        let requestedFamily = model ? original.choices.find(choice => choice.id === model)?.familyId : null;
        const offered = [];
        for (const version of [original.versions.find(v => v.id === original.version), ...original.versions.filter(v => v.id !== original.version)]) {
          const state = await ui.version(version.id); if (!state) return refused('selection_unconfirmed');
          if (deniedRequestedChoice(state)) return refused('choice_denied');
          requestedFamily ||= model ? state.choices.find(choice => choice.id === model)?.familyId : null;
          for (const choice of state.choices) {
            if (!choice.available) continue;
            const exact = !model || choice.familyId === model || choice.id === model ||
              (requestedFamily && choice.familyId === requestedFamily);
            const display = !exact && name && (normalizeModelLabel(choice.familyLabel) === name ||
              normalizeModelLabel(choice.label) === name);
            if (exact || display) offered.push({ version: version.id, choice, rank: exact ? 2 : 1 });
          }
          // Selection is not catalog discovery. If the current native version offers the
          // exact execution slug and effort, another version's broken/retired menu must
          // not prevent selecting it. Keep ambiguity and final native confirmation below.
          if (version.id === original.version && model && effort && offered.some(entry =>
              entry.choice.id === model && entry.choice.effort === effort)) break;
        }
        // ChatGPT can rename/rebuild the effort ladder while keeping the same model. Resolve a
        // saved effort to the nearest lane that exact model now exposes, ties upward. High and
        // above are quality floors: a missing requested rung may migrate upward, never silently
        // downward. Cooldown fallback belongs to its separate, availability-proven owner.
        let wantedEffort = effort;
        if (options.exact !== true && effort && offered.length && !offered.some(entry => entry.choice.effort === effort)) {
          const ladder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
          const target = ladder.indexOf(effort);
          const efforts = [...new Set(offered.map(entry => entry.choice.effort))].filter(value =>
            ladder.includes(value) && (target < ladder.indexOf('high') || ladder.indexOf(value) >= target));
          if (target >= 0 && efforts.length) {
            efforts.sort((a, b) => {
              const aDistance = Math.abs(ladder.indexOf(a) - target);
              const bDistance = Math.abs(ladder.indexOf(b) - target);
              return aDistance - bDistance || ladder.indexOf(b) - ladder.indexOf(a);
            });
            wantedEffort = efforts[0];
          }
        }
        const candidates = offered.filter(entry => !wantedEffort || entry.choice.effort === wantedEffort);
        const rank = Math.max(0, ...candidates.map(candidate => candidate.rank));
        const matches = candidates.filter(candidate => candidate.rank === rank);
        if (!matches.length) return refused('choice_unavailable');
        if ((model && new Set(matches.map(candidate => candidate.choice.familyId)).size !== 1) ||
            (model && wantedEffort && new Set(matches.map(candidate => `${candidate.choice.id}\u0000${candidate.choice.effort}`)).size !== 1)) return refused('selection_ambiguous');
        const wanted = matches.find(candidate => candidate.version === original.version &&
          candidate.choice.bucket === original.currentBucket) || matches[0];
        const state = await ui.version(wanted.version), choice = wanted.choice;
        if (!state) return refused('selection_unconfirmed');
        const after = await ui.bucket(choice.bucket);
        const confirmed = after?.choices.find(candidate => candidate.bucket === after.currentBucket);
        selected = selectionCurrent() && confirmed?.available === true && confirmed.id === choice.id &&
          confirmed.effort === choice.effort;
      } finally {
        if (!selected && selectionCurrent() && await ui.version(original.version)) await ui.bucket(original.currentBucket);
        closed = await ui.close();
        if (!closed) refusal = 'picker_not_closed';
      }
      if (!selected || !closed || !selectionCurrent()) return refused(!closed ? 'picker_not_closed' : 'selection_unconfirmed');
      success = await waitComposerWritable(selectionCurrent, remaining(15000));
      return success || refused('composer_unwritable');
    } finally {
      // Report once, after native close/restore has settled. A failed close is never
      // advertised as retryable snapshot hydration, even if that was the first symptom.
      if (!success && typeof options.failure === 'function') options.failure(Date.now() >= deadline
        ? 'preparation_expired' : !stillCurrent() ? 'owner_changed' : refusal || ui.failure() || 'selection_unconfirmed');
    }
  }

  /**
   * Provider limits are holds on the exact requested model, never authorization to switch
   * models. Retain this policy boundary for the existing recovery caller.
   */
  function nextCooldownSelection(selection, models) {
    if (!selection?.model || !selection.reasoningEffort || !Array.isArray(models)) return null;
    return null;
  }

  /**
   * Before an unattended Loop send, enforce an explicit account pair when supplied; otherwise
   * keep any preferred model/effort pair the user has already
   * selected. Recovery is not a standing instruction to promote an
   * Extra High or High chat on every turn. Only an unknown or non-preferred current choice opens
   * the native picker to select GPT-6. Medium, Instant and legacy families are not accepted.
   */
  async function ensurePreferredAutomationModel(stillCurrent = () => true, requested = null) {
    // The account's explicit automation pair outranks a provider-reset native picker.
    // Do not infer a user correction merely from observing a different effort.
    if (requested?.model && requested?.reasoningEffort) {
      const effort = requested.reasoningEffort;
      const selected = await selectModelSettings(requested.model, effort, stillCurrent);
      const observed = visibleModelSelection();
      if (!selected || !stillCurrent() || observed?.reasoningEffort !== effort) {
        return { status: 'waiting', reason: 'selection_failed' };
      }
      return { status: 'ready', model: requested.model, effort, changed: true };
    }
    const selection = visibleModelSelection();
    const selectionKnown = Boolean(selection?.model && selection.reasoningEffort);
    const currentTier = preferredModelTier(selection);
    const currentPreferred = Boolean(selectionKnown && (
      currentTier === 'gpt6' && ['high', 'pro', 'xhigh'].includes(selection.reasoningEffort)
    ));
    // The closed native trigger is positive proof of the user's current pair. Do not inspect
    // the catalog and silently replace GPT-6 Extra High (or another preferred pair) merely
    // because a higher hierarchy rung also happens to be available.
    if (currentPreferred && stillCurrent()) {
      return { status: 'ready', model: selection.model, effort: selection.reasoningEffort, changed: false };
    }
    const currentStillSelected = () => {
      const current = visibleModelSelection();
      return selectionKnown && stillCurrent() && current?.model === selection.model && current.reasoningEffort === selection.reasoningEffort;
    };
    // New Chat can expose a usable composer and full native picker before its closed trigger
    // publishes the current model. That transient absence used to return selection_unknown
    // without opening the picker, so every retry made the same observation forever even while
    // Extra High was available. Catalog inspection is the proof source in this state: it can
    // select and confirm the best preferred rung without guessing the current default.
    const catalog = await inspectModelCatalogState(stillCurrent);
    // A closed picker can temporarily fail to expose its full catalog even though its exact
    // selected execution model and effort remain proven. Keep an already-selected Pro/Extra
    // High rung running in that case; catalog failure is not evidence it is unavailable.
    if (!catalog || !stillCurrent()) return currentPreferred && currentStillSelected()
      ? { status: 'ready', model: selection.model, effort: selection.reasoningEffort, changed: false,
        catalog: 'unavailable' }
      : { status: 'waiting', reason: 'catalog_unavailable' };
    const best = preferredModelSelections(catalog.models, selection?.reasoningEffort)[0];
    if (!best) return { status: 'waiting', reason: 'preferred_unavailable', ...(catalog.retryAt ? { retryAt: catalog.retryAt } : {}) };
    const currentModel = normalizeModelLabel(selection?.model);
    const already = selectionKnown && best.effort === selection.reasoningEffort &&
      [best.model, best.label, ...best.aliases].some(value => normalizeModelLabel(value) === currentModel);
    if (already) return { status: 'ready', model: best.model, effort: best.effort, changed: false };
    if (!await selectModelSettings(best.model, best.effort, stillCurrent) || !stillCurrent()) {
      // A picker refresh can reveal that the previously observed pair was valid even when the
      // first closed-trigger read was incomplete. Preserve that exact proof; otherwise wait
      // without sending on an unconfirmed Medium/Instant/default selection.
      return currentPreferred && currentStillSelected()
        ? { status: 'ready', model: selection.model, effort: selection.reasoningEffort, changed: false,
          upgrade: 'selection_failed' }
        : { status: 'waiting', reason: 'selection_failed', ...(catalog.retryAt ? { retryAt: catalog.retryAt } : {}) };
    }
    return { status: 'ready', model: best.model, effort: best.effort, changed: true,
      ...(selectionKnown ? { fromModel: selection.model, from: selection.reasoningEffort } : {}) };
  }

  /**
   * Observes the exact latest model cooldown without switching models or replaying its turn.
   * Return the selected model's reset time where exposed; existing recovery owns the wait.
   */
  async function recoverModelCooldown(error, stillCurrent = () => true) {
    if (!error || error.reason !== 'model_cooldown' || !stillCurrent() || generating() ||
        !composerSubmitReady() || hasComposerAttachments()) return { status: 'stopped', reason: 'page_not_idle' };
    const all = turns();
    const latest = all.at(-1);
    const sections = latest?.role === 'assistant' ? turnNodes(latest) : [];
    if (!latest || !sections.some(section => section === error.node || section.contains(error.node))) {
      return { status: 'stopped', reason: 'not_latest_turn' };
    }
    const selection = visibleModelSelection();
    if (!selection?.model || !selection.reasoningEffort) return { status: 'stopped', reason: 'selection_unknown' };
    const retry = error.retry;
    if (!retry?.isConnected || !displayed(retry) || retry.disabled || retry.getAttribute('aria-disabled') === 'true') {
      return { status: 'stopped', reason: 'retry_unavailable' };
    }
    const errorCurrent = () => stillCurrent() && error.node?.isConnected && retry.isConnected &&
      sections.some(section => section.isConnected && (section === error.node || section.contains(error.node))) &&
      !generating() && composerSubmitReady() && !hasComposerAttachments();
    const catalog = await inspectModelCatalogState(errorCurrent);
    if (!catalog || !errorCurrent()) return { status: 'waiting', reason: 'catalog_unavailable' };
    const unavailableCurrent = (Array.isArray(catalog.availability) ? catalog.availability : [])
      .find(choice => choice.status === 'unavailable' && sameModelSelection({
        model: choice.model, label: choice.label, effort: choice.effort, aliases: []
      }, selection));
    return { status: 'waiting', reason: 'preferred_unavailable',
      ...(unavailableCurrent?.retryAt ? { retryAt: unavailableCurrent.retryAt } : {}) };
  }

  /**
   * Clicks the one exact native Retry/Try again control for the latest transport failure.
   *
   * This is deliberately narrower than sending a prompt: the provider owns the original user
   * message and its retry semantics. A visible draft, attachment, active generation, historical
   * failure, or more than one eligible current control all fail closed.
   */
  const retriedTransportControls = new WeakSet();
  // A visible Stop alone is not permission to interrupt. Only the latest provider-owned
  // interrupted-stream card qualifies; historical/authored errors and drafts never do.
  function interruptedTransportFailure() {
    const box = composer();
    if (!box?.isConnected || hasComposerAttachments() || (editorText(box) || '').trim()) return null;
    const latest = turns().at(-1);
    const section = latest ? turnNodes(latest).at(-1) : null;
    const matches = errors().filter(error => {
      if (!error.recoverable || error.blocking || error.reason || !error.node?.isConnected ||
          !displayed(error.node) || retriedTransportControls.has(error.node) ||
          !/^connection interrupted\.? (?:waiting|please wait) for the complete answer\.?(?: retry)?$/i.test(
            String(error.text || '').replace(/\s+/g, ' ').trim())) return false;
      // An authored alert/quote can repeat the exact provider wording. It is
      // diagnostic text, never authority to interrupt the live native answer.
      if (error.node.closest?.(`${OWN_SURFACES},.markdown,blockquote,pre,code,[data-message-author-role="user"],[data-markdown-text-style],[data-content-search-unit-key$=":user"],[data-clf-user-text],[contenteditable]`)) return false;
      const container = error.node.closest?.(TURN);
      // Logical turn IDs can be reused. Only the newest physical section owns
      // the current native failure; retained older cards remain diagnostic.
      return !container || Boolean(section && (section === container ||
        section.contains(error.node) || container.contains(section)));
    });
    return matches.length === 1 ? matches[0].node : null;
  }
  function retryLatestTransportFailure(stillCurrent = () => true, beforeRetry = null) {
    // Native Retry belongs to ChatGPT's failed turn, not to the new-message composer. After a
    // delivery timeout the editor may be temporarily read-only even though the exact Retry
    // control is enabled. Keep the empty-editor/attachment/active-turn fences, but do not
    // require the editor to accept a *new* message before retrying the old one.
    const box = composer();
    const allTurns = turns();
    const wholePageLoadFailure = !box && Boolean(conversationId()) && allTurns.length === 0;
    const pendingDraft = () => [...document.querySelectorAll('textarea#pending-conversation-input')].some(composerHasDraft);
    if (!stillCurrent() || generating() || wholePageLoadFailure && pendingDraft() || (!wholePageLoadFailure && (!box?.isConnected ||
        hasComposerAttachments() || (editorText(box) || '').trim()))) {
      return { status: 'stopped', reason: 'page_not_idle' };
    }
    const latest = allTurns.at(-1);
    const latestSection = latest ? turnNodes(latest).at(-1) : null;
    const currentErrors = errors().filter(error => {
      if (error.recoverable !== true || error.blocking === true || error.reason ||
          error.node?.closest?.(`${OWN_SURFACES},.markdown,blockquote,pre,code,[data-message-author-role="user"],[data-markdown-text-style],[data-content-search-unit-key$=":user"],[data-clf-user-text],[contenteditable]`)) return false;
      const turnContainer = error.node?.closest?.(TURN);
      if (wholePageLoadFailure) return !turnContainer && conversationLoadFailure(error.text);
      return !turnContainer || Boolean(latestSection && (latestSection === turnContainer ||
        latestSection.contains(error.node) || turnContainer.contains(latestSection)));
    });
    const eligible = currentErrors.filter(error => error.retry &&
      !retriedTransportControls.has(error.node) && !retriedTransportControls.has(error.retry) && error.retry.isConnected && displayed(error.retry) &&
      !error.retry.disabled && error.retry.getAttribute('aria-disabled') !== 'true');
    if (eligible.length !== 1) {
      // A positively identified failed card can precede its Retry control. This invocation has
      // not clicked anything, but an already-spent control is NOT the same readiness evidence.
      // Preserve the old conservative result for spent, missing-error and ambiguous surfaces.
      const notReady = eligible.length === 0 && currentErrors.length === 1 &&
        currentErrors[0].node?.isConnected && displayed(currentErrors[0].node) &&
        !retriedTransportControls.has(currentErrors[0].node) &&
        !(currentErrors[0].retry && retriedTransportControls.has(currentErrors[0].retry));
      return { status: 'stopped', reason: eligible.length ? 'ambiguous_retry' : notReady ? 'retry_not_ready' : 'retry_unavailable' };
    }
    const error = eligible[0];
    const pageChanged = wholePageLoadFailure
      ? Boolean(composer()) || pendingDraft() || turns().length !== 0 || !conversationId() || !conversationLoadFailure(error.text)
      : composer() !== box || !box?.isConnected || hasComposerAttachments() || (editorText(box) || '').trim();
    if (!stillCurrent() || !error.node?.isConnected || !error.retry.isConnected || generating() || pageChanged) {
      return { status: 'stopped', reason: 'page_changed' };
    }
    // Some callers own a durable transaction whose one-shot fence must be committed before
    // React handles the native click. A false/throwing hook refuses the click and deliberately
    // leaves this live control unspent; no caller may use the hook to insert or resend text.
    if (typeof beforeRetry === 'function') {
      let authorized = false;
      try { authorized = beforeRetry(error) === true; } catch { authorized = false; }
      if (!authorized) return { status: 'stopped', reason: 'retry_not_authorized' };
    }
    // Mark before clicking: navigation can destroy this document synchronously, and a delayed
    // background receipt must never make the same live control spend the retry twice.
    retriedTransportControls.add(error.retry);
    retriedTransportControls.add(error.node);
    error.retry.click();
    return { status: 'retried' };
  }

  /** Label text for a native control, without trusting icons or nearby authored prose. */
  function nativeControlLabel(control) {
    return safe(() => (control.getAttribute('aria-label') || control.getAttribute('title') ||
      control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim(), '');
  }

  /**
   * Re-submits one exact app-authored Resume through ChatGPT's own message editor.
   *
   * Some `Resume stream unavailable` surfaces expose no Retry button. This fallback is not a
   * second composer Send: the caller must name the exact existing provider message and supply
   * its complete original text. The message must still be the newest user row, no real assistant
   * answer may follow it, and the editor must reproduce that text exactly before its one native
   * Send is authorized. Any ambiguous/remounted control fails closed.
   */
  const resubmittedResumeMessages = new Set();
  async function resubmitExactResumeMessage(options = {}) {
    const { messageId, token, expectedText, stillCurrent = () => true, beforeResubmit = null } = options;
    if (typeof messageId !== 'string' || !messageId || typeof token !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(token) || typeof expectedText !== 'string' ||
        expectedText.length > 240000 || resubmittedResumeMessages.has(messageId)) {
      return { status: 'stopped', reason: 'resume_identity_missing' };
    }
    if (!promptEnvelopeValid(expectedText)) return { status: 'stopped', reason: 'prompt-envelope-missing' };
    const marker = `[[CLF-RESUME:${token}]]`;
    if (!operatorPromptBody(expectedText).trimStart().startsWith(marker)) {
      return { status: 'stopped', reason: 'resume_identity_missing' };
    }
    const box = composer();
    if (!stillCurrent() || generating() || !box?.isConnected || hasComposerAttachments() ||
        (editorText(box) || '').trim()) return { status: 'stopped', reason: 'page_not_idle' };

    const pageMessages = messages();
    const owned = pageMessages.filter(message => message.role === 'user' && message.id === messageId);
    const userRows = pageMessages.filter(message => message.role === 'user');
    if (owned.length !== 1 || userRows.at(-1) !== owned[0]) {
      return { status: 'stopped', reason: 'resume_not_latest_user' };
    }
    const compact = value => String(value || '').replace(/\s+/g, '');
    if (!operatorPromptBody(String(owned[0].text || '')).trimStart().startsWith(marker) ||
        compact(owned[0].text) !== compact(expectedText)) {
      return { status: 'stopped', reason: 'resume_text_changed' };
    }
    const ownedIndex = pageMessages.indexOf(owned[0]);
    if (pageMessages.slice(ownedIndex + 1).some(message => message.role === 'user' ||
        (message.role === 'assistant' && !resumeStreamFailure(message.text)))) {
      return { status: 'stopped', reason: 'newer_answer_present' };
    }
    const failures = errors().filter(error => resumeStreamFailure(error.text));
    if (failures.length !== 1 || failures[0].retry) {
      return { status: 'stopped', reason: failures.length > 1 ? 'ambiguous_failure' :
        failures.length === 0 ? 'stream_failure_missing' : 'native_retry_available' };
    }

    const scope = owned[0].node?.closest?.(TURN) || owned[0].node;
    if (!scope?.isConnected || failures[0].node?.closest?.(OWN_SURFACES)) {
      return { status: 'stopped', reason: 'page_changed' };
    }
    const editableControls = [...scope.querySelectorAll('button')].filter(control =>
      displayed(control) && !control.disabled && control.getAttribute('aria-disabled') !== 'true' &&
      /^(?:edit|edit message)$/i.test(nativeControlLabel(control)) &&
      !control.closest(`${OWN_SURFACES},.markdown,[contenteditable]`));
    if (editableControls.length !== 1) {
      return { status: 'stopped', reason: editableControls.length ? 'ambiguous_edit' : 'edit_unavailable' };
    }
    const edit = editableControls[0];
    if (!stillCurrent() || !edit.isConnected || messages().filter(message =>
        message.role === 'user' && message.id === messageId).length !== 1) {
      return { status: 'stopped', reason: 'page_changed' };
    }
    edit.click();

    const editing = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true; observer.disconnect(); clearTimeout(timer); resolve(value);
      };
      const check = () => {
        if (!stillCurrent() || !scope.isConnected) return finish(null);
        const editors = [...scope.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')]
          .filter(editor => editor !== composer() && displayed(editor) && !editor.closest(OWN_SURFACES));
        if (editors.length > 1) return finish(null);
        if (editors.length === 1) finish(editors[0]);
      };
      const observer = new MutationObserver(check);
      observer.observe(scope, { subtree: true, childList: true, attributes: true });
      const timer = setTimeout(() => finish(null), 5000);
      check();
    });
    const cancelEdit = () => {
      const cancels = [...scope.querySelectorAll('button')].filter(control => displayed(control) &&
        !control.disabled && control.getAttribute('aria-disabled') !== 'true' &&
        /^cancel$/i.test(nativeControlLabel(control)) && !control.closest(`${OWN_SURFACES},.markdown`));
      if (cancels.length === 1) cancels[0].click();
    };
    if (!editing) {
      cancelEdit();
      return { status: 'stopped', reason: 'edit_unavailable' };
    }
    const readEditing = () => editing instanceof HTMLTextAreaElement ? editing.value :
      (typeof editing.innerText === 'string' ? editing.innerText : [...editing.childNodes]
        .map(node => editorText(node) + (/^(P|DIV|BR)$/.test(node.nodeName) ? '\n' : '')).join('')).trim();
    const editedText = readEditing();
    if (!operatorPromptBody(editedText).trimStart().startsWith(marker) || compact(editedText) !== compact(expectedText)) {
      cancelEdit();
      return { status: 'stopped', reason: 'resume_text_changed' };
    }
    const submit = [...scope.querySelectorAll('button')].filter(control => displayed(control) &&
      !control.disabled && control.getAttribute('aria-disabled') !== 'true' &&
      /^(?:send|send message|save|save changes)$/i.test(nativeControlLabel(control)) &&
      !control.closest(`${OWN_SURFACES},.markdown`));
    if (submit.length !== 1 || !stillCurrent() || !editing.isConnected) {
      cancelEdit();
      return { status: 'stopped', reason: submit.length > 1 ? 'ambiguous_send' : 'send_unavailable' };
    }
    if (typeof beforeResubmit === 'function') {
      let authorized = false;
      try { authorized = beforeResubmit() === true; } catch { authorized = false; }
      if (!authorized) {
        cancelEdit();
        return { status: 'stopped', reason: 'resubmit_not_authorized' };
      }
    }
    const finalText = readEditing();
    if (!stillCurrent() || !editing.isConnected || finalText !== editedText || !promptEnvelopeValid(finalText) ||
        !submit[0].isConnected || submit[0].disabled || submit[0].getAttribute('aria-disabled') === 'true') {
      cancelEdit();
      return { status: 'stopped', reason: 'resume_text_changed' };
    }
    resubmittedResumeMessages.add(messageId);
    submit[0].click();
    return { status: 'resubmitted' };
  }

  function projectHomeId(pathname = location.pathname) {
    return /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]+)?\/project\/?$/i.exec(pathname)?.[1]?.toLowerCase() || null;
  }

  const PROJECT_ENTRY_HYDRATION_MS = 45_000;
  const PROJECT_ENTRY_TRANSITION_MS = 12_000;
  const PROJECT_ENTRY_RETRY_MS = 2_000;
  const PROJECT_ENTRY_MAX_ATTEMPTS = 3;

  /** Enter a Project through its source chat's native link. Cold /project loads can error. */
  async function enterProject(entry, stillCurrent = () => true) {
    if (!entry || !/^g-p-[0-9a-f]{32}$/.test(entry.id) || conversationId() !== entry.sourceConversationId) return false;
    return new Promise(resolve => {
      let attempts = 0, done = false, expectedHref = null;
      let retryTimer = null;
      const interrupt = event => { if (event.isTrusted) finish(false); };
      const finish = result => {
        if (done) return;
        done = true; observer.disconnect(); clearTimeout(deadlineTimer); clearTimeout(retryTimer);
        document.removeEventListener('pointerdown', interrupt, true);
        document.removeEventListener('keydown', interrupt, true);
        resolve(result);
      };
      const safeSource = () => {
        const source = composer();
        return stillCurrent() && conversationId() === entry.sourceConversationId && source?.isConnected &&
          composerSubmitReady() && !hasComposerAttachments() ? source : null;
      };
      const projectLink = () => {
        const links = [...document.querySelectorAll('a[href]')].filter(link => {
          const url = new URL(link.href, location.href);
          // The current Project header no longer exposes the old folder-icon test id. The
          // unique same-origin /g/<exact-id>/project target is the native identity; requiring
          // the retired icon made every otherwise-ready handoff wait out its whole deadline.
          return !link.closest(`${OWN_SURFACES}, ${TURN}`) && !onKeptPage(link) && composerCssVisible(link) && url.origin === location.origin &&
            projectHomeId(url.pathname) === entry.id &&
            (!expectedHref || url.href === expectedHref);
        });
        return links.length === 1 ? links[0] : null;
      };
      const projectHomeReady = () => attempts > 0 && projectHomeId() === entry.id &&
        composer()?.isConnected && composerSubmitReady() && !turns().length;
      const scheduleRetry = () => {
        if (done || retryTimer || attempts >= PROJECT_ENTRY_MAX_ATTEMPTS) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          check();
        }, PROJECT_ENTRY_RETRY_MS);
      };
      const check = () => {
        if (done) return;
        if (!stillCurrent()) return finish(false);
        // ChatGPT now keeps the same editor element while moving a Project chat to its Project
        // home. The exact route, one empty/writable current editor, and no displayed turns are
        // the receipt; editor replacement is no longer evidence and retained hidden pages do
        // not participate in any of those elections.
        if (projectHomeReady()) return finish(true);
        if (conversationId() !== entry.sourceConversationId) {
          if (projectHomeId() !== entry.id) finish(false);
          return;
        }
        if (attempts > 0 && retryTimer) return;
        // The native header arrives before the source chat finishes loading. Its link
        // alone is not readiness: an early click can be swallowed during hydration and
        // fully hydrated SPA can still swallow that exact native click, so retry the
        // same link at most twice more. Every attempt repeats the full source/draft/
        // generation/attachment/identity proof; a changed link or user action fails closed.
        const source = safeSource();
        const link = source && projectLink();
        if (!source || !link) {
          if (attempts > 0) scheduleRetry();
          return;
        }
        const href = new URL(link.href, location.href).href;
        if (!expectedHref) expectedHref = href;
        if (href !== expectedHref || attempts >= PROJECT_ENTRY_MAX_ATTEMPTS) return;
        attempts++;
        link.click();
        // A warm SPA can complete the native transition synchronously inside the click.
        // Accept the exact Project-home receipt before arming another timer;
        // waiting for MutationObserver here lets an unrelated deadline race a transition that
        // has already succeeded (and made the Project bootstrap fail in the test/live fast path).
        if (stillCurrent() && projectHomeReady()) return finish(true);
        if (conversationId() !== entry.sourceConversationId && projectHomeId() !== entry.id) return finish(false);
        scheduleRetry();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      const deadlineTimer = setTimeout(() => finish(false), PROJECT_ENTRY_HYDRATION_MS + PROJECT_ENTRY_TRANSITION_MS);
      document.addEventListener('pointerdown', interrupt, true);
      document.addEventListener('keydown', interrupt, true);
      check();
    });
  }

  function projectCreateControl() {
    return safe(() => {
      const shown = [...document.querySelectorAll('button[data-app-action-sidebar-project-create]')]
        .filter(node => !node.closest(`${OWN_SURFACES},[hidden],[aria-hidden="true"],[inert]`) &&
          node.getClientRects().length > 0 && !node.disabled);
      return shown.length === 1 ? shown[0] : null;
    }, null);
  }

  function revealSidebar() {
    return safe(() => {
      const toggles = [...document.querySelectorAll('button[data-testid="open-sidebar-button"][aria-expanded="false"]')]
        .filter(node => !node.closest(`${OWN_SURFACES},[hidden],[aria-hidden="true"],[inert]`) &&
          node.getClientRects().length > 0 && !node.disabled);
      if (toggles.length !== 1) return false;
      toggles[0].click();
      return true;
    }, false);
  }

  function projectIdsShown() {
    return safe(() => [...new Set([...document.querySelectorAll('a[href]')]
      .map(link => projectHomeId(new URL(link.href, location.href).pathname)).filter(Boolean))], []);
  }

  function projectCreateForm() {
    return safe(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .filter(node => node.querySelector('input#chatgpt-project-name') && node.getClientRects().length > 0);
      if (dialogs.length !== 1) return null;
      const input = dialogs[0].querySelector('input#chatgpt-project-name');
      const submits = [...dialogs[0].querySelectorAll('button[type="submit"]')];
      return input && submits.length === 1 ? { dialog: dialogs[0], input, submit: submits[0] } : null;
    }, null);
  }

  function fillProjectName(input, name) {
    return safe(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      input.focus();
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === name;
    }, false);
  }

  async function newChatControl(stillCurrent = () => true) {
    const shown = node => node && !node.closest(OWN_SURFACES) && !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.getClientRects().length > 0;
    const link = (root = document) => [...root.querySelectorAll('a[data-testid="create-new-chat-button"][data-sidebar-item="true"][href="/"]')].find(shown) || null;
    if (!stillCurrent()) return null;
    if (link()) return link();
    // Compact ChatGPT unmounts navigation when its sidebar is closed. Reveal the
    // actual native control before concluding that this document cannot be reused.
    const toggles = [...document.querySelectorAll('button[data-testid="open-sidebar-button"][aria-expanded="false"][aria-controls]')].filter(shown);
    if (toggles.length !== 1 || toggles[0].disabled) return null;
    const toggle = toggles[0], sidebarId = toggle.getAttribute('aria-controls');
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = () => {
        if (!stillCurrent()) return finish(null);
        const sidebar = document.getElementById(sidebarId), control = sidebar && link(sidebar);
        if (toggle.getAttribute('aria-expanded') === 'true' && control) finish(control);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      const timer = setTimeout(() => finish(null), 3000);
      toggle.click(); check();
    });
  }
  /**
   * Exact native proof that the current ChatGPT page is an active Temporary Chat.
   *
   * The checked sprite is the locale-independent classic-shell receipt. The current
   * 2026-09-24 shell no longer mounts that sprite consistently, so accept its paired
   * provider surfaces as well: the page-header Save chat control and the composer-local
   * Temporary chat marker, on the requested temporary-chat route. Neither URL intent,
   * authored transcript text, nor either English surface by itself is authority.
   */
  function temporaryChatReady() {
    return safe(() => {
      // Mode activation is not readiness while the native introduction owns focus.
      if (temporaryChatIntroductions().length) return false;
      const visible = node => node && !node.closest(OWN_SURFACES) &&
        !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.getClientRects().length > 0;
      const checked = [...document.querySelectorAll('button')].some(button => {
        if (!visible(button) || button.closest('[data-message-author-role], [data-testid^="conversation-turn-"]')) return false;
        // The provider renders both classic icons at once. Only the visible checked glyph
        // proves that shell's mode; translated labels and URL intent remain insufficient.
        return [...button.querySelectorAll('svg use')].some(use => {
          const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
          if (href.slice(href.lastIndexOf('#')) !== '#chat-temp-checked') return false;
          for (let node = use.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || style.opacity === '0') return false;
          }
          return true;
        });
      });
      if (checked) return true;
      const url = new URL(location.href);
      const requestedTemporary = url.searchParams.get('temporary-chat') === 'true';
      // The elected helper may lose both query markers during native hydration. Its enabled
      // mode is still observable on an empty bare home; input election/claim remains separate.
      const strippedHome = url.pathname === '/' && !url.search && !url.hash &&
        !document.querySelector(`${TURN},[data-turn-key]`);
      if (!requestedTemporary && !strippedHome) return false;

      const box = composerBox();
      if (!visible(box)) return false;
      // Current app-shell receipt (2026-09-24): Temporary Chat is an enabled header mode whose
      // only native action is "Turn off temporary chat". The former Save-chat + composer-marker
      // pair is no longer mounted. Keep this proof inside the provider-owned app-shell header,
      // require the temporary route or empty bare home plus a live composer, excluding authored text;
      // wording anywhere else remains insufficient.
      const appShellHeaders = [...document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')]
        .filter(visible);
      const enabledHeaderToggle = appShellHeaders.some(header =>
        [...header.querySelectorAll('button')].some(button => visible(button) &&
          !button.closest('[data-message-author-role], [data-testid^="conversation-turn-"], .markdown, [contenteditable]') &&
          (button.getAttribute('aria-label') || '').trim() === 'Turn off temporary chat'));
      if (enabledHeaderToggle) return true;
      if (!requestedTemporary) return false;

      const temporaryMarker = [...box.querySelectorAll('*')].some(node => {
        if (!visible(node) || node.closest('[data-message-author-role], [data-testid^="conversation-turn-"]')) return false;
        return text(node, 80) === 'Temporary chat' ||
          ['aria-label', 'title', 'data-placeholder'].some(name => (node.getAttribute(name) || '').trim() === 'Temporary chat');
      });
      if (!temporaryMarker) return false;

      const headers = [...document.querySelectorAll('[data-testid="page-header"], header')].filter(visible);
      return headers.some(header => [...header.querySelectorAll('button')].some(button => visible(button) &&
        !button.closest('[data-message-author-role], [data-testid^="conversation-turn-"]') &&
        (text(button, 80) === 'Save chat' || ['aria-label', 'title'].some(name =>
          (button.getAttribute(name) || '').trim() === 'Save chat'))));
    }, false);
  }

  function temporaryChatIntroductions() {
    return [...document.querySelectorAll('[role="dialog"]')].filter(node =>
      !node.closest(`${OWN_SURFACES},[data-message-author-role],[data-testid^="conversation-turn"],.markdown,[hidden],[aria-hidden="true"],[inert]`) &&
      node.getClientRects().length > 0 &&
      [...node.querySelectorAll('h1,h2,[role="heading"]')].some(heading => /^Temporary chat$/i.test(text(heading, 100))) &&
      /(?:Not in history|won['’]t appear in (?:your )?history)/i.test(text(node, 2000)));
  }
  function confirmTemporaryChatIntroduction() {
    const dialogs = temporaryChatIntroductions();
    const buttons = dialogs.length === 1 ? [...dialogs[0].querySelectorAll('button')].filter(node =>
      /^Continue$/i.test(text(node, 100)) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.getClientRects().length > 0) : [];
    if (buttons.length === 1) buttons[0].click();
  }

  return {
    userPromptText,
    operatorPromptBody,
    promptEnvelopeValid,
    promptEnvelopeReady,
    promptEnvelopeProtocol,
    preparePromptEnvelope,
    userMessageReaction,
    presentUserPrompts,
    composerVisible,
    prepareChatModelSurface,
    newChatControl,
    projectCreateControl,
    projectCreateForm,
    revealSidebar,
    projectIdsShown,
    fillProjectName,
    projectHomeId,
    enterProject,
    visibleModelSelection,
    inspectModelSettings,
    inspectModelCatalogEvidence,
    uploadImages,
    captureComposerDraft,
    composerText: (box = composer()) => editorText(box),
    hasComposerAttachments,
    composerAttachmentNames,
    connectorMentionIdentity,
    nativeConnectorMentionIdentity,
    connectorMentionSelected,
    composerAuthoredText,
    insertPromptWithConnector,
    connectorMenuOption,
    connectorMenuOptionReader,
    selectConnectorMenuOption,
    openConnectorMenu,
    pluginRefreshView,
    setConnectorApps,
    setConnectorNames,
    connectorApps,
    connectorNames,
    pluginInstalledButtons,
    pluginManagementIdle,
    selectModelSettings,
    nextCooldownSelection,
    ensurePreferredAutomationModel,
    recoverModelCooldown,
    retryLatestTransportFailure,
    interruptedTransportFailure,
    conversationLoadRetryControl,
    resubmitExactResumeMessage,
    temporaryChatReady,
    confirmTemporaryChatIntroduction,
    workModeInterstitial,
    conversationId,
    conversationFromPath,
    conversationTitle,
    shellKind,
    turns,
    presentationTurns,
    turnContainer,
    turnMutationRelevant,
    messages,
    messagesIn,
    sectionSignature,
    generating,
    approvalWaiting,
    approvalMutationRelevant,
    autoApproveIfNeeded,
    noteStopClick,
    restoreStoppedTurn,
    clearStoppedTurn,
    dictating,
    stopButton,
    stopGeneration,
    sendButton,
    progressLine,
    progressItems,
    interrupted,
    markProgress,
    toolBlocks,
    activityItems,
    isConnectorBlock,
    markLocalBlock,
    hasConnectorRow,
    connectorRows,
    fiberRef,
    toolLabel,
    errors,
    accessNoticeSince,
    composer,
    composerSubmitReady,
    composerWritable,
    composerDiagnostics,
    authenticationState,
    emptyComposerForClose,
    waitComposerWritable,
    composerBox,
    pageTheme,
    composerActions,
    composerStack,
    firstUserMessage,
    turnMount,
    boundedVirtualizedTurnHost,
    hideProgress,
    replaceActivity,
    insertPrompt,
    setTabStatus,
    composerHasProtectedDraft,
    clearPromptExact,
    send
  };
})();
