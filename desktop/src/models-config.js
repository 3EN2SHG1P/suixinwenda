/**
 * 文件：desktop/src/models-config.js
 * 职责：模型配置的纯逻辑——预置模板、字段校验、增删改、默认模型、生成运行时明文配置。
 *
 * 为什么单独成模块：这段决定「用户填的 Key 会不会写歪 / 删到没有模型 / 默认指向已删除项」，
 * 而 main.js 需要 electron 无法单测。加解密与文件 IO 全部由调用方注入。
 *
 * 关键口径：
 * - 每个模型自带 Base URL 与 Key（与桌面端 CodeBuddy 的「添加模型」一致），
 *   选哪个模型就用哪个模型的凭据——不是全局一把 Key。
 * - 预置模板只带配置（地址/模型 ID），**不带 Key**，Key 必须由用户自己填。
 */

/** 预置模板：只填地址与建议模型 ID，Key 一律留空。 */
const TEMPLATES = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    vision: false,
    reasoning: false
  },
  {
    provider: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    vision: true,
    reasoning: false
  },
  {
    provider: 'custom',
    label: '自定义（兼容 OpenAI）',
    baseUrl: '',
    model: '',
    vision: false,
    reasoning: false
  }
];

const NAME_MAX = 60;
const MODEL_MAX = 100;
const URL_MAX = 300;
const KEY_MAX = 300;

function text(value) {
  return String(value == null ? '' : value).trim();
}

/** Key 清洗：粘贴常带首尾空格与换行，写进配置会把 JSON/环境变量写坏；中间字符原样保留。 */
function cleanKey(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, '').trim();
}

/** 校验并规范化用户输入；返回 { error } 或 { values }（不含 apiKeyEnc）。 */
function validateModel(input) {
  const source = input && typeof input === 'object' ? input : {};
  const name = text(source.name);
  const model = text(source.model);
  const baseUrl = text(source.baseUrl);
  const provider = text(source.provider) || 'custom';

  if (!name) {
    return { error: '显示名称不能为空' };
  }
  if (name.length > NAME_MAX) {
    return { error: `显示名称不能超过 ${NAME_MAX} 个字符` };
  }
  if (!model) {
    return { error: '模型 ID 不能为空（例如 deepseek-chat）' };
  }
  if (model.length > MODEL_MAX || /\s/.test(model)) {
    return { error: '模型 ID 不能包含空白字符，也不能过长' };
  }
  if (!baseUrl) {
    return { error: 'Base URL 不能为空' };
  }
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > URL_MAX) {
    return { error: 'Base URL 必须以 http:// 或 https:// 开头，且不能包含空白' };
  }
  const apiKey = cleanKey(source.apiKey);
  if (apiKey.length > KEY_MAX || /\s/.test(apiKey)) {
    return { error: 'API Key 不能包含空白字符，也不能过长' };
  }
  return {
    values: {
      name,
      provider,
      baseUrl,
      model,
      apiKey,
      vision: Boolean(source.vision),
      reasoning: Boolean(source.reasoning)
    }
  };
}

/** 生成模型 id：只允许出现在下拉值与配置键里，所以用 ASCII 短串。 */
function nextId(now, random) {
  const stamp = Number(now ? now() : Date.now()).toString(36);
  const noise = Math.floor((typeof random === 'function' ? random() : Math.random()) * 0x1000)
    .toString(36)
    .padStart(3, '0');
  return `m-${stamp}-${noise}`;
}

/** 默认配置：两条预置模板，状态是「未配置 Key」。 */
function defaultConfig() {
  return {
    version: 1,
    default: '',
    models: TEMPLATES.filter((item) => item.baseUrl).map((item) => ({
      id: `m-${item.provider}`,
      name: item.label,
      provider: item.provider,
      baseUrl: item.baseUrl,
      model: item.model,
      apiKeyEnc: '',
      vision: Boolean(item.vision),
      reasoning: Boolean(item.reasoning)
    }))
  };
}

/**
 * 新增模型。encrypt 由调用方注入（Electron safeStorage）；返回 { config, id } 或 { error }。
 */
function addModel(config, input, options) {
  const opts = options || {};
  const checked = validateModel(input);
  if (checked.error) {
    return checked;
  }
  if (!checked.values.apiKey) {
    return { error: '新增模型必须填写 API Key' };
  }
  const encrypted = typeof opts.encrypt === 'function' ? opts.encrypt(checked.values.apiKey) : '';
  if (!encrypted) {
    return { error: '系统加密不可用，无法安全保存 Key（请检查系统密钥环）' };
  }
  const id = nextId(opts.now, opts.random);
  const model = {
    id,
    name: checked.values.name,
    provider: checked.values.provider,
    baseUrl: checked.values.baseUrl,
    model: checked.values.model,
    apiKeyEnc: encrypted,
    vision: checked.values.vision,
    reasoning: checked.values.reasoning
  };
  const models = [...config.models, model];
  return {
    config: {
      ...config,
      models,
      // 第一个模型自动成为默认，省得用户还要多点一次
      default: config.default || id
    },
    id
  };
}

