// Singer metadata: style lookup, singing-teacher selection and default key-range adjustment.

import type { Speaker, SpeakerStyle, VoicevoxApi } from './api.js'

export interface SingerStyleInfo {
  id: number
  singerName: string
  styleName: string
  type: SpeakerStyle['type']
}

const singerCache = new Map<string, Promise<Speaker[]>>()

export function getSingers(api: VoicevoxApi): Promise<Speaker[]> {
  let p = singerCache.get(api.baseUrl)
  if (!p) {
    p = api.singers()
    p.catch(() => singerCache.delete(api.baseUrl))
    singerCache.set(api.baseUrl, p)
  }
  return p
}

export async function findSingerStyle(api: VoicevoxApi, id: number): Promise<SingerStyleInfo | undefined> {
  for (const s of await getSingers(api)) {
    const style = s.styles.find((st) => st.id === id)
    if (style) return { id, singerName: s.name, styleName: style.name, type: style.type }
  }
  return undefined
}

/**
 * The style used for `sing_frame_audio_query` (timing/pitch prediction).
 * A "sing" style can teach itself; "frame_decode" (humming) styles borrow the first "sing" style.
 */
export async function resolveTeacher(api: VoicevoxApi, singer: SingerStyleInfo): Promise<number> {
  if (singer.type === 'sing' || singer.type === 'singing_teacher') return singer.id
  for (const s of await getSingers(api)) {
    const t = s.styles.find((st) => st.type === 'sing' || st.type === 'singing_teacher')
    if (t) return t.id
  }
  throw new Error('No singing-teacher style ("sing" type) found on this engine')
}

/**
 * Default key-range adjustment (semitones) per humming voice, matching the values the
 * official VOICEVOX editor fills in. Lets the teacher predict in its own range while the
 * output stays at the written pitch.
 */
const KEY_RANGE_ADJUSTMENT: Record<string, Record<string, number>> = {
  四国めたん: { ノーマル: -4, あまあま: -4, ツンツン: -5, セクシー: -4, ヒソヒソ: -9 },
  ずんだもん: { ノーマル: -2, あまあま: 0, ツンツン: -3, セクシー: 0, ヒソヒソ: -7, ヘロヘロ: -3, なみだめ: 6 },
  春日部つむぎ: { ノーマル: -2 },
  雨晴はう: { ノーマル: 0 },
  波音リツ: { ノーマル: -8, クイーン: -5 },
  玄野武宏: { ノーマル: -17, 喜び: -9, ツンギレ: -14, 悲しみ: -18 },
  白上虎太郎: { ふつう: -14, わーい: -8, びくびく: -7, おこ: -9, びえーん: -3 },
  青山龍星: { ノーマル: -22, 熱血: -18, 不機嫌: -23, 喜び: -21, しっとり: -27, かなしみ: -22 },
  冥鳴ひまり: { ノーマル: -7 },
  九州そら: { ノーマル: -7, あまあま: -2, ツンツン: -6, セクシー: -4 },
  もち子さん: { ノーマル: -5, 'セクシー／あん子': -7, 泣き: -2, 怒り: -3, 喜び: -2, のんびり: -5 },
  剣崎雌雄: { ノーマル: -18 },
  WhiteCUL: { ノーマル: -6, たのしい: -3, かなしい: -7, びえーん: 0 },
  後鬼: { '人間ver.': -7, 'ぬいぐるみver.': -2 },
  'No.7': { ノーマル: -8, アナウンス: -10, 読み聞かせ: -9 },
  ちび式じい: { ノーマル: -18 },
  櫻歌ミコ: { ノーマル: -6, 第二形態: -12, ロリ: -7 },
  '小夜/SAYO': { ノーマル: -4 },
  ナースロボ＿タイプＴ: { ノーマル: -6, 楽々: -3, 恐怖: -4 },
  '†聖騎士 紅桜†': { ノーマル: -15 },
  雀松朱司: { ノーマル: -21 },
  麒ヶ島宗麟: { ノーマル: -17 },
  春歌ナナ: { ノーマル: -2 },
  猫使アル: { ノーマル: -8, おちつき: -9, うきうき: -7 },
  猫使ビィ: { ノーマル: -1, おちつき: -3 },
  中国うさぎ: { ノーマル: -8, おどろき: -4, こわがり: -2, へろへろ: -4 },
  栗田まろん: { ノーマル: -14 },
  あいえるたん: { ノーマル: -2 },
  満別花丸: { ノーマル: -4, 元気: 2, ささやき: -33, ぶりっ子: 0, ボーイ: -10 },
  琴詠ニア: { ノーマル: -4 },
}

export function defaultKeyRangeAdjustment(singer: SingerStyleInfo): number {
  if (singer.type !== 'frame_decode') return 0
  return KEY_RANGE_ADJUSTMENT[singer.singerName]?.[singer.styleName] ?? 0
}
