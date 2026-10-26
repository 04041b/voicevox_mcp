// Song spec types shared by the renderer, the project import/export and the MCP schemas.

import type { Envelope, Waveform } from './instruments.js'
import type { TempoPoint } from './music.js'
import type { TalkOptions } from './tts.js'

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

/** Editor phoneme timing edit: move the start of the note's Nth phoneme (0 = first) by `offset` seconds. */
export interface PhonemeTimingEdit {
  index: number
  offset: number
}

export interface SongNote {
  /** Stable id (kept through .vvproj import/export). Optional. */
  id?: string
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
  /** Phoneme timing edits, indices as reported by voicevox_inspect_singing (sing tracks). */
  phonemeTimings?: PhonemeTimingEdit[]
  /** Shorthand for phonemeTimings [{index: 0, offset}] (moves the consonant). */
  timingOffset?: number
}

export interface BaseTrack {
  name?: string
  /** Linear gain. Default 1. */
  volume?: number
  /** -1 (left) .. 1 (right). Default 0. */
  pan?: number
  mute?: boolean
  /** When any track is solo, only solo tracks are rendered. */
  solo?: boolean
  /** Beat at which this track's note sequence starts. Default 0. */
  startBeat?: number
}

/** A pitch line drawn over time, like the editor's pitch pen: points are [beat, pitch]. */
export interface PitchCurve {
  /** [beat, pitch] where pitch is a note name ("A4"), a MIDI number (fractions allowed: 69.5) or {hz}. */
  points: [number, string | number | { hz: number }][]
}

/** A volume line drawn over time in dB relative to the predicted volume: points are [beat, dB]. */
export interface VolumeCurve {
  points: [number, number][]
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
  /** Lyric for notes that still have none: any kana, or "doremi" to sing the note name. Default "ら". */
  defaultLyric?: string
  /** Semitones added to every note. */
  transpose?: number
  /** Editor "音域調整". Default is the editor's per-voice value. */
  keyRangeAdjustment?: number
  /** Editor "声量調整" in dB. Default 0. */
  volumeRangeAdjustment?: number
  /** Default vibrato for all notes (off unless set). */
  vibrato?: Vibrato | false
  /** Drawn pitch lines (absolute pitch), applied with the editor's smoothing. */
  pitchCurves?: PitchCurve[]
  /** Drawn volume lines (dB). */
  volumeCurves?: VolumeCurve[]
  /** Raw editor pitch edit data: Hz per frame (93.75 fps from song time 0), -1 = no edit. Set by .vvproj import. */
  pitchEditData?: number[]
  /** Raw editor volume edit data: dB per frame, null = no edit. Set by .vvproj import. */
  volumeEditData?: (number | null)[]
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

export interface TimeSignature {
  /** 1-based bar number where this signature starts. */
  bar: number
  beats: number
  beatType: number
}

export interface Song {
  title?: string
  bpm?: number
  tempo?: TempoPoint[]
  /** Only used for .vvproj export (and kept from imports). Default 4/4. */
  timeSignatures?: TimeSignature[]
  tracks: Track[]
  /** Linear master gain. Default 1. */
  masterGain?: number
  /** Scale the mix down if it would clip. Default true. */
  normalize?: boolean
  /** Output stereo (pan works) or mono. Default true. */
  stereo?: boolean
}
