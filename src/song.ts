// Song rendering: sing / talk / synth / drum tracks laid on a shared tempo grid and mixed to one WAV.
//
// Singing follows the same pipeline as the official VOICEVOX editor:
//   split each sing track into phrases (runs of notes without rests)
//   -> sing_frame_audio_query with the singing teacher (keys shifted by -keyRangeAdjustment)
//   -> optional phoneme timing edits (+ sing_frame_f0 to re-predict pitch)
//   -> f0 shifted back by +keyRangeAdjustment, then user pitch edits (bend / vibrato)
//   -> sing_frame_volume, tail pause muted, user volume edits
//   -> frame_synthesis with the singer style.

import { createHash } from 'node:crypto'
import type { FrameAudioQuery, FramePhoneme, Score, ScoreNote, VoicevoxApi } from './api.js'
import { DRUM_CHARS, type DrumHit, type Envelope, renderDrum, renderTone, type Waveform } from './instruments.js'
import {
  ENGINE_FRAME_RATE,
  isKanaLyric,
  midiToName,
  parseBeats,
  parsePitch,
  parseScoreNotation,
  resolveLongVowels,
  splitMora,
  type TempoPoint,
  TempoMap,
} from './music.js'
import { defaultKeyRangeAdjustment, findSingerStyle, resolveTeacher } from './singers.js'
import { remember, SAMPLE_RATE, synthesizeTalk, type TalkOptions } from './tts.js'
import { decodeWav, durationSec, Mixer, type PcmAudio } from './wav.js'

// ---------------------------------------------------------------- spec types

export interface Vibrato {
  /** Depth in cents (peak deviation). Default 40. */
  depth?: number
  /** Rate in Hz. Default 5.5. */
  rate?: number
  /** Seconds after note start before vibrato begins. Default 0.3. */
  delay?: number
  /** Seconds to ramp vibrato depth in. Default 0.2. */
  fadeIn?: number
}

export interface SongNote {
  /** "C4", "F#3", MIDI number, or null / "R" for a rest. Synth tracks accept chords: "C4+E4+G4". */
  pitch?: string | number | null
  /** Kana lyric. Several mora split the note evenly ("きら"). "ー" holds the previous vowel. */
  lyric?: string
  /** Length in beats (quarter = 1) or note value ("8n", "4n.", "8t", "3/2"). Default 1. */
  beats?: number | string
  /** Volume multiplier for this note (sing: scales the volume curve; synth/drums: velocity). */
  volume?: number
  /** Constant pitch offset in cents (sing tracks). */
  pitchBend?: number
  /** Pitch curve: [[position 0..1 within note, cents], ...], linearly interpolated (sing tracks). */
  bend?: [number, number][]
  /** Per-note vibrato, or false to disable the track default. */
  vibrato?: Vibrato | false
  /** Shift the start of this note's first phoneme (consonant) in seconds; negative = earlier. */
  timingOffset?: number
}

interface BaseTrack {
  name?: string
  /** Linear gain. Default 1. */
  volume?: number
  /** -1 (left) .. 1 (right). Default 0. */
  pan?: number
  mute?: boolean
  /** Beat at which this track's note sequence starts. Default 0. */
  startBeat?: number
}

export interface SingTrack extends BaseTrack {
  type: 'sing'
  /** Singer style id from list_singers (e.g. 3003 = ずんだもん ノーマル, 6000 = 波音リツ ノーマル). */
  singer: number
  /** Singing-teacher style id. Default: the singer itself if it is a "sing" style, else the engine's first "sing" style. */
  teacher?: number
  notes?: SongNote[]
  /** Compact notation, see parseScoreNotation. Appended after `notes`. */
  score?: string
  /** Lyrics assigned one mora per note to notes without an explicit lyric. Kanji is converted to kana. */
  lyrics?: string
  /** Lyric used for notes that still have none. Default "ら". */
  defaultLyric?: string
  /** Semitones added to every note. */
  transpose?: number
  /** Editor "音域調整". Default is the editor's per-voice value. */
  keyRangeAdjustment?: number
  /** Editor "声量調整" in dB. Default 0. */
  volumeRangeAdjustment?: number
  /** Default vibrato for all notes (off unless set). */
  vibrato?: Vibrato | false
}

