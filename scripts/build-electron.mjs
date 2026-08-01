import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const projectDir = process.cwd()
const outputDir = path.join(projectDir, 'dist-electron')

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

await build({
  absWorkingDir: projectDir,
  // Keep the entry relative to absWorkingDir. On Windows, passing the same
  // path as an absolute entry can make esbuild resolve the drive root as an
  // external directory inside restricted build environments.
  entryPoints: ['./electron/main.ts'],
  outfile: path.join(outputDir, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  packages: 'external',
  logLevel: 'info',
})
