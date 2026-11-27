import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../extras/desktop-plugins/bloub-bots/plugin.js', import.meta.url), 'utf8')
const faceCode = source.slice(source.indexOf('const PRIMARY ='), source.indexOf('function adopt('))
const heroCode = source.slice(source.indexOf('let heroAv ='), source.indexOf('export default {'))

function face({ color = '#e8483f', shape = 'triangle', mood = 'idle' } = {}) {
  const attributes = { 'data-bot-face': 'default', 'data-hb-math': '1', 'data-hb-shape': shape, 'data-hb-mood': mood, width: '76' }
  return {
    getAttribute: key => attributes[key] ?? null,
    hasAttribute: key => key in attributes,
    querySelector: () => ({ getAttribute: () => color })
  }
}

test('the default profile preview reads the actual editor shape and color', () => {
  const readFace = runInNewContext(`${faceCode}\nreadFace`)
  const look = readFace(face())
  assert.equal(look.color, '#e8483f')
  assert.equal(look.shape, 'triangle')
  assert.equal(readFace(face({ color: 'not a color' })).color, '#f2f2f2')
})

test('an already mounted lead mascot reflects the saved roster avatar', () => {
  let svg = face({ shape: 'circle', color: '#f4f4f4' })
  const applied = []
  const list = {}
  const name = { textContent: 'Donna' }
  const hero = { parentElement: list, querySelector: () => name, hasAttribute: () => false }
  list.firstElementChild = hero
  const row = {
    offsetParent: {}, parentElement: list, className: '',
    querySelector: selector => selector.includes('data-bot-face') ? svg : selector === '.truncate.font-medium' ? name : null
  }
  const update = runInNewContext(`${faceCode}\n${heroCode}\nheroAv = { set: look => applied.push(look) }; renderHero`, {
    applied,
    __set() {}, visibleAdd: () => null,
    getComputedStyle: () => ({ overflowY: 'auto' }),
    document: { querySelector: () => row, querySelectorAll: () => [], getElementById: () => hero }
  })
  update()
  svg = face()
  update()
  assert.deepEqual(applied.map(({ color, shape }) => [color, shape]), [['#f4f4f4', 'circle'], ['#e8483f', 'triangle']])
})
