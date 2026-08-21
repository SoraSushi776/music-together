import type { PlayMode, Track } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'

/** Result of a single-track queue add attempt. */
export type AddResult = 'added' | 'queue-full' | 'user-limit'

/**
 * How many tracks in the queue were requested by `requester`.
 * `requestedBy` is the nickName injected by the server when a user adds a song,
 * which is the same key used by `interleaveByRequester` for fairness ordering.
 */
function countTracksByRequester(room: { queue: Track[] }, requester: string | undefined): number {
  if (!requester) return 0
  return room.queue.filter((t) => t.requestedBy === requester).length
}

/**
 * Whether adding one more track for `requester` would exceed the room's
 * per-listener quota. Returns the concrete failure reason, or null if allowed.
 */
function checkAddQuota(
  room: { queue: Track[]; maxSongsPerUser: number },
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

interface RequesterGroup {
  key: string
  tracks: Track[]
}

/**
 * Interleave tracks so that consecutive tracks come from different requesters
 * whenever possible. Original order is preserved within each requester's
 * songs; tie-breaks are random so repeated shuffles vary.
 *
 * Two strategies:
 * - Feasible case (no requester owns more than the rest combined + 1):
 *   greedy interleave — always place from the largest eligible group
 *   (different requester than the last placed track).
 * - Dominant case: the dominant requester's songs are split into evenly
 *   sized runs (ceil(M / (rest + 1)) each), with other songs as separators,
 *   which minimizes the longest same-requester streak.
 */
export function interleaveByRequester(tracks: Track[]): Track[] {
  if (tracks.length <= 2) return [...tracks]

  const groups = new Map<string, Track[]>()
  for (const track of tracks) {
    const key = track.requestedBy ?? '__anonymous__'
    const group = groups.get(key)
    if (group) group.push(track)
    else groups.set(key, [track])
  }
  if (groups.size <= 1) return [...tracks]

  const entries: RequesterGroup[] = [...groups.entries()].map(([key, list]) => ({ key, tracks: [...list] }))
  entries.sort((a, b) => b.tracks.length - a.tracks.length)

  const dominant = entries[0]
  const others = entries.slice(1)
  const othersTotal = tracks.length - dominant.tracks.length

  if (dominant.tracks.length > othersTotal + 1) {
    return interleaveDominant(dominant, others)
  }
  return greedyInterleave(entries)
}

/** Greedy interleave: largest eligible group first, random pick among ties. */
function greedyInterleave(entries: RequesterGroup[]): Track[] {
  const pending = entries.map((g) => ({ ...g, tracks: [...g.tracks] }))
  const result: Track[] = []
  let lastKey: string | null = null

  while (pending.length > 0) {
    // Eligible groups: a different requester than the last placed track.
    // When every remaining song belongs to that requester, clustering is
    // unavoidable and we take from it anyway.
    const eligible = pending.filter((g) => g.key !== lastKey)
    const pool = eligible.length > 0 ? eligible : pending

    const maxCount = Math.max(...pool.map((g) => g.tracks.length))
    const candidates = pool.filter((g) => g.tracks.length === maxCount)
    const group = candidates[Math.floor(Math.random() * candidates.length)]
    if (!group) break

    const track = group.tracks.shift()
    if (track) {
      result.push(track)
      lastKey = group.key
    }
    if (group.tracks.length === 0) pending.splice(pending.indexOf(group), 1)
  }

  return result
}

/**
 * Dominant case: split the dominant requester's songs into evenly sized runs
 * and use every other song as a separator between runs.
 */
function interleaveDominant(dominant: RequesterGroup, others: RequesterGroup[]): Track[] {
  const separators = others.flatMap((g) => g.tracks)
  const runCount = separators.length + 1
  const runSize = Math.ceil(dominant.tracks.length / runCount)

  const result: Track[] = []
  let cursor = 0
  for (let run = 0; run < runCount; run++) {
    const take = Math.min(runSize, dominant.tracks.length - cursor)
    result.push(...dominant.tracks.slice(cursor, cursor + take))
    cursor += take
    if (run < runCount - 1 && run < separators.length) {
      result.push(separators[run])
    }
  }
  return result
}

/**
 * Shuffle the queue by interleaving requesters so one person's songs don't
 * play back-to-back. Tracks up to and including the currently playing one
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
