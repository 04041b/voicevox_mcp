// Minimal PCM WAV decode/encode plus a float stereo mixing buffer.

export interface PcmAudio {
  sampleRate: number
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[]
}

export function decodeWav(buf: Buffer): PcmAudio {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  let format = 0
  let numChannels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let data: Buffer | undefined

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    let size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    // Streaming encoders may write 0/0xFFFFFFFF as the data size.
    if (id === 'data' && (size === 0 || start + size > buf.length)) size = buf.length - start
    if (id === 'fmt ') {
      format = buf.readUInt16LE(start)
      numChannels = buf.readUInt16LE(start + 2)
      sampleRate = buf.readUInt32LE(start + 4)
      bitsPerSample = buf.readUInt16LE(start + 14)
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(start + 24)
    } else if (id === 'data') {
      data = buf.subarray(start, start + size)
    }
    offset = start + size + (size % 2)
  }
  if (!data || !numChannels) throw new Error('WAV is missing fmt or data chunk')

  const bytes = bitsPerSample / 8
  const frames = Math.floor(data.length / (bytes * numChannels))
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const p = (i * numChannels + c) * bytes
      let v: number
      if (format === 3 && bitsPerSample === 32) v = data.readFloatLE(p)
      else if (bitsPerSample === 16) v = data.readInt16LE(p) / 32768
      else if (bitsPerSample === 24) v = data.readIntLE(p, 3) / 8388608
      else if (bitsPerSample === 32) v = data.readInt32LE(p) / 2147483648
      else if (bitsPerSample === 8) v = (data[p] - 128) / 128
      else throw new Error(`Unsupported WAV sample format (${bitsPerSample} bit, format ${format})`)
      channels[c][i] = v
    }
  }
  return { sampleRate, channels }
}

export function encodeWav(audio: PcmAudio): Buffer {
  const numChannels = audio.channels.length
  const frames = audio.channels[0]?.length ?? 0
  const dataSize = frames * numChannels * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(numChannels, 22)
  buf.writeUInt32LE(audio.sampleRate, 24)
  buf.writeUInt32LE(audio.sampleRate * numChannels * 2, 28)
  buf.writeUInt16LE(numChannels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  let p = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, audio.channels[c][i]))
      buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), p)
      p += 2
    }
  }
  return buf
}

/** Linear-interpolation resampler; adequate for speech/singing at engine rates. */
export function resample(audio: PcmAudio, targetRate: number): PcmAudio {
  if (audio.sampleRate === targetRate) return audio
  const ratio = audio.sampleRate / targetRate
  const channels = audio.channels.map((src) => {
    const out = new Float32Array(Math.floor(src.length / ratio))
    for (let i = 0; i < out.length; i++) {
      const x = i * ratio
      const i0 = Math.floor(x)
      const i1 = Math.min(i0 + 1, src.length - 1)
      const t = x - i0
      out[i] = src[i0] * (1 - t) + src[i1] * t
    }
    return out
  })
  return { sampleRate: targetRate, channels }
}

export function durationSec(audio: PcmAudio): number {
  return (audio.channels[0]?.length ?? 0) / audio.sampleRate
}

/** Growable stereo float buffer that clips are summed into. */
export class Mixer {
  private left = new Float32Array(0)
  private right = new Float32Array(0)
  private length = 0

  constructor(readonly sampleRate: number) {}

  private ensure(frames: number) {
    if (frames <= this.left.length) return
    const cap = Math.max(frames, this.left.length * 2, this.sampleRate)
    const l = new Float32Array(cap)
    const r = new Float32Array(cap)
    l.set(this.left)
    r.set(this.right)
    this.left = l
    this.right = r
  }

  /**
   * Add a clip at `atSec`. `gain` is linear, `pan` is -1 (left) .. 1 (right).
   * Uses a constant-power pan law. Parts that fall before t=0 are dropped.
   */
  add(clip: PcmAudio, atSec: number, gain = 1, pan = 0) {
    const audio = resample(clip, this.sampleRate)
    const src = audio.channels
    const frames = src[0]?.length ?? 0
    const start = Math.round(atSec * this.sampleRate)
    const end = start + frames
    this.ensure(end)
    const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4
    const gl = gain * Math.cos(angle) * Math.SQRT2
    const gr = gain * Math.sin(angle) * Math.SQRT2
    const l = src[0]
    const r = src[1] ?? src[0]
    for (let i = Math.max(0, -start); i < frames; i++) {
      this.left[start + i] += l[i] * gl
      this.right[start + i] += r[i] * gr
    }
    this.length = Math.max(this.length, end)
  }

  /** Pad (or extend) the mix to at least `sec` seconds. */
  extendTo(sec: number) {
    const frames = Math.round(sec * this.sampleRate)
    this.ensure(frames)
    this.length = Math.max(this.length, frames)
  }

  /**
   * Render the mix. If `normalize` is set and the peak exceeds it, the whole mix
   * is scaled down so nothing clips.
   */
  render(opts: { stereo?: boolean; normalizePeak?: number; masterGain?: number } = {}): PcmAudio {
    const l = this.left.slice(0, this.length)
    const r = this.right.slice(0, this.length)
    let gain = opts.masterGain ?? 1
    if (opts.normalizePeak) {
      let peak = 0
      for (let i = 0; i < this.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]))
      peak *= gain
      if (peak > opts.normalizePeak) gain *= opts.normalizePeak / peak
    }
    if (gain !== 1) {
      for (let i = 0; i < this.length; i++) {
        l[i] *= gain
        r[i] *= gain
      }
    }
    if (opts.stereo === false) {
      const m = new Float32Array(this.length)
      for (let i = 0; i < this.length; i++) m[i] = (l[i] + r[i]) / 2
      return { sampleRate: this.sampleRate, channels: [m] }
    }
    return { sampleRate: this.sampleRate, channels: [l, r] }
  }
}
