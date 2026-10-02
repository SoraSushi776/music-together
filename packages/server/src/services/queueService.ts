import type { PlayMode, Track, UserRole } from '@music-together/shared'
import { LIMITS, defineAbilityFor } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'

/** Result of a single-track queue add attempt. */
export type AddResult = 'added' | 'queue-full' | 'user-limit'

/**
 * The not-yet-played part of the queue. The queue keeps played tracks
 * (playlist semantics — `getNextTrack` advances by index and never prunes),
 * so "upcoming" is everything positioned strictly after the effective
 * current track (a scheduled `pendingPlayback` track if present, else
 * `currentTrack`). When nothing is playing, the whole queue is upcoming.
 */
function upcomingTracks(
  room: Pick<RoomData, 'queue' | 'currentTrack'> & { pendingPlayback?: RoomData['pendingPlayback'] },
): Track[] {
  const effective = room.pendingPlayback?.track ?? room.currentTrack
  if (!effective) return room.queue
  const index = room.queue.findIndex((t) => t.id === effective.id)
  if (index < 0) return room.queue
  return room.queue.slice(index + 1)
}

/**
 * How many *upcoming* (not yet played) tracks were requested by `requester`.
 * `requestedBy` is the nickName injected by the server when a user adds a song,
 * which is the same key used by `interleaveByRequester` for fairness ordering.
 *
 * Played tracks and the currently playing track do NOT occupy the per-listener
 * quota — otherwise a listener whose songs all finished could never add new
 * ones without deleting the old entries first.
 */
function countTracksByRequester(
  room: Pick<RoomData, 'queue' | 'currentTrack'> & { pendingPlayback?: RoomData['pendingPlayback'] },
  requester: string | undefined,
): number {
  if (!requester) return 0
  return upcomingTracks(room).filter((t) => t.requestedBy === requester).length
}

/**
 * Whether adding one more track for `requester` would exceed the room's
 * per-listener quota. Returns the concrete failure reason, or null if allowed.
 *
 * Note: the per-listener quota only counts upcoming tracks (see
 * `countTracksByRequester`), while the global QUEUE_MAX_SIZE applies to the
 * whole queue including already-played entries.
 */
function checkAddQuota(
  room: Pick<RoomData, 'queue' | 'currentTrack' | 'maxSongsPerUser'> & {
    pendingPlayback?: RoomData['pendingPlayback']
  },
  requester: string | undefined,
): Exclude<AddResult, 'added'> | null {
  if (room.queue.length >= LIMITS.QUEUE_MAX_SIZE) return 'queue-full'
  if (room.maxSongsPerUser > 0) {
    const existing = countTracksByRequester(room, requester)
    if (existing >= room.maxSongsPerUser) return 'user-limit'
  }
  return null
}

export function addTrack(roomId: string, track: Track): AddResult {
  const room = roomRepo.get(roomId)
  if (!room) return 'queue-full'
  const blocked = checkAddQuota(room, track.requestedBy)
  if (blocked) return blocked
  room.queue.push(track)
  return 'added'
}

/**
 * Add multiple tracks at once (from playlist import).
 * Respects both QUEUE_MAX_SIZE and the per-listener quota — adds as many as fit.
 * @returns Number of tracks actually added and the reason addition stopped (if any).
 */
export function addBatchTracks(
  roomId: string,
  tracks: Track[],
): { added: number; reason?: 'queue-full' | 'user-limit' } {
  const room = roomRepo.get(roomId)
  if (!room) return { added: 0 }
  const available = LIMITS.QUEUE_MAX_SIZE - room.queue.length
  if (available <= 0) return { added: 0, reason: 'queue-full' }

  let quota = available
  if (room.maxSongsPerUser > 0) {
    const requester = tracks[0]?.requestedBy
    const existing = countTracksByRequester(room, requester)
    const remaining = Math.max(0, room.maxSongsPerUser - existing)
    quota = Math.min(available, remaining)
  }
  if (quota <= 0) return { added: 0, reason: 'user-limit' }

  const toAdd = tracks.slice(0, quota)
  room.queue.push(...toAdd)
  return { added: toAdd.length }
}

