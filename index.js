const MODULE_ID = 'st-persona-wardrobe';
const EXTENSION_FOLDER = 'third-party/st-persona-wardrobe';

const LEGACY_PRESET_GROUPS = new Set([
  '现代都市',
  '西幻奇幻',
  '赛博科幻',
  '古风仙侠',
  '无限流/规则',
  '古风',
  '现代',
  '西幻',
  '科幻',
  '无限流',
]);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  enhanceNativePersonaPanel: true,
  showTopbarButton: false,
  showWandButton: true,
  autoSwitchOnCharacterChat: true,
  scanDepth: 5,
  groups: [],
  profiles: {},
  avatarUrlCache: {},
});

const state = {
  initialized: false,
  disposers: [],
  activeFilter: 'all', // 'all' | 'global' | 'dedicated' | 'chatted' | 'fav' | 'char:<charKey>' | 'group:<groupName>' | 'ungrouped'
  collapsedSections: new Set(),
  batchAssignTarget: null, // null | { type: 'character', key: string, name: string } | { type: 'group', name: string }
  searchQuery: '',
  selectedAvatarId: null,
  multiSelectMode: false,
  multiSelectedIds: new Set(),
  lastMultiClickedAvatarId: '',
  expandedTraitIdx: null,
  showStatsDetail: false,
  isScanningHistory: false,
  scanProgressText: '',
  hasCompletedAutoStatsScan: false,
  autoStatsScanTimerId: null,
  cachedHostCharacters: [],
  lastUserInteractionAt: Date.now(),
  useRawNativeLeftList: false,
  diskAvatarSet: null,
  diskAvatarFetched: false,
  personaThumbnailUnsupported: false,
  avatarCacheBust: new Map(),
  resolvedExternalAvatars: new Map(),
  whitePlaceholderIds: new Set(),
  isHarvestingAvatars: false,
  hasCompletedFullHarvestThisSession: false,
  harvestTimerId: null,
  avatarCacheSaveTimer: null,
  _probeCanvas: null,
  lastLeftRenderedHtml: '',
  lastRightRenderedHtml: '',
  lastModalRenderedHtml: '',
  savedInlineListScrollTop: 0,
  savedModalListScrollTop: 0,
  savedModalDetailScrollTop: 0,
  lastUsageDirty: false,
  lastExcludedOrphanCount: 0,
  lastMergedDuplicateCount: 0,
  worldbookCache: new Map(),
  lastPromptInjectedSummary: [],
  minimizedReturnPill: null,
  hostPersonasModule: null,
  hostWorldInfoModule: null,
  hostPopupModule: null,
};

function isTauriTavernHost() {
  return Boolean(
    globalThis.__TAURITAVERN__ ||
      globalThis.__TAURITAVERN_MAIN_READY__ ||
      globalThis.__TAURI_RUNNING__ ||
      globalThis.__TAURI__
  );
}

async function waitForTauriTavernReady() {
  const readyCandidate =
    globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
  if (readyCandidate && typeof readyCandidate.then === 'function') {
    try {
      await Promise.race([
        readyCandidate,
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch (err) {
      console.warn(`[${MODULE_ID}] 等待 TauriTavern 就绪返回告警:`, err);
    }
  }
}

function invalidateRenderedHtmlCache() {
  state.lastLeftRenderedHtml = '';
  state.lastRightRenderedHtml = '';
  state.lastModalRenderedHtml = '';
}

async function refreshDiskAvatarSet() {
  try {
    const context = getContext();
    const rawHeaders =
      typeof context.getRequestHeaders === 'function'
        ? { ...context.getRequestHeaders({ omitContentType: true }) }
        : {};
    delete rawHeaders['Content-Type'];
    delete rawHeaders['content-type'];

    const response = await fetch('/api/avatars/get', {
      method: 'POST',
      headers: rawHeaders,
    });
    if (response.ok) {
      const list = await response.json();
      if (Array.isArray(list)) {
        state.diskAvatarSet = new Set(
          list.map((x) => String(x || '').trim()).filter(Boolean)
        );
        state.diskAvatarFetched = true;
        return state.diskAvatarSet;
      }
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] 读取 /api/avatars/get 跳过:`, err);
  }
  return state.diskAvatarSet;
}

function getContext() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) {
    throw new Error(`[${MODULE_ID}] SillyTavern.getContext() 不可用`);
  }
  return context;
}

async function probeHostModules() {
  if (!state.hostPersonasModule) {
    try {
      state.hostPersonasModule = await import('../../../personas.js');
    } catch (_e) {
      try {
        state.hostPersonasModule = await import('/scripts/personas.js');
      } catch (_e2) {}
    }
  }
  if (!state.hostWorldInfoModule) {
    try {
      state.hostWorldInfoModule = await import('../../../world-info.js');
    } catch (_e) {
      try {
        state.hostWorldInfoModule = await import('/scripts/world-info.js');
      } catch (_e2) {}
    }
  }
  if (!state.hostPopupModule) {
    try {
      state.hostPopupModule = await import('../../../popup.js');
    } catch (_e) {
      try {
        state.hostPopupModule = await import('/scripts/popup.js');
      } catch (_e2) {}
    }
  }
}

function sanitizeHtml(raw) {
  const purify = globalThis.SillyTavern?.libs?.DOMPurify;
  if (purify?.sanitize) {
    return purify.sanitize(String(raw ?? ''));
  }
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(val) {
  return String(val ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function hasOpenHostPopupDialog() {
  if (document.querySelector('dialog[open]:not([closing])')) {
    return true;
  }
  const legacyPopup = document.querySelector('#dialogue_popup');
  if (legacyPopup && isElementVisible(legacyPopup)) {
    return true;
  }
  return false;
}

/**
 * 跨宿主异步文本输入弹窗（适配 TauriTavern Android/iOS/HarmonyOS 原生 WebView 禁用同步 window.prompt 的情况）
 */
async function promptUserText(
  title,
  defaultValue = '',
  { subtitle = '', placeholder = '' } = {}
) {
  const safeTitle = escapeAttr(title || '');
  const safeSubtitle = subtitle ? escapeAttr(subtitle) : null;
  const initVal = String(defaultValue ?? '');

  try {
    const context = getContext();
    const PopupClass = context.Popup || state.hostPopupModule?.Popup;
    if (typeof PopupClass?.show?.input === 'function') {
      const val = await PopupClass.show.input(safeTitle, safeSubtitle, initVal, {
        placeholder,
        rows: 1,
      });
      return val === null || val === undefined ? null : String(val);
    }
    const callPopupFn =
      context.callGenericPopup || state.hostPopupModule?.callGenericPopup;
    const inputType =
      context.POPUP_TYPE?.INPUT ?? state.hostPopupModule?.POPUP_TYPE?.INPUT ?? 2;
    if (typeof callPopupFn === 'function') {
      const html = safeSubtitle ? `<h3>${safeTitle}</h3><div>${safeSubtitle}</div>` : safeTitle;
      const val = await callPopupFn(html, inputType, initVal, { placeholder, rows: 1 });
      if (val === false || val === null || val === undefined) return null;
      return String(val);
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] Popup.show.input 降级:`, err);
  }

  if (!isTauriTavernHost() && typeof window.prompt === 'function') {
    return window.prompt(subtitle ? `${title}\n${subtitle}` : title, initVal);
  }
  return null;
}

/**
 * 跨宿主异步确认弹窗（适配 TauriTavern 原生 WebView 禁用同步 window.confirm 的情况）
 */
async function confirmUserAction(title, message = '') {
  const safeTitle = escapeAttr(title || '');
  const safeMessage = message ? escapeAttr(message) : null;

  try {
    const context = getContext();
    const PopupClass = context.Popup || state.hostPopupModule?.Popup;
    if (typeof PopupClass?.show?.confirm === 'function') {
      const res = await PopupClass.show.confirm(
        safeTitle,
        safeMessage
      );
      return Boolean(res);
    }
    const callPopupFn =
      context.callGenericPopup || state.hostPopupModule?.callGenericPopup;
    const confirmType =
      context.POPUP_TYPE?.CONFIRM ?? state.hostPopupModule?.POPUP_TYPE?.CONFIRM ?? 1;
    if (typeof callPopupFn === 'function') {
      const html = safeMessage ? `<h3>${safeTitle}</h3><div>${safeMessage}</div>` : safeTitle;
      const res = await callPopupFn(html, confirmType);
      return Boolean(res);
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] Popup.show.confirm 降级:`, err);
  }

  if (!isTauriTavernHost() && typeof window.confirm === 'function') {
    return window.confirm(message ? `${title}\n${message}` : title);
  }
  return false;
}

function getSettings() {
  const context = getContext();
  if (!context.extensionSettings[MODULE_ID]) {
    context.extensionSettings[MODULE_ID] = structuredClone(DEFAULT_SETTINGS);
  }
  const store = context.extensionSettings[MODULE_ID];
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(store, key) || store[key] === undefined) {
      store[key] = structuredClone(defaultValue);
    }
  }
  if (!Array.isArray(store.groups)) {
    store.groups = [];
  }
  if (!store.profiles || typeof store.profiles !== 'object') {
    store.profiles = {};
  }
  if (!store.avatarUrlCache || typeof store.avatarUrlCache !== 'object') {
    store.avatarUrlCache = {};
  } else {
    for (const [k, v] of Object.entries(store.avatarUrlCache)) {
      if (isTinyPlaceholderDataUri(v)) {
        delete store.avatarUrlCache[k];
      }
    }
  }

  // 自动清理早期版本遗留且没有任何人设使用的空预设分组
  if (!store._cleanedLegacyPresetGroups) {
    const usedGroups = new Set(
      Object.values(store.profiles)
        .map((p) => p?.group)
        .filter(Boolean)
    );
    store.groups = store.groups.filter(
      (g) => !LEGACY_PRESET_GROUPS.has(g) || usedGroups.has(g)
    );
    store._cleanedLegacyPresetGroups = true;
  }

  // 已原位接管酒馆顶栏原生人设栏目 (#PersonaManagement)，默认关闭顶栏多余的第二个图标
  if (!store._migratedHideRedundantTopbar) {
    store.showTopbarButton = false;
    store._migratedHideRedundantTopbar = true;
  }

  return store;
}

function saveSettings() {
  try {
    const context = getContext();
    context.saveSettingsDebounced?.();
  } catch (err) {
    console.warn(`[${MODULE_ID}] saveSettingsDebounced 失败:`, err);
  }
}

function ensureProfileMeta(avatarId) {
  const settings = getSettings();
  if (!settings.profiles[avatarId]) {
    settings.profiles[avatarId] = {
      favorite: false,
      group: '',
      tags: [],
      boundCharacters: [],
      note: '',
      extraWorldbooks: [],
      traits: [],
      presets: [],
      activePresetId: '',
      usageStats: {
        chats: {},
        extraLiveMs: 0,
      },
    };
  }
  const profile = settings.profiles[avatarId];
  if (typeof profile.favorite !== 'boolean') profile.favorite = false;
  if (typeof profile.group !== 'string') profile.group = '';
  if (!Array.isArray(profile.tags)) profile.tags = [];
  if (!Array.isArray(profile.boundCharacters)) profile.boundCharacters = [];
  if (typeof profile.note !== 'string') profile.note = '';
  if (!Array.isArray(profile.extraWorldbooks)) profile.extraWorldbooks = [];
  if (!Array.isArray(profile.traits)) profile.traits = [];
  if (!Array.isArray(profile.presets)) profile.presets = [];
  if (typeof profile.activePresetId !== 'string') profile.activePresetId = '';
  if (!profile.usageStats || typeof profile.usageStats !== 'object') {
    profile.usageStats = { chats: {}, extraLiveMs: 0 };
  }
  if (!profile.usageStats.chats || typeof profile.usageStats.chats !== 'object') {
    profile.usageStats.chats = {};
  }
  if (typeof profile.usageStats.extraLiveMs !== 'number') {
    profile.usageStats.extraLiveMs = 0;
  }
  return profile;
}

function formatDurationShort(ms) {
  const val = Math.max(0, Number(ms) || 0);
  if (val <= 0) return '0分';
  if (val < 60_000) return '<1分';
  if (val < 3600_000) return `${Math.round(val / 60_000)}分`;
  const hours = (val / 3600_000).toFixed(1).replace(/\.0$/, '');
  return `${hours}h`;
}

function formatDurationHuman(ms) {
  const val = Math.max(0, Number(ms) || 0);
  if (val <= 0) return '0 分';
  if (val < 60_000) return `${Math.max(1, Math.round(val / 1000))} 秒`;
  const totalMins = Math.floor(val / 60_000);
  if (totalMins < 60) {
    const secs = Math.round((val % 60_000) / 1000);
    return secs > 0 ? `${totalMins} 分 ${secs} 秒` : `${totalMins} 分钟`;
  }
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
}

function getPersonaUsageSummary(avatarId) {
  const meta = ensureProfileMeta(avatarId);
  const chatRecords = Object.values(meta.usageStats?.chats || {}).filter(
    (c) => c && typeof c === 'object' && c.charName
  );
  const charMap = new Map();
  let totalChatCount = 0;
  let totalUserMsgs = 0;
  let totalAiMsgs = 0;
  let totalDurationMs = Math.max(0, Number(meta.usageStats?.extraLiveMs) || 0);
  let lastChatAt = 0;

  for (const rec of chatRecords) {
    totalChatCount++;
    const uMsgs = Math.max(0, Number(rec.userMsgs) || 0);
    const aMsgs = Math.max(0, Number(rec.aiMsgs) || 0);
    const dur = Math.max(0, Number(rec.durationMs) || 0);
    const ts = Math.max(0, Number(rec.lastChatAt) || 0);
    totalUserMsgs += uMsgs;
    totalAiMsgs += aMsgs;
    totalDurationMs += dur;
    if (ts > lastChatAt) lastChatAt = ts;

    const cKey = String(rec.charName).trim().toLowerCase();
    if (!charMap.has(cKey)) {
      charMap.set(cKey, {
        charName: rec.charName,
        charAvatar: rec.charAvatar || '',
        chatCount: 0,
        userMsgs: 0,
        aiMsgs: 0,
        durationMs: 0,
        lastChatAt: 0,
      });
    }
    const bucket = charMap.get(cKey);
    bucket.chatCount++;
    bucket.userMsgs += uMsgs;
    bucket.aiMsgs += aMsgs;
    bucket.durationMs += dur;
    if (ts > bucket.lastChatAt) bucket.lastChatAt = ts;
  }

  const byCharacter = [...charMap.values()].sort(
    (a, b) => b.durationMs - a.durationMs || b.chatCount - a.chatCount
  );

  return {
    charCount: byCharacter.length,
    chatCount: totalChatCount,
    userMsgs: totalUserMsgs,
    aiMsgs: totalAiMsgs,
    totalMsgs: totalUserMsgs + totalAiMsgs,
    durationMs: totalDurationMs,
    lastChatAt,
    byCharacter,
  };
}

const IGNORED_HEADER_USER_NAMES = new Set([
  '',
  'unused',
  'system',
  'assistant',
  '{{user}}',
  '<user>',
]);

function parseStTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e11 ? Math.round(raw * 1000) : raw;
  }
  const str = String(raw).trim();
  if (!str) return 0;

  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str);
    if (Number.isFinite(num) && num > 0) {
      return num < 1e11 ? num * 1000 : num;
    }
  }

  const direct = Date.parse(str);
  if (Number.isFinite(direct) && direct > 0) return direct;

  // 兼容经典酒馆无空格 am/pm 格式，如 "November 26, 2026 1:45pm"
  const normalizedAmPm = str.replace(/(\d)(am|pm)\b/i, '$1 $2');
  if (normalizedAmPm !== str) {
    const parsedAmPm = Date.parse(normalizedAmPm);
    if (Number.isFinite(parsedAmPm) && parsedAmPm > 0) return parsedAmPm;
  }

  // 兼容酒馆与 TauriTavern humanizedDateTime 格式 "2026-11-25 @15h 30m 12s 123ms" / "2026-11-25@15h30m12s123ms"
  const m = str.match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*@?\s*(\d{1,2})h\s*(\d{1,2})m(?:\s*(\d{1,2})s)?/i
  );
  if (m) {
    const dt = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    );
    return dt.getTime();
  }

  // 兼容中文日期格式 "2026年11月26日 13:45(:12)"
  const zh = str.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/
  );
  if (zh) {
    const dt = new Date(
      Number(zh[1]),
      Number(zh[2]) - 1,
      Number(zh[3]),
      Number(zh[4]),
      Number(zh[5]),
      Number(zh[6] || 0)
    );
    return dt.getTime();
  }

  return 0;
}

function normalizeAvatarStem(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  const slashIdx = s.lastIndexOf('/');
  if (slashIdx !== -1) s = s.slice(slashIdx + 1);
  const qIdx = s.indexOf('?');
  if (qIdx !== -1) s = s.slice(0, qIdx);
  const hIdx = s.indexOf('#');
  if (hIdx !== -1) s = s.slice(0, hIdx);
  return s.trim();
}

/**
 * 从消息的 force_avatar 提取真实的 User 头像文件名：
 * 兼容：
 * 1) TauriTavern / 新版 ST: "/thumbnail?type=persona&file=xxx.png"（含 URLSearchParams 的 + 空格编码）
 * 2) 标准 ST / Luker: "User Avatars/xxx.png" 或 "/User%20Avatars/xxx.png?t=..."
 * 3) 直接文件名: "xxx.png"
 */
function extractAvatarIdFromForceAvatar(forceAvatarRaw) {
  if (!forceAvatarRaw || typeof forceAvatarRaw === 'boolean') return '';
  const rawStr = String(forceAvatarRaw).trim();
  if (!rawStr) return '';
  const lowerRaw = rawStr.toLowerCase();
  if (
    lowerRaw === 'false' ||
    lowerRaw === 'true' ||
    lowerRaw === 'null' ||
    lowerRaw === 'undefined' ||
    lowerRaw === 'unused'
  ) {
    return '';
  }

  // 1) 优先解析带查询参数的缩略图地址（如 /thumbnail?type=persona&file=My+Persona.png）
  if (rawStr.includes('?')) {
    try {
      const parsed = new URL(
        rawStr,
        globalThis.location?.origin && globalThis.location.origin !== 'null'
          ? globalThis.location.origin
          : 'http://127.0.0.1/'
      );
      const fileParam =
        parsed.searchParams.get('file') ||
        parsed.searchParams.get('avatar') ||
        '';
      if (fileParam.trim()) {
        return normalizeAvatarStem(fileParam);
      }
    } catch (_e) {}
  }

  // 2) 常规路径提取（如 User Avatars/xxx.png）
  let decoded = rawStr;
  try {
    decoded = decodeURIComponent(rawStr);
  } catch (_e) {}
  const candidate = normalizeAvatarStem(decoded);
  if (!candidate || candidate.toLowerCase() === 'thumbnail') {
    return '';
  }
  return candidate;
}

function matchPersonaAvatarId(candidateRaw, personaByAvatar, personaByLowerId, personaByStemLower) {
  const extracted =
    extractAvatarIdFromForceAvatar(candidateRaw) || normalizeAvatarStem(candidateRaw);
  if (!extracted) return '';
  if (personaByAvatar.has(extracted)) return extracted;
  const lower = extracted.toLowerCase();
  if (personaByLowerId.has(lower)) return personaByLowerId.get(lower);
  const stem = lower.replace(/\.(png|webp|jpg|jpeg|gif|avif)$/i, '');
  if (stem && personaByStemLower.has(stem)) return personaByStemLower.get(stem);
  return '';
}

/**
 * 分析单个聊天档的消息数组，计算该聊天档关联到了哪些 User 以及各自的互动时长、消息数
 */
function attributeChatMessagesToPersonas({
  charName,
  charAvatar,
  chatId,
  headerObj,
  messages,
  allPersonas,
  fallbackAvatarId = '',
  unattributedUserFallbackId = '',
}) {
  if (!charName || !chatId || !Array.isArray(messages) || messages.length === 0) {
    return false;
  }

  const personaByAvatar = new Map(allPersonas.map((p) => [p.avatarId, p]));
  const personaByLowerId = new Map(
    allPersonas.map((p) => [p.avatarId.toLowerCase(), p.avatarId])
  );
  const personaByStemLower = new Map();
  for (const p of allPersonas) {
    const stem = p.avatarId.toLowerCase().replace(/\.(png|webp|jpg|jpeg|gif|avif)$/i, '');
    if (stem && !personaByStemLower.has(stem)) {
      personaByStemLower.set(stem, p.avatarId);
    }
  }

  const resolveAvatarRef = (ref) =>
    matchPersonaAvatarId(ref, personaByAvatar, personaByLowerId, personaByStemLower);

  const resolveByNameAndChar = (uName) => {
    const clean = String(uName || '').trim().toLowerCase();
    if (!clean || IGNORED_HEADER_USER_NAMES.has(clean)) return null;
    let candidates = allPersonas.filter((p) => p.name.trim().toLowerCase() === clean);
    if (candidates.length === 0) {
      candidates = allPersonas.filter(
        (p) => p.title && p.title.trim().toLowerCase() === clean
      );
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].avatarId;
    // 如果同名有多个 User，优先归属给绑定了该角色卡的那个 User
    const boundHit = candidates.find((p) =>
      p.meta.boundCharacters.some((c) => c.toLowerCase() === charName.toLowerCase())
    );
    return (boundHit || candidates[0]).avatarId;
  };

  const validFallbackId = resolveAvatarRef(fallbackAvatarId);
  const validUnattributedUserFallbackId = resolveAvatarRef(unattributedUserFallbackId);

  // 先看 chat_metadata 或 header 里的显式绑定（过滤 TauriTavern 固定写入的 user_name: "unused"）
  const chatMeta = headerObj?.chat_metadata || {};
  let chatLevelAvatarId = '';
  const trackedLukerAvatar = resolveAvatarRef(chatMeta?.luker_last_user_persona?.avatar);
  const lockedChatAvatar = resolveAvatarRef(
    chatMeta?.persona || chatMeta?.user_avatar || chatMeta?.tainted_persona
  );
  if (trackedLukerAvatar) {
    chatLevelAvatarId = trackedLukerAvatar;
  } else if (lockedChatAvatar) {
    chatLevelAvatarId = lockedChatAvatar;
  } else if (chatMeta?.luker_last_user_persona?.name) {
    chatLevelAvatarId = resolveByNameAndChar(chatMeta.luker_last_user_persona.name) || '';
  } else if (
    headerObj?.user_name &&
    !IGNORED_HEADER_USER_NAMES.has(String(headerObj.user_name).trim().toLowerCase())
  ) {
    chatLevelAvatarId = resolveByNameAndChar(headerObj.user_name) || '';
  }

  // 统计消息时间戳与生成耗时，并按消息识别参与的 User
  const timestamps = [];
  let totalGenMs = 0;
  let totalUserMsgs = 0;
  let totalAiMsgs = 0;
  let lastChatAt = 0;
  const userHitsCount = new Map(); // avatarId -> userMsgCount

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.is_system) continue;

    const ts = parseStTimestamp(msg.send_date ?? msg.timestamp ?? msg.date);
    if (ts > 0) {
      timestamps.push(ts);
      if (ts > lastChatAt) lastChatAt = ts;
    }

    const genStart = parseStTimestamp(msg.gen_started ?? msg.extra?.gen_started);
    const genEnd = parseStTimestamp(msg.gen_finished ?? msg.extra?.gen_finished);
    if (genStart > 0 && genEnd > genStart && genEnd - genStart < 600_000) {
      totalGenMs += genEnd - genStart;
    }

    if (msg.is_user) {
      totalUserMsgs++;
      let msgAvatarId =
        resolveAvatarRef(msg.force_avatar) ||
        resolveAvatarRef(msg.extra?.persona || msg.persona);
      if (!msgAvatarId && msg.name) {
        msgAvatarId = resolveByNameAndChar(msg.name) || '';
      }
      if (!msgAvatarId) {
        msgAvatarId = chatLevelAvatarId || validFallbackId;
      }
      // 对于真实发生过用户发言的聊天，若该消息为默认 User（如未注册进 power_user.personas 时的 user-default.png）或历史改名消息，兜底归属给默认/当前人设
      if (!msgAvatarId) {
        if (
          String(msg.name || '').trim().toLowerCase() === 'user' &&
          personaByAvatar.has('user-default.png')
        ) {
          msgAvatarId = 'user-default.png';
        } else if (validUnattributedUserFallbackId) {
          msgAvatarId = validUnattributedUserFallbackId;
        }
      }
      if (msgAvatarId && personaByAvatar.has(msgAvatarId)) {
        userHitsCount.set(msgAvatarId, (userHitsCount.get(msgAvatarId) || 0) + 1);
      }
    } else {
      totalAiMsgs++;
    }
  }

  // 如果该档还没有用户发言（例如只有开场白），仅在显式锁卡/绑卡时归属，不把未聊过的新卡开场白误算进默认人设
  if (userHitsCount.size === 0) {
    const targetId = chatLevelAvatarId || validFallbackId;
    if (targetId && personaByAvatar.has(targetId) && (totalUserMsgs > 0 || totalAiMsgs > 0)) {
      userHitsCount.set(targetId, totalUserMsgs);
    }
  }

  if (userHitsCount.size === 0) return false;

  // 计算该聊天档的活跃互动时长（相邻消息间隔 <= 10分钟全额计入，> 10分钟按单轮 90秒封顶，避免挂机虚高）
  timestamps.sort((a, b) => a - b);
  let intervalDurationMs = 0;
  if (timestamps.length >= 2) {
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap > 0) {
        intervalDurationMs += gap <= 10 * 60_000 ? gap : 90_000;
      }
    }
    intervalDurationMs += 45_000;
  } else if (totalUserMsgs > 0 || totalAiMsgs > 0) {
    intervalDurationMs = totalUserMsgs * 60_000 + totalAiMsgs * 20_000;
  }

  const estimatedTotalMs = Math.max(intervalDurationMs, totalGenMs);
  const totalAttributedUserMsgs = Math.max(
    1,
    [...userHitsCount.values()].reduce((acc, v) => acc + v, 0)
  );
  const chatRecordKey = `${charAvatar || charName}::${chatId}`;

  let anyChanged = false;
  for (const [avatarId, uCount] of userHitsCount.entries()) {
    const share = userHitsCount.size === 1 ? 1 : Math.max(0.1, uCount / totalAttributedUserMsgs);
    const meta = ensureProfileMeta(avatarId);
    const prev = meta.usageStats.chats[chatRecordKey];
    const computedDur = Math.round(estimatedTotalMs * share);
    const nextAiMsgs = Math.round(totalAiMsgs * share);
    const nextDur = Math.max(prev?.durationMs || 0, computedDur);
    const nextLastChatAt = lastChatAt || prev?.lastChatAt || Date.now();

    if (
      !prev ||
      prev.userMsgs !== uCount ||
      prev.aiMsgs !== nextAiMsgs ||
      nextDur - (prev.durationMs || 0) >= 30_000 ||
      prev.charName !== charName
    ) {
      anyChanged = true;
    }

    meta.usageStats.chats[chatRecordKey] = {
      charName,
      charAvatar: charAvatar || '',
      chatId,
      userMsgs: uCount,
      aiMsgs: nextAiMsgs,
      durationMs: nextDur,
      lastChatAt: nextLastChatAt,
    };
  }

  return anyChanged;
}

function normalizeChatPayloadLines(rawPayload) {
  if (Array.isArray(rawPayload)) return rawPayload;
  if (rawPayload && typeof rawPayload === 'object') {
    if (Array.isArray(rawPayload.messages)) return rawPayload.messages;
    if (Array.isArray(rawPayload.chat)) return rawPayload.chat;
  }
  return [];
}

/**
 * 实时记录当前打开聊天窗口（单人角色卡 & 群聊）的使用统计
 */
function recordCurrentOpenChatStats() {
  try {
    const context = getContext();
    const chatMessages = Array.isArray(context.chat) ? context.chat : [];
    if (chatMessages.length === 0) return;

    let targetName = '';
    let targetAvatar = '';
    let chatId = '';

    if (context.groupId) {
      const hostGroups = Array.isArray(context.groups) ? context.groups : [];
      const activeGroup = hostGroups.find((g) => String(g?.id) === String(context.groupId));
      if (!activeGroup) return;
      const gName = String(activeGroup.name || activeGroup.id || '').trim();
      if (!gName) return;
      targetName = `${gName} (群聊)`;
      targetAvatar = String(activeGroup.avatar_url || `group:${activeGroup.id}`).trim();
      chatId = String(
        activeGroup.chat_id ||
          context.chatId ||
          (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '') ||
          ''
      )
        .replace(/\.jsonl$/i, '')
        .trim();
    } else {
      const currentChar = getCurrentCharacter();
      if (!currentChar?.name) return;
      const rawChars = Array.isArray(context.characters) ? context.characters : [];
      const rawChar = rawChars[currentChar.index];
      targetName = currentChar.name;
      targetAvatar = currentChar.avatar;
      chatId = String(
        context.chatId ||
          rawChar?.chat ||
          (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '') ||
          ''
      )
        .replace(/\.jsonl$/i, '')
        .trim();
    }

    if (!chatId) return;

    const allPersonas = getHostPersonas();
    if (allPersonas.length === 0) return;
    const activeId = getActiveAvatarId();
    const pu = context.powerUserSettings || globalThis.power_user || {};
    const defaultFallback = activeId || pu.default_persona || allPersonas[0]?.avatarId || '';

    const updated = attributeChatMessagesToPersonas({
      charName: targetName,
      charAvatar: targetAvatar,
      chatId,
      headerObj: {
        user_name: context.name1,
        chat_metadata: context.chatMetadata || globalThis.chat_metadata || {},
      },
      messages: chatMessages,
      allPersonas,
      fallbackAvatarId: activeId,
      unattributedUserFallbackId: defaultFallback,
    });

    if (updated) {
      invalidateRenderedHtmlCache();
      saveSettings();
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] 记录当前聊天统计跳过:`, err);
  }
}

/**
 * 一键扫描酒馆内所有角色卡与群聊的历史聊天档，回溯每个 User 聊过几个角色卡、几个聊天档、聊了多久
 */
async function scanAllHistoricalChatsForStats({ silent = false } = {}) {
  if (state.isScanningHistory) return;
  state.isScanningHistory = true;
  if (!silent) {
    state.scanProgressText = '准备扫描…';
    invalidateRenderedHtmlCache();
    refreshAllViews();
  }

  try {
    await refreshDiskAvatarSet();
    const context = getContext();
    const headers =
      typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    let rawChars = Array.isArray(context.characters) ? context.characters : [];
    if (rawChars.length > 0) {
      state.cachedHostCharacters = rawChars;
    } else {
      try {
        const allCharsRes = await fetch('/api/characters/all', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
        if (allCharsRes.ok) {
          const fetchedChars = await allCharsRes.json();
          if (Array.isArray(fetchedChars) && fetchedChars.length > 0) {
            rawChars = fetchedChars;
            state.cachedHostCharacters = fetchedChars;
          }
        }
      } catch (_e) {}
    }

    const hostGroups = Array.isArray(context.groups) ? context.groups : [];
    const allPersonas = getHostPersonas();
    const pu = context.powerUserSettings || globalThis.power_user || {};
    const activeId = getActiveAvatarId();
    const globalUserMsgFallbackId =
      pu.default_persona ||
      activeId ||
      (allPersonas.length === 1 ? allPersonas[0].avatarId : '');

    let scannedChars = 0;
    let scannedChatFiles = 0;

    // 1) 扫描全部单人角色卡聊天档
    for (let i = 0; i < rawChars.length; i++) {
      const rawChar = rawChars[i];
      const charName = String(rawChar?.name || '').trim();
      const charAvatar = String(rawChar?.avatar || '').trim();
      if (!charName || !charAvatar) continue;

      if (!silent) {
        state.scanProgressText = `扫描中 (${i + 1}/${rawChars.length})：${charName}`;
        syncNativePersonaPanelEnhancement({ forceRight: true });
      }

      let chatList = [];
      try {
        const listRes = await fetch('/api/characters/chats', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            avatar_url: charAvatar,
            ch_name: charName,
            metadata: true,
          }),
        });
        if (listRes.ok) {
          const data = await listRes.json();
          chatList = Array.isArray(data) ? data : Object.values(data || {});
        }
      } catch (_e) {}

      if (!Array.isArray(chatList) || chatList.length === 0) continue;
      let charHadValidChat = false;

      // 如果该角色卡在 Luker、原生连线或本插件下只绑定了唯一一个专属 User，可作为该角色卡历史聊天档的默认归属兜底
      const charDedicatedPersonas = allPersonas.filter((p) =>
        p.meta.boundCharacters.some((c) => c.toLowerCase() === charName.toLowerCase())
      );
      const charDefaultAvatarId =
        charDedicatedPersonas.length === 1 ? charDedicatedPersonas[0].avatarId : '';

      for (const chatInfo of chatList) {
        const rawFileName = String(chatInfo?.file_name || chatInfo?.file_id || '').trim();
        if (!rawFileName) continue;
        const fileId = rawFileName.replace(/\.jsonl$/i, '');

        try {
          const chatRes = await fetch('/api/chats/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ch_name: charName,
              file_name: fileId,
              avatar_url: charAvatar,
              allow_not_found: true,
            }),
          });
          if (!chatRes.ok) continue;
          const lines = normalizeChatPayloadLines(await chatRes.json());
          if (!Array.isArray(lines) || lines.length === 0) continue;

          const firstLine = lines[0];
          const hasHeader =
            firstLine &&
            typeof firstLine === 'object' &&
            !Object.hasOwn(firstLine, 'mes') &&
            (Object.hasOwn(firstLine, 'user_name') || Object.hasOwn(firstLine, 'chat_metadata'));
          const headerObj = hasHeader
            ? {
                ...firstLine,
                chat_metadata: {
                  ...(chatInfo?.chat_metadata || {}),
                  ...(firstLine.chat_metadata || {}),
                },
              }
            : { chat_metadata: chatInfo?.chat_metadata || {} };
          const msgLines = hasHeader ? lines.slice(1) : lines;

          if (msgLines.length === 0) continue;

          const hit = attributeChatMessagesToPersonas({
            charName,
            charAvatar,
            chatId: fileId,
            headerObj,
            messages: msgLines,
            allPersonas,
            fallbackAvatarId: charDefaultAvatarId,
            unattributedUserFallbackId: charDefaultAvatarId || globalUserMsgFallbackId,
          });
          if (hit) {
            scannedChatFiles++;
            charHadValidChat = true;
          }
        } catch (_e) {}
      }

      if (charHadValidChat) {
        scannedChars++;
      }
    }

    // 2) 扫描全部群聊历史聊天档 (/api/chats/group/get)
    for (let gIdx = 0; gIdx < hostGroups.length; gIdx++) {
      const group = hostGroups[gIdx];
      const rawGroupName = String(group?.name || group?.id || '').trim();
      if (!rawGroupName) continue;
      const groupDisplayName = `${rawGroupName} (群聊)`;
      const groupAvatarKey = String(group?.avatar_url || `group:${group.id}`).trim();

      const groupChatIds = new Set();
      if (group?.chat_id) {
        groupChatIds.add(String(group.chat_id).replace(/\.jsonl$/i, '').trim());
      }
      if (Array.isArray(group?.chats)) {
        for (const cid of group.chats) {
          const cleanCid = String(cid || '').replace(/\.jsonl$/i, '').trim();
          if (cleanCid) groupChatIds.add(cleanCid);
        }
      }
      if (groupChatIds.size === 0) continue;

      const groupDedicatedPersonas = allPersonas.filter((p) =>
        p.meta.boundCharacters.some((c) => c.toLowerCase() === rawGroupName.toLowerCase())
      );
      const groupDefaultAvatarId =
        groupDedicatedPersonas.length === 1 ? groupDedicatedPersonas[0].avatarId : '';

      let groupHadValidChat = false;
      for (const gChatId of groupChatIds) {
        try {
          const gRes = await fetch('/api/chats/group/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              id: gChatId,
              allow_not_found: true,
            }),
          });
          if (!gRes.ok) continue;
          const lines = normalizeChatPayloadLines(await gRes.json());
          if (!Array.isArray(lines) || lines.length === 0) continue;

          const firstLine = lines[0];
          const hasHeader =
            firstLine &&
            typeof firstLine === 'object' &&
            !Object.hasOwn(firstLine, 'mes') &&
            (Object.hasOwn(firstLine, 'user_name') || Object.hasOwn(firstLine, 'chat_metadata'));
          const headerObj = hasHeader ? firstLine : { chat_metadata: {} };
          const msgLines = hasHeader ? lines.slice(1) : lines;
          if (msgLines.length === 0) continue;

          const hit = attributeChatMessagesToPersonas({
            charName: groupDisplayName,
            charAvatar: groupAvatarKey,
            chatId: gChatId,
            headerObj,
            messages: msgLines,
            allPersonas,
            fallbackAvatarId: groupDefaultAvatarId,
            unattributedUserFallbackId: groupDefaultAvatarId || globalUserMsgFallbackId,
          });
          if (hit) {
            scannedChatFiles++;
            groupHadValidChat = true;
          }
        } catch (_e) {}
      }

      if (groupHadValidChat) {
        scannedChars++;
      }
    }

    // 同时补记当前已打开窗口的内存态消息
    recordCurrentOpenChatStats();

    if (rawChars.length > 0 || hostGroups.length > 0) {
      const settings = getSettings();
      settings._autoScannedStatsVersion = 2;
    }

    saveSettings();
    if (!silent) {
      globalThis.toastr?.success?.(
        `历史统计回溯完成：共扫描识别 ${scannedChars} 个角色/群聊、${scannedChatFiles} 个聊天档`
      );
    }
  } catch (err) {
    console.error(`[${MODULE_ID}] 历史聊天扫描异常:`, err);
    if (!silent) {
      globalThis.toastr?.error?.(`扫描出错：${err.message}`);
    }
  } finally {
    state.isScanningHistory = false;
    state.scanProgressText = '';
    invalidateRenderedHtmlCache();
    refreshAllViews();
  }
}

