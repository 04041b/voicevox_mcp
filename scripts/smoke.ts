// End-to-end smoke test against a running VOICEVOX Engine: `npx tsx scripts/smoke.ts`
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const outDir = process.env.VOICEVOX_OUTPUT_DIR ?? 'output'
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  env: { ...process.env, VOICEVOX_AUTO_PLAY: 'false', VOICEVOX_OUTPUT_DIR: outDir } as Record<string, string>,
})
const client = new Client({ name: 'smoke', version: '0' })
await client.connect(transport)

async function call(name: string, args: Record<string, unknown> = {}) {
  const t = Date.now()
  const r = await client.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join('\n')
  console.log(`\n=== ${name} (${Date.now() - t} ms)${r.isError ? ' ERROR' : ''}\n${body.slice(0, 1500)}`)
  if (r.isError) process.exitCode = 1
  return r
}

console.log((await client.listTools()).tools.map((t) => t.name).join(', '))
await call('voicevox_engine_status')
await call('voicevox_list_singers', { filter: 'ずんだ' })
await call('voicevox_speak', { text: 'こんにちは、ずんだもんなのだ。', outputPath: `${outDir}/speak.wav` })
await call('voicevox_speak', {
  segments: [
    { text: 'ねえ、歌ってみて。', speaker: 2 },
    { kana: "イイヨ'/ウタウ'ネ", speaker: 3, speedScale: 1.1 },
  ],
  outputPath: `${outDir}/dialogue.wav`,
})
await call('voicevox_audio_query', { text: '今日は良い天気です' })
await call('voicevox_sing', {
  singer: 3003,
  bpm: 110,
  score: 'C4 D4 E4 F4 | E4 D4 C4:2 | E4 F4 G4 A4 | G4 F4 E4:2',
  lyrics: 'かえるのうたがきこえてくるよ',
  vibrato: { depth: 30 },
  outputPath: `${outDir}/kaeru.wav`,
})
await call('voicevox_render_song', {
  song: {
    title: 'kirakira',
    bpm: 100,
    tracks: [
      { type: 'talk', speaker: 3, segments: [{ text: 'きらきら星、いくのだ！', atSeconds: 0 }] },
      {
        type: 'sing',
        name: 'lead',
        singer: 6000,
        startBeat: 4,
        score: 'C4 C4 G4 G4 A4 A4 G4:2 | F4 F4 E4 E4 D4 D4 C4:2',
        lyrics: 'きらきらひかるおそらのほしよ',
        vibrato: { depth: 35 },
        pan: -0.2,
      },
      {
        type: 'sing',
        name: 'harmony',
        singer: 3003,
        startBeat: 4,
        score: 'E4 E4 C5 C5 C5 C5 C5:2 | A4 A4 G4 G4 F4 F4 E4:2',
        lyrics: 'きらきらひかるおそらのほしよ',
        volume: 0.6,
        pan: 0.3,
      },
      { type: 'synth', waveform: 'piano', startBeat: 4, score: 'C3+E3+G3:4 F3+A3+C4:2 C3+E3+G3:2 F3+A3+C4:2 C3+E3+G3:2 G2+B2+D3:2 C3+E3+G3:2', volume: 0.7 },
      { type: 'drums', startBeat: 4, pattern: 'k-h-s-h-', repeat: 4, volume: 0.5 },
    ],
  },
  saveSongTo: `${outDir}/kirakira.json`,
  outputPath: `${outDir}/kirakira.wav`,
})
await call('voicevox_render_song', { songFile: `${outDir}/kirakira.json`, outputPath: `${outDir}/kirakira2.wav` })
await call('voicevox_inspect_singing', { songFile: `${outDir}/kirakira.json`, track: 'lead', count: 3 })
await call('voicevox_export_project', { songFile: `${outDir}/kirakira.json`, outputPath: `${outDir}/kirakira.vvproj` })
await call('voicevox_import_score', { file: `${outDir}/kirakira.vvproj`, saveSongTo: `${outDir}/kirakira-imported.json` })
await call('voicevox_render_song', { songFile: `${outDir}/kirakira-imported.json`, outputPath: `${outDir}/kirakira-imported.wav` })
{
  let progress = 0
  await client.callTool(
    { name: 'voicevox_sing', arguments: { singer: 3003, score: 'G4 E4 E4:2 R F4 D4 D4:2', lyrics: 'うさぎうさぎ', play: false, outputPath: `${outDir}/progress.wav` } },
    undefined,
    { onprogress: () => void progress++ }
  )
  console.log(`\n=== progress notifications received: ${progress}`)
  if (progress === 0) process.exitCode = 1
}
await client.close()
