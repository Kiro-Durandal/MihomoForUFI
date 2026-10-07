const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'ufi-backend.sh'), 'utf8');
for (const id of ['start', 'config_test', 'backup_create', 'backup_manage', 'provider_check', 'diagnostic', 'xd_open', 'xd_toggle', 'controller_check', 'xd_upgrade', 'controller_9099']) {
  assert.doesNotMatch(frontend, new RegExp(`id="mi_${id}"`), id);
}
for (const action of ['start', 'config-test', 'backup-create', 'backup-list', 'backup-read', 'backup-delete', 'backup-restore', 'diagnostic', 'api-version', 'ui-upgrade', 'provider-refresh']) {
  assert.doesNotMatch(backend, new RegExp(`^  ${action}\\)`, 'm'), action);
}
assert.doesNotMatch(frontend, /F50|formatApplyTiming|openBackupManager|redactDiagnostic/);
assert.match(frontend, /id="mi_config_edit"/);
assert.match(frontend, /id="mi_controller_settings"/);
const buttonIds = [...frontend.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
const modalNames = [...frontend.matchAll(/name: '([^']+)'/g)].map((match) => match[1]);
for (const name of modalNames) assert.ok(!buttonIds.includes(name), `modal ID collides with a button: ${name}`);
assert.match(frontend, /name: 'mi_controller_settings_dialog'/);
assert.match(frontend, /name: 'mi_subscription_dialog'/);
assert.match(frontend, /true, true, oldHash/);
assert.match(frontend, /await readProviderSummary/);
assert.match(backend, /-X PUT/);
assert.match(backend, /\/configs\?force=true/);
assert.match(backend, /\/providers\/proxies\/main/);
assert.match(backend, /REFRESH_MAIN\) REFRESH_MAIN=1/);
assert.match(backend, /AUTO_REFRESH_MAIN\) REFRESH_MAIN=2/);
assert.match(backend, /EXPECTED_OLD_SHA=\$\{4:-\}/);
assert.match(backend, /say 'health_confirmed=1'/);
assert.doesNotMatch(backend, /create_backup|backup_create_action|diagnostic_action|ui_upgrade_action/);
assert.doesNotMatch(frontend, /setInterval/);
const actions = [...backend.matchAll(/^  ([a-z-]+)\)/gm)].map((match) => match[1]);
for (const file of ['install.sh', 'install-upgrade.sh']) {
  const installer = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of installer.matchAll(/ufi-backend\.sh" ([a-z-]+)/g)) {
    assert.ok(actions.includes(match[1]), `${file} calls removed backend action ${match[1]}`);
  }
}
console.log('PASS reduced UI/actions, subscription feedback and reload safeguards');
