// Interop with the VOICEVOX editor (.vvproj) and other singing-synth / score formats
// (MIDI, MusicXML, UST, USTX, SVP, VSQX, CCS, ufdata, ...) via utaformatix-ts, as the editor does.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { phonemeIndicesInNote, toPhonemeTimings, VALUE_INDICATING_NO_DATA } from './editor.js'
import { ENGINE_FRAME_RATE, isKanaLyric } from './music.js'
import { compilePitchCurves, compileVolumeCurves, type SingTrackResult, sourceKey } from './sing.js'
import type { RenderResult } from './song.js'
import type { SingTrack, Song, SongNote, TimeSignature } from './types.js'

export const TPQN = 480
export const DEFAULT_ENGINE_ID = '074fc39e-678b-4c13-8916-ffca8d505d1d'
/** Version written into exported projects; the editor migrates anything older. */
const PROJECT_APP_VERSION = '0.25.0'

// ---------------------------------------------------------------- .vvproj types (editor schema)

interface VvNote {
  id: string
  position: number
  duration: number
  noteNumber: number
  lyric: string | null
}

interface VvTrack {
  name: string
  singer?: { engineId: string; styleId: number }
  singingTeacher?: { styleId: number }
  keyRangeAdjustment: number
  volumeRangeAdjustment: number
  notes: VvNote[]
  pitchEditData: number[]
  volumeEditData: (number | null)[]
  phonemeTimingEditData: Record<string, { phonemeIndexInNote: number; offsetSeconds: number }[]>
  solo: boolean
  mute: boolean
  gain: number
  pan: number
}

export interface VvProject {
  appVersion: string
  talk: { audioKeys: string[]; audioItems: Record<string, unknown> }
  song: {
    tpqn: number
    tempos: { position: number; bpm: number }[]
    timeSignatures: { measureNumber: number; beats: number; beatType: number }[]
    tracks: Record<string, VvTrack>
    trackOrder: string[]
  }
}

const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))

// ---------------------------------------------------------------- export

/**
 * Build a .vvproj from a rendered song. Drawn edits are copied as-is; note-relative edits
 * (bend, vibrato, note volume) have no editor equivalent, so their result is baked into the
 * pitch / volume edit data from the rendered f0 and volume.
 */
export function songToVvproj(song: Song, result: RenderResult, engineId = DEFAULT_ENGINE_ID) {
  const warnings: string[] = []
  const tracks: Record<string, VvTrack> = {}
  const order: string[] = []

  song.tracks.forEach((track, i) => {
    if (track.type !== 'sing') {
      warnings.push(`Track ${i + 1} (${track.name ?? track.type}) is a ${track.type} track; .vvproj song tracks hold singing only, so it was left out.`)
      return
    }
    const res = result.sing.get(i)
    if (!res) return
    const id = randomUUID()
    tracks[id] = singTrackToVv(track, res, result, engineId, warnings, i)
    order.push(id)
  })
  if (order.length === 0) throw new Error('The song has no sing tracks to export')

  const tempos = [{ position: 0, bpm: song.bpm ?? 120 }]
  for (const t of song.tempo ?? []) if (t.beat > 0) tempos.push({ position: Math.round(t.beat * TPQN), bpm: t.bpm })
  tempos.sort((a, b) => a.position - b.position)

  const project: VvProject = {
    appVersion: PROJECT_APP_VERSION,
    talk: { audioKeys: [], audioItems: {} },
    song: {
      tpqn: TPQN,
      tempos,
      timeSignatures: withFirstBar(song.timeSignatures).map((t) => ({
        measureNumber: t.bar,
        beats: t.beats,
        beatType: t.beatType,
      })),
      tracks,
      trackOrder: order,
    },
  }
  const errors = validateVvproj(project)
  if (errors.length) throw new Error(`The song can't be represented as a VOICEVOX project: ${errors.join('; ')}`)
  return { project, warnings }
}

function withFirstBar(ts: TimeSignature[] | undefined): TimeSignature[] {
  const sorted = [...(ts ?? [])].sort((a, b) => a.bar - b.bar)
  if (sorted[0]?.bar !== 1) sorted.unshift({ bar: 1, beats: 4, beatType: 4 })
  return sorted
}

// Editor limits (src/song/domain.ts, src/song/music.ts)
const KEY_RANGE = [-28, 28] as const
const VOLUME_RANGE = [-20, 20] as const
const MIN_BPM = 40
const BEAT_TYPES = [2, 4, 8, 16, 32]

