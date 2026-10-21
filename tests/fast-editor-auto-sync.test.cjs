const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const sourcePath = process.argv[2] || path.join(__dirname, '..', 'process-tools', 'fast-editor', 'v1.5.3', 'DAZY-GC-Process-Fast-Editor.js');
const source = fs.readFileSync(sourcePath, 'utf8');
new vm.Script(source);

// Execute the actual changed production functions with controlled server replies
// and a deterministic clock. No GetCourse account or write request is needed.
function extractFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const next = /\n  (?:async )?function /g;
  next.lastIndex = start + 1;
  const match = next.exec(source);
  return source.slice(start, match ? match.index : source.length);
}
const functionNames = [
  'isAutomaticSyncBlocked', 'scheduleSafeFullSync', 'fullSync',
  'waitForSyncFinish', 'handleNativePasteSuccess', 'patchNativePasteAjax',
  'assertSuccessfulResponse',
];
const productionFunctions = functionNames.map(extractFunction).join('\n');
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}
function xhr() {
  let settled = '', args = [];
  const done = [], fail = [];
  const result = {
    done(fn) { if (settled === 'done') fn(...args); else done.push(fn); return result; },
    fail(fn) { if (settled === 'fail') fn(...args); else fail.push(fn); return result; },
    always(fn) { result.done(fn); result.fail(fn); return result; },
    resolve(...values) { settled = 'done'; args = values; done.slice().forEach(fn => fn(...args)); },
    reject(...values) { settled = 'fail'; args = values; fail.slice().forEach(fn => fn(...args)); },
  };
  return result;
}
function harness(autoSyncAfterPaste = true) {
  let now = 0, nextTimer = 1, selected = ['1'], scroll = {left: 640, top: 380};
  let sourceKind = 'operation', forceLoadError = false;
  const timers = new Map(), placements = [], loads = [], statuses = [], ajaxRequests = [];
  const elements = new Map([['1', {id: 'fwb1'}], ['2', {id: 'fwb2'}]]);
  const modals = [];
  const state = {
    destroyed: false, busy: false, safeSyncTimer: null, skipReloadBudget: 0,
    copyBusy: false, deleteBusy: false, copyPlacementsPending: 0,
    moveRequestsPending: 0, syncPointerId: null, nativePastePending: null,
    groupProxyCandidate: null, groupProxyActive: false, groupProxySaving: false,
    lightDragCandidate: null, lightDragActive: false, pendingModalSave: null,
    sectionGroupQueue: [], localChanges: 0, ajaxPatched: false,
  };
  const plugin = {
    loadData(_normalize, finish) {
      if (forceLoadError) throw Error('Simulated load error');
      loads.push({finish});
    },
  };
  state.originalLoadData = plugin.loadData;
  const dollar = function() { return {off() { return this; }, on() { return this; }}; };
  dollar.ajax = function(...args) {
    const handle = xhr();
    ajaxRequests.push({args, handle});
    return handle;
  };
  const context = {
    state, CONFIG: {autoSyncAfterPaste, syncTimeoutMs: 45000}, console,
    $: dollar,
    document: {
      getElementById(id) { return elements.get(String(id).replace(/^fwb/, '')) || null; },
      querySelectorAll(selector) { assert.equal(selector, '.block-modal-window'); return modals; },
    },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, {fn, at: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { return context.setTimeout(fn, 16); },
    normalizeArray: value => Array.isArray(value) ? value : [],
    readPasteRequest: options => ({sourceIds: options.data.blocks, coords: {left: 50, top: 60}}),
    getInternalCopiedConnectionSpecs: () => [],
    buildCopiedPlacementPlan: (sourceIds, createdIds) => createdIds.map((id, i) => ({
      createdId: id, sourceId: sourceIds[i] || sourceIds[0], coords: {left: 78, top: 98},
    })),
    inferBlockKind: () => sourceKind,
    getBlockTitle: block => block.id,
    resolveBlockSectionContext: () => ({insideSection: false, resolved: true, sectionId: null}),
    isSectionBlock: () => sourceKind === 'section',
    createLocalPlaceholder: ({id}) => { const el = {id: 'fwb' + id}; elements.set(id, el); return el; },
    createLocalCopiedConnections: () => 0,
    markLocalChange: () => { state.localChanges++; },
    closeBlockModal: () => {},
    scheduleSelectCopiedBlocks: ids => { selected = [...ids]; },
    persistCopiedPlacementPlan: () => { const pending = deferred(); placements.push(pending); return pending.promise; },
    setSaveStatus: (message, tone) => statuses.push({message, tone}),
    responseErrorText: error => error.message || 'Simulated server failure',
    getVisualSelectedBlockIds: () => [...selected],
    readEditorScroll: () => ({...scroll}),
    getEditorScrollContainer: () => ({}),
    setEditorScroll: (_container, left, top) => { scroll = {left, top}; },
    finishLightDrag: () => {}, clearLocalCopyConnections: () => {},
    clearSelectionState: () => { selected = []; },
    selectBlocksByIds: ids => { selected = ids.filter(id => elements.has(id)); },
    getFlowchartPlugin: () => plugin,
    installSectionRenderGuard: () => {}, clearSectionGroupFlushTimer: () => {},
    clearPendingSave: () => { state.pendingModalSave = null; state.skipReloadBudget = 0; },
    setPanelDisabled: () => {},
    resetLocalChanges: () => { state.localChanges = 0; },
    flushSectionGroupQueue: () => {}, resetLinkSelection: () => {},
    clearNativePasteTimer: () => {},
    prepareNativePaste: ids => (state.nativePastePending = {sourceIds: ids}),
  };
  vm.createContext(context);
  vm.runInContext(productionFunctions, context);
  return {
    context, state, loads, placements, statuses, ajaxRequests, modals, timers,
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    tick(duration) {
      const end = now + duration;
      let count = 0;
      while (true) {
        const ready = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        assert.ok(++count < 1000, 'Timer loop');
        now = ready[1].at; timers.delete(ready[0]); ready[1].fn();
      }
      now = end;
    },
    paste(ids = ['101'], sourceIds = ['1']) {
      return context.handleNativePasteSuccess({success: true, data: {created_ids: ids}}, {data: {blocks: sourceIds}});
    },
    completeSync() {
      const load = loads.at(-1); assert.ok(load);
      selected = []; scroll = {left: 0, top: 0}; load.finish(); this.tick(16);
    },
    get selected() { return selected; },
    get scroll() { return scroll; },
    set selected(ids) { selected = ids; },
    set sourceKind(value) { sourceKind = value; },
    set forceLoadError(value) { forceLoadError = value; },
  };
}

const cases = [];
function test(name, callback) { cases.push({name, callback}); }
test('successful copy waits for coordinates, synchronizes once, restores selection and scroll', async () => {
  const h = harness(); h.paste(); h.tick(1000); assert.equal(h.loads.length, 0);
  h.placements[0].resolve({data: {success: true}}); await h.flush();
  assert.equal(h.state.copyPlacementsPending, 0); h.tick(179); assert.equal(h.loads.length, 0);
  h.tick(1); assert.equal(h.loads.length, 1); h.completeSync();
  assert.deepEqual(h.selected, ['101']); assert.deepEqual(h.scroll, {left: 640, top: 380});
  assert.equal(h.state.busy, false); assert.match(h.statuses.at(-1).message, /Можно создавать связи/);
  h.tick(1000); assert.equal(h.loads.length, 1);
});
test('group copy preserves all copied block selections', async () => {
  const h = harness(); h.paste(['101', '102'], ['1', '2']);
  h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(180); h.completeSync();
  assert.deepEqual(h.selected, ['101', '102']);
});
test('overlapping copies coalesce and wait for every placement response', async () => {
  const h = harness(); h.paste(['101']); h.paste(['102']);
  h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(1000);
  assert.equal(h.loads.length, 0); assert.equal(h.state.copyPlacementsPending, 1);
  h.placements[1].resolve({data: {success: true}}); await h.flush(); h.tick(180);
  assert.equal(h.loads.length, 1); h.completeSync(); assert.deepEqual(h.selected, ['102']);
});
for (const flag of ['busy', 'copyBusy', 'deleteBusy', 'groupProxyActive', 'groupProxySaving', 'lightDragActive']) {
  test(`automatic sync waits while ${flag}`, async () => {
    const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
    h.state[flag] = true; h.tick(1000); assert.equal(h.loads.length, 0);
    h.state[flag] = false; h.tick(250); assert.equal(h.loads.length, 1);
  });
}
test('native pointer hold and unfinished native movement defer sync', async () => {
  const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
  h.state.syncPointerId = 7; h.tick(500); assert.equal(h.loads.length, 0);
  h.state.syncPointerId = null; h.state.moveRequestsPending = 1; h.tick(500); assert.equal(h.loads.length, 0);
  h.state.moveRequestsPending = 0; h.tick(250); assert.equal(h.loads.length, 1);
});
test('open modal and pending form save defer automatic sync', async () => {
  const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
  h.modals.push({offsetParent: {}}); h.tick(500); assert.equal(h.loads.length, 0);
  h.modals.length = 0; h.state.pendingModalSave = {}; h.tick(500); assert.equal(h.loads.length, 0);
  h.state.pendingModalSave = null; h.tick(250); assert.equal(h.loads.length, 1);
});
test('hidden modal does not block sync', async () => {
  const h = harness(); h.modals.push({offsetParent: null}); h.paste();
  h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(180); assert.equal(h.loads.length, 1);
});
test('failed copy response does not start placement or sync', () => {
  const h = harness(); assert.throws(() => h.context.handleNativePasteSuccess({success: false, message: 'Denied'}, {data: {blocks: ['1']}}), /Denied/);
  h.tick(1000); assert.equal(h.loads.length, 0); assert.equal(h.placements.length, 0);
});
for (const failure of ['transport', 'server']) {
  test(`placement ${failure} error retains safe fallback synchronization`, async () => {
    const h = harness(); h.paste();
    if (failure === 'transport') h.placements[0].reject(Error('Network failure'));
    else h.placements[0].resolve({data: {success: false, message: 'Coordinates rejected'}});
    await h.flush(); assert.equal(h.state.copyPlacementsPending, 0); h.tick(140);
    assert.equal(h.loads.length, 1); assert.ok(h.statuses.some(item => /не удалось сохранить/.test(item.message)));
  });
}
test('section copy uses automatic native synchronization', () => {
  const h = harness(); h.sourceKind = 'section'; h.paste(); h.tick(120);
  assert.equal(h.loads.length, 1); assert.equal(h.placements.length, 0);
});
test('configuration can disable automatic sync for regular copies', async () => {
  const h = harness(false); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(1000);
  assert.equal(h.loads.length, 0); assert.deepEqual(h.selected, ['101']);
});
test('destroyed tool schedules no late synchronization after placement', async () => {
  const h = harness(); h.paste(); h.state.destroyed = true;
  h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(1000);
  assert.equal(h.loads.length, 0); assert.equal(h.state.copyPlacementsPending, 0);
});
test('destroyed tool ignores an already scheduled sync', async () => {
  const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
  h.state.destroyed = true; h.tick(1000); assert.equal(h.loads.length, 0);
});
test('manual sync cancels the pending automatic duplicate', async () => {
  const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
  h.context.fullSync('manual'); h.completeSync(); h.tick(1000); assert.equal(h.loads.length, 1);
});
test('automatic refresh preserves an intentionally cleared selection', async () => {
  const h = harness(); h.paste(); h.placements[0].resolve({data: {success: true}}); await h.flush();
  h.selected = []; h.tick(180); h.completeSync(); assert.deepEqual(h.selected, []);
});
test('tracked native movement retains the original request and decrements on both outcomes', () => {
  const h = harness(); h.context.patchNativePasteAjax();
  for (const outcome of ['resolve', 'reject']) {
    const handle = h.context.$.ajax('/pl/tasks/mission/move-scripts', {type: 'POST', data: {blocks: {}}});
    assert.equal(handle, h.ajaxRequests.at(-1).handle); assert.equal(h.state.moveRequestsPending, 1);
    handle[outcome]({success: true}); assert.equal(h.state.moveRequestsPending, 0);
  }
});
test('native paste wrapper automatically syncs for a staff user', async () => {
  const h = harness(); h.context.patchNativePasteAjax();
  const handle = h.context.$.ajax({url: '/pl/tasks/mission/paste-blocks', type: 'POST', data: {blocks: ['1']}});
  assert.equal(h.state.copyBusy, true); handle.resolve({success: true, data: {created_ids: [101]}});
  assert.equal(h.state.copyBusy, false); assert.equal(h.state.nativePastePending, null);
  h.placements[0].resolve({data: {success: true}}); await h.flush(); h.tick(180);
  assert.equal(h.loads.length, 1); h.completeSync(); assert.deepEqual(h.selected, ['101']);
});
test('failed native paste clears busy state and never syncs', () => {
  const h = harness(); h.context.patchNativePasteAjax();
  const handle = h.context.$.ajax({url: '/pl/tasks/mission/paste-blocks', data: {blocks: ['1']}});
  handle.reject({status: 500}, 'error', 'failed'); h.tick(1000);
  assert.equal(h.state.copyBusy, false); assert.equal(h.loads.length, 0);
});

(async () => {
  for (const item of cases) { await item.callback(); console.log('PASS ' + item.name); }
  console.log(`${cases.length} tests passed; production syntax OK.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

