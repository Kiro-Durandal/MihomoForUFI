const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const begin = source.indexOf('  const countIndent =');
const end = source.indexOf('  const updateXdDockVisual =', begin);
assert.ok(begin >= 0 && end > begin, 'front-end config helpers must be present');

let providerResponse = JSON.stringify({ proxies: [{ name: 'example-node' }, { name: 'COMPATIBLE' }] });
const { replaceMainProviderUrl, replaceControllerSetting, normalizeControllerIP, readProviderSummary } =
  new Function('runBackend', `${source.slice(begin, end)}; return { replaceMainProviderUrl, replaceControllerSetting, normalizeControllerIP, readProviderSummary };`)(
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

const changed = replaceControllerSetting(template, '192.168.0.1', '9191');
assert.match(changed, /external-controller: '192\.168\.0\.1:9191'/);
assert.match(changed, /secret: '123456'/);
assert.match(replaceControllerSetting(template, '::', 9099), /external-controller: '\[::\]:9099'/);
assert.match(replaceControllerSetting(template, '::1', 9098), /external-controller: '\[::1\]:9098'/);
for (const ip of ['999.0.0.1', '1.2.3', 'localhost', '0.0.0.0;id', 'bad:ipv6']) assert.throws(() => normalizeControllerIP(ip));
for (const port of [0, -1, 65536, '9.5', '9099;id']) assert.throws(() => replaceControllerSetting(template, '0.0.0.0', port));
assert.throws(() => replaceControllerSetting(template + '\nexternal-controller: 0.0.0.0:9099\n', '0.0.0.0', 9099));
const commented = "external-controller: '[::]:9099' # controller\r\nsecret: '123456'\r\n";
assert.equal(replaceControllerSetting(commented, '127.0.0.1', 9099), "external-controller: '127.0.0.1:9099' # controller\r\nsecret: '123456'\r\n");
const namingBegin = source.indexOf('  const configFilename =');
const namingEnd = source.indexOf('  let lastBackendState =', namingBegin);
const configFilename = new Function(`${source.slice(namingBegin, namingEnd)}; return configFilename;`)();
assert.equal(configFilename(new Date(2026, 9, 3, 23, 50)), 'MiConfig-202610032350.yaml');

(async () => {
  assert.equal((await readProviderSummary()).count, 1);
  providerResponse = JSON.stringify({ proxies: [] });
  assert.equal((await readProviderSummary()).count, 0);
  console.log('PASS config edit, IPv4/IPv6 controller settings, naming and provider count');
})().catch((error) => { console.error(error); process.exitCode = 1; });