/**
 * 首次安装或升级到修复版后，当检测到历史统计尚未完成自动回溯（或所有 User 统计全为空）时，
 * 自动在后台静默回溯一次全部历史聊天档，无需用户手动点击「扫描历史档」即可直接看到统计数据！
 */
function scheduleAutoHistoricalStatsBackfill(delayMs = 500) {
  if (state.isScanningHistory || state.hasCompletedAutoStatsScan) return;
  const settings = getSettings();
  if (settings._autoScannedStatsVersion === 2) {
    state.hasCompletedAutoStatsScan = true;
    return;
  }
  if (state.autoStatsScanTimerId) return;

  state.autoStatsScanTimerId = setTimeout(async () => {
    state.autoStatsScanTimerId = null;
    if (state.isScanningHistory || state.hasCompletedAutoStatsScan) return;
    try {
      state.hasCompletedAutoStatsScan = true;
      await scanAllHistoricalChatsForStats({ silent: true });
    } catch (_e) {}
  }, delayMs);
}

/**
 * 读取酒馆所有角色卡与群聊实体（兼容 TauriTavern 欢迎页未展开抽屉时 context.characters 懒加载为空数组的情况）
 */
function getHostCharacters() {
  try {
    const context = getContext();
    const chars =
      Array.isArray(context.characters) && context.characters.length > 0
        ? context.characters
        : state.cachedHostCharacters;
    const currentChid =
      context.characterId !== undefined && context.characterId !== null
        ? Number(context.characterId)
        : -1;
    const getThumb = (avatar) => {
      if (!avatar) return '';
      if (typeof context.getThumbnailUrl === 'function') {
        return context.getThumbnailUrl('avatar', avatar);
      }
      return `/characters/${encodeURIComponent(avatar)}`;
    };

    return chars
      .map((c, idx) => ({
        index: idx,
        name: String(c?.name || '').trim(),
        avatar: String(c?.avatar || '').trim(),
        avatarUrl: getThumb(c?.avatar),
        isCurrent: idx === currentChid && Array.isArray(context.characters) && context.characters.length > 0,
      }))
      .filter((c) => c.name);
  } catch (_e) {
    return [];
  }
}

function getCurrentCharacter() {
  return getHostCharacters().find((c) => c.isCurrent) || null;
}

function getAvailableWorldbooks() {
  const books = new Set();

  try {
    const context = getContext();
    if (typeof context.getWorldInfoNames === 'function') {
      for (const name of context.getWorldInfoNames()) {
        if (typeof name === 'string' && name.trim()) books.add(name.trim());
      }
    }
  } catch (_e) {}

  if (Array.isArray(state.hostWorldInfoModule?.world_names)) {
    for (const name of state.hostWorldInfoModule.world_names) {
      if (typeof name === 'string' && name.trim()) books.add(name.trim());
    }
  }

  if (Array.isArray(globalThis.world_names)) {
    for (const name of globalThis.world_names) {
      if (typeof name === 'string' && name.trim()) books.add(name.trim());
    }
  }

  const selectors = [
    '#world_editor_select option',
    '#persona_description_lorebook option',
    '#character_world option',
  ];

  for (const sel of selectors) {
    const options = document.querySelectorAll(sel);
    options.forEach((opt) => {
      const text = (opt.textContent || '').trim();
      const val = (opt.value || '').trim();
      if (
        text &&
        !text.startsWith('---') &&
        !text.startsWith('Select') &&
        !text.includes('None') &&
        !text.includes('无') &&
        val !== ''
      ) {
        books.add(text);
      }
    });
  }

  return [...books].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function getActiveAvatarId() {
  if (
    typeof state.hostPersonasModule?.user_avatar === 'string' &&
    state.hostPersonasModule.user_avatar.trim()
  ) {
    return state.hostPersonasModule.user_avatar.trim();
  }
  if (typeof globalThis.user_avatar === 'string' && globalThis.user_avatar.trim()) {
    return globalThis.user_avatar.trim();
  }
  const selectedDom = document.querySelector(
    '#user_avatar_block .avatar-container.selected[data-avatar-id]'
  );
  if (selectedDom) {
    return selectedDom.getAttribute('data-avatar-id') || '';
  }
  try {
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
    if (pu?.chat_metadata?.persona) return pu.chat_metadata.persona;
    if (context.chatMetadata?.persona) return context.chatMetadata.persona;
    if (pu?.personas && typeof pu.personas === 'object') {
      const entries = Object.entries(pu.personas);
      const byNameAndDesc = entries.find(([id, name]) => {
        const desc = pu.persona_descriptions?.[id]?.description ?? '';
        return name === context.name1 && desc === (pu.persona_description ?? '');
      });
      if (byNameAndDesc) return byNameAndDesc[0];
      const byName = entries.find(([_id, name]) => name === context.name1);
      if (byName) return byName[0];
    }
    if (pu?.default_persona) return pu.default_persona;
  } catch (_e) {}
  return '';
}

function detectHostPersonaAvatarMode() {
  if (state.personaThumbnailUnsupported) return;
  try {
    const sampleImg = document.querySelector(
      '#user_avatar_block .avatar-container[data-avatar-id] img[src]'
    );
    const src = sampleImg?.getAttribute('src') || '';
    if (src && src.includes('User Avatars/') && !src.includes('thumbnail')) {
      state.personaThumbnailUnsupported = true;
    }
  } catch (_e) {}
}

function resolvePersonaDirectAvatarUrl(avatarId) {
  const clean = String(avatarId || '').trim();
  if (!clean) return 'img/ai4.png';
  const bust = state.avatarCacheBust.get(clean);
  return `User Avatars/${encodeURIComponent(clean)}${bust ? `?t=${bust}` : ''}`;
}

function extractUrlFromCssBg(bgValue) {
  const raw = String(bgValue || '').trim();
  if (!raw || raw === 'none') return '';
  const m = raw.match(/url\((['"]?)(.*?)\1\)/i);
  const extracted = m?.[2]?.trim() || '';
  return isTinyPlaceholderDataUri(extracted) ? '' : extracted;
}

/**
 * 识别并拉黑所有 1x1 懒加载占位 Base64 图（如 bLazy / 懒加载脚本经典的 data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==）
 */
function isTinyPlaceholderDataUri(url) {
  const s = String(url || '').trim();
  if (!s) return true;
  if (
    s.includes('R0lGODlhAQAB') ||
    s.includes('R0lGODdhAQAB') ||
    s.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')
  ) {
    return true;
  }
  if (s.startsWith('data:image/') && s.length < 240) {
    return true;
  }
  if (s === 'about:blank') {
    return true;
  }
  return false;
}

function getRealSrcFromLazyImg(img) {
  if (!img || typeof img.getAttribute !== 'function') return '';
  for (const attr of [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-url',
    'data-echo',
    'data- lazy',
  ]) {
    const val = String(img.getAttribute(attr) || '').trim();
    if (val && !isTinyPlaceholderDataUri(val)) {
      return val;
    }
  }
  return '';
}

function isLikelyImageUrl(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s || s.length > 2_000_000 || isTinyPlaceholderDataUri(s)) return false;
  if (
    s.startsWith('https://') ||
    s.startsWith('http://') ||
    s.startsWith('data:image/') ||
    s.startsWith('blob:') ||
    s.startsWith('/user/images/') ||
    s.startsWith('user/images/') ||
    s.startsWith('/assets/') ||
    s.startsWith('assets/')
  ) {
    return true;
  }
  return /\.(png|webp|jpg|jpeg|gif|avif|svg)(\?.*)?$/i.test(s);
}

/**
 * 判断某个 URL 是否属于云头像/图床/IndexedDB Blob/美化脚本改写后的自定义头像地址（而非酒馆默认的本地缩略图、直链或 1x1 懒加载占位符）
 */
function isExternalOrCustomAvatarUrl(url, avatarId) {
  const s = String(url || '').trim();
  if (!s || isTinyPlaceholderDataUri(s) || s.endsWith('img/ai4.png') || s === 'img/ai4.png') {
    return false;
  }
  if (s.startsWith('blob:') || s.startsWith('data:image/')) return true;

  const cleanId = String(avatarId || '').trim();
  const encId = encodeURIComponent(cleanId);

  try {
    const parsed = new URL(s, globalThis.location?.href || 'http://127.0.0.1/');
    const sameOrigin =
      !globalThis.location?.origin ||
      globalThis.location.origin === 'null' ||
      parsed.origin === globalThis.location.origin;

    if (!sameOrigin) {
      return true;
    }

    const p = parsed.pathname || '';
    if (p.endsWith('/thumbnail') && parsed.searchParams.get('type') === 'persona') {
      const f = parsed.searchParams.get('file') || '';
      return Boolean(cleanId && f && f !== cleanId);
    }
    if (p.includes('/User%20Avatars/') || p.includes('/User Avatars/')) {
      return Boolean(cleanId && !p.endsWith(`/${encId}`) && !p.endsWith(`/${cleanId}`));
    }
    return true;
  } catch (_e) {
    return (
      !s.includes('thumbnail?type=persona') &&
      !s.includes(`User Avatars/${encId}`) &&
      !s.includes(`User Avatars/${cleanId}`)
    );
  }
}

function isPersistableExternalUrl(url) {
  const s = String(url || '').trim();
  if (!s || s.startsWith('blob:') || isTinyPlaceholderDataUri(s)) return false;
  if (s.startsWith('data:image/')) {
    return s.length <= 48_000;
  }
  return true;
}

function saveAvatarCacheDebounced() {
  if (state.avatarCacheSaveTimer) clearTimeout(state.avatarCacheSaveTimer);
  state.avatarCacheSaveTimer = setTimeout(() => {
    state.avatarCacheSaveTimer = null;
    saveSettings();
  }, 1500);
}

/**
 * 记录并原位热替换已捕获的云头像/美化头像地址（不重写列表 innerHTML，绝不产生任何滚动跳动）
 */
function recordResolvedExternalAvatar(avatarId, url) {
  const cleanId = String(avatarId || '').trim();
  const cleanUrl = String(url || '').trim();
  if (!cleanId || !cleanUrl || isTinyPlaceholderDataUri(cleanUrl)) return false;

  const prevMem = state.resolvedExternalAvatars.get(cleanId);
  state.resolvedExternalAvatars.set(cleanId, cleanUrl);
  state.whitePlaceholderIds.delete(cleanId);

  try {
    const settings = getSettings();
    if (isPersistableExternalUrl(cleanUrl)) {
      if (settings.avatarUrlCache[cleanId] !== cleanUrl) {
        settings.avatarUrlCache[cleanId] = cleanUrl;
        saveAvatarCacheDebounced();
      }
    }
  } catch (_e) {}

  if (prevMem !== cleanUrl) {
    try {
      const esc = globalThis.CSS?.escape
        ? globalThis.CSS.escape(cleanId)
        : cleanId.replaceAll('"', '\\"');
      document
        .querySelectorAll(
          `#st_pw_inline_left_panel img[data-avatar-id="${esc}"], #st_pw_wardrobe_modal img[data-avatar-id="${esc}"], #st_pw_native_persona_helper img[data-avatar-id="${esc}"]`
        )
        .forEach((img) => {
          if (img.getAttribute('src') !== cleanUrl) {
            img.dataset.triedExt = '1';
            img.classList.remove('st-pw-placeholder-pending');
            img.setAttribute('src', cleanUrl);
          }
        });
    } catch (_e) {}
    return true;
  }
  return false;
}

/**
 * 扫描宿主 extension_settings、persona_descriptions 与 localStorage 中可能由第三方图床/云头像/美化脚本保存的头像映射
 */
function scanExternalAvatarMappings() {
  let foundCount = 0;
  try {
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user || {};
    const personasMap = pu.personas && typeof pu.personas === 'object' ? pu.personas : {};
    const descMap =
      pu.persona_descriptions && typeof pu.persona_descriptions === 'object'
        ? pu.persona_descriptions
        : {};
    const knownIds = new Set([
      ...Object.keys(personasMap),
      ...Object.keys(descMap),
      ...(state.diskAvatarSet instanceof Set ? [...state.diskAvatarSet] : []),
    ]);
    if (knownIds.size === 0) return 0;

    const extractUrlFromCandidateValue = (val) => {
      if (isLikelyImageUrl(val)) return val.trim();
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        for (const k of [
          'avatarUrl',
          'avatar_url',
          'cloudAvatar',
          'cloud_avatar',
          'customAvatar',
          'custom_avatar',
          'url',
          'src',
          'image',
          'img',
          'icon',
        ]) {
          if (isLikelyImageUrl(val[k])) return val[k].trim();
        }
      }
      return '';
    };

    // 1) 检查 persona_descriptions[avatarId] 上的自定义扩展字段
    for (const id of knownIds) {
      const d = descMap[id];
      if (!d || typeof d !== 'object') continue;
      const hit = extractUrlFromCandidateValue(d);
      if (hit && isExternalOrCustomAvatarUrl(hit, id)) {
        if (recordResolvedExternalAvatar(id, hit)) foundCount++;
      }
    }

    // 2) 扫描其他扩展的 extension_settings 命名空间（最多向下 3 层查找精确匹配的 avatarId 键）
    const inspectDict = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 3) return;
      if (Array.isArray(obj)) {
        if (obj.length > 2000) return;
        for (const item of obj) {
          if (!item || typeof item !== 'object') continue;
          const itemKey = String(
            item.avatarId || item.avatar || item.id || item.key || item.file || ''
          ).trim();
          if (itemKey && knownIds.has(itemKey)) {
            const u = extractUrlFromCandidateValue(item);
            if (u && isExternalOrCustomAvatarUrl(u, itemKey)) {
              if (recordResolvedExternalAvatar(itemKey, u)) foundCount++;
            }
          }
        }
        return;
      }
      const entries = Object.entries(obj);
      if (entries.length > 3000) return;
      for (const [k, v] of entries) {
        if (knownIds.has(k)) {
          const u = extractUrlFromCandidateValue(v);
          if (u && isExternalOrCustomAvatarUrl(u, k)) {
            if (recordResolvedExternalAvatar(k, u)) foundCount++;
            continue;
          }
        }
        if (v && typeof v === 'object') {
          inspectDict(v, depth + 1);
        }
      }
    };

    const allExtSettings = context.extensionSettings || {};
    for (const [extName, extData] of Object.entries(allExtSettings)) {
      if (extName === MODULE_ID || !extData || typeof extData !== 'object') continue;
      inspectDict(extData, 0);
    }

    // 3) 扫描 localStorage 中与 avatar / persona / 图床 相关的轻量 JSON 表
    if (typeof globalThis.localStorage !== 'undefined') {
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const lsKey = globalThis.localStorage.key(i) || '';
        if (!/avatar|persona|tuchuang|cloud|img|pic|图床|头像|人设/i.test(lsKey)) continue;
        if (lsKey.includes(MODULE_ID)) continue;
        const raw = globalThis.localStorage.getItem(lsKey) || '';
        if (!raw || raw.length > 2_000_000 || (raw[0] !== '{' && raw[0] !== '[')) continue;
        try {
          inspectDict(JSON.parse(raw), 0);
        } catch (_e) {}
      }
    }
  } catch (_e) {}
  return foundCount;
}

/**
 * 检测已加载的 <img> 是否为 1x1 或全画幅零对比度的纯白/纯色占位图（第三方图床插件常在本地存 1x1 纯白 PNG 作为占位）
 */
function checkIsUniformBlankPlaceholder(img) {
  try {
    if (!(img instanceof HTMLImageElement) || !img.complete) return false;
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (nw === 0 || nh === 0) return false;
    if (nw <= 4 && nh <= 4) return true;

    if (!state._probeCanvas && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      if (typeof c.getContext === 'function') {
        c.width = 6;
        c.height = 6;
        state._probeCanvas = c;
      }
    }
    const ctx = state._probeCanvas?.getContext?.('2d', { willReadFrequently: true });
    if (!ctx) return false;

    ctx.clearRect(0, 0, 6, 6);
    ctx.drawImage(img, 0, 0, 6, 6);
    const data = ctx.getImageData(0, 0, 6, 6).data;
    let minR = 255;
    let maxR = 0;
    let minG = 255;
    let maxG = 0;
    let minB = 255;
    let maxB = 0;
    let minA = 255;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
      if (a < minA) minA = a;
    }

    // 全透明占位图
    if (minA === 0 && maxR === 0 && maxG === 0 && maxB === 0) return true;
    // 全图 36 个采样区块几乎完全同色且偏亮白/浅灰（如 #FFFFFF 纯白占位图经 Jimp 缩放后的 JPEG）
    if (
      minA >= 240 &&
      minR >= 235 &&
      minG >= 235 &&
      minB >= 235 &&
      maxR - minR <= 6 &&
      maxG - minG <= 6 &&
      maxB - minB <= 6
    ) {
      return true;
    }
    return false;
  } catch (_e) {
    // 跨域图床图片读取像素会抛 SecurityError，说明已经是外部真实头像
    return false;
  }
}

/**
 * 从原生 #user_avatar_block 当前挂载的节点中提取所有已被美化/云头像脚本改写或加载完成的真实头像地址
 */
function harvestCurrentNativeDomAvatars() {
  let harvested = 0;
  try {
    const block = document.querySelector('#user_avatar_block');
    if (!block) return 0;

    const containers = block.querySelectorAll('.avatar-container[data-avatar-id]');
    containers.forEach((node) => {
      const avatarId = node.getAttribute('data-avatar-id')?.trim();
      if (!avatarId) return;

      const avatarBox = node.querySelector('.avatar');
      const imgs = node.querySelectorAll('img');
      for (const img of imgs) {
        const lazyAttrUrl = getRealSrcFromLazyImg(img);
        const candidates = [
          lazyAttrUrl,
          img.getAttribute('src'),
          img.currentSrc,
        ];
        for (const raw of candidates) {
          const u = String(raw || '').trim();
          if (!u || isTinyPlaceholderDataUri(u)) continue;
          if (isExternalOrCustomAvatarUrl(u, avatarId)) {
            if (recordResolvedExternalAvatar(avatarId, u)) harvested++;
            return;
          }
        }
        // 若原生节点里的同源地址已重新生成为非纯白真实图像（或从 data-src 拿到了真实同源地址）
        const liveSrc = String(
          lazyAttrUrl || img.currentSrc || img.getAttribute('src') || ''
        ).trim();
        if (
          liveSrc &&
          !isTinyPlaceholderDataUri(liveSrc) &&
          state.whitePlaceholderIds.has(avatarId) &&
          (Boolean(lazyAttrUrl) ||
            (img.complete && img.naturalWidth > 4 && !checkIsUniformBlankPlaceholder(img)))
        ) {
          state.whitePlaceholderIds.delete(avatarId);
          state.avatarCacheBust.set(avatarId, Date.now());
          recordResolvedExternalAvatar(
            avatarId,
            `${liveSrc}${liveSrc.includes('?') ? '&' : '?'}t=${Date.now()}`
          );
          harvested++;
          return;
        }
      }

      // 兼容通过 inline style background-image 注入头像的美化脚本
      for (const el of [avatarBox, node]) {
        if (!el) continue;
        const bgUrl = extractUrlFromCssBg(el.style?.backgroundImage);
        if (bgUrl && isExternalOrCustomAvatarUrl(bgUrl, avatarId)) {
          if (recordResolvedExternalAvatar(avatarId, bgUrl)) harvested++;
          return;
        }
      }
    });
  } catch (_e) {}
  return harvested;
}

/**
 * 通用原生人设池全量唤醒采集器：
 * 当检测到纯白占位图或第三方云头像脚本时，自动在隐式视口内将原生 #user_avatar_block 展开渲染全量条目，
 * 让任何依赖原生列表（翻页/MutationObserver/IntersectionObserver/is(':visible')）的未知图床/美化脚本一次性吐出全部真实头像！
 */
function restoreNativeLeftColumnElements(leftCol) {
  if (!leftCol) return;
  leftCol.classList?.remove?.('st-pw-left-taken', 'st-pw-harvesting-col');
  Array.from(leftCol.children || []).forEach((child) => {
    if (!child || !child.style) return;
    if (child.dataset?.stPwHiddenNative === '1') {
      delete child.dataset.stPwHiddenNative;
      child.style.removeProperty?.('display');
      child.style.removeProperty?.('position');
      child.style.removeProperty?.('left');
      child.style.removeProperty?.('top');
      child.style.removeProperty?.('width');
      child.style.removeProperty?.('height');
      child.style.removeProperty?.('overflow');
      child.style.removeProperty?.('opacity');
      child.style.removeProperty?.('pointer-events');
      child.style.removeProperty?.('clip-path');
      child.style.removeProperty?.('z-index');
    }
  });
}

function syncNativeLeftColumnVisibility(leftCol) {
  if (!leftCol) return;
  const settings = getSettings();
  if (!settings.enhanceNativePersonaPanel || state.useRawNativeLeftList) {
    restoreNativeLeftColumnElements(leftCol);
    return;
  }

  leftCol.classList?.add?.('st-pw-left-taken');
  if (state.isHarvestingAvatars) {
    leftCol.classList?.add?.('st-pw-harvesting-col');
  } else {
    leftCol.classList?.remove?.('st-pw-harvesting-col');
  }

  Array.from(leftCol.children || []).forEach((child) => {
    if (!child || !child.style) return;
    if (child.id === 'st_pw_inline_left_panel' || child.id === 'form_upload_avatar') {
      return;
    }
    if (child.dataset) child.dataset.stPwHiddenNative = '1';
    if (state.isHarvestingAvatars && child.id === 'user_avatar_block') {
      child.style.removeProperty?.('display');
      child.style.setProperty?.('position', 'fixed', 'important');
      child.style.setProperty?.('left', '0', 'important');
      child.style.setProperty?.('top', '0', 'important');
      child.style.setProperty?.('width', '1px', 'important');
      child.style.setProperty?.('height', '1px', 'important');
      child.style.setProperty?.('overflow', 'hidden', 'important');
      child.style.setProperty?.('opacity', '0.0001', 'important');
      child.style.setProperty?.('pointer-events', 'none', 'important');
      child.style.setProperty?.('clip-path', 'inset(50%)', 'important');
      child.style.setProperty?.('z-index', '-9999', 'important');
    } else {
      child.style.setProperty?.('display', 'none', 'important');
    }
  });
}

async function runUniversalNativeAvatarHarvest({ manual = false } = {}) {
  scanExternalAvatarMappings();
  harvestCurrentNativeDomAvatars();

  if (state.isHarvestingAvatars) return;
  if (
    !manual &&
    state.hasCompletedFullHarvestThisSession &&
    state.whitePlaceholderIds.size === 0
  ) {
    return;
  }

  state.isHarvestingAvatars = true;
  state.hasCompletedFullHarvestThisSession = true;
  const beforeCount = state.resolvedExternalAvatars.size;

  const drawerEl = document.querySelector('#PersonaManagement');
  const leftColEl = document.querySelector('#PersonaManagement .persona_management_left_column');
  const addedHarvestDrawerClass = Boolean(
    drawerEl && drawerEl.classList.contains('closedDrawer')
  );
  if (addedHarvestDrawerClass) {
    drawerEl.classList.add('st-pw-harvesting-drawer');
  }
  syncNativeLeftColumnVisibility(leftColEl);

  try {
    await probeHostModules();
    const context = getContext();
    const storage = context.accountStorage || globalThis.localStorage;
    const PER_PAGE_KEY = 'Personas_PerPage';
    const prevPerPage = storage?.getItem?.(PER_PAGE_KEY) ?? null;

    if (
      !state.useRawNativeLeftList &&
      typeof state.hostPersonasModule?.getUserAvatars === 'function'
    ) {
      try {
        storage?.setItem?.(PER_PAGE_KEY, '1000');
        await state.hostPersonasModule.getUserAvatars(true, getActiveAvatarId());
      } catch (err) {
        console.warn(`[${MODULE_ID}] 唤醒原生 getUserAvatars 采集跳过:`, err);
      } finally {
        // 立即恢复存储中的分页偏好（保留 DOM 中已挂载的全量节点供异步云头像脚本替换）
        if (prevPerPage !== null && prevPerPage !== undefined) {
          storage?.setItem?.(PER_PAGE_KEY, String(prevPerPage));
        } else {
          storage?.removeItem?.(PER_PAGE_KEY);
        }
      }
    }

    for (const waitMs of [120, 450, 1100, 2400]) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      scanExternalAvatarMappings();
      harvestCurrentNativeDomAvatars();
    }
  } finally {
    if (addedHarvestDrawerClass && drawerEl) {
      drawerEl.classList.remove('st-pw-harvesting-drawer');
    }
    state.isHarvestingAvatars = false;
    syncNativeLeftColumnVisibility(leftColEl);
  }

  if (manual) {
    const gained = Math.max(0, state.resolvedExternalAvatars.size - beforeCount);
    invalidateRenderedHtmlCache();
    refreshAllViews();
    globalThis.toastr?.success?.(
      gained > 0
        ? `已同步捕获 ${gained} 个云端/美化头像（共缓存 ${state.resolvedExternalAvatars.size} 个）`
        : '已同步刷新人设与头像列表'
    );
  }
}

function scheduleUniversalAvatarHarvest(delayMs = 220) {
  if (state.isHarvestingAvatars || state.hasCompletedFullHarvestThisSession) return;
  if (state.harvestTimerId) return;
  state.harvestTimerId = setTimeout(() => {
    state.harvestTimerId = null;
    runUniversalNativeAvatarHarvest({ manual: false });
  }, delayMs);
}

function observeNativeAvatarBlock() {
  if (typeof MutationObserver === 'undefined') return;
  const personaDrawer = document.querySelector('#PersonaManagement');
  if (!personaDrawer) return;

  let debounceId = null;
  const triggerHarvestPass = () => {
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(() => {
      debounceId = null;
      const gained = harvestCurrentNativeDomAvatars();
      // 若发现原生前 5 条已经被某个云头像插件改写了外链，且本轮会话尚未全量展开同步过，自动把剩余人设也一并同步出来
      if (gained > 0 && !state.hasCompletedFullHarvestThisSession) {
        scheduleUniversalAvatarHarvest(180);
      }
    }, 80);
  };

  const observer = new MutationObserver((mutations) => {
    let drawerOpened = false;
    let blockMutated = false;
    const block = document.querySelector('#user_avatar_block');

    for (const m of mutations) {
      if (m.target === personaDrawer && m.attributeName === 'class') {
        if (personaDrawer.classList.contains('openDrawer')) {
          drawerOpened = true;
        }
      } else if (block && (m.target === block || block.contains(m.target))) {
        blockMutated = true;
      }
    }

    if (drawerOpened) {
      syncNativePersonaPanelEnhancement();
      triggerHarvestPass();
    } else if (blockMutated) {
      triggerHarvestPass();
    }
  });

  observer.observe(personaDrawer, {
    attributes: true,
    attributeFilter: ['class', 'src', 'style', 'data-src', 'data-lazy-src'],
    childList: true,
    subtree: true,
  });

  state.disposers.push(() => {
    if (debounceId) clearTimeout(debounceId);
    observer.disconnect();
  });
}

