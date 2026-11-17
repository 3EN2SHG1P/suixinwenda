/**
 * 文件：desktop/eslint.config.mjs
 * 职责：桌面端 lint 配置（flat config）。只开三类规则：no-undef / no-unused-vars / no-redeclare。
 *
 * 为什么按路径分组给 globals：主进程（Node 环境）、渲染进程（浏览器环境）、lib（双出口，
 * 同时需要 window 与 module）三者的全局变量完全不同，用一套合并的 globals 会大面积误报 no-undef，
 * 让人被迫加 eslint-disable 糊过去——那等于没有 lint。
 *
 * 范围：src/** 与 tools/**（mock-server / run-smoke / build 都是 Node 脚本，同样吃 no-undef 这套规则）。
 * test/**（node --test 的用例）用 globals.node 扫描。
 */
import globals from 'globals';

// 三条规则共用的口径：
// - caughtErrors: 'none' —— 绝大多数 catch 的意图就是「读到异常但故意吞掉」（注释里写了原因），
//   强行改写成 `catch {}` 或逐行 eslint-disable 只是噪音；真要处理异常的地方本来就会用到 error
const RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { caughtErrors: 'none' }],
  'no-redeclare': 'error'
};

// 渲染进程可用的全局（由 index.html 里 lib/*.js 的 classic script 提供）
const LIB_GLOBALS = {
  SXWMarkdown: 'readonly',
  SXWSse: 'readonly',
  SXWStreamBlocks: 'readonly',
  SXWSmoke: 'readonly'
};

export default [
  {
    // 主进程侧全部 js（main / preload-main / preload-window / app-windows / backend-manager …）。
    // 用通配而不是逐个列文件名：以前是穷举名单，新加 preload-main.js 这类文件时漏登记，
    // 它们就完全不参与 lint（no-undef 对它们形同虚设），而且没人会发现
    files: ['src/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node }
    },
    rules: RULES
  },
  {
    // 渲染进程与 lib：页面里是 classic script，单测里是 CommonJS 双出口。
    // 统一给 browser + module/require/process，避免为「谁有 module」再维护一份名单
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...LIB_GLOBALS,
        module: 'readonly',
        require: 'readonly',
        process: 'readonly'
      }
    },
    rules: RULES
  },
  {
    // 构建与冒烟脚本、node --test 用例：都是 Node 侧脚本，和主进程同一套全局
    files: ['tools/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node }
    },
    rules: RULES
  }
];
