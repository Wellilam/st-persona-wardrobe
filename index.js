const MODULE_ID = 'st-persona-wardrobe';
const EXTENSION_FOLDER = 'third-party/st-persona-wardrobe';

const DEFAULT_GROUPS = Object.freeze([
  '现代都市',
  '西幻奇幻',
  '赛博科幻',
  '古风仙侠',
  '无限流/规则',
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
  activeModalTab: 'all',
  searchQuery: '',
  selectedAvatarId: null,
  worldbookCache: new Map(),
  lastPromptInjectedSummary: [],
  minimizedReturnPill: null,
};

function getContext() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) {
    throw new Error(`[${MODULE_ID}] SillyTavern.getContext() 不可用`);
  }
  return context;
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
 * 读取酒馆当前所有可用世界书列表
 */
function getAvailableWorldbooks() {
  const books = new Set();

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

/**
 * 获取酒馆当前激活的 User Avatar ID
 */
function getActiveAvatarId() {
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
    if (pu?.default_persona) return pu.default_persona;
  } catch (_e) {}
  return '';
}

/**
 * 从酒馆 Context 与 DOM 读取所有 User Personas
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

  const activeAvatarId = getActiveAvatarId();
  const resultMap = new Map();

  for (const [avatarId, displayName] of Object.entries(personasMap)) {
    const descObj = descMap[avatarId] || {};
    resultMap.set(avatarId, {
      avatarId,
      name: String(displayName || avatarId),
      description: String(descObj.description ?? ''),
      lorebook: String(descObj.lorebook ?? ''),
      position: descObj.position,
      depth: descObj.depth,
      role: descObj.role,
      title: String(descObj.title ?? ''),
      avatarUrl: `/User Avatars/${encodeURIComponent(avatarId)}`,
      isActive: avatarId === activeAvatarId,
    });
  }

  // DOM 兜底扫描：防止部分版本 powerUserSettings 未及时暴露或包含未同步项
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
    const imgSrc = node.querySelector('img')?.getAttribute('src') || `/User Avatars/${encodeURIComponent(avatarId)}`;
    const isSelected = node.classList.contains('selected') || avatarId === activeAvatarId;
    const descObj = descMap[avatarId] || {};

    if (!resultMap.has(avatarId)) {
      resultMap.set(avatarId, {
        avatarId,
        name: domName,
        description: String(descObj.description ?? domDesc),
        lorebook: String(descObj.lorebook ?? ''),
        title: String(descObj.title ?? ''),
        avatarUrl: imgSrc,
        isActive: isSelected,
      });
    } else {
      const existing = resultMap.get(avatarId);
      if (isSelected) existing.isActive = true;
      if (imgSrc) existing.avatarUrl = imgSrc;
    }
  });

  // 如果当前正在激活的 User 在 DOM 表单里有最新值，补充同步
  const activeDomLorebook = document.querySelector('#persona_description_lorebook');
  if (activeAvatarId && resultMap.has(activeAvatarId) && activeDomLorebook) {
    const selectedOption = activeDomLorebook.options?.[activeDomLorebook.selectedIndex];
    const selectedBookName =
      selectedOption && activeDomLorebook.value
        ? selectedOption.textContent.trim()
        : '';
    const item = resultMap.get(activeAvatarId);
    if (!item.lorebook && selectedBookName && !selectedBookName.includes('None')) {
      item.lorebook = selectedBookName;
    }
  }

  const list = [...resultMap.values()];
  for (const item of list) {
    item.meta = ensureProfileMeta(item.avatarId);
  }
  return list;
}

/**
 * 切换当前激活的 User Persona
 */
