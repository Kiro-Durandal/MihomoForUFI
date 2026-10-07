const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const section = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
let dialog, calls = [], original = "external-controller: '0.0.0.0:9099'\nsecret: '123456'\ndns:\n  ipv6: true\n";
const element = () => ({ value: '', textContent: '', disabled: false, readOnly: false,
  style: {}, classList: { add() {} }, children: [],
  appendChild(child) { child.parentElement = this; this.children.push(child); }, insertBefore() {},
});
const createModal = (options) => {
  const elements = new Map();
  const toolbar = element(), header = element(), save = element(), cancel = element();
  save.parentElement = cancel.parentElement = toolbar;
  elements.set('.title', header);
  elements.set('#mi_config_editor_confirm', save); elements.set('.mi-editor-save', save);
  elements.set('#mi_config_editor_close', cancel); elements.set('.mi-editor-cancel', cancel);
  dialog = { id: 'mock', options, closed: false, el: { remove: () => { dialog.removed = true; }, querySelector: (name) => {
    if (!elements.has(name)) elements.set(name, element()); return elements.get(name);
  }, style: {} }, toolbar, header };
  return dialog;
};
const helpers = new Function(`${section('  const countIndent =', '  const readProviderSummary =')}; return { readControllerSetting, replaceControllerSetting, normalizeControllerIP };`)();
const staleRemoved = [];
const document = { getElementById: (name) => ({ remove: () => staleRemoved.push(name) }) };
const dialogs = new Function('document', 'runBackend', 'createModal', 'closeModal', 'showModal', 'applyEditedConfig', 'createToast', 'setBusy',
  'readControllerSetting', 'replaceControllerSetting', 'normalizeControllerIP',
  `let globalBusy = false, modalElement = null; ${section('  const showManagerDialog =', '  const openSubscriptionManager =')}; return { openConfigEditor, openControllerSettings };`,
)(document, async (action) => { assert.equal(action, 'config-read'); return original; }, createModal,
  (id, delay, callback) => { dialog.closed = true; callback?.(); }, () => {},
  async (before, after) => { calls.push({ before, after }); }, () => {}, () => {},
  helpers.readControllerSetting, helpers.replaceControllerSetting, helpers.normalizeControllerIP);

(async () => {
  await dialogs.openConfigEditor();
  assert.equal(dialog.options.showConfirm, true);
  assert.equal(dialog.options.confirmBtnText, '保存并应用'); assert.equal(dialog.options.closeBtnText, '取消');
  assert.equal(dialog.toolbar.parentElement, dialog.header, 'editor actions belong to the outer header');
  assert.equal(dialog.el.style.display, 'flex');
  assert.doesNotMatch(dialog.options.content, /<button/, 'no duplicate buttons inside the content');
  dialog.el.querySelector('.mi-editor-text').value = '# discarded';
  dialog.el.querySelector('.mi-editor-cancel').onclick();
  assert.equal(calls.length, 0, 'Cancel must not upload or apply'); assert.ok(dialog.closed); assert.ok(dialog.removed);
  await dialogs.openConfigEditor();
  await dialog.el.querySelector('.mi-editor-save').onclick();
  assert.equal(calls.length, 0, 'unchanged Save must not restart');
  await dialogs.openConfigEditor();
  const edited = original.replace('ipv6: true', 'ipv6: false');
  dialog.el.querySelector('.mi-editor-text').value = edited;
  await dialog.el.querySelector('.mi-editor-save').onclick();
  assert.deepEqual(calls[0], { before: original, after: edited }); assert.ok(dialog.closed);
  calls = [];
  await dialogs.openControllerSettings();
  assert.equal(dialog.options.name, 'mi_controller_settings_dialog');
  dialog.el.querySelector('.mi-controller-ip').value = '999.1.2.3';
  await dialog.el.querySelector('.mi-controller-save').onclick();
  assert.equal(calls.length, 0); assert.ok(!dialog.closed);
  assert.match(dialog.el.querySelector('.mi-controller-result').textContent, /有效/);
  dialog.el.querySelector('.mi-controller-ip').value = '192.168.0.1';
  dialog.el.querySelector('.mi-controller-port').value = '9191';
  await dialog.el.querySelector('.mi-controller-save').onclick();
  assert.equal(calls.length, 1); assert.match(calls[0].after, /192\.168\.0\.1:9191/);
  assert.match(calls[0].after, /secret: '123456'/);
  assert.match(calls[0].after, /ipv6: true/);
  assert.ok(dialog.closed);
  calls = [];
  await dialogs.openControllerSettings(); dialog.el.querySelector('.mi-controller-cancel').onclick();
  assert.equal(calls.length, 0);
  assert.deepEqual(staleRemoved, ['mi_config_editor', 'mi_config_editor', 'mi_config_editor', 'mi_controller_settings_dialog', 'mi_controller_settings_dialog'], 'reopening must remove stale modal IDs, not manager buttons');
  console.log('PASS editor Cancel/no-op/Save and controller validation/Cancel/Save');
})().catch((error) => { console.error(error); process.exitCode = 1; });
