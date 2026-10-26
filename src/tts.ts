// Talk (text-to-speech) rendering on top of the engine API.

import { createHash } from 'node:crypto'
import type { AccentPhrase, AudioQuery, VoicevoxApi } from './api.js'

export interface TalkOptions {
  /** Plain Japanese text (kanji ok). Ignored when `kana` or `accentPhrases` is given. */
  text?: string
  /** AquesTalk-style kana with accent marks, e.g. "コンニチワ'/セ'カイ". Gives full control over reading and accent. */
  kana?: string
  /** Fully edited accent phrases (as returned by the audio query tool). Highest priority. */
  accentPhrases?: AccentPhrase[]
  /** Recompute mora pitch/length from `accentPhrases` (needed after changing accent positions). Default true. */
  recalculate?: boolean
  speaker: number
  speedScale?: number
  pitchScale?: number
  intonationScale?: number
  volumeScale?: number
  prePhonemeLength?: number
  postPhonemeLength?: number
  pauseLengthScale?: number
}

export const SAMPLE_RATE = 24000

export async function buildAudioQuery(api: VoicevoxApi, opts: TalkOptions): Promise<AudioQuery> {
  let query: AudioQuery
  if (opts.accentPhrases) {
    query = baseQuery(
      opts.recalculate === false ? opts.accentPhrases : await api.moraData(opts.accentPhrases, opts.speaker)
    )
  } else if (opts.kana) {
    query = baseQuery(await api.accentPhrases(opts.kana, opts.speaker, true))
    query.kana = opts.kana
  } else if (opts.text?.trim()) {
    query = await api.audioQuery(opts.text, opts.speaker)
  } else {
    throw new Error('Provide text, kana or accentPhrases')
  }
  return applyTalkScales(query, opts)
}

export function applyTalkScales(query: AudioQuery, opts: Partial<TalkOptions>): AudioQuery {
  const q = { ...query, outputSamplingRate: SAMPLE_RATE, outputStereo: false }
  if (opts.speedScale !== undefined) q.speedScale = opts.speedScale
  if (opts.pitchScale !== undefined) q.pitchScale = opts.pitchScale
  if (opts.intonationScale !== undefined) q.intonationScale = opts.intonationScale
  if (opts.volumeScale !== undefined) q.volumeScale = opts.volumeScale
  if (opts.prePhonemeLength !== undefined) q.prePhonemeLength = opts.prePhonemeLength
  if (opts.postPhonemeLength !== undefined) q.postPhonemeLength = opts.postPhonemeLength
  if (opts.pauseLengthScale !== undefined) q.pauseLengthScale = opts.pauseLengthScale
  return q
}

function baseQuery(accent_phrases: AccentPhrase[]): AudioQuery {
  return {
    accent_phrases,
    speedScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    pauseLength: null,
    pauseLengthScale: 1,
    outputSamplingRate: SAMPLE_RATE,
    outputStereo: false,
  }
}

const cache = new Map<string, Buffer>()
const CACHE_LIMIT = 200

/** Synthesize a talk segment, memoized on the exact query so re-renders of a song are cheap. */
export async function synthesizeTalk(api: VoicevoxApi, opts: TalkOptions): Promise<{ wav: Buffer; query: AudioQuery }> {
  const query = await buildAudioQuery(api, opts)
  const wav = await synthesizeQuery(api, query, opts.speaker)
  return { wav, query }
}

export async function synthesizeQuery(api: VoicevoxApi, query: AudioQuery, speaker: number): Promise<Buffer> {
  const key = createHash('sha1').update(JSON.stringify([api.baseUrl, speaker, query])).digest('hex')
  const hit = cache.get(key)
  if (hit) return hit
  const wav = await api.synthesis(query, speaker)
  remember(cache, key, wav)
  return wav
}

export function remember<V>(map: Map<string, V>, key: string, value: V, limit = CACHE_LIMIT) {
  map.set(key, value)
  while (map.size > limit) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

/** Compact, editable view of a query: one entry per accent phrase. */
export function summarizeQuery(query: AudioQuery) {
  return query.accent_phrases.map((p, i) => ({
    phrase: i,
    reading: p.moras.map((m) => m.text).join(''),
    accent: p.accent,
    question: p.is_interrogative ?? false,
    pauseAfter: p.pause_mora ? Number(p.pause_mora.vowel_length.toFixed(3)) : 0,
    /** mora:pitch:length (s); pitch 0 = unvoiced */
    moras: p.moras
      .map((m) => `${m.text}:${m.pitch.toFixed(2)}:${((m.consonant_length ?? 0) + m.vowel_length).toFixed(3)}`)
      .join(' '),
  }))
}
