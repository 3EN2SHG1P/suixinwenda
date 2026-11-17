/**
 * 文件：desktop/tools/check-globals.js
 * 职责：静态扫描主窗口加载的 classic script，找出重复的顶层声明。
 *
 * 为什么要单独检查：renderer 没有打包器，index.html 里的 script 共享同一个全局词法作用域。
 * 两个文件都写 `const state = ...` 时，浏览器只会在控制台报一句 SyntaxError，
 * 表现是「页面白屏」——本地跑 lint / 单测都发现不了（每个文件单独看都合法）。
 *
 * 用法：node tools/check-globals.js（CI 与本地都跑；有冲突时退出码 1）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.resolve(__dirname, '..', 'src', 'renderer');
const indexHtml = path.join(rendererDir, 'index.html');

// 只认行首（列 0）的声明：缩进过的是函数体内的局部变量，不会进全局词法作用域
const DECLARATION = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

function scriptsOf(html) {
  const names = [];
  const pattern = /<script[^>]*\bsrc="([^"]+)"/g;
  let match = pattern.exec(html);
  while (match) {
    const src = match[1];
    // 只检查同目录下的本地脚本；http(s) 外链不归本项目管
    if (!/^[a-z]+:/i.test(src)) {
      names.push(src.replace(/^\.\//, ''));
    }
    match = pattern.exec(html);
  }
  return names;
}

function declarationsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = DECLARATION.exec(line);
    if (match) {
      found.push({ name: match[1], line: index + 1 });
    }
  });
  return found;
}

function main() {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const scripts = scriptsOf(html);
  const seen = new Map();
  const conflicts = [];

  for (const src of scripts) {
    const file = path.join(rendererDir, src);
    if (!fs.existsSync(file)) {
      conflicts.push(`index.html 引用了不存在的脚本：${src}`);
      continue;
    }
    for (const item of declarationsOf(file)) {
      const previous = seen.get(item.name);
      if (previous) {
        conflicts.push(
          `${item.name} 重复声明：${previous.file}:${previous.line} 与 ${src}:${item.line}`
        );
      } else {
        seen.set(item.name, { file: src, line: item.line });
      }
    }
  }

  if (conflicts.length) {
    console.error('[globals] 顶层声明冲突（classic script 共享全局词法作用域）：');
    conflicts.forEach((text) => console.error(`  - ${text}`));
    process.exit(1);
  }
  console.log(`[globals] ${scripts.length} 个脚本、${seen.size} 个顶层声明，无冲突`);
}

main();
