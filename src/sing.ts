// Singing synthesis, following the VOICEVOX editor (src/song/songTrackRendering.ts) step by step:
//
//   phrases   = runs of notes without rests; first rest clamped to [0.12 s, one quarter], 0.5 s last rest,
//               plus the editor's min/max non-pause frames so neighbouring phrases don't overlap
//   query     = sing_frame_audio_query(teacher, keys - keyRangeAdjustment), phonemes adjusted to bounds
//   phonemes  = query phonemes + phoneme timing edits, adjusted again
//   pitch     = sing_frame_f0(teacher, edited phonemes) * 2^(keyRangeAdjustment/12)
//   f0        = pitch + drawn pitch edits (editor smoothing) + note bends / vibrato (our extension)
//   volume    = sing_frame_volume(teacher, f0 shifted back), tail pau faded out, clamped >= 0
//               + drawn volume edits (dB, non-pause span only) + note volume + volumeRangeAdjustment
//   audio     = frame_synthesis(singer)

import { createHash } from 'node:crypto'
import type { FrameAudioQuery, Score, ScoreNote, VoicevoxApi } from './api.js'
import {
  adjustPhonemeTimings,
  applyPhonemeTimingEdit,
  applyPitchEdit,
  applyVolumeEdit,
  getDoremi,
  interpByDiff,
  phonemeIndicesInNote,
  type TimingEdit,
  toPhonemes,
  toPhonemeTimings,
  UNVOICED_PHONEMES,
  VALUE_INDICATING_NO_DATA,
} from './editor.js'
import {
  ENGINE_FRAME_RATE,
  isKanaLyric,
  midiToHz,
  midiToName,
  parsePitch,
  resolveLongVowels,
  splitMora,
  type TempoMap,
} from './music.js'
import { defaultKeyRangeAdjustment, findSingerStyle, resolveTeacher, type SingerStyleInfo } from './singers.js'
import { collectNotes, layoutNotes, type TimedNote } from './timeline.js'
import { remember, SAMPLE_RATE } from './tts.js'
import type { PitchCurve, SingTrack, SongNote, Vibrato, VolumeCurve } from './types.js'
import { decodeWav, type PcmAudio } from './wav.js'

const FIRST_REST_MIN_SEC = 0.12
const LAST_REST_SEC = 0.5
const FADE_OUT_SEC = 0.15

export interface SingContext {
  api: VoicevoxApi
  defaultTalkSpeaker: number
  log?: (msg: string) => void
}

export interface EngineNote {
  /** Engine note id: `<source note key>#<mora index>` */
  id: string
  key: number
  lyric: string
  start: number
  end: number
  startBeat: number
  endBeat: number
  src: TimedNote
}

/** Everything known about a rendered phrase (used by inspect and .vvproj export). */
export interface RenderedPhrase {
  start: number
  notes: EngineNote[]
  /** Final query sent to frame_synthesis (edited phonemes, f0, volume). */
  query: FrameAudioQuery
  /** Phrase-relative frames whose f0 / volume differ from the prediction because of relative note edits. */
  relPitchFrames: number[]
  relVolumeFrames: number[]
  /** Predicted volume before any edits (for baking relative volume edits into dB). */
  baseVolume: number[]
}

export interface SingTrackResult {
  singer: SingerStyleInfo
  teacher: number
  keyRangeAdjustment: number
  notes: TimedNote[]
  engineNotes: EngineNote[]
  phrases: RenderedPhrase[]
  clips: { audio: PcmAudio; at: number }[]
  start: number
  end: number
}

const cache = new Map<string, { wav: Buffer; phrase: Omit<RenderedPhrase, 'notes'> }>()

/** Key of the editable note a phoneme belongs to (engine ids are `<key>#<mora>`). */
export const sourceKey = (engineId: string) => engineId.slice(0, engineId.lastIndexOf('#'))
const noteKey = (n: TimedNote) => n.src.id ?? `n${n.index}`

// ---------------------------------------------------------------- notes & lyrics

