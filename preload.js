const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),
  listVideos: (folder) => ipcRenderer.invoke('list-videos', folder),
  getMediaUrl: (filePath) => ipcRenderer.invoke('get-media-url', filePath),
  getDuration: (videoPath) => ipcRenderer.invoke('get-duration', videoPath),
  generatePoster: (videoPath) => ipcRenderer.invoke('generate-poster', videoPath),
  generateSprites: (videoPath) => ipcRenderer.invoke('generate-sprites', videoPath),
  lookupMetadata: (payload) => ipcRenderer.invoke('lookup-metadata', payload),
  getMetadataSourceStatus: () => ipcRenderer.invoke('get-metadata-source-status'),
  getMetadataSettings: () => ipcRenderer.invoke('get-metadata-settings'),
  saveMetadataSettings: (payload) => ipcRenderer.invoke('save-metadata-settings', payload),
  saveSelectedMetadata: (payload) => ipcRenderer.invoke('save-selected-metadata', payload),
  clearSelectedMetadata: (payload) => ipcRenderer.invoke('clear-selected-metadata', payload),
  lookupPersonDetails: (payload) => ipcRenderer.invoke('lookup-person-details', payload),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  onSpriteProgress: (callback) => {
    ipcRenderer.on('sprite-progress', (_event, data) => callback(data));
  },
});
