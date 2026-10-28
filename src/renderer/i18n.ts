import zhCN from './locales/zh-CN.json';

export type Language = 'en' | 'zh-CN';
const STORAGE_KEY = 'cos.ui.language';
/**
 * Account/device profiles landed after the generated locale file. Keep this small overlay beside
 * the renderer that owns the feature until the locale bundle's next generated refresh; callers
 * still see one catalogue and interpolation is validated exactly the same way.
 */
const accountZhCN: Readonly<Record<string, string>> = {
  'Copy diagnostics': '复制诊断信息',
  'Copy privacy-safe runtime, queue and recovery diagnostics': '复制不包含私人内容的运行、队列和恢复诊断信息',
  'Message target': '消息目标',
  'Why is this stuck?': '为什么任务停住了？',
  'Account': '账户', 'Task': '任务', 'Folder': '文件夹', 'Model': '模型', 'Automation': '自动化',
  'Checking active account…': '正在确认当前账户…',
  'Checking selected task…': '正在确认所选任务…',
  'Checking task folder…': '正在确认任务文件夹…',
  'Selected project unavailable': '所选项目不可用',
  'No project folder selected': '未选择项目文件夹',
  'Choose a confirmed model': '请选择已确认可用的模型',
  'Loop continuation': '循环续接',
  'Require verified tool results': '要求已验证的工具结果',
  'Continue after a settled reply': '回复明确结束后继续',
  'Settled-turn mode continues after a verified finished reply. Missing tool results stay Unverified; the next turn must reconcile saved work. Live tools, approvals, drafts and uncertain sends still hold.': '轮次结束模式会在确认回复结束后继续。缺失的工具结果仍标记为未验证；下一轮必须先核对已保存的工作。运行中的工具、审批、草稿和不确定的发送仍会阻止续接。',
  'Use an existing tunnel service with a permanent HTTPS address, or leave the address blank for local only.': '使用现有隧道服务和固定 HTTPS 地址，或将地址留空以仅在本地使用。',
  'ChatGPT sign-out emergency': 'ChatGPT 退出登录紧急提醒',
  'When the companion positively detects this account signed out, pause browser dispatch and send one DPAPI-backed Pushover emergency. From 10 PM–8 AM local, also play one bounded computer wake-up ring. Windows only.': '当配套扩展明确检测到此账户已退出登录时，暂停浏览器任务派发，并通过 DPAPI 凭据发送一次 Pushover 紧急提醒。当地时间晚上 10 点至早上 8 点，还会播放一次有时限的电脑唤醒提示音。仅支持 Windows。',
  'ChatGPT signed out for {0}. Browser dispatch is paused. A bounded wake-up alert is playing.': '账户 {0} 的 ChatGPT 已退出登录。浏览器任务派发已暂停。正在播放有时限的唤醒提示音。',
  ', or share a whole drive after reviewing its access warning. File tools protect operating-system locations; terminal commands still use your OS permissions.': '，或在查看访问警告后共享整个驱动器。文件工具会保护操作系统位置；终端命令仍使用您的操作系统权限。',
  'Share folders across accounts': '跨账户共享文件夹',
  'Stop sharing folders across accounts': '停止跨账户共享文件夹',
  'One folder list for current and future accounts on this computer. Other computers keep their own local paths.': '此电脑上的当前和未来账户使用同一份文件夹列表。其他电脑保留各自的本地路径。',
  'Manage the shared folder list in the primary account window. Credentials and account settings remain separate.': '在主账户窗口中管理共享文件夹列表。凭据和账户设置保持独立。',
  'Shared on this computer. New accounts inherit this exact list; removals take effect on their next local tool call.': '已在此电脑上共享。新账户继承此列表；移除的权限在下一次本地工具调用时生效。',
  'Check this account window': '请查看此账户窗口',
  'Key stored securely': '密钥已安全保存',
  'Rotation · Fair queue': '轮换 · 公平队列',
  'Rotation batch': '轮换批次',
  'In Rotation mode, run this many top-level Loop chats at once. Each chat still chooses its own useful worker count up to its saved/global limit.': '在轮换模式下，同时运行此数量的顶层循环对话。每个对话仍会在其已保存或全局上限内自行选择合适的子智能体数量。',
  'chats': '个对话',
  'Rotation window': '轮换时长',
  'After this long, the active batch stops receiving new automatic work, finishes in-flight turns/tools, then yields to the next batch.': '经过此时长后，活动批次停止接收新的自动任务，完成正在进行的轮次和工具调用，然后让位给下一批次。',
  'New-chat priority slots': '新对话优先槽位',
  'Temporarily let this many newly started chats run above the normal Rotation batch. Their current turn finishes, then a Loop joins the front of the regular queue.': '允许此数量的新对话临时在常规轮换批次之外运行。当前轮次完成后，其循环会加入常规队列前端。',
  'slots': '个槽位',
  'Luna Forge X7 Plugins': 'Luna Forge X7 Plugins',
  'Loading account…': '正在加载账户…',
  'Accounts and devices': '账户和设备',
  'Manage accounts & devices…': '管理账户和设备…',
  'Add account or device…': '添加账户或设备…',
  'Accounts & devices': '账户和设备',
  'No active profile': '没有活动配置',
  'Close account manager': '关闭账户管理',
  'Each profile keeps its own browser account, connector identity, workers, and local state.': '每个配置都有独立的浏览器账户、连接器身份、子智能体和本地状态。',
  'Profiles': '配置',
  'Add account or device': '添加账户或设备',
  'Account and device profiles': '账户和设备配置',
  'Profile': '配置',
  'Win': 'Windows',
  'Windows': 'Windows',
  'Mac': 'Mac',
  'Linux': 'Linux',
  'Disconnected': '未连接',
  'Offline': '离线',
  'Core off': 'Core 已关闭',
  'Core starting': 'Core 正在启动',
  'Core live': 'Core 在线',
  'Core error': 'Core 错误',
  'Nickname': '昵称',
  'Browser profile': '浏览器配置',
  'Profile activity': '配置活动',
  'active workers': '活跃子智能体',
  'queued workers': '排队子智能体',
  'Save nickname': '保存昵称',
  'Switch to profile': '切换到此配置',
  'Active profile': '当前配置',
  'Disable profile': '停用配置',
  'Enable profile': '启用配置',
  'Link ChatGPT account': '关联 ChatGPT 账户',
  'Remove…': '移除…',
  'Switch to another profile before disabling this one.': '请先切换到其他配置，再停用此配置。',
  'Pending operations': '待处理操作',
  'Connector setup': '连接器设置',
  'MCP URL': 'MCP URL',
  'Status': '状态',
  'Progress': '进度',
  'Never': '从未',
  'Last successful request': '最近一次成功请求',
  'Live': '在线',
  'Error': '错误',
  'Copy setup': '复制设置',
  'Copy error': '复制错误信息',
  'Verify / reconnect': '验证 / 重新连接',
  'Switch to this profile before reconnecting its connector.': '请先切换到此配置，再重新连接其连接器。',
  'Profile change pending': '配置切换待处理',
  'Finish current work': '完成当前工作',
  'Drain & Apply Update': '排空并应用更新',
  'Queue update': '安排更新',
  'Update queued': '更新已排队',
  'Update queued · finishing current work': '更新已排队 · 正在完成当前工作',
  'Safe update shutdown queued · finishing current work': '安全更新关闭已排队 · 正在完成当前工作',
  'Update is ready to restart': '更新已准备好重启',
  'Installing update…': '正在安装更新…',
  'Ready for external updater': '已准备好交给外部更新程序',
  '{0} active operation(s) still finishing. New chats and automation are on hold.': '仍有 {0} 个活动操作正在完成。新对话和自动化已暂停。',
  'All accepted work is settling. Chat On Steroids will restart automatically when it is safe.': '所有已接受的工作正在收尾。安全后 Chat On Steroids 将自动重启。',
  'Update queued. Chat On Steroids pauses new work, finishes current work, then closes and starts again as the new version.': '更新已排队。Chat On Steroids 会暂停新工作、完成当前工作，然后关闭并以新版本重新启动。',
  'Queued update cancelled. New work is allowed again.': '已取消排队的更新。现在可以再次开始新工作。',
  'Create a local profile for one ChatGPT browser profile. Nothing is restarted by this screen.': '为一个 ChatGPT 浏览器配置创建本地配置。此界面不会重启应用。',
  'Work account': '工作账户',
  'Browser profile directory': '浏览器配置目录',
  'Chrome profile directory': 'Chrome 配置目录',
  'Set an unbound active account now. To change an existing binding, switch away first.': '现在可设置尚未绑定的当前账户。若要更改已有绑定，请先切换到其他账户。',
  'Save Chrome profile': '保存 Chrome 配置',
  'Run alongside': '同时运行',
  'Running · pair browser': '运行中 · 需配对浏览器',
  'Core tunnel ID': 'Core 隧道 ID',
  'Save tunnel': '保存隧道',
  'Tunnel runtime API key': '隧道运行时 API 密钥',
  'No key stored': '未保存密钥',
  'Save key': '保存密钥',
  'Clear key': '清除密钥',
  'Profile 3': 'Profile 3',
  'tunnel_…': 'tunnel_…',
  'Profile 2': '例如：Profile 2',
  'Use the browser profile directory exactly as it is configured on this device.': '请按此设备上的实际配置准确填写浏览器配置目录。',
  'The device label is added to connector names automatically. Typing “Example Mac” or “Example Windows” will not duplicate it.': '设备标签会自动添加到连接器名称中。输入“Example Mac”或“Example Windows”不会重复添加。',
  'Current work is still running': '当前工作仍在运行',
  'This profile can switch after its current work finishes.': '当前工作完成后即可切换到此配置。',
  'Keep current profile': '保持当前配置',
  'Switch after current work': '当前工作完成后切换',
  'Remove profile': '移除配置',
  'Type the profile nickname to confirm removal.': '输入配置昵称以确认移除。',
  'Confirmation': '确认文本',
  '{0} active · {1} queued': '{0} 个活跃 · {1} 个排队',
  '{0} ({1})': '{0}（{1}）',
  '{0} {1}': '{0} 项：{1}',
  '{0} pending operation(s)': '{0} 个待处理操作',
  'Checking current work before switching…': '正在检查当前工作后再切换…',
  'Profile switched.': '已切换配置。',
  'Profile switch queued after current work.': '已安排在当前工作完成后切换配置。',
  'Profile switch is blocked.': '配置切换被阻止。',
  'Creating profile…': '正在创建配置…',
  'Profile added.': '配置已添加。',
  'Nickname is already up to date.': '昵称已是最新。',
  'Saving nickname…': '正在保存昵称…',
  'Nickname saved.': '昵称已保存。',
  'Disabling profile…': '正在停用配置…',
  'Enabling profile…': '正在启用配置…',
  'Profile enabled.': '配置已启用。',
  'Profile disabled.': '配置已停用。',
  'ChatGPT opened in this browser profile. Sign in there to link the account.': '已在此浏览器配置中打开 ChatGPT。请在那里登录以关联账户。',
  'ChatGPT account link opened.': '已打开 ChatGPT 账户关联页面。',
  'Connector setup copied.': '连接器设置已复制。',
  'Reconnecting connector…': '正在重新连接连接器…',
  'Connector refresh requested.': '已请求刷新连接器。',
  'Type “{0}” to confirm removal. This removes the local profile only.': '输入“{0}”确认移除。此操作仅移除本地配置。',
  'The nickname does not match.': '昵称不匹配。',
  'Removing profile…': '正在移除配置…',
  'Profile removed.': '配置已移除。',
  'Updating pending profile operation…': '正在更新待处理的配置操作…',
  'Pending profile operation updated.': '待处理的配置操作已更新。',
  'Profile switch to {0}': '切换到配置 {0}',
  'Application update': '应用更新',
  'Safe close for update': '安全关闭以进行更新',
  'Profile lifecycle transition': '配置生命周期切换',
  'Waiting to become active': '等待成为活动配置',
  'queued': '已排队',
  'draining': '正在排空',
  'ready': '就绪',
  'applying': '正在应用',
  'switch-ready': '切换就绪',
  'draining-update': '正在为更新排空',
  'draining-shutdown': '正在为安全关闭排空',
  'shutdown-applied': '正在安全关闭',
  'drain-ready': '排空完成',
  'Current work is idle. Switching profiles…': '当前工作已空闲。正在切换配置…',
  'Current work is idle. Applying the committed update…': '当前工作已空闲。正在应用已确认的更新…',
  'Current work is idle. Closing safely for the external updater…': '当前工作已空闲。正在安全关闭以供外部更新程序使用…',
  'Pause new work, finish active work, save state, and close for an external update': '暂停新任务，等待当前任务完成，保存状态并关闭以进行外部更新',
  'Safe close requested. New work is paused; active work may finish before the app saves state and closes for the external updater.': '已请求安全关闭。新任务已暂停；当前任务完成后，应用将保存状态并关闭，以供外部更新程序使用。',
  'This profile belongs to another physical device.': '此配置属于另一台实体设备。',
  'Switch to this profile to start its local bridge and connector.': '切换到此配置以启动其本地桥接和连接器。',
  'Core connector needs attention.': 'Core 连接器需要处理。',
  'Browser paired and present.': '浏览器已配对并在线。',
  'Browser paired; companion is not currently present.': '浏览器已配对，但配套扩展当前不在线。',
  'Browser companion is not paired.': '浏览器配套扩展尚未配对。',
  'Connector has not reached ChatGPT.': '连接器尚未连接到 ChatGPT。',
  'connector request(s) still executing or recording': '连接器请求仍在执行或记录',
  'send(s) are already authorized/in delivery and must resolve without replay': '消息已获发送授权或正在发送，必须在不重复发送的情况下完成',
  'already-created message(s) are waiting for their existing delivery contract': '已创建的消息正在等待既有发送流程完成',
  'ChatGPT turn(s) are still visibly active': 'ChatGPT 轮次仍明显处于活动状态',
  'Compact & Resume / handoff transaction(s) have not reached a terminal commit or abort': '压缩并继续 / 交接事务尚未完成提交或终止',
  'worker(s) are active, detached, or waking': '子智能体仍处于活跃、无标签页或唤醒状态',
  'already-created worker(s) are waiting for browser bootstrap': '已创建的子智能体正在等待浏览器启动',
  'profile-owned browser command(s) are still queued or leased': '此配置拥有的浏览器命令仍在排队或已被占用',
  'Account profile not found.': '未找到账户配置。',
  'Type the exact profile nickname to confirm removal.': '请输入完整且准确的配置昵称以确认移除。',
  'This profile still has saved tunnel registrations. Clear those registrations before removing it.': '此配置仍有已保存的隧道注册。请先清除这些注册再移除。',
  'This profile still has a connector API key. Clear its connector setup before removing it.': '此配置仍有连接器 API 密钥。请先清除连接器设置再移除。',
  'This profile is still paired with a browser companion. Disconnect that pairing before removing it.': '此配置仍与浏览器配套扩展保持配对。请先断开配对再移除。',
  'This profile already owns local sessions, queues, logs, or diagnostics. Disable it and keep it instead of deleting its history.': '此配置已拥有本地会话、队列、日志或诊断数据。请停用并保留它，而不是删除其历史记录。',
  'This profile belongs to another physical device and cannot open a browser here.': '此配置属于另一台实体设备，无法在此处打开浏览器。',
  'Choose an explicit Chrome/Chromium profile directory first.': '请先明确选择 Chrome/Chromium 配置目录。',
  'Enable this account profile before switching to it.': '请先启用此账户配置，再切换到它。',
  'This profile belongs to another physical device. Rebind a portable profile on this device instead.': '此配置属于另一台实体设备。请改为在此设备上重新绑定可移植配置。',
  'Choose an explicit Chrome/Chromium profile directory before activating this account.': '激活此账户前，请明确选择 Chrome/Chromium 配置目录。',
  'Switch queued until this profile reaches verified idle.': '已安排切换；将在此配置确认空闲后执行。',
  'That profile is already active.': '该配置已经处于活动状态。',
  'Profile switch is ready; the app is reconnecting under the selected profile.': '配置切换已就绪；应用正在使用所选配置重新连接。',
  'Another profile lifecycle transition is already active': '已有另一个配置生命周期切换正在进行',
  'No profile lifecycle Drain is active': '当前没有活动的配置排空操作',
  'Profile lifecycle Drain can no longer be cancelled after finalization starts': '配置排空进入最终处理后无法再取消',
  'Profile lifecycle Drain lost its work-admission ownership': '配置排空已失去工作准入控制权'
};

