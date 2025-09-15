import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Link } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({
  component: SettingsApp,
})

type ScannedItem = {
  path: string
  size: number
  modified?: string
  modality: 'image' | 'pdf_page' | 'video' | string
  lat?: number
  lon?: number
  timestamp?: string
}

type ScanResponse = {
  count: number
  items: ScannedItem[]
}

function SettingsApp() {
  const [selectedFolder, setSelectedFolder] = useState<string>('')
  const [isScanning, setIsScanning] = useState(false)
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState(0)

  useEffect(() => {
    // Load default folder on startup
    void loadDefaultFolder()
  }, [])

  async function loadDefaultFolder() {
    try {
      const defaultPath = await invoke<string>('get_default_folder')
      setSelectedFolder(defaultPath)
    } catch (e) {
      console.error('Failed to load default folder:', e)
    }
  }

  async function handlePickFolder() {
    try {
      const result = await invoke<string | null>('pick_folder')
      if (result) {
        setSelectedFolder(result)
      }
    } catch (e) {
      console.error('Failed to pick folder:', e)
    }
  }

  async function handleScanFolder() {
    if (!selectedFolder) return
    
    setIsScanning(true)
    try {
      const result = await invoke<ScanResponse>('scan_folder', {
        path: selectedFolder,
        maxSamples: 1000,
      })
      setScanResults(result)
    } catch (e) {
      console.error('Scan failed:', e)
    } finally {
      setIsScanning(false)
    }
  }

  async function handleStartIndexing() {
    if (!scanResults) return

    setIsIndexing(true)
    setIndexProgress(0)

    try {
      const chunkSize = 50
      const chunks = []
      for (let i = 0; i < scanResults.items.length; i += chunkSize) {
        chunks.push(scanResults.items.slice(i, i + chunkSize))
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        try {
          const payload = {
            items: chunk.map((item) => ({
              user_id: 'user',
              modality: item.modality,
              uri: item.path,
              ts: item.modified,
              lat: item.lat,
              lon: item.lon,
              timestamp: item.timestamp,
            })),
          }
          
          await invoke<number>('sync_index', {
            serverUrl: 'http://localhost:8080',
            payload,
          })
          
          setIndexProgress(((i + 1) / chunks.length) * 100)
        } catch (e) {
          console.warn('Failed to sync chunk:', e)
        }
      }
    } catch (e) {
      console.error('Indexing failed:', e)
    } finally {
      setIsIndexing(false)
      setIndexProgress(0)
    }
  }

  async function handleShowOverlay() {
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to show overlay:', e)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-violet-900">
      <div className="container mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-6">
            <Link to="/" className="text-purple-300 hover:text-white transition-colors">
              ← Back to Home
            </Link>
            <h1 className="text-4xl font-bold text-white">Settings & Configuration</h1>
            <div></div>
          </div>
          <p className="text-xl text-purple-200 text-center">
            Manage your file indexing and search settings
          </p>
        </div>

        <div className="max-w-4xl mx-auto space-y-8">
          
          <div className="bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-8">
            <h2 className="text-2xl font-semibold text-white mb-6">Folder Selection</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-purple-200 mb-2">Selected Folder:</label>
                <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                  <code className="text-white font-mono text-sm break-all">
                    {selectedFolder || 'No folder selected'}
                  </code>
                </div>
              </div>
              
              <button
                onClick={handlePickFolder}
                className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105"
              >
                Choose Different Folder
              </button>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-8">
            <h2 className="text-2xl font-semibold text-white mb-6">File Scanning</h2>
            
            <div className="space-y-4">
              <button
                onClick={handleScanFolder}
                disabled={!selectedFolder || isScanning}
                className="bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 disabled:from-gray-500 disabled:to-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 disabled:transform-none disabled:cursor-not-allowed"
              >
                {isScanning ? 'Scanning...' : 'Scan Folder'}
              </button>

              {scanResults && (
                <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                  <h3 className="text-white font-semibold mb-2">Scan Results:</h3>
                  <p className="text-purple-200">
                    Found {scanResults.count.toLocaleString()} files
                  </p>
                  <div className="mt-3 space-y-1">
                    {Object.entries(
                      scanResults.items.reduce((acc, item) => {
                        acc[item.modality] = (acc[item.modality] || 0) + 1
                        return acc
                      }, {} as Record<string, number>)
                    ).map(([modality, count]) => (
                      <div key={modality} className="text-sm text-purple-300">
                        {modality}: {count} files
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-8">
            <h2 className="text-2xl font-semibold text-white mb-6">Server Indexing</h2>
            
            <div className="space-y-4">
              <button
                onClick={handleStartIndexing}
                disabled={!scanResults || isIndexing}
                className="bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 disabled:from-gray-500 disabled:to-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 disabled:transform-none disabled:cursor-not-allowed"
              >
                {isIndexing ? `Indexing... ${indexProgress.toFixed(0)}%` : 'Start Indexing'}
              </button>

              {isIndexing && (
                <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                  <div className="flex items-center space-x-3">
                    <div className="flex-1 bg-black/30 rounded-full h-3">
                      <div 
                        className="bg-gradient-to-r from-orange-500 to-red-600 h-3 rounded-full transition-all duration-300"
                        style={{ width: `${indexProgress}%` }}
                      />
                    </div>
                    <span className="text-white text-sm font-mono">
                      {indexProgress.toFixed(0)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-8">
            <h2 className="text-2xl font-semibold text-white mb-6">Overlay Control</h2>
            
            <div className="space-y-4">
              <p className="text-purple-200">
                The search overlay is always running in the background. Use the button below to show/hide it.
              </p>
              
              <button
                onClick={handleShowOverlay}
                className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105"
              >
                Toggle Search Overlay
              </button>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-8">
            <h2 className="text-2xl font-semibold text-white mb-6">Advanced Settings</h2>
            
            <div className="space-y-6">
              <div>
                <label className="block text-purple-200 mb-2">Search Mode</label>
                <select className="w-full bg-black/20 border border-white/20 rounded-lg px-3 py-2 text-white">
                  <option>Semantic Search</option>
                  <option>Keyword Search</option>
                  <option>Hybrid Mode</option>
                </select>
              </div>
              
              <div>
                <label className="block text-purple-200 mb-2">Max Results</label>
                <input 
                  type="number" 
                  defaultValue={10}
                  className="w-full bg-black/20 border border-white/20 rounded-lg px-3 py-2 text-white"
                />
              </div>
              
              <div>
                <label className="block text-purple-200 mb-2">Server URL</label>
                <input 
                  type="text" 
                  defaultValue="http://localhost:8080"
                  className="w-full bg-black/20 border border-white/20 rounded-lg px-3 py-2 text-white font-mono text-sm"
                />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}