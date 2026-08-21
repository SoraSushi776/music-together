import { trackKey } from '@/lib/utils'
import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { EVENTS } from '@music-together/shared'
import type { Track } from '@music-together/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'

const EMPTY_QUEUE: Track[] = []

/**
 * Tracks "already added" state for add-song UIs.
 *
 * Truth is queue membership (server-confirmed via QUEUE_UPDATED). A local
 * `pendingIds` set provides instant optimistic feedback and double-click
 * protection. It self-heals: keys that never land in the queue are dropped as
 * soon as any queue update or ROOM_ERROR arrives, so failed adds (per-listener
 * limit, queue full, …) no longer leave a permanently stuck checkmark — the
 * add button recovers automatically.
 */
export function useAddedTracks() {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const queueKeys = useMemo(() => new Set(queue.map(trackKey)), [queue])
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const { socket } = useSocketContext()

  // Drop optimistic keys that are still absent from the queue — either the add
  // failed, or it landed (queueKeys covers it now, keeping the key is harmless).
  const dropUnconfirmed = useCallback(() => {
    setPendingIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((key) => queueKeys.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [queueKeys])

  // Any queue change is a chance to reconcile with the server.
  useEffect(() => {
    dropUnconfirmed()
  }, [dropUnconfirmed])

  // The server explicitly rejected an action (ROOM_ERROR) — reconcile now
  // instead of waiting for the next queue update.
  useEffect(() => {
    socket.on(EVENTS.ROOM_ERROR, dropUnconfirmed)
    return () => {
      socket.off(EVENTS.ROOM_ERROR, dropUnconfirmed)
    }
  }, [socket, dropUnconfirmed])

  const markPending = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    setPendingIds((prev) => {
      const next = new Set(prev)
      for (const t of tracks) next.add(trackKey(t))
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setPendingIds(new Set())
  }, [])

  const isTrackAdded = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      return queueKeys.has(key) || pendingIds.has(key)
    },
    [queueKeys, pendingIds],
  )

  /** Server-confirmed queue membership only (no optimistic pending state). */
  const isInQueue = useCallback((track: Track) => queueKeys.has(trackKey(track)), [queueKeys])

  return { queue, queueKeys, markPending, reset, isTrackAdded, isInQueue }
}
