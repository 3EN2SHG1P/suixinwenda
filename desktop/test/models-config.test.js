/**
 * 文件：desktop/test/models-config.test.js
 * 职责：模型配置的增删改与运行时导出规则。
 *
 * 为什么单独测：这几条错一条都不会抛异常——删到没有模型、编辑时把 Key 清空、
 * 默认指向已删除项、运行时文件里漏了 Key，表现都是「界面看着正常、一聊就报错」。
 */
const test = require('node:test');
const assert = require('node:assert');

const cfg = require('../src/models-config.js');

const encrypt = (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`;
const decrypt = (token) => Buffer.from(String(token).slice(4), 'base64').toString('utf8');

const INPUT = {
  name: '我的模型',
  provider: 'custom',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-123',
  vision: true,
  reasoning: false
};

test('预置模板只带配置，不带 Key', () => {
  const config = cfg.defaultConfig();
  assert.strictEqual(config.models.length, 2, '两条可用的预置（自定义模板需要手填地址）');
  assert.ok(config.models.every((item) => item.apiKeyEnc === ''), '模板里不能有任何 Key');
  assert.ok(config.models.every((item) => item.baseUrl.startsWith('https://')));
  assert.strictEqual(config.default, '', '还没配 Key，不该有默认模型');
});

test('校验：名称/模型 ID/Base URL/Key 四类错误都能说清楚', () => {
  assert.match(cfg.validateModel({ ...INPUT, name: '' }).error, /显示名称不能为空/);
  assert.match(cfg.validateModel({ ...INPUT, model: '' }).error, /模型 ID 不能为空/);
  assert.match(cfg.validateModel({ ...INPUT, model: 'a b' }).error, /不能包含空白/);
  assert.match(cfg.validateModel({ ...INPUT, baseUrl: '' }).error, /Base URL 不能为空/);
  assert.match(cfg.validateModel({ ...INPUT, baseUrl: 'ftp://x' }).error, /http/);
  assert.match(cfg.validateModel({ ...INPUT, apiKey: 'sk a b' }).error, /API Key/);
  assert.strictEqual(cfg.validateModel(INPUT).error, undefined);
});

test('Key 清洗：去掉换行与首尾空格，中间字符保留', () => {
  assert.strictEqual(cfg.cleanKey('  sk-abc\n123\t '), 'sk-abc123');
});

test('新增模型：缺 Key 拒绝，有 Key 加密落盘并自动成为默认', () => {
  const base = cfg.defaultConfig();
  assert.match(cfg.addModel(base, { ...INPUT, apiKey: '' }, { encrypt }).error, /必须填写 API Key/);

  const created = cfg.addModel(base, INPUT, { encrypt, now: () => 1000, random: () => 0.5 });
  assert.ok(created.id.startsWith('m-'));
  assert.strictEqual(created.config.models.length, 3);
  assert.strictEqual(created.config.default, created.id, '第一个可用模型应自动成为默认');
  const stored = created.config.models[2];
  assert.strictEqual(stored.apiKeyEnc, encrypt('sk-test-123'));
  assert.ok(!JSON.stringify(stored).includes('sk-test-123'), '配置里不许出现明文 Key');
});

test('系统加密不可用时拒绝保存，而不是退回明文', () => {
  const base = cfg.defaultConfig();
  assert.match(cfg.addModel(base, INPUT, { encrypt: () => '' }).error, /系统加密不可用/);
});

test('编辑：Key 留空表示不改，填了才重新加密', () => {
  const created = cfg.addModel(cfg.defaultConfig(), INPUT, { encrypt, now: () => 1, random: () => 0.1 });
  const id = created.id;
  const before = created.config.models.find((item) => item.id === id).apiKeyEnc;

  const kept = cfg.updateModel(created.config, id, { ...INPUT, apiKey: '', name: '改名了' }, { encrypt });
  assert.strictEqual(kept.config.models.find((item) => item.id === id).apiKeyEnc, before);
  assert.strictEqual(kept.config.models.find((item) => item.id === id).name, '改名了');

  const changed = cfg.updateModel(created.config, id, { ...INPUT, apiKey: 'sk-new' }, { encrypt });
  assert.strictEqual(changed.config.models.find((item) => item.id === id).apiKeyEnc, encrypt('sk-new'));
});

test('删除：可以删到空，默认值随之清空；删默认后回落到剩下的第一个', () => {
  const base = cfg.defaultConfig();
  const one = { ...base, models: [base.models[0]], default: base.models[0].id };
  const emptied = cfg.deleteModel(one, one.models[0].id);
  assert.deepStrictEqual(emptied.config.models, [], '允许把模型删空');
  assert.strictEqual(emptied.config.default, '', '没有模型时默认值也要清掉');

  const two = cfg.defaultConfig();
  const removed = cfg.deleteModel(two, two.models[0].id);
  assert.strictEqual(removed.config.models.length, 1);
  assert.strictEqual(removed.config.default, two.models[1].id, '默认要落到还在的那个');
  assert.match(cfg.deleteModel(two, 'm-nope').error, /已经不存在/);
});

test('设默认 / 清除 Key', () => {
  const config = cfg.addModel(cfg.defaultConfig(), INPUT, { encrypt, now: () => 2, random: () => 0.2 });
  const id = config.id;
  assert.strictEqual(cfg.setDefaultModel(config.config, id).config.default, id);
  assert.match(cfg.setDefaultModel(config.config, 'm-x').error, /不存在/);

  const cleared = cfg.clearModelKey(config.config, id);
  assert.strictEqual(cleared.config.models.find((item) => item.id === id).apiKeyEnc, '');
});

test('运行时导出：解不开的模型跳过，默认回落到可用项', () => {
  const config = cfg.defaultConfig();
  const withKey = cfg.addModel(config, INPUT, { encrypt, now: () => 3, random: () => 0.3 }).config;
  // 再加一条 Key 无法解密的模型：它不该被交给后端
  withKey.models.push({ ...withKey.models[0], id: 'm-broken', apiKeyEnc: 'BAD-TOKEN' });
  withKey.default = 'm-broken';

  // 严格的解密实现：非本系统密文直接抛错，模拟「换机器后解不开」
  const strictDecrypt = (token) => {
    if (!String(token).startsWith('enc:')) {
      throw new Error('解不开');
    }
    return decrypt(token);
  };
  const payload = cfg.runtimePayload(withKey, strictDecrypt);
  assert.strictEqual(payload.models.length, 1, '解不开的模型要跳过，不能拿空 Key 建模型');
  assert.strictEqual(payload.models[0].apiKey, 'sk-test-123');
  assert.strictEqual(payload.default, payload.models[0].id, '默认要回落到可用模型');
});

test('发给界面的视图不含 Key，只告诉配没配', () => {
  const config = cfg.addModel(cfg.defaultConfig(), INPUT, { encrypt, now: () => 4, random: () => 0.4 }).config;
  const view = cfg.publicConfig(config);
  assert.ok(!JSON.stringify(view).includes('sk-test-123'));
  assert.ok(!JSON.stringify(view).includes('enc:'));
  const item = view.models.find((row) => row.hasKey);
  assert.ok(item, '已配置的模型要标 hasKey');
});
