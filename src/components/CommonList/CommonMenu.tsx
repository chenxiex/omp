import { useNavigate } from 'react-router-dom'
import { Menu, MenuItem, ListItemText } from '@mui/material'
import usePlayQueueStore from '@/store/usePlayQueueStore'
import useUiStore from '@/store/useUiStore'
import { FileNode, Track } from '@/types/file'
import { useShallow } from 'zustand/shallow'
import { useLingui } from '@lingui/react/macro'
import { isAudio, isVideo } from '@/utils/checkFileType'
import { fileNodeToTrack } from '@/utils/track'
import { appendTracksToPlayQueue, insertTracksNextInPlayQueue } from '@/utils/playQueue'
import AddToPlaylistDialog from './AddToPlaylistDialog'

const CommonMenu = (
  {
    listData,
    listType,
    anchorEl,
    menuOpen,
    dialogOpen,
    selectIndex,
    selectIndexArray,
    setAnchorEl,
    setMenuOpen,
    setDialogOpen,
    setSelectIndex,
    setSelectIndexArray,
    handleClickRemove,
  }
    :
    {
      listData: FileNode[] | Track[],
      listType: 'files' | 'playlist' | 'playQueue',
      anchorEl: null | HTMLElement,
      menuOpen: boolean,
      dialogOpen: boolean,
      selectIndex: number | null,
      selectIndexArray: number[],
      setAnchorEl: (anchorEl: null | HTMLElement) => void,
      setMenuOpen: (menuOpen: boolean) => void,
      setDialogOpen: (dialogOpen: boolean) => void,
      setSelectIndex: (index: number | null) => void
      setSelectIndexArray: (setSelectIndexArray: number[]) => void,
      handleClickRemove?: (indexArray: number[]) => void,
    }
) => {
  const { t } = useLingui()

  const navigate = useNavigate()

  const playQueue = usePlayQueueStore.use.playQueue()
  const currentIndex = usePlayQueueStore.use.currentIndex()
  const updatePlayQueue = usePlayQueueStore.use.updatePlayQueue()

  const [updateAudioViewIsShow, updateVideoViewIsShow, updatePlayQueueIsShow] = useUiStore(
    useShallow((state) => [state.updateAudioViewIsShow, state.updateVideoViewIsShow, state.updatePlayQueueIsShow])
  )

  const handleCloseMenu = () => {
    setMenuOpen(false)
    setAnchorEl(null)
  }

  // 将单选和批量选择统一转换为 Track，供共享弹窗和队列追加逻辑使用。
  const selectedItem = typeof selectIndex === 'number' ? listData[selectIndex] : undefined
  const selectedTracks = selectedItem
    ? [fileNodeToTrack(selectedItem)]
    : selectIndexArray
      .map(index => listData[index])
      .filter((item): item is FileNode | Track => Boolean(item) && (isAudio(item.name) || isVideo(item.name)))
      .map(fileNodeToTrack)

  // 添加到播放队列
  const handleClickAddToPlayQueue = () => {
    updatePlayQueue(appendTracksToPlayQueue(playQueue, selectedTracks))
    setMenuOpen(false)
    setSelectIndex(null)
    setSelectIndexArray([])
  }

  // 插入到当前曲目之后，使其成为实际播放顺序中的下一首。
  const handleClickPlayNext = () => {
    updatePlayQueue(insertTracksNextInPlayQueue(playQueue, currentIndex, selectedTracks))
    setMenuOpen(false)
    setSelectIndex(null)
    setSelectIndexArray([])
  }

  // 打开所在文件夹
  const handleClickOpenInFolder = async () => {
    if (typeof selectIndex === 'number' && listData[selectIndex].path) {
      setMenuOpen(false)
      setSelectIndex(null)
      updateAudioViewIsShow(false)
      updateVideoViewIsShow(false)
      updatePlayQueueIsShow(false)
      navigate(`/files/${listData[selectIndex].path.slice(0, -1).join('/')}`)
    }
  }

  return (
    <>
      <Menu
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={handleCloseMenu}
      >
        <MenuItem onClick={() => {
          setDialogOpen(true)
          handleCloseMenu()
        }}>
          <ListItemText primary={t`Add to playlist`} />
        </MenuItem>
        {
          (listType !== 'playQueue') &&
          <MenuItem onClick={handleClickPlayNext}>
            <ListItemText primary={t`Play next`} />
          </MenuItem>
        }
        {
          (listType !== 'playQueue') &&
          <MenuItem onClick={handleClickAddToPlayQueue}>
            <ListItemText primary={t`Add to play queue`} />
          </MenuItem>
        }

        {  // 在 Files 组件中隐藏
          handleClickRemove && typeof selectIndex === 'number' &&
          <MenuItem onClick={handleClickOpenInFolder}>
            <ListItemText primary={t`Open in folder`} />
          </MenuItem>
        }

        {
          handleClickRemove &&
          <MenuItem
            onClick={() => {
              if (typeof selectIndex === 'number') {
                handleClickRemove([selectIndex])
              } else if (selectIndexArray.length > 0) {
                handleClickRemove(selectIndexArray)
              }
              setSelectIndex(null)
              setSelectIndexArray([])
              handleCloseMenu()
            }}
          >
            <ListItemText primary={t`Remove`} />
          </MenuItem>
        }

        {
          typeof selectIndex === 'number' && (selectIndexArray.length === 0) &&
          <MenuItem onClick={() => {
            if (typeof selectIndex === 'number') {
              setSelectIndexArray([...selectIndexArray, selectIndex])
            }
            handleCloseMenu()
            setSelectIndex(null)
          }}>
            <ListItemText primary={t`Select`} />
          </MenuItem>
        }

        {
          <MenuItem onClick={() => {
            setSelectIndex(null)
            setSelectIndexArray(Array.from({ length: listData.length }, (_, i) => i))
            handleCloseMenu()
          }}>
            <ListItemText primary={t`Select all`} />
          </MenuItem>
        }

        {
          (selectIndexArray.length > 0) &&
          <MenuItem onClick={() => {
            setSelectIndex(null)
            setSelectIndexArray([])
            handleCloseMenu()
          }}>
            <ListItemText primary={t`Cancel select`} />
          </MenuItem>
        }
      </Menu>

      <AddToPlaylistDialog
        open={dialogOpen}
        tracks={selectedTracks}
        onClose={() => setDialogOpen(false)}
        onAdded={() => {
          setSelectIndex(null)
          setSelectIndexArray([])
        }}
      />
    </>

  )
}

export default CommonMenu