export const catalog: Readonly<Record<string, string>> = Object.freeze({ ...zhCN, ...accountZhCN });
let language: Language = 'en';
try { if (window.localStorage.getItem(STORAGE_KEY) === 'zh-CN') language = 'zh-CN'; } catch { /* Storage may be unavailable in a restricted renderer. */ }

export function currentLanguage(): Language { return language; }

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const key = Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const translated = language === 'zh-CN' && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();

function read(node: Node, property: Property): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}
function write(node: Node, property: Property, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

/** Bind the existing node, never reconstruct controls, drafts, icons or chat history. */
export function ui<T extends Node>(node: T, property: Property, value: () => string): T {
  let properties = bindings.get(node);
  if (!properties) {
    bindings.set(node, properties = new Map());
  }
  const last = value();
  properties.set(property, { read: value, last });
  write(node, property, last);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

export function setLanguage(next: Language): void {
  language = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The current window can still change language. */ }
  document.documentElement.lang = next;
  syncLanguageControls();
  // The document owns the live labels, including hidden settings and collapsed
  // history. Do not index every label ever created: sweeping WeakRefs during
  // rendering keeps their detached DOM trees alive until the job ends and makes
  // each repaint revisit accumulated history. Bindings alone do not retain nodes.
  const walker = document.createTreeWalker(document.body, 1 | 4 /* elements + text */);
  do {
    const node = walker.currentNode;
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  } while (walker.nextNode());
}

/** Setup and settings project the same saved preference. */
function syncLanguageControls(): void {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select) select.value = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
}

/** Run once on the static shell, before any user/provider content is inserted. */
export function initLanguage(): void {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (Object.hasOwn(catalog, key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && Object.hasOwn(catalog, source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  syncLanguageControls();
  select.addEventListener('change', () => setLanguage(select.value === 'zh-CN' ? 'zh-CN' : 'en'));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.addEventListener('click', () => setLanguage(button.dataset.language === 'zh-CN' ? 'zh-CN' : 'en'));
  }
}
