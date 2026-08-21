import { describe, expect, it } from 'vitest'
import { LIMITS } from './constants.js'
import {
  coverQuerySchema,
  queueAddBatchSchema,
  roomCreateSchema,
  roomJoinSchema,
  searchQuerySchema,
  urlQuerySchema,
  voteStartSchema,
} from './schemas.js'

const track = {
  id: 'track-1',
  title: 'Blank Space',
  artist: ['Taylor Swift'],
  album: '1989',
  duration: 231,
  cover: '',
  source: 'tencent' as const,
  sourceId: '003VHaBb0wCHop',
  urlId: '003VHaBb0wCHop',
}

describe('shared schemas', () => {
  it('rejects empty nicknames and oversized room names', () => {
    expect(roomCreateSchema.safeParse({ nickname: '' }).success).toBe(false)
    expect(
      roomCreateSchema.safeParse({
        nickname: 'listener',
        roomName: 'x'.repeat(LIMITS.ROOM_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })

  it('applies the nickname limit consistently when joining', () => {
    expect(roomJoinSchema.safeParse({ roomId: 'ROOM01', nickname: 'listener' }).success).toBe(true)
    expect(
      roomJoinSchema.safeParse({
        roomId: 'ROOM01',
        nickname: 'x'.repeat(LIMITS.NICKNAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })

  it('validates vote payloads by action', () => {
    expect(voteStartSchema.safeParse({ action: 'pause' }).success).toBe(true)
    expect(voteStartSchema.safeParse({ action: 'set-mode', payload: {} }).success).toBe(false)
    expect(voteStartSchema.safeParse({ action: 'set-mode', payload: { mode: 'shuffle' } }).success).toBe(true)
    expect(voteStartSchema.safeParse({ action: 'play-track', payload: { trackId: '' } }).success).toBe(false)
  })

  it('preserves track title/cover for play-track and remove-track votes', () => {
    const play = voteStartSchema.safeParse({
      action: 'play-track',
      payload: { trackId: 'abc', trackTitle: 'song name', cover: 'https://x/y.jpg', thumbnailCover: 'https://x/t.jpg' },
    })
    expect(play.success).toBe(true)
    // 关键：服务端解析后必须保留 trackTitle / cover，否则投票窗口无法显示歌曲
    expect((play.data as { payload: { trackTitle: string; cover: string; thumbnailCover: string } }).payload).toEqual({
      trackId: 'abc',
      trackTitle: 'song name',
      cover: 'https://x/y.jpg',
      thumbnailCover: 'https://x/t.jpg',
    })

    const remove = voteStartSchema.safeParse({ action: 'remove-track', payload: { trackId: 'abc', trackTitle: 'song name' } })
    expect(remove.success).toBe(true)
    // trackTitle 缺失应通过校验失败（避免投票窗口拿到无名歌曲）
    expect(
      voteStartSchema.safeParse({ action: 'remove-track', payload: { trackId: 'abc' } }).success,
    ).toBe(false)
  })

  it('bounds music resource IDs and numeric options', () => {
    expect(urlQuerySchema.safeParse({ source: 'netease', urlId: 'id', bitrate: 320 }).success).toBe(true)
    expect(urlQuerySchema.safeParse({ source: 'netease', urlId: 'x'.repeat(201), bitrate: 320 }).success).toBe(false)
    expect(coverQuerySchema.safeParse({ source: 'netease', picId: 'id', size: 5000 }).success).toBe(false)
  })

  it('coerces valid search pagination and rejects values outside limits', () => {
    const parsed = searchQuerySchema.parse({
      source: 'tencent',
      keyword: 'blank space',
      limit: '20',
      page: '2',
    })

    expect(parsed).toMatchObject({ limit: 20, page: 2, type: 'song' })
    expect(
      searchQuerySchema.safeParse({
        source: 'tencent',
        keyword: 'blank space',
        limit: LIMITS.SEARCH_PAGE_SIZE_MAX + 1,
      }).success,
    ).toBe(false)
  })

  it('enforces queue batch size limits', () => {
    expect(queueAddBatchSchema.safeParse({ tracks: [] }).success).toBe(false)
    expect(queueAddBatchSchema.safeParse({ tracks: [track] }).success).toBe(true)
    expect(
      queueAddBatchSchema.safeParse({
        tracks: Array.from({ length: LIMITS.QUEUE_BATCH_MAX_SIZE + 1 }, (_, i) => ({
          ...track,
          id: `track-${i}`,
        })),
      }).success,
    ).toBe(false)
  })
})
