/**
 * 文件：desktop/src/renderer/views/model.js
 * 职责：添加 / 编辑模型窗口——供应商预置、显示名、Base URL、API Key、模型 ID、能力位。
 * 载荷：{ id }（空 = 新增）
 * 口径：校验规则与 models.js 一致；保存后主进程会重启后端并广播模型变更。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  window.SXW_VIEWS.model = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const editingId = (ctx.payload && ctx.payload.id) || '';
      let presets = [];
      let existing = null;

      const title = h('h3', { class: 'modal-title', text: editingId ? '编辑模型' : '添加模型' });
      const provider = h('select', { class: 'auth-input' }, [
        h('option', { value: 'deepseek', text: 'DeepSeek' }),
        h('option', { value: 'qwen', text: '通义千问' }),
        h('option', { value: 'custom', text: '自定义（兼容 OpenAI）' })
      ]);
      const name = h('input', { class: 'auth-input', type: 'text', placeholder: 'DeepSeek', autocomplete: 'off' });
      const baseUrl = h('input', {
        class: 'auth-input',
        type: 'text',
        placeholder: 'https://api.deepseek.com/v1',
        autocomplete: 'off'
      });
      const apiKey = h('input', { class: 'auth-input', type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
      const keyHint = h('p', { class: 'settings-hint', hidden: true, text: '已配置 Key：留空表示不修改。' });
      const modelId = h('input', {
        class: 'auth-input',
        type: 'text',
        placeholder: 'deepseek-chat',
        autocomplete: 'off'
      });
      const vision = h('input', { type: 'checkbox' });
      const reasoning = h('input', { type: 'checkbox' });
      const tip = h('p', { class: 'auth-tip', hidden: true });
      const cancelButton = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const saveButton = h('button', { class: 'btn-primary', type: 'button', text: '保存并应用' });

      function field(label, input) {
        return h('label', { class: 'auth-field' }, [h('span', { class: 'auth-label', text: label }), input]);
      }

      root.appendChild(
        h('div', { class: 'modal-card aw-card', role: 'dialog', 'aria-modal': 'true' }, [
          title,
          h('p', {
            class: 'settings-hint',
            text: '兼容 OpenAI 协议的接口都能用：只要 Base URL、模型 ID 与 Key。保存后会自动重启本地服务（约 2 秒）让配置生效。'
          }),
          h('div', { class: 'db-grid' }, [field('供应商', provider), field('显示名称', name)]),
          field('Base URL', baseUrl),
          field('API Key', apiKey),
          keyHint,
          field('模型 ID', modelId),
          h('label', { class: 'restore-check' }, [vision, h('span', { text: '支持图片输入（可发图片附件）' })]),
          h('label', { class: 'restore-check' }, [reasoning, h('span', { text: '推理模型（预留：后端暂不回传推理过程）' })]),
          tip,
          h('div', { class: 'modal-actions' }, [cancelButton, saveButton])
        ])
      );

      function setTip(text, isError) {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(isError));
      }

      function presetOf(id) {
        return presets.find((item) => item.provider === id) || null;
      }

      function applyPreset(id) {
        const preset = presetOf(id);
        if (!preset) {
          return;
        }
        if (preset.baseUrl) {
          baseUrl.value = preset.baseUrl;
        }
        if (preset.model) {
          modelId.value = preset.model;
        }
        if (!name.value.trim()) {
          name.value = preset.label || '';
        }
        vision.checked = Boolean(preset.vision);
        reasoning.checked = Boolean(preset.reasoning);
      }

      provider.addEventListener('change', () => applyPreset(provider.value));

      function readForm() {
        return {
          id: editingId || undefined,
          provider: provider.value,
          name: name.value,
          baseUrl: baseUrl.value,
          model: modelId.value,
          apiKey: apiKey.value,
          vision: vision.checked,
          reasoning: reasoning.checked
        };
      }

      function validate(form) {
        if (!form.name.trim()) {
          return '显示名称不能为空';
        }
        if (!form.model.trim()) {
          return '模型 ID 不能为空（例如 deepseek-chat）';
        }
        if (!/^https?:\/\/[^\s]+$/i.test(form.baseUrl.trim())) {
          return 'Base URL 必须以 http:// 或 https:// 开头';
        }
        if (!form.id && !form.apiKey.trim()) {
          return '新增模型必须填写 API Key';
        }
        return '';
      }

      function setBusy(next) {
        saveButton.disabled = next;
        cancelButton.disabled = next;
        provider.disabled = next;
        ctx.setClosable(!next);
        saveButton.textContent = next ? '正在应用…' : '保存并应用';
      }

      saveButton.addEventListener('click', async () => {
        const form = readForm();
        const invalid = validate(form);
        if (invalid) {
          setTip(invalid, true);
          return;
        }
        setBusy(true);
        setTip('');
        try {
          const result = await ctx.bridge.saveModel({
            id: form.id,
            provider: form.provider,
            name: form.name,
            baseUrl: form.baseUrl,
            model: form.model,
            apiKey: form.apiKey,
            vision: form.vision,
            reasoning: form.reasoning
          });
          if (!result || !result.ok) {
            // 配置是先落盘再重启后端的：失败时旧配置已经被覆盖，
            // 写「已保留原配置」会让用户以为不用管，实际重启后会拿到新配置
            setTip(
              `配置已保存，但服务未能启动：${(result && result.error) || '未知原因'}；`
                + '重启应用后生效，若持续失败请检查端口是否被占用',
              true
            );
            return;
          }
          const applied = typeof result.models === 'number' ? result.models : 0;
          ctx.result({
            action: 'saved',
            message: applied > 0 ? `已生效：${applied} 个可用模型` : '已保存：还没有可用模型，请补全 Key'
          });
          // 必须先解除 busy：setBusy(true) 把窗口标成不可关闭，直接 close 会被主进程拦下，
          // 用户看到「正在执行，完成前不能关闭这个窗口」，以为保存失败
          setBusy(false);
          ctx.close();
        } catch (error) {
          setTip(ctx.kit.friendlyError(error), true);
        } finally {
          setBusy(false);
        }
      });

      cancelButton.addEventListener('click', () => ctx.close());

      async function init() {
        try {
          const listed = (await ctx.bridge.listModels()) || {};
          presets = Array.isArray(listed.presets) ? listed.presets : [];
          const models = Array.isArray(listed.models) ? listed.models : [];
          existing = editingId ? models.find((item) => item.id === editingId) : null;
        } catch (error) {
          setTip('读取模型配置失败', true);
        }
        if (existing) {
          title.textContent = '编辑模型';
          provider.value = existing.provider || 'deepseek';
          name.value = existing.name || '';
          baseUrl.value = existing.baseUrl || '';
          modelId.value = existing.model || '';
          apiKey.placeholder = existing.hasKey ? '留空表示不修改' : 'sk-…';
          keyHint.hidden = !existing.hasKey;
          vision.checked = Boolean(existing.vision);
          reasoning.checked = Boolean(existing.reasoning);
        } else {
          title.textContent = '添加模型';
          provider.value = 'deepseek';
          applyPreset('deepseek');
        }
        name.focus();
      }
      init();

      return {
        // 保存中不接受新载荷；空闲时返回 false 让外壳整块重挂（换成另一个模型的表单）
        onPayload() {
          return Boolean(saveButton.disabled);
        },
        onEscape() {
          if (saveButton.disabled) {
            return true;
          }
          ctx.close();
          return true;
        }
      };
    }
  };
})();
