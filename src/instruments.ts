// Tiny built-in instruments so a song can carry its own backing track.

import { midiToHz } from './music.js'
import type { PcmAudio } from './wav.js'

export type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'piano' | 'organ' | 'bass'

export interface Envelope {
  attack?: number
  decay?: number
  sustain?: number
  release?: number
}

const ENVELOPES: Record<Waveform, Required<Envelope>> = {
  sine: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.08 },
  triangle: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.08 },
  square: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.06 },
  sawtooth: { attack: 0.02, decay: 0.15, sustain: 0.6, release: 0.1 },
  piano: { attack: 0.003, decay: 0.9, sustain: 0.15, release: 0.25 },
  organ: { attack: 0.02, decay: 0.05, sustain: 0.9, release: 0.06 },
  bass: { attack: 0.005, decay: 0.25, sustain: 0.5, release: 0.08 },
}

/** Harmonic amplitudes per waveform (band-limited additive synthesis avoids aliasing). */
function harmonics(wave: Waveform, freq: number, sampleRate: number): [number, number][] {
  const maxH = Math.max(1, Math.floor(sampleRate / 2 / freq) - 1)
  const out: [number, number][] = []
  switch (wave) {
    case 'sine':
      return [[1, 1]]
    case 'organ':
      return (
        [
          [1, 1],
          [2, 0.5],
          [3, 0.3],
          [4, 0.2],
          [6, 0.1],
        ] as [number, number][]
      ).filter(([h]) => h <= maxH)
    case 'piano':
      for (let h = 1; h <= Math.min(12, maxH); h++) out.push([h, 1 / h ** 1.4])
      return out
    case 'bass':
      for (let h = 1; h <= Math.min(6, maxH); h++) out.push([h, 1 / h ** 1.8])
      return out
    case 'triangle':
      for (let h = 1; h <= Math.min(31, maxH); h += 2) out.push([h, (h % 4 === 1 ? 1 : -1) / (h * h)])
      return out
    case 'square':
      for (let h = 1; h <= Math.min(31, maxH); h += 2) out.push([h, 1 / h])
      return out
    case 'sawtooth':
      for (let h = 1; h <= Math.min(31, maxH); h++) out.push([h, 1 / h])
      return out
  }
}

/** Render one (possibly chordal) note. Duration excludes the release tail. */
export function renderTone(
  midis: number[],
  durationSec: number,
  sampleRate: number,
  wave: Waveform,
  velocity = 1,
  env: Envelope = {}
): PcmAudio {
  const e = { ...ENVELOPES[wave], ...env }
  const total = Math.ceil((durationSec + e.release) * sampleRate)
  const out = new Float32Array(total)
  const level = (0.22 * velocity) / Math.sqrt(Math.max(1, midis.length))
  for (const midi of midis) {
    const f = midiToHz(midi)
    const hs = harmonics(wave, f, sampleRate)
    const norm = hs.reduce((a, [, amp]) => a + Math.abs(amp), 0) || 1
    for (const [h, amp] of hs) {
      const w = (2 * Math.PI * f * h) / sampleRate
      // Higher piano partials die away faster, like a real string.
      const partialDecay = wave === 'piano' ? 1.5 * h : 0
      const k = Math.exp((-partialDecay * 0.5) / sampleRate)
      let d = (amp / norm) * level
      for (let i = 0; i < total; i++) {
        out[i] += d * Math.sin(w * i)
        d *= k
      }
    }
  }
  // ADSR
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate
    let g: number
    if (t < e.attack) g = t / e.attack
    else if (t < e.attack + e.decay) g = 1 - (1 - e.sustain) * ((t - e.attack) / e.decay)
    else g = e.sustain
    if (t > durationSec) g *= Math.max(0, 1 - (t - durationSec) / e.release)
    out[i] *= g
  }
  return { sampleRate, channels: [out] }
}

// ---------------------------------------------------------------- drums

export type DrumHit = 'kick' | 'snare' | 'hat' | 'openhat' | 'clap' | 'tom' | 'crash'

export const DRUM_CHARS: Record<string, DrumHit> = {
  k: 'kick',
  b: 'kick',
  s: 'snare',
  h: 'hat',
  x: 'hat',
  o: 'openhat',
  c: 'clap',
  t: 'tom',
  C: 'crash',
}

function noise(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) / 4294967296) * 2 - 1
  }
}

export function renderDrum(hit: DrumHit, sampleRate: number, velocity = 1): PcmAudio {
  const len = { kick: 0.45, snare: 0.25, hat: 0.06, openhat: 0.35, clap: 0.25, tom: 0.4, crash: 1.4 }[hit]
  const n = Math.ceil(len * sampleRate)
  const out = new Float32Array(n)
  const rnd = noise(hit.length * 7919 + 17)
  let phase = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = 0
    switch (hit) {
      case 'kick': {
        const f = 45 + 110 * Math.exp(-t * 30)
        phase += (2 * Math.PI * f) / sampleRate
        v = Math.sin(phase) * Math.exp(-t * 7) * 0.9
        break
      }
      case 'tom': {
        const f = 90 + 60 * Math.exp(-t * 12)
        phase += (2 * Math.PI * f) / sampleRate
        v = Math.sin(phase) * Math.exp(-t * 8) * 0.6
        break
      }
      case 'snare': {
        phase += (2 * Math.PI * 185) / sampleRate
        v = (Math.sin(phase) * 0.35 * Math.exp(-t * 25) + rnd() * 0.5 * Math.exp(-t * 18)) * 0.8
        break
      }
      case 'hat':
      case 'openhat':
      case 'crash': {
        const r = rnd()
        const hp = r - prev // crude high-pass
        prev = r
        const decay = hit === 'hat' ? 60 : hit === 'openhat' ? 9 : 3
        v = hp * 0.22 * Math.exp(-t * decay)
        break
      }
      case 'clap': {
        const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.4) : Math.exp(-(t - 0.03) * 20)
        v = rnd() * 0.45 * burst
        break
      }
    }
    out[i] = v * velocity
  }
  return { sampleRate, channels: [out] }
}