async function switchActivePersona(avatarId) {
  if (!avatarId) return false;
  const personas = getHostPersonas();
  const target = personas.find((p) => p.avatarId === avatarId);

  // 优先触发酒馆原生头像容器点击，确保聊天绑定、名称与表单全部走原生逻辑
  const escapedId = CSS.escape ? CSS.escape(avatarId) : avatarId.replaceAll('"', '\\"');
  const domAvatar = document.querySelector(
    `#user_avatar_block .avatar-container[data-avatar-id="${escapedId}"]`
  );
  if (domAvatar) {
    domAvatar.click();
    globalThis.toastr?.success?.(
      `已切换当前 User 为：${target?.name || avatarId}`,
      'User 人设衣柜'
    );
    refreshAllViews();
    return true;
  }

  // 次选：通过 SlashCommand /persona 切换
  try {
    const context = getContext();
    if (typeof context.executeSlashCommandsWithOptions === 'function') {
      await context.executeSlashCommandsWithOptions(`/persona ${target?.name || avatarId}`);
      globalThis.toastr?.success?.(
        `已通过命令切换 User 为：${target?.name || avatarId}`,
        'User 人设衣柜'
      );
      refreshAllViews();
      return true;
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] /persona 切换失败:`, err);
  }

  globalThis.toastr?.warning?.(
    '请先点开一次酒馆顶部「User 人设管理」抽屉让列表加载，再执行一键切换。',
    'User 人设衣柜'
  );
  return false;
}

/**
 * 更新某个 User 的原生人设描述与主绑定世界书
 */
function updateHostPersonaData(avatarId, { description, lorebook }) {
  try {
    const context = getContext();
    const pu = context.powerUserSettings || globalThis.power_user;
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
        };
      }
      if (description !== undefined) {
        pu.persona_descriptions[avatarId].description = description;
      }
      if (lorebook !== undefined) {
        pu.persona_descriptions[avatarId].lorebook = lorebook;
      }
    }

    // 如果修改的就是当前激活的 User，同步更新酒馆原生 DOM 输入框与下拉框
    if (avatarId === getActiveAvatarId()) {
      if (description !== undefined) {
        const descInput = document.querySelector('#persona_description');
        if (descInput && descInput.value !== description) {
          descInput.value = description;
          descInput.dispatchEvent(new Event('input', { bubbles: true }));
          descInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (lorebook !== undefined) {
        const loreSelect = document.querySelector('#persona_description_lorebook');
        if (loreSelect) {
          let matchedValue = '';
          for (const opt of loreSelect.options) {
            if (opt.value === lorebook || opt.textContent.trim() === lorebook) {
              matchedValue = opt.value;
              break;
            }
          }
          loreSelect.value = lorebook ? matchedValue : '';
          globalThis.jQuery?.(loreSelect).trigger('change');
          loreSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    saveSettings();
    refreshAllViews();
    return true;
  } catch (err) {
    console.error(`[${MODULE_ID}] 更新原生 Persona 数据失败:`, err);
    return false;
  }
}

/**
 * 像「角色世界书」一样，一键跳转并打开酒馆原生的世界书编辑器并选中目标世界书
 */
function jumpToWorldbookInHost(worldbookName, { fromWardrobeModal = false } = {}) {
  const targetName = String(worldbookName || '').trim();
  if (!targetName) {
    globalThis.toastr?.warning?.('该 User 当前尚未绑定世界书，请先选择或绑定一本世界书。', '世界书跳转');
    return false;
  }

  // 1. 打开酒馆顶部的 World Info 抽屉
  const wiDrawerContent =
    document.querySelector('#WorldInfo') ||
    document.querySelector('#world_info');
  const wiToggle =
    document.querySelector('#WI_button .drawer-toggle') ||
    document.querySelector('#WI_button') ||
    document.querySelector('[data-i18n="World Info"]')?.closest('.drawer-toggle');

  if (wiDrawerContent && (wiDrawerContent.classList.contains('closedDrawer') || ! isElementVisible(wiDrawerContent))) {
    if (wiToggle) {
      wiToggle.click();
    }
  } else if (!wiDrawerContent && wiToggle) {
    wiToggle.click();
  }

  // 2. 在 #world_editor_select 中定位并选中该世界书（兼容 value 为索引或书名两种实现）
  const editorSelect = document.querySelector('#world_editor_select');
  if (!editorSelect) {
    globalThis.toastr?.error?.('未找到酒馆世界书选择器 (#world_editor_select)。', '世界书跳转');
    return false;
  }

  let matchedValue = null;
  for (const opt of editorSelect.options) {
    const optText = (opt.textContent || '').trim();
    const optVal = (opt.value || '').trim();
    if (optText === targetName || optVal === targetName) {
      matchedValue = opt.value;
      break;
    }
  }

  if (matchedValue === null) {
    globalThis.toastr?.warning?.(
      `在酒馆世界书列表中未找到「${targetName}」，可能已被重命名或删除。`,
      '世界书跳转'
    );
    return false;
  }

  editorSelect.value = matchedValue;
  if (globalThis.jQuery) {
    globalThis.jQuery(editorSelect).trigger('change');
  } else {
    editorSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 3. 如果是从我们的衣柜全屏弹窗点过来的，自动收起弹窗并在右下角放一个「← 返回 User 人设衣柜」胶囊按钮
  if (fromWardrobeModal) {
    const modal = document.querySelector('#st_pw_wardrobe_modal');
    if (modal) {
      modal.classList.add('st-pw-hidden');
      showReturnToWardrobePill(targetName);
    }
  }

  globalThis.toastr?.info?.(`已在世界书编辑器中打开：${targetName}`, '世界书跳转');
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
  pill.className = 'st-pw-return-pill';
  pill.innerHTML = `<i class="fa-solid fa-rotate-left"></i> <span>已打开「${sanitizeHtml(bookName)}」· 点击返回 User 人设衣柜</span>`;
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

/**
 * 调用酒馆原生 /api/worldinfo/get 读取世界书完整数据
 */
async function fetchWorldbookData(worldbookName) {
  const name = String(worldbookName || '').trim();
  if (!name) throw new Error('世界书名称为空');

  const context = getContext();
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
    data: structuredClone(data),
  });
  return data;
}

/**
 * 调用酒馆原生 /api/worldinfo/edit 保存修改后的世界书条目
 */
async function saveWorldbookData(worldbookName, worldData) {
  const name = String(worldbookName || '').trim();
  if (!name || !worldData) throw new Error('世界书名称或数据为空');

  const context = getContext();
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
    data: structuredClone(worldData),
  });

  // 若酒馆当前在世界书面板里正好打开了这本书，触发一次刷新
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
 * 打开「世界书条目弹窗速览与直接开关/编辑」二级弹窗
 */
async function openWorldbookInspectorModal(worldbookName) {
  const name = String(worldbookName || '').trim();
  if (!name) {
    globalThis.toastr?.warning?.('请先为该 User 选择或绑定一本世界书。', '世界书弹窗');
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
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true" aria-label="世界书条目管理">
      <div class="st-pw-modal-header">
        <div class="st-pw-modal-title-wrap">
          <i class="fa-solid fa-book-atlas st-pw-accent-icon"></i>
          <div>
            <h3 class="st-pw-modal-title">世界书弹窗速编：${sanitizeHtml(name)}</h3>
            <p class="st-pw-modal-subtitle">正在读取条目数据…</p>
          </div>
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-close-wb-modal">关闭</button>
        </div>
      </div>
      <div class="st-pw-wb-body st-pw-loading-state">
        <i class="fa-solid fa-spinner fa-spin"></i> 正在从酒馆加载「${sanitizeHtml(name)}」的条目…
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
          <p><strong>无法直接读取世界书接口：</strong>${sanitizeHtml(err.message)}</p>
          <p>你仍然可以点击下方按钮，直接跳转到酒馆原生的世界书编辑器打开它：</p>
          <button type="button" class="menu_button st-pw-fallback-jump-btn">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转到酒馆世界书面板打开「${sanitizeHtml(name)}」
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
  let editingUid = null;

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
        raw: entry,
      }))
      .sort((a, b) => a.order - b.order || String(a.uid).localeCompare(String(b.uid)));
  }

  function redraw() {
    const allEntries = getEntriesArray();
    const enabledCount = allEntries.filter((e) => !e.disable).length;
    const constantCount = allEntries.filter((e) => !e.disable && e.constant).length;
    const q = searchFilter.trim().toLowerCase();

    const filtered = allEntries.filter((item) => {
      if (!q) return true;
      const inTitle = item.comment.toLowerCase().includes(q);
      const inKeys = item.keyList.join(', ').toLowerCase().includes(q);
      const inContent = item.content.toLowerCase().includes(q);
      return inTitle || inKeys || inContent;
    });

    modal.innerHTML = `
      <div class="st-pw-wb-dialog" role="dialog" aria-modal="true" aria-label="世界书条目管理">
        <div class="st-pw-modal-header">
          <div class="st-pw-modal-title-wrap">
            <i class="fa-solid fa-book-open st-pw-accent-icon"></i>
            <div>
              <h3 class="st-pw-modal-title">${sanitizeHtml(worldbookName)}</h3>
              <p class="st-pw-modal-subtitle">
                共 ${allEntries.length} 条 · 已启用 <strong>${enabledCount}</strong> 条（常驻蓝灯 ${constantCount} 条 / 关键词绿灯 ${enabledCount - constantCount} 条）
              </p>
            </div>
          </div>
          <div class="st-pw-modal-header-actions">
            <button type="button" class="menu_button st-pw-wb-jump-host-btn" title="在酒馆原生世界书编辑器中打开">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转酒馆原生编辑器
            </button>
            <button type="button" class="menu_button st-pw-wb-add-entry-btn">
              <i class="fa-solid fa-plus"></i> 新增条目
            </button>
            <button type="button" class="menu_button st-pw-close-wb-modal">
              <i class="fa-solid fa-xmark"></i> 关闭
            </button>
          </div>
        </div>

        <div class="st-pw-wb-toolbar">
          <div class="st-pw-search-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" class="text_pole st-pw-wb-search-input" placeholder="搜索条目标题、触发关键词或正文内容…" value="${escapeAttr(searchFilter)}" />
          </div>
          <div class="st-pw-wb-bulk-btns">
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-enable-all">全部启用</button>
            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-disable-all">全部停用</button>
          </div>
        </div>

        <div class="st-pw-wb-list">
          ${
            filtered.length === 0
              ? `<div class="st-pw-empty-state">没有匹配的条目。你可以点击右上角「+ 新增条目」直接往这本世界书里添设定。</div>`
              : filtered
                  .map((item) => {
                    const isEditing = editingUid === String(item._key);
                    const statusBadge = item.disable
                      ? `<span class="st-pw-badge st-pw-badge-muted">已停用</span>`
                      : item.constant
                        ? `<span class="st-pw-badge st-pw-badge-blue">🔵 常驻生效</span>`
                        : `<span class="st-pw-badge st-pw-badge-green">🟢 关键词触发</span>`;
                    return `
                      <div class="st-pw-wb-entry-card ${item.disable ? 'is-disabled' : ''}" data-entry-key="${escapeAttr(item._key)}">
                        <div class="st-pw-wb-entry-head">
                          <label class="st-pw-switch" title="启用/停用此条目">
                            <input type="checkbox" class="st-pw-wb-toggle-enable" data-entry-key="${escapeAttr(item._key)}" ${!item.disable ? 'checked' : ''} />
                            <span class="st-pw-slider"></span>
                          </label>
                          <div class="st-pw-wb-entry-main">
                            <div class="st-pw-wb-entry-title-row">
                              <strong class="st-pw-wb-entry-title">${sanitizeHtml(item.comment || `(未命名条目 #${item.uid})`)}</strong>
                              ${statusBadge}
                            </div>
                            <div class="st-pw-wb-entry-keys">
                              ${
                                item.constant
                                  ? `<span>无需关键词，激活该 User 时始终注入</span>`
                                  : `<span>触发词：${sanitizeHtml(item.keyList.join('、') || '（未填触发词）')}</span>`
                              }
                            </div>
                          </div>
                          <div class="st-pw-wb-entry-actions">
                            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-toggle-constant" data-entry-key="${escapeAttr(item._key)}" title="切换常驻蓝灯 / 关键词绿灯">
                              ${item.constant ? '切为关键词' : '设为常驻'}
                            </button>
                            <button type="button" class="menu_button st-pw-mini-btn st-pw-wb-edit-btn" data-entry-key="${escapeAttr(item._key)}">
                              <i class="fa-solid fa-pen"></i> ${isEditing ? '收起' : '编辑'}
                            </button>
                          </div>
                        </div>
                        ${
                          !isEditing
                            ? `<div class="st-pw-wb-entry-preview">${sanitizeHtml(item.content.slice(0, 180))}${item.content.length > 180 ? '…' : ''}</div>`
                            : `
                              <div class="st-pw-wb-entry-editor">
                                <div class="st-pw-form-grid">
                                  <div>
                                    <label>条目标题 (Comment)</label>
                                    <input type="text" class="text_pole st-pw-edit-comment" value="${escapeAttr(item.comment)}" />
                                  </div>
                                  <div>
                                    <label>触发关键词（逗号分隔，绿灯模式下生效）</label>
                                    <input type="text" class="text_pole st-pw-edit-keys" value="${escapeAttr(item.keyList.join(', '))}" />
                                  </div>
                                </div>
                                <div class="st-pw-form-row">
                                  <label>条目设定正文 (Content)</label>
                                  <textarea class="text_pole st-pw-edit-content" rows="5">${sanitizeHtml(item.content)}</textarea>
                                </div>
                                <div class="st-pw-editor-footer">
                                  <button type="button" class="menu_button st-pw-primary-action-btn st-pw-save-entry-btn" data-entry-key="${escapeAttr(item._key)}">
                                    <i class="fa-solid fa-floppy-disk"></i> 保存此条目到世界书
                                  </button>
                                </div>
                              </div>
                            `
                        }
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    // 绑定事件
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

    modal.querySelector('.st-pw-wb-add-entry-btn')?.addEventListener('click', async () => {
      const existingKeys = Object.keys(worldData.entries || {}).map(Number).filter(Number.isFinite);
      const nextUid = existingKeys.length ? Math.max(...existingKeys) + 1 : 0;
      const keyStr = String(nextUid);
      worldData.entries[keyStr] = {
        uid: nextUid,
        key: [],
        keysecondary: [],
        comment: `新 User 设定条目 #${nextUid + 1}`,
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
      editingUid = keyStr;
      await saveWorldbookData(worldbookName, worldData);
      redraw();
    });

    modal.querySelector('.st-pw-wb-enable-all')?.addEventListener('click', async () => {
      for (const entry of Object.values(worldData.entries || {})) {
        entry.disable = false;
      }
      await saveWorldbookData(worldbookName, worldData);
      globalThis.toastr?.success?.('已启用该世界书全部条目', '世界书弹窗');
      redraw();
    });

    modal.querySelector('.st-pw-wb-disable-all')?.addEventListener('click', async () => {
      for (const entry of Object.values(worldData.entries || {})) {
        entry.disable = true;
      }
      await saveWorldbookData(worldbookName, worldData);
      globalThis.toastr?.info?.('已停用该世界书全部条目', '世界书弹窗');
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
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-entry-key');
        if (key && worldData.entries?.[key]) {
          worldData.entries[key].constant = !worldData.entries[key].constant;
          await saveWorldbookData(worldbookName, worldData);
          redraw();
        }
      });
    });

    modal.querySelectorAll('.st-pw-wb-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-entry-key');
        editingUid = editingUid === key ? null : key;
        redraw();
      });
    });

    modal.querySelectorAll('.st-pw-save-entry-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-entry-key');
        const card = btn.closest('.st-pw-wb-entry-card');
        if (!key || !card || !worldData.entries?.[key]) return;
        const commentVal = card.querySelector('.st-pw-edit-comment')?.value ?? '';
        const keysRaw = card.querySelector('.st-pw-edit-keys')?.value ?? '';
        const contentVal = card.querySelector('.st-pw-edit-content')?.value ?? '';

        worldData.entries[key].comment = commentVal.trim();
        worldData.entries[key].key = keysRaw
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        worldData.entries[key].content = contentVal;

        await saveWorldbookData(worldbookName, worldData);
        globalThis.toastr?.success?.('条目已保存回酒馆世界书', '世界书弹窗');
        editingUid = null;
        redraw();
      });
    });
  }

  redraw();
}

