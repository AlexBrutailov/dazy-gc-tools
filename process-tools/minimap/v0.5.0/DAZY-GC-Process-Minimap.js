/*
 * DAZY — GC Process Minimap v0.5.0 BETA
 *
 * Первая рабочая версия мини-карты для редактора процессов GetCourse.
 *
 * Возможности:
 * - canvas-отрисовка всего процесса;
 * - реальные цвета карточек и секций;
 * - переключаемые упрощённые связи;
 * - прямоугольник текущей видимой области;
 * - переход по клику;
 * - перетаскивание области обзора;
 * - автоматическое обновление после движения, создания, копирования,
 *   удаления и внутренней синхронизации;
 * - сворачивание и перемещение панели;
 * - сохранение настроек в localStorage.
 *
 * Инструмент ничего не сохраняет на сервере и не изменяет структуру процесса.
 */

(() => {
  'use strict';

  const TOOL_KEY = 'gcProcessMinimapV050Beta';
  const VERSION = '0.5.0 BETA';

  const SHARED_CONFIG =
    window.DAZY_PROCESS_TOOLS_CONFIG &&
    typeof window.DAZY_PROCESS_TOOLS_CONFIG === 'object'
      ? window.DAZY_PROCESS_TOOLS_CONFIG
      : {};

  function normalizeIds(value, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];

    return [...new Set(
      value
        .map(item => Number(item))
        .filter(item => Number.isFinite(item) && item > 0)
    )];
  }

  const CONFIG = {
    allowedAccountIds: normalizeIds(
      SHARED_CONFIG.allowedAccountIds,
      [842325, 60520]
    ),
    allowedUserIds: normalizeIds(
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
    debug: SHARED_CONFIG.debug === true,
    sceneDebounceMs: 90,
    viewportPollMs: 120,
    minimumCanvasWidth: 260,
    minimumCanvasHeight: 150,
  };

  const page = {
    pathname: location.pathname,
    processId: new URLSearchParams(location.search).get('id') || '',
    accountId: Number(window.accountId || window.account_id || 0),
    accountUserId: Number(
      window.accountUserId || window.account_user_id || 0
    ),
  };

  const processAllowed =
    CONFIG.allowAnyProcess ||
    (CONFIG.allowedProcessIds.length > 0 &&
      CONFIG.allowedProcessIds.includes(String(page.processId || '')));

  if (!processAllowed) {
    console.warn(
      '[GC Minimap] Запуск запрещён для текущего processId.',
      { processId: page.processId, allowed: CONFIG.allowedProcessIds }
    );
    return;
  }


  function log(...args) {
    if (CONFIG.debug) console.log('[GC Process Minimap]', ...args);
  }

  function warn(...args) {
    console.warn('[GC Process Minimap]', ...args);
  }

  function isProcessPage() {
    return (
      page.pathname === '/pl/tasks/mission/process' &&
      Boolean(page.processId)
    );
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
    warn('Мини-карта предназначена для страницы процесса GetCourse.');
    return;
  }

  if (!isAllowed()) {
    warn('Доступ запрещён для текущего аккаунта или пользователя.', page);
    return;
  }

  try {
    window[TOOL_KEY]?.destroy?.();
  } catch (_) {}

  const $ = window.jQuery;

  const SETTINGS_KEY =
    `dazyGcProcessMinimapV050Beta:${page.accountId || 'account'}:` +
    `${page.accountUserId || 'user'}`;

  function readSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  const savedSettings = readSettings();

  const state = {
    destroyed: false,
    panel: null,
    canvas: null,
    context: null,
    sceneCanvas: null,
    sceneContext: null,
    style: null,

    collapsed: Boolean(savedSettings.collapsed),
    showConnections: savedSettings.showConnections !== false,
    mapZoom: Math.max(
      1,
      Math.min(16, Number(savedSettings.mapZoom) || 1)
    ),
    mapCenterWorld: null,
    panelLeft:
      Number.isFinite(Number(savedSettings.panelLeft))
        ? Number(savedSettings.panelLeft)
        : null,
    panelTop:
      Number.isFinite(Number(savedSettings.panelTop))
        ? Number(savedSettings.panelTop)
        : 78,

    blocks: [],
    sections: [],
    connections: [],
    bounds: null,
    mapTransform: null,
    viewportWorld: null,

    sceneDirty: true,
    viewportDirty: true,
    renderQueued: false,
    sceneTimer: null,
    animationFrame: 0,
    viewportPollTimer: null,

    mutationObserver: null,
    resizeObserver: null,

    panelDrag: null,
    mapDrag: null,
    pendingPanWorld: null,
    pendingPanFrame: 0,

    listeners: [],
    lastSurfaceRectKey: '',
    lastBlockCount: 0,
    lastConnectionCount: 0,
  };

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          collapsed: state.collapsed,
          showConnections: state.showConnections,
          mapZoom: state.mapZoom,
          panelLeft: state.panelLeft,
          panelTop: state.panelTop,
        })
      );
    } catch (_) {}
  }

  function getPlugin() {
    if (!$) return null;

    const flowchart = $('#flowchart');
    return (
      flowchart.data('gc-flowchartPlugin') ||
      flowchart.data('flowchartPlugin') ||
      null
    );
  }

  function getJsPlumbInstance() {
    return getPlugin()?.instance || window.jsPlumb || null;
  }

  function getWorldContainer() {
    const plugin = getPlugin();

    return (
      plugin?.container?.[0] ||
      document.querySelector('#flowchart .flowchart-container') ||
      document.querySelector('.flowchart-container')
    );
  }

  function getSurface() {
    return getWorldContainer();
  }

  function getPanzoomElement() {
    const pluginPanzoom = getPlugin()?.panzoom;

    return (
      pluginPanzoom?.[0] ||
      (pluginPanzoom instanceof Element ? pluginPanzoom : null) ||
      document.querySelector('#flowchart .panzoom') ||
      document.querySelector('.panzoom')
    );
  }

  function getPanzoomJQuery() {
    const pluginPanzoom = getPlugin()?.panzoom;
    if (pluginPanzoom?.jquery) return pluginPanzoom;

    const element = getPanzoomElement();
    return element && $ ? $(element) : null;
  }

  function getViewportElement() {
    const panzoom = getPanzoomElement();

    return (
      panzoom?.closest?.('.panzoom-container') ||
      document.querySelector('#flowchart .panzoom-container') ||
      document.querySelector('.panzoom-container')
    );
  }

  function isDocumentScroller(element) {
    return (
      element === document.scrollingElement ||
      element === document.documentElement ||
      element === document.body
    );
  }

  function getScrollContainer() {
    const start = getViewportElement() || getPanzoomElement();
    let node = start;

    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const overflowX = style.overflowX;
      const overflowY = style.overflowY;

      const scrollableX =
        node.scrollWidth > node.clientWidth + 2 &&
        /(auto|scroll|overlay)/.test(overflowX);

      const scrollableY =
        node.scrollHeight > node.clientHeight + 2 &&
        /(auto|scroll|overlay)/.test(overflowY);

      if (scrollableX || scrollableY) return node;
      node = node.parentElement;
    }

    return (
      document.scrollingElement ||
      document.documentElement ||
      document.body
    );
  }

  function readScrollPosition(container) {
    if (!container) return { left: 0, top: 0 };

    if (isDocumentScroller(container)) {
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

  function setScrollPosition(container, left, top) {
    if (!container) return { left: 0, top: 0 };

    if (isDocumentScroller(container)) {
      window.scrollTo({
        left: Math.max(0, Number(left) || 0),
        top: Math.max(0, Number(top) || 0),
        behavior: 'auto',
      });
    } else {
      container.scrollLeft = Math.max(0, Number(left) || 0);
      container.scrollTop = Math.max(0, Number(top) || 0);
    }

    return readScrollPosition(container);
  }

  function getVisibleViewportRect() {
    const host = getViewportElement();
    const hostRect = host?.getBoundingClientRect?.();

    const left = Math.max(0, hostRect?.left || 0);
    const top = Math.max(0, hostRect?.top || 0);
    const right = Math.min(
      window.innerWidth,
      hostRect?.right || window.innerWidth
    );
    const bottom = Math.min(
      window.innerHeight,
      hostRect?.bottom || window.innerHeight
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

  function normalizeList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;

    if (typeof value.each === 'function') {
      const result = [];
      value.each(item => result.push(item));
      return result;
    }

    if (typeof value === 'object') {
      return Object.values(value).flatMap(normalizeList);
    }

    return [];
  }

  function getRuntimeConnections() {
    const instance = getJsPlumbInstance();

    try {
      if (typeof instance?.getAllConnections === 'function') {
        return normalizeList(instance.getAllConnections());
      }

      if (typeof instance?.getConnections === 'function') {
        return normalizeList(instance.getConnections());
      }
    } catch (_) {}

    return [];
  }

  function getBlockId(block) {
    return String(
      block?.dataset?.id ||
      block?.getAttribute?.('data-id') ||
      String(block?.id || '').match(/fwb(\d+)/)?.[1] ||
      ''
    );
  }

  function normalizeDomBlockId(value) {
    return String(value || '')
      .replace(/^fwb/, '')
      .replace(/[^\d]/g, '');
  }

  function getConnectionSourceId(connection) {
    return (
      connection?.sourceId ||
      connection?.source?.id ||
      connection?.endpoints?.[0]?.elementId ||
      connection?.endpoints?.[0]?.element?.id ||
      ''
    );
  }

  function getConnectionTargetId(connection) {
    return (
      connection?.targetId ||
      connection?.target?.id ||
      connection?.endpoints?.[1]?.elementId ||
      connection?.endpoints?.[1]?.element?.id ||
      ''
    );
  }

  function isSectionElement(block) {
    return Boolean(
      block?.classList?.contains('flowchart-section') ||
      block?.classList?.contains('group-container')
    );
  }

  function getElementPosition(block) {
    const surface = getWorldContainer();

    let left = 0;
    let top = 0;
    let node = block;
    let guard = 0;

    while (node && node !== surface && guard < 32) {
      left += Number(node.offsetLeft) || 0;
      top += Number(node.offsetTop) || 0;
      node = node.offsetParent;
      guard += 1;
    }

    if (node !== surface) {
      const scale = getSurfaceScale();
      const panzoom = getPanzoomElement();
      const blockRect = block?.getBoundingClientRect?.();
      const panzoomRect = panzoom?.getBoundingClientRect?.();

      if (
        blockRect &&
        panzoomRect &&
        Number.isFinite(scale) &&
        scale > 0
      ) {
        left = (blockRect.left - panzoomRect.left) / scale;
        top = (blockRect.top - panzoomRect.top) / scale;
      } else {
        left = Number.parseFloat(block?.style?.left || '0') || 0;
        top = Number.parseFloat(block?.style?.top || '0') || 0;
      }
    }

    return {
      left,
      top,
      width: Math.max(1, block?.offsetWidth || 1),
      height: Math.max(1, block?.offsetHeight || 1),
    };
  }

  function getElementColor(block, fallback) {
    try {
      const style = getComputedStyle(block);
      const color = style.backgroundColor;

      if (
        color &&
        color !== 'transparent' &&
        color !== 'rgba(0, 0, 0, 0)'
      ) {
        return color;
      }
    } catch (_) {}

    return fallback;
  }

  function getBlockKind(block) {
    if (!block) return 'unknown';
    if (isSectionElement(block)) return 'section';

    const classes = [...block.classList];

    const match = classes.find(className =>
      /-flowchart-block$/i.test(className)
    );

    return match
      ? match.replace(/-flowchart-block$/i, '')
      : 'unknown';
  }

  function getFallbackColor(kind) {
    const colors = {
      start: '#f86646',
      condition: '#c9b8ec',
      question: '#c9b8ec',
      operation: '#9aefb4',
      callbackOperation: '#9aefb4',
      delayed: '#9de9cf',
      waitCondition: '#9de9cf',
      currentTime: '#9de9cf',
      proxy: '#efb7d3',
      note: '#f6d994',
      finish: '#f59e0b',
      subtask: '#b8dff0',
      voiceMessage: '#b8dff0',
      unknown: '#a8b0ba',
    };

    return colors[kind] || colors.unknown;
  }

  function collectScene() {
    const surface = getSurface();
    if (!surface) {
      return {
        blocks: [],
        sections: [],
        connections: [],
        bounds: {
          minX: 0,
          minY: 0,
          maxX: 1000,
          maxY: 1000,
          width: 1000,
          height: 1000,
        },
      };
    }

    const allBlocks = [
      ...surface.querySelectorAll('.flowchart-block'),
    ];

    const blocks = [];
    const sections = [];
    const blockMap = new Map();

    allBlocks.forEach(element => {
      const id = getBlockId(element);
      const position = getElementPosition(element);
      const kind = getBlockKind(element);
      const item = {
        id,
        element,
        kind,
        color: getElementColor(element, getFallbackColor(kind)),
        selected: element.classList.contains('flowchart-selected'),
        local: element.classList.contains('dazy-gc-local-unsynced'),
        ...position,
      };

      if (kind === 'section') {
        sections.push(item);
      } else {
        blocks.push(item);
        if (id) blockMap.set(id, item);
      }
    });

    const runtimeConnections = getRuntimeConnections();
    const connections = [];
    const seenConnections = new Set();

    runtimeConnections.forEach(connection => {
      const sourceId = normalizeDomBlockId(
        getConnectionSourceId(connection)
      );
      const targetId = normalizeDomBlockId(
        getConnectionTargetId(connection)
      );

      const source = blockMap.get(sourceId);
      const target = blockMap.get(targetId);
      if (!source || !target) return;

      const key = `${sourceId}|${targetId}|${connection?.id || ''}`;
      if (seenConnections.has(key)) return;
      seenConnections.add(key);

      connections.push({
        sourceId,
        targetId,
        source,
        target,
        local: Boolean(connection?.__dazyLocalCopyConnection),
      });
    });

    const objects = [...blocks, ...sections];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    objects.forEach(item => {
      minX = Math.min(minX, item.left);
      minY = Math.min(minY, item.top);
      maxX = Math.max(maxX, item.left + item.width);
      maxY = Math.max(maxY, item.top + item.height);
    });

    if (!objects.length) {
      minX = 0;
      minY = 0;
      maxX = 1000;
      maxY = 1000;
    }

    const paddingX = Math.max(220, (maxX - minX) * 0.025);
    const paddingY = Math.max(220, (maxY - minY) * 0.025);

    minX -= paddingX;
    minY -= paddingY;
    maxX += paddingX;
    maxY += paddingY;

    return {
      blocks,
      sections,
      connections,
      bounds: {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      },
    };
  }

  function getSurfaceScale() {
    const pluginScale = Number(
      getPlugin()?.panzoomSettings?.currentScale
    );

    if (Number.isFinite(pluginScale) && pluginScale > 0) {
      return pluginScale;
    }

    const panzoom = getPanzoomElement();
    const transform = panzoom
      ? getComputedStyle(panzoom).transform
      : '';

    if (transform && transform !== 'none') {
      try {
        const matrix = new DOMMatrixReadOnly(transform);
        const scale = Math.sqrt(
          matrix.a * matrix.a + matrix.b * matrix.b
        );

        if (Number.isFinite(scale) && scale > 0) return scale;
      } catch (_) {}
    }

    return 1;
  }

  function collectViewportWorld() {
    const panzoom = getPanzoomElement();
    if (!panzoom) return null;

    const panzoomRect = panzoom.getBoundingClientRect();
    const viewportRect = getVisibleViewportRect();
    const scale = getSurfaceScale();

    if (!Number.isFinite(scale) || scale <= 0) return null;

    return {
      left: (viewportRect.left - panzoomRect.left) / scale,
      top: (viewportRect.top - panzoomRect.top) / scale,
      width: viewportRect.width / scale,
      height: viewportRect.height / scale,
      scale,
    };
  }

  function resizeCanvas() {
    const canvas = state.canvas;
    if (!canvas) return false;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(
      CONFIG.minimumCanvasWidth,
      Math.round(rect.width)
    );
    const cssHeight = Math.max(
      CONFIG.minimumCanvasHeight,
      Math.round(rect.height)
    );
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);

    if (canvas.width === width && canvas.height === height) {
      return false;
    }

    canvas.width = width;
    canvas.height = height;

    state.sceneCanvas.width = width;
    state.sceneCanvas.height = height;

    state.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.sceneContext.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.sceneDirty = true;
    state.viewportDirty = true;
    return true;
  }

  function getCanvasSize() {
    const canvas = state.canvas;
    const rect = canvas?.getBoundingClientRect();

    return {
      width: Math.max(1, rect?.width || 1),
      height: Math.max(1, rect?.height || 1),
    };
  }

  function clampMapCenter(bounds, center, scale, size) {
    const halfWidth = size.width / (2 * scale);
    const halfHeight = size.height / (2 * scale);

    const minCenterX =
      bounds.width <= halfWidth * 2
        ? bounds.minX + bounds.width / 2
        : bounds.minX + halfWidth;

    const maxCenterX =
      bounds.width <= halfWidth * 2
        ? bounds.minX + bounds.width / 2
        : bounds.maxX - halfWidth;

    const minCenterY =
      bounds.height <= halfHeight * 2
        ? bounds.minY + bounds.height / 2
        : bounds.minY + halfHeight;

    const maxCenterY =
      bounds.height <= halfHeight * 2
        ? bounds.minY + bounds.height / 2
        : bounds.maxY - halfHeight;

    return {
      x: Math.max(
        minCenterX,
        Math.min(maxCenterX, Number(center?.x) || minCenterX)
      ),
      y: Math.max(
        minCenterY,
        Math.min(maxCenterY, Number(center?.y) || minCenterY)
      ),
    };
  }

  function computeMapTransform(bounds) {
    const size = getCanvasSize();
    const inset = 9;

    const usableWidth = Math.max(1, size.width - inset * 2);
    const usableHeight = Math.max(1, size.height - inset * 2);

    const fitScale = Math.min(
      usableWidth / bounds.width,
      usableHeight / bounds.height
    );

    const scale = fitScale * state.mapZoom;

    const defaultCenter = {
      x: bounds.minX + bounds.width / 2,
      y: bounds.minY + bounds.height / 2,
    };

    const center = clampMapCenter(
      bounds,
      state.mapCenterWorld || defaultCenter,
      scale,
      {
        width: usableWidth,
        height: usableHeight,
      }
    );

    state.mapCenterWorld = center;

    return {
      scale,
      fitScale,
      centerX: center.x,
      centerY: center.y,
      offsetX: size.width / 2 - center.x * scale,
      offsetY: size.height / 2 - center.y * scale,
      width: size.width,
      height: size.height,
    };
  }

  function worldToCanvas(x, y) {
    const transform = state.mapTransform;
    if (!transform) return { x: 0, y: 0 };

    return {
      x: x * transform.scale + transform.offsetX,
      y: y * transform.scale + transform.offsetY,
    };
  }

  function canvasToWorld(x, y) {
    const transform = state.mapTransform;
    if (!transform || !transform.scale) return { x: 0, y: 0 };

    return {
      x: (x - transform.offsetX) / transform.scale,
      y: (y - transform.offsetY) / transform.scale,
    };
  }

  function drawScene() {
    resizeCanvas();

    const scene = collectScene();
    state.blocks = scene.blocks;
    state.sections = scene.sections;
    state.connections = scene.connections;
    state.bounds = scene.bounds;
    state.mapTransform = computeMapTransform(scene.bounds);

    const context = state.sceneContext;
    const size = getCanvasSize();

    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = '#11161b';
    context.fillRect(0, 0, size.width, size.height);

    context.save();

    // Секции рисуются под связями и карточками.
    scene.sections.forEach(section => {
      const topLeft = worldToCanvas(section.left, section.top);
      const bottomRight = worldToCanvas(
        section.left + section.width,
        section.top + section.height
      );

      const width = Math.max(1, bottomRight.x - topLeft.x);
      const height = Math.max(1, bottomRight.y - topLeft.y);

      context.globalAlpha = 0.16;
      context.fillStyle = section.color;
      context.fillRect(topLeft.x, topLeft.y, width, height);

      context.globalAlpha = 0.72;
      context.strokeStyle = section.color;
      context.lineWidth = 1;
      context.strokeRect(
        topLeft.x + 0.5,
        topLeft.y + 0.5,
        Math.max(0, width - 1),
        Math.max(0, height - 1)
      );
    });

    if (state.showConnections) {
      context.globalAlpha = 0.31;
      context.strokeStyle = '#9aa7b4';
      context.lineWidth = 0.65;

      scene.connections.forEach(connection => {
        const source = worldToCanvas(
          connection.source.left + connection.source.width / 2,
          connection.source.top + connection.source.height / 2
        );
        const target = worldToCanvas(
          connection.target.left + connection.target.width / 2,
          connection.target.top + connection.target.height / 2
        );

        context.beginPath();
        context.moveTo(source.x, source.y);

        const middleX = source.x + (target.x - source.x) * 0.5;
        context.lineTo(middleX, source.y);
        context.lineTo(middleX, target.y);
        context.lineTo(target.x, target.y);

        if (connection.local) {
          context.setLineDash([3, 2]);
        } else {
          context.setLineDash([]);
        }

        context.stroke();
      });

      context.setLineDash([]);
    }

    context.globalAlpha = 1;

    scene.blocks.forEach(block => {
      const topLeft = worldToCanvas(block.left, block.top);
      const bottomRight = worldToCanvas(
        block.left + block.width,
        block.top + block.height
      );

      const width = Math.max(2, bottomRight.x - topLeft.x);
      const height = Math.max(2, bottomRight.y - topLeft.y);

      context.fillStyle = block.color;
      context.fillRect(topLeft.x, topLeft.y, width, height);

      if (block.local) {
        context.strokeStyle = '#f59e0b';
        context.lineWidth = 1.2;
        context.setLineDash([3, 2]);
        context.strokeRect(
          topLeft.x + 0.5,
          topLeft.y + 0.5,
          Math.max(0, width - 1),
          Math.max(0, height - 1)
        );
        context.setLineDash([]);
      } else if (block.selected) {
        context.strokeStyle = '#38bdf8';
        context.lineWidth = 1.2;
        context.strokeRect(
          topLeft.x + 0.5,
          topLeft.y + 0.5,
          Math.max(0, width - 1),
          Math.max(0, height - 1)
        );
      }
    });

    context.restore();

    state.lastBlockCount = scene.blocks.length + scene.sections.length;
    state.lastConnectionCount = scene.connections.length;

    updateStats();
    state.sceneDirty = false;
    state.viewportDirty = true;
  }

  function getViewportCanvasRect() {
    const viewport = state.viewportWorld;
    if (!viewport || !state.mapTransform) return null;

    const topLeft = worldToCanvas(viewport.left, viewport.top);
    const bottomRight = worldToCanvas(
      viewport.left + viewport.width,
      viewport.top + viewport.height
    );

    return {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  function drawViewport() {
    const context = state.context;
    const size = getCanvasSize();

    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(
      state.sceneCanvas,
      0,
      0,
      state.sceneCanvas.width,
      state.sceneCanvas.height,
      0,
      0,
      size.width,
      size.height
    );

    state.viewportWorld = collectViewportWorld();
    const viewportRect = getViewportCanvasRect();
    if (!viewportRect) return;

    context.save();

    context.fillStyle = 'rgba(56, 189, 248, 0.10)';
    context.fillRect(
      viewportRect.left,
      viewportRect.top,
      viewportRect.width,
      viewportRect.height
    );

    context.strokeStyle = '#38bdf8';
    context.lineWidth = 1.7;
    context.strokeRect(
      viewportRect.left + 0.75,
      viewportRect.top + 0.75,
      Math.max(0, viewportRect.width - 1.5),
      Math.max(0, viewportRect.height - 1.5)
    );

    const handleSize = 5;
    context.fillStyle = '#38bdf8';
    context.fillRect(
      viewportRect.left + viewportRect.width / 2 - handleSize / 2,
      viewportRect.top + viewportRect.height / 2 - handleSize / 2,
      handleSize,
      handleSize
    );

    context.restore();
    state.viewportDirty = false;
  }

  function renderFrame() {
    state.animationFrame = 0;
    if (state.destroyed || state.collapsed) return;

    if (state.sceneDirty) drawScene();
    if (state.viewportDirty || state.sceneDirty) drawViewport();
  }

  function queueRender() {
    if (state.renderQueued || state.destroyed) return;

    state.renderQueued = true;
    state.animationFrame = requestAnimationFrame(() => {
      state.renderQueued = false;
      renderFrame();
    });
  }

  function markSceneDirty(delayMs = CONFIG.sceneDebounceMs) {
    state.sceneDirty = true;
    state.viewportDirty = true;

    if (state.sceneTimer) clearTimeout(state.sceneTimer);

    state.sceneTimer = setTimeout(() => {
      state.sceneTimer = null;
      queueRender();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function markViewportDirty() {
    state.viewportDirty = true;
    queueRender();
  }

  function getSurfaceRectKey() {
    const panzoom = getPanzoomElement();
    const viewport = getViewportElement();
    if (!panzoom || !viewport) return '';

    const s = panzoom.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    const scale = getSurfaceScale();

    return [
      Math.round(s.left * 10),
      Math.round(s.top * 10),
      Math.round(s.width * 10),
      Math.round(s.height * 10),
      Math.round(v.width * 10),
      Math.round(v.height * 10),
      Math.round(scale * 10000),
    ].join('|');
  }

  function startViewportPolling() {
    if (state.viewportPollTimer) {
      clearInterval(state.viewportPollTimer);
    }

    state.viewportPollTimer = setInterval(() => {
      if (state.destroyed || state.collapsed) return;

      const key = getSurfaceRectKey();
      if (key !== state.lastSurfaceRectKey) {
        state.lastSurfaceRectKey = key;
        markViewportDirty();
      }

      const currentBlockCount = document.querySelectorAll(
        '#flowchart .flowchart-block'
      ).length;

      const currentConnectionCount = getRuntimeConnections().length;

      if (
        currentBlockCount !== state.lastBlockCount ||
        currentConnectionCount !== state.lastConnectionCount
      ) {
        markSceneDirty(50);
      }
    }, CONFIG.viewportPollMs);
  }

  function readPanzoomMatrix($panzoom) {
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

  function setStatus(text, tone = 'normal') {
    const status = state.panel?.querySelector('[data-role="status"]');
    if (!status) return;

    status.textContent = String(text || '');
    status.dataset.tone = tone;
  }

  function panToWorld(worldX, worldY) {
    const panzoom = getPanzoomElement();
    const scrollContainer = getScrollContainer();

    if (!panzoom || !scrollContainer) {
      setStatus('Не найден слой навигации GetCourse.', 'error');
      return false;
    }

    // SAFE MODE: мини-карта не меняет matrix/panzoom GetCourse.
    // По явному клику пользователя меняется только scroll viewport.
    const scale = getSurfaceScale();
    const viewportRect = getVisibleViewportRect();
    const panzoomRect = panzoom.getBoundingClientRect();

    const targetScreenX = panzoomRect.left + worldX * scale;
    const targetScreenY = panzoomRect.top + worldY * scale;
    const desiredScreenX = viewportRect.left + viewportRect.width / 2;
    const desiredScreenY = viewportRect.top + viewportRect.height / 2;
    const before = readScrollPosition(scrollContainer);

    setScrollPosition(
      scrollContainer,
      before.left + targetScreenX - desiredScreenX,
      before.top + targetScreenY - desiredScreenY
    );

    markViewportDirty();
    setStatus(
      `SAFE переход: x ${Math.round(worldX)}, y ${Math.round(worldY)}. ` +
      'Изменён только scroll; matrix GetCourse не тронут.',
      'success'
    );
    return true;
  }

  function schedulePanToWorld(worldX, worldY) {
    state.pendingPanWorld = { x: worldX, y: worldY };

    if (state.pendingPanFrame) return;

    state.pendingPanFrame = requestAnimationFrame(() => {
      state.pendingPanFrame = 0;

      const point = state.pendingPanWorld;
      state.pendingPanWorld = null;

      if (point) panToWorld(point.x, point.y);
    });
  }

  function getCanvasPoint(event) {
    const rect = state.canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function isPointInsideRect(point, rect) {
    return Boolean(
      rect &&
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height
    );
  }

  function setMapZoom(nextZoom, anchorPoint = null) {
    const previousTransform = state.mapTransform;
    const previousWorld =
      anchorPoint && previousTransform
        ? canvasToWorld(anchorPoint.x, anchorPoint.y)
        : null;

    state.mapZoom = Math.max(
      1,
      Math.min(16, Number(nextZoom) || 1)
    );

    if (
      previousWorld &&
      state.bounds
    ) {
      const size = getCanvasSize();
      const inset = 9;
      const usableWidth = Math.max(1, size.width - inset * 2);
      const usableHeight = Math.max(1, size.height - inset * 2);

      const fitScale = Math.min(
        usableWidth / state.bounds.width,
        usableHeight / state.bounds.height
      );
      const scale = fitScale * state.mapZoom;

      state.mapCenterWorld = {
        x:
          previousWorld.x -
          (anchorPoint.x - size.width / 2) / scale,
        y:
          previousWorld.y -
          (anchorPoint.y - size.height / 2) / scale,
      };
    } else if (state.mapZoom === 1) {
      state.mapCenterWorld = null;
    }

    saveSettings();
    markSceneDirty(0);

    setStatus(
      `Масштаб карты: ${Math.round(state.mapZoom * 100)}%.`,
      'success'
    );
  }

  function fitWholeProcess() {
    state.mapZoom = 1;
    state.mapCenterWorld = null;
    saveSettings();
    markSceneDirty(0);
    setStatus('Показана вся схема процесса.', 'success');
  }

  function handleCanvasWheel(event) {
    const point = getCanvasPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0015);

    setMapZoom(state.mapZoom * factor, point);

    event.preventDefault();
    event.stopPropagation();
  }

  function handleCanvasPointerDown(event) {
    if (event.button !== 0) return;

    const point = getCanvasPoint(event);
    const viewportRect = getViewportCanvasRect();
    const world = canvasToWorld(point.x, point.y);

    state.mapDrag = {
      pointerId: event.pointerId,
      insideViewport: isPointInsideRect(point, viewportRect),
      startPoint: point,
      moved: false,
      viewportOffset:
        isPointInsideRect(point, viewportRect) && viewportRect
          ? {
              x:
                point.x -
                (viewportRect.left + viewportRect.width / 2),
              y:
                point.y -
                (viewportRect.top + viewportRect.height / 2),
            }
          : { x: 0, y: 0 },
    };

    if (!state.mapDrag.insideViewport) {
      schedulePanToWorld(world.x, world.y);
    }

    try {
      state.canvas.setPointerCapture(event.pointerId);
    } catch (_) {}

    event.preventDefault();
    event.stopPropagation();
  }

  function handleCanvasPointerMove(event) {
    const drag = state.mapDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const point = getCanvasPoint(event);
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;

    if (Math.hypot(dx, dy) >= 2) drag.moved = true;

    const adjustedPoint = {
      x: point.x - drag.viewportOffset.x,
      y: point.y - drag.viewportOffset.y,
    };

    const world = canvasToWorld(adjustedPoint.x, adjustedPoint.y);
    schedulePanToWorld(world.x, world.y);

    event.preventDefault();
    event.stopPropagation();
  }

  function finishCanvasDrag(event) {
    if (
      !state.mapDrag ||
      state.mapDrag.pointerId !== event.pointerId
    ) {
      return;
    }

    state.mapDrag = null;

    try {
      state.canvas.releasePointerCapture(event.pointerId);
    } catch (_) {}

    event.preventDefault();
    event.stopPropagation();
  }

  function clampPanelPosition(left, top) {
    const panel = state.panel;
    const width = panel?.offsetWidth || 330;
    const height = panel?.offsetHeight || 260;

    return {
      left: Math.max(
        8,
        Math.min(window.innerWidth - width - 8, left)
      ),
      top: Math.max(
        62,
        Math.min(window.innerHeight - height - 8, top)
      ),
    };
  }

  function applyPanelPosition() {
    if (!state.panel) return;

    const defaultLeft = Math.max(
      58,
      window.innerWidth - state.panel.offsetWidth - 365
    );

    const position = clampPanelPosition(
      state.panelLeft == null ? defaultLeft : state.panelLeft,
      state.panelTop
    );

    state.panelLeft = position.left;
    state.panelTop = position.top;

    state.panel.style.left = `${position.left}px`;
    state.panel.style.top = `${position.top}px`;
    state.panel.style.right = 'auto';
    state.panel.style.bottom = 'auto';
  }

  function handlePanelPointerDown(event) {
    if (
      event.button !== 0 ||
      event.target.closest('button, input, canvas, label')
    ) {
      return;
    }

    const rect = state.panel.getBoundingClientRect();

    state.panelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    try {
      state.panel.setPointerCapture(event.pointerId);
    } catch (_) {}

    event.preventDefault();
  }

  function handlePanelPointerMove(event) {
    const drag = state.panelDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const position = clampPanelPosition(
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY
    );

    state.panelLeft = position.left;
    state.panelTop = position.top;

    state.panel.style.left = `${position.left}px`;
    state.panel.style.top = `${position.top}px`;

    event.preventDefault();
  }

  function finishPanelDrag(event) {
    if (
      !state.panelDrag ||
      state.panelDrag.pointerId !== event.pointerId
    ) {
      return;
    }

    state.panelDrag = null;
    saveSettings();

    try {
      state.panel.releasePointerCapture(event.pointerId);
    } catch (_) {}

    event.preventDefault();
  }

  function updateStats() {
    const target = state.panel?.querySelector('[data-role="stats"]');
    if (!target || !state.bounds) return;

    target.textContent =
      `Блоков: ${state.blocks.length}; ` +
      `секций: ${state.sections.length}; ` +
      `связей: ${state.connections.length}; ` +
      `поле: ${Math.round(state.bounds.width)} × ` +
      `${Math.round(state.bounds.height)} px; ` +
      `карта: ${Math.round(state.mapZoom * 100)}%`;
  }

  function setCollapsed(collapsed, persist = true) {
    state.collapsed = Boolean(collapsed);

    if (state.panel) {
      state.panel.classList.toggle(
        'is-collapsed',
        state.collapsed
      );

      const button =
        state.panel.querySelector('[data-role="collapse"]');

      if (button) {
        button.textContent = state.collapsed ? '+' : '−';
        button.title = state.collapsed
          ? 'Развернуть мини-карту'
          : 'Свернуть мини-карту';
      }
    }

    if (!state.collapsed) {
      markSceneDirty(0);
    }

    if (persist) saveSettings();
  }

  function installStyles() {
    const style = document.createElement('style');
    style.id = 'dazy-gc-process-minimap-style';
    style.textContent = `
      #dazy-gc-process-minimap {
        position: fixed;
        z-index: 2147483644;
        width: 340px;
        padding: 12px;
        border-radius: 14px;
        background: #202326;
        color: #fff;
        font: 13px/1.35 Arial, sans-serif;
        box-shadow: 0 12px 38px rgba(0,0,0,.38);
        user-select: none;
      }

      #dazy-gc-process-minimap * {
        box-sizing: border-box;
      }

      #dazy-gc-process-minimap .dazy-minimap-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        cursor: move;
        touch-action: none;
      }

      #dazy-gc-process-minimap .dazy-minimap-title {
        font-size: 14px;
        font-weight: 700;
      }

      #dazy-gc-process-minimap .dazy-minimap-head-actions {
        display: flex;
        align-items: center;
        gap: 7px;
      }

      #dazy-gc-process-minimap .dazy-minimap-version {
        opacity: .58;
        font-size: 11px;
      }

      #dazy-gc-process-minimap button {
        border: 0;
        border-radius: 8px;
        padding: 7px 9px;
        color: #fff;
        background: #3b4653;
        cursor: pointer;
        font-weight: 700;
      }

      #dazy-gc-process-minimap button:hover {
        filter: brightness(1.08);
      }

      #dazy-gc-process-minimap [data-role="collapse"] {
        width: 28px;
        min-width: 28px;
        height: 26px;
        padding: 0;
        font-size: 17px;
        line-height: 1;
      }

      #dazy-gc-process-minimap .dazy-minimap-body {
        margin-top: 10px;
      }

      #dazy-gc-process-minimap.is-collapsed {
        width: 254px;
        padding-bottom: 10px;
      }

      #dazy-gc-process-minimap.is-collapsed .dazy-minimap-body {
        display: none;
      }

      #dazy-gc-process-minimap canvas {
        display: block;
        width: 100%;
        height: 220px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 9px;
        background: #11161b;
        cursor: crosshair;
        touch-action: none;
      }

      #dazy-gc-process-minimap .dazy-minimap-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 9px;
        margin-top: 9px;
      }

      #dazy-gc-process-minimap .dazy-minimap-toggle {
        display: flex;
        align-items: center;
        gap: 7px;
        color: #d4dade;
        cursor: pointer;
      }

      #dazy-gc-process-minimap .dazy-minimap-toggle input {
        margin: 0;
      }

      #dazy-gc-process-minimap .dazy-minimap-button-group {
        display: flex;
        gap: 6px;
      }

      #dazy-gc-process-minimap [data-role="fit"] {
        background: #4b5563;
      }

      #dazy-gc-process-minimap [data-role="refresh"] {
        background: #385a85;
      }

      #dazy-gc-process-minimap .dazy-minimap-status {
        margin-top: 8px;
        padding: 7px 8px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #cbd1d5;
        font-size: 11px;
      }

      #dazy-gc-process-minimap .dazy-minimap-status[data-tone="success"] {
        background: rgba(34,197,94,.16);
        color: #bbf7d0;
      }

      #dazy-gc-process-minimap .dazy-minimap-status[data-tone="error"] {
        background: rgba(239,68,68,.18);
        color: #fecaca;
      }

      #dazy-gc-process-minimap .dazy-minimap-stats {
        margin-top: 8px;
        padding: 7px 8px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #cbd1d5;
        font-size: 11px;
      }

      #dazy-gc-process-minimap .dazy-minimap-help {
        margin-top: 7px;
        color: #9eabb4;
        font-size: 11px;
      }
    `;

    document.head.appendChild(style);
    state.style = style;
  }

  function addListener(target, type, handler, options) {
    if (!target) return;

    target.addEventListener(type, handler, options);
    state.listeners.push(() =>
      target.removeEventListener(type, handler, options)
    );
  }

  function installPanel() {
    const panel = document.createElement('div');
    panel.id = 'dazy-gc-process-minimap';
    panel.innerHTML = `
      <div class="dazy-minimap-head" data-role="drag-handle">
        <span class="dazy-minimap-title">DAZY Process Minimap</span>
        <div class="dazy-minimap-head-actions">
          <span class="dazy-minimap-version">v${VERSION}</span>
          <button
            type="button"
            data-role="collapse"
            title="Свернуть мини-карту"
          >−</button>
        </div>
      </div>

      <div class="dazy-minimap-body">
        <canvas data-role="canvas"></canvas>

        <div class="dazy-minimap-controls">
          <label class="dazy-minimap-toggle">
            <input type="checkbox" data-role="connections">
            <span>Показывать связи</span>
          </label>

          <div class="dazy-minimap-button-group">
            <button type="button" data-role="fit">
              Вся схема
            </button>
            <button type="button" data-role="refresh">
              Обновить
            </button>
          </div>
        </div>

        <div
          class="dazy-minimap-status"
          data-role="status"
          data-tone="normal"
        >Мини-карта готовится…</div>

        <div class="dazy-minimap-stats" data-role="stats">
          Собираю структуру процесса…
        </div>

        <div class="dazy-minimap-help">
          Клик — перейти к области. Перетаскивание голубой рамки —
          перемещаться по процессу. Колесо мыши — масштаб карты.
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    state.panel = panel;
    state.canvas = panel.querySelector('[data-role="canvas"]');
    state.context = state.canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });

    state.sceneCanvas = document.createElement('canvas');
    state.sceneContext = state.sceneCanvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });

    const connections =
      panel.querySelector('[data-role="connections"]');
    connections.checked = state.showConnections;

    panel
      .querySelectorAll('button, input, label, canvas')
      .forEach(control => {
        addListener(control, 'pointerdown', event => {
          event.stopPropagation();
        });
      });

    addListener(
      panel.querySelector('[data-role="collapse"]'),
      'click',
      () => setCollapsed(!state.collapsed)
    );

    addListener(connections, 'change', event => {
      state.showConnections = Boolean(event.target.checked);
      saveSettings();
      markSceneDirty(0);
    });

    addListener(
      panel.querySelector('[data-role="fit"]'),
      'click',
      () => fitWholeProcess()
    );

    addListener(
      panel.querySelector('[data-role="refresh"]'),
      'click',
      () => refresh()
    );

    addListener(
      panel.querySelector('[data-role="drag-handle"]'),
      'pointerdown',
      handlePanelPointerDown
    );
    addListener(panel, 'pointermove', handlePanelPointerMove);
    addListener(panel, 'pointerup', finishPanelDrag);
    addListener(panel, 'pointercancel', finishPanelDrag);

    addListener(
      state.canvas,
      'wheel',
      handleCanvasWheel,
      { passive: false }
    );

    addListener(
      state.canvas,
      'pointerdown',
      handleCanvasPointerDown
    );
    addListener(
      state.canvas,
      'pointermove',
      handleCanvasPointerMove
    );
    addListener(state.canvas, 'pointerup', finishCanvasDrag);
    addListener(state.canvas, 'pointercancel', finishCanvasDrag);

    addListener(window, 'resize', () => {
      applyPanelPosition();
      markSceneDirty(0);
    });

    applyPanelPosition();
    setCollapsed(state.collapsed, false);
  }

  function installObservers() {
    const flowchart = document.getElementById('flowchart');
    if (!flowchart) return;

    state.mutationObserver = new MutationObserver(mutations => {
      let sceneChanged = false;
      let viewportChanged = false;

      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.target === getPanzoomElement() &&
          mutation.attributeName === 'style'
        ) {
          viewportChanged = true;
          continue;
        }

        if (
          mutation.type === 'childList' ||
          mutation.attributeName === 'style' ||
          mutation.attributeName === 'class'
        ) {
          sceneChanged = true;
        }
      }

      if (sceneChanged) {
        markSceneDirty();
      } else if (viewportChanged) {
        markViewportDirty();
      }
    });

    state.mutationObserver.observe(flowchart, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => {
        markSceneDirty(0);
      });

      state.resizeObserver.observe(state.canvas);

      const viewport = getViewportElement();
      if (viewport) state.resizeObserver.observe(viewport);
    }

    if ($) {
      const panzoom = getPanzoomElement();

      if (panzoom) {
        const handler = () => markViewportDirty();
        $(panzoom).on(
          'panzoomchange.dazyMinimap ' +
          'panzoompan.dazyMinimap ' +
          'panzoomzoom.dazyMinimap',
          handler
        );

        state.listeners.push(() => {
          try {
            $(panzoom).off('.dazyMinimap');
          } catch (_) {}
        });
      }
    }
  }

  function refresh() {
    if (state.destroyed) return false;

    try {
      state.sceneDirty = true;
      state.viewportDirty = true;
      drawScene();
      drawViewport();
      setStatus(
        `Обновлено: ${new Date().toLocaleTimeString()}.`,
        'success'
      );
      return true;
    } catch (error) {
      setStatus(
        `Ошибка обновления: ${error?.message || error}`,
        'error'
      );
      warn('Не удалось обновить мини-карту:', error);
      return false;
    }
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;

    if (state.sceneTimer) clearTimeout(state.sceneTimer);
    if (state.viewportPollTimer) {
      clearInterval(state.viewportPollTimer);
    }
    if (state.animationFrame) {
      cancelAnimationFrame(state.animationFrame);
    }
    if (state.pendingPanFrame) {
      cancelAnimationFrame(state.pendingPanFrame);
    }

    state.mutationObserver?.disconnect();
    state.resizeObserver?.disconnect();

    state.listeners.splice(0).forEach(remove => {
      try {
        remove();
      } catch (_) {}
    });

    state.panel?.remove();
    state.style?.remove();

    try {
      delete window[TOOL_KEY];
    } catch (_) {
      window[TOOL_KEY] = null;
    }

    log('Мини-карта остановлена.');
  }

  installStyles();
  installPanel();
  installObservers();
  startViewportPolling();
  // SAFE MODE: при запуске не изменяем pan/zoom/scroll редактора.
  refresh();

  window[TOOL_KEY] = {
    version: VERSION,
    page: { ...page },
    safetyMode: 'no-automatic-panzoom-mutation',
    refresh,
    fitWholeProcess,
    setMapZoom: value => setMapZoom(Number(value) || 1),
    panTo: (x, y) => panToWorld(Number(x) || 0, Number(y) || 0),
    getPanzoomInfo: () => {
      const panzoom = getPanzoomElement();
      const viewport = getViewportElement();
      const $panzoom = getPanzoomJQuery();

      return {
        panzoomElement: panzoom,
        viewportElement: viewport,
        matrix: readPanzoomMatrix($panzoom),
        scale: getSurfaceScale(),
      };
    },
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
    showConnections: enabled => {
      state.showConnections = Boolean(enabled);

      const input =
        state.panel?.querySelector('[data-role="connections"]');

      if (input) input.checked = state.showConnections;
      saveSettings();
      markSceneDirty(0);
    },
    getState: () => ({
      blockCount: state.blocks.length,
      sectionCount: state.sections.length,
      connectionCount: state.connections.length,
      bounds: state.bounds ? { ...state.bounds } : null,
      viewport: state.viewportWorld
        ? { ...state.viewportWorld }
        : null,
      showConnections: state.showConnections,
      mapZoom: state.mapZoom,
      mapCenterWorld: state.mapCenterWorld
        ? { ...state.mapCenterWorld }
        : null,
      scrollPosition: readScrollPosition(getScrollContainer()),
      collapsed: state.collapsed,
    }),
    destroy,
  };

  log(`v${VERSION} запущена.`, {
    processId: page.processId,
    accountId: page.accountId,
    accountUserId: page.accountUserId,
  });
})();
