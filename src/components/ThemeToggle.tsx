import { useState } from 'react'

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')

  function toggle() {
    const theme = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('pasa-theme', theme) } catch { /* Keep the choice for this page when storage is unavailable. */ }
    setDark(!dark)
  }

  return <button type="button" className="secondary theme-toggle" onClick={toggle}>{dark ? 'Modo claro' : 'Modo oscuro'}</button>
}
