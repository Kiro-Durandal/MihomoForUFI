const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'f50-mihomo-ufi-device-manager-beta2.6-rc2.2.1.js'), 'utf8');
const start = source.indexOf('  const fetchReleaseManifest =');
const end = source.indexOf('  const runReleaseInstaller =', start);
assert.ok(start >= 0 && end > start, 'release manifest helper must be present');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
let result = {
  success: true,
  content: `INFO: proxy\n__F50_MANIFEST_BEGIN__\n${JSON.stringify(manifest)}\n__F50_MANIFEST_END__\n`,
};
let command = '';
const fetchManifest = new Function(
  'runShellWithRoot', 'validateReleaseManifest', 'redactInstallOutput', 'shellQuote',
  `const INSTALL_MANIFEST_URL = 'https://raw.githubusercontent.com/Kiro-Durandal/MihomoForUFI/v2.6-rc2.2.1/release-manifest.json';
   const DEVICE_LOCAL_PROXY = 'http://127.0.0.1:7892';
   const RELEASE_TAG = 'v2.6-rc2.2.1';
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
  `const DEVICE_LOCAL_PROXY = 'http://127.0.0.1:7892';
   ${source.slice(installStart, installEnd)};
   return runReleaseInstaller;`,
)(
  async (script, timeout) => {
    installCommands.push({ script, timeout });
    if (script.startsWith('mktemp ')) {
      return { success: true, content: '/data/local/tmp/f50-mihomo-rc221-package.abc123\n' };
    }
    if (script.includes('--output ')) {
      const ok = downloadResults.shift();
      return { success: Boolean(ok), content: ok ? '' : 'curl: connection failed' };
    }
    if (script.includes('STAGE=')) {
      return { success: true, content: 'package verified\n__F50_RC2_INSTALL_EXIT__=0\n' };
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
  assert.match(command, /while \[ "\$ATTEMPT" -le 3 \]/, 'fresh install must retry direct manifest download');
  assert.match(command, /--proto-redir '=https'/);
  assert.doesNotMatch(source.slice(start, end), /await fetch\(/);

  result = { success: false, content: 'ERROR: direct and proxy failed' };
  await assert.rejects(fetchManifest(), /F50 下载发布清单失败/);
  result = { success: true, content: '__F50_MANIFEST_BEGIN__\nnot-json\n__F50_MANIFEST_END__\n' };
  await assert.rejects(fetchManifest(), /不是有效 JSON/);
  assert.equal(await runReleaseInstaller(manifest), 'package verified');
  assert.equal(installCommands.length, 4, 'allocate, download, install, cleanup');
  assert.match(installCommands[1].script, /--noproxy '\*'/);
  assert.match(installCommands[2].script, /SHA-256 不匹配/);
  const verifyCommandLength = installCommands[2].script.length;
  assert.ok(installCommands.every(({ timeout }) => timeout <= 300000), 'each Root command must fit the UFI-Tools timeout range');

  installCommands = [];
  downloadResults = [false, false, false, true];
  assert.equal(await runReleaseInstaller(manifest), 'package verified');
  const downloads = installCommands.filter(({ script }) => script.includes('--output '));
  assert.equal(downloads.length, 4, 'three direct attempts then optional proxy');
  assert.ok(downloads.slice(0, 3).every(({ script }) => script.includes("--noproxy '*'")));
  assert.match(downloads[3].script, /--proxy 'http:\/\/127\.0\.0\.1:7892'/);

  installCommands = [];
  downloadResults = [false, false, false, false];
  await assert.rejects(runReleaseInstaller(manifest), /直连三次及本机代理均无法下载/);
  assert.ok(installCommands.at(-1).script.startsWith('rm -f '), 'failed download must clean up');
  console.log(`command lengths: manifest=${command.length}, download=${downloads[0].script.length}, installer=${verifyCommandLength}`);
  console.log('PASS device-side release manifest/package download and diagnostics');
})().catch((error) => { console.error(error); process.exitCode = 1; });
