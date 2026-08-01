export type HotkeyAction =
  | 'torrents'
  | 'blur'
  | 'compressor'
  | 'mirror'
  | 'reload'
  | 'speedDown'
  | 'speedReset'
  | 'speedUp'
  | 'logout'
  | 'toggleMenu'
  | 'theater'
  | 'dimming'
  | 'pip'
  | 'aspectRatio'
  | 'center'
  | 'overlay'
  | 'copyLink'

export type HotkeyMap = Record<HotkeyAction, string>

export interface HotkeyMeta {
  action: HotkeyAction
  label: string
  group: 'menu' | 'player'
  /** Registered via Electron globalShortcut */
  global: boolean
}

export const HOTKEY_META: HotkeyMeta[] = [
  { action: 'torrents', label: 'Полка (торренты)', group: 'menu', global: true },
  { action: 'blur', label: 'Блюр', group: 'menu', global: true },
  { action: 'compressor', label: 'Компрессор', group: 'menu', global: true },
  { action: 'mirror', label: 'Отражение / зеркало', group: 'menu', global: true },
  { action: 'reload', label: 'Обновить', group: 'menu', global: true },
  { action: 'speedDown', label: 'Скорость −0.25x', group: 'menu', global: true },
  { action: 'speedReset', label: 'Скорость 1.0x', group: 'menu', global: true },
  { action: 'speedUp', label: 'Скорость +0.25x', group: 'menu', global: true },
  { action: 'logout', label: 'Выйти', group: 'menu', global: true },
  { action: 'toggleMenu', label: 'Скрыть/показать меню', group: 'menu', global: true },
  { action: 'theater', label: 'Театральный режим', group: 'player', global: false },
  { action: 'dimming', label: 'Затемнение', group: 'player', global: false },
  { action: 'pip', label: 'Картинка в картинке', group: 'player', global: false },
  { action: 'aspectRatio', label: 'Соотношение сторон', group: 'player', global: false },
  { action: 'center', label: 'Центрировать плеер', group: 'player', global: false },
  { action: 'overlay', label: 'Оверлей', group: 'player', global: false },
  { action: 'copyLink', label: 'Копировать ссылку', group: 'player', global: false },
]

export const DEFAULT_HOTKEYS: HotkeyMap = {
  torrents: 'F1',
  blur: 'F2',
  compressor: 'F3',
  mirror: 'F4',
  reload: 'F5',
  speedDown: 'F6',
  speedReset: 'F7',
  speedUp: 'F8',
  logout: 'F9',
  toggleMenu: 'F10',
  theater: 'Alt+T',
  dimming: 'Alt+D',
  pip: 'Alt+P',
  aspectRatio: 'Alt+R',
  center: 'Alt+C',
  overlay: 'Alt+O',
  copyLink: 'Alt+L',
}

const STORE_KEY = 'hotkeys'

interface SimpleStore {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

export function normalizeHotkeys(raw: unknown): HotkeyMap {
  const result = { ...DEFAULT_HOTKEYS }
  if (!raw || typeof raw !== 'object') return result
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]) {
    const val = obj[key]
    if (typeof val === 'string') {
      result[key] = val.trim()
    }
  }
  return result
}

export function loadHotkeys(store: SimpleStore): HotkeyMap {
  return normalizeHotkeys(store.get(STORE_KEY))
}

export function saveHotkeys(store: SimpleStore, map: HotkeyMap): void {
  store.set(STORE_KEY, normalizeHotkeys(map))
}

/** Convert a KeyboardEvent into an Electron-style accelerator, or null if ignored. */
export function acceleratorFromEvent(e: {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): string | null {
  const key = e.key
  if (!key || key === 'Dead') return null
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null
  if (key === 'Escape') return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  let main = key.length === 1 ? key.toUpperCase() : key
  if (/^f\d{1,2}$/i.test(key)) main = key.toUpperCase()
  else if (key === ' ') main = 'Space'
  else if (key === 'ArrowUp') main = 'Up'
  else if (key === 'ArrowDown') main = 'Down'
  else if (key === 'ArrowLeft') main = 'Left'
  else if (key === 'ArrowRight') main = 'Right'
  else if (key === '+') main = 'Plus'
  else if (key.length === 1) main = key.toUpperCase()

  parts.push(main)
  return parts.join('+')
}

export function formatAccelerator(accel: string): string {
  if (!accel) return '—'
  return accel
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Command/gi, 'Cmd')
    .replace(/Control/gi, 'Ctrl')
}
