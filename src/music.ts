// Music helpers: pitch names, note lengths, tempo maps, kana/mora handling and
// the compact score notation agents can write by hand.

export const ENGINE_FRAME_RATE = 93.75 // 24000 Hz / 256 hop, fixed by the VOICEVOX engine

// ---------------------------------------------------------------- pitch

const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const REST_WORDS = new Set(['r', 'rest', '_', 'x'])

/** Parse "C4", "F#3", "Bb5", "60" or 60 into a MIDI note number (C4 = 60). `null` means rest. */
export function parsePitch(pitch: string | number | null | undefined): number | null {
  if (pitch === null || pitch === undefined) return null
  if (typeof pitch === 'number') {
    if (!Number.isFinite(pitch)) throw new Error(`Invalid pitch: ${pitch}`)
    return Math.round(pitch)
  }
  const s = pitch.trim()
  if (s === '' || REST_WORDS.has(s.toLowerCase())) return null
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10)
  const m = /^([A-Ga-g])([#♯sb♭]*)(-?\d+)$/.exec(s)
  if (!m) throw new Error(`Invalid pitch "${pitch}". Use names like C4, F#3, Bb4, a MIDI number, or R for a rest.`)
  let n = NOTE_OFFSETS[m[1].toLowerCase()]
  for (const ch of m[2]) n += ch === 'b' || ch === '♭' ? -1 : 1
  return n + (Number.parseInt(m[3], 10) + 1) * 12
}

export function midiToName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

// ---------------------------------------------------------------- length

/**
 * Parse a note length into beats (quarter note = 1 beat).
 * Accepts numbers (beats), fractions "3/2", and note values "4n" (quarter), "8n." (dotted eighth),
 * "8t" (eighth triplet), "1n" (whole).
 */
export function parseBeats(len: number | string): number {
  if (typeof len === 'number') {
    if (!(len > 0)) throw new Error(`Note length must be > 0, got ${len}`)
    return len
  }
  const s = len.trim()
  let m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s)
  if (m) return positive(Number(m[1]) / Number(m[2]), len)
  m = /^(\d+)(n|t)(\.*)$/.exec(s)
  if (m) {
    let beats = 4 / Number(m[1])
    if (m[2] === 't') beats *= 2 / 3
    let add = beats / 2
    for (let i = 0; i < m[3].length; i++) {
      beats += add
      add /= 2
    }
    return positive(beats, len)
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) return positive(Number(s), len)
  throw new Error(`Invalid note length "${len}". Use beats (1, 0.5, "3/2") or note values ("4n", "8n.", "8t").`)
}

function positive(v: number, src: unknown): number {
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`Note length must be > 0, got ${String(src)}`)
  return v
}

// ---------------------------------------------------------------- tempo

export interface TempoPoint {
  beat: number
  bpm: number
}

/** Piecewise-constant tempo map converting beat positions to seconds. */
export class TempoMap {
  private readonly points: { beat: number; bpm: number; sec: number }[]

  constructor(bpm: number, changes: TempoPoint[] = []) {
    if (!(bpm > 0)) throw new Error(`bpm must be > 0, got ${bpm}`)
    const sorted = [{ beat: 0, bpm }, ...changes.filter((c) => c.beat > 0)].sort((a, b) => a.beat - b.beat)
    this.points = []
    let sec = 0
    for (let i = 0; i < sorted.length; i++) {
      if (!(sorted[i].bpm > 0)) throw new Error(`bpm must be > 0, got ${sorted[i].bpm}`)
      if (i > 0) sec += ((sorted[i].beat - sorted[i - 1].beat) * 60) / sorted[i - 1].bpm
      this.points.push({ ...sorted[i], sec })
    }
  }

  beatToSec(beat: number): number {
    let p = this.points[0]
    for (const q of this.points) if (q.beat <= beat) p = q
    return p.sec + ((beat - p.beat) * 60) / p.bpm
  }

