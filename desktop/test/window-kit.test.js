/**
 * 文件：desktop/test/window-kit.test.js
 * 职责：子窗口公共请求层（window-kit）的用例——重点是 requestJson 的失败分支。
 *
 * 为什么需要：它是 connection.js、storage-form.js、session-page.js 等所有子窗口的公共底座，
 * 此前覆盖率只有 37.8%，意味着「超时、非 JSON、4xx/5xx」这些出错路径一条都没被断言过。
 * 出错时的表现（提示文案、error.status、是否把 HTML 当 JSON）全靠猜。
 *
 * 加载方式：window-kit.js 尾部是 `})(window)`，直接 require 会抛 ReferenceError，
 * 所以先给 global.window 挂一个假对象；它的 bridge 读的是 IIFE 入参上的 windowBridge，
 * 因此桥接能力要挂在 window.windowBridge 上，而不是 global 上。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'src', 'renderer', 'lib', 'window-kit.js');

/** 重新加载模块：config/token 是模块级缓存，不重新加载会让用例互相串味。 */
function loadKit({ bridge = {}, fetch: fetchImpl } = {}) {
  delete require.cache[require.resolve(MODULE_PATH)];
  global.window = { windowBridge: bridge };
  global.document = { querySelector: () => null };
  global.fetch = fetchImpl || (() => Promise.reject(new Error('fetch 未被用例提供')));
  require(MODULE_PATH);
  return global.window.SXW_WIN;
}

/** 造一个 fetch 响应；json 与 text 都给上，具体用例只用到其中一个。 */
function response({ status = 200, body = '', ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

function captureFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return reply;
  };
  return { calls, impl };
}

test('requestJson：拼出 apiBase + /api/v1，并去掉多余的尾斜杠', async () => {
  const { calls, impl } = captureFetch(response({ body: '{"code":0}' }));
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://127.0.0.1:8010//' }), readAuth: async () => null },
    fetch: impl
  });

  const body = await kit.requestJson('/conversations');

  assert.strictEqual(calls[0].url, 'http://127.0.0.1:8010/api/v1/conversations');
  assert.deepStrictEqual(body, { code: 0 });
});

test('requestJson：带令牌时加 Authorization，没令牌时不加', async () => {
  const withToken = captureFetch(response({ body: '{}' }));
  const kit1 = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => ({ token: 'tok-123' }) },
    fetch: withToken.impl
  });
  await kit1.requestJson('/x');
  assert.strictEqual(withToken.calls[0].init.headers.Authorization, 'Bearer tok-123');

  const without = captureFetch(response({ body: '{}' }));
  const kit2 = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => ({ token: '' }) },
    fetch: without.impl
  });
  await kit2.requestJson('/x');
  assert.strictEqual(without.calls[0].init.headers.Authorization, undefined);
});

test('requestJson：传 json 时设置 Content-Type 并序列化 body', async () => {
  const { calls, impl } = captureFetch(response({ body: '{}' }));
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: impl
  });

  await kit.requestJson('/x', { method: 'POST', json: { title: '新标题' } });

  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers['Content-Type'], 'application/json');
  assert.strictEqual(calls[0].init.body, '{"title":"新标题"}');
});

test('requestJson：不传 json 时不带 body 与 Content-Type', async () => {
  const { calls, impl } = captureFetch(response({ body: '{}' }));
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: impl
  });

  await kit.requestJson('/x');

  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(calls[0].init.body, undefined);
  assert.strictEqual(calls[0].init.headers['Content-Type'], undefined);
});

test('requestJson：空白响应体返回 null（DELETE 常见）', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: async () => response({ body: '   \n ' })
  });

  assert.strictEqual(await kit.requestJson('/x'), null);
});

test('requestJson：非 JSON 响应返回 null（不把 HTML 错误页当数据）', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: async () => response({ body: '<html>502 Bad Gateway</html>' })
  });

  assert.strictEqual(await kit.requestJson('/x'), null);
});

test('requestJson：4xx 时用 detail[0].msg 作提示，并去掉 Value error 前缀', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: async () => response({ status: 422, body: '{"detail":[{"msg":"Value error, 标题不能为空"}]}' })
  });

  await assert.rejects(
    () => kit.requestJson('/x'),
    (error) => {
      assert.strictEqual(error.status, 422);
      assert.strictEqual(error.message, '标题不能为空');
      return true;
    }
  );
});

test('requestJson：5xx 时依次回落到 detail 字符串、message 字段、通用文案', async () => {
  const bridge = { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null };

  const detailString = loadKit({ bridge, fetch: async () => response({ status: 500, body: '{"detail":"数据库不可用"}' }) });
  await assert.rejects(() => detailString.requestJson('/x'), (error) => error.message === '数据库不可用');

  const messageField = loadKit({ bridge, fetch: async () => response({ status: 500, body: '{"message":"上游超时"}' }) });
  await assert.rejects(() => messageField.requestJson('/x'), (error) => error.message === '上游超时');

  const nothing = loadKit({ bridge, fetch: async () => response({ status: 500, body: '{}' }) });
  await assert.rejects(() => nothing.requestJson('/x'), (error) => error.message === '请求失败（500）');
});

test('requestJson：超时会中断请求并抛 AbortError', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('request aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  });

  await assert.rejects(
    () => kit.requestJson('/slow', { timeout: 20 }),
    (error) => error.name === 'AbortError'
  );
});

