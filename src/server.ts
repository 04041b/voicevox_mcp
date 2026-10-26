import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { type AccentPhrase, VoicevoxApi } from './api.js'
import type { Config } from './config.js'
import { playFile, stopPlayback } from './playback.js'
import { getSingers } from './singers.js'
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
  timingOffset: z.number().optional().describe('Seconds to move this note\'s consonant start (negative = earlier) (sing).'),
})

const trackBase = {
  name: z.string().optional(),
  volume: z.number().optional().describe('Linear gain, default 1'),
  pan: z.number().min(-1).max(1).optional().describe('-1 left .. 1 right'),
  mute: z.boolean().optional(),
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
  defaultLyric: z.string().optional().describe('Lyric for notes that still have none, default "ら".'),
  keyRangeAdjustment: z.number().int().optional().describe('Editor "音域調整" in semitones. Default is the editor\'s value for the voice.'),
  volumeRangeAdjustment: z.number().optional().describe('Editor "声量調整" in dB.'),
  vibrato: vibratoSchema.optional().describe('Default vibrato for all notes (off unless set).'),
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
  tracks: z.array(trackSchema),
  masterGain: z.number().optional(),
  normalize: z.boolean().optional(),
  stereo: z.boolean().optional(),
})

// ---------------------------------------------------------------- helpers

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
        'voicevox_render_song (multi-track: several singers, harmonies, spoken parts, built-in synth/drum backing). ' +
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
        'Expression per note: volume, pitchBend (cents), bend curve, vibrato, timingOffset. For harmonies, backing or spoken parts use voicevox_render_song.',
      ].join('\n'),
      inputSchema: {
        ...singTrackFields,
        bpm: z.number().positive().optional().describe('Tempo, default 120'),
        ...outputFields,
      },
    },
    async (args) => {
      const { bpm, outputPath, play, waitForEnd, returnAudio, ...track } = args
      return renderAndDeliver(
        { bpm, tracks: [{ type: 'sing', ...track, singer: track.singer ?? config.defaultSinger }] },
        { outputPath, play, waitForEnd, returnAudio }
      )
    }
  )

  server.registerTool(
    'voicevox_render_song',
    {
      title: 'Render song',
      description: [
        'Render a full multi-track song to one WAV: any number of sing tracks (lead, harmonies, duets), talk tracks (spoken lines, narration, rap-like parts placed on beats), synth tracks (piano/organ/bass/... melodies and chords) and drum patterns, all on a shared tempo grid with volume/pan per track.',
        'Track types:',
        '  sing  {type:"sing", singer, score|notes, lyrics?, transpose?, vibrato?, volume?, pan?, startBeat?}',
        '  talk  {type:"talk", speaker?, segments:[{text|kana, beat?|atSeconds?, speedScale?, ...}]}',
        '  synth {type:"synth", waveform:"piano"|"organ"|"bass"|"sine"|"square"|"sawtooth"|"triangle", score|notes (chords "C4+E4+G4:4"), repeat?}',
        '  drums {type:"drums", pattern:"k-h-s-h-", stepBeats?:0.5, repeat?}',
        'Score notation is the same as voicevox_sing. Tracks start at beat 0 unless startBeat is set. Rests split sung phrases (also good places to breathe).',
        'Iterate like a producer: save the spec with saveSongTo, edit, then re-render from songFile. Unchanged phrases are cached, so re-renders are fast.',
      ].join('\n'),
      inputSchema: {
        song: songSchema.optional().describe('The song spec. Either this or songFile.'),
        songFile: z.string().optional().describe('Path to a JSON song spec (as saved by saveSongTo).'),
        saveSongTo: z.string().optional().describe('Also save the song spec JSON here for later editing.'),
        ...outputFields,
      },
    },
    async ({ song, songFile, saveSongTo, ...out }) => {
      try {
        let spec = song as Song | undefined
        if (!spec && songFile) spec = songSchema.parse(JSON.parse(await readFile(songFile, 'utf8'))) as Song
        if (!spec) throw new Error('Provide song or songFile')
        if (saveSongTo) {
          await mkdir(path.dirname(path.resolve(saveSongTo)), { recursive: true })
          await writeFile(saveSongTo, JSON.stringify(spec, null, 2))
        }
        return await renderAndDeliver(spec, out, saveSongTo ? { songFile: path.resolve(saveSongTo) } : {})
      } catch (e) {
        return fail(e)
      }
    }
  )

  async function renderAndDeliver(
    song: Song,
    out: { outputPath?: string; play?: boolean; waitForEnd?: boolean; returnAudio?: boolean },
    extra: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    try {
      for (const t of song.tracks) if (t.type === 'sing' && t.singer === undefined) t.singer = config.defaultSinger
      const result = await renderSong({ api, defaultTalkSpeaker: config.defaultSpeaker }, song)
      return await deliver(encodeWav(result.audio), song.title ?? 'song', out, {
        duration: result.duration,
        tracks: result.tracks,
        ...extra,
      })
    } catch (e) {
      return fail(e)
    }
  }

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