  bpmAt(beat: number): number {
    let p = this.points[0]
    for (const q of this.points) if (q.beat <= beat) p = q
    return p.bpm
  }
}

// ---------------------------------------------------------------- kana / mora

const SMALL_KANA = new Set([...'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ'])
const LONG_MARKS = new Set(['ー', '〜', '～', '-'])

export function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
}

export function isKanaLyric(s: string): boolean {
  return /^[ぁ-ゖァ-ヺー〜～\-ゔヴ]+$/.test(s)
}

/** Split kana into mora: "きゃっと" -> ["キャ", "ッ", "ト"]. Punctuation and spaces are dropped. */
export function splitMora(text: string): string[] {
  const out: string[] = []
  for (const ch of toKatakana(text)) {
    if (SMALL_KANA.has(ch) && out.length > 0 && !LONG_MARKS.has(out[out.length - 1])) {
      out[out.length - 1] += ch
    } else if (/[ァ-ヺ]/.test(ch) || LONG_MARKS.has(ch)) {
      out.push(LONG_MARKS.has(ch) ? 'ー' : ch)
    }
  }
  return out
}

const VOWEL_ROWS: Record<string, string> = {
  ア: 'アカガサザタダナハバパマヤラワァャヮ',
  イ: 'イキギシジチヂニヒビピミリィ',
  ウ: 'ウクグスズツヅヌフブプムユルゥュヴ',
  エ: 'エケゲセゼテデネヘベペメレェ',
  オ: 'オコゴソゾトドノホボポモヨロヲォョ',
}

/** The vowel kana a mora ends on ("キャ" -> "ア", "ン" -> "ン"). */
export function moraVowel(mora: string): string | undefined {
  const last = mora[mora.length - 1]
  if (last === 'ン') return 'ン'
  for (const [v, row] of Object.entries(VOWEL_ROWS)) if (row.includes(last)) return v
  return undefined
}

/**
 * Replace long-vowel marks with the preceding vowel so the engine accepts them
 * ("ー" after "ラ" becomes "ア"). Returns katakana lyrics.
 */
export function resolveLongVowels(lyrics: string[]): string[] {
  let prevVowel: string | undefined
  return lyrics.map((l) => {
    if (l === '') return l
    let k = toKatakana(l)
    if (k === 'ー') {
      if (!prevVowel) throw new Error('A long-vowel mark "ー" must follow a sung note')
      k = prevVowel
    }
    prevVowel = moraVowel(k) ?? prevVowel
    return k
  })
}

// ---------------------------------------------------------------- compact score notation

export interface ParsedToken {
  pitch: string | null
  lyric?: string
  beats: number
}

/**
 * Parse the compact score notation:
 *
 *   "C4:ど:1 D4:れ:1 E4:み:2 | R:1 G4:そ:0.5 G4:ー:1.5"
 *
 * Each token is `pitch[:lyric][:length]` (length in beats, default 1, or "8n"/"3/2" etc.).
 * Rests are `R[:length]`. `|` bar lines and newlines are ignored.
 * For chords (synth tracks) join pitches with "+": "C4+E4+G4:2".
 */
export function parseScoreNotation(score: string): ParsedToken[] {
  const tokens = score
    .split(/[\s|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  return tokens.map((tok) => {
    const parts = tok.split(':')
    const head = parts[0]
    const isRest = REST_WORDS.has(head.toLowerCase())
    let lyric: string | undefined
    let len: string | undefined
    for (const p of parts.slice(1)) {
      if (p === '') continue
      if (/^[\d./]+[nt]?\.*$/.test(p)) len = p
      else lyric = p
    }
    let beats: number
    try {
      beats = len === undefined ? 1 : parseBeats(len)
    } catch (e) {
      throw new Error(`Bad length in token "${tok}": ${(e as Error).message}`)
    }
    if (!isRest) {
      for (const p of head.split('+')) parsePitch(p) // validate early with a helpful error
    }
    return { pitch: isRest ? null : head, lyric: isRest ? undefined : lyric, beats }
  })
}
