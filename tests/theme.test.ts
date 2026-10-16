import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const startup = html.match(/<script>([\s\S]*?)<\/script>/)![1]

test('tema inicial: preferencia guardada, sistema y almacenamiento bloqueado antes de React', () => {
  for (const saved of ['light', 'dark', null, 'invalid', 'blocked']) {
    for (const systemDark of [true, false]) {
      const document = { documentElement: { dataset: {} as Record<string, string> } }
      runInNewContext(startup, {
        document,
        localStorage: { getItem: (key: string) => {
          assert.equal(key, 'pasa-theme')
          if (saved === 'blocked') throw new Error('Storage disabled')
          return saved
        } },
        matchMedia: (query: string) => {
          assert.equal(query, '(prefers-color-scheme: dark)')
          return { matches: systemDark }
        },
      })
      assert.equal(document.documentElement.dataset.theme, saved === 'light' || saved === 'dark' ? saved : systemDark ? 'dark' : 'light')
    }
  }
  const document = { documentElement: { dataset: {} as Record<string, string> } }
  runInNewContext(startup, { document })
  assert.equal(document.documentElement.dataset.theme, 'light')
  assert.ok(html.indexOf('<script>') < html.indexOf('id="root"'))
})

function luminance(hex: string) {
  const [r, g, b] = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return .2126 * r + .7152 * g + .0722 * b
}
function contrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

test('paletas: contraste de texto 4.5:1 y controles/foco 3:1 en ambos temas', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  for (const block of css.split('}').slice(0, 2)) {
    const palette = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6})\b/g)].map(match => [match[1], match[2]]))
    const check = (fg: string, bg: string, minimum: number) => assert.ok(contrast(palette[fg], palette[bg]) >= minimum, `${fg}/${bg}: ${contrast(palette[fg], palette[bg])}`)
    for (const bg of ['page', 'surface', 'surface-soft', 'surface-blue', 'disabled-bg']) {
      for (const fg of ['text', 'heading', 'muted', 'link']) check(fg, bg, 4.5)
      check('focus', bg, 3)
      check('control-border', bg, 3)
    }
    for (const state of ['success', 'warning', 'error']) {
      check(`${state}-text`, `${state}-bg`, 4.5)
      check(`${state}-border`, `${state}-bg`, 3)
      check('link', `${state}-bg`, 4.5)
    }
    for (const bg of ['primary', 'primary-hover', 'brand']) check('on-primary', bg, 4.5)
  }
})
