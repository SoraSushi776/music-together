import { getUserQuotaRemaining, isUserQuotaReached } from '@/lib/quota'
import { useRoomStore } from '@/stores/roomStore'
import { LIMITS } from '@music-together/shared'
import { useMemo } from 'react'

export interface AddQuotaInfo {
  /** Human-readable reason why adding is currently blocked; undefined = allowed */
  disabledReason?: string
  /** Remaining per-listener quota; `null` = no limit configured */
  remaining: number | null
}

/**
 * Client-side gating for add-song buttons, mirroring the server's
 * `checkAddQuota`: global queue size first, then the per-listener quota
 * (only upcoming tracks count). Used to disable the + button up front
 * instead of letting the click fail server-side.
 */
export function useAddQuota(): AddQuotaInfo {
  const room = useRoomStore((s) => s.room)
  const currentUser = useRoomStore((s) => s.currentUser)

  return useMemo(() => {
    if (!room) return { remaining: null }
    if (room.queue.length >= LIMITS.QUEUE_MAX_SIZE) {
      return { disabledReason: '播放队列已满', remaining: 0 }
    }
    const remaining = getUserQuotaRemaining(room, currentUser?.nickname)
    if (isUserQuotaReached(room, currentUser?.nickname)) {
      return { disabledReason: '已达点歌上限，待歌曲播放后可继续', remaining: 0 }
    }
    return { remaining }
  }, [room, currentUser?.nickname])
}
