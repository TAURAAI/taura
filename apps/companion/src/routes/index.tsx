import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const Route = createFileRoute('/')({ 
  component: HomeScreen,
})

function HomeScreen() {
  const [stats, setStats] = useState({ filesIndexed: 0, lastScan: null as string | null })
  const [serverStatus, setServerStatus] = useState('checking')

  useEffect(() => {
    checkServerStatus()
    loadStats()
  }, [])

  async function checkServerStatus() {
    try {
      const response = await fetch('http://localhost:8080/healthz')
      setServerStatus(response.ok ? 'online' : 'offline')
    } catch {
      setServerStatus('offline')
    }
  }

  async function loadStats() {
    try {
      const defaultPath = await invoke<string>('get_default_folder')
      const result = await invoke<{ count: number }>('scan_folder', {
        path: defaultPath,
        maxSamples: 0,
      })
      setStats({ 
        filesIndexed: result.count, 
        lastScan: new Date().toLocaleDateString() 
      })
    } catch (e) {
      console.error('Failed to load stats:', e)
    }
  }

  async function handleQuickOverlay() {
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to toggle overlay:', e)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-purple-900">
      <div className="container mx-auto px-6 py-12">
        
        <div className="text-center mb-16">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full mb-8">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          
          <h1 className="text-6xl font-bold text-white mb-4">
            Taura
          </h1>
          <p className="text-2xl text-blue-200 mb-8">
            Intelligent File Search & Recall
          </p>
          <p className="text-lg text-purple-300 max-w-2xl mx-auto">
            Search your files using natural language. Find photos, documents, and media 
            by describing what you're looking for, not just filenames.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/20">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Files Indexed</h3>
              <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
            </div>
            <p className="text-3xl font-bold text-white mb-2">
              {stats.filesIndexed.toLocaleString()}
            </p>
            <p className="text-blue-300 text-sm">
              {stats.lastScan ? `Last scan: ${stats.lastScan}` : 'No scans yet'}
            </p>
          </div>

          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/20">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Server Status</h3>
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                serverStatus === 'online' ? 'bg-green-500/20' : 
                serverStatus === 'offline' ? 'bg-red-500/20' : 'bg-yellow-500/20'
              }`}>
                <div className={`w-3 h-3 rounded-full ${
                  serverStatus === 'online' ? 'bg-green-400' : 
                  serverStatus === 'offline' ? 'bg-red-400' : 'bg-yellow-400'
                }`} />
              </div>
            </div>
            <p className="text-3xl font-bold text-white mb-2 capitalize">
              {serverStatus}
            </p>
            <p className="text-blue-300 text-sm">
              {serverStatus === 'online' ? 'Ready for search' : 
               serverStatus === 'offline' ? 'Backend unavailable' : 'Checking connection'}
            </p>
          </div>

          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/20">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Search Mode</h3>
              <div className="w-12 h-12 bg-purple-500/20 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
            </div>
            <p className="text-3xl font-bold text-white mb-2">
              Semantic
            </p>
            <p className="text-blue-300 text-sm">
              AI-powered understanding
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          <div className="bg-gradient-to-br from-blue-500/10 to-purple-600/10 backdrop-blur-md rounded-2xl p-8 border border-white/20">
            <div className="flex items-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center mr-4">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-2xl font-bold text-white">Search Overlay</h3>
                <p className="text-blue-200">Always-on search interface</p>
              </div>
            </div>
            <p className="text-purple-200 mb-6">
              Access the floating search overlay to quickly find your files while working.
            </p>
            <button
              onClick={handleQuickOverlay}
              className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105"
            >
              Open Search Overlay
            </button>
          </div>

          <div className="bg-gradient-to-br from-green-500/10 to-emerald-600/10 backdrop-blur-md rounded-2xl p-8 border border-white/20">
            <div className="flex items-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-r from-green-500 to-emerald-600 rounded-full flex items-center justify-center mr-4">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-2xl font-bold text-white">Configuration</h3>
                <p className="text-green-200">Manage settings & indexing</p>
              </div>
            </div>
            <p className="text-green-200 mb-6">
              Configure folders to index, manage search settings, and control the indexing process.
            </p>
            <Link to="/settings">
              <button className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105">
                Open Settings
              </button>
            </Link>
          </div>
        </div>

        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-4">How It Works</h2>
          <p className="text-blue-200 text-lg mb-8">Taura understands your files like you do</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="text-center p-6">
            <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Smart Indexing</h3>
            <p className="text-purple-300">Automatically analyzes your photos, documents, and media files</p>
          </div>

          <div className="text-center p-6">
            <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Natural Language</h3>
            <p className="text-purple-300">Search by describing what you remember, not exact filenames</p>
          </div>

          <div className="text-center p-6">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Instant Results</h3>
            <p className="text-purple-300">Get relevant results in milliseconds with AI-powered search</p>
          </div>
        </div>
      </div>
    </div>
  )
}