/**
 * 计算当前激活 User 将在本次对话中注入的所有扩展内容（随身设定卡片 A + 附加世界书 B）
 */
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

  // 1. 随身设定卡片 (A)
  for (const trait of profile.traits) {
    if (!trait || !trait.enabled || !String(trait.content || '').trim()) continue;
    if (trait.triggerMode === 'keyword') {
      const kwList = String(trait.keywords || '')
        .split(/[,，]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const matchedKw = kwList.find((kw) => recentText.includes(kw));
      if (!matchedKw) continue;
      blocks.push(`[User 随身设定 · ${trait.title || '触发设定'}]\n${trait.content.trim()}`);
      summary.push({
        type: 'trait',
        title: trait.title || '未命名设定',
        reason: `关键词触发 (${matchedKw})`,
      });
    } else {
      blocks.push(`[User 随身设定 · ${trait.title || '常驻设定'}]\n${trait.content.trim()}`);
      summary.push({
        type: 'trait',
        title: trait.title || '未命名设定',
        reason: '常驻生效',
      });
    }
  }

  // 2. 附加绑定世界书 (B)
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
            title: entry.comment || `条目 #${entry.uid}`,
            reason: '附加书·常驻蓝灯',
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
              title: entry.comment || `条目 #${entry.uid}`,
              reason: `附加书·关键词 (${hit})`,
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

/**
 * 全局生成拦截器（在 manifest.json 的 generate_interceptor 中声明，必须挂在 globalThis 上）
 */
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
      mes: `[当前 User 扩展设定补充]\n${blocks.join('\n\n')}`,
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

/**
 * 打开主界面：「User 人设与世界书衣柜总管」全屏/大弹窗
 */
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

function renderWardrobeModalContent() {
  const modal = document.querySelector('#st_pw_wardrobe_modal');
  if (!modal || modal.classList.contains('st-pw-hidden')) return;

  const settings = getSettings();
  const personas = getHostPersonas();
  const availableBooks = getAvailableWorldbooks();
  const activePersona = personas.find((p) => p.isActive) || null;
  const selectedPersona =
    personas.find((p) => p.avatarId === state.selectedAvatarId) ||
    activePersona ||
    personas[0] ||
    null;

  if (selectedPersona && state.selectedAvatarId !== selectedPersona.avatarId) {
    state.selectedAvatarId = selectedPersona.avatarId;
  }

  // 过滤左侧人设列表
  const q = state.searchQuery.trim().toLowerCase();
  const filteredPersonas = personas
    .filter((p) => {
      if (state.activeModalTab === 'fav' && !p.meta.favorite) return false;
      if (
        state.activeModalTab === 'linked' &&
        !p.lorebook &&
        p.meta.extraWorldbooks.length === 0 &&
        p.meta.traits.length === 0
      ) {
        return false;
      }
      if (
        state.activeModalTab !== 'all' &&
        state.activeModalTab !== 'fav' &&
        state.activeModalTab !== 'linked'
      ) {
        if (p.meta.group !== state.activeModalTab) return false;
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

  modal.innerHTML = `
    <div class="st-pw-wardrobe-dialog" role="dialog" aria-modal="true" aria-label="User 人设与世界书衣柜总管">
      <!-- 顶部栏 -->
      <div class="st-pw-modal-header">
        <div class="st-pw-modal-title-wrap">
          <i class="fa-solid fa-id-card-clip st-pw-accent-icon"></i>
          <div>
            <h3 class="st-pw-modal-title">User 人设与世界书总管</h3>
            <p class="st-pw-modal-subtitle">
              共收纳 <strong>${personas.length}</strong> 个 User 档案 · 支持分类检索、一键切人设、世界书跳转与弹窗直接改条目
            </p>
          </div>
        </div>
        <div class="st-pw-modal-header-actions">
          <button type="button" class="menu_button st-pw-preview-active-prompt-btn" title="查看当前激活 User 实际生效的完整设定与世界书清单">
            <i class="fa-solid fa-eye"></i> 预览当前生效设定
          </button>
          <button type="button" class="menu_button st-pw-refresh-host-btn" title="重新从酒馆同步最新 User 与世界书列表">
            <i class="fa-solid fa-rotate"></i> 刷新同步
          </button>
          <button type="button" class="menu_button st-pw-close-wardrobe-btn">
            <i class="fa-solid fa-xmark"></i> 关闭
          </button>
        </div>
      </div>

      <!-- C. 顶部「当前正在生效总览条」 -->
      <div class="st-pw-active-banner">
        <div class="st-pw-active-banner-left">
          <span class="st-pw-banner-tag">当前激活 User</span>
          <strong>${sanitizeHtml(activePersona ? activePersona.name : '未检测到激活 User')}</strong>
          ${
            activePersona?.meta?.group
              ? `<span class="st-pw-chip">${sanitizeHtml(activePersona.meta.group)}</span>`
              : ''
          }
        </div>
        <div class="st-pw-active-banner-books">
          <div class="st-pw-banner-book-item">
            <span class="st-pw-muted">原生主世界书：</span>
            ${
              activePersona?.lorebook
                ? `
                  <strong class="st-pw-highlight-book">${sanitizeHtml(activePersona.lorebook)}</strong>
                  <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(activePersona.lorebook)}" title="在酒馆世界书面板中跳转打开">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转面板
                  </button>
                  <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(activePersona.lorebook)}" title="直接在弹窗内查看和开关条目">
                    <i class="fa-solid fa-book-open"></i> 弹窗条目
                  </button>
                `
                : `<span class="st-pw-muted">未绑定</span>`
            }
          </div>
          <div class="st-pw-banner-book-item">
            <span class="st-pw-muted">附加世界书：</span>
            <strong>${activeExtraBooks.length} 本启用</strong>
            <span class="st-pw-muted">· 随身设定卡：</span>
            <strong>${activeTraits.length} 条启用</strong>
          </div>
        </div>
      </div>

      <!-- 主体双栏工作台 -->
      <div class="st-pw-workbench">
        <!-- 左栏：分类导航 + 搜索 + User 卡片列表 -->
        <aside class="st-pw-sidebar">
          <div class="st-pw-search-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" id="st_pw_search_input" class="text_pole" placeholder="搜 User 名、设定词、标签、世界书或关联卡…" value="${escapeAttr(state.searchQuery)}" />
          </div>

          <div class="st-pw-group-tabs">
            <button type="button" class="st-pw-tab-btn ${state.activeModalTab === 'all' ? 'active' : ''}" data-tab="all">
              全部 (${personas.length})
            </button>
            <button type="button" class="st-pw-tab-btn ${state.activeModalTab === 'fav' ? 'active' : ''}" data-tab="fav">
              ★ 收藏 (${personas.filter((p) => p.meta.favorite).length})
            </button>
            <button type="button" class="st-pw-tab-btn ${state.activeModalTab === 'linked' ? 'active' : ''}" data-tab="linked">
              已绑设定 (${personas.filter((p) => p.lorebook || p.meta.extraWorldbooks.length || p.meta.traits.length).length})
            </button>
            ${settings.groups
              .map((g) => {
                const count = personas.filter((p) => p.meta.group === g).length;
                return `
                  <button type="button" class="st-pw-tab-btn ${state.activeModalTab === g ? 'active' : ''}" data-tab="${escapeAttr(g)}">
                    ${sanitizeHtml(g)} (${count})
                  </button>
                `;
              })
              .join('')}
            <button type="button" class="st-pw-tab-btn st-pw-add-group-btn" title="新增自定义分组">+ 分组</button>
          </div>

          <div class="st-pw-persona-list">
            ${
              filteredPersonas.length === 0
                ? `<div class="st-pw-empty-state">没有匹配的 User 人设。可尝试清空搜索词或切换分组标签。</div>`
                : filteredPersonas
                    .map((p) => {
                      const isSelected = selectedPersona?.avatarId === p.avatarId;
                      const enabledExtraCount = p.meta.extraWorldbooks.filter((b) => b.enabled).length;
                      const enabledTraitCount = p.meta.traits.filter((t) => t.enabled).length;
                      return `
                        <div class="st-pw-persona-card ${isSelected ? 'is-selected' : ''} ${p.isActive ? 'is-active-user' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}">
                          <div class="st-pw-avatar-box">
                            <img src="${escapeAttr(p.avatarUrl)}" alt="${escapeAttr(p.name)}" onerror="this.style.display='none'" />
                            ${p.isActive ? `<span class="st-pw-active-dot" title="当前正在使用"></span>` : ''}
                          </div>
                          <div class="st-pw-card-info">
                            <div class="st-pw-card-top-row">
                              <strong class="st-pw-card-name">${sanitizeHtml(p.name)}</strong>
                              <button type="button" class="st-pw-fav-btn ${p.meta.favorite ? 'is-fav' : ''}" data-avatar-id="${escapeAttr(p.avatarId)}" title="收藏置顶">
                                ★
                              </button>
                            </div>
                            <div class="st-pw-card-badges">
                              ${p.isActive ? `<span class="st-pw-badge st-pw-badge-amber">使用中</span>` : ''}
                              ${p.meta.group ? `<span class="st-pw-badge">${sanitizeHtml(p.meta.group)}</span>` : ''}
                              ${
                                p.lorebook
                                  ? `<span class="st-pw-badge st-pw-badge-blue" title="原生主世界书：${escapeAttr(p.lorebook)}"><i class="fa-solid fa-book"></i> ${sanitizeHtml(p.lorebook)}</span>`
                                  : ''
                              }
                              ${
                                enabledExtraCount > 0
                                  ? `<span class="st-pw-badge st-pw-badge-green">+${enabledExtraCount} 附加书</span>`
                                  : ''
                              }
                              ${
                                enabledTraitCount > 0
                                  ? `<span class="st-pw-badge st-pw-badge-purple">${enabledTraitCount} 随身卡</span>`
                                  : ''
                              }
                            </div>
                            <div class="st-pw-card-desc-snippet">
                              ${sanitizeHtml((p.description || p.meta.note || '暂无描述').slice(0, 60))}
                            </div>
                          </div>
                          <div class="st-pw-card-quick-action">
                            ${
                              p.isActive
                                ? `<span class="st-pw-in-use-label">当前</span>`
                                : `<button type="button" class="menu_button st-pw-mini-btn st-pw-use-persona-btn" data-avatar-id="${escapeAttr(p.avatarId)}">切换</button>`
                            }
                          </div>
                        </div>
                      `;
                    })
                    .join('')
            }
          </div>
        </aside>

        <!-- 右栏：选中 User 的详情、世界书跳转/弹窗中心、附加世界书、随身设定卡片 -->
        <main class="st-pw-detail-pane">
          ${
            !selectedPersona
              ? `<div class="st-pw-empty-state">尚未在酒馆中检测到任何 User 人设。请先打开一次酒馆顶部的「User 人设管理」抽屉。</div>`
              : renderSelectedPersonaDetail(selectedPersona, availableBooks, settings)
          }
        </main>
      </div>
    </div>
  `;

  bindWardrobeModalEvents(modal, selectedPersona, availableBooks);
}

function renderSelectedPersonaDetail(persona, availableBooks, settings) {
  const meta = persona.meta;
  const bookOptionsHtml = [
    `<option value="">— 未绑定主世界书 —</option>`,
    ...availableBooks.map(
      (b) =>
        `<option value="${escapeAttr(b)}" ${persona.lorebook === b ? 'selected' : ''}>${sanitizeHtml(b)}</option>`
    ),
  ].join('');

  return `
    <!-- 详情头部 -->
    <div class="st-pw-detail-header">
      <div class="st-pw-detail-identity">
        <img class="st-pw-detail-avatar" src="${escapeAttr(persona.avatarUrl)}" alt="${escapeAttr(persona.name)}" onerror="this.style.display='none'" />
        <div>
          <div class="st-pw-detail-title-row">
            <h2>${sanitizeHtml(persona.name)}</h2>
            <span class="st-pw-mono-id">${sanitizeHtml(persona.avatarId)}</span>
            ${
              persona.isActive
                ? `<span class="st-pw-badge st-pw-badge-amber">当前正在使用此 User</span>`
                : `<button type="button" class="menu_button st-pw-primary-action-btn st-pw-detail-switch-btn" data-avatar-id="${escapeAttr(persona.avatarId)}">
                    <i class="fa-solid fa-check"></i> 一键切换为此 User
                  </button>`
            }
          </div>
          <div class="st-pw-detail-meta-bar">
            <label>所属分类：</label>
            <select id="st_pw_detail_group" class="text_pole st-pw-inline-select">
              <option value="">未分类</option>
              ${settings.groups
                .map(
                  (g) =>
                    `<option value="${escapeAttr(g)}" ${meta.group === g ? 'selected' : ''}>${sanitizeHtml(g)}</option>`
                )
                .join('')}
            </select>
            <label>标签（逗号分隔）：</label>
            <input type="text" id="st_pw_detail_tags" class="text_pole st-pw-inline-input" placeholder="如：高冷, 调查员, 现代" value="${escapeAttr(meta.tags.join(', '))}" />
            <label>常用关联角色卡：</label>
            <input type="text" id="st_pw_detail_chars" class="text_pole st-pw-inline-input" placeholder="填角色名，切聊天可自动匹配" value="${escapeAttr(meta.boundCharacters.join(', '))}" />
          </div>
        </div>
      </div>
    </div>

    <!-- 模块 1：世界书绑定、一键跳转与弹窗速编中心 (核心解决原生世界书不好使) -->
    <section class="st-pw-section-card">
      <div class="st-pw-section-head">
        <div>
          <h3><i class="fa-solid fa-earth-asia st-pw-accent-icon"></i> 关联世界书总控（支持一键跳转面板 & 弹窗直接改条目）</h3>
          <p class="st-pw-section-desc">
            原生主世界书会直接同步给酒馆自带的 Persona Lorebook；你还可以额外绑定多本附加世界书，切换此 User 时自动联动生效。
          </p>
        </div>
      </div>

      <!-- 1.1 原生主绑定世界书 -->
      <div class="st-pw-primary-book-box">
        <div class="st-pw-book-box-label">
          <strong>原生主绑定世界书 (Primary Lorebook)</strong>
          <span class="st-pw-muted">与酒馆原生 User 面板双向同步</span>
        </div>
        <div class="st-pw-book-controls-row">
          <select id="st_pw_primary_book_select" class="text_pole st-pw-book-select">
            ${bookOptionsHtml}
          </select>
          <button type="button" class="menu_button st-pw-act-jump-book" data-book="${escapeAttr(persona.lorebook)}" ${!persona.lorebook ? 'disabled' : ''} title="像角色世界书一样，直接打开酒馆世界书面板并选中这本书">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转世界书面板
          </button>
          <button type="button" class="menu_button st-pw-primary-action-btn st-pw-act-popup-book" data-book="${escapeAttr(persona.lorebook)}" ${!persona.lorebook ? 'disabled' : ''} title="不离开当前页面，直接弹窗查看、搜索、开关和修改里面的条目">
            <i class="fa-solid fa-book-open"></i> 弹窗管理条目
          </button>
        </div>
      </div>

      <!-- 1.2 附加绑定世界书 (B: 多世界书绑定) -->
      <div class="st-pw-extra-books-box">
        <div class="st-pw-book-box-label">
          <strong>附加关联世界书（突破原生只能绑 1 本的限制）</strong>
          <div class="st-pw-add-extra-book-row">
            <select id="st_pw_add_extra_book_select" class="text_pole st-pw-inline-select">
              <option value="">+ 选择一本现有世界书加入关联…</option>
              ${availableBooks
                .filter((b) => b !== persona.lorebook && !meta.extraWorldbooks.some((eb) => eb.name === b))
                .map((b) => `<option value="${escapeAttr(b)}">${sanitizeHtml(b)}</option>`)
                .join('')}
            </select>
            <button type="button" id="st_pw_add_extra_book_btn" class="menu_button st-pw-mini-btn">
              <i class="fa-solid fa-plus"></i> 添加绑定
            </button>
          </div>
        </div>

        ${
          meta.extraWorldbooks.length === 0
            ? `<div class="st-pw-subtle-empty">暂未绑定额外世界书。若该 User 需要同时挂载「通用背景书 + 个人关系书 + 道具书」，可在右上角下拉框添加。</div>`
            : `
              <div class="st-pw-extra-book-list">
                ${meta.extraWorldbooks
                  .map(
                    (eb, idx) => `
                      <div class="st-pw-extra-book-item ${eb.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                        <label class="st-pw-switch" title="启用/暂停此附加世界书">
                          <input type="checkbox" class="st-pw-toggle-extra-book" data-idx="${idx}" ${eb.enabled ? 'checked' : ''} />
                          <span class="st-pw-slider"></span>
                        </label>
                        <strong class="st-pw-extra-book-name"><i class="fa-solid fa-book-bookmark"></i> ${sanitizeHtml(eb.name)}</strong>
                        <span class="st-pw-badge st-pw-badge-green">随此 User 自动扫描生效</span>
                        <div class="st-pw-extra-book-btns">
                          <button type="button" class="menu_button st-pw-mini-btn st-pw-act-jump-book" data-book="${escapeAttr(eb.name)}">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转面板
                          </button>
                          <button type="button" class="menu_button st-pw-mini-btn st-pw-act-popup-book" data-book="${escapeAttr(eb.name)}">
                            <i class="fa-solid fa-book-open"></i> 弹窗条目
                          </button>
                          <button type="button" class="menu_button st-pw-mini-btn st-pw-remove-extra-book" data-idx="${idx}" title="移除关联（不会删除原世界书文件）">
                            <i class="fa-solid fa-trash-can"></i>
                          </button>
                        </div>
                      </div>
                    `
                  )
                  .join('')}
              </div>
            `
        }
      </div>
    </section>

    <!-- 模块 2：A. User 随身设定卡片（不用专门建世界书也能随时勾选开关的模块化人设） -->
    <section class="st-pw-section-card">
      <div class="st-pw-section-head">
        <div>
          <h3><i class="fa-solid fa-layer-group st-pw-accent-icon"></i> 随身设定卡片（模块化人设开关）</h3>
          <p class="st-pw-section-desc">
            把「表面身份」「隐藏过往」「当前服装/状态」「对某角色的特殊关系」拆成独立小卡片，随时打勾启用，支持常驻或关键词触发。
          </p>
        </div>
        <button type="button" id="st_pw_add_trait_btn" class="menu_button st-pw-primary-action-btn">
          <i class="fa-solid fa-plus"></i> 新增随身设定卡
        </button>
      </div>

      ${
        meta.traits.length === 0
          ? `<div class="st-pw-subtle-empty">还没有随身设定卡。点击右上角「+ 新增随身设定卡」，可以把零散设定拆开管理，不用每次去世界书里大海捞针。</div>`
          : `
            <div class="st-pw-trait-list">
              ${meta.traits
                .map(
                  (trait, idx) => `
                    <div class="st-pw-trait-card ${trait.enabled ? '' : 'is-disabled'}" data-idx="${idx}">
                      <div class="st-pw-trait-header">
                        <label class="st-pw-switch" title="启用/停用此设定卡">
                          <input type="checkbox" class="st-pw-trait-enable" data-idx="${idx}" ${trait.enabled ? 'checked' : ''} />
                          <span class="st-pw-slider"></span>
                        </label>
                        <input type="text" class="text_pole st-pw-trait-title" data-idx="${idx}" placeholder="设定卡标题（如：隐藏身份 / 战损状态 / 随身背包）" value="${escapeAttr(trait.title)}" />
                        <select class="text_pole st-pw-trait-mode" data-idx="${idx}">
                          <option value="always" ${trait.triggerMode !== 'keyword' ? 'selected' : ''}>🔵 常驻生效</option>
                          <option value="keyword" ${trait.triggerMode === 'keyword' ? 'selected' : ''}>🟢 关键词触发</option>
                        </select>
                        <button type="button" class="menu_button st-pw-mini-btn st-pw-trait-delete" data-idx="${idx}" title="删除此设定卡">
                          <i class="fa-solid fa-trash-can"></i>
                        </button>
                      </div>
                      ${
                        trait.triggerMode === 'keyword'
                          ? `
                            <div class="st-pw-trait-kw-row">
                              <input type="text" class="text_pole st-pw-trait-keywords" data-idx="${idx}" placeholder="输入触发关键词，多个词用逗号分隔（最近消息提及即自动注入）" value="${escapeAttr(trait.keywords || '')}" />
                            </div>
                          `
                          : ''
                      }
                      <textarea class="text_pole st-pw-trait-content" data-idx="${idx}" rows="3" placeholder="输入这段随身设定的具体内容…">${sanitizeHtml(trait.content || '')}</textarea>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
      }
    </section>

    <!-- 模块 3：原生基础人设描述 & 私密备忘 -->
    <section class="st-pw-section-card">
      <div class="st-pw-section-head">
        <div>
          <h3><i class="fa-solid fa-user-pen st-pw-accent-icon"></i> 基础人设描述与私密备注</h3>
          <p class="st-pw-section-desc">左侧直接同步修改酒馆原生的 Persona Description；右侧备忘仅供你自己识别，不会发送给 AI。</p>
        </div>
        <button type="button" id="st_pw_save_base_desc_btn" class="menu_button">
          <i class="fa-solid fa-floppy-disk"></i> 保存基础描述
        </button>
      </div>
      <div class="st-pw-form-grid">
        <div>
          <label for="st_pw_base_description">原生 User 人设描述 (Persona Description)</label>
          <textarea id="st_pw_base_description" class="text_pole" rows="5" placeholder="该 User 的常驻基础描述…">${sanitizeHtml(persona.description)}</textarea>
        </div>
        <div>
          <label for="st_pw_private_note">衣柜私密备注（不发给 AI，仅自己可见）</label>
          <textarea id="st_pw_private_note" class="text_pole" rows="5" placeholder="记录这个 User 适合什么题材、配哪张角色卡、当前玩到哪条线…">${sanitizeHtml(meta.note)}</textarea>
        </div>
      </div>
    </section>
  `;
}

function bindWardrobeModalEvents(modal, selectedPersona, _availableBooks) {
  const settings = getSettings();

  modal.querySelector('.st-pw-close-wardrobe-btn')?.addEventListener('click', () => {
    modal.classList.add('st-pw-hidden');
  });

  modal.querySelector('.st-pw-refresh-host-btn')?.addEventListener('click', () => {
    refreshAllViews();
    globalThis.toastr?.info?.('已同步酒馆最新 User 与世界书列表', 'User 人设衣柜');
  });

  modal.querySelector('.st-pw-preview-active-prompt-btn')?.addEventListener('click', async () => {
    await openActivePromptPreviewModal();
  });

  // 搜索框
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

  // 分类标签切换
  modal.querySelectorAll('.st-pw-tab-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeModalTab = btn.getAttribute('data-tab') || 'all';
      renderWardrobeModalContent();
    });
  });

  // 新增自定义分组
  modal.querySelector('.st-pw-add-group-btn')?.addEventListener('click', () => {
    const newGroup = window.prompt('请输入新的人设分类名称（例如：克苏鲁跑团、校园恋爱）：');
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

  // 点击左侧卡片选中详情
  modal.querySelectorAll('.st-pw-persona-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (
        e.target.closest('.st-pw-fav-btn') ||
        e.target.closest('.st-pw-use-persona-btn')
      ) {
        return;
      }
      state.selectedAvatarId = card.getAttribute('data-avatar-id');
      renderWardrobeModalContent();
    });
  });

  // 收藏按钮
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

  // 一键切换 User
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

  // 所有「跳转世界书面板」按钮
  modal.querySelectorAll('.st-pw-act-jump-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const book = btn.getAttribute('data-book');
      jumpToWorldbookInHost(book, { fromWardrobeModal: true });
    });
  });

  // 所有「弹窗管理条目」按钮
  modal.querySelectorAll('.st-pw-act-popup-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const book = btn.getAttribute('data-book');
      openWorldbookInspectorModal(book);
    });
  });

  if (!selectedPersona) return;
  const meta = selectedPersona.meta;

  // 分类、标签、关联角色卡修改
  modal.querySelector('#st_pw_detail_group')?.addEventListener('change', (e) => {
    meta.group = e.target.value;
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

  modal.querySelector('#st_pw_detail_chars')?.addEventListener('change', (e) => {
    meta.boundCharacters = e.target.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    saveSettings();
  });

  // 更换原生主绑定世界书
  modal.querySelector('#st_pw_primary_book_select')?.addEventListener('change', (e) => {
    const newBook = e.target.value;
    updateHostPersonaData(selectedPersona.avatarId, { lorebook: newBook });
    globalThis.toastr?.success?.(
      newBook ? `已将该 User 主世界书绑定为「${newBook}」` : '已解除该 User 的主世界书绑定',
      'User 人设衣柜'
    );
  });

  // 添加附加绑定世界书
  modal.querySelector('#st_pw_add_extra_book_btn')?.addEventListener('click', () => {
    const sel = modal.querySelector('#st_pw_add_extra_book_select');
    const bookName = sel?.value?.trim();
    if (!bookName) {
      globalThis.toastr?.info?.('请先从下拉框选择一本要关联的世界书', '附加世界书');
      return;
    }
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

  // 随身设定卡片 (A)
  modal.querySelector('#st_pw_add_trait_btn')?.addEventListener('click', () => {
    meta.traits.push({
      id: `trait_${Date.now()}`,
      title: `随身设定 #${meta.traits.length + 1}`,
      content: '',
      enabled: true,
      triggerMode: 'always',
      keywords: '',
    });
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

  modal.querySelectorAll('.st-pw-trait-title').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].title = e.target.value.trim();
        saveSettings();
      }
    });
  });

  modal.querySelectorAll('.st-pw-trait-mode').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = Number(e.target.getAttribute('data-idx'));
      if (meta.traits[idx]) {
        meta.traits[idx].triggerMode = e.target.value;
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
      saveSettings();
      renderWardrobeModalContent();
    });
  });

  // 保存基础人设描述与私密备注
  modal.querySelector('#st_pw_save_base_desc_btn')?.addEventListener('click', () => {
    const newDesc = modal.querySelector('#st_pw_base_description')?.value ?? '';
    const newNote = modal.querySelector('#st_pw_private_note')?.value ?? '';
    meta.note = newNote;
    updateHostPersonaData(selectedPersona.avatarId, { description: newDesc });
    globalThis.toastr?.success?.('已保存基础人设描述与备注', 'User 人设衣柜');
  });

  modal.querySelector('#st_pw_private_note')?.addEventListener('change', (e) => {
    meta.note = e.target.value;
    saveSettings();
  });
}