export interface TalkSegment extends Partial<TalkOptions> {
  /** Start position in beats. If omitted (and no atSeconds) the segment follows the previous one. */
  beat?: number
  /** Start position in seconds; overrides `beat`. */
  atSeconds?: number
  /** Gap after the previous segment when placed sequentially. Default 0.2 s. */
  gapSeconds?: number
}

export interface TalkTrack extends BaseTrack {
  type: 'talk'
  /** Default speaker for segments. */
  speaker?: number
  segments: TalkSegment[]
}

export interface SynthTrack extends BaseTrack, Envelope {
  type: 'synth'
  waveform?: Waveform
  notes?: SongNote[]
  score?: string
  transpose?: number
  /** Repeat the note sequence this many times. Default 1. */
  repeat?: number
}

export interface DrumTrack extends BaseTrack {
  type: 'drums'
  /**
   * Step pattern, one char per step: k=kick s=snare h=hat o=open hat c=clap t=tom C=crash, "-" or "." = rest.
   * Several voices on one step: "[kh]". Spaces and "|" are ignored.
   */
  pattern: string
  /** Beats per step. Default 0.5 (eighth notes). */
  stepBeats?: number
  /** Repeat the pattern this many times. Default 1. */
  repeat?: number
}

export type Track = SingTrack | TalkTrack | SynthTrack | DrumTrack

export interface Song {
  title?: string
  bpm?: number
  tempo?: TempoPoint[]
  tracks: Track[]
  /** Linear master gain. Default 1. */
  masterGain?: number
  /** Scale the mix down if it would clip. Default true. */
  normalize?: boolean
  /** Output stereo (pan works) or mono. Default true. */
  stereo?: boolean
}

export interface RenderContext {
  api: VoicevoxApi
  /** Speaker used to convert kanji lyrics to kana. */
  defaultTalkSpeaker: number
  /** Called with progress messages. */
  log?: (msg: string) => void
}

export interface TrackReport {
  name: string
  type: Track['type']
  start: number
  end: number
  detail: Record<string, unknown>
}

export interface RenderResult {
  audio: PcmAudio
  duration: number
  tracks: TrackReport[]
}

// ---------------------------------------------------------------- timing

interface TimedNote {
  index: number
  startBeat: number
  endBeat: number
  start: number
  end: number
  midis: number[] // empty = rest
  lyric?: string
  src: SongNote
}

export function collectNotes(track: { notes?: SongNote[]; score?: string }): SongNote[] {
  const notes = [...(track.notes ?? [])]
  if (track.score) {
    for (const t of parseScoreNotation(track.score)) notes.push({ pitch: t.pitch, lyric: t.lyric, beats: t.beats })
  }
  return notes
}

function parseMidis(pitch: SongNote['pitch']): number[] {
  if (typeof pitch === 'string' && pitch.includes('+')) {
    return pitch.split('+').map((p) => {
      const m = parsePitch(p)
      if (m === null) throw new Error(`Rest inside chord "${pitch}"`)
      return m
    })
  }
  const m = parsePitch(pitch)
  return m === null ? [] : [m]
}

export function layoutNotes(notes: SongNote[], tempo: TempoMap, startBeat: number, transpose = 0): TimedNote[] {
  let beat = startBeat
  return notes.map((src, index) => {
    const len = parseBeats(src.beats ?? 1)
    const midis = parseMidis(src.pitch).map((m) => m + transpose)
    const n: TimedNote = {
      index,
      startBeat: beat,
      endBeat: beat + len,
      start: tempo.beatToSec(beat),
      end: tempo.beatToSec(beat + len),
      midis,
      lyric: src.lyric,
      src,
    }
    beat += len
    return n
  })
}

// ---------------------------------------------------------------- sing

interface EngineNote {
  id: string
  key: number
  lyric: string
  start: number
  end: number
  src: TimedNote
}

const FIRST_REST_MIN_SEC = 0.12
const LAST_REST_SEC = 0.5
const FADE_OUT_SEC = 0.15

const singCache = new Map<string, Buffer>()

