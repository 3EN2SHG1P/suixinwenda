/**
 * 文件：desktop/src/auto-backup.js
 * 职责：定期自动备份的判定——设置归一口径、最近一份备份的时间、「这次该不该备份」。
 *
 * 为什么单独成模块：这段逻辑决定「要不要往用户磁盘上写一个几十 MB 的包」，
 * 判错一次就是天天备份或永远不备份，而它本身只是几个纯函数。
 * 不 require('electron')：文件系统、目录清单、当前时间全部由调用方注入，测试里用临时目录跑。
 */
const fsSync = require('node:fs');
const nodePath = require('node:path');

// 默认值（唯一源）：7 天是「一周没备份就补一份」的直觉值；上限 90 天防止有人填 100000 把功能变哑
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 天数归一：非法值回默认，超范围夹到边界（配置是页面写进来的，不可信）。 */
function normalizeDays(value) {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days < MIN_DAYS) {
    return DEFAULT_DAYS;
  }
  return Math.min(days, MAX_DAYS);
}

/** 从 config.json 里读设置：开关默认开（历史配置没有这两个键时按「开 + 7 天」处理）。 */
function settingsOf(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    enabled: source.autoBackupEnabled !== false,
    days: normalizeDays(source.autoBackupDays)
  };
}

/**
 * 最近一份备份的时间（毫秒），没有则返回 0。
 *
 * 只看各备份根目录下的直接子项 *.zip：手动备份在 userData/backups，
 * 自动备份在 data 目录下的 backups，两处都算「用户的退路」——
 * 只盯自动备份那一池，用户刚手动备份过还会被再备一份。
 */
function latestBackupTime(dirs, options = {}) {
  const fs = options.fs || fsSync;
  let newest = 0;
  for (const dir of dirs || []) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue; // 目录还不存在是最常见的情况，不算错误
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) {
        continue;
      }
      try {
        const stat = fs.statSync(nodePath.join(dir, entry.name));
        newest = Math.max(newest, stat.mtimeMs);
      } catch (error) {
        // 单个文件读不到不影响「有没有更新的备份」这个判断
      }
    }
  }
  return newest;
}

/**
 * 该不该跑这次自动备份。
 *
 * lastAt 为 0（一份备份都没有）时必须返回 true：那正是最需要退路的时候，
 * 而「超过 N 天」在数学上永远不成立，不单独判就会让新用户永远等不到第一份自动备份。
 */
function shouldAutoBackup(input) {
  const opts = input || {};
  if (!opts.enabled) {
    return false;
  }
  const now = Number(opts.now) || Date.now();
  const lastAt = Number(opts.lastAt) || 0;
  if (lastAt <= 0) {
    return true;
  }
  return now - lastAt >= normalizeDays(opts.days) * DAY_MS;
}

module.exports = {
  DEFAULT_DAYS,
  MAX_DAYS,
  DAY_MS,
  normalizeDays,
  settingsOf,
  latestBackupTime,
  shouldAutoBackup
};
