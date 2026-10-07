// Test-only ln -s provider for the minimal bundled Git/MSYS shell, which lacks
// ln.exe. MSYS handles its system-file symlinks without Windows admin rights.
// Format: https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/path.cc
// Production Android and Linux CI use the native ln command, never this file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [flag, target, output] = process.argv.slice(2);
const fixture = path.resolve(process.cwd());
const destination = path.resolve(output || '.');
if (process.platform !== 'win32' || flag !== '-s' || !/^MiConfig-\d{12}\.yaml$/.test(target || '')
  || !path.basename(fixture).startsWith('.test-config-transaction-')
  || path.dirname(destination) !== path.join(fixture, 'backend', 'config')) {
  throw new Error('refusing a symlink outside the isolated transaction fixture');
}
fs.writeFileSync(destination, Buffer.concat([
  Buffer.from('!<symlink>', 'ascii'), Buffer.from('\ufeff' + target + '\0', 'utf16le'),
]), { flag: 'wx' });
const result = spawnSync('attrib.exe', ['+S', destination], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stdout + result.stderr || 'cannot set fixture symlink attribute');
