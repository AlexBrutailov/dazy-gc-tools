/*
 * DAZY — GC Process Tools Launcher v0.5.2 BETA
 * SMART project.
 *
 * В GetCourse остаётся только этот файл.
 * Инструменты загружаются с GitHub Pages.
 */
(function () {
  'use strict';

  var TOOL_KEY = 'gcProcessToolsLauncherV052Beta';
  var BOOT_KEY = '__DAZY_PROCESS_TOOLS_LAUNCHER_BOOT_V052_BETA__';
  var STORAGE_KEY = 'gc-process-tools-launcher';

  if (window[BOOT_KEY]) {
    console.info('[DAZY Process Tools] Повторный запуск лаунчера пропущен.');
    return;
  }

  window[BOOT_KEY] = true;

  var TARGET_PAGE = {
    origin: 'https://course.smart-child.ru',
    pathname: '/pl/tasks/mission/process',
    processIds: ['2592961']
  };

  var ACCESS_CONFIG = {
    allowedUserIds: [
      355017780,
      95427939,
      141682633
    ],

    /*
      Админский интерфейс увидят только эти пользователи.
      Остальные allowedUserIds получат упрощённую рабочую панель.
    */
    adminUserIds: [
      355017780
    ],

    allowedAccountIds: [
      60520
    ]
  };

  var GITHUB_BASE =
    'https://alexbrutailov.github.io/dazy-gc-tools';

  window.DAZY_PROCESS_TOOLS_CONFIG = {
    allowedUserIds: ACCESS_CONFIG.allowedUserIds.slice(),
    allowedAccountIds: ACCESS_CONFIG.allowedAccountIds.slice(),
    allowedProcessIds: TARGET_PAGE.processIds.slice(),

    allowAnyUser: false,
    allowAnyAccount: false,
    allowAnyProcess: false,

    externalMoveGuard: true,
    managedUi: true,
    compactUi: true,
    linkUiHostSelector:
      '#gcptl-panel-v051 [data-role="link-ui-host"]',

    massMoveLimit: 16,
    massMovePermitTtlMs: 60000,
    baselineHistoryLimit: 3,
    moveHistoryLimit: 10,
    snapshotGroupMoves: true,

    referenceProfile: {
      sourceProcessId: '315988',
      blocks: 741,
      connections: 1058,
      sections: 1
    },

    debug: false
  };

  var SCRIPT_URLS = {
    safetyGuard:
      GITHUB_BASE +
      '/process-tools/safety-guard/v0.2.1/DAZY-GC-Process-Safety-Guard.js',

    fastEditor:
      GITHUB_BASE +
      '/process-tools/fast-editor/v1.5.1/DAZY-GC-Process-Fast-Editor.js',

    minimap:
      GITHUB_BASE +
      '/process-tools/minimap/v0.6.0/DAZY-GC-Process-Minimap.js'
  };

  var GLOBAL_KEYS = {
    safetyGuard: 'gcProcessSafetyGuardV021Beta',
    fastEditor: 'gcProcessFastEditorV151Beta',
    minimap: 'gcProcessMinimapV060Beta'
  };

  var state = {
    panel: null,
    style: null,
    collapsed: true,
    adminOpen: false,
    loading: false,
    statusTimer: null,
    safetyState: null,
    activeOperation: '',
    handlers: []
  };

  var currentUrl = new URL(window.location.href);
  var currentProcessId =
    currentUrl.searchParams.get('id');

  var allowedPage =
    currentUrl.origin === TARGET_PAGE.origin &&
    currentUrl.pathname === TARGET_PAGE.pathname &&
    TARGET_PAGE.processIds.indexOf(currentProcessId) !== -1;

  if (!allowedPage) {
    console.info(
      '[DAZY Process Tools] Страница не входит в allowlist.',
      currentUrl.href
    );
    return;
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function includesNum(list, value) {
    value = num(value);

    return (
      value !== null &&
      list.map(Number).indexOf(value) !== -1
    );
  }

  function accessAllowed() {
    return (
      includesNum(
        ACCESS_CONFIG.allowedAccountIds,
        window.accountId
      ) &&
      includesNum(
        ACCESS_CONFIG.allowedUserIds,
        window.accountUserId
      )
    );
  }

  function isAdmin() {
    return includesNum(
      ACCESS_CONFIG.adminUserIds,
      window.accountUserId
    );
  }

  if (!accessAllowed()) {
    console.warn(
      '[DAZY Process Tools] Доступ запрещён.',
      {
        accountId: window.accountId,
        accountUserId: window.accountUserId
      }
    );
    return;
  }

  function readSetting(name, fallback) {
    try {
      var raw =
        localStorage.getItem(
          STORAGE_KEY + ':' + name
        );

      if (raw === null) return fallback;

      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function saveSetting(name, value) {
    try {
      localStorage.setItem(
        STORAGE_KEY + ':' + name,
        JSON.stringify(value)
      );
    } catch (_) {}
  }

  function tool(name) {
    return window[GLOBAL_KEYS[name]] || null;
  }

  function loadScript(name) {
    if (tool(name)) {
      return Promise.resolve(tool(name));
    }

    return new Promise(function (resolve, reject) {
      var old = document.querySelector(
        'script[data-dazy-process-tool="' +
        name +
        '"]'
      );

      if (old) old.remove();

      var script = document.createElement('script');

      script.src = SCRIPT_URLS[name];
      script.async = true;
      script.dataset.dazyProcessTool = name;

      script.onload = function () {
        window.setTimeout(function () {
          var loaded = tool(name);

          if (loaded) {
            resolve(loaded);
          } else {
            reject(
              new Error(
                name +
                ' загрузился, но global не найден.'
              )
            );
          }
        }, 0);
      };

      script.onerror = function () {
        reject(
          new Error(
            'Не удалось загрузить ' +
            SCRIPT_URLS[name]
          )
        );
      };

      document.head.appendChild(script);
    });
  }

  function destroyTool(name) {
    try {
      tool(name)?.destroy?.();
    } catch (error) {
      console.warn(
        '[DAZY Process Tools] Ошибка остановки ' +
        name +
        ':',
        error
      );
    }
  }

  function setStatus(message, tone, timeout) {
    var el =
      state.panel?.querySelector(
        '[data-role="status"]'
      );

    if (!el) return;

    clearTimeout(state.statusTimer);

    el.textContent = String(message || 'Готово');
    el.dataset.tone = tone || 'normal';

    if (timeout) {
      state.statusTimer =
        window.setTimeout(function () {
          el.textContent =
            'Изменения сохраняются автоматически.';
          el.dataset.tone = 'normal';
        }, timeout);
    }
  }

  function updateButton(
    role,
    enabled,
    onText,
    offText
  ) {
    var button =
      state.panel?.querySelector(
        '[data-role="' + role + '"]'
      );

    if (!button) return;

    button.classList.toggle(
      'is-active',
      Boolean(enabled)
    );

    button.textContent =
      enabled ? onText : offText;
  }

  function updateUi() {
    if (!state.panel) return;

    var fast = tool('fastEditor');
    var mini = tool('minimap');
    var guard = tool('safetyGuard');

    var fastState =
      fast?.getUiState?.() ||
      fast?.state ||
      {};

    updateButton(
      'minimap',
      mini?.isVisible?.() !== false,
      'Скрыть мини-карту',
      'Мини-карта'
    );

    updateButton(
      'links',
      Boolean(fastState.linkMode),
      'Изменение связей включено',
      'Изменить связи блоков'
    );

    updateButton(
      'drag',
      Boolean(fastState.lightDragEnabled),
      'Быстрое перемещение включено',
      'Быстрое перемещение блоков'
    );

    var safety =
      guard?.getState?.() ||
      state.safetyState ||
      {};

    state.safetyState = safety;

    var undo =
      state.panel.querySelector(
        '[data-role="undo-move"]'
      );

    if (undo) {
      var history =
        Number(safety.moveHistoryCount || 0);

      undo.disabled =
        history < 1 ||
        state.activeOperation === 'undo-group-move';

      undo.textContent =
        state.activeOperation === 'undo-group-move'
          ? 'Отмена выполняется…'
          : (
              history > 0
                ? 'Отменить последний перенос группы'
                : 'Нет переноса для отмены'
            );
    }

    var permit =
      state.panel.querySelector(
        '[data-role="permit"]'
      );

    if (permit) {
      var pending =
        Number(safety.pendingMassCount || 0);

      permit.hidden =
        !(pending > Number(
          safety.massMoveLimit || 16
        ));

      if (!permit.hidden) {
        permit.textContent =
          'Разрешить один перенос: ' +
          pending +
          ' блоков';
      }
    }

    var restoreBaseline =
      state.panel.querySelector(
        '[data-role="restore-baseline"]'
      );

    if (restoreBaseline) {
      var moved =
        Number(
          safety.baselineAudit?.moved || 0
        );

      restoreBaseline.disabled = moved < 1;

      restoreBaseline.textContent =
        moved > 0
          ? 'Восстановить координаты: ' +
            moved +
            ' блоков'
          : 'Восстановить координаты';
    }

    var adminSection =
      state.panel.querySelector(
        '[data-role="admin-section"]'
      );

    if (adminSection) {
      adminSection.hidden =
        !isAdmin() || !state.adminOpen;
    }

    var adminButton =
      state.panel.querySelector(
        '[data-role="admin-toggle"]'
      );

    if (adminButton) {
      adminButton.hidden = !isAdmin();
      adminButton.textContent =
        state.adminOpen
          ? 'Скрыть админ-инструменты'
          : 'Админ-инструменты';
    }
  }

  function nextPaint() {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  async function undoLastGroupMove() {
    var guard = tool('safetyGuard');
    var fast = tool('fastEditor');

    if (!guard) {
      setStatus(
        'Защита координат не загружена.',
        'error',
        2800
      );
      return;
    }

    if (state.activeOperation) {
      return;
    }

    state.activeOperation = 'undo-group-move';
    updateUi();

    try {
      setStatus(
        'Отмена выполняется, пожалуйста, подождите…',
        'loading'
      );

      // Даём браузеру реально отрисовать сообщение ДО тяжёлого запроса.
      await nextPaint();

      await guard.previewLatestMoveRestore();

      var preview =
        guard.getState?.().movePreview;

      if (!preview?.changed) {
        setStatus(
          'Координаты последнего переноса уже совпадают.',
          'success',
          3200
        );
        return;
      }

      setStatus(
        'Возвращаю координаты блоков. Не закрывайте страницу…',
        'loading'
      );

      await nextPaint();

      var result =
        await guard.restoreLatestMove();

      if (!result?.verified) {
        setStatus(
          'GetCourse ещё не подтвердил все координаты. Обновите страницу перед повторной попыткой.',
          'warning',
          5200
        );
        return;
      }

      setStatus(
        'Координаты восстановлены. Обновляю блоки на схеме…',
        'loading'
      );

      await nextPaint();

      var localResult =
        fast?.applyExternalCoordinateRestore?.(
          result.restoredBlocks || []
        ) || {
          updated: 0,
          missing: []
        };

      await nextPaint();

      if (localResult.missing?.length) {
        setStatus(
          'Перенос отменён на сервере. Часть блоков не найдена в текущем DOM — обновите страницу.',
          'warning',
          5200
        );
      } else {
        setStatus(
          `Последний перенос отменён. Восстановлено блоков: ${result.restored || localResult.updated || 0}.`,
          'success',
          4200
        );
      }
    } finally {
      state.activeOperation = '';
      updateUi();
    }
  }

  async function auditBaseline() {
    var guard = tool('safetyGuard');

    setStatus(
      'Проверяю координаты…',
      'loading'
    );

    var result =
      await guard?.auditBaseline?.();

    var moved =
      Number(result?.diff?.moved?.length || 0);

    setStatus(
      moved
        ? 'От точки восстановления отличаются ' +
          moved +
          ' блоков.'
        : 'Координаты совпадают с точкой восстановления.',
      moved ? 'warning' : 'success',
      3500
    );

    updateUi();
  }

  function installStyles() {
    var style =
      document.createElement('style');

    style.id =
      'gcptl-styles-v051-beta';

    style.textContent = `
      #gcptl-panel-v051 {
        position: fixed;
        left: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: 286px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 14px;
        background: #202326;
        color: #fff;
        font: 12px/1.35 Arial,sans-serif;
        box-shadow: 0 12px 38px rgba(0,0,0,.36);
      }

      #gcptl-panel-v051 * {
        box-sizing: border-box;
      }

      #gcptl-panel-v051 .gcptl-fab {
        display: none;
      }

      #gcptl-panel-v051 .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      #gcptl-panel-v051 .title {
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        user-select: none;
      }

      #gcptl-panel-v051 .gcptl-collapse-btn {
        width: 28px;
        height: 26px;
        margin: 0;
        padding: 0;
      }

      #gcptl-panel-v051 .body {
        margin-top: 8px;
      }

      #gcptl-panel-v051 button {
        width: 100%;
        margin-top: 6px;
        padding: 8px 9px;
        border: 1px solid rgba(255,255,255,.13);
        border-radius: 8px;
        background: #34445c;
        color: #fff;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
      }

      #gcptl-panel-v051 button:hover {
        filter: brightness(1.08);
      }

      #gcptl-panel-v051 button:disabled {
        opacity: .48;
        cursor: default;
        filter: none;
      }

      #gcptl-panel-v051 button.is-active {
        background: #0d7138;
        border-color: rgba(74,222,128,.55);
      }

      #gcptl-panel-v051 [data-role="permit"] {
        background: #8a5b09;
      }

      #gcptl-panel-v051 .status {
        margin-top: 7px;
        padding: 7px 8px;
        border-radius: 8px;
        background: rgba(255,255,255,.06);
        color: #cbd5e1;
      }

      #gcptl-panel-v051 .status[data-tone="success"] {
        background: rgba(22,101,52,.42);
        color: #d1fae5;
      }

      #gcptl-panel-v051 .status[data-tone="warning"] {
        background: rgba(146,92,8,.42);
        color: #fef3c7;
      }

      #gcptl-panel-v051 .status[data-tone="error"] {
        background: rgba(127,29,29,.55);
        color: #fee2e2;
      }

      #gcptl-panel-v051 .status[data-tone="loading"] {
        background: rgba(76,29,149,.42);
        color: #ede9fe;
      }

      #gcptl-panel-v051 .separator {
        height: 1px;
        margin: 9px 0 3px;
        background: rgba(255,255,255,.1);
      }

      #gcptl-panel-v051 .admin {
        margin-top: 6px;
        padding-top: 2px;
      }

      #gcptl-panel-v051.is-collapsed {
        width: 58px;
        height: 58px;
        padding: 0;
        border-radius: 50%;
        background: transparent;
        border: 0;
        box-shadow: 0 10px 28px rgba(0,0,0,.32);
      }

      #gcptl-panel-v051.is-collapsed .head,
      #gcptl-panel-v051.is-collapsed .body {
        display: none;
      }

      #gcptl-panel-v051.is-collapsed .gcptl-fab {
        display: flex;
        width: 58px;
        height: 58px;
        margin: 0;
        padding: 0;
        border-radius: 50%;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(255,255,255,.14);
        background: #202326;
        color: #fff;
        font-size: 12px;
        letter-spacing: .4px;
        box-shadow: 0 10px 28px rgba(0,0,0,.32);
      }
    `;

    document.head.appendChild(style);
    state.style = style;
  }

  function installPanel() {
    var panel =
      document.createElement('div');

    panel.id = 'gcptl-panel-v051';

    panel.innerHTML = `
      <button
        type="button"
        class="gcptl-fab"
        data-role="expand"
        title="Открыть DAZY"
      >DAZY</button>

      <div class="head">
        <span class="title">DAZY</span>
        <button
          type="button"
          class="gcptl-collapse-btn"
          data-role="collapse"
          title="Свернуть"
        >−</button>
      </div>

      <div class="body">
        <button type="button" data-role="minimap">
          Мини-карта
        </button>

        <button type="button" data-role="links">
          Изменить связи блоков
        </button>

        <div data-role="link-ui-host"></div>

        <button type="button" data-role="drag">
          Быстрое перемещение блоков
        </button>

        <button
          type="button"
          data-role="permit"
          hidden
        >Разрешить один массовый перенос</button>

        <button
          type="button"
          data-role="undo-move"
          disabled
        >Нет переноса для отмены</button>

        <div
          class="status"
          data-role="status"
          data-tone="normal"
        >Изменения сохраняются автоматически.</div>

        <button
          type="button"
          data-role="admin-toggle"
          hidden
        >Админ-инструменты</button>

        <div
          class="admin"
          data-role="admin-section"
          hidden
        >
          <div class="separator"></div>

          <button
            type="button"
            data-role="sync"
            title="Перечитать серверное состояние и полностью перерисовать схему. Это не кнопка сохранения."
          >Синхронизировать схему</button>

          <button
            type="button"
            data-role="audit"
            title="Сравнить текущие серверные координаты с сохранённой точкой восстановления."
          >Проверить координаты</button>

          <button
            type="button"
            data-role="baseline-new"
            title="Считать текущее расположение блоков корректным и сохранить новую точку восстановления."
          >Обновить точку восстановления</button>

          <button
            type="button"
            data-role="restore-baseline"
            disabled
            title="Вернуть только отличающиеся координаты к последней точке восстановления."
          >Восстановить координаты</button>

          <button
            type="button"
            data-role="compatibility"
            title="Проверить внутренние API и структуру текущего редактора GetCourse."
          >Проверить совместимость</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    state.panel = panel;

    state.collapsed =
      readSetting('collapsed', true);

    panel.classList.toggle(
      'is-collapsed',
      state.collapsed
    );

    panel
      .querySelector('[data-role="expand"]')
      .addEventListener(
        'click',
        function () {
          state.collapsed = false;
          panel.classList.remove(
            'is-collapsed'
          );
          saveSetting(
            'collapsed',
            false
          );
        }
      );

    panel
      .querySelector('[data-role="collapse"]')
      .addEventListener(
        'click',
        function () {
          state.collapsed = true;
          panel.classList.add(
            'is-collapsed'
          );
          saveSetting(
            'collapsed',
            true
          );
        }
      );

    panel
      .querySelector('.title')
      ?.addEventListener(
        'click',
        function () {
          state.collapsed = true;
          panel.classList.add(
            'is-collapsed'
          );
          saveSetting(
            'collapsed',
            true
          );
        }
      );

    panel
      .querySelector('[data-role="minimap"]')
      .addEventListener(
        'click',
        function () {
          var mini = tool('minimap');
          if (!mini) return;

          mini.toggle?.();
          updateUi();
        }
      );

    panel
      .querySelector('[data-role="links"]')
      .addEventListener(
        'click',
        function () {
          var fast = tool('fastEditor');
          if (!fast) return;

          if (fast.getUiState?.().linkMode) {
            fast.disableLinks?.();
          } else {
            fast.enableLinks?.();
          }

          updateUi();
        }
      );

    panel
      .querySelector('[data-role="drag"]')
      .addEventListener(
        'click',
        function () {
          var fast = tool('fastEditor');
          if (!fast) return;

          var nextEnabled =
            !Boolean(
              fast.getUiState?.()
                .lightDragEnabled
            );

          if (nextEnabled) {
            fast.enableLightDrag?.();
          } else {
            fast.disableLightDrag?.();
          }

          saveSetting(
            'fastDragEnabled',
            nextEnabled
          );

          updateUi();

          setStatus(
            nextEnabled
              ? 'Быстрое перемещение включено.'
              : 'Быстрое перемещение выключено.',
            'success',
            1800
          );
        }
      );

    panel
      .querySelector('[data-role="permit"]')
      .addEventListener(
        'click',
        function () {
          tool('safetyGuard')
            ?.allowPendingMassMove?.();

          setStatus(
            'Разрешён один перенос выбранной большой группы.',
            'warning',
            3200
          );

          updateUi();
        }
      );

    panel
      .querySelector('[data-role="undo-move"]')
      .addEventListener(
        'click',
        function () {
          void undoLastGroupMove()
            .catch(function (error) {
              console.error(error);
              setStatus(
                String(
                  error?.message ||
                  error
                ),
                'error',
                4000
              );
            });
        }
      );

    var adminToggle =
      panel.querySelector(
        '[data-role="admin-toggle"]'
      );

    if (adminToggle) {
      adminToggle.addEventListener(
        'click',
        function () {
          state.adminOpen =
            !state.adminOpen;

          updateUi();
        }
      );
    }

    panel
      .querySelector('[data-role="sync"]')
      ?.addEventListener(
        'click',
        function () {
          tool('fastEditor')
            ?.fullSync?.('admin-manual');

          setStatus(
            'Синхронизация схемы запущена.',
            'loading',
            3800
          );
        }
      );

    panel
      .querySelector('[data-role="audit"]')
      ?.addEventListener(
        'click',
        function () {
          void auditBaseline()
            .catch(function (error) {
              setStatus(
                String(
                  error?.message ||
                  error
                ),
                'error',
                4000
              );
            });
        }
      );

    panel
      .querySelector('[data-role="baseline-new"]')
      ?.addEventListener(
        'click',
        function () {
          setStatus(
            'Сохраняю новую точку восстановления…',
            'loading'
          );

          void tool('safetyGuard')
            ?.createBaseline?.()
            .then(function () {
              setStatus(
                'Новая точка восстановления сохранена.',
                'success',
                3000
              );

              updateUi();
            })
            .catch(function (error) {
              setStatus(
                String(
                  error?.message ||
                  error
                ),
                'error',
                4000
              );
            });
        }
      );

    panel
      .querySelector('[data-role="restore-baseline"]')
      ?.addEventListener(
        'click',
        function () {
          setStatus(
            'Восстанавливаю координаты…',
            'loading'
          );

          void tool('safetyGuard')
            ?.restoreBaseline?.()
            .then(function () {
              setStatus(
                'Координаты восстановлены.',
                'success',
                3000
              );

              updateUi();

              tool('fastEditor')
                ?.fullSync?.(
                  'restore-baseline'
                );
            })
            .catch(function (error) {
              setStatus(
                String(
                  error?.message ||
                  error
                ),
                'error',
                4000
              );
            });
        }
      );

    panel
      .querySelector('[data-role="compatibility"]')
      ?.addEventListener(
        'click',
        function () {
          setStatus(
            'Проверяю совместимость…',
            'loading'
          );

          void Promise.resolve(
            tool('fastEditor')
              ?.runDeepCompatibilityCheck?.()
          )
            .then(function () {
              var result =
                tool('fastEditor')
                  ?.getCompatibility?.();

              var critical =
                result?.critical?.length || 0;

              var warnings =
                result?.warnings?.length || 0;

              setStatus(
                critical
                  ? 'Найдены критические несовместимости: ' +
                    critical
                  : (
                      warnings
                        ? 'Совместимость подтверждена. Предупреждений: ' +
                          warnings
                        : 'Совместимость подтверждена.'
                    ),
                critical
                  ? 'error'
                  : (
                      warnings
                        ? 'warning'
                        : 'success'
                    ),
                4200
              );
            })
            .catch(function (error) {
              setStatus(
                String(
                  error?.message ||
                  error
                ),
                'error',
                4000
              );
            });
        }
      );

    updateUi();
  }

  function onSafetyState(event) {
    state.safetyState =
      event?.detail || null;

    if (state.activeOperation === 'undo-group-move') {
      updateUi();
      return;
    }

    var message =
      String(
        state.safetyState
          ?.lastStatus
          ?.message || ''
      );

    var tone =
      state.safetyState
        ?.lastStatus
        ?.tone || 'normal';

    // Постоянный статус не засоряем техническими baseline-сообщениями.
    if (
      message &&
      !/точк[аи] восстановления создан/i.test(
        message
      )
    ) {
      setStatus(
        message,
        tone,
        tone === 'error' ? 4200 : 2800
      );
    }

    updateUi();
  }

  function addHandler(
    target,
    type,
    handler,
    options
  ) {
    target.addEventListener(
      type,
      handler,
      options
    );

    state.handlers.push(
      function () {
        target.removeEventListener(
          type,
          handler,
          options
        );
      }
    );
  }

  function startAll() {
    if (state.loading) {
      return Promise.resolve();
    }

    state.loading = true;

    setStatus(
      'Загружаю инструменты…',
      'loading'
    );

    return loadScript('safetyGuard')
      .then(function () {
        return Promise.all([
          loadScript('fastEditor'),
          loadScript('minimap')
        ]);
      })
      .then(function () {
        var fast = tool('fastEditor');

        // Быстрое сохранение — фоновая оптимизация, сотруднику
        // не нужна отдельная кнопка для её включения.
        fast?.enableFastSave?.();

        // Быстрое перемещение включено по умолчанию.
        // После первого ручного переключения запоминаем выбор пользователя.
        var fastDragEnabled =
          readSetting(
            'fastDragEnabled',
            true
          );

        if (fastDragEnabled) {
          fast?.enableLightDrag?.();
        } else {
          fast?.disableLightDrag?.();
        }

        // Изменение связей по-прежнему включается только вручную.
        fast?.disableLinks?.();

        updateUi();

        setStatus(
          'Изменения сохраняются автоматически.',
          'success',
          2200
        );
      })
      .finally(function () {
        state.loading = false;
      });
  }

  function stopAll() {
    destroyTool('fastEditor');
    destroyTool('minimap');
    destroyTool('safetyGuard');
  }

  function destroy(options) {
    options = options || {};

    if (options.stopTools) {
      stopAll();
    }

    state.handlers.forEach(
      function (remove) {
        try { remove(); } catch (_) {}
      }
    );

    state.handlers = [];

    clearTimeout(state.statusTimer);

    state.panel?.remove();
    state.style?.remove();

    document
      .querySelectorAll(
        'script[data-dazy-process-tool]'
      )
      .forEach(function (script) {
        script.remove();
      });

    try {
      delete window[TOOL_KEY];
      delete window[BOOT_KEY];
    } catch (_) {
      window[TOOL_KEY] = null;
      window[BOOT_KEY] = null;
    }
  }

  function init() {
    installStyles();
    installPanel();

    addHandler(
      document,
      'dazy:process-safety-state',
      onSafetyState
    );

    window[TOOL_KEY] = {
      version: '0.5.2 BETA',
      role: isAdmin() ? 'admin' : 'staff',
      startAll: startAll,
      stopAll: stopAll,
      destroy: destroy,
      scriptUrls: { ...SCRIPT_URLS },
      config: window.DAZY_PROCESS_TOOLS_CONFIG
    };

    startAll().catch(
      function (error) {
        console.error(
          '[DAZY Process Tools]',
          error
        );

        setStatus(
          String(
            error?.message ||
            error
          ),
          'error'
        );
      }
    );

    console.info(
      '[DAZY Process Tools Launcher v0.5.2 BETA] запущен',
      {
        role: isAdmin()
          ? 'admin'
          : 'staff',
        accountUserId:
          window.accountUserId
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      init,
      { once: true }
    );
  } else {
    init();
  }
})();
