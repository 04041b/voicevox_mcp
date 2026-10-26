// Lays a track's note list out on the song's tempo map.

import { parseBeats, parsePitch, parseScoreNotation, type TempoMap } from './music.js'
import type { SongNote } from './types.js'

export interface TimedNote {
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
