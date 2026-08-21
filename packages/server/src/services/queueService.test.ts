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
  it('spreads one requester’s songs across other requesters’ songs', () => {
    // 人A × 3 followed by 人B × 1 and 人C × 1 (the README shuffle scenario)
    const tracks = [
      makeRequestedTrack('a1', 'A'),
      makeRequestedTrack('a2', 'A'),
      makeRequestedTrack('a3', 'A'),
      makeRequestedTrack('b1', 'B'),
      makeRequestedTrack('c1', 'C'),
    ]

    const result = interleaveByRequester(tracks)

    expect(result).toHaveLength(tracks.length)
    expect(result.map((t) => t.id).sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'c1'])
    // No two adjacent tracks share a requester (achievable here: 3 vs 1+1)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].requestedBy).not.toBe(result[i - 1].requestedBy)
    }
  })

  it('never places the same requester twice in a row when interleaving is possible', () => {
    const tracks = [
      ...Array.from({ length: 4 }, (_, i) => makeRequestedTrack(`a${i}`, 'A')),
      ...Array.from({ length: 3 }, (_, i) => makeRequestedTrack(`b${i}`, 'B')),
      ...Array.from({ length: 3 }, (_, i) => makeRequestedTrack(`c${i}`, 'C')),
    ]

    const result = interleaveByRequester(tracks)

    for (let i = 1; i < result.length; i++) {
      expect(result[i].requestedBy).not.toBe(result[i - 1].requestedBy)
    }
    // A's songs keep their relative order
    const aIds = result.filter((t) => t.requestedBy === 'A').map((t) => t.id)
    expect(aIds).toEqual(['a0', 'a1', 'a2', 'a3'])
  })

  it('minimizes clustering when one requester dominates', () => {
    // A has 5, B and C have 1 each — perfect interleaving is impossible.
    // Best achievable: at most ⌈5/(1+1+1)⌉ = 2 consecutive A tracks.
    const tracks = [
      ...Array.from({ length: 5 }, (_, i) => makeRequestedTrack(`a${i}`, 'A')),
      makeRequestedTrack('b0', 'B'),
      makeRequestedTrack('c0', 'C'),
    ]

    const result = interleaveByRequester(tracks)

    let maxRun = 1
    let run = 1
    for (let i = 1; i < result.length; i++) {
      run = result[i].requestedBy === result[i - 1].requestedBy ? run + 1 : 1
      maxRun = Math.max(maxRun, run)
    }
    expect(maxRun).toBeLessThanOrEqual(2)
  })

  it('returns short queues and single-requester queues unchanged in content', () => {
    const single = [makeRequestedTrack('a1', 'A'), makeRequestedTrack('a2', 'A'), makeRequestedTrack('a3', 'A')]
    expect(interleaveByRequester(single).map((t) => t.id)).toEqual(['a1', 'a2', 'a3'])

    const two = [makeRequestedTrack('a1', 'A'), makeRequestedTrack('b1', 'B')]
    expect(interleaveByRequester(two).map((t) => t.id)).toEqual(['a1', 'b1'])
  })

  it('keeps no-adjacent-same-requester across random feasible distributions', () => {
    // Property check: whenever no requester owns more than the rest + 1,
    // interleaving without adjacent duplicates must always be achievable —
    // regardless of random tie-breaks.
    for (let seedCase = 0; seedCase < 50; seedCase++) {
      const personCount = 2 + Math.floor(Math.random() * 4)
      const tracks: Track[] = []
      for (let person = 0; person < personCount; person++) {
        const count = Math.floor(Math.random() * 5)
        for (let i = 0; i < count; i++) {
          tracks.push(makeRequestedTrack(`case${seedCase}-p${person}-t${i}`, `p${person}`))
        }
      }
      if (tracks.length < 3) continue

      const counts = new Map<string, number>()
      for (const t of tracks) counts.set(t.requestedBy!, (counts.get(t.requestedBy!) ?? 0) + 1)
      const maxCount = Math.max(...counts.values())
      const feasible = maxCount <= tracks.length - maxCount + 1

      const result = interleaveByRequester(tracks)
      expect(result.map((t) => t.id).sort()).toEqual(tracks.map((t) => t.id).sort())
      if (feasible) {
        for (let i = 1; i < result.length; i++) {
          expect(result[i].requestedBy).not.toBe(result[i - 1].requestedBy)
        }
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
    // Upcoming part: A's two songs are not adjacent (B and C can separate them)
    const upcoming = queue.slice(2)
    for (let i = 1; i < upcoming.length; i++) {
      expect(upcoming[i].requestedBy).not.toBe(upcoming[i - 1].requestedBy)
    }
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
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i].requestedBy).not.toBe(queue[i - 1].requestedBy)
    }
  })

  it('is a no-op for rooms with two or fewer tracks', () => {
    roomRepo.set('ROOM01', makeRoom([makeTrack('a'), makeTrack('b')]))
    expect(shuffleQueue('ROOM01')).toBe(false)
    expect(roomRepo.get('ROOM01')?.queue.map((t) => t.id)).toEqual(['a', 'b'])
  })
})
