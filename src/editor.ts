// Ports of the VOICEVOX editor's song-editing algorithms (src/song/domain.ts, utility.ts,
// songTrackRendering.ts) so edits behave exactly as they do in the editor.

import type { FramePhoneme } from './api.js'
import { ENGINE_FRAME_RATE } from './music.js'

export const VALUE_INDICATING_NO_DATA = -1
export const UNVOICED_PHONEMES = ['pau', 'cl', 'ch', 'f', 'h', 'k', 'p', 's', 'sh', 't', 'ts']

export interface PhonemeTiming {
  noteId: string | null | undefined
  startFrame: number
  endFrame: number
  phoneme: string
}

export function toPhonemeTimings(phonemes: FramePhoneme[]): PhonemeTiming[] {
  let f = 0
  return phonemes.map((p) => {
    const t = { noteId: p.note_id, startFrame: f, endFrame: f + p.frame_length, phoneme: p.phoneme }
    f += p.frame_length
    return t
  })
}

export function toPhonemes(timings: PhonemeTiming[]): FramePhoneme[] {
  return timings.map((t) => ({ phoneme: t.phoneme, frame_length: t.endFrame - t.startFrame, note_id: t.noteId }))
}

/**
 * Index of each phoneme within its note. `groupOf` maps an engine note id to the note the
 * user edits (a multi-mora note is several engine notes but one editable note).
 */
export function phonemeIndicesInNote(
  phonemes: readonly { noteId?: string | null }[],
  groupOf: (noteId: string) => string = (id) => id
): number[] {
  const out: number[] = []
  let idx = 0
  for (let i = 0; i < phonemes.length; i++) {
    const g = phonemes[i].noteId ? groupOf(phonemes[i].noteId as string) : undefined
    const pg = i > 0 && phonemes[i - 1].noteId ? groupOf(phonemes[i - 1].noteId as string) : undefined
    idx = i === 0 || g !== pg ? 0 : idx + 1
    out.push(idx)
  }
  return out
}

export interface TimingEdit {
  phonemeIndexInNote: number
  offsetSeconds: number
}

/** editor: applyPhonemeTimingEdit */
export function applyPhonemeTimingEdit(
  timings: PhonemeTiming[],
  edits: Map<string, TimingEdit[]>,
  groupOf: (noteId: string) => string = (id) => id
) {
  if (edits.size === 0) return
  const indices = phonemeIndicesInNote(timings, groupOf)
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i]
    const prev = timings[i - 1]
    const next = timings[i + 1]
    if (t.phoneme === 'pau' || !t.noteId) continue
    const list = edits.get(groupOf(t.noteId))
    if (!list) continue
    for (const e of list) {
      const offset = Math.round(e.offsetSeconds * ENGINE_FRAME_RATE)
      if (e.phonemeIndexInNote === indices[i]) {
        t.startFrame += offset
        if (prev) prev.endFrame = t.startFrame
      } else if (e.phonemeIndexInNote === indices[i] + 1 && next?.phoneme === 'pau') {
        // The phrase-final pau counts as part of the last note.
        t.endFrame += offset
        next.startFrame = t.endFrame
      }
    }
  }
}

/** editor: adjustPhonemeTimings — keep phonemes >= 1 frame and the voiced span within bounds. */
export function adjustPhonemeTimings(
  timings: PhonemeTiming[],
  minNonPauseStartFrame: number | undefined,
  maxNonPauseEndFrame: number | undefined
) {
  for (let i = timings.length - 1; i >= 0; i--) {
    const t = timings[i]
    const prev = timings[i - 1]
    if (i === timings.length - 1 && maxNonPauseEndFrame !== undefined && t.startFrame > maxNonPauseEndFrame) {
      t.startFrame = maxNonPauseEndFrame
    }
    if (t.startFrame >= t.endFrame) t.startFrame = t.endFrame - 1
    if (prev) prev.endFrame = t.startFrame
  }
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i]
    const next = timings[i + 1]
    if (i === 0) {
      t.startFrame = 0
      if (minNonPauseStartFrame !== undefined && t.endFrame < minNonPauseStartFrame) t.endFrame = minNonPauseStartFrame
    }
    if (t.startFrame >= t.endFrame) t.endFrame = t.startFrame + 1
    if (next) next.startFrame = t.endFrame
  }
}

/** editor: interpByDiff — closer to `b` the larger b - a is. */
export function interpByDiff(a: number, b: number, k: number, p: number): number {
  const d = Math.max(0, b - a)
  return b - d / (d ** p * k + 1)
}

function smoothStep(x: number) {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}