function resolvePersonaAvatarUrl(avatarId) {
  const clean = String(avatarId || '').trim();
  if (!clean) return 'img/ai4.png';

  detectHostPersonaAvatarMode();
  const bust = state.avatarCacheBust.get(clean);

  // 1) 优先使用已捕获的云头像/图床/IndexedDB Blob/美化脚本真实头像（绝不采信 R0lGODlhAQAB 等 1x1 懒加载空白占位符！）
  if (!bust) {
    const memExt = state.resolvedExternalAvatars.get(clean);
    if (memExt && !isTinyPlaceholderDataUri(memExt)) return memExt;

    try {
      const escaped = globalThis.CSS?.escape
        ? globalThis.CSS.escape(clean)
        : clean.replaceAll('"', '\\"');
      const domNode = document.querySelector(
        `#user_avatar_block .avatar-container[data-avatar-id="${escaped}"]`
      );
      if (domNode) {
        const domImg = domNode.querySelector('img');
        // 优先提取懒加载脚本暂存在 data-src / data-original / data-lazy-src 上的真实头像地址
        const lazyRealSrc = getRealSrcFromLazyImg(domImg);
        if (lazyRealSrc) {
          if (isExternalOrCustomAvatarUrl(lazyRealSrc, clean)) {
            state.resolvedExternalAvatars.set(clean, lazyRealSrc);
          }
          return lazyRealSrc;
        }

        const domSrc = domImg?.getAttribute('src')?.trim() || '';
        // 关键修复：若原生 #user_avatar_block 里的 img.src 是 1x1 懒加载占位 GIF (R0lGODlhAQAB...)，直接忽略它，继续向下走真实缩略图/原图地址！
        if (domSrc && !isTinyPlaceholderDataUri(domSrc)) {
          if (isExternalOrCustomAvatarUrl(domSrc, clean)) {
            state.resolvedExternalAvatars.set(clean, domSrc);
          }
          return domSrc;
        }

        const bgUrl = extractUrlFromCssBg(
          domNode.querySelector('.avatar')?.style?.backgroundImage ||
            domNode.style?.backgroundImage
        );
        if (bgUrl && isExternalOrCustomAvatarUrl(bgUrl, clean)) {
          state.resolvedExternalAvatars.set(clean, bgUrl);
          return bgUrl;
        }
      }
    } catch (_e) {}

    try {
      const persistedExt = getSettings().avatarUrlCache?.[clean];
      if (persistedExt && !isTinyPlaceholderDataUri(persistedExt)) return persistedExt;
    } catch (_e) {}
  }

  if (!state.personaThumbnailUnsupported) {
    try {
      const context = getContext();
      if (typeof context.getThumbnailUrl === 'function') {
        const thumbUrl = context.getThumbnailUrl('persona', clean);
        return bust
          ? `${thumbUrl}${thumbUrl.includes('?') ? '&' : '?'}t=${bust}`
          : thumbUrl;
      }
    } catch (_e) {}
  }

  return resolvePersonaDirectAvatarUrl(clean);
}

/**
 * 为面板容器绑定捕获阶段的头像 load + error 自愈链：
 * 1) load 阶段自动识别 1x1 / 纯白占位图：若检测到图床插件的纯白占位图，立即柔和暗化防刺眼，并自动后台唤醒原生列表抓取真实云头像热替换
 * 2) error 阶段自动降级：失效缓存外链 -> /thumbnail?type=persona -> User Avatars/<file> 原图直链 -> img/ai4.png
 */
function bindAvatarErrorFallback(container) {
  if (!container || container.dataset.avatarErrBound === '1') return;
  container.dataset.avatarErrBound = '1';

  container.addEventListener(
    'load',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const avatarId = img.getAttribute('data-avatar-id');
      if (!avatarId) return;

      const currentSrc = img.getAttribute('src') || '';
      if (currentSrc.endsWith('img/ai4.png')) {
        img.classList.remove('st-pw-placeholder-pending');
        return;
      }

      // 若全局懒加载插件强行把本插件自己的 <img> src 也改写成了 1x1 占位 GIF (R0lGODlhAQAB...)，立即从 data-src 或 data-real-src 夺回真实地址！
      if (isTinyPlaceholderDataUri(currentSrc)) {
        const stolenReal =
          getRealSrcFromLazyImg(img) ||
          img.getAttribute('data-real-src') ||
          '';
        if (
          stolenReal &&
          !isTinyPlaceholderDataUri(stolenReal) &&
          !img.dataset.restoredRealSrc
        ) {
          img.dataset.restoredRealSrc = '1';
          img.classList.remove('b-lazy', 'lazyload');
          img.classList.add('b-loaded', 'loaded');
          img.setAttribute('data-loaded', 'true');
          img.setAttribute('src', stolenReal);
          return;
        }
      }

      if (checkIsUniformBlankPlaceholder(img)) {
        // 先看是否已采集到该人设的云端/美化真实头像
        const extUrl =
          state.resolvedExternalAvatars.get(avatarId) ||
          getSettings().avatarUrlCache?.[avatarId] ||
          '';
        if (extUrl && extUrl !== currentSrc && !img.dataset.triedExt) {
          img.dataset.triedExt = '1';
          img.setAttribute('src', extUrl);
          return;
        }

        // 若当前是缩略图返回纯白，尝试一次原图直链（排除 Jimp 缩略图损坏的可能）
        const directSrc =
          img.getAttribute('data-fallback-src') || resolvePersonaDirectAvatarUrl(avatarId);
        if (!img.dataset.triedDirect && currentSrc !== directSrc && currentSrc.includes('thumbnail')) {
          img.dataset.triedDirect = '1';
          img.setAttribute('src', directSrc);
          return;
        }

        // 确认本地文件本身即为纯白占位图：柔和暗化并自动唤醒通用原生采集器拉取云头像
        img.classList.add('st-pw-placeholder-pending');
        state.whitePlaceholderIds.add(avatarId);
        scheduleUniversalAvatarHarvest(150);
      } else {
        img.classList.remove('st-pw-placeholder-pending');
        state.whitePlaceholderIds.delete(avatarId);
      }
    },
    true
  );

  container.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const avatarId = img.getAttribute('data-avatar-id');
      if (!avatarId) return;

      const currentSrc = img.getAttribute('src') || '';
      const directSrc = img.getAttribute('data-fallback-src') || resolvePersonaDirectAvatarUrl(avatarId);

      // 若持久化的外链图床地址已失效，清除该条外链缓存并重新触发采集或回退本地
      try {
        const settings = getSettings();
        if (settings.avatarUrlCache?.[avatarId] === currentSrc) {
          delete settings.avatarUrlCache[avatarId];
          state.resolvedExternalAvatars.delete(avatarId);
          state.hasCompletedFullHarvestThisSession = false;
          scheduleUniversalAvatarHarvest(250);
        }
      } catch (_e) {}

      if (!img.dataset.triedDirect && currentSrc !== directSrc) {
        img.dataset.triedDirect = '1';
        if (currentSrc.includes('thumbnail') && currentSrc.includes('persona')) {
          state.personaThumbnailUnsupported = true;
          document
            .querySelectorAll('img[data-avatar-id][data-fallback-src]')
            .forEach((otherImg) => {
              const otherSrc = otherImg.getAttribute('src') || '';
              const otherDirect = otherImg.getAttribute('data-fallback-src') || '';
              if (
                otherImg !== img &&
                !otherImg.dataset.triedDirect &&
                otherDirect &&
                otherSrc.includes('thumbnail') &&
                otherSrc.includes('persona')
              ) {
                otherImg.dataset.triedDirect = '1';
                otherImg.setAttribute('src', otherDirect);
              }
            });
        }
        img.setAttribute('src', directSrc);
        return;
      }

      if (!img.dataset.triedDefault) {
        img.dataset.triedDefault = '1';
        img.classList.remove('st-pw-placeholder-pending');
        img.setAttribute('src', 'img/ai4.png');
      }
    },
    true
  );
}

/**
 * 直接在插件中触发上传新建人设头像 / 更换指定人设头像（无需先切去原生人设栏目）
 */
async function triggerPersonaAvatarUpload({ targetAvatarId = '' } = {}) {
  if (targetAvatarId) {
    const activeId = getActiveAvatarId();
    if (activeId !== targetAvatarId) {
      await switchActivePersona(targetAvatarId);
    }
    const setBtn = document.querySelector('#persona_set_image_button');
    if (setBtn) {
      setBtn.click();
      return;
    }
    const overwriteInput = document.querySelector('#avatar_upload_overwrite');
    if (overwriteInput) overwriteInput.value = targetAvatarId;
    document.querySelector('#avatar_upload_file')?.click();
    return;
  }

  const uploadTrigger = document.querySelector('#user_avatar_block .avatar_upload');
  if (uploadTrigger) {
    uploadTrigger.click();
  } else {
    const overwriteInput = document.querySelector('#avatar_upload_overwrite');
    if (overwriteInput) overwriteInput.value = '';
    document.querySelector('#avatar_upload_file')?.click();
  }
}

/**
 * 从角色对象读取 Luker 专属的 character.data.extensions.luker.dedicated_personas
 */
function extractLukerDedicatedPersonas(rawChar) {
  if (!rawChar || typeof rawChar !== 'object') return [];
  if (typeof state.hostPersonasModule?.getDedicatedPersonaEntriesFromCharacter === 'function') {
    try {
      const list = state.hostPersonasModule.getDedicatedPersonaEntriesFromCharacter(rawChar);
      if (Array.isArray(list)) return list;
    } catch (_e) {}
  }
  const direct = rawChar?.data?.extensions?.luker?.dedicated_personas;
  if (Array.isArray(direct)) return direct;
  if (typeof rawChar?.json_data === 'string' && rawChar.json_data.trim()) {
    try {
      const parsed = JSON.parse(rawChar.json_data);
      const fromJson = parsed?.data?.extensions?.luker?.dedicated_personas;
      if (Array.isArray(fromJson)) return fromJson;
    } catch (_e) {}
  }
  return [];
}

/**
 * 读取所有 User Personas，同时兼容：
 * 1. 标准 SillyTavern 的 power_user.personas / persona_descriptions.connections
 * 2. Luker (funnycups/Luker) 的 character.data.extensions.luker.dedicated_personas（含 Character-Only 专属人设）
 */
function getHostPersonas() {
  let context = null;
  try {
    context = getContext();
  } catch (_e) {}

  const pu = context?.powerUserSettings || globalThis.power_user || {};
  const personasMap = pu.personas && typeof pu.personas === 'object' ? pu.personas : {};
  const descMap =
    pu.persona_descriptions && typeof pu.persona_descriptions === 'object'
      ? pu.persona_descriptions
      : {};

  const rawChars =
    Array.isArray(context?.characters) && context.characters.length > 0
      ? context.characters
      : state.cachedHostCharacters;
  const hostChars = getHostCharacters();
  const charByAvatar = new Map(hostChars.map((c) => [c.avatar, c]));
  const charByNameLower = new Map(hostChars.map((c) => [c.name.toLowerCase(), c]));
  const hostGroups = Array.isArray(context?.groups) ? context.groups : [];
  const groupById = new Map(hostGroups.map((g) => [String(g.id), String(g.name || g.id)]));

  const activeAvatarId = getActiveAvatarId();
  const resultMap = new Map();
  const hasDiskFilter =
    state.diskAvatarFetched &&
    state.diskAvatarSet instanceof Set &&
    state.diskAvatarSet.size > 0;

  let excludedOrphanCount = 0;
  let mergedDuplicateCount = 0;

  // 1. 读取全局 power_user.personas（与酒馆原生 getUserAvatars 一致：必须校核 /api/avatars/get 磁盘文件是否存在，过滤已删头像的历史残留键）
  for (const [avatarId, displayName] of Object.entries(personasMap)) {
    const cleanId = String(avatarId || '').trim();
    if (!cleanId) continue;
    const isCurrent = cleanId === activeAvatarId;
    if (hasDiskFilter && !state.diskAvatarSet.has(cleanId) && !isCurrent) {
      excludedOrphanCount++;
      continue;
    }

    const descObj = descMap[cleanId] || {};
    const effectiveLorebook = String(
      descObj.lorebook || (isCurrent ? pu.persona_description_lorebook || '' : '')
    );
    const connections = Array.isArray(descObj.connections) ? descObj.connections : [];

    resultMap.set(cleanId, {
      avatarId: cleanId,
      name: String(displayName || cleanId),
      description: String(descObj.description ?? (isCurrent ? pu.persona_description ?? '' : '')),
      lorebook: effectiveLorebook,
      position: descObj.position,
      depth: descObj.depth,
      role: descObj.role,
      title: String(descObj.title ?? ''),
      connections,
      lukerDedicatedChars: [],
      isLukerCharacterOnly: false,
      avatarUrl: resolvePersonaAvatarUrl(cleanId),
      isActive: isCurrent,
    });
  }

  // 辅助：查找是否已有同一个人设（兼容 Luker 为不同角色卡生成 Char__Persona.png 或 _1.png 等不同 avatarId 的情况）
  const findExistingPersonaForDedicated = (avatarId, entryName, entryDesc) => {
    if (resultMap.has(avatarId)) {
      return resultMap.get(avatarId);
    }
    const normName = String(entryName || '').trim().toLowerCase();
    const normDesc = String(entryDesc || '').trim();
    if (!normName) return null;

    // 优先匹配：同名且同描述（跨卡绑定同一个人设或同时存在于全局与角色卡）
    for (const item of resultMap.values()) {
      if (
        item.name.trim().toLowerCase() === normName &&
        item.description.trim() === normDesc
      ) {
        return item;
      }
    }
    // 次级匹配：如果两边有一边描述为空且名字完全一致
    for (const item of resultMap.values()) {
      if (
        item.name.trim().toLowerCase() === normName &&
        (!normDesc || !item.description.trim())
      ) {
        return item;
      }
    }
    return null;
  };

  // 2. 扫描 Luker 的 character.data.extensions.luker.dedicated_personas（自动去重合并同人设跨多张角色卡的绑定）
  for (const rawChar of rawChars) {
    const charName = String(rawChar?.name || '').trim();
    const charAvatar = String(rawChar?.avatar || '').trim();
    if (!charName) continue;
    const dedicatedList = extractLukerDedicatedPersonas(rawChar);
    for (const entry of dedicatedList) {
      const avatarId = String(entry?.avatar || '').trim();
      const entryName = String(entry?.name || avatarId).trim();
      if (!avatarId && !entryName) continue;
      const entryDesc = String(entry?.description ?? '');
      const isCurrent = Boolean(avatarId && avatarId === activeAvatarId);

      const existing = findExistingPersonaForDedicated(avatarId, entryName, entryDesc);
      if (existing) {
        if (existing.avatarId !== avatarId) {
          mergedDuplicateCount++;
        }
        if (!existing.lukerDedicatedChars.includes(charName)) {
          existing.lukerDedicatedChars.push(charName);
        }
        if (!existing.description && entryDesc) {
          existing.description = entryDesc;
        }
        if (!existing.lorebook && entry.lorebook) {
          existing.lorebook = String(entry.lorebook);
        }
        if (isCurrent) {
          existing.isActive = true;
        }
      } else {
        const finalId = avatarId || `luker_dedicated__${charName}__${entryName}.png`;
        if (hasDiskFilter && avatarId && !state.diskAvatarSet.has(avatarId) && !entryDesc.trim() && !isCurrent) {
          excludedOrphanCount++;
          continue;
        }
        resultMap.set(finalId, {
          avatarId: finalId,
          name: entryName || finalId,
          description: String(entryDesc || (isCurrent ? pu.persona_description ?? '' : '')),
          lorebook: String(entry.lorebook || (isCurrent ? pu.persona_description_lorebook || '' : '')),
          position: entry.position,
          depth: entry.depth,
          role: entry.role,
          title: String(entry.title ?? ''),
          connections: [],
          lukerDedicatedChars: [charName],
          lukerCharacterAvatars: charAvatar ? [charAvatar] : [],
          isLukerCharacterOnly: true,
          avatarUrl: resolvePersonaAvatarUrl(finalId),
          isActive: isCurrent,
        });
      }
    }
  }

  state.lastExcludedOrphanCount = excludedOrphanCount;
  state.lastMergedDuplicateCount = mergedDuplicateCount;

  const avatarNodes = document.querySelectorAll(
    '#user_avatar_block .avatar-container[data-avatar-id]'
  );
  avatarNodes.forEach((node) => {
    const avatarId = node.getAttribute('data-avatar-id');
    if (!avatarId) return;
    const domName =
      node.querySelector('.ch_name')?.textContent?.trim() ||
      node.getAttribute('title') ||
      avatarId;
    const domDesc = node.querySelector('.ch_description')?.textContent?.trim() || '';
    const resolvedSrc = resolvePersonaAvatarUrl(avatarId);
    const isSelected = node.classList.contains('selected') || avatarId === activeAvatarId;
    const descObj = descMap[avatarId] || {};

    if (!resultMap.has(avatarId)) {
      resultMap.set(avatarId, {
        avatarId,
        name: domName,
        description: String(descObj.description ?? domDesc),
        lorebook: String(descObj.lorebook ?? ''),
        title: String(descObj.title ?? ''),
        connections: Array.isArray(descObj.connections) ? descObj.connections : [],
        lukerDedicatedChars: [],
        isLukerCharacterOnly: false,
        avatarUrl: resolvedSrc,
        isActive: isSelected,
      });
    } else {
      const existing = resultMap.get(avatarId);
      if (isSelected) existing.isActive = true;
      if (resolvedSrc) existing.avatarUrl = resolvedSrc;
    }
  });

  // 标准 SillyTavern 兼容：若磁盘 User Avatars/ 下有尚未经原生人设面板首次打开注册的新头像文件，直接补齐显示（Luker 因存在卡内专属文件不自动升为全局）
  const isLukerHost =
    typeof state.hostPersonasModule?.getDedicatedPersonaEntriesFromCharacter === 'function' ||
    typeof state.hostPersonasModule?.setCharacterDedicatedPersonaEntries === 'function';
  if (!isLukerHost && hasDiskFilter) {
    for (const diskFile of state.diskAvatarSet) {
      if (!resultMap.has(diskFile)) {
        const descObj = descMap[diskFile] || {};
        const isDefaultAvatar =
          diskFile === 'user-default.png' ||
          (diskFile === activeAvatarId && context?.name1);
        const fallbackDisplayName = isDefaultAvatar
          ? String(context?.name1 || 'User')
          : diskFile.replace(/\.(png|webp|jpg|jpeg|gif)$/i, '');
        resultMap.set(diskFile, {
          avatarId: diskFile,
          name: String(personasMap[diskFile] || fallbackDisplayName),
          description: String(descObj.description ?? (diskFile === activeAvatarId ? pu.persona_description ?? '' : '')),
          lorebook: String(descObj.lorebook ?? (diskFile === activeAvatarId ? pu.persona_description_lorebook ?? '' : '')),
          title: String(descObj.title ?? ''),
          connections: Array.isArray(descObj.connections) ? descObj.connections : [],
          lukerDedicatedChars: [],
          isLukerCharacterOnly: false,
          avatarUrl: resolvePersonaAvatarUrl(diskFile),
          isActive: diskFile === activeAvatarId,
        });
      }
    }
  }

  const list = [...resultMap.values()];
  for (const item of list) {
    const meta = ensureProfileMeta(item.avatarId);
    const mergedCharNames = new Set(meta.boundCharacters.filter(Boolean));

    for (const cName of item.lukerDedicatedChars || []) {
      if (cName) mergedCharNames.add(cName);
    }

    for (const conn of item.connections) {
      if (!conn?.id) continue;
      if (conn.type === 'character') {
        const matchedChar = charByAvatar.get(conn.id);
        const charName = matchedChar?.name || String(conn.id).replace(/\.(png|webp|jpg|jpeg)$/i, '');
        if (charName) mergedCharNames.add(charName);
      } else if (conn.type === 'group') {
        const gName = groupById.get(String(conn.id));
        if (gName) mergedCharNames.add(gName);
      }
    }

    meta.boundCharacters = [...mergedCharNames];
    item.meta = meta;
    item.resolvedChars = meta.boundCharacters.map((cName) => {
      const found = charByNameLower.get(cName.toLowerCase());
      return {
        name: cName,
        avatar: found?.avatar || '',
        avatarUrl: found?.avatarUrl || '',
        isCurrent: Boolean(found?.isCurrent),
      };
    });
  }
  return list;
}

/**
 * 核心：自动分组构建器
 * 1. 如果一个角色卡下面绑了多个（或任意）User，这些 User 自动归为以该角色卡命名的一组！
 * 2. 同时合并用户创建的「自定义分组」。
 * 3. 既没绑角色也没进自定义分组的 User 归入「未分组」。
 */
function buildUnifiedPersonaGroups(personas) {
  const settings = getSettings();
  const hostChars = getHostCharacters();
  const charByNameLower = new Map(hostChars.map((c) => [c.name.toLowerCase(), c]));
  const currentChar = getCurrentCharacter();

  // 1. 收集所有绑定了 User 的角色，自动聚合成「角色分组」
  const charBuckets = new Map();
  for (const p of personas) {
    for (const cName of p.meta.boundCharacters) {
      const clean = String(cName || '').trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (!charBuckets.has(key)) {
        const hostChar = charByNameLower.get(key);
        charBuckets.set(key, {
          id: `char:${clean}`,
          type: 'character',
          name: hostChar?.name || clean,
          avatarUrl: hostChar?.avatarUrl || '',
          isCurrentChar: Boolean(
            currentChar && currentChar.name.toLowerCase() === key
          ),
          members: [],
        });
      }
      charBuckets.get(key).members.push(p);
    }
  }

  // 排序角色自动分组：当前聊天角色置顶 -> 绑定了多个 User 的角色组优先 -> 按人数降序 -> 名称排序
  const characterGroups = [...charBuckets.values()].sort((a, b) => {
    if (a.isCurrentChar !== b.isCurrentChar) return a.isCurrentChar ? -1 : 1;
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  // 2. 收集所有「自定义分组」
  const customGroupNames = new Set(settings.groups.filter(Boolean));
  for (const p of personas) {
    if (p.meta.group && p.meta.group.trim()) {
      customGroupNames.add(p.meta.group.trim());
    }
  }

  const customGroups = [...customGroupNames].map((gName) => ({
    id: `group:${gName}`,
    type: 'group',
    name: gName,
    members: personas.filter((p) => p.meta.group === gName),
  }));

  // 3. 收集既不在任何角色组、也不在任何自定义组里的「未分组」User
  const ungroupedMembers = personas.filter(
    (p) => p.meta.boundCharacters.length === 0 && !p.meta.group
  );

  return {
    characterGroups,
    customGroups,
    ungroupedMembers,
  };
}

/**
 * 将某个 User 绑定到指定角色名（同时开启酒馆原生 persona_allow_multi_connections 并写入 connections）
 */
async function bindPersonaToCharacter(avatarId, characterName, { skipRefresh = false } = {}) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  if (!meta.boundCharacters.some((c) => c.toLowerCase() === cleanName.toLowerCase())) {
    meta.boundCharacters.push(cleanName);
  }

  try {
    const context = getContext();
    const rawChars =
      Array.isArray(context.characters) && context.characters.length > 0
        ? context.characters
        : state.cachedHostCharacters;
    const rawChar = rawChars.find(
      (c) => String(c?.name || '').trim().toLowerCase() === cleanName.toLowerCase()
    );
    const pu = context.powerUserSettings || globalThis.power_user;

    if (pu) {
      pu.persona_allow_multi_connections = true;
      const multiChk = document.querySelector('#persona_allow_multi_connections');
      if (multiChk) multiChk.checked = true;
    }

    // 1. 若在 Luker 环境（存在 setCharacterDedicatedPersonaEntries），同步写入角色卡的 dedicated_personas
    if (
      rawChar?.avatar &&
      typeof state.hostPersonasModule?.setCharacterDedicatedPersonaEntries === 'function'
    ) {
      const existingPersona = getHostPersonas().find((p) => p.avatarId === avatarId);
      const currentDedicated = extractLukerDedicatedPersonas(rawChar);
      if (!currentDedicated.some((e) => String(e?.avatar || '').trim() === avatarId)) {
        const nextEntries = [
          ...currentDedicated,
          {
            avatar: avatarId,
            name: existingPersona?.name || pu?.personas?.[avatarId] || avatarId,
            description: existingPersona?.description ?? pu?.persona_descriptions?.[avatarId]?.description ?? '',
            position: existingPersona?.position ?? 0,
            depth: existingPersona?.depth ?? 2,
            role: existingPersona?.role ?? 0,
            lorebook: existingPersona?.lorebook ?? pu?.persona_descriptions?.[avatarId]?.lorebook ?? '',
            title: existingPersona?.title ?? '',
          },
        ];
        await state.hostPersonasModule.setCharacterDedicatedPersonaEntries(
          rawChar.avatar,
          nextEntries
        );
      }
    } else if (rawChar?.avatar && pu) {
      // 2. 标准 SillyTavern 环境：写入 power_user.persona_descriptions[avatarId].connections
      if (!pu.persona_descriptions) pu.persona_descriptions = {};
      if (!pu.persona_descriptions[avatarId]) {
        pu.persona_descriptions[avatarId] = {
          description: '',
          position: 0,
          depth: 2,
          role: 0,
          lorebook: '',
          title: '',
          connections: [],
        };
      }
      if (!Array.isArray(pu.persona_descriptions[avatarId].connections)) {
        pu.persona_descriptions[avatarId].connections = [];
      }
      const conns = pu.persona_descriptions[avatarId].connections;
      if (!conns.some((c) => c.type === 'character' && c.id === rawChar.avatar)) {
        conns.push({ type: 'character', id: rawChar.avatar });
      }
    }

    if (!skipRefresh) {
      state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
      state.hostPersonasModule?.updatePersonaUIStates?.();
    }
  } catch (_e) {}

  if (!skipRefresh) {
    invalidateRenderedHtmlCache();
    saveSettings();
    refreshAllViews();
  }
}

async function unbindPersonaFromCharacter(avatarId, characterName, { skipRefresh = false } = {}) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  meta.boundCharacters = meta.boundCharacters.filter(
    (c) => c.toLowerCase() !== cleanName.toLowerCase()
  );

  try {
    const context = getContext();
    const rawChars =
      Array.isArray(context.characters) && context.characters.length > 0
        ? context.characters
        : state.cachedHostCharacters;
    const rawChar = rawChars.find(
      (c) => String(c?.name || '').trim().toLowerCase() === cleanName.toLowerCase()
    );
    const pu = context.powerUserSettings || globalThis.power_user;

    // 1. Luker 环境：同步从 character.data.extensions.luker.dedicated_personas 移除（并默认恢复回全局）
    if (
      rawChar?.avatar &&
      typeof state.hostPersonasModule?.setCharacterDedicatedPersonaEntries === 'function'
    ) {
      const currentDedicated = extractLukerDedicatedPersonas(rawChar);
      const nextEntries = currentDedicated.filter(
        (e) => String(e?.avatar || '').trim() !== avatarId
      );
      if (nextEntries.length !== currentDedicated.length) {
        await state.hostPersonasModule.setCharacterDedicatedPersonaEntries(
          rawChar.avatar,
          nextEntries,
          { restoreRemovedToGlobal: true }
        );
      }
    }

    // 2. 标准 SillyTavern 环境：从 connections 移除
    if (rawChar?.avatar && Array.isArray(pu?.persona_descriptions?.[avatarId]?.connections)) {
      pu.persona_descriptions[avatarId].connections =
        pu.persona_descriptions[avatarId].connections.filter(
          (c) => !(c.type === 'character' && c.id === rawChar.avatar)
        );
    }
    if (!skipRefresh) {
      state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
      state.hostPersonasModule?.updatePersonaUIStates?.();
    }
  } catch (_e) {}

  if (!skipRefresh) {
    invalidateRenderedHtmlCache();
    saveSettings();
    refreshAllViews();
  }
}

function getValidMultiSelectedIds() {
  const validSet = new Set(getHostPersonas().map((p) => p.avatarId));
  for (const id of [...state.multiSelectedIds]) {
    if (!validSet.has(id)) {
      state.multiSelectedIds.delete(id);
    }
  }
  return [...state.multiSelectedIds];
}

/**
 * 原位刷新多选勾选状态与工具栏数字（零 innerHTML 重建、零列表回顶）
 */
function syncMultiSelectionDomInPlace() {
  const count = state.multiSelectedIds.size;
  const hasAny = count > 0;

  document
    .querySelectorAll(
      '#st_pw_inline_left_panel .st-pw-persona-item[data-avatar-id], #st_pw_wardrobe_modal .st-pw-persona-item[data-avatar-id]'
    )
    .forEach((row) => {
      const id = row.getAttribute('data-avatar-id') || '';
      const checked = state.multiSelectedIds.has(id);
      row.classList.toggle('is-multi-checked', checked);
      const chk = row.querySelector('.st-pw-multi-check');
      if (chk && chk.checked !== checked) {
        chk.checked = checked;
      }
    });

  document.querySelectorAll('.st-pw-multi-count-num').forEach((el) => {
    el.textContent = String(count);
  });

  document.querySelectorAll('.st-pw-toggle-multi-btn').forEach((btn) => {
    if (state.multiSelectMode) {
      btn.classList.add('is-active-mode');
      btn.innerHTML = `<i class="fa-solid fa-check-double"></i> 完成${count > 0 ? ` (${count})` : ''}`;
    } else {
      btn.classList.remove('is-active-mode');
      btn.innerHTML = `<i class="fa-regular fa-square-check"></i> 多选`;
    }
  });

  document
    .querySelectorAll(
      '.st-pw-multi-group-select, .st-pw-multi-char-select, .st-pw-multi-book-select, .st-pw-multi-fav-on, .st-pw-multi-fav-off, .st-pw-multi-delete, .st-pw-multi-clear'
    )
    .forEach((ctrl) => {
      ctrl.disabled = !hasAny;
    });
}

async function executeBatchMoveToGroup(rawTargetGroup) {
  const ids = getValidMultiSelectedIds();
  if (ids.length === 0) return;

  const settings = getSettings();
  let finalGroup = '';

  if (rawTargetGroup === '__new__') {
    const entered = await promptUserText('新建自定义分组并批量移入', '', {
      subtitle: `将当前选中的 ${ids.length} 个 User 一并移入新分组`,
      placeholder: '输入新分组名称…',
    });
    if (!entered || !entered.trim()) return;
    finalGroup = entered.trim();
    if (!settings.groups.includes(finalGroup)) {
      settings.groups.push(finalGroup);
    }
  } else if (rawTargetGroup === '__ungroup__') {
    finalGroup = '';
  } else {
    finalGroup = String(rawTargetGroup || '').trim();
    if (!finalGroup) return;
  }

  for (const id of ids) {
    const meta = ensureProfileMeta(id);
    meta.group = finalGroup;
  }
  if (finalGroup) {
    state.collapsedSections.delete(`group:${finalGroup}`);
  }
  // 批量归组后自动清空勾选并保持多选开启，方便紧接着勾选下一批人设归入其他分组！
  state.multiSelectedIds.clear();
  invalidateRenderedHtmlCache();
  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(
    finalGroup
      ? `已将 ${ids.length} 个 User 移入分组「${finalGroup}」`
      : `已将 ${ids.length} 个 User 移出自定义分组`
  );
}

