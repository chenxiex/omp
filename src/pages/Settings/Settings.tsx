import { Alert, Avatar, Box, Button, Checkbox, Dialog, DialogActions, DialogTitle, Divider, FormControl, FormControlLabel, IconButton, List, ListItem, ListItemAvatar, ListItemButton, ListItemText, MenuItem, Select, SelectChangeEvent, TextField, Tooltip, Typography } from '@mui/material'
import useUser from '@/hooks/graph/useUser'
import { licenses } from '@/data/licenses'
import useLocalMetaDataStore from '@/store/useLocalMetaDataStore'
import useUiStore from '@/store/useUiStore'
import { UiState } from '@/types/ui'
import { useEffect, useMemo, useState } from 'react'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded'
import usePlayQueueStore from '@/store/usePlayQueueStore'
import usePlayerStore from '@/store/usePlayerStore'
import useHistoryStore from '@/store/useHistoryStore'
import usePlaylistsStore from '@/store/usePlaylistsStore'
import { AccountInfo } from '@azure/msal-browser'
import { useShallow } from 'zustand/shallow'
import INFO from '@/data/info'
import { useLingui } from '@lingui/react/macro'
import SetLibraryFolderDialog from '@/components/Dialog/SetLibraryFolderDialog'
import { useLiveQuery } from 'dexie-react-hooks'
import useDb from '@/hooks/useDb'
import { useMsal } from '@azure/msal-react'
import useGraph from '@/hooks/graph/useGraph'
import ListItemTitle from '@/components/ListItemTitle'
import { getRemotePath } from '@/utils/remote'
import { checkMediaProxy, normalizeMediaProxyUrl } from '@/utils/mediaProxy'

type MediaProxyTestStatus = 'idle' | 'testing' | 'success' | 'error'

