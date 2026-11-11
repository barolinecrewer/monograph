// One rig run: boot a sandboxed Hermes, run check a (boot), then the checks of
// the suite named by MG_RIG_SUITE. Started by rig/run.mjs; see rig/README.md.
import { BOOT, bootCheck, declare, teardown, test, wrapUp } from './harness.mjs'

const name = process.env.MG_RIG_SUITE || 'core'

if (!/^[a-z0-9-]+$/.test(name)) {
  throw new Error(`MG_RIG_SUITE ${JSON.stringify(name)} is not a suite name`)
}

const suite = await import(`./suites/${name}.mjs`)

declare([BOOT, ...suite.checks])

test.afterAll(teardown)

test(`monograph rig: ${name}`, async () => {
  await bootCheck(suite)
  await suite.run()
  await wrapUp()
})
