import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { type AccentPhrase, VoicevoxApi } from './api.js'
import type { Config } from './config.js'
import { playFile, stopPlayback } from './playback.js'
import { getSingers } from './singers.js'
import { importScoreFile, songToVvproj, vvprojToSong } from './project.js'
import { inspectSingTrack, singDetail } from './sing.js'
import { renderSong, type Song } from './song.js'
import { buildAudioQuery, summarizeQuery, synthesizeQuery } from './tts.js'
import { decodeWav, durationSec, encodeWav, Mixer } from './wav.js'

// ---------------------------------------------------------------- schemas

const talkFields = {
  speaker: z.number().int().optional().describe('Talk style id (see voicevox_list_speakers).'),
  speedScale: z.number().min(0.5).max(2).optional().describe('Speed, 1 = normal.'),
  pitchScale: z.number().min(-0.15).max(0.15).optional().describe('Pitch offset, 0 = normal.'),
  intonationScale: z.number().min(0).max(2).optional().describe('Intonation strength, 1 = normal.'),
  volumeScale: z.number().min(0).max(2).optional().describe('Volume, 1 = normal.'),
  prePhonemeLength: z.number().min(0).max(1.5).optional().describe('Silence before speech (s).'),
  postPhonemeLength: z.number().min(0).max(1.5).optional().describe('Silence after speech (s).'),
  pauseLengthScale: z.number().min(0).max(2).optional().describe('Scale of pauses at punctuation.'),
}

const accentPhrasesSchema = z
  .array(z.any())
  .describe('Edited accent_phrases from voicevox_audio_query (change "accent", mora "pitch", lengths, pause_mora).')

const talkSource = {
  text: z.string().optional().describe('Japanese text (kanji ok).'),
  kana: z
    .string()
    .optional()
    .describe(
      "AquesTalk-style kana for exact reading & accent: katakana; every accent phrase needs exactly one ' after its accented mora; / or 、 separates accent phrases; _ before a mora makes it unvoiced, ？ at end for a question. e.g. \"コンニチワ'/セ'カイ\""
    ),
  accentPhrases: accentPhrasesSchema.optional(),
  recalculate: z
    .boolean()
    .optional()
    .describe('With accentPhrases: re-derive mora pitch/length from the accent positions (default true). Set false to keep hand-edited pitch values.'),
}

const outputFields = {
  outputPath: z.string().optional().describe('Where to save the WAV. Default: an auto-named file in the output directory.'),
  play: z.boolean().optional().describe('Play through the local speakers (default from VOICEVOX_AUTO_PLAY, normally true).'),
  waitForEnd: z.boolean().optional().describe('Block until playback finishes (default false).'),
  returnAudio: z.boolean().optional().describe('Also return the WAV inline as base64 audio content (default false).'),
}

const vibratoSchema = z.union([
  z.literal(false),
  z.object({
    depth: z.number().optional().describe('Cents, default 40'),
    rate: z.number().optional().describe('Hz, default 5.5'),
    delay: z.number().optional().describe('Seconds after note start, default 0.3'),
    fadeIn: z.number().optional().describe('Seconds to reach full depth, default 0.2'),
  }),
])

const noteSchema = z.object({
  id: z.string().optional().describe('Stable note id (kept through .vvproj import/export).'),
  pitch: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .describe('"C4" (=MIDI 60), "F#3", "Bb4", MIDI number, or null/"R" for a rest. Synth chords: "C4+E4+G4".'),
  lyric: z.string().optional().describe('Kana. One mora per note normally; several mora split the note evenly. "ー" holds the previous vowel.'),
  beats: z.union([z.number(), z.string()]).optional().describe('Length in beats (quarter=1) or "8n", "4n.", "8t", "3/2". Default 1.'),
  volume: z.number().optional().describe('Per-note volume / velocity multiplier, default 1.'),
  pitchBend: z.number().optional().describe('Constant pitch offset in cents (sing).'),
  bend: z.array(z.tuple([z.number(), z.number()])).optional().describe('Pitch curve [[pos 0..1, cents], ...] (sing). e.g. scoop: [[0,-100],[0.15,0]]'),
  vibrato: vibratoSchema.optional(),
  phonemeTimings: z
    .array(z.object({ index: z.number().int().min(0), offset: z.number() }))
    .optional()
    .describe('Move phoneme starts (editor 音素タイミング): index = phoneme index in this note as shown by voicevox_inspect_singing (0 = first; last+1 = the end of the final vowel before a rest), offset in seconds (negative = earlier).'),
  timingOffset: z.number().optional().describe('Shorthand for phonemeTimings [{index:0, offset}] (moves the consonant).'),
})