async function assignLyrics(ctx: SingContext, notes: TimedNote[], track: SingTrack) {
  const sung = notes.filter((n) => n.midis.length > 0)
  if (track.lyrics?.trim()) {
    const mora = await lyricsToMora(ctx, track.lyrics)
    const open = sung.filter((n) => !n.lyric)
    if (mora.length !== open.length) {
      throw new Error(
        `Lyrics have ${mora.length} mora (${mora.join(' ')}) but there are ${open.length} notes without a lyric. ` +
          'Each note takes one mora; add/remove notes, use "ー" to hold a vowel, or give some notes multi-mora lyrics.'
      )
    }
    open.forEach((n, i) => {
      n.lyric = mora[i]
    })
  }
  for (const n of sung) {
    if (!n.lyric) n.lyric = track.defaultLyric === 'doremi' ? getDoremi(n.midis[0]) : (track.defaultLyric ?? 'ら')
    if (!isKanaLyric(n.lyric)) {
      throw new Error(
        `Note ${n.index + 1} (${midiToName(n.midis[0])}) has lyric "${n.lyric}". Per-note lyrics must be kana; put kanji text in the track's "lyrics" field instead.`
      )
    }
  }
}

/** Kana lyrics are split directly; anything else is read by the talk engine first. */
async function lyricsToMora(ctx: SingContext, lyrics: string): Promise<string[]> {
  const parts = lyrics.split(/[\s、。,.!?！？「」『』()（）]+/).filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    if (isKanaLyric(part)) {
      out.push(...splitMora(part))
    } else {
      const phrases = await ctx.api.accentPhrases(part, ctx.defaultTalkSpeaker)
      for (const p of phrases) for (const m of p.moras) out.push(...splitMora(m.text))
    }
  }
  return out
}

function toEngineNotes(notes: TimedNote[]): EngineNote[] {
  const out: EngineNote[] = []
  for (const n of notes) {
    if (n.midis.length === 0) continue
    const mora = splitMora(n.lyric ?? '')
    if (mora.length === 0) throw new Error(`Note ${n.index + 1} has an empty lyric`)
    const step = (n.end - n.start) / mora.length
    const beatStep = (n.endBeat - n.startBeat) / mora.length
    mora.forEach((m, i) => {
      out.push({
        id: `${noteKey(n)}#${i}`,
        key: n.midis[0],
        lyric: m,
        start: n.start + step * i,
        end: n.start + step * (i + 1),
        startBeat: n.startBeat + beatStep * i,
        endBeat: n.startBeat + beatStep * (i + 1),
        src: n,
      })
    })
  }
  // The editor drops overlapping notes; sequential layout can't overlap, but keep the guarantee.
  const resolved = resolveLongVowels(out.map((n) => n.lyric))
  out.forEach((n, i) => {
    n.lyric = resolved[i]
  })
  for (const n of out) if (n.key < 0 || n.key > 127) throw new Error(`Note ${n.src.index + 1} is out of MIDI range`)
  return out
}

function splitPhrases(notes: EngineNote[]): EngineNote[][] {
  const phrases: EngineNote[][] = []
  for (const n of notes) {
    const cur = phrases[phrases.length - 1]
    const prev = cur?.[cur.length - 1]
    if (prev && n.start - prev.end < 1e-6) cur.push(n)
    else phrases.push([n])
  }
  return phrases
}

// ---------------------------------------------------------------- phrase planning

interface PhrasePlan {
  notes: EngineNote[]
  start: number
  score: Score
  minNonPauseStartFrame?: number
  maxNonPauseEndFrame?: number
}

function planPhrases(phrases: EngineNote[][], tempo: TempoMap, keyShift: number): PhrasePlan[] {
  const plans: PhrasePlan[] = []
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i]
    const first = phrase[0]
    const last = phrase[phrase.length - 1]
    const quarter = 60 / tempo.bpmAt(first.startBeat)
    const prevEnd = i > 0 ? phrases[i - 1][phrases[i - 1].length - 1].end : undefined
    let rest = prevEnd === undefined ? (first.start <= 1e-6 ? quarter : first.start) : first.start - prevEnd
    rest = Math.max(Math.min(rest, quarter), FIRST_REST_MIN_SEC)
    const start = first.start - rest
    const frame = (t: number) => Math.round(t * ENGINE_FRAME_RATE)

    const notes: ScoreNote[] = [{ key: null, frame_length: frame(first.start) - frame(start), lyric: '' }]
    for (const n of phrase) {
      notes.push({ id: n.id, key: n.key - keyShift, frame_length: frame(n.end) - frame(n.start), lyric: n.lyric })
    }
    notes.push({ key: null, frame_length: Math.round(LAST_REST_SEC * ENGINE_FRAME_RATE), lyric: '' })
    for (let j = 0; j < notes.length; j++) {
      const shift = Math.max(0, 1 - notes[j].frame_length)
      notes[j].frame_length += shift
      if (j < notes.length - 1) notes[j + 1].frame_length -= shift
    }

    const plan: PhrasePlan = { notes: phrase, start, score: { notes } }
    const prev = plans[i - 1]
    if (prev) {
      plan.minNonPauseStartFrame = Math.max(
        1,
        Math.round((prev.start - start) * ENGINE_FRAME_RATE + (prev.maxNonPauseEndFrame as number)) + 1
      )
    }
    const next = phrases[i + 1]
    if (next) {
      const minBoundary = interpByDiff(first.start, last.end, 7, 1)
      const boundary = interpByDiff(minBoundary, next[0].start, 3.5, 0.6)
      let max = Math.floor((boundary - start) * ENGINE_FRAME_RATE)
      if (plan.minNonPauseStartFrame !== undefined) max = Math.max(plan.minNonPauseStartFrame, max)
      plan.maxNonPauseEndFrame = max
    }
    plans.push(plan)
  }
  return plans
}

