//<script>
// Mihomo UFI-Tools Device Manager Beta 2.6-RC2.3
// Official-style manager button + persistent collapsible MetaCubeXD dock.
// No shell calls on page load, no polling. The dock only loads MetaCubeXD when expanded.
// All write operations are delegated to a fixed-action backend with a global lock.
(async () => {
  'use strict';

  const PLUGIN_VERSION = '2.6-RC2.3';
  const BACKEND_VERSION = '2.6-rc2.3';
  const RELEASE_TAG = 'v2.6-rc2.3';
  const BACKEND = '/data/f50-mihomo/scripts/ufi-backend.sh';
  // The GitHub installer requires this repository to be public and the tag to
  // be immutable. The local-package installer remains available without GitHub.
  const INSTALL_MANIFEST_URL = 'https://raw.githubusercontent.com/Kiro-Durandal/MihomoForUFI/v2.6-rc2.3/release-manifest.json';
  const DEVICE_LOCAL_PROXY = 'http://127.0.0.1:7892';
  const MAX_RELEASE_BYTES = 128 * 1024 * 1024;
  const MODAL_NAME = 'mi_mihomo_manager_v26';
  const BUTTON_ID = 'mi_mihomo_manager_btn_v26';
  const BUTTON_LABEL = 'MiCatty';
  const UPLOAD_ROOT = '/data/data/com.minikano.f50_sms/files/';
  const XD_DOCK_ID = 'mi_mihomo_xd_dock_v26';
  const XD_DOCK_STATE_KEY = 'mi_mihomo_xd_dock_open';
  const XD_CONTROLLER_PORT_KEY = 'mi_mihomo_controller_port';

  const existingButton = document.getElementById(BUTTON_ID);
  if (existingButton) {
    existingButton.textContent = BUTTON_LABEL;
    return;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const escapeHtml = (value = '') =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const shellQuote = (value = '') =>
    "'" + String(value).replace(/'/g, "'\"'\"'") + "'";

  const redactInstallOutput = (value, subscriptionUrl = '') => {
    let output = String(value || '');
    if (subscriptionUrl) output = output.replaceAll(subscriptionUrl, '[订阅链接已隐藏]');
    return output.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL 已隐藏]');
  };

  const parseKeyValue = (text) => {
    const output = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index <= 0) continue;
      output[line.slice(0, index)] = line.slice(index + 1);
    }
    return output;
  };

  const formatBytes = (value) => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes;
    let unit = -1;
    do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
  };

  const downloadText = (filename, text, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const configFilename = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `MiConfig-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.yaml`;
  };

  let lastBackendState = null;

  const rootEnabled = async () => {
    try {
      if (typeof checkAdvancedFunc === 'function') {
        return Boolean(await checkAdvancedFunc());
      }
      const res = await runShellWithRoot('whoami', 15000);
      return Boolean(res?.content?.includes('root'));
    } catch (_) {
      return false;
    }
  };

  const ensureBackend = async () => {
    const res = await runShellWithRoot(
      `[ -x ${shellQuote(BACKEND)} ] && sh ${shellQuote(BACKEND)} status 2>/dev/null || true`,
      25000,
    );
    const output = String(res?.content || '');
    updateControllerPortFromStatus(output);
    const state = parseKeyValue(output);
    lastBackendState = state;
    return {
      ready: state.backend === BACKEND_VERSION && state.installed === '1',
      output,
      state,
    };
  };

  const hasCompleteInstall = async () => {
    if (lastBackendState) return lastBackendState.installed === '1';
    const res = await runShellWithRoot(
      `sh ${shellQuote(BACKEND)} status 2>/dev/null | grep -q '^installed=1$' && echo YES || echo NO`,
      25000,
    );
    return /(?:^|\n)YES(?:\r?\n|$)/.test(String(res?.content || ''));
  };

  const validateReleaseManifest = (input) => {
    const manifest = input && typeof input === 'object' ? input : {};
    if (manifest.schema !== 1 || manifest.version !== PLUGIN_VERSION) {
      throw new Error(`发布清单与插件版本不匹配（需要 ${PLUGIN_VERSION}）`);
    }
    if (manifest.published !== true) throw new Error('发布清单尚未标记为可发布');
    const pkg = manifest.package || {};
    let packageUrl;
    try { packageUrl = new URL(String(pkg.url || '')); }
    catch (_) { throw new Error('发布包 URL 无效'); }
    if (packageUrl.protocol !== 'https:' || packageUrl.hostname !== 'github.com') {
      throw new Error('发布包必须使用 GitHub HTTPS Release URL');
    }
    if (!packageUrl.pathname.includes(`/releases/download/${RELEASE_TAG}/`)) {
      throw new Error(`发布包必须固定到不可变标签 ${RELEASE_TAG}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(pkg.sha256 || ''))) throw new Error('发布包 SHA-256 无效');
    if (!/^[A-Za-z0-9._-]+\.tar$/.test(String(pkg.name || ''))) throw new Error('发布包文件名无效');
    if (!/^[A-Za-z0-9._-]+$/.test(String(pkg.root_dir || ''))) throw new Error('发布包根目录无效');
    const expectedPath = `/Kiro-Durandal/MihomoForUFI/releases/download/${RELEASE_TAG}/${pkg.name}`;
    if (packageUrl.pathname !== expectedPath || packageUrl.username || packageUrl.password || packageUrl.search || packageUrl.hash) {
      throw new Error('发布包 URL 与固定仓库、标签或文件名不一致');
    }
    const bytes = Number(pkg.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_RELEASE_BYTES) {
      throw new Error('发布包大小字段无效或超过 128 MB');
    }
    return {
      schema: 1,
      version: manifest.version,
      published: true,
      ...(manifest.upgrade_package ? { upgrade_package: validateReleaseManifest({ ...manifest, package: manifest.upgrade_package, upgrade_package: undefined }).package } : {}),
      package: {
        url: String(pkg.url),
        sha256: String(pkg.sha256),
        name: String(pkg.name),
        root_dir: String(pkg.root_dir),
        bytes,
      },
    };
  };

  const selectInstallPackage = (manifest, upgrading) =>
    upgrading && manifest.upgrade_package ? { ...manifest, package: manifest.upgrade_package } : manifest;

  const readManifestFile = async (file) => {
    if (!file || file.size <= 0 || file.size > 64 * 1024) throw new Error('本地发布清单无效');
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (_) { throw new Error('本地发布清单不是有效 JSON'); }
    return validateReleaseManifest(parsed);
  };

  const fetchReleaseManifest = async () => {
    if (!/^https:\/\//.test(INSTALL_MANIFEST_URL) || INSTALL_MANIFEST_URL.includes('__')) {
      throw new Error('RC2.3 尚未填写 GitHub 发布清单地址；请先完成发布配置，或使用本地完整包');
    }
    const source = new URL(INSTALL_MANIFEST_URL);
    if (source.hostname !== 'raw.githubusercontent.com' || !source.pathname.includes(`/${RELEASE_TAG}/`)) {
      throw new Error(`发布清单必须来自 raw.githubusercontent.com 的不可变标签 ${RELEASE_TAG}`);
    }
    // The UFI-Tools WebView may block cross-origin fetch even when the 设备 can
    // reach GitHub. Fetch on the device; use its local mixed listener only if
    // the direct request fails, so a running proxy is not required.
    const command = String.raw`
exec 2>&1
CURL=/data/data/com.minikano.f50_sms/files/curl
[ -x "$CURL" ] || { echo 'ERROR: 设备缺少 UFI-Tools curl' >&2; exit 1; }
MANIFEST=$(mktemp /data/local/tmp/mi-mihomo-rc23-manifest.XXXXXX) || exit 1
trap 'rm -f "$MANIFEST"' EXIT
DOWNLOADED=0
ATTEMPT=1
while [ "$ATTEMPT" -le 3 ]; do
  if "$CURL" --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --noproxy '*' --connect-timeout 8 --max-time 15 \
    --output "$MANIFEST" ${shellQuote(INSTALL_MANIFEST_URL)}; then
    echo "INFO: 发布清单由设备直连获取（第 $ATTEMPT 次）"
    DOWNLOADED=1
    break
  fi
  if [ "$ATTEMPT" -eq 1 ]; then
    if "$CURL" --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --proxy ${shellQuote(DEVICE_LOCAL_PROXY)} --noproxy '' --connect-timeout 5 --max-time 20 \
      --output "$MANIFEST" ${shellQuote(INSTALL_MANIFEST_URL)}; then
      echo 'INFO: 发布清单经设备本机代理获取'
      DOWNLOADED=1
      break
    fi
  fi
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -le 3 ] && sleep 2
done
if [ "$DOWNLOADED" -eq 0 ]; then
  echo 'ERROR: 设备 直连重试三次且本机代理不可用；初装可改用本地完整包' >&2
  exit 1
fi
[ -s "$MANIFEST" ] && [ "$(wc -c < "$MANIFEST")" -le 65536 ] || {
  echo 'ERROR: 发布清单为空或超过 64 KB' >&2
  exit 1
}
printf '__MI_MANIFEST_BEGIN__\n'
cat "$MANIFEST"
printf '\n__MI_MANIFEST_END__\n'
`;
    const result = await runShellWithRoot(command, 80000);
    const output = String(result?.content || '').replace(/\r\n/g, '\n');
    const begin = '__MI_MANIFEST_BEGIN__\n';
    const end = '\n__MI_MANIFEST_END__';
    const start = output.indexOf(begin);
    const finish = start < 0 ? -1 : output.indexOf(end, start + begin.length);
    if (!result?.success || start < 0 || finish < 0) {
      const detail = redactInstallOutput(output.slice(-1200)).trim();
      throw new Error(`设备下载发布清单失败。${detail ? `\n${detail}` : '设备未返回诊断输出'}`);
    }
    let parsed;
    try { parsed = JSON.parse(output.slice(start + begin.length, finish)); }
    catch (_) { throw new Error('设备 下载的发布清单不是有效 JSON'); }
    const manifest = validateReleaseManifest(parsed);
    const sourceParts = source.pathname.split('/').filter(Boolean);
    const packageUrl = new URL(manifest.package.url);
    const expectedPrefix = `/${sourceParts[0]}/${sourceParts[1]}/releases/download/${RELEASE_TAG}/`;
    if (sourceParts.length < 4 || !packageUrl.pathname.startsWith(expectedPrefix)) {
      throw new Error('发布清单与安装包不属于同一个 GitHub 仓库或标签');
    }
    return manifest;
  };

  const runReleaseInstaller = async (manifest, packageFile = null, onProgress = () => {}) => {
    if (packageFile) {
      if (packageFile.name !== manifest.package.name) throw new Error('发布包文件名与清单不一致');
      if (packageFile.size !== manifest.package.bytes) throw new Error('发布包大小与清单不一致');
    }

    let packagePath = '';
    const transferStarted = Date.now();
    try {
      if (packageFile) {
        onProgress('正在将本地完整包上传到 设备……');
        packagePath = await uploadFileToUfi(packageFile);
      } else {
        const allocated = await runShellWithRoot(
          'mktemp /data/local/tmp/mi-mihomo-rc23-package.XXXXXX', 15000,
        );
        const pathMatch = String(allocated?.content || '').match(/(?:^|\n)(\/data\/local\/tmp\/mi-mihomo-rc23-package\.[A-Za-z0-9._-]+)(?:\r?\n|$)/);
        if (!allocated?.success || !pathMatch) {
          throw new Error(`设备无法创建临时下载文件：${redactInstallOutput(allocated?.content || '无输出')}`);
        }
        packagePath = pathMatch[1];
        const curl = '/data/data/com.minikano.f50_sms/files/curl';
        const download = async (useProxy, attempt) => {
          onProgress(useProxy ? '设备直连失败，正在通过本机 7892 代理下载……'
            : `设备直连下载发布包（第 ${attempt}/3 次）……`);
          const route = useProxy ? `--proxy ${shellQuote(DEVICE_LOCAL_PROXY)} --noproxy ''` : `--noproxy '*'`;
          const marker = `__MI_DOWNLOAD_EXIT_${Date.now()}_${++backendCallSequence}__`;
          const command = `exec 2>&1\n[ -x ${shellQuote(curl)} ] || { echo 'ERROR: 设备缺少 UFI-Tools curl'; exit 1; }\n${shellQuote(curl)} --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 ${route} --connect-timeout 12 --max-time 240 --speed-limit 1024 --speed-time 30 --output ${shellQuote(packagePath)} ${shellQuote(manifest.package.url)}; mi_download_rc=$?; printf '\\n${marker}=%s\\n' "$mi_download_rc"`;
          const result = await runShellWithRoot(command, 270000);
          const receipt = String(result?.content || '').match(new RegExp(`${marker}=(\\d+)\\s*$`));
          return { ok: Boolean(result?.success && receipt && receipt[1] === '0'), detail: String(result?.content || '').trim() };
        };
        let downloaded = false;
        let lastFailure = '';
        const firstDirect = await download(false, 1);
        downloaded = firstDirect.ok;
        if (!downloaded) {
          lastFailure = firstDirect.detail;
          // On an installed device 7892 may already work; try it after one
          // failed direct transfer instead of spending two more long timeouts.
          // Fresh installations still get all three direct attempts.
          const proxyResult = await download(true, 1);
          downloaded = proxyResult.ok;
          if (!downloaded) lastFailure = proxyResult.detail || lastFailure;
        }
        if (!downloaded) {
          for (let attempt = 2; attempt <= 3; attempt++) {
            const result = await download(false, attempt);
            if (result.ok) { downloaded = true; break; }
            lastFailure = result.detail || lastFailure;
          }
        }
        if (!downloaded) {
          throw new Error(`设备 直连三次及本机代理均无法下载发布包。${lastFailure ? `\n${redactInstallOutput(lastFailure.slice(-800))}` : ''}\n初装可改用本地完整包。`);
        }
      }
      const transferSeconds = ((Date.now() - transferStarted) / 1000).toFixed(1);
      onProgress(`发布包已取得（传输 ${transferSeconds} 秒）；正在校验大小与 SHA-256 并安装……`);
      const installStarted = Date.now();
      const command = String.raw`
exec 2>&1
PACKAGE=${shellQuote(packagePath)}
STAGE=/data/local/tmp/mi-mihomo-rc23-install-$$
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
EXPECTED=${shellQuote(manifest.package.sha256)}
EXPECTED_BYTES=${manifest.package.bytes}
ROOT_DIR=${shellQuote(manifest.package.root_dir)}
[ "$(wc -c < "$PACKAGE" 2>/dev/null)" = "$EXPECTED_BYTES" ] || { echo 'ERROR: 发布包字节数与清单不一致' >&2; exit 1; }
mkdir "$STAGE" || exit 1
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$PACKAGE" | awk '{print $1}')
elif toybox sha256sum /dev/null >/dev/null 2>&1; then
  ACTUAL=$(toybox sha256sum "$PACKAGE" | awk '{print $1}')
else
  echo 'ERROR: 设备缺少 SHA-256 校验工具' >&2
  exit 1
fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo 'ERROR: 发布包 SHA-256 不匹配' >&2; exit 1; }
if command -v tar >/dev/null 2>&1; then
  CONTENTS=$(tar -tf "$PACKAGE") || exit 1
  DETAILS=$(tar -tvf "$PACKAGE") || exit 1
else
  CONTENTS=$(toybox tar -tf "$PACKAGE") || exit 1
  DETAILS=$(toybox tar -tvf "$PACKAGE") || exit 1
fi
printf '%s\n' "$CONTENTS" | awk -v root="$ROOT_DIR" '
  {
    path=$0
    sub(/^\.\//, "", path)
    if (path ~ /^\// || path ~ /(^|\/)\.\.(\/|$)/ || (path != root && index(path, root "/") != 1)) bad=1
  }
  END { exit bad ? 1 : 0 }
' || { echo 'ERROR: 发布包含越界路径' >&2; exit 1; }
printf '%s\n' "$DETAILS" | awk '$1 ~ /^[lh]/ { bad=1 } END { exit bad ? 1 : 0 }' || {
  echo 'ERROR: 发布包不允许包含符号链接或硬链接' >&2
  exit 1
}
if command -v tar >/dev/null 2>&1; then
  tar -xf "$PACKAGE" -C "$STAGE" || exit 1
else
  toybox tar -xf "$PACKAGE" -C "$STAGE" || exit 1
fi
[ -z "$(find "$STAGE" -type l -print -quit 2>/dev/null)" ] || { echo 'ERROR: 解包结果包含符号链接' >&2; exit 1; }
[ -f "$STAGE/$ROOT_DIR/install.sh" ] || { echo 'ERROR: 发布包缺少 install.sh' >&2; exit 1; }
printf 'RC2.3 发布包已校验并解包；开始执行 install.sh\n'
sh "$STAGE/$ROOT_DIR/install.sh"
INSTALL_EXIT=$?
printf '\n__MI_RC2_INSTALL_EXIT__=%s\n' "$INSTALL_EXIT"
exit "$INSTALL_EXIT"
`;
      const result = await runShellWithRoot(command, 300000);
      const rawOutput = String(result?.content || '');
      const exitMatch = rawOutput.match(/(?:^|\n)__MI_RC2_INSTALL_EXIT__=(\d+)(?:\r?\n|$)/);
      const installOutput = rawOutput.replace(/(?:^|\n)__MI_RC2_INSTALL_EXIT__=\d+(?:\r?\n|$)/, '\n').trim();
      if (!result?.success || !exitMatch || exitMatch[1] !== '0') {
        const exitDetail = exitMatch ? `退出码 ${exitMatch[1]}` : '未到达安装完成标记';
        throw new Error(`RC2.3 安装未完成（${exitDetail}）。\n${installOutput || '设备未返回安装输出'}`);
      }
      const installSeconds = ((Date.now() - installStarted) / 1000).toFixed(1);
      return `${installOutput}\n耗时：发布包传输 ${transferSeconds} 秒；校验与安装 ${installSeconds} 秒。`;
    } finally {
      if (packagePath) {
        const cleanupCommand = `rm -f ${shellQuote(packagePath)}`;
        try { await runShellWithRoot(cleanupCommand, 15000); } catch (_) { /* best effort */ }
      }
    }
  };

  const ACTIONS = new Set([
    'status', 'health', 'stop', 'restart',
    'boot-enable', 'boot-disable',
    'config-read', 'config-apply',
    'boot-log', 'mihomo-log',
    'provider-status', 'uninstall',
  ]);

  let backendCallSequence = 0;
  const runBackend = async (action, args = [], timeout = 120000) => {
    if (!ACTIONS.has(action)) throw new Error('前端请求了不受支持的后端动作');
    const safeArgs = args.map((item) => shellQuote(String(item))).join(' ');
    // UFI success only means that /root_shell returned a result, not exit 0.
    // A unique final receipt also detects missing/truncated or stale responses.
    const marker = `__MI_BACKEND_EXIT_${Date.now()}_${++backendCallSequence}__`;
    const command = `sh ${shellQuote(BACKEND)} ${shellQuote(action)}${safeArgs ? ` ${safeArgs}` : ''} 2>&1; mi_backend_rc=$?; printf '\\n${marker}=%s\\n' "$mi_backend_rc"`;
    const res = await runShellWithRoot(command, timeout);
    if (!res?.success) {
      throw new Error(String(res?.content || '后端命令执行失败').trim());
    }
    const raw = String(res.content || '');
    const receipt = raw.match(new RegExp(`(?:\\r?\\n)?${marker}=(\\d+)\\s*$`));
    if (!receipt) throw new Error('未收到后端完成回执，无法确认操作结果；请刷新状态，勿将此提示视为成功');
    const output = raw.slice(0, receipt.index);
    if (Number(receipt[1]) !== 0) {
      throw new Error(output.trim() || `后端操作失败（退出码 ${receipt[1]}）`);
    }
    return output;
  };

  const getLanIp = () =>
    (window.UFI_DATA && window.UFI_DATA.lan_ipaddr) || '192.168.0.1';

  let controllerPort = null;
  let controllerAddress = '';
  let xdDock = null;
  try {
    const cachedPort = Number(localStorage.getItem(XD_CONTROLLER_PORT_KEY));
    if (Number.isInteger(cachedPort) && cachedPort >= 1 && cachedPort <= 65535) {
      controllerPort = cachedPort;
    }
  } catch (_) {}

  const updateControllerPortFromStatus = (status) => {
    const data = typeof status === 'string' ? parseKeyValue(status) : (status || {});
    const port = Number(data.controller_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const changed = controllerPort !== port || Boolean(data.controller_address && controllerAddress !== data.controller_address);
    controllerPort = port;
    if (data.controller_address) controllerAddress = String(data.controller_address);
    try { localStorage.setItem(XD_CONTROLLER_PORT_KEY, String(port)); } catch (_) {}
    if (changed && xdDock?.open) {
      xdDock.frame.src = getXdUrl(true);
    }
    return true;
  };

  const refreshControllerPort = async () => {
    const output = await runBackend('status', [], 25000);
    if (!updateControllerPortFromStatus(output)) {
      throw new Error('无法从现有 config.yaml 读取 external-controller TCP 端口');
    }
    return output;
  };

  const formatUrlHost = (host) => {
    const value = String(host || '').trim().replace(/^\[|\]$/g, '');
    return value.includes(':') ? `[${value}]` : value;
  };

  const getXdUrl = (cacheBust = false) =>
    `http://${formatUrlHost(controllerAddress && !/^(0\.0\.0\.0|\[::\]):/.test(controllerAddress) ? controllerAddress.slice(0, controllerAddress.lastIndexOf(':')) : getLanIp())}:${controllerPort || 9099}/ui/${cacheBust ? `?t=${Date.now()}` : ''}`;

  const uploadFileToUfi = async (file, uploadName = file.name) => {
    const formData = new FormData();
    formData.append('file', file, uploadName);
    const response = await fetch(`${KANO_baseURL}/upload_img`, {
      method: 'POST',
      headers: common_headers,
      body: formData,
    });
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error(`上传接口返回了非 JSON 响应（HTTP ${response.status}）`); }
    if (!response.ok) throw new Error(result?.error || `上传失败（HTTP ${response.status}）`);
    if (!result?.url) throw new Error(result?.error || '上传失败');

    const relativePath = String(result.url).replace(/^\/+/, '');
    if (!/^uploads\/[A-Za-z0-9._-]+$/.test(relativePath)) {
      throw new Error('UFI-Tools 返回了异常上传路径');
    }
    return `${UPLOAD_ROOT}${relativePath}`;
  };

  // Hash the actual file bytes, not decoded YAML (preserves BOM/CRLF/UTF-8).
  // HTTP UFI pages may lack Web Crypto, so retain a dependency-free fallback.
  const sha256Bytes = (bytes) => {
    const constants = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    const words = new Uint32Array(64);
    const rotate = (value, count) => (value >>> count) | (value << (32 - count));
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3))
          + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
          + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
        const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22))
          + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, i) => { state[i] += value; });
    }
    return Array.from(state, (value) => value.toString(16).padStart(8, '0')).join('');
  };

  const configFileSha256 = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (globalThis.crypto?.subtle) {
      try {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      } catch (_) { /* unavailable Web Crypto: use exact-byte fallback */ }
    }
    return sha256Bytes(bytes);
  };

  const showTextModal = (title, text, filename) => {
    const name = `mi_text_${Date.now()}`;
    document.getElementById(name)?.remove();
    const created = createModal({
      name,
      title,
      maxWidth: '900px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <pre class="mi-text-output" style="box-sizing:border-box;white-space:pre-wrap;
          word-break:break-word;max-height:62vh;overflow:auto;margin:0;padding:12px;
          border-radius:8px;background:#000c;color:#8cff8c;font-size:.66rem;
          line-height:1.5"></pre>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="mi-text-download">下载文本</button>
        </div>`,
    });
    if (!created) throw new Error('无法创建文本窗口');
    created.el.querySelector('.mi-text-output').textContent = text || '（无内容）';
    created.el.querySelector('.mi-text-download').onclick = () =>
      downloadText(filename, text || '');
    showModal(created.id);
  };

  const countIndent = (line) => (/^ */.exec(line)?.[0].length || 0);

  const splitYamlValueAndComment = (raw) => {
    let single = false;
    let double = false;
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (single) {
        if (char === "'") {
          if (raw[i + 1] === "'") i++;
          else single = false;
        }
        continue;
      }
      if (double) {
        if (char === '\\') { i++; continue; }
        if (char === '"') double = false;
        continue;
      }
      if (char === "'") { single = true; continue; }
      if (char === '"') { double = true; continue; }
      if (char === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
        return { value: raw.slice(0, i).trimEnd(), comment: raw.slice(i) };
      }
    }
    return { value: raw.trimEnd(), comment: '' };
  };

  const parseYamlScalar = (raw) => {
    const value = splitYamlValueAndComment(String(raw || '')).value.trim();
    if (!value) return '';
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return JSON.parse(value); } catch (_) { return value.slice(1, -1); }
    }
    return value;
  };

  const findMainProviderUrl = (configText) => {
    const lines = String(configText || '').split(/\r?\n/);
    let providersIndex = -1;
    let providersIndent = -1;
    let mainIndex = -1;
    let mainIndent = -1;
    const mainBlockLines = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('\t')) throw new Error('配置含 Tab 缩进，无法安全修改');
      if (/^\s*proxy-providers:\s*(?:#.*)?$/.test(lines[i])) {
        providersIndex = i;
        providersIndent = countIndent(lines[i]);
        break;
      }
    }
    if (providersIndex < 0) throw new Error('未找到 proxy-providers');

    for (let i = providersIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = countIndent(line);
      if (indent <= providersIndent) break;
      if (/^\s*main:\s*(?:#.*)?$/.test(line)) {
        mainIndex = i;
        mainIndent = indent;
        break;
      }
    }
    if (mainIndex < 0) throw new Error('未找到 proxy-providers.main');

    for (let i = mainIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = countIndent(line);
      if (indent <= mainIndent) break;
      mainBlockLines.push({ index: i, line, indent });
    }
    if (!mainBlockLines.length) throw new Error('proxy-providers.main 内容为空');

    const directChildIndent = Math.min(...mainBlockLines.map((item) => item.indent));
    const matches = [];
    for (const item of mainBlockLines) {
      if (item.indent !== directChildIndent) continue;
      const match = /^(\s*)url:\s*(.*)$/.exec(item.line);
      if (match) matches.push({ index: item.index, indent: match[1], raw: match[2] });
    }
    if (matches.length !== 1) {
      throw new Error(matches.length ? 'main 同级存在多个 url' : '未找到 main.url');
    }
    return {
      lines,
      index: matches[0].index,
      indent: matches[0].indent,
      currentUrl: parseYamlScalar(matches[0].raw),
      comment: splitYamlValueAndComment(matches[0].raw).comment,
      trailingNewline: /\r?\n$/.test(String(configText || '')),
    };
  };

  const validateSubscriptionUrl = (input) => {
    const value = String(input || '').trim();
    if (!value) throw new Error('请输入订阅链接');
    if (value.length > 4096) throw new Error('订阅链接过长');
    if (/[\u0000-\u001f\u007f\s]/.test(value)) throw new Error('链接不能含空格或控制字符');
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new Error('订阅链接格式无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('只允许 HTTP 或 HTTPS 订阅链接');
    }
    if (!parsed.hostname) throw new Error('订阅链接缺少主机名');
    return value;
  };

  const replaceMainProviderUrl = (configText, newUrl) => {
    const location = findMainProviderUrl(configText);
    const quoted = `'${String(newUrl).replace(/'/g, "''")}'`;
    const suffix = location.comment ? ` ${location.comment}` : '';
    location.lines[location.index] = `${location.indent}url: ${quoted}${suffix}`;
    if (location.trailingNewline && location.lines.at(-1) === '') location.lines.pop();
    const output = location.lines.join('\n');
    return location.trailingNewline ? `${output}\n` : output;
  };

  const normalizeControllerIP = (input) => {
    const value = String(input || '').trim().replace(/^\[|\]$/g, '');
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
      const parts = value.split('.').map(Number);
      if (parts.every((part) => part <= 255)) return parts.join('.');
    }
    if (value.includes(':') && /^[0-9a-f:]+$/i.test(value)) {
      try { return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, ''); } catch (_) {}
    }
    throw new Error('请输入有效的 IPv4 或 IPv6 地址，不要包含协议或端口');
  };

  const readControllerSetting = (text) => {
    const lines = String(text).split(/\r?\n/);
    const matches = lines.map((line, index) => ({ index, match: /^\ufeff?external-controller:\s*(.*)$/.exec(line) })).filter((item) => item.match);
    if (matches.length !== 1) throw new Error('配置须有且仅有一个 external-controller 字段');
    const item = matches[0];
    const address = parseYamlScalar(item.match[1]);
    const pos = address.lastIndexOf(':');
    if (pos < 0) throw new Error('现有控制器地址格式无效');
    return { lines, index: item.index, raw: item.match[1], ip: address.slice(0, pos).replace(/^\[|\]$/g, ''), port: address.slice(pos + 1) };
  };

  const replaceControllerSetting = (text, inputIP, inputPort) => {
    const ip = normalizeControllerIP(inputIP);
    const portText = String(inputPort).trim();
    if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('端口应为 1–65535 的整数');
    const setting = readControllerSetting(text);
    const suffix = splitYamlValueAndComment(setting.raw).comment;
    const bom = setting.lines[setting.index].startsWith('\ufeff') ? '\ufeff' : '';
    const address = `${ip.includes(':') ? `[${ip}]` : ip}:${Number(portText)}`;
    setting.lines[setting.index] = `${bom}external-controller: '${address}'${suffix ? ` ${suffix}` : ''}`;
    return setting.lines.join(/\r\n/.test(text) ? '\r\n' : '\n');
  };

  const readProviderSummary = async () => {
    const raw = await runBackend('provider-status', [], 30000);
    let provider;
    try { provider = JSON.parse(raw); }
    catch (_) { throw new Error('控制器返回的订阅状态不是有效 JSON'); }
    if (!Array.isArray(provider?.proxies)) throw new Error('控制器未返回 main 节点列表');
    // Only show a count: provider JSON may contain private node metadata.
    const count = provider.proxies.filter((proxy) =>
      proxy && typeof proxy.name === 'string' && proxy.name !== 'COMPATIBLE').length;
    return { count };
  };

  const updateXdDockVisual = (open) => {
    if (!xdDock) return;
    xdDock.open = Boolean(open);
    xdDock.body.style.display = xdDock.open ? 'block' : 'none';
    xdDock.toggleButton.textContent = xdDock.open ? '收起' : '展开';
    xdDock.toggleButton.setAttribute('aria-expanded', xdDock.open ? 'true' : 'false');
    if (xdDock.open && controllerPort && xdDock.frame.src === 'about:blank') {
      xdDock.frame.src = getXdUrl(false);
    }
  };

  const setXdDockOpen = (open, persist = true, focus = false) => {
    updateXdDockVisual(open);
    if (persist) {
      try { localStorage.setItem(XD_DOCK_STATE_KEY, open ? '1' : '0'); } catch (_) {}
    }
    if (open && focus && xdDock?.root) {
      xdDock.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const refreshXdDock = async () => {
    if (!xdDock) return;
    await refreshControllerPort();
    xdDock.frame.src = getXdUrl(true);
    setXdDockOpen(true, true, false);
  };

  const mountXdDock = () => {
    // A previous failed initialization may have left a panel without handlers.
    // Rebuild it when the main entry has not yet been mounted.
    document.getElementById(XD_DOCK_ID)?.remove();
    const anchor = document.querySelector('.functions-container') ||
      document.querySelector('.actions-buttons')?.parentElement;
    if (!anchor) return;

    const root = document.createElement('div');
    root.id = XD_DOCK_ID;
    root.style.cssText = 'width:100%;margin-top:10px';
    root.innerHTML = `
      <div class="title" style="display:flex;align-items:center;gap:10px;margin:6px 0">
        <strong>MetaCubeXD</strong>
        <button class="btn mi-xd-dock-toggle" type="button" aria-expanded="false">展开</button>
      </div>
      <div class="mi-xd-dock-body" style="display:none;padding:0 8px 8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 2px 8px">
          <button class="btn mi-xd-dock-refresh" type="button">刷新网页</button>
        </div>
        <div class="mi-xd-dock-frame-wrap" style="position:relative;width:100%;height:72vh;min-height:460px;max-height:88vh;resize:vertical;overflow:hidden;border-radius:8px;background:#111">
          <iframe class="mi-xd-dock-frame" title="MetaCubeXD" src="about:blank" loading="lazy"
            referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write" allowfullscreen
            style="display:block;width:100%;height:100%;border:0;background:#111"></iframe>
        </div>
      </div>`;

    anchor.insertAdjacentElement('afterend', root);
    xdDock = {
      root,
      body: root.querySelector('.mi-xd-dock-body'),
      frame: root.querySelector('.mi-xd-dock-frame'),
      toggleButton: root.querySelector('.mi-xd-dock-toggle'),
      open: false,
    };

    const toggle = async () => {
      try {
        if (!xdDock.open) await refreshControllerPort();
        setXdDockOpen(!xdDock.open, true, false);
      } catch (error) {
        createToast(error.message || String(error), 'red', 6000);
      }
    };
    xdDock.toggleButton.onclick = () => { void toggle(); };
    root.querySelector('.mi-xd-dock-refresh').onclick = () => {
      refreshXdDock().catch((error) => createToast(error.message || String(error), 'red', 6000));
    };

    // Start closed after a page reload so a stale cached controller port never
    // opens the iframe before the actual port has been read from config.yaml.
    setXdDockOpen(false, false, false);
  };

  let globalBusy = false;
  let currentState = {};
  let modalElement = null;

  const setBusy = (busy, label = '') => {
    globalBusy = busy;
    if (!modalElement) return;
    modalElement.querySelectorAll('[data-mi-action]').forEach((button) => {
      button.disabled = busy;
    });
    const tip = modalElement.querySelector('#mi_busy_tip');
    if (tip) {
      tip.style.display = busy ? 'block' : 'none';
      tip.textContent = busy ? (label || '正在执行操作，请稍候……') : '';
    }
  };

  const withBusy = async (label, fn) => {
    if (globalBusy) return;
    setBusy(true, label);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };

  const refreshStatus = async (toast = false, knownOutput = null) => {
    const output = knownOutput ?? await runBackend('status', [], 25000);
    currentState = typeof output === 'string' ? parseKeyValue(output) : { ...output };
    lastBackendState = currentState;
    updateControllerPortFromStatus(currentState);
    const el = modalElement?.querySelector('#mi_status_card');
    if (!el) return;

    const running = currentState.running === '1';
    const installed = currentState.installed === '1';
    const configured = currentState.configured !== '0';
    const boot = currentState.boot === '1';
    const ui = currentState.ui === '1';
    const ipv4 = currentState.ipv4 === '1';
    const ipv6 = currentState.ipv6 === '1';
    el.innerHTML = `
      <div><b>安装：</b>${installed ? '已安装' : '未检测到'}</div>
      <div><b>首次配置：</b>${configured ? '已完成' : '等待填写订阅链接'}</div>
      <div><b>内核：</b>${running ? `🟢 运行中（PID ${escapeHtml(currentState.pid || '?')}）` : '🔴 已停止'}</div>
      <div><b>IPv4 代理：</b>${ipv4 ? '🟢 规则完整' : '🔴 未就绪'}</div>
      <div><b>IPv6 代理：</b>${ipv6 ? '🟢 规则完整' : '🔴 未就绪'}</div>
      <div><b>版本：</b>${escapeHtml(currentState.version || '未知')}</div>
      <div><b>后端：</b>${escapeHtml(currentState.backend || '未知')}</div>
      <div><b>控制器：</b>${escapeHtml(currentState.controller_address || currentState.controller_port || '未知')}</div>
      <div><b>配置：</b>${escapeHtml(currentState.config_name || '未知')}</div>
      <div><b>开机自启：</b>${boot ? '已开启' : '未开启'}</div>
      <div><b>MetaCubeXD：</b>${ui ? '已安装' : '未检测到'}</div>
      <div><b>日志占用：</b>Mihomo ${formatBytes(currentState.log_bytes)}；开机 ${formatBytes(currentState.boot_log_bytes)}</div>`;

    const bootBtn = modalElement.querySelector('#mi_boot_toggle');
    if (bootBtn) {
      bootBtn.textContent = boot ? '关闭开机自启' : '开启开机自启';
      bootBtn.style.background = boot ? 'var(--dark-btn-color-active)' : '';
    }
    if (toast) createToast('状态已刷新', 'green');
  };

  const applyConfigFile = async (file, onProgress = () => {}, refreshCard = true, refreshMain = false, expectedOldHash = '') => {
    if (!file) return;
    if (file.size <= 0) throw new Error('配置文件为空');
    if (file.size > 3 * 1024 * 1024) throw new Error('配置文件不能超过 3 MB');
    const uploadStarted = Date.now();
    onProgress('正在上传配置……');
    const expectedHash = await configFileSha256(file);
    const uploadName = configFilename().replace('.yaml', `-${++backendCallSequence}.yaml`);
    const uploadedPath = await uploadFileToUfi(file, uploadName);
    const uploadSeconds = ((Date.now() - uploadStarted) / 1000).toFixed(1);
    onProgress(`上传完成（${uploadSeconds} 秒）；正在校验配置、启动 Mihomo、必要时刷新 main 并检查双栈……`);
    const applyStarted = Date.now();
    const output = await runBackend('config-apply', [uploadedPath, refreshMain ? 'REFRESH_MAIN' : 'AUTO_REFRESH_MAIN', expectedHash, expectedOldHash], 240000).catch(async (error) => {
      try { await runShellWithRoot(`rm -f ${shellQuote(uploadedPath)}`, 15000); } catch (_) {}
      throw error;
    });
    if (parseKeyValue(output).config_sha256 !== expectedHash) {
      throw new Error('后端未确认正式配置与上传文件一致；请确认已配套升级 RC2.3 前后端，勿将此提示视为成功');
    }
    const applySeconds = ((Date.now() - applyStarted) / 1000).toFixed(1);
    updateControllerPortFromStatus(output);
    if (refreshCard) await refreshStatus(false, { ...currentState, ...parseKeyValue(output) });
    return { output, uploadSeconds, applySeconds };
  };

  const applyEditedConfig = async (original, edited, progress) => {
    const oldHash = await configFileSha256(new File([original], configFilename()));
    return applyConfigFile(new File([edited], configFilename(), { type: 'text/yaml' }), progress, true, false, oldHash);
  };

  const showManagerDialog = (dialog, display = '') => {
    const parent = modalElement;
    const restoreParent = parent && parent.style.display !== 'none';
    if (restoreParent) parent.style.display = 'none';
    showModal(dialog.id);
    // UFI showModal clears inline display; set layout only after it runs.
    if (display) dialog.el.style.display = display;
    return () => closeModal(dialog.id, 300, () => {
      dialog.el.remove();
      if (restoreParent && parent.isConnected) showModal(`#${parent.id}`);
    });
  };

  const openConfigEditor = async () => {
    const original = await runBackend('config-read', [], 30000);
    document.getElementById('mi_config_editor')?.remove();
    let saving = false;
    const dialog = createModal({
      name: 'mi_config_editor', title: '编辑 Mihomo 配置', maxWidth: '1050px', showConfirm: true,
      confirmBtnText: '保存并应用', closeBtnText: '取消',
      onClose: () => { if (!saving) closeEditor(); return false; },
      contentStyle: 'min-height:0;overflow:auto;flex:1',
      content: `<div style="font-size:.66rem;margin-bottom:8px">保存后校验并应用；取消不修改。配置含订阅与密钥，请勿公开分享。</div>
        <textarea class="mi-editor-text" spellcheck="false" autocomplete="off" style="box-sizing:border-box;width:100%;height:55vh;min-height:220px;padding:10px;font-family:monospace;white-space:pre;tab-size:2"></textarea>
        <div class="mi-editor-result" role="status" style="white-space:pre-wrap;font-size:.66rem;margin:8px 0"></div>` });
    if (!dialog) throw new Error('无法创建配置编辑窗口');
    const area = dialog.el.querySelector('.mi-editor-text');
    const save = dialog.el.querySelector('#mi_config_editor_confirm');
    const cancel = dialog.el.querySelector('#mi_config_editor_close');
    const result = dialog.el.querySelector('.mi-editor-result');
    // Reuse the UFI window's buttons, but move their bar into the outer
    // header. Only the content scrolls; there is no duplicate Close footer.
    const header = dialog.el.querySelector('.title');
    const toolbar = cancel.parentElement;
    save.classList.add('mi-editor-save'); cancel.classList.add('mi-editor-cancel');
    toolbar.classList.add('mi-editor-actions');
    toolbar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:0;flex-shrink:0';
    toolbar.insertBefore(cancel, save);
    header.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;flex-shrink:0';
    header.appendChild(toolbar);
    dialog.el.style.flexDirection = 'column';
    dialog.el.style.maxHeight = '88vh';
    dialog.el.style.overflow = 'hidden';
    area.value = original;
    const initial = area.value;
    const closeEditor = showManagerDialog(dialog, 'flex');
    cancel.onclick = () => { if (!saving) closeEditor(); };
    save.onclick = async () => {
      if (saving || globalBusy) return;
      if (area.value === initial) { closeEditor(); return; }
      saving = true; save.disabled = cancel.disabled = true; area.readOnly = true; setBusy(true, '正在应用编辑后的配置……');
      try {
        await applyEditedConfig(original, area.value, (message) => { result.textContent = message; });
        closeEditor(); createToast('配置已保存并应用', 'green');
      } catch (error) { result.textContent = error.message || String(error); }
      finally { saving = false; save.disabled = cancel.disabled = false; area.readOnly = false; setBusy(false); }
    };
  };

  const openControllerSettings = async () => {
    const original = await runBackend('config-read', [], 30000);
    const setting = readControllerSetting(original);
    document.getElementById('mi_controller_settings_dialog')?.remove();
    let saving = false;
    const dialog = createModal({
      name: 'mi_controller_settings_dialog', title: '设置控制器 IP 与端口', maxWidth: '620px', showConfirm: false,
      onClose: () => { if (!saving) closeSettings(); return false; },
      content: `<div style="font-size:.66rem;line-height:1.7;margin-bottom:10px">只修改 external-controller，不修改密钥。保存会重启 Mihomo。0.0.0.0 / :: 监听所有地址；127.0.0.1 / ::1 仅限设备本地，远程 MetaCubeXD 将不能直连。</div>
        <label>IP <input class="mi-controller-ip" type="text" autocomplete="off" spellcheck="false" style="width:65%"></label>
        <label>端口 <input class="mi-controller-port" type="number" min="1" max="65535" style="width:100px"></label>
        <div class="mi-controller-result" role="status" style="white-space:pre-wrap;font-size:.66rem;margin:10px 0"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn mi-controller-cancel">取消</button><button class="btn mi-controller-save">保存并应用</button></div>` });
    if (!dialog) throw new Error('无法创建控制器设置窗口');
    const ip = dialog.el.querySelector('.mi-controller-ip');
    const port = dialog.el.querySelector('.mi-controller-port');
    const save = dialog.el.querySelector('.mi-controller-save');
    const cancel = dialog.el.querySelector('.mi-controller-cancel');
    const result = dialog.el.querySelector('.mi-controller-result');
    ip.value = setting.ip; port.value = setting.port;
    const closeSettings = showManagerDialog(dialog);
    cancel.onclick = () => { if (!saving) closeSettings(); };
    save.onclick = async () => {
      if (saving || globalBusy) return;
      try {
        const edited = replaceControllerSetting(original, ip.value, port.value);
        let previousIP = setting.ip;
        try { previousIP = normalizeControllerIP(setting.ip); } catch (_) {}
        if (normalizeControllerIP(ip.value) === previousIP && Number(port.value) === Number(setting.port)) { closeSettings(); return; }
        saving = true; save.disabled = cancel.disabled = true; setBusy(true, '正在修改控制器设置……');
        await applyEditedConfig(original, edited, (message) => { result.textContent = message; });
        closeSettings(); createToast('控制器 IP 与端口已更新', 'green');
      } catch (error) { result.textContent = error.message || String(error); }
      finally { saving = false; save.disabled = cancel.disabled = false; setBusy(false); }
    };
  };

  const openSubscriptionManager = async () => {
    const initial = await runBackend('config-read', [], 30000);
    const location = findMainProviderUrl(initial);
    const pending = location.currentUrl === '__SUBSCRIPTION_URL__';
    document.getElementById('mi_subscription_dialog')?.remove();
    let saving = false;
    const dialog = createModal({
      name: 'mi_subscription_dialog', title: pending ? '首次配置：填写订阅链接' : '更换订阅链接', maxWidth: '720px', showConfirm: false,
      onClose: () => { if (!saving) closeSubscription(); return false; },
      content: `<div style="font-size:.66rem;margin-bottom:8px">只修改 main.url。保存后自动拉取节点；填写原链接也可重新拉取。</div>
        <input class="mi-subscription-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://…" style="box-sizing:border-box;width:100%;padding:8px">
        <div class="mi-subscription-result" role="status" style="white-space:pre-wrap;font-size:.66rem;margin:10px 0"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn mi-subscription-cancel">取消</button><button class="btn mi-subscription-apply">保存并应用</button></div>` });
    if (!dialog) throw new Error('无法创建订阅窗口');
    const input = dialog.el.querySelector('.mi-subscription-input');
    const apply = dialog.el.querySelector('.mi-subscription-apply');
    const cancel = dialog.el.querySelector('.mi-subscription-cancel');
    const result = dialog.el.querySelector('.mi-subscription-result');
    const closeSubscription = showManagerDialog(dialog);
    cancel.onclick = () => { if (!saving) closeSubscription(); };
    apply.onclick = async () => {
      if (saving || globalBusy) return;
      let url = '';
      try {
        url = validateSubscriptionUrl(input.value);
        if (pending && new URL(url).protocol !== 'https:') throw new Error('首次配置只接受 HTTPS 订阅链接');
        saving = true; apply.disabled = cancel.disabled = true; setBusy(true, '正在应用订阅……');
        const current = await runBackend('config-read', [], 30000);
        const oldHash = await configFileSha256(new File([current], configFilename()));
        const edited = replaceMainProviderUrl(current, url);
        const applied = await applyConfigFile(new File([edited], configFilename(), { type: 'text/yaml' }),
          (message) => { result.textContent = message; }, true, true, oldHash);
        // The backend has already confirmed current URL refresh + dual-stack
        // health. Only one additional request is needed for the node count.
        const provider = await readProviderSummary();
        if (provider.count < 1) throw new Error('配置已应用，但 main 没有可用节点；请检查订阅与 Mihomo 日志');
        result.textContent = `订阅已从新链接拉取，main 已加载 ${provider.count} 个节点。上传 ${applied.uploadSeconds} 秒，应用 ${applied.applySeconds} 秒。`;
        createToast('订阅已更新，节点已加载', 'green');
      } catch (error) { result.textContent = redactInstallOutput(error.message || String(error), url); }
      finally { saving = false; apply.disabled = cancel.disabled = false; setBusy(false); }
    };
  };

  const bindAction = (selector, label, handler) => {
    const button = modalElement.querySelector(selector);
    if (!button) return;
    button.onclick = () => withBusy(label, async () => {
      try {
        await handler(button);
      } catch (error) {
        console.error(error);
        createToast(error.message || String(error), 'red', 6000);
      }
    });
  };

  const openInstaller = async () => {
    const upgrading = await hasCompleteInstall();
    const name = 'mi_mihomo_installer_v26_rc23';
    document.getElementById(name)?.remove();
    const created = createModal({
      name,
      title: `Mihomo ${upgrading ? '升级' : '首次安装'} ${PLUGIN_VERSION}`,
      maxWidth: '760px',
      showConfirm: false,
      onClose: () => !installing,
      content: `
        <div style="padding:10px;border-radius:9px;background:rgba(255,180,0,.12);font-size:.68rem;line-height:1.7">
          ${upgrading
            ? `检测到现有完整安装，但后端不是 ${escapeHtml(BACKEND_VERSION)}。升级只替换脚本；现有 <code>config.yaml</code>、内核、provider、UI、日志和 secret 全部原样保留。`
            : `先安装后端与配置模板。随后填写订阅链接并校验配置，成功后启动双栈 TProxy、开启开机自启。`}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="mi-install-github">从 GitHub 安装</button>
          <button class="mi-install-local">使用本地安装包</button>
          <input class="mi-install-files" type="file" multiple accept=".json,.tar,application/json,application/x-tar" style="display:none">
        </div>
        <div style="font-size:.61rem;opacity:.7;line-height:1.65;margin-top:8px">
          本地安装需同时选择 <code>release-manifest.json</code> 和清单指定的 <code>.tar</code> 文件。发布包会先核对大小和 SHA-256，再执行其中的 <code>install.sh</code>。
          已安装设备可用 <code>upgrade.tar</code> 脚本包；全新安装需 <code>arm64.tar</code> 完整包。
        </div>
        <pre class="mi-install-output" style="display:none;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;margin-top:10px;padding:10px;border-radius:8px;background:#111;color:#ddd;font-size:.62rem"></pre>`,
    });
    if (!created) throw new Error('无法创建首次安装窗口');
    const githubButton = created.el.querySelector('.mi-install-github');
    const localButton = created.el.querySelector('.mi-install-local');
    const filesInput = created.el.querySelector('.mi-install-files');
    const output = created.el.querySelector('.mi-install-output');
    let installing = false;

    const setInstalling = (value, message = '') => {
      installing = value;
      githubButton.disabled = value;
      localButton.disabled = value;
      if (message) {
        output.style.display = 'block';
        output.textContent = message;
      }
    };

    const install = async (manifest, packageFile) => {
      if (installing) return;
      if (!confirm(`确定${upgrading ? '升级' : '安装'} Mihomo ${PLUGIN_VERSION} 吗？期间网络可能短暂中断。`)) return;
      setInstalling(true, '正在获取、校验并执行安装包，请勿关闭 UFI-Tools……');
      const started = Date.now();
      try {
        const text = await runReleaseInstaller(manifest, packageFile, (message) => {
          output.textContent = `${message}\n请勿关闭窗口。`;
        });
        const safeText = redactInstallOutput(text);
        output.textContent = `${safeText || '安装命令已完成。'}\n总耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`;
        const installed = await ensureBackend();
        if (!installed.ready) {
          throw new Error(`安装脚本返回成功，但未检测到 RC2.3 后端。\n\n安装输出：\n${safeText || '设备未返回安装输出'}`);
        }
        const waitingForSubscription = installed.state.configured === '0';
        createToast(waitingForSubscription ? '后端已就绪，请填写订阅链接'
          : 'Mihomo RC2.3 升级完成', 'green', 7000);
        closeModal(created.id);
        await openManager(installed.output);
        if (waitingForSubscription) await openSubscriptionManager();
      } catch (error) {
        const message = String(error.message || error);
        const safeMessage = redactInstallOutput(message);
        console.error(safeMessage);
        output.textContent = `${safeMessage}\n已耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`;
        createToast(safeMessage.split('\n')[0], 'red', 8000);
      } finally {
        setInstalling(false);
      }
    };

    githubButton.onclick = async () => {
      if (installing) return;
      try {
        setInstalling(true, '正在读取 GitHub 发布清单……');
        const manifest = selectInstallPackage(await fetchReleaseManifest(), upgrading);
        output.textContent = `设备将下载 ${manifest.package.name}（${formatBytes(manifest.package.bytes)}）并校验 SHA-256……`;
        setInstalling(false);
        await install(manifest, null);
      } catch (error) {
        console.error(error);
        output.style.display = 'block';
        output.textContent = error.message || String(error);
        createToast(error.message || String(error), 'red', 8000);
        setInstalling(false);
      }
    };

    localButton.onclick = () => {
      if (!installing) filesInput.click();
    };
    filesInput.onchange = async () => {
      const files = [...(filesInput.files || [])];
      filesInput.value = '';
      if (!files.length) return;
      try {
        const manifestFile = files.find((file) => file.name.endsWith('.json'));
        if (!manifestFile) throw new Error('请选择 release-manifest.json');
        const fullManifest = await readManifestFile(manifestFile);
        let manifest = selectInstallPackage(fullManifest, upgrading);
        // Existing users may also install with the full package offline.
        if (!files.some((file) => file.name === manifest.package.name) && files.some((file) => file.name === fullManifest.package.name)) manifest = fullManifest;
        const packageFile = files.find((file) => file.name === manifest.package.name);
        if (!packageFile) throw new Error(`请选择清单指定的 ${manifest.package.name}`);
        await install(manifest, packageFile);
      } catch (error) {
        console.error(error);
        output.style.display = 'block';
        output.textContent = error.message || String(error);
        createToast(error.message || String(error), 'red', 8000);
      }
    };

    showModal(created.id);
  };

  const openManager = async (knownStatus = null) => {
    document.getElementById(MODAL_NAME)?.remove();
    const created = createModal({
      name: MODAL_NAME,
      title: `Mihomo 设备管理 ${PLUGIN_VERSION}`,
      maxWidth: '980px',
      showConfirm: false,
      onClose: () => true,
      contentStyle: 'max-height:76vh;overflow:auto',
      content: `
        <div id="mi_busy_tip" style="display:none;padding:8px;margin-bottom:8px;border-radius:8px;background:rgba(255,180,0,.15);font-size:.68rem"></div>
        <div id="mi_status_card" style="padding:10px;border-radius:9px;background:rgba(127,127,127,.12);font-size:.7rem;line-height:1.75">读取状态中……</div>
        <div style="font-size:.63rem;opacity:.72;margin:8px 0 12px">无自动轮询；仅在点击按钮时执行 Root 命令。写操作由后端全局锁串行处理。</div>

        <div class="title" style="font-size:.78rem;margin:8px 0">服务与状态</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="mi_refresh" data-mi-action>刷新状态</button>
          <button id="mi_health" data-mi-action>健康检查</button>
          <button id="mi_stop" data-mi-action>停止</button>
          <button id="mi_restart" data-mi-action>重启</button>
          <button id="mi_boot_toggle" data-mi-action>开机自启</button>
        </div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">配置管理</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="mi_config_download" data-mi-action>下载配置备份</button>
          <button id="mi_config_upload" data-mi-action>上传并应用配置</button>
          <button id="mi_config_edit" data-mi-action>编辑配置</button>
          <button id="mi_subscription" data-mi-action>更换订阅链接</button>
          <input id="mi_config_input" type="file" accept=".yaml,.yml,text/yaml,text/plain" style="display:none">
        </div>
        <div id="mi_config_timing" role="status" style="font-size:.62rem;opacity:.75;line-height:1.6;margin-top:6px"></div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">日志</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="mi_boot_log" data-mi-action>开机日志</button>
          <button id="mi_mihomo_log" data-mi-action>Mihomo 日志</button>
        </div>
        <div style="font-size:.6rem;opacity:.72;margin-top:7px">Mihomo 日志是原始日志，可能包含节点名称或地址；请勿公开分享原始日志。</div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">MetaCubeXD</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="mi_controller_settings" data-mi-action>设置控制器 IP 与端口</button>
        </div>
        <div style="font-size:.6rem;opacity:.66;margin-top:7px">常驻面板位于 UFI-Tools 主页面，和 TTYD 一样可随时展开，无需重复打开设备管理窗口。</div>
        <div class="title" style="font-size:.78rem;margin:14px 0 8px;color:#ff6b6b">危险操作</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="mi_uninstall" data-mi-action style="background:#a52a2a;color:#fff">彻底卸载后端</button>
        </div>
        <div style="font-size:.6rem;opacity:.72;margin-top:7px">永久删除后端、配置、节点缓存、日志与备份；UFI-Tools 中的前端 JS 需手动删除。</div>`,
    });
    if (!created) throw new Error('无法创建设备管理窗口');
    modalElement = created.el;

    bindAction('#mi_refresh', '正在刷新状态……', async () => refreshStatus(true));
    bindAction('#mi_health', '正在执行健康检查……', async () => {
      const text = await runBackend('health', [], 45000);
      showTextModal('Mihomo 健康检查', text, `mi-health-${Date.now()}.txt`);
    });
    bindAction('#mi_stop', '正在停止 Mihomo……', async () => {
      if (!confirm('确定停止 Mihomo 并移除 IPv4/IPv6 TProxy 规则吗？')) return;
      const text = await runBackend('stop', [], 150000);
      await refreshStatus();
      createToast(text.trim() || 'Mihomo 已停止', 'green');
    });
    bindAction('#mi_restart', '正在重启 Mihomo……', async () => {
      if (!confirm('确定重启 Mihomo 吗？网络会短暂中断。')) return;
      const text = await runBackend('restart', [], 210000);
      await refreshStatus();
      createToast(text.trim() || 'Mihomo 已重启', 'green', 5000);
    });
    bindAction('#mi_boot_toggle', '正在修改开机自启……', async () => {
      const enabled = currentState.boot === '1';
      const text = await runBackend(enabled ? 'boot-disable' : 'boot-enable', [], 45000);
      await refreshStatus();
      createToast(text.trim(), 'green');
    });
    bindAction('#mi_config_download', '正在读取配置……', async () => {
      if (!confirm('完整配置可能包含订阅地址、节点信息和控制器密钥。确定下载到当前设备吗？')) return;
      const text = await runBackend('config-read', [], 30000);
      downloadText(configFilename(), text, 'text/yaml;charset=utf-8');
      createToast('配置已下载', 'green');
    });
    bindAction('#mi_subscription', '正在读取订阅配置……', openSubscriptionManager);
    bindAction('#mi_config_edit', '正在读取配置……', openConfigEditor);
    bindAction('#mi_controller_settings', '正在读取控制器设置……', openControllerSettings);
    bindAction('#mi_boot_log', '正在读取开机日志……', async () => {
      const text = await runBackend('boot-log', [], 30000);
      showTextModal('Mihomo 开机日志', text, `mi-boot-${Date.now()}.txt`);
    });
    bindAction('#mi_mihomo_log', '正在读取 Mihomo 日志……', async () => {
      const text = await runBackend('mihomo-log', [], 30000);
      showTextModal('Mihomo 日志', text, `mi-mihomo-log-${Date.now()}.txt`);
    });
    bindAction('#mi_uninstall', '正在彻底卸载 Mihomo……', async () => {
      if (!confirm('确定彻底卸载吗？\n\n这会立即停止 Mihomo，清除 IPv4/IPv6 TProxy 与开机自启，并永久删除所有后端配置、节点缓存、日志和备份。\n\n此操作不可恢复。')) return;
      const text = await runBackend('uninstall', ['PURGE'], 180000);
      try {
        localStorage.removeItem(XD_DOCK_STATE_KEY);
        localStorage.removeItem(XD_CONTROLLER_PORT_KEY);
      } catch (_) {}
      xdDock?.root?.remove();
      xdDock = null;
      closeModal(created.id);
      document.getElementById(BUTTON_ID)?.remove();
      createToast(text.trim() || 'Mihomo 后端已彻底卸载；请再手动删除 UFI-Tools 中的前端 JS。', 'green', 9000);
    });

    const configInput = modalElement.querySelector('#mi_config_input');
    modalElement.querySelector('#mi_config_upload').onclick = () => {
      if (!globalBusy) configInput.click();
    };
    configInput.onchange = async () => {
      const file = configInput.files?.[0];
      const timingLine = modalElement.querySelector('#mi_config_timing');
      configInput.value = '';
      if (!file) return;
      if (!confirm(`确定校验并应用“${file.name}”吗？网络会短暂中断。`)) return;
      if (timingLine) timingLine.textContent = '正在应用配置……';
      await withBusy('正在上传、校验并应用配置……', async () => {
        try {
          const applied = await applyConfigFile(file);
          const mainSynced = parseKeyValue(applied.output).main_refreshed === '1';
          if (timingLine) timingLine.textContent = `配置已应用（${parseKeyValue(applied.output).apply_mode === 'reload' ? '热加载' : '重启'}）；上传 ${applied.uploadSeconds} 秒，应用 ${applied.applySeconds} 秒。`;
          createToast(`配置已应用${mainSynced ? '，main 已同步' : ''}（上传 ${applied.uploadSeconds} 秒，应用 ${applied.applySeconds} 秒）`, 'green', 6000);
        } catch (error) {
          const message = error.message || String(error);
          const reason = message.split(/\r?\n/).reverse().find((line) => line.startsWith('ERROR:')) || message;
          if (timingLine) timingLine.textContent = `本次应用未成功确认：${reason.slice(0, 800)}`;
          createToast(error.message || String(error), 'red', 7000);
        }
      });
    };

    showModal(created.id);
    await refreshStatus(false, knownStatus);
  };

  let actionsContainer = null;
  for (let i = 0; i < 200; i++) {
    actionsContainer = document.querySelector('.actions-buttons');
    if (actionsContainer) break;
    await wait(100);
  }
  if (!actionsContainer) {
    createToast('未找到 UFI-Tools 操作按钮区，插件未加载。', 'red');
    return;
  }

  // Recheck after the DOM wait, so concurrent script injections do not add
  // duplicate buttons. Mount the essential entry before the optional panel.
  const mountedButton = document.getElementById(BUTTON_ID);
  if (mountedButton) {
    mountedButton.textContent = BUTTON_LABEL;
    return;
  }

  const mainButton = document.createElement('button');
  mainButton.id = BUTTON_ID;
  mainButton.type = 'button';
  mainButton.classList.add('btn');
  mainButton.textContent = BUTTON_LABEL;
  mainButton.onclick = async () => {
    try {
      if (!(await rootEnabled())) {
        createToast('请先在 UFI-Tools 中启用高级功能', 'red', 5000);
        return;
      }
      const installed = await ensureBackend();
      if (!installed.ready) {
        await openInstaller();
        return;
      }
      await openManager(installed.output);
    } catch (error) {
      console.error(error);
      createToast(error.message || String(error), 'red', 7000);
    }
  };
  actionsContainer.appendChild(mainButton);
  try {
    mountXdDock();
  } catch (error) {
    document.getElementById(XD_DOCK_ID)?.remove();
    xdDock = null;
    console.error('MiCatty: MetaCubeXD 面板初始化失败', error);
    createToast('MetaCubeXD 面板未加载；MiCatty 管理入口仍可使用。', 'red', 6000);
  }
})();
//</script>
