// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { EVENTS, type RoomState, type Track } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoomStore } from '@/stores/roomStore'
import { useAddedTracks } from './useAddedTracks'

const { listeners, socket } = vi.hoisted(() => {
  const listeners = new Map<string, () => void>()
  return {
    listeners,
    socket: {
      on: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
      off: vi.fn((event: string) => listeners.delete(event)),
    },
  }
})

vi.mock('@/providers/SocketProvider', () => ({ useSocketContext: () => ({ socket }) }))

const track: Track = {
  id: 'first-result',
  title: 'Song',
  artist: ['Artist'],
  album: '',
  duration: 180,
  cover: '',
  source: 'netease',
  sourceId: '123',
  urlId: '123',
}

beforeEach(() => {
  const room: RoomState = {
    id: 'ROOM01',
    name: 'Room',
    creatorId: 'owner',
    hostId: 'owner',
    conductorSocketId: null,
    hasPassword: false,
    audioQuality: 320,
    users: [],
    queue: [],
    currentTrack: null,
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: 0, revision: 0 },
    playMode: 'sequential',
    disableVoting: false,
    maxSongsPerUser: 0,
  }
  useRoomStore.getState().setRoom(room)
})

afterEach(() => {
  cleanup()
  useRoomStore.getState().reset()
  listeners.clear()
})

describe('useAddedTracks server reconciliation', () => {
  it('allows adding again after a confirmed track is removed without remounting search', () => {
    const { result } = renderHook(useAddedTracks)
    act(() => result.current.markPending([track]))
    expect(result.current.isTrackAdded(track)).toBe(true)
    expect(result.current.isInQueue(track)).toBe(false)

    act(() => useRoomStore.getState().updateRoom({ queue: [track] }))
    expect(result.current.isInQueue(track)).toBe(true)
    // A fresh search result can have a new ID for the same platform song.
    expect(result.current.isTrackAdded({ ...track, id: 'new-result' })).toBe(true)

    act(() => useRoomStore.getState().updateRoom({ queue: [] }))
    expect(result.current.isTrackAdded(track)).toBe(false)
    act(() => result.current.markPending([track]))
    expect(result.current.isTrackAdded(track)).toBe(true)
  })

  it('restores a failed add on ROOM_ERROR while keeping confirmed songs marked', () => {
    const confirmed = { ...track, id: 'confirmed', sourceId: '456' }
    act(() => useRoomStore.getState().updateRoom({ queue: [confirmed] }))
    const { result } = renderHook(useAddedTracks)
    act(() => result.current.markPending([track, confirmed]))
    act(() => listeners.get(EVENTS.ROOM_ERROR)?.())
    expect(result.current.isTrackAdded(track)).toBe(false)
    expect(result.current.isTrackAdded(confirmed)).toBe(true)
  })

  it('reconciles partial batch additions and recovers after the queue is cleared', () => {
    const rejected = { ...track, id: 'rejected', sourceId: '789' }
    const { result } = renderHook(useAddedTracks)
    act(() => result.current.markPending([track, rejected]))
    act(() => useRoomStore.getState().updateRoom({ queue: [track] }))
    expect(result.current.isTrackAdded(track)).toBe(true)
    expect(result.current.isTrackAdded(rejected)).toBe(false)
    act(() => useRoomStore.getState().updateRoom({ queue: [] }))
    expect(result.current.isTrackAdded(track)).toBe(false)
  })
})