test('配置缓存：onConfigChanged 广播后，下一次请求用新的 apiBase', async () => {
  let notify = null;
  const { calls, impl } = captureFetch(response({ body: '{}' }));
  const kit = loadKit({
    bridge: {
      readConfig: async () => ({ apiBase: 'http://old' }),
      readAuth: async () => null,
      onConfigChanged: (fn) => {
        notify = fn;
      }
    },
    fetch: impl
  });

  await kit.requestJson('/x');
  assert.strictEqual(calls[0].url, 'http://old/api/v1/x');

  notify({ apiBase: 'http://new' });
  await kit.requestJson('/y');
  assert.strictEqual(calls[1].url, 'http://new/api/v1/y');
});

test('桥接抛错时降级为空配置，不把异常抛给调用方', async () => {
  const calls = [];
  const kit = loadKit({
    bridge: {
      readConfig: async () => {
        throw new Error('bridge 未就绪');
      },
      readAuth: async () => {
        throw new Error('bridge 未就绪');
      }
    },
    fetch: async (url) => {
      calls.push(url);
      return response({ body: '{}' });
    }
  });

  await kit.requestJson('/x');

  assert.strictEqual(calls[0], '/api/v1/x');
});

test('jsonPayload：解开 {code,data} 信封，其它形态原样返回', () => {
  const kit = loadKit();

  assert.deepStrictEqual(kit.jsonPayload({ code: 0, data: { a: 1 } }), { a: 1 });
  assert.deepStrictEqual(kit.jsonPayload({ code: 0 }), { code: 0 });
  assert.deepStrictEqual(kit.jsonPayload([1, 2]), [1, 2]);
  assert.strictEqual(kit.jsonPayload(null), null);
});

test('friendlyError：三类错误各自给中文文案', () => {
  const kit = loadKit();

  assert.strictEqual(kit.friendlyError(new TypeError('fetch failed')), '无法连接后端，请确认服务已启动，然后重试');
  assert.strictEqual(kit.friendlyError({ name: 'AbortError' }), '请求超时，请确认后端在运行后重试');
  assert.strictEqual(kit.friendlyError(new Error('会话不存在')), '会话不存在');
  assert.strictEqual(kit.friendlyError(null), '请求失败，请稍后重试');
});

test('formatFileSize：B / KB / MB 三档', () => {
  const kit = loadKit();

  assert.strictEqual(kit.formatFileSize(0), '0 B');
  assert.strictEqual(kit.formatFileSize(1023), '1023 B');
  assert.strictEqual(kit.formatFileSize(1024), '1 KB');
  assert.strictEqual(kit.formatFileSize(1024 * 1024), '1.0 MB');
});

test('attachLabel / attachKindOf：先按 mime，再按扩展名兜底', () => {
  const kit = loadKit();

  assert.strictEqual(kit.attachLabel('application/pdf', 'x.pdf'), 'PDF');
  assert.strictEqual(kit.attachLabel('', '报告.docx'), 'Word');
  assert.strictEqual(kit.attachLabel('', '明细.xlsm'), 'Excel');
  assert.strictEqual(kit.attachLabel('', '未知.zzz'), '文件');

  assert.strictEqual(kit.attachKindOf('image/png', 'a.bin'), 'image');
  assert.strictEqual(kit.attachKindOf('', 'a.webp'), 'image');
  assert.strictEqual(kit.attachKindOf('text/plain', 'a.txt'), 'text');
});

test('toast：找不到提示元素时静默返回（不抛错）', () => {
  const kit = loadKit();

  assert.doesNotThrow(() => kit.toast('随便说点什么', 'error'));
});

test('fetchAttachmentBlob：带令牌取原文件，返回 Blob', async () => {
  const calls = [];
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => ({ token: 'tok' }) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, blob: async () => new Blob(['x']) };
    }
  });

  const blob = await kit.fetchAttachmentBlob(12);

  assert.ok(blob instanceof Blob, '应返回 Blob 供 URL.createObjectURL 使用');
  assert.strictEqual(calls[0].url, 'http://a/api/v1/attachments/12');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('fetchAttachmentBlob：附件不存在时抛出后端给的原因', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ detail: '附件不存在或已删除' }) })
  });

  await assert.rejects(() => kit.fetchAttachmentBlob(99), (error) => error.message === '附件不存在或已删除');
});

test('fetchAttachmentBlob：超时会中断请求', async () => {
  const kit = loadKit({
    bridge: { readConfig: async () => ({ apiBase: 'http://a' }), readAuth: async () => null },
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  });

  await assert.rejects(() => kit.fetchAttachmentBlob(1, 20), (error) => error.name === 'AbortError');
});

test('attachLabel：图片按 mime 与扩展名两条路都能认出来', () => {
  const kit = loadKit();

  assert.strictEqual(kit.attachLabel('image/webp', 'a.bin'), '图片');
  assert.strictEqual(kit.attachLabel('', '照片.jpeg'), '图片');
  assert.strictEqual(kit.attachLabel('text/markdown', 'a.md'), 'Markdown');
});

test('clear：清空容器的所有子节点', () => {
  const kit = loadKit();
  const element = {
    firstChild: { nodeType: 1 },
    removeChild() {
      this.firstChild = null;
    }
  };

  assert.strictEqual(kit.clear(element), element, '应返回容器本身，便于链式调用');
  assert.strictEqual(element.firstChild, null);
});