/**
 * Insert a new track right after the current playing track.
 * If current track is missing from the queue (edge race), insert to the front.
 */
export function insertAfterCurrent(roomId: string, track: Track): AddResult {
  const room = roomRepo.get(roomId)
  if (!room) return 'queue-full'
  const blocked = checkAddQuota(room, track.requestedBy)
  if (blocked) return blocked

  const currentId = room.currentTrack?.id
  const currentIndex = currentId ? room.queue.findIndex((t) => t.id === currentId) : -1
  const insertIndex = currentIndex >= 0 ? currentIndex + 1 : 0
  room.queue.splice(insertIndex, 0, track)
  return 'added'
}

export function removeTrack(roomId: string, trackId: string): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.queue = room.queue.filter((t) => t.id !== trackId)
  }
}

/**
 * Remove all *upcoming* tracks requested by `requester` — used when a listener
 * leaves the room so their queued songs no longer occupy the playlist.
 *
 * The played/unplayed boundary matches the per-listener quota
 * (`countTracksByRequester`): played tracks, the currently playing track and a
 * scheduled `pendingPlayback` track are kept, so playlist history and
 * in-flight playback are not disrupted.
 *
 * @returns the tracks that were actually removed (empty array = nothing matched).
 */
export function removeTracksByRequester(roomId: string, requester: string | undefined): Track[] {
  if (!requester) return []
  const room = roomRepo.get(roomId)
  if (!room) return []

  const effective = room.pendingPlayback?.track ?? room.currentTrack
  // -1 when nothing is playing (or the effective track is missing from the
  // queue): everything is upcoming, mirroring `upcomingTracks`.
  const boundaryIndex = effective ? room.queue.findIndex((t) => t.id === effective.id) : -1

  const removed: Track[] = []
  const kept: Track[] = []
  room.queue.forEach((track, index) => {
    if (index > boundaryIndex && track.requestedBy === requester) removed.push(track)
    else kept.push(track)
  })
  if (removed.length === 0) return []

  room.queue = kept
  return removed
}

/**
 * Whether `user` may remove the track with `trackId` from the queue WITHOUT a
 * vote. Privileged roles (owner/admin — CASL `remove` on `Queue`) may remove
 * any track; ordinary members may remove only tracks they requested
 * themselves (`requestedBy` nickname match, the same identity dimension the
 * per-listener quota uses).
 */
export function canRemoveTrackWithoutVote(
  room: Pick<RoomData, 'queue'>,
  user: { role: UserRole; nickname: string },
  trackId: string,
): boolean {
  if (defineAbilityFor(user.role).can('remove', 'Queue')) return true
  const target = room.queue.find((t) => t.id === trackId)
  return !!target?.requestedBy && target.requestedBy === user.nickname
}

/** Resolve the track that should follow a removed current item, using the queue before removal. */
export function getSuccessorAfterRemoval(roomId: string, trackId: string, playMode: PlayMode): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null
  const removedIndex = room.queue.findIndex((track) => track.id === trackId)
  if (removedIndex < 0) return null

  const remaining = room.queue.filter((track) => track.id !== trackId)
  if (remaining.length === 0) return null

  switch (playMode) {
    case 'shuffle':
      return remaining[Math.floor(Math.random() * remaining.length)] ?? null
    case 'loop-all':
    case 'loop-one':
      return remaining[removedIndex] ?? remaining[0]
    case 'sequential':
    default:
      return remaining[removedIndex] ?? null
  }
}

export function clearQueue(roomId: string): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.queue = []
  }
}