async function assignLyrics(ctx: RenderContext, notes: TimedNote[], track: SingTrack) {
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
    if (!n.lyric) n.lyric = track.defaultLyric ?? 'ら'
    if (!isKanaLyric(n.lyric)) {
      throw new Error(
        `Note ${n.index + 1} (${midiToName(n.midis[0])}) has lyric "${n.lyric}". Per-note lyrics must be kana; put kanji text in the track's "lyrics" field instead.`
      )
    }
  }
}

/** Kana lyrics are split directly; anything else is read by the talk engine first. */
async function lyricsToMora(ctx: RenderContext, lyrics: string): Promise<string[]> {
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
    mora.forEach((m, i) => {
      out.push({
        id: `n${n.index}_${i}`,
        key: n.midis[0],
        lyric: m,
        start: n.start + step * i,
        end: n.start + step * (i + 1),
        src: n,
      })
    })
  }
  const resolved = resolveLongVowels(out.map((n) => n.lyric))
  out.forEach((n, i) => {
    n.lyric = resolved[i]
  })
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

interface PhrasePlan {
  start: number // seconds, phrase audio start (includes first rest)
  score: Score
  /** Frame span of each source note (for pitch/volume edits). */
  spans: { src: TimedNote; from: number; to: number }[]
}

function planPhrase(phrase: EngineNote[], prevEnd: number | undefined, tempo: TempoMap, keyShift: number): PhrasePlan {
  const first = phrase[0]
  const quarter = 60 / tempo.bpmAt(first.src.startBeat)
  let rest = prevEnd === undefined ? (first.start <= 1e-6 ? quarter : first.start) : first.start - prevEnd
  rest = Math.max(Math.min(rest, quarter), FIRST_REST_MIN_SEC)
  const start = first.start - rest
  const frame = (t: number) => Math.round((t - start) * ENGINE_FRAME_RATE)

  const notes: ScoreNote[] = [{ key: null, frame_length: frame(first.start), lyric: '' }]
  for (const n of phrase) {
    notes.push({ id: n.id, key: n.key - keyShift, frame_length: frame(n.end) - frame(n.start), lyric: n.lyric })
  }
  notes.push({ key: null, frame_length: Math.round(LAST_REST_SEC * ENGINE_FRAME_RATE), lyric: '' })
  // Every note needs at least one frame; borrow from the following note.
  for (let i = 0; i < notes.length; i++) {
    const shift = Math.max(0, 1 - notes[i].frame_length)
    notes[i].frame_length += shift
    if (i < notes.length - 1) notes[i + 1].frame_length -= shift
  }

  const spans: PhrasePlan['spans'] = []
  for (const n of phrase) {
    const last = spans[spans.length - 1]
    if (last && last.src === n.src) last.to = frame(n.end)
    else spans.push({ src: n.src, from: frame(n.start), to: frame(n.end) })
  }
  return { start, score: { notes }, spans }
}

interface PhonemeTiming {
  phoneme: string
  noteId?: string | null
  start: number
  end: number
}

function toTimings(phonemes: FramePhoneme[]): PhonemeTiming[] {
  let f = 0
  return phonemes.map((p) => {
    const t = { phoneme: p.phoneme, noteId: p.note_id, start: f, end: f + p.frame_length }
    f += p.frame_length
    return t
  })
}

/** Apply per-note consonant offsets, keeping every phoneme >= 1 frame and the leading pau at frame 0. */
function applyTimingOffsets(query: FrameAudioQuery, offsets: Map<string, number>): boolean {
  if (offsets.size === 0) return false
  const t = toTimings(query.phonemes)
  for (let i = 1; i < t.length; i++) {
    const id = t[i].noteId
    if (!id || t[i - 1].noteId === id) continue
    const off = offsets.get(id)
    if (!off) continue
    t[i].start += Math.round(off * ENGINE_FRAME_RATE)
    t[i - 1].end = t[i].start
  }
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].start >= t[i].end) t[i].start = t[i].end - 1
    if (i > 0) t[i - 1].end = t[i].start
  }
  for (let i = 0; i < t.length; i++) {
    if (i === 0) t[i].start = 0
    if (t[i].start >= t[i].end) t[i].end = t[i].start + 1
    if (i < t.length - 1) t[i + 1].start = t[i].end
  }
  const total = query.f0.length
  query.phonemes = t.map((p) => ({ phoneme: p.phoneme, note_id: p.noteId, frame_length: p.end - p.start }))
  // Keep the total frame count unchanged by trimming/extending the trailing pau.
  const sum = query.phonemes.reduce((a, p) => a + p.frame_length, 0)
  const lastPau = query.phonemes[query.phonemes.length - 1]
  lastPau.frame_length = Math.max(1, lastPau.frame_length + (total - sum))
  return true
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

