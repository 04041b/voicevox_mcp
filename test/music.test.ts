import { describe, expect, it } from 'vitest'
import {
  parseBeats,
  parsePitch,
  parseScoreNotation,
  resolveLongVowels,
  splitMora,
  TempoMap,
  midiToName,
} from '../src/music.js'

describe('parsePitch', () => {
  it('parses names, accidentals, numbers and rests', () => {
    expect(parsePitch('C4')).toBe(60)
    expect(parsePitch('A4')).toBe(69)
    expect(parsePitch('F#3')).toBe(54)
    expect(parsePitch('Bb4')).toBe(70)
    expect(parsePitch('c-1')).toBe(0)
    expect(parsePitch(64)).toBe(64)
    expect(parsePitch('62')).toBe(62)
    expect(parsePitch('R')).toBeNull()
    expect(parsePitch(null)).toBeNull()
    expect(() => parsePitch('H4')).toThrow(/Invalid pitch/)
  })
  it('round-trips names', () => {
    expect(midiToName(61)).toBe('C#4')
  })
})

describe('parseBeats', () => {
  it('accepts numbers, fractions and note values', () => {
    expect(parseBeats(2)).toBe(2)
    expect(parseBeats('3/2')).toBe(1.5)
    expect(parseBeats('4n')).toBe(1)
    expect(parseBeats('8n.')).toBe(0.75)
    expect(parseBeats('8t')).toBeCloseTo(1 / 3)
    expect(parseBeats('1n')).toBe(4)
    expect(() => parseBeats(0)).toThrow()
  })
})

describe('TempoMap', () => {
  it('handles tempo changes', () => {
    const t = new TempoMap(120, [{ beat: 4, bpm: 60 }])
    expect(t.beatToSec(2)).toBe(1)
    expect(t.beatToSec(4)).toBe(2)
    expect(t.beatToSec(5)).toBe(3)
    expect(t.bpmAt(4.5)).toBe(60)
  })
})

describe('mora handling', () => {
  it('splits kana into mora', () => {
    expect(splitMora('きゃっと')).toEqual(['キャ', 'ッ', 'ト'])
    expect(splitMora('ら ら、ら')).toEqual(['ラ', 'ラ', 'ラ'])
    expect(splitMora('ティー')).toEqual(['ティ', 'ー'])
  })
  it('resolves long vowels to the previous vowel', () => {
    expect(resolveLongVowels(['ラ', 'ー', 'キョ', 'ー', 'ン', 'ー'])).toEqual(['ラ', 'ア', 'キョ', 'オ', 'ン', 'ン'])
    expect(() => resolveLongVowels(['ー'])).toThrow()
  })
})

describe('parseScoreNotation', () => {
  it('parses pitch, lyric and length in any order after the pitch', () => {
    expect(parseScoreNotation('C4:ど:2 | R:0.5 D4 E4:1/2:み G4+B4:8n')).toEqual([
      { pitch: 'C4', lyric: 'ど', beats: 2 },
      { pitch: null, lyric: undefined, beats: 0.5 },
      { pitch: 'D4', lyric: undefined, beats: 1 },
      { pitch: 'E4', lyric: 'み', beats: 0.5 },
      { pitch: 'G4+B4', lyric: undefined, beats: 0.5 },
    ])
  })
  it('reports bad tokens', () => {
    expect(() => parseScoreNotation('Q4:ら')).toThrow(/Invalid pitch/)
  })
})
