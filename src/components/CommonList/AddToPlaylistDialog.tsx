import usePlaylistsStore from '@/store/usePlaylistsStore'
import type { Track } from '@/types/file'
import PlaylistAddRoundedIcon from '@mui/icons-material/PlaylistAddRounded'
import ListRoundedIcon from '@mui/icons-material/ListRounded'
import {
  Button,
  Dialog,
  DialogActions,
  DialogTitle,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from '@mui/material'
import { useLingui } from '@lingui/react/macro'
import shortUUID from 'short-uuid'
import { useShallow } from 'zustand/shallow'

const AddToPlaylistDialog = ({
  open,
  tracks,
  onClose,
  onAdded,
}: {
  open: boolean
  tracks: Track[]
  onClose: () => void
  onAdded?: () => void
}) => {
  const { t } = useLingui()
  const [playlists, insertPlaylist, insertFilesToPlaylist] = usePlaylistsStore(
    useShallow(state => [state.playlists, state.insertPlaylist, state.insertFilesToPlaylist]),
  )

  const addNewPlaylist = () => {
    // 与原 CommonMenu 行为一致：先创建空列表，让用户再选择该列表完成添加。
    insertPlaylist({ id: shortUUID().generate(), name: t`New playlist`, files: [] })
  }

  const addToPlaylist = (id: string) => {
    if (tracks.length === 0) return

    insertFilesToPlaylist(id, tracks)
    onAdded?.()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth='xs'>
      <DialogTitle>{t`Add to playlist`}</DialogTitle>
      <List>
        {playlists?.map(item => (
          <ListItem disablePadding key={item.id}>
            <ListItemButton sx={{ pl: 3 }} onClick={() => addToPlaylist(item.id)}>
              <ListItemIcon>
                <ListRoundedIcon />
              </ListItemIcon>
              <ListItemText primary={item.name} />
            </ListItemButton>
          </ListItem>
        ))}
        <ListItem disablePadding>
          <ListItemButton sx={{ pl: 3 }} onClick={addNewPlaylist}>
            <ListItemIcon>
              <PlaylistAddRoundedIcon />
            </ListItemIcon>
            <ListItemText primary={t`Add playlist`} />
          </ListItemButton>
        </ListItem>
      </List>
      <DialogActions>
        <Button onClick={onClose}>{t`Cancel`}</Button>
      </DialogActions>
    </Dialog>
  )
}

export default AddToPlaylistDialog
