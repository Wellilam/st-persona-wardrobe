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
  showTopbarButton: true,
  showWandButton: true,
  autoSwitchOnCharacterChat: true,
  scanDepth: 5,
  groups: [],
  profiles: {},
});

const state = {
  initialized: false,
  disposers: [],
  activeFilter: 'all', // 'all' | 'fav' | 'char:<charKey>' | 'group:<groupName>' | 'ungrouped'
  collapsedSections: new Set(),
  batchAssignTarget: null, // null | { type: 'character', key: string, name: string } | { type: 'group', name: string }
  searchQuery: '',
  selectedAvatarId: null,
  expandedTraitIdx: null,
  worldbookCache: new Map(),
  lastPromptInjectedSummary: [],
  minimizedReturnPill: null,
  hostPersonasModule: null,
  hostWorldInfoModule: null,
};

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
    } catch (_e) {}
  }
  if (!state.hostWorldInfoModule) {
    try {
      state.hostWorldInfoModule = await import('../../../world-info.js');
    } catch (_e) {}
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
  return profile;
}

/**
 * 读取酒馆所有角色卡与群聊实体（用于识别角色下绑定的多个 User 并自动归组）
 */
function getHostCharacters() {
  try {
    const context = getContext();
    const chars = Array.isArray(context.characters) ? context.characters : [];
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
        isCurrent: idx === currentChid,
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

function resolvePersonaAvatarUrl(avatarId) {
  try {
    const context = getContext();
    if (typeof context.getThumbnailUrl === 'function') {
      return context.getThumbnailUrl('persona', avatarId);
    }
  } catch (_e) {}
  return `/User Avatars/${encodeURIComponent(avatarId)}`;
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

  const rawChars = Array.isArray(context?.characters) ? context.characters : [];
  const hostChars = getHostCharacters();
  const charByAvatar = new Map(hostChars.map((c) => [c.avatar, c]));
  const charByNameLower = new Map(hostChars.map((c) => [c.name.toLowerCase(), c]));
  const hostGroups = Array.isArray(context?.groups) ? context.groups : [];
  const groupById = new Map(hostGroups.map((g) => [String(g.id), String(g.name || g.id)]));

  const activeAvatarId = getActiveAvatarId();
  const resultMap = new Map();

  for (const [avatarId, displayName] of Object.entries(personasMap)) {
    const descObj = descMap[avatarId] || {};
    const isCurrent = avatarId === activeAvatarId;
    const effectiveLorebook = String(
      descObj.lorebook || (isCurrent ? pu.persona_description_lorebook || '' : '')
    );
    const connections = Array.isArray(descObj.connections) ? descObj.connections : [];

    resultMap.set(avatarId, {
      avatarId,
      name: String(displayName || avatarId),
      description: String(descObj.description ?? (isCurrent ? pu.persona_description ?? '' : '')),
      lorebook: effectiveLorebook,
      position: descObj.position,
      depth: descObj.depth,
      role: descObj.role,
      title: String(descObj.title ?? ''),
      connections,
      lukerDedicatedChars: [],
      isLukerCharacterOnly: false,
      avatarUrl: resolvePersonaAvatarUrl(avatarId),
      isActive: isCurrent,
    });
  }

  // 扫描 Luker 的 character.data.extensions.luker.dedicated_personas
  // 在 Luker 中选择 "Character Only" 绑定后，人设会从 power_user.personas 移除并仅存于角色卡内
  for (const rawChar of rawChars) {
    const charName = String(rawChar?.name || '').trim();
    const charAvatar = String(rawChar?.avatar || '').trim();
    if (!charName) continue;
    const dedicatedList = extractLukerDedicatedPersonas(rawChar);
    for (const entry of dedicatedList) {
      const avatarId = String(entry?.avatar || '').trim();
      if (!avatarId) continue;
      const isCurrent = avatarId === activeAvatarId;
      if (!resultMap.has(avatarId)) {
        resultMap.set(avatarId, {
          avatarId,
          name: String(entry.name || avatarId),
          description: String(entry.description ?? (isCurrent ? pu.persona_description ?? '' : '')),
          lorebook: String(entry.lorebook || (isCurrent ? pu.persona_description_lorebook || '' : '')),
          position: entry.position,
          depth: entry.depth,
          role: entry.role,
          title: String(entry.title ?? ''),
          connections: [],
          lukerDedicatedChars: [charName],
          lukerCharacterAvatars: charAvatar ? [charAvatar] : [],
          isLukerCharacterOnly: true,
          avatarUrl: resolvePersonaAvatarUrl(avatarId),
          isActive: isCurrent,
        });
      } else {
        const existing = resultMap.get(avatarId);
        if (!existing.lukerDedicatedChars.includes(charName)) {
          existing.lukerDedicatedChars.push(charName);
        }
        if (!existing.description && entry.description) {
          existing.description = String(entry.description);
        }
        if (!existing.lorebook && entry.lorebook) {
          existing.lorebook = String(entry.lorebook);
        }
      }
    }
  }

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
    const imgSrc = node.querySelector('img')?.getAttribute('src') || resolvePersonaAvatarUrl(avatarId);
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
        avatarUrl: imgSrc,
        isActive: isSelected,
      });
    } else {
      const existing = resultMap.get(avatarId);
      if (isSelected) existing.isActive = true;
      if (imgSrc) existing.avatarUrl = imgSrc;
    }
  });

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
async function bindPersonaToCharacter(avatarId, characterName) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  if (!meta.boundCharacters.some((c) => c.toLowerCase() === cleanName.toLowerCase())) {
    meta.boundCharacters.push(cleanName);
  }

  try {
    const context = getContext();
    const rawChars = Array.isArray(context.characters) ? context.characters : [];
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

    state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
    state.hostPersonasModule?.updatePersonaUIStates?.();
  } catch (_e) {}

  saveSettings();
  refreshAllViews();
}

