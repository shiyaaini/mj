import { useAppStore } from '@/stores/appStore'
import { AUTOMATION_LABELS, pickLabel } from '@/labels'
import './automation.css'

export function AutomationPage() {
  const automations = useAppStore((s) => s.automations)
  const toggleAutomation = useAppStore((s) => s.toggleAutomation)

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>自动化</h1>
        </div>
        <button type="button" className="btn btn-primary">
          + 创建自动化
        </button>
      </header>

      <div className="auto-list">
        {automations.map((rule) => (
          <div key={rule.id} className="panel auto-item">
            <div>
              <h3>{pickLabel(AUTOMATION_LABELS, rule.nameKey, rule.nameKey)}</h3>
              <p>{rule.enabled ? '已启用' : '已停用'}</p>
            </div>
            <button
              type="button"
              className={`switch${rule.enabled ? ' on' : ''}`}
              aria-pressed={rule.enabled}
              onClick={() => toggleAutomation(rule.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
