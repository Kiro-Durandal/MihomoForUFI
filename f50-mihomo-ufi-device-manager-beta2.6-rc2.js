//<script>
// F50 Mihomo UFI-Tools Device Manager Beta 2.6-RC2
// Official-style manager button + persistent collapsible MetaCubeXD dock.
// No shell calls on page load, no polling. The dock only loads MetaCubeXD when expanded.
// All write operations are delegated to a fixed-action backend with a global lock.
(async () => {
  'use strict';

  const PLUGIN_VERSION = '2.6-RC2';
  const BACKEND_VERSION = '2.6-rc2';
  const RELEASE_TAG = 'v2.6-rc2';
  const BACKEND = '/data/f50-mihomo/scripts/ufi-backend.sh';
  // The GitHub installer requires this repository to be public and the tag to
  // be immutable. The local-package installer remains available without GitHub.
  const INSTALL_MANIFEST_URL = 'https://raw.githubusercontent.com/Kiro-Durandal/MihomoForUFI/v2.6-rc2/release-manifest.json';
  const MAX_RELEASE_BYTES = 128 * 1024 * 1024;
  const MODAL_NAME = 'f50_mihomo_manager_v26';
  const BUTTON_ID = 'f50_mihomo_manager_btn_v26';
  const UPLOAD_ROOT = '/data/data/com.minikano.f50_sms/files/';
  const XD_DOCK_ID = 'f50_mihomo_xd_dock_v26';
  const XD_DOCK_STATE_KEY = 'f50_mihomo_xd_dock_open';
  const XD_CONTROLLER_PORT_KEY = 'f50_mihomo_controller_port';

  if (document.getElementById(BUTTON_ID)) return;

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
    const lines = output.split(/\r?\n/);
    return lines.includes(`backend=${BACKEND_VERSION}`) && lines.includes('installed=1');
  };

  const hasCompleteInstall = async () => {
    const res = await runShellWithRoot(
      '[ -x /data/f50-mihomo/bin/mihomo ] && [ -f /data/f50-mihomo/config/config.yaml ] && [ -d /data/f50-mihomo/scripts ] && echo YES || echo NO',
      15000,
    );
    return String(res?.content || '').trim().endsWith('YES');
  };

  const validateInstallSubscriptionUrl = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.length > 4096) throw new Error('订阅链接为空或过长');
    let parsed;
    try { parsed = new URL(value); }
    catch (_) { throw new Error('订阅链接格式无效'); }
    if (parsed.protocol !== 'https:') throw new Error('首次安装只接受 HTTPS 订阅链接');
    if (parsed.username || parsed.password) throw new Error('订阅链接不能包含 URL 用户名或密码');
    return value;
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
    const bytes = Number(pkg.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_RELEASE_BYTES) {
      throw new Error('发布包大小字段无效或超过 128 MB');
    }
    return {
      schema: 1,
      version: manifest.version,
      package: {
        url: String(pkg.url),
        sha256: String(pkg.sha256),
        name: String(pkg.name),
        root_dir: String(pkg.root_dir),
        bytes,
      },
    };
  };

  const readManifestFile = async (file) => {
    if (!file || file.size <= 0 || file.size > 64 * 1024) throw new Error('本地发布清单无效');
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (_) { throw new Error('本地发布清单不是有效 JSON'); }
    return validateReleaseManifest(parsed);
  };

  const fetchReleaseManifest = async () => {
    if (!/^https:\/\//.test(INSTALL_MANIFEST_URL) || INSTALL_MANIFEST_URL.includes('__')) {
      throw new Error('RC2 尚未填写 GitHub 发布清单地址；请先完成发布配置，或使用本地完整包');
    }
    const source = new URL(INSTALL_MANIFEST_URL);
    if (source.hostname !== 'raw.githubusercontent.com' || !source.pathname.includes(`/${RELEASE_TAG}/`)) {
      throw new Error(`发布清单必须来自 raw.githubusercontent.com 的不可变标签 ${RELEASE_TAG}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(INSTALL_MANIFEST_URL, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`发布清单下载失败（HTTP ${response.status}）`);
      const manifest = validateReleaseManifest(await response.json());
      const sourceParts = source.pathname.split('/').filter(Boolean);
      const packageUrl = new URL(manifest.package.url);
      const expectedPrefix = `/${sourceParts[0]}/${sourceParts[1]}/releases/download/${RELEASE_TAG}/`;
      if (sourceParts.length < 4 || !packageUrl.pathname.startsWith(expectedPrefix)) {
        throw new Error('发布清单与安装包不属于同一个 GitHub 仓库或标签');
      }
      return manifest;
    } finally {
      clearTimeout(timeout);
    }
  };

  const fetchReleasePackage = async (manifest) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(manifest.package.url, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`发布包下载失败（HTTP ${response.status}）`);
      const advertised = Number(response.headers.get('content-length') || 0);
      if (advertised && advertised !== manifest.package.bytes) throw new Error('发布包大小与清单不一致');
      const blob = await response.blob();
      if (blob.size !== manifest.package.bytes || blob.size > MAX_RELEASE_BYTES) {
        throw new Error('发布包实际大小与清单不一致');
      }
      return new File([blob], manifest.package.name, { type: 'application/x-tar' });
    } finally {
      clearTimeout(timeout);
    }
  };

  const runUploadedInstaller = async (manifest, packageFile, subscriptionUrl = '') => {
    if (packageFile.name !== manifest.package.name) throw new Error('发布包文件名与清单不一致');
    if (packageFile.size !== manifest.package.bytes) throw new Error('发布包大小与清单不一致');

    let packagePath = '';
    let subscriptionPath = '';
    try {
      packagePath = await uploadFileToUfi(packageFile);
      if (subscriptionUrl) {
        const subscriptionFile = new File([`${subscriptionUrl}\n`], 'f50-subscription.txt', {
          type: 'text/plain;charset=utf-8',
        });
        subscriptionPath = await uploadFileToUfi(subscriptionFile);
      }
      const installArgument = subscriptionPath
        ? ` --subscription-file ${shellQuote(subscriptionPath)}`
        : '';
      const command = String.raw`
PACKAGE=${shellQuote(packagePath)}
SUBSCRIPTION_FILE=${shellQuote(subscriptionPath)}
EXPECTED=${shellQuote(manifest.package.sha256)}
ROOT_DIR=${shellQuote(manifest.package.root_dir)}
STAGE=/data/local/tmp/f50-mihomo-rc2-install-$$
cleanup() { rm -rf "$STAGE"; rm -f "$PACKAGE"; [ -z "$SUBSCRIPTION_FILE" ] || rm -f "$SUBSCRIPTION_FILE"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
sh "$STAGE/$ROOT_DIR/install.sh"${installArgument}
`;
      const result = await runShellWithRoot(command, 600000);
      if (!result?.success) throw new Error(String(result?.content || 'RC2 安装失败').trim());
      return String(result.content || '');
    } finally {
      const uploaded = [packagePath, subscriptionPath].filter(Boolean);
      if (uploaded.length) {
        const cleanupCommand = `rm -f ${uploaded.map((item) => shellQuote(item)).join(' ')}`;
        try { await runShellWithRoot(cleanupCommand, 15000); } catch (_) { /* best effort */ }
      }
    }
  };

  const ACTIONS = new Set([
    'status', 'health', 'start', 'stop', 'restart',
    'boot-enable', 'boot-disable',
    'config-test', 'config-read', 'config-apply',
    'backup-create', 'backup-list', 'backup-read',
    'backup-delete', 'backup-restore',
    'boot-log', 'mihomo-log', 'diagnostic',
    'api-version', 'ui-upgrade', 'uninstall',
  ]);

  const runBackend = async (action, args = [], timeout = 120000) => {
    if (!ACTIONS.has(action)) throw new Error('前端请求了不受支持的后端动作');
    const safeArgs = args.map((item) => shellQuote(String(item))).join(' ');
    const command = `sh ${shellQuote(BACKEND)} ${shellQuote(action)}${safeArgs ? ` ${safeArgs}` : ''}`;
    const res = await runShellWithRoot(command, timeout);
    if (!res?.success) {
      throw new Error(String(res?.content || '后端命令执行失败').trim());
    }
    return String(res.content || '');
  };

  const getLanIp = () =>
    (window.UFI_DATA && window.UFI_DATA.lan_ipaddr) || '192.168.0.1';

  let controllerPort = null;
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
    const changed = controllerPort !== port;
    controllerPort = port;
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
    `http://${formatUrlHost(getLanIp())}:${controllerPort || 9090}/ui/${cacheBust ? `?t=${Date.now()}` : ''}`;

  const openXdInNewTab = async () => {
    await refreshControllerPort();
    if (typeof openLink === 'function') {
      openLink(getXdUrl(true));
      return;
    }
    const a = document.createElement('a');
    a.href = getXdUrl(true);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  };

  const uploadFileToUfi = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
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

  const redactDiagnostic = (text) =>
    String(text || '')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '<url-redacted>')
      .replace(/\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?:%[a-z0-9._-]+)?(?:\/\d{1,3})?/gi, (match) => {
        const colonCount = (match.match(/:/g) || []).length;
        return match.includes('::') || colonCount >= 3 ? '<ipv6-redacted>' : match;
      })
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<ip-redacted>')
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        '<uuid-redacted>',
      )
      .replace(
        /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?\b/gi,
        '<host-redacted>',
      )
      .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer <redacted>')
      .replace(
        /(^|\n)(\s*)(secret|password|passwd|token|private-key|uuid|authorization|server|servername|sni)\s*[:=]\s*.*(?=\n|$)/gi,
        '$1$2$3: <redacted>',
      );

  const showTextModal = (title, text, filename) => {
    const name = `f50_text_${Date.now()}`;
    document.getElementById(name)?.remove();
    const created = createModal({
      name,
      title,
      maxWidth: '900px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <pre class="f50-text-output" style="box-sizing:border-box;white-space:pre-wrap;
          word-break:break-word;max-height:62vh;overflow:auto;margin:0;padding:12px;
          border-radius:8px;background:#000c;color:#8cff8c;font-size:.66rem;
          line-height:1.5"></pre>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="f50-text-download">下载文本</button>
        </div>`,
    });
    if (!created) throw new Error('无法创建文本窗口');
    created.el.querySelector('.f50-text-output').textContent = text || '（无内容）';
    created.el.querySelector('.f50-text-download').onclick = () =>
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
    const output = location.lines.join('\n');
    return location.trailingNewline ? `${output}\n` : output;
  };

  const maskSubscriptionUrl = (value) =>
    String(value || '').trim() ? '已配置（地址已完全隐藏）' : '未配置';

  let xdDock = null;

  const updateXdDockVisual = (open) => {
    if (!xdDock) return;
    xdDock.open = Boolean(open);
    xdDock.body.style.display = xdDock.open ? 'block' : 'none';
    xdDock.switchButton.setAttribute('aria-checked', xdDock.open ? 'true' : 'false');
    xdDock.switchButton.title = xdDock.open ? '收起 MetaCubeXD' : '展开 MetaCubeXD';
    xdDock.switchButton.style.background = xdDock.open ? '#1487b8' : 'rgba(127,127,127,.35)';
    xdDock.knob.style.transform = xdDock.open ? 'translateX(20px)' : 'translateX(0)';
    xdDock.arrow.textContent = xdDock.open ? '▼' : '▶';
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
    if (document.getElementById(XD_DOCK_ID)) return;
    const anchor = document.querySelector('.functions-container') ||
      document.querySelector('.actions-buttons')?.parentElement;
    if (!anchor) return;

    const root = document.createElement('div');
    root.id = XD_DOCK_ID;
    root.style.cssText = 'width:100%;margin-top:10px;border-radius:10px;overflow:hidden;background:rgba(127,127,127,.08)';
    root.innerHTML = `
      <div class="f50-xd-dock-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;user-select:none">
        <div class="f50-xd-dock-title" style="display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1">
          <span class="f50-xd-dock-arrow" style="opacity:.72">▶</span>
          <strong style="font-size:.74rem">MetaCubeXD</strong>
          <span style="font-size:.58rem;opacity:.58;white-space:nowrap">常驻面板</span>
        </div>
        <div style="display:flex;align-items:center;gap:7px;flex:0 0 auto">
          <button class="f50-xd-dock-refresh" title="刷新 MetaCubeXD" style="min-width:34px;padding:4px 8px">↻</button>
          <button class="f50-xd-dock-newtab" title="在新标签页打开" style="min-width:34px;padding:4px 8px">↗</button>
          <button class="f50-xd-dock-switch" type="button" role="switch" aria-checked="false"
            style="box-sizing:border-box;width:44px;height:24px;padding:2px;border:0;border-radius:999px;background:rgba(127,127,127,.35);cursor:pointer;transition:background .18s ease">
            <span class="f50-xd-dock-knob" style="display:block;width:20px;height:20px;border-radius:50%;background:#e9f3f7;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:translateX(0);transition:transform .18s ease"></span>
          </button>
        </div>
      </div>
      <div class="f50-xd-dock-body" style="display:none;padding:0 8px 8px">
        <div style="font-size:.58rem;opacity:.62;margin:0 2px 7px">首次展开后保持加载；收起不会关闭 MetaCubeXD，也不会调用 UFI 后端。</div>
        <div class="f50-xd-dock-frame-wrap" style="position:relative;width:100%;height:72vh;min-height:460px;max-height:88vh;resize:vertical;overflow:hidden;border-radius:8px;background:#111">
          <iframe class="f50-xd-dock-frame" title="MetaCubeXD" src="about:blank" loading="lazy"
            referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write" allowfullscreen
            style="display:block;width:100%;height:100%;border:0;background:#111"></iframe>
        </div>
      </div>`;

    anchor.insertAdjacentElement('afterend', root);
    xdDock = {
      root,
      body: root.querySelector('.f50-xd-dock-body'),
      frame: root.querySelector('.f50-xd-dock-frame'),
      switchButton: root.querySelector('.f50-xd-dock-switch'),
      knob: root.querySelector('.f50-xd-dock-knob'),
      arrow: root.querySelector('.f50-xd-dock-arrow'),
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
    root.querySelector('.f50-xd-dock-title').onclick = () => { void toggle(); };
    xdDock.switchButton.onclick = () => { void toggle(); };
    root.querySelector('.f50-xd-dock-refresh').onclick = () => {
      refreshXdDock().catch((error) => createToast(error.message || String(error), 'red', 6000));
    };
    root.querySelector('.f50-xd-dock-newtab').onclick = () => {
      openXdInNewTab().catch((error) => createToast(error.message || String(error), 'red', 6000));
    };

    let remembered = false;
    try { remembered = localStorage.getItem(XD_DOCK_STATE_KEY) === '1'; } catch (_) {}
    setXdDockOpen(remembered && Boolean(controllerPort), false, false);
  };

  let globalBusy = false;
  let currentState = {};
  let modalElement = null;

  const setBusy = (busy, label = '') => {
    globalBusy = busy;
    if (!modalElement) return;
    modalElement.querySelectorAll('[data-f50-action]').forEach((button) => {
      button.disabled = busy;
    });
    const tip = modalElement.querySelector('#f50_busy_tip');
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

  const refreshStatus = async (toast = false) => {
    const output = await runBackend('status', [], 25000);
    currentState = parseKeyValue(output);
    updateControllerPortFromStatus(currentState);
    const el = modalElement?.querySelector('#f50_status_card');
    if (!el) return;

    const running = currentState.running === '1';
    const installed = currentState.installed === '1';
    const boot = currentState.boot === '1';
    const ui = currentState.ui === '1';
    const ipv4 = currentState.ipv4 === '1';
    const ipv6 = currentState.ipv6 === '1';
    el.innerHTML = `
      <div><b>安装：</b>${installed ? '已安装' : '未检测到'}</div>
      <div><b>内核：</b>${running ? `🟢 运行中（PID ${escapeHtml(currentState.pid || '?')}）` : '🔴 已停止'}</div>
      <div><b>IPv4 代理：</b>${ipv4 ? '🟢 规则完整' : '🔴 未就绪'}</div>
      <div><b>IPv6 代理：</b>${ipv6 ? '🟢 规则完整' : '🔴 未就绪'}</div>
      <div><b>版本：</b>${escapeHtml(currentState.version || '未知')}</div>
      <div><b>后端：</b>${escapeHtml(currentState.backend || '未知')}</div>
      <div><b>控制器端口：</b>${escapeHtml(currentState.controller_port || '未知')}</div>
      <div><b>开机自启：</b>${boot ? '已开启' : '未开启'}</div>
      <div><b>MetaCubeXD：</b>${ui ? '已安装' : '未检测到'}</div>
      <div><b>日志占用：</b>Mihomo ${formatBytes(currentState.log_bytes)}；开机 ${formatBytes(currentState.boot_log_bytes)}</div>`;

    const bootBtn = modalElement.querySelector('#f50_boot_toggle');
    if (bootBtn) {
      bootBtn.textContent = boot ? '关闭开机自启' : '开启开机自启';
      bootBtn.style.background = boot ? 'var(--dark-btn-color-active)' : '';
    }
    if (toast) createToast('状态已刷新', 'green');
  };

  const applyConfigFile = async (file) => {
    if (!file) return;
    if (file.size <= 0) throw new Error('配置文件为空');
    if (file.size > 3 * 1024 * 1024) throw new Error('配置文件不能超过 3 MB');
    const uploadedPath = await uploadFileToUfi(file);
    const output = await runBackend('config-apply', [uploadedPath], 240000);
    await refreshStatus();
    return output;
  };

  const openBackupManager = async () => {
    const name = `f50_backups_${Date.now()}`;
    const created = createModal({
      name,
      title: '配置回滚点管理',
      maxWidth: '720px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <div style="font-size:.68rem;opacity:.8;margin-bottom:8px">恢复配置会短暂中断网络；恢复前会自动再创建一个安全回滚点。下载的回滚点包含完整订阅地址与控制器密钥，请勿对外分享。</div>
        <select class="f50-backup-list" size="10" style="box-sizing:border-box;width:100%;min-height:260px;padding:8px;border-radius:8px;background:var(--dark-btn-color);color:inherit"></select>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="f50-backup-refresh">刷新</button>
          <button class="f50-backup-download">下载</button>
          <button class="f50-backup-restore">恢复</button>
          <button class="f50-backup-delete">删除</button>
        </div>`,
    });
    if (!created) throw new Error('无法创建回滚点窗口');
    const select = created.el.querySelector('.f50-backup-list');

    const refresh = async () => {
      const list = (await runBackend('backup-list', [], 25000))
        .split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
      select.innerHTML = '';
      for (const item of list) {
        const option = document.createElement('option');
        option.value = item;
        option.textContent = item;
        select.appendChild(option);
      }
      if (!list.length) {
        const option = document.createElement('option');
        option.textContent = '暂无回滚点';
        option.disabled = true;
        select.appendChild(option);
      }
    };

    const selected = () => {
      const value = select.value;
      if (!/^config-[0-9]+\.yaml$/.test(value)) throw new Error('请先选择回滚点');
      return value;
    };

    created.el.querySelector('.f50-backup-refresh').onclick = async () => {
      try { await refresh(); createToast('列表已刷新', 'green'); }
      catch (error) { createToast(error.message || String(error), 'red'); }
    };
    created.el.querySelector('.f50-backup-download').onclick = async () => {
      try {
        const item = selected();
        if (!confirm('该配置回滚点可能包含完整订阅地址、节点信息和控制器密钥。确定下载到当前设备吗？')) return;
        const text = await runBackend('backup-read', [item], 30000);
        downloadText(item, text, 'text/yaml;charset=utf-8');
      } catch (error) { createToast(error.message || String(error), 'red'); }
    };
    created.el.querySelector('.f50-backup-delete').onclick = async () => {
      try {
        const item = selected();
        if (!confirm(`确定删除 ${item} 吗？`)) return;
        await runBackend('backup-delete', [item], 30000);
        await refresh();
        createToast('回滚点已删除', 'green');
      } catch (error) { createToast(error.message || String(error), 'red'); }
    };
    created.el.querySelector('.f50-backup-restore').onclick = async () => {
      try {
        const item = selected();
        if (!confirm(`确定恢复 ${item} 吗？网络会短暂中断。`)) return;
        const output = await runBackend('backup-restore', [item], 240000);
        await refreshStatus();
        createToast(output.trim() || '回滚点已恢复', 'green', 5000);
      } catch (error) { createToast(error.message || String(error), 'red', 6000); }
    };

    showModal(created.id);
    await refresh();
  };

  const openSubscriptionManager = async () => {
    const configText = await runBackend('config-read', [], 30000);
    const location = findMainProviderUrl(configText);
    const name = `f50_subscription_${Date.now()}`;
    const created = createModal({
      name,
      title: '更换 main 订阅链接',
      maxWidth: '720px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <div style="font-size:.68rem;line-height:1.7;margin-bottom:8px">
          只修改 <code>proxy-providers.main.url</code>，不会修改嵌套的 <code>health-check.url</code>。<br>
          当前：<b>${escapeHtml(maskSubscriptionUrl(location.currentUrl))}</b>
        </div>
        <input class="f50-subscription-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://…" style="box-sizing:border-box;width:100%;padding:10px;border-radius:8px">
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="f50-subscription-apply">校验并应用</button>
        </div>`,
    });
    if (!created) throw new Error('无法创建订阅窗口');
    const input = created.el.querySelector('.f50-subscription-input');
    const apply = created.el.querySelector('.f50-subscription-apply');
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const url = validateSubscriptionUrl(input.value);
        if (!confirm('确定替换订阅链接并重启 Mihomo 吗？')) return;
        // Re-read after confirmation so a concurrent edit is never overwritten
        // by the snapshot captured when this dialog was opened.
        const latestConfigText = await runBackend('config-read', [], 30000);
        const updated = replaceMainProviderUrl(latestConfigText, url);
        const file = new File([updated], 'config-subscription-update.yaml', { type: 'text/yaml' });
        const output = await applyConfigFile(file);
        createToast(output.trim() || '订阅链接已更新', 'green', 6000);
        closeModal(created.id);
      } catch (error) {
        createToast(error.message || String(error), 'red', 6000);
      } finally {
        apply.disabled = false;
      }
    };
    showModal(created.id);
    input.focus();
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
    const name = 'f50_mihomo_installer_v26_rc2';
    document.getElementById(name)?.remove();
    const created = createModal({
      name,
      title: `F50 Mihomo ${upgrading ? '升级' : '首次安装'} ${PLUGIN_VERSION}`,
      maxWidth: '760px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <div style="padding:10px;border-radius:9px;background:rgba(255,180,0,.12);font-size:.68rem;line-height:1.7">
          ${upgrading
            ? `检测到现有完整安装，但后端不是 ${escapeHtml(BACKEND_VERSION)}。升级只替换 RC2 脚本；现有 <code>config.yaml</code>、内核、provider、UI、日志和 secret 全部原样保留。`
            : `未检测到完整安装。安装会根据脱敏模板生成配置，写入 <code>/data/f50-mihomo</code>、启动双栈 TProxy，并登记开机自启。`}
        </div>
        <label style="display:${upgrading ? 'none' : 'block'};margin-top:12px;font-size:.68rem">订阅链接（仅写入设备配置，不写入日志或发布包）</label>
        <input class="f50-install-subscription" type="url" autocomplete="off" spellcheck="false" placeholder="https://…"
          style="display:${upgrading ? 'none' : 'block'};box-sizing:border-box;width:100%;margin-top:5px;padding:10px;border-radius:8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="f50-install-github">从 GitHub 安装</button>
          <button class="f50-install-local">使用本地完整包</button>
          <input class="f50-install-files" type="file" multiple accept=".json,.tar,application/json,application/x-tar" style="display:none">
        </div>
        <div style="font-size:.61rem;opacity:.7;line-height:1.65;margin-top:8px">
          本地安装需同时选择 <code>release-manifest.json</code> 和清单指定的 <code>.tar</code> 文件。发布包会先核对大小和 SHA-256，再执行其中的 <code>install.sh</code>。
        </div>
        <pre class="f50-install-output" style="display:none;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;margin-top:10px;padding:10px;border-radius:8px;background:#111;color:#ddd;font-size:.62rem"></pre>`,
    });
    if (!created) throw new Error('无法创建首次安装窗口');
    const subscription = created.el.querySelector('.f50-install-subscription');
    const githubButton = created.el.querySelector('.f50-install-github');
    const localButton = created.el.querySelector('.f50-install-local');
    const filesInput = created.el.querySelector('.f50-install-files');
    const output = created.el.querySelector('.f50-install-output');
    let installing = false;

    const setInstalling = (value, message = '') => {
      installing = value;
      githubButton.disabled = value;
      localButton.disabled = value;
      subscription.disabled = value;
      if (message) {
        output.style.display = 'block';
        output.textContent = message;
      }
    };

    const install = async (manifest, packageFile) => {
      if (installing) return;
      const url = upgrading ? '' : validateInstallSubscriptionUrl(subscription.value);
      if (!confirm(`确定${upgrading ? '升级' : '安装'} F50 Mihomo ${PLUGIN_VERSION} 吗？期间网络可能短暂中断。`)) return;
      setInstalling(true, '正在上传、校验并执行安装包，请勿关闭 UFI-Tools……');
      try {
        const text = await runUploadedInstaller(manifest, packageFile, url);
        output.textContent = text || '安装命令已完成。';
        if (!(await ensureBackend())) throw new Error('安装命令结束，但未检测到 RC2 后端');
        createToast('F50 Mihomo RC2 安装完成', 'green', 7000);
        closeModal(created.id);
        await openManager();
      } catch (error) {
        console.error(error);
        output.textContent = error.message || String(error);
        createToast(error.message || String(error), 'red', 8000);
      } finally {
        setInstalling(false);
      }
    };

    githubButton.onclick = async () => {
      if (installing) return;
      try {
        if (!upgrading) validateInstallSubscriptionUrl(subscription.value);
        setInstalling(true, '正在读取 GitHub 发布清单……');
        const manifest = await fetchReleaseManifest();
        output.textContent = `正在下载 ${manifest.package.name}（${formatBytes(manifest.package.bytes)}）……`;
        const packageFile = await fetchReleasePackage(manifest);
        setInstalling(false);
        await install(manifest, packageFile);
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
        const manifest = await readManifestFile(manifestFile);
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
    if (!upgrading) subscription.focus();
  };

  const openManager = async () => {
    document.getElementById(MODAL_NAME)?.remove();
    const created = createModal({
      name: MODAL_NAME,
      title: `F50 Mihomo 设备管理 ${PLUGIN_VERSION}`,
      maxWidth: '980px',
      showConfirm: false,
      onClose: () => true,
      contentStyle: 'max-height:76vh;overflow:auto',
      content: `
        <div id="f50_busy_tip" style="display:none;padding:8px;margin-bottom:8px;border-radius:8px;background:rgba(255,180,0,.15);font-size:.68rem"></div>
        <div id="f50_status_card" style="padding:10px;border-radius:9px;background:rgba(127,127,127,.12);font-size:.7rem;line-height:1.75">读取状态中……</div>
        <div style="font-size:.63rem;opacity:.72;margin:8px 0 12px">无自动轮询；仅在点击按钮时执行 Root 命令。写操作由后端全局锁串行处理。</div>

        <div class="title" style="font-size:.78rem;margin:8px 0">服务与状态</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="f50_refresh" data-f50-action>刷新状态</button>
          <button id="f50_health" data-f50-action>健康检查</button>
          <button id="f50_start" data-f50-action>启动</button>
          <button id="f50_stop" data-f50-action>停止</button>
          <button id="f50_restart" data-f50-action>重启</button>
          <button id="f50_boot_toggle" data-f50-action>开机自启</button>
        </div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">配置与回滚</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="f50_config_test" data-f50-action>校验当前配置</button>
          <button id="f50_config_download" data-f50-action>下载配置备份</button>
          <button id="f50_config_upload" data-f50-action>上传并应用配置</button>
          <button id="f50_backup_create" data-f50-action>创建回滚点</button>
          <button id="f50_backup_manage" data-f50-action>管理回滚点</button>
          <button id="f50_subscription" data-f50-action>更换订阅链接</button>
          <input id="f50_config_input" type="file" accept=".yaml,.yml,text/yaml,text/plain" style="display:none">
        </div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">日志与诊断</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="f50_boot_log" data-f50-action>开机日志</button>
          <button id="f50_mihomo_log" data-f50-action>Mihomo 日志</button>
          <button id="f50_diagnostic" data-f50-action>脱敏诊断报告</button>
        </div>
        <div style="font-size:.6rem;opacity:.72;margin-top:7px">Mihomo 日志是原始日志，可能包含节点名称或地址；需要对外分享时请使用“脱敏诊断报告”。</div>

        <div class="title" style="font-size:.78rem;margin:14px 0 8px">MetaCubeXD</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="f50_xd_open" data-f50-action>新标签打开</button>
          <button id="f50_xd_toggle" data-f50-action>展开常驻面板</button>
          <button id="f50_xd_upgrade" data-f50-action>更新 MetaCubeXD</button>
        </div>
        <div style="font-size:.6rem;opacity:.66;margin-top:7px">常驻面板位于 UFI-Tools 主页面，和 TTYD 一样可随时展开，无需重复打开设备管理窗口。</div>
        <div class="title" style="font-size:.78rem;margin:14px 0 8px;color:#ff6b6b">危险操作</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="f50_uninstall" data-f50-action style="background:#a52a2a;color:#fff">彻底卸载后端</button>
        </div>
        <div style="font-size:.6rem;opacity:.72;margin-top:7px">永久删除后端、配置、节点缓存、日志与备份；UFI-Tools 中的前端 JS 需手动删除。</div>`,
    });
    if (!created) throw new Error('无法创建设备管理窗口');
    modalElement = created.el;

    bindAction('#f50_refresh', '正在刷新状态……', async () => refreshStatus(true));
    bindAction('#f50_health', '正在执行健康检查……', async () => {
      const text = await runBackend('health', [], 45000);
      showTextModal('F50 Mihomo 健康检查', text, `f50-health-${Date.now()}.txt`);
    });
    bindAction('#f50_start', '正在启动 Mihomo……', async () => {
      const text = await runBackend('start', [], 180000);
      await refreshStatus();
      createToast(text.trim() || 'Mihomo 已启动', 'green', 5000);
    });
    bindAction('#f50_stop', '正在停止 Mihomo……', async () => {
      if (!confirm('确定停止 Mihomo 并移除 IPv4/IPv6 TProxy 规则吗？')) return;
      const text = await runBackend('stop', [], 150000);
      await refreshStatus();
      createToast(text.trim() || 'Mihomo 已停止', 'green');
    });
    bindAction('#f50_restart', '正在重启 Mihomo……', async () => {
      if (!confirm('确定重启 Mihomo 吗？网络会短暂中断。')) return;
      const text = await runBackend('restart', [], 210000);
      await refreshStatus();
      createToast(text.trim() || 'Mihomo 已重启', 'green', 5000);
    });
    bindAction('#f50_boot_toggle', '正在修改开机自启……', async () => {
      const enabled = currentState.boot === '1';
      const text = await runBackend(enabled ? 'boot-disable' : 'boot-enable', [], 45000);
      await refreshStatus();
      createToast(text.trim(), 'green');
    });
    bindAction('#f50_config_test', '正在校验配置……', async () => {
      const text = await runBackend('config-test', [], 180000);
      showTextModal('配置校验结果', text || 'configuration test successful', `f50-config-test-${Date.now()}.txt`);
    });
    bindAction('#f50_config_download', '正在读取配置……', async () => {
      if (!confirm('完整配置可能包含订阅地址、节点信息和控制器密钥。确定下载到当前设备吗？')) return;
      const text = await runBackend('config-read', [], 30000);
      downloadText(`f50-config-${Date.now()}.yaml`, text, 'text/yaml;charset=utf-8');
      createToast('配置已下载', 'green');
    });
    bindAction('#f50_backup_create', '正在创建回滚点……', async () => {
      const text = await runBackend('backup-create', [], 30000);
      createToast(text.trim() || '回滚点已创建', 'green');
    });
    bindAction('#f50_backup_manage', '正在读取回滚点……', openBackupManager);
    bindAction('#f50_subscription', '正在读取订阅配置……', openSubscriptionManager);
    bindAction('#f50_boot_log', '正在读取开机日志……', async () => {
      const text = await runBackend('boot-log', [], 30000);
      showTextModal('Mihomo 开机日志', text, `f50-boot-${Date.now()}.txt`);
    });
    bindAction('#f50_mihomo_log', '正在读取 Mihomo 日志……', async () => {
      const text = await runBackend('mihomo-log', [], 30000);
      showTextModal('Mihomo 日志', text, `f50-mihomo-log-${Date.now()}.txt`);
    });
    bindAction('#f50_diagnostic', '正在生成脱敏诊断报告……', async () => {
      const raw = await runBackend('diagnostic', [], 60000);
      const text = redactDiagnostic(raw);
      showTextModal('F50 Mihomo 脱敏诊断报告', text, `f50-diagnostic-${Date.now()}.txt`);
    });
    bindAction('#f50_xd_open', '正在打开 MetaCubeXD……', async () => openXdInNewTab());
    bindAction('#f50_xd_toggle', '正在展开常驻面板……', async () => {
      setXdDockOpen(true, true, true);
      closeModal(created.id);
    });
    bindAction('#f50_xd_upgrade', '正在更新 MetaCubeXD……', async () => {
      if (!confirm('确定根据 external-ui-url 更新 MetaCubeXD 吗？')) return;
      const text = await runBackend('ui-upgrade', [], 210000);
      createToast(text.trim() || '更新请求已完成', 'green', 5000);
    });
    bindAction('#f50_uninstall', '正在彻底卸载 F50 Mihomo……', async () => {
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
      createToast(text.trim() || 'F50 Mihomo 后端已彻底卸载；请再手动删除 UFI-Tools 中的前端 JS。', 'green', 9000);
    });

    const configInput = modalElement.querySelector('#f50_config_input');
    modalElement.querySelector('#f50_config_upload').onclick = () => {
      if (!globalBusy) configInput.click();
    };
    configInput.onchange = async () => {
      const file = configInput.files?.[0];
      configInput.value = '';
      if (!file) return;
      if (!confirm(`确定校验并应用“${file.name}”吗？网络会短暂中断。`)) return;
      await withBusy('正在上传、校验并应用配置……', async () => {
        try {
          const text = await applyConfigFile(file);
          createToast(text.trim() || '配置已应用', 'green', 6000);
        } catch (error) {
          createToast(error.message || String(error), 'red', 7000);
        }
      });
    };

    showModal(created.id);
    await refreshStatus();
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

  mountXdDock();

  const mainButton = document.createElement('button');
  mainButton.id = BUTTON_ID;
  mainButton.textContent = 'F50 Mihomo';
  mainButton.onclick = async () => {
    try {
      if (!(await rootEnabled())) {
        createToast('请先在 UFI-Tools 中启用高级功能', 'red', 5000);
        return;
      }
      if (!(await ensureBackend())) {
        await openInstaller();
        return;
      }
      await openManager();
    } catch (error) {
      console.error(error);
      createToast(error.message || String(error), 'red', 7000);
    }
  };
  actionsContainer.appendChild(mainButton);
})();
//</script>