async function unbindPersonaFromCharacter(avatarId, characterName) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  meta.boundCharacters = meta.boundCharacters.filter(
    (c) => c.toLowerCase() !== cleanName.toLowerCase()
  );

  try {
    const context = getContext();
    const rawChars = Array.isArray(context.characters) ? context.characters : [];
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
    state.hostPersonasModule?.updatePersonaConnectionsAvatarList?.();
    state.hostPersonasModule?.updatePersonaUIStates?.();
  } catch (_e) {}

  saveSettings();
  refreshAllViews();
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

async function jumpToWorldbookInHost(worldbookName, { fromWardrobeModal = false } = {}) {
  const targetName = String(worldbookName || '').trim();
  if (!targetName) {
    globalThis.toastr?.warning?.('当前未绑定世界书');
    return false;
  }

  await probeHostModules();

  let jumped = false;

  if (typeof state.hostWorldInfoModule?.openWorldInfoEditor === 'function') {
    try {
      state.hostWorldInfoModule.openWorldInfoEditor(targetName);
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

  if (fromWardrobeModal) {
    const modal = document.querySelector('#st_pw_wardrobe_modal');
    if (modal) {
      modal.classList.add('st-pw-hidden');
      showReturnToWardrobePill(targetName);
    }
  }

  return true;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
}

function showReturnToWardrobePill(bookName) {
  removeReturnToWardrobePill();
  const pill = document.createElement('button');
  pill.id = 'st_pw_return_pill';
  pill.type = 'button';
  pill.className = 'menu_button st-pw-return-pill';
  pill.innerHTML = `<i class="fa-solid fa-arrow-left"></i> <span>返回人设管理 (${sanitizeHtml(bookName)})</span>`;
  pill.addEventListener('click', () => {
    removeReturnToWardrobePill();
    openWardrobeModal();
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

  modal.classList.remove('st-pw-hidden');
  modal.innerHTML = `
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true">
      <div class="st-pw-modal-header">
        <div class="st-pw-header-left">
          <span class="st-pw-modal-title">${sanitizeHtml(name)}</span>
          <span class="st-pw-header-meta">读取中…</span>
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-close-wb-modal">关闭</button>
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
            <button type="button" class="menu_button st-pw-wb-jump-host-btn" title="在酒馆原生世界书面板中打开">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> 原生编辑器
            </button>
            <button type="button" class="menu_button st-pw-wb-add-entry-btn">
              <i class="fa-solid fa-plus"></i> 新建条目
            </button>
            <button type="button" class="menu_button st-pw-close-wb-modal" title="关闭">
              <i class="fa-solid fa-xmark"></i>
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
        if (!window.confirm(`确定删除条目「${title}」吗？`)) return;
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

  modal.classList.remove('st-pw-hidden');
  renderWardrobeModalContent();
}

function renderPersonaRowHtml(p, selectedAvatarId) {
  const isSelected = selectedAvatarId === p.avatarId;
  const extraCount = p.meta.extraWorldbooks.filter((b) => b.enabled).length;
  const traitCount = p.meta.traits.filter((t) => t.enabled).length;
  return `
    <div class="st-pw-persona-item ${isSelected ? 'is-selected' : ''} ${p.isActive ? 'is-active-user' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}">
      <img class="st-pw-item-avatar" src="${escapeAttr(p.avatarUrl)}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="st-pw-item-main">
        <div class="st-pw-item-title-line">
          <span class="st-pw-item-name">${sanitizeHtml(p.name)}</span>
          ${p.meta.group ? `<span class="st-pw-tiny-tag">${sanitizeHtml(p.meta.group)}</span>` : ''}
        </div>
        <div class="st-pw-item-sub-line">
          ${
            p.lorebook
              ? `<span class="st-pw-item-book">${sanitizeHtml(p.lorebook)}</span>`
              : `<span class="st-pw-muted">未绑书</span>`
          }
          ${extraCount ? `<span>+${extraCount}书</span>` : ''}
          ${traitCount ? `<span>· ${traitCount}设定</span>` : ''}
        </div>
      </div>
      <div class="st-pw-item-actions">
        <button type="button" class="st-pw-fav-btn ${p.meta.favorite ? 'is-fav' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}" title="收藏">
          <i class="fa-${p.meta.favorite ? 'solid' : 'regular'} fa-star"></i>
        </button>
        ${
          p.isActive
            ? `<span class="st-pw-active-label">当前</span>`
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

function renderWardrobeModalContent() {
  const modal = document.querySelector('#st_pw_wardrobe_modal');
  if (!modal || modal.classList.contains('st-pw-hidden')) return;

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

  // 构建左侧折叠分组树 HTML
  const renderGroupedTreeHtml = () => {
    const sections = [];

    // 1) 自动角色分组（一个角色下绑了多个 User 的自动归为一组）
    for (const cg of characterGroups) {
      if (state.activeFilter !== 'all' && state.activeFilter !== cg.id) continue;
      const visibleMembers = cg.members.filter((p) => matchesSearch(p, q));
      if (q && visibleMembers.length === 0) continue;
      const isCollapsed = state.collapsedSections.has(cg.id);
      const isBatchOpen =
        state.batchAssignTarget?.type === 'character' &&
        state.batchAssignTarget?.name.toLowerCase() === cg.name.toLowerCase();

      sections.push(`
        <div class="st-pw-folder-section" data-section-id="${escapeAttr(cg.id)}">
          <div class="st-pw-folder-header">
            <div class="st-pw-folder-title-wrap st-pw-folder-toggle" data-section-id="${escapeAttr(cg.id)}">
              <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'} st-pw-folder-arrow"></i>
              ${
                cg.avatarUrl
                  ? `<img class="st-pw-folder-char-avatar" src="${escapeAttr(cg.avatarUrl)}" alt="" onerror="this.style.display='none'" />`
                  : `<i class="fa-solid fa-user-tag st-pw-folder-icon"></i>`
              }
              <span class="st-pw-folder-name">${sanitizeHtml(cg.name)}</span>
              <span class="st-pw-folder-count">${cg.members.length}</span>
              ${cg.isCurrentChar ? `<span class="st-pw-tiny-tag">当前角色</span>` : ''}
            </div>
            <div class="st-pw-folder-actions">
              <button type="button" class="st-pw-icon-btn st-pw-open-batch-char" data-char-name="${escapeAttr(cg.name)}" title="勾选/管理绑定到此角色下的多个 User">
                <i class="fa-solid fa-user-plus"></i>
              </button>
            </div>
          </div>
          ${
            isBatchOpen
              ? renderBatchChecklistHtml('character', cg.name, personas)
              : ''
          }
          ${
            !isCollapsed
              ? `<div class="st-pw-folder-body">${
                  visibleMembers.length
                    ? visibleMembers.map((p) => renderPersonaRowHtml(p, selectedPersona?.avatarId)).join('')
                    : `<div class="st-pw-muted-hint">无匹配项</div>`
                }</div>`
              : ''
          }
        </div>
      `);
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
          ${
            isBatchOpen
              ? renderBatchChecklistHtml('group', grp.name, personas)
              : ''
          }
          ${
            !isCollapsed
              ? `<div class="st-pw-folder-body">${
                  visibleMembers.length
                    ? visibleMembers.map((p) => renderPersonaRowHtml(p, selectedPersona?.avatarId)).join('')
                    : `<div class="st-pw-muted-hint">组内暂无 User，点右上角小人图标可批量勾选加入</div>`
                }</div>`
              : ''
          }
        </div>
      `);
    }

    // 3) 仅查看收藏
    if (state.activeFilter === 'fav') {
      const favList = personas.filter((p) => p.meta.favorite && matchesSearch(p, q));
      return favList.length
        ? favList.map((p) => renderPersonaRowHtml(p, selectedPersona?.avatarId)).join('')
        : `<div class="st-pw-empty-state">暂无收藏的 User</div>`;
    }

    // 4) 未分组 User（如果还没有任何角色分组或自定义分组，直接平铺显示，不套多余文件夹壳子）
    if (state.activeFilter === 'all' || state.activeFilter === 'ungrouped') {
      const visibleUngrouped = ungroupedMembers.filter((p) => matchesSearch(p, q));
      if (characterGroups.length === 0 && customGroups.length === 0) {
        return visibleUngrouped.length
          ? visibleUngrouped.map((p) => renderPersonaRowHtml(p, selectedPersona?.avatarId)).join('')
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
            </div>
            ${
              !isCollapsed
                ? `<div class="st-pw-folder-body">${visibleUngrouped
                    .map((p) => renderPersonaRowHtml(p, selectedPersona?.avatarId))
                    .join('')}</div>`
                : ''
            }
          </div>
        `);
      }
    }

    return sections.length ? sections.join('') : `<div class="st-pw-empty-state">无匹配人设</div>`;
  };

  const activeMeta = activePersona ? activePersona.meta : null;
  const activeExtraBooks = activeMeta
    ? activeMeta.extraWorldbooks.filter((b) => b.enabled && b.name)
    : [];
  const activeTraits = activeMeta
    ? activeMeta.traits.filter((t) => t.enabled && String(t.content || '').trim())
    : [];

  modal.innerHTML = `
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
          <button type="button" class="menu_button st-pw-mini-btn st-pw-preview-active-prompt-btn">生效预览</button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-refresh-host-btn" title="同步列表"><i class="fa-solid fa-rotate"></i></button>
          <button type="button" class="menu_button st-pw-mini-btn st-pw-close-wardrobe-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>

      <div class="st-pw-workbench">
        <aside class="st-pw-sidebar">
          <input type="search" id="st_pw_search_input" class="text_pole st-pw-sidebar-search" placeholder="搜索 User、角色组、自定义组、世界书…" value="${escapeAttr(state.searchQuery)}" />

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

          <!-- 顶部快速筛选标签（只展示实际有内容的自动角色组与用户自建组，绝不显示无用的空预设） -->
          <div class="st-pw-group-tabs">
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'all' ? 'active' : ''}" data-filter="all">
              全部 (${personas.length})
            </button>
            <button type="button" class="st-pw-filter-pill ${state.activeFilter === 'fav' ? 'active' : ''}" data-filter="fav">
              收藏 (${personas.filter((p) => p.meta.favorite).length})
            </button>
            ${characterGroups
              .map(
                (cg) => `
                  <button type="button" class="st-pw-filter-pill ${state.activeFilter === cg.id ? 'active' : ''}" data-filter="${escapeAttr(cg.id)}" title="角色绑定的 User 自动分组">
                    <i class="fa-solid fa-user-tag"></i> ${sanitizeHtml(cg.name)} (${cg.members.length})
                  </button>
                `
              )
              .join('')}
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

          <!-- 分组树列表：同一角色下绑的多个 User 自动归在一组，自定义组也自动归在一组 -->
          <div class="st-pw-persona-list">
            ${renderGroupedTreeHtml()}
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

  bindWardrobeModalEvents(modal, selectedPersona, personas);
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
        <img class="st-pw-detail-avatar" src="${escapeAttr(persona.avatarUrl)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="st-pw-detail-user-info">
          <div class="st-pw-detail-name-line">
            <strong>${sanitizeHtml(persona.name)}</strong>
            <span class="st-pw-mono-id">${sanitizeHtml(persona.avatarId)}</span>
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

  modal.querySelector('.st-pw-close-wardrobe-btn')?.addEventListener('click', () => {
    modal.classList.add('st-pw-hidden');
  });

  modal.querySelector('.st-pw-refresh-host-btn')?.addEventListener('click', () => {
    refreshAllViews();
    globalThis.toastr?.info?.('已刷新');
  });

  modal.querySelector('.st-pw-preview-active-prompt-btn')?.addEventListener('click', async () => {
    await openActivePromptPreviewModal();
  });

  const searchInput = modal.querySelector('#st_pw_search_input');
  searchInput?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderWardrobeModalContent();
    const nextInput = modal.querySelector('#st_pw_search_input');
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(pos, pos);
    }
  });

  // 顶部筛选胶囊
  modal.querySelectorAll('.st-pw-filter-pill[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeFilter = btn.getAttribute('data-filter') || 'all';
      renderWardrobeModalContent();
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
      renderWardrobeModalContent();
    });
  });

  // 从左上角下拉框选一个角色卡，开启批量勾选多个 User 绑到该角色下自动成组
  modal.querySelector('#st_pw_create_char_group_select')?.addEventListener('change', (e) => {
    const charName = e.target.value;
    if (!charName) return;
    // 默认把当前选中的 User 先绑进去，并展开批量勾选框方便继续勾其他 User
    if (selectedPersona) {
      bindPersonaToCharacter(selectedPersona.avatarId, charName);
    }
    state.batchAssignTarget = { type: 'character', name: charName };
    state.collapsedSections.delete(`char:${charName}`);
    renderWardrobeModalContent();
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
      renderWardrobeModalContent();
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
      renderWardrobeModalContent();
    });
  });

  modal.querySelectorAll('.st-pw-close-batch').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.batchAssignTarget = null;
      renderWardrobeModalContent();
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
        renderWardrobeModalContent();
      }
    });
  });

  // 新建自定义分组
  modal.querySelector('.st-pw-add-group-btn')?.addEventListener('click', () => {
    const newGroup = window.prompt('输入新分组名称：');
    if (newGroup && newGroup.trim()) {
      const clean = newGroup.trim();
      if (!settings.groups.includes(clean)) {
        settings.groups.push(clean);
        saveSettings();
      }
      state.batchAssignTarget = { type: 'group', name: clean };
      state.collapsedSections.delete(`group:${clean}`);
      renderWardrobeModalContent();
    }
  });

  // 重命名自定义分组
  modal.querySelectorAll('.st-pw-rename-group-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const oldName = btn.getAttribute('data-group-name');
      if (!oldName) return;
      const nextName = window.prompt(`重命名分组「${oldName}」：`, oldName);
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
      renderWardrobeModalContent();
    });
  });

  // 删除自定义分组
  modal.querySelectorAll('.st-pw-delete-group-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const oldName = btn.getAttribute('data-group-name');
      if (!oldName) return;
      if (!window.confirm(`确定删除自定义分组「${oldName}」吗？（组内 User 不会被删除）`)) {
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
      renderWardrobeModalContent();
    });
  });

  modal.querySelectorAll('.st-pw-persona-item').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.st-pw-fav-btn') || e.target.closest('.st-pw-use-persona-btn')) {
        return;
      }
      state.selectedAvatarId = card.getAttribute('data-avatar-id');
      state.expandedTraitIdx = null;
      renderWardrobeModalContent();
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
      renderWardrobeModalContent();
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

  modal.querySelector('#st_pw_detail_group')?.addEventListener('change', (e) => {
    if (e.target.value === '__new__') {
      const newGroup = window.prompt('输入新分组名称：');
      if (newGroup && newGroup.trim()) {
        const clean = newGroup.trim();
        if (!settings.groups.includes(clean)) settings.groups.push(clean);
        meta.group = clean;
      }
    } else {
      meta.group = e.target.value;
    }
    saveSettings();
    renderWardrobeModalContent();
  });

  modal.querySelector('#st_pw_detail_tags')?.addEventListener('change', (e) => {
    meta.tags = e.target.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    saveSettings();
    renderWardrobeModalContent();
  });

  modal.querySelector('#st_pw_bind_current_char_btn')?.addEventListener('click', (e) => {
    const cName = e.currentTarget.getAttribute('data-char');
    if (cName) {
      bindPersonaToCharacter(selectedPersona.avatarId, cName);
    }
  });

  modal.querySelector('#st_pw_bind_char_select')?.addEventListener('change', (e) => {
    let val = e.target.value;
    if (!val) return;
    if (val === '__custom__') {
      val = window.prompt('输入要绑定的角色卡名称：') || '';
    }
    if (val.trim()) {
      bindPersonaToCharacter(selectedPersona.avatarId, val.trim());
    } else {
      e.target.value = '';
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
        renderWardrobeModalContent();
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
      renderWardrobeModalContent();
    }
  });

  modal.querySelectorAll('.st-pw-toggle-extra-book').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.extraWorldbooks[idx]) {
        meta.extraWorldbooks[idx].enabled = e.target.checked;
        saveSettings();
        renderWardrobeModalContent();
      }
    });
  });

  modal.querySelectorAll('.st-pw-remove-extra-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      meta.extraWorldbooks.splice(idx, 1);
      saveSettings();
      renderWardrobeModalContent();
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
    renderWardrobeModalContent();
  });

  modal.querySelectorAll('.st-pw-trait-enable').forEach((chk) => {
    chk.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].enabled = e.target.checked;
        saveSettings();
        renderWardrobeModalContent();
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
        renderWardrobeModalContent();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-expand').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.getAttribute('data-idx'));
      state.expandedTraitIdx = state.expandedTraitIdx === idx ? null : idx;
      renderWardrobeModalContent();
    });
  });

  modal.querySelectorAll('.st-pw-trait-title').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].title = e.target.value.trim();
        saveSettings();
        renderWardrobeModalContent();
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
      renderWardrobeModalContent();
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
  modal.classList.remove('st-pw-hidden');

  modal.innerHTML = `
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true">
      <div class="st-pw-modal-header">
        <div class="st-pw-header-left">
          <span class="st-pw-modal-title">当前生效预览：${sanitizeHtml(active?.name || '无')}</span>
        </div>
        <button type="button" class="menu_button st-pw-close-preview-btn">关闭</button>
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
 * 原生 Persona 面板内嵌控制条
 */
function syncNativePersonaPanelEnhancement() {
  const settings = getSettings();
  const existingBar = document.querySelector('#st_pw_native_persona_helper');

  if (!settings.enhanceNativePersonaPanel) {
    existingBar?.remove();
    return;
  }

  const personaControlsRow = document.querySelector('#persona_controls');
  const anchorEl =
    personaControlsRow ||
    document.querySelector('#persona_description_lorebook') ||
    document.querySelector('#persona_description');

  if (!anchorEl) return;

  let helperBar = existingBar;
  if (!helperBar) {
    helperBar = document.createElement('div');
    helperBar.id = 'st_pw_native_persona_helper';
    helperBar.className = 'st-pw-native-helper-bar';
  }
  if (anchorEl.id === 'persona_description') {
    if (helperBar.nextElementSibling !== anchorEl) {
      anchorEl.insertAdjacentElement('beforebegin', helperBar);
    }
  } else if (helperBar.previousElementSibling !== anchorEl) {
    anchorEl.insertAdjacentElement('afterend', helperBar);
  }

  const personas = getHostPersonas();
  const active = personas.find((p) => p.isActive);
  const currentBook = active?.lorebook || '';
  const availableBooks = getAvailableWorldbooks();
  const currentChar = getCurrentCharacter();
  const charBoundPersonas = currentChar
    ? personas.filter((p) =>
        p.meta.boundCharacters.some((c) => c.toLowerCase() === currentChar.name.toLowerCase())
      )
    : [];

  helperBar.innerHTML = `
    ${
      currentChar && charBoundPersonas.length > 0
        ? `
          <span class="st-pw-native-bar-label">${sanitizeHtml(currentChar.name)}组 (${charBoundPersonas.length})</span>
          <select id="st_pw_native_char_personas_select" class="text_pole st-pw-native-quick-select">
            ${charBoundPersonas
              .map(
                (p) =>
                  `<option value="${escapeAttr(p.avatarId)}" ${p.isActive ? 'selected' : ''}>${sanitizeHtml(p.name)}</option>`
              )
              .join('')}
          </select>
        `
        : ''
    }
    <span class="st-pw-native-bar-label">世界书</span>
    <select id="st_pw_native_quick_book_select" class="text_pole st-pw-native-quick-select">
      <option value="">— 未绑定 —</option>
      ${availableBooks
        .map(
          (b) =>
            `<option value="${escapeAttr(b)}" ${currentBook === b ? 'selected' : ''}>${sanitizeHtml(b)}</option>`
        )
        .join('')}
    </select>
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-popup-btn" ${!currentBook ? 'disabled' : ''}>
      条目
    </button>
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-jump-btn" ${!currentBook ? 'disabled' : ''}>
      跳转
    </button>
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-wardrobe-btn">
      人设管理
    </button>
  `;

  helperBar.querySelector('#st_pw_native_char_personas_select')?.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (id) await switchActivePersona(id);
  });

  helperBar.querySelector('#st_pw_native_quick_book_select')?.addEventListener('change', (e) => {
    const newBook = e.target.value;
    const activeId = getActiveAvatarId();
    if (activeId) {
      updateHostPersonaData(activeId, { lorebook: newBook });
    }
  });

  helperBar.querySelector('.st-pw-native-jump-btn')?.addEventListener('click', () => {
    jumpToWorldbookInHost(currentBook, { fromWardrobeModal: false });
  });

  helperBar.querySelector('.st-pw-native-popup-btn')?.addEventListener('click', () => {
    openWorldbookInspectorModal(currentBook);
  });

  helperBar.querySelector('.st-pw-native-wardrobe-btn')?.addEventListener('click', () => {
    openWardrobeModal();
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
        openWardrobeModal();
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
      item.addEventListener('click', () => {
        openWardrobeModal();
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
            openWardrobeModal();
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
          openWardrobeModal();
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
    openWardrobeModal();
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
    a.click();
    URL.revokeObjectURL(url);
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

async function initExtension() {
  if (state.initialized) return;
  state.initialized = true;

  await probeHostModules();
  getSettings();
  await mountSettingsPanel();
  registerSlashCommands();
  refreshAllViews();

  try {
    const context = getContext();
    const { eventSource, event_types } = context;
    if (eventSource && event_types) {
      const subscribe = (evtName, handler) => {
        if (!evtName) return;
        eventSource.on(evtName, handler);
        state.disposers.push(() => eventSource.removeListener?.(evtName, handler));
      };

      subscribe(event_types.CHAT_CHANGED, onChatChanged);
      subscribe(event_types.SETTINGS_UPDATED, refreshAllViews);
      subscribe(event_types.WORLDINFO_UPDATED, () => {
        state.worldbookCache.clear();
        refreshAllViews();
      });
      subscribe(event_types.PERSONA_CHANGED, refreshAllViews);
      subscribe(event_types.PERSONA_CREATED, refreshAllViews);
      subscribe(event_types.PERSONA_UPDATED, refreshAllViews);
      subscribe(event_types.PERSONA_RENAMED, refreshAllViews);
      subscribe(event_types.PERSONA_DELETED, refreshAllViews);
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] 事件订阅警告:`, err);
  }
}

export async function onActivate() {
  await initExtension();
}

export async function onDisable() {
  while (state.disposers.length) {
    const dispose = state.disposers.pop();
    try {
      dispose?.();
    } catch (_e) {}
  }
  removeReturnToWardrobePill();
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