const Settings = () => {
  const { t } = useLingui()

  const { instance } = useMsal()
  const { accounts, account, login, logout } = useUser()
  const db = useDb(account)

  const { getFileData } = useGraph(instance, account)

  const { clearLocalMetaData } = useLocalMetaDataStore()

  const [
    currentAccount,
    CoverThemeColor,
    colorMode,
    updateCurrentAccount,
    updateCoverThemeColor,
    updateColorMode,
    mediaProxyEnabled,
    mediaProxyUrl,
    mediaProxyAccessKey,
    updateMediaProxyEnabled,
    updateMediaProxyUrl,
    updateMediaProxyAccessKey
  ] = useUiStore(
    useShallow(
      (state) => [
        state.currentAccount,
        state.CoverThemeColor,
        state.colorMode,
        state.updateCurrentAccount,
        state.updateCoverThemeColor,
        state.updateColorMode,
        state.mediaProxyEnabled,
        state.mediaProxyUrl,
        state.mediaProxyAccessKey,
        state.updateMediaProxyEnabled,
        state.updateMediaProxyUrl,
        state.updateMediaProxyAccessKey
      ]
    )
  )

  const resetPlayQueue = usePlayQueueStore.use.resetPlayQueue()
  const resetPlayer = usePlayerStore(state => state.resetPlayer)
  const updateHistoryList = useHistoryStore((state) => state.updateHistoryList)
  const updatePlaylists = usePlaylistsStore((state) => state.updatePlaylists)

  const [accountsDialogOpen, setAccountsDialogOpen] = useState(false)
  const [libraryRootName, setLibraryRootName] = useState('')
  const [mediaProxyTestStatus, setMediaProxyTestStatus] = useState<MediaProxyTestStatus>('idle')

  const settings = useLiveQuery(() => db?.settings.get('settings'), [db])
  const libraryRootId = useMemo(() => settings?.libraryRootId, [settings])

  useEffect(
    () => {
      (async () => {
        if (libraryRootId) {
          const res = await getFileData(libraryRootId)
          setLibraryRootName(getRemotePath(res).join('/'))
        }
      })()
    },
    [db, getFileData, libraryRootId]
  )

  const handleCloseAccountsDialog = () => setAccountsDialogOpen(false)

  const resetMediaProxyTest = () => setMediaProxyTestStatus('idle')

  const handleMediaProxyTest = async () => {
    setMediaProxyTestStatus('testing')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    try {
      const normalizedUrl = normalizeMediaProxyUrl(mediaProxyUrl)
      await checkMediaProxy({ url: normalizedUrl, accessKey: mediaProxyAccessKey }, controller.signal)
      setMediaProxyTestStatus('success')
    } catch {
      setMediaProxyTestStatus('error')
    } finally {
      window.clearTimeout(timeout)
    }
  }

  const handleChangeAccount = (index: number) => {
    handleCloseAccountsDialog()
    if (currentAccount === index) return
    updateCurrentAccount(index)
    updateHistoryList([])
    updatePlaylists([])
    resetPlayQueue()
    resetPlayer()
  }

  const handleLogout = (account: AccountInfo) => {
    if (account.username === accounts[currentAccount].username) {
      resetPlayQueue()
      resetPlayer()
      updateHistoryList([])
      updatePlaylists([])
    }
    if (currentAccount === accounts.length - 1) {
      updateCurrentAccount((accounts.length - 1) <= 1 ? 0 : (accounts.length - 1))
    }
    logout(account)
  }

  return (
    <Box style={{ width: '100%', height: '100%', overflow: 'auto' }}>

      <List>
        <ListItemTitle title={t`Account`} />
        <ListItem
          secondaryAction={
            <Button onClick={() => setAccountsDialogOpen(true)}>{t`Manage`}</Button>
          }
        >
          <ListItemAvatar>
            {account && <Avatar aria-label={account.name}>{account.name?.split(' ')[0]}</Avatar>}
          </ListItemAvatar>
          {
            account
              ? <ListItemText primary={account.name} secondary={account.username} />
              : <ListItemText primary={t`Please use Microsoft account authorization to log in`} secondary={' '} />
          }

        </ListItem>

        {
          account &&
          <>
            <Divider sx={{ m: 1 }} />

            <ListItemTitle title={t`Library`} />
            <ListItem secondaryAction={<SetLibraryFolderDialog title={t`Select`} variant='text' />}>
              <ListItemText inset primary={t`Library folder`} secondary={libraryRootName} />
            </ListItem>
          </>
        }

        <Divider sx={{ m: 1 }} />

        <ListItemTitle title={t`Data`} />
        <ListItem
          secondaryAction={
            <Button onClick={async () => {
              await clearLocalMetaData()
              await db?.metadata.clear()
              await db?.pictures.clear()
            }}>
              {t`Clear`}
            </Button>
          }
        >
          <ListItemText inset primary={t`Local metaData cache`} secondary=' ' />
        </ListItem>

        <Divider sx={{ m: 1 }} />

        <ListItemTitle title={t`Media proxy`} />
        <ListItem sx={{ pl: { xs: 2, sm: 9 } }}>
          <Alert severity='warning' sx={{ width: '100%' }}>
            {t`Only use a Worker you control. Signed media URLs contain a reversible encoding of the short-lived single-file download URL and may appear in Worker request logs, but never contain a Microsoft Graph token or the proxy key. Use a long random proxy key. This configuration stays in this browser and is not synced to OneDrive.`}
          </Alert>
        </ListItem>
        <ListItem
          secondaryAction={
            <FormControlLabel
              control={<Checkbox checked={mediaProxyEnabled} />}
              label={false}
              onChange={() => {
                updateMediaProxyEnabled(!mediaProxyEnabled)
                resetMediaProxyTest()
              }}
            />
          }
        >
          <ListItemText inset primary={t`Enable media proxy`} secondary={t`Disabled by default`} />
        </ListItem>
        <ListItem sx={{ pl: { xs: 2, sm: 9 }, pr: { xs: 2, sm: 3 } }}>
          <TextField
            fullWidth
            label={t`Worker HTTPS address`}
            placeholder='https://media-proxy.example.workers.dev'
            value={mediaProxyUrl}
            onChange={(event) => {
              updateMediaProxyUrl(event.target.value)
              resetMediaProxyTest()
            }}
          />
        </ListItem>
        <ListItem sx={{ pl: { xs: 2, sm: 9 }, pr: { xs: 2, sm: 3 } }}>
          <TextField
            fullWidth
            type='password'
            autoComplete='new-password'
            label={t`Proxy access key`}
            value={mediaProxyAccessKey}
            onChange={(event) => {
              updateMediaProxyAccessKey(event.target.value)
              resetMediaProxyTest()
            }}
          />
        </ListItem>
        <ListItem sx={{ pl: { xs: 2, sm: 9 }, gap: 2 }}>
          <Button
            variant='outlined'
            disabled={mediaProxyTestStatus === 'testing'}
            onClick={() => void handleMediaProxyTest()}
          >
            {mediaProxyTestStatus === 'testing' ? t`Testing…` : t`Test connection and key`}
          </Button>
          {mediaProxyTestStatus === 'success' && (
            <Typography color='success.main'>{t`Connection and key verified`}</Typography>
          )}
          {mediaProxyTestStatus === 'error' && (
            <Typography color='error.main'>{t`Connection or key verification failed`}</Typography>
          )}
        </ListItem>

        <Divider sx={{ m: 1 }} />

        <ListItemTitle title={t`Customize`} />
        <ListItem
          secondaryAction={
            <FormControl variant="standard">
              <Select
                labelId="color-mode-select-label"
                id="color-mode-select"
                value={colorMode}
                onChange={(event: SelectChangeEvent) => updateColorMode(event.target.value as UiState['colorMode'])}
              >
                <MenuItem value={'auto'}> {t`Auto`} </MenuItem>
                <MenuItem value={'light'}> {t`Light`} </MenuItem>
                <MenuItem value={'dark'}> {t`Dark`} </MenuItem>
              </Select>
            </FormControl>
          }
        >
          <ListItemText inset primary={t`Color mode`} secondary=' ' />
        </ListItem>

        <ListItem
          secondaryAction={
            <FormControlLabel
              control={<Checkbox checked={CoverThemeColor} />}
              label={false}
              onChange={() => updateCoverThemeColor(!CoverThemeColor)}
            />
          }
        >
          <ListItemText inset primary={t`Use album cover theme color`} secondary=' ' />
        </ListItem>

        <Divider sx={{ m: 1 }} />

        <ListItemTitle title={t`About`} />
        <ListItem disablePadding>
          <ListItemButton onClick={() => window.open('https://github.com/nini22P/omp', '_blank')}>
            <ListItemText inset primary='OMP - OneDrive Media Player' secondary='AGPL-3.0' />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton onClick={() => window.open(INFO.dev ? 'https://github.com/nini22P/omp/tree/dev' : `https://github.com/nini22P/omp/releases/tag/v${INFO.version}`, '_blank')}>
            <ListItemText inset primary={t`Version`} secondary={INFO.version} />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton>
            <ListItemText inset primary={t`Build time`} secondary={(new Date(INFO.buildTime)).toLocaleString()} />
          </ListItemButton>
        </ListItem>

        <Divider sx={{ m: 1 }} />

        <ListItemTitle title={t`Open source dependencies`} />
        {
          licenses.map((license) =>
            <ListItem key={license.name} disablePadding>
              <ListItemButton onClick={() => window.open(license.link, '_blank')}>
                <ListItemText inset primary={license.name} secondary={license.licenseType} />
              </ListItemButton>
            </ListItem>
          )
        }

      </List>

      <Dialog open={accountsDialogOpen} onClose={handleCloseAccountsDialog} >
        <DialogTitle>{t`Select account`}</DialogTitle>
        <List>
          {
            accounts.map((account, index) =>
              <ListItem
                key={index}
                disablePadding
                secondaryAction={
                  <Tooltip title={t`Sign out`}>
                    <IconButton onClick={() => handleLogout(account)}>
                      <LogoutRoundedIcon />
                    </IconButton>
                  </Tooltip>
                }>
                <ListItemButton onClick={() => handleChangeAccount(index)}>
                  <ListItemAvatar>
                    <Avatar aria-label={account.name}>{account.name?.split(' ')[0]}</Avatar>
                  </ListItemAvatar>
                  <ListItemText primary={account.name} secondary={account.username} sx={{ paddingRight: 2 }} />
                </ListItemButton>
              </ListItem>)
          }
          <ListItem disablePadding>
            <ListItemButton onClick={() => login()}>
              <ListItemAvatar>
                <Avatar>
                  <AddRoundedIcon />
                </Avatar>
              </ListItemAvatar>
              <ListItemText primary={t`Add account`} />
            </ListItemButton>
          </ListItem>
        </List>
        <DialogActions>
          <Button onClick={handleCloseAccountsDialog}>{t`Cancel`}</Button>
        </DialogActions>
      </Dialog>

    </Box>

  )
}

export default Settings