async function executeBatchCharacterAction(rawAction) {
  const ids = getValidMultiSelectedIds();
  if (ids.length === 0 || !rawAction) return;

  if (rawAction === '__clear_all_chars__') {
    if (
      !(await confirmUserAction(
        '批量解绑角色卡',
        `确定清空所选 ${ids.length} 个 User 身上的全部角色连线/绑定吗？`
      ))
    ) {
      return;
    }
    const allPersonas = getHostPersonas();
    const personaMap = new Map(allPersonas.map((p) => [p.avatarId, p]));
    for (const id of ids) {
      const p = personaMap.get(id);
      const boundList = [...(p?.meta?.boundCharacters || [])];
      for (const cName of boundList) {
        await unbindPersonaFromCharacter(id, cName, { skipRefresh: true });
      }
      const meta = ensureProfileMeta(id);
      meta.boundCharacters = [];
      try {
        const pu = getContext().powerUserSettings || globalThis.power_user;
        if (Array.isArray(pu?.persona_descriptions?.[id]?.connections)) {
          pu.persona_descriptions[id].connections = [];
        }
      } catch (_e) {}
    }
    state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
    state.hostPersonasModule?.updatePersonaUIStates?.();
    state.multiSelectedIds.clear();
    invalidateRenderedHtmlCache();
    saveSettings();
    refreshAllViews();
    globalThis.toastr?.success?.(`已清空 ${ids.length} 个 User 的全部角色绑定`);
    return;
  }

  let targetCharName = rawAction;
  if (rawAction === '__custom_char__') {
    const entered = await promptUserText('批量绑定到角色名', '', {
      subtitle: `将选中的 ${ids.length} 个 User 绑定到同一角色组`,
      placeholder: '输入角色名称…',
    });
    if (!entered || !entered.trim()) return;
    targetCharName = entered.trim();
  }

  await probeHostModules();
  for (const id of ids) {
    await bindPersonaToCharacter(id, targetCharName, { skipRefresh: true });
  }
  state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
  state.hostPersonasModule?.updatePersonaUIStates?.();
  state.collapsedSections.delete(`char:${targetCharName}`);
  state.multiSelectedIds.clear();
  invalidateRenderedHtmlCache();
  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(`已将 ${ids.length} 个 User 绑定到角色「${targetCharName}」`);
}

async function executeBatchWorldbookAction(rawBook) {
  const ids = getValidMultiSelectedIds();
  if (ids.length === 0 || !rawBook) return;
  const nextBook = rawBook === '__clear_book__' ? '' : String(rawBook).trim();

  await probeHostModules();
  for (const id of ids) {
    await updateHostPersonaData(id, { lorebook: nextBook });
  }
  invalidateRenderedHtmlCache();
  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(
    nextBook
      ? `已为 ${ids.length} 个 User 批量绑定主世界书「${nextBook}」`
      : `已解绑 ${ids.length} 个 User 的主世界书`
  );
}

function executeBatchFavorite(favState) {
  const ids = getValidMultiSelectedIds();
  if (ids.length === 0) return;
  for (const id of ids) {
    const meta = ensureProfileMeta(id);
    meta.favorite = Boolean(favState);
  }
  invalidateRenderedHtmlCache();
  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(
    favState ? `已批量收藏 ${ids.length} 个 User` : `已取消 ${ids.length} 个 User 的收藏`
  );
}

async function executeBatchDeletePersonas() {
  const ids = getValidMultiSelectedIds();
  if (ids.length === 0) return;

  const activeId = getActiveAvatarId();
  const protectedIds = [];
  const deletableIds = [];
  for (const id of ids) {
    if (id === 'user-default.png' || id === activeId || id.startsWith('luker_dedicated__')) {
      protectedIds.push(id);
    } else {
      deletableIds.push(id);
    }
  }

  if (deletableIds.length === 0) {
    globalThis.toastr?.warning?.('当前正在使用的人设与系统默认人设受保护，不可在批量操作中直接删除');
    return;
  }

  const allPersonas = getHostPersonas();
  const nameById = new Map(allPersonas.map((p) => [p.avatarId, p.name]));
  const previewNames = deletableIds
    .slice(0, 6)
    .map((id) => nameById.get(id) || id)
    .join('、');
  const skipHint =
    protectedIds.length > 0
      ? `\n（已自动跳过 ${protectedIds.length} 个当前使用中/默认保护人设）`
      : '';

  if (
    !(await confirmUserAction(
      `批量删除 ${deletableIds.length} 个人设`,
      `确定永久删除「${previewNames}${deletableIds.length > 6 ? '…' : ''}」共 ${deletableIds.length} 个人设及其头像吗？此操作不可撤销！${skipHint}`
    ))
  ) {
    return;
  }

  const context = getContext();
  const headers =
    typeof context.getRequestHeaders === 'function'
      ? context.getRequestHeaders()
      : { 'Content-Type': 'application/json' };
  const pu = context.powerUserSettings || globalThis.power_user || {};
  const settings = getSettings();

  let deletedCount = 0;
  for (const id of deletableIds) {
    try {
      const res = await fetch('/api/avatars/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ avatar: id }),
      });
      if (res.ok) {
        deletedCount++;
        if (pu.personas) delete pu.personas[id];
        if (pu.persona_descriptions) delete pu.persona_descriptions[id];
        if (pu.default_persona === id) pu.default_persona = null;
        delete settings.profiles[id];
        if (settings.avatarUrlCache) delete settings.avatarUrlCache[id];
        state.multiSelectedIds.delete(id);
      }
    } catch (err) {
      console.warn(`[${MODULE_ID}] 批量删除 ${id} 跳过:`, err);
    }
  }

  await refreshDiskAvatarSet();
  try {
    await state.hostPersonasModule?.getUserAvatars?.(true, getActiveAvatarId());
  } catch (_e) {}
  invalidateRenderedHtmlCache();
  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(
    `已成功批量删除 ${deletedCount} 个人设${protectedIds.length ? `（保留 ${protectedIds.length} 个受保护项）` : ''}`
  );
}

async function switchActivePersona(avatarId) {
  if (!avatarId) return false;
  await probeHostModules();
  const personas = getHostPersonas();
  const target = personas.find((p) => p.avatarId === avatarId);

  if (typeof state.hostPersonasModule?.setUserAvatar === 'function') {
    await state.hostPersonasModule.setUserAvatar(avatarId);
    globalThis.toastr?.success?.(`已切换：${target?.name || avatarId}`);
    refreshAllViews();
    return true;
  }

  const escapedId = CSS.escape ? CSS.escape(avatarId) : avatarId.replaceAll('"', '\\"');
  const domAvatar = document.querySelector(
    `#user_avatar_block .avatar-container[data-avatar-id="${escapedId}"]`
  );
  if (domAvatar) {
    domAvatar.click();
    globalThis.toastr?.success?.(`已切换：${target?.name || avatarId}`);
    refreshAllViews();
    return true;
  }

  try {
    const context = getContext();
    if (typeof context.executeSlashCommandsWithOptions === 'function') {
      await context.executeSlashCommandsWithOptions(`/persona-set mode=lookup "${avatarId}"`);
      globalThis.toastr?.success?.(`已切换：${target?.name || avatarId}`);
      refreshAllViews();
      return true;
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] /persona-set 切换失败:`, err);
  }

  return false;
}

async function updateHostPersonaData(avatarId, { description, lorebook }) {
  try {
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
    const isCurrent = avatarId === getActiveAvatarId();
    const isGlobal = Boolean(pu?.personas && Object.hasOwn(pu.personas, avatarId));

    if (pu) {
      if (isGlobal || !pu.persona_descriptions?.[avatarId]) {
        if (!pu.persona_descriptions) pu.persona_descriptions = {};
        if (isGlobal && !pu.persona_descriptions[avatarId]) {
          pu.persona_descriptions[avatarId] = {
            description: '',
            position: 0,
            depth: 2,
            role: 0,
            lorebook: '',
            title: '',
            connections: [],
          };
        }
      }
      if (description !== undefined) {
        if (pu.persona_descriptions?.[avatarId]) {
          pu.persona_descriptions[avatarId].description = description;
        }
        if (isCurrent) {
          pu.persona_description = description;
        }
      }
      if (lorebook !== undefined) {
        if (pu.persona_descriptions?.[avatarId]) {
          pu.persona_descriptions[avatarId].lorebook = lorebook;
        }
        if (isCurrent) {
          pu.persona_description_lorebook = lorebook;
        }
      }
    }

    // Luker 兼容：如果该 User 也存在于某些角色卡的 dedicated_personas 中，同步更新角色卡内的 dedicated_personas
    if (typeof state.hostPersonasModule?.setCharacterDedicatedPersonaEntries === 'function') {
      const rawChars = Array.isArray(context.characters) ? context.characters : [];
      for (const rawChar of rawChars) {
        if (!rawChar?.avatar) continue;
        const dedicated = extractLukerDedicatedPersonas(rawChar);
        const idx = dedicated.findIndex((e) => String(e?.avatar || '').trim() === avatarId);
        if (idx !== -1) {
          const nextEntries = dedicated.map((e, i) => {
            if (i !== idx) return e;
            return {
              ...e,
              ...(description !== undefined ? { description } : {}),
              ...(lorebook !== undefined ? { lorebook } : {}),
            };
          });
          await state.hostPersonasModule.setCharacterDedicatedPersonaEntries(
            rawChar.avatar,
            nextEntries
          );
        }
      }
    }

    if (isCurrent) {
      if (description !== undefined) {
        const descInput = document.querySelector('#persona_description');
        if (descInput && descInput.value !== description) {
          descInput.value = description;
          descInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (lorebook !== undefined) {
        const loreBtn = document.querySelector('#persona_lore_button');
        if (loreBtn) {
          loreBtn.classList.toggle('world_set', Boolean(lorebook));
        }
        const loreSelect = document.querySelector('#persona_description_lorebook');
        if (loreSelect) {
          loreSelect.value = lorebook || '';
        }
      }
      state.hostPersonasModule?.setPersonaDescription?.();
    }

    saveSettings();
    refreshAllViews();
    return true;
  } catch (err) {
    console.error(`[${MODULE_ID}] 更新 Persona 数据失败:`, err);
    return false;
  }
}

/**
 * 捕获当前 User 的状态快照（含原生描述、主世界书及其各条目开关/常驻状态、附加世界书、随身设定）
 */
async function captureCurrentPersonaSnapshot(persona, presetName, existingId = null) {
  const cleanName = String(presetName || '').trim();
  if (!persona || !cleanName) return null;

  let liveDesc = persona.description || '';
  if (persona.isActive) {
    const descEl = document.querySelector('#persona_description');
    if (descEl && typeof descEl.value === 'string') {
      liveDesc = descEl.value;
    }
  }

  const primaryBook = persona.lorebook || '';
  const primaryEntryStates = {};
  if (primaryBook) {
    try {
      const worldData = await fetchWorldbookData(primaryBook);
      for (const [key, entry] of Object.entries(worldData?.entries || {})) {
        if (entry && typeof entry === 'object') {
          primaryEntryStates[key] = {
            disable: Boolean(entry.disable),
            constant: Boolean(entry.constant),
          };
        }
      }
    } catch (err) {
      console.warn(`[${MODULE_ID}] 快照读取主世界书条目状态跳过:`, err);
    }
  }

  return {
    id: existingId || `preset_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    updatedAt: Date.now(),
    description: liveDesc,
    lorebook: primaryBook,
    primaryEntryStates,
    extraWorldbooks: structuredClone(persona.meta.extraWorldbooks || []),
    traits: structuredClone(persona.meta.traits || []),
  };
}

/**
 * 一键应用/恢复某套状态快照预设
 */
async function applyPersonaSnapshotPreset(persona, presetId) {
  if (!persona) return false;
  const meta = ensureProfileMeta(persona.avatarId);
  const preset = meta.presets.find((p) => p.id === presetId);
  if (!preset) return false;

  meta.extraWorldbooks = structuredClone(preset.extraWorldbooks || []);
  meta.traits = structuredClone(preset.traits || []);
  meta.activePresetId = preset.id;

  const targetBook = preset.lorebook !== undefined ? preset.lorebook : persona.lorebook;
  const targetDesc = preset.description !== undefined ? preset.description : persona.description;

  updateHostPersonaData(persona.avatarId, {
    description: targetDesc,
    lorebook: targetBook,
  });

  // 如果快照里保存了主世界书各条目的启用/常驻状态，同步还原
  const entryStates = preset.primaryEntryStates;
  if (targetBook && entryStates && typeof entryStates === 'object' && Object.keys(entryStates).length > 0) {
    try {
      const worldData = await fetchWorldbookData(targetBook);
      let changed = false;
      for (const [key, savedState] of Object.entries(entryStates)) {
        if (worldData?.entries?.[key] && savedState) {
          if (Boolean(worldData.entries[key].disable) !== Boolean(savedState.disable)) {
            worldData.entries[key].disable = Boolean(savedState.disable);
            changed = true;
          }
          if (Boolean(worldData.entries[key].constant) !== Boolean(savedState.constant)) {
            worldData.entries[key].constant = Boolean(savedState.constant);
            changed = true;
          }
        }
      }
      if (changed) {
        await saveWorldbookData(targetBook, worldData);
      }
    } catch (err) {
      console.warn(`[${MODULE_ID}] 还原快照主世界书条目开关失败:`, err);
    }
  }

  saveSettings();
  refreshAllViews();
  globalThis.toastr?.success?.(`已切换至状态快照「${preset.name}」`);
  return true;
}

/**
 * 完整克隆 User 变体（连带头像文件、人设描述、主世界书、附加世界书、随身设定、所属自定义组、绑定角色组与全部快照预设）
 */
async function clonePersonaVariant(sourcePersona, { customName = '', fromPreset = null } = {}) {
  if (!sourcePersona) return null;
  await probeHostModules();

  const defaultVariantName = fromPreset
    ? `${sourcePersona.name} (${fromPreset.name})`
    : `${sourcePersona.name} (变体)`;
  const rawName =
    customName ||
    (await promptUserText('输入克隆出的新 User 变体名称', defaultVariantName, {
      subtitle: '将连同头像、世界书、随身设定与状态快照完整克隆',
    }));
  if (!rawName || !rawName.trim()) return null;
  const cleanName = rawName.trim();

  const asciiSlug = cleanName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'variant';
  const newAvatarId = `${Date.now()}-${asciiSlug}.png`;

  const context = getContext();
  const pu = context.powerUserSettings;

  // 1. 克隆头像文件到服务端 /api/avatars/upload
  try {
    let avatarBlob = null;
    for (const candidateUrl of [
      sourcePersona.avatarUrl,
      `/User Avatars/${encodeURIComponent(sourcePersona.avatarId)}`,
      '/img/ai4.png',
    ]) {
      if (!candidateUrl) continue;
      try {
        const res = await fetch(candidateUrl);
        if (res.ok) {
          avatarBlob = await res.blob();
          break;
        }
      } catch (_e) {}
    }

    if (avatarBlob) {
      const file = new File([avatarBlob], 'avatar.png', {
        type: avatarBlob.type || 'image/png',
      });
      const formData = new FormData();
      formData.append('avatar', file);
      formData.append('overwrite_name', newAvatarId);

      const headers =
        typeof context.getRequestHeaders === 'function'
          ? { ...context.getRequestHeaders({ omitContentType: true }) }
          : {};
      delete headers['Content-Type'];
      delete headers['content-type'];

      await fetch('/api/avatars/upload', {
        method: 'POST',
        headers,
        cache: 'no-cache',
        body: formData,
      });
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] 克隆头像上传警告（将继续写入人设记录）:`, err);
  }

  // 2. 写入宿主 Persona 数据
  const targetDesc =
    fromPreset && fromPreset.description !== undefined
      ? fromPreset.description
      : sourcePersona.description || '';
  const targetLorebook =
    fromPreset && fromPreset.lorebook !== undefined
      ? fromPreset.lorebook
      : sourcePersona.lorebook || '';

  const sourceDescriptor = pu?.persona_descriptions?.[sourcePersona.avatarId] || {};
  const pos = sourceDescriptor.position ?? 0;
  const depth = sourceDescriptor.depth ?? 2;
  const role = sourceDescriptor.role ?? 0;

  if (typeof state.hostPersonasModule?.initPersona === 'function') {
    try {
      await state.hostPersonasModule.initPersona(newAvatarId, cleanName, targetDesc, '', {
        position: pos,
        depth,
        role,
        lorebook: targetLorebook,
      });
    } catch (_e) {}
  }

  if (pu) {
    if (!pu.personas) pu.personas = {};
    if (!pu.persona_descriptions) pu.persona_descriptions = {};
    pu.personas[newAvatarId] = cleanName;
    pu.persona_descriptions[newAvatarId] = {
      description: targetDesc,
      position: pos,
      depth,
      role,
      lorebook: targetLorebook,
      title: '',
      connections: structuredClone(sourceDescriptor.connections || []),
    };
  }

  // 3. 完整克隆扩展 Profile 元数据（分组、标签、角色绑定、附加世界书、随身设定、状态快照）
  const settings = getSettings();
  const srcMeta = sourcePersona.meta;
  settings.profiles[newAvatarId] = {
    favorite: Boolean(srcMeta.favorite),
    group: srcMeta.group || '',
    tags: [...(srcMeta.tags || [])],
    boundCharacters: [...(srcMeta.boundCharacters || [])],
    note: srcMeta.note || '',
    extraWorldbooks: structuredClone(
      fromPreset ? fromPreset.extraWorldbooks || [] : srcMeta.extraWorldbooks || []
    ),
    traits: structuredClone(fromPreset ? fromPreset.traits || [] : srcMeta.traits || []),
    presets: structuredClone(srcMeta.presets || []),
    activePresetId: fromPreset ? fromPreset.id : srcMeta.activePresetId || '',
  };

  // 4. 如果原 User 绑定了角色组（含 Luker dedicated_personas 或标准 connections），同步把新变体也绑入对应角色组
  for (const charName of srcMeta.boundCharacters || []) {
    await bindPersonaToCharacter(newAvatarId, charName);
  }

  saveSettings();

  if (state.diskAvatarSet instanceof Set) {
    state.diskAvatarSet.add(newAvatarId);
  }
  await refreshDiskAvatarSet();

  try {
    await state.hostPersonasModule?.getUserAvatars?.(true, newAvatarId);
  } catch (_e) {}

  state.selectedAvatarId = newAvatarId;
  await switchActivePersona(newAvatarId);
  refreshAllViews();
  globalThis.toastr?.success?.(`已完整克隆变体「${cleanName}」`);
  return newAvatarId;
}

async function jumpToWorldbookInHost(
  worldbookName,
  { fromWardrobeModal = false, uid = null } = {}
) {
  const targetName = String(worldbookName || '').trim();
  if (!targetName) {
    globalThis.toastr?.warning?.('当前未绑定世界书');
    return false;
  }

  await probeHostModules();

  const hasEntryUid =
    uid !== null && uid !== undefined && String(uid).trim() !== '';
  let jumped = false;
  let openedViaTauriEntryApi = false;

  // 1. TauriTavern 官方公开契约：若指定了条目 uid，优先调用 window.__TAURITAVERN__.api.worldInfo.openEntry({ world, uid })
  if (
    hasEntryUid &&
    typeof globalThis.__TAURITAVERN__?.api?.worldInfo?.openEntry === 'function'
  ) {
    try {
      const normalizedUid = Number.isFinite(Number(uid)) ? Number(uid) : String(uid).trim();
      const res = await globalThis.__TAURITAVERN__.api.worldInfo.openEntry({
        world: targetName,
        uid: normalizedUid,
      });
      if (res?.opened) {
        jumped = true;
        openedViaTauriEntryApi = true;
      }
    } catch (err) {
      console.warn(`[${MODULE_ID}] TauriTavern worldInfo.openEntry 降级:`, err);
    }
  }

  if (!jumped && typeof state.hostWorldInfoModule?.openWorldInfoEditor === 'function') {
    try {
      await state.hostWorldInfoModule.openWorldInfoEditor(targetName);
      jumped = true;
    } catch (_err) {}
  }

  if (!jumped) {
    const wiDrawerContent =
      document.querySelector('#WorldInfo') ||
      document.querySelector('#world_info');
    if (wiDrawerContent && !isElementVisible(wiDrawerContent)) {
      const wiToggle =
        document.querySelector('#WIDrawerIcon') ||
        document.querySelector('#WI_button .drawer-toggle') ||
        document.querySelector('#WI_button');
      wiToggle?.click();
    }

    try {
      const context = getContext();
      if (typeof context.reloadWorldInfoEditor === 'function') {
        context.reloadWorldInfoEditor(targetName, true);
      }
    } catch (_e) {}

    const editorSelect = document.querySelector('#world_editor_select');
    if (editorSelect) {
      let matchedValue = null;
      for (const opt of editorSelect.options) {
        const optText = (opt.textContent || '').trim();
        const optVal = (opt.value || '').trim();
        if (optText === targetName || optVal === targetName) {
          matchedValue = opt.value;
          break;
        }
      }
      if (matchedValue !== null) {
        editorSelect.value = matchedValue;
        if (globalThis.jQuery) {
          globalThis.jQuery(editorSelect).trigger('change');
        } else {
          editorSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        jumped = true;
      }
    }
  }

  if (!jumped) {
    globalThis.toastr?.warning?.(`未找到世界书「${targetName}」`);
    return false;
  }

  // 标准 SillyTavern / Luker 下若指定了 uid，在打开世界书抽屉后自动滚动定位到对应条目
  if (hasEntryUid && !openedViaTauriEntryApi) {
    const uidStr = String(uid).trim();
    setTimeout(() => {
      try {
        const escapedUid = CSS.escape ? CSS.escape(uidStr) : uidStr.replaceAll('"', '\\"');
        const entryEl = document.querySelector(
          `#world_popup_entries_list .world_entry[uid="${escapedUid}"], #world_popup_entries_list [uid="${escapedUid}"]`
        );
        if (entryEl instanceof HTMLElement) {
          entryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          entryEl.style.outline = '2px solid rgba(255, 215, 110, 0.75)';
          setTimeout(() => {
            entryEl.style.outline = '';
          }, 1800);
        }
      } catch (_e) {}
    }, 220);
  }

  if (fromWardrobeModal) {
    const modal = document.querySelector('#st_pw_wardrobe_modal');
    if (modal && !modal.classList.contains('st-pw-hidden')) {
      modal.classList.add('st-pw-hidden');
      showReturnToWardrobePill(targetName, { returnTo: 'modal' });
    } else {
      showReturnToWardrobePill(targetName, { returnTo: 'native' });
    }
  } else {
    showReturnToWardrobePill(targetName, { returnTo: 'native' });
  }

  return true;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
}

function bindModalBackdropEvents(modal) {
  if (!modal || modal.dataset.backdropBound === '1') return;
  modal.dataset.backdropBound = '1';

  // 点击/轻触遮罩空白处直接关闭弹窗
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('st-pw-hidden');
    }
  });

  // 阻止 touchstart / mousedown 冒泡到 html，避免触发 Luker 全局抽屉自动收起逻辑
  modal.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  modal.addEventListener(
    'touchstart',
    (e) => {
      e.stopPropagation();
    },
    { passive: true }
  );
}

function closeTopmostWardrobeModal() {
  const modalIds = [
    '#st_pw_preview_modal',
    '#st_pw_wb_inspector_modal',
    '#st_pw_wardrobe_modal',
  ];
  for (const sel of modalIds) {
    const el = document.querySelector(sel);
    if (el && !el.classList.contains('st-pw-hidden')) {
      el.classList.add('st-pw-hidden');
      return true;
    }
  }
  return false;
}

function openNativePersonaDrawer({ fromWandClick = false } = {}) {
  removeReturnToWardrobePill();
  if (!fromWandClick) {
    const extMenu = document.querySelector('#extensionsMenu');
    const extBtn = document.querySelector('#extensionsMenuButton');
    if (extMenu && window.getComputedStyle(extMenu).display !== 'none') {
      if (extBtn) {
        extBtn.click();
      } else {
        extMenu.style.display = 'none';
      }
    }
  }
  if (!state.diskAvatarFetched || !state.diskAvatarSet || state.diskAvatarSet.size === 0) {
    refreshDiskAvatarSet().then(() => {
      invalidateRenderedHtmlCache();
      refreshAllViews();
    });
  }
  const drawerContent = document.querySelector('#PersonaManagement');
  const drawerToggle =
    document.querySelector('#persona-management-button > .drawer-toggle') ||
    document.querySelector('#persona-management-button .drawer-icon');
  if (drawerContent && drawerToggle) {
    if (!drawerContent.classList.contains('openDrawer')) {
      drawerToggle.click();
    }
    syncNativePersonaPanelEnhancement();
    return true;
  }
  openWardrobeModal();
  return false;
}

function showReturnToWardrobePill(bookName, { returnTo = 'native' } = {}) {
  removeReturnToWardrobePill();
  const pill = document.createElement('div');
  pill.id = 'st_pw_return_pill';
  pill.className = 'menu_button st-pw-return-pill';
  pill.innerHTML = `
    <span class="st-pw-return-pill-main" title="返回 User 人设栏目">
      <i class="fa-solid fa-arrow-left"></i>
      <span>返回人设管理 (${sanitizeHtml(bookName)})</span>
    </span>
    <span class="st-pw-return-pill-close" title="关闭此悬浮按钮">
      <i class="fa-solid fa-xmark"></i>
    </span>
  `;
  pill.querySelector('.st-pw-return-pill-main')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeReturnToWardrobePill();
    if (returnTo === 'modal') {
      openWardrobeModal();
    } else {
      openNativePersonaDrawer();
    }
  });
  pill.querySelector('.st-pw-return-pill-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeReturnToWardrobePill();
  });
  document.body.appendChild(pill);
  state.minimizedReturnPill = pill;
}

function removeReturnToWardrobePill() {
  if (state.minimizedReturnPill) {
    state.minimizedReturnPill.remove();
    state.minimizedReturnPill = null;
  }
  document.querySelector('#st_pw_return_pill')?.remove();
}

async function fetchWorldbookData(worldbookName) {
  const name = String(worldbookName || '').trim();
  if (!name) throw new Error('世界书名称为空');

  const context = getContext();
  if (typeof context.loadWorldInfo === 'function') {
    const data = await context.loadWorldInfo(name);
    if (data && typeof data === 'object') {
      if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
      }
      state.worldbookCache.set(name, {
        fetchedAt: Date.now(),
        data,
      });
      return data;
    }
  }

  const headers =
    typeof context.getRequestHeaders === 'function'
      ? context.getRequestHeaders()
      : { 'Content-Type': 'application/json' };

  const response = await fetch('/api/worldinfo/get', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    throw new Error(`读取世界书「${name}」失败 (HTTP ${response.status})`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object') {
    throw new Error(`世界书「${name}」返回格式无效`);
  }
  if (!data.entries || typeof data.entries !== 'object') {
    data.entries = {};
  }
  state.worldbookCache.set(name, {
    fetchedAt: Date.now(),
    data,
  });
  return data;
}

async function saveWorldbookData(worldbookName, worldData) {
  const name = String(worldbookName || '').trim();
  if (!name || !worldData) throw new Error('世界书名称或数据为空');

  const context = getContext();
  if (typeof context.saveWorldInfo === 'function') {
    await context.saveWorldInfo(name, worldData, true);
    state.worldbookCache.set(name, {
      fetchedAt: Date.now(),
      data: worldData,
    });
    context.reloadWorldInfoEditor?.(name, false);
    return true;
  }

  const headers =
    typeof context.getRequestHeaders === 'function'
      ? context.getRequestHeaders()
      : { 'Content-Type': 'application/json' };

  const response = await fetch('/api/worldinfo/edit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, data: worldData }),
  });

  if (!response.ok) {
    throw new Error(`保存世界书「${name}」失败 (HTTP ${response.status})`);
  }

  state.worldbookCache.set(name, {
    fetchedAt: Date.now(),
    data: worldData,
  });

  const editorSelect = document.querySelector('#world_editor_select');
  if (editorSelect) {
    const selectedOpt = editorSelect.options?.[editorSelect.selectedIndex];
    if (selectedOpt && (selectedOpt.textContent.trim() === name || selectedOpt.value === name)) {
      globalThis.jQuery?.(editorSelect).trigger('change');
    }
  }

  return true;
}

/**
 * 世界书条目管理弹窗（紧凑表格行设计）
 */