/** The checks the editor runs when it loads a song (isValidTpqn / Tempos / TimeSignatures / Track). */
export function validateVvproj(p: VvProject): string[] {
  const e: string[] = []
  const s = p.song
  const int = Number.isInteger
  if (!(int(s.tpqn) && BEAT_TYPES.every((b) => (s.tpqn * 4) % b === 0) && s.tpqn % 3 === 0)) e.push(`invalid tpqn ${s.tpqn}`)
  if (!s.tempos.length || s.tempos[0].position !== 0) e.push('first tempo must be at position 0')
  for (const t of s.tempos) {
    if (!int(t.position) || t.position < 0 || !Number.isFinite(t.bpm) || t.bpm < MIN_BPM) e.push(`tempo ${t.bpm} BPM at tick ${t.position} (editor minimum is ${MIN_BPM} BPM)`)
  }
  if (!s.timeSignatures.length || s.timeSignatures[0].measureNumber !== 1) e.push('first time signature must be at bar 1')
  for (const t of s.timeSignatures) {
    if (!int(t.measureNumber) || t.measureNumber < 1 || !int(t.beats) || t.beats < 1 || !BEAT_TYPES.includes(t.beatType)) {
      e.push(`time signature ${t.beats}/${t.beatType} at bar ${t.measureNumber} (beat type must be one of ${BEAT_TYPES.join(', ')})`)
    }
  }
  for (const [id, t] of Object.entries(s.tracks)) {
    const name = t.name || id
    if (!int(t.keyRangeAdjustment) || t.keyRangeAdjustment < KEY_RANGE[0] || t.keyRangeAdjustment > KEY_RANGE[1]) e.push(`${name}: keyRangeAdjustment ${t.keyRangeAdjustment}`)
    if (!int(t.volumeRangeAdjustment) || t.volumeRangeAdjustment < VOLUME_RANGE[0] || t.volumeRangeAdjustment > VOLUME_RANGE[1]) e.push(`${name}: volumeRangeAdjustment ${t.volumeRangeAdjustment}`)
    for (const n of t.notes) {
      if (!int(n.position) || !int(n.duration) || !int(n.noteNumber) || n.position < 0 || n.duration < 1 || n.noteNumber < 0 || n.noteNumber > 127) {
        e.push(`${name}: note at tick ${n.position} (pitch ${n.noteNumber}, length ${n.duration})`)
        break
      }
    }
    if (!t.pitchEditData.every((v) => Number.isFinite(v) && (v > 0 || v === VALUE_INDICATING_NO_DATA))) e.push(`${name}: pitch edit data`)
    if (!t.volumeEditData.every((v) => v === null || (Number.isFinite(v) && Number.isFinite(10 ** (v / 20))))) e.push(`${name}: volume edit data`)
  }
  return e
}

function clampInt(v: number, [lo, hi]: readonly [number, number], label: string, warnings: string[]): number {
  const c = Math.min(hi, Math.max(lo, Math.round(v)))
  if (c !== v) warnings.push(`${label} ${v} is outside the editor's range (${lo}..${hi} whole numbers); exported as ${c}, so the editor's render will differ.`)
  return c
}

