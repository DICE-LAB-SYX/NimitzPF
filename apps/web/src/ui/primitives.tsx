import { roundPercent } from '@nimitzpf/core'
import { useEffect, useRef, type ReactNode } from 'react'
import css from './primitives.module.css'

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

export function Stars({ count, max = 3, size = 12 }: { count: number; max?: number; size?: number }) {
  return (
    <span className={css.stars} style={{ fontSize: size }} aria-label={`${count}/${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <svg key={i} viewBox="0 0 24 24" className={i < count ? css.starOn : css.starOff} aria-hidden="true">
          <path d="M12 2.5l2.9 6.2 6.8.8-5 4.6 1.4 6.7L12 17.4l-6.1 3.4 1.4-6.7-5-4.6 6.8-.8z" />
        </svg>
      ))}
    </span>
  )
}

export function HpBar({ hp, compact = false }: { hp: number; compact?: boolean }) {
  return (
    <span className={cx(css.hp, compact && css.hpCompact)} aria-label={`HP ${hp}/3`}>
      {Array.from({ length: 3 }, (_, i) => (
        <span key={i} className={cx(css.hpSeg, i < hp && css.hpOn, hp === 1 && i < hp && css.hpLow)} />
      ))}
    </span>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T
  options: readonly { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className={cx(css.segmented, size === 'sm' && css.segmentedSm)} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={cx(css.segment, o.value === value && css.segmentOn)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  wide?: boolean
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={cx(css.dialog, wide && css.dialogWide, 'paper')}
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open && (
        <div className={css.dialogBody}>
          <header className={css.dialogHeader}>
            <h2>{title}</h2>
            <button type="button" className={css.close} onClick={onClose} aria-label="close">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div className={css.dialogContent}>{children}</div>
          {footer && <footer className={css.dialogFooter}>{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

export function Button({
  children,
  onClick,
  variant = 'plain',
  disabled,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'plain' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} title={title} className={cx(css.button, css[`button_${variant}`])}>
      {children}
    </button>
  )
}

export function Odds({ probability, size }: { probability: number; size: 'sm' | 'lg' }) {
  const pct = roundPercent(probability)
  const tone = pct >= 100 ? css.oddsCertain : pct <= 0 ? css.oddsZero : pct > 50 ? css.oddsLikely : css.oddsUnlikely
  return (
    <span className={cx(css.odds, css[`odds_${size}`], tone)}>
      {pct}
      <small>%</small>
    </span>
  )
}
