// Execute the entire plugin, rather than only extracted helper functions.
// Isolated DOM/UFI adapters: no device, network, subscriptions or user config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');

function fixture({ dockFails = false, dockAlreadyExists = false, delayedActions = 0 } = {}) {
  const attached = new Map(), errors = [], toasts = [], requests = [], modals = [], shown = [];
  const element = (tag) => {
    const selectors = new Map();
    const node = { tagName: tag.toUpperCase(), style: {}, textContent: '', src: tag === 'iframe' ? 'about:blank' : '',
      classList: { add() {} }, setAttribute() {},
      appendChild(child) { child.parentElement = this; attached.set(child.id, child); },
      remove() { attached.delete(this.id); },
      querySelector(selector) {
        if (!selectors.has(selector)) selectors.set(selector, element(selector.includes('frame') && !selector.includes('wrap') ? 'iframe' : 'div'));
        return selectors.get(selector);
      }, querySelectorAll() { return [...selectors.values()]; },
      insertAdjacentElement(position, child) {
        assert.equal(position, 'afterend');
        if (dockFails) throw new Error('isolated panel mounting failure');
        attached.set(child.id, child);
      },
    };
    return node;
  };
  const actions = element('div'), anchor = element('div');
  actions.parentElement = anchor;
  if (dockAlreadyExists) {
    const staleDock = element('div'); staleDock.id = 'mi_mihomo_xd_dock_v26';
    attached.set(staleDock.id, staleDock);
  }
  let lookups = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => attached.get(id) || null, createElement: element,
      querySelector: (selector) => selector === '.actions-buttons' ? (++lookups > delayedActions ? actions : null)
        : selector === '.functions-container' ? anchor : null },
    window: { UFI_DATA: { lan_ipaddr: '192.0.2.1' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    setTimeout: (callback) => { callback(); return 1; },
    URL, Blob, File, FormData,
    fetch: () => { throw new Error('page load must not access the network'); },
    checkAdvancedFunc: async () => true,
    runShellWithRoot: async (command) => {
      requests.push(command);
      return { success: true, content: 'installed=1\nconfigured=1\nbackend=2.6-rc2.3\ncontroller_port=9099\ncontroller_address=0.0.0.0:9099\nrunning=1\n' };
    },
    createToast: (...args) => toasts.push(args),
    createModal: (options) => { modals.push(options); const node = element('div'); node.id = options.name; attached.set(node.id, node); return { el: node, id: '#' + node.id }; },
    showModal: (id) => shown.push(id), closeModal() {}, confirm: () => true,
  });
  return { context, attached, errors, toasts, requests, modals, shown,
    run: () => vm.runInContext(source, context, { timeout: 2000 }) };
}

(async () => {
  for (const options of [{}, { delayedActions: 3 }, { dockAlreadyExists: true }, { dockFails: true }]) {
    const page = fixture(options);
    await page.run();
    const button = page.attached.get('mi_mihomo_manager_btn_v26');
    assert.ok(button, `main button missing: ${JSON.stringify(options)}`);
    assert.equal(button.textContent, 'MiCatty');
    assert.equal(typeof button.onclick, 'function');
    assert.equal(page.requests.length, 0, 'no Root calls during initial mounting');
    if (!options.dockFails) {
      const dock = page.attached.get('mi_mihomo_xd_dock_v26');
      assert.ok(dock); assert.equal(dock.querySelector('.mi-xd-dock-body').style.display, 'none');
      assert.equal(dock.querySelector('.mi-xd-dock-frame').src, 'about:blank');
      assert.equal(page.errors.length, 0);
    }
    if (options.dockFails) assert.equal(page.errors.length, 1, 'optional panel failure must be reported, not hide the manager');
    await button.onclick();
    assert.equal(page.requests.length, 1, 'status is requested only after clicking the entry');
    assert.equal(page.modals[0].name, 'mi_mihomo_manager_v26');
    assert.deepEqual(page.shown, ['#mi_mihomo_manager_v26']);
    button.textContent = 'Mihomo';
    await page.run();
    assert.equal(page.attached.get('mi_mihomo_manager_btn_v26'), button, 're-injection must not duplicate the entry');
    assert.equal(button.textContent, 'MiCatty', 'existing entry gets the new name');
  }
  console.log('PASS complete plugin startup, MiCatty entry, panel failure isolation, delayed DOM and click/re-injection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
