import type { Track } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'
import {
  addBatchTracks,
  addTrack,
  canRemoveTrackWithoutVote,
  getNextTrack,
  getPreviousTrack,
  getSuccessorAfterRemoval,
  insertAfterCurrent,
  interleaveByRequester,
  removeTracksByRequester,
  reorderTracks,
  shuffleQueue,
} from './queueService.js'

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: ['Artist'],
    album: 'Album',
    duration: 180,
    cover: '',
    source: 'netease',
    sourceId: id,
    urlId: id,
  }
}

function makeRequestedTrack(id: string, requestedBy: string): Track {
  return { ...makeTrack(id), requestedBy }
}

function makeRoom(queue: Track[], currentTrack: Track | null = null): RoomData {
  return {
    id: 'ROOM01',
    name: 'Test Room',
    password: null,
    creatorId: 'owner',
    hostId: 'owner',
    conductorSocketId: 'socket-owner',
    adminUserIds: new Set(),
    temporaryAdminUserId: null,
    audioQuality: 320,
    users: [],
    queue,
    currentTrack,
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now(), revision: 0 },
    playMode: 'sequential',
    disableVoting: false,
    maxSongsPerUser: 0,
  }
}

afterEach(() => {
  roomRepo.delete('ROOM01')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('queueService', () => {
  it('inserts immediately after the current track', () => {
    const a = makeTrack('a')
    const b = makeTrack('b')
    const inserted = makeTrack('inserted')
    roomRepo.set('ROOM01', makeRoom([a, b], a))

    expect(insertAfterCurrent('ROOM01', inserted)).toBe('added')
    expect(roomRepo.get('ROOM01')?.queue.map((track) => track.id)).toEqual(['a', 'inserted', 'b'])
  })

  it('reorders known IDs without dropping unspecified tracks or duplicating IDs', () => {
    const a = makeTrack('a')
    const b = makeTrack('b')
    const c = makeTrack('c')
    roomRepo.set('ROOM01', makeRoom([a, b, c], a))

    reorderTracks('ROOM01', ['c', 'c', 'missing', 'a'])

    expect(roomRepo.get('ROOM01')?.queue.map((track) => track.id)).toEqual(['c', 'a', 'b'])
  })

  it('respects the queue capacity for batch additions', () => {
    const existing = Array.from({ length: LIMITS.QUEUE_MAX_SIZE - 1 }, (_, i) => makeTrack(`existing-${i}`))
    roomRepo.set('ROOM01', makeRoom(existing))

    expect(addBatchTracks('ROOM01', [makeTrack('new-1'), makeTrack('new-2')])).toEqual({ added: 1 })
    expect(roomRepo.get('ROOM01')?.queue).toHaveLength(LIMITS.QUEUE_MAX_SIZE)
  })

  it('implements sequential, loop and shuffle next-track behavior', () => {
    const a = makeTrack('a')
    const b = makeTrack('b')
    const c = makeTrack('c')
    roomRepo.set('ROOM01', makeRoom([a, b, c], c))

    expect(getNextTrack('ROOM01', 'sequential')).toBeNull()
    expect(getNextTrack('ROOM01', 'loop-all')?.id).toBe('a')
    expect(getNextTrack('ROOM01', 'loop-one')?.id).toBe('c')

    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(getNextTrack('ROOM01', 'shuffle')?.id).toBe('a')
  })

  it('selects the item after a removed current track without jumping backwards', () => {
    const a = makeTrack('a')
    const b = makeTrack('b')
    const c = makeTrack('c')
    roomRepo.set('ROOM01', makeRoom([a, b, c], b))

    expect(getSuccessorAfterRemoval('ROOM01', 'b', 'sequential')?.id).toBe('c')
    expect(getSuccessorAfterRemoval('ROOM01', 'c', 'sequential')).toBeNull()
    expect(getSuccessorAfterRemoval('ROOM01', 'c', 'loop-all')?.id).toBe('a')
  })

  it('wraps previous track only in loop-all mode', () => {
    const a = makeTrack('a')
    const b = makeTrack('b')
    const room = makeRoom([a, b], a)
    roomRepo.set('ROOM01', room)

    expect(getPreviousTrack('ROOM01')).toBeNull()
    room.playMode = 'loop-all'
    expect(getPreviousTrack('ROOM01')?.id).toBe('b')
  })
})

describe('queueService — per-listener song limit (maxSongsPerUser)', () => {
  it('allows unlimited songs when limit is 0 (default)', () => {
    roomRepo.set('ROOM01', makeRoom([]))
    const tracks = Array.from({ length: 5 }, (_, i) => makeRequestedTrack(`a${i}`, 'A'))
    for (const t of tracks) {
      expect(addTrack('ROOM01', t)).toBe('added')
    }
    expect(roomRepo.get('ROOM01')?.queue).toHaveLength(5)
  })

  it('blocks a single listener once they reach the per-user cap', () => {
    roomRepo.set('ROOM01', makeRoom([makeRequestedTrack('a1', 'A'), makeRequestedTrack('a2', 'A')]))
    roomRepo.get('ROOM01')!.maxSongsPerUser = 2

    // 3rd song by the same listener is rejected
    expect(addTrack('ROOM01', makeRequestedTrack('a3', 'A'))).toBe('user-limit')
    expect(roomRepo.get('ROOM01')?.queue).toHaveLength(2)

    // but a different listener is still allowed
    expect(addTrack('ROOM01', makeRequestedTrack('b1', 'B'))).toBe('added')
    expect(roomRepo.get('ROOM01')?.queue).toHaveLength(3)
  })

  it('enforces the cap on insertAfterCurrent too', () => {
    const a1 = makeRequestedTrack('a1', 'A')
    roomRepo.set(
      'ROOM01',
      makeRoom([a1, makeRequestedTrack('a2', 'A'), makeRequestedTrack('a3', 'A')], a1),
    )
    roomRepo.get('ROOM01')!.maxSongsPerUser = 2

    // a2/a3 are upcoming and already fill A's quota; the playing a1 does not count
    expect(insertAfterCurrent('ROOM01', makeRequestedTrack('a4', 'A'))).toBe('user-limit')
    expect(insertAfterCurrent('ROOM01', makeRequestedTrack('b1', 'B'))).toBe('added')
  })

  it('played tracks and the current track do NOT occupy the per-listener quota', () => {
    // Regression: with playlist semantics the queue keeps played tracks forever.
    // A listener whose 5 songs all finished must be able to queue new songs
    // again without deleting the old entries.
    const played = Array.from({ length: 4 }, (_, i) => makeRequestedTrack(`p${i}`, 'A'))
    const lastPlayed = makeRequestedTrack('p4', 'A')
    roomRepo.set('ROOM01', makeRoom([...played, lastPlayed], lastPlayed))
    roomRepo.get('ROOM01')!.maxSongsPerUser = 5

    // All 5 of A's songs are played; nothing upcoming -> quota is free again
    expect(addTrack('ROOM01', makeRequestedTrack('a-new', 'A'))).toBe('added')
    expect(roomRepo.get('ROOM01')?.queue).toHaveLength(6)
  })

  it('counts only the upcoming slice when the current track is mid-queue', () => {
    const played = [makeRequestedTrack('p0', 'A'), makeRequestedTrack('p1', 'A')]
    const current = makeRequestedTrack('cur', 'A')
    const upcoming = [makeRequestedTrack('u0', 'A')]
    roomRepo.set('ROOM01', makeRoom([...played, current, ...upcoming], current))
    roomRepo.get('ROOM01')!.maxSongsPerUser = 2

    // Only u0 (upcoming) counts; p0/p1 (played) and cur (playing) don't
    expect(addTrack('ROOM01', makeRequestedTrack('u1', 'A'))).toBe('added')
    expect(addTrack('ROOM01', makeRequestedTrack('u2', 'A'))).toBe('user-limit')
  })

  it('uses a scheduled pendingPlayback track as the played/played-not boundary', () => {
    const room = makeRoom(
      [
        makeRequestedTrack('p0', 'A'),
        makeRequestedTrack('scheduled', 'A'),
        makeRequestedTrack('u0', 'A'),
      ],
      makeRequestedTrack('p0', 'A'),
    )
    room.maxSongsPerUser = 2
    const timer = setTimeout(() => {}, 60_000)
    room.pendingPlayback = {
      type: 'play',
      track: room.queue[1],
      playState: { isPlaying: true, currentTime: 0, serverTimestamp: Date.now(), revision: 1, serverTimeToExecute: Date.now() + 1000 },
      timer,
    }
    roomRepo.set('ROOM01', room)

    try {
      // Boundary is the scheduled track: only u0 counts against A's quota
      expect(addTrack('ROOM01', makeRequestedTrack('u1', 'A'))).toBe('added')
      expect(addTrack('ROOM01', makeRequestedTrack('u2', 'A'))).toBe('user-limit')
    } finally {
      clearTimeout(timer)
    }
  })

  it('caps a batch import at the remaining per-user quota', () => {
    roomRepo.set('ROOM01', makeRoom([makeRequestedTrack('a0', 'A')]))
    roomRepo.get('ROOM01')!.maxSongsPerUser = 3

    const batch = Array.from({ length: 5 }, (_, i) => makeRequestedTrack(`a${i + 1}`, 'A'))
    expect(addBatchTracks('ROOM01', batch)).toEqual({ added: 2 })
    expect(roomRepo.get('ROOM01')?.queue.filter((t) => t.requestedBy === 'A')).toHaveLength(3)
  })

  it('returns user-limit when the per-user cap is already exhausted even if the queue has room', () => {
    roomRepo.set('ROOM01', makeRoom(Array.from({ length: 3 }, (_, i) => makeRequestedTrack(`a${i}`, 'A'))))
    roomRepo.get('ROOM01')!.maxSongsPerUser = 3

    const batch = Array.from({ length: 4 }, (_, i) => makeRequestedTrack(`b${i}`, 'A'))
    expect(addBatchTracks('ROOM01', batch)).toEqual({ added: 0, reason: 'user-limit' })
  })
})

describe('queueService — canRemoveTrackWithoutVote (self-removal rule)', () => {
  const own = makeRequestedTrack('own-1', '小明')
  const others = makeRequestedTrack('other-1', '小红')
  const anonymous = makeTrack('anon-1')
  const room = { queue: [own, others, anonymous] }

  it('lets a member remove their own requested track without a vote', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'member', nickname: '小明' }, 'own-1')).toBe(true)
  })

  it('blocks a member from removing tracks requested by others', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'member', nickname: '小明' }, 'other-1')).toBe(false)
  })

  it('blocks a member from removing tracks without a requester (e.g. imported)', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'member', nickname: '小明' }, 'anon-1')).toBe(false)
  })

  it('blocks a member whose nickname no longer matches (renamed after queuing)', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'member', nickname: '小明_new' }, 'own-1')).toBe(false)
  })

  it('blocks when the track does not exist in the queue', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'member', nickname: '小明' }, 'missing')).toBe(false)
  })

  it('lets owner and admin remove any track', () => {
    expect(canRemoveTrackWithoutVote(room, { role: 'owner', nickname: '房主' }, 'other-1')).toBe(true)
    expect(canRemoveTrackWithoutVote(room, { role: 'admin', nickname: '管理员' }, 'anon-1')).toBe(true)
  })
})