/** editor: applySmoothTransitions (utility.ts) */
export function applySmoothTransitions(
  data: number[],
  jumpIndices: number[],
  constraints: { left: number; right: number }[]
) {
  for (let i = 0; i < jumpIndices.length; i++) {
    const jump = jumpIndices[i]
    const size = data[jump] - data[jump - 1]
    if (size === 0) continue
    const leftSpace = i === 0 ? jump : jump - jumpIndices[i - 1]
    const rightSpace = i === jumpIndices.length - 1 ? data.length - jump : jumpIndices[i + 1] - jump
    const left = Math.min(leftSpace, constraints[i].left)
    const right = Math.min(rightSpace, constraints[i].right)
    const center = jump - 0.5
    const start = center - left
    const end = center + right
    const total = left + right
    for (let j = Math.max(0, Math.ceil(start)); j < Math.min(data.length, Math.floor(end) + 1); j++) {
      const w = smoothStep((j - start) / total)
      if (j < center) data[j] += size * w
      else data[j] -= size * (1 - w)
    }
  }
}

function framePhonemes(phonemes: FramePhoneme[]): string[] {
  const out: string[] = []
  for (const p of phonemes) for (let i = 0; i < p.frame_length; i++) out.push(p.phoneme)
  return out
}

/**
 * editor: applyPitchEdit — overwrite f0 with the drawn pitch (Hz, song-time frames) in the log domain,
 * smoothing edit boundaries and moving transitions into unvoiced regions where possible.
 * Returns the frames (phrase-relative) that were changed.
 */
export function applyPitchEdit(
  f0: number[],
  phonemes: FramePhoneme[],
  phraseStartTime: number,
  pitchEditData: number[]
): Set<number> {
  const changed = new Set<number>()
  if (pitchEditData.length === 0) return changed
  const fp = framePhonemes(phonemes)
  const startFrame = Math.round(phraseStartTime * ENGINE_FRAME_RATE)
  const endFrame = startFrame + f0.length

  const ranges: { s: number; e: number }[] = []
  let cur: number | undefined
  for (let i = Math.max(0, startFrame); i < endFrame; i++) {
    if (f0[i - startFrame] >= 1e-5) {
      if (cur === undefined) cur = i
    } else if (cur !== undefined) {
      ranges.push({ s: cur, e: i })
      cur = undefined
    }
  }
  if (cur !== undefined) ranges.push({ s: cur, e: endFrame })

  const base = Math.round((60 / 1000) * ENGINE_FRAME_RATE)
  for (const { s, e } of ranges) {
    const info: { edited: boolean; voiced: boolean }[] = []
    const logF0: number[] = []
    const diff: number[] = []
    for (let i = s; i < e; i++) {
      const k = i - startFrame
      const voiced = !UNVOICED_PHONEMES.includes(fp[k])
      const v = voiced && i < pitchEditData.length ? pitchEditData[i] : VALUE_INDICATING_NO_DATA
      const edited = v !== VALUE_INDICATING_NO_DATA && v > 0
      const orig = Math.log(f0[k])
      info.push({ edited, voiced })
      logF0.push(orig)
      diff.push(edited ? Math.log(v) - orig : 0)
    }
    if (!info.some((x) => x.edited)) continue

    const jumps: number[] = []
    const cons: { left: number; right: number }[] = []
    for (let i = 1; i < info.length; i++) {
      if (info[i].edited === info[i - 1].edited) continue
      let left = Math.floor(base / 2)
      let right = Math.floor(base / 2)
      if (info[i].edited) {
        for (let d = 0; d < right && i - 1 - d >= 0; d++) {
          if (!info[i - 1 - d].voiced) {
            left += right - d
            right = d
            break
          }
        }
      } else {
        for (let d = 0; d < left && i + d < info.length; d++) {
          if (!info[i + d].voiced) {
            right += left - d
            left = d
            break
          }
        }
      }
      if (left !== 0 || right !== 0) {
        jumps.push(i)
        cons.push({ left, right })
      }
    }
    applySmoothTransitions(diff, jumps, cons)
    for (let i = 0; i < logF0.length; i++) {
      if (diff[i] === 0) continue
      const k = s + i - startFrame
      f0[k] = Math.exp(logF0[i] + diff[i])
      changed.add(k)
    }
  }
  return changed
}

/** editor: applyVolumeEdit — multiply by the drawn dB change, only inside the non-pau span. */
export function applyVolumeEdit(
  volume: number[],
  phraseStartTime: number,
  volumeEditData: (number | null)[],
  minNonPauseStartFrame: number | undefined,
  maxNonPauseEndFrame: number | undefined
): Set<number> {
  const changed = new Set<number>()
  const startFrame = Math.round(phraseStartTime * ENGINE_FRAME_RATE)
  const from = Math.max(0, startFrame + (minNonPauseStartFrame ?? 0))
  const to = Math.min(volumeEditData.length, startFrame + (maxNonPauseEndFrame ?? volume.length), startFrame + volume.length)
  for (let i = from; i < to; i++) {
    const db = volumeEditData[i]
    if (db === null || db === undefined) continue
    volume[i - startFrame] *= 10 ** (db / 20)
    changed.add(i - startFrame)
  }
  return changed
}

export function getDoremi(noteNumber: number): string {
  return ['ド', 'ド', 'レ', 'レ', 'ミ', 'ファ', 'ファ', 'ソ', 'ソ', 'ラ', 'ラ', 'シ'][((noteNumber % 12) + 12) % 12]
}
