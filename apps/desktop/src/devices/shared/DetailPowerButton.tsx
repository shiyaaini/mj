import './detail-power.css'

interface Props {
  on: boolean
  /** Status text under the icon (e.g. 已开启 / 已关闭) */
  label: string
  disabled?: boolean
  busy?: boolean
  onClick: () => void
  size?: 'lg' | 'md'
  className?: string
}

/** Circular power control used on device detail pages (PC boot card style). */
export function DetailPowerButton({
  on,
  label,
  disabled,
  busy,
  onClick,
  size = 'md',
  className = '',
}: Props) {
  return (
    <button
      type="button"
      className={`detail-power size-${size}${on ? ' on' : ''}${busy ? ' busy' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
    >
      <span className="detail-power-ring" aria-hidden />
      <span className="detail-power-disc">
        <svg className="detail-power-icon" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 3v9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M7.05 6.05a7.5 7.5 0 1 0 9.9 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
        <strong>{label}</strong>
      </span>
    </button>
  )
}

export function isPrimaryPowerProp(name: string) {
  const n = name.replace(/_/g, '-').toLowerCase()
  // Accessory switches are named on-{siid} (e.g. indicator on-5) — not hero power
  return n === 'on' || n === 'power' || n === 'switch'
}

/** True for any on / on-N power-like bool (list card preview sync). */
export function isPowerLikeProp(name: string) {
  const n = name.replace(/_/g, '-').toLowerCase()
  return n === 'on' || /^on-\d+$/.test(n) || n === 'power' || n === 'switch'
}
