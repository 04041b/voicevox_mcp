// Local audio playback via whatever player the OS provides.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'

let current: ChildProcess | null = null

function which(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
  return r.status === 0
}

function playerCommand(file: string): [string, string[]] {
  const custom = process.env.VOICEVOX_PLAYER
  if (custom) {
    const parts = custom.split(' ').filter(Boolean)
    const args = parts.slice(1)
    return [parts[0], args.includes('{file}') ? args.map((a) => (a === '{file}' ? file : a)) : [...args, file]]
  }
  if (process.platform === 'darwin') return ['afplay', [file]]
  if (process.platform === 'win32') {
    const ps = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`
    return ['powershell', ['-NoProfile', '-Command', ps]]
  }
  for (const [cmd, args] of [
    ['paplay', [file]],
    ['pw-play', [file]],
    ['aplay', ['-q', file]],
    ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]],
    ['mpv', ['--no-video', '--really-quiet', file]],
  ] as [string, string[]][]) {
    if (which(cmd)) return [cmd, args]
  }
  throw new Error('No audio player found (install paplay/aplay/ffplay or set VOICEVOX_PLAYER)')
}

/** Play a WAV file. Stops whatever is currently playing. Resolves when playback ends if `wait`. */
export function playFile(file: string, wait = false): Promise<void> {
  stopPlayback()
  const [cmd, args] = playerCommand(file)
  const child = spawn(cmd, args, { stdio: 'ignore' })
  current = child
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => {
      if (current === child) current = null
      reject(e)
    })
    child.on('exit', () => {
      if (current === child) current = null
      resolve()
    })
  })
  if (wait) return done
  done.catch(() => {})
  return Promise.resolve()
}

export function stopPlayback(): boolean {
  if (!current) return false
  current.kill()
  current = null
  return true
}
