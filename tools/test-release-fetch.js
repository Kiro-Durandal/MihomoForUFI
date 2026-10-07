const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const start = source.indexOf('  const fetchReleaseManifest =');
const end = source.indexOf('  const runReleaseInstaller =', start);
assert.ok(start >= 0 && end > start, 'release manifest helper must be present');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
const validationStart = source.indexOf('  const validateReleaseManifest =');
const validationEnd = source.indexOf('  const readManifestFile =', validationStart);
const validation = new Function(`const PLUGIN_VERSION='2.6-RC2.3', RELEASE_TAG='v2.6-rc2.3', MAX_RELEASE_BYTES=128*1024*1024; ${source.slice(validationStart, validationEnd)}; return { validateReleaseManifest, selectInstallPackage };`)();
const validated = validation.validateReleaseManifest(manifest);
assert.equal(validation.selectInstallPackage(validated, false).package.name, manifest.package.name);
assert.ok(manifest.upgrade_package, 'the manifest must offer a script-only upgrade');
assert.equal(validation.selectInstallPackage(validated, true).package.name, manifest.upgrade_package.name);
assert.ok(manifest.upgrade_package.bytes < manifest.package.bytes / 10);
assert.throws(() => validation.validateReleaseManifest({ ...manifest, upgrade_package: { ...manifest.upgrade_package, url: 'https://example.invalid/pkg.tar' } }));
let result = {
  success: true,
  content: `INFO: proxy\n__MI_MANIFEST_BEGIN__\n${JSON.stringify(manifest)}\n__MI_MANIFEST_END__\n`,
};
let command = '';
const fetchManifest = new Function(
  'runShellWithRoot', 'validateReleaseManifest', 'redactInstallOutput', 'shellQuote',
  `const INSTALL_MANIFEST_URL = 'https://raw.githubusercontent.com/Kiro-Durandal/MihomoForUFI/v2.6-rc2.3/release-manifest.json';
   const DEVICE_LOCAL_PROXY = 'http://127.0.0.1:7892';
   const RELEASE_TAG = 'v2.6-rc2.3';
   ${source.slice(start, end)};
   return fetchReleaseManifest;`,
)(
  async (script) => { command = script; return result; },
  (parsed) => parsed,
  (text) => text,
  (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`,
);

const installStart = source.indexOf('  const runReleaseInstaller =', end);
const installEnd = source.indexOf('  const ACTIONS =', installStart);
assert.ok(installStart >= end && installEnd > installStart, 'release installer helper must be present');
let installCommands = [];
let downloadResults = [true];
const runReleaseInstaller = new Function(
  'runShellWithRoot', 'shellQuote', 'redactInstallOutput',
  `let backendCallSequence = 0; const DEVICE_LOCAL_PROXY = 'http://127.0.0.1:7892';
   ${source.slice(installStart, installEnd)};
   return runReleaseInstaller;`,
)(
  async (script, timeout) => {
    installCommands.push({ script, timeout });
    if (script.startsWith('mktemp ')) {
      return { success: true, content: '/data/local/tmp/mi-mihomo-rc23-package.abc123\n' };
    }
    if (script.includes('--output ')) {
      const ok = downloadResults.shift();
      const marker = script.match(/__MI_DOWNLOAD_EXIT_\d+_\d+__/)[0];
      return { success: true, content: `${ok ? '' : 'curl: connection failed'}\n${marker}=${ok ? 0 : 28}\n` };
    }
    if (script.includes('STAGE=')) {
      return { success: true, content: 'package verified\n__MI_RC2_INSTALL_EXIT__=0\n' };
    }
    if (script.startsWith('rm -f ')) return { success: true, content: '' };
    throw new Error(`unexpected command: ${script}`);
  },
  (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`,
  (text) => text,
);

(async () => {
  assert.deepEqual(await fetchManifest(), manifest);
  assert.match(command, /--proxy 'http:\/\/127\.0\.0\.1:7892'/);
  assert.match(command, /--noproxy '\*'/);
  assert.ok(command.indexOf("--noproxy '*'") < command.indexOf('--proxy'), 'direct manifest fetch must precede proxy fallback');
  assert.ok(command.indexOf('--proxy') < command.indexOf('ATTEMPT=$((ATTEMPT + 1))'),
    'proxy fallback must run before two further direct manifest timeouts');
  assert.match(command, /while \[ "\$ATTEMPT" -le 3 \]/, 'fresh install must retry direct manifest download');
  assert.match(command, /--proto-redir '=https'/);
  assert.doesNotMatch(source.slice(start, end), /await fetch\(/);

  result = { success: false, content: 'ERROR: direct and proxy failed' };
  await assert.rejects(fetchManifest(), /设备下载发布清单失败/);
  result = { success: true, content: '__MI_MANIFEST_BEGIN__\nnot-json\n__MI_MANIFEST_END__\n' };
  await assert.rejects(fetchManifest(), /不是有效 JSON/);
  assert.match(await runReleaseInstaller(manifest), /package verified\n耗时：发布包传输/);
  assert.equal(installCommands.length, 4, 'allocate, download, install, cleanup');
  assert.match(installCommands[1].script, /--noproxy '\*'/);
  assert.match(installCommands[2].script, /SHA-256 不匹配/);
  const verifyCommandLength = installCommands[2].script.length;
  assert.ok(installCommands.every(({ timeout }) => timeout <= 300000), 'each Root command must fit the UFI-Tools timeout range');

  installCommands = [];
  downloadResults = [false, true];
  assert.match(await runReleaseInstaller(manifest), /package verified\n耗时：发布包传输/);
  assert.equal(installCommands.filter(({ script }) => script.includes('--output ')).length, 2,
    'working local proxy should be used after one failed direct attempt');

  installCommands = [];
  downloadResults = [false, false, false, true];
  assert.match(await runReleaseInstaller(manifest), /package verified\n耗时：发布包传输/);
  const downloads = installCommands.filter(({ script }) => script.includes('--output '));
  assert.equal(downloads.length, 4, 'one direct attempt, optional proxy, then two more direct attempts');
  assert.ok(downloads[0].script.includes("--noproxy '*'"), 'first attempt must be direct');
  assert.match(downloads[1].script, /--proxy 'http:\/\/127\.0\.0\.1:7892'/,
    'an installed device should not wait through two more direct timeouts before proxy fallback');
  assert.ok(downloads.slice(2).every(({ script }) => script.includes("--noproxy '*'")),
    'fresh installations still receive three direct attempts');

  installCommands = [];
  downloadResults = [false, false, false, false];
  await assert.rejects(runReleaseInstaller(manifest), /直连三次及本机代理均无法下载/);
  assert.ok(installCommands.at(-1).script.startsWith('rm -f '), 'failed download must clean up');
  console.log(`command lengths: manifest=${command.length}, download=${downloads[0].script.length}, installer=${verifyCommandLength}`);
  console.log('PASS device-side release manifest/package download and diagnostics');
})().catch((error) => { console.error(error); process.exitCode = 1; });