async function openWorldbookInspectorModal(worldbookName) {
  const name = String(worldbookName || '').trim();
  if (!name) {
    globalThis.toastr?.warning?.('请先选择一本世界书');
    return;
  }

  let modal = document.querySelector('#st_pw_wb_inspector_modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'st_pw_wb_inspector_modal';
    modal.className = 'st-pw-modal-backdrop';
    document.body.appendChild(modal);
  }
  bindModalBackdropEvents(modal);

  modal.classList.remove('st-pw-hidden');
  modal.innerHTML = `
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true">
      <div class="st-pw-modal-header">
        <div class="st-pw-header-left">
          <span class="st-pw-modal-title">${sanitizeHtml(name)}</span>
          <span class="st-pw-header-meta">读取中…</span>
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-close-wb-modal" title="关闭"><i class="fa-solid fa-xmark"></i> 关闭</button>
        </div>
      </div>
      <div class="st-pw-wb-body st-pw-loading-state">
        正在加载「${sanitizeHtml(name)}」…
      </div>
    </div>
  `;

  modal.querySelector('.st-pw-close-wb-modal')?.addEventListener('click', () => {
    modal.classList.add('st-pw-hidden');
  });

  try {
    const worldData = await fetchWorldbookData(name);
    renderWorldbookInspectorContent(modal, name, worldData);
  } catch (err) {
    const bodyEl = modal.querySelector('.st-pw-wb-body');
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="st-pw-error-box">
          <p>读取失败：${sanitizeHtml(err.message)}</p>
          <button type="button" class="menu_button st-pw-fallback-jump-btn">
            在酒馆世界书编辑器中打开
          </button>
        </div>
      `;
      bodyEl.querySelector('.st-pw-fallback-jump-btn')?.addEventListener('click', () => {
        modal.classList.add('st-pw-hidden');
        jumpToWorldbookInHost(name, { fromWardrobeModal: true });
      });
    }
  }
}

function renderWorldbookInspectorContent(modal, worldbookName, worldData) {
  let searchFilter = '';
  let statusFilter = 'all';
  let expandedKey = null;

  function getEntriesArray() {
    const entriesObj = worldData.entries || {};
    return Object.entries(entriesObj)
      .map(([key, entry]) => ({
        _key: key,
        uid: entry.uid ?? Number(key),
        comment: String(entry.comment ?? ''),
        keyList: Array.isArray(entry.key) ? entry.key : [],
        content: String(entry.content ?? ''),
        constant: Boolean(entry.constant),
        disable: Boolean(entry.disable),
        order: Number(entry.order ?? 100),
        depth: Number(entry.depth ?? 4),
        raw: entry,
      }))
      .sort((a, b) => b.order - a.order || Number(a.uid) - Number(b.uid));
  }

  function redraw() {
    const allEntries = getEntriesArray();
    const enabledCount = allEntries.filter((e) => !e.disable).length;
    const constantCount = allEntries.filter((e) => !e.disable && e.constant).length;
    const keywordCount = enabledCount - constantCount;
    const disabledCount = allEntries.length - enabledCount;
    const q = searchFilter.trim().toLowerCase();

    const filtered = allEntries.filter((item) => {
      if (statusFilter === 'enabled' && item.disable) return false;
      if (statusFilter === 'constant' && (item.disable || !item.constant)) return false;
      if (statusFilter === 'keyword' && (item.disable || item.constant)) return false;
      if (statusFilter === 'disabled' && !item.disable) return false;

      if (!q) return true;
      return (
        item.comment.toLowerCase().includes(q) ||
        item.keyList.join(', ').toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
      );
    });

    modal.innerHTML = `
      <div class="st-pw-wb-dialog" role="dialog" aria-modal="true">
        <div class="st-pw-modal-header">
          <div class="st-pw-header-left">
            <span class="st-pw-modal-title">${sanitizeHtml(worldbookName)}</span>
            <span class="st-pw-header-meta">${enabledCount} / ${allEntries.length} 启用</span>
          </div>
          <div class="st-pw-modal-header-actions">
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-jump-host-btn" title="在酒馆原生世界书面板中打开">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> 原生编辑器
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-add-entry-btn">
              <i class="fa-solid fa-plus"></i> 新建条目
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-close-wb-modal" title="关闭">
              <i class="fa-solid fa-xmark"></i> 关闭
            </button>
          </div>
        </div>

        <div class="st-pw-wb-toolbar">
          <input type="search" class="text_pole st-pw-wb-search-input" placeholder="搜索标题、关键词或内容…" value="${escapeAttr(searchFilter)}" />
          <div class="st-pw-wb-filter-tabs">
            <button type="button" class="st-pw-filter-pill ${statusFilter === 'all' ? 'active' : ''}" data-filter="all">全部 (${allEntries.length})</button>
            <button type="button" class="st-pw-filter-pill ${statusFilter === 'constant' ? 'active' : ''}" data-filter="constant">常驻 (${constantCount})</button>
            <button type="button" class="st-pw-filter-pill ${statusFilter === 'keyword' ? 'active' : ''}" data-filter="keyword">关键词 (${keywordCount})</button>
            <button type="button" class="st-pw-filter-pill ${statusFilter === 'disabled' ? 'active' : ''}" data-filter="disabled">停用 (${disabledCount})</button>
          </div>
          <div class="st-pw-wb-bulk-btns">
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-enable-all">全开</button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-disable-all">全关</button>
          </div>
        </div>

        <div class="st-pw-wb-list">
          ${
            filtered.length === 0
              ? `<div class="st-pw-empty-state">无匹配条目</div>`
              : filtered
                  .map((item) => {
                    const isExpanded = expandedKey === String(item._key);
                    const modeClass = item.constant ? 'is-constant' : 'is-keyword';
                    const modeLabel = item.constant ? '常驻' : '关键词';
                    const keysText = item.constant
                      ? ''
                      : item.keyList.length
                        ? item.keyList.join(', ')
                        : '未设关键词';

                    return `
                      <div class="st-pw-wb-row ${item.disable ? 'is-disabled' : ''} ${isExpanded ? 'is-expanded' : ''}" data-entry-key="${escapeAttr(item._key)}">
                        <div class="st-pw-wb-row-bar">
                          <input type="checkbox" class="st-pw-wb-toggle-enable" data-entry-key="${escapeAttr(item._key)}" ${!item.disable ? 'checked' : ''} title="启用/停用" />
                          <button type="button" class="st-pw-mode-tag ${modeClass} st-pw-wb-toggle-constant" data-entry-key="${escapeAttr(item._key)}" title="点击切换常驻 / 关键词触发">
                            <span class="st-pw-dot"></span>${modeLabel}
                          </button>
                          <div class="st-pw-wb-row-title st-pw-wb-expand-trigger" data-entry-key="${escapeAttr(item._key)}">
                            <span class="st-pw-entry-name">${sanitizeHtml(item.comment || `(未命名 #${item.uid})`)}</span>
                            ${
                              keysText
                                ? `<span class="st-pw-entry-keys">${sanitizeHtml(keysText)}</span>`
                                : ''
                            }
                          </div>
                          <span class="st-pw-entry-order" title="插入顺序 (Order)">#${item.order}</span>
                          <button type="button" class="st-pw-icon-btn st-pw-wb-jump-entry-btn" data-entry-uid="${escapeAttr(item.uid ?? item._key)}" title="在酒馆世界书编辑器中定位此条目">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i>
                          </button>
                          <button type="button" class="st-pw-icon-btn st-pw-wb-expand-trigger" data-entry-key="${escapeAttr(item._key)}" title="展开/收起编辑">
                            <i class="fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}"></i>
                          </button>
                        </div>
                        ${
                          isExpanded
                            ? `
                              <div class="st-pw-wb-row-detail">
                                <div class="st-pw-wb-detail-grid">
                                  <div>
                                    <label>标题</label>
                                    <input type="text" class="text_pole st-pw-edit-comment" value="${escapeAttr(item.comment)}" />
                                  </div>
                                  <div>
                                    <label>触发关键词（逗号分隔）</label>
                                    <input type="text" class="text_pole st-pw-edit-keys" value="${escapeAttr(item.keyList.join(', '))}" placeholder="${item.constant ? '当前为常驻模式，无需关键词' : '输入触发词…'}" />
                                  </div>
                                  <div>
                                    <label>权重顺序 (Order)</label>
                                    <input type="number" class="text_pole st-pw-edit-order" value="${escapeAttr(item.order)}" />
                                  </div>
                                </div>
                                <div class="st-pw-form-row">
                                  <label>内容 (${item.content.length} 字)</label>
                                  <textarea class="text_pole st-pw-edit-content" rows="6">${sanitizeHtml(item.content)}</textarea>
                                </div>
                                <div class="st-pw-editor-footer">
                                  <button type="button" class="menu_button st-pw-delete-entry-btn" data-entry-key="${escapeAttr(item._key)}">
                                    删除条目
                                  </button>
                                  <button type="button" class="menu_button st-pw-primary-btn st-pw-save-entry-btn" data-entry-key="${escapeAttr(item._key)}">
                                    保存修改
                                  </button>
                                </div>
                              </div>
                            `
                            : ''
                        }
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    modal.querySelector('.st-pw-close-wb-modal')?.addEventListener('click', () => {
      modal.classList.add('st-pw-hidden');
    });

    modal.querySelector('.st-pw-wb-jump-host-btn')?.addEventListener('click', () => {
      modal.classList.add('st-pw-hidden');
      jumpToWorldbookInHost(worldbookName, { fromWardrobeModal: true });
    });

    const searchInput = modal.querySelector('.st-pw-wb-search-input');
    searchInput?.addEventListener('input', (e) => {
      searchFilter = e.target.value;
      const pos = e.target.selectionStart;
      redraw();
      const nextInput = modal.querySelector('.st-pw-wb-search-input');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(pos, pos);
      }
    });

    modal.querySelectorAll('.st-pw-filter-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        statusFilter = btn.getAttribute('data-filter') || 'all';
        redraw();
      });
    });

    modal.querySelector('.st-pw-wb-add-entry-btn')?.addEventListener('click', async () => {
      const existingKeys = Object.keys(worldData.entries || {}).map(Number).filter(Number.isFinite);
      const nextUid = existingKeys.length ? Math.max(...existingKeys) + 1 : 0;
      const keyStr = String(nextUid);
      worldData.entries[keyStr] = {
        uid: nextUid,
        key: [],
        keysecondary: [],
        comment: `新条目 #${nextUid + 1}`,
        content: '',
        constant: true,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
      };
      expandedKey = keyStr;
      statusFilter = 'all';
      await saveWorldbookData(worldbookName, worldData);
      redraw();
    });

    modal.querySelector('.st-pw-wb-enable-all')?.addEventListener('click', async () => {
      for (const item of filtered) {
        if (worldData.entries?.[item._key]) {
          worldData.entries[item._key].disable = false;
        }
      }
      await saveWorldbookData(worldbookName, worldData);
      redraw();
    });

    modal.querySelector('.st-pw-wb-disable-all')?.addEventListener('click', async () => {
      for (const item of filtered) {
        if (worldData.entries?.[item._key]) {
          worldData.entries[item._key].disable = true;
        }
      }
      await saveWorldbookData(worldbookName, worldData);
      redraw();
    });

    modal.querySelectorAll('.st-pw-wb-toggle-enable').forEach((checkbox) => {
      checkbox.addEventListener('change', async (e) => {
        const key = e.target.getAttribute('data-entry-key');
        if (key && worldData.entries?.[key]) {
          worldData.entries[key].disable = !e.target.checked;
          await saveWorldbookData(worldbookName, worldData);
          redraw();
        }
      });
    });

    modal.querySelectorAll('.st-pw-wb-toggle-constant').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-entry-key');
        if (key && worldData.entries?.[key]) {
          worldData.entries[key].constant = !worldData.entries[key].constant;
          await saveWorldbookData(worldbookName, worldData);
          redraw();
        }
      });
    });

    modal.querySelectorAll('.st-pw-wb-jump-entry-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entryUid = btn.getAttribute('data-entry-uid');
        modal.classList.add('st-pw-hidden');
        await jumpToWorldbookInHost(worldbookName, {
          fromWardrobeModal: true,
          uid: entryUid,
        });
      });
    });

    modal.querySelectorAll('.st-pw-wb-expand-trigger').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-entry-key');
        expandedKey = expandedKey === key ? null : key;
        redraw();
      });
    });

    modal.querySelectorAll('.st-pw-save-entry-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-entry-key');
        const row = btn.closest('.st-pw-wb-row');
        if (!key || !row || !worldData.entries?.[key]) return;
        const commentVal = row.querySelector('.st-pw-edit-comment')?.value ?? '';
        const keysRaw = row.querySelector('.st-pw-edit-keys')?.value ?? '';
        const orderVal = Number(row.querySelector('.st-pw-edit-order')?.value ?? 100);
        const contentVal = row.querySelector('.st-pw-edit-content')?.value ?? '';

        worldData.entries[key].comment = commentVal.trim();
        worldData.entries[key].key = keysRaw
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (Number.isFinite(orderVal)) {
          worldData.entries[key].order = orderVal;
        }
        worldData.entries[key].content = contentVal;

        await saveWorldbookData(worldbookName, worldData);
        globalThis.toastr?.success?.('已保存');
        expandedKey = null;
        redraw();
      });
    });

    modal.querySelectorAll('.st-pw-delete-entry-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-entry-key');
        if (!key || !worldData.entries?.[key]) return;
        const title = worldData.entries[key].comment || `#${key}`;
        if (!(await confirmUserAction('删除世界书条目', `确定删除条目「${title}」吗？`))) return;
        delete worldData.entries[key];
        expandedKey = null;
        await saveWorldbookData(worldbookName, worldData);
        redraw();
      });
    });
  }

  redraw();
}

