/*
 * DAZY — GC Process Fast Editor v1.4.0 BETA
 *
 * Назначение:
 * 1) Отключает автоматическую live-проверку условий в модальном окне блока.
 *    Проверка запускается только кнопкой «Проверить сегмент».
 * 2) Показывает ВСЕ выходы блока, включая свободные «Да», «Нет» и «Выполнено».
 * 3) Создаёт связь по кликам: исходный блок → выход → целевой блок.
 * 4) Безопасно переподключает занятый выход в два серверных шага:
 *    удалить старую связь → создать новую. Если создание не удалось,
 *    старая связь автоматически восстанавливается.
 * 5) Перехватывает автоматическую полную перерисовку после сохранения блока.
 *    Существующий блок обновляется локально.
 * 6) Создаёт локальные карточки новых и скопированных блоков без немедленного
 *    flowchart-data. Полная серверная синхронизация запускается отдельной кнопкой.
 * 7) Ускоряет копирование через НАТИВНЫЙ обработчик /paste-blocks GetCourse:
 *    штатный код формирует запрос, инструмент читает created_ids и блокирует reload.
 *
 * 8) Ускоряет удаление через НАТИВНЫЙ /delete-scripts:
 *    сервер удаляет выбранные блоки, после чего инструмент точечно убирает только
 *    их карточки, endpoint'ы и связанные линии без flowchart-data.
 * 9) Перемещает и одиночный блок, и группу через лёгкий прокси-контур.
 *    Принадлежность блоков к секциям сохраняется в /move-scripts.
 * 10) Распознаёт выходы success / yes / no / error / timeout динамически.
 * 11) Для редких и неизвестных типов не строит выдуманную карточку:
 *     сохранение выполняется штатно, затем запускается безопасная синхронизация.
 * 12) Выполняет самодиагностику возможностей каждого открытого процесса.
 *
 * Важно:
 * - v1.3.0 SAFE TEST не привязан к конкретному processId или набору операций.
 * - После группового копирования оригиналы снимаются с выделения, а все новые
 *   локальные копии автоматически становятся текущей выбранной группой.
 * - Копии сразу добавляются в flowchartSelectable и drag selection jsPlumb,
 *   поэтому их можно перемещать, повторно копировать или удалять без sync.
 * - Временные связи следуют за выделенной группой во время прокси-перемещения.
 * - Защита удаления и stale selection из v1.2.8 сохранена.
 * - Новые и скопированные блоки до полной синхронизации отмечаются оранжевой
 *   рамкой. Они уже существуют на сервере, но их endpoint'ы и внутренние связи
 *   окончательно подтягиваются кнопкой «Полностью синхронизировать процесс».
 */

