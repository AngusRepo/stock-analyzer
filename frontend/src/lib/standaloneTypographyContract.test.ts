import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const css = fs.readFileSync('src/components/observability/StandaloneJobRegistry.css', 'utf8').replace(/\r\n/g, '\n')

// 9a2001cb moved the registry from hardcoded hex/px to the shared theme tokens:
// titles 15px (.9375rem, --foreground), secondary text 13px (.8125rem, --muted-foreground).
assert(css.includes('.obs-standalone__group-header p { margin: 0; color: var(--foreground); font-size: .9375rem; font-weight: 600;'), 'group headings must use the homepage-aligned title role')
assert(css.includes('.obs-standalone__identity strong { display: block; overflow: hidden; color: var(--foreground); font-size: .9375rem; font-weight: 600;'), 'job names must use the homepage-aligned title role')
assert(css.includes('.obs-standalone__status { display: flex; flex: none; align-items: center; gap: 5px; color: var(--muted-foreground); font-size: .8125rem; font-weight: 600;'), 'job status must remain readable at the secondary-text size')
// 11/28 Wei 不收合規則：摘要全文換行，不截兩行。
assert(css.includes('.obs-standalone__summary { display: block; min-height: 44px;') && !/obs-standalone__summary[^}]*(line-clamp|max-height)/.test(css), 'summary shows the whole text, no two-line clamp')
assert(css.includes('font-size: .8125rem; line-height: 22px;'), 'summary body must use the readable 13px/22px role')
assert(css.includes('.obs-standalone__group-header > div > span { display: block; margin-top: 2px; color: var(--muted-foreground); font-size: .8125rem;'), 'group metadata must use the homepage secondary-text role')
assert(css.includes('.obs-standalone__identity span { display: block; margin-top: 2px; overflow: hidden; color: var(--muted-foreground); font-size: .8125rem;'), 'job ids must use the homepage secondary-text role')
assert(css.includes('.obs-standalone__timing dt { color: var(--muted-foreground); font-size: .8125rem;'), 'timing labels must use the homepage secondary-text role')

const fontSizesPx = [...css.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)].map(([, value, unit]) => Number(value) * (unit === 'rem' ? 16 : 1))
assert(fontSizesPx.length > 0 && fontSizesPx.every((px) => px >= 12), 'standalone card text must not render below the 12px homepage baseline')

console.log('standaloneTypographyContract: OK')
