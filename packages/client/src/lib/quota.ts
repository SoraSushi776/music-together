import type { Track } from '@music-together/shared'

/**
 * Client-side view of the room fields needed to compute the per-listener quota.
 *
 * Mirrors the server's queueService quota semantics: only *upcoming* tracks
 * (those after the current playing track) occupy a listener's quota — played
 * tracks never do. The server additionally treats a scheduled pendingPlayback
 * track as the boundary, but that is internal server state not serialized to
 * clients, so `currentTrack` is the best boundary available client-side.
 */
export interface QuotaRoomView {
  queue: Track[]
  currentTrack: Track | null
  /** 0 = 不限制 */
  maxSongsPerUser: number
}

/** Tracks that have not been played yet (the slice after the current track). */
export function upcomingTracks(room: QuotaRoomView): Track[] {
  if (!room.currentTrack) return room.queue
  const index = room.queue.findIndex((t) => t.id === room.currentTrack?.id)
  if (index < 0) return room.queue
  return room.queue.slice(index + 1)
}

/** How many upcoming tracks were requested by `nickname`. */
export function countUpcomingByRequester(room: QuotaRoomView, nickname: string): number {
  return upcomingTracks(room).filter((t) => t.requestedBy === nickname).length
}

/** Remaining add quota for `nickname`; `null` when the room has no limit. */
export function getUserQuotaRemaining(room: QuotaRoomView, nickname: string | undefined): number | null {
  if (room.maxSongsPerUser <= 0) return null
  if (!nickname) return room.maxSongsPerUser
  return Math.max(0, room.maxSongsPerUser - countUpcomingByRequester(room, nickname))
}

/** Whether `nickname` has used up their per-listener add quota. */
export function isUserQuotaReached(room: QuotaRoomView, nickname: string | undefined): boolean {
  const remaining = getUserQuotaRemaining(room, nickname)
  return remaining !== null && remaining <= 0
}