function singTrackToVv(
  track: SingTrack,
  res: SingTrackResult,
  result: RenderResult,
  engineId: string,
  warnings: string[],
  index: number
): VvTrack {
  // One editor note per engine note (multi-mora notes become several notes).
  const idOf = new Map<string, string>()
  const notes: VvNote[] = res.engineNotes.map((n) => {
    const single = res.engineNotes.filter((m) => m.src === n.src).length === 1
    const id = single && n.src.src.id ? n.src.src.id : randomUUID()
    idOf.set(n.id, id)
    const position = Math.round(n.startBeat * TPQN)
    return {
      id,
      position,
      duration: Math.max(1, Math.round(n.endBeat * TPQN) - position),
      noteNumber: n.key,
      lyric: toHiragana(n.lyric),
    }
  })

  const pitch = compilePitchCurves(track.pitchCurves, track.pitchEditData, result.tempo)
  const volume = compileVolumeCurves(track.volumeCurves, track.volumeEditData, result.tempo)
  const gain = 10 ** ((track.volumeRangeAdjustment ?? 0) / 20)
  let baked = false
  const timingEdits: VvTrack['phonemeTimingEditData'] = {}

  for (const ph of res.phrases) {
    const start = Math.round(ph.start * ENGINE_FRAME_RATE)
    for (const f of ph.relPitchFrames) {
      const abs = start + f
      if (abs < 0 || !(ph.query.f0[f] > 0)) continue
      while (pitch.length <= abs) pitch.push(VALUE_INDICATING_NO_DATA)
      pitch[abs] = ph.query.f0[f]
      baked = true
    }
    for (const f of ph.relVolumeFrames) {
      const abs = start + f
      const base = ph.baseVolume[f] * gain
      if (abs < 0 || !(base > 0) || !(ph.query.volume[f] > 0)) continue
      while (volume.length <= abs) volume.push(null)
      volume[abs] = 20 * Math.log10(ph.query.volume[f] / base)
      baked = true
    }

    // Phoneme timing edits: ours index phonemes across a whole (possibly multi-mora) note;
    // the editor indexes per engine note.
    const timings = toPhonemeTimings(ph.query.phonemes)
    const groupIdx = phonemeIndicesInNote(timings, sourceKey)
    const localIdx = phonemeIndicesInNote(timings)
    for (const n of ph.notes) {
      if (!n.id.endsWith('#0')) continue // once per source note
      const src = n.src.src
      const edits = [...(src.phonemeTimings ?? [])]
      if (src.timingOffset) edits.push({ index: 0, offset: src.timingOffset })
      for (const e of edits) {
        let target: { noteId: string; local: number } | undefined
        let lastOfNote: { noteId: string; local: number } | undefined
        timings.forEach((t, k) => {
          if (!t.noteId || sourceKey(t.noteId) !== sourceKey(n.id) || t.phoneme === 'pau') return
          if (groupIdx[k] === e.index) target = { noteId: t.noteId, local: localIdx[k] }
          lastOfNote = { noteId: t.noteId, local: localIdx[k] }
        })
        if (!target && lastOfNote) target = { noteId: lastOfNote.noteId, local: lastOfNote.local + 1 }
        if (!target) continue
        const vvId = idOf.get(target.noteId)
        if (!vvId) continue
        ;(timingEdits[vvId] ??= []).push({ phonemeIndexInNote: target.local, offsetSeconds: e.offset })
      }
    }
  }
  if (baked) {
    warnings.push(
      `Track ${index + 1}: note bends / vibrato / note volume were baked into the editor's pitch and volume lines (they will not follow the notes if you move them in the editor).`
    )
  }

  return {
    name: track.name ?? `${res.singer.singerName}`,
    singer: { engineId, styleId: track.singer },
    singingTeacher: { styleId: res.teacher },
    keyRangeAdjustment: clampInt(res.keyRangeAdjustment, KEY_RANGE, `Track ${index + 1} keyRangeAdjustment`, warnings),
    volumeRangeAdjustment: clampInt(track.volumeRangeAdjustment ?? 0, VOLUME_RANGE, `Track ${index + 1} volumeRangeAdjustment`, warnings),
    notes,
    pitchEditData: trimTrailing(pitch, (v) => v === VALUE_INDICATING_NO_DATA),
    volumeEditData: trimTrailing(volume, (v) => v === null),
    phonemeTimingEditData: timingEdits,
    solo: track.solo ?? false,
    mute: track.mute ?? false,
    gain: track.volume ?? 1,
    pan: track.pan ?? 0,
  }
}

function trimTrailing<T>(a: T[], empty: (v: T) => boolean): T[] {
  let n = a.length
  while (n > 0 && empty(a[n - 1])) n--
  return a.slice(0, n)
}

// ---------------------------------------------------------------- import

interface ScoreNoteIn {
  id?: string
  position: number
  duration: number
  noteNumber: number
  lyric?: string | null
  phonemeTimings?: { index: number; offset: number }[]
}

interface ScoreTrackIn {
  name?: string
  notes: ScoreNoteIn[]
  singer?: number
  teacher?: number
  keyRangeAdjustment?: number
  volumeRangeAdjustment?: number
  pitchEditData?: number[]
  volumeEditData?: (number | null)[]
  mute?: boolean
  solo?: boolean
  volume?: number
  pan?: number
}

/** Turn positioned notes (ticks) into our sequential note list with rests; overlapping notes are dropped like the editor does. */
function buildTrack(t: ScoreTrackIn, tpqn: number, defaultSinger: number, warnings: string[], label: string): SingTrack {
  const sorted = [...t.notes].sort((a, b) => a.position - b.position)
  const notes: SongNote[] = []
  let cursor = 0
  let dropped = 0
  let badLyrics = 0
  for (const n of sorted) {
    if (n.position < cursor) {
      dropped++
      continue
    }
    if (n.position > cursor) notes.push({ pitch: null, beats: (n.position - cursor) / tpqn })
    let lyric = n.lyric ?? undefined
    if (lyric !== undefined && !isKanaLyric(lyric)) {
      badLyrics++
      lyric = undefined
    }
    const note: SongNote = { pitch: n.noteNumber, beats: n.duration / tpqn }
    if (n.id) note.id = n.id
    if (lyric) note.lyric = lyric
    if (n.phonemeTimings?.length) note.phonemeTimings = n.phonemeTimings
    notes.push(note)
    cursor = n.position + n.duration
  }
  if (dropped) warnings.push(`${label}: dropped ${dropped} overlapping note(s).`)
  if (badLyrics) warnings.push(`${label}: ${badLyrics} note(s) had non-kana lyrics and will use the default lyric.`)

  const track: SingTrack = { type: 'sing', name: t.name, singer: t.singer ?? defaultSinger, notes }
  if (t.teacher !== undefined) track.teacher = t.teacher
  if (t.keyRangeAdjustment !== undefined) track.keyRangeAdjustment = t.keyRangeAdjustment
  if (t.volumeRangeAdjustment) track.volumeRangeAdjustment = t.volumeRangeAdjustment
  if (t.pitchEditData?.some((v) => v !== VALUE_INDICATING_NO_DATA)) track.pitchEditData = t.pitchEditData
  if (t.volumeEditData?.some((v) => v !== null)) track.volumeEditData = t.volumeEditData
  if (t.mute) track.mute = true
  if (t.solo) track.solo = true
  if (t.volume !== undefined && t.volume !== 1) track.volume = t.volume
  if (t.pan) track.pan = t.pan
  return track
}

