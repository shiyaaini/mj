<template>
  <div class="demo">
    <h3>{{ title }}</h3>
    <p class="sub">{{ deviceLabel }}</p>
    <p class="sub">电源：{{ powerText }}</p>
    <div class="row">
      <button type="button" @click="toggle">切换开关</button>
      <button type="button" class="ghost" @click="reload">刷新</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'DevicePluginDemo',
  inject: {
    miPlugin: { from: 'miPlugin', default: null },
  },
  props: {
    device: { type: Object, default: null },
    values: { type: Object, default: null },
    miPlugin: { type: Object, default: null },
  },
  computed: {
    api() {
      return this.miPlugin || (typeof window !== 'undefined' && window.__miPlugin) || null
    },
    title() {
      return (this.api && this.api.device && this.api.device.name) || 'Vue 设备插件'
    },
    deviceLabel() {
      const d = this.api && this.api.device
      if (!d) return '未注入设备（预览模式）'
      return d.model + ' · ' + d.id
    },
    powerText() {
      const v = this.api && this.api.values
      if (!v) return '—'
      const on = v.on
      if (on === true) return '开'
      if (on === false) return '关'
      return String(on ?? '—')
    },
  },
  methods: {
    async toggle() {
      if (!this.api) return
      const cur = Boolean(this.api.values && this.api.values.on)
      await this.api.setSwitch(!cur)
      this.api.toast(!cur ? '已开启' : '已关闭')
    },
    async reload() {
      if (!this.api) return
      await this.api.reload()
      this.api.toast('已刷新')
    },
  },
}
</script>

<style>
.demo {
  font-family: inherit;
  color: var(--text-primary, #1a1f2c);
}
.demo h3 {
  margin: 0 0 8px;
  font-size: 18px;
}
.demo .sub {
  margin: 0 0 8px;
  opacity: 0.75;
  font-size: 13px;
}
.demo .row {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.demo button {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 8px 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  color: #fff;
  background: var(--accent, #3b82f6);
}
.demo button.ghost {
  background: transparent;
  color: var(--text-primary, #1a1f2c);
  border: 1px solid var(--border, #d0d5dd);
}
</style>
