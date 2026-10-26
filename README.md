# voicevox-mcp

An MCP server that lets an AI agent use [VOICEVOX](https://voicevox.hiroshiba.jp/) for both **text-to-speech and singing**, with roughly the same control a person has in the VOICEVOX editor:

- **Talk**: speak text, run multi-speaker dialogues, set the exact reading and accent (AquesTalk kana), and inspect or edit the accent phrases and mora pitch.
- **Sing**: write melodies with lyrics in a compact score notation. Kanji lyrics are read for you. You get melisma (`ー`), per-note pitch bends, vibrato, volume and consonant timing, plus the editor's 音域調整 (key range) and 声量調整 (volume range) settings.
- **Songs**: mix several sing tracks (lead, harmonies, duets), spoken talk tracks, a built-in synth (piano/organ/bass/…) and drum patterns into one WAV, with per-track volume and pan.

The singing pipeline follows the official VOICEVOX editor. Each sing track is split into phrases at rests. Each phrase is queried with the singing teacher (`sing_frame_audio_query`), its pitch is edited, its volume is re-predicted (`sing_frame_volume`) and the trailing breath is muted. The phrase is then synthesized with the chosen singer (`frame_synthesis`). Phrases are cached, so re-rendering after a small edit is fast.

This project was inspired by [kajidog/mcp-tts-voicevox](https://github.com/kajidog/mcp-tts-voicevox), which covers TTS but not singing.

## Requirements

- Node.js 18+
- A running VOICEVOX Engine (0.16+ for singing), e.g.
  `docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest`
  or the VOICEVOX desktop app (the engine listens on `http://localhost:50021`).

## Setup

```bash
npm install
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
| `voicevox_render_song` | Render a multi-track song (sing, talk, synth and drum tracks). Can save and load the song spec as JSON |
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
- `timingOffset` moves the consonant (in seconds; negative is earlier).

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
npx tsx scripts/smoke.ts    # end-to-end via MCP against a running engine
npx tsx scripts/expression.ts
```
