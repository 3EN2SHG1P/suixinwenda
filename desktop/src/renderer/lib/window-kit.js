/**
 * 文件：desktop/src/renderer/lib/window-kit.js
 * 职责：独立子窗口的公共工具——DOM 构造、后端请求（带令牌与超时）、错误翻译、提示条、附件文案。
 *      子窗口拿不到主窗口的 state / appConfig，所以这里自己缓存配置与令牌，并跟随主进程广播更新。
 * 口径：与 app.js 的请求口径一致（/api/v1 前缀、Authorization: Bearer、detail 中文原因），
 *      但只保留窗口需要的部分——不复制聊天与流式逻辑。
 */
(function (global) {
  'use strict';

  const bridge = () => global.windowBridge || {};
  let configCache = null;
  let tokenCache = null;

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  /** 极简 DOM 构造：视图里不拼 innerHTML，天然免疫注入。 */
  function h(tag, props, children) {
    const el = document.createElement(tag);
    const source = props || {};
    Object.keys(source).forEach((key) => {
      const value = source[key];
      if (value === undefined || value === null) {
        return;
      }
      if (key === 'class') {
        el.className = value;
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'dataset') {
        Object.keys(value).forEach((name) => {
          el.dataset[name] = String(value[name]);
        });
      } else if (key === 'style') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el) {
        el[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    });
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
    list.forEach((child) => {
      if (child === null || child === undefined || child === false) {
        return;
      }
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function clear(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
    return el;
  }

  async function config() {
    if (!configCache) {
      try {
        configCache = (await bridge().readConfig()) || {};
      } catch (error) {
        configCache = {};
      }
    }
    return configCache;
  }

  async function token() {
    if (tokenCache !== null) {
      return tokenCache;
    }
    try {
      const auth = await bridge().readAuth();
      tokenCache = (auth && auth.token) || '';
    } catch (error) {
      tokenCache = '';
    }
    return tokenCache;
  }

  async function readDetail(response) {
    try {
      const body = await response.json();
      const detail = body && body.detail;
      if (Array.isArray(detail)) {
        const first = detail[0] || {};
        return first.msg
          ? String(first.msg).replace(/^Value error,\s*/, '')
          : `请求失败（${response.status}）`;
      }
      if (typeof detail === 'string' && detail) {
        return detail;
      }
      if (body && typeof body.message === 'string' && body.message) {
        return body.message;
      }
      return `请求失败（${response.status}）`;
    } catch (error) {
      return `请求失败（${response.status}）`;
    }
  }

  /** 与主窗口同口径的请求：路径不带前缀，内部补 /api/v1。 */
  async function requestJson(path, options) {
    const opts = options || {};
    const conf = await config();
    const bearer = await token();
    const headers = {};
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    const url = `${String(conf.apiBase || '').replace(/\/+$/, '')}/api/v1${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 30000);
    let response;
    try {
      response = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(await readDetail(response));
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  /** 鉴权取附件原文件（图片灯箱、预览窗口的缩略图都要走它，不能直接塞进 img src）。 */
  async function fetchAttachmentBlob(id, timeout) {
    const conf = await config();
    const bearer = await token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 60000);
    try {
      const response = await fetch(`${String(conf.apiBase || '').replace(/\/+$/, '')}/api/v1/attachments/${id}`, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(await readDetail(response));
      }
      return response.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  function jsonPayload(body) {
    if (body && typeof body === 'object' && !Array.isArray(body) && 'code' in body && 'data' in body) {
      return body.data;
    }
    return body;
  }

  function friendlyError(error) {
    if (error instanceof TypeError) {
      return '无法连接后端，请确认服务已启动，然后重试';
    }
    if (error && error.name === 'AbortError') {
      return '请求超时，请确认后端在运行后重试';
    }
    return (error && error.message) || '请求失败，请稍后重试';
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size >= 1024 * 1024) {
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }
    if (size >= 1024) {
      return `${Math.round(size / 1024)} KB`;
    }
    return `${size} B`;
  }

  const ATTACH_LABELS = {
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'Excel',
    'text/plain': '文本',
    'text/markdown': 'Markdown',
    'text/csv': 'CSV',
    'application/json': 'JSON',
    'image/png': '图片',
    'image/jpeg': '图片',
    'image/gif': '图片',
    'image/webp': '图片'
  };

  function attachLabel(mime, name) {
    const key = String(mime || '').toLowerCase();
    if (ATTACH_LABELS[key]) {
      return ATTACH_LABELS[key];
    }
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      return '图片';
    }
    if (ext === 'pdf') {
      return 'PDF';
    }
    if (ext === 'docx') {
      return 'Word';
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      return 'Excel';
    }
    return '文件';
  }

  function attachKindOf(mime, name) {
    if (String(mime || '').startsWith('image/')) {
      return 'image';
    }
    const ext = String(name || '').split('.').pop().toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? 'image' : 'text';
  }

  /** 窗口内提示条：不抢焦点、4 秒自动消失（错误留久一点）。 */
  let toastTimer = 0;
  function toast(message, kind) {
    const box = qs('#aw-toast');
    if (!box) {
      return;
    }
    box.textContent = String(message || '');
    box.classList.toggle('is-error', kind === 'error');
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, kind === 'error' ? 6000 : 3600);
  }

  // 配置与令牌跟随广播失效：主题切换 / 登录状态变化后下一次请求立即用新值
  if (typeof bridge().onConfigChanged === 'function') {
    bridge().onConfigChanged((next) => {
      configCache = next || configCache;
    });
  }
  if (typeof bridge().onAuthChanged === 'function') {
    bridge().onAuthChanged((auth) => {
      tokenCache = (auth && auth.token) || '';
    });
  }

  global.SXW_WIN = {
    qs,
    qsa,
    h,
    clear,
    config,
    token,
    requestJson,
    fetchAttachmentBlob,
    jsonPayload,
    friendlyError,
    formatFileSize,
    attachLabel,
    attachKindOf,
    toast
  };
})(window);