function applyPitchEdits(f0: number[], plan: PhrasePlan, trackVibrato: Vibrato | false | undefined): void {
  for (const span of plan.spans) {
    const src = span.src.src
    const vib = src.vibrato === undefined ? trackVibrato : src.vibrato
    const hasBend = src.pitchBend !== undefined || (src.bend?.length ?? 0) > 0
    if (!hasBend && !vib) continue
    const len = Math.max(1, span.to - span.from)
    for (let f = span.from; f < span.to && f < f0.length; f++) {
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
      f0[f] *= 2 ** (cents / 1200)
    }
  }
}

function muteTailPause(volume: number[], phonemes: FramePhoneme[]) {
  const last = phonemes[phonemes.length - 1]
  if (!last || last.phoneme !== 'pau') return
  const start = phonemes.slice(0, -1).reduce((a, p) => a + p.frame_length, 0)
  const fade = Math.min(last.frame_length, Math.round(FADE_OUT_SEC * ENGINE_FRAME_RATE))
  for (let i = 0; i < last.frame_length && start + i < volume.length; i++) {
    volume[start + i] *= i < fade ? (fade <= 1 ? 0.5 : 1 - i / (fade - 1)) : 0
  }
}

async function renderSingTrack(ctx: RenderContext, track: SingTrack, tempo: TempoMap) {
  const singer = await findSingerStyle(ctx.api, track.singer)
  if (!singer) throw new Error(`Singer style ${track.singer} not found. Use voicevox_list_singers to see valid ids.`)
  const teacher = track.teacher ?? (await resolveTeacher(ctx.api, singer))
  const keyShift = track.keyRangeAdjustment ?? defaultKeyRangeAdjustment(singer)
  const volGain = 10 ** ((track.volumeRangeAdjustment ?? 0) / 20)

  const notes = layoutNotes(collectNotes(track), tempo, track.startBeat ?? 0, track.transpose ?? 0)
  await assignLyrics(ctx, notes, track)
  const engineNotes = toEngineNotes(notes)
  if (engineNotes.length === 0) throw new Error(`Sing track "${track.name ?? ''}" has no sung notes`)
  for (const n of engineNotes) {
    if (n.key < 0 || n.key > 127) throw new Error(`Note ${n.src.index + 1} is out of MIDI range`)
  }
  const phrases = splitPhrases(engineNotes)

  const clips: { audio: PcmAudio; at: number }[] = []
  let prevEnd: number | undefined
  for (const [pi, phrase] of phrases.entries()) {
    const plan = planPhrase(phrase, prevEnd, tempo, keyShift)
    prevEnd = phrase[phrase.length - 1].end
    ctx.log?.(`sing "${track.name ?? singer.singerName}": phrase ${pi + 1}/${phrases.length}`)

    const edits = plan.spans.map((s) => ({
      v: s.src.src.vibrato === undefined ? track.vibrato : s.src.src.vibrato,
      b: s.src.src.pitchBend,
      c: s.src.src.bend,
      vol: s.src.src.volume,
      t: s.src.src.timingOffset,
    }))
    const key = createHash('sha1')
      .update(JSON.stringify([ctx.api.baseUrl, track.singer, teacher, keyShift, volGain, plan.score, edits]))
      .digest('hex')
    let wav = singCache.get(key)
    if (!wav) {
      wav = await synthesizePhrase(ctx, track, plan, { singer: track.singer, teacher, keyShift, volGain })
      remember(singCache, key, wav)
    }
    clips.push({ audio: decodeWav(wav), at: plan.start })
  }

  const detail = {
    singer: `${singer.singerName} (${singer.styleName}) #${singer.id}`,
    teacher,
    keyRangeAdjustment: keyShift,
    phrases: phrases.length,
    notes: engineNotes.length,
    lyrics: phrases.map((p) => p.map((n) => n.lyric).join('')).join(' / '),
    range: rangeOf(engineNotes.map((n) => n.key)),
  }
  return { clips, detail, start: engineNotes[0].start, end: engineNotes[engineNotes.length - 1].end }
}

