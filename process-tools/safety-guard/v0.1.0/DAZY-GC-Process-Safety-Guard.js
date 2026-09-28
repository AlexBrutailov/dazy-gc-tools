/*
 * DAZY — GC Process Safety Guard v0.1.0 BETA
 *
 * Независимая страховка координат для редактора процессов GetCourse.
 * - блокирует случайное массовое перемещение сверх лимита;
 * - даёт одноразовое разрешение для намеренного большого переноса;
 * - перед таким переносом сохраняет координаты выбранных блоков в localStorage;
 * - хранит постоянную полную точку восстановления процесса между перезагрузками;
 * - умеет read-only сравнить серверные координаты и восстановить только изменённые блоки.
 */

(() => {
  'use strict';

  const TOOL_KEY = 'gcProcessSafetyGuardV010Beta';
  const VERSION = '0.1.0 BETA';

  try { window[TOOL_KEY]?.destroy?.(); } catch (_) {}

  const SHARED_CONFIG =
    window.DAZY_PROCESS_TOOLS_CONFIG &&
    typeof window.DAZY_PROCESS_TOOLS_CONFIG === 'object'
      ? window.DAZY_PROCESS_TOOLS_CONFIG
      : {};

  const page = {
    pathname: location.pathname,
    processId: new URLSearchParams(location.search).get('id') || '',
    accountId: Number(window.accountId || window.account_id || 0),
    accountUserId: Number(window.accountUserId || window.account_user_id || 0),
  };

  const CONFIG = {
    allowedAccountIds: (Array.isArray(SHARED_CONFIG.allowedAccountIds)
      ? SHARED_CONFIG.allowedAccountIds : []).map(Number).filter(Number.isFinite),
    allowedUserIds: (Array.isArray(SHARED_CONFIG.allowedUserIds)
      ? SHARED_CONFIG.allowedUserIds : []).map(Number).filter(Number.isFinite),
    allowedProcessIds: (Array.isArray(SHARED_CONFIG.allowedProcessIds)
      ? SHARED_CONFIG.allowedProcessIds : []).map(String).filter(Boolean),
    allowAnyAccount: SHARED_CONFIG.allowAnyAccount === true,
    allowAnyUser: SHARED_CONFIG.allowAnyUser === true,
    allowAnyProcess: SHARED_CONFIG.allowAnyProcess === true,
    massMoveLimit: Math.max(1, Number(SHARED_CONFIG.massMoveLimit) || 16),
    permitTtlMs: Math.max(10000, Number(SHARED_CONFIG.massMovePermitTtlMs) || 60000),
    baselineHistoryLimit: Math.max(1, Number(SHARED_CONFIG.baselineHistoryLimit) || 3),
    moveHistoryLimit: Math.max(1, Number(SHARED_CONFIG.moveHistoryLimit) || 10),
    requestTimeoutMs: Math.max(5000, Number(SHARED_CONFIG.requestTimeoutMs) || 20000),
    debug: SHARED_CONFIG.debug === true,
  };

  function isAllowed() {
    if (page.pathname !== '/pl/tasks/mission/process' || !page.processId) return false;
    const accountOk = CONFIG.allowAnyAccount || !CONFIG.allowedAccountIds.length ||
      CONFIG.allowedAccountIds.includes(page.accountId);
    const userOk = CONFIG.allowAnyUser || !CONFIG.allowedUserIds.length ||
      CONFIG.allowedUserIds.includes(page.accountUserId);
    const processOk = CONFIG.allowAnyProcess ||
      (CONFIG.allowedProcessIds.length && CONFIG.allowedProcessIds.includes(page.processId));
    return Boolean(accountOk && userOk && processOk);
  }

  if (!isAllowed()) {
    console.info('[DAZY Safety Guard] Запуск пропущен.', page);
    return;
  }

  if (!window.jQuery) {
    console.warn('[DAZY Safety Guard] jQuery не найден.');
    return;
  }

  const $ = window.jQuery;
  const storageBase = `dazyGcSafetyGuardV1:${page.accountId || 'account'}:${page.processId}`;
  const BASELINES_KEY = `${storageBase}:baselines`;
  const MOVES_KEY = `${storageBase}:moves`;
  const SETTINGS_KEY = `${storageBase}:settings`;

  const state = {
    destroyed: false,
    panel: null,
    style: null,
    statusEl: null,
    baselineEl: null,
    permitBtn: null,
    restoreBaselineBtn: null,
    restoreMoveBtn: null,
    collapsed: false,
    pendingMassIds: [],
    permit: null,
    baselinePreview: null,
    movePreview: null,
    handlers: [],
  };

  const log = (...args) => { if (CONFIG.debug) console.log('[DAZY Safety Guard]', ...args); };
  const warn = (...args) => console.warn('[DAZY Safety Guard]', ...args);

  function ajaxPromise(options) {
    return new Promise((resolve, reject) => {
      $.ajax({ timeout: CONFIG.requestTimeoutMs, ...options })
        .done((data, textStatus, jqXHR) => resolve({ data, textStatus, jqXHR }))
        .fail((jqXHR, textStatus, errorThrown) => reject({ jqXHR, textStatus, errorThrown }));
    });
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      warn('Не удалось записать localStorage:', error);
      return false;
    }
  }

  function getPlugin() {
    const $flowchart = $('#flowchart');
    return $flowchart.data('gc-flowchartPlugin') || $flowchart.data('flowchartPlugin') || null;
  }

  function getBlockId(el) {
    if (!el) return '';
    return String(
      el.dataset?.id ||
      el.getAttribute?.('data-id') ||
      String(el.id || '').replace(/^fwb/, '') ||
      ''
    ).trim();
  }

  function getSelectedIds() {
    const visual = [...document.querySelectorAll('#flowchart .flowchart-block.flowchart-selected')]
      .filter(el => el.isConnected && !el.classList.contains('start-flowchart-block'))
      .map(getBlockId).filter(Boolean);

    let internal = [];
    try {
      internal = (getPlugin()?.flowchartSelectable?.getSelectedNodes?.() || [])
        .filter(el => el && !el.classList?.contains('start-flowchart-block'))
        .map(getBlockId).filter(Boolean);
    } catch (_) {}

    return [...new Set([...visual, ...internal].map(String))];
  }

  function idsEqual(a, b) {
    const aa = [...new Set((a || []).map(String))].sort();
    const bb = [...new Set((b || []).map(String))].sort();
    return aa.length === bb.length && aa.every((id, i) => id === bb[i]);
  }

  function getBlockPosition(el) {
    const left = Number.parseFloat(el?.style?.left || '');
    const top = Number.parseFloat(el?.style?.top || '');
    if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
    const data = getPlugin()?.blocks?.[getBlockId(el)] ||
      Object.values(getPlugin()?.blocks || {}).find(item => String(item?.id) === getBlockId(el));
    return {
      left: Number(data?.coord?.left) || 0,
      top: Number(data?.coord?.top) || 0,
    };
  }

  function findSectionId(blockId) {
    const plugin = getPlugin();
    const blocks = plugin?.blocks || {};
    const data = blocks[blockId] || Object.values(blocks).find(item => String(item?.id) === String(blockId));
    const direct = Number(data?.sectionId);
    if (Number.isFinite(direct) && direct > 0) return direct;
    return null;
  }

  function captureSelectedSnapshot(ids, reason) {
    const blocks = [];
    for (const id of ids) {
      const el = document.getElementById(`fwb${id}`);
      if (!el) continue;
      const pos = getBlockPosition(el);
      blocks.push({ id: String(id), left: pos.left, top: pos.top, sectionId: findSectionId(id) });
    }
    if (!blocks.length) return null;
    const snapshot = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      processId: page.processId,
      reason,
      blocks,
    };
    const history = readJson(MOVES_KEY, []);
    history.unshift(snapshot);
    history.splice(CONFIG.moveHistoryLimit);
    if (!writeJson(MOVES_KEY, history)) return null;
    updatePanel();
    return snapshot;
  }

  async function fetchServerSnapshot() {
    const response = await ajaxPromise({
      url: `/pl/tasks/mission/flowchart-data?id=${encodeURIComponent(page.processId)}`,
      type: 'POST', dataType: 'json', data: {},
    });
    const data = response?.data?.data?.flowchartData;
    if (!data) throw new Error('GetCourse не вернул flowchartData.');
    const blocks = Array.isArray(data.blocks) ? data.blocks : Object.values(data.blocks || {});
    const coords = {};
    blocks.forEach(block => {
      const id = String(block?.id || '');
      const left = Number(block?.coord?.left);
      const top = Number(block?.coord?.top);
      if (!id || !Number.isFinite(left) || !Number.isFinite(top)) return;
      coords[id] = { left, top, sectionId: Number(block?.sectionId) || null };
    });
    return {
      capturedAt: new Date().toISOString(),
      processId: page.processId,
      blockCount: blocks.length,
      connectionCount: Array.isArray(data.connections) ? data.connections.length : Object.keys(data.connections || {}).length,
      sectionCount: Array.isArray(data.sections) ? data.sections.length : Object.keys(data.sections || {}).length,
      coords,
    };
  }

  function saveBaseline(snapshot, reason) {
    const item = { ...snapshot, reason, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    const history = readJson(BASELINES_KEY, []);
    history.unshift(item);
    history.splice(CONFIG.baselineHistoryLimit);
    if (!writeJson(BASELINES_KEY, history)) return null;
    updatePanel();
    return item;
  }

  function latestBaseline() { return readJson(BASELINES_KEY, [])[0] || null; }
  function latestMove() { return readJson(MOVES_KEY, [])[0] || null; }

  async function ensureBaseline() {
    const existing = latestBaseline();
    if (existing) { updatePanel(); return existing; }
    setStatus('Создаю постоянную точку восстановления…', 'loading');
    const snapshot = await fetchServerSnapshot();
    const saved = saveBaseline(snapshot, 'auto-first-load');
    setStatus(`Точка восстановления создана: ${snapshot.blockCount} блоков.`, 'success');
    return saved;
  }

  async function createBaseline() {
    setStatus('Считываю текущие серверные координаты…', 'loading');
    const snapshot = await fetchServerSnapshot();
    saveBaseline(snapshot, 'manual');
    state.baselinePreview = null;
    updatePanel();
    setStatus(`Новая точка восстановления: ${snapshot.blockCount} блоков.`, 'success');
  }

  function diffSnapshot(base, current) {
    const moved = [], missing = [], added = [];
    Object.entries(base?.coords || {}).forEach(([id, before]) => {
      const after = current?.coords?.[id];
      if (!after) { missing.push(id); return; }
      if (Math.abs(after.left-before.left) > .01 || Math.abs(after.top-before.top) > .01) {
        moved.push({ id, before, after });
      }
    });
    Object.keys(current?.coords || {}).forEach(id => {
      if (!base?.coords?.[id]) added.push(id);
    });
    return { moved, missing, added };
  }

  async function auditBaseline() {
    const baseline = latestBaseline();
    if (!baseline) { await createBaseline(); return null; }
    setStatus('Проверяю координаты относительно точки восстановления…', 'loading');
    const current = await fetchServerSnapshot();
    const diff = diffSnapshot(baseline, current);
    state.baselinePreview = { baseline, current, diff };
    updatePanel();
    setStatus(
      diff.moved.length || diff.missing.length
        ? `От baseline отличаются ${diff.moved.length} блоков; исчезло ${diff.missing.length}; новых ${diff.added.length}.`
        : `Координаты ${baseline.blockCount} исходных блоков совпадают с baseline. Новых: ${diff.added.length}.`,
      diff.moved.length || diff.missing.length ? 'warning' : 'success'
    );
    console.info('[DAZY Safety Guard] Baseline audit', state.baselinePreview);
    return state.baselinePreview;
  }

  async function postCoords(blocks) {
    return ajaxPromise({
      url: '/pl/tasks/mission/move-scripts', type: 'POST', dataType: 'json', data: { blocks },
    });
  }

  async function restoreBaseline() {
    const preview = state.baselinePreview || await auditBaseline();
    if (!preview?.diff?.moved?.length) {
      setStatus('Восстанавливать нечего: изменённых координат нет.', 'success');
      return;
    }
    // Перед восстановлением сохраняем текущее состояние, чтобы восстановление тоже можно было отменить.
    const currentBlocks = preview.diff.moved.map(item => ({
      id: item.id, left: item.after.left, top: item.after.top, sectionId: item.after.sectionId ?? null,
    }));
    const history = readJson(MOVES_KEY, []);
    history.unshift({
      id: `${Date.now()}-pre-restore`, createdAt: new Date().toISOString(), processId: page.processId,
      reason: 'before-baseline-restore', blocks: currentBlocks,
    });
    history.splice(CONFIG.moveHistoryLimit);
    if (!writeJson(MOVES_KEY, history)) {
      setStatus('Откат заблокирован: не удалось сохранить страховочную копию.', 'error');
      return;
    }
    const payload = {};
    preview.diff.moved.forEach(item => {
      payload[item.id] = {
        coord: { left: item.before.left, top: item.before.top },
        sectionId: item.before.sectionId ?? null,
      };
    });
    setStatus(`Восстанавливаю ${Object.keys(payload).length} блоков…`, 'loading');
    await postCoords(payload);
    state.baselinePreview = null;
    setStatus(`Восстановлено координат: ${Object.keys(payload).length}. Обнови/синхронизируй схему.`, 'success');
    updatePanel();
  }

  async function previewLatestMoveRestore() {
    const snapshot = latestMove();
    if (!snapshot) { setStatus('История массовых перемещений пуста.', 'normal'); return; }
    setStatus('Проверяю последнее сохранённое перемещение…', 'loading');
    const current = await fetchServerSnapshot();
    const changed = [], missing = [];
    snapshot.blocks.forEach(before => {
      const after = current.coords[before.id];
      if (!after) { missing.push(before.id); return; }
      if (Math.abs(after.left-before.left) > .01 || Math.abs(after.top-before.top) > .01) {
        changed.push({ id: before.id, before, after });
      }
    });
    state.movePreview = { snapshot, current, changed, missing };
    updatePanel();
    setStatus(`Последний snapshot: изменено ${changed.length}/${snapshot.blocks.length}; отсутствует ${missing.length}.`, changed.length ? 'warning' : 'success');
  }

  async function restoreLatestMove() {
    const preview = state.movePreview || (await previewLatestMoveRestore(), state.movePreview);
    if (!preview?.changed?.length) { setStatus('По последнему snapshot восстанавливать нечего.', 'success'); return; }
    const payload = {};
    preview.changed.forEach(item => {
      payload[item.id] = {
        coord: { left: item.before.left, top: item.before.top },
        sectionId: item.before.sectionId ?? null,
      };
    });
    setStatus(`Откатываю ${Object.keys(payload).length} блоков…`, 'loading');
    await postCoords(payload);
    state.movePreview = null;
    setStatus(`Последнее массовое перемещение восстановлено: ${Object.keys(payload).length} блоков.`, 'success');
    updatePanel();
  }

  function setStatus(message, tone='normal') {
    if (!state.statusEl) return;
    state.statusEl.textContent = message;
    state.statusEl.dataset.tone = tone;
  }

  function flashBlocked(ids) {
    const els = ids.map(id => document.getElementById(`fwb${id}`)).filter(Boolean);
    els.forEach(el => el.classList.add('dazy-sg-blocked'));
    setTimeout(() => els.forEach(el => el.classList.remove('dazy-sg-blocked')), 1500);
    document.getElementById('dazy-sg-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'dazy-sg-toast';
    toast.textContent = `SAFE: выбрано ${ids.length} блоков. Лимит без отдельного разрешения — ${CONFIG.massMoveLimit}.`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  function blockEvent(event) {
    try { event.preventDefault(); } catch (_) {}
    try { event.stopPropagation(); } catch (_) {}
    try { event.stopImmediatePropagation?.(); } catch (_) {}
  }

  function permitMatches(ids) {
    if (!state.permit) return false;
    if (Date.now() > state.permit.expiresAt) { state.permit = null; updatePanel(); return false; }
    return idsEqual(ids, state.permit.ids);
  }

  function allowPendingMassMove() {
    const ids = [...state.pendingMassIds];
    if (ids.length <= CONFIG.massMoveLimit) {
      setStatus('Сейчас нет заблокированной большой группы.', 'normal');
      return;
    }
    state.permit = { ids, expiresAt: Date.now() + CONFIG.permitTtlMs };
    updatePanel();
    setStatus(`Разрешено одно перемещение группы из ${ids.length} блоков на ${Math.round(CONFIG.permitTtlMs/1000)} сек.`, 'warning');
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || event.shiftKey) return;
    if (event.target.closest?.('button,a,input,textarea,select,.jtk-endpoint,._jsPlumb_endpoint')) return;
    const block = event.target.closest?.('#flowchart .flowchart-block');
    if (!block || block.classList.contains('start-flowchart-block')) return;

    const selected = getSelectedIds();
    const clickedId = getBlockId(block);
    const groupIds = selected.includes(clickedId) && selected.length ? selected : [clickedId];
    if (groupIds.length <= CONFIG.massMoveLimit) return;

    if (permitMatches(groupIds)) {
      const snapshot = captureSelectedSnapshot(groupIds, 'before-one-time-mass-move');
      if (!snapshot) {
        blockEvent(event);
        setStatus('Перемещение заблокировано: snapshot не сохранился.', 'error');
        return;
      }
      state.permit = null;
      state.pendingMassIds = [];
      updatePanel();
      setStatus(`Страховочный snapshot сохранён. Разрешено перемещение ${groupIds.length} блоков.`, 'success');
      return;
    }

    state.pendingMassIds = [...groupIds];
    state.permit = null;
    flashBlocked(groupIds);
    updatePanel();
    setStatus(`Массовое перемещение заблокировано: ${groupIds.length} блоков.`, 'error');
    blockEvent(event);
  }

  function fmtDate(value) {
    try { return new Date(value).toLocaleString('ru-RU'); } catch (_) { return String(value || ''); }
  }

  function updatePanel() {
    if (!state.panel) return;
    const baseline = latestBaseline();
    const move = latestMove();
    if (state.baselineEl) {
      state.baselineEl.textContent = baseline
        ? `Baseline: ${baseline.blockCount} блоков · ${fmtDate(baseline.capturedAt)}`
        : 'Baseline ещё не создан.';
    }
    if (state.permitBtn) {
      const pending = state.pendingMassIds.length;
      const validPermit = state.permit && Date.now() <= state.permit.expiresAt;
      state.permitBtn.hidden = !(pending > CONFIG.massMoveLimit || validPermit);
      state.permitBtn.textContent = validPermit
        ? `Разрешение активно: ${state.permit.ids.length} блоков`
        : `Разрешить 1 перенос: ${pending} блоков`;
      state.permitBtn.disabled = Boolean(validPermit);
    }
    if (state.restoreBaselineBtn) {
      const n = state.baselinePreview?.diff?.moved?.length || 0;
      state.restoreBaselineBtn.hidden = n < 1;
      state.restoreBaselineBtn.textContent = `Восстановить baseline: ${n} блоков`;
    }
    if (state.restoreMoveBtn) {
      const n = state.movePreview?.changed?.length || 0;
      state.restoreMoveBtn.hidden = n < 1;
      state.restoreMoveBtn.textContent = `Откатить последний перенос: ${n} блоков`;
    }
    const hist = state.panel.querySelector('[data-role="history"]');
    if (hist) hist.textContent = move
      ? `Последний snapshot: ${move.blocks.length} блоков · ${fmtDate(move.createdAt)}`
      : 'Snapshot массовых переносов пока нет.';
  }

  function installStyles() {
    const style = document.createElement('style');
    style.id = 'dazy-gc-safety-guard-styles';
    style.textContent = `
      #dazy-gc-safety-guard{position:fixed;left:18px;top:110px;z-index:2147483645;width:330px;padding:12px;border-radius:14px;background:#202326;color:#fff;font:12px/1.4 Arial,sans-serif;box-shadow:0 12px 38px rgba(0,0,0,.34)}
      #dazy-gc-safety-guard *{box-sizing:border-box} #dazy-gc-safety-guard .head{display:flex;justify-content:space-between;gap:8px;align-items:center;font-weight:700;margin-bottom:8px}
      #dazy-gc-safety-guard .head button{width:30px;padding:4px} #dazy-gc-safety-guard button{width:100%;margin-top:6px;padding:7px 9px;border:1px solid rgba(255,255,255,.15);border-radius:7px;background:#34445c;color:#fff;cursor:pointer;font-weight:700}
      #dazy-gc-safety-guard button:hover{filter:brightness(1.08)} #dazy-gc-safety-guard button[hidden]{display:none} #dazy-gc-safety-guard button:disabled{opacity:.55;cursor:default}
      #dazy-gc-safety-guard .status,#dazy-gc-safety-guard .meta{padding:7px 8px;border-radius:7px;background:#17191c;margin-top:6px} #dazy-gc-safety-guard .status[data-tone="success"]{background:#17462f;color:#c9f8dd} #dazy-gc-safety-guard .status[data-tone="warning"]{background:#5a4517;color:#ffecad} #dazy-gc-safety-guard .status[data-tone="error"]{background:#642828;color:#ffd1d1} #dazy-gc-safety-guard .status[data-tone="loading"]{background:#3d315b;color:#eadcff}
      #dazy-gc-safety-guard.is-collapsed .body{display:none}
      #flowchart .flowchart-block.dazy-sg-blocked{outline:4px solid #ef4444!important;outline-offset:3px!important;box-shadow:0 0 0 7px rgba(239,68,68,.22),0 0 26px rgba(239,68,68,.4)!important;animation:dazySgPulse .38s ease-in-out 3 alternate}@keyframes dazySgPulse{from{filter:saturate(1)}to{filter:saturate(1.7) brightness(1.08)}}
      #dazy-sg-toast{position:fixed;left:50%;top:30px;transform:translateX(-50%);z-index:2147483647;max-width:min(760px,calc(100vw - 40px));padding:11px 16px;border:1px solid rgba(248,113,113,.7);border-radius:10px;background:rgba(127,29,29,.96);color:#fff;box-shadow:0 12px 38px rgba(0,0,0,.32);font:700 13px/1.35 Arial,sans-serif;text-align:center;pointer-events:none}
    `;
    document.head.appendChild(style); state.style = style;
  }

  function installPanel() {
    const panel = document.createElement('div');
    panel.id = 'dazy-gc-safety-guard';
    panel.innerHTML = `
      <div class="head"><span>DAZY Coordinate Safety · v${VERSION}</span><button data-role="collapse">−</button></div>
      <div class="body">
        <div class="meta" data-role="baseline">Baseline ещё не создан.</div>
        <div class="status" data-role="status" data-tone="normal">Защита активна. Лимит без разрешения: ${CONFIG.massMoveLimit} блоков.</div>
        <button data-role="permit" hidden>Разрешить 1 массовый перенос</button>
        <button data-role="baseline-new">Обновить точку восстановления</button>
        <button data-role="baseline-audit">Проверить координаты относительно baseline</button>
        <button data-role="baseline-restore" hidden>Восстановить baseline</button>
        <div class="meta" data-role="history">Snapshot массовых переносов пока нет.</div>
        <button data-role="move-preview">Проверить последний массовый перенос</button>
        <button data-role="move-restore" hidden>Откатить последний перенос</button>
      </div>`;
    document.body.appendChild(panel);
    state.panel = panel;
    state.statusEl = panel.querySelector('[data-role="status"]');
    state.baselineEl = panel.querySelector('[data-role="baseline"]');
    state.permitBtn = panel.querySelector('[data-role="permit"]');
    state.restoreBaselineBtn = panel.querySelector('[data-role="baseline-restore"]');
    state.restoreMoveBtn = panel.querySelector('[data-role="move-restore"]');
    panel.querySelector('[data-role="collapse"]').onclick = () => {
      state.collapsed = !state.collapsed; panel.classList.toggle('is-collapsed', state.collapsed);
      panel.querySelector('[data-role="collapse"]').textContent = state.collapsed ? '+' : '−';
      writeJson(SETTINGS_KEY, { collapsed: state.collapsed });
    };
    panel.querySelector('[data-role="permit"]').onclick = allowPendingMassMove;
    panel.querySelector('[data-role="baseline-new"]').onclick = () => void createBaseline().catch(e => setStatus(String(e?.message || e),'error'));
    panel.querySelector('[data-role="baseline-audit"]').onclick = () => void auditBaseline().catch(e => setStatus(String(e?.message || e),'error'));
    panel.querySelector('[data-role="baseline-restore"]').onclick = () => void restoreBaseline().catch(e => setStatus(String(e?.message || e),'error'));
    panel.querySelector('[data-role="move-preview"]').onclick = () => void previewLatestMoveRestore().catch(e => setStatus(String(e?.message || e),'error'));
    panel.querySelector('[data-role="move-restore"]').onclick = () => void restoreLatestMove().catch(e => setStatus(String(e?.message || e),'error'));
    const settings = readJson(SETTINGS_KEY, {}); state.collapsed = Boolean(settings.collapsed);
    panel.classList.toggle('is-collapsed', state.collapsed);
    panel.querySelector('[data-role="collapse"]').textContent = state.collapsed ? '+' : '−';
    updatePanel();
  }

  function destroy() {
    if (state.destroyed) return; state.destroyed = true;
    state.handlers.forEach(({type,fn,opts}) => document.removeEventListener(type,fn,opts));
    state.handlers = [];
    state.panel?.remove(); state.style?.remove(); document.getElementById('dazy-sg-toast')?.remove();
    document.querySelectorAll('.dazy-sg-blocked').forEach(el => el.classList.remove('dazy-sg-blocked'));
    try { delete window[TOOL_KEY]; } catch (_) { window[TOOL_KEY] = null; }
  }

  function addDoc(type, fn, opts) { document.addEventListener(type,fn,opts); state.handlers.push({type,fn,opts}); }

  installStyles(); installPanel(); addDoc('pointerdown', handlePointerDown, true);
  window[TOOL_KEY] = {
    version: VERSION, config: CONFIG,
    createBaseline, auditBaseline, restoreBaseline,
    previewLatestMoveRestore, restoreLatestMove,
    allowPendingMassMove,
    getBaseline: latestBaseline,
    getMoveHistory: () => readJson(MOVES_KEY, []),
    getPermit: () => state.permit ? { ...state.permit } : null,
    destroy,
  };
  void ensureBaseline().catch(error => setStatus(`Baseline не создан: ${String(error?.message || error)}`, 'error'));
  console.info(`[DAZY Safety Guard v${VERSION}] запущен`, { processId: page.processId, massMoveLimit: CONFIG.massMoveLimit });
})();
