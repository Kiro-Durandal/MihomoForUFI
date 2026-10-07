// Optional real-browser DOM regression using an isolated blank page and the
// inspected UFI helper file. No real device, personal profile or network.
// Set MI_TEST_PLAYWRIGHT_MODULE, MI_TEST_BROWSER_PATH and MI_TEST_UFI_UTILS.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MI_TEST_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const plugin = fs.readFileSync(path.join(root, 'mihomo-ufi-device-manager-beta2.6-rc2.3.js'), 'utf8');
const ufi = fs.readFileSync(process.env.MI_TEST_UFI_UTILS, 'utf8');
const section = (start, end) => {
  const a = ufi.indexOf(start), b = ufi.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'unsupported UFI helper layout'); return ufi.slice(a, b);
};
const helpers = section('let modalTimer = null', 'const debounce =')
  + '\n' + section('const createModal =', '// 安全DOM');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MI_TEST_BROWSER_PATH || undefined });
  try {
    for (const viewport of [{ width: 1100, height: 820 }, { width: 390, height: 780 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.abort());
      await page.exposeFunction('__hashText', (text) => crypto.createHash('sha256').update(text).digest('hex'));
      await page.setContent(`<!doctype html><html><head><style>
        html {font-size:24px} body {background:#172936;color:#eee;font:16px sans-serif}
        .modal {position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);box-sizing:border-box;padding:16px;background:#213746;border-radius:10px;overflow:auto;max-height:90vh}
        .title {font-size:18px;margin:0 0 8px} button {padding:8px 10px;background:#0a4660;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:15px}
        textarea,input {box-sizing:border-box;background:#122430;color:#eee;border:1px solid #456;padding:6px;font-size:14px}
      </style></head><body><div id="BG_OVERLAY"><div class="container"><div class="functions-container"><div class="actions-buttons"></div></div></div></div></body></html>`);
      await page.addScriptTag({ content: `
        const t = key => key, isPromise = fn => fn?.constructor?.name === 'AsyncFunction';
        window.UFI_DATA = {lan_ipaddr:'192.0.2.1'};
        window.__calls = []; window.__uploaded = ''; window.__toasts = [];
        window.__config = "external-controller: '0.0.0.0:9099'\\nsecret: '123456'\\ndns:\\n  ipv6: true\\nproxy-providers:\\n  main:\\n    url: 'https://example.invalid/old'\\n" + '# harmless editor test line\\n'.repeat(1500);
        const createToast = (...args) => window.__toasts.push(args);
        const checkAdvancedFunc = async () => true;
        const common_headers = {}, KANO_baseURL = '/mock';
        window.confirm = () => true;
        window.fetch = async (url, options) => {
          if (url !== '/mock/upload_img') throw new Error('unexpected network call');
          const file = options.body.get('file'); window.__uploaded = await file.text();
          return {ok:true,status:200,json:async()=>({url:'uploads/'+file.name})};
        };
        const runShellWithRoot = async command => {
          window.__calls.push(command);
          const marker = command.match(/__MI_BACKEND_EXIT_\\d+_\\d+__/);
          let output = 'installed=1\\nconfigured=1\\nbackend=2.6-rc2.3\\ncontroller_port=9099\\ncontroller_address=0.0.0.0:9099\\nrunning=1\\n';
          if (command.includes("'config-read'")) output = window.__config;
          else if (command.includes("'config-apply'")) {
            window.__config = window.__uploaded;
            output += 'config_sha256=' + await window.__hashText(window.__config) + '\\napply_mode=reload\\n';
          } else if (command.includes("'provider-status'")) output = '{"proxies":[{"name":"public-test-node"}]}';
          return {success:true,content:output+(marker ? '\\n'+marker[0]+'=0\\n' : '')};
        };
        ${helpers}
      ` });
      await page.evaluate((code) => eval(code), plugin);
      await page.locator('#mi_mihomo_manager_btn_v26').click();
      await page.locator('#mi_config_edit').click();
      const editor = page.locator('#mi_config_editor');
      await editor.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#mi_mihomo_manager_v26').isVisible(), false, 'parent manager must not expose its Close button behind the editor');
      assert.equal(await editor.locator('button').count(), 2, 'only Cancel/Save, no duplicate Close');
      assert.equal(await editor.locator('.content button').count(), 0, 'actions must be outside the scrolling content');
      assert.equal(await editor.locator('.title .mi-editor-actions button').count(), 2);
      assert.deepEqual(await editor.locator('button').allTextContents(), ['取消', '保存并应用']);
      const save = editor.locator('.mi-editor-save'), cancel = editor.locator('.mi-editor-cancel');
      const saveRect = await save.boundingBox(), areaRect = await editor.locator('textarea').boundingBox();
      assert.ok(saveRect.y >= 0 && saveRect.y + saveRect.height <= areaRect.y, 'toolbar must remain above the editor');
      assert.ok(saveRect.x >= 0 && saveRect.x + saveRect.width <= viewport.width, 'toolbar must fit mobile viewport');
      await editor.locator('textarea').evaluate((area) => { area.scrollTop = area.scrollHeight; });
      assert.deepEqual(await save.boundingBox(), saveRect, 'scrolling YAML must not move actions');
      if (process.env.MI_TEST_SCREENSHOT_DIR) {
        await page.screenshot({path:path.join(process.env.MI_TEST_SCREENSHOT_DIR, `editor-${viewport.width}.png`)});
      }
      const beforeCancel = await page.evaluate(() => window.__config);
      await editor.locator('textarea').fill('# cancelled'); await cancel.click();
      await editor.waitFor({state:'detached'});
      assert.equal(await page.locator('#mi_mihomo_manager_v26').isVisible(), true, 'Cancel restores the manager');
      assert.equal(await page.evaluate(() => window.__config), beforeCancel, 'Cancel does not modify config');
      await page.locator('#mi_config_edit').click();
      await page.locator('#mi_config_editor .mi-editor-text').fill(beforeCancel + '# saved\n');
      await page.locator('#mi_config_editor .mi-editor-save').click();
      await page.locator('#mi_config_editor').waitFor({state:'detached'});
      assert.equal(await page.locator('#mi_mihomo_manager_v26').isVisible(), true, 'Save restores the manager');
      assert.equal(await page.evaluate(() => window.__config), beforeCancel + '# saved\n');
      for (const [entry, dialog, cancelSelector] of [
        ['mi_controller_settings','mi_controller_settings_dialog','.mi-controller-cancel'],
        ['mi_subscription','mi_subscription_dialog','.mi-subscription-cancel'],
      ]) {
        for (let attempt=0; attempt<2; attempt++) {
          await page.locator('#'+entry).click();
          await page.locator('#'+dialog).waitFor({state:'visible'});
          assert.equal(await page.locator('#'+entry).count(), 1, 'opening a dialog must not remove its entry');
          assert.equal(await page.locator('#'+dialog).count(), 1, 'no duplicate dialog IDs');
          await page.locator('#'+dialog+' '+(attempt ? '#'+dialog+'_close' : cancelSelector)).click();
          await page.locator('#'+dialog).waitFor({state:'detached'});
          assert.equal(await page.locator('#'+entry).count(), 1);
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS real UFI modal DOM: desktop/mobile outer toolbar, Cancel/Save, repeated controller/subscription entries');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
