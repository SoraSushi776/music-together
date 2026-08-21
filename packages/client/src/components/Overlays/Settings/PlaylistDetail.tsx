import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VirtualTrackList } from '@/components/VirtualTrackList'
import { useAddQuota, type AddQuotaInfo } from '@/hooks/useAddQuota'
import { useAddedTracks } from '@/hooks/useAddedTracks'
import type { Playlist, Track } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { ArrowLeft, ListPlus, Music } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

interface PlaylistDetailProps {
  playlist: Playlist | null
  tracks: Track[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  onBack: () => void
  onAddTrack: (track: Track) => void
  onInsertAfterCurrent?: (track: Track) => void
  onAddAll: (tracks: Track[], playlistName?: string) => void
  onLoadMore: () => void
  /** Add gating (queue full / per-listener quota) shared with the parent dialog. */
  addQuota?: AddQuotaInfo
}

export function PlaylistDetail({
  playlist,
  tracks,
  loading,
  loadingMore,
  hasMore,
  total,
  onBack,
  onAddTrack,
  onInsertAfterCurrent,
  onAddAll,
  onLoadMore,
  addQuota,
}: PlaylistDetailProps) {
  const { queue, markPending, isTrackAdded, isInQueue } = useAddedTracks()
  const fallbackQuota = useAddQuota()
  const quota = addQuota ?? fallbackQuota

  const handleAddTrack = useCallback(
    (track: Track) => {
      if (isInQueue(track) || isTrackAdded(track)) {
        toast.info(`「${track.title}」已在队列中`)
        return
      }
      onAddTrack(track)
      markPending([track])
    },
    [onAddTrack, isInQueue, isTrackAdded, markPending],
  )

  const handleInsertAfterCurrent = useCallback(
    (track: Track) => {
      if (isInQueue(track) || isTrackAdded(track)) {
        toast.info(`「${track.title}」已在队列中`)
        return
      }
      onInsertAfterCurrent?.(track)
      markPending([track])
    },
    [onInsertAfterCurrent, isInQueue, isTrackAdded, markPending],
  )

  // Dynamic "add all" logic — filter duplicates, cap by queue size and per-listener quota
  const availableSlots = LIMITS.QUEUE_MAX_SIZE - queue.length
  const uniqueTracks = useMemo(() => tracks.filter((t) => !isTrackAdded(t)), [tracks, isTrackAdded])
  const addCount = Math.min(availableSlots, uniqueTracks.length, quota.remaining ?? Number.POSITIVE_INFINITY)
  const isQueueFull = availableSlots <= 0
  const isQuotaReached = !!quota.disabledReason
  const isAddAllDisabled = loading || isQueueFull || isQuotaReached || uniqueTracks.length === 0

  const handleAddAll = useCallback(() => {
    if (addCount <= 0) return
    const toAdd = uniqueTracks.slice(0, addCount)
    onAddAll(toAdd, playlist?.name)
    markPending(toAdd)
    if (addCount < uniqueTracks.length) {
      toast.success(`已添加 ${addCount} 首到队列（已达上限，还有 ${uniqueTracks.length - addCount} 首未添加）`)
    } else {
      toast.success(`已添加全部 ${addCount} 首到队列`)
    }
  }, [addCount, uniqueTracks, onAddAll, playlist?.name, markPending])

  // Button label
  let addAllLabel: string
  if (loading) {
    addAllLabel = '加载中…'
  } else if (tracks.length === 0) {
    addAllLabel = '添加全部'
  } else if (isQueueFull) {
    addAllLabel = '队列已满'
  } else if (isQuotaReached) {
    addAllLabel = '已达点歌上限'
  } else if (uniqueTracks.length === 0) {
    addAllLabel = '全部已添加'
  } else if (addCount === uniqueTracks.length) {
    addAllLabel = `添加全部 ${addCount} 首`
  } else {
    addAllLabel = `添加 ${addCount} 首到队列`
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Row 1: Back + Title — pr-8 reserves space for dialog close button */}
      <div className="flex shrink-0 items-center gap-2 pr-8">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{playlist?.name ?? '歌单详情'}</h4>
      </div>

      {/* Row 2: Info + Action */}
      <div className="flex shrink-0 items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          {loading
            ? '加载中…'
            : `${total} 首${tracks.length < total ? `（已加载 ${tracks.length}）` : ''}${playlist?.creator ? ` · ${playlist.creator}` : ''}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddAll}
          disabled={isAddAllDisabled}
          title={isAddAllDisabled && quota.disabledReason ? quota.disabledReason : undefined}
          className="shrink-0 gap-1"
        >
          <ListPlus className="h-3.5 w-3.5" />
          {addAllLabel}
        </Button>
      </div>

      <Separator className="shrink-0" />

      {/* Track list with shared virtual scrolling component */}
      <VirtualTrackList
        tracks={tracks}
        loading={loading}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        isTrackAdded={isTrackAdded}
        addDisabledReason={quota.disabledReason}
        onAddTrack={handleAddTrack}
        onInsertAfterCurrent={onInsertAfterCurrent ? handleInsertAfterCurrent : undefined}
        emptyIcon={<Music className="h-8 w-8" />}
        emptyMessage="歌单为空"
        className="border-0 rounded-none"
      />
    </div>
  )
}
