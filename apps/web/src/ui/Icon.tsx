import css from './Icon.module.css'

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  arrowRight: 'M5 12h13M13 6l6 6-6 6',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  close: 'M6 6l12 12M18 6L6 18',
} as const

export function Icon({ name, size }: { name: keyof typeof PATHS; size: number }) {
  return (
    <svg className={css.icon} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