// ---------------------------------------------------------------- edit compilation

/** Compile drawn pitch curves (beats) into editor pitchEditData (Hz per song-time frame). */
export function compilePitchCurves(curves: PitchCurve[] | undefined, raw: number[] | undefined, tempo: TempoMap): number[] {
  const data = raw ? [...raw] : []
  for (const c of curves ?? []) {
    const pts = c.points
      .map(([beat, p]) => [tempo.beatToSec(beat) * ENGINE_FRAME_RATE, curvePitchToMidi(p)] as const)
      .sort((a, b) => a[0] - b[0])
    if (pts.length === 0) continue
    if (pts.length === 1) {
      setFrame(data, Math.round(pts[0][0]), midiToHz(pts[0][1]), VALUE_INDICATING_NO_DATA)
      continue
    }
    for (let k = 1; k < pts.length; k++) {
      const [f0, m0] = pts[k - 1]
      const [f1, m1] = pts[k]
      for (let f = Math.max(0, Math.round(f0)); f <= Math.round(f1); f++) {
        const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0)
        setFrame(data, f, midiToHz(m0 + (m1 - m0) * Math.min(1, Math.max(0, t))), VALUE_INDICATING_NO_DATA)
      }
    }
  }
  return data
}

export function compileVolumeCurves(
  curves: VolumeCurve[] | undefined,
  raw: (number | null)[] | undefined,
  tempo: TempoMap
): (number | null)[] {
  const data = raw ? [...raw] : []
  for (const c of curves ?? []) {
    const pts = c.points.map(([beat, db]) => [tempo.beatToSec(beat) * ENGINE_FRAME_RATE, db] as const).sort((a, b) => a[0] - b[0])
    for (let k = 1; k < pts.length; k++) {
      const [f0, d0] = pts[k - 1]
      const [f1, d1] = pts[k]
      for (let f = Math.max(0, Math.round(f0)); f <= Math.round(f1); f++) {
        const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0)
        setFrame(data, f, d0 + (d1 - d0) * Math.min(1, Math.max(0, t)), null)
      }
    }
    if (pts.length === 1) setFrame(data, Math.round(pts[0][0]), pts[0][1], null)
  }
  return data
}

function setFrame<T>(data: T[], i: number, v: T, fill: T) {
  while (data.length <= i) data.push(fill)
  data[i] = v
}

function curvePitchToMidi(p: string | number | { hz: number }): number {
  if (typeof p === 'object') return 69 + 12 * Math.log2(p.hz / 440)
  if (typeof p === 'number') return p
  const m = /^(.*?)([+-]\d+(?:\.\d+)?)c$/.exec(p.trim())
  const base = parsePitch(m ? m[1] : p)
  if (base === null) throw new Error(`Pitch curve point "${p}" is a rest`)
  return base + (m ? Number(m[2]) / 100 : 0)
}

function timingEdits(notes: TimedNote[]): Map<string, TimingEdit[]> {
  const map = new Map<string, TimingEdit[]>()
  for (const n of notes) {
    const list: TimingEdit[] = (n.src.phonemeTimings ?? []).map((e) => ({ phonemeIndexInNote: e.index, offsetSeconds: e.offset }))
    if (n.src.timingOffset) list.push({ phonemeIndexInNote: 0, offsetSeconds: n.src.timingOffset })
    if (list.length) map.set(noteKey(n), list)
  }
  return map
}