describe('queueService — removeTracksByRequester (auto-remove on leave)', () => {
  it('removes only the requester’s upcoming tracks, keeping played/current/others’ tracks', () => {
    const playedA = makeRequestedTrack('played-a', 'A')
    const currentA = makeRequestedTrack('current-a', 'A')
    const upcomingA1 = makeRequestedTrack('upcoming-a1', 'A')
    const upcomingA2 = makeRequestedTrack('upcoming-a2', 'A')
    const upcomingB = makeRequestedTrack('upcoming-b', 'B')
    const anonymous = makeTrack('anon')
    roomRepo.set(
      'ROOM01',
      makeRoom([playedA, currentA, upcomingA1, upcomingB, upcomingA2, anonymous], currentA),
    )

    const removed = removeTracksByRequester('ROOM01', 'A')

    expect(removed.map((t) => t.id).sort()).toEqual(['upcoming-a1', 'upcoming-a2'])
    expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual([
      'played-a',
      'current-a',
      'upcoming-b',
      'anon',
    ])
  })

  it('treats a scheduled pendingPlayback track as the played/unplayed boundary', () => {
    const current = makeRequestedTrack('current', 'B')
    const scheduled = makeRequestedTrack('scheduled', 'A')
    const upcomingA = makeRequestedTrack('upcoming-a', 'A')
    const room = makeRoom([current, scheduled, upcomingA], current)
    const timer = setTimeout(() => {}, 60_000)
    room.pendingPlayback = {
      type: 'play',
      track: scheduled,
      playState: { isPlaying: true, currentTime: 0, serverTimestamp: Date.now(), revision: 1, serverTimeToExecute: Date.now() + 1000 },
      timer,
    }
    roomRepo.set('ROOM01', room)

    try {
      // The already-scheduled track must survive; only upcoming-a is removed
      const removed = removeTracksByRequester('ROOM01', 'A')
      expect(removed.map((t) => t.id)).toEqual(['upcoming-a'])
      expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual(['current', 'scheduled'])
    } finally {
      clearTimeout(timer)
    }
  })

  it('removes everything for the requester when nothing is playing', () => {
    const a1 = makeRequestedTrack('a1', 'A')
    const b1 = makeRequestedTrack('b1', 'B')
    roomRepo.set('ROOM01', makeRoom([a1, b1]))

    const removed = removeTracksByRequester('ROOM01', 'A')
    expect(removed.map((t) => t.id)).toEqual(['a1'])
    expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual(['b1'])
  })

  it('returns an empty list when nothing matches (no-op, no queue mutation)', () => {
    const b1 = makeRequestedTrack('b1', 'B')
    const anon = makeTrack('anon')
    roomRepo.set('ROOM01', makeRoom([b1, anon]))

    expect(removeTracksByRequester('ROOM01', 'A')).toEqual([])
    expect(removeTracksByRequester('ROOM01', undefined)).toEqual([])
    expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual(['b1', 'anon'])
  })

  it('returns an empty list for a missing room', () => {
    expect(removeTracksByRequester('NOPE', 'A')).toEqual([])
  })
})