/**
 * C. 预览当前激活 User 实际生效的设定清单与合成文本弹窗
 */
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
    <div class="st-pw-wb-dialog" role="dialog" aria-modal="true" aria-label="当前 User 生效设定预览">
      <div class="st-pw-modal-header">
        <div class="st-pw-modal-title-wrap">
          <i class="fa-solid fa-eye st-pw-accent-icon"></i>
          <div>
            <h3 class="st-pw-modal-title">当前生效设定总览：${sanitizeHtml(active?.name || '未选中 User')}</h3>
            <p class="st-pw-modal-subtitle">以下为你当前聊天轮次中，随该 User 一同生效的人设、原生主世界书与扩展注入内容</p>
          </div>
        </div>
        <button type="button" class="menu_button st-pw-close-preview-btn">关闭</button>
      </div>
      <div class="st-pw-wb-body">
        <div class="st-pw-preview-section">
          <h4>1. 原生基础人设 (Persona Description)</h4>
          <pre class="st-pw-code-preview">${sanitizeHtml(active?.description || '（空）')}</pre>
        </div>
        <div class="st-pw-preview-section">
          <h4>2. 原生主绑定世界书 (Primary Lorebook)</h4>
          <p>${
            active?.lorebook
              ? `已绑定 <strong>${sanitizeHtml(active.lorebook)}</strong>（由酒馆原生世界书引擎扫描激活，可点「弹窗管理条目」或「跳转世界书面板」检查具体条目）`
              : '未绑定原生主世界书'
          }</p>
        </div>
        <div class="st-pw-preview-section">
          <h4>3. 本插件在当前聊天命中的随身设定卡 & 附加世界书条目 (${summary.length} 项)</h4>
          ${
            summary.length === 0
              ? `<p class="st-pw-muted">当前无额外命中的随身设定卡或附加世界书条目。</p>`
              : `
                <ul class="st-pw-hit-list">
                  ${summary
                    .map(
                      (s) =>
                        `<li><strong>${sanitizeHtml(s.book ? `[${s.book}] ${s.title}` : s.title)}</strong> — <span class="st-pw-badge st-pw-badge-green">${sanitizeHtml(s.reason)}</span></li>`
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
 * 在酒馆原生 Persona Management 面板的「Persona Lorebook」旁注入【↗ 跳转世界书】【📖 弹窗条目】【🗂️ 人设衣柜】快捷按钮
 */
function syncNativePersonaPanelEnhancement() {
  const settings = getSettings();
  const existingBar = document.querySelector('#st_pw_native_persona_helper');

  if (!settings.enhanceNativePersonaPanel) {
    existingBar?.remove();
    return;
  }

  const loreSelect = document.querySelector('#persona_description_lorebook');
  const personaPanel =
    loreSelect?.closest('#PersonaManagement') ||
    document.querySelector('#user-settings-block') ||
    loreSelect?.parentElement;

  if (!loreSelect || !personaPanel) return;

  let helperBar = existingBar;
  if (!helperBar) {
    helperBar = document.createElement('div');
    helperBar.id = 'st_pw_native_persona_helper';
    helperBar.className = 'st-pw-native-helper-bar';
    loreSelect.insertAdjacentElement('afterend', helperBar);
  }

  const getSelectedNativeBook = () => {
    const personas = getHostPersonas();
    const active = personas.find((p) => p.isActive);
    if (active?.lorebook) return active.lorebook;
    const opt = loreSelect.options?.[loreSelect.selectedIndex];
    const txt = opt ? opt.textContent.trim() : '';
    return loreSelect.value && txt && !txt.includes('None') && !txt.startsWith('---') ? txt : '';
  };

  helperBar.innerHTML = `
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-jump-btn" title="像角色世界书一样直接跳转打开这本世界书">
      <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转打开此世界书
    </button>
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-popup-btn" title="直接在弹窗里查看、搜索、开关这本世界书的条目">
      <i class="fa-solid fa-book-open"></i> 弹窗管理条目
    </button>
    <button type="button" class="menu_button st-pw-mini-btn st-pw-native-wardrobe-btn" title="打开多 User 分类衣柜与随身设定总管">
      <i class="fa-solid fa-id-card-clip"></i> User 衣柜总管
    </button>
  `;

  helperBar.querySelector('.st-pw-native-jump-btn')?.addEventListener('click', () => {
    jumpToWorldbookInHost(getSelectedNativeBook(), { fromWardrobeModal: false });
  });

  helperBar.querySelector('.st-pw-native-popup-btn')?.addEventListener('click', () => {
    openWorldbookInspectorModal(getSelectedNativeBook());
  });

  helperBar.querySelector('.st-pw-native-wardrobe-btn')?.addEventListener('click', () => {
    openWardrobeModal();
  });
}

/**
 * 同步顶部导航栏与左下角魔棒菜单快捷入口
 */
function syncQuickEntryButtons() {
  const settings = getSettings();

  // 1. 顶部导航栏按钮
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
          <div class="drawer-icon fa-solid fa-id-card-clip fa-fw closedIcon" title="打开 User 人设与世界书衣柜"></div>
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

  // 2. 魔棒菜单按钮 (#extensionsMenu)
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
        <span>User 人设与世界书衣柜</span>
      `;
      item.addEventListener('click', () => {
        openWardrobeModal();
      });
      extMenu.appendChild(item);
    }
  }
}

