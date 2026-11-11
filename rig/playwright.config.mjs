// Run through `node rig/run.mjs`, which sets the MG_RIG_* variables. The
// Playwright CLI comes from the Hermes checkout, so nothing is imported here:
// this repo has no node_modules.
import path from 'node:path'

const evidence = process.env.MG_RIG_EVIDENCE

if (!evidence) {
  throw new Error('MG_RIG_EVIDENCE is not set: start the rig with "node rig/run.mjs"')
}

export default {
  forbidOnly: true,
  fullyParallel: false,
  // Playwright's own artefacts go beside the screenshots, never into the repo.
  outputDir: path.join(evidence, 'pw-output'),
  reporter: [['line']],
  retries: 0,
  testDir: import.meta.dirname,
  testMatch: 'checks.spec.mjs',
  // One test holds the whole run; boot alone may take a minute on a cold machine.
  timeout: Number(process.env.MG_RIG_LIMIT_S || 600) * 1000 - 30_000,
  use: { screenshot: 'off', trace: 'off', video: 'off' },
  workers: 1
}
