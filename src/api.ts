// Thin, typed client for the VOICEVOX Engine HTTP API (talk + sing endpoints).

export interface Mora {
  text: string
  consonant?: string | null
  consonant_length?: number | null
  vowel: string
  vowel_length: number
  pitch: number
}

export interface AccentPhrase {
  moras: Mora[]
  accent: number
  pause_mora?: Mora | null
  is_interrogative?: boolean
}

export interface AudioQuery {
  accent_phrases: AccentPhrase[]
  speedScale: number
  pitchScale: number
  intonationScale: number
  volumeScale: number
  prePhonemeLength: number
  postPhonemeLength: number
  pauseLength?: number | null
  pauseLengthScale?: number
  outputSamplingRate: number
  outputStereo: boolean
  kana?: string
}

/** A note as the engine expects it. `key` is a MIDI note number, null for a rest. */
export interface ScoreNote {
  id?: string | null
  key: number | null
  frame_length: number
  lyric: string
}

export interface Score {
  notes: ScoreNote[]
}

export interface FramePhoneme {
  phoneme: string
  frame_length: number
  note_id?: string | null
}

export interface FrameAudioQuery {
  f0: number[]
  volume: number[]
  phonemes: FramePhoneme[]
  volumeScale: number
  outputSamplingRate: number
  outputStereo: boolean
}

export interface SpeakerStyle {
  name: string
  id: number
  type?: 'talk' | 'singing_teacher' | 'frame_decode' | 'sing'
}

export interface Speaker {
  name: string
  speaker_uuid: string
  styles: SpeakerStyle[]
  version?: string
}

export interface UserDictWord {
  surface: string
  pronunciation: string
  accent_type: number
  word_type?: string
  priority: number
  [key: string]: unknown
}

export class VoicevoxApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'VoicevoxApiError'
  }
}

export interface VoicevoxApiOptions {
  timeoutMs?: number
  retryCount?: number
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type ResponseKind = 'json' | 'binary' | 'text' | 'none'

export class VoicevoxApi {
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retryCount: number

  constructor(baseUrl: string, options: VoicevoxApiOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.retryCount = options.retryCount ?? 2
  }

  // ---- engine ----

  version(): Promise<string> {
    return this.request('GET', '/version', { kind: 'json' })
  }

  engineManifest(): Promise<{ uuid: string; name: string; frame_rate?: number }> {
    return this.request('GET', '/engine_manifest', { kind: 'json' })
  }

  // ---- talk ----

  speakers(): Promise<Speaker[]> {
    return this.request('GET', '/speakers', { kind: 'json' })
  }

  audioQuery(text: string, speaker: number): Promise<AudioQuery> {
    return this.request('POST', '/audio_query', { kind: 'json', query: { text, speaker } })
  }

  /** `isKana` accepts AquesTalk-style kana notation, e.g. "コンニチワ'/セ'カイ". */
  accentPhrases(text: string, speaker: number, isKana = false): Promise<AccentPhrase[]> {
    return this.request('POST', '/accent_phrases', {
      kind: 'json',
      query: { text, speaker, is_kana: isKana },
    })
  }

  moraData(accentPhrases: AccentPhrase[], speaker: number): Promise<AccentPhrase[]> {
    return this.request('POST', '/mora_data', { kind: 'json', query: { speaker }, body: accentPhrases })
  }

  synthesis(query: AudioQuery, speaker: number): Promise<Buffer> {
    return this.request('POST', '/synthesis', { kind: 'binary', query: { speaker }, body: query })
  }

  // ---- sing ----

  singers(): Promise<Speaker[]> {
    return this.request('GET', '/singers', { kind: 'json' })
  }

  singFrameAudioQuery(score: Score, speaker: number): Promise<FrameAudioQuery> {
    return this.request('POST', '/sing_frame_audio_query', { kind: 'json', query: { speaker }, body: score })
  }

  singFrameF0(score: Score, frameAudioQuery: FrameAudioQuery, speaker: number): Promise<number[]> {
    return this.request('POST', '/sing_frame_f0', {
      kind: 'json',
      query: { speaker },
      body: { score, frame_audio_query: frameAudioQuery },
    })
  }

  singFrameVolume(score: Score, frameAudioQuery: FrameAudioQuery, speaker: number): Promise<number[]> {
    return this.request('POST', '/sing_frame_volume', {
      kind: 'json',
      query: { speaker },
      body: { score, frame_audio_query: frameAudioQuery },
    })
  }

  frameSynthesis(frameAudioQuery: FrameAudioQuery, speaker: number): Promise<Buffer> {
    return this.request('POST', '/frame_synthesis', { kind: 'binary', query: { speaker }, body: frameAudioQuery })
  }

  // ---- user dictionary ----

  userDict(): Promise<Record<string, UserDictWord>> {
    return this.request('GET', '/user_dict', { kind: 'json' })
  }

  addUserDictWord(word: {
    surface: string
    pronunciation: string
    accentType: number
    wordType?: string
    priority?: number
  }): Promise<string> {
    return this.request('POST', '/user_dict_word', {
      kind: 'json',
      retry: false,
      query: {
        surface: word.surface,
        pronunciation: word.pronunciation,
        accent_type: word.accentType,
        word_type: word.wordType,
        priority: word.priority,
      },
    })
  }

  deleteUserDictWord(uuid: string): Promise<void> {
    return this.request('DELETE', `/user_dict_word/${encodeURIComponent(uuid)}`, { kind: 'none' })
  }

  // ---- transport ----

  private async request<T>(
    method: Method,
    path: string,
    opts: {
      kind: ResponseKind
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
      retry?: boolean
    }
  ): Promise<T> {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) params.set(k, String(v))
    }
    const qs = params.toString()
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const attempts = (opts.retry === false ? 0 : this.retryCount) + 1
    let lastError: unknown

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)))
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        lastError = new VoicevoxApiError(
          `Cannot reach VOICEVOX Engine at ${this.baseUrl} (${error instanceof Error ? error.message : String(error)}). Is the engine running?`
        )
        continue
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const err = new VoicevoxApiError(
          `VOICEVOX ${method} ${path} failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
          res.status,
          detail
        )
        if (res.status >= 500 || res.status === 429) {
          lastError = err
          continue
        }
        throw err
      }

      switch (opts.kind) {
        case 'binary':
          return Buffer.from(await res.arrayBuffer()) as T
        case 'text':
          return (await res.text()) as T
        case 'none':
          return undefined as T
        default: {
          const text = await res.text()
          return (text ? JSON.parse(text) : undefined) as T
        }
      }
    }
    throw lastError
  }
}
