// .vvproj export/import and score import against a running engine: `npx tsx scripts/verify-project.ts`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import midiPkg from '@tonejs/midi'
import { VoicevoxApi } from '../src/api.js'
import { importScoreFile, songToVvproj, vvprojToSong } from '../src/project.js'
import { inspectSingTrack } from '../src/sing.js'
import { renderSong, type SingTrack, type Song } from '../src/song.js'

const { Midi } = midiPkg
const api = new VoicevoxApi(process.env.VOICEVOX_URL ?? 'http://localhost:50021')
const ctx = { api, defaultTalkSpeaker: 3 }
mkdirSync('output', { recursive: true })
let failed = 0
const check = (name: string, ok: boolean, info: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, info)
  if (!ok) failed++
}

const song: Song = {
  title: 'roundtrip',
  bpm: 100,
  tempo: [{ beat: 8, bpm: 80 }],
  timeSignatures: [{ bar: 1, beats: 3, beatType: 4 }],
  tracks: [
    {
      type: 'sing',
      name: 'lead',
      singer: 3002,
      keyRangeAdjustment: -3,
      volumeRangeAdjustment: 2,
      pan: -0.3,
      volume: 0.8,
      notes: [
        { pitch: 'E4', lyric: 'きら', beats: 2, phonemeTimings: [{ index: 2, offset: -0.04 }] },
        { pitch: 'G4', lyric: 'ら', beats: 1, vibrato: { depth: 60 } },
        { pitch: 'R', beats: 1 },
        { pitch: 'A4', lyric: 'ほ', beats: 2, volume: 0.6 },
        { pitch: 'G4', lyric: 'し', beats: 3, timingOffset: -0.05 },
      ],
      pitchCurves: [{ points: [[9, 'G4'], [10, 'F4']] }],
      volumeCurves: [{ points: [[6, 0], [8, -4]] }],
    },
    { type: 'drums', pattern: 'k-s-' },
  ],
}

const result = await renderSong(ctx, song)
const manifest = await api.engineManifest()
const { project, warnings } = songToVvproj(song, result, manifest.uuid)
writeFileSync('output/roundtrip.vvproj', JSON.stringify(project))
console.log('warnings:', warnings)
check('drum track dropped with a warning', warnings.some((w) => w.includes('drums')))
const t = Object.values(project.song.tracks)[0]
check('multi-mora note became two editor notes', t.notes.length === 5, t.notes.map((n) => `${n.lyric}@${n.position}+${n.duration}`))
check('tempo / time signature', project.song.tempos.length === 2 && project.song.tempos[1].position === 8 * 480 && project.song.timeSignatures[0].beats === 3)
check('phoneme edit on きら mapped to the ら sub-note', Object.values(t.phonemeTimingEditData).some((l) => l.some((e) => e.phonemeIndexInNote === 0 && e.offsetSeconds === -0.04)), t.phonemeTimingEditData)
check('pitch edits present (curve + baked vibrato)', t.pitchEditData.filter((v) => v > 0).length > 50)
check('volume edits present (curve + baked note volume)', t.volumeEditData.filter((v) => v !== null).length > 50)
check('track settings', t.keyRangeAdjustment === -3 && t.volumeRangeAdjustment === 2 && t.gain === 0.8 && t.pan === -0.3 && t.singingTeacher?.styleId === 6000)

// re-import and re-render: the editor-native data must reproduce the same notes and timings
const back = vvprojToSong(project, 3003, 'roundtrip')
const bt = back.song.tracks[0] as SingTrack
check('import keeps notes and rests', bt.notes!.length === 6, bt.notes!.map((n) => `${n.pitch}:${n.lyric ?? ''}:${n.beats}`).join(' '))
check('import keeps tempo map', back.song.bpm === 100 && back.song.tempo?.[0].beat === 8)
const r2 = await renderSong(ctx, back.song)
const a = inspectSingTrack(result.sing.get(0)!)
const b = inspectSingTrack(r2.sing.get(0)!)
const phon = (x: typeof a) => x.flatMap((n) => n.phonemes.map((p) => `${p.phoneme}@${p.start.toFixed(2)}`)).join(' ')
check('re-imported song has identical phoneme timings', phon(a) === phon(b), { a: phon(a), b: phon(b) })
const f0a = result.sing.get(0)!.phrases[1].query.f0
const f0b = r2.sing.get(0)!.phrases[1].query.f0
const frames = [...result.sing.get(0)!.phrases[1].relPitchFrames]
const maxCents = Math.max(0, ...frames.map((f) => Math.abs(1200 * Math.log2(f0b[f] / f0a[f]))).filter(Number.isFinite))
check('baked pitch edits reproduce the edited pitch (< 5 cents)', maxCents < 5, { maxCents: maxCents.toFixed(2) })

// MIDI import
const midi = new Midi()
midi.header.setTempo(90)
const tr = midi.addTrack()
tr.name = 'melody'
;['C4', 'D4', 'E4', 'F4', 'G4'].forEach((n, i) => {
  tr.addNote({ name: n, ticks: i * 480 + (i >= 3 ? 480 : 0), durationTicks: 480 })
})
const mid = await importScoreFile(new Uint8Array(midi.toArray()), 'test.mid', 3003)
const mt = mid.song.tracks[0] as SingTrack
check('MIDI import: tempo', Math.round(mid.song.bpm ?? 0) === 90, mid.song.bpm)
check('MIDI import: notes and gap rest', mt.notes!.map((n) => `${n.pitch}:${n.beats}`).join(' ') === '60:1 62:1 64:1 :1 65:1 67:1'.replace(':1 65', 'null:1 65'), mt.notes!.map((n) => `${n.pitch}:${n.beats}`).join(' '))
const rm = await renderSong(ctx, mid.song)
check('MIDI import renders', rm.duration > 5, rm.duration)

// .vvproj validates against the editor's own schema (run separately with the editor schema shim)
// To check against the editor's zod schema, run its projectFileSchema over output/roundtrip.vvproj.
process.exit(failed ? 1 : 0)