async function evaluateActivePersonaInjections(chatMessages = []) {
  const settings = getSettings();
  if (!settings.enabled) {
    return { blocks: [], summary: [] };
  }

  const activeAvatarId = getActiveAvatarId();
  if (!activeAvatarId) {
    return { blocks: [], summary: [] };
  }

  const profile = ensureProfileMeta(activeAvatarId);
  const scanDepth = Math.max(1, Number(settings.scanDepth) || 5);
  const recentText = chatMessages
    .filter((m) => m && typeof m === 'object' && !m.is_system)
    .slice(-scanDepth)
    .map((m) => String(m?.mes ?? ''))
    .join('\n')
    .toLowerCase();

  const blocks = [];
  const summary = [];

  for (const trait of profile.traits) {
    if (!trait || !trait.enabled || !String(trait.content || '').trim()) continue;
    if (trait.triggerMode === 'keyword') {
      const kwList = String(trait.keywords || '')
        .split(/[,，]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const matchedKw = kwList.find((kw) => recentText.includes(kw));
      if (!matchedKw) continue;
      blocks.push(`[${trait.title || '设定'}]\n${trait.content.trim()}`);
      summary.push({
        type: 'trait',
        title: trait.title || '未命名设定',
        reason: `关键词: ${matchedKw}`,
      });
    } else {
      blocks.push(`[${trait.title || '设定'}]\n${trait.content.trim()}`);
      summary.push({
        type: 'trait',
        title: trait.title || '未命名设定',
        reason: '常驻',
      });
    }
  }

  for (const extraBook of profile.extraWorldbooks) {
    if (!extraBook || !extraBook.enabled || !extraBook.name) continue;
    try {
      let worldData = state.worldbookCache.get(extraBook.name)?.data;
      if (!worldData) {
        worldData = await fetchWorldbookData(extraBook.name);
      }
      const entries = Object.values(worldData?.entries || {});
      for (const entry of entries) {
        if (!entry || entry.disable || !String(entry.content || '').trim()) continue;
        if (entry.constant) {
          blocks.push(entry.content.trim());
          summary.push({
            type: 'worldbook',
            book: extraBook.name,
            title: entry.comment || `#${entry.uid}`,
            reason: '常驻',
          });
        } else {
          const keys = Array.isArray(entry.key) ? entry.key : [];
          const hit = keys
            .map((k) => String(k || '').trim().toLowerCase())
            .filter(Boolean)
            .find((k) => recentText.includes(k));
          if (hit) {
            blocks.push(entry.content.trim());
            summary.push({
              type: 'worldbook',
              book: extraBook.name,
              title: entry.comment || `#${entry.uid}`,
              reason: `关键词: ${hit}`,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[${MODULE_ID}] 读取附加世界书「${extraBook.name}」跳过:`, err);
    }
  }

  state.lastPromptInjectedSummary = summary;
  return { blocks, summary };
}

globalThis.PersonaWardrobe_interceptGeneration = async function (
  chat,
  _contextSize,
  _abort,
  type
) {
  if (type === 'quiet') return;
  try {
    const { blocks } = await evaluateActivePersonaInjections(Array.isArray(chat) ? chat : []);
    if (!blocks.length || !Array.isArray(chat) || chat.length === 0) return;

    const combinedNote = {
      is_user: false,
      is_system: false,
      name: 'Persona Wardrobe',
      send_date: Date.now(),
      mes: blocks.join('\n\n'),
      extra: {
        isSmallSys: true,
        source: MODULE_ID,
      },
    };

    const insertPos = Math.max(0, chat.length - 1);
    chat.splice(insertPos, 0, combinedNote);
  } catch (err) {
    console.error(`[${MODULE_ID}] 生成拦截器执行异常:`, err);
  }
};

function openWardrobeModal(initialAvatarId = null) {
  removeReturnToWardrobePill();
  const extMenu = document.querySelector('#extensionsMenu');
  const extBtn = document.querySelector('#extensionsMenuButton');
  if (extMenu && window.getComputedStyle(extMenu).display !== 'none') {
    if (extBtn) {
      extBtn.click();
    } else {
      extMenu.style.display = 'none';
    }
  }
  if (!state.diskAvatarFetched || !state.diskAvatarSet || state.diskAvatarSet.size === 0) {
    refreshDiskAvatarSet().then(() => {
      invalidateRenderedHtmlCache();
      renderWardrobeModalContent({ force: true });
    });
  }
  const personas = getHostPersonas();
  const activeId = getActiveAvatarId();
  if (initialAvatarId) {
    state.selectedAvatarId = initialAvatarId;
  } else if (!state.selectedAvatarId || !personas.some((p) => p.avatarId === state.selectedAvatarId)) {
    state.selectedAvatarId = activeId || personas[0]?.avatarId || null;
  }

  let modal = document.querySelector('#st_pw_wardrobe_modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'st_pw_wardrobe_modal';
    modal.className = 'st-pw-modal-backdrop';
    document.body.appendChild(modal);
  }
  bindModalBackdropEvents(modal);
  bindAvatarErrorFallback(modal);

  modal.classList.remove('st-pw-hidden');
  renderWardrobeModalContent({ force: true });
}

function renderMultiSelectToolbarHtml(settings, hostChars, currentCharName, availableBooks) {
  if (!state.multiSelectMode) return '';
  const selectedCount = state.multiSelectedIds.size;
  const disAttr = selectedCount === 0 ? 'disabled' : '';

  return `
    <div class="st-pw-multi-bar">
      <div class="st-pw-multi-bar-top">
        <span class="st-pw-multi-count">已选 <strong class="st-pw-multi-count-num">${selectedCount}</strong> 项</span>
        <div class="st-pw-multi-quick-btns">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-select-visible" title="全选当前列表中的所有可见人设（配合搜索框使用更高效）">全选当前</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-invert-visible" title="反选当前列表中的可见人设">反选</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-clear" ${disAttr}>清空</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-exit">退出</button>
        </div>
      </div>

      <div class="st-pw-multi-bar-actions">
        <select class="text_pole st-pw-multi-select-ctrl st-pw-multi-group-select" ${disAttr} title="将已勾选的 User 一次性批量移入指定分组">
          <option value="">批量移入分组…</option>
          ${(settings.groups || [])
            .map((g) => `<option value="${escapeAttr(g)}">移入分组：${sanitizeHtml(g)}</option>`)
            .join('')}
          <option value="__new__">+ 新建分组并移入…</option>
          <option value="__ungroup__">— 移出自定义分组（恢复未分组）—</option>
        </select>

        <select class="text_pole st-pw-multi-select-ctrl st-pw-multi-char-select" ${disAttr} title="将已勾选的 User 一次性绑定到角色卡或清空绑定">
          <option value="">批量角色绑定…</option>
          ${
            currentCharName
              ? `<option value="${escapeAttr(currentCharName)}">★ 绑到当前：${sanitizeHtml(currentCharName)}</option>`
              : ''
          }
          ${hostChars
            .filter((c) => c.name !== currentCharName)
            .map((c) => `<option value="${escapeAttr(c.name)}">绑到角色：${sanitizeHtml(c.name)}</option>`)
            .join('')}
          <option value="__custom_char__">+ 手动输入角色名绑定…</option>
          <option value="__clear_all_chars__">— 清空所选的全部角色绑定 —</option>
        </select>

        <select class="text_pole st-pw-multi-select-ctrl st-pw-multi-book-select" ${disAttr} title="为已勾选的 User 批量设置或解绑主世界书">
          <option value="">批量设世界书…</option>
          ${availableBooks
            .map((b) => `<option value="${escapeAttr(b)}">设为主书：${sanitizeHtml(b)}</option>`)
            .join('')}
          <option value="__clear_book__">— 解绑主世界书 —</option>
        </select>

        <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-fav-on" ${disAttr} title="批量设为收藏">
          <i class="fa-solid fa-star"></i> 收藏
        </button>
        <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-fav-off" ${disAttr} title="批量取消收藏">
          <i class="fa-regular fa-star"></i> 取消收藏
        </button>
        <button type="button" class="menu_button st-pw-mini-btn st-pw-multi-delete" ${disAttr} title="批量删除已勾选人设（自动保护当前使用中人设与系统默认人设）">
          <i class="fa-solid fa-trash-can"></i> 删除
        </button>
      </div>
    </div>
  `;
}

function renderPersonaRowHtml(p, selectedAvatarId) {
  const isMulti = Boolean(state.multiSelectMode);
  const isMultiChecked = isMulti && state.multiSelectedIds.has(p.avatarId);
  const isSelected = !isMulti && selectedAvatarId === p.avatarId;
  const extraCount = p.meta.extraWorldbooks.filter((b) => b.enabled).length;
  const traitCount = p.meta.traits.filter((t) => t.enabled).length;
  const presetCount = Array.isArray(p.meta.presets) ? p.meta.presets.length : 0;
  const usage = getPersonaUsageSummary(p.avatarId);
  const hasUsage = usage.charCount > 0 || usage.chatCount > 0 || usage.durationMs > 0;
  const fallbackAvatarUrl = resolvePersonaDirectAvatarUrl(p.avatarId);
  const isPendingPlaceholder =
    state.whitePlaceholderIds.has(p.avatarId) &&
    !state.resolvedExternalAvatars.has(p.avatarId) &&
    !getSettings().avatarUrlCache?.[p.avatarId];
  return `
    <div class="st-pw-persona-item ${isMulti ? 'is-multi-mode' : ''} ${isMultiChecked ? 'is-multi-checked' : ''} ${isSelected ? 'is-selected' : ''} ${p.isActive ? 'is-active-user' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}">
      ${
        isMulti
          ? `<input type="checkbox" class="st-pw-multi-check" data-avatar-id="${escapeAttr(p.avatarId)}" ${isMultiChecked ? 'checked' : ''} aria-label="勾选 ${escapeAttr(p.name)}" />`
          : ''
      }
      <img class="st-pw-item-avatar b-loaded loaded ${isPendingPlaceholder ? 'st-pw-placeholder-pending' : ''}" src="${escapeAttr(p.avatarUrl)}" data-real-src="${escapeAttr(p.avatarUrl)}" data-no-lazy="1" data-loaded="true" data-avatar-id="${escapeAttr(p.avatarId)}" data-fallback-src="${escapeAttr(fallbackAvatarUrl)}" decoding="async" alt="" />
      <div class="st-pw-item-main">
        <div class="st-pw-item-title-line">
          <span class="st-pw-item-name">${sanitizeHtml(p.name)}</span>
          ${p.meta.group ? `<span class="st-pw-tiny-tag">${sanitizeHtml(p.meta.group)}</span>` : ''}
          ${p.isLukerCharacterOnly ? `<span class="st-pw-tiny-tag" title="Luker 角色卡专属人设 (Character Only)">卡内专属</span>` : ''}
        </div>
        <div class="st-pw-item-sub-line">
          ${
            p.lorebook
              ? `<span class="st-pw-item-book">${sanitizeHtml(p.lorebook)}</span>`
              : `<span class="st-pw-muted">未绑书</span>`
          }
          ${extraCount ? `<span>+${extraCount}书</span>` : ''}
          ${traitCount ? `<span>· ${traitCount}设定</span>` : ''}
          ${presetCount ? `<span>· ${presetCount}快照</span>` : ''}
          ${
            (p.meta.boundCharacters?.length || 0) >= 2
              ? `<span title="${escapeAttr(p.meta.boundCharacters.join(' / '))}">· 绑${p.meta.boundCharacters.length}卡</span>`
              : ''
          }
          ${
            hasUsage
              ? `<span class="st-pw-usage-badge" title="已聊 ${usage.charCount} 个角色卡 · ${usage.chatCount} 个聊天档 · 累计 ${formatDurationHuman(usage.durationMs)}">· ${usage.charCount}角/${usage.chatCount}档/${formatDurationShort(usage.durationMs)}</span>`
              : ''
          }
        </div>
      </div>
      <div class="st-pw-item-actions">
        <button type="button" class="st-pw-fav-btn ${p.meta.favorite ? 'is-fav' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}" title="收藏">
          <i class="fa-${p.meta.favorite ? 'solid' : 'regular'} fa-star"></i>
        </button>
        ${
          p.isActive
            ? `<span class="st-pw-active-label">当前</span>`
            : isMulti
              ? ''
              : `<button type="button" class="menu_button st-pw-mini-btn st-pw-use-persona-btn" data-avatar-id="${escapeAttr(p.avatarId)}">使用</button>`
        }
      </div>
    </div>
  `;
}

function matchesSearch(p, q) {
  if (!q) return true;
  const hay = [
    p.name,
    p.avatarId,
    p.description,
    p.lorebook,
    p.meta.group,
    p.meta.note,
    ...(p.meta.tags || []),
    ...(p.meta.boundCharacters || []),
    ...(p.meta.extraWorldbooks || []).map((b) => b.name),
    ...(p.meta.traits || []).map((t) => `${t.title} ${t.keywords}`),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function renderFilterPillsBarHtml(personas, characterGroups, customGroups, ungroupedMembers) {
  const dedicatedCount = personas.filter((p) => p.isLukerCharacterOnly).length;
  const globalCount = personas.length - dedicatedCount;
  const favCount = personas.filter((p) => p.meta.favorite).length;
  const chattedCount = personas.filter((p) => {
    const u = getPersonaUsageSummary(p.avatarId);
    return u.chatCount > 0 || u.durationMs > 0;
  }).length;

  const dedupParts = [];
  if (state.lastExcludedOrphanCount > 0) {
    dedupParts.push(`已过滤 ${state.lastExcludedOrphanCount} 条无头像残留`);
  }
  if (state.lastMergedDuplicateCount > 0) {
    dedupParts.push(`已合并 ${state.lastMergedDuplicateCount} 条跨卡同名重复`);
  }

  const currentCharGroup = characterGroups.find((cg) => cg.isCurrentChar) || null;
  const otherCharGroups = characterGroups.filter((cg) => !cg.isCurrentChar);
  const useCharDropdown = otherCharGroups.length >= 2;
  const isOtherCharFilterSelected =
    state.activeFilter.startsWith('char:') &&
    (!currentCharGroup || state.activeFilter !== currentCharGroup.id);

  return `
    <div class="st-pw-group-tabs">
      <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'all' ? 'active' : ''}" data-filter="all" title="所有去重后的真实人设总数">
        全部 (${personas.length})
      </button>
      ${
        dedicatedCount > 0
          ? `
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'global' ? 'active' : ''}" data-filter="global" title="全局人设列表中的人设数量（与 Luker 原生全局列表一致）">
              全局 (${globalCount})
            </button>
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'dedicated' ? 'active' : ''}" data-filter="dedicated" title="Luker 中设为 Character Only 仅保存在角色卡内部的人设">
              卡内专属 (${dedicatedCount})
            </button>
          `
          : ''
      }
      ${
        chattedCount > 0
          ? `
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'chatted' ? 'active' : ''}" data-filter="chatted" title="有过聊天档记录的 User">
              已聊过 (${chattedCount})
            </button>
          `
          : ''
      }
      <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'fav' ? 'active' : ''}" data-filter="fav">
        收藏 (${favCount})
      </button>
      ${
        currentCharGroup
          ? `
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === currentCharGroup.id ? 'active' : ''}" data-filter="${escapeAttr(currentCharGroup.id)}" title="当前打开角色绑定的 User">
              <i class="fa-solid fa-user-tag"></i> ${sanitizeHtml(currentCharGroup.name)} (${currentCharGroup.members.length})
            </button>
          `
          : ''
      }
      ${
        !useCharDropdown
          ? otherCharGroups
              .map(
                (cg) => `
                  <button type="button" class="st-pw-filter-pill ${state.activeFilter === cg.id ? 'active' : ''}" data-filter="${escapeAttr(cg.id)}" title="角色绑定的 User 自动分组">
                    <i class="fa-solid fa-user-tag"></i> ${sanitizeHtml(cg.name)} (${cg.members.length})
                  </button>
                `
              )
              .join('')
          : `
            <select class="text_pole st-pw-char-filter-select ${isOtherCharFilterSelected ? 'is-active-select' : ''}" title="按绑定角色筛选 User（避免大量连线角色撑满屏幕）">
              <option value="all">按角色筛选 (${characterGroups.length})…</option>
              ${characterGroups
                .map(
                  (cg) =>
                    `<option value="${escapeAttr(cg.id)}" ${state.activeFilter === cg.id ? 'selected' : ''}>${cg.isCurrentChar ? '★ ' : ''}${sanitizeHtml(cg.name)} (${cg.members.length})</option>`
                )
                .join('')}
            </select>
          `
      }
      ${customGroups
        .map(
          (g) => `
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === g.id ? 'active' : ''}" data-filter="${escapeAttr(g.id)}">
              ${sanitizeHtml(g.name)} (${g.members.length})
            </button>
          `
        )
        .join('')}
      ${
        (characterGroups.length > 0 || customGroups.length > 0) && ungroupedMembers.length > 0
          ? `<button type="button" class="st-pw-filter-pill ${state.activeFilter === 'ungrouped' ? 'active' : ''}" data-filter="ungrouped">未分组 (${ungroupedMembers.length})</button>`
          : ''
      }
    </div>
    ${
      dedupParts.length > 0
        ? `<div class="st-pw-dedup-notice">${sanitizeHtml(dedupParts.join(' · '))}</div>`
        : ''
    }
  `;
}

function renderWardrobeModalContent({ force = false } = {}) {
  const modal = document.querySelector('#st_pw_wardrobe_modal');
  if (!modal || modal.classList.contains('st-pw-hidden')) return;

  if (
    !force &&
    document.activeElement &&
    modal.contains(document.activeElement) &&
    (document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.tagName === 'SELECT') &&
    document.activeElement.type !== 'checkbox'
  ) {
    return;
  }

  const settings = getSettings();
  const personas = getHostPersonas();
  const availableBooks = getAvailableWorldbooks();
  const hostChars = getHostCharacters();
  const currentChar = getCurrentCharacter();
  const currentCharName = currentChar?.name || '';

  const { characterGroups, customGroups, ungroupedMembers } =
    buildUnifiedPersonaGroups(personas);

  const activePersona = personas.find((p) => p.isActive) || null;
  const selectedPersona =
    personas.find((p) => p.avatarId === state.selectedAvatarId) ||
    activePersona ||
    personas[0] ||
    null;

  if (selectedPersona && state.selectedAvatarId !== selectedPersona.avatarId) {
    state.selectedAvatarId = selectedPersona.avatarId;
  }

  // 如果当前过滤项已不存在，自动退回 'all'
  if (
    state.activeFilter.startsWith('char:') &&
    !characterGroups.some((cg) => cg.id === state.activeFilter)
  ) {
    state.activeFilter = 'all';
  }
  if (
    state.activeFilter.startsWith('group:') &&
    !customGroups.some((g) => g.id === state.activeFilter)
  ) {
    state.activeFilter = 'all';
  }

  const q = state.searchQuery.trim().toLowerCase();
  const activeMeta = activePersona ? activePersona.meta : null;
  const activeExtraBooks = activeMeta
    ? activeMeta.extraWorldbooks.filter((b) => b.enabled && b.name)
    : [];
  const activeTraits = activeMeta
    ? activeMeta.traits.filter((t) => t.enabled && String(t.content || '').trim())
    : [];

  const nextModalHtml = `
    <div class="st-pw-wardrobe-dialog" role="dialog" aria-modal="true">
      <div class="st-pw-modal-header">
        <div class="st-pw-header-left">
          <span class="st-pw-modal-title">User 人设管理</span>
          <span class="st-pw-header-meta">当前：<strong>${sanitizeHtml(activePersona ? activePersona.name : '无')}</strong></span>
          ${
            activePersona?.lorebook
              ? `
                <span class="st-pw-header-divider">|</span>
                <span class="st-pw-header-meta">世界书：<strong>${sanitizeHtml(activePersona.lorebook)}</strong></span>
                <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(activePersona.lorebook)}">条目</button>
                <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(activePersona.lorebook)}">跳转</button>
              `
              : ''
          }
          ${
            activeExtraBooks.length || activeTraits.length
              ? `<span class="st-pw-header-divider">|</span><span class="st-pw-header-meta">附加书 ${activeExtraBooks.length} · 随身设定 ${activeTraits.length}</span>`
              : ''
          }
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-scan-history-btn" ${state.isScanningHistory ? 'disabled' : ''}>
            <i class="fa-solid fa-${state.isScanningHistory ? 'spinner fa-spin' : 'chart-simple'}"></i>
            ${state.isScanningHistory ? sanitizeHtml(state.scanProgressText || '扫描中…') : '扫描统计'}
          </button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-preview-active-prompt-btn">生效预览</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-refresh-host-btn" title="同步列表"><i class="fa-solid fa-rotate"></i></button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-close-wardrobe-btn" title="关闭"><i class="fa-solid fa-xmark"></i> 关闭</button>
        </div>
      </div>

      <div class="st-pw-workbench">
        <aside class="st-pw-sidebar">
          <div class="st-pw-inline-left-top">
            <input type="search" id="st_pw_search_input" class="text_pole st-pw-sidebar-search" placeholder="搜索 User、角色组、自定义组、世界书…" value="${escapeAttr(state.searchQuery)}" />
            <button type="button" class="menu_button st-pw-mini-btn st-pw-toggle-multi-btn ${state.multiSelectMode ? 'is-active-mode' : ''}" title="开启多选模式，一次性将多个 User 批量移入分组、绑卡、绑世界书或删除">
              <i class="fa-${state.multiSelectMode ? 'solid fa-check-double' : 'regular fa-square-check'}"></i> ${state.multiSelectMode ? `完成${state.multiSelectedIds.size > 0 ? ` (${state.multiSelectedIds.size})` : ''}` : '多选'}
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-modal-create-btn" title="调用原生新建人设">
              <i class="fa-solid fa-plus"></i> 新建
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-modal-upload-btn" title="上传头像新建人设">
              <i class="fa-solid fa-image"></i> 头像
            </button>
          </div>

          <!-- 快捷创建组：按角色建组（把多个 User 绑到同一角色下自动成组） / 新建自定义组 -->
          <div class="st-pw-sidebar-create-bar">
            <select id="st_pw_create_char_group_select" class="text_pole st-pw-flex-select" title="选一个角色卡，把多个 User 绑到它下面自动归为一组">
              <option value="">+ 按角色绑一组 User…</option>
              ${
                currentCharName
                  ? `<option value="${escapeAttr(currentCharName)}">当前角色：${sanitizeHtml(currentCharName)}</option>`
                  : ''
              }
              ${hostChars
                .filter((c) => c.name !== currentCharName)
                .map((c) => `<option value="${escapeAttr(c.name)}">${sanitizeHtml(c.name)}</option>`)
                .join('')}
            </select>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-add-group-btn" title="新建自定义分组">
              + 自定义组
            </button>
          </div>

          ${renderFilterPillsBarHtml(personas, characterGroups, customGroups, ungroupedMembers)}
          ${renderMultiSelectToolbarHtml(settings, hostChars, currentCharName, availableBooks)}

          <!-- 分组树列表：同一角色下绑的多个 User 自动归在一组，自定义组也自动归在一组 -->
          <div class="st-pw-persona-list">
            ${buildGroupedTreeSectionsHtml(
              personas,
              selectedPersona?.avatarId,
              characterGroups,
              customGroups,
              ungroupedMembers,
              q
            )}
          </div>
        </aside>

        <main class="st-pw-detail-pane">
          ${
            !selectedPersona
              ? `<div class="st-pw-empty-state">未选择 User</div>`
              : renderSelectedPersonaDetail(selectedPersona, availableBooks, hostChars, currentCharName, settings)
          }
        </main>
      </div>
    </div>
  `;

  if (modal.childElementCount > 0 && nextModalHtml === state.lastModalRenderedHtml) {
    return;
  }

  const prevListEl = modal.querySelector('.st-pw-persona-list');
  const prevDetailEl = modal.querySelector('.st-pw-detail-pane');
  const savedListScroll = prevListEl ? prevListEl.scrollTop : state.savedModalListScrollTop;
  const savedDetailScroll = prevDetailEl ? prevDetailEl.scrollTop : state.savedModalDetailScrollTop;

  state.lastModalRenderedHtml = nextModalHtml;
  modal.innerHTML = nextModalHtml;
  bindAvatarErrorFallback(modal);
  bindWardrobeModalEvents(modal, selectedPersona, personas);

  const nextListEl = modal.querySelector('.st-pw-persona-list');
  const nextDetailEl = modal.querySelector('.st-pw-detail-pane');
  if (nextListEl) {
    nextListEl.scrollTop = savedListScroll;
    nextListEl.addEventListener(
      'scroll',
      () => {
        state.savedModalListScrollTop = nextListEl.scrollTop;
      },
      { passive: true }
    );
  }
  if (nextDetailEl) {
    nextDetailEl.scrollTop = savedDetailScroll;
    nextDetailEl.addEventListener(
      'scroll',
      () => {
        state.savedModalDetailScrollTop = nextDetailEl.scrollTop;
      },
      { passive: true }
    );
  }
}

/**
 * 在分组标题下直接展开「批量勾选哪些 User 属于该角色 / 该自定义分组」的清单
 */
function renderBatchChecklistHtml(targetType, targetName, allPersonas) {
  return `
    <div class="st-pw-batch-box">
      <div class="st-pw-batch-head">
        <span>勾选要归入「<strong>${sanitizeHtml(targetName)}</strong>」的 User：</span>
        <button type="button" class="st-pw-link-btn st-pw-close-batch">完成</button>
      </div>
      <div class="st-pw-batch-list">
        ${allPersonas
          .map((p) => {
            const isChecked =
              targetType === 'character'
                ? p.meta.boundCharacters.some((c) => c.toLowerCase() === targetName.toLowerCase())
                : p.meta.group === targetName;
            return `
              <label class="st-pw-batch-item">
                <input type="checkbox" class="st-pw-batch-check" data-target-type="${escapeAttr(targetType)}" data-target-name="${escapeAttr(targetName)}" data-avatar-id="${escapeAttr(p.avatarId)}" ${isChecked ? 'checked' : ''} />
                <span>${sanitizeHtml(p.name)}</span>
              </label>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderUsageStatsBlockHtml(persona) {
  const stats = getPersonaUsageSummary(persona.avatarId);
  return `
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">使用足迹统计（聊过角色 · 聊天档 · 累计时长）</span>
        <div class="st-pw-inline-header-btns">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-scan-history-btn" ${state.isScanningHistory ? 'disabled' : ''} title="扫描酒馆内所有角色卡的历史聊天档，自动回溯统计每个 User 聊过的角色卡、档数与时长">
            <i class="fa-solid fa-${state.isScanningHistory ? 'spinner fa-spin' : 'chart-simple'}"></i>
            ${state.isScanningHistory ? sanitizeHtml(state.scanProgressText || '扫描中…') : '扫描历史档'}
          </button>
          ${
            stats.byCharacter.length > 0
              ? `
                <button type="button" class="menu_button st-pw-mini-btn st-pw-toggle-stats-detail-btn">
                  ${state.showStatsDetail ? '收起明细' : '角色明细'}
                </button>
              `
              : ''
          }
          ${
            stats.chatCount > 0 || stats.durationMs > 0
              ? `
                <button type="button" class="menu_button st-pw-mini-btn st-pw-reset-user-stats-btn" title="清空此 User 的使用统计记录">
                  重置
                </button>
              `
              : ''
          }
        </div>
      </div>

      <div class="st-pw-stats-metrics-row">
        <div class="st-pw-stat-cell">
          <span class="st-pw-stat-label">聊过角色卡</span>
          <strong class="st-pw-stat-val">${stats.charCount} <small>个</small></strong>
        </div>
        <div class="st-pw-stat-cell">
          <span class="st-pw-stat-label">聊天档数</span>
          <strong class="st-pw-stat-val">${stats.chatCount} <small>个档</small></strong>
        </div>
        <div class="st-pw-stat-cell">
          <span class="st-pw-stat-label">互动消息</span>
          <strong class="st-pw-stat-val">${stats.totalMsgs} <small>条</small></strong>
        </div>
        <div class="st-pw-stat-cell">
          <span class="st-pw-stat-label">累计聊天时长</span>
          <strong class="st-pw-stat-val">${sanitizeHtml(formatDurationHuman(stats.durationMs))}</strong>
        </div>
      </div>

      ${
        state.showStatsDetail && stats.byCharacter.length > 0
          ? `
            <div class="st-pw-compact-rows">
              ${stats.byCharacter
                .map(
                  (c) => `
                    <div class="st-pw-compact-row">
                      <span class="st-pw-row-main-text"><strong>${sanitizeHtml(c.charName)}</strong></span>
                      <span class="st-pw-muted" style="font-size:0.8rem;">${c.chatCount} 个档 · ${c.userMsgs + c.aiMsgs} 条消息 · ${sanitizeHtml(formatDurationHuman(c.durationMs))}</span>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
          : ''
      }
    </div>
  `;
}

function renderPresetsAndCloneBlockHtml(persona) {
  const meta = persona.meta;
  const presets = Array.isArray(meta.presets) ? meta.presets : [];
  return `
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">变体克隆 & 状态快照预设 (${presets.length})</span>
        <div class="st-pw-inline-header-btns">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-save-preset-btn" title="将当前人设描述、主世界书及条目开关、附加书与随身设定保存为一套状态快照">
            + 存为状态快照
          </button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-clone-variant-btn" title="完整克隆此 User（连带头像、描述、世界书、随身设定、所属角色组/自定义组及快照）">
            <i class="fa-solid fa-copy"></i> 完整克隆变体
          </button>
        </div>
      </div>
      ${
        presets.length === 0
          ? `<div class="st-pw-muted-hint">可保存多套「人设描述 + 主世界书条目开关 + 附加书 + 随身设定」状态快照（如日常态/战斗态/IF线），一键切换或直接派生为新 User。</div>`
          : `
            <div class="st-pw-compact-rows">
              ${presets
                .map((pr) => {
                  const isCurrentPreset = meta.activePresetId === pr.id;
                  const ebCount = Array.isArray(pr.extraWorldbooks)
                    ? pr.extraWorldbooks.filter((b) => b.enabled).length
                    : 0;
                  const trCount = Array.isArray(pr.traits)
                    ? pr.traits.filter((t) => t.enabled).length
                    : 0;
                  const entryCount =
                    pr.primaryEntryStates && typeof pr.primaryEntryStates === 'object'
                      ? Object.values(pr.primaryEntryStates).filter((s) => s && !s.disable).length
                      : null;
                  const summaryParts = [
                    pr.lorebook
                      ? `${pr.lorebook}${entryCount !== null ? `(${entryCount}条开)` : ''}`
                      : '无主书',
                  ];
                  if (ebCount) summaryParts.push(`+${ebCount}书`);
                  if (trCount) summaryParts.push(`${trCount}设定`);
                  summaryParts.push(`${String(pr.description || '').length}字`);

                  return `
                    <div class="st-pw-compact-row ${isCurrentPreset ? 'is-active-preset' : ''}" data-preset-id="${escapeAttr(pr.id)}">
                      <span class="st-pw-mode-tag ${isCurrentPreset ? 'is-constant' : 'is-keyword'} st-pw-apply-preset-btn" data-preset-id="${escapeAttr(pr.id)}" title="点击切换到此状态快照">
                        <span class="st-pw-dot"></span>${isCurrentPreset ? '当前快照' : '快照'}
                      </span>
                      <span class="st-pw-row-main-text st-pw-apply-preset-btn" data-preset-id="${escapeAttr(pr.id)}" title="点击切换到此状态快照">
                        <strong>${sanitizeHtml(pr.name)}</strong>
                        <small class="st-pw-muted"> · ${sanitizeHtml(summaryParts.join(' · '))}</small>
                      </span>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-apply-preset-btn" data-preset-id="${escapeAttr(pr.id)}" title="一键恢复此快照的描述、世界书条目开关与随身设定">
                        切换
                      </button>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-overwrite-preset-btn" data-preset-id="${escapeAttr(pr.id)}" title="用当前最新状态覆盖更新此快照">
                        更新
                      </button>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-preset-to-variant-btn" data-preset-id="${escapeAttr(pr.id)}" title="将此快照直接派生为一个新的独立 User 人设">
                        派生User
                      </button>
                      <button type="button" class="st-pw-icon-btn st-pw-delete-preset-btn" data-preset-id="${escapeAttr(pr.id)}" title="删除此快照">
                        <i class="fa-solid fa-xmark"></i>
                      </button>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
      }
    </div>
  `;
}

function renderSelectedPersonaDetail(persona, availableBooks, hostChars, currentCharName, settings) {
  const meta = persona.meta;
  const bookOptionsHtml = [
    `<option value="">— 未绑定 —</option>`,
    ...availableBooks.map(
      (b) =>
        `<option value="${escapeAttr(b)}" ${persona.lorebook === b ? 'selected' : ''}>${sanitizeHtml(b)}</option>`
    ),
  ].join('');

  const isCurrentCharBound =
    currentCharName &&
    meta.boundCharacters.some((c) => c.toLowerCase() === currentCharName.toLowerCase());

  const unboundHostChars = hostChars.filter(
    (c) => !meta.boundCharacters.some((bc) => bc.toLowerCase() === c.name.toLowerCase())
  );

  return `
    <div class="st-pw-detail-top">
      <div class="st-pw-detail-user-row">
        <img class="st-pw-detail-avatar b-loaded loaded" src="${escapeAttr(persona.avatarUrl)}" data-real-src="${escapeAttr(persona.avatarUrl)}" data-no-lazy="1" data-loaded="true" data-avatar-id="${escapeAttr(persona.avatarId)}" data-fallback-src="${escapeAttr(resolvePersonaDirectAvatarUrl(persona.avatarId))}" decoding="async" alt="" />
        <div class="st-pw-detail-user-info">
          <div class="st-pw-detail-name-line">
            <strong>${sanitizeHtml(persona.name)}</strong>
            <span class="st-pw-mono-id">${sanitizeHtml(persona.avatarId)}</span>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-change-avatar-btn" data-avatar-id="${escapeAttr(persona.avatarId)}" title="直接上传更换该 User 的头像">
              <i class="fa-solid fa-image"></i> 换头像
            </button>
          </div>
          <div class="st-pw-detail-meta-inputs">
            <select id="st_pw_detail_group" class="text_pole" title="所属自定义分组">
              <option value="">自定义分组：无</option>
              ${settings.groups
                .map(
                  (g) =>
                    `<option value="${escapeAttr(g)}" ${meta.group === g ? 'selected' : ''}>分组：${sanitizeHtml(g)}</option>`
                )
                .join('')}
              <option value="__new__">+ 新建自定义分组…</option>
            </select>
            <input type="text" id="st_pw_detail_tags" class="text_pole" placeholder="标签 (逗号分隔)" value="${escapeAttr(meta.tags.join(', '))}" />
          </div>
        </div>
        <div>
          ${
            persona.isActive
              ? `<span class="st-pw-current-pill">当前使用中</span>`
              : `<button type="button" class="menu_button st-pw-primary-btn st-pw-detail-switch-btn" data-avatar-id="${escapeAttr(persona.avatarId)}">切换为此 User</button>`
          }
        </div>
      </div>
    </div>

    <!-- 使用足迹统计 -->
    ${renderUsageStatsBlockHtml(persona)}

    <!-- 绑定角色卡（绑在同一个角色卡下的多个 User 会自动在左侧归为一组） -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">绑定角色卡（绑在同一角色下的多个 User 会自动归为一组）</span>
        ${
          currentCharName && !isCurrentCharBound
            ? `<button type="button" id="st_pw_bind_current_char_btn" class="menu_button st-pw-mini-btn" data-char="${escapeAttr(currentCharName)}">+ 绑到当前角色「${sanitizeHtml(currentCharName)}」</button>`
            : ''
        }
      </div>
      <div class="st-pw-char-chips-row">
        ${
          meta.boundCharacters.length === 0
            ? `<span class="st-pw-muted" style="font-size:0.82rem;">未绑定角色</span>`
            : meta.boundCharacters
                .map(
                  (cName) => `
                    <span class="st-pw-char-chip">
                      <span class="st-pw-char-chip-jump" data-char="${escapeAttr(cName)}" title="点击筛选该角色组下的所有 User">${sanitizeHtml(cName)}</span>
                      <button type="button" class="st-pw-chip-remove" data-char="${escapeAttr(cName)}" title="移出该角色组">×</button>
                    </span>
                  `
                )
                .join('')
        }
        <select id="st_pw_bind_char_select" class="text_pole st-pw-char-add-select">
          <option value="">+ 选择角色卡加入该角色组…</option>
          ${unboundHostChars
            .map((c) => `<option value="${escapeAttr(c.name)}">${sanitizeHtml(c.name)}</option>`)
            .join('')}
          <option value="__custom__">手动输入角色名…</option>
        </select>
      </div>
    </div>

    <!-- 变体克隆 & 状态快照预设 -->
    ${renderPresetsAndCloneBlockHtml(persona)}

    <!-- 世界书绑定 -->
    <div class="st-pw-block">
      <div class="st-pw-block-title">世界书绑定</div>
      <div class="st-pw-wb-bind-row">
        <span class="st-pw-field-label">主世界书</span>
        <select id="st_pw_primary_book_select" class="text_pole st-pw-flex-select">
          ${bookOptionsHtml}
        </select>
        <button type="button" class="menu_button st-pw-act-popup-book" data-book="${escapeAttr(persona.lorebook)}" ${!persona.lorebook ? 'disabled' : ''}>
          查看条目
        </button>
        <button type="button" class="menu_button st-pw-act-jump-book" data-book="${escapeAttr(persona.lorebook)}" ${!persona.lorebook ? 'disabled' : ''}>
          跳转编辑器
        </button>
      </div>

      <div class="st-pw-wb-bind-row">
        <span class="st-pw-field-label">附加书</span>
        <select id="st_pw_add_extra_book_select" class="text_pole st-pw-flex-select">
          <option value="">添加额外关联世界书…</option>
          ${availableBooks
            .filter((b) => b !== persona.lorebook && !meta.extraWorldbooks.some((eb) => eb.name === b))
            .map((b) => `<option value="${escapeAttr(b)}">${sanitizeHtml(b)}</option>`)
            .join('')}
        </select>
        <button type="button" id="st_pw_add_extra_book_btn" class="menu_button">添加</button>
      </div>

      ${
        meta.extraWorldbooks.length > 0
          ? `
            <div class="st-pw-compact-rows">
              ${meta.extraWorldbooks
                .map(
                  (eb, idx) => `
                    <div class="st-pw-compact-row ${eb.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                      <input type="checkbox" class="st-pw-toggle-extra-book" data-idx="${idx}" ${eb.enabled ? 'checked' : ''} />
                      <span class="st-pw-row-main-text">${sanitizeHtml(eb.name)}</span>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(eb.name)}">条目</button>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(eb.name)}">跳转</button>
                      <button type="button" class="st-pw-icon-btn st-pw-remove-extra-book" data-idx="${idx}" title="移除"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
          : ''
      }
    </div>

    <!-- 随身设定 -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">随身设定 (${meta.traits.filter((t) => t.enabled).length}/${meta.traits.length})</span>
        <button type="button" id="st_pw_add_trait_btn" class="menu_button st-pw-mini-btn">+ 添加设定</button>
      </div>
      ${
        meta.traits.length === 0
          ? `<div class="st-pw-muted-hint">可添加随该 User 独立开关的补充设定片段（支持常驻或关键词触发）。</div>`
          : `
            <div class="st-pw-compact-rows">
              ${meta.traits
                .map((trait, idx) => {
                  const isExp = state.expandedTraitIdx === idx;
                  const isKw = trait.triggerMode === 'keyword';
                  return `
                    <div class="st-pw-trait-row ${trait.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                      <div class="st-pw-compact-row">
                        <input type="checkbox" class="st-pw-trait-enable" data-idx="${idx}" ${trait.enabled ? 'checked' : ''} />
                        <button type="button" class="st-pw-mode-tag ${isKw ? 'is-keyword' : 'is-constant'} st-pw-trait-toggle-mode" data-idx="${idx}" title="点击切换常驻 / 关键词">
                          <span class="st-pw-dot"></span>${isKw ? '关键词' : '常驻'}
                        </button>
                        <span class="st-pw-row-main-text st-pw-trait-expand" data-idx="${idx}">
                          ${sanitizeHtml(trait.title || `设定 #${idx + 1}`)}
                          ${isKw && trait.keywords ? `<small class="st-pw-muted"> (${sanitizeHtml(trait.keywords)})</small>` : ''}
                        </span>
                        <button type="button" class="st-pw-icon-btn st-pw-trait-expand" data-idx="${idx}">
                          <i class="fa-solid fa-chevron-${isExp ? 'up' : 'down'}"></i>
                        </button>
                        <button type="button" class="st-pw-icon-btn st-pw-trait-delete" data-idx="${idx}" title="删除">
                          <i class="fa-solid fa-xmark"></i>
                        </button>
                      </div>
                      ${
                        isExp
                          ? `
                            <div class="st-pw-trait-editor">
                              <div class="st-pw-form-grid">
                                <input type="text" class="text_pole st-pw-trait-title" data-idx="${idx}" placeholder="标题" value="${escapeAttr(trait.title)}" />
                                <input type="text" class="text_pole st-pw-trait-keywords" data-idx="${idx}" placeholder="触发关键词（逗号分隔，仅关键词模式生效）" value="${escapeAttr(trait.keywords || '')}" />
                              </div>
                              <textarea class="text_pole st-pw-trait-content" data-idx="${idx}" rows="4" placeholder="设定内容…">${sanitizeHtml(trait.content || '')}</textarea>
                            </div>
                          `
                          : ''
                      }
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
      }
    </div>

    <!-- 人设描述 & 备注 -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">人设描述 & 备注</span>
        <button type="button" id="st_pw_save_base_desc_btn" class="menu_button st-pw-mini-btn">保存描述</button>
      </div>
      <div class="st-pw-form-grid">
        <div>
          <label class="st-pw-sub-label">原生人设描述 (Persona Description)</label>
          <textarea id="st_pw_base_description" class="text_pole" rows="6" placeholder="发送给 AI 的基础人设描述…">${sanitizeHtml(persona.description)}</textarea>
        </div>
        <div>
          <label class="st-pw-sub-label">私密备注（仅自己可见，不发给 AI）</label>
          <textarea id="st_pw_private_note" class="text_pole" rows="6" placeholder="备注适用角色卡或剧情线…">${sanitizeHtml(meta.note)}</textarea>
        </div>
      </div>
    </div>
  `;
}

function bindWardrobeModalEvents(modal, selectedPersona, allPersonas) {
  const settings = getSettings();
  const rerenderPanels = () => {
    syncNativePersonaPanelEnhancement({ forceRight: true });
    renderWardrobeModalContent({ force: true });
  };

  modal.querySelector('.st-pw-close-wardrobe-btn')?.addEventListener('click', () => {
    modal.classList.add('st-pw-hidden');
  });

  modal.querySelector('.st-pw-refresh-host-btn')?.addEventListener('click', async () => {
    await refreshDiskAvatarSet();
    await runUniversalNativeAvatarHarvest({ manual: true });
  });

  modal.querySelector('.st-pw-modal-create-btn')?.addEventListener('click', () => {
    document.querySelector('#create_dummy_persona')?.click();
  });

  modal.querySelector('.st-pw-modal-upload-btn')?.addEventListener('click', async () => {
    await triggerPersonaAvatarUpload({ targetAvatarId: '' });
  });

  modal.querySelectorAll('.st-pw-change-avatar-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute('data-avatar-id') || selectedPersona?.avatarId || '';
      if (targetId) {
        await triggerPersonaAvatarUpload({ targetAvatarId: targetId });
      }
    });
  });

  modal.querySelector('.st-pw-preview-active-prompt-btn')?.addEventListener('click', async () => {
    await openActivePromptPreviewModal();
  });

  const searchInput = modal.querySelector('#st_pw_search_input');
  searchInput?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderWardrobeModalContent({ force: true });
    const nextInput = modal.querySelector('#st_pw_search_input');
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(pos, pos);
    }
  });

  // 顶部筛选胶囊与角色筛选下拉框
  modal.querySelectorAll('.st-pw-filter-pill[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeFilter = btn.getAttribute('data-filter') || 'all';
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-char-filter-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      state.activeFilter = e.target.value || 'all';
      e.target.blur?.();
      rerenderPanels();
    });
  });

  // 折叠/展开分组文件夹
  modal.querySelectorAll('.st-pw-folder-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      const secId = el.getAttribute('data-section-id');
      if (!secId) return;
      if (state.collapsedSections.has(secId)) {
        state.collapsedSections.delete(secId);
      } else {
        state.collapsedSections.add(secId);
      }
      rerenderPanels();
    });
  });

  // 从左上角下拉框选一个角色卡，开启批量勾选多个 User 绑到该角色下自动成组
  modal
    .querySelector('#st_pw_create_char_group_select, #st_pw_inline_char_group_select')
    ?.addEventListener('change', (e) => {
      const charName = e.target.value;
      if (!charName) return;
      if (selectedPersona) {
        bindPersonaToCharacter(selectedPersona.avatarId, charName);
      }
      state.batchAssignTarget = { type: 'character', name: charName };
      state.collapsedSections.delete(`char:${charName}`);
      rerenderPanels();
    });

  // 点击某个角色组标题右侧的「+」批量勾选该角色下的多个 User
  modal.querySelectorAll('.st-pw-open-batch-char').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const charName = btn.getAttribute('data-char-name');
      if (!charName) return;
      if (
        state.batchAssignTarget?.type === 'character' &&
        state.batchAssignTarget?.name === charName
      ) {
        state.batchAssignTarget = null;
      } else {
        state.batchAssignTarget = { type: 'character', name: charName };
      }
      rerenderPanels();
    });
  });

  // 点击某个自定义分组标题右侧的「+」批量勾选该组内的多个 User
  modal.querySelectorAll('.st-pw-open-batch-group').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupName = btn.getAttribute('data-group-name');
      if (!groupName) return;
      if (
        state.batchAssignTarget?.type === 'group' &&
        state.batchAssignTarget?.name === groupName
      ) {
        state.batchAssignTarget = null;
      } else {
        state.batchAssignTarget = { type: 'group', name: groupName };
      }
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-close-batch').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.batchAssignTarget = null;
      rerenderPanels();
    });
  });

  // 批量勾选/取消勾选某个 User 到角色组或自定义组
  modal.querySelectorAll('.st-pw-batch-check').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      const targetType = e.target.getAttribute('data-target-type');
      const targetName = e.target.getAttribute('data-target-name');
      const avatarId = e.target.getAttribute('data-avatar-id');
      if (!targetName || !avatarId) return;

      if (targetType === 'character') {
        if (e.target.checked) {
          bindPersonaToCharacter(avatarId, targetName);
        } else {
          unbindPersonaFromCharacter(avatarId, targetName);
        }
      } else if (targetType === 'group') {
        const meta = ensureProfileMeta(avatarId);
        meta.group = e.target.checked ? targetName : '';
        saveSettings();
        rerenderPanels();
      }
    });
  });

  // 新建自定义分组
  modal
    .querySelector('.st-pw-add-group-btn, .st-pw-inline-add-group-btn')
    ?.addEventListener('click', async () => {
      const newGroup = await promptUserText('新建自定义分组', '', {
        placeholder: '输入新分组名称…',
      });
      if (newGroup && newGroup.trim()) {
        const clean = newGroup.trim();
        if (!settings.groups.includes(clean)) {
          settings.groups.push(clean);
          saveSettings();
        }
        state.batchAssignTarget = { type: 'group', name: clean };
        state.collapsedSections.delete(`group:${clean}`);
        rerenderPanels();
      }
    });

  // 重命名自定义分组
  modal.querySelectorAll('.st-pw-rename-group-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const oldName = btn.getAttribute('data-group-name');
      if (!oldName) return;
      const nextName = await promptUserText(`重命名分组「${oldName}」`, oldName);
      if (!nextName || !nextName.trim() || nextName.trim() === oldName) return;
      const clean = nextName.trim();
      const idx = settings.groups.indexOf(oldName);
      if (idx !== -1) settings.groups[idx] = clean;
      for (const prof of Object.values(settings.profiles)) {
        if (prof && prof.group === oldName) prof.group = clean;
      }
      if (state.activeFilter === `group:${oldName}`) {
        state.activeFilter = `group:${clean}`;
      }
      saveSettings();
      rerenderPanels();
    });
  });

  // 删除自定义分组
  modal.querySelectorAll('.st-pw-delete-group-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const oldName = btn.getAttribute('data-group-name');
      if (!oldName) return;
      if (
        !(await confirmUserAction(
          `删除自定义分组「${oldName}」`,
          '组内 User 本身不会被删除，仅恢复为未分组。'
        ))
      ) {
        return;
      }
      settings.groups = settings.groups.filter((g) => g !== oldName);
      for (const prof of Object.values(settings.profiles)) {
        if (prof && prof.group === oldName) prof.group = '';
      }
      if (state.activeFilter === `group:${oldName}`) {
        state.activeFilter = 'all';
      }
      saveSettings();
      rerenderPanels();
    });
  });

  // ==================== 多选批量管理事件 ====================
  modal.querySelectorAll('.st-pw-toggle-multi-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.multiSelectMode = !state.multiSelectMode;
      if (!state.multiSelectMode) {
        state.multiSelectedIds.clear();
        state.lastMultiClickedAvatarId = '';
      }
      invalidateRenderedHtmlCache();
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-multi-exit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.multiSelectMode = false;
      state.multiSelectedIds.clear();
      state.lastMultiClickedAvatarId = '';
      invalidateRenderedHtmlCache();
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-multi-select-visible').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      modal
        .querySelectorAll('.st-pw-persona-list .st-pw-persona-item[data-avatar-id]')
        .forEach((row) => {
          const id = row.getAttribute('data-avatar-id');
          if (id) state.multiSelectedIds.add(id);
        });
      syncMultiSelectionDomInPlace();
    });
  });

  modal.querySelectorAll('.st-pw-multi-invert-visible').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const seen = new Set();
      modal
        .querySelectorAll('.st-pw-persona-list .st-pw-persona-item[data-avatar-id]')
        .forEach((row) => {
          const id = row.getAttribute('data-avatar-id');
          if (!id || seen.has(id)) return;
          seen.add(id);
          if (state.multiSelectedIds.has(id)) {
            state.multiSelectedIds.delete(id);
          } else {
            state.multiSelectedIds.add(id);
          }
        });
      syncMultiSelectionDomInPlace();
    });
  });

  modal.querySelectorAll('.st-pw-multi-clear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.multiSelectedIds.clear();
      state.lastMultiClickedAvatarId = '';
      syncMultiSelectionDomInPlace();
    });
  });

  modal.querySelectorAll('.st-pw-multi-select-section').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const secEl = btn.closest('.st-pw-folder-section');
      if (!secEl) return;
      const rows = Array.from(secEl.querySelectorAll('.st-pw-persona-item[data-avatar-id]'));
      const ids = rows.map((r) => r.getAttribute('data-avatar-id')).filter(Boolean);
      if (ids.length === 0) return;
      const allSelected = ids.every((id) => state.multiSelectedIds.has(id));
      for (const id of ids) {
        if (allSelected) {
          state.multiSelectedIds.delete(id);
        } else {
          state.multiSelectedIds.add(id);
        }
      }
      syncMultiSelectionDomInPlace();
    });
  });

  modal.querySelectorAll('.st-pw-multi-group-select').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const val = e.target.value;
      e.target.value = '';
      e.target.blur?.();
      if (!val) return;
      await executeBatchMoveToGroup(val);
    });
  });

  modal.querySelectorAll('.st-pw-multi-char-select').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const val = e.target.value;
      e.target.value = '';
      e.target.blur?.();
      if (!val) return;
      await executeBatchCharacterAction(val);
    });
  });

  modal.querySelectorAll('.st-pw-multi-book-select').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const val = e.target.value;
      e.target.value = '';
      e.target.blur?.();
      if (!val) return;
      await executeBatchWorldbookAction(val);
    });
  });

  modal.querySelectorAll('.st-pw-multi-fav-on').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeBatchFavorite(true);
    });
  });

  modal.querySelectorAll('.st-pw-multi-fav-off').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeBatchFavorite(false);
    });
  });

  modal.querySelectorAll('.st-pw-multi-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await executeBatchDeletePersonas();
    });
  });

  modal.querySelectorAll('.st-pw-persona-item').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.st-pw-fav-btn') || e.target.closest('.st-pw-use-persona-btn')) {
        return;
      }
      const id = card.getAttribute('data-avatar-id');
      if (!id) return;

      if (state.multiSelectMode) {
        const shouldCheck = !state.multiSelectedIds.has(id);
        // 支持桌面端按住 Shift 连选一整段人设
        if (e.shiftKey && state.lastMultiClickedAvatarId && state.lastMultiClickedAvatarId !== id) {
          const allVisibleRows = Array.from(
            modal.querySelectorAll('.st-pw-persona-list .st-pw-persona-item[data-avatar-id]')
          );
          const idxA = allVisibleRows.findIndex(
            (r) => r.getAttribute('data-avatar-id') === state.lastMultiClickedAvatarId
          );
          const idxB = allVisibleRows.findIndex((r) => r.getAttribute('data-avatar-id') === id);
          if (idxA !== -1 && idxB !== -1) {
            const [start, end] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
            for (let k = start; k <= end; k++) {
              const rangeId = allVisibleRows[k].getAttribute('data-avatar-id');
              if (!rangeId) continue;
              if (shouldCheck) state.multiSelectedIds.add(rangeId);
              else state.multiSelectedIds.delete(rangeId);
            }
          }
        }
        if (shouldCheck) {
          state.multiSelectedIds.add(id);
        } else {
          state.multiSelectedIds.delete(id);
        }
        state.lastMultiClickedAvatarId = id;
        syncMultiSelectionDomInPlace();
        return;
      }

      if (modal.id === 'st_pw_wardrobe_modal') {
        state.selectedAvatarId = id;
        state.expandedTraitIdx = null;
        renderWardrobeModalContent();
      }
    });
  });

  modal.querySelectorAll('.st-pw-fav-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-avatar-id');
      if (!id) return;
      const meta = ensureProfileMeta(id);
      meta.favorite = !meta.favorite;
      saveSettings();
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-use-persona-btn, .st-pw-detail-switch-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-avatar-id');
      if (id) {
        state.selectedAvatarId = id;
        await switchActivePersona(id);
      }
    });
  });

  modal.querySelectorAll('.st-pw-act-jump-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const book = btn.getAttribute('data-book');
      jumpToWorldbookInHost(book, { fromWardrobeModal: true });
    });
  });

  modal.querySelectorAll('.st-pw-act-popup-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const book = btn.getAttribute('data-book');
      openWorldbookInspectorModal(book);
    });
  });

  if (!selectedPersona) return;
  const meta = selectedPersona.meta;

  modal.querySelector('#st_pw_detail_group')?.addEventListener('change', async (e) => {
    const selectEl = e.target;
    if (selectEl.value === '__new__') {
      const newGroup = await promptUserText('新建自定义分组', '', {
        placeholder: '输入新分组名称…',
      });
      if (newGroup && newGroup.trim()) {
        const clean = newGroup.trim();
        if (!settings.groups.includes(clean)) settings.groups.push(clean);
        meta.group = clean;
      } else {
        selectEl.value = meta.group || '';
        return;
      }
    } else {
      meta.group = selectEl.value;
    }
    saveSettings();
    rerenderPanels();
  });

  modal.querySelector('#st_pw_detail_tags')?.addEventListener('change', (e) => {
    meta.tags = e.target.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    saveSettings();
    rerenderPanels();
  });

  modal.querySelector('#st_pw_bind_current_char_btn')?.addEventListener('click', async (e) => {
    const cName = e.currentTarget.getAttribute('data-char');
    if (cName) {
      await bindPersonaToCharacter(selectedPersona.avatarId, cName);
    }
  });

  modal.querySelector('#st_pw_bind_char_select')?.addEventListener('change', async (e) => {
    const selectEl = e.target;
    let val = selectEl.value;
    if (!val) return;
    if (val === '__custom__') {
      val =
        (await promptUserText('手动输入角色卡名称', '', {
          placeholder: '输入要绑定的角色卡名称…',
        })) || '';
    }
    if (val.trim()) {
      await bindPersonaToCharacter(selectedPersona.avatarId, val.trim());
    } else {
      selectEl.value = '';
    }
  });

  modal.querySelectorAll('.st-pw-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cName = btn.getAttribute('data-char');
      if (cName) {
        unbindPersonaFromCharacter(selectedPersona.avatarId, cName);
      }
    });
  });

  modal.querySelectorAll('.st-pw-char-chip-jump').forEach((el) => {
    el.addEventListener('click', () => {
      const cName = el.getAttribute('data-char');
      if (cName) {
        state.activeFilter = `char:${cName}`;
        rerenderPanels();
      }
    });
  });

  modal.querySelector('#st_pw_primary_book_select')?.addEventListener('change', (e) => {
    const newBook = e.target.value;
    updateHostPersonaData(selectedPersona.avatarId, { lorebook: newBook });
  });

  modal.querySelector('#st_pw_add_extra_book_btn')?.addEventListener('click', () => {
    const sel = modal.querySelector('#st_pw_add_extra_book_select');
    const bookName = sel?.value?.trim();
    if (!bookName) return;
    if (!meta.extraWorldbooks.some((b) => b.name === bookName)) {
      meta.extraWorldbooks.push({ name: bookName, enabled: true });
      saveSettings();
      rerenderPanels();
    }
  });

  modal.querySelectorAll('.st-pw-toggle-extra-book').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.extraWorldbooks[idx]) {
        meta.extraWorldbooks[idx].enabled = e.target.checked;
        saveSettings();
        rerenderPanels();
      }
    });
  });

  modal.querySelectorAll('.st-pw-remove-extra-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      meta.extraWorldbooks.splice(idx, 1);
      saveSettings();
      rerenderPanels();
    });
  });

  modal.querySelector('#st_pw_add_trait_btn')?.addEventListener('click', () => {
    meta.traits.push({
      id: `trait_${Date.now()}`,
      title: `设定 #${meta.traits.length + 1}`,
      content: '',
      enabled: true,
      triggerMode: 'always',
      keywords: '',
    });
    state.expandedTraitIdx = meta.traits.length - 1;
    saveSettings();
    rerenderPanels();
  });

  modal.querySelectorAll('.st-pw-trait-enable').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].enabled = e.target.checked;
        saveSettings();
        rerenderPanels();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-toggle-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].triggerMode =
          meta.traits[idx].triggerMode === 'keyword' ? 'always' : 'keyword';
        state.expandedTraitIdx = idx;
        saveSettings();
        rerenderPanels();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-expand').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.getAttribute('data-idx'));
      state.expandedTraitIdx = state.expandedTraitIdx === idx ? null : idx;
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-trait-title').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].title = e.target.value.trim();
        saveSettings();
        rerenderPanels();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-keywords').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].keywords = e.target.value;
        saveSettings();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-content').forEach((ta) => {
    ta.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].content = e.target.value;
        saveSettings();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      meta.traits.splice(idx, 1);
      if (state.expandedTraitIdx === idx) state.expandedTraitIdx = null;
      saveSettings();
      rerenderPanels();
    });
  });

  modal.querySelector('#st_pw_save_base_desc_btn')?.addEventListener('click', () => {
    const newDesc = modal.querySelector('#st_pw_base_description')?.value ?? '';
    const newNote = modal.querySelector('#st_pw_private_note')?.value ?? '';
    meta.note = newNote;
    updateHostPersonaData(selectedPersona.avatarId, { description: newDesc });
    globalThis.toastr?.success?.('已保存');
  });

  modal.querySelector('#st_pw_private_note')?.addEventListener('change', (e) => {
    meta.note = e.target.value;
    saveSettings();
  });

  // ==================== 变体克隆 & 状态快照预设事件 ====================
  modal.querySelector('.st-pw-save-preset-btn')?.addEventListener('click', async () => {
    const defaultName = `状态 #${(meta.presets?.length || 0) + 1}`;
    const name = await promptUserText('保存状态快照预设', defaultName, {
      subtitle: '例如：日常态 / 战斗态 / IF线',
    });
    if (!name || !name.trim()) return;
    const snap = await captureCurrentPersonaSnapshot(selectedPersona, name.trim());
    if (!snap) return;
    meta.presets.push(snap);
    meta.activePresetId = snap.id;
    saveSettings();
    rerenderPanels();
    globalThis.toastr?.success?.(`已保存状态快照「${snap.name}」`);
  });

  modal.querySelector('.st-pw-clone-variant-btn')?.addEventListener('click', async () => {
    await clonePersonaVariant(selectedPersona);
  });

  modal.querySelectorAll('.st-pw-apply-preset-btn').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = el.getAttribute('data-preset-id');
      if (presetId) {
        await applyPersonaSnapshotPreset(selectedPersona, presetId);
      }
    });
  });

  modal.querySelectorAll('.st-pw-overwrite-preset-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = btn.getAttribute('data-preset-id');
      const idx = meta.presets.findIndex((p) => p.id === presetId);
      if (idx === -1) return;
      const oldPreset = meta.presets[idx];
      const updated = await captureCurrentPersonaSnapshot(
        selectedPersona,
        oldPreset.name,
        oldPreset.id
      );
      if (!updated) return;
      meta.presets[idx] = updated;
      meta.activePresetId = updated.id;
      saveSettings();
      rerenderPanels();
      globalThis.toastr?.success?.(`已用当前状态更新快照「${updated.name}」`);
    });
  });

  modal.querySelectorAll('.st-pw-preset-to-variant-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = btn.getAttribute('data-preset-id');
      const preset = meta.presets.find((p) => p.id === presetId);
      if (!preset) return;
      await clonePersonaVariant(selectedPersona, { fromPreset: preset });
    });
  });

  modal.querySelectorAll('.st-pw-delete-preset-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = btn.getAttribute('data-preset-id');
      const preset = meta.presets.find((p) => p.id === presetId);
      if (!preset) return;
      if (
        !(await confirmUserAction('删除状态快照', `确定删除状态快照「${preset.name}」吗？`))
      ) {
        return;
      }
      meta.presets = meta.presets.filter((p) => p.id !== presetId);
      if (meta.activePresetId === presetId) {
        meta.activePresetId = '';
      }
      saveSettings();
      rerenderPanels();
    });
  });

  // ==================== 使用足迹统计（聊过角色卡 · 聊天档 · 时长）事件 ====================
  modal.querySelectorAll('.st-pw-scan-history-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await scanAllHistoricalChatsForStats();
    });
  });

  modal.querySelectorAll('.st-pw-toggle-stats-detail-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.showStatsDetail = !state.showStatsDetail;
      rerenderPanels();
    });
  });

  modal.querySelectorAll('.st-pw-reset-user-stats-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (
        !(await confirmUserAction(
          '清空使用统计记录',
          `确定清空「${selectedPersona.name}」的使用统计记录吗？`
        ))
      ) {
        return;
      }
      meta.usageStats = { chats: {}, extraLiveMs: 0 };
      saveSettings();
      rerenderPanels();
    });
  });
}

