// Every file in src/machines/ keeps the contract of docs/state-machines.md.
// No app, no build: `npm test`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'machines')
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort() : []

for (const file of files) {
  const exported = await import(pathToFileURL(path.join(dir, file)).href)

  for (const [name, machine] of Object.entries(exported)) {
    test(`${file}: ${name} keeps the contract`, () => {
      assert.equal(machine.id, name, 'id is the export name')
      assert.ok(Array.isArray(machine.states) && machine.states.length > 1, 'states is a list of two or more')
      assert.equal(new Set(machine.states).size, machine.states.length, 'no state is listed twice')
      assert.ok(machine.states.every(state => typeof state === 'string' && state), 'states are names')

      const first = machine.start()
      const second = machine.start()

      assert.ok(machine.states.includes(first.phase), `start() is in a listed state, not ${JSON.stringify(first.phase)}`)
      assert.notEqual(first, second, 'start() makes a new state each time')
      assert.deepEqual(first, second, 'start() always makes the same state')
      assert.equal(machine.step(first, { type: 'no such event' }, 0), first, 'an unknown event changes nothing and returns the same object')
      assert.deepEqual(first, second, 'step() does not write into the state it was given')
    })
  }
}

test('machine files export something', async () => {
  for (const file of files) {
    const exported = await import(pathToFileURL(path.join(dir, file)).href)

    assert.ok(Object.keys(exported).length > 0, `${file} exports no machine`)
  }
})