function tempoFields(tempos: { position: number; bpm: number }[], tpqn: number) {
  const sorted = [...tempos].sort((a, b) => a.position - b.position)
  const bpm = sorted[0]?.position === 0 ? sorted[0].bpm : 120
  const tempo = sorted.filter((t) => t.position > 0).map((t) => ({ beat: t.position / tpqn, bpm: t.bpm }))
  return tempo.length ? { bpm, tempo } : { bpm }
}

export function vvprojToSong(project: VvProject, defaultSinger: number, title?: string) {
  const s = project?.song
  if (!s || typeof s.tpqn !== 'number' || !s.tracks) throw new Error('Not a VOICEVOX project file (missing song section)')
  const warnings: string[] = []
  const order = s.trackOrder?.length ? s.trackOrder : Object.keys(s.tracks)
  const tracks = order.map((id, i) => {
    const t = s.tracks[id]
    const edits = t.phonemeTimingEditData ?? {}
    return buildTrack(
      {
        name: t.name,
        notes: t.notes.map((n) => ({
          ...n,
          phonemeTimings: (edits[n.id] ?? []).map((e) => ({ index: e.phonemeIndexInNote, offset: e.offsetSeconds })),
        })),
        singer: t.singer?.styleId,
        teacher: t.singingTeacher?.styleId,
        keyRangeAdjustment: t.keyRangeAdjustment,
        volumeRangeAdjustment: t.volumeRangeAdjustment,
        pitchEditData: t.pitchEditData,
        volumeEditData: t.volumeEditData,
        mute: t.mute,
        solo: t.solo,
        volume: t.gain,
        pan: t.pan,
      },
      s.tpqn,
      defaultSinger,
      warnings,
      `Track ${i + 1}`
    )
  })
  const song: Song = {
    title,
    ...tempoFields(s.tempos ?? [], s.tpqn),
    timeSignatures: (s.timeSignatures ?? []).map((t): TimeSignature => ({ bar: t.measureNumber, beats: t.beats, beatType: t.beatType })),
    tracks: tracks.filter((t) => t.notes?.length),
  }
  if (Object.keys(project.talk?.audioItems ?? {}).length) warnings.push('The talk (トーク) part of the project was not imported.')
  return { song, warnings }
}

/** Import any score / project format utaformatix understands (MIDI, MusicXML, UST, USTX, SVP, VSQX, CCS, ufdata, ...). */
export async function importScoreFile(data: Uint8Array, fileName: string, defaultSinger: number) {
  const { Project } = await import('@sevenc-nanashi/utaformatix-ts')
  const file = new File([new Uint8Array(data)], path.basename(fileName))
  const project = (await Project.fromAny(file)).convertJapaneseLyrics('auto', 'KanaCv', { convertVowelConnections: true })
  const p = project.data.project
  const warnings: string[] = []
  const tracks = p.tracks.map((t, i) =>
    buildTrack(
      {
        name: t.name || undefined,
        notes: t.notes.map((n) => ({ position: n.tickOn, duration: Math.max(1, n.tickOff - n.tickOn), noteNumber: n.key, lyric: n.lyric || null })),
      },
      TPQN, // utaformatix data is always 480 tpqn
      defaultSinger,
      warnings,
      `Track ${i + 1}`
    )
  )
  const song: Song = {
    title: p.name || path.parse(fileName).name,
    ...tempoFields(p.tempos.map((t) => ({ position: t.tickPosition, bpm: t.bpm })), TPQN),
    timeSignatures: p.timeSignatures.map((t) => ({ bar: t.measurePosition + 1, beats: t.numerator, beatType: t.denominator })),
    tracks: tracks.filter((t) => t.notes?.length),
  }
  return { song, warnings }
}