export function reorderTracks(roomId: string, trackIds: string[]): void {
  const room = roomRepo.get(roomId)
  if (!room) return
  if (!Array.isArray(trackIds) || trackIds.length === 0) return

  const trackMap = new Map(room.queue.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const reordered: Track[] = []
  for (const id of trackIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const track = trackMap.get(id)
    if (track) reordered.push(track)
  }
  // Append any tracks that were NOT included in trackIds (prevent accidental drops)
  for (const track of room.queue) {
    if (!seen.has(track.id)) {
      reordered.push(track)
    }
  }
  room.queue = reordered
}

/**
 * Give each requester one turn per round, preserving their own song order.
 * Randomize requester order once, then keep that order for every round. Song
 * counts must not affect priority: even a one-song listener joins round one.
 * Once other listeners run out, the remaining songs necessarily play together.
 */
export function interleaveByRequester(tracks: Track[]): Track[] {
  if (tracks.length <= 2) return [...tracks]

  const groups = new Map<string | undefined, Track[]>()
  for (const track of tracks) {
    const group = groups.get(track.requestedBy)
    if (group) group.push(track)
    else groups.set(track.requestedBy, [track])
  }
  if (groups.size <= 1) return [...tracks]

  const turns = [...groups.values()]
  for (let i = turns.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[turns[i], turns[j]] = [turns[j], turns[i]]
  }

  const result: Track[] = []
  for (let round = 0; result.length < tracks.length; round++) {
    for (const group of turns) {
      if (round < group.length) result.push(group[round])
    }
  }
  return result
}

/**
 * Shuffle the queue into rounds with one song per requester.
 * Tracks up to and including the currently playing one
 * keep their positions; only the upcoming part is shuffled. When nothing is
 * playing, the whole queue is shuffled.
 *
 * @returns true when the room exists and has a shufflable queue.
 */
export function shuffleQueue(roomId: string): boolean {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length <= 2) return false

  const effectiveTrack = room.pendingPlayback?.track ?? room.currentTrack
  const currentIndex = effectiveTrack ? room.queue.findIndex((t) => t.id === effectiveTrack.id) : -1

  const head = currentIndex >= 0 ? room.queue.slice(0, currentIndex + 1) : []
  const tail = room.queue.slice(head.length)

  room.queue = [...head, ...interleaveByRequester(tail)]
  return true
}

/**
 * Get the next track based on the play mode.
 *
 * - sequential: next in queue; null at end
 * - loop-all:   next in queue; wraps to first at end
 * - loop-one:   returns the current track itself
 * - shuffle:    random track from queue (excludes current; returns self if queue has 1 item)
 */
export function getNextTrack(roomId: string, playMode?: PlayMode): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null

  const mode = playMode ?? room.playMode ?? 'sequential'

  const currentIndex = room.currentTrack ? room.queue.findIndex((t) => t.id === room.currentTrack!.id) : -1

  switch (mode) {
    case 'loop-one':
      // Replay the current track; fall back to next if current is gone
      if (room.currentTrack && currentIndex >= 0) return room.currentTrack
      return room.queue[0] ?? null

    case 'loop-all': {
      const nextIndex = currentIndex + 1
      return nextIndex < room.queue.length ? room.queue[nextIndex] : room.queue[0] // wrap to first
    }

    case 'shuffle': {
      if (room.queue.length === 1) return room.queue[0]
      // Pick a random track excluding the current one
      const candidates = room.queue.filter((_, i) => i !== currentIndex)
      return candidates[Math.floor(Math.random() * candidates.length)] ?? room.queue[0]
    }

    case 'sequential':
    default: {
      const nextIndex = currentIndex + 1
      return nextIndex < room.queue.length ? room.queue[nextIndex] : null
    }
  }
}

export function getPreviousTrack(roomId: string): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null

  const currentIndex = room.currentTrack ? room.queue.findIndex((t) => t.id === room.currentTrack!.id) : -1

  // For loop-all, wrap to last track when at the beginning
  if (room.playMode === 'loop-all' && currentIndex <= 0) {
    return room.queue[room.queue.length - 1]
  }

  const prevIndex = currentIndex - 1
  return prevIndex >= 0 ? room.queue[prevIndex] : null
}