function bendCents(src: SongNote, pos: number): number {
  let c = src.pitchBend ?? 0
  const pts = src.bend
  if (pts && pts.length > 0) {
    const sorted = [...pts].sort((a, b) => a[0] - b[0])
    if (pos <= sorted[0][0]) c += sorted[0][1]
    else if (pos >= sorted[sorted.length - 1][0]) c += sorted[sorted.length - 1][1]
    else {
      for (let i = 1; i < sorted.length; i++) {
        const [p0, c0] = sorted[i - 1]
        const [p1, c1] = sorted[i]
        if (pos <= p1) {
          c += c0 + ((c1 - c0) * (pos - p0)) / (p1 - p0 || 1)
          break
        }
      }
    }
  }
  return c
}

/** Frame span [from, to) of each source note within a phrase. */
function noteSpans(plan: PhrasePlan) {
  const spans: { src: TimedNote; from: number; to: number }[] = []
  const rel = (t: number) => Math.round(t * ENGINE_FRAME_RATE) - Math.round(plan.start * ENGINE_FRAME_RATE)
  for (const n of plan.notes) {
    const last = spans[spans.length - 1]
    if (last && last.src === n.src) last.to = rel(n.end)
    else spans.push({ src: n.src, from: rel(n.start), to: rel(n.end) })
  }
  return spans
}

/** Note-relative pitch edits (bend, pitchBend, vibrato), on top of the editor's absolute edits. */
function applyRelativePitch(f0: number[], plan: PhrasePlan, trackVibrato: Vibrato | false | undefined): Set<number> {
  const changed = new Set<number>()
  for (const span of noteSpans(plan)) {
    const src = span.src.src
    const vib = src.vibrato === undefined ? trackVibrato : src.vibrato
    const hasBend = src.pitchBend !== undefined || (src.bend?.length ?? 0) > 0
    if (!hasBend && !vib) continue
    const len = Math.max(1, span.to - span.from)
    for (let f = Math.max(0, span.from); f < span.to && f < f0.length; f++) {
      if (f0[f] <= 0) continue
      let cents = hasBend ? bendCents(src, (f - span.from) / len) : 0
      if (vib) {
        const t = (f - span.from) / ENGINE_FRAME_RATE
        const delay = vib.delay ?? 0.3
        if (t > delay) {
          const ramp = Math.min(1, (t - delay) / Math.max(1e-3, vib.fadeIn ?? 0.2))
          // Fade vibrato out over the last 60 ms so it does not fight the next note's transition.
          const tail = Math.min(1, (span.to - f) / (0.06 * ENGINE_FRAME_RATE))
          cents += (vib.depth ?? 40) * ramp * tail * Math.sin(2 * Math.PI * (vib.rate ?? 5.5) * (t - delay))
        }
      }
      if (cents !== 0) {
        f0[f] *= 2 ** (cents / 1200)
        changed.add(f)
      }
    }
  }
  return changed
}

function muteTailPause(volume: number[], phonemes: { phoneme: string; frame_length: number }[]) {
  const last = phonemes[phonemes.length - 1]
  if (!last || last.phoneme !== 'pau') return
  const start = phonemes.slice(0, -1).reduce((a, p) => a + p.frame_length, 0)
  const fade = Math.min(last.frame_length, Math.max(0, Math.round(FADE_OUT_SEC * ENGINE_FRAME_RATE)))
  for (let i = 0; i < last.frame_length && start + i < volume.length; i++) {
    if (i < fade) volume[start + i] *= fade === 1 ? 0.5 : 1 - i / (fade - 1)
    else volume[start + i] = 0
  }
}

// ---------------------------------------------------------------- synthesis

interface TrackSettings {
  singer: number
  teacher: number
  keyShift: number
  volumeRangeAdjustment: number
  vibrato: Vibrato | false | undefined
  pitchEditData: number[]
  volumeEditData: (number | null)[]
  edits: Map<string, TimingEdit[]>
}

