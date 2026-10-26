import os from 'node:os'
import path from 'node:path'

export interface Config {
  voicevoxUrl: string
  defaultSpeaker: number
  defaultSinger: number
  outputDir: string
  autoPlay: boolean
  timeoutMs: number
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === '' ? Number.NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback
  return !/^(0|false|no|off)$/i.test(v)
}

export function loadConfig(env = process.env): Config {
  return {
    voicevoxUrl: env.VOICEVOX_URL || 'http://localhost:50021',
    defaultSpeaker: num(env.VOICEVOX_DEFAULT_SPEAKER, 3), // ずんだもん ノーマル
    defaultSinger: num(env.VOICEVOX_DEFAULT_SINGER, 3003), // ずんだもん ノーマル (humming)
    outputDir: env.VOICEVOX_OUTPUT_DIR || path.join(os.tmpdir(), 'voicevox-mcp'),
    autoPlay: bool(env.VOICEVOX_AUTO_PLAY, true),
    timeoutMs: num(env.VOICEVOX_TIMEOUT_MS, 300_000),
  }
}