async function synthesizePhrase(
  ctx: RenderContext,
  track: SingTrack,
  plan: PhrasePlan,
  o: { singer: number; teacher: number; keyShift: number; volGain: number }
): Promise<Buffer> {
  const { api } = ctx
  const query = await api.singFrameAudioQuery(plan.score, o.teacher)

  const offsets = new Map<string, number>()
  for (const s of plan.spans) {
    if (s.src.src.timingOffset) offsets.set(`n${s.src.index}_0`, s.src.src.timingOffset)
  }
  if (applyTimingOffsets(query, offsets)) {
    query.f0 = await api.singFrameF0(plan.score, query, o.teacher)
  }

  const up = 2 ** (o.keyShift / 12)
  const f0 = query.f0.map((v) => v * up)
  applyPitchEdits(f0, plan, track.vibrato)

  const volume = await api.singFrameVolume(
    plan.score,
    { ...query, f0: f0.map((v) => v / up) },
    o.teacher
  )
  muteTailPause(volume, query.phonemes)
  for (let i = 0; i < volume.length; i++) volume[i] = Math.max(0, volume[i]) * o.volGain
  for (const s of plan.spans) {
    const m = s.src.src.volume
    if (m === undefined || m === 1) continue
    for (let f = s.from; f < s.to && f < volume.length; f++) volume[f] *= Math.max(0, m)
  }

  return api.frameSynthesis(
    { ...query, f0, volume, volumeScale: 1, outputSamplingRate: SAMPLE_RATE, outputStereo: false },
    o.singer
  )
}

function rangeOf(keys: number[]): string {
  if (keys.length === 0) return '-'
  return `${midiToName(Math.min(...keys))}–${midiToName(Math.max(...keys))}`
}

// ---------------------------------------------------------------- talk

async function renderTalkTrack(ctx: RenderContext, track: TalkTrack, tempo: TempoMap) {
  const clips: { audio: PcmAudio; at: number }[] = []
  let cursor = tempo.beatToSec(track.startBeat ?? 0)
  const lines: string[] = []
  for (const [i, seg] of track.segments.entries()) {
    const speaker = seg.speaker ?? track.speaker ?? ctx.defaultTalkSpeaker
    ctx.log?.(`talk "${track.name ?? 'talk'}": segment ${i + 1}/${track.segments.length}`)
    const { wav } = await synthesizeTalk(ctx.api, { ...seg, speaker })
    const audio = decodeWav(wav)
    let at: number
    if (seg.atSeconds !== undefined) at = seg.atSeconds
    else if (seg.beat !== undefined) at = tempo.beatToSec(seg.beat)
    else at = i === 0 ? cursor : cursor + (seg.gapSeconds ?? 0.2)
    clips.push({ audio, at })
    cursor = at + durationSec(audio)
    lines.push(`${at.toFixed(2)}s ${seg.text ?? seg.kana ?? '(edited query)'}`)
  }
  const start = clips.length ? Math.min(...clips.map((c) => c.at)) : 0
  const end = Math.max(0, ...clips.map((c) => c.at + durationSec(c.audio)))
  return { clips, detail: { segments: lines }, start, end }
}

// ---------------------------------------------------------------- synth & drums

function renderSynthTrack(track: SynthTrack, tempo: TempoMap) {
  const seq = collectNotes(track)
  const clips: { audio: PcmAudio; at: number }[] = []
  let beat = track.startBeat ?? 0
  let end = 0
  const reps = Math.max(1, Math.floor(track.repeat ?? 1))
  for (let r = 0; r < reps; r++) {
    const timed = layoutNotes(seq, tempo, beat, track.transpose ?? 0)
    for (const n of timed) {
      if (n.midis.length === 0) continue
      const audio = renderTone(n.midis, n.end - n.start, SAMPLE_RATE, track.waveform ?? 'piano', n.src.volume ?? 1, track)
      clips.push({ audio, at: n.start })
      end = Math.max(end, n.end)
    }
    beat = timed.length ? timed[timed.length - 1].endBeat : beat
  }
  return {
    clips,
    detail: { waveform: track.waveform ?? 'piano', notes: clips.length },
    start: tempo.beatToSec(track.startBeat ?? 0),
    end,
  }
}

