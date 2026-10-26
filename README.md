# voicevox-mcp

An MCP server that lets an AI agent use [VOICEVOX](https://voicevox.hiroshiba.jp/) for both **text-to-speech and singing**, with roughly the same control a person has in the VOICEVOX editor:

- **Talk**: speak text, run multi-speaker dialogues, set the exact reading and accent (AquesTalk kana), and inspect or edit the accent phrases and mora pitch.
- **Sing**: everything the VOICEVOX editor's song mode can edit.
  - Notes and lyrics in a compact score notation. Kanji lyrics are read for you, `ー` holds a vowel, and notes without lyrics sing `ら` or their note name (`doremi`).
  - Tempo changes and time signatures.
  - Per-track singer and singing teacher (歌い方), 音域調整 (key range) and 声量調整 (volume range).
  - Phoneme timing edits (音素タイミング) for any phoneme.
  - Drawn pitch lines (ピッチ編集) and volume lines (ボリューム編集).
  - Multiple tracks with gain, pan, mute and solo.
  - Extras beyond the editor: per-note bends, vibrato and volume.
- **See the result**: `voicevox_inspect_singing` is the agent's piano roll. It shows every phoneme's index and timing and how far the sung pitch line sits from each written note.
- **Interop**: import `.vvproj`, MIDI, MusicXML, UST, USTX, SVP, VSQX, CCS and more (the same UtaFormatix converter the editor uses). Export `.vvproj` so a person can open the song in the VOICEVOX app and keep editing.
- **Songs**: several sing tracks (lead, harmonies, duets) can be mixed with spoken talk tracks on the same timeline. A basic synth and drums are included for guide accompaniment.

The singing pipeline is a step-by-step port of the official editor (`src/song/songTrackRendering.ts`):

1. Each sing track is split into phrases at rests, with the editor's lead-in and tail lengths and phrase-boundary limits.
2. The singing teacher predicts phoneme timing (`sing_frame_audio_query`).
3. Phoneme timing edits are applied.
4. Pitch is predicted (`sing_frame_f0`). Drawn pitch lines are blended in with the editor's log-domain smoothing.
5. Volume is predicted (`sing_frame_volume`), the trailing breath is faded out, and volume edits are applied in dB.
6. The chosen singer synthesizes the phrase (`frame_synthesis`).

Phrases are cached, so re-rendering after a small edit is fast. The engine's pitch and volume predictions vary slightly from call to call (the singing model samples noise), and the cache keeps unchanged phrases identical between renders.

This project was inspired by [kajidog/mcp-tts-voicevox](https://github.com/kajidog/mcp-tts-voicevox), which covers TTS but not singing.

## Requirements

- Node.js 18+
- A running VOICEVOX Engine (0.16+ for singing), e.g.
  `docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest`
  or the VOICEVOX desktop app (the engine listens on `http://localhost:50021`).

## Setup

```bash
npm install   # .npmrc points @jsr packages at npm.jsr.io (for the UtaFormatix converter)
npm run build
```

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "voicevox": {
      "command": "node",
      "args": ["/path/to/voicevox_mcp/dist/index.js"],
      "env": { "VOICEVOX_URL": "http://localhost:50021" }
    }
  }
}
```

| Env var | Default | |
| --- | --- | --- |
| `VOICEVOX_URL` | `http://localhost:50021` | Engine URL |
| `VOICEVOX_DEFAULT_SPEAKER` | `3` | Talk style (ずんだもん ノーマル) |
| `VOICEVOX_DEFAULT_SINGER` | `3003` | Singer style (ずんだもん ノーマル) |
| `VOICEVOX_OUTPUT_DIR` | `$TMPDIR/voicevox-mcp` | Where WAVs are written |
| `VOICEVOX_AUTO_PLAY` | `true` | Play results on the local speakers |
| `VOICEVOX_PLAYER` | auto | Custom player command, e.g. `mpv --no-video {file}` |
| `VOICEVOX_TIMEOUT_MS` | `300000` | Per-request timeout |

## Tools

| Tool | What it does |
| --- | --- |
| `voicevox_engine_status` | Check the engine connection and version |
| `voicevox_list_speakers` | Talk characters and style ids |
| `voicevox_list_singers` | Singing voices and style ids (`(sing)` marks dedicated singers; the others are humming styles) |
| `voicevox_speak` | TTS from `text`, `kana` or edited `accentPhrases`, or a `segments` dialogue. Supports speed, pitch, intonation, volume, pre/post silence and pause scale |
| `voicevox_audio_query` | Show the reading/accent/pitch the engine would use and return editable `accentPhrases` |
| `voicevox_sing` | Sing one melody |
| `voicevox_render_song` | Render a multi-track song. Can save and load the song spec as JSON |
| `voicevox_inspect_singing` | Per-note phonemes (index + timing) and pitch error in cents, without playing |
| `voicevox_import_score` | `.vvproj` / MIDI / MusicXML / UST / USTX / SVP / VSQX / CCS / … → song JSON |
| `voicevox_export_project` | Song → `.vvproj` for the VOICEVOX editor |
| `voicevox_play` / `voicevox_stop` | Replay a file / stop playback |
| `voicevox_dictionary_list` / `_add` / `_delete` | Manage the engine's user dictionary |

Every audio tool saves a WAV (`outputPath`, or an auto-named file) and plays it (`play`, `waitForEnd`). With `returnAudio: true` it also returns the audio inline.