async function openActivePromptPreviewModal() {
  const personas = getHostPersonas();
  const active = personas.find((p) => p.isActive);
  let chat = [];
  try {
    chat = getContext().chat || [];
  } catch (_e) {}

  const { blocks, summary } = await evaluateActivePersonaInjections(chat);

  let modal = document.querySelector('#st_pw_preview_modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'st_pw_preview_modal';
    modal.className = 'st-pw-modal-backdrop';
    document.body.appendChild(modal);
  }
  bindModalBackdropEvents(modal);
  modal.classList.remove('st-pw-hidden');

  modal.innerHTML = `
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true">
      <div class="st-pw-modal-header">
        <div class="st-pw-header-left">
          <span class="st-pw-modal-title">当前生效预览：${sanitizeHtml(active?.name || '无')}</span>
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-mini-btn st-pw-close-preview-btn" title="关闭"><i class="fa-solid fa-xmark"></i> 关闭</button>
        </div>
      </div>
      <div class="st-pw-wb-body">
        <div class="st-pw-block">
          <div class="st-pw-block-title">原生人设描述</div>
          <pre class="st-pw-code-preview">${sanitizeHtml(active?.description || '（空）')}</pre>
        </div>
        <div class="st-pw-block">
          <div class="st-pw-block-title">主绑定世界书</div>
          <div>${active?.lorebook ? sanitizeHtml(active.lorebook) : '未绑定'}</div>
        </div>
        <div class="st-pw-block">
          <div class="st-pw-block-title">本轮命中的附加书与随身设定 (${summary.length})</div>
          ${
            summary.length === 0
              ? `<div class="st-pw-muted">无额外命中项</div>`
              : `
                <ul class="st-pw-hit-list">
                  ${summary
                    .map(
                      (s) =>
                        `<li><strong>${sanitizeHtml(s.book ? `[${s.book}] ${s.title}` : s.title)}</strong> <span class="st-pw-muted">(${sanitizeHtml(s.reason)})</span></li>`
                    )
                    .join('')}
                </ul>
                <pre class="st-pw-code-preview">${sanitizeHtml(blocks.join('\n\n'))}</pre>
              `
          }
        </div>
      </div>
    </div>
  `;

  modal.querySelector('.st-pw-close-preview-btn')?.addEventListener('click', () => {
    modal.classList.add('st-pw-hidden');
  });
}

/**
 * 直接接管酒馆/Luker 原生的人设栏目 (#PersonaManagement)
 * - 左栏 (.persona_management_left_column)：直接接管为「按绑定角色自动成组 + 自定义分组折叠树 + 搜索 + 新建/上传头像 + 一键切回原生平铺列表」
 * - 右栏 (.persona_management_right_column)：在保留原生改名/换头像/复制/删除/描述/位置/连接的前提下，原位嵌入「分组与角色绑定、主/附加世界书（下拉+查看条目+跳转编辑器）、随身设定、生效预览与私密备注」
 */
function buildGroupedTreeSectionsHtml(personas, selectedAvatarId, characterGroups, customGroups, ungroupedMembers, q) {
  // 单项模式筛选：收藏 / 全局人设 / 卡内专属 / 已聊过
  if (state.activeFilter === 'fav') {
    const favList = personas.filter((p) => p.meta.favorite && matchesSearch(p, q));
    return favList.length
      ? favList.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
      : `<div class="st-pw-empty-state">暂无收藏的 User</div>`;
  }
  if (state.activeFilter === 'global') {
    const globalList = personas.filter((p) => !p.isLukerCharacterOnly && matchesSearch(p, q));
    return globalList.length
      ? globalList.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
      : `<div class="st-pw-empty-state">无匹配的全局人设</div>`;
  }
  if (state.activeFilter === 'dedicated') {
    const dedList = personas.filter((p) => p.isLukerCharacterOnly && matchesSearch(p, q));
    return dedList.length
      ? dedList.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
      : `<div class="st-pw-empty-state">无匹配的卡内专属人设</div>`;
  }
  if (state.activeFilter === 'chatted') {
    const chattedList = personas.filter((p) => {
      const u = getPersonaUsageSummary(p.avatarId);
      return (u.chatCount > 0 || u.durationMs > 0) && matchesSearch(p, q);
    });
    return chattedList.length
      ? chattedList.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
      : `<div class="st-pw-empty-state">暂无有聊天记录的 User，可点右侧「扫描历史档」回溯</div>`;
  }

  const sections = [];

  // 识别「同一通用 User 被原生连线锁到了 >= 3 个单人角色卡」的情况：
  // 避免 1 个通用 User 连了 30 张卡时在全部视图中衍生出 30 个重复的单人文件夹刷屏！
  const soloCharCountByAvatar = new Map();
  for (const cg of characterGroups) {
    if (!cg.isCurrentChar && cg.members.length === 1) {
      const mId = cg.members[0].avatarId;
      soloCharCountByAvatar.set(mId, (soloCharCountByAvatar.get(mId) || 0) + 1);
    }
  }
  const generalMultiBoundMap = new Map();

  // 1) 自动角色分组（绑在同一角色下的多个 User 自动归为一组）
  for (const cg of characterGroups) {
    if (state.activeFilter !== 'all' && state.activeFilter !== cg.id) continue;

    const isBatchOpen =
      state.batchAssignTarget?.type === 'character' &&
      state.batchAssignTarget?.name.toLowerCase() === cg.name.toLowerCase();

    if (
      state.activeFilter === 'all' &&
      !cg.isCurrentChar &&
      !isBatchOpen &&
      cg.members.length === 1 &&
      (soloCharCountByAvatar.get(cg.members[0].avatarId) || 0) >= 3
    ) {
      const p = cg.members[0];
      generalMultiBoundMap.set(p.avatarId, p);
      continue;
    }

    const visibleMembers = cg.members.filter((p) => matchesSearch(p, q));
    if (q && visibleMembers.length === 0) continue;
    const isCollapsed = state.collapsedSections.has(cg.id);

    sections.push(`
      <div class="st-pw-folder-section" data-section-id="${escapeAttr(cg.id)}">
        <div class="st-pw-folder-header">
          <div class="st-pw-folder-title-wrap st-pw-folder-toggle" data-section-id="${escapeAttr(cg.id)}">
            <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} st-pw-folder-arrow"></i>
            ${
              cg.avatarUrl
                ? `<img class="st-pw-folder-char-avatar" src="${escapeAttr(cg.avatarUrl)}" loading="lazy" decoding="async" alt="" onerror="this.style.display='none'" />`
                : `<i class="fa-solid fa-user-tag st-pw-folder-icon"></i>`
            }
            <span class="st-pw-folder-name">${sanitizeHtml(cg.name)}</span>
            <span class="st-pw-folder-count">${cg.members.length}</span>
            ${cg.isCurrentChar ? `<span class="st-pw-tiny-tag">当前角色</span>` : ''}
          </div>
          <div class="st-pw-folder-actions">
            ${
              state.multiSelectMode && !isCollapsed && visibleMembers.length > 0
                ? `<button type="button" class="st-pw-link-btn st-pw-multi-select-section" title="全选或取消本组所有可见人设">全选本组</button>`
                : ''
            }
            <button type="button" class="st-pw-icon-btn st-pw-open-batch-char" data-char-name="${escapeAttr(cg.name)}" title="勾选/管理绑定到此角色下的多个 User">
              <i class="fa-solid fa-user-plus"></i>
            </button>
          </div>
        </div>
        ${isBatchOpen ? renderBatchChecklistHtml('character', cg.name, personas) : ''}
        ${
          !isCollapsed
            ? `<div class="st-pw-folder-body">${
                visibleMembers.length
                  ? visibleMembers.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
                  : `<div class="st-pw-muted-hint">无匹配项</div>`
              }</div>`
            : ''
        }
      </div>
    `);
  }

  // 1.5) 绑定了 >= 3 个单人角色卡的通用人设聚合组（只展示 1 次，不再重复刷出几十个单人卡片组）
  if (state.activeFilter === 'all' && generalMultiBoundMap.size > 0) {
    const generalMembers = [...generalMultiBoundMap.values()].filter(
      (p) => !p.meta.group && matchesSearch(p, q)
    );
    if (generalMembers.length > 0) {
      const isCollapsed = state.collapsedSections.has('multi_char_general');
      sections.push(`
        <div class="st-pw-folder-section" data-section-id="multi_char_general">
          <div class="st-pw-folder-header">
            <div class="st-pw-folder-title-wrap st-pw-folder-toggle" data-section-id="multi_char_general">
              <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} st-pw-folder-arrow"></i>
              <i class="fa-solid fa-users-gear st-pw-folder-icon"></i>
              <span class="st-pw-folder-name">多角色通用绑定</span>
              <span class="st-pw-folder-count">${generalMembers.length}</span>
            </div>
            ${
              state.multiSelectMode && !isCollapsed && generalMembers.length > 0
                ? `<div class="st-pw-folder-actions"><button type="button" class="st-pw-link-btn st-pw-multi-select-section">全选本组</button></div>`
                : ''
            }
          </div>
          ${
            !isCollapsed
              ? `<div class="st-pw-folder-body">${generalMembers
                  .map((p) => renderPersonaRowHtml(p, selectedAvatarId))
                  .join('')}</div>`
              : ''
          }
        </div>
      `);
    }
  }

  // 2) 用户自定义分组
  for (const grp of customGroups) {
    if (state.activeFilter !== 'all' && state.activeFilter !== grp.id) continue;
    const visibleMembers = grp.members.filter((p) => matchesSearch(p, q));
    if (q && visibleMembers.length === 0) continue;
    const isCollapsed = state.collapsedSections.has(grp.id);
    const isBatchOpen =
      state.batchAssignTarget?.type === 'group' &&
      state.batchAssignTarget?.name === grp.name;

    sections.push(`
      <div class="st-pw-folder-section" data-section-id="${escapeAttr(grp.id)}">
        <div class="st-pw-folder-header">
          <div class="st-pw-folder-title-wrap st-pw-folder-toggle" data-section-id="${escapeAttr(grp.id)}">
            <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} st-pw-folder-arrow"></i>
            <i class="fa-regular fa-folder st-pw-folder-icon"></i>
            <span class="st-pw-folder-name">${sanitizeHtml(grp.name)}</span>
            <span class="st-pw-folder-count">${grp.members.length}</span>
          </div>
          <div class="st-pw-folder-actions">
            ${
              state.multiSelectMode && !isCollapsed && visibleMembers.length > 0
                ? `<button type="button" class="st-pw-link-btn st-pw-multi-select-section" title="全选或取消本组所有可见人设">全选本组</button>`
                : ''
            }
            <button type="button" class="st-pw-icon-btn st-pw-open-batch-group" data-group-name="${escapeAttr(grp.name)}" title="批量勾选移入此分组的 User">
              <i class="fa-solid fa-user-plus"></i>
            </button>
            <button type="button" class="st-pw-icon-btn st-pw-rename-group-btn" data-group-name="${escapeAttr(grp.name)}" title="重命名分组">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="st-pw-icon-btn st-pw-delete-group-btn" data-group-name="${escapeAttr(grp.name)}" title="删除分组">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        ${isBatchOpen ? renderBatchChecklistHtml('group', grp.name, personas) : ''}
        ${
          !isCollapsed
            ? `<div class="st-pw-folder-body">${
                visibleMembers.length
                  ? visibleMembers.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
                  : `<div class="st-pw-muted-hint">组内暂无 User，点右上角小人图标可批量勾选加入</div>`
              }</div>`
            : ''
        }
      </div>
    `);
  }

  // 3) 未分组 User
  if (state.activeFilter === 'all' || state.activeFilter === 'ungrouped') {
    const visibleUngrouped = ungroupedMembers.filter((p) => matchesSearch(p, q));
    if (characterGroups.length === 0 && customGroups.length === 0) {
      return visibleUngrouped.length
        ? visibleUngrouped.map((p) => renderPersonaRowHtml(p, selectedAvatarId)).join('')
        : `<div class="st-pw-empty-state">无匹配人设</div>`;
    }
    if (visibleUngrouped.length > 0 || state.activeFilter === 'ungrouped') {
      const isCollapsed = state.collapsedSections.has('ungrouped');
      sections.push(`
        <div class="st-pw-folder-section" data-section-id="ungrouped">
          <div class="st-pw-folder-header">
            <div class="st-pw-folder-title-wrap st-pw-folder-toggle" data-section-id="ungrouped">
              <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} st-pw-folder-arrow"></i>
              <span class="st-pw-folder-name st-pw-muted">未分组</span>
              <span class="st-pw-folder-count">${visibleUngrouped.length}</span>
            </div>
            ${
              state.multiSelectMode && !isCollapsed && visibleUngrouped.length > 0
                ? `<div class="st-pw-folder-actions"><button type="button" class="st-pw-link-btn st-pw-multi-select-section" title="一键全选未分组人设">全选本组</button></div>`
                : ''
            }
          </div>
          ${
            !isCollapsed
              ? `<div class="st-pw-folder-body">${visibleUngrouped
                  .map((p) => renderPersonaRowHtml(p, selectedAvatarId))
                  .join('')}</div>`
              : ''
          }
        </div>
      `);
    }
  }

  return sections.length ? sections.join('') : `<div class="st-pw-empty-state">无匹配人设</div>`;
}