export function parseDrumPattern(pattern: string): DrumHit[][] {
  const steps: DrumHit[][] = []
  const s = pattern.replace(/[\s|]+/g, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '-' || ch === '.') steps.push([])
    else if (ch === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) throw new Error('Unclosed "[" in drum pattern')
      steps.push([...s.slice(i + 1, close)].map(drumHit))
      i = close
    } else steps.push([drumHit(ch)])
  }
  return steps
}

function drumHit(ch: string): DrumHit {
  const hit = DRUM_CHARS[ch]
  if (!hit) throw new Error(`Unknown drum symbol "${ch}". Use k s h o c t C, "-" for rest, [ks] for layers.`)
  return hit
}

function renderDrumTrack(track: DrumTrack, tempo: TempoMap) {
  const steps = parseDrumPattern(track.pattern)
  const stepBeats = track.stepBeats ?? 0.5
  const reps = Math.max(1, Math.floor(track.repeat ?? 1))
  const clips: { audio: PcmAudio; at: number }[] = []
  const cache = new Map<DrumHit, PcmAudio>()
  let beat = track.startBeat ?? 0
  for (let r = 0; r < reps; r++) {
    for (const step of steps) {
      for (const hit of step) {
        let audio = cache.get(hit)
        if (!audio) {
          audio = renderDrum(hit, SAMPLE_RATE)
          cache.set(hit, audio)
        }
        clips.push({ audio, at: tempo.beatToSec(beat) })
      }
      beat += stepBeats
    }
  }
  return {
    clips,
    detail: { steps: steps.length, repeat: reps, hits: clips.length },
    start: tempo.beatToSec(track.startBeat ?? 0),
    end: tempo.beatToSec(beat),
  }
}

// ---------------------------------------------------------------- song

export async function renderSong(ctx: RenderContext, song: Song): Promise<RenderResult> {
  if (!song.tracks?.length) throw new Error('Song has no tracks')
  const tempo = new TempoMap(song.bpm ?? 120, song.tempo)
  const placed: { audio: PcmAudio; at: number; gain: number; pan: number }[] = []
  const reports: TrackReport[] = []

  for (const [i, track] of song.tracks.entries()) {
    const name = track.name ?? `${track.type}${i + 1}`
    if (track.mute) {
      reports.push({ name, type: track.type, start: 0, end: 0, detail: { muted: true } })
      continue
    }
    let r: { clips: { audio: PcmAudio; at: number }[]; detail: Record<string, unknown>; start: number; end: number }
    try {
      switch (track.type) {
        case 'sing':
          r = await renderSingTrack(ctx, track, tempo)
          break
        case 'talk':
          r = await renderTalkTrack(ctx, track, tempo)
          break
        case 'synth':
          r = renderSynthTrack(track, tempo)
          break
        case 'drums':
          r = renderDrumTrack(track, tempo)
          break
        default:
          throw new Error(`Unknown track type "${(track as { type: string }).type}"`)
      }
    } catch (e) {
      throw new Error(`Track ${i + 1} (${name}): ${(e as Error).message}`)
    }
    for (const c of r.clips) placed.push({ ...c, gain: track.volume ?? 1, pan: track.pan ?? 0 })
    reports.push({ name, type: track.type, start: round(r.start), end: round(r.end), detail: r.detail })
  }

  // Phrase lead-ins can start before t=0; shift the whole song so nothing is cut.
  const lead = Math.max(0, -Math.min(0, ...placed.map((p) => p.at)))
  const mixer = new Mixer(SAMPLE_RATE)
  for (const p of placed) mixer.add(p.audio, p.at + lead, p.gain, p.pan)
  const audio = mixer.render({
    stereo: song.stereo ?? true,
    normalizePeak: song.normalize === false ? undefined : 0.98,
    masterGain: song.masterGain,
  })
  if (lead > 0) for (const r of reports) if (!r.detail.muted) ((r.start += lead), (r.end += lead))
  for (const r of reports) ((r.start = round(r.start)), (r.end = round(r.end)))
  return { audio, duration: round(durationSec(audio)), tracks: reports }
}

function round(n: number) {
  return Math.round(n * 1000) / 1000
}