describe('interleaveByRequester', () => {
  it('gives every requester a turn before starting the next round', () => {
    // Keep Fisher-Yates in input order so the reported regression is readable.
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const tracks = [...'AAABBBCCCDDE'].map((person, i) => makeRequestedTrack(String(i), person))
    const originalIds = tracks.map((t) => t.id)

    const result = interleaveByRequester(tracks)

    expect(result.map((t) => t.requestedBy).join('')).toBe('ABCDEABCDABC')
    expect(tracks.map((t) => t.id)).toEqual(originalIds)
    expect(result.map((t) => t.id).sort()).toEqual([...originalIds].sort())
    for (const person of 'ABCDE') {
      expect(result.filter((t) => t.requestedBy === person).map((t) => t.id)).toEqual(
        tracks.filter((t) => t.requestedBy === person).map((t) => t.id),
      )
    }
  })

  it('lets one-song listeners participate in the first round even if one listener dominates', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const tracks = [...'AAAAABC'].map((person, i) => makeRequestedTrack(String(i), person))
    expect(interleaveByRequester(tracks).map((t) => t.requestedBy).join('')).toBe('ABCAAAA')
  })

  it('randomizes requester order once and keeps the same turns in later rounds', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const tracks = [...'AABBCC'].map((person, i) => makeRequestedTrack(String(i), person))
    expect(interleaveByRequester(tracks).map((t) => t.requestedBy).join('')).toBe('BCABCA')
  })

  it('preserves empty, short and single-requester queues', () => {
    for (const people of ['', 'A', 'AB', 'AAA']) {
      const tracks = [...people].map((person, i) => makeRequestedTrack(String(i), person))
      expect(interleaveByRequester(tracks)).toEqual(tracks)
    }
  })

  it('treats tracks without a requester as one group', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const tracks = [makeTrack('unknown1'), makeTrack('unknown2'), makeRequestedTrack('a1', 'A')]
    expect(interleaveByRequester(tracks).map((t) => t.id)).toEqual(['unknown1', 'a1', 'unknown2'])
  })

  it('takes exactly one song per active requester per round for uneven distributions', () => {
    // Deterministic coverage of 256 count distributions, including empty groups.
    for (let distribution = 0; distribution < 256; distribution++) {
      const counts = Array.from({ length: 4 }, (_, i) => (distribution >> (i * 2)) & 3)
      const tracks = counts.flatMap((count, person) =>
        Array.from({ length: count }, (_, i) => makeRequestedTrack(`${person}-${i}`, String(person))),
      )
      const result = interleaveByRequester(tracks)
      expect(result.map((t) => t.id).sort()).toEqual(tracks.map((t) => t.id).sort())
      let offset = 0
      for (let round = 0; round < Math.max(...counts); round++) {
        const active = counts.flatMap((count, person) => count > round ? [String(person)] : [])
        const batch = result.slice(offset, offset + active.length)
        expect(batch.map((t) => t.requestedBy).sort()).toEqual(active)
        for (const t of batch) expect(t.id).toBe(`${t.requestedBy}-${round}`)
        offset += active.length
      }
    }
  })
})