async function synthesizePhrase(api: VoicevoxApi, plan: PhrasePlan, s: TrackSettings) {
  const up = 2 ** (s.keyShift / 12)
  const group = (id: string) => sourceKey(id)

  // query
  const query = await api.singFrameAudioQuery(plan.score, s.teacher)
  const base = toPhonemeTimings(query.phonemes)
  adjustPhonemeTimings(base, plan.minNonPauseStartFrame, plan.maxNonPauseEndFrame)
  query.phonemes = toPhonemes(base)

  // phoneme timing edits
  const timings = toPhonemeTimings(query.phonemes)
  applyPhonemeTimingEdit(timings, s.edits, group)
  adjustPhonemeTimings(timings, plan.minNonPauseStartFrame, plan.maxNonPauseEndFrame)
  const phonemes = toPhonemes(timings)

  // pitch
  const predicted = await api.singFrameF0(plan.score, { ...query, phonemes }, s.teacher)
  const f0 = predicted.map((v) => v * up)
  applyPitchEdit(f0, phonemes, plan.start, s.pitchEditData)
  const relPitch = applyRelativePitch(f0, plan, s.vibrato)

  // volume
  const volume = await api.singFrameVolume(plan.score, { ...query, phonemes, f0: f0.map((v) => v / up) }, s.teacher)
  muteTailPause(volume, phonemes)
  for (let i = 0; i < volume.length; i++) volume[i] = Math.max(0, volume[i])
  const baseVolume = [...volume]
  applyVolumeEdit(volume, plan.start, s.volumeEditData, plan.minNonPauseStartFrame, plan.maxNonPauseEndFrame)
  const relVolume = new Set<number>()
  for (const span of noteSpans(plan)) {
    const m = span.src.src.volume
    if (m === undefined || m === 1) continue
    for (let f = Math.max(0, span.from); f < span.to && f < volume.length; f++) {
      volume[f] *= Math.max(0, m)
      relVolume.add(f)
    }
  }
  const gain = 10 ** (s.volumeRangeAdjustment / 20)
  for (let i = 0; i < volume.length; i++) volume[i] *= gain

  const final: FrameAudioQuery = {
    ...query,
    phonemes,
    f0,
    volume,
    volumeScale: 1,
    outputSamplingRate: SAMPLE_RATE,
    outputStereo: false,
  }
  const wav = await api.frameSynthesis(final, s.singer)
  return {
    wav,
    phrase: {
      start: plan.start,
      query: final,
      relPitchFrames: [...relPitch].sort((a, b) => a - b),
      relVolumeFrames: [...relVolume].sort((a, b) => a - b),
      baseVolume,
    },
  }
}

export async function renderSingTrack(ctx: SingContext, track: SingTrack, tempo: TempoMap): Promise<SingTrackResult> {
  const singer = await findSingerStyle(ctx.api, track.singer)
  if (!singer) throw new Error(`Singer style ${track.singer} not found. Use voicevox_list_singers to see valid ids.`)
  const teacher = track.teacher ?? (await resolveTeacher(ctx.api, singer))
  const keyShift = track.keyRangeAdjustment ?? defaultKeyRangeAdjustment(singer)

  const notes = layoutNotes(collectNotes(track), tempo, track.startBeat ?? 0, track.transpose ?? 0)
  await assignLyrics(ctx, notes, track)
  const engineNotes = toEngineNotes(notes)
  if (engineNotes.length === 0) throw new Error(`Sing track "${track.name ?? ''}" has no sung notes`)
  const plans = planPhrases(splitPhrases(engineNotes), tempo, keyShift)

  const settings: TrackSettings = {
    singer: track.singer,
    teacher,
    keyShift,
    volumeRangeAdjustment: track.volumeRangeAdjustment ?? 0,
    vibrato: track.vibrato,
    pitchEditData: compilePitchCurves(track.pitchCurves, track.pitchEditData, tempo),
    volumeEditData: compileVolumeCurves(track.volumeCurves, track.volumeEditData, tempo),
    edits: timingEdits(notes),
  }

  const phrases: RenderedPhrase[] = []
  const clips: SingTrackResult['clips'] = []
  for (const [i, plan] of plans.entries()) {
    ctx.log?.(`sing "${track.name ?? singer.singerName}": phrase ${i + 1}/${plans.length}`)
    const startFrame = Math.round(plan.start * ENGINE_FRAME_RATE)
    const total = plan.score.notes.reduce((a, n) => a + n.frame_length, 0)
    const ids = new Set(plan.notes.map((n) => sourceKey(n.id)))
    const key = createHash('sha1')
      .update(
        JSON.stringify([
          ctx.api.baseUrl,
          settings.singer,
          teacher,
          keyShift,
          settings.volumeRangeAdjustment,
          plan.score,
          plan.minNonPauseStartFrame,
          plan.maxNonPauseEndFrame,
          plan.notes.map((n) => [n.src.src.vibrato ?? settings.vibrato, n.src.src.bend, n.src.src.pitchBend, n.src.src.volume]),
          [...ids].map((id) => settings.edits.get(id)),
          settings.pitchEditData.slice(Math.max(0, startFrame), startFrame + total),
          settings.volumeEditData.slice(Math.max(0, startFrame), startFrame + total),
        ])
      )
      .digest('hex')
    let hit = cache.get(key)
    if (!hit) {
      hit = await synthesizePhrase(ctx.api, plan, settings)
      remember(cache, key, hit)
    }
    phrases.push({ ...hit.phrase, notes: plan.notes })
    clips.push({ audio: decodeWav(hit.wav), at: plan.start })
  }

  return {
    singer,
    teacher,
    keyRangeAdjustment: keyShift,
    notes,
    engineNotes,
    phrases,
    clips,
    start: engineNotes[0].start,
    end: engineNotes[engineNotes.length - 1].end,
  }
}

