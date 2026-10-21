/**
 * Spawn a RisuAI-NodeOnly server in isolation using a temporary save directory.
 *
 * Strategy: run `node <project>/server/node/server.cjs` with cwd set to a temp
 * directory.  The server resolves `save/` relative to cwd, but loads code via
 * __dirname, so no symlinks or copies are needed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server', 'node', 'server.cjs')

const TEST_PASSWORD = 'compat-test-pass'

export interface ServerHandle {
  port: number
  password: string
  cwd: string
  /** Everything the server has printed to stdout so far. */
  stdout: () => string
  /** Kill the server and clean up the temp directory. */
  cleanup: () => Promise<void>
}

/** Find a free port by binding to 0 and immediately closing. */
async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Unable to determine port')))
      }
    })
    srv.on('error', reject)
  })
}

export interface SpawnServerOptions {
  /** Extra env vars to pass to the spawned server process. */
  env?: Record<string, string>
  /**
   * Seed files into the temp `save/` directory BEFORE the server boots — e.g.
   * to plant an old hex-named save folder and exercise migrateFromSaveDir.
   * Receives the absolute path to the `save/` dir.
   */
  seedSave?: (saveDir: string) => Promise<void>
}

export async function spawnServer(opts: SpawnServerOptions = {}): Promise<ServerHandle> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-compat-'))
  await mkdir(path.join(tempDir, 'save'), { recursive: true })
  await mkdir(path.join(tempDir, 'backups'), { recursive: true })
  await writeFile(path.join(tempDir, 'save', '__password'), TEST_PASSWORD, 'utf-8')
  if (opts.seedSave) await opts.seedSave(path.join(tempDir, 'save'))

  let port = 0
  let child!: ChildProcess
  // Collect stderr for diagnostics on failure, stdout for tests that read logs
  let stderrBuf = ''
  let stdoutBuf = ''
  // On a loaded machine (the full suite runs files in parallel) the server can
  // take more than a few seconds to start, and the free port can be taken
  // between getFreePort and the listen: wait longer, and take a new port once
  // when it was (whole files failed for either, 2026-10-22).
  for (let attempt = 1; ; attempt++) {
    port = await getFreePort()
    stderrBuf = ''
    stdoutBuf = ''
    const started: ChildProcess = spawn(
      process.execPath,
      [SERVER_SCRIPT],
      {
        cwd: tempDir,
        env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    started.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
    started.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString() })

    try {
      // Wait for the server to print its "running" message
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Server did not start within 30 s.\nstderr: ${stderrBuf}`))
        }, 30_000)

        started.stdout?.on('data', () => {
          if (stdoutBuf.includes('[Server]') && stdoutBuf.includes('server is running')) {
            clearTimeout(timeout)
            resolve()
          }
        })

        started.on('error', (err) => { clearTimeout(timeout); reject(err) })
        started.on('exit', (code) => {
          clearTimeout(timeout)
          reject(new Error(`Server exited early with code ${code}.\nstderr: ${stderrBuf}`))
        })
      })
      child = started
      break
    } catch (error) {
      if (started.exitCode === null) started.kill('SIGKILL')
      if (attempt >= 2 || !/EADDRINUSE/.test(stderrBuf)) throw error
    }
  }

  // Track exit state via event listener (set up once, before any cleanup call)
  let exited = child.exitCode !== null
  child.on('exit', () => { exited = true })

  const cleanup = async () => {
    if (!exited) {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    await rm(tempDir, { recursive: true, force: true })
  }

  return { port, password: TEST_PASSWORD, cwd: tempDir, stdout: () => stdoutBuf, cleanup }
}
