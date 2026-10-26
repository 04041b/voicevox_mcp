// Song rendering: sing / talk / synth / drum tracks laid on a shared tempo grid and mixed to one WAV.
// Singing itself lives in sing.ts.

import { DRUM_CHARS, type DrumHit, renderDrum, renderTone } from './instruments.js'
import { TempoMap } from './music.js'
import { renderSingTrack, type SingContext, type SingTrackResult, singDetail } from './sing.js'
import { collectNotes, layoutNotes } from './timeline.js'
import { SAMPLE_RATE, synthesizeTalk } from './tts.js'
import type { DrumTrack, Song, SynthTrack, TalkTrack, Track } from './types.js'
import { decodeWav, durationSec, Mixer, type PcmAudio } from './wav.js'

export type * from './types.js'

export type RenderContext = SingContext

export interface TrackReport {
  name: string
  type: Track['type']
  start: number
  end: number
  detail: Record<string, unknown>
}

export interface RenderResult {
  audio: PcmAudio
  duration: number
  tracks: TrackReport[]
  /** Seconds the whole mix was shifted so phrase lead-ins before t=0 are kept. */
  lead: number
  tempo: TempoMap
  /** Detailed results per sing track, keyed by track index. */
  sing: Map<number, SingTrackResult>
}

// ---------------------------------------------------------------- talk

async function renderTalkTrack(ctx: RenderContext, track: TalkTrack, tempo: TempoMap) {
  const clips: { audio: PcmAudio; at: number }[] = []
  let cursor = tempo.beatToSec(track.startBeat ?? 0)
  const lines: string[] = []
  for (const [i, seg] of track.segments.entries()) {
    const speaker = seg.speaker ?? track.speaker ?? ctx.defaultTalkSpeaker
    ctx.log?.(`talk "${track.name ?? 'talk'}": segment ${i + 1}/${track.segments.length}`)
    const { wav } = await synthesizeTalk(ctx.api, { ...seg, speaker })
    const audio = decodeWav(wav)
    let at: number
    if (seg.atSeconds !== undefined) at = seg.atSeconds
    else if (seg.beat !== undefined) at = tempo.beatToSec(seg.beat)
    else at = i === 0 ? cursor : cursor + (seg.gapSeconds ?? 0.2)
    clips.push({ audio, at })
    cursor = at + durationSec(audio)
    lines.push(`${at.toFixed(2)}s ${seg.text ?? seg.kana ?? '(edited query)'}`)
  }
  const start = clips.length ? Math.min(...clips.map((c) => c.at)) : 0
  const end = Math.max(0, ...clips.map((c) => c.at + durationSec(c.audio)))
  return { clips, detail: { segments: lines }, start, end }
}

// ---------------------------------------------------------------- synth & drums

function renderSynthTrack(track: SynthTrack, tempo: TempoMap) {
  const seq = collectNotes(track)
  const clips: { audio: PcmAudio; at: number }[] = []
  let beat = track.startBeat ?? 0
  let end = 0
  const reps = Math.max(1, Math.floor(track.repeat ?? 1))
  for (let r = 0; r < reps; r++) {
    const timed = layoutNotes(seq, tempo, beat, track.transpose ?? 0)
    for (const n of timed) {
      if (n.midis.length === 0) continue
      const audio = renderTone(n.midis, n.end - n.start, SAMPLE_RATE, track.waveform ?? 'piano', n.src.volume ?? 1, track)
      clips.push({ audio, at: n.start })
      end = Math.max(end, n.end)
    }
    beat = timed.length ? timed[timed.length - 1].endBeat : beat
  }
  return {
    clips,
    detail: { waveform: track.waveform ?? 'piano', notes: clips.length },
    start: tempo.beatToSec(track.startBeat ?? 0),
    end,
  }
}

export function parseDrumPattern(pattern: string): DrumHit[][] {
  const steps: DrumHit[][] = []
  const s = pattern.replace(/[\s|]+/g, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '-' || ch === '.') steps.push([])
    else if (ch === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) throw new Error('Unclosed "[" in drum pattern')
      steps.push([...s.slice(i + 1, close)].map(drumHit))
      i = close
    } else steps.push([drumHit(ch)])
  }
  return steps
}

