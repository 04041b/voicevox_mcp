import { describe, expect, it } from 'vitest'
import type { FrameAudioQuery, Score, VoicevoxApi } from '../src/api.js'
import { renderSong } from '../src/song.js'
import { encodeWav } from '../src/wav.js'

/** Fake engine: records requests and returns plausible frame data. */
function fakeApi() {
  const calls: { method: string; score?: Score; speaker: number; query?: FrameAudioQuery }[] = []
  const wav = (frames: number) => encodeWav({ sampleRate: 24000, channels: [new Float32Array(frames * 256).fill(0.1)] })
  const api = {
    baseUrl: `fake://${Math.random()}`,
    singers: async () => [
      { name: '波音リツ', speaker_uuid: 'r', styles: [{ name: 'ノーマル', id: 6000, type: 'sing' }] },
      { name: 'ずんだもん', speaker_uuid: 'z', styles: [{ name: 'ノーマル', id: 3003, type: 'frame_decode' }] },
    ],
    async singFrameAudioQuery(score: Score, speaker: number): Promise<FrameAudioQuery> {
      calls.push({ method: 'query', score, speaker })
      const total = score.notes.reduce((a, n) => a + n.frame_length, 0)
      return {
        f0: Array(total).fill(200),
        volume: Array(total).fill(0.5),
        phonemes: score.notes.map((n) => ({ phoneme: n.key === null ? 'pau' : 'a', frame_length: n.frame_length, note_id: n.id ?? null })),
        volumeScale: 1,
        outputSamplingRate: 24000,
        outputStereo: false,
      }
    },
    async singFrameVolume(score: Score, query: FrameAudioQuery, speaker: number) {
      calls.push({ method: 'volume', score, speaker, query })
      return query.f0.map(() => 0.5)
    },
    async singFrameF0(score: Score, query: FrameAudioQuery) {
      return query.f0
    },
    async frameSynthesis(query: FrameAudioQuery, speaker: number) {
      calls.push({ method: 'synth', speaker, query })
      return wav(query.f0.length)
    },
    async accentPhrases() {
      return [{ accent: 1, moras: [{ text: 'ホ', vowel: 'o', vowel_length: 0.1, pitch: 5 }, { text: 'シ', vowel: 'i', vowel_length: 0.1, pitch: 5 }] }]
    },
  }
  return { api: api as unknown as VoicevoxApi, calls }
}

describe('renderSong (sing)', () => {
  it('builds editor-style phrase scores with teacher, key shift and rests', async () => {
    const { api, calls } = fakeApi()
    const r = await renderSong(
      { api, defaultTalkSpeaker: 3 },
      { bpm: 120, tracks: [{ type: 'sing', singer: 3003, score: 'C4:ら D4:ー R:2 E4:きら:2', vibrato: { depth: 50 } }] }
    )
    const queries = calls.filter((c) => c.method === 'query')
    expect(queries).toHaveLength(2) // the rest splits two phrases
    expect(queries[0].speaker).toBe(6000) // humming voice borrows the sing teacher
    const n = queries[0].score!.notes
    expect(n[0]).toMatchObject({ key: null, lyric: '' })
    expect(n[0].frame_length).toBe(Math.round(0.5 * 93.75)) // song starts at 0 -> one quarter lead-in
    expect(n.slice(1, 3).map((x) => [x.key, x.lyric])).toEqual([
      [62, 'ラ'], // C4 + 2 (keyRangeAdjustment -2 is subtracted for the teacher)
      [64, 'ア'], // "ー" became the previous vowel
    ])
    expect(n[n.length - 1]).toMatchObject({ key: null, frame_length: Math.round(0.5 * 93.75) })
    // multi-mora lyric splits the note
    expect(queries[1].score!.notes.slice(1, 3).map((x) => x.lyric)).toEqual(['キ', 'ラ'])

    const synth = calls.find((c) => c.method === 'synth')!
    expect(synth.speaker).toBe(3003)
    // f0 is shifted back down by 2 semitones and vibrato modulates it
    const f0 = synth.query!.f0
    expect(Math.min(...f0)).toBeLessThan(200 * 2 ** (-2 / 12) - 1)
    expect(r.tracks[0].detail.phrases).toBe(2)
    expect(r.duration).toBeGreaterThan(3)
  })

  it('assigns lyrics text (incl. kanji via the engine) one mora per note', async () => {
    const { api, calls } = fakeApi()
    await renderSong({ api, defaultTalkSpeaker: 3 }, { tracks: [{ type: 'sing', singer: 6000, score: 'C4 D4 E4', lyrics: 'あ 星' }] })
    const lyrics = calls.find((c) => c.method === 'query')!.score!.notes.map((n) => n.lyric)
    expect(lyrics).toEqual(['', 'ア', 'ホ', 'シ', ''])
  })

  it('explains lyric/note count mismatches', async () => {
    const { api } = fakeApi()
    await expect(
      renderSong({ api, defaultTalkSpeaker: 3 }, { tracks: [{ type: 'sing', singer: 6000, score: 'C4 D4', lyrics: 'らららら' }] })
    ).rejects.toThrow(/4 mora .* 2 notes/)
  })

  it('mixes synth and drum tracks without an engine', async () => {
    const { api } = fakeApi()
    const r = await renderSong(
      { api, defaultTalkSpeaker: 3 },
      {
        bpm: 60,
        tracks: [
          { type: 'synth', waveform: 'organ', score: 'C4+E4+G4:2', repeat: 2 },
          { type: 'drums', pattern: 'k-s-', stepBeats: 1 },
        ],
      }
    )
    expect(r.duration).toBeGreaterThanOrEqual(4)
    expect(r.audio.channels).toHaveLength(2)
  })
})
