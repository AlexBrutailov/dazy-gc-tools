/*
 * DAZY — GC Process Tools Launcher v0.4.0 BETA
 * SMART project example. This is the ONLY file kept in GetCourse theme.
 */
(function () {
  'use strict';

  var TOOL_KEY = 'gcProcessToolsLauncherV040Beta';
  var BOOT_KEY = '__DAZY_PROCESS_TOOLS_LAUNCHER_BOOT_V040_BETA__';
  var STORAGE_KEY = 'gc-process-tools-launcher-v040-beta:collapsed';

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
    allowedUserIds: [355017780, 95427939, 141682633],
    allowedAccountIds: [60520]
  };

  // После создания GitHub Pages замени только REPLACE_WITH_GITHUB_USERNAME.
  var GITHUB_BASE =
    'https://REPLACE_WITH_GITHUB_USERNAME.github.io/dazy-gc-tools';

  window.DAZY_PROCESS_TOOLS_CONFIG = {
    allowedUserIds: ACCESS_CONFIG.allowedUserIds.slice(),
    allowedAccountIds: ACCESS_CONFIG.allowedAccountIds.slice(),
    allowedProcessIds: TARGET_PAGE.processIds.slice(),
    allowAnyUser: false,
    allowAnyAccount: false,
    allowAnyProcess: false,

    // Safety Guard — главный предохранитель координат.
    externalMoveGuard: true,
    massMoveLimit: 16,
    massMovePermitTtlMs: 60000,
    baselineHistoryLimit: 3,
    moveHistoryLimit: 10,

    // Эталон нужен только для тестовой копии SMART.
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
      GITHUB_BASE + '/process-tools/safety-guard/v0.1.0/DAZY-GC-Process-Safety-Guard.js',
    fastEditor:
      GITHUB_BASE + '/process-tools/fast-editor/v1.4.0/DAZY-GC-Process-Fast-Editor.js',
    minimap:
      GITHUB_BASE + '/process-tools/minimap/v0.5.0/DAZY-GC-Process-Minimap.js'
  };

  var GLOBAL_KEYS = {
    safetyGuard: 'gcProcessSafetyGuardV010Beta',
    fastEditor: 'gcProcessFastEditorV140Beta',
    minimap: 'gcProcessMinimapV050Beta'
  };

  var currentUrl = new URL(window.location.href);
  var currentProcessId = currentUrl.searchParams.get('id');
  var allowedPage =
    currentUrl.origin === TARGET_PAGE.origin &&
    currentUrl.pathname === TARGET_PAGE.pathname &&
    TARGET_PAGE.processIds.indexOf(currentProcessId) !== -1;

  if (!allowedPage) {
    console.info('[DAZY Process Tools] Страница не входит в allowlist.', currentUrl.href);
    return;
  }

  function num(value) { var n = Number(value); return Number.isFinite(n) ? n : null; }
  function includesNum(list,value) { value=num(value); return value!==null && list.map(Number).indexOf(value)!==-1; }
  function accessAllowed() {
    return includesNum(ACCESS_CONFIG.allowedAccountIds, window.accountId) &&
      includesNum(ACCESS_CONFIG.allowedUserIds, window.accountUserId);
  }
  if (!accessAllowed()) {
    console.warn('[DAZY Process Tools] Доступ запрещён.');
    return;
  }

  function loadScript(toolName) {
    if (window[GLOBAL_KEYS[toolName]]) return Promise.resolve(window[GLOBAL_KEYS[toolName]]);
    return new Promise(function(resolve,reject){
      var old=document.querySelector('script[data-dazy-process-tool="'+toolName+'"]');
      if (old) old.remove();
      var s=document.createElement('script');
      s.src=SCRIPT_URLS[toolName];
      s.async=true;
      s.dataset.dazyProcessTool=toolName;
      s.onload=function(){
        setTimeout(function(){
          var tool=window[GLOBAL_KEYS[toolName]];
          if (tool) resolve(tool); else reject(new Error(toolName+' загрузился, но global не найден.'));
        },0);
      };
      s.onerror=function(){ reject(new Error('Не удалось загрузить '+SCRIPT_URLS[toolName])); };
      document.head.appendChild(s);
    });
  }

  function destroyTool(name) {
    try { window[GLOBAL_KEYS[name]]?.destroy?.(); } catch (error) { console.warn(error); }
  }

  function startAll() {
    // Guard запускается первым, чтобы его capture-handler регистрировался раньше drag-обработчиков.
    return loadScript('safetyGuard').then(function(){
      return Promise.allSettled([loadScript('fastEditor'), loadScript('minimap')]);
    });
  }

  function stopAll() {
    destroyTool('fastEditor'); destroyTool('minimap'); destroyTool('safetyGuard');
  }

  function installPanel() {
    var style=document.createElement('style');
    style.id='gcptl-styles';
    style.textContent='#gcptl-panel{position:fixed;left:18px;bottom:18px;z-index:2147483646;width:320px;padding:12px;border-radius:14px;background:#202326;color:#fff;font:13px/1.4 Arial,sans-serif;box-shadow:0 12px 38px rgba(0,0,0,.38)}#gcptl-panel *{box-sizing:border-box}#gcptl-panel .head{display:flex;justify-content:space-between;align-items:center;font-weight:700}#gcptl-panel .body{margin-top:8px}#gcptl-panel button{width:100%;margin-top:6px;padding:7px;border:0;border-radius:7px;background:#34445c;color:#fff;cursor:pointer;font-weight:700}#gcptl-panel .stop{background:#8f3d43}#gcptl-panel .status{padding:7px;border-radius:7px;background:#17462f;color:#d9ffe7}#gcptl-panel.is-collapsed .body{display:none}';
    document.head.appendChild(style);
    var panel=document.createElement('div'); panel.id='gcptl-panel';
    panel.innerHTML='<div class="head"><span>DAZY Process Tools · GitHub BETA</span><button data-role="collapse" style="width:30px;margin:0">−</button></div><div class="body"><div class="status">Safety Guard → Fast Editor → Minimap</div><button data-role="guard">Остановить Safety Guard</button><button data-role="fast">Остановить Fast Editor</button><button data-role="mini">Остановить мини-карту</button><button class="stop" data-role="all">Остановить все инструменты</button></div>';
    document.body.appendChild(panel);
    var collapsed=false;
    try { collapsed=localStorage.getItem(STORAGE_KEY)==='1'; } catch(_){}
    panel.classList.toggle('is-collapsed',collapsed);
    panel.querySelector('[data-role="collapse"]').textContent=collapsed?'+':'−';
    panel.querySelector('[data-role="collapse"]').onclick=function(){ collapsed=!collapsed; panel.classList.toggle('is-collapsed',collapsed); this.textContent=collapsed?'+':'−'; try{localStorage.setItem(STORAGE_KEY,collapsed?'1':'0')}catch(_){} };
    panel.querySelector('[data-role="guard"]').onclick=function(){ destroyTool('safetyGuard'); };
    panel.querySelector('[data-role="fast"]').onclick=function(){ destroyTool('fastEditor'); };
    panel.querySelector('[data-role="mini"]').onclick=function(){ destroyTool('minimap'); };
    panel.querySelector('[data-role="all"]').onclick=stopAll;
  }

  function destroy(options) {
    options=options||{}; if(options.stopTools) stopAll();
    document.getElementById('gcptl-panel')?.remove(); document.getElementById('gcptl-styles')?.remove();
    document.querySelectorAll('script[data-dazy-process-tool]').forEach(function(s){s.remove()});
    try { delete window[TOOL_KEY]; delete window[BOOT_KEY]; } catch (_) { window[TOOL_KEY]=null; window[BOOT_KEY]=null; }
  }

  function init() {
    installPanel();
    window[TOOL_KEY]={version:'0.4.0 BETA',startAll,stopAll,destroy,scriptUrls:{...SCRIPT_URLS},config:window.DAZY_PROCESS_TOOLS_CONFIG};
    startAll().catch(function(error){console.error('[DAZY Process Tools]',error)});
    console.info('[DAZY Process Tools Launcher v0.4.0 BETA] запущен');
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
