import { describe, expect, it } from 'vitest'
import {
  adjustPhonemeTimings,
  applyPhonemeTimingEdit,
  applyPitchEdit,
  applyVolumeEdit,
  getDoremi,
  interpByDiff,
  phonemeIndicesInNote,
  toPhonemes,
  toPhonemeTimings,
} from '../src/editor.js'
import { TempoMap } from '../src/music.js'
import { compilePitchCurves, compileVolumeCurves } from '../src/sing.js'

const ph = (list: [string, number, string | null][]) => list.map(([phoneme, frame_length, note_id]) => ({ phoneme, frame_length, note_id }))

describe('phoneme timing edits', () => {
  const phonemes = ph([
    ['pau', 10, null],
    ['k', 4, 'a#0'],
    ['a', 20, 'a#0'],
    ['r', 3, 'a#1'],
    ['a', 20, 'a#1'],
    ['pau', 10, null],
  ])

  it('indexes phonemes per note, optionally grouping engine notes', () => {
    expect(phonemeIndicesInNote(toPhonemeTimings(phonemes))).toEqual([0, 0, 1, 0, 1, 0])
    expect(phonemeIndicesInNote(toPhonemeTimings(phonemes), (id) => id.split('#')[0])).toEqual([0, 0, 1, 2, 3, 0])
  })

  it('moves a phoneme start and keeps neighbours contiguous', () => {
    const t = toPhonemeTimings(phonemes)
    applyPhonemeTimingEdit(t, new Map([['a', [{ phonemeIndexInNote: 2, offsetSeconds: -2 / 93.75 }]]]), (id) => id.split('#')[0])
    adjustPhonemeTimings(t, undefined, undefined)
    expect(toPhonemes(t).map((p) => p.frame_length)).toEqual([10, 4, 18, 5, 20, 10])
  })

  it('index past the last phoneme moves the end into the final pau', () => {
    const t = toPhonemeTimings(phonemes)
    applyPhonemeTimingEdit(t, new Map([['a#1', [{ phonemeIndexInNote: 2, offsetSeconds: 5 / 93.75 }]]]))
    expect(toPhonemes(t).map((p) => p.frame_length)).toEqual([10, 4, 20, 3, 25, 5])
  })

  it('adjust enforces >=1 frame and the min/max non-pause bounds', () => {
    const t = toPhonemeTimings(phonemes)
    adjustPhonemeTimings(t, 12, 50)
    const out = toPhonemes(t).map((p) => p.frame_length)
    expect(out[0]).toBe(12)
    expect(out.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(50)
    expect(out.every((n) => n >= 1)).toBe(true)
  })
})

describe('applyPitchEdit', () => {
  it('sets edited frames exactly, smooths the edges and leaves the rest', () => {
    const f0 = Array(100).fill(200)
    const phonemes = ph([['a', 100, 'n#0']])
    const edit = Array(100).fill(-1)
    for (let i = 40; i < 60; i++) edit[i] = 400
    const changed = applyPitchEdit(f0, phonemes, 0, edit)
    expect(f0[50]).toBeCloseTo(400)
    expect(f0[10]).toBe(200)
    expect(f0[90]).toBe(200)
    // smoothing: the frame just before the edit is between the two values
    expect(f0[39]).toBeGreaterThan(200)
    expect(f0[39]).toBeLessThan(400)
    expect(changed.has(50)).toBe(true)
  })

  it('uses song-time frames (phrase offset) and ignores unvoiced phonemes', () => {
    const f0 = Array(20).fill(100)
    const phonemes = ph([['s', 10, 'n#0'], ['a', 10, 'n#0']])
    const edit = Array(200).fill(-1)
    for (let i = 100; i < 120; i++) edit[i] = 150
    applyPitchEdit(f0, phonemes, 100 / 93.75, edit)
    expect(f0[2]).toBeLessThan(150) // "s" is unvoiced: no edit data there
    expect(f0[15]).toBeCloseTo(150)
  })
})

describe('applyVolumeEdit', () => {
  it('applies dB only inside the non-pause span', () => {
    const v = Array(10).fill(1)
    applyVolumeEdit(v, 0, Array(10).fill(-6), 2, 8)
    expect(v[1]).toBe(1)
    expect(v[2]).toBeCloseTo(0.501, 2)
    expect(v[8]).toBe(1)
  })
})

describe('curves', () => {
  const tempo = new TempoMap(60) // 1 beat = 1 s = 93.75 frames
  it('compiles pitch curves to Hz per frame, interpolating in semitones', () => {
    const d = compilePitchCurves([{ points: [[0, 'A4'], [1, 'A5']] }], undefined, tempo)
    expect(d[0]).toBeCloseTo(440)
    expect(d[47] / (440 * Math.SQRT2)).toBeCloseTo(1, 2)
    expect(d[94]).toBeCloseTo(880, 0)
    expect(compilePitchCurves([{ points: [[0, 'A4+100c']] }], undefined, tempo)[0]).toBeCloseTo(466.16, 1)
    expect(compilePitchCurves([{ points: [[0, { hz: 300 }]] }], undefined, tempo)[0]).toBe(300)
  })
  it('compiles volume curves and keeps raw data elsewhere', () => {
    const d = compileVolumeCurves([{ points: [[1, -6], [2, 0]] }], [3], tempo)
    expect(d[0]).toBe(3)
    expect(d[1]).toBeNull()
    expect(d[94]).toBeCloseTo(-6, 1)
  })
})

describe('misc', () => {
  it('interpByDiff approaches b for large differences', () => {
    expect(interpByDiff(0, 0, 7, 1)).toBe(0)
    expect(interpByDiff(0, 10, 7, 1)).toBeCloseTo(10 - 10 / 71)
  })
  it('doremi lyrics follow the pitch class', () => {
    expect([60, 62, 65, 71].map(getDoremi)).toEqual(['ド', 'レ', 'ファ', 'シ'])
  })
})