const trackBase = {
  name: z.string().optional(),
  volume: z.number().optional().describe('Linear gain, default 1'),
  pan: z.number().min(-1).max(1).optional().describe('-1 left .. 1 right'),
  mute: z.boolean().optional(),
  solo: z.boolean().optional().describe('If any track is solo, only solo tracks play'),
  startBeat: z.number().optional().describe('Beat where this track starts, default 0'),
}

const scoreFields = {
  notes: z.array(noteSchema).optional(),
  score: z
    .string()
    .optional()
    .describe('Compact notation "pitch:lyric:beats" tokens, e.g. "C4:ど:1 D4:れ:1 E4:み:2 | R:1 G4:そ:0.5 G4:ー:1.5". Lyric and length optional (default 1 beat). Appended after notes.'),
  transpose: z.number().int().optional().describe('Semitones added to every note'),
}

const singTrackFields = {
  ...trackBase,
  ...scoreFields,
  singer: z.number().int().optional().describe('Singer style id from voicevox_list_singers.'),
  teacher: z.number().int().optional().describe('Singing-teacher style id (advanced). Default chosen automatically.'),
  lyrics: z
    .string()
    .optional()
    .describe('Lyrics assigned one mora per note to notes without a lyric. Kana or kanji text (kanji is read by the engine).'),
  defaultLyric: z.string().optional().describe('Lyric for notes that still have none: kana, or "doremi" to sing note names. Default "ら".'),
  keyRangeAdjustment: z.number().int().optional().describe('Editor "音域調整" in semitones. Default is the editor\'s value for the voice.'),
  volumeRangeAdjustment: z.number().optional().describe('Editor "声量調整" in dB.'),
  vibrato: vibratoSchema.optional().describe('Default vibrato for all notes (off unless set).'),
  pitchCurves: z
    .array(
      z.object({
        points: z.array(
          z.tuple([z.number(), z.union([z.string(), z.number(), z.object({ hz: z.number().positive() })])])
        ),
      })
    )
    .optional()
    .describe(
      'Drawn pitch lines (editor ピッチ編集), absolute pitch: points [beat, pitch] with pitch "A4", "A4+30c", fractional MIDI 69.3 or {hz}. Linear between points; blended into the predicted pitch with the editor\'s smoothing. e.g. a fall at the end of a phrase: [[7.5,"C5"],[8,"G4"]]'
    ),
  volumeCurves: z
    .array(z.object({ points: z.array(z.tuple([z.number(), z.number()])) }))
    .optional()
    .describe('Drawn volume lines (editor ボリューム編集): points [beat, dB relative to the predicted volume]. e.g. crescendo [[0,-6],[4,3]]'),
  pitchEditData: z
    .array(z.number())
    .optional()
    .describe('Raw editor pitch data (Hz per 1/93.75 s frame from song start, -1 = none). Normally set by project import.'),
  volumeEditData: z
    .array(z.number().nullable())
    .optional()
    .describe('Raw editor volume data (dB per frame, null = none). Normally set by project import.'),
}

const singTrackSchema = z.object({ type: z.literal('sing'), ...singTrackFields })

const talkSegmentSchema = z.object({
  ...talkSource,
  ...talkFields,
  beat: z.number().optional().describe('Start beat. Omit to follow the previous segment.'),
  atSeconds: z.number().optional().describe('Start time in seconds (overrides beat).'),
  gapSeconds: z.number().optional().describe('Gap after previous segment when sequential, default 0.2'),
})

const talkTrackSchema = z.object({
  type: z.literal('talk'),
  ...trackBase,
  speaker: z.number().int().optional(),
  segments: z.array(talkSegmentSchema),
})

const synthTrackSchema = z.object({
  type: z.literal('synth'),
  ...trackBase,
  ...scoreFields,
  waveform: z.enum(['sine', 'triangle', 'square', 'sawtooth', 'piano', 'organ', 'bass']).optional(),
  repeat: z.number().int().min(1).optional(),
  attack: z.number().optional(),
  decay: z.number().optional(),
  sustain: z.number().optional(),
  release: z.number().optional(),
})

