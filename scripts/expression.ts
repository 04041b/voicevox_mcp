// Exercises singing expression features against a running engine: `npx tsx scripts/expression.ts`
import { VoicevoxApi } from '../src/api.js'
import { renderSong } from '../src/song.js'
import { encodeWav } from '../src/wav.js'
import { writeFileSync, mkdirSync } from 'node:fs'

const api = new VoicevoxApi(process.env.VOICEVOX_URL ?? 'http://localhost:50021')
mkdirSync('output', { recursive: true })
const r = await renderSong(
  { api, defaultTalkSpeaker: 3, log: console.log },
  {
    bpm: 90,
    tracks: [
      {
        type: 'sing',
        singer: 3002,
        lyrics: '春の小川は',
        notes: [
          { pitch: 'G4', beats: '8n' },
          { pitch: 'A4', beats: '8n', bend: [[0, -100], [0.2, 0]] },
          { pitch: 'G4', beats: 1 },
          { pitch: 'E4', beats: 1, timingOffset: -0.05 },
          { pitch: 'C5', beats: 1, vibrato: { depth: 60, rate: 6 } },
          { pitch: 'R', beats: '8n' },
          { pitch: 'A4', beats: 1.5, volume: 0.7 },
          { pitch: 'G4', beats: 2 },
        ],
      },
      { type: 'sing', singer: 3003, startBeat: 6, score: 'C4:きゃっ:1 D4:と:1 E4:ー:1 F4:ん:1' },
    ],
  }
)
writeFileSync('output/expression.wav', encodeWav(r.audio))
console.log(JSON.stringify(r.tracks, null, 2))
