// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TrackListItem } from './TrackListItem'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Track } from '@music-together/shared'

const mockTrack: Track = {
  id: 'test-1',
  title: 'Test Song',
  artist: ['Test Artist'],
  album: 'Test Album',
  duration: 200,
  cover: 'https://example.com/cover.jpg',
  thumbnailCover: 'https://example.com/thumbnail.jpg',
  source: 'netease',
  sourceId: '123',
  urlId: '123',
}

function renderComponent(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('TrackListItem thumbnail optimization', () => {
  it('renders thumbnailCover when provided', () => {
    const { container } = renderComponent(
      <TrackListItem
        track={mockTrack}
        index={0}
        isAdded={false}
        onAdd={vi.fn()}
      />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'https://example.com/thumbnail.jpg')
  })

  it('falls back to cover when thumbnailCover is not provided', () => {
    const trackWithoutThumb = { ...mockTrack, thumbnailCover: undefined }
    const { container } = renderComponent(
      <TrackListItem
        track={trackWithoutThumb}
        index={0}
        isAdded={false}
        onAdd={vi.fn()}
      />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'https://example.com/cover.jpg')
  })
})

describe('TrackListItem add-disabled state (per-listener quota reached)', () => {
  it('keeps the + button visible but disabled, with the reason as aria-label', () => {
    renderComponent(
      <TrackListItem
        track={mockTrack}
        index={0}
        isAdded={false}
        addDisabledReason="已达点歌上限，待歌曲播放后可继续"
        onAdd={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: '已达点歌上限，待歌曲播放后可继续' })
    expect(button).toBeDisabled()
  })

  it('does not fire onAdd when disabled', () => {
    const onAdd = vi.fn()
    renderComponent(
      <TrackListItem track={mockTrack} index={0} isAdded={false} addDisabledReason="已达点歌上限" onAdd={onAdd} />,
    )
    // fireEvent (not userEvent) to avoid pointer-hover opening the tooltip in jsdom.
    fireEvent.click(screen.getByRole('button', { name: '已达点歌上限' }))
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('hides the insert-after-current button while adds are disabled', () => {
    renderComponent(
      <TrackListItem
        track={mockTrack}
        index={0}
        isAdded={false}
        addDisabledReason="已达点歌上限"
        onAdd={vi.fn()}
        onInsertAfterCurrent={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: `置顶 ${mockTrack.title}` })).toBeNull()
  })

  it('shows the added checkmark state regardless of the disable reason', () => {
    renderComponent(
      <TrackListItem
        track={mockTrack}
        index={0}
        isAdded
        addDisabledReason="已达点歌上限"
        onAdd={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '已添加' })).toBeDisabled()
  })
})