const drumTrackSchema = z.object({
  type: z.literal('drums'),
  ...trackBase,
  pattern: z.string().describe('One char per step: k kick, s snare, h hat, o open hat, c clap, t tom, C crash, - rest; [kh] = layered. e.g. "k-h-s-h- k-k-s-h-"'),
  stepBeats: z.number().optional().describe('Beats per step, default 0.5'),
  repeat: z.number().int().min(1).optional(),
})

const trackSchema = z.discriminatedUnion('type', [singTrackSchema, talkTrackSchema, synthTrackSchema, drumTrackSchema])

const songSchema = z.object({
  title: z.string().optional(),
  bpm: z.number().positive().optional().describe('Default 120'),
  tempo: z.array(z.object({ beat: z.number(), bpm: z.number().positive() })).optional().describe('Tempo changes'),
  timeSignatures: z
    .array(z.object({ bar: z.number().int().min(1), beats: z.number().int(), beatType: z.number().int() }))
    .optional()
    .describe('Time signatures (for .vvproj export). Default 4/4.'),
  tracks: z.array(trackSchema),
  masterGain: z.number().optional(),
  normalize: z.boolean().optional(),
  stereo: z.boolean().optional(),
})

// ---------------------------------------------------------------- helpers

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

function text(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

function fail(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
}

function slug(s: string) {
  return (
    s
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'audio'
  )
}

// ---------------------------------------------------------------- server

export function createServer(config: Config): McpServer {
  const api = new VoicevoxApi(config.voicevoxUrl, { timeoutMs: config.timeoutMs })
  const server = new McpServer(
    { name: 'voicevox-mcp', version: '0.1.0' },
    {
      instructions:
        'VOICEVOX text-to-speech and singing. Speak with voicevox_speak. Sing with voicevox_sing (one melody) or ' +
        'voicevox_render_song (multi-track songs). Check results with voicevox_inspect_singing; import MIDI/MusicXML/UST/.vvproj ' +
        'with voicevox_import_score and hand songs to the VOICEVOX editor with voicevox_export_project. ' +
        'Talk speakers and singers use different style ids: get them from voicevox_list_speakers / voicevox_list_singers.',
    }
  )

  async function deliver(
    wav: Buffer,
    name: string,
    opts: { outputPath?: string; play?: boolean; waitForEnd?: boolean; returnAudio?: boolean },
    info: Record<string, unknown>
  ): Promise<CallToolResult> {
    const file = path.resolve(opts.outputPath ?? path.join(config.outputDir, `${Date.now()}_${slug(name)}.wav`))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, wav)
    let played: string | boolean = false
    if (opts.play ?? config.autoPlay) {
      try {
        await playFile(file, opts.waitForEnd ?? false)
        played = true
      } catch (e) {
        played = `failed: ${(e as Error).message}`
      }
    }
    const result = text({ file, played, ...info })
    if (opts.returnAudio) result.content.push({ type: 'audio', data: wav.toString('base64'), mimeType: 'audio/wav' })
    return result
  }

  // ---- engine / voices

  server.registerTool(
    'voicevox_engine_status',
    { title: 'Engine status', description: 'Check that the VOICEVOX Engine is reachable and report its version.', inputSchema: {} },
    async () => {
      try {
        return text({ url: api.baseUrl, connected: true, version: await api.version(), outputDir: config.outputDir })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_list_speakers',
    {
      title: 'List talk speakers',
      description: 'List text-to-speech characters and their style ids (for voicevox_speak and talk tracks).',
      inputSchema: { filter: z.string().optional().describe('Substring filter on character or style name') },
    },
    async ({ filter }) => {
      try {
        const speakers = await api.speakers()
        const lines = speakers
          .map((s) => ({ name: s.name, styles: s.styles.filter((st) => !st.type || st.type === 'talk') }))
          .filter((s) => s.styles.length && (!filter || `${s.name} ${s.styles.map((x) => x.name).join(' ')}`.includes(filter)))
          .map((s) => `${s.name}: ${s.styles.map((st) => `${st.name}=${st.id}`).join(', ')}`)
        return text(lines.join('\n') || 'No speakers matched')
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_list_singers',
    {
      title: 'List singers',
      description:
        'List singing voices and their style ids (for voicevox_sing and sing tracks). "sing" styles are dedicated singers; "hum" styles are talk voices singing via a teacher model.',
      inputSchema: { filter: z.string().optional().describe('Substring filter on character or style name') },
    },
    async ({ filter }) => {
      try {
        const singers = await getSingers(api)
        const lines = singers
          .filter((s) => !filter || `${s.name} ${s.styles.map((x) => x.name).join(' ')}`.includes(filter))
          .map(
            (s) =>
              `${s.name}: ${s.styles.map((st) => `${st.name}=${st.id}${st.type === 'frame_decode' ? '' : ' (sing)'}`).join(', ')}`
          )
        return text(lines.join('\n') || 'No singers matched')
      } catch (e) {
        return fail(e)
      }
    }
  )

  // ---- talk

  server.registerTool(
    'voicevox_speak',
    {
      title: 'Speak',
      description:
        'Text-to-speech. Give `text` (or `kana` / edited `accentPhrases`) for one voice, or `segments` for a dialogue with several speakers/settings joined in order. Saves a WAV and plays it.',
      inputSchema: {
        ...talkSource,
        ...talkFields,
        segments: z
          .array(z.object({ ...talkSource, ...talkFields, gapSeconds: z.number().optional().describe('Silence before this segment, default 0.2') }))
          .optional()
          .describe('Dialogue / multi-part speech. Each item inherits top-level settings it does not set.'),
        ...outputFields,
      },
    },
    async (args) => {
      try {
        const { segments, outputPath, play, waitForEnd, returnAudio, ...base } = args
        const parts = segments?.length ? segments.map((s) => ({ ...base, ...s })) : [base]
        const mixer = new Mixer(24000)
        let t = 0
        const summary: string[] = []
        for (const [i, p] of parts.entries()) {
          const speaker = p.speaker ?? config.defaultSpeaker
          const query = await buildAudioQuery(api, { ...p, accentPhrases: p.accentPhrases as AccentPhrase[] | undefined, speaker })
          const audio = decodeWav(await synthesizeQuery(api, query, speaker))
          if (i > 0) t += (p as { gapSeconds?: number }).gapSeconds ?? 0.2
          mixer.add(audio, t)
          summary.push(`${t.toFixed(2)}s [${speaker}] ${p.text ?? p.kana ?? query.kana ?? ''}`)
          t += durationSec(audio)
        }
        const audio = mixer.render({ stereo: false })
        const name = parts[0].text ?? parts[0].kana ?? 'speech'
        return await deliver(encodeWav(audio), name, { outputPath, play, waitForEnd, returnAudio }, {
          duration: Number(durationSec(audio).toFixed(2)),
          segments: summary,
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_audio_query',
    {
      title: 'Inspect / edit speech',
      description:
        'Get the reading, accent and pitch the engine would use for some text, like the accent editor in the VOICEVOX app. ' +
        'Returns a readable summary plus `accentPhrases` JSON you can edit (accent position, mora pitch, lengths) and pass back to voicevox_speak.',
      inputSchema: { ...talkSource, speaker: talkFields.speaker },
    },
    async (args) => {
      try {
        const speaker = args.speaker ?? config.defaultSpeaker
        const query = await buildAudioQuery(api, { ...args, accentPhrases: args.accentPhrases as AccentPhrase[] | undefined, speaker })
        return text({ kana: query.kana, summary: summarizeQuery(query), accentPhrases: query.accent_phrases })
      } catch (e) {
        return fail(e)
      }
    }
  )

  // ---- sing

  /** Forward render progress as MCP progress notifications when the client asked for them. */
  function progressLogger(extra: ToolExtra) {
    const token = extra._meta?.progressToken
    if (token === undefined) return undefined
    let n = 0
    return (message: string) => {
      n++
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } }).catch(() => {})
    }
  }

  const ctxFor = (extra: ToolExtra) => ({ api, defaultTalkSpeaker: config.defaultSpeaker, log: progressLogger(extra) })

  async function loadSong(song: unknown, songFile: string | undefined): Promise<Song> {
    let spec = song as Song | undefined
    if (!spec && songFile) spec = songSchema.parse(JSON.parse(await readFile(songFile, 'utf8'))) as Song
    if (!spec) throw new Error('Provide song or songFile')
    for (const t of spec.tracks) if (t.type === 'sing' && t.singer === undefined) t.singer = config.defaultSinger
    return spec
  }

  async function saveJson(file: string, data: unknown) {
    const full = path.resolve(file)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, JSON.stringify(data, null, 2))
    return full
  }

  const songSource = {
    song: songSchema.optional().describe('The song spec. Either this or songFile.'),
    songFile: z.string().optional().describe('Path to a JSON song spec (as saved by saveSongTo / voicevox_import_score).'),
  }

  server.registerTool(
    'voicevox_sing',
    {
      title: 'Sing',
      description: [
        'Sing a melody with lyrics (one singer). Write the melody as `score` (compact) or `notes`, and the words either per note or as `lyrics`.',
        'Compact score: space-separated "pitch:lyric:beats" tokens; rest = "R:beats"; "|" bar lines are ignored.',
        '  e.g. score "C4:か:1 D4:え:1 E4:る:1 F4:の:1 E4:う:1 D4:た:1 C4:が:2"',
        '  or score "C4 D4 E4 F4 E4 D4 C4:2" with lyrics "かえるのうたが".',
        'One mora per note (きゃ, っ, ん each count as one). "ー" holds the previous vowel across notes (melisma).',
        'Pitch: C4 = middle C (MIDI 60). Comfortable ranges: female/child voices ~ A3–A5, male voices ~ C3–C5.',
        'Everything the VOICEVOX editor can edit is available: per-note volume, bend, vibrato and phonemeTimings; drawn pitchCurves / volumeCurves; keyRangeAdjustment (音域調整) and volumeRangeAdjustment (声量調整).',
        'Use voicevox_inspect_singing to see phoneme timings and how the pitch sits on each note. For several tracks use voicevox_render_song.',
      ].join('\n'),
      inputSchema: {
        ...singTrackFields,
        bpm: z.number().positive().optional().describe('Tempo, default 120'),
        tempo: songSchema.shape.tempo,
        ...outputFields,
      },
    },
    async (args, extra) => {
      const { bpm, tempo, outputPath, play, waitForEnd, returnAudio, ...track } = args
      return renderAndDeliver(
        { bpm, tempo, tracks: [{ type: 'sing', ...track, singer: track.singer ?? config.defaultSinger }] },
        { outputPath, play, waitForEnd, returnAudio },
        extra
      )
    }
  )

  server.registerTool(
    'voicevox_render_song',
    {
      title: 'Render song',
      description: [
        'Render a multi-track song to one WAV, like the VOICEVOX editor\'s song mode: several sing tracks (lead, harmonies, duets), each with its own singer, volume, pan, mute/solo.',
        'Track types:',
        '  sing  {type:"sing", singer, score|notes, lyrics?, transpose?, vibrato?, pitchCurves?, volumeCurves?, volume?, pan?, startBeat?}',
        '  talk  {type:"talk", speaker?, segments:[{text|kana, beat?|atSeconds?, speedScale?, ...}]}  (spoken lines on the timeline)',
        '  synth {type:"synth", waveform:"piano"|..., score|notes} and drums {type:"drums", pattern:"k-h-s-h-"} (simple guide accompaniment)',
        'Score notation is the same as voicevox_sing. Tracks start at beat 0 unless startBeat is set. Rests split sung phrases (also where the singer breathes).',
        'Iterate like in the editor: save the spec with saveSongTo, inspect with voicevox_inspect_singing, edit, re-render from songFile. Unchanged phrases are cached.',
        'Import MIDI/MusicXML/UST/.vvproj with voicevox_import_score; open the result in the VOICEVOX editor with voicevox_export_project.',
      ].join('\n'),
      inputSchema: {
        ...songSource,
        saveSongTo: z.string().optional().describe('Also save the song spec JSON here for later editing.'),
        ...outputFields,
      },
    },
    async ({ song, songFile, saveSongTo, ...out }, extra) => {
      try {
        const spec = await loadSong(song, songFile)
        const saved = saveSongTo ? await saveJson(saveSongTo, spec) : undefined
        return await renderAndDeliver(spec, out, extra, saved ? { songFile: saved } : {})
      } catch (e) {
        return fail(e)
      }
    }
  )

  async function renderAndDeliver(
    song: Song,
    out: { outputPath?: string; play?: boolean; waitForEnd?: boolean; returnAudio?: boolean },
    extra: ToolExtra,
    info: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    try {
      const result = await renderSong(ctxFor(extra), song)
      return await deliver(encodeWav(result.audio), song.title ?? 'song', out, {
        duration: result.duration,
        tracks: result.tracks,
        ...info,
      })
    } catch (e) {
      return fail(e)
    }
  }

  server.registerTool(
    'voicevox_inspect_singing',
    {
      title: 'Inspect singing',
      description: [
        'Show what the singer will actually do, like looking at the VOICEVOX editor\'s piano roll: for each note its lyric, start/end, every phoneme with its index and timing, and how far the sung pitch line sits from the written note (cents).',
        'Use the phoneme indices with a note\'s phonemeTimings to move consonants/vowels, and pitchErrorCents to decide on pitchCurves or bends. Renders (cached) but does not play.',
      ].join('\n'),
      inputSchema: {
        ...songSource,
        track: z.union([z.number().int(), z.string()]).optional().describe('Track index (0-based) or name. Default: first sing track.'),
        fromNote: z.number().int().min(1).optional().describe('First note number (1-based, rests count) to show. Default 1.'),
        count: z.number().int().min(1).max(200).optional().describe('How many notes to show. Default 40.'),
      },
    },
    async ({ song, songFile, track, fromNote, count }, extra) => {
      try {
        const spec = await loadSong(song, songFile)
        const index =
          track === undefined
            ? spec.tracks.findIndex((t) => t.type === 'sing')
            : typeof track === 'number'
              ? track
              : spec.tracks.findIndex((t) => t.name === track)
        const t = spec.tracks[index]
        if (!t || t.type !== 'sing') throw new Error(`No sing track ${track ?? ''} in the song`)
        const result = await renderSong(ctxFor(extra), { ...spec, tracks: spec.tracks.map((x, i) => (i === index ? { ...x, mute: false, solo: false } : x)) }, { onlyTracks: [index] })
        const res = result.sing.get(index)
        if (!res) throw new Error('Track did not render')
        const all = inspectSingTrack(res)
        const from = fromNote ?? 1
        const shown = all.filter((n) => n.note >= from).slice(0, count ?? 40)
        return text({
          track: index,
          ...singDetail(res),
          phraseStarts: res.phrases.map((p) => Number(p.start.toFixed(3))),
          notesShown: `${shown.length} of ${all.length}`,
          phonemeFormat: 'index:phoneme start-end (song seconds)',
          notes: shown.map((n) => ({
            ...n,
            phonemes: n.phonemes.map((p) => `${p.index}:${p.phoneme} ${p.start.toFixed(3)}-${p.end.toFixed(3)}`).join(', '),
          })),
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_export_project',
    {
      title: 'Export VOICEVOX project',
      description:
        'Save the song as a VOICEVOX editor project (.vvproj) so a person can open it in the VOICEVOX app and keep editing: notes, lyrics, tempo, time signatures, singer & singing teacher, 音域調整/声量調整, phoneme timing, pitch and volume edits, track gain/pan/mute/solo. Talk/synth/drum tracks are not part of .vvproj and are left out.',
      inputSchema: {
        ...songSource,
        outputPath: z.string().describe('Where to write the .vvproj file'),
      },
    },
    async ({ song, songFile, outputPath }, extra) => {
      try {
        const spec = await loadSong(song, songFile)
        const singIdx = spec.tracks.flatMap((t, i) => (t.type === 'sing' ? [i] : []))
        // Render every sing track (even muted ones) so note-relative edits can be baked in.
        const unmuted = { ...spec, tracks: spec.tracks.map((t) => ({ ...t, mute: false, solo: false })) }
        const result = await renderSong(ctxFor(extra), unmuted, { onlyTracks: singIdx })
        const manifest = await api.engineManifest().catch(() => undefined)
        const { project, warnings } = songToVvproj(spec, result, manifest?.uuid)
        const file = await saveJson(outputPath.endsWith('.vvproj') ? outputPath : `${outputPath}.vvproj`, project)
        return text({ file, tracks: project.song.trackOrder.length, warnings })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_import_score',
    {
      title: 'Import score / project',
      description:
        'Load a song from a file into an editable song spec: VOICEVOX projects (.vvproj, including pitch/volume/timing edits) and, via UtaFormatix like the VOICEVOX editor, MIDI (.mid), MusicXML (.musicxml/.xml), UTAU (.ust), OpenUtau (.ustx), Synthesizer V (.svp/.s5p), VOCALOID (.vsqx/.vpr/.vsq), CeVIO (.ccs), DeepVocal (.dv), VoiSona (.tssln), Piapro Studio (.ppsf) and .ufdata. Lyrics are converted to kana. The spec is saved as JSON for voicevox_render_song / voicevox_inspect_singing.',
      inputSchema: {
        file: z.string().describe('Path of the file to import'),
        singer: z.number().int().optional().describe('Singer for tracks that have none (default VOICEVOX_DEFAULT_SINGER).'),
        saveSongTo: z.string().optional().describe('Where to save the song JSON. Default: next to the input as <name>.song.json'),
      },
    },
    async ({ file, singer, saveSongTo }) => {
      try {
        const data = await readFile(file)
        const defaultSinger = singer ?? config.defaultSinger
        const { song, warnings } = file.toLowerCase().endsWith('.vvproj')
          ? vvprojToSong(JSON.parse(data.toString('utf8')), defaultSinger, path.parse(file).name)
          : await importScoreFile(data, file, defaultSinger)
        if (singer !== undefined) for (const t of song.tracks) if (t.type === 'sing') t.singer = singer
        const out = await saveJson(saveSongTo ?? path.join(path.dirname(file), `${path.parse(file).name}.song.json`), song)
        return text({
          songFile: out,
          title: song.title,
          bpm: song.bpm,
          tempoChanges: song.tempo?.length ?? 0,
          tracks: song.tracks.map((t, i) => ({
            index: i,
            name: t.name,
            ...(t.type === 'sing'
              ? {
                  singer: t.singer,
                  notes: t.notes?.filter((n) => n.pitch !== null).length,
                  lyrics: t.notes?.map((n) => n.lyric ?? (n.pitch === null ? ' ' : '?')).join('').trim().slice(0, 120),
                }
              : {}),
          })),
          warnings,
          next: 'Render with voicevox_render_song {songFile}. Edit the JSON to change singers, lyrics or expression.',
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  // ---- playback

  server.registerTool(
    'voicevox_play',
    {
      title: 'Play file',
      description: 'Play a previously generated WAV file again.',
      inputSchema: { file: z.string(), waitForEnd: z.boolean().optional() },
    },
    async ({ file, waitForEnd }) => {
      try {
        await playFile(path.resolve(file), waitForEnd ?? false)
        return text(`Playing ${file}`)
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_stop',
    { title: 'Stop playback', description: 'Stop the audio that is currently playing.', inputSchema: {} },
    async () => text(stopPlayback() ? 'Stopped' : 'Nothing was playing')
  )

  // ---- dictionary

  server.registerTool(
    'voicevox_dictionary_list',
    { title: 'List user dictionary', description: 'List words in the engine user dictionary.', inputSchema: {} },
    async () => {
      try {
        const dict = await api.userDict()
        return text(
          Object.entries(dict).map(([uuid, w]) => ({
            uuid,
            surface: w.surface,
            pronunciation: w.pronunciation,
            accentType: w.accent_type,
            priority: w.priority,
          }))
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_dictionary_add',
    {
      title: 'Add dictionary word',
      description: 'Teach the engine how to read a word (names, jargon, English terms). Affects talk and kanji lyrics.',
      inputSchema: {
        surface: z.string().describe('The word as written'),
        pronunciation: z.string().describe('Reading in katakana'),
        accentType: z.number().int().min(0).describe('Mora index of the accent nucleus (0 = flat/heiban)'),
        wordType: z.enum(['PROPER_NOUN', 'COMMON_NOUN', 'VERB', 'ADJECTIVE', 'SUFFIX']).optional(),
        priority: z.number().int().min(0).max(10).optional().describe('0-10, default 5'),
      },
    },
    async (args) => {
      try {
        return text({ uuid: await api.addUserDictWord(args) })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'voicevox_dictionary_delete',
    {
      title: 'Delete dictionary word',
      description: 'Remove a word from the user dictionary by uuid.',
      inputSchema: { uuid: z.string() },
    },
    async ({ uuid }) => {
      try {
        await api.deleteUserDictWord(uuid)
        return text(`Deleted ${uuid}`)
      } catch (e) {
        return fail(e)
      }
    }
  )

  return server
}