(() => {
  'use strict';

  const TOOL_KEY = 'gcProcessFastEditorV140Beta';
  const VERSION = '1.4.0 BETA';
  const LEGACY_TOOL_KEYS = ['gcProcessFastEditorV01', 'gcProcessFastEditorV02', 'gcProcessFastEditorV03', 'gcProcessFastEditorV04', 'gcProcessFastEditorV041', 'gcProcessFastEditorV05', 'gcProcessFastEditorV06', 'gcProcessFastEditorV061', 'gcProcessFastEditorV07', 'gcProcessFastEditorV10', 'gcProcessFastEditorV11', 'gcProcessFastEditorV12', 'gcProcessFastEditorV121', 'gcProcessFastEditorV122', 'gcProcessFastEditorV123', 'gcProcessFastEditorV124', 'gcProcessFastEditorV125', 'gcProcessFastEditorV126', 'gcProcessFastEditorV127', 'gcProcessFastEditorV128', 'gcProcessFastEditorV129', 'gcProcessFastEditorV130Safe', 'gcProcessFastEditorV131Safe', 'gcProcessFastEditorV132Safe', 'gcProcessFastEditorV140Beta'];

  LEGACY_TOOL_KEYS.forEach(key => {
    if (window[key]?.destroy) {
      try {
        window[key].destroy();
      } catch (error) {
        console.warn('[GC Fast Editor] Не удалось удалить прошлый экземпляр:', key, error);
      }
    }
  });

  const SHARED_CONFIG =
    window.DAZY_PROCESS_TOOLS_CONFIG &&
    typeof window.DAZY_PROCESS_TOOLS_CONFIG === 'object'
      ? window.DAZY_PROCESS_TOOLS_CONFIG
      : {};

  function normalizeConfigIds(value, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];
    return [...new Set(
      value
        .map(item => Number(item))
        .filter(item => Number.isFinite(item) && item > 0)
    )];
  }

  const CONFIG = {
    allowedAccountIds: normalizeConfigIds(
      SHARED_CONFIG.allowedAccountIds,
      [842325, 60520]
    ),
    allowedUserIds: normalizeConfigIds(
      SHARED_CONFIG.allowedUserIds,
      [427328640, 425987389, 355017780]
    ),
    allowedProcessIds: (Array.isArray(SHARED_CONFIG.allowedProcessIds)
      ? SHARED_CONFIG.allowedProcessIds
      : [])
      .map(String)
      .filter(Boolean),
    allowAnyAccount: SHARED_CONFIG.allowAnyAccount === true,
    allowAnyUser: SHARED_CONFIG.allowAnyUser === true,
    allowAnyProcess: SHARED_CONFIG.allowAnyProcess === true,
    externalMoveGuard: SHARED_CONFIG.externalMoveGuard === true,
    maxProxyMoveBlocks: Math.max(1, Number(SHARED_CONFIG.maxProxyMoveBlocks) || 16),
    referenceProfile:
      SHARED_CONFIG.referenceProfile &&
      typeof SHARED_CONFIG.referenceProfile === 'object'
        ? SHARED_CONFIG.referenceProfile
        : null,
    requestTimeoutMs: Number(SHARED_CONFIG.requestTimeoutMs) || 20000,
    oneTestTimeoutMs: Number(SHARED_CONFIG.oneTestTimeoutMs) || 20000,
    syncTimeoutMs: Number(SHARED_CONFIG.syncTimeoutMs) || 45000,
    debug: SHARED_CONFIG.debug === true,
  };

  const page = {
    pathname: location.pathname,
    processId: new URLSearchParams(location.search).get('id'),
    accountId: Number(window.accountId || window.account_id || 0),
    accountUserId: Number(window.accountUserId || window.account_user_id || 0),
  };


  const SAFE_REFERENCE_PROFILE = CONFIG.referenceProfile
    ? Object.freeze({ ...CONFIG.referenceProfile })
    : null;
  const SAFE_MAX_PROXY_MOVE_BLOCKS = CONFIG.maxProxyMoveBlocks;
  const SAFE_FAST_SAVE_KINDS = new Set(['operation', 'condition']);

  const processAllowed =
    CONFIG.allowAnyProcess ||
    (CONFIG.allowedProcessIds.length > 0 &&
      CONFIG.allowedProcessIds.includes(String(page.processId || '')));

  if (!processAllowed) {
    console.warn(
      '[GC Fast Editor] Запуск запрещён для текущего processId.',
      { processId: page.processId, allowed: CONFIG.allowedProcessIds }
    );
    return;
  }

  const SETTINGS_KEY =
    `dazyGcProcessFastEditorV140Beta:${page.accountId || 'account'}:${page.accountUserId || 'user'}:${page.processId}`;

  function readSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  const savedSettings = readSettings();

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          fastSaveEnabled: state.fastSaveEnabled,
          lightDragEnabled: state.lightDragEnabled,
          edgePanEnabled: state.edgePanEnabled,
          panelCollapsed: state.panelCollapsed,
        })
      );
    } catch (_) {}
  }

  function log(...args) {
    if (CONFIG.debug) console.log('[GC Fast Editor]', ...args);
  }

  function warn(...args) {
    console.warn('[GC Fast Editor]', ...args);
  }

  function isProcessPage() {
    return page.pathname === '/pl/tasks/mission/process' && Boolean(page.processId);
  }

  function isAllowed() {
    const accountAllowed =
      CONFIG.allowAnyAccount ||
      !page.accountId ||
      CONFIG.allowedAccountIds.includes(page.accountId);

    const userAllowed =
      CONFIG.allowAnyUser ||
      !page.accountUserId ||
      CONFIG.allowedUserIds.includes(page.accountUserId);

    return accountAllowed && userAllowed;
  }

  if (!isProcessPage()) {
    warn('Скрипт предназначен для страницы процесса GetCourse.');
    return;
  }

  if (!isAllowed()) {
    warn('Доступ к инструменту запрещён для текущего аккаунта или пользователя.', page);
    return;
  }

  if (!window.jQuery) {
    warn('jQuery не найден. Дождитесь полной загрузки страницы и повторите запуск.');
    return;
  }

  const $ = window.jQuery;

  const state = {
    destroyed: false,
    linkMode: false,
    sourceBlock: null,
    selectedOutput: null,
    pendingTarget: null,
    busy: false,
    modalObserver: null,
    originalRulePlugin: $.fn.rulePlugin,
    rulePluginPatched: false,
    guardedHosts: new Set(),
    activeRuleTest: null,
    panel: null,
    style: null,
    documentHandlers: [],

    fastSaveEnabled: false,
    localChanges: 0,
    localHistory: [],
    skipReloadBudget: 0,
    forceReload: false,
    originalLoadData: null,
    loadDataPatched: false,
    pendingModalSave: null,
    pendingResetTimer: null,
    modalSavedHandler: null,
    ajaxErrorHandler: null,
    ajaxCompleteHandler: null,
    localBlockHandlers: new Map(),
    copyBusy: false,
    originalAjax: null,
    ajaxPatched: false,
    nativePastePending: null,
    nativePasteTimer: null,
    deleteBusy: false,

    lightDragEnabled: false,
    edgePanEnabled: false,
    lightDragCandidate: null,
    lightDragActive: false,
    lightDragBlocks: [],
    lightDragStartPoint: null,
    lightDragSafetyTimer: null,
    lightDragWasSuspended: false,
    lightDragPatchedInstance: null,
    lightDragOriginalMethods: null,
    lightDragRepaintSuppressed: 0,

    panelCollapsed: Boolean(savedSettings.panelCollapsed),

    groupProxyEnabled: true,
    groupProxyCandidate: null,
    groupProxyActive: false,
    groupProxyPointerId: null,
    groupProxyStartPoint: null,
    groupProxyLastDelta: { x: 0, y: 0 },
    groupProxyPointerDelta: { x: 0, y: 0 },
    groupProxyPanTranslation: { x: 0, y: 0 },
    groupProxyPointerClient: null,
    groupProxyAutoPanFrame: null,
    groupProxyAutoPanWasActive: false,
    groupProxyBlocks: [],
    groupProxyScale: 1,
    groupProxyElement: null,
    groupProxyRaf: null,
    groupProxySafetyTimer: null,
    groupProxyWasSuspended: false,
    groupProxySaving: false,
    groupProxyNativeDragDisabled: false,
    groupProxyInterceptNative: false,
    groupProxyClickTarget: null,
    groupProxyClickModifiers: null,

    safeSyncTimer: null,
    compatibility: null,
    lastProxyFallbackReason: '',
    safetyBaseline: null,
    safetyBaselineError: '',
    deepCompatibilityBusy: false,

    sectionGuardProto: null,
    sectionGuardOriginalAddToGroup: null,
    sectionGuardPatchedAddToGroup: null,
    sectionGroupQueue: [],
    sectionGroupFlushTimer: null,

    localCopyConnections: [],
  };

  const classes = {
    bodyMode: 'dazy-gc-fast-link-mode',
    source: 'dazy-gc-fast-source',
    targetCandidate: 'dazy-gc-fast-target-candidate',
    targetPending: 'dazy-gc-fast-target-pending',
    targetConflict: 'dazy-gc-fast-target-conflict',
    rulePanel: 'dazy-gc-rule-test-panel',
    localDirty: 'dazy-gc-local-dirty',
    localUnsynced: 'dazy-gc-local-unsynced',
    bodyLiteDrag: 'dazy-gc-lite-drag-active',
    liteDragBlock: 'dazy-gc-lite-drag-block',
    bodyGroupProxy: 'dazy-gc-group-proxy-active',
    groupProxySource: 'dazy-gc-group-proxy-source',
    groupProxyElement: 'dazy-gc-group-drag-proxy',
    moveBlocked: 'dazy-gc-move-blocked',
  };

  function getFlowchartPlugin() {
    const $flowchart = $('#flowchart');
    if (!$flowchart.length) return null;

    return (
      $flowchart.data('gc-flowchartPlugin') ||
      $flowchart.data('flowchartPlugin') ||
      null
    );
  }

  function getJsPlumbInstance() {
    const plugin = getFlowchartPlugin();
    if (plugin?.instance) return plugin.instance;

    if (window.jsPlumb?.getConnections) return window.jsPlumb;
    return null;
  }

  function normalizeConnections(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;

    if (typeof value.each === 'function') {
      const result = [];
      value.each(item => result.push(item));
      return result;
    }

    if (typeof value === 'object') {
      return Object.values(value).flatMap(item => normalizeConnections(item));
    }

    return [];
  }

  function getConnections() {
    const instance = getJsPlumbInstance();
    if (!instance?.getConnections) return [];

    try {
      return normalizeConnections(instance.getConnections());
    } catch (error) {
      warn('Не удалось получить список связей:', error);
      return [];
    }
  }

  function getBlockId(blockEl) {
    if (!blockEl) return '';

    const dataId = blockEl.getAttribute('data-id') || blockEl.dataset?.id;
    if (dataId) return String(dataId);

    const match = String(blockEl.id || '').match(/fwb(\d+)/);
    return match?.[1] || '';
  }

  function getBlockTitle(blockEl) {
    if (!blockEl) return 'Неизвестный блок';

    const selectors = [
      '.flowchart-block-name',
      '.flowchart-block-title',
      '.flowchart-block__title',
      '.block-title',
      '.title',
    ];

    for (const selector of selectors) {
      const value = blockEl.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }

    return blockEl.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) || `Блок ${getBlockId(blockEl)}`;
  }

  function getConnectionSourceId(connection) {
    return String(
      connection?.sourceId ||
      connection?.source?.id ||
      connection?.endpoints?.[0]?.elementId ||
      ''
    );
  }

  function getConnectionTargetId(connection) {
    return String(
      connection?.targetId ||
      connection?.target?.id ||
      connection?.endpoints?.[1]?.elementId ||
      ''
    );
  }

  function getEndpointUuid(endpoint) {
    if (!endpoint) return '';

    const candidates = [];

    try {
      if (typeof endpoint.getUuid === 'function') candidates.push(endpoint.getUuid());
    } catch (_) {}

    try {
      if (typeof endpoint.getParameter === 'function') {
        candidates.push(endpoint.getParameter('uuid'));
        candidates.push(endpoint.getParameter('fromUuid'));
      }
    } catch (_) {}

    candidates.push(
      endpoint.uuid,
      endpoint._uuid,
      endpoint.__uuid,
      endpoint.parameters?.uuid,
      endpoint.parameters?.fromUuid,
      endpoint._jsPlumb?.uuid,
      endpoint._jsPlumb?.parameters?.uuid,
      endpoint.canvas?.dataset?.uuid,
      endpoint.canvas?.getAttribute?.('data-uuid'),
      endpoint.canvas?.getAttribute?.('data-jtk-uuid')
    );

    const value = candidates.find(item => typeof item === 'string' && item.trim());
    return value ? value.trim() : '';
  }

  function getConnectionUuid(connection) {
    const endpointUuid = getEndpointUuid(connection?.endpoints?.[0]);
    if (endpointUuid) return endpointUuid;

    const candidates = [];

    try {
      if (typeof connection?.getParameter === 'function') {
        candidates.push(connection.getParameter('fromUuid'));
        candidates.push(connection.getParameter('uuid'));
      }
    } catch (_) {}

    candidates.push(
      connection?.parameters?.fromUuid,
      connection?.parameters?.uuid,
      connection?._jsPlumb?.parameters?.fromUuid,
      connection?._jsPlumb?.parameters?.uuid
    );

    const value = candidates.find(item => typeof item === 'string' && item.trim());
    return value ? value.trim() : '';
  }

  function getOverlayValues(connection) {
    let overlays = null;

    try {
      overlays = typeof connection?.getOverlays === 'function'
        ? connection.getOverlays()
        : connection?.overlays;
    } catch (_) {}

    if (!overlays) return [];
    return Array.isArray(overlays) ? overlays : Object.values(overlays);
  }

  function getConnectionLabel(connection) {
    for (const overlay of getOverlayValues(connection)) {
      let label = '';

      try {
        if (typeof overlay?.getLabel === 'function') label = overlay.getLabel();
      } catch (_) {}

      label = label || overlay?.label || overlay?.options?.label || overlay?.getElement?.()?.textContent;
      label = String(label || '').replace(/\s+/g, ' ').trim();

      if (label && !/^arrow$/i.test(label)) return label;
    }

    const sourceEl = document.getElementById(getConnectionSourceId(connection));
    if (sourceEl?.classList.contains('operation-flowchart-block')) return 'Выполнено';
    if (sourceEl?.classList.contains('start-flowchart-block')) return 'Старт';
    return 'Выход';
  }

  function normalizeResultKey(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text === 'да' || text.includes('yes')) return 'yes';
    if (text === 'нет' || text.includes('no')) return 'no';
    if (text.includes('выполн') || text.includes('success')) return 'success';
    if (text.includes('ошиб') || text.includes('error')) return 'error';
    if (text.includes('таймаут') || text.includes('timeout')) return 'timeout';
    if (text.includes('старт') || text.includes('start')) return 'start';
    return text || 'output';
  }

  function getConnectionResultKey(connection) {
    for (const overlay of getOverlayValues(connection)) {
      const element = (() => {
        try { return overlay?.getElement?.() || overlay?.canvas || null; } catch (_) { return null; }
      })();
      const className = [
        overlay?.cssClass,
        overlay?.options?.cssClass,
        element?.className,
      ].map(value => typeof value === 'string' ? value : value?.baseVal || '').join(' ');

      if (className.includes('flowchart-connection-label--yes')) return 'yes';
      if (className.includes('flowchart-connection-label--no')) return 'no';
      if (className.includes('flowchart-connection-label--success')) return 'success';
      if (className.includes('flowchart-connection-label--error')) return 'error';
      if (className.includes('flowchart-connection-label--timeout')) return 'timeout';
    }

    const labelKey = normalizeResultKey(getConnectionLabel(connection));
    if (labelKey !== 'output') return labelKey;

    const sourceEl = document.getElementById(getConnectionSourceId(connection));
    if (sourceEl?.classList.contains('operation-flowchart-block')) return 'success';
    if (sourceEl?.classList.contains('start-flowchart-block')) return 'start';
    return labelKey;
  }

  function normalizeArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.each === 'function') {
      const result = [];
      value.each(item => result.push(item));
      return result;
    }
    if (typeof value === 'object') return Object.values(value).flatMap(normalizeArray);
    return [];
  }

  function getPluginConnectionList() {
    const value = getFlowchartPlugin()?.connections;
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
      return Object.values(value).filter(item =>
        item && typeof item === 'object' &&
        (Object.prototype.hasOwnProperty.call(item, 'uuids') ||
         Object.prototype.hasOwnProperty.call(item, 'fromUuid') ||
         Object.prototype.hasOwnProperty.call(item, 'id'))
      );
    }
    return [];
  }

  function getConnectionConfigUuid(config) {
    const uuids = Array.isArray(config?.uuids) ? config.uuids : [config?.uuids];
    return String(uuids.find(Boolean) || config?.fromUuid || '');
  }

  function getConnectionConfigTargetDomId(config) {
    const targets = Array.isArray(config?.target) ? config.target : [config?.target];
    const value = targets.find(Boolean) || config?.toBlockId || '';
    if (value instanceof Element) return value.id;
    const text = String(value || '');
    if (/^fwb\d+$/.test(text)) return text;
    if (/^\d+$/.test(text)) return `fwb${text}`;
    return text;
  }

  function findConnectionConfigByUuid(uuid) {
    return getPluginConnectionList().find(config => getConnectionConfigUuid(config) === String(uuid)) || null;
  }

  function findRuntimeConnectionByUuid(uuid) {
    return getConnections().find(connection => getConnectionUuid(connection) === String(uuid)) || null;
  }

  function getOutputLabel(resultId, blockEl) {
    const result = String(resultId || '').toLowerCase();
    if (result === 'yes') return 'Да';
    if (result === 'no') return 'Нет';
    if (result === 'error') return 'Ошибка';
    if (result === 'timeout') return 'Таймаут';
    if (result === 'success') {
      return blockEl?.classList.contains('start-flowchart-block') ? 'Старт' : 'Выполнено';
    }
    return resultId ? String(resultId) : 'Выход';
  }

  function outputSortWeight(resultId) {
    const weights = {
      start: 0,
      success: 10,
      yes: 10,
      no: 20,
      error: 30,
      timeout: 40,
    };
    return weights[String(resultId || '').toLowerCase()] ?? 50;
  }

  function getBlockOutputs(blockEl) {
    const plugin = getFlowchartPlugin();
    const blockId = getBlockId(blockEl);
    if (!plugin || !blockId) return [];

    const definitions = Object.entries(plugin.endpoints || {})
      .map(([key, definition]) => ({ key, definition: definition || {} }))
      .filter(({ definition }) => String(definition.fromBlockId || '') === String(blockId));

    return definitions.map(({ key, definition }, index) => {
      const resultId = String(
        definition.resultId ||
        definition.settings?.resultId ||
        String(key).split('-').pop() ||
        'output'
      );
      const uuid = String(definition.settings?.uuid || key || '');
      const config = findConnectionConfigByUuid(uuid);
      const runtimeConnection = findRuntimeConnectionByUuid(uuid);
      const targetDomId = config
        ? getConnectionConfigTargetDomId(config)
        : getConnectionTargetId(runtimeConnection);
      const targetEl = targetDomId ? document.getElementById(targetDomId) : null;
      const connectionId = config?.id ?? runtimeConnection?.id ?? null;

      return {
        index,
        source: blockEl,
        blockId,
        resultId,
        resultKey: normalizeResultKey(resultId),
        label: getOutputLabel(resultId, blockEl),
        uuid,
        definition,
        config,
        runtimeConnection,
        connectionId,
        currentTarget: targetEl,
        currentTargetDomId: targetDomId || '',
        occupied: Boolean(config || runtimeConnection),
      };
    }).sort((a, b) => {
      const byWeight = outputSortWeight(a.resultId) - outputSortWeight(b.resultId);
      return byWeight || a.index - b.index;
    });
  }

  function clearBlockHighlights() {
    document.querySelectorAll(`.${classes.source}, .${classes.targetCandidate}, .${classes.targetPending}, .${classes.targetConflict}`)
      .forEach(element => {
        element.classList.remove(classes.source, classes.targetCandidate, classes.targetPending, classes.targetConflict);
      });
  }

  function setLinkStatus(message, tone = 'normal') {
    if (!state.panel) return;

    const status = state.panel.querySelector('[data-role="status"]');
    if (!status) return;

    status.textContent = message;
    status.dataset.tone = tone;
  }

  function renderConnectionChoices(blockEl) {
    const list = state.panel?.querySelector('[data-role="outputs"]');
    if (!list) return;

    list.innerHTML = '';

    const outputs = getBlockOutputs(blockEl);
    if (!outputs.length) {
      list.innerHTML = '<div class="dazy-gc-fast-empty">У блока не найдены исходящие выходы.</div>';
      setLinkStatus('Выберите другой исходный блок.', 'warning');
      return;
    }

    outputs.forEach(output => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dazy-gc-fast-output';
      button.disabled = !output.uuid;

      const targetText = output.occupied
        ? `Сейчас → ${getBlockTitle(output.currentTarget)}`
        : 'Свободен — связь ещё не создана';

      button.innerHTML = `
        <span class="dazy-gc-fast-output-label">${escapeHtml(output.label)}</span>
        <span class="dazy-gc-fast-output-target" data-state="${output.occupied ? 'occupied' : 'free'}">${escapeHtml(targetText)}</span>
        ${output.uuid ? '' : '<span class="dazy-gc-fast-output-error">UUID выхода не найден</span>'}
      `;

      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        if (!output.uuid) return;

        state.selectedOutput = output;

        document.querySelectorAll('.dazy-gc-fast-output.is-selected')
          .forEach(item => item.classList.remove('is-selected'));
        button.classList.add('is-selected');

        document.querySelectorAll('.flowchart-block')
          .forEach(item => {
            if (item !== blockEl) item.classList.add(classes.targetCandidate);
          });

        setLinkStatus(
          output.occupied
            ? `Выход «${output.label}» занят. Выберите новый целевой блок для переподключения.`
            : `Свободный выход «${output.label}» выбран. Нажмите на целевой блок.`,
          'active'
        );
      });

      list.appendChild(button);
    });
  }

  function selectSourceBlock(blockEl) {
    clearBlockHighlights();
    state.sourceBlock = blockEl;
    state.selectedOutput = null;
    state.pendingTarget = null;

    blockEl.classList.add(classes.source);
    renderConnectionChoices(blockEl);
    setLinkStatus(`Исходный блок: ${getBlockTitle(blockEl)}`, 'active');
  }

  function showConfirmation(targetEl) {
    const confirmation = state.panel?.querySelector('[data-role="confirm"]');
    if (!confirmation || !state.selectedOutput) return;

    document.querySelectorAll(`.${classes.targetPending}, .${classes.targetConflict}`)
      .forEach(item => item.classList.remove(classes.targetPending, classes.targetConflict));

    const output = state.selectedOutput;
    if (targetEl === output.currentTarget) {
      state.pendingTarget = null;
      confirmation.hidden = true;
      setLinkStatus('Этот выход уже ведёт в выбранный блок.', 'warning');
      return;
    }

    state.pendingTarget = targetEl;
    targetEl.classList.add(classes.targetPending);

    const targetTitle = getBlockTitle(targetEl);
    const text = output.occupied
      ? `Переподключить «${output.label}»: «${getBlockTitle(output.currentTarget)}» → «${targetTitle}»? Старая связь будет удалена, затем создана новая.`
      : `Создать связь «${output.label}» → «${targetTitle}»?`;

    confirmation.hidden = false;
    confirmation.querySelector('[data-role="confirm-text"]').textContent = text;

    const saveButton = confirmation.querySelector('[data-role="confirm-save"]');
    if (saveButton) saveButton.textContent = output.occupied ? 'Переподключить' : 'Подключить';

    setLinkStatus(
      output.occupied
        ? 'После подтверждения выполню удаление и создание с автоматическим откатом при ошибке.'
        : 'Проверьте цель и подтвердите создание связи.',
      'warning'
    );
  }

  function hideConfirmation() {
    const confirmation = state.panel?.querySelector('[data-role="confirm"]');
    if (confirmation) confirmation.hidden = true;

    document.querySelectorAll(`.${classes.targetPending}, .${classes.targetConflict}`)
      .forEach(item => item.classList.remove(classes.targetPending, classes.targetConflict));

    state.pendingTarget = null;
  }

  function ajaxPromise(options) {
    return new Promise((resolve, reject) => {
      $.ajax({
        ...options,
        timeout: CONFIG.requestTimeoutMs,
      })
        .done((data, textStatus, jqXHR) => resolve({ data, textStatus, jqXHR }))
        .fail((jqXHR, textStatus, errorThrown) => reject({ jqXHR, textStatus, errorThrown }));
    });
  }

  function responseErrorText(value) {
    return String(
      value?.jqXHR?.responseJSON?.error ||
      value?.jqXHR?.responseJSON?.message ||
      value?.jqXHR?.responseText ||
      value?.data?.error ||
      value?.data?.message ||
      value?.message ||
      value?.errorThrown ||
      value?.textStatus ||
      value ||
      'Неизвестная ошибка'
    );
  }

  function assertSuccessfulResponse(response, actionName) {
    const data = response?.data || {};
    if (data?.success === false || data?.error) {
      throw new Error(data?.error || data?.message || `${actionName}: GetCourse вернул ошибку`);
    }
    return data;
  }

  async function createServerConnection(uuid, targetId) {
    const response = await ajaxPromise({
      url: '/pl/tasks/mission/create-connection',
      type: 'POST',
      dataType: 'json',
      data: {
        'transition[fromUuid]': uuid,
        'transition[toBlockId]': targetId,
      },
    });
    const data = assertSuccessfulResponse(response, 'Создание связи');
    const id = data?.data?.id;
    if (!id) throw new Error('GetCourse создал связь, но не вернул её ID.');
    return { id, response };
  }

  async function deleteServerConnection(connectionId) {
    if (!connectionId) throw new Error('Не найден серверный ID старой связи.');
    const response = await ajaxPromise({
      url: `/pl/tasks/mission/delete-connection?id=${encodeURIComponent(connectionId)}`,
      type: 'POST',
      dataType: 'json',
      data: {},
    });
    assertSuccessfulResponse(response, 'Удаление связи');
    return response;
  }

  function replacePluginConnection(uuid, newConfig) {
    const plugin = getFlowchartPlugin();
    if (!plugin) return;

    const list = getPluginConnectionList().filter(item => getConnectionConfigUuid(item) !== String(uuid));
    if (newConfig) list.push(newConfig);
    plugin.connections = list;
  }

  function makePluginConnectionConfig(id, uuid, targetEl) {
    return {
      id: Number(id) || id,
      uuids: [String(uuid)],
      target: [targetEl.id],
      editable: true,
    };
  }

  function runJsPlumbWithoutServer(callback) {
    const plugin = getFlowchartPlugin();
    const instance = getJsPlumbInstance();
    if (!plugin || !instance) throw new Error('Не найден flowchartPlugin или экземпляр jsPlumb.');

    const wasInitialized = plugin.initialized;
    const execute = () => {
      plugin.initialized = false;
      try { return callback(instance, plugin); }
      finally { plugin.initialized = wasInitialized; }
    };

    if (typeof instance.batch === 'function') return instance.batch(execute);
    return execute();
  }

  function connectLocally(output, targetEl, serverId) {
    let created = null;

    runJsPlumbWithoutServer((instance, plugin) => {
      const currentRuntime = findRuntimeConnectionByUuid(output.uuid);
      if (currentRuntime && typeof instance.deleteConnection === 'function') {
        instance.deleteConnection(currentRuntime);
      }

      const params = {
        uuids: [output.uuid],
        target: [targetEl.id],
        editable: true,
      };

      created = instance.connect(params);
      if (!created) throw new Error('jsPlumb не создал локальную линию.');

      created.id = Number(serverId) || serverId;
      created.saved = true;

      if (typeof instance.repaint === 'function') {
        instance.repaint(output.source);
        if (output.currentTarget) instance.repaint(output.currentTarget);
        instance.repaint(targetEl);
      }
    });

    return created;
  }

  function emergencyReload(reason) {
    warn('Выполняется аварийная синхронизация схемы:', reason);
    try {
      fullSync(reason || 'аварийная синхронизация');
      return true;
    } catch (error) {
      warn('Не удалось перезагрузить схему:', error);
    }
    return false;
  }

  async function applySelectedOutput() {
    if (state.busy || !state.selectedOutput || !state.pendingTarget) return;

    const output = state.selectedOutput;
    const targetEl = state.pendingTarget;
    const targetId = getBlockId(targetEl);
    const sourceId = getBlockId(output.source);

    if (!targetId) {
      setLinkStatus('Не удалось определить ID целевого блока.', 'error');
      return;
    }

    if (sourceId === targetId) {
      setLinkStatus('В быстром режиме нельзя направить выход блока в него самого.', 'error');
      return;
    }

    if (output.occupied && !output.connectionId) {
      setLinkStatus('У старой связи не найден серверный ID. Переподключение остановлено.', 'error');
      return;
    }

    const oldTarget = output.currentTarget;
    const oldTargetId = getBlockId(oldTarget);
    const oldConnectionId = output.connectionId;
    let oldDeleted = false;
    let newConnection = null;

    state.busy = true;
    setPanelDisabled(true);

    try {
      if (output.occupied) {
        setLinkStatus(`Шаг 1/2: разрываю старую связь «${output.label}»…`, 'loading');
        await deleteServerConnection(oldConnectionId);
        oldDeleted = true;
      }

      setLinkStatus(
        output.occupied
          ? `Шаг 2/2: создаю связь с «${getBlockTitle(targetEl)}»…`
          : `Создаю связь «${output.label}» с «${getBlockTitle(targetEl)}»…`,
        'loading'
      );

      newConnection = await createServerConnection(output.uuid, targetId);

      const newConfig = makePluginConnectionConfig(newConnection.id, output.uuid, targetEl);
      replacePluginConnection(output.uuid, newConfig);

      let localUpdated = true;
      try {
        connectLocally(output, targetEl, newConnection.id);
      } catch (localError) {
        localUpdated = false;
        warn('Серверная связь сохранена, но локальная линия не обновилась:', localError);
        emergencyReload(localError);
      }

      const source = output.source;
      hideConfirmation();
      clearBlockHighlights();
      source.classList.add(classes.source);
      state.selectedOutput = null;
      renderConnectionChoices(source);

      setLinkStatus(
        localUpdated
          ? `${output.occupied ? 'Переподключено' : 'Подключено'}: «${output.label}» → «${getBlockTitle(targetEl)}».`
          : 'Связь сохранена. Схема синхронизируется штатной перезагрузкой.',
        localUpdated ? 'success' : 'warning'
      );
    } catch (error) {
      const originalError = responseErrorText(error);
      warn('Ошибка изменения связи:', error);

      if (oldDeleted && output.occupied && oldTargetId) {
        setLinkStatus('Новая связь не создалась. Восстанавливаю старую…', 'loading');

        try {
          const rollback = await createServerConnection(output.uuid, oldTargetId);
          const rollbackConfig = makePluginConnectionConfig(rollback.id, output.uuid, oldTarget);
          replacePluginConnection(output.uuid, rollbackConfig);

          output.connectionId = rollback.id;
          output.config = rollbackConfig;
          output.occupied = true;

          setLinkStatus(
            `Переподключение отменено: ${originalError.slice(0, 190)} Старая связь восстановлена.`,
            'error'
          );
        } catch (rollbackError) {
          const rollbackText = responseErrorText(rollbackError);
          replacePluginConnection(output.uuid, null);
          emergencyReload(rollbackError);
          setLinkStatus(
            `Критическая ошибка: новая связь не создана и старую восстановить не удалось. ` +
            `${originalError.slice(0, 120)} / откат: ${rollbackText.slice(0, 120)}. Схема перезагружается.`,
            'error'
          );
        }
      } else {
        setLinkStatus(`Связь не создана: ${originalError.slice(0, 260)}`, 'error');
      }
    } finally {
      state.busy = false;
      setPanelDisabled(false);
    }
  }

  function setPanelDisabled(disabled) {
    if (!state.panel) return;
    state.panel.querySelectorAll('button').forEach(button => {
      if (button.dataset.role !== 'mode') button.disabled = disabled;
    });
  }

  function resetLinkSelection() {
    state.sourceBlock = null;
    state.selectedOutput = null;
    state.pendingTarget = null;
    clearBlockHighlights();
    hideConfirmation();

    const list = state.panel?.querySelector('[data-role="outputs"]');
    if (list) list.innerHTML = '';

    if (state.linkMode) {
      setLinkStatus('Нажмите на исходный блок.', 'normal');
    }
  }

  function setLinkMode(enabled) {
    state.linkMode = Boolean(enabled);
    document.body.classList.toggle(classes.bodyMode, state.linkMode);

    const modeButton = state.panel?.querySelector('[data-role="mode"]');
    if (modeButton) {
      modeButton.classList.toggle('is-active', state.linkMode);
      modeButton.textContent = state.linkMode ? 'Выключить быстрые связи' : 'Включить быстрые связи';
    }

    resetLinkSelection();

    if (!state.linkMode) {
      setLinkStatus('Быстрые связи выключены.', 'normal');
    }
  }

  function handleBlockPointer(event) {
    if (!state.linkMode || state.busy) return;

    const blockEl = event.target.closest?.('.flowchart-block');
    if (!blockEl) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function handleBlockClick(event) {
    if (!state.linkMode || state.busy) return;

    const blockEl = event.target.closest?.('.flowchart-block');
    if (!blockEl) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    if (!state.sourceBlock || !state.selectedOutput) {
      selectSourceBlock(blockEl);
      return;
    }

    if (blockEl === state.sourceBlock) {
      selectSourceBlock(blockEl);
      return;
    }

    hideConfirmation();
    showConfirmation(blockEl);
  }

  // ---------------------------------------------------------------------------
  // Универсальные типы блоков и принадлежность к секциям
  // ---------------------------------------------------------------------------

  const BLOCK_KIND_CLASS_MAP = {
    start: 'start-flowchart-block',
    operation: 'operation-flowchart-block',
    condition: 'condition-flowchart-block',
    question: 'question-flowchart-block',
    callbackOperation: 'callbackOperation-flowchart-block',
    delayed: 'delayed-flowchart-block',
    waitCondition: 'waitCondition-flowchart-block',
    currentTime: 'currentTime-flowchart-block',
    proxy: 'proxy-flowchart-block',
    note: 'note-flowchart-block',
    finish: 'finish-flowchart-block',
    subtask: 'subtask-flowchart-block',
    voiceMessage: 'voiceMessage-flowchart-block',
  };

  const SPECIAL_KIND_ALIASES = {
    callbackoperation: 'callbackOperation',
    delayed: 'delayed',
    waitcondition: 'waitCondition',
    currenttime: 'currentTime',
    proxy: 'proxy',
    note: 'note',
    finish: 'finish',
    subtask: 'subtask',
    voicemessage: 'voiceMessage',
    question: 'question',
    condition: 'condition',
    operation: 'operation',
    start: 'start',
  };

  const SAFE_STANDALONE_PLACEHOLDER_KINDS = new Set([
    'operation',
    'condition',
    'question',
  ]);

  const SAFE_FAST_COPY_KINDS = new Set([
    'operation',
    'condition',
    'question',
    'proxy',
  ]);

  function normalizeBlockKind(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const withoutClass = raw
      .replace(/\s+/g, ' ')
      .split(' ')
      .find(item => /-flowchart-block$/i.test(item)) || raw;

    const stripped = withoutClass
      .replace(/-flowchart-block$/i, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();

    return SPECIAL_KIND_ALIASES[stripped] || '';
  }

  function getBlockKindFromElement(blockEl) {
    if (!blockEl) return '';

    if (
      blockEl.classList.contains('flowchart-section') ||
      blockEl.classList.contains('group-container')
    ) {
      return 'section';
    }

    for (const className of blockEl.classList) {
      const kind = normalizeBlockKind(className);
      if (kind) return kind;
    }

    return '';
  }

  function getBlockCssClass(kind, sourceBlock = null) {
    if (sourceBlock) {
      const sourceClass = [...sourceBlock.classList]
        .find(className => /-flowchart-block$/i.test(className));
      if (sourceClass) return sourceClass;
    }

    return BLOCK_KIND_CLASS_MAP[kind] || '';
  }

  function inferBlockKind({
    sourceBlock = null,
    scriptType = '',
    blockType = '',
    operationType = '',
  } = {}) {
    const sourceKind = getBlockKindFromElement(sourceBlock);
    if (sourceKind) return sourceKind;

    const specialOperationKind = normalizeBlockKind(operationType);
    if (
      specialOperationKind &&
      specialOperationKind !== 'operation'
    ) {
      return specialOperationKind;
    }

    return (
      normalizeBlockKind(blockType) ||
      normalizeBlockKind(scriptType) ||
      'operation'
    );
  }

  function isSectionBlock(blockEl) {
    return Boolean(
      blockEl?.classList?.contains('flowchart-section') ||
      blockEl?.classList?.contains('group-container') ||
      blockEl?.matches?.('[data-section-id].flowchart-block')
    );
  }

  function normalizeNumericId(value) {
    if (value == null || value === '') return '';

    if (value instanceof Element) {
      return normalizeNumericId(
        value.dataset?.sectionId ||
        value.dataset?.id ||
        value.getAttribute?.('data-section-id') ||
        value.getAttribute?.('data-id') ||
        value.id
      );
    }

    if (typeof value === 'object') {
      return normalizeNumericId(
        value.sectionId ??
        value.groupId ??
        value.id ??
        value.el ??
        value.element
      );
    }

    const text = String(value).trim();
    if (!text) return '';

    const direct = text.match(/^\d+$/)?.[0];
    if (direct) return direct;

    return text.match(/(\d{4,})/)?.[1] || '';
  }

  function referenceMatchesBlock(value, blockId) {
    const expected = String(blockId || '');
    if (!expected || value == null) return false;

    if (value instanceof Element) {
      return String(getBlockId(value) || '') === expected;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).replace(/^fwb/, '');
      return normalized === expected;
    }

    if (typeof value === 'object') {
      return [
        value.blockId,
        value.scriptId,
        value.id,
        value.elementId,
        value.el,
        value.element,
      ].some(item => referenceMatchesBlock(item, expected));
    }

    return false;
  }

  function collectionContainsBlock(value, blockId, depth = 5, seen = new WeakSet()) {
    if (depth < 0 || value == null) return false;

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value instanceof Element
    ) {
      return referenceMatchesBlock(value, blockId);
    }

    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (referenceMatchesBlock(value, blockId)) return true;

    if (Array.isArray(value)) {
      return value.some(item =>
        collectionContainsBlock(item, blockId, depth - 1, seen)
      );
    }

    const preferredKeys = [
      'blocks',
      'blockIds',
      'scripts',
      'scriptIds',
      'children',
      'items',
      'members',
      'elements',
    ];

    for (const key of preferredKeys) {
      if (
        Object.prototype.hasOwnProperty.call(value, key) &&
        collectionContainsBlock(value[key], blockId, depth - 1, seen)
      ) {
        return true;
      }
    }

    return false;
  }

  function findSectionIdInMapping(mapping, blockId, depth = 6, seen = new WeakSet()) {
    if (depth < 0 || mapping == null) return '';

    if (typeof mapping !== 'object') return '';
    if (seen.has(mapping)) return '';
    seen.add(mapping);

    if (!Array.isArray(mapping)) {
      const direct = mapping[blockId] ?? mapping[`fwb${blockId}`];
      if (
        typeof direct === 'string' ||
        typeof direct === 'number' ||
        direct instanceof Element
      ) {
        const directId = normalizeNumericId(direct);
        if (directId && directId !== String(blockId)) return directId;
      }

      if (
        referenceMatchesBlock(
          mapping.blockId ?? mapping.scriptId ?? mapping.elementId,
          blockId
        )
      ) {
        const ownSectionId = normalizeNumericId(
          mapping.sectionId ??
          mapping.groupId ??
          mapping.parentId ??
          mapping.section
        );
        if (ownSectionId) return ownSectionId;
      }

      const ownSectionId = normalizeNumericId(
        mapping.sectionId ??
        mapping.groupId ??
        mapping.parentId
      );

      const memberSource =
        mapping.blocks ??
        mapping.blockIds ??
        mapping.scripts ??
        mapping.scriptIds ??
        mapping.children ??
        mapping.items ??
        mapping.members ??
        mapping.elements;

      if (
        ownSectionId &&
        memberSource != null &&
        collectionContainsBlock(memberSource, blockId)
      ) {
        return ownSectionId;
      }

      for (const [key, value] of Object.entries(mapping)) {
        const keyId = normalizeNumericId(key);

        if (
          keyId &&
          keyId !== String(blockId) &&
          collectionContainsBlock(value, blockId)
        ) {
          return keyId;
        }

        const nested = findSectionIdInMapping(
          value,
          blockId,
          depth - 1,
          seen
        );
        if (nested) return nested;
      }

      return '';
    }

    for (const item of mapping) {
      const nested = findSectionIdInMapping(item, blockId, depth - 1, seen);
      if (nested) return nested;
    }

    return '';
  }

  function getSectionElements() {
    return [...document.querySelectorAll(
      '#flowchart .flowchart-block.flowchart-section, ' +
      '#flowchart .flowchart-block.group-container'
    )];
  }

  function getKnownSectionIds() {
    return new Set(
      getSectionElements()
        .map(section => normalizeNumericId(
          section.dataset?.sectionId ||
          section.dataset?.id ||
          section.getAttribute?.('data-section-id') ||
          section.getAttribute?.('data-id') ||
          section.id
        ))
        .filter(Boolean)
    );
  }

  function isKnownSectionId(value, knownIds = getKnownSectionIds()) {
    const id = normalizeNumericId(value);
    return Boolean(id && knownIds.has(id));
  }

  function findMembershipInKnownSections(
    mapping,
    blockId,
    knownIds = getKnownSectionIds(),
    depth = 7,
    seen = new WeakSet()
  ) {
    if (depth < 0 || mapping == null || typeof mapping !== 'object') return '';
    if (seen.has(mapping)) return '';
    seen.add(mapping);

    if (!Array.isArray(mapping)) {
      const direct = mapping[blockId] ?? mapping[`fwb${blockId}`];
      const directId = normalizeNumericId(direct);
      if (directId && knownIds.has(directId)) return directId;

      const ownId = normalizeNumericId(
        mapping.sectionId ??
        mapping.groupId ??
        mapping.id ??
        mapping.section
      );

      const memberSource =
        mapping.blocks ??
        mapping.blockIds ??
        mapping.scripts ??
        mapping.scriptIds ??
        mapping.children ??
        mapping.items ??
        mapping.members ??
        mapping.elements;

      if (
        ownId &&
        knownIds.has(ownId) &&
        memberSource != null &&
        collectionContainsBlock(memberSource, blockId)
      ) {
        return ownId;
      }

      for (const [key, value] of Object.entries(mapping)) {
        const keyId = normalizeNumericId(key);

        if (
          keyId &&
          knownIds.has(keyId) &&
          collectionContainsBlock(value, blockId)
        ) {
          return keyId;
        }

        const nested = findMembershipInKnownSections(
          value,
          blockId,
          knownIds,
          depth - 1,
          seen
        );
        if (nested) return nested;
      }

      return '';
    }

    for (const item of mapping) {
      const nested = findMembershipInKnownSections(
        item,
        blockId,
        knownIds,
        depth - 1,
        seen
      );
      if (nested) return nested;
    }

    return '';
  }

  function findDomSectionContainer(blockEl) {
    let node = blockEl?.parentElement || null;

    while (node && node !== document.body) {
      if (
        node.matches?.(
          '.flowchart-section, .group-container, ' +
          '[data-section-id], [data-group-id]'
        )
      ) {
        return node;
      }
      node = node.parentElement;
    }

    return null;
  }

  function getJsPlumbGroupForBlock(blockEl) {
    const instance = getJsPlumbInstance();
    const manager = instance?._groupManager;
    const candidates = [];

    const calls = [
      () => instance?.getGroupFor?.(blockEl),
      () => instance?.getGroupFor?.(blockEl?.id),
      () => manager?.getGroupFor?.(blockEl),
      () => manager?.getGroupFor?.(blockEl?.id),
      () => manager?.getGroup?.(blockEl),
      () => manager?.getGroup?.(blockEl?.id),
    ];

    calls.forEach(call => {
      try {
        const value = call();
        if (value) candidates.push(value);
      } catch (_) {}
    });

    return candidates.find(Boolean) || null;
  }

  function resolveBlockSectionContext(blockEl) {
    const blockId = getBlockId(blockEl);
    const plugin = getFlowchartPlugin();
    const blockData = findPluginBlockData(blockId);
    const knownIds = getKnownSectionIds();

    const directId = normalizeNumericId(blockData?.sectionId);
    if (directId && knownIds.has(directId)) {
      return {
        sectionId: directId,
        insideSection: true,
        resolved: true,
        source: 'plugin.blocks.sectionId',
      };
    }

    const mappingId =
      findMembershipInKnownSections(
        plugin?.blocksInSections,
        blockId,
        knownIds
      ) ||
      findMembershipInKnownSections(
        plugin?.sections,
        blockId,
        knownIds
      );

    if (mappingId) {
      return {
        sectionId: mappingId,
        insideSection: true,
        resolved: true,
        source: 'plugin.section-mapping',
      };
    }

    const domContainer = findDomSectionContainer(blockEl);
    if (domContainer) {
      const domId = normalizeNumericId(
        domContainer.dataset?.sectionId ||
        domContainer.dataset?.groupId ||
        domContainer.dataset?.id ||
        domContainer.getAttribute?.('data-section-id') ||
        domContainer.getAttribute?.('data-group-id') ||
        domContainer.getAttribute?.('data-id') ||
        domContainer.id
      );

      if (domId && knownIds.has(domId)) {
        return {
          sectionId: domId,
          insideSection: true,
          resolved: true,
          source: 'dom',
        };
      }
    }

    const group = getJsPlumbGroupForBlock(blockEl);
    if (group) {
      const groupId = normalizeNumericId(
        group.id ||
        group.groupId ||
        group.el ||
        group.element ||
        group
      );

      if (groupId && knownIds.has(groupId)) {
        return {
          sectionId: groupId,
          insideSection: true,
          resolved: true,
          source: 'jsPlumb-group',
        };
      }
    }

    return {
      sectionId: null,
      insideSection: false,
      resolved: true,
      source: 'none',
    };
  }

  function assessProxySelection(blocks) {
    if (!blocks.length) {
      return { ok: false, reason: 'Блоки для перемещения не найдены.', contexts: [] };
    }

    if (blocks.some(isSectionBlock)) {
      return {
        ok: false,
        reason: 'Секции перемещаются штатным механизмом GetCourse.',
        contexts: [],
      };
    }

    const contexts = blocks.map(resolveBlockSectionContext);
    const unresolvedSectionIndex = contexts.findIndex(
      context => context.insideSection && !context.resolved
    );

    if (unresolvedSectionIndex >= 0) {
      return {
        ok: false,
        reason:
          'Не удалось надёжно определить ID секции одного из блоков. ' +
          'Используется штатное перемещение GetCourse.',
        contexts,
      };
    }

    return { ok: true, reason: '', contexts };
  }

  function canCloneBlockLocally(sourceBlock) {
    return Boolean(sourceBlock && !isSectionBlock(sourceBlock));
  }

  function canCreateStandalonePlaceholder(kind) {
    return SAFE_STANDALONE_PLACEHOLDER_KINDS.has(kind);
  }

  function clearSectionGroupFlushTimer() {
    if (state.sectionGroupFlushTimer) {
      clearTimeout(state.sectionGroupFlushTimer);
      state.sectionGroupFlushTimer = null;
    }
  }

  function isMissingGroupError(error) {
    return /No such group/i.test(String(error?.message || error || ''));
  }

  function scheduleSectionGroupFlush(delayMs = 0) {
    clearSectionGroupFlushTimer();
    state.sectionGroupFlushTimer = setTimeout(() => {
      state.sectionGroupFlushTimer = null;
      flushSectionGroupQueue();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function flushSectionGroupQueue(forceRepaint = false) {
    if (!state.sectionGroupQueue.length) return 0;

    const remaining = [];
    let completed = 0;

    state.sectionGroupQueue.forEach(item => {
      try {
        state.sectionGuardOriginalAddToGroup.apply(item.manager, item.args);
        completed += 1;
      } catch (error) {
        if (isMissingGroupError(error) && item.attempts < 80) {
          remaining.push({
            ...item,
            attempts: item.attempts + 1,
          });
        } else {
          warn('Не удалось восстановить блок в jsPlumb-секции:', error, item);
        }
      }
    });

    state.sectionGroupQueue = remaining;

    if (remaining.length) {
      scheduleSectionGroupFlush(25);
    } else if (forceRepaint) {
      try { getJsPlumbInstance()?.repaintEverything?.(); } catch (_) {}
    }

    return completed;
  }

  function installSectionRenderGuard() {
    const manager = getJsPlumbInstance()?._groupManager;
    const proto = manager ? Object.getPrototypeOf(manager) : null;
    if (!proto || typeof proto.addToGroup !== 'function') return false;

    if (
      state.sectionGuardProto === proto &&
      proto.addToGroup === state.sectionGuardPatchedAddToGroup
    ) {
      return true;
    }

    if (
      state.sectionGuardProto &&
      state.sectionGuardOriginalAddToGroup &&
      state.sectionGuardProto.addToGroup === state.sectionGuardPatchedAddToGroup
    ) {
      state.sectionGuardProto.addToGroup =
        state.sectionGuardOriginalAddToGroup;
    }

    const original = proto.addToGroup;
    const patched = function(...args) {
      try {
        return original.apply(this, args);
      } catch (error) {
        if (!isMissingGroupError(error)) throw error;

        state.sectionGroupQueue.push({
          manager: this,
          args,
          attempts: 0,
        });
        scheduleSectionGroupFlush(0);
        return null;
      }
    };

    patched.__dazyOriginal = original;
    patched.__dazySectionGuard = true;

    proto.addToGroup = patched;
    state.sectionGuardProto = proto;
    state.sectionGuardOriginalAddToGroup = original;
    state.sectionGuardPatchedAddToGroup = patched;
    return true;
  }

  function processHasSections() {
    const plugin = getFlowchartPlugin();
    return (
      getSectionElements().length > 0 ||
      Boolean(plugin?.blocksInSections) ||
      Boolean(plugin?.sections)
    );
  }

  function scheduleSafeFullSync(reason, delayMs = 160) {
    if (state.safeSyncTimer) clearTimeout(state.safeSyncTimer);

    state.skipReloadBudget = Math.max(state.skipReloadBudget, 1);

    state.safeSyncTimer = setTimeout(() => {
      state.safeSyncTimer = null;
      if (state.destroyed) return;

      if (state.busy) {
        scheduleSafeFullSync(reason, 250);
        return;
      }

      fullSync(reason);
    }, Math.max(50, Number(delayMs) || 160));
  }

  // ---------------------------------------------------------------------------
  // Единое прокси-перемещение одного блока и группы
  // ---------------------------------------------------------------------------

  function getPanzoomScale() {
    const plugin = getFlowchartPlugin();
    const direct = Number(plugin?.panzoomSettings?.currentScale);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const panzoom =
      document.querySelector('#flowchart .panzoom') ||
      document.querySelector('.panzoom-container > .panzoom') ||
      document.querySelector('.panzoom');

    const transform = panzoom ? getComputedStyle(panzoom).transform : '';
    if (transform && transform !== 'none') {
      try {
        const matrix = new DOMMatrixReadOnly(transform);
        const scale = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
        if (Number.isFinite(scale) && scale > 0) return scale;
      } catch (_) {}
    }

    return 1;
  }

  function getBlockPosition(blockEl) {
    const blockData = findPluginBlockData(getBlockId(blockEl));
    const left = Number.parseFloat(blockEl?.style?.left || blockData?.coord?.left || 0) || 0;
    const top = Number.parseFloat(blockEl?.style?.top || blockData?.coord?.top || 0) || 0;
    return { left, top };
  }

  function getGroupProxySelection(clickedBlock) {
    if (
      !clickedBlock ||
      clickedBlock.classList.contains('start-flowchart-block') ||
      isSectionBlock(clickedBlock)
    ) {
      return [];
    }

    // На тяжёлых процессах CSS-выделение и внутренний Selectable GetCourse
    // могут временно расходиться. Берём объединение обоих источников.
    const visualIds = getVisualSelectedBlockIds();
    const internalIds = getInternalSelectedBlockIds();
    const selectedIds = [
      ...new Set([...visualIds, ...internalIds].map(String).filter(Boolean)),
    ];

    const clickedId = String(getBlockId(clickedBlock) || '');
    const clickedIsSelected =
      clickedBlock.classList.contains('flowchart-selected') ||
      selectedIds.includes(clickedId);

    if (clickedIsSelected && selectedIds.length) {
      return selectedIds
        .map(id => document.getElementById(`fwb${id}`))
        .filter(
          block =>
            block?.isConnected &&
            block.classList.contains('flowchart-block') &&
            !block.classList.contains('start-flowchart-block')
        );
    }

    return [clickedBlock];
  }

  function stopUnsafeNativeMove(event) {
    // Простой return недостаточен: после него штатный drag GetCourse
    // продолжает обработку pointerdown и может обойти SAFE-лимит.
    try { event.preventDefault(); } catch (_) {}
    try { event.stopPropagation(); } catch (_) {}
    try { event.stopImmediatePropagation?.(); } catch (_) {}
  }

  function setProxyBlocksNativeDraggable(enabled) {
    const instance = getJsPlumbInstance();
    if (!instance || !state.groupProxyBlocks.length) return;

    state.groupProxyBlocks.forEach(item => {
      try {
        if (typeof instance.setDraggable === 'function') {
          instance.setDraggable(item.el, Boolean(enabled));
        } else if (window.jQuery?.fn?.draggable && window.jQuery(item.el).data('ui-draggable')) {
          window.jQuery(item.el).draggable(enabled ? 'enable' : 'disable');
        }
      } catch (_) {}
    });

    state.groupProxyNativeDragDisabled = !enabled;
  }

  function restoreProxyBlocksNativeDraggable() {
    if (!state.groupProxyNativeDragDisabled) return;
    setProxyBlocksNativeDraggable(true);
    state.groupProxyNativeDragDisabled = false;
  }

  function getEditorPanzoomElement() {
    const pluginPanzoom = getFlowchartPlugin()?.panzoom;

    return (
      pluginPanzoom?.[0] ||
      (pluginPanzoom instanceof Element ? pluginPanzoom : null) ||
      document.querySelector('#flowchart .panzoom') ||
      document.querySelector('.panzoom')
    );
  }

  function getEditorPanzoomJQuery() {
    const pluginPanzoom = getFlowchartPlugin()?.panzoom;
    if (pluginPanzoom?.jquery) return pluginPanzoom;

    const element = getEditorPanzoomElement();
    return element && $ ? $(element) : null;
  }

  function getEditorViewportElement() {
    const panzoom = getEditorPanzoomElement();

    return (
      panzoom?.closest?.('.panzoom-container') ||
      document.querySelector('#flowchart .panzoom-container') ||
      document.querySelector('.panzoom-container')
    );
  }

  function readEditorPanzoomMatrix($panzoom) {
    if (!$panzoom?.length || typeof $panzoom.panzoom !== 'function') {
      return null;
    }

    try {
      const matrix = $panzoom.panzoom('getMatrix');
      if (!Array.isArray(matrix) || matrix.length < 6) return null;

      const values = matrix.map(Number);
      return values.every(Number.isFinite) ? values : null;
    } catch (_) {
      return null;
    }
  }

  function isEditorDocumentScroller(element) {
    return (
      element === document.scrollingElement ||
      element === document.documentElement ||
      element === document.body
    );
  }

  function getEditorScrollContainer() {
    let node = getEditorViewportElement();

    while (node && node !== document.body) {
      const style = getComputedStyle(node);

      const scrollableX =
        node.scrollWidth > node.clientWidth + 2 &&
        /(auto|scroll|overlay)/.test(style.overflowX);

      const scrollableY =
        node.scrollHeight > node.clientHeight + 2 &&
        /(auto|scroll|overlay)/.test(style.overflowY);

      if (scrollableX || scrollableY) return node;
      node = node.parentElement;
    }

    return (
      document.scrollingElement ||
      document.documentElement ||
      document.body
    );
  }

  function readEditorScroll(container) {
    if (!container) return { left: 0, top: 0 };

    if (isEditorDocumentScroller(container)) {
      return {
        left:
          window.scrollX ||
          document.documentElement.scrollLeft ||
          document.body.scrollLeft ||
          0,
        top:
          window.scrollY ||
          document.documentElement.scrollTop ||
          document.body.scrollTop ||
          0,
      };
    }

    return {
      left: Number(container.scrollLeft) || 0,
      top: Number(container.scrollTop) || 0,
    };
  }

  function setEditorScroll(container, left, top) {
    if (!container) return { left: 0, top: 0 };

    if (isEditorDocumentScroller(container)) {
      window.scrollTo({
        left: Math.max(0, Number(left) || 0),
        top: Math.max(0, Number(top) || 0),
        behavior: 'auto',
      });
    } else {
      container.scrollLeft = Math.max(0, Number(left) || 0);
      container.scrollTop = Math.max(0, Number(top) || 0);
    }

    return readEditorScroll(container);
  }

  function getEditorVisibleViewportRect() {
    const host = getEditorViewportElement();
    const rect = host?.getBoundingClientRect?.();

    const left = Math.max(0, rect?.left || 0);
    const top = Math.max(0, rect?.top || 0);
    const right = Math.min(
      window.innerWidth,
      rect?.right || window.innerWidth
    );
    const bottom = Math.min(
      window.innerHeight,
      rect?.bottom || window.innerHeight
    );

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  function panEditorByScreen(dx, dy) {
    const scrollContainer = getEditorScrollContainer();
    if (!scrollContainer) return { x: 0, y: 0 };

    const before = readEditorScroll(scrollContainer);

    const after = setEditorScroll(
      scrollContainer,
      before.left - (Number(dx) || 0),
      before.top - (Number(dy) || 0)
    );

    // Scroll вправо сдвигает контент влево, поэтому возвращаем
    // фактическое экранное смещение контента с обратным знаком.
    return {
      x: -(after.left - before.left),
      y: -(after.top - before.top),
    };
  }

  function updateGroupProxyEffectiveDelta() {
    state.groupProxyLastDelta = {
      x: state.groupProxyPointerDelta.x - state.groupProxyPanTranslation.x,
      y: state.groupProxyPointerDelta.y - state.groupProxyPanTranslation.y,
    };
  }

  function stopGroupProxyAutoPan() {
    if (state.groupProxyAutoPanFrame) {
      cancelAnimationFrame(state.groupProxyAutoPanFrame);
      state.groupProxyAutoPanFrame = null;
    }
  }

  function getEdgePanStep(pointer, rect) {
    const threshold = 76;
    const maximum = 24;
    const minimum = 3;

    function speed(distance) {
      const ratio = Math.max(
        0,
        Math.min(1, (threshold - distance) / threshold)
      );
      return minimum + (maximum - minimum) * ratio * ratio;
    }

    let x = 0;
    let y = 0;

    const leftDistance = pointer.x - rect.left;
    const rightDistance = rect.right - pointer.x;
    const topDistance = pointer.y - rect.top;
    const bottomDistance = rect.bottom - pointer.y;

    if (leftDistance < threshold) {
      x = speed(Math.max(0, leftDistance));
    } else if (rightDistance < threshold) {
      x = -speed(Math.max(0, rightDistance));
    }

    if (topDistance < threshold) {
      y = speed(Math.max(0, topDistance));
    } else if (bottomDistance < threshold) {
      y = -speed(Math.max(0, bottomDistance));
    }

    return { x, y };
  }

  function runGroupProxyAutoPan() {
    state.groupProxyAutoPanFrame = null;

    if (
      !state.groupProxyActive ||
      !state.edgePanEnabled ||
      !state.groupProxyPointerClient
    ) {
      return;
    }

    const viewport = getEditorViewportElement();
    if (!viewport) return;

    const rect = getEditorVisibleViewportRect();
    const step = getEdgePanStep(state.groupProxyPointerClient, rect);

    if (Math.abs(step.x) > 0.01 || Math.abs(step.y) > 0.01) {
      const actual = panEditorByScreen(step.x, step.y);

      if (Math.abs(actual.x) > 0.01 || Math.abs(actual.y) > 0.01) {
        state.groupProxyPanTranslation.x += actual.x;
        state.groupProxyPanTranslation.y += actual.y;
        state.groupProxyAutoPanWasActive = true;
        updateGroupProxyEffectiveDelta();
      }
    }

    state.groupProxyAutoPanFrame =
      requestAnimationFrame(runGroupProxyAutoPan);
  }

  function startGroupProxyAutoPan() {
    stopGroupProxyAutoPan();
    if (!state.edgePanEnabled) return;

    state.groupProxyAutoPanFrame =
      requestAnimationFrame(runGroupProxyAutoPan);
  }

  function getVisualSelectedBlockIds() {
    return [
      ...document.querySelectorAll(
        '#flowchart .flowchart-block.flowchart-selected'
      ),
    ]
      .filter(
        block =>
          !block.classList.contains('start-flowchart-block') &&
          block.isConnected
      )
      .map(getBlockId)
      .filter(Boolean);
  }

  function getInternalSelectedBlockIds() {
    const selectable = getFlowchartPlugin()?.flowchartSelectable;

    try {
      return (selectable?.getSelectedNodes?.() || [])
        .filter(
          block =>
            block &&
            !block.classList?.contains('start-flowchart-block')
        )
        .map(getBlockId)
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function clearSelectionState(reason = 'manual') {
    const plugin = getFlowchartPlugin();
    const selectable = plugin?.flowchartSelectable;
    const instance = getJsPlumbInstance();

    let internalNodes = [];

    try {
      internalNodes = selectable?.getSelectedNodes?.() || [];
    } catch (_) {}

    try {
      instance?.clearDragSelection?.();
    } catch (_) {}

    // Некоторые версии Selectable надёжнее снимают выбор по одному узлу,
    // особенно если после render внутри остались ссылки на старые DOM-элементы.
    if (typeof selectable?.deselect === 'function') {
      internalNodes.forEach(node => {
        try {
          selectable.deselect(node);
        } catch (_) {}
      });
    }

    try {
      selectable?.deselectAll?.();
    } catch (_) {}

    document
      .querySelectorAll('#flowchart .flowchart-block.flowchart-selected')
      .forEach(block => {
        block.classList.remove('flowchart-selected');

        try {
          instance?.removeFromDragSelection?.(block);
        } catch (_) {}
      });

    try {
      selectable?.update?.();
    } catch (_) {}

    $('.flowchart-selected-blocks-btn').prop('disabled', true);

    log('Выделение очищено.', {
      reason,
      staleInternalNodes: internalNodes.length,
    });

    return {
      reason,
      staleInternalNodes: internalNodes.length,
      visualIds: getVisualSelectedBlockIds(),
      internalIds: getInternalSelectedBlockIds(),
    };
  }

  function sanitizeDeleteBlockIds(requestedIds) {
    const requested = [
      ...new Set(
        (requestedIds || [])
          .map(String)
          .filter(Boolean)
      ),
    ];

    const visual = [
      ...new Set(getVisualSelectedBlockIds()),
    ];

    const internal = [
      ...new Set(getInternalSelectedBlockIds()),
    ];

    // Источник истины для удаления — только текущее видимое выделение.
    // Native GetCourse формирует requested из flowchartSelectable, где после
    // reload иногда остаются ссылки на ранее выбранную группу.
    const safeIds = visual;

    const requestedKey = [...requested].sort().join(',');
    const visualKey = [...visual].sort().join(',');
    const internalKey = [...internal].sort().join(',');

    return {
      requested,
      visual,
      internal,
      safeIds,
      mismatch:
        requestedKey !== visualKey ||
        internalKey !== visualKey,
    };
  }

  function selectBlocksByIds(
    blockIds,
    { clearExisting = true, reason = 'manual' } = {}
  ) {
    const ids = [...new Set((blockIds || []).map(String).filter(Boolean))];
    if (!ids.length) return [];

    if (clearExisting) clearSelectionState(`before-select:${reason}`);

    const plugin = getFlowchartPlugin();
    const selectable = plugin?.flowchartSelectable;
    const instance = getJsPlumbInstance();
    const selected = [];

    ids.forEach(id => {
      const block = document.getElementById(`fwb${id}`);
      if (!block?.isConnected) return;

      try { selectable?.select?.(block); } catch (_) {}
      block.classList.add('flowchart-selected');
      try { instance?.addToDragSelection?.(block); } catch (_) {}
      selected.push(block);
    });

    try { selectable?.update?.(); } catch (_) {}
    updateSelectedActionButtons();

    log('Блоки выбраны программно.', {
      reason,
      selectedIds: selected.map(getBlockId),
    });

    return selected;
  }

  function scheduleSelectCopiedBlocks(blockIds) {
    const ids = [...new Set((blockIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;

    const apply = reason => {
      const selected = selectBlocksByIds(ids, {
        clearExisting: true,
        reason,
      });

      if (selected.length === ids.length) {
        setSaveStatus(
          `Новая группа выделена. Блоков: ${selected.length}; ` +
          'можно сразу перемещать, копировать или удалять без синхронизации.',
          'success'
        );
      }
    };

    requestAnimationFrame(() => {
      apply('copied-blocks-frame');
      setTimeout(() => apply('copied-blocks-timeout'), 0);
    });
  }

  function updateSelectedActionButtons() {
    const selectedCount = document.querySelectorAll(
      '#flowchart .flowchart-block.flowchart-selected'
    ).length;

    const disabled = selectedCount < 1;

    [
      '#flowchart-duplicate-blocks-btn',
      '#flowchart-delete-selected-blocks-btn',
      '#flowchart-copy-to-clipboard-selected-blocks-btn',
    ].forEach(selector => {
      try {
        $(selector).prop('disabled', disabled);
      } catch (_) {}
    });
  }

  function restoreMovedSelection(items) {
    const selectedItems = items.filter(
      item => item.wasSelected || items.length > 1
    );

    if (!selectedItems.length) return;

    selectBlocksByIds(
      selectedItems.map(item => getBlockId(item.el)).filter(Boolean),
      {
        clearExisting: false,
        reason: 'restore-after-move',
      }
    );
  }

  function clearGroupProxySafetyTimer() {
    if (state.groupProxySafetyTimer) {
      clearTimeout(state.groupProxySafetyTimer);
      state.groupProxySafetyTimer = null;
    }
  }

  function clearGroupProxyRaf() {
    if (state.groupProxyRaf) {
      cancelAnimationFrame(state.groupProxyRaf);
      state.groupProxyRaf = null;
    }
  }

  function removeGroupProxyElement() {
    clearGroupProxyRaf();
    state.groupProxyElement?.remove();
    state.groupProxyElement = null;
  }

  function restoreGroupProxyVisuals() {
    document.body.classList.remove(classes.bodyGroupProxy, classes.bodyLiteDrag);
    state.groupProxyBlocks.forEach(item => {
      try { item.el?.classList?.remove(classes.groupProxySource, classes.liteDragBlock); } catch (_) {}
    });
    removeGroupProxyElement();
    restoreProxyBlocksNativeDraggable();
  }

  function resetGroupProxyState() {
    clearGroupProxySafetyTimer();
    restoreGroupProxyVisuals();
    state.groupProxyCandidate = null;
    state.groupProxyActive = false;
    state.groupProxyPointerId = null;
    state.groupProxyStartPoint = null;
    state.groupProxyLastDelta = { x: 0, y: 0 };
    state.groupProxyPointerDelta = { x: 0, y: 0 };
    state.groupProxyPanTranslation = { x: 0, y: 0 };
    state.groupProxyPointerClient = null;
    state.groupProxyAutoPanWasActive = false;
    stopGroupProxyAutoPan();
    state.groupProxyBlocks = [];
    state.groupProxyScale = 1;
    state.groupProxyWasSuspended = false;
    state.groupProxySaving = false;
    state.groupProxyNativeDragDisabled = false;
    state.groupProxyInterceptNative = false;
    state.groupProxyClickTarget = null;
    state.groupProxyClickModifiers = null;
  }

  function createGroupProxyElement(items) {
    const rects = items.map(item => item.el.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right));
    const bottom = Math.max(...rects.map(rect => rect.bottom));

    const proxy = document.createElement('div');
    proxy.className = classes.groupProxyElement;
    proxy.style.left = `${left}px`;
    proxy.style.top = `${top}px`;
    proxy.style.width = `${Math.max(32, right - left)}px`;
    proxy.style.height = `${Math.max(32, bottom - top)}px`;
    proxy.innerHTML = `<span>${
      items.length === 1 ? 'Перемещается блок' : `Перемещается блоков: ${items.length}`
    }</span>`;

    const maxMiniatures = 24;
    rects.slice(0, maxMiniatures).forEach(rect => {
      const miniature = document.createElement('i');
      miniature.style.left = `${rect.left - left}px`;
      miniature.style.top = `${rect.top - top}px`;
      miniature.style.width = `${Math.max(12, rect.width)}px`;
      miniature.style.height = `${Math.max(12, rect.height)}px`;
      proxy.appendChild(miniature);
    });

    document.body.appendChild(proxy);
    state.groupProxyElement = proxy;
    return proxy;
  }

  function paintGroupProxyDelta() {
    state.groupProxyRaf = null;
    const proxy = state.groupProxyElement;
    if (!proxy) return;
    const { x, y } = state.groupProxyPointerDelta;
    proxy.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function queueGroupProxyDelta(dx, dy) {
    state.groupProxyPointerDelta = { x: dx, y: dy };
    updateGroupProxyEffectiveDelta();
    if (!state.groupProxyRaf) {
      state.groupProxyRaf = requestAnimationFrame(paintGroupProxyDelta);
    }
  }

  function startGroupProxyDrag() {
    if (!state.groupProxyCandidate || state.groupProxyActive) return;

    const instance = installLightDragRenderGuard() || getJsPlumbInstance();
    state.groupProxyActive = true;
    state.lightDragActive = true;
    state.lightDragRepaintSuppressed = 0;
    state.groupProxyScale = getPanzoomScale();

    document.body.classList.add(classes.bodyGroupProxy, classes.bodyLiteDrag);
    state.groupProxyBlocks.forEach(item => {
      item.el.classList.add(classes.groupProxySource, classes.liteDragBlock);
    });
    createGroupProxyElement(state.groupProxyBlocks);

    try {
      state.groupProxyWasSuspended = Boolean(instance?.isSuspendDrawing?.());
      if (instance?.setSuspendDrawing && !state.groupProxyWasSuspended) {
        instance.setSuspendDrawing(true);
      }
    } catch (error) {
      warn('Не удалось заморозить jsPlumb для группового прокси:', error);
    }

    setDragStatus(
      state.groupProxyBlocks.length === 1
        ? 'Прокси-перемещение одного блока. Карточка будет сдвинута после отпускания.'
        : `Прокси-перемещение: ${state.groupProxyBlocks.length} блоков. Карточки будут сдвинуты после отпускания.`,
      'loading'
    );

    startGroupProxyAutoPan();

    clearGroupProxySafetyTimer();
    state.groupProxySafetyTimer = setTimeout(() => {
      finishGroupProxyDrag('safety-timeout', true);
    }, 20000);
  }

  function applyGroupProxyCoordinates(dxClient, dyClient) {
    const scale = state.groupProxyScale || 1;
    const dx = dxClient / scale;
    const dy = dyClient / scale;
    const blocksPayload = {};

    state.groupProxyBlocks.forEach(item => {
      const nextLeft = Math.round((item.startLeft + dx) * 100) / 100;
      const nextTop = Math.round((item.startTop + dy) * 100) / 100;
      item.nextLeft = nextLeft;
      item.nextTop = nextTop;
      item.el.style.left = `${nextLeft}px`;
      item.el.style.top = `${nextTop}px`;

      const blockData = findPluginBlockData(item.id);
      if (blockData) blockData.coord = { left: nextLeft, top: nextTop };

      blocksPayload[item.id] = {
        coord: { top: nextTop, left: nextLeft },
        sectionId: item.sectionId ?? null,
      };

      if (blockData && item.sectionId != null) {
        blockData.sectionId = item.sectionId;
      }
    });

    return blocksPayload;
  }

  function revertGroupProxyCoordinates(items) {
    items.forEach(item => {
      item.el.style.left = `${item.startLeft}px`;
      item.el.style.top = `${item.startTop}px`;
      const blockData = findPluginBlockData(item.id);
      if (blockData) blockData.coord = { left: item.startLeft, top: item.startTop };
    });
  }

  async function finishGroupProxyDrag(reason = 'pointerup', cancelled = false, silent = false) {
    if (!state.groupProxyCandidate && !state.groupProxyActive) return;
    if (state.groupProxySaving) return;

    const items = [...state.groupProxyBlocks];
    const wasActive = state.groupProxyActive;
    const delta = { ...state.groupProxyLastDelta };

    // Независимый предохранитель непосредственно перед сохранением.
    if (!CONFIG.externalMoveGuard && items.length > SAFE_MAX_PROXY_MOVE_BLOCKS) {
      cancelled = true;
      setDragStatus(
        `SAFE MODE: отправка координат отменена (${items.length} блоков; лимит ${SAFE_MAX_PROXY_MOVE_BLOCKS}).`,
        'warning'
      );
    }
    const instance = getJsPlumbInstance();
    const suppressed = state.lightDragRepaintSuppressed;

    state.groupProxySaving = true;
    clearGroupProxySafetyTimer();
    stopGroupProxyAutoPan();
    restoreGroupProxyVisuals();

    if (!wasActive || cancelled || Math.hypot(delta.x, delta.y) < 1) {
      try {
        if (instance?.setSuspendDrawing && !state.groupProxyWasSuspended) {
          instance.setSuspendDrawing(false, false);
        }
      } catch (_) {}
      state.lightDragActive = false;
      resetGroupProxyState();
      if (!silent && cancelled) setDragStatus('Перемещение отменено.', 'warning');
      return;
    }

    const payload = applyGroupProxyCoordinates(delta.x, delta.y);
    const payloadIds = Object.keys(payload || {});

    // Последний guard уже по фактическому payload перед POST /move-scripts.
    if (
      payloadIds.length !== items.length ||
      (!CONFIG.externalMoveGuard &&
        payloadIds.length > SAFE_MAX_PROXY_MOVE_BLOCKS)
    ) {
      revertGroupProxyCoordinates(items);
      requestAnimationFrame(() => repaintMovedBlocks(items.map(item => item.el)));

      try {
        if (instance?.setSuspendDrawing && !state.groupProxyWasSuspended) {
          instance.setSuspendDrawing(false, false);
        }
      } catch (_) {}

      state.lightDragActive = false;
      const selectionItems = [...items];
      resetGroupProxyState();
      requestAnimationFrame(() => restoreMovedSelection(selectionItems));

      setDragStatus(
        `SAFE MODE: координаты не отправлены — payload=${payloadIds.length}, группа=${items.length}, лимит=${SAFE_MAX_PROXY_MOVE_BLOCKS}.`,
        'warning'
      );
      return;
    }

    try {
      if (instance?.setSuspendDrawing && !state.groupProxyWasSuspended) {
        instance.setSuspendDrawing(false, false);
      }
    } catch (error) {
      warn('Не удалось возобновить jsPlumb после группового прокси:', error);
    }

    state.lightDragActive = false;
    requestAnimationFrame(() => {
      repaintMovedBlocks(items.map(item => item.el));
      restoreMovedSelection(items);
    });

    try {
      await ajaxPromise({
        url: '/pl/tasks/mission/move-scripts',
        type: 'POST',
        dataType: 'json',
        data: { blocks: payload },
      });

      if (!silent) {
        setDragStatus(
          items.length === 1
            ? `Блок перемещён через прокси; координаты сохранены одним запросом.`
            : `Группа перемещена. Блоков: ${items.length}; выделение сохранено` +
              `${state.groupProxyAutoPanWasActive ? '; автопрокрутка использована' : ''}.`,
          'success'
        );
      }
      log('Прокси-перемещение завершено.', {
        reason,
        blocks: items.map(item => item.id),
        delta,
      });
    } catch (error) {
      revertGroupProxyCoordinates(items);
      requestAnimationFrame(() => repaintMovedBlocks(items.map(item => item.el)));
      setDragStatus(
        `Координаты группы не сохранены, положение возвращено: ${responseErrorText(error).slice(0, 180)}`,
        'warning'
      );
      warn('Прокси-перемещение группы не сохранилось:', error);
    } finally {
      const selectionItems = [...items];
      resetGroupProxyState();
      requestAnimationFrame(() => restoreMovedSelection(selectionItems));
    }
  }

  function removeMoveLimitToast() {
    document.getElementById('dazy-gc-move-limit-toast')?.remove();
  }

  function flashBlockedMove(blocks, count) {
    const message =
      `SAFE: выбрано ${count} блоков. Максимум для одного перемещения — ` +
      `${SAFE_MAX_PROXY_MOVE_BLOCKS}. Перемещение заблокировано.`;

    setDragStatus(message, 'error');

    const uniqueBlocks = [
      ...new Map(
        (blocks || [])
          .filter(block => block?.isConnected)
          .map(block => [String(getBlockId(block) || ''), block])
          .filter(([id]) => id)
      ).values(),
    ];

    uniqueBlocks.forEach(block => {
      block.classList.remove(classes.moveBlocked);
      void block.offsetWidth;
      block.classList.add(classes.moveBlocked);
    });

    window.setTimeout(() => {
      uniqueBlocks.forEach(block => {
        try { block.classList.remove(classes.moveBlocked); } catch (_) {}
      });
    }, 1500);

    removeMoveLimitToast();

    const toast = document.createElement('div');
    toast.id = 'dazy-gc-move-limit-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    window.setTimeout(() => {
      try { toast.remove(); } catch (_) {}
    }, 2600);
  }

  function handleGroupProxyPointerDown(event) {
    if (
      state.linkMode ||
      state.busy ||
      state.groupProxySaving ||
      event.button !== 0
    ) {
      return;
    }

    if (
      event.target.closest?.(
        '.jtk-endpoint, ._jsPlumb_endpoint, button, a, input, textarea, select'
      )
    ) {
      return;
    }

    const blockEl = event.target.closest?.('#flowchart .flowchart-block');

    if (
      !blockEl ||
      blockEl.classList.contains('start-flowchart-block')
    ) {
      return;
    }

    // Shift нужен GetCourse для формирования выделения.
    // Ограничение проверяем при следующей обычной попытке drag.
    if (event.shiftKey) {
      state.lastProxyFallbackReason = '';
      return;
    }

    const selected = getGroupProxySelection(blockEl);

    if (selected.length < 1) {
      return;
    }

    // Safety-лимит работает всегда, независимо от режима перемещения.
    if (!CONFIG.externalMoveGuard && selected.length > SAFE_MAX_PROXY_MOVE_BLOCKS) {
      state.lastProxyFallbackReason =
        `SAFE MODE: массовое перемещение заблокировано ` +
        `(${selected.length} блоков; лимит ${SAFE_MAX_PROXY_MOVE_BLOCKS}).`;

      flashBlockedMove(selected, selected.length);
      stopUnsafeNativeMove(event);

      state.groupProxyCandidate = null;
      state.groupProxyBlocks = [];
      return;
    }

    // Облегчённый режим выключен:
    // до лимита полностью оставляем drag штатному GetCourse.
    if (
      !state.lightDragEnabled ||
      !state.groupProxyEnabled
    ) {
      return;
    }

    if (selected.some(isSectionBlock)) {
      state.lastProxyFallbackReason =
        'SAFE MODE: секция не может входить в прокси-группу.';
      setDragStatus(state.lastProxyFallbackReason, 'warning');
      return;
    }

    const assessment = assessProxySelection(selected);

    if (!assessment.ok) {
      state.lastProxyFallbackReason = assessment.reason;
      setDragStatus(assessment.reason, 'warning');
      return;
    }

    if (assessment.contexts.some(context => context.insideSection)) {
      state.lastProxyFallbackReason =
        'SAFE MODE: перемещение блоков внутри секций временно запрещено.';
      setDragStatus(state.lastProxyFallbackReason, 'warning');
      return;
    }

    state.lastProxyFallbackReason = '';
    state.groupProxyCandidate = blockEl;
    state.groupProxyPointerId = event.pointerId;
    state.groupProxyStartPoint = {
      x: event.clientX,
      y: event.clientY,
    };
    state.groupProxyLastDelta = { x: 0, y: 0 };
    state.groupProxyPointerDelta = { x: 0, y: 0 };
    state.groupProxyPanTranslation = { x: 0, y: 0 };
    state.groupProxyPointerClient = {
      x: event.clientX,
      y: event.clientY,
    };

    state.groupProxyBlocks = selected.map((el, index) => {
      const position = getBlockPosition(el);
      const sectionContext =
        assessment.contexts[index] ||
        {
          sectionId: null,
          insideSection: false,
          resolved: true,
          source: 'none',
        };

      return {
        el,
        id: getBlockId(el),
        startLeft: position.left,
        startTop: position.top,
        sectionId: sectionContext.sectionId,
        sectionContext,
        wasSelected:
          el.classList.contains('flowchart-selected'),
      };
    });

    // В proxy-режиме полностью перехватываем native drag GetCourse.
    state.groupProxyInterceptNative = true;
    state.groupProxyClickTarget = blockEl;
    state.groupProxyClickModifiers = {
      ctrlKey: Boolean(event.ctrlKey),
      shiftKey: Boolean(event.shiftKey),
      altKey: Boolean(event.altKey),
      metaKey: Boolean(event.metaKey),
    };

    setProxyBlocksNativeDraggable(false);

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch (_) {}
  }

  function handleGroupProxyPointerMove(event) {
    if (!state.groupProxyCandidate || event.pointerId !== state.groupProxyPointerId) return;

    const dx = event.clientX - state.groupProxyStartPoint.x;
    const dy = event.clientY - state.groupProxyStartPoint.y;

    state.groupProxyPointerClient = {
      x: event.clientX,
      y: event.clientY,
    };

    if (!state.groupProxyActive && Math.hypot(dx, dy) >= 4) {
      startGroupProxyDrag();
    }
    if (state.groupProxyActive) queueGroupProxyDelta(dx, dy);

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function handleGroupProxyPointerUp(event) {
    if (!state.groupProxyCandidate || event.pointerId !== state.groupProxyPointerId) return;

    if (!state.groupProxyActive) {
      const clickTarget = state.groupProxyClickTarget;
      const modifiers = state.groupProxyClickModifiers;
      const intercepted = state.groupProxyInterceptNative;

      restoreProxyBlocksNativeDraggable();
      resetGroupProxyState();

      if (intercepted && clickTarget?.isConnected) {
        setTimeout(() => {
          clickTarget.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              ctrlKey: Boolean(modifiers?.ctrlKey),
              shiftKey: Boolean(modifiers?.shiftKey),
              altKey: Boolean(modifiers?.altKey),
              metaKey: Boolean(modifiers?.metaKey),
            })
          );
        }, 0);
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    void finishGroupProxyDrag('pointer-end', false);
  }

  function handleGroupProxyPointerCancel(event) {
    if (!state.groupProxyCandidate || event.pointerId !== state.groupProxyPointerId) return;

    if (!state.groupProxyActive) {
      restoreProxyBlocksNativeDraggable();
      resetGroupProxyState();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    void finishGroupProxyDrag('pointer-cancel', true);
  }

  // ---------------------------------------------------------------------------
  // Облегчённое перемещение блоков
  // ---------------------------------------------------------------------------

  function setDragStatus(message, tone = 'normal') {
    const status = state.panel?.querySelector('[data-role="drag-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function clearLightDragSafetyTimer() {
    if (state.lightDragSafetyTimer) {
      clearTimeout(state.lightDragSafetyTimer);
      state.lightDragSafetyTimer = null;
    }
  }

  function getSelectedDragBlocks(clickedBlock) {
    const selected = [...document.querySelectorAll('#flowchart .flowchart-block.flowchart-selected')];
    if (clickedBlock?.classList.contains('flowchart-selected') && selected.length) {
      return selected;
    }
    return clickedBlock ? [clickedBlock] : [];
  }

  function restoreLightDragRenderGuard() {
    const instance = state.lightDragPatchedInstance;
    const originals = state.lightDragOriginalMethods;

    if (instance && originals) {
      Object.entries(originals).forEach(([methodName, original]) => {
        try {
          if (typeof original === 'function') instance[methodName] = original;
        } catch (_) {}
      });
    }

    state.lightDragPatchedInstance = null;
    state.lightDragOriginalMethods = null;
  }

  function installLightDragRenderGuard() {
    const instance = getJsPlumbInstance();
    if (!instance) return null;

    if (state.lightDragPatchedInstance === instance && state.lightDragOriginalMethods) {
      return instance;
    }

    restoreLightDragRenderGuard();

    const originals = {};
    ['repaintEverything', 'repaint', 'revalidate'].forEach(methodName => {
      const original = instance[methodName];
      if (typeof original !== 'function') return;

      originals[methodName] = original;

      instance[methodName] = function dazyLiteDragRenderGuard(...args) {
        if (state.lightDragActive) {
          state.lightDragRepaintSuppressed += 1;
          return this;
        }
        return original.apply(this, args);
      };
    });

    if (Object.keys(originals).length) {
      state.lightDragPatchedInstance = instance;
      state.lightDragOriginalMethods = originals;
    }

    return instance;
  }

  function resetLightDragState() {
    clearLightDragSafetyTimer();

    state.lightDragBlocks.forEach(block => {
      try { block?.classList?.remove(classes.liteDragBlock); } catch (_) {}
    });

    state.lightDragCandidate = null;
    state.lightDragActive = false;
    state.lightDragBlocks = [];
    state.lightDragStartPoint = null;
    state.lightDragWasSuspended = false;
    state.lightDragRepaintSuppressed = 0;
    document.body.classList.remove(classes.bodyLiteDrag);
  }

  function repaintMovedBlocks(blocks) {
    const instance = getJsPlumbInstance();
    if (!instance) return;

    const unique = [...new Set((blocks || []).filter(Boolean))];
    let repainted = 0;

    try {
      unique.forEach(block => {
        if (!block?.isConnected) return;
        if (typeof instance.revalidate === 'function') {
          instance.revalidate(block);
          repainted += 1;
        } else if (typeof instance.repaint === 'function') {
          instance.repaint(block);
          repainted += 1;
        }
      });

      if (!repainted && typeof instance.repaintEverything === 'function') {
        instance.repaintEverything();
      }
    } catch (error) {
      warn('Точечная перерисовка после перемещения не удалась:', error);
      try { instance.repaintEverything?.(); } catch (_) {}
    }
  }

  function finishLightDrag(reason = 'pointerup', silent = false) {
    if (!state.lightDragCandidate && !state.lightDragActive) return;

    const blocks = [...state.lightDragBlocks];
    const wasActive = state.lightDragActive;
    const suppressedRepaints = state.lightDragRepaintSuppressed;
    const instance = getJsPlumbInstance();

    clearLightDragSafetyTimer();
    document.body.classList.remove(classes.bodyLiteDrag);

    if (wasActive && instance) {
      try {
        if (
          typeof instance.setSuspendDrawing === 'function' &&
          !state.lightDragWasSuspended
        ) {
          instance.setSuspendDrawing(false, false);
        }
      } catch (error) {
        warn('Не удалось возобновить отрисовку jsPlumb:', error);
      }

      requestAnimationFrame(() => {
        repaintMovedBlocks(blocks);
        if (!silent) {
          setDragStatus(
            `Перемещение завершено. Блоков: ${blocks.length || 1}; подавлено перерисовок: ${suppressedRepaints}.`,
            'success'
          );
        }
      });
    }

    resetLightDragState();
    log('Облегчённое перемещение завершено.', { reason, blocks: blocks.map(getBlockId) });
  }

  function startLightDrag() {
    if (!state.lightDragCandidate || state.lightDragActive) return;

    const instance = installLightDragRenderGuard() || getJsPlumbInstance();
    if (!instance || typeof instance.setSuspendDrawing !== 'function') {
      state.lightDragActive = true;
      state.lightDragRepaintSuppressed = 0;
      document.body.classList.add(classes.bodyLiteDrag);
      state.lightDragBlocks.forEach(block => block?.classList?.add(classes.liteDragBlock));
      setDragStatus('Линии временно скрыты до отпускания блока.', 'loading');
      return;
    }

    state.lightDragActive = true;
    state.lightDragRepaintSuppressed = 0;
    document.body.classList.add(classes.bodyLiteDrag);
    state.lightDragBlocks.forEach(block => block?.classList?.add(classes.liteDragBlock));

    try {
      state.lightDragWasSuspended = Boolean(instance.isSuspendDrawing?.());
      if (!state.lightDragWasSuspended) {
        instance.setSuspendDrawing(true);
      }
      setDragStatus(
        `Линии заморожены. Перемещается блоков: ${state.lightDragBlocks.length || 1}.`,
        'loading'
      );
    } catch (error) {
      warn('Не удалось приостановить отрисовку jsPlumb:', error);
      setDragStatus('Линии скрыты, но jsPlumb не удалось заморозить полностью.', 'warning');
    }

    clearLightDragSafetyTimer();
    state.lightDragSafetyTimer = setTimeout(() => {
      finishLightDrag('safety-timeout');
    }, 20000);
  }

  function handleLiteDragPointerDown(event) {
    if (
      !state.lightDragEnabled ||
      state.linkMode ||
      state.busy ||
      state.groupProxyEnabled ||
      state.groupProxyCandidate ||
      state.groupProxyActive ||
      event.button !== 0
    ) {
      return;
    }

    if (event.target.closest?.('.jtk-endpoint, ._jsPlumb_endpoint, button, a, input, textarea, select')) {
      return;
    }

    const blockEl = event.target.closest?.('#flowchart .flowchart-block');
    if (!blockEl || blockEl.classList.contains('start-flowchart-block')) return;

    state.lightDragCandidate = blockEl;
    state.lightDragBlocks = getSelectedDragBlocks(blockEl);
    state.lightDragStartPoint = { x: event.clientX, y: event.clientY };
  }

  function handleLiteDragPointerMove(event) {
    if (state.groupProxyCandidate || state.groupProxyActive) return;
    if (!state.lightDragCandidate || state.lightDragActive || !state.lightDragStartPoint) return;

    const dx = event.clientX - state.lightDragStartPoint.x;
    const dy = event.clientY - state.lightDragStartPoint.y;
    if (Math.hypot(dx, dy) < 5) return;

    startLightDrag();
  }

  function handleLiteDragPointerEnd() {
    if (state.groupProxyCandidate || state.groupProxyActive) return;
    queueMicrotask(() => finishLightDrag('pointer-end'));
  }

  function toggleEdgePan(enabled) {
    state.edgePanEnabled = Boolean(enabled);

    const button =
      state.panel?.querySelector('[data-role="edge-pan-toggle"]');

    if (button) {
      button.classList.toggle('is-active', state.edgePanEnabled);
      button.textContent = state.edgePanEnabled
        ? 'Автопрокрутка у края: включена'
        : 'Автопрокрутка у края: выключена';
    }

    if (!state.edgePanEnabled) {
      stopGroupProxyAutoPan();
    } else if (state.groupProxyActive) {
      startGroupProxyAutoPan();
    }

    saveSettings();
  }

  function toggleLightDrag(enabled) {
    state.lightDragEnabled = Boolean(enabled);

    if (!state.lightDragEnabled) {
      void finishGroupProxyDrag('disabled', true, true);
      finishLightDrag('disabled', true);
    }

    const button = state.panel?.querySelector('[data-role="drag-toggle"]');
    if (button) {
      button.classList.toggle('is-active', state.lightDragEnabled);
      button.textContent = state.lightDragEnabled
        ? 'Облегчённое перемещение: включено'
        : 'Облегчённое перемещение: выключено';
    }

    setDragStatus(
      state.lightDragEnabled
        ? (CONFIG.externalMoveGuard
            ? 'Прокси-перемещение включено. Массовую защиту контролирует Safety Guard.'
            : `Прокси-перемещение включено. Лимит: ${SAFE_MAX_PROXY_MOVE_BLOCKS} блоков.`)
        : (CONFIG.externalMoveGuard
            ? 'Используется штатное перемещение GetCourse. Массовую защиту контролирует Safety Guard.'
            : `Используется штатное перемещение GetCourse. Лимит: ${SAFE_MAX_PROXY_MOVE_BLOCKS} блоков.`), 
      state.lightDragEnabled ? 'success' : 'warning'
    );

    saveSettings();
  }

  function addDocumentHandler(type, handler, options) {
    document.addEventListener(type, handler, options);
    state.documentHandlers.push({ type, handler, options });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }


  // ---------------------------------------------------------------------------
  // Быстрое сохранение, создание, копирование и ручная синхронизация
  // ---------------------------------------------------------------------------

  function setSaveStatus(message, tone = 'normal') {
    const status = state.panel?.querySelector('[data-role="save-status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function updateLocalChangesView() {
    const value = state.panel?.querySelector('[data-role="local-changes-value"]');
    if (value) value.textContent = String(state.localChanges);

    const syncButton = state.panel?.querySelector('[data-role="sync"]');
    if (syncButton) {
      syncButton.disabled = state.busy;
      syncButton.classList.toggle('has-local-changes', state.localChanges > 0);
    }
  }

  function markLocalChange(type, details = {}, count = 1) {
    state.localChanges += Math.max(1, Number(count) || 1);
    state.localHistory.push({
      at: new Date().toISOString(),
      type,
      details,
    });

    if (state.localHistory.length > 100) {
      state.localHistory.splice(0, state.localHistory.length - 100);
    }

    updateLocalChangesView();
  }

  function resetLocalChanges() {
    state.localChanges = 0;
    state.localHistory = [];
    updateLocalChangesView();
  }

  function findPluginBlockData(blockId) {
    const plugin = getFlowchartPlugin();
    return normalizeArray(plugin?.blocks).find(
      item => String(item?.id || '') === String(blockId || '')
    ) || null;
  }

  function getModalForm(element = null) {
    const direct = element?.closest?.('form.block-modal-window, form');
    if (direct) return direct;

    const visible = [...document.querySelectorAll('form.block-modal-window')]
      .find(form => form.offsetParent !== null);
    return visible || document.querySelector('form.block-modal-window');
  }

  function getFormScriptInfo(form) {
    if (!form) return { scriptId: '', blockType: '' };

    let url = null;
    try {
      url = new URL(form.getAttribute('action') || form.action || '', location.href);
    } catch (_) {}

    return {
      scriptId: url?.searchParams.get('scriptId') || '',
      blockType: url?.searchParams.get('blockType') || '',
    };
  }

  function getFormValue(form, name) {
    if (!form) return '';
    const field = form.elements?.namedItem?.(name) || form.querySelector?.(`[name="${CSS.escape(name)}"]`);
    if (!field) return '';
    if (field instanceof RadioNodeList) return field.value;
    return String(field.value ?? '');
  }

  function snapshotModalSave(form, submitter = null) {
    const info = getFormScriptInfo(form);
    const buttonName = String(
      submitter?.getAttribute?.('name') ||
      submitter?.name ||
      ''
    );

    return {
      startedAt: Date.now(),
      form,
      buttonName,
      scriptId: info.scriptId,
      blockType: info.blockType,
      title:
        getFormValue(form, 'title') ||
        form.querySelector('.run-block-title-input')?.value ||
        'Новый блок',
      coords: {
        top: Number(getFormValue(form, 'coords[top]')) || 0,
        left: Number(getFormValue(form, 'coords[left]')) || 0,
      },
      operationType: getFormValue(form, 'operationType'),
      results: getFormValue(form, 'results'),
      sourceBlock: info.scriptId ? document.getElementById(`fwb${info.scriptId}`) : null,
    };
  }

  function clearPendingSave() {
    if (state.pendingResetTimer) {
      clearTimeout(state.pendingResetTimer);
      state.pendingResetTimer = null;
    }
    state.pendingModalSave = null;
    state.skipReloadBudget = 0;
  }

  function armFastSave(form, submitter = null) {
    if (!state.fastSaveEnabled || !form) return;

    const buttonName = String(
      submitter?.getAttribute?.('name') ||
      submitter?.name ||
      ''
    );

    if (buttonName && buttonName !== 'save') return;

    const snapshot = snapshotModalSave(form, submitter);
    const blockKind = inferBlockKind({
      sourceBlock: snapshot?.sourceBlock || null,
      scriptType: snapshot?.blockType || '',
      blockType: snapshot?.blockType || '',
      operationType: snapshot?.operationType || '',
    });

    if (!SAFE_FAST_SAVE_KINDS.has(blockKind)) {
      state.pendingModalSave = null;
      state.skipReloadBudget = 0;
      setSaveStatus(
        `SAFE MODE: блок типа «${blockKind || 'unknown'}» сохраняется штатно GetCourse.`,
        'warning'
      );
      return;
    }

    state.pendingModalSave = snapshot;
    state.skipReloadBudget = Math.max(state.skipReloadBudget, 1);

    if (state.pendingResetTimer) clearTimeout(state.pendingResetTimer);
    state.pendingResetTimer = setTimeout(() => {
      if (!state.pendingModalSave) return;
      warn('Ожидание сохранения истекло. Автоматическая перезагрузка больше не блокируется.');
      clearPendingSave();
      setSaveStatus('Сохранение не подтвердилось. Быстрый режим сброшен для безопасности.', 'warning');
    }, CONFIG.requestTimeoutMs + 5000);

    setSaveStatus('Сохраняю блок без полной перерисовки процесса…', 'loading');
  }

  function getSafeBlockCoords(snapshot = null, offsetIndex = 0) {
    const submitted = snapshot?.coords || {};
    if (Number.isFinite(submitted.left) && Number.isFinite(submitted.top) &&
        (submitted.left !== 0 || submitted.top !== 0)) {
      return {
        left: Math.max(0, submitted.left + offsetIndex * 26),
        top: Math.max(0, submitted.top + offsetIndex * 26),
      };
    }

    const plugin = getFlowchartPlugin();
    const scale = Number(plugin?.panzoomSettings?.currentScale) || 1;
    const container =
      plugin?.flowchartSelectable?.container ||
      document.querySelector('.panzoom-container');

    const $container = container ? $(container) : $('.panzoom-container');
    const left = Math.max(0, Number($container.scrollLeft() || 0) / scale + 80 + offsetIndex * 26);
    const top = Math.max(0, Number($container.scrollTop() || 0) / scale + 80 + offsetIndex * 26);
    return { left, top };
  }

  function updateBlockTitleLocally(blockId, title) {
    const blockEl = document.getElementById(`fwb${blockId}`);
    const blockData = findPluginBlockData(blockId);
    const safeTitle = String(title || '').trim() || `Блок ${blockId}`;

    if (blockData) {
      const previousName = blockData.name;
      blockData.name = safeTitle;
      if (!blockData.label || blockData.label === previousName) {
        blockData.label = safeTitle;
      }
    }

    if (blockEl) {
      const nameEl =
        blockEl.querySelector('.flowchart-block-name') ||
        blockEl.querySelector('.flowchart-block-title') ||
        blockEl.querySelector(':scope > span');

      if (nameEl) {
        nameEl.textContent = safeTitle;
      } else {
        blockEl.prepend(Object.assign(document.createElement('span'), {
          className: 'flowchart-block-name',
          textContent: safeTitle,
        }));
      }

      blockEl.classList.add(classes.localDirty);
    }

    return blockEl;
  }

  function makeLocalBlockHtml(title, blockId) {
    return `
      <span class="flowchart-block-name">${escapeHtml(title)}</span>
      <div class="text-muted small">(idS: ${escapeHtml(blockId)})</div>
      <div class="dazy-gc-local-badge">локально — нужна синхронизация</div>
    `;
  }

  function installLocalBlockBehaviour(blockEl) {
    if (!blockEl || state.localBlockHandlers.has(blockEl)) return;

    const openHandler = event => {
      if (state.linkMode) return;
      if (event.type === 'dblclick' || event.detail === 2) {
        event.preventDefault();
        event.stopPropagation();
        const id = getBlockId(blockEl);
        const plugin = getFlowchartPlugin();
        try {
          if (typeof plugin?.openScriptWindow === 'function') {
            plugin.openScriptWindow(Number(id) || id);
          } else {
            plugin?.scriptModalEl?.scriptWindow?.('openScript', plugin.options.missionId, Number(id) || id);
          }
        } catch (error) {
          warn('Не удалось открыть локально добавленный блок:', error);
        }
      }
    };

    blockEl.addEventListener('dblclick', openHandler, true);
    state.localBlockHandlers.set(blockEl, openHandler);

    const instance = getJsPlumbInstance();
    try {
      instance?.manage?.(blockEl);
    } catch (_) {}

    try {
      instance?.draggable?.([blockEl.id], {
        stop(event) {
          const el = event?.el || blockEl;
          const left = parseFloat(el.style.left || '0') || 0;
          const top = parseFloat(el.style.top || '0') || 0;
          const id = getBlockId(el);
          const data = findPluginBlockData(id);
          if (data) data.coord = { left, top };

          $.ajax({
            url: '/pl/tasks/mission/move-scripts',
            type: 'POST',
            dataType: 'json',
            data: {
              blocks: {
                [id]: {
                  coord: { top, left },
                  sectionId: resolveBlockSectionContext(el).sectionId ?? null,
                },
              },
            },
          });
        },
      });
    } catch (error) {
      log('Минимальный drag для локального блока не установлен:', error);
    }
  }

  function createLocalPlaceholder({
    id,
    title,
    scriptType,
    blockType = '',
    operationType = '',
    blockKind = '',
    coords,
    sourceBlock = null,
    copied = false,
  }) {
    const plugin = getFlowchartPlugin();
    const container =
      plugin?.container?.[0] ||
      document.querySelector('.flowchart-container');

    if (!plugin || !container || !id) return null;

    const sourceSectionContext = sourceBlock
      ? resolveBlockSectionContext(sourceBlock)
      : {
          sectionId: null,
          insideSection: false,
          resolved: true,
          source: 'none',
        };

    const sourceGroup = sourceBlock
      ? getJsPlumbGroupForBlock(sourceBlock)
      : null;

    const sourceParent = sourceBlock?.parentElement || null;
    const localParent =
      sourceSectionContext.insideSection &&
      sourceSectionContext.resolved &&
      sourceParent
        ? sourceParent
        : container;

    let blockEl = document.getElementById(`fwb${id}`);
    if (blockEl) {
      updateBlockTitleLocally(id, title);
      blockEl.classList.add(classes.localUnsynced);
      return blockEl;
    }

    const resolvedKind =
      blockKind ||
      inferBlockKind({
        sourceBlock,
        scriptType,
        blockType,
        operationType,
      });

    const sourceCloneAllowed = canCloneBlockLocally(sourceBlock);
    const standaloneAllowed = canCreateStandalonePlaceholder(resolvedKind);

    if (!sourceCloneAllowed && !standaloneAllowed) {
      return null;
    }

    const cssClass = getBlockCssClass(resolvedKind, sourceBlock);
    if (!cssClass) return null;

    const safeCoords = coords || getSafeBlockCoords(null, 0);
    blockEl = sourceCloneAllowed
      ? sourceBlock.cloneNode(true)
      : document.createElement('div');

    blockEl.id = `fwb${id}`;
    blockEl.dataset.id = String(id);
    [...blockEl.classList].forEach(className => {
      if (
        className === 'flowchart-selected' ||
        className.startsWith('jtk-') ||
        className.startsWith('_jsPlumb_') ||
        className === classes.source ||
        className === classes.targetCandidate ||
        className === classes.targetPending ||
        className === classes.targetConflict
      ) {
        blockEl.classList.remove(className);
      }
    });

    blockEl.classList.add(
      'flowchart-block',
      'flowchart-selectable',
      cssClass,
      classes.localDirty,
      classes.localUnsynced
    );

    blockEl.style.position = 'absolute';
    blockEl.style.left = `${Math.max(0, Number(safeCoords.left) || 0)}px`;
    blockEl.style.top = `${Math.max(0, Number(safeCoords.top) || 0)}px`;

    const displayTitle = copied && !/\(копия\)$/i.test(title)
      ? `${title} (копия)`
      : title;

    if (sourceCloneAllowed) {
      blockEl
        .querySelectorAll(
          '.jtk-endpoint, ._jsPlumb_endpoint, .jtk-connector, ' +
          '._jsPlumb_connector, .jtk-overlay, ._jsPlumb_overlay, ' +
          '.dazy-gc-local-badge'
        )
        .forEach(node => node.remove());

      const titleEl =
        blockEl.querySelector('.flowchart-block-name') ||
        blockEl.querySelector('.flowchart-block-title') ||
        blockEl.querySelector(':scope > span');

      if (titleEl) titleEl.textContent = displayTitle;

      const badge = document.createElement('div');
      badge.className = 'dazy-gc-local-badge';
      badge.textContent = 'локально — нужна синхронизация';
      blockEl.appendChild(badge);
    } else {
      blockEl.innerHTML = makeLocalBlockHtml(displayTitle, id);
    }

    localParent.appendChild(blockEl);

    // jsPlumb group.add может переподключить DOM-родителя и пересчитать offsets.
    // После добавления в группу координаты повторно фиксируются ниже.
    const sourceData = sourceBlock
      ? findPluginBlockData(getBlockId(sourceBlock))
      : null;
    const blockData = {
      ...(sourceData ? JSON.parse(JSON.stringify(sourceData)) : {}),
      id: Number(id) || id,
      name: displayTitle,
      label: displayTitle,
      cssClass,
      htmlBlock: null,
      coord: {
        left: Math.max(0, Number(safeCoords.left) || 0),
        top: Math.max(0, Number(safeCoords.top) || 0),
      },
      __dazyLocalPlaceholder: true,
      __dazyBlockKind: resolvedKind,
      sectionId:
        sourceSectionContext.insideSection &&
        sourceSectionContext.resolved
          ? sourceSectionContext.sectionId
          : null,
    };

    if (!Array.isArray(plugin.blocks)) plugin.blocks = normalizeArray(plugin.blocks);
    if (!findPluginBlockData(id)) plugin.blocks.push(blockData);

    installLocalBlockBehaviour(blockEl);

    if (
      sourceBlock &&
      sourceSectionContext.insideSection &&
      sourceSectionContext.resolved &&
      sourceGroup?.add
    ) {
      try {
        sourceGroup.add(blockEl);
        blockData.sectionId = sourceSectionContext.sectionId;

        // В некоторых версиях jsPlumb addToGroup меняет offset при reparent.
        // Возвращаем серверные локальные координаты копии.
        blockEl.style.position = 'absolute';
        blockEl.style.left =
          `${Math.max(0, Number(safeCoords.left) || 0)}px`;
        blockEl.style.top =
          `${Math.max(0, Number(safeCoords.top) || 0)}px`;

        try {
          getJsPlumbInstance()?.revalidate?.(blockEl);
          getJsPlumbInstance()?.repaint?.(blockEl);
        } catch (_) {}
      } catch (error) {
        warn(
          'Локальная копия создана, но не добавлена в jsPlumb-секцию:',
          error
        );
      }
    }

    return blockEl;
  }

  function handleModalSaved(_event, data) {
    if (!state.fastSaveEnabled) return;

    const pending = state.pendingModalSave;
    if (!pending) return;

    const scriptId = String(data?.scriptId || pending.scriptId || '');
    const scriptType = String(data?.scriptType || pending.blockType || 'operation');
    const isInsert = Boolean(data?.isInsert);
    const existingBlock =
      document.getElementById(`fwb${scriptId}`) ||
      pending.sourceBlock ||
      null;

    const blockKind = inferBlockKind({
      sourceBlock: existingBlock,
      scriptType,
      blockType: pending.blockType,
      operationType: pending.operationType,
    });

    if (!scriptId) {
      clearPendingSave();
      setSaveStatus('GetCourse сохранил блок, но не вернул его ID. Выполни полную синхронизацию.', 'warning');
      return;
    }

    if (isInsert) {
      const coords = getSafeBlockCoords(pending, 0);
      const placeholder = createLocalPlaceholder({
        id: scriptId,
        title: pending.title,
        scriptType,
        blockType: pending.blockType,
        operationType: pending.operationType,
        blockKind,
        coords,
      });

      markLocalChange(
        'create-block',
        {
          scriptId,
          scriptType,
          blockKind,
          title: pending.title,
          localPlaceholder: Boolean(placeholder),
        }
      );

      if (!placeholder) {
        clearPendingSave();
        setSaveStatus(
          `Блок ${scriptId} типа «${blockKind || scriptType}» сохранён. ` +
          'Для безопасного отображения выполняю полную синхронизацию.',
          'warning'
        );
        scheduleSafeFullSync(`новый тип блока: ${blockKind || scriptType}`);
        return;
      }

      setSaveStatus(
        blockKind === 'operation'
          ? `Заготовка блока ${scriptId} создана. GetCourse откроет второй этап настройки без перерисовки.`
          : `Блок ${scriptId} создан локально. Endpoint’ы появятся после полной синхронизации.`,
        'success'
      );
    } else {
      const blockEl = updateBlockTitleLocally(scriptId, pending.title);

      if (!blockEl) {
        const placeholder = createLocalPlaceholder({
          id: scriptId,
          title: pending.title,
          scriptType,
          blockType: pending.blockType,
          operationType: pending.operationType,
          blockKind,
          coords: getSafeBlockCoords(pending, 0),
        });

        if (!placeholder) {
          clearPendingSave();
          setSaveStatus(
            `Блок ${scriptId} сохранён, но его локальный тип не распознан. ` +
            'Выполняю безопасную синхронизацию.',
            'warning'
          );
          scheduleSafeFullSync(`неизвестный локальный тип: ${blockKind || scriptType}`);
          return;
        }
      }

      const localUnsyncedBlock = document.getElementById(`fwb${scriptId}`);
      const complexLocalFinalSave =
        localUnsyncedBlock?.classList.contains(classes.localUnsynced) &&
        !SAFE_STANDALONE_PLACEHOLDER_KINDS.has(blockKind);

      markLocalChange(
        'save-block',
        { scriptId, scriptType, blockKind, title: pending.title }
      );

      if (complexLocalFinalSave) {
        clearPendingSave();
        setSaveStatus(
          `Настройки сложного блока ${scriptId} сохранены. ` +
          'Обновляю его штатную структуру и выходы.',
          'warning'
        );
        scheduleSafeFullSync(`финальная настройка блока: ${blockKind}`);
        return;
      }

      setSaveStatus(`Блок ${scriptId} сохранён без полной перерисовки.`, 'success');
    }

    clearPendingSave();
  }

  function patchFlowchartLoadData() {
    const plugin = getFlowchartPlugin();
    if (!plugin || typeof plugin.loadData !== 'function') {
      warn('Не удалось найти flowchartPlugin.loadData. Быстрое сохранение не установлено.');
      return false;
    }

    if (plugin.loadData.__dazyFastSaveV130Safe) {
      state.originalLoadData = plugin.loadData.__dazyOriginal;
      state.loadDataPatched = true;
      return true;
    }

    const original = plugin.loadData;
    state.originalLoadData = original;

    function patchedLoadData(normalize, callback) {
      if (
        state.fastSaveEnabled &&
        !state.forceReload &&
        state.skipReloadBudget > 0
      ) {
        state.skipReloadBudget -= 1;
        $('body').css('cursor', '');
        log('Автоматическая flowchart-data перерисовка пропущена.', {
          remaining: state.skipReloadBudget,
          pending: state.pendingModalSave,
        });

        if (typeof callback === 'function') {
          queueMicrotask(callback);
        }
        return undefined;
      }

      return original.apply(this, arguments);
    }

    patchedLoadData.__dazyFastSaveV130Safe = true;
    patchedLoadData.__dazyOriginal = original;
    plugin.loadData = patchedLoadData;
    state.loadDataPatched = true;
    return true;
  }

  function toggleFastSave(enabled) {
    state.fastSaveEnabled = Boolean(enabled);
    const button = state.panel?.querySelector('[data-role="fast-save-toggle"]');
    if (button) {
      button.classList.toggle('is-active', state.fastSaveEnabled);
      button.textContent = state.fastSaveEnabled
        ? 'Быстрое сохранение: включено'
        : 'Быстрое сохранение: выключено';
    }

    if (!state.fastSaveEnabled) {
      clearPendingSave();
      setSaveStatus('Штатные сохранения снова будут полностью перерисовывать процесс.', 'warning');
    } else {
      setSaveStatus('Автоматическая полная перерисовка после сохранения блоков отключена.', 'success');
    }

    saveSettings();
  }

  function waitForSyncFinish(callback) {
    let completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      state.forceReload = false;
      state.busy = false;
      setPanelDisabled(false);
      setSaveStatus('Полная синхронизация не завершилась за отведённое время.', 'error');
    }, CONFIG.syncTimeoutMs);

    return () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      state.forceReload = false;
      state.busy = false;
      setPanelDisabled(false);
      resetLocalChanges();
      setSaveStatus('Процесс полностью синхронизирован с сервером.', 'success');
      if (typeof callback === 'function') callback();
    };
  }

  function fullSync(reason = 'manual') {
    if (state.busy) return;
    finishLightDrag('full-sync', true);
    clearLocalCopyConnections();
    clearSelectionState('before-full-sync');

    const plugin = getFlowchartPlugin();
    installSectionRenderGuard();
    state.sectionGroupQueue = [];
    clearSectionGroupFlushTimer();

    const original = state.originalLoadData || plugin?.loadData?.__dazyOriginal;
    if (!plugin || typeof original !== 'function') {
      setSaveStatus('Не найдена штатная функция полной синхронизации.', 'error');
      return;
    }

    state.busy = true;
    state.forceReload = true;
    clearPendingSave();
    setPanelDisabled(true);
    setSaveStatus(
      reason === 'manual'
        ? 'Полностью загружаю и перерисовываю процесс…'
        : `Аварийная синхронизация: ${String(reason).slice(0, 120)}`,
      'loading'
    );

    const finishBase = waitForSyncFinish(() => {
      flushSectionGroupQueue(true);

      // loadData может создать новый Selectable и одновременно оставить
      // внутренние ссылки предыдущего экземпляра. Очищаем состояние после
      // завершения DOM-render и ещё раз на следующем animation frame.
      clearSelectionState('after-full-sync');

      requestAnimationFrame(() => {
        clearSelectionState('after-full-sync-frame');
      });
    });

    const finish = () => {
      installSectionRenderGuard();
      flushSectionGroupQueue(true);
      finishBase();
    };

    try {
      original.call(plugin, false, finish);
    } catch (error) {
      state.forceReload = false;
      state.busy = false;
      setPanelDisabled(false);
      setSaveStatus(`Ошибка полной синхронизации: ${responseErrorText(error).slice(0, 240)}`, 'error');
    }
  }

  function parseCopiedBlockIds() {
    const raw = String(localStorage.getItem('copied_blocks') || '').trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (_) {}

    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }

  function getSelectedBlockIds() {
    return getVisualSelectedBlockIds();
  }

  function normalizePasteBlockIds(value) {
    if (!value) return [];

    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean);
    }

    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    }

    if (typeof value === 'object') {
      return Object.values(value).flatMap(normalizePasteBlockIds);
    }

    return [];
  }

  function clearLocalCopyConnections() {
    const items = state.localCopyConnections.splice(0);
    if (!items.length) return 0;

    try {
      runJsPlumbWithoutServer(instance => {
        items.forEach(connection => {
          try {
            if (connection && typeof instance.deleteConnection === 'function') {
              instance.deleteConnection(connection);
            }
          } catch (_) {}
        });
      });
    } catch (_) {}

    return items.length;
  }

  function getInternalCopiedConnectionSpecs(sourceIds) {
    const sourceSet = new Set(sourceIds.map(String));
    const seen = new Set();

    return getConnections()
      .map(connection => {
        const sourceId = normalizeDomBlockId(
          getConnectionSourceId(connection)
        );
        const targetId = normalizeDomBlockId(
          getConnectionTargetId(connection)
        );

        if (!sourceSet.has(sourceId) || !sourceSet.has(targetId)) {
          return null;
        }

        const key = [
          sourceId,
          targetId,
          getConnectionUuid(connection),
          getConnectionResultKey(connection),
        ].join('|');

        if (seen.has(key)) return null;
        seen.add(key);

        return {
          sourceId,
          targetId,
          label: getConnectionLabel(connection),
          resultKey: getConnectionResultKey(connection),
        };
      })
      .filter(Boolean);
  }

  function makeLocalCopyConnectionParams(sourceEl, targetEl, spec) {
    const resultKey = normalizeResultKey(spec?.resultKey);
    const label = String(spec?.label || '').trim();

    const overlays = [
      [
        'Arrow',
        {
          location: 1,
          width: 8,
          length: 8,
          foldback: 0.82,
        },
      ],
    ];

    if (label && !/^выход$/i.test(label)) {
      overlays.push([
        'Label',
        {
          label,
          cssClass:
            `flowchart-connection-label ` +
            `flowchart-connection-label--${resultKey}`,
          location: 0.5,
        },
      ]);
    }

    return {
      source: sourceEl,
      target: targetEl,
      anchors: ['Continuous', 'Continuous'],
      endpoint: 'Blank',
      connector: [
        'Flowchart',
        {
          stub: 18,
          gap: 2,
          cornerRadius: 5,
          alwaysRespectStubs: true,
        },
      ],
      paintStyle: {
        stroke: '#94a3b8',
        strokeWidth: 2,
      },
      hoverPaintStyle: {
        stroke: '#64748b',
        strokeWidth: 2,
      },
      overlays,
      detachable: false,
      reattach: false,
    };
  }

  function createLocalCopiedConnections(sourceIds, createdIds, specs = null) {
    const mapping = new Map();

    sourceIds.forEach((sourceId, index) => {
      const createdId = createdIds[index];
      if (createdId) mapping.set(String(sourceId), String(createdId));
    });

    const connectionSpecs =
      Array.isArray(specs)
        ? specs
        : getInternalCopiedConnectionSpecs(sourceIds);

    if (!connectionSpecs.length) return 0;

    let createdCount = 0;

    try {
      runJsPlumbWithoutServer(instance => {
        connectionSpecs.forEach(spec => {
          const copiedSourceId = mapping.get(String(spec.sourceId));
          const copiedTargetId = mapping.get(String(spec.targetId));
          if (!copiedSourceId || !copiedTargetId) return;

          const sourceEl = document.getElementById(`fwb${copiedSourceId}`);
          const targetEl = document.getElementById(`fwb${copiedTargetId}`);
          if (!sourceEl || !targetEl) return;

          try {
            const connection = instance.connect(
              makeLocalCopyConnectionParams(sourceEl, targetEl, spec)
            );

            if (!connection) return;

            connection.__dazyLocalCopyConnection = true;
            connection.saved = true;

            try {
              connection.addClass?.('dazy-gc-local-copy-connection');
            } catch (_) {}

            state.localCopyConnections.push(connection);
            createdCount += 1;
          } catch (error) {
            warn('Не удалось отрисовать локальную связь копий:', error, spec);
          }
        });

        mapping.forEach(createdId => {
          const blockEl = document.getElementById(`fwb${createdId}`);
          if (blockEl) instance.repaint?.(blockEl);
        });
      });
    } catch (error) {
      warn('Не удалось создать локальные связи копий:', error);
    }

    return createdCount;
  }

  function buildCopiedPlacementPlan(sourceIds, createdIds, offset = 38) {
    const safeOffset = Number.isFinite(Number(offset))
      ? Number(offset)
      : 38;

    return createdIds.map((createdId, index) => {
      const sourceId =
        sourceIds[index] ||
        sourceIds[index % Math.max(sourceIds.length, 1)] ||
        '';

      const sourceBlock = document.getElementById(`fwb${sourceId}`);
      const sourcePosition = sourceBlock
        ? getBlockPosition(sourceBlock)
        : getSafeBlockCoords(null, index);

      const sectionContext = sourceBlock
        ? resolveBlockSectionContext(sourceBlock)
        : {
            sectionId: null,
            insideSection: false,
            resolved: true,
            source: 'none',
          };

      return {
        createdId: String(createdId),
        sourceId: String(sourceId),
        sourceBlock,
        sectionContext,
        coords: {
          left: Math.max(
            0,
            Math.round((Number(sourcePosition.left) + safeOffset) * 100) / 100
          ),
          top: Math.max(
            0,
            Math.round((Number(sourcePosition.top) + safeOffset) * 100) / 100
          ),
        },
      };
    });
  }

  function persistCopiedPlacementPlan(plan) {
    const blocks = {};

    plan.forEach(item => {
      if (!item?.createdId) return;

      blocks[item.createdId] = {
        coord: {
          top: item.coords.top,
          left: item.coords.left,
        },
        sectionId:
          item.sectionContext?.insideSection &&
          item.sectionContext?.resolved
            ? item.sectionContext.sectionId
            : null,
      };
    });

    if (!Object.keys(blocks).length) {
      return Promise.resolve({ success: true, skipped: true });
    }

    return ajaxPromise({
      url: '/pl/tasks/mission/move-scripts',
      type: 'POST',
      dataType: 'json',
      data: { blocks },
    });
  }

  function readPasteRequest(options) {
    const data = options?.data || {};
    const coordsSource = data.coords || {};

    const top = Number(
      coordsSource.top ??
      data['coords[top]'] ??
      0
    );
    const left = Number(
      coordsSource.left ??
      data['coords[left]'] ??
      0
    );

    return {
      sourceIds: normalizePasteBlockIds(data.blocks),
      coords: {
        top: Number.isFinite(top) ? Math.trunc(top) : 0,
        left: Number.isFinite(left) ? Math.trunc(left) : 0,
      },
    };
  }

  function prepareNativePaste(sourceIds, options = {}) {
    const ids = [...new Set(normalizePasteBlockIds(sourceIds))];
    if (!ids.length) {
      setSaveStatus('Не найдено блоков для копирования.', 'error');
      return null;
    }

    const pending = {
      sourceIds: ids,
      closeModal: Boolean(options.closeModal),
      requestedBy: options.requestedBy || 'native-paste',
      resolve: options.resolve || null,
      reject: options.reject || null,
      startedAt: Date.now(),
    };

    state.nativePastePending = pending;
    setSaveStatus(`Копирую блоков: ${ids.length} штатным механизмом GetCourse…`, 'loading');
    return pending;
  }

  function clearNativePasteTimer() {
    if (state.nativePasteTimer) {
      clearTimeout(state.nativePasteTimer);
      state.nativePasteTimer = null;
    }
  }

  function handleNativePasteSuccess(response, requestOptions) {
    const payload = assertSuccessfulResponse({ data: response }, 'Копирование блоков');
    const createdIds = normalizeArray(payload?.data?.created_ids)
      .map(String)
      .filter(Boolean);

    if (!createdIds.length) {
      throw new Error(payload?.message || 'GetCourse не вернул created_ids.');
    }

    const request = readPasteRequest(requestOptions);
    const pending = state.nativePastePending;
    const sourceIds =
      pending?.sourceIds?.length
        ? pending.sourceIds
        : request.sourceIds;

    const sourceBlocks = sourceIds.map(
      id => document.getElementById(`fwb${id}`)
    );

    const internalConnectionSpecs =
      getInternalCopiedConnectionSpecs(sourceIds);

    const placementPlan =
      buildCopiedPlacementPlan(sourceIds, createdIds, 38);

    createdIds.forEach((createdId, index) => {
      const placement = placementPlan[index];

      const source =
        placement?.sourceBlock ||
        sourceBlocks[index] ||
        sourceBlocks[index % Math.max(sourceBlocks.length, 1)] ||
        null;

      const sourceTitle = source
        ? getBlockTitle(source)
        : `Копия блока ${sourceIds[index] || sourceIds[0] || ''}`.trim();

      const sourceKind = inferBlockKind({ sourceBlock: source });
      const sectionContext = source
        ? resolveBlockSectionContext(source)
        : {
            insideSection: false,
            resolved: true,
            sectionId: null,
            source: 'none',
          };

      const fastCopyAllowed =
        Boolean(source) &&
        !isSectionBlock(source);

      if (!fastCopyAllowed) {
        request.__dazyRequiresInternalSync = true;
        return;
      }

      const placeholder = createLocalPlaceholder({
        id: createdId,
        title: sourceTitle,
        scriptType: sourceKind || 'operation',
        blockKind: sourceKind,
        coords:
          placement?.coords ||
          getSafeBlockCoords({ coords: request.coords }, index),
        sourceBlock: source,
        copied: true,
      });

      if (!placeholder) {
        request.__dazyRequiresInternalSync = true;
      }
    });

    const copiedConnectionCount = request.__dazyRequiresInternalSync
      ? 0
      : createLocalCopiedConnections(
          sourceIds,
          createdIds,
          internalConnectionSpecs
        );

    markLocalChange(
      'paste-blocks',
      {
        sourceIds,
        createdIds,
        requestedBy: pending?.requestedBy || 'native-paste',
        copiedConnectionCount,
        placementPlan: placementPlan.map(item => ({
          createdId: item.createdId,
          sourceId: item.sourceId,
          coords: item.coords,
          sectionId:
            item.sectionContext?.insideSection &&
            item.sectionContext?.resolved
              ? item.sectionContext.sectionId
              : null,
        })),
      },
      createdIds.length
    );

    if (pending?.closeModal) {
      closeBlockModal();
    }

    pending?.resolve?.(createdIds);

    if (request.__dazyRequiresInternalSync) {
      setSaveStatus(
        `Создано копий: ${createdIds.length}. Для секции выполняю внутреннюю ` +
        'синхронизацию без обновления страницы.',
        'warning'
      );
      scheduleSafeFullSync('копирование секции', 120);
    } else {
      scheduleSelectCopiedBlocks(createdIds);

      setSaveStatus(
        `Создано копий: ${createdIds.length}. Сохраняю положение копий рядом ` +
        'с оригиналами; новая группа уже готовится к выделению…',
        'loading'
      );

      persistCopiedPlacementPlan(placementPlan)
        .then(() => {
          scheduleSelectCopiedBlocks(createdIds);

          setSaveStatus(
            copiedConnectionCount
              ? `Создано копий: ${createdIds.length}; внутренних связей: ${copiedConnectionCount}. ` +
                'Новая группа выделена и готова к перемещению без синхронизации.'
              : `Создано копий: ${createdIds.length}. Новая группа выделена и ` +
                'готова к перемещению без синхронизации.',
            'success'
          );
        })
        .catch(error => {
          setSaveStatus(
            `Копии созданы, но их положение не удалось сохранить. ` +
            `Выполняю безопасную синхронизацию: ` +
            `${responseErrorText(error).slice(0, 180)}`,
            'warning'
          );
          scheduleSafeFullSync('не удалось сохранить координаты копий', 140);
        });
    }

    return createdIds;
  }


  function readDeleteRequest(options) {
    const data = options?.data || {};
    return {
      blockIds: [...new Set(normalizePasteBlockIds(data.blocks))],
    };
  }

  function normalizeDomBlockId(value) {
    return String(value || '').replace(/^fwb/, '');
  }

  function pluginConnectionReferencesDeletedBlock(connection, deletedIds) {
    const sourceId = normalizeDomBlockId(
      connection?.sourceId ||
      connection?.source?.id ||
      connection?.fromBlockId ||
      connection?.sourceBlockId ||
      ''
    );

    const targetId = normalizeDomBlockId(
      connection?.targetId ||
      connection?.target?.id ||
      connection?.toBlockId ||
      connection?.targetBlockId ||
      ''
    );

    const uuid = String(
      connection?.fromUuid ||
      connection?.sourceUuid ||
      connection?.uuid ||
      ''
    );

    return (
      deletedIds.has(sourceId) ||
      deletedIds.has(targetId) ||
      [...deletedIds].some(id => uuid === id || uuid.startsWith(`${id}-`))
    );
  }

  function cleanupPluginModelAfterDelete(blockIds) {
    const plugin = getFlowchartPlugin();
    if (!plugin) return;

    const deletedIds = new Set(blockIds.map(String));

    if (Array.isArray(plugin.blocks)) {
      plugin.blocks = plugin.blocks.filter(
        block => !deletedIds.has(String(block?.id || ''))
      );
    }

    if (plugin.endpoints && typeof plugin.endpoints === 'object') {
      if (Array.isArray(plugin.endpoints)) {
        plugin.endpoints = plugin.endpoints.filter(endpoint => {
          const uuid = String(
            endpoint?.uuid ||
            endpoint?.fromUuid ||
            endpoint?.id ||
            ''
          );
          const blockId = String(
            endpoint?.blockId ||
            endpoint?.scriptId ||
            endpoint?.elementId ||
            ''
          ).replace(/^fwb/, '');

          return !(
            deletedIds.has(blockId) ||
            [...deletedIds].some(id => uuid === id || uuid.startsWith(`${id}-`))
          );
        });
      } else {
        Object.keys(plugin.endpoints).forEach(key => {
          const endpoint = plugin.endpoints[key];
          const uuid = String(
            endpoint?.uuid ||
            endpoint?.fromUuid ||
            key ||
            ''
          );
          const blockId = String(
            endpoint?.blockId ||
            endpoint?.scriptId ||
            endpoint?.elementId ||
            ''
          ).replace(/^fwb/, '');

          if (
            deletedIds.has(blockId) ||
            [...deletedIds].some(id => uuid === id || uuid.startsWith(`${id}-`))
          ) {
            delete plugin.endpoints[key];
          }
        });
      }
    }

    if (Array.isArray(plugin.connections)) {
      plugin.connections = plugin.connections.filter(
        connection => !pluginConnectionReferencesDeletedBlock(connection, deletedIds)
      );
    }

    if (Array.isArray(plugin.blocksInSections)) {
      plugin.blocksInSections = plugin.blocksInSections.filter(item => {
        const blockId = String(
          item?.blockId ||
          item?.scriptId ||
          item?.id ||
          ''
        );
        return !deletedIds.has(blockId);
      });
    }
  }

  function removeLocalBlockHandler(blockEl) {
    const handler = state.localBlockHandlers.get(blockEl);
    if (handler) {
      try {
        blockEl.removeEventListener('dblclick', handler, true);
      } catch (_) {}
      state.localBlockHandlers.delete(blockEl);
    }
  }

  function removeBlocksLocally(blockIds) {
    const ids = [...new Set(blockIds.map(String).filter(Boolean))];
    if (!ids.length) {
      throw new Error('GetCourse не передал ID удаляемых блоков.');
    }

    const plugin = getFlowchartPlugin();
    const instance = getJsPlumbInstance();

    if (!plugin || !instance) {
      throw new Error('Не найдена активная модель jsPlumb.');
    }

    const deletedIds = new Set(ids);
    const blocks = ids
      .map(id => document.getElementById(`fwb${id}`))
      .filter(Boolean);

    const unsupported = ids.filter(id => {
      const element =
        document.getElementById(`fwb${id}`) ||
        document.querySelector(`.flowchart-section[data-id="${CSS.escape(id)}"]`);
      return element && !element.classList.contains('flowchart-block');
    });

    if (unsupported.length) {
      throw new Error(
        `Локальное удаление секций пока не поддерживается: ${unsupported.join(', ')}`
      );
    }

    const connectedBefore = getConnections().filter(connection => {
      const sourceId = normalizeDomBlockId(getConnectionSourceId(connection));
      const targetId = normalizeDomBlockId(getConnectionTargetId(connection));
      return deletedIds.has(sourceId) || deletedIds.has(targetId);
    });

    if (
      state.sourceBlock &&
      deletedIds.has(String(getBlockId(state.sourceBlock)))
    ) {
      resetLinkSelection();
      setLinkStatus('Исходный блок удалён. Выбор быстрых связей сброшен.', 'normal');
    }

    const previousInitialized = plugin.initialized;
    plugin.initialized = false;

    try {
      try {
        instance.clearDragSelection?.();
      } catch (_) {}

      try {
        plugin.flowchartSelectable?.deselectAll?.();
      } catch (_) {}

      blocks.forEach(blockEl => {
        removeLocalBlockHandler(blockEl);

        let removedByJsPlumb = false;

        if (typeof instance.remove === 'function') {
          try {
            instance.remove(blockEl, true);
            removedByJsPlumb = !document.documentElement.contains(blockEl);
          } catch (error) {
            log('instance.remove не смог удалить блок, использую резервный путь:', error);
          }
        }

        if (!removedByJsPlumb) {
          try {
            instance.deleteConnectionsForElement?.(blockEl, { fireEvent: false });
          } catch (_) {}

          try {
            instance.removeAllEndpoints?.(blockEl, true);
          } catch (_) {}

          try {
            instance.unmanage?.(blockEl);
          } catch (_) {}

          blockEl.remove();
        }
      });
    } finally {
      plugin.initialized = previousInitialized;
    }

    cleanupPluginModelAfterDelete(ids);

    try {
      plugin.flowchartSelectable?.update?.();
    } catch (_) {}

    const selectedRemain = document.querySelectorAll(
      '.flowchart-block.flowchart-selected'
    ).length;

    if (!selectedRemain) {
      $('.flowchart-selected-blocks-btn').prop('disabled', true);
    }

    return {
      deletedIds: ids,
      removedDomBlocks: blocks.length,
      removedConnections: connectedBefore.length,
    };
  }

  function handleNativeDeleteSuccess(response, requestOptions) {
    assertSuccessfulResponse({ data: response }, 'Удаление блоков');

    const request = readDeleteRequest(requestOptions);
    if (!request.blockIds.length) {
      throw new Error('Не удалось определить ID удалённых блоков.');
    }

    const result = removeBlocksLocally(request.blockIds);
    clearSelectionState('after-delete');

    markLocalChange(
      'delete-blocks',
      {
        deletedIds: result.deletedIds,
        removedConnections: result.removedConnections,
      },
      result.deletedIds.length
    );

    setSaveStatus(
      result.deletedIds.length === 1
        ? `Блок ${result.deletedIds[0]} удалён без полной перерисовки.`
        : `Удалено блоков: ${result.deletedIds.length}. Полная перерисовка пропущена.`,
      'success'
    );

    return result;
  }

  function patchNativePasteAjax() {
    if (state.ajaxPatched) return true;
    if (typeof $.ajax !== 'function') return false;

    const original = $.ajax;
    state.originalAjax = original;

    function patchedAjax(urlOrOptions, maybeOptions) {
      const options =
        typeof urlOrOptions === 'string'
          ? { ...(maybeOptions || {}), url: urlOrOptions }
          : { ...(urlOrOptions || {}) };

      const url = String(options.url || '');
      const isPaste = url.includes('/pl/tasks/mission/paste-blocks');
      const isDelete = url.includes('/pl/tasks/mission/delete-scripts');

      if (!isPaste && !isDelete) {
        return original.apply(this, arguments);
      }

      if (isDelete) {
        const request = readDeleteRequest(options);
        const selectionAudit =
          sanitizeDeleteBlockIds(request.blockIds);

        if (!selectionAudit.safeIds.length) {
          const rejected = $.Deferred();
          const errorText =
            'Удаление отменено: в текущем процессе нет визуально выделенных блоков.';

          setSaveStatus(errorText, 'warning');

          rejected.reject(
            { status: 0, responseText: errorText },
            'abort',
            errorText
          );

          return rejected.promise();
        }

        const safeOptions = {
          ...options,
          data: {
            ...(options.data || {}),
            blocks: selectionAudit.safeIds,
          },
        };

        if (selectionAudit.mismatch) {
          setSaveStatus(
            `Обнаружено устаревшее внутреннее выделение GetCourse. ` +
            `Удаляю только текущие блоки: ${selectionAudit.safeIds.join(', ')}.`,
            'warning'
          );

          log('Удаление очищено от устаревших ID.', selectionAudit);
        }

        request.blockIds = selectionAudit.safeIds;

        if (state.deleteBusy) {
          const rejected = $.Deferred();
          const errorText = 'Предыдущее удаление ещё выполняется.';
          setSaveStatus(errorText, 'warning');
          rejected.reject({ status: 0, responseText: errorText }, 'abort', errorText);
          return rejected.promise();
        }

        state.deleteBusy = true;
        state.skipReloadBudget = Math.max(state.skipReloadBudget, 1);
        setSaveStatus(
          request.blockIds.length === 1
            ? `Удаляю блок ${request.blockIds[0]} без полной перерисовки…`
            : `Удаляю блоков: ${request.blockIds.length} без полной перерисовки…`,
          'loading'
        );

        const jqXHR = original.call(this, safeOptions);

        jqXHR
          .done(response => {
            try {
              handleNativeDeleteSuccess(response, safeOptions);
            } catch (error) {
              // Штатный done-handler GetCourse вызовет reload сразу после нашего.
              // Снимаем бюджет пропуска, чтобы он выполнил безопасную синхронизацию.
              state.skipReloadBudget = 0;
              setSaveStatus(
                `Блоки удалены на сервере, но локальная очистка не удалась. GetCourse выполнит полную синхронизацию: ${responseErrorText(error).slice(0, 220)}`,
                'warning'
              );
            }
          })
          .fail((jqXHRValue, textStatus, errorThrown) => {
            state.skipReloadBudget = 0;
            setSaveStatus(
              `Удаление GetCourse завершилось ошибкой ${jqXHRValue?.status || ''}: ${responseErrorText({ jqXHR: jqXHRValue, textStatus, errorThrown }).slice(0, 220)}`,
              'error'
            );
          })
          .always(() => {
            state.deleteBusy = false;
          });

        return jqXHR;
      }

      const request = readPasteRequest(options);
      const pending =
        state.nativePastePending ||
        prepareNativePaste(request.sourceIds, { requestedBy: 'native-toolbar' });

      state.copyBusy = true;
      state.skipReloadBudget = Math.max(state.skipReloadBudget, 1);
      clearNativePasteTimer();

      const jqXHR = original.apply(this, arguments);

      jqXHR
        .done(response => {
          try {
            handleNativePasteSuccess(response, options);
          } catch (error) {
            state.skipReloadBudget = 0;
            pending?.reject?.(error);
            setSaveStatus(
              `Копирование завершилось, но ответ не удалось обработать: ${responseErrorText(error).slice(0, 260)}`,
              'error'
            );
          }
        })
        .fail((jqXHRValue, textStatus, errorThrown) => {
          state.skipReloadBudget = 0;
          const error = { jqXHR: jqXHRValue, textStatus, errorThrown };
          pending?.reject?.(error);
          setSaveStatus(
            `Штатное копирование GetCourse завершилось ошибкой ${jqXHRValue?.status || ''}: ${responseErrorText(error).slice(0, 220)}`,
            'error'
          );
        })
        .always(() => {
          clearNativePasteTimer();
          state.copyBusy = false;
          if (state.nativePastePending === pending) {
            state.nativePastePending = null;
          }
        });

      return jqXHR;
    }

    patchedAjax.__dazyNativeActionsV130Safe = true;
    patchedAjax.__dazyOriginal = original;
    $.ajax = patchedAjax;
    state.ajaxPatched = true;
    return true;
  }

  function triggerNativePaste(sourceIds, options = {}) {
    const ids = [...new Set(normalizePasteBlockIds(sourceIds))];

    if (!ids.length) {
      const error = new Error('Не найдено блоков для копирования.');
      setSaveStatus(error.message, 'error');
      return Promise.reject(error);
    }

    if (state.copyBusy) {
      const error = new Error('Предыдущее копирование ещё выполняется.');
      setSaveStatus(error.message, 'warning');
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      prepareNativePaste(ids, {
        ...options,
        resolve,
        reject,
      });

      // Штатный интерфейс GetCourse хранит список блоков именно так:
      // массив автоматически превращается localStorage в строку "id1,id2".
      localStorage.setItem('copied_blocks', ids.join(','));

      const pasteButton = $('#flowchart-paste-from-clipboard-blocks-btn');
      if (!pasteButton.length) {
        state.nativePastePending = null;
        reject(new Error('Не найдена штатная кнопка вставки блоков GetCourse.'));
        return;
      }

      pasteButton.prop('disabled', false);

      clearNativePasteTimer();
      state.nativePasteTimer = setTimeout(() => {
        if (!state.nativePastePending) return;
        const error = new Error('Штатный обработчик GetCourse не отправил запрос копирования.');
        state.nativePastePending?.reject?.(error);
        state.nativePastePending = null;
        state.copyBusy = false;
        state.skipReloadBudget = 0;
        setSaveStatus(error.message, 'error');
      }, 5000);

      // Важно: вызываем именно штатный click-handler GetCourse.
      pasteButton.trigger('click');
    });
  }

  async function fastPasteBlocks(blockIds, options = {}) {
    return triggerNativePaste(blockIds, {
      requestedBy: options.requestedBy || 'api',
      closeModal: Boolean(options.closeModal),
    });
  }

  function closeBlockModal() {
    const plugin = getFlowchartPlugin();
    try {
      plugin?.scriptModalEl?.scriptWindow?.('hideEl');
      return;
    } catch (_) {}

    try {
      $('.block-modal-window').modal('hide');
    } catch (_) {}
  }

  async function fastCopyCurrentModal(button) {
    const form = getModalForm(button);
    const { scriptId } = getFormScriptInfo(form);

    if (!scriptId) {
      setSaveStatus('Не удалось определить ID копируемого блока.', 'error');
      return;
    }

    try {
      await triggerNativePaste([scriptId], {
        requestedBy: 'modal-copy',
        closeModal: true,
      });
    } catch (_) {}
  }

  function handleFastSaveCapture(event) {
    const target = event.target;
    if (!(target instanceof Element) || !state.fastSaveEnabled) return;

    const modalCopy = target.closest('.block-modal-window button[name="copy"]');
    if (modalCopy) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (state.copyBusy) {
        setSaveStatus('Предыдущее копирование ещё выполняется.', 'warning');
        return;
      }

      fastCopyCurrentModal(modalCopy);
      return;
    }

    const duplicateButton = target.closest('#flowchart-duplicate-blocks-btn');
    if (duplicateButton) {
      if (state.copyBusy) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setSaveStatus('Предыдущее копирование ещё выполняется.', 'warning');
        return;
      }

      // Не блокируем событие: штатный handler GetCourse сам вызовет Copy → Paste.
      prepareNativePaste(getSelectedBlockIds(), {
        requestedBy: 'toolbar-duplicate',
      });
      return;
    }

    const pasteButton = target.closest('#flowchart-paste-from-clipboard-blocks-btn');
    if (pasteButton) {
      if (state.copyBusy) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setSaveStatus('Предыдущее копирование ещё выполняется.', 'warning');
        return;
      }

      // Не блокируем событие и не формируем POST сами.
      // Снимаем только контекст для локального добавления карточек.
      if (!state.nativePastePending) {
        prepareNativePaste(parseCopiedBlockIds(), {
          requestedBy: 'toolbar-paste',
        });
      }
      return;
    }

    const saveButton = target.closest('.block-modal-window button[name="save"], .block-modal-window input[name="save"]');
    if (saveButton) {
      armFastSave(getModalForm(saveButton), saveButton);
    }
  }

  function handleFastFormSubmit(event) {
    if (!state.fastSaveEnabled) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.block-modal-window')) return;

    const submitter = event.submitter;
    const name = String(submitter?.name || submitter?.getAttribute?.('name') || '');
    if (name === 'copy') return;

    if (!state.pendingModalSave) {
      armFastSave(form, submitter);
    }
  }

  function installFastSave() {
    patchFlowchartLoadData();
    patchNativePasteAjax();

    const modal = $('.block-modal-window');
    state.modalSavedHandler = handleModalSaved;
    modal.off('saved.dazyFastEditorV130Safe').on('saved.dazyFastEditorV130Safe', state.modalSavedHandler);

    state.ajaxErrorHandler = (_event, xhr, settings) => {
      const url = String(settings?.url || '');
      if (!state.pendingModalSave || !url.includes('/pl/tasks/mission/script')) return;

      clearPendingSave();
      setSaveStatus(
        `Сохранение завершилось ошибкой ${xhr?.status || ''}. Полная перерисовка не блокируется.`,
        'error'
      );
    };
    $(document).on('ajaxError.dazyFastEditorV130Safe', state.ajaxErrorHandler);

    state.ajaxCompleteHandler = (_event, xhr, settings) => {
      const url = String(settings?.url || '');
      if (!state.pendingModalSave || !url.includes('/pl/tasks/mission/script')) return;

      let response = xhr?.responseJSON;
      if (!response && xhr?.responseText) {
        try { response = JSON.parse(xhr.responseText); } catch (_) {}
      }

      if (response?.success === false) {
        const message = response?.message || response?.error || 'GetCourse отклонил сохранение.';
        clearPendingSave();
        setSaveStatus(String(message).slice(0, 260), 'error');
      }
    };
    $(document).on('ajaxComplete.dazyFastEditorV130Safe', state.ajaxCompleteHandler);

    addDocumentHandler('click', handleFastSaveCapture, true);
    addDocumentHandler('submit', handleFastFormSubmit, true);

    toggleFastSave(true);
  }

  // ---------------------------------------------------------------------------
  // Проверка сегментов по кнопке
  // ---------------------------------------------------------------------------

  function findRuleHost(element) {
    if (!element) return null;
    if (element.matches?.('[id^="rulePlugin"]')) return element;
    return element.closest?.('[id^="rulePlugin"]') || null;
  }

  function getRuleValueInput(host) {
    if (!host?.id) return null;
    return document.getElementById(`${host.id}Value`);
  }

  function getCurrentRule(host) {
    const input = getRuleValueInput(host);
    if (!input?.value) return null;

    try {
      return JSON.parse(input.value);
    } catch (error) {
      warn('Не удалось прочитать текущее правило:', error);
      return null;
    }
  }

  function saveCurrentRule(host, rule) {
    const input = getRuleValueInput(host);
    if (input) input.value = JSON.stringify(rule);
  }

  function getRulePanel(host) {
    return host?.querySelector(`.${classes.rulePanel}`) || null;
  }

  function setRulePanelStatus(host, text, tone = 'normal') {
    const panel = getRulePanel(host);
    if (!panel) return;

    const status = panel.querySelector('[data-role="rule-status"]');
    if (status) {
      status.textContent = text;
      status.dataset.tone = tone;
    }
  }

  function reinitializeRulePlugin(host, allowTesting) {
    if (!host || typeof state.originalRulePlugin !== 'function') return false;

    const currentRule = getCurrentRule(host);
    const stored = host.__dazyRulePluginOptions;

    if (!currentRule || !stored) {
      setRulePanelStatus(host, 'Не удалось получить параметры конструктора условий.', 'error');
      return false;
    }

    const previousContainer = host.querySelector('.rule-container');
    const nextContainer = document.createElement('div');
    nextContainer.className = 'rule-container';

    previousContainer?.replaceWith(nextContainer);
    if (!nextContainer.isConnected) host.appendChild(nextContainer);

    const options = {
      ...stored,
      rule: currentRule,
      allowTesting: Boolean(allowTesting),
      useTimerForHeavySegment: Boolean(allowTesting && stored.useTimerForHeavySegment),
    };

    try {
      state.originalRulePlugin.call($(nextContainer), options);
      $(nextContainer).off('rulechanged.dazyFastEditor');
      $(nextContainer).on('rulechanged.dazyFastEditor', (_event, rule) => {
        saveCurrentRule(host, rule);
      });

      host.dataset.dazyRuleTesting = allowTesting ? '1' : '0';
      return true;
    } catch (error) {
      warn('Ошибка переинициализации rulePlugin:', error);
      setRulePanelStatus(host, 'Не удалось переключить режим проверки.', 'error');
      return false;
    }
  }

  function extractRuleResultText(host) {
    const text = host?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const patterns = [
      /Под правило попадает:\s*([^\.]{1,100})/i,
      /Найдено:\s*([^\.]{1,100})/i,
      /Попадает:\s*([^\.]{1,100})/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }

    return '';
  }

  function finishOneRuleTest(host, resultText, isError = false) {
    if (state.activeRuleTest?.timer) clearTimeout(state.activeRuleTest.timer);
    state.activeRuleTest = null;

    reinitializeRulePlugin(host, false);

    const panel = getRulePanel(host);
    const button = panel?.querySelector('[data-role="run-rule-test"]');
    if (button) {
      button.disabled = false;
      button.textContent = 'Проверить сегмент';
    }

    if (isError) {
      setRulePanelStatus(host, resultText || 'Проверка завершилась ошибкой.', 'error');
    } else {
      setRulePanelStatus(
        host,
        resultText ? `Результат: ${resultText}` : 'Проверка выполнена. Live-режим снова выключен.',
        'success'
      );
    }
  }

  function runOneRuleTest(host) {
    if (state.activeRuleTest) {
      setRulePanelStatus(host, 'Другая проверка уже выполняется.', 'warning');
      return;
    }

    const panel = getRulePanel(host);
    const button = panel?.querySelector('[data-role="run-rule-test"]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверяю…';
    }

    setRulePanelStatus(host, 'Запускаю одну штатную проверку GetCourse…', 'loading');

    let completed = false;

    const ajaxCompleteHandler = (_event, xhr, settings) => {
      const url = String(settings?.url || '');
      if (!url.includes('/pl/logic/rule/test')) return;
      if (completed) return;
      completed = true;

      $(document).off('ajaxComplete.dazyFastEditorOneTest', ajaxCompleteHandler);

      setTimeout(() => {
        const resultText = extractRuleResultText(host);
        const failed = Number(xhr?.status || 0) >= 400;
        const fallbackError = failed
          ? `Ошибка ${xhr?.status || ''}: ${String(xhr?.responseText || '').slice(0, 180)}`
          : '';

        finishOneRuleTest(host, resultText || fallbackError, failed);
      }, 250);
    };

    $(document).on('ajaxComplete.dazyFastEditorOneTest', ajaxCompleteHandler);

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      $(document).off('ajaxComplete.dazyFastEditorOneTest', ajaxCompleteHandler);
      finishOneRuleTest(host, 'GetCourse не запустил проверочный запрос за отведённое время.', true);
    }, CONFIG.oneTestTimeoutMs);

    state.activeRuleTest = { host, timer, ajaxCompleteHandler };

    if (!reinitializeRulePlugin(host, true)) {
      $(document).off('ajaxComplete.dazyFastEditorOneTest', ajaxCompleteHandler);
      clearTimeout(timer);
      state.activeRuleTest = null;
      if (button) {
        button.disabled = false;
        button.textContent = 'Проверить сегмент';
      }
    }
  }

  function installRulePanel(host) {
    if (!host || getRulePanel(host)) return;

    const panel = document.createElement('div');
    panel.className = classes.rulePanel;
    panel.innerHTML = `
      <div class="dazy-gc-rule-test-copy">
        <strong>Проверка сегмента выключена</strong>
        <span data-role="rule-status" data-tone="normal">Условие редактируется без автоматических запросов /pl/logic/rule/test.</span>
      </div>
      <button type="button" data-role="run-rule-test">Проверить сегмент</button>
    `;

    panel.querySelector('[data-role="run-rule-test"]')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      runOneRuleTest(host);
    });

    host.prepend(panel);
    state.guardedHosts.add(host);
  }

  function patchRulePlugin() {
    if (typeof state.originalRulePlugin !== 'function') {
      warn('$.fn.rulePlugin не найден. Защита live-проверки не установлена.');
      return;
    }

    $.fn.rulePlugin = function patchedRulePlugin(options, ...rest) {
      const safeOptions = options && typeof options === 'object'
        ? { ...options }
        : options;

      if (safeOptions && typeof safeOptions === 'object') {
        const element = this?.[0];
        const host = findRuleHost(element);

        if (host) {
          host.__dazyRulePluginOptions = { ...safeOptions };
          safeOptions.allowTesting = false;
          safeOptions.useTimerForHeavySegment = false;
          host.dataset.dazyRuleTesting = '0';

          queueMicrotask(() => installRulePanel(host));
        }
      }

      return state.originalRulePlugin.call(this, safeOptions, ...rest);
    };

    state.rulePluginPatched = true;
    log('Автоматическая проверка сегментов отключена.');
  }

  function observeRuleModals() {
    const scan = root => {
      if (!(root instanceof Element) && root !== document) return;

      const hosts = [];
      if (root instanceof Element && root.matches('[id^="rulePlugin"]')) hosts.push(root);
      root.querySelectorAll?.('[id^="rulePlugin"]').forEach(host => hosts.push(host));

      hosts.forEach(host => {
        if (host.querySelector('.rule-container')) installRulePanel(host);
      });
    };

    scan(document);

    state.modalObserver = new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(node => {
          if (node instanceof Element) scan(node);
        });
      }
    });

    state.modalObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // Самодиагностика совместимости
  // ---------------------------------------------------------------------------

  function collectBlockTypeCounts() {
    const counts = {};

    document.querySelectorAll('#flowchart .flowchart-block').forEach(block => {
      const kind = getBlockKindFromElement(block) || 'unknown';
      counts[kind] = (counts[kind] || 0) + 1;
    });

    return counts;
  }

  function collectEndpointResultTypes() {
    const plugin = getFlowchartPlugin();
    const values = new Set();

    Object.entries(plugin?.endpoints || {}).forEach(([key, definition = {}]) => {
      const resultId = String(
        definition.resultId ||
        definition.settings?.resultId ||
        String(key).split('-').pop() ||
        ''
      ).trim();

      if (resultId) values.add(resultId);
    });

    return [...values].sort();
  }

  function setCompatibilityStatus(report) {
    const host = state.panel?.querySelector('[data-role="compatibility-status"]');
    if (!host || !report) return;

    host.dataset.tone = report.ready
      ? report.warnings.length
        ? 'warning'
        : 'success'
      : 'error';

    const summary = report.ready
      ? report.warnings.length
        ? `Совместимость подтверждена с оговорками: ${report.warnings.length}.`
        : 'Совместимость подтверждена.'
      : 'Критические возможности редактора не найдены.';

    host.textContent =
      `${summary} Блоков: ${report.blockCount}; связей: ${report.connectionCount}; ` +
      `секций: ${report.sectionCount}.`;
    host.title = report.warnings.join('\n');
  }

  function runCompatibilityCheck() {
    const plugin = getFlowchartPlugin();
    const instance = getJsPlumbInstance();
    const blockTypeCounts = collectBlockTypeCounts();
    const resultTypes = collectEndpointResultTypes();
    const warnings = [];
    const critical = [];

    if (!plugin) critical.push('flowchartPlugin не найден');
    if (!instance) critical.push('jsPlumb instance не найден');
    if (typeof plugin?.loadData !== 'function') {
      critical.push('flowchartPlugin.loadData не найден');
    }
    if (typeof $.ajax !== 'function') critical.push('jQuery.ajax не найден');

    if (typeof instance?.setDraggable !== 'function') {
      warnings.push('setDraggable отсутствует: прокси-перемещение может быть недоступно');
    }
    if (typeof instance?.remove !== 'function') {
      warnings.push('jsPlumb.remove отсутствует: быстрое удаление будет использовать fallback');
    }
    if (!plugin?.endpoints || !Object.keys(plugin.endpoints).length) {
      warnings.push('endpoint definitions пока не загружены');
    }

    const unknownBlockCount = blockTypeCounts.unknown || 0;
    if (unknownBlockCount) {
      warnings.push(
        `обнаружено блоков неизвестного DOM-типа: ${unknownBlockCount}`
      );
    }

    const sectionCount = document.querySelectorAll(
      '#flowchart .flowchart-section, #flowchart .group-container.flowchart-block'
    ).length;

    const report = {
      checkedAt: new Date().toISOString(),
      ready: critical.length === 0,
      critical,
      warnings,
      blockCount: document.querySelectorAll('#flowchart .flowchart-block').length,
      connectionCount: getConnections().length,
      endpointCount: Object.keys(plugin?.endpoints || {}).length,
      sectionCount,
      blockTypeCounts,
      resultTypes,
      features: {
        fastSave: typeof plugin?.loadData === 'function',
        proxyMove:
          typeof instance?.setDraggable === 'function' &&
          typeof $.ajax === 'function',
        fastLinks: Boolean(plugin?.endpoints),
        fastDelete:
          typeof instance?.remove === 'function' ||
          typeof instance?.deleteEveryEndpoint === 'function',
        sectionsDetected:
          sectionCount > 0 ||
          Boolean(plugin?.blocksInSections) ||
          Boolean(plugin?.sections),
      },
      access: {
        accountId: page.accountId,
        accountUserId: page.accountUserId,
        allowAnyAccount: CONFIG.allowAnyAccount,
        allowAnyUser: CONFIG.allowAnyUser,
      },
    };

    state.compatibility = report;
    setCompatibilityStatus(report);
    log('Проверка совместимости завершена.', report);
    return report;
  }

  function collectionCount(value) {
    if (!value) return 0;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'object') return Object.keys(value).length;
    return 0;
  }

  async function fetchServerFlowchartSnapshot() {
    const response = await ajaxPromise({
      url: `/pl/tasks/mission/flowchart-data?id=${encodeURIComponent(page.processId)}`,
      type: 'POST',
      dataType: 'json',
      data: {},
    });

    const data = response?.data?.data?.flowchartData;
    if (!data) {
      throw new Error('GetCourse не вернул data.flowchartData');
    }

    const blocks = Array.isArray(data.blocks)
      ? data.blocks
      : Object.values(data.blocks || {});
    const sections = Array.isArray(data.sections)
      ? data.sections
      : Object.values(data.sections || {});
    const coords = {};

    blocks.forEach(block => {
      const id = String(block?.id || '');
      const left = Number(block?.coord?.left);
      const top = Number(block?.coord?.top);
      if (!id || !Number.isFinite(left) || !Number.isFinite(top)) return;
      coords[id] = { left, top };
    });

    return {
      capturedAt: new Date().toISOString(),
      blockCount: blocks.length,
      connectionCount: collectionCount(data.connections),
      endpointCount: collectionCount(data.endpoints),
      sectionCount: sections.length,
      blocksInSectionsCount: collectionCount(data.blocksInSections),
      coords,
    };
  }

  async function captureSafetyBaseline() {
    try {
      const snapshot = await fetchServerFlowchartSnapshot();
      state.safetyBaseline = snapshot;
      state.safetyBaselineError = '';
      setSaveStatus(
        `SAFE baseline: ${snapshot.blockCount} блоков, ${snapshot.connectionCount} связей, ` +
        `${snapshot.sectionCount} секций. Запись координат не выполнялась.`,
        'success'
      );
      return snapshot;
    } catch (error) {
      state.safetyBaselineError = responseErrorText(error);
      setSaveStatus(
        `SAFE baseline не получен: ${state.safetyBaselineError.slice(0, 180)}`,
        'warning'
      );
      return null;
    }
  }

  async function auditServerCoordinates() {
    const baseline = state.safetyBaseline || await captureSafetyBaseline();
    if (!baseline) return null;

    const current = await fetchServerFlowchartSnapshot();
    const moved = [];
    const missing = [];
    const added = [];

    Object.entries(baseline.coords).forEach(([id, before]) => {
      const after = current.coords[id];
      if (!after) {
        missing.push(id);
        return;
      }
      if (
        Math.abs(after.left - before.left) > 0.01 ||
        Math.abs(after.top - before.top) > 0.01
      ) {
        moved.push({ id, before, after });
      }
    });

    Object.keys(current.coords).forEach(id => {
      if (!baseline.coords[id]) added.push(id);
    });

    const audit = {
      checkedAt: new Date().toISOString(),
      moved,
      missing,
      added,
      baseline: {
        blockCount: baseline.blockCount,
        connectionCount: baseline.connectionCount,
        sectionCount: baseline.sectionCount,
      },
      current: {
        blockCount: current.blockCount,
        connectionCount: current.connectionCount,
        sectionCount: current.sectionCount,
      },
    };

    setSaveStatus(
      moved.length || missing.length
        ? `SAFE audit: изменены координаты ${moved.length} блоков; исчезло ${missing.length}; новых ${added.length}.`
        : `SAFE audit: координаты исходных ${baseline.blockCount} блоков не изменились; новых блоков ${added.length}.`,
      moved.length || missing.length ? 'warning' : 'success'
    );

    console.info('[GC Fast Editor SAFE] Coordinate audit', audit);
    return audit;
  }

  async function runDeepCompatibilityCheck() {
    if (state.deepCompatibilityBusy) return state.compatibility;
    state.deepCompatibilityBusy = true;

    try {
      const report = runCompatibilityCheck();
      const server = await fetchServerFlowchartSnapshot();
      report.server = server;
      report.referenceProfile = SAFE_REFERENCE_PROFILE
        ? { ...SAFE_REFERENCE_PROFILE }
        : null;

      if (report.blockCount !== server.blockCount) {
        report.warnings.push(
          `DOM/сервер: блоки ${report.blockCount}/${server.blockCount}`
        );
      }
      if (report.connectionCount !== server.connectionCount) {
        report.warnings.push(
          `DOM/сервер: связи ${report.connectionCount}/${server.connectionCount}`
        );
      }
      if (report.sectionCount !== server.sectionCount) {
        report.warnings.push(
          `DOM/сервер: секции ${report.sectionCount}/${server.sectionCount}`
        );
      }
      if (
        SAFE_REFERENCE_PROFILE &&
        (server.blockCount !== Number(SAFE_REFERENCE_PROFILE.blocks) ||
          server.connectionCount !== Number(SAFE_REFERENCE_PROFILE.connections) ||
          server.sectionCount !== Number(SAFE_REFERENCE_PROFILE.sections))
      ) {
        report.warnings.push(
          `Процесс отличается от эталона ${SAFE_REFERENCE_PROFILE.sourceProcessId || 'reference'}: ` +
          `${server.blockCount}/${server.connectionCount}/${server.sectionCount} вместо ` +
          `${SAFE_REFERENCE_PROFILE.blocks}/${SAFE_REFERENCE_PROFILE.connections}/${SAFE_REFERENCE_PROFILE.sections}`
        );
      }

      state.compatibility = report;
      setCompatibilityStatus(report);
      console.info('[GC Fast Editor SAFE] Deep compatibility', report);
      return report;
    } catch (error) {
      const report = state.compatibility || runCompatibilityCheck();
      report.warnings.push(
        `серверная SAFE-проверка не выполнена: ${responseErrorText(error).slice(0, 180)}`
      );
      state.compatibility = report;
      setCompatibilityStatus(report);
      return report;
    } finally {
      state.deepCompatibilityBusy = false;
    }
  }

  function scheduleDeepCompatibilityCheck(attempt = 0) {
    const delay = attempt === 0 ? 700 : 500;
    setTimeout(() => {
      if (state.destroyed) return;
      const count = document.querySelectorAll('#flowchart .flowchart-block').length;
      if (count === 0 && attempt < 30) {
        scheduleDeepCompatibilityCheck(attempt + 1);
        return;
      }
      void runDeepCompatibilityCheck();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Интерфейс
  // ---------------------------------------------------------------------------

  function installStyles() {
    const style = document.createElement('style');
    style.id = 'dazy-gc-process-fast-editor-style';
    style.textContent = `
      #dazy-gc-process-fast-editor {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        width: 350px;
        max-height: calc(100vh - 36px);
        overflow: auto;
        padding: 14px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 14px;
        background: rgba(25,27,31,.96);
        color: #f4f6f8;
        box-shadow: 0 18px 54px rgba(0,0,0,.36);
        font-family: Arial, sans-serif;
        font-size: 13px;
        line-height: 1.35;
        backdrop-filter: blur(12px);
      }

      #dazy-gc-process-fast-editor * { box-sizing: border-box; }

      .dazy-gc-fast-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }

      .dazy-gc-fast-title { font-weight: 700; font-size: 14px; }
      .dazy-gc-fast-version { opacity: .55; font-size: 11px; }

      .dazy-gc-fast-head-actions {
        display: flex;
        align-items: center;
        gap: 7px;
      }

      #dazy-gc-process-fast-editor [data-role="collapse"] {
        width: 28px;
        min-width: 28px;
        height: 26px;
        padding: 0;
        border-radius: 7px;
        font-size: 17px;
        line-height: 1;
      }

      #dazy-gc-process-fast-editor.is-collapsed {
        width: 286px;
        max-height: none;
        overflow: hidden;
        padding-bottom: 10px;
      }

      #dazy-gc-process-fast-editor.is-collapsed .dazy-gc-fast-head {
        margin-bottom: 0;
      }

      #dazy-gc-process-fast-editor.is-collapsed [data-role="panel-body"] {
        display: none;
      }

      #dazy-gc-process-fast-editor button {
        appearance: none;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 9px;
        background: #343942;
        color: #fff;
        padding: 8px 10px;
        cursor: pointer;
        font: inherit;
      }

      #dazy-gc-process-fast-editor button:hover:not(:disabled) { background: #414854; }
      #dazy-gc-process-fast-editor button:disabled { opacity: .52; cursor: wait; }

      #dazy-gc-process-fast-editor [data-role="mode"] {
        width: 100%;
        background: #334155;
        font-weight: 700;
      }

      #dazy-gc-process-fast-editor [data-role="mode"].is-active {
        background: #0f766e;
        border-color: #2dd4bf;
      }

      .dazy-gc-fast-status {
        margin: 10px 0;
        padding: 9px 10px;
        border-radius: 9px;
        background: rgba(255,255,255,.06);
        color: #d7dce2;
      }

      .dazy-gc-fast-status[data-tone="active"] { background: rgba(59,130,246,.18); color: #bfdbfe; }
      .dazy-gc-fast-status[data-tone="success"] { background: rgba(34,197,94,.18); color: #bbf7d0; }
      .dazy-gc-fast-status[data-tone="warning"] { background: rgba(245,158,11,.18); color: #fde68a; }
      .dazy-gc-fast-status[data-tone="error"] { background: rgba(239,68,68,.2); color: #fecaca; }
      .dazy-gc-fast-status[data-tone="loading"] { background: rgba(168,85,247,.18); color: #e9d5ff; }

      .dazy-gc-compatibility-box {
        margin: 0 0 10px;
        padding: 9px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        background: rgba(255,255,255,.04);
      }

      .dazy-gc-compatibility-status {
        padding: 8px 9px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #d7dce2;
        font-size: 12px;
      }

      .dazy-gc-compatibility-status[data-tone="success"] {
        color: #bbf7d0;
        background: rgba(34,197,94,.16);
      }

      .dazy-gc-compatibility-status[data-tone="warning"] {
        color: #fde68a;
        background: rgba(245,158,11,.16);
      }

      .dazy-gc-compatibility-status[data-tone="error"] {
        color: #fecaca;
        background: rgba(239,68,68,.18);
      }

      #dazy-gc-process-fast-editor [data-role="compatibility-check"] {
        width: 100%;
        margin-top: 7px;
        background: #334155;
      }

      .dazy-gc-fast-save-box {
        margin: 0 0 10px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        background: rgba(255,255,255,.04);
      }

      .dazy-gc-fast-save-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }

      .dazy-gc-fast-save-row strong { font-size: 12px; }
      .dazy-gc-fast-save-counter {
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(245,158,11,.18);
        color: #fde68a;
        font-weight: 700;
      }

      #dazy-gc-process-fast-editor [data-role="fast-save-toggle"] {
        width: 100%;
        margin-bottom: 7px;
        background: #475569;
      }

      #dazy-gc-process-fast-editor [data-role="fast-save-toggle"].is-active {
        background: #166534;
        border-color: #4ade80;
      }

      #dazy-gc-process-fast-editor [data-role="sync"] {
        width: 100%;
        background: #6b4f15;
      }

      #dazy-gc-process-fast-editor [data-role="sync"].has-local-changes {
        background: #92400e;
        border-color: #fbbf24;
      }

      .dazy-gc-save-status {
        margin: 7px 0 0;
        padding: 8px 9px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #d7dce2;
        font-size: 12px;
      }

      .dazy-gc-save-status[data-tone="success"] { color: #bbf7d0; background: rgba(34,197,94,.16); }
      .dazy-gc-save-status[data-tone="warning"] { color: #fde68a; background: rgba(245,158,11,.16); }
      .dazy-gc-save-status[data-tone="error"] { color: #fecaca; background: rgba(239,68,68,.18); }
      .dazy-gc-save-status[data-tone="loading"] { color: #e9d5ff; background: rgba(168,85,247,.16); }

      .flowchart-block.${classes.localDirty} {
        box-shadow: 0 0 0 3px rgba(245,158,11,.22);
      }

      .jtk-connector.dazy-gc-local-copy-connection path,
      ._jsPlumb_connector.dazy-gc-local-copy-connection path {
        stroke-dasharray: 7 5;
        opacity: .9;
      }

      .flowchart-block.${classes.localUnsynced} {
        outline: 3px dashed #f59e0b !important;
        outline-offset: 3px !important;
      }

      .dazy-gc-local-badge {
        margin-top: 5px;
        color: #b45309;
        font-size: 10px;
        font-weight: 700;
      }

      .dazy-gc-fast-drag-box {
        margin: 0 0 10px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        background: rgba(255,255,255,.04);
      }

      #dazy-gc-process-fast-editor [data-role="drag-toggle"] {
        width: 100%;
        background: #475569;
      }

      #dazy-gc-process-fast-editor [data-role="drag-toggle"].is-active {
        background: #166534;
        border-color: #4ade80;
      }

      .dazy-gc-drag-status {
        margin-top: 7px;
        padding: 8px 9px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #d7dce2;
        font-size: 12px;
      }

      .dazy-gc-drag-status[data-tone="success"] { color: #bbf7d0; background: rgba(34,197,94,.16); }
      .dazy-gc-drag-status[data-tone="warning"] { color: #fde68a; background: rgba(245,158,11,.16); }
      .dazy-gc-drag-status[data-tone="loading"] { color: #e9d5ff; background: rgba(168,85,247,.16); }

      .dazy-gc-drag-status[data-tone="error"] {
        color: #fecaca;
        background: rgba(239,68,68,.22);
        border: 1px solid rgba(248,113,113,.45);
      }

      #flowchart .flowchart-block.dazy-gc-move-blocked {
        outline: 4px solid #ef4444 !important;
        outline-offset: 3px !important;
        box-shadow:
          0 0 0 7px rgba(239,68,68,.22),
          0 0 26px rgba(239,68,68,.4) !important;
        animation: dazyGcMoveBlockedPulse .38s ease-in-out 3 alternate;
      }

      @keyframes dazyGcMoveBlockedPulse {
        from { filter: saturate(1); }
        to { filter: saturate(1.7) brightness(1.08); }
      }

      #dazy-gc-move-limit-toast {
        position: fixed;
        left: 50%;
        top: 78px;
        transform: translateX(-50%);
        z-index: 2147483647;
        max-width: min(680px, calc(100vw - 40px));
        padding: 11px 16px;
        border: 1px solid rgba(248,113,113,.7);
        border-radius: 10px;
        background: rgba(127,29,29,.96);
        color: #fff;
        box-shadow: 0 12px 38px rgba(0,0,0,.32);
        font: 700 13px/1.35 Arial, sans-serif;
        text-align: center;
        pointer-events: none;
      }

      body.${classes.bodyLiteDrag} #flowchart .jtk-connector,
      body.${classes.bodyLiteDrag} #flowchart ._jsPlumb_connector,
      body.${classes.bodyLiteDrag} #flowchart .jtk-endpoint,
      body.${classes.bodyLiteDrag} #flowchart ._jsPlumb_endpoint,
      body.${classes.bodyLiteDrag} #flowchart .jtk-overlay,
      body.${classes.bodyLiteDrag} #flowchart ._jsPlumb_overlay {
        visibility: hidden !important;
      }

      body.${classes.bodyLiteDrag} #flowchart .flowchart-block {
        cursor: grabbing !important;
      }

      body.${classes.bodyLiteDrag} #flowchart .flowchart-block.${classes.liteDragBlock} {
        will-change: left, top;
        backface-visibility: hidden;
      }

      body.dazy-gc-group-proxy-active #flowchart .flowchart-block.dazy-gc-group-proxy-source {
        opacity: .34 !important;
        filter: grayscale(.15);
      }

      .dazy-gc-group-drag-proxy {
        position: fixed;
        z-index: 2147483645;
        pointer-events: none;
        border: 2px solid #22c55e;
        border-radius: 12px;
        background: rgba(34,197,94,.08);
        box-shadow: 0 12px 36px rgba(0,0,0,.18);
        will-change: transform;
        contain: layout paint style;
      }

      .dazy-gc-group-drag-proxy > span {
        position: absolute;
        left: 8px;
        top: -31px;
        padding: 5px 8px;
        border-radius: 7px;
        background: #166534;
        color: #fff;
        font: 700 12px/1.2 Arial, sans-serif;
        white-space: nowrap;
      }

      .dazy-gc-group-drag-proxy > i {
        position: absolute;
        display: block;
        box-sizing: border-box;
        border: 1px dashed rgba(255,255,255,.9);
        border-radius: 8px;
        background: rgba(34,197,94,.16);
      }

      .dazy-gc-fast-outputs { display: grid; gap: 7px; }

      .dazy-gc-fast-output {
        width: 100%;
        text-align: left;
        display: grid;
        gap: 3px;
      }

      .dazy-gc-fast-output.is-selected {
        border-color: #60a5fa !important;
        box-shadow: 0 0 0 2px rgba(96,165,250,.24);
      }

      .dazy-gc-fast-output-label { font-weight: 700; }
      .dazy-gc-fast-output-target { opacity: .7; font-size: 11px; }
      .dazy-gc-fast-output-error { color: #fca5a5; font-size: 11px; }
      .dazy-gc-fast-empty { opacity: .68; padding: 4px 1px; }

      .dazy-gc-fast-confirm {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,.12);
      }

      .dazy-gc-fast-confirm-text { margin-bottom: 9px; }
      .dazy-gc-fast-confirm-buttons { display: flex; gap: 8px; }
      .dazy-gc-fast-confirm-buttons button { flex: 1; }
      .dazy-gc-fast-confirm-buttons [data-role="confirm-save"] { background: #166534; }
      .dazy-gc-fast-confirm-buttons [data-role="confirm-cancel"] { background: #4b5563; }

      body.${classes.bodyMode} .jtk-endpoint,
      body.${classes.bodyMode} .jtk-endpoint-connected,
      body.${classes.bodyMode} svg.jtk-endpoint {
        pointer-events: none !important;
      }

      body.${classes.bodyMode} .flowchart-block { cursor: crosshair !important; }

      .flowchart-block.${classes.source} {
        outline: 4px solid #3b82f6 !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 8px rgba(59,130,246,.18) !important;
      }

      .flowchart-block.${classes.targetCandidate}:not(.${classes.source}) {
        outline: 2px dashed rgba(34,197,94,.8) !important;
        outline-offset: 2px !important;
      }

      .flowchart-block.${classes.targetPending} {
        outline: 5px solid #22c55e !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 9px rgba(34,197,94,.2) !important;
      }

      .flowchart-block.${classes.targetConflict} {
        outline: 5px solid #ef4444 !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 9px rgba(239,68,68,.2) !important;
      }

      .${classes.rulePanel} {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin: 0 0 12px;
        padding: 10px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 9px;
        background: #f8fafc;
        color: #1f2937;
      }

      .dazy-gc-rule-test-copy { display: grid; gap: 2px; }
      .dazy-gc-rule-test-copy span { font-size: 12px; color: #64748b; }
      .dazy-gc-rule-test-copy span[data-tone="success"] { color: #15803d; }
      .dazy-gc-rule-test-copy span[data-tone="warning"] { color: #b45309; }
      .dazy-gc-rule-test-copy span[data-tone="error"] { color: #b91c1c; }
      .dazy-gc-rule-test-copy span[data-tone="loading"] { color: #7e22ce; }

      .${classes.rulePanel} button {
        flex: 0 0 auto;
        border: 0;
        border-radius: 7px;
        padding: 8px 12px;
        background: #2563eb;
        color: #fff;
        cursor: pointer;
      }

      .${classes.rulePanel} button:disabled { opacity: .55; cursor: wait; }
    `;

    document.head.appendChild(style);
    state.style = style;
  }

  function setPanelCollapsed(collapsed, persist = true) {
    state.panelCollapsed = Boolean(collapsed);

    if (state.panel) {
      state.panel.classList.toggle('is-collapsed', state.panelCollapsed);

      const button = state.panel.querySelector('[data-role="collapse"]');
      if (button) {
        button.textContent = state.panelCollapsed ? '+' : '−';
        button.title = state.panelCollapsed ? 'Развернуть панель' : 'Свернуть панель';
        button.setAttribute('aria-expanded', String(!state.panelCollapsed));
      }
    }

    if (persist) saveSettings();
  }

  function installPanel() {
    const panel = document.createElement('div');
    panel.id = 'dazy-gc-process-fast-editor';
    panel.innerHTML = `
      <div class="dazy-gc-fast-head">
        <span class="dazy-gc-fast-title">DAZY Process Fast Editor · SAFE TEST</span>
        <div class="dazy-gc-fast-head-actions">
          <span class="dazy-gc-fast-version">v${VERSION}</span>
          <button type="button" data-role="collapse" title="Свернуть панель" aria-expanded="true">−</button>
        </div>
      </div>
      <div data-role="panel-body">
      <div class="dazy-gc-compatibility-box">
        <div
          class="dazy-gc-compatibility-status"
          data-role="compatibility-status"
          data-tone="normal"
        >Проверяю совместимость процесса…</div>
        <button type="button" data-role="compatibility-check">
          Повторно проверить совместимость
        </button>
      </div>
      <div class="dazy-gc-fast-save-box">
        <div class="dazy-gc-fast-save-row">
          <strong>Точечное обновление</strong>
          <span class="dazy-gc-fast-save-counter">Изменений: <span data-role="local-changes-value">0</span></span>
        </div>
        <button type="button" data-role="fast-save-toggle">Быстрое сохранение: выключено</button>
        <button type="button" data-role="sync">Полностью синхронизировать процесс</button>
        <button type="button" data-role="coordinate-audit">Проверить координаты (read-only)</button>
        <div class="dazy-gc-save-status" data-role="save-status" data-tone="normal">SAFE MODE: запись ускорений выключена до ручного включения.</div>
      </div>
      <div class="dazy-gc-fast-drag-box">
        <button type="button" data-role="drag-toggle">Облегчённое перемещение: выключено</button>
        <button type="button" data-role="edge-pan-toggle">Автопрокрутка у края: выключена</button>
        <div class="dazy-gc-drag-status" data-role="drag-status" data-tone="success">${CONFIG.externalMoveGuard ? 'Safety Guard управляет защитой массовых перемещений.' : `Локальный лимит: ${SAFE_MAX_PROXY_MOVE_BLOCKS} блоков.`}</div>
      </div>
      <button type="button" data-role="mode">Включить быстрые связи</button>
      <div class="dazy-gc-fast-status" data-role="status" data-tone="normal">Быстрые связи выключены.</div>
      <div class="dazy-gc-fast-outputs" data-role="outputs"></div>
      <div class="dazy-gc-fast-confirm" data-role="confirm" hidden>
        <div class="dazy-gc-fast-confirm-text" data-role="confirm-text"></div>
        <div class="dazy-gc-fast-confirm-buttons">
          <button type="button" data-role="confirm-save">Подключить</button>
          <button type="button" data-role="confirm-cancel">Отмена</button>
        </div>
      </div>
      </div>
    `;

    panel.querySelector('[data-role="collapse"]')?.addEventListener('click', () => {
      setPanelCollapsed(!state.panelCollapsed);
    });

    panel.querySelector('[data-role="compatibility-check"]')?.addEventListener('click', () => {
      void runDeepCompatibilityCheck();
    });

    panel.querySelector('[data-role="fast-save-toggle"]')?.addEventListener('click', () => {
      toggleFastSave(!state.fastSaveEnabled);
    });

    panel.querySelector('[data-role="sync"]')?.addEventListener('click', () => {
      fullSync('manual');
    });

    panel.querySelector('[data-role="coordinate-audit"]')?.addEventListener('click', () => {
      void auditServerCoordinates();
    });

    panel.querySelector('[data-role="drag-toggle"]')?.addEventListener('click', () => {
      toggleLightDrag(!state.lightDragEnabled);
    });

    panel.querySelector('[data-role="edge-pan-toggle"]')?.addEventListener('click', () => {
      toggleEdgePan(!state.edgePanEnabled);
    });

    panel.querySelector('[data-role="mode"]')?.addEventListener('click', () => {
      setLinkMode(!state.linkMode);
    });

    panel.querySelector('[data-role="confirm-save"]')?.addEventListener('click', () => {
      applySelectedOutput();
    });

    panel.querySelector('[data-role="confirm-cancel"]')?.addEventListener('click', () => {
      hideConfirmation();
      setLinkStatus('Выберите другой целевой блок.', 'active');
    });

    document.body.appendChild(panel);
    state.panel = panel;
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;

    stopGroupProxyAutoPan();
    void finishGroupProxyDrag('destroy', true, true);
    finishLightDrag('destroy', true);
    restoreLightDragRenderGuard();
    setLinkMode(false);

    state.modalObserver?.disconnect();
    state.modalObserver = null;

    if (state.rulePluginPatched && $.fn.rulePlugin === patchedReference) {
      $.fn.rulePlugin = state.originalRulePlugin;
    }

    if (state.activeRuleTest) {
      clearTimeout(state.activeRuleTest.timer);
      $(document).off('ajaxComplete.dazyFastEditorOneTest', state.activeRuleTest.ajaxCompleteHandler);
      state.activeRuleTest = null;
    }

    state.documentHandlers.forEach(({ type, handler, options }) => {
      document.removeEventListener(type, handler, options);
    });
    state.documentHandlers = [];

    state.guardedHosts.forEach(host => {
      getRulePanel(host)?.remove();
      delete host.__dazyRulePluginOptions;
      delete host.dataset.dazyRuleTesting;
    });
    state.guardedHosts.clear();

    const plugin = getFlowchartPlugin();
    if (
      state.loadDataPatched &&
      state.originalLoadData &&
      plugin?.loadData?.__dazyFastSaveV130Safe
    ) {
      plugin.loadData = state.originalLoadData;
    }

    $('.block-modal-window').off('saved.dazyFastEditorV130Safe');
    $(document).off('ajaxError.dazyFastEditorV130Safe');
    $(document).off('ajaxComplete.dazyFastEditorV130Safe');

    if (
      state.ajaxPatched &&
      state.originalAjax &&
      $.ajax?.__dazyNativeActionsV130Safe
    ) {
      $.ajax = state.originalAjax;
    }
    state.ajaxPatched = false;
    state.originalAjax = null;

    clearNativePasteTimer();
    state.nativePastePending = null;
    state.copyBusy = false;
    state.deleteBusy = false;

    if (state.pendingResetTimer) clearTimeout(state.pendingResetTimer);
    state.pendingResetTimer = null;

    if (state.safeSyncTimer) clearTimeout(state.safeSyncTimer);
    state.safeSyncTimer = null;

    clearSectionGroupFlushTimer();
    state.sectionGroupQueue = [];
    clearLocalCopyConnections();

    if (
      state.sectionGuardProto &&
      state.sectionGuardOriginalAddToGroup &&
      state.sectionGuardProto.addToGroup === state.sectionGuardPatchedAddToGroup
    ) {
      state.sectionGuardProto.addToGroup =
        state.sectionGuardOriginalAddToGroup;
    }

    state.pendingModalSave = null;
    state.skipReloadBudget = 0;

    state.localBlockHandlers.forEach((handler, blockEl) => {
      try { blockEl.removeEventListener('dblclick', handler, true); } catch (_) {}
    });
    state.localBlockHandlers.clear();

    state.panel?.remove();
    state.style?.remove();
    removeMoveLimitToast();

    document.querySelectorAll(
      '#flowchart .flowchart-block.dazy-gc-move-blocked'
    ).forEach(block => {
      try { block.classList.remove('dazy-gc-move-blocked'); } catch (_) {}
    });

    LEGACY_TOOL_KEYS.forEach(key => { if (window[key] === window[TOOL_KEY] || key === TOOL_KEY) delete window[key]; });
    log('Инструмент отключён.');
  }

  installStyles();
  installPanel();
  setPanelCollapsed(state.panelCollapsed, false);
  toggleFastSave(state.fastSaveEnabled);
  toggleLightDrag(state.lightDragEnabled);
  toggleEdgePan(state.edgePanEnabled);

  patchRulePlugin();
  const patchedReference = $.fn.rulePlugin;
  observeRuleModals();
  installFastSave();
  installLightDragRenderGuard();
  installSectionRenderGuard();
  void captureSafetyBaseline();
  scheduleDeepCompatibilityCheck();

  addDocumentHandler('pointerdown', handleGroupProxyPointerDown, true);
  addDocumentHandler('pointermove', handleGroupProxyPointerMove, true);
  addDocumentHandler('pointerup', handleGroupProxyPointerUp, true);
  addDocumentHandler('pointercancel', handleGroupProxyPointerCancel, true);
  addDocumentHandler('pointerdown', handleLiteDragPointerDown, true);
  addDocumentHandler('pointermove', handleLiteDragPointerMove, true);
  addDocumentHandler('pointerup', handleLiteDragPointerEnd, true);
  addDocumentHandler('pointercancel', handleLiteDragPointerEnd, true);
  addDocumentHandler('pointerdown', handleBlockPointer, true);
  addDocumentHandler('mousedown', handleBlockPointer, true);
  addDocumentHandler('click', handleBlockClick, true);
  addDocumentHandler('keydown', event => {
    if (event.key === 'Escape' && state.linkMode) {
      resetLinkSelection();
      setLinkStatus('Выбор отменён. Нажмите на исходный блок.', 'normal');
    }
  }, true);

  window[TOOL_KEY] = {
    version: VERSION,
    state,
    enableLinks: () => setLinkMode(true),
    disableLinks: () => setLinkMode(false),
    resetLinks: resetLinkSelection,
    getConnections,
    getBlockOutputs,
    getJsPlumbInstance,
    fullSync,
    fastPasteBlocks,
    enableFastSave: () => toggleFastSave(true),
    disableFastSave: () => toggleFastSave(false),
    enableLightDrag: () => toggleLightDrag(true),
    disableLightDrag: () => toggleLightDrag(false),
    enableEdgePan: () => toggleEdgePan(true),
    disableEdgePan: () => toggleEdgePan(false),
    getScrollInfo: () => {
      const container = getEditorScrollContainer();
      return {
        container,
        position: readEditorScroll(container),
        viewport: getEditorVisibleViewportRect(),
      };
    },
    getLocalHistory: () => [...state.localHistory],
    runCompatibilityCheck,
    runDeepCompatibilityCheck,
    captureSafetyBaseline,
    auditServerCoordinates,
    processHasSections,
    flushSectionGroups: () => flushSectionGroupQueue(true),
    clearLocalCopyConnections,
    getLocalCopyConnections: () => [...state.localCopyConnections],
    getSelectedBlocks: () => [
      ...document.querySelectorAll(
        '#flowchart .flowchart-block.flowchart-selected'
      ),
    ].map(block => ({
      id: getBlockId(block),
      position: getBlockPosition(block),
      section: resolveBlockSectionContext(block),
    })),
    getSelectionAudit: () => ({
      visualIds: getVisualSelectedBlockIds(),
      internalIds: getInternalSelectedBlockIds(),
    }),
    clearSelection: () => clearSelectionState('public-api'),
    selectBlocks: blockIds =>
      selectBlocksByIds(blockIds, {
        clearExisting: true,
        reason: 'public-api',
      }).map(getBlockId),
    previewCopyPlacement: blockIds => {
      const ids = normalizePasteBlockIds(blockIds);
      return buildCopiedPlacementPlan(
        ids,
        ids.map((id, index) => `preview-${index + 1}`),
        38
      ).map(item => ({
        sourceId: item.sourceId,
        coords: item.coords,
        section: item.sectionContext,
      }));
    },
    getCompatibility: () => state.compatibility
      ? JSON.parse(JSON.stringify(state.compatibility))
      : null,
    resolveBlockSection: blockOrId => {
      const blockEl =
        blockOrId instanceof Element
          ? blockOrId
          : document.getElementById(`fwb${String(blockOrId || '').replace(/^fwb/, '')}`);
      return blockEl ? resolveBlockSectionContext(blockEl) : null;
    },
    getSettings: () => ({
      fastSaveEnabled: state.fastSaveEnabled,
      lightDragEnabled: state.lightDragEnabled,
      edgePanEnabled: state.edgePanEnabled,
      panelCollapsed: state.panelCollapsed,
      allowedAccountIds: [...CONFIG.allowedAccountIds],
      allowedUserIds: [...CONFIG.allowedUserIds],
      allowAnyAccount: CONFIG.allowAnyAccount,
      allowAnyUser: CONFIG.allowAnyUser,
      allowAnyProcess: CONFIG.allowAnyProcess,
      allowedProcessIds: [...CONFIG.allowedProcessIds],
      externalMoveGuard: CONFIG.externalMoveGuard,
      maxProxyMoveBlocks: SAFE_MAX_PROXY_MOVE_BLOCKS,
      fastSaveKinds: [...SAFE_FAST_SAVE_KINDS],
      referenceProfile: SAFE_REFERENCE_PROFILE
        ? { ...SAFE_REFERENCE_PROFILE }
        : null,
    }),
    collapsePanel: () => setPanelCollapsed(true),
    expandPanel: () => setPanelCollapsed(false),
    destroy,
  };

  log(`v${VERSION} запущен.`, {
    processId: page.processId,
    accountId: page.accountId,
    accountUserId: page.accountUserId,
    connections: getConnections().length,
  });
})();
