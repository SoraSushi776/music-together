import { describe, expect, it } from 'vitest'
import type { Track } from '@music-together/shared'
import {
  countUpcomingByRequester,
  getUserQuotaRemaining,
  isUserQuotaReached,
  upcomingTracks,
  type QuotaRoomView,
} from './quota'

let nextId = 0
function track(requestedBy?: string): Track {
  nextId += 1
  return {
    id: `t-${nextId}`,
    title: `Track ${nextId}`,
    artist: ['Artist'],
    album: 'Album',
    cover: '',
    duration: 100,
    source: 'netease',
    sourceId: String(nextId),
    urlId: String(nextId),
    requestedBy,
  }
}

function room(partial: Partial<QuotaRoomView> & Pick<QuotaRoomView, 'queue' | 'maxSongsPerUser'>): QuotaRoomView {
  return { currentTrack: null, ...partial }
}

describe('lib/quota — upcomingTracks', () => {
  it('returns the whole queue when nothing is playing', () => {
    const queue = [track(), track()]
    expect(upcomingTracks(room({ queue, maxSongsPerUser: 0 }))).toEqual(queue)
  })

  it('slices after the current track', () => {
    const a = track()
    const b = track()
    const c = track()
    const view = room({ queue: [a, b, c], currentTrack: b, maxSongsPerUser: 0 })
    expect(upcomingTracks(view)).toEqual([c])
  })

  it('returns the whole queue when the current track is missing from it', () => {
    const a = track()
    const b = track()
    const ghost = track()
    const view = room({ queue: [a, b], currentTrack: ghost, maxSongsPerUser: 0 })
    expect(upcomingTracks(view)).toEqual([a, b])
  })
})

describe('lib/quota — per-listener quota', () => {
  it('played tracks and the current track do NOT occupy the quota', () => {
    // A listener had 5 songs, all played (current is the last one). Cap 5.
    const played = Array.from({ length: 5 }, () => track('小明'))
    const current = played[played.length - 1]
    const view = room({ queue: played, currentTrack: current, maxSongsPerUser: 5 })
    expect(countUpcomingByRequester(view, '小明')).toBe(0)
    expect(isUserQuotaReached(view, '小明')).toBe(false)
  })

  it('counts only the upcoming slice when the current track is mid-queue', () => {
    const a = track('小明')
    const b = track('小明')
    const c = track('小明')
    const view = room({ queue: [a, b, c], currentTrack: a, maxSongsPerUser: 2 })
    expect(countUpcomingByRequester(view, '小明')).toBe(2)
    expect(isUserQuotaReached(view, '小明')).toBe(true)
  })

  it('ignores other listeners’ tracks', () => {
    const a = track('小红')
    const b = track('小明')
    const c = track('小明')
    const view = room({ queue: [a, b, c], maxSongsPerUser: 2 })
    // 小红 only has 1 upcoming track with cap 2 — not reached yet.
    expect(isUserQuotaReached(view, '小红')).toBe(false)
    expect(getUserQuotaRemaining(view, '小红')).toBe(1)
    // 小明 has both of his tracks still upcoming with cap 2 — reached.
    expect(isUserQuotaReached(view, '小明')).toBe(true)
  })

  it('0 (or negative) means unlimited', () => {
    const view = room({ queue: [track('小明'), track('小明')], maxSongsPerUser: 0 })
    expect(getUserQuotaRemaining(view, '小明')).toBeNull()
    expect(isUserQuotaReached(view, '小明')).toBe(false)
  })

  it('unknown nickname gets the full quota as remaining', () => {
    const view = room({ queue: [track('小明')], maxSongsPerUser: 2 })
    expect(getUserQuotaRemaining(view, undefined)).toBe(2)
    expect(isUserQuotaReached(view, undefined)).toBe(false)
  })

  it('returns remaining quota', () => {
    const view = room({ queue: [track('小明'), track('小明')], maxSongsPerUser: 5 })
    expect(getUserQuotaRemaining(view, '小明')).toBe(3)
  })
})
