import { useEffect, useId, useRef, useState } from 'react'
import { useAppStore } from '@/stores/appStore'
import './plugins.css'

const SAMPLE_CONFIG = `{
  "id": "yeelink-light-demo",
  "name": "彩灯示例",
  "version": "1.0.0",
  "match": "yeelink.light.*",
  "logo": "assets/logo.svg",
  "description": "开关 / 亮度 / 色温"
}
`

const SAMPLE_INDEX = `import { useState } from 'react'

export default function Plugin({ miPlugin, device, values, config }) {
  const on = Boolean(values.on)
  const logo = config.logo ? miPlugin.assetUrl(config.logo) : ''

  return (
    <div className="pkg-plugin">
      <style>{\`
        .pkg-plugin { display: grid; gap: 12px; }
        .pkg-plugin .head { display: flex; gap: 12px; align-items: center; }
        .pkg-plugin img { width: 40px; height: 40px; object-fit: contain; }
        .pkg-plugin button {
          padding: 8px 14px; border-radius: 10px; border: 0;
          background: #3b82f6; color: #fff; cursor: pointer;
        }
      \`}</style>
      <div className="head">
        {logo ? <img src={logo} alt="" /> : null}
        <div>
          <strong>{config.name || device.name}</strong>
          <div>{device.model}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={() =>
          miPlugin.setSwitch(!on).then(() =>
            miPlugin.toast(on ? '已关闭' : '已打开'),
          )
        }
      >
        {on ? '关闭' : '打开'}
      </button>
    </div>
  )
}
`

type Props = {
  open: boolean
  onClose: () => void
}

export function PluginDocsDialog({ open, onClose }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const showToast = useAppStore((s) => s.showToast)
  const [copied, setCopied] = useState<'config' | 'index' | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) setCopied(null)
  }, [open])

  if (!open) return null

  const copyText = async (text: string, which: 'config' | 'index') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      showToast('已复制')
      window.setTimeout(() => setCopied(null), 2000)
    } catch {
      showToast('复制失败，请手动选择代码')
    }
  }

  return (
    <div className="filter-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="filter-dialog plugin-docs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-dialog-head">
          <h2 id={titleId}>插件编写说明</h2>
          <button
            type="button"
            className="filter-dialog-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="filter-dialog-body plugin-docs-body">
          <p className="filter-dialog-hint">
            上传 <code>.zip</code> 插件包（支持一次多选）。安装后自动解压到{' '}
            <code>userData/plugins/&lt;id&gt;/</code>，运行时编译挂载。
          </p>

          <section className="plugin-docs-section">
            <h3>1. 包结构（必填）</h3>
            <pre className="plugin-docs-code">
              <code>{`my-light-plugin.zip
├── config.json          # 必填
├── index.jsx            # 必填（或 index.tsx / config.entry）
└── assets/
    └── logo.svg         # 可选资源，由 config 引用`}</code>
            </pre>
            <ul>
              <li>
                <code>config.json</code> 与入口文件必须在包根目录（或唯一子文件夹内）
              </li>
              <li>
                图片 / 字体等相对路径写在 config，代码里用{' '}
                <code>miPlugin.assetUrl(...)</code> 解析
              </li>
            </ul>
          </section>

          <section className="plugin-docs-section">
            <div className="plugin-docs-sample-head">
              <h3>2. config.json</h3>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void copyText(SAMPLE_CONFIG, 'config')}
              >
                {copied === 'config' ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="plugin-docs-code">
              <code>{SAMPLE_CONFIG}</code>
            </pre>
            <div className="plugin-docs-table-wrap">
              <table className="plugin-docs-table">
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>id</code>
                    </td>
                    <td>安装目录名（唯一）</td>
                  </tr>
                  <tr>
                    <td>
                      <code>match</code>
                    </td>
                    <td>
                      设备 model，或 <code>*</code> 通配；也可为字符串数组
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>logo</code>
                    </td>
                    <td>相对路径，如 <code>assets/logo.png</code></td>
                  </tr>
                  <tr>
                    <td>
                      <code>entry</code>
                    </td>
                    <td>可选，默认 <code>index.jsx</code> / <code>index.tsx</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="plugin-docs-section">
            <h3>3. 详情页优先级</h3>
            <ol>
              <li>电脑开机卡（内置 React）</li>
              <li>匹配到的本机插件包（按 config.match）</li>
              <li>品类预制页 / 通用 Spec</li>
            </ol>
          </section>

          <section className="plugin-docs-section">
            <h3>4. 组件 props / miPlugin</h3>
            <div className="plugin-docs-table-wrap">
              <table className="plugin-docs-table">
                <thead>
                  <tr>
                    <th>属性</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>device</code> / <code>values</code> / <code>config</code>
                    </td>
                    <td>设备信息、属性快照、config.json</td>
                  </tr>
                  <tr>
                    <td>
                      <code>miPlugin.assetUrl(path)</code>
                    </td>
                    <td>包内相对路径 → 可加载 URL</td>
                  </tr>
                  <tr>
                    <td>
                      <code>setSwitch</code> / <code>setProp</code> /{' '}
                      <code>runAction</code>
                    </td>
                    <td>写属性 / 动作</td>
                  </tr>
                  <tr>
                    <td>
                      <code>reload</code> / <code>toast</code>
                    </td>
                    <td>刷新快照 / 提示</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="plugin-docs-section">
            <div className="plugin-docs-sample-head">
              <h3>5. index.jsx 示例</h3>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void copyText(SAMPLE_INDEX, 'index')}
              >
                {copied === 'index' ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="plugin-docs-code">
              <code>{SAMPLE_INDEX}</code>
            </pre>
          </section>

          <section className="plugin-docs-section">
            <h3>6. 提示</h3>
            <ul>
              <li>仅可 import react；样式建议加独立 class 前缀</li>
              <li>同 id 再次安装会覆盖原目录</li>
              <li>旧版单文件 .jsx/.tsx 仍可识别，建议迁移为 zip 包</li>
            </ul>
          </section>
        </div>

        <div className="filter-dialog-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
