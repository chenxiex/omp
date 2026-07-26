import usePlayQueueStore from '@/store/usePlayQueueStore'
import useUiStore from '@/store/useUiStore'
import type { FileNode, Track } from '@/types/file'
import { appendTracksToPlayQueue, insertTracksNextInPlayQueue } from '@/utils/playQueue'
import { fileNodeToTrack } from '@/utils/track'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import { IconButton, ListItemText, Menu, MenuItem } from '@mui/material'
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/shallow'
import AddToPlaylistDialog from './AddToPlaylistDialog'

export interface LibrarySongMenuTarget {
  // 保存点击瞬间的坐标，避免虚拟列表重挂载后原按钮 DOM 失效。
  anchorPosition: LibrarySongMenuPosition
  // 保存实际节点而非列表索引，避免虚拟列表重排后操作到其他歌曲。
  fileNode: FileNode
}

export interface LibrarySongMenuPosition {
  top: number
  left: number
}

export const LibrarySongMenuButton = ({
  onClick,
}: {
  onClick: (anchorPosition: LibrarySongMenuPosition) => void
}) => {
  const { t } = useLingui()

  return (
    <IconButton
      aria-label={t`More`}
      onClick={event => {
        event.stopPropagation()
        const anchorRect = event.currentTarget.getBoundingClientRect()
        onClick({ top: anchorRect.bottom, left: anchorRect.left })
      }}
    >
      <MoreVertRoundedIcon />
    </IconButton>
  )
}

const LibrarySongMenu = ({
  target,
  onClose,
  onNavigate,
}: {
  target: LibrarySongMenuTarget | null
  onClose: () => void
  onNavigate?: () => void
}) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const playQueue = usePlayQueueStore.use.playQueue()
  const currentIndex = usePlayQueueStore.use.currentIndex()
  const updatePlayQueue = usePlayQueueStore.use.updatePlayQueue()
  const [updateAudioViewIsShow, updateVideoViewIsShow, updatePlayQueueIsShow] = useUiStore(
    useShallow(state => [state.updateAudioViewIsShow, state.updateVideoViewIsShow, state.updatePlayQueueIsShow]),
  )
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([])

  const openPlaylistDialog = () => {
    if (!target) return

    // 菜单关闭后父组件会清空 target，因此先保存播放列表弹窗所需的歌曲快照。
    setPlaylistTracks([fileNodeToTrack(target.fileNode)])
    onClose()
  }

  const addToPlayQueue = () => {
    if (!target) return

    updatePlayQueue(appendTracksToPlayQueue(playQueue, [fileNodeToTrack(target.fileNode)]))
    onClose()
  }

  const playNext = () => {
    if (!target) return

    updatePlayQueue(insertTracksNextInPlayQueue(
      playQueue,
      currentIndex,
      [fileNodeToTrack(target.fileNode)],
    ))
    onClose()
  }

  const openInFolder = () => {
    if (!target) return

    const folderPath = target.fileNode.path.slice(0, -1).join('/')
    onClose()
    updateAudioViewIsShow(false)
    updateVideoViewIsShow(false)
    updatePlayQueueIsShow(false)
    // 搜索页借此先关闭搜索对话框，普通库页面无需额外处理。
    onNavigate?.()
    navigate(`/files/${folderPath}`)
  }

  return (
    <>
      <Menu
        anchorReference='anchorPosition'
        anchorPosition={target?.anchorPosition}
        open={Boolean(target)}
        onClose={onClose}
      >
        <MenuItem onClick={openPlaylistDialog}>
          <ListItemText primary={t`Add to playlist`} />
        </MenuItem>
        <MenuItem onClick={playNext}>
          <ListItemText primary={t`Play next`} />
        </MenuItem>
        <MenuItem onClick={addToPlayQueue}>
          <ListItemText primary={t`Add to play queue`} />
        </MenuItem>
        <MenuItem onClick={openInFolder}>
          <ListItemText primary={t`Open in folder`} />
        </MenuItem>
      </Menu>

      <AddToPlaylistDialog
        open={playlistTracks.length > 0}
        tracks={playlistTracks}
        onClose={() => setPlaylistTracks([])}
      />
    </>
  )
}

export default LibrarySongMenu