function syncNativePersonaPanelEnhancement({ forceRight = false } = {}) {
  const settings = getSettings();
  const leftCol = document.querySelector('#PersonaManagement .persona_management_left_column');
  const existingLeftPanel = document.querySelector('#st_pw_inline_left_panel');
  const existingRightPanel = document.querySelector('#st_pw_native_persona_helper');

  if (!settings.enhanceNativePersonaPanel) {
    restoreNativeLeftColumnElements(leftCol);
    existingLeftPanel?.remove();
    existingRightPanel?.remove();
    return;
  }

  const personas = getHostPersonas();
  const activePersona = personas.find((p) => p.isActive) || null;
  const availableBooks = getAvailableWorldbooks();
  const hostChars = getHostCharacters();
  const currentChar = getCurrentCharacter();
  const currentCharName = currentChar?.name || '';

  const { characterGroups, customGroups, ungroupedMembers } =
    buildUnifiedPersonaGroups(personas);

  if (
    state.activeFilter.startsWith('char:') &&
    !characterGroups.some((cg) => cg.id === state.activeFilter)
  ) {
    state.activeFilter = 'all';
  }
  if (
    state.activeFilter.startsWith('group:') &&
    !customGroups.some((g) => g.id === state.activeFilter)
  ) {
    state.activeFilter = 'all';
  }

  const targetPersona =
    activePersona ||
    personas.find((p) => p.avatarId === state.selectedAvatarId) ||
    personas[0] ||
    null;

  if (targetPersona && !state.selectedAvatarId) {
    state.selectedAvatarId = targetPersona.avatarId;
  }

  const drawerEl = document.querySelector('#PersonaManagement');
  const rightCol = document.querySelector('#PersonaManagement .persona_management_right_column');

  // ==================== 1. 左栏原位接管 (.persona_management_left_column) ====================
  if (leftCol) {
    let leftPanel = existingLeftPanel;
    if (!leftPanel) {
      leftPanel = document.createElement('div');
      leftPanel.id = 'st_pw_inline_left_panel';
      leftPanel.className = 'st-pw-inline-left-panel';
      leftCol.insertBefore(leftPanel, leftCol.firstChild);
    }
    bindAvatarErrorFallback(leftPanel);

    // 如果用户正在展开左栏的下拉菜单 (<select>)，不要在后台重绘冲掉已打开的下拉框
    const isLeftSelectFocused =
      !forceRight &&
      document.activeElement &&
      leftPanel.contains(document.activeElement) &&
      document.activeElement.tagName === 'SELECT';

    if (!isLeftSelectFocused) {
      if (state.useRawNativeLeftList) {
        restoreNativeLeftColumnElements(leftCol);
        const rawBarHtml = `
          <div class="st-pw-raw-mode-bar">
            <span class="st-pw-muted">当前为原生平铺列表</span>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-toggle-raw-list-btn">
              <i class="fa-solid fa-folder-tree"></i> 切回分组接管视图
            </button>
          </div>
        `;
        if (leftPanel.childElementCount === 0 || state.lastLeftRenderedHtml !== rawBarHtml) {
          state.lastLeftRenderedHtml = rawBarHtml;
          leftPanel.innerHTML = rawBarHtml;
          leftPanel.querySelector('.st-pw-toggle-raw-list-btn')?.addEventListener('click', () => {
            state.useRawNativeLeftList = false;
            syncNativePersonaPanelEnhancement({ forceRight: true });
          });
        }
      } else {
        syncNativeLeftColumnVisibility(leftCol);
        const q = state.searchQuery.trim().toLowerCase();
        const wasSearchFocused =
          document.activeElement &&
          document.activeElement.id === 'st_pw_inline_search_input';
        const searchCursorPos = wasSearchFocused ? document.activeElement.selectionStart : null;

        const nextLeftHtml = `
          <div class="st-pw-inline-left-top">
            <input type="search" id="st_pw_inline_search_input" class="text_pole st-pw-sidebar-search" placeholder="搜索 User、角色组、自定义组、世界书…" value="${escapeAttr(state.searchQuery)}" />
            <button type="button" class="menu_button st-pw-mini-btn st-pw-toggle-multi-btn ${state.multiSelectMode ? 'is-active-mode' : ''}" title="开启多选模式，一次性将多个 User 批量移入分组、绑卡、绑世界书或删除">
              <i class="fa-${state.multiSelectMode ? 'solid fa-check-double' : 'regular fa-square-check'}"></i> ${state.multiSelectMode ? `完成${state.multiSelectedIds.size > 0 ? ` (${state.multiSelectedIds.size})` : ''}` : '多选'}
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-inline-create-btn" title="调用原生新建人设">
              <i class="fa-solid fa-plus"></i> 新建
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-inline-upload-btn" title="上传头像新建人设">
              <i class="fa-solid fa-image"></i> 头像
            </button>
            ${
              targetPersona
                ? `<button type="button" class="menu_button st-pw-mini-btn st-pw-inline-change-avatar-btn" title="更换当前选中 User 的头像">换图</button>`
                : ''
            }
            <button type="button" class="menu_button st-pw-mini-btn st-pw-sync-cloud-avatars-btn" title="一键唤醒原生人设池同步图床/云端/美化插件头像">
              刷图
            </button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-toggle-raw-list-btn" title="切换到酒馆原生平铺列表">
              原生列表
            </button>
          </div>

          <div class="st-pw-sidebar-create-bar">
            <select id="st_pw_inline_char_group_select" class="text_pole st-pw-flex-select" title="选一个角色卡，把多个 User 绑到它下面自动归为一组">
              <option value="">+ 按角色绑一组 User…</option>
              ${
                currentCharName
                  ? `<option value="${escapeAttr(currentCharName)}">当前角色：${sanitizeHtml(currentCharName)}</option>`
                  : ''
              }
              ${hostChars
                .filter((c) => c.name !== currentCharName)
                .map((c) => `<option value="${escapeAttr(c.name)}">${sanitizeHtml(c.name)}</option>`)
                .join('')}
            </select>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-inline-add-group-btn" title="新建自定义分组">
              + 自定义组
            </button>
          </div>

          ${renderFilterPillsBarHtml(personas, characterGroups, customGroups, ungroupedMembers)}
          ${renderMultiSelectToolbarHtml(settings, hostChars, currentCharName, availableBooks)}

          <div class="st-pw-persona-list st-pw-inline-persona-list">
            ${buildGroupedTreeSectionsHtml(
              personas,
              targetPersona?.avatarId,
              characterGroups,
              customGroups,
              ungroupedMembers,
              q
            )}
          </div>
        `;

        // 关键防回顶保护：若左栏 HTML 无任何实质变化，绝不重写 innerHTML（0 节点销毁、0 滚动跳回）
        if (leftPanel.childElementCount === 0 || nextLeftHtml !== state.lastLeftRenderedHtml) {
          const prevInlineList = leftPanel.querySelector('.st-pw-inline-persona-list');
          const savedInlineScroll = prevInlineList
            ? prevInlineList.scrollTop
            : state.savedInlineListScrollTop;
          const savedDrawerScroll = drawerEl ? drawerEl.scrollTop : 0;
          const savedLeftColScroll = leftCol ? leftCol.scrollTop : 0;
          const prevHeight = leftPanel.offsetHeight;
          if (prevHeight > 0) {
            leftPanel.style.minHeight = `${prevHeight}px`;
          }

          state.lastLeftRenderedHtml = nextLeftHtml;
          leftPanel.innerHTML = nextLeftHtml;

          if (wasSearchFocused) {
            const nextInput = leftPanel.querySelector('#st_pw_inline_search_input');
            if (nextInput) {
              nextInput.focus({ preventScroll: true });
              if (typeof searchCursorPos === 'number') {
                nextInput.setSelectionRange(searchCursorPos, searchCursorPos);
              }
            }
          }

          leftPanel.querySelector('#st_pw_inline_search_input')?.addEventListener('input', (e) => {
            state.searchQuery = e.target.value;
            state.savedInlineListScrollTop = 0;
            syncNativePersonaPanelEnhancement();
          });

          leftPanel.querySelector('.st-pw-inline-create-btn')?.addEventListener('click', () => {
            document.querySelector('#create_dummy_persona')?.click();
          });

          leftPanel.querySelector('.st-pw-inline-upload-btn')?.addEventListener('click', async () => {
            await triggerPersonaAvatarUpload({ targetAvatarId: '' });
          });

          leftPanel
            .querySelector('.st-pw-inline-change-avatar-btn')
            ?.addEventListener('click', async () => {
              if (targetPersona?.avatarId) {
                await triggerPersonaAvatarUpload({ targetAvatarId: targetPersona.avatarId });
              }
            });

          leftPanel
            .querySelector('.st-pw-sync-cloud-avatars-btn')
            ?.addEventListener('click', async () => {
              await refreshDiskAvatarSet();
              await runUniversalNativeAvatarHarvest({ manual: true });
            });

          leftPanel.querySelector('.st-pw-toggle-raw-list-btn')?.addEventListener('click', async () => {
            state.useRawNativeLeftList = true;
            syncNativePersonaPanelEnhancement({ forceRight: true });
            try {
              await state.hostPersonasModule?.getUserAvatars?.(true, getActiveAvatarId());
            } catch (_e) {}
          });

          // 使用与主窗口一致的分组树交互绑定
          bindWardrobeModalEvents(leftPanel, targetPersona, personas);

          // 在原生人设栏目左栏点击某个人设行时，直接切换为该人设（多选模式下仅勾选，不触发切换）
          leftPanel.querySelectorAll('.st-pw-persona-item').forEach((card) => {
            card.addEventListener('click', async (e) => {
              if (state.multiSelectMode) return;
              if (
                e.target.closest('.st-pw-fav-btn') ||
                e.target.closest('.st-pw-use-persona-btn')
              ) {
                return;
              }
              const id = card.getAttribute('data-avatar-id');
              if (!id) return;
              state.selectedAvatarId = id;
              state.expandedTraitIdx = null;
              await switchActivePersona(id);
              refreshAllViews();
            });
          });

          const nextInlineList = leftPanel.querySelector('.st-pw-inline-persona-list');
          if (nextInlineList) {
            nextInlineList.scrollTop = savedInlineScroll;
            nextInlineList.addEventListener(
              'scroll',
              () => {
                state.savedInlineListScrollTop = nextInlineList.scrollTop;
              },
              { passive: true }
            );
          }
          if (leftCol) leftCol.scrollTop = savedLeftColScroll;
          if (drawerEl) drawerEl.scrollTop = savedDrawerScroll;

          requestAnimationFrame(() => {
            leftPanel.style.minHeight = '';
            if (nextInlineList && Math.abs(nextInlineList.scrollTop - savedInlineScroll) > 2) {
              nextInlineList.scrollTop = savedInlineScroll;
            }
            if (drawerEl && Math.abs(drawerEl.scrollTop - savedDrawerScroll) > 2) {
              drawerEl.scrollTop = savedDrawerScroll;
            }
          });
        }
      }
    }
  }

  // ==================== 2. 右栏原位接管 (.persona_management_right_column) ====================
  const personaControlsRow = document.querySelector('#persona_controls');
  const anchorEl =
    personaControlsRow ||
    document.querySelector('#persona_description_lorebook') ||
    document.querySelector('#persona_description');

  if (!anchorEl || !targetPersona) return;

  let rightPanel = existingRightPanel;
  if (!rightPanel) {
    rightPanel = document.createElement('div');
    rightPanel.id = 'st_pw_native_persona_helper';
    rightPanel.className = 'st-pw-inline-right-workbench';
  }
  rightPanel.className = 'st-pw-inline-right-workbench';

  if (anchorEl.id === 'persona_description') {
    if (rightPanel.nextElementSibling !== anchorEl) {
      anchorEl.insertAdjacentElement('beforebegin', rightPanel);
    }
  } else if (rightPanel.previousElementSibling !== anchorEl) {
    anchorEl.insertAdjacentElement('afterend', rightPanel);
  }

  // 如果用户当前正在右栏接管面板的输入框或下拉菜单 (<select>) 中操作，避免后台重绘直接销毁展开中的下拉框
  if (
    !forceRight &&
    document.activeElement &&
    rightPanel.contains(document.activeElement) &&
    (document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.tagName === 'SELECT') &&
    document.activeElement.type !== 'checkbox'
  ) {
    return;
  }

  const meta = targetPersona.meta;
  const currentBook = targetPersona.lorebook || '';
  const isCurrentCharBound =
    currentCharName &&
    meta.boundCharacters.some((c) => c.toLowerCase() === currentCharName.toLowerCase());
  const unboundHostChars = hostChars.filter(
    (c) => !meta.boundCharacters.some((bc) => bc.toLowerCase() === c.name.toLowerCase())
  );

  const nextRightHtml = `
    <!-- 0. 使用足迹统计（聊过几个角色卡 · 几个聊天档 · 聊了多久） -->
    ${renderUsageStatsBlockHtml(targetPersona)}

    <!-- 1. 分组、标签与角色分组绑定 -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">分组与绑定角色卡（同角色绑多个 User 自动在左侧归为一组）</span>
        <div class="st-pw-inline-header-btns">
          ${
            currentCharName && !isCurrentCharBound
              ? `<button type="button" id="st_pw_bind_current_char_btn" class="menu_button st-pw-mini-btn" data-char="${escapeAttr(currentCharName)}">+ 绑到当前角色「${sanitizeHtml(currentCharName)}」</button>`
              : ''
          }
          <button type="button" class="menu_button st-pw-mini-btn st-pw-preview-active-prompt-btn">生效预览</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-native-wardrobe-btn" title="打开独立双栏大窗口">独立窗口</button>
        </div>
      </div>

      <div class="st-pw-detail-meta-inputs">
        <select id="st_pw_detail_group" class="text_pole" title="所属自定义分组">
          <option value="">自定义分组：无</option>
          ${settings.groups
            .map(
              (g) =>
                `<option value="${escapeAttr(g)}" ${meta.group === g ? 'selected' : ''}>分组：${sanitizeHtml(g)}</option>`
            )
            .join('')}
          <option value="__new__">+ 新建自定义分组…</option>
        </select>
        <input type="text" id="st_pw_detail_tags" class="text_pole" placeholder="标签 (逗号分隔)" value="${escapeAttr(meta.tags.join(', '))}" />
      </div>

      <div class="st-pw-char-chips-row">
        ${
          meta.boundCharacters.length === 0
            ? `<span class="st-pw-muted" style="font-size:0.82rem;">未绑定角色组</span>`
            : meta.boundCharacters
                .map(
                  (cName) => `
                    <span class="st-pw-char-chip">
                      <span class="st-pw-char-chip-jump" data-char="${escapeAttr(cName)}" title="点击在左侧筛选该角色组下的所有 User">${sanitizeHtml(cName)}</span>
                      <button type="button" class="st-pw-chip-remove" data-char="${escapeAttr(cName)}" title="移出该角色组">×</button>
                    </span>
                  `
                )
                .join('')
        }
        <select id="st_pw_bind_char_select" class="text_pole st-pw-char-add-select">
          <option value="">+ 选择角色卡加入该角色组…</option>
          ${unboundHostChars
            .map((c) => `<option value="${escapeAttr(c.name)}">${sanitizeHtml(c.name)}</option>`)
            .join('')}
          <option value="__custom__">手动输入角色名…</option>
        </select>
      </div>
    </div>

    <!-- 1.5 变体克隆 & 状态快照预设 -->
    ${renderPresetsAndCloneBlockHtml(targetPersona)}

    <!-- 2. 世界书绑定（主世界书 + 附加世界书） -->
    <div class="st-pw-block">
      <div class="st-pw-block-title">世界书绑定</div>
      <div class="st-pw-wb-bind-row">
        <span class="st-pw-field-label">主世界书</span>
        <select id="st_pw_primary_book_select" class="text_pole st-pw-flex-select">
          <option value="">— 未绑定 —</option>
          ${availableBooks
            .map(
              (b) =>
                `<option value="${escapeAttr(b)}" ${currentBook === b ? 'selected' : ''}>${sanitizeHtml(b)}</option>`
            )
            .join('')}
        </select>
        <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(currentBook)}" ${!currentBook ? 'disabled' : ''}>
          查看条目
        </button>
        <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(currentBook)}" ${!currentBook ? 'disabled' : ''}>
          跳转编辑器
        </button>
      </div>

      <div class="st-pw-wb-bind-row">
        <span class="st-pw-field-label">附加书</span>
        <select id="st_pw_add_extra_book_select" class="text_pole st-pw-flex-select">
          <option value="">添加额外关联世界书…</option>
          ${availableBooks
            .filter((b) => b !== currentBook && !meta.extraWorldbooks.some((eb) => eb.name === b))
            .map((b) => `<option value="${escapeAttr(b)}">${sanitizeHtml(b)}</option>`)
            .join('')}
        </select>
        <button type="button" id="st_pw_add_extra_book_btn" class="menu_button st-pw-mini-btn">添加</button>
      </div>

      ${
        meta.extraWorldbooks.length > 0
          ? `
            <div class="st-pw-compact-rows">
              ${meta.extraWorldbooks
                .map(
                  (eb, idx) => `
                    <div class="st-pw-compact-row ${eb.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                      <input type="checkbox" class="st-pw-toggle-extra-book" data-idx="${idx}" ${eb.enabled ? 'checked' : ''} />
                      <span class="st-pw-row-main-text">${sanitizeHtml(eb.name)}</span>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(eb.name)}">条目</button>
                      <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(eb.name)}">跳转</button>
                      <button type="button" class="st-pw-icon-btn st-pw-remove-extra-book" data-idx="${idx}" title="移除"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
          : ''
      }
    </div>

    <!-- 3. 随身设定 & 私密备注 -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">随身设定 (${meta.traits.filter((t) => t.enabled).length}/${meta.traits.length})</span>
        <button type="button" id="st_pw_add_trait_btn" class="menu_button st-pw-mini-btn">+ 添加设定</button>
      </div>
      ${
        meta.traits.length === 0
          ? `<div class="st-pw-muted-hint">可添加随该 User 独立开关的补充设定片段（支持常驻或关键词触发）。</div>`
          : `
            <div class="st-pw-compact-rows">
              ${meta.traits
                .map((trait, idx) => {
                  const isExp = state.expandedTraitIdx === idx;
                  const isKw = trait.triggerMode === 'keyword';
                  return `
                    <div class="st-pw-trait-row ${trait.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                      <div class="st-pw-compact-row">
                        <input type="checkbox" class="st-pw-trait-enable" data-idx="${idx}" ${trait.enabled ? 'checked' : ''} />
                        <button type="button" class="st-pw-mode-tag ${isKw ? 'is-keyword' : 'is-constant'} st-pw-trait-toggle-mode" data-idx="${idx}" title="点击切换常驻 / 关键词">
                          <span class="st-pw-dot"></span>${isKw ? '关键词' : '常驻'}
                        </button>
                        <span class="st-pw-row-main-text st-pw-trait-expand" data-idx="${idx}">
                          ${sanitizeHtml(trait.title || `设定 #${idx + 1}`)}
                          ${isKw && trait.keywords ? `<small class="st-pw-muted"> (${sanitizeHtml(trait.keywords)})</small>` : ''}
                        </span>
                        <button type="button" class="st-pw-icon-btn st-pw-trait-expand" data-idx="${idx}">
                          <i class="fa-solid fa-chevron-${isExp ? 'up' : 'down'}"></i>
                        </button>
                        <button type="button" class="st-pw-icon-btn st-pw-trait-delete" data-idx="${idx}" title="删除">
                          <i class="fa-solid fa-xmark"></i>
                        </button>
                      </div>
                      ${
                        isExp
                          ? `
                            <div class="st-pw-trait-editor">
                              <div class="st-pw-form-grid">
                                <input type="text" class="text_pole st-pw-trait-title" data-idx="${idx}" placeholder="标题" value="${escapeAttr(trait.title)}" />
                                <input type="text" class="text_pole st-pw-trait-keywords" data-idx="${idx}" placeholder="触发关键词（逗号分隔，仅关键词模式生效）" value="${escapeAttr(trait.keywords || '')}" />
                              </div>
                              <textarea class="text_pole st-pw-trait-content" data-idx="${idx}" rows="4" placeholder="设定内容…">${sanitizeHtml(trait.content || '')}</textarea>
                            </div>
                          `
                          : ''
                      }
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
      }
      <div class="st-pw-inline-note-row">
        <input type="text" id="st_pw_private_note" class="text_pole" placeholder="私密备注（仅自己可见，不发给 AI）…" value="${escapeAttr(meta.note)}" />
      </div>
    </div>
  `;

  if (rightPanel.childElementCount > 0 && nextRightHtml === state.lastRightRenderedHtml) {
    return;
  }

  const savedDrawerScroll = drawerEl ? drawerEl.scrollTop : 0;
  const savedRightColScroll = rightCol ? rightCol.scrollTop : 0;
  const prevRightHeight = rightPanel.offsetHeight;
  if (prevRightHeight > 0) {
    rightPanel.style.minHeight = `${prevRightHeight}px`;
  }

  state.lastRightRenderedHtml = nextRightHtml;
  rightPanel.innerHTML = nextRightHtml;
  bindAvatarErrorFallback(rightPanel);

  rightPanel.querySelector('.st-pw-native-wardrobe-btn')?.addEventListener('click', () => {
    openWardrobeModal(targetPersona.avatarId);
  });

  bindWardrobeModalEvents(rightPanel, targetPersona, personas);

  if (rightCol) rightCol.scrollTop = savedRightColScroll;
  if (drawerEl) drawerEl.scrollTop = savedDrawerScroll;
  requestAnimationFrame(() => {
    rightPanel.style.minHeight = '';
    if (drawerEl && Math.abs(drawerEl.scrollTop - savedDrawerScroll) > 2) {
      drawerEl.scrollTop = savedDrawerScroll;
    }
  });
}

function syncQuickEntryButtons() {
  const settings = getSettings();

  const existingTopBtn = document.querySelector('#st_pw_topbar_btn');
  if (!settings.showTopbarButton) {
    existingTopBtn?.remove();
  } else if (!existingTopBtn) {
    const topBarHolder =
      document.querySelector('#top-settings-holder') ||
      document.querySelector('#top-bar');
    if (topBarHolder) {
      const btn = document.createElement('div');
      btn.id = 'st_pw_topbar_btn';
      btn.className = 'drawer st-pw-topbar-drawer';
      btn.innerHTML = `
        <div class="drawer-toggle">
          <div class="drawer-icon fa-solid fa-id-card-clip fa-fw closedIcon" title="User 人设管理"></div>
        </div>
      `;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openNativePersonaDrawer();
      });
      topBarHolder.appendChild(btn);
    }
  }

  const existingWandBtn = document.querySelector('#st_pw_wand_btn');
  if (!settings.showWandButton) {
    existingWandBtn?.remove();
  } else if (!existingWandBtn) {
    const extMenu = document.querySelector('#extensionsMenu');
    if (extMenu) {
      const item = document.createElement('div');
      item.id = 'st_pw_wand_btn';
      item.className = 'list-group-item flex-container flexGap5 interactable';
      item.tabIndex = 0;
      item.innerHTML = `
        <div class="fa-solid fa-id-card-clip extensionsMenuExtensionButton"></div>
        <span>User 人设管理</span>
      `;
      item.addEventListener('click', (e) => {
        e.preventDefault();
        openNativePersonaDrawer({ fromWandClick: true });
      });
      extMenu.appendChild(item);
    }
  }
}

function refreshAllViews() {
  const personas = getHostPersonas();
  const active = personas.find((p) => p.isActive);

  const activeUserEl = document.querySelector('#st_pw_drawer_active_user');
  const primaryBookEl = document.querySelector('#st_pw_drawer_primary_book');
  const extraSummaryEl = document.querySelector('#st_pw_drawer_extra_summary');

  if (activeUserEl) {
    activeUserEl.textContent = active
      ? `${active.name}${active.meta.group ? ` (${active.meta.group})` : ''}`
      : '未检测到';
  }
  if (primaryBookEl) {
    primaryBookEl.textContent = active?.lorebook || '未绑定';
  }
  if (extraSummaryEl) {
    const ebCount = active ? active.meta.extraWorldbooks.filter((b) => b.enabled).length : 0;
    const trCount = active ? active.meta.traits.filter((t) => t.enabled).length : 0;
    extraSummaryEl.textContent = `${ebCount} 附加书 · ${trCount} 随身设定`;
  }

  syncNativePersonaPanelEnhancement();
  syncQuickEntryButtons();
  renderWardrobeModalContent();
}

function onChatChanged() {
  recordCurrentOpenChatStats();
  refreshAllViews();
  const settings = getSettings();
  if (!settings.autoSwitchOnCharacterChat) return;

  try {
    const currentChar = getCurrentCharacter();
    if (!currentChar?.name) return;

    const personas = getHostPersonas();
    const matchedList = personas.filter((p) =>
      p.meta.boundCharacters.some((c) => c.toLowerCase() === currentChar.name.toLowerCase())
    );
    if (matchedList.length > 0 && !matchedList.some((p) => p.isActive)) {
      const names = matchedList.map((p) => p.name).join(' / ');
      globalThis.toastr?.info?.(
        `当前角色「${currentChar.name}」组内有 ${matchedList.length} 套人设：${names}`
      );
    }
  } catch (_e) {}
}

function registerSlashCommands() {
  try {
    const context = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    if (SlashCommandParser.commands?.['pwardrobe']) return;

    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: 'pwardrobe',
        aliases: ['userwardrobe'],
        callback: async (_namedArgs, unnamedArgs) => {
          const query = String(unnamedArgs ?? '').trim();
          if (!query) {
            openNativePersonaDrawer();
            return '';
          }
          const personas = getHostPersonas();
          const hit = personas.find(
            (p) =>
              p.name.toLowerCase() === query.toLowerCase() ||
              p.avatarId.toLowerCase() === query.toLowerCase()
          );
          if (hit) {
            await switchActivePersona(hit.avatarId);
            return hit.name;
          }
          openNativePersonaDrawer();
          return '';
        },
        unnamedArgumentList: SlashCommandArgument?.fromProps
          ? [
              SlashCommandArgument.fromProps({
                description: 'User 名字（留空打开管理面板）',
                typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : ['string'],
                isRequired: false,
              }),
            ]
          : [],
        helpString: '<div>打开 User 人设管理，或直接按名字切换当前 User。</div>',
      })
    );
  } catch (err) {
    console.warn(`[${MODULE_ID}] 注册斜杠命令跳过:`, err);
  }
}

async function mountSettingsPanel() {
  if (document.querySelector('#st_persona_wardrobe_settings')) return;
  const context = getContext();
  let html = '';

  if (typeof context.renderExtensionTemplateAsync === 'function') {
    try {
      html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    } catch (_e) {}
  }
  if (!html && globalThis.jQuery) {
    try {
      html = await globalThis.jQuery.get(`scripts/extensions/${EXTENSION_FOLDER}/settings.html`);
    } catch (_e) {}
  }

  const container =
    document.querySelector('#extensions_settings2') ||
    document.querySelector('#extensions_settings');
  if (!container || !html) return;

  container.insertAdjacentHTML('beforeend', html);

  const settings = getSettings();
  const bindCheckbox = (selector, key, afterChange) => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.checked = Boolean(settings[key]);
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      saveSettings();
      afterChange?.();
    });
  };

  bindCheckbox('#st_pw_enabled', 'enabled');
  bindCheckbox('#st_pw_enhance_native', 'enhanceNativePersonaPanel', syncNativePersonaPanelEnhancement);
  bindCheckbox('#st_pw_show_topbar', 'showTopbarButton', syncQuickEntryButtons);
  bindCheckbox('#st_pw_show_wand', 'showWandButton', syncQuickEntryButtons);
  bindCheckbox('#st_pw_auto_switch_char', 'autoSwitchOnCharacterChat');

  const scanInput = document.querySelector('#st_pw_scan_depth');
  if (scanInput) {
    scanInput.value = String(settings.scanDepth ?? 5);
    scanInput.addEventListener('change', () => {
      settings.scanDepth = Math.max(1, Math.min(50, Number(scanInput.value) || 5));
      saveSettings();
    });
  }

  document.querySelector('#st_pw_open_wardrobe_btn')?.addEventListener('click', () => {
    openNativePersonaDrawer();
  });

  document.querySelector('#st_pw_drawer_jump_book_btn')?.addEventListener('click', () => {
    const active = getHostPersonas().find((p) => p.isActive);
    jumpToWorldbookInHost(active?.lorebook, { fromWardrobeModal: false });
  });

  document.querySelector('#st_pw_drawer_popup_book_btn')?.addEventListener('click', () => {
    const active = getHostPersonas().find((p) => p.isActive);
    openWorldbookInspectorModal(active?.lorebook);
  });

  document.querySelector('#st_pw_export_btn')?.addEventListener('click', () => {
    const payload = JSON.stringify(getSettings(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `st-persona-wardrobe-${new Date().toISOString().slice(0, 10)}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 适配 TauriTavern download-bridge：保留 Blob URL 足够时长供异步原生文件落盘，避免立即 revoke 导致下载失败
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
  });

  const importFile = document.querySelector('#st_pw_import_file');
  document.querySelector('#st_pw_import_btn')?.addEventListener('click', () => {
    importFile?.click();
  });
  importFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.profiles !== 'object') {
        throw new Error('缺少 profiles 字段');
      }
      const current = getSettings();
      if (Array.isArray(parsed.groups)) {
        current.groups = [...new Set([...current.groups, ...parsed.groups])];
      }
      Object.assign(current.profiles, parsed.profiles);
      saveSettings();
      refreshAllViews();
      globalThis.toastr?.success?.('配置已导入');
    } catch (err) {
      globalThis.toastr?.error?.(`导入失败：${err.message}`);
    } finally {
      importFile.value = '';
    }
  });
}

async function reloadPersonaAvatarHttpCache(avatarId) {
  const clean = String(avatarId || '').trim();
  if (!clean) return;
  const urls = [`User Avatars/${encodeURIComponent(clean)}`];
  try {
    const context = getContext();
    if (typeof context.getThumbnailUrl === 'function' && !state.personaThumbnailUnsupported) {
      urls.push(context.getThumbnailUrl('persona', clean));
    }
  } catch (_e) {}
  await Promise.all(
    urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {}))
  );
}

/**
 * 适配 TauriTavern (Android / HarmonyOS) 物理与侧滑返回手势 (__TAURITAVERN_HANDLE_BACK__)：
 * 当本插件全屏弹窗处于打开状态时，侧滑返回优先关闭顶层弹窗，避免穿透关闭底层聊天界面
 */
function installTauriTavernBackBridge() {
  const BACK_KEY = '__TAURITAVERN_HANDLE_BACK__';
  if (globalThis[BACK_KEY]?._stPwWrapped) return;
  if (!isTauriTavernHost() && typeof globalThis[BACK_KEY] !== 'function') return;

  const prevHandler =
    typeof globalThis[BACK_KEY] === 'function' ? globalThis[BACK_KEY] : null;

  const wrappedBackHandler = () => {
    // 若当前有顶层原生 <dialog open> 弹窗（如输入/确认/头像裁剪框），优先交给宿主关闭顶层 dialog
    if (hasOpenHostPopupDialog()) {
      return prevHandler ? Boolean(prevHandler()) : false;
    }
    if (closeTopmostWardrobeModal()) {
      return true;
    }
    return prevHandler ? Boolean(prevHandler()) : false;
  };
  wrappedBackHandler._stPwWrapped = true;
  wrappedBackHandler._stPwPrev = prevHandler;
  globalThis[BACK_KEY] = wrappedBackHandler;

  state.disposers.push(() => {
    if (globalThis[BACK_KEY] === wrappedBackHandler) {
      if (prevHandler) {
        globalThis[BACK_KEY] = prevHandler;
      } else {
        delete globalThis[BACK_KEY];
      }
    }
  });
}

function ensureStylesheetCacheBusted(versionStr) {
  try {
    document
      .querySelectorAll('link[rel="stylesheet"]')
      .forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (href.includes('st-persona-wardrobe/style.css') && !href.includes(`v=${versionStr}`)) {
          const cleanHref = href.split('?')[0];
          link.setAttribute('href', `${cleanHref}?v=${versionStr}`);
        }
      });
  } catch (_e) {}
}

async function initExtension() {
  if (state.initialized) return;
  state.initialized = true;

  ensureStylesheetCacheBusted('1.2.0');
  await waitForTauriTavernReady();
  await probeHostModules();
  await refreshDiskAvatarSet();
  getSettings();
  scanExternalAvatarMappings();
  harvestCurrentNativeDomAvatars();
  await mountSettingsPanel();
  registerSlashCommands();
  installTauriTavernBackBridge();
  observeNativeAvatarBlock();
  recordCurrentOpenChatStats();
  refreshAllViews();
  scheduleAutoHistoricalStatsBackfill(450);

  const onGlobalKeydown = (e) => {
    state.lastUserInteractionAt = Date.now();
    if (e.key === 'Escape') {
      // 若顶层有原生 <dialog open> 弹窗正在展示，按 Esc 仅关闭顶层 dialog，不连带关闭底下衣柜总管
      if (hasOpenHostPopupDialog()) return;
      if (closeTopmostWardrobeModal()) {
        e.stopPropagation();
      }
    }
  };
  document.addEventListener('keydown', onGlobalKeydown);
  state.disposers.push(() => document.removeEventListener('keydown', onGlobalKeydown));

  const onUserActivity = () => {
    state.lastUserInteractionAt = Date.now();
  };
  document.addEventListener('mousedown', onUserActivity, { passive: true });
  document.addEventListener('touchstart', onUserActivity, { passive: true });
  state.disposers.push(() => {
    document.removeEventListener('mousedown', onUserActivity);
    document.removeEventListener('touchstart', onUserActivity);
  });

  // 实时聊天活跃计时器：仅在内存中静默累加活跃时长，绝不在定时器中调用 saveSettings() 触发全局 SETTINGS_UPDATED 导致滚动回顶
  const liveTimerId = setInterval(() => {
    try {
      if (document.hidden) return;
      if (Date.now() - state.lastUserInteractionAt > 120_000) return;
      const context = getContext();
      const activeId = getActiveAvatarId();
      if (!activeId) return;

      let entityKey = '';
      let chatFile = '';

      if (context.groupId) {
        const hostGroups = Array.isArray(context.groups) ? context.groups : [];
        const activeGroup = hostGroups.find((g) => String(g?.id) === String(context.groupId));
        if (!activeGroup) return;
        entityKey = String(activeGroup.avatar_url || `group:${activeGroup.id}`).trim();
        chatFile = String(
          activeGroup.chat_id ||
            context.chatId ||
            (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '') ||
            'active_group_chat'
        )
          .replace(/\.jsonl$/i, '')
          .trim();
      } else {
        const charId = context.characterId;
        if (charId === undefined || charId === null || Number(charId) < 0) return;
        const charObj = context.characters?.[charId];
        if (!charObj?.avatar) return;
        entityKey = String(charObj.avatar).trim();
        chatFile = String(
          charObj.chat ||
            context.chatId ||
            (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '') ||
            'active_chat'
        )
          .replace(/\.jsonl$/i, '')
          .trim();
      }

      if (!entityKey || !chatFile) return;

      const meta = ensureProfileMeta(activeId);
      const chatKey = `${entityKey}::${chatFile}`;
      if (meta.usageStats.chats[chatKey]) {
        meta.usageStats.chats[chatKey].durationMs =
          (Number(meta.usageStats.chats[chatKey].durationMs) || 0) + 15_000;
        meta.usageStats.chats[chatKey].lastActive = Date.now();
      } else {
        meta.usageStats.extraLiveMs = (Number(meta.usageStats.extraLiveMs) || 0) + 15_000;
      }
      state.lastUsageDirty = true;
    } catch (_e) {}
  }, 15_000);
  state.disposers.push(() => clearInterval(liveTimerId));

  const onVisibilityChange = () => {
    if (document.hidden && state.lastUsageDirty) {
      state.lastUsageDirty = false;
      saveSettings();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  state.disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  // 监听原生头像上传文件框 (#avatar_upload_file)：无需先去原生列表，上传或更换头像后自动破除缩略图缓存并刷新插件头像
  const onAvatarFileSelected = (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'avatar_upload_file') return;
    if (!target.files || target.files.length === 0) return;
    const overwriteName =
      document.querySelector('#avatar_upload_overwrite')?.value?.trim() || getActiveAvatarId();
    for (const delayMs of [700, 2000, 4200]) {
      setTimeout(async () => {
        const now = Date.now();
        if (overwriteName) {
          state.avatarCacheBust.set(overwriteName, now);
          await reloadPersonaAvatarHttpCache(overwriteName);
        }
        const curActive = getActiveAvatarId();
        if (curActive) {
          state.avatarCacheBust.set(curActive, now);
          if (curActive !== overwriteName) {
            await reloadPersonaAvatarHttpCache(curActive);
          }
        }
        await refreshDiskAvatarSet();
        invalidateRenderedHtmlCache();
        refreshAllViews();
      }, delayMs);
    }
  };
  document.addEventListener('change', onAvatarFileSelected, true);
  state.disposers.push(() => document.removeEventListener('change', onAvatarFileSelected, true));

  // 注意：只监听顶栏笑脸抽屉开关按钮 (.drawer-toggle)，绝不能绑定在父容器 #persona-management-button 上，
  // 否则在 #PersonaManagement 内部点击 <select> 世界书下拉框会冒泡触发 30ms 重绘并直接销毁展开中的下拉菜单！
  const personaDrawerToggle = document.querySelector('#persona-management-button > .drawer-toggle');
  if (personaDrawerToggle) {
    const onPersonaDrawerClick = (e) => {
      if (e?.target && document.querySelector('#PersonaManagement')?.contains(e.target)) {
        return;
      }
      setTimeout(() => {
        syncNativePersonaPanelEnhancement();
        scheduleAutoHistoricalStatsBackfill(120);
      }, 30);
    };
    personaDrawerToggle.addEventListener('click', onPersonaDrawerClick);
    state.disposers.push(() =>
      personaDrawerToggle.removeEventListener('click', onPersonaDrawerClick)
    );
  }

  try {
    const context = getContext();
    const { eventSource } = context;
    const evtTypes = context.eventTypes || context.event_types;
    if (eventSource && evtTypes) {
      const subscribe = (evtName, handler) => {
        if (!evtName) return;
        eventSource.on(evtName, handler);
        state.disposers.push(() => eventSource.removeListener?.(evtName, handler));
      };

      const onAppOrSettingsLoaded = async () => {
        await waitForTauriTavernReady();
        await probeHostModules();
        installTauriTavernBackBridge();
        await refreshDiskAvatarSet();
        scanExternalAvatarMappings();
        harvestCurrentNativeDomAvatars();
        invalidateRenderedHtmlCache();
        recordCurrentOpenChatStats();
        refreshAllViews();
        scheduleAutoHistoricalStatsBackfill(350);
      };

      const onChatMessageActivity = () => {
        state.lastUserInteractionAt = Date.now();
        if (state.lastUsageDirty) {
          state.lastUsageDirty = false;
          saveSettings();
        }
        recordCurrentOpenChatStats();
        refreshAllViews();
      };

      subscribe(evtTypes.APP_READY, onAppOrSettingsLoaded);
      subscribe(evtTypes.SETTINGS_LOADED_AFTER, onAppOrSettingsLoaded);
      subscribe(evtTypes.EXTENSION_SETTINGS_LOADED, onAppOrSettingsLoaded);
      subscribe(evtTypes.CHAT_LOADED, () => {
        recordCurrentOpenChatStats();
        refreshAllViews();
        scheduleAutoHistoricalStatsBackfill(300);
      });
      subscribe(evtTypes.CHAT_CHANGED, () => {
        if (state.lastUsageDirty) {
          state.lastUsageDirty = false;
          saveSettings();
        }
        onChatChanged();
        scheduleAutoHistoricalStatsBackfill(300);
      });
      subscribe(evtTypes.MESSAGE_SENT, onChatMessageActivity);
      subscribe(evtTypes.MESSAGE_RECEIVED, onChatMessageActivity);
      subscribe(evtTypes.GENERATION_ENDED, onChatMessageActivity);
      subscribe(evtTypes.SETTINGS_UPDATED, refreshAllViews);
      subscribe(evtTypes.WORLDINFO_UPDATED, () => {
        state.worldbookCache.clear();
        refreshAllViews();
      });
      subscribe(evtTypes.PERSONA_CHANGED, () => {
        recordCurrentOpenChatStats();
        refreshAllViews();
      });
      subscribe(evtTypes.PERSONA_CREATED, async () => {
        await refreshDiskAvatarSet();
        invalidateRenderedHtmlCache();
        refreshAllViews();
      });
      subscribe(evtTypes.PERSONA_UPDATED, () => {
        invalidateRenderedHtmlCache();
        refreshAllViews();
      });
      subscribe(evtTypes.PERSONA_RENAMED, () => {
        invalidateRenderedHtmlCache();
        refreshAllViews();
      });
      subscribe(evtTypes.PERSONA_DELETED, async () => {
        await refreshDiskAvatarSet();
        invalidateRenderedHtmlCache();
        refreshAllViews();
      });
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] 事件订阅警告:`, err);
  }
}

export async function onActivate() {
  await initExtension();
}

export async function onDisable() {
  if (state.harvestTimerId) {
    clearTimeout(state.harvestTimerId);
    state.harvestTimerId = null;
  }
  if (state.autoStatsScanTimerId) {
    clearTimeout(state.autoStatsScanTimerId);
    state.autoStatsScanTimerId = null;
  }
  if (state.avatarCacheSaveTimer) {
    clearTimeout(state.avatarCacheSaveTimer);
    state.avatarCacheSaveTimer = null;
  }
  while (state.disposers.length) {
    const dispose = state.disposers.pop();
    try {
      dispose?.();
    } catch (_e) {}
  }
  removeReturnToWardrobePill();
  document.querySelector('#PersonaManagement')?.classList.remove('st-pw-harvesting-drawer');
  restoreNativeLeftColumnElements(
    document.querySelector('#PersonaManagement .persona_management_left_column')
  );
  document.querySelector('#st_pw_inline_left_panel')?.remove();
  document.querySelector('#st_pw_wardrobe_modal')?.remove();
  document.querySelector('#st_pw_wb_inspector_modal')?.remove();
  document.querySelector('#st_pw_preview_modal')?.remove();
  document.querySelector('#st_pw_native_persona_helper')?.remove();
  document.querySelector('#st_pw_topbar_btn')?.remove();
  document.querySelector('#st_pw_wand_btn')?.remove();
  document.querySelector('#st_persona_wardrobe_settings')?.remove();
  state.worldbookCache.clear();
  state.initialized = false;
}

export async function onClean() {
  state.worldbookCache.clear();
}

if (typeof globalThis.jQuery === 'function') {
  globalThis.jQuery(() => {
    initExtension();
  });
}
try {
  const ctx = globalThis.SillyTavern?.getContext?.();
  if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
    ctx.eventSource.once(ctx.event_types.APP_READY, () => {
      initExtension();
    });
  }
} catch (_e) {}
