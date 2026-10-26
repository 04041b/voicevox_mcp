import { describe, expect, it } from 'vitest'
import { parseDrumPattern } from '../src/song.js'
import { decodeWav, encodeWav, Mixer, resample } from '../src/wav.js'

describe('wav', () => {
  it('round-trips 16-bit PCM', () => {
    const ch = new Float32Array([0, 0.5, -0.5, 1, -1])
    const out = decodeWav(encodeWav({ sampleRate: 24000, channels: [ch] }))
    expect(out.sampleRate).toBe(24000)
    expect(Array.from(out.channels[0]).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1])
  })

  it('resamples length proportionally', () => {
    const a = resample({ sampleRate: 48000, channels: [new Float32Array(4800)] }, 24000)
    expect(a.channels[0].length).toBe(2400)
  })

  it('mixes with offset, pan and normalization', () => {
    const m = new Mixer(10)
    m.add({ sampleRate: 10, channels: [new Float32Array([1, 1])] }, 0.5, 1, -1)
    m.add({ sampleRate: 10, channels: [new Float32Array([1])] }, -1) // entirely before t=0: dropped
    const out = m.render({ normalizePeak: 0.5 })
    expect(out.channels[0].length).toBe(7)
    expect(out.channels[0][5]).toBeCloseTo(0.5)
    expect(out.channels[1][5]).toBeCloseTo(0)
  })
})

describe('drum pattern', () => {
  it('parses steps, rests and layers', () => {
    expect(parseDrumPattern('k-[kh] s|.')).toEqual([['kick'], [], ['kick', 'hat'], ['snare'], []])
    expect(() => parseDrumPattern('z')).toThrow(/Unknown drum/)
  })
})
