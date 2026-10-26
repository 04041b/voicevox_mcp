// .vvproj export/import and score import against a running engine: `npx tsx scripts/verify-project.ts`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import midiPkg from '@tonejs/midi'
import { VoicevoxApi } from '../src/api.js'
import { importScoreFile, songToVvproj, validateVvproj, vvprojToSong } from '../src/project.js'
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
      pitchCurves: [{ points: [[7, 'G4'], [8, 'F4']] }], // inside し (beats 6-9)
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
// vibrato on ら (phrase 0) was baked into pitchEditData: the re-import must sing the same pitch there
const f0a = result.sing.get(0)!.phrases[0].query.f0
const f0b = r2.sing.get(0)!.phrases[0].query.f0
const frames = [...result.sing.get(0)!.phrases[0].relPitchFrames].filter((f) => f0a[f] > 0 && f0b[f] > 0)
const cents = frames.map((f) => Math.abs(1200 * Math.log2(f0b[f] / f0a[f])))
const sorted = [...cents].sort((x, y) => x - y)
check('baked vibrato frames exist', frames.length > 20, frames.length)
check('baked vibrato reproduces on re-import (median < 3 cents)', sorted[Math.floor(sorted.length / 2)] < 3, {
  median: sorted[Math.floor(sorted.length / 2)]?.toFixed(2),
  max: sorted[sorted.length - 1]?.toFixed(2),
})
// the drawn pitch line at beat 7.5 is halfway G4->F4 = F#4 in both renders
const ph1a = result.sing.get(0)!.phrases[1]
const ph1b = r2.sing.get(0)!.phrases[1]
const at = (p: typeof ph1a) => p.query.f0[Math.round(result.tempo.beatToSec(7.5) * 93.75) - Math.round(p.start * 93.75)]
const target = 440 * 2 ** ((66 - 69) / 12)
check('pitch line holds F#4 at beat 7.5 (original and re-import)', Math.abs(1200 * Math.log2(at(ph1a) / target)) < 5 && Math.abs(1200 * Math.log2(at(ph1b) / target)) < 5, {
  original: at(ph1a).toFixed(2),
  reimported: at(ph1b).toFixed(2),
  target: target.toFixed(2),
})

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

// MusicXML and UST: generate fixtures with UtaFormatix itself, with lyrics, and import them back
const { Project } = await import('@sevenc-nanashi/utaformatix-ts')
const uf = new Project({
  formatVersion: 1,
  project: {
    name: 'fixture',
    measurePrefix: 0,
    tempos: [{ tickPosition: 0, bpm: 110 }],
    timeSignatures: [{ measurePosition: 0, numerator: 4, denominator: 4 }],
    tracks: [{ name: 'v', notes: ['か', 'え', 'る', 'の'].map((lyric, i) => ({ key: 60 + i * 2, tickOn: i * 480, tickOff: i * 480 + 480, lyric })) }],
  },
})
for (const [ext, gen] of [
  ['musicxml', () => uf.toMusicXml()],
  ['ust', () => uf.toUst()],
] as const) {
  const [bytes] = await gen()
  const imp = await importScoreFile(bytes, `fixture.${ext}`, 3003)
  const it = imp.song.tracks[0] as SingTrack
  const desc = it.notes!.map((n) => `${n.pitch}:${n.lyric}`).join(' ')
  check(`${ext} import keeps pitches and lyrics`, desc === '60:か 62:え 64:る 66:の' && Math.round(imp.song.bpm!) === 110, { desc, bpm: imp.song.bpm })
}

// Editor validators: an extreme default key range (満別花丸 ささやき = -33) is clamped with a warning
const hanamaru = (await api.singers()).flatMap((s) => s.styles.map((st) => ({ s, st }))).find((x) => x.s.name === '満別花丸' && x.st.name === 'ささやき')
if (hanamaru) {
  const hs: Song = { bpm: 100, tracks: [{ type: 'sing', singer: hanamaru.st.id, score: 'C4:ら:2' }] }
  const hr = await renderSong(ctx, hs)
  const ex = songToVvproj(hs, hr)
  check('out-of-range key range clamped to -28 with a warning', Object.values(ex.project.song.tracks)[0].keyRangeAdjustment === -28 && ex.warnings.some((w) => w.includes('-33')), ex.warnings)
}
const slow: Song = { bpm: 30, tracks: [{ type: 'sing', singer: 3003, score: 'C4:ら:1' }] }
let reason = ''
try {
  songToVvproj(slow, await renderSong(ctx, slow))
} catch (e) {
  reason = (e as Error).message
}
check('export refuses tempos the editor cannot load (< 40 BPM)', reason.includes('40 BPM'), reason)
check('exported project passes the editor validators', validateVvproj(project).length === 0, validateVvproj(project))

// .vvproj validates against the editor's own schema (run separately with the editor schema shim)
// To check against the editor's zod schema, run its projectFileSchema over output/roundtrip.vvproj.
process.exit(failed ? 1 : 0)