export function singDetail(r: SingTrackResult) {
  const keys = r.engineNotes.map((n) => n.key)
  return {
    singer: `${r.singer.singerName} (${r.singer.styleName}) #${r.singer.id}`,
    teacher: r.teacher,
    keyRangeAdjustment: r.keyRangeAdjustment,
    phrases: r.phrases.length,
    notes: r.engineNotes.length,
    lyrics: r.phrases.map((p) => p.notes.map((n) => n.lyric).join('')).join(' / '),
    range: `${midiToName(Math.min(...keys))}–${midiToName(Math.max(...keys))}`,
  }
}

// ---------------------------------------------------------------- inspection

export interface NoteInspection {
  note: number
  pitch: string
  lyric: string
  start: number
  end: number
  /** Median sung pitch vs the written note, in cents (null if unvoiced). */
  pitchErrorCents: number | null
  /** Phonemes with their editable index (for phonemeTimings) and times in song seconds. */
  phonemes: { index: number; phoneme: string; start: number; end: number }[]
}

/** The editor's piano-roll view: where each phoneme falls and how the pitch line sits on each note. */
export function inspectSingTrack(r: SingTrackResult): NoteInspection[] {
  const out = new Map<TimedNote, NoteInspection>()
  for (const ph of r.phrases) {
    const timings = toPhonemeTimings(ph.query.phonemes)
    const idx = phonemeIndicesInNote(timings, sourceKey)
    const byNote = new Map<string, TimedNote>(ph.notes.map((n) => [n.id, n.src]))
    timings.forEach((t, i) => {
      if (!t.noteId) return
      const src = byNote.get(t.noteId)
      if (!src) return
      let rec = out.get(src)
      if (!rec) {
        rec = {
          note: src.index + 1,
          pitch: midiToName(src.midis[0]),
          lyric: '',
          start: round(src.start),
          end: round(src.end),
          pitchErrorCents: null,
          phonemes: [],
        }
        out.set(src, rec)
      }
      rec.phonemes.push({
        index: idx[i],
        phoneme: t.phoneme,
        start: round(ph.start + t.startFrame / ENGINE_FRAME_RATE),
        end: round(ph.start + t.endFrame / ENGINE_FRAME_RATE),
      })
    })
    for (const n of ph.notes) {
      const rec = out.get(n.src)
      if (rec && !rec.lyric.endsWith(n.lyric)) rec.lyric += n.lyric
    }
    // pitch error over voiced frames inside each note's span
    const phStart = Math.round(ph.start * ENGINE_FRAME_RATE)
    const voiced = toFrameVoicing(ph.query.phonemes)
    for (const [src, rec] of out) {
      if (rec.pitchErrorCents !== null || !ph.notes.some((n) => n.src === src)) continue
      const from = Math.round(src.start * ENGINE_FRAME_RATE) - phStart
      const to = Math.round(src.end * ENGINE_FRAME_RATE) - phStart
      const target = midiToHz(src.midis[0])
      const cents: number[] = []
      for (let f = Math.max(0, from); f < Math.min(to, ph.query.f0.length); f++) {
        if (voiced[f] && ph.query.f0[f] > 0) cents.push(1200 * Math.log2(ph.query.f0[f] / target))
      }
      if (cents.length) rec.pitchErrorCents = Math.round(cents.sort((a, b) => a - b)[Math.floor(cents.length / 2)])
    }
  }
  return [...out.values()]
}

function toFrameVoicing(phonemes: { phoneme: string; frame_length: number }[]): boolean[] {
  const out: boolean[] = []
  for (const p of phonemes) for (let i = 0; i < p.frame_length; i++) out.push(!UNVOICED_PHONEMES.includes(p.phoneme))
  return out
}

function round(n: number) {
  return Math.round(n * 1000) / 1000
}