/** 编辑模型：apiKey 留空表示不改（界面不回显 Key）。 */
function updateModel(config, id, input, options) {
  const opts = options || {};
  const index = config.models.findIndex((item) => item.id === id);
  if (index < 0) {
    return { error: '这个模型已经不存在了' };
  }
  const checked = validateModel(input);
  if (checked.error) {
    return checked;
  }
  const previous = config.models[index];
  let apiKeyEnc = previous.apiKeyEnc;
  if (checked.values.apiKey) {
    apiKeyEnc = typeof opts.encrypt === 'function' ? opts.encrypt(checked.values.apiKey) : '';
    if (!apiKeyEnc) {
      return { error: '系统加密不可用，无法安全保存 Key（请检查系统密钥环）' };
    }
  }
  const models = config.models.slice();
  models[index] = {
    ...previous,
    name: checked.values.name,
    provider: checked.values.provider,
    baseUrl: checked.values.baseUrl,
    model: checked.values.model,
    vision: checked.values.vision,
    reasoning: checked.values.reasoning,
    apiKeyEnc
  };
  return { config: { ...config, models } };
}

/** 删除模型：允许删到空（界面会显示「暂无模型」并给出添加入口，发送键同时禁用）。 */
function deleteModel(config, id) {
  if (!config.models.some((item) => item.id === id)) {
    return { error: '这个模型已经不存在了' };
  }
  const models = config.models.filter((item) => item.id !== id);
  // 默认模型被删（或本来就指向空/失效项）时，落到剩下的第一个；一个都不剩就清空，
  // 留一个指向已删除 id 的默认值会让前端下拉显示空，看起来像「模型还在但坏了」
  const stillValid = models.some((item) => item.id === config.default);
  return { config: { ...config, models, default: stillValid ? config.default : models.length ? models[0].id : '' } };
}

function setDefaultModel(config, id) {
  if (!config.models.some((item) => item.id === id)) {
    return { error: '这个模型已经不存在了' };
  }
  return { config: { ...config, default: id } };
}

/** 清除某个模型的 Key（保留其它配置）。 */
function clearModelKey(config, id) {
  const index = config.models.findIndex((item) => item.id === id);
  if (index < 0) {
    return { error: '这个模型已经不存在了' };
  }
  const models = config.models.slice();
  models[index] = { ...models[index], apiKeyEnc: '' };
  return { config: { ...config, models } };
}

/**
 * 生成给后端的运行时配置（明文 Key）。
 *
 * 解不开的项直接跳过：宁可这个模型不出现，也不要让后端拿空 Key 去建一个「看起来能用」的模型。
 */
function runtimePayload(config, decrypt) {
  const models = [];
  (config.models || []).forEach((item) => {
    let apiKey = '';
    try {
      apiKey = item.apiKeyEnc && typeof decrypt === 'function' ? String(decrypt(item.apiKeyEnc) || '') : '';
    } catch (error) {
      apiKey = '';
    }
    if (!apiKey) {
      return;
    }
    models.push({
      id: item.id,
      name: item.name,
      provider: item.provider,
      baseUrl: item.baseUrl,
      model: item.model,
      apiKey,
      vision: Boolean(item.vision),
      reasoning: Boolean(item.reasoning)
    });
  });
  const wanted = String(config.default || '');
  const defaultId = models.some((item) => item.id === wanted) ? wanted : models.length ? models[0].id : '';
  return { default: defaultId, models };
}

/** 发给渲染进程的视图：绝不含 Key，只告诉界面「配没配」。 */
function publicConfig(config) {
  return {
    version: config.version || 1,
    default: String(config.default || ''),
    models: (config.models || []).map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      baseUrl: item.baseUrl,
      model: item.model,
      vision: Boolean(item.vision),
      reasoning: Boolean(item.reasoning),
      hasKey: Boolean(item.apiKeyEnc)
    }))
  };
}

module.exports = {
  TEMPLATES,
  defaultConfig,
  validateModel,
  cleanKey,
  addModel,
  updateModel,
  deleteModel,
  setDefaultModel,
  clearModelKey,
  runtimePayload,
  publicConfig
};
