const MODULE_ID = 'st-persona-wardrobe';
const EXTENSION_FOLDER = 'third-party/st-persona-wardrobe';

const DEFAULT_GROUPS = Object.freeze([
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
  groups: [...DEFAULT_GROUPS],
  profiles: {},
});

const state = {
  initialized: false,
  disposers: [],
  sidebarMode: 'group', // 'group' (按自定义分组) | 'character' (按绑定角色)
  activeModalTab: 'all',
  activeCharFilter: '__current__',
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
    store.groups = [...DEFAULT_GROUPS];
  }
  if (!store.profiles || typeof store.profiles !== 'object') {
    store.profiles = {};
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
 * 读取酒馆当前所有角色卡与当前正在聊天的角色
 */
function getHostCharacters() {
  try {
    const context = getContext();
    const chars = Array.isArray(context.characters) ? context.characters : [];
    const currentChid =
      context.characterId !== undefined && context.characterId !== null
        ? Number(context.characterId)
        : -1;
    return chars
      .map((c, idx) => ({
        index: idx,
        name: String(c?.name || '').trim(),
        avatar: String(c?.avatar || '').trim(),
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
 * 读取所有 User Personas，并把酒馆原生 connections（绑定到角色的锁定关系）与插件 boundCharacters 自动合并
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

  const hostChars = getHostCharacters();
  const charByAvatar = new Map(hostChars.map((c) => [c.avatar, c.name]));

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
      avatarUrl: resolvePersonaAvatarUrl(avatarId),
      isActive: isCurrent,
    });
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
    // 将酒馆原生 connections 中的角色自动合并进 meta.boundCharacters（保持双向一致）
    const mergedChars = new Set(meta.boundCharacters.filter(Boolean));
    for (const conn of item.connections) {
      if (conn?.type === 'character' && conn.id) {
        const resolvedName = charByAvatar.get(conn.id);
        if (resolvedName) mergedChars.add(resolvedName);
      }
    }
    meta.boundCharacters = [...mergedChars];
    item.meta = meta;
  }
  return list;
}

/**
 * 将某个 User 绑定到指定角色名（同时写入插件 boundCharacters 与酒馆原生 connections）
 */
function bindPersonaToCharacter(avatarId, characterName) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  if (!meta.boundCharacters.includes(cleanName)) {
    meta.boundCharacters.push(cleanName);
  }

  // 如果该角色存在于酒馆角色列表，同步写入酒馆原生 persona_descriptions[avatarId].connections
  try {
    const hostChar = getHostCharacters().find(
      (c) => c.name.toLowerCase() === cleanName.toLowerCase()
    );
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
    if (hostChar?.avatar && pu?.persona_descriptions?.[avatarId]) {
      if (!Array.isArray(pu.persona_descriptions[avatarId].connections)) {
        pu.persona_descriptions[avatarId].connections = [];
      }
      const conns = pu.persona_descriptions[avatarId].connections;
      if (!conns.some((c) => c.type === 'character' && c.id === hostChar.avatar)) {
        conns.push({ type: 'character', id: hostChar.avatar });
      }
    }
  } catch (_e) {}

  saveSettings();
  refreshAllViews();
}

/**
 * 解除某个 User 与指定角色的绑定（同时从插件与酒馆原生 connections 移除）
 */
function unbindPersonaFromCharacter(avatarId, characterName) {
  const cleanName = String(characterName || '').trim();
  if (!avatarId || !cleanName) return;

  const meta = ensureProfileMeta(avatarId);
  meta.boundCharacters = meta.boundCharacters.filter(
    (c) => c.toLowerCase() !== cleanName.toLowerCase()
  );

  try {
    const hostChar = getHostCharacters().find(
      (c) => c.name.toLowerCase() === cleanName.toLowerCase()
    );
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
    if (hostChar?.avatar && Array.isArray(pu?.persona_descriptions?.[avatarId]?.connections)) {
      pu.persona_descriptions[avatarId].connections =
        pu.persona_descriptions[avatarId].connections.filter(
          (c) => !(c.type === 'character' && c.id === hostChar.avatar)
        );
    }
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

function updateHostPersonaData(avatarId, { description, lorebook }) {
  try {
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
    const isCurrent = avatarId === getActiveAvatarId();

    if (pu) {
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
      if (description !== undefined) {
        pu.persona_descriptions[avatarId].description = description;
        if (isCurrent) {
          pu.persona_description = description;
        }
      }
      if (lorebook !== undefined) {
        pu.persona_descriptions[avatarId].lorebook = lorebook;
        if (isCurrent) {
          pu.persona_description_lorebook = lorebook;
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
 * 世界书条目管理弹窗（高密度紧凑列表，点击才展开编辑）
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

/**
 * 统计每个角色卡下面绑定了哪些 User 人设（支持一个角色绑多个 User 人设）
 */
function buildCharacterGroupMap(personas) {
  const currentChar = getCurrentCharacter();
  const map = new Map();

  if (currentChar?.name) {
    map.set(currentChar.name, []);
  }

  for (const p of personas) {
    for (const cName of p.meta.boundCharacters) {
      const clean = String(cName || '').trim();
      if (!clean) continue;
      if (!map.has(clean)) map.set(clean, []);
      map.get(clean).push(p);
    }
  }

  return { currentCharName: currentChar?.name || '', map };
}

function renderWardrobeModalContent() {
  const modal = document.querySelector('#st_pw_wardrobe_modal');
  if (!modal || modal.classList.contains('st-pw-hidden')) return;

  const settings = getSettings();
  const personas = getHostPersonas();
  const availableBooks = getAvailableWorldbooks();
  const hostChars = getHostCharacters();
  const { currentCharName, map: charGroupMap } = buildCharacterGroupMap(personas);

  const activePersona = personas.find((p) => p.isActive) || null;
  const selectedPersona =
    personas.find((p) => p.avatarId === state.selectedAvatarId) ||
    activePersona ||
    personas[0] ||
    null;

  if (selectedPersona && state.selectedAvatarId !== selectedPersona.avatarId) {
    state.selectedAvatarId = selectedPersona.avatarId;
  }

  // 如果在「按绑定角色」模式下，确定当前选中的角色分组
  const charGroupNames = [...charGroupMap.keys()];
  let effectiveCharFilter = state.activeCharFilter;
  if (effectiveCharFilter === '__current__') {
    effectiveCharFilter = currentCharName || charGroupNames[0] || '__unbound__';
  }
  if (
    effectiveCharFilter !== '__unbound__' &&
    effectiveCharFilter !== '__all_chars__' &&
    !charGroupMap.has(effectiveCharFilter)
  ) {
    effectiveCharFilter = currentCharName || charGroupNames[0] || '__unbound__';
  }

  const q = state.searchQuery.trim().toLowerCase();
  const filteredPersonas = personas
    .filter((p) => {
      if (state.sidebarMode === 'character') {
        if (effectiveCharFilter === '__unbound__') {
          if (p.meta.boundCharacters.length > 0) return false;
        } else if (effectiveCharFilter !== '__all_chars__') {
          const hitChar = p.meta.boundCharacters.some(
            (c) => c.toLowerCase() === effectiveCharFilter.toLowerCase()
          );
          if (!hitChar) return false;
        }
      } else {
        if (state.activeModalTab === 'fav' && !p.meta.favorite) return false;
        if (
          state.activeModalTab === 'linked' &&
          !p.lorebook &&
          p.meta.extraWorldbooks.length === 0 &&
          p.meta.traits.length === 0
        ) {
          return false;
        }
        if (state.activeModalTab === '__ungrouped__' && p.meta.group) return false;
        if (
          state.activeModalTab !== 'all' &&
          state.activeModalTab !== 'fav' &&
          state.activeModalTab !== 'linked' &&
          state.activeModalTab !== '__ungrouped__'
        ) {
          if (p.meta.group !== state.activeModalTab) return false;
        }
      }

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
    })
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.meta.favorite !== b.meta.favorite) return a.meta.favorite ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

  const activeMeta = activePersona ? activePersona.meta : null;
  const activeExtraBooks = activeMeta
    ? activeMeta.extraWorldbooks.filter((b) => b.enabled && b.name)
    : [];
  const activeTraits = activeMeta
    ? activeMeta.traits.filter((t) => t.enabled && String(t.content || '').trim())
    : [];

  // 自定义分组模式下，若当前选中的是某个自定义分组，显示分组重命名/删除与批量移入条
  const isCustomGroupSelected =
    state.sidebarMode === 'group' &&
    settings.groups.includes(state.activeModalTab);

  // 角色分组模式下，若当前选中的是某个具体角色，可一键把其他现有 User 绑定到该角色下
  const isSpecificCharSelected =
    state.sidebarMode === 'character' &&
    effectiveCharFilter &&
    effectiveCharFilter !== '__unbound__' &&
    effectiveCharFilter !== '__all_chars__';

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
          <!-- 分组维度切换：自定义分组 vs 按角色分组（一个角色下绑多个人设） -->
          <div class="st-pw-mode-switch">
            <button type="button" class="st-pw-mode-btn ${state.sidebarMode === 'group' ? 'active' : ''}" data-mode="group">
              自定义分组
            </button>
            <button type="button" class="st-pw-mode-btn ${state.sidebarMode === 'character' ? 'active' : ''}" data-mode="character">
              按绑定角色 (${charGroupNames.length})
            </button>
          </div>

          <input type="search" id="st_pw_search_input" class="text_pole st-pw-sidebar-search" placeholder="搜索人设、标签、世界书、角色…" value="${escapeAttr(state.searchQuery)}" />

          ${
            state.sidebarMode === 'group'
              ? `
                <div class="st-pw-group-tabs">
                  <button type="button" class="st-pw-filter-pill ${state.activeModalTab === 'all' ? 'active' : ''}" data-tab="all">全部 (${personas.length})</button>
                  <button type="button" class="st-pw-filter-pill ${state.activeModalTab === 'fav' ? 'active' : ''}" data-tab="fav">收藏 (${personas.filter((p) => p.meta.favorite).length})</button>
                  <button type="button" class="st-pw-filter-pill ${state.activeModalTab === 'linked' ? 'active' : ''}" data-tab="linked">已绑书 (${personas.filter((p) => p.lorebook || p.meta.extraWorldbooks.length || p.meta.traits.length).length})</button>
                  ${settings.groups
                    .map((g) => {
                      const count = personas.filter((p) => p.meta.group === g).length;
                      return `<button type="button" class="st-pw-filter-pill ${state.activeModalTab === g ? 'active' : ''}" data-tab="${escapeAttr(g)}">${sanitizeHtml(g)} (${count})</button>`;
                    })
                    .join('')}
                  <button type="button" class="st-pw-filter-pill ${state.activeModalTab === '__ungrouped__' ? 'active' : ''}" data-tab="__ungrouped__">未分类 (${personas.filter((p) => !p.meta.group).length})</button>
                  <button type="button" class="st-pw-filter-pill st-pw-add-group-btn" title="新建自定义分组">+ 新建</button>
                </div>
                ${
                  isCustomGroupSelected
                    ? `
                      <div class="st-pw-group-ops-bar">
                        <span class="st-pw-group-ops-name">${sanitizeHtml(state.activeModalTab)}</span>
                        <div class="st-pw-group-ops-btns">
                          <button type="button" class="st-pw-link-btn st-pw-rename-group-btn">重命名</button>
                          <button type="button" class="st-pw-link-btn st-pw-delete-group-btn">删除分组</button>
                        </div>
                      </div>
                    `
                    : ''
                }
              `
              : `
                <div class="st-pw-group-tabs">
                  ${
                    currentCharName
                      ? `<button type="button" class="st-pw-filter-pill ${effectiveCharFilter === currentCharName ? 'active' : ''}" data-char="${escapeAttr(currentCharName)}">当前角色: ${sanitizeHtml(currentCharName)} (${(charGroupMap.get(currentCharName) || []).length})</button>`
                      : ''
                  }
                  ${charGroupNames
                    .filter((c) => c !== currentCharName)
                    .map((c) => {
                      const list = charGroupMap.get(c) || [];
                      return `<button type="button" class="st-pw-filter-pill ${effectiveCharFilter === c ? 'active' : ''}" data-char="${escapeAttr(c)}">${sanitizeHtml(c)} (${list.length})</button>`;
                    })
                    .join('')}
                  <button type="button" class="st-pw-filter-pill ${effectiveCharFilter === '__unbound__' ? 'active' : ''}" data-char="__unbound__">未绑角色 (${personas.filter((p) => p.meta.boundCharacters.length === 0).length})</button>
                </div>
                ${
                  isSpecificCharSelected
                    ? `
                      <div class="st-pw-char-assign-bar">
                        <select id="st_pw_quick_assign_persona_to_char" class="text_pole st-pw-flex-select">
                          <option value="">+ 将其他人设绑到「${sanitizeHtml(effectiveCharFilter)}」…</option>
                          ${personas
                            .filter(
                              (p) =>
                                !p.meta.boundCharacters.some(
                                  (c) => c.toLowerCase() === effectiveCharFilter.toLowerCase()
                                )
                            )
                            .map(
                              (p) =>
                                `<option value="${escapeAttr(p.avatarId)}">${sanitizeHtml(p.name)}</option>`
                            )
                            .join('')}
                        </select>
                      </div>
                    `
                    : ''
                }
              `
          }

          <div class="st-pw-persona-list">
            ${
              filteredPersonas.length === 0
                ? `<div class="st-pw-empty-state">${
                    isSpecificCharSelected
                      ? `角色「${sanitizeHtml(effectiveCharFilter)}」下暂未绑定人设，可在上方下拉框直接添加。`
                      : '无匹配人设'
                  }</div>`
                : filteredPersonas
                    .map((p) => {
                      const isSelected = selectedPersona?.avatarId === p.avatarId;
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
                              ${
                                p.meta.boundCharacters.length
                                  ? `<span class="st-pw-muted">· ${p.meta.boundCharacters.length}角色</span>`
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
                                : `<button type="button" class="menu_button st-pw-mini-btn st-pw-use-persona-btn" data-avatar-id="${escapeAttr(p.avatarId)}">使用</button>`
                            }
                          </div>
                        </div>
                      `;
                    })
                    .join('')
            }
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

  bindWardrobeModalEvents(modal, selectedPersona, availableBooks, effectiveCharFilter);
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
            <select id="st_pw_detail_group" class="text_pole" title="自定义分组">
              <option value="">未分类</option>
              ${settings.groups
                .map(
                  (g) =>
                    `<option value="${escapeAttr(g)}" ${meta.group === g ? 'selected' : ''}>${sanitizeHtml(g)}</option>`
                )
                .join('')}
              <option value="__new__">+ 新建分组…</option>
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

    <!-- 角色分组绑定：支持一个角色下绑定多套 User 人设，也支持一个 User 绑多个角色 -->
    <div class="st-pw-block">
      <div class="st-pw-block-header">
        <span class="st-pw-block-title">绑定角色卡（同一角色下可绑定多个人设，与酒馆原生角色锁定互通）</span>
        ${
          currentCharName && !isCurrentCharBound
            ? `<button type="button" id="st_pw_bind_current_char_btn" class="menu_button st-pw-mini-btn" data-char="${escapeAttr(currentCharName)}">+ 绑定当前角色「${sanitizeHtml(currentCharName)}」</button>`
            : ''
        }
      </div>
      <div class="st-pw-char-chips-row">
        ${
          meta.boundCharacters.length === 0
            ? `<span class="st-pw-muted" style="font-size:0.82rem;">暂未绑定角色卡</span>`
            : meta.boundCharacters
                .map(
                  (cName) => `
                    <span class="st-pw-char-chip">
                      <span class="st-pw-char-chip-jump" data-char="${escapeAttr(cName)}" title="点击查看该角色下的所有人设">${sanitizeHtml(cName)}</span>
                      <button type="button" class="st-pw-chip-remove" data-char="${escapeAttr(cName)}" title="解除绑定">×</button>
                    </span>
                  `
                )
                .join('')
        }
        <select id="st_pw_bind_char_select" class="text_pole st-pw-char-add-select">
          <option value="">+ 选择角色卡绑定…</option>
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

function bindWardrobeModalEvents(modal, selectedPersona, _availableBooks, effectiveCharFilter) {
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

  // 切换「自定义分组」与「按绑定角色」两种视图模式
  modal.querySelectorAll('.st-pw-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sidebarMode = btn.getAttribute('data-mode') || 'group';
      renderWardrobeModalContent();
    });
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

  // 自定义分组标签点击
  modal.querySelectorAll('.st-pw-filter-pill[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeModalTab = btn.getAttribute('data-tab') || 'all';
      renderWardrobeModalContent();
    });
  });

  // 角色分组标签点击
  modal.querySelectorAll('.st-pw-filter-pill[data-char]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeCharFilter = btn.getAttribute('data-char') || '__current__';
      renderWardrobeModalContent();
    });
  });

  // 在角色分组视图下，一键将其他 User 人设绑定到当前查看的角色下
  modal.querySelector('#st_pw_quick_assign_persona_to_char')?.addEventListener('change', (e) => {
    const targetAvatarId = e.target.value;
    if (targetAvatarId && effectiveCharFilter) {
      bindPersonaToCharacter(targetAvatarId, effectiveCharFilter);
      state.selectedAvatarId = targetAvatarId;
      globalThis.toastr?.success?.(`已将人设绑定到「${effectiveCharFilter}」`);
    }
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
      state.activeModalTab = clean;
      renderWardrobeModalContent();
    }
  });

  // 重命名当前自定义分组
  modal.querySelector('.st-pw-rename-group-btn')?.addEventListener('click', () => {
    const oldName = state.activeModalTab;
    if (!settings.groups.includes(oldName)) return;
    const nextName = window.prompt(`重命名分组「${oldName}」：`, oldName);
    if (!nextName || !nextName.trim() || nextName.trim() === oldName) return;
    const clean = nextName.trim();
    const idx = settings.groups.indexOf(oldName);
    if (idx !== -1) settings.groups[idx] = clean;
    for (const prof of Object.values(settings.profiles)) {
      if (prof && prof.group === oldName) prof.group = clean;
    }
    state.activeModalTab = clean;
    saveSettings();
    renderWardrobeModalContent();
  });

  // 删除当前自定义分组（不删人设，仅清空所属分组字段）
  modal.querySelector('.st-pw-delete-group-btn')?.addEventListener('click', () => {
    const oldName = state.activeModalTab;
    if (!settings.groups.includes(oldName)) return;
    if (!window.confirm(`确定删除分组「${oldName}」吗？（组内人设不会被删除，只会变为未分类）`)) {
      return;
    }
    settings.groups = settings.groups.filter((g) => g !== oldName);
    for (const prof of Object.values(settings.profiles)) {
      if (prof && prof.group === oldName) prof.group = '';
    }
    state.activeModalTab = 'all';
    saveSettings();
    renderWardrobeModalContent();
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

  // 角色绑定操作
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
        state.sidebarMode = 'character';
        state.activeCharFilter = cName;
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
 * 原生 Persona 面板内嵌控制条（同时支持一键切换当前角色绑定的多套人设 + 切换/弹窗/跳转世界书）
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
  // 确保插入在 #persona_controls 整行外部下方，绝不挤进 #persona_controls 内部 flex 容器导致原按钮变成竖排
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
          <span class="st-pw-native-bar-label">${sanitizeHtml(currentChar.name)}的人设</span>
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
        `角色「${currentChar.name}」绑定了 ${matchedList.length} 套人设：${names}`
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