## Score notation

Tokens are separated by spaces and written as `pitch:lyric:beats`. The lyric and the length are optional; the default length is 1 beat (a quarter note).

```
C4:ど:1 D4:れ:1 E4:み:2 | R:1 G4:そ:0.5 G4:ー:1.5
```

- **Pitch**: `C4` is middle C (MIDI 60). `F#3`, `Bb4` and MIDI numbers also work. `R` is a rest. Synth tracks accept chords such as `C4+E4+G4:4`.
- **Length**: beats (`2`, `0.5`, `3/2`) or note values (`4n`, `8n.`, `8t`).
- **Lyric**: one kana mora per note (`きゃ`, `っ` and `ん` each count as one). A note with several mora (`きら`) is split evenly between them. `ー` holds the previous vowel across notes.
- `|` bar lines are ignored. Rests split the melody into phrases, which is also where the singer breathes.
- Instead of per-note lyrics you can pass `lyrics: "かえるのうたが"` (or text with kanji). It is assigned one mora per note. If the counts don't match, the error lists the mora so you can fix the notes.

### Per-note expression (JSON `notes`)

```json
{ "pitch": "A4", "lyric": "ら", "beats": 2,
  "bend": [[0, -100], [0.15, 0]],
  "vibrato": { "depth": 50, "rate": 5.5, "delay": 0.3 },
  "volume": 0.8, "pitchBend": 10, "timingOffset": -0.03 }
```

- `bend` is a pitch curve in cents. The example scoops up into the note.
- `pitchBend` is a constant offset in cents.
- `vibrato` overrides the track's default vibrato for this note.
- `volume` scales the singing volume curve for this note.
- `phonemeTimings` moves phoneme starts, like dragging phoneme boundaries in the editor. `index` is the phoneme's position in the note as shown by `voicevox_inspect_singing`; using last+1 moves the end of the final vowel before a rest. `offset` is in seconds; negative is earlier. `timingOffset` is shorthand for moving the first phoneme.

### Drawn pitch and volume lines (track level)

```json
{ "pitchCurves": [{ "points": [[7.5, "C5"], [8, "G4"]] }],
  "volumeCurves": [{ "points": [[0, -6], [4, 3]] }] }
```

- Points are `[beat, value]` and are joined by straight lines.
- Pitch values can be a note name (`"A4"`), a note with a cents offset (`"A4+30c"`), a fractional MIDI number, or `{ "hz": 440 }`. Pitch lines are absolute and are blended into the predicted pitch with the editor's smoothing.
- Volume values are dB relative to the predicted volume.
- Projects imported from the editor keep its raw per-frame data in `pitchEditData` and `volumeEditData`.

### Working with the VOICEVOX editor

- `voicevox_import_score { file: "song.mid" }` writes `song.song.json`. Pick singers and lyrics, then render with `voicevox_render_song { songFile }`.
- `voicevox_export_project { songFile, outputPath: "song.vvproj" }` writes a project the VOICEVOX app can open.
  - Notes, lyrics, tempo, time signatures, singer and teacher, range adjustments, phoneme timings, pitch and volume lines, and gain/pan/mute/solo carry over.
  - Note bends, vibrato and note volume have no editor equivalent, so their result is baked into the pitch and volume lines.
  - Talk, synth and drum tracks are left out, with a warning.

## Example: a full song

```json
{
  "song": {
    "title": "kirakira",
    "bpm": 100,
    "tracks": [
      { "type": "talk", "speaker": 3, "segments": [{ "text": "きらきら星、いくのだ！", "atSeconds": 0 }] },
      { "type": "sing", "name": "lead", "singer": 6000, "startBeat": 4,
        "score": "C4 C4 G4 G4 A4 A4 G4:2 | F4 F4 E4 E4 D4 D4 C4:2",
        "lyrics": "きらきらひかるおそらのほしよ", "vibrato": { "depth": 35 }, "pan": -0.2 },
      { "type": "sing", "name": "harmony", "singer": 3003, "startBeat": 4,
        "score": "E4 E4 C5 C5 C5 C5 C5:2 | A4 A4 G4 G4 F4 F4 E4:2",
        "lyrics": "きらきらひかるおそらのほしよ", "volume": 0.6, "pan": 0.3 },
      { "type": "synth", "waveform": "piano", "startBeat": 4, "volume": 0.7,
        "score": "C3+E3+G3:4 F3+A3+C4:2 C3+E3+G3:2 F3+A3+C4:2 C3+E3+G3:2 G2+B2+D3:2 C3+E3+G3:2" },
      { "type": "drums", "startBeat": 4, "pattern": "k-h-s-h-", "repeat": 4, "volume": 0.5 }
    ]
  },
  "saveSongTo": "songs/kirakira.json"
}
```

To iterate, edit `songs/kirakira.json` and call `voicevox_render_song` with `{ "songFile": "songs/kirakira.json" }`. Only the phrases you changed are synthesized again.

## Development

```bash
npm test                    # unit tests (no engine needed)
npm run typecheck
npx tsx scripts/smoke.ts            # end-to-end via MCP against a running engine
npx tsx scripts/verify-singing.ts   # measures pitch/timing/volume edits on the real engine
npx tsx scripts/verify-project.ts   # .vvproj round trip and MIDI import
npx tsx scripts/expression.ts
```