function drumHit(ch: string): DrumHit {
  const hit = DRUM_CHARS[ch]
  if (!hit) throw new Error(`Unknown drum symbol "${ch}". Use k s h o c t C, "-" for rest, [ks] for layers.`)
  return hit
}

function renderDrumTrack(track: DrumTrack, tempo: TempoMap) {
  const steps = parseDrumPattern(track.pattern)
  const stepBeats = track.stepBeats ?? 0.5
  const reps = Math.max(1, Math.floor(track.repeat ?? 1))
  const clips: { audio: PcmAudio; at: number }[] = []
  const cache = new Map<DrumHit, PcmAudio>()
  let beat = track.startBeat ?? 0
  for (let r = 0; r < reps; r++) {
    for (const step of steps) {
      for (const hit of step) {
        let audio = cache.get(hit)
        if (!audio) {
          audio = renderDrum(hit, SAMPLE_RATE)
          cache.set(hit, audio)
        }
        clips.push({ audio, at: tempo.beatToSec(beat) })
      }
      beat += stepBeats
    }
  }
  return {
    clips,
    detail: { steps: steps.length, repeat: reps, hits: clips.length },
    start: tempo.beatToSec(track.startBeat ?? 0),
    end: tempo.beatToSec(beat),
  }
}

// ---------------------------------------------------------------- song

export async function renderSong(ctx: RenderContext, song: Song, opts: { onlyTracks?: number[] } = {}): Promise<RenderResult> {
  if (!song.tracks?.length) throw new Error('Song has no tracks')
  const tempo = new TempoMap(song.bpm ?? 120, song.tempo)
  const placed: { audio: PcmAudio; at: number; gain: number; pan: number }[] = []
  const reports: TrackReport[] = []
  const sing = new Map<number, SingTrackResult>()
  const anySolo = song.tracks.some((t) => t.solo)

  for (const [i, track] of song.tracks.entries()) {
    const name = track.name ?? `${track.type}${i + 1}`
    const skipped = track.mute || (anySolo && !track.solo) || (opts.onlyTracks && !opts.onlyTracks.includes(i))
    if (skipped) {
      reports.push({ name, type: track.type, start: 0, end: 0, detail: { muted: true } })
      continue
    }
    let r: { clips: { audio: PcmAudio; at: number }[]; detail: Record<string, unknown>; start: number; end: number }
    try {
      switch (track.type) {
        case 'sing': {
          const res = await renderSingTrack(ctx, track, tempo)
          sing.set(i, res)
          r = { ...res, detail: singDetail(res) }
          break
        }
        case 'talk':
          r = await renderTalkTrack(ctx, track, tempo)
          break
        case 'synth':
          r = renderSynthTrack(track, tempo)
          break
        case 'drums':
          r = renderDrumTrack(track, tempo)
          break
        default:
          throw new Error(`Unknown track type "${(track as { type: string }).type}"`)
      }
    } catch (e) {
      throw new Error(`Track ${i + 1} (${name}): ${(e as Error).message}`)
    }
    for (const c of r.clips) placed.push({ ...c, gain: track.volume ?? 1, pan: track.pan ?? 0 })
    reports.push({ name, type: track.type, start: r.start, end: r.end, detail: r.detail })
  }
  if (placed.length === 0) throw new Error('Nothing to render (all tracks muted or empty)')

  // Phrase lead-ins can start before t=0; shift the whole song so nothing is cut.
  const lead = Math.max(0, -Math.min(0, ...placed.map((p) => p.at)))
  const mixer = new Mixer(SAMPLE_RATE)
  for (const p of placed) mixer.add(p.audio, p.at + lead, p.gain, p.pan)
  const audio = mixer.render({
    stereo: song.stereo ?? true,
    normalizePeak: song.normalize === false ? undefined : 0.98,
    masterGain: song.masterGain,
  })
  for (const r of reports) {
    if (!r.detail.muted) {
      r.start = round(r.start + lead)
      r.end = round(r.end + lead)
    }
  }
  return { audio, duration: round(durationSec(audio)), tracks: reports, lead, tempo, sing }
}

function round(n: number) {
  return Math.round(n * 1000) / 1000
}
