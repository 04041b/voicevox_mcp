// Measures each singing edit against a running engine: `npx tsx scripts/verify-singing.ts`
import { VoicevoxApi } from '../src/api.js'
import { ENGINE_FRAME_RATE } from '../src/music.js'
import { inspectSingTrack } from '../src/sing.js'
import { renderSong, type Song } from '../src/song.js'

const api = new VoicevoxApi(process.env.VOICEVOX_URL ?? 'http://localhost:50021')
const ctx = { api, defaultTalkSpeaker: 3 }
let failed = 0
const check = (name: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, info)
  if (!ok) failed++
}

const base: Song = {
  bpm: 120,
  tracks: [{ type: 'sing', singer: 3003, score: 'C4:か:2 E4:さ:2 G4:た:2 R:1 C5:な:2' }],
}
const r0 = await renderSong(ctx, base)
const res0 = r0.sing.get(0)!

// 1. pitch curve: hold A4 over beats 2.5..3.5 (inside the E4 "さ" note, 1.25s..1.75s)
const curved: Song = structuredClone(base)
;(curved.tracks[0] as any).pitchCurves = [{ points: [[2.5, 'A4'], [3.5, 'A4']] }]
const r1 = await renderSong(ctx, curved)
const ph = r1.sing.get(0)!.phrases[0]
const phStart = Math.round(ph.start * ENGINE_FRAME_RATE)
const mid = Math.round(1.5 * ENGINE_FRAME_RATE) - phStart
const cents = 1200 * Math.log2(ph.query.f0[mid] / 440)
check('pitch curve holds A4 mid-edit', Math.abs(cents) < 5, { cents: cents.toFixed(2) })
// (frames outside the edit are covered by unit tests: engine predictions are stochastic between calls)

// 2. phoneme timing: move "s" of さ 0.1 s earlier
const timed: Song = structuredClone(base)
const t = timed.tracks[0] as any
t.notes = [{ pitch: 'C4', lyric: 'か', beats: 2 }, { pitch: 'E4', lyric: 'さ', beats: 2, phonemeTimings: [{ index: 0, offset: -0.1 }] }]
t.score = 'G4:た:2 R:1 C5:な:2'
const insp0 = inspectSingTrack(res0)
const insp2 = inspectSingTrack((await renderSong(ctx, timed)).sing.get(0)!)
const s0 = insp0[1].phonemes[0]
const s2 = insp2[1].phonemes[0]
const shift = Math.round((s0.start - s2.start) * ENGINE_FRAME_RATE)
check('phoneme timing moves consonant by round(0.1*93.75)=9 frames', shift === 9, { before: s0, after: s2 })

// 3. volume curve: -6 dB over the whole of note 3 (beats 4..6)
const vol: Song = structuredClone(base)
;(vol.tracks[0] as any).volumeCurves = [{ points: [[4, -6], [6, -6]] }]
const r3 = await renderSong(ctx, vol)
const p3 = r3.sing.get(0)!.phrases[0]
const f = Math.round(2.5 * ENGINE_FRAME_RATE) - phStart
check('volume curve scales frame by -6 dB', Math.abs(20 * Math.log10(p3.query.volume[f] / p3.baseVolume[f]) + 6) < 0.01, {
  ratio: (p3.query.volume[f] / p3.baseVolume[f]).toFixed(4),
})
const rms = (a: Float32Array, s: number, e: number) => {
  let x = 0
  for (let i = s; i < e; i++) x += a[i] * a[i]
  return Math.sqrt(x / (e - s))
}
const sr = 24000
const a = rms(r0.audio.channels[0], Math.round((2.2 + r0.lead) * sr), Math.round((2.8 + r0.lead) * sr))
const b = rms(r3.audio.channels[0], Math.round((2.2 + r3.lead) * sr), Math.round((2.8 + r3.lead) * sr))
check('audio RMS drops ~6 dB', Math.abs(20 * Math.log10(b / a) + 6) < 2, { dB: (20 * Math.log10(b / a)).toFixed(2) })

// 4. phrase bounds: two phrases, second's voiced start after first's voiced end
const p = res0.phrases
check('rest splits into 2 phrases', p.length === 2, {})
const firstVoicedEnd = p[0].start + (p[0].query.phonemes.slice(0, -1).reduce((x, y) => x + y.frame_length, 0)) / ENGINE_FRAME_RATE
const secondVoicedStart = p[1].start + p[1].query.phonemes[0].frame_length / ENGINE_FRAME_RATE
check('phrases do not overlap', secondVoicedStart > firstVoicedEnd, { firstVoicedEnd, secondVoicedStart })

// 5. pitch accuracy without edits
const errs = insp0.map((n) => n.pitchErrorCents)
check('unedited notes within 50 cents', errs.every((e) => e !== null && Math.abs(e) < 50), errs)

process.exit(failed ? 1 : 0)