describe('shuffleQueue', () => {
  it('keeps already-played tracks and the current one in place, interleaving the rest', () => {
    const played = makeRequestedTrack('played', 'A')
    const current = makeRequestedTrack('current', 'A')
    const pending = [
      makeRequestedTrack('a2', 'A'),
      makeRequestedTrack('a3', 'A'),
      makeRequestedTrack('b1', 'B'),
      makeRequestedTrack('c1', 'C'),
    ]
    roomRepo.set('ROOM01', makeRoom([played, current, ...pending], current))

    expect(shuffleQueue('ROOM01')).toBe(true)

    const queue = roomRepo.get('ROOM01')!.queue
    expect(queue.slice(0, 2).map((t) => t.id)).toEqual(['played', 'current'])
    expect(queue.slice(2).map((t) => t.id).sort()).toEqual(['a2', 'a3', 'b1', 'c1'])
    const upcoming = queue.slice(2)
    expect(new Set(upcoming.slice(0, 3).map((t) => t.requestedBy))).toEqual(new Set(['A', 'B', 'C']))
    expect(upcoming[3].requestedBy).toBe('A')
  })

  it('shuffles the whole queue when nothing is playing', () => {
    const tracks = [
      makeRequestedTrack('a1', 'A'),
      makeRequestedTrack('a2', 'A'),
      makeRequestedTrack('a3', 'A'),
      makeRequestedTrack('b1', 'B'),
      makeRequestedTrack('c1', 'C'),
    ]
    roomRepo.set('ROOM01', makeRoom(tracks))

    expect(shuffleQueue('ROOM01')).toBe(true)

    const queue = roomRepo.get('ROOM01')!.queue
    expect(queue).toHaveLength(tracks.length)
    expect(queue.map((t) => t.id).sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'c1'])
    expect(new Set(queue.slice(0, 3).map((t) => t.requestedBy))).toEqual(new Set(['A', 'B', 'C']))
    expect(queue.slice(3).map((t) => t.requestedBy)).toEqual(['A', 'A'])
  })

  it('keeps the scheduled next track and everything before it fixed', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    vi.useFakeTimers()
    const current = makeRequestedTrack('current', 'A')
    const scheduled = makeRequestedTrack('scheduled', 'A')
    const tail = [...'AAABBBCCCDDE'].map((person, i) => makeRequestedTrack(String(i), person))
    const data = makeRoom([current, scheduled, ...tail], current)
    data.pendingPlayback = {
      type: 'play', track: scheduled, timer: setTimeout(() => {}, 300),
      playState: { ...data.playState, revision: 1, serverTimeToExecute: Date.now() + 300 },
    }
    roomRepo.set('ROOM01', data)

    expect(shuffleQueue('ROOM01')).toBe(true)
    expect(data.queue.slice(0, 2)).toEqual([current, scheduled])
    expect(data.queue.slice(2).map((t) => t.requestedBy).join('')).toBe('ABCDEABCDABC')
  })

  it('is a no-op for rooms with two or fewer tracks', () => {
    roomRepo.set('ROOM01', makeRoom([makeTrack('a'), makeTrack('b')]))
    expect(shuffleQueue('ROOM01')).toBe(false)
    expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual(['a', 'b'])
  })
})