/**
 * 刷新扩展右侧抽屉状态与打开中的弹窗
 */
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
    extraSummaryEl.textContent = `${ebCount} 本附加世界书 · ${trCount} 条随身设定开启`;
  }

  syncNativePersonaPanelEnhancement();
  syncQuickEntryButtons();
  renderWardrobeModalContent();
}

/**
 * 切换角色聊天时检查是否有绑定该角色的专属 User 人设
 */
function onChatChanged() {
  refreshAllViews();
  const settings = getSettings();
  if (!settings.autoSwitchOnCharacterChat) return;

  try {
    const context = getContext();
    const charId = context.characterId;
    const charObj = charId !== undefined ? context.characters?.[charId] : null;
    const charName = String(charObj?.name || '').trim();
    if (!charName) return;

    const personas = getHostPersonas();
    const matched = personas.find((p) =>
      p.meta.boundCharacters.some((c) => c.toLowerCase() === charName.toLowerCase())
    );
    if (matched && !matched.isActive) {
      globalThis.toastr?.info?.(
        `检测到角色「${charName}」关联了专属 User「${matched.name}」，可在人设衣柜一键切换。`,
        'User 人设衣柜'
      );
    }
  } catch (_e) {}
}

/**
 * 注册 /pwardrobe 斜杠命令
 */
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
                description: '可选：直接填写要切换的 User 名字，留空则打开人设衣柜面板',
                typeList: ARGUMENT_TYPE?.STRING ? [ARGUMENT_TYPE.STRING] : ['string'],
                isRequired: false,
              }),
            ]
          : [],
        helpString: '<div>打开 User 人设与世界书衣柜，或直接按名字切换当前 User。</div>',
      })
    );
  } catch (err) {
    console.warn(`[${MODULE_ID}] 注册斜杠命令跳过:`, err);
  }
}

/**
 * 注入扩展设置面板并绑定控件
 */
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

  // 导出配置
  document.querySelector('#st_pw_export_btn')?.addEventListener('click', () => {
    const payload = JSON.stringify(getSettings(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `st-persona-wardrobe-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // 导入配置
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
        throw new Error('配置文件缺少 profiles 字段');
      }
      const current = getSettings();
      if (Array.isArray(parsed.groups)) {
        current.groups = [...new Set([...current.groups, ...parsed.groups])];
      }
      Object.assign(current.profiles, parsed.profiles);
      saveSettings();
      refreshAllViews();
      globalThis.toastr?.success?.('已成功导入 User 衣柜配置', 'User 人设衣柜');
    } catch (err) {
      globalThis.toastr?.error?.(`导入失败：${err.message}`, 'User 人设衣柜');
    } finally {
      importFile.value = '';
    }
  });
}

async function initExtension() {
  if (state.initialized) return;
  state.initialized = true;

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
      // 兼容 ST v1.17+ 新增的 PERSONA_* 事件
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

// 兼容 ST v1.14 - v1.16 无 manifest.hooks 的加载路径（幂等防重复初始化）
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
