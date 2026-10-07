// Isolated tests: no device, network, real service, firewall or personal config.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'ufi-backend.sh'), 'utf8');
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const section = (begin, end) => {
  const a = frontend.indexOf(begin), b = frontend.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing frontend section: ${begin}`);
  return frontend.slice(a, b);
};
const parseKeyValue = (text) => Object.fromEntries(String(text).split(/\r?\n/)
  .filter((line) => line.includes('='))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));

const { sha256Bytes, configFileSha256 } = new Function(
  `${section('  const sha256Bytes =', '  const showTextModal =')}; return { sha256Bytes, configFileSha256 };`,
)();
const makeRunBackend = (adapter, backendPath = '/mock/backend.sh') => new Function('runShellWithRoot', 'shellQuote', 'BACKEND',
  `${section('  const ACTIONS =', '  const getLanIp =')}; return runBackend;`,
)(adapter, shellQuote, backendPath);
const markerOf = (command) => {
  const marker = command.match(/__MI_BACKEND_EXIT_\d+_\d+__/);
  assert.ok(marker, 'every invocation must have a unique completion marker');
  assert.ok(!command.includes('\n'), 'UFI command must remain a single line');
  return marker[0];
};

async function frontendTests() {
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('\ufeff# 中文\r\ndns:\r\n  ipv6: true\r\n'),
    ...[55, 56, 63, 64, 65, 127, 128, 129, 3145728].map((n) => Buffer.alloc(n, 0xa5))]) {
    assert.equal(sha256Bytes(new Uint8Array(bytes)), hash(bytes), `SHA-256 mismatch for ${bytes.length} bytes`);
  }
  const file = new Blob(['\ufeff# 国内 IPv6\r\ndns:\r\n  ipv6: true\r\n']);
  assert.equal(await configFileSha256(file), hash(Buffer.from(await file.arrayBuffer())));
  const rawConfig = 'dns:\r\n  nameserver:\r\n    - https://example.invalid/dns-query\r\n';
  const markers = new Set();
  const ok = makeRunBackend(async (command) => {
    const marker = markerOf(command);
    assert.ok(!markers.has(marker)); markers.add(marker);
    return { success: true, content: `${rawConfig}\n${marker}=0\n` };
  });
  assert.equal(await ok('config-read'), rawConfig, 'receipt stripping must preserve config newlines');
  assert.equal(await ok('config-read'), rawConfig);
  const failed = makeRunBackend(async (command) => ({ success: true,
    content: `configuration test successful\nERROR: runtime failed; old config restored\n\n${markerOf(command)}=1\n` }));
  await assert.rejects(failed('config-apply'), /old config restored/,
    'UFI success:true must not override shell exit 1');
  await assert.rejects(makeRunBackend(async () => ({ success: true, content: 'OK: 配置已应用' }))('config-apply'), /未收到后端完成回执/);
  await assert.rejects(makeRunBackend(async () => ({ success: true, content: 'OK\n__F50_BACKEND_EXIT_0_0__=0\n' }))('config-apply'), /未收到后端完成回执/,
    'a previous invocation receipt must not be accepted');
  await assert.rejects(makeRunBackend(async () => ({ success: false, content: 'transport failed' }))('status'), /transport failed/);
  await assert.rejects(ok('arbitrary-command'), /不受支持/);

  let suppliedArgs, uploadedName;
  const expected = await configFileSha256(file);
  let receiptHash = expected;
  const applyConfigFile = new Function('configFileSha256', 'uploadFileToUfi', 'runBackend', 'parseKeyValue', 'refreshStatus', 'configFilename', 'updateControllerPortFromStatus', 'currentState',
    `let backendCallSequence = 0; ${section('  const applyConfigFile =', '  const applyEditedConfig =')}; return applyConfigFile;`,
  )(configFileSha256, async (value, name) => { uploadedName = name; return '/mock/uploads/' + name; },
    async (action, args) => { assert.equal(action, 'config-apply'); suppliedArgs = args; return `config_sha256=${receiptHash}\n`; },
    parseKeyValue, async () => {}, () => 'MiConfig-202610032350.yaml', () => {}, {});
  await applyConfigFile(file, () => {}, false, true);
  assert.match(uploadedName, /^MiConfig-\d{12}-\d+\.yaml$/);
  assert.deepEqual(suppliedArgs.slice(1), ['REFRESH_MAIN', expected, '']);
  await applyConfigFile(file, () => {}, false, false);
  assert.equal(suppliedArgs[1], 'AUTO_REFRESH_MAIN');
  receiptHash = '0'.repeat(64);
  await assert.rejects(applyConfigFile(file, () => {}, false), /未确认正式配置/);
  receiptHash = '';
  await assert.rejects(applyConfigFile(file, () => {}, false), /未确认正式配置/);
  console.log('PASS exact-byte hashing, real exit receipts, and frontend apply verification');
}

function testShell() {
  if (process.env.F50_TEST_SH) return process.env.F50_TEST_SH;
  if (process.platform !== 'win32') return '/bin/sh';
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, 'Git Bash is required for isolated Windows shell tests');
  const shell = path.resolve(git.stdout.trim(), '../../..', 'usr/bin/sh.exe');
  assert.ok(fs.existsSync(shell), 'cannot locate Git Bash; set F50_TEST_SH explicitly');
  return shell;
}

async function backendTests() {
  const fixture = fs.mkdtempSync(path.join(root, '.test-config-transaction-'));
  const p = '.';
  const shell = testShell();
  const testEnv = { ...process.env };
  const write = (name, body) => {
    const target = path.join(fixture, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, { mode: 0o700 });
  };
  let shim = backend.replace('set -u', 'set -u\nPATH=".:/usr/bin:/bin:$PATH"\nexport PATH')
    .replace(/^BASE=.*$/m, `BASE=${shellQuote(p + '/backend')}`)
    .replace(/^CURL=.*$/m, `CURL=${shellQuote(p + '/curl')}`)
    .replace(/^UPLOAD_ROOT=.*$/m, `UPLOAD_ROOT=${shellQuote(p + '/uploads')}`)
    .replace(/^BOOT_FILE=.*$/m, `BOOT_FILE=${shellQuote(p + '/boot.sh')}`)
    .replace(/^BOOT_LOG=.*$/m, `BOOT_LOG=${shellQuote(p + '/boot.log')}`);
  // Only health is mocked here. The actual dispatcher, file transaction,
  // checksum, backup and main-refresh HTTP status handling are executed.
  shim = shim.replace('ACTION="${1:-}"', `health_quiet() { [ -f "$BASE/live" ]; }
  controller_reachable() { API_SECRET=123456; [ -f "$BASE/live" ]; }
  wait_controller_healthy() {
    [ ! -f "$BASE/health-fail" ] || return 1
    [ ! -f "$BASE/tamper" ] || printf '# foreign writer\\n' >> "$CFG"
    return 0
  }
  ACTION="\${1:-}"`);
  const scriptHeader = `#!/bin/sh\nBASE=${shellQuote(p + '/backend')}\n`;
  write('backend.sh', shim);
  write('date', '#!/bin/sh\nprintf "202610032350\\n"\n');
  // The bundled Windows Git shell omits sha256sum. Use Node as its fixture
  // provider; Linux CI runs the real system sha256sum unchanged.
  if (process.platform === 'win32') write('sha256sum', `#!/bin/sh\nexec ${shellQuote(process.execPath.replaceAll('\\', '/'))} -e 'const fs=require("node:fs"), c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(0)).digest("hex")+"  -\\n");'\n`);
  if (process.platform === 'win32') write('ln', `#!/bin/sh\nexec ${shellQuote(process.execPath.replaceAll('\\', '/'))} ${shellQuote(path.join(__dirname, 'windows-test-symlink.js').replaceAll('\\', '/'))} "$@"\n`);
  write('backend/bin/mihomo', scriptHeader + `printf 'configuration test successful\\n'\n[ ! -f "$BASE/test-fail" ]\n`);
  write('backend/scripts/start.sh', scriptHeader + `printf 'start:%s\\n' "$*" >> "$BASE/calls"\n[ ! -f "$BASE/start-fail" ]\n`);
  write('backend/scripts/stop.sh', scriptHeader + `printf 'stop\\n' >> "$BASE/calls"\n`);
  write('curl', scriptHeader + `case "$*" in\n  *'/configs?force=true'*) printf 'reload\\n' >> "$BASE/calls"; if [ -f "$BASE/reload-fail" ]; then printf '400'; elif [ -f "$BASE/no-reload" ]; then printf '404'; else printf '204'; fi ;;\n  *) printf 'refresh\\n' >> "$BASE/calls"; if [ -f "$BASE/refresh-fail" ]; then printf '500'; else printf '204'; fi ;;\nesac\n`);
  const config = (version, url = 'https://example.invalid/old') => `# ${version}\r\nexternal-controller: 0.0.0.0:9099\r\nsecret: 123456\r\ndns:\r\n  fake-ip-filter:\r\n    - ${version}.invalid\r\n  default-nameserver:\r\n    - ${version === 'old' ? '223.6.6.6' : '119.29.29.29'}\r\n  nameserver:\r\n    - https://${version}.invalid/dns-query\r\n  proxy-server-nameserver:\r\n    - https://${version}.invalid/proxy-query\r\n  direct-nameserver:\r\n    - https://${version}.invalid/direct-query\r\nproxy-providers:\r\n  main:\r\n    url: ${url}\r\n`;
  const old = config('old'), changed = config('new');
  const cfgPath = path.join(fixture, 'backend/config/config.yaml');
  const configTarget = () => spawnSync(shell, ['-c', 'PATH=.:/usr/bin:/bin:$PATH; export PATH; readlink ./backend/config/config.yaml'],
    { cwd: fixture, encoding: 'utf8', windowsHide: true, env: testEnv }).stdout.trim();
  const readCfg = () => fs.readFileSync(configTarget() ? path.join(path.dirname(cfgPath), configTarget()) : cfgPath, 'utf8');
  const calls = () => fs.existsSync(path.join(fixture, 'backend/calls'))
    ? fs.readFileSync(path.join(fixture, 'backend/calls'), 'utf8') : '';
  const reset = () => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    for (const name of fs.readdirSync(path.dirname(cfgPath))) {
      if (name === 'config.yaml' || name === 'current' || /^MiConfig-\d{12}\.yaml$/.test(name)) fs.rmSync(path.join(path.dirname(cfgPath), name), { force: true });
    }
    write('backend/config/config.yaml', old);
    for (const name of ['calls', 'test-fail', 'start-fail', 'health-fail', 'tamper', 'refresh-fail', 'live', 'reload-fail', 'no-reload', 'run/main-refresh-pending']) {
      fs.rmSync(path.join(fixture, 'backend', name), { force: true });
    }
  };
  const apply = (text, mode = 'AUTO_REFRESH_MAIN', expected = hash(Buffer.from(text)), oldHash = '') => {
    write('uploads/test.yaml', text);
    return spawnSync(shell, [p + '/backend.sh', 'config-apply', p + '/uploads/test.yaml', mode, expected, oldHash],
      { cwd: fixture, encoding: 'utf8', timeout: 20000, windowsHide: true, env: testEnv });
  };
  try {
    reset();
    let result = apply(changed);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readCfg(), changed, 'all five DNS fields and CRLF must exactly match upload');
    assert.equal(parseKeyValue(result.stdout).config_sha256, hash(Buffer.from(changed)));
    assert.doesNotMatch(calls(), /refresh/, 'unchanged main URL must not trigger network refresh');
    assert.equal(parseKeyValue(result.stdout).config_name, 'MiConfig-202610032350.yaml');
    assert.deepEqual(fs.readdirSync(path.dirname(cfgPath)).sort(), ['MiConfig-202610032350.yaml', 'config.yaml']);
    assert.equal(configTarget(), 'MiConfig-202610032350.yaml', 'stable core path must resolve to the current dated file');
    assert.ok(!fs.existsSync(path.join(fixture, 'backend/backups')), 'no persistent config rollback history');
    const configRead = spawnSync(shell, [p + '/backend.sh', 'config-read'],
      { cwd: fixture, encoding: 'utf8', windowsHide: true, env: testEnv });
    assert.equal(configRead.status, 0, configRead.stderr);
    assert.equal(configRead.stdout, changed, 'config download must return the committed DNS file');

    reset();
    result = apply(changed, 'AUTO_REFRESH_MAIN', '0'.repeat(64));
    assert.equal(result.status, 1); assert.equal(readCfg(), old); assert.equal(calls(), '');
    assert.match(result.stderr, /未停止服务或替换现有配置/);
    reset(); result = apply(changed, 'AUTO_REFRESH_MAIN', hash(Buffer.from(changed)), '0'.repeat(64));
    assert.equal(result.status, 1); assert.equal(readCfg(), old); assert.equal(calls(), '');
    assert.match(result.stderr, /配置已被其他操作修改/);

    for (const cause of ['test-fail', 'start-fail', 'health-fail', 'tamper']) {
      reset(); write('backend/' + cause, '1'); result = apply(changed);
      assert.equal(result.status, 1, cause); assert.equal(readCfg(), old, cause);
      assert.doesNotMatch(result.stdout, /OK: 配置已应用|config_sha256=/, cause);
      if (cause !== 'test-fail') assert.match(result.stdout, /configuration test successful/);
    }

    reset(); result = apply(changed, 'REFRESH_MAIN');
    assert.equal(result.status, 0, result.stderr); assert.match(calls(), /refresh/);
    assert.equal(parseKeyValue(result.stdout).main_refreshed, '1', 'dispatcher must forward REFRESH_MAIN');
    reset(); result = apply(config('new', 'https://example.invalid/new'));
    assert.equal(result.status, 0, result.stderr); assert.match(calls(), /refresh/);
    assert.equal(parseKeyValue(result.stdout).main_refreshed, '1', 'dispatcher must forward AUTO_REFRESH_MAIN');

    reset(); write('backend/refresh-fail', '1'); result = apply(changed, 'REFRESH_MAIN');
    assert.equal(result.status, 1); assert.equal(readCfg(), old); assert.match(result.stderr, /main 订阅刷新失败/);

    reset(); write('backend/live', '1'); result = apply(changed);
    assert.equal(result.status, 0, result.stderr); assert.equal(readCfg(), changed);
    assert.equal(parseKeyValue(result.stdout).apply_mode, 'reload');
    assert.match(calls(), /reload/); assert.doesNotMatch(calls(), /start|stop|refresh/);
    assert.doesNotMatch(result.stdout, /configuration test successful/, 'reload API parses once, no duplicate CLI validation');
    result = apply(config('third'));
    assert.equal(result.status, 0, result.stderr); assert.equal(readCfg(), config('third'));
    assert.deepEqual(fs.readdirSync(path.dirname(cfgPath)).sort(), ['MiConfig-202610032350.yaml', 'config.yaml'], 'same-minute saves must not accumulate files');
    write('backend/reload-fail', '1'); result = apply(changed);
    assert.equal(result.status, 1); assert.equal(readCfg(), config('third'), 'restore the same-minute config and stable symlink');
    fs.rmSync(path.join(fixture, 'backend/reload-fail'));
    write('date', '#!/bin/sh\nprintf "202610032351\\n"\n');
    result = apply(config('fourth'));
    assert.equal(result.status, 0, result.stderr); assert.equal(readCfg(), config('fourth'));
    assert.equal(configTarget(), 'MiConfig-202610032351.yaml');
    assert.deepEqual(fs.readdirSync(path.dirname(cfgPath)).sort(), ['MiConfig-202610032351.yaml', 'config.yaml'], 'later-minute save removes the old dated file but keeps the core path');
    write('date', '#!/bin/sh\nprintf "202610032352\\n"\n');
    write('backend/reload-fail', '1'); result = apply(changed);
    assert.equal(result.status, 1); assert.equal(readCfg(), config('fourth'));
    assert.equal(configTarget(), 'MiConfig-202610032351.yaml', 'failed later-minute save restores the old link target');
    assert.deepEqual(fs.readdirSync(path.dirname(cfgPath)).sort(), ['MiConfig-202610032351.yaml', 'config.yaml']);
    reset(); write('backend/live', '1'); result = apply(changed.replace('0.0.0.0:9099', '192.168.0.1:9191'));
    assert.equal(result.status, 0, result.stderr); assert.equal(parseKeyValue(result.stdout).apply_mode, 'restart');
    assert.match(calls(), /stop/); assert.doesNotMatch(calls(), /reload/);
    reset(); write('backend/live', '1'); write('backend/no-reload', '1'); result = apply(changed);
    assert.equal(result.status, 0, result.stderr); assert.equal(parseKeyValue(result.stdout).apply_mode, 'restart');

    // Reproduce the actual UFI contract: success:true even when the inner
    // backend rolls back. Execute the new frontend's real wrapper as well.
    reset(); write('backend/start-fail', '1'); write('uploads/test.yaml', changed);
    const rootShellAdapter = async (command) => {
      const response = spawnSync(shell, ['-c', 'PATH=.:/usr/bin:/bin:$PATH; export PATH; ' + command],
        { cwd: fixture, encoding: 'utf8', timeout: 20000, windowsHide: true, env: testEnv });
      assert.equal(response.status, 0, 'the exit-receipt wrapper itself must finish normally');
      return { success: true, content: response.stdout };
    };
    await assert.rejects(makeRunBackend(rootShellAdapter, './backend.sh')('config-apply',
      ['./uploads/test.yaml', 'AUTO_REFRESH_MAIN', hash(Buffer.from(changed))]), /已尝试恢复操作前配置/);
    assert.equal(readCfg(), old);
    console.log('PASS actual shell dispatcher, DNS-byte preservation, hash rejection, rollback and provider refresh');
  } finally {
    // Delete only this uniquely created fixture, never a computed broad root.
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith('.test-config-transaction-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

frontendTests().then(backendTests).catch((error) => { console.error(error); process.exitCode = 1; });
