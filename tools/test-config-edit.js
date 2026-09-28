const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'f50-mihomo-ufi-device-manager-beta2.6-rc2.2.1.js'), 'utf8');
const begin = source.indexOf('  const countIndent =');
const end = source.indexOf('  const maskSubscriptionUrl =', begin);
assert.ok(begin >= 0 && end > begin, 'front-end config helpers must be present');

let providerResponse = JSON.stringify({ proxies: [{ name: 'example-node' }, { name: 'COMPATIBLE' }] });
const { replaceMainProviderUrl, replaceControllerPort, readProviderSummary } =
  new Function('runBackend', `${source.slice(begin, end)}; return { replaceMainProviderUrl, replaceControllerPort, readProviderSummary };`)(
    async (action) => {
      assert.equal(action, 'provider-status');
      return providerResponse;
    },
  );

const template = fs.readFileSync(path.join(root, 'config', 'config.template.yaml'), 'utf8');
assert.match(template, /external-controller: 0\.0\.0\.0:9099/);
const withUrl = replaceMainProviderUrl(template, 'https://example.invalid/config');
assert.doesNotMatch(withUrl, /__SUBSCRIPTION_URL__/);
assert.match(withUrl, /    url: 'https:\/\/example\.invalid\/config'/);
assert.match(withUrl, /      url: https:\/\/www\.gstatic\.com\/generate_204/);
assert.equal(withUrl.endsWith('\n'), template.endsWith('\n'));

const legacy = template.replace('external-controller: 0.0.0.0:9099', 'external-controller: 0.0.0.0:9090');
const migrated = replaceControllerPort(legacy, true);
assert.match(migrated, /external-controller: 0\.0\.0\.0:9099/);
assert.equal(replaceControllerPort(template, true), null);
const custom = template.replace('external-controller: 0.0.0.0:9099', 'external-controller: 0.0.0.0:9191');
assert.equal(replaceControllerPort(custom, true), null, 'pending setup must preserve a custom port');
assert.match(replaceControllerPort(custom), /external-controller: 0\.0\.0\.0:9099/);

(async () => {
  assert.equal((await readProviderSummary()).count, 1);
  providerResponse = JSON.stringify({ proxies: [] });
  assert.equal((await readProviderSummary()).count, 0);
  console.log('PASS config edit, legacy-port migration, provider count');
})().catch((error) => { console.error(error); process.exitCode = 1; });
