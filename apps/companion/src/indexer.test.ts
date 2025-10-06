import { beforeEach, describe, expect, it, vi } from 'vitest'

const localStorageMock = {
  getItem: vi.fn<(key: string) => string | null>().mockReturnValue(null),
  setItem: vi.fn<(key: string, value: string) => void>(),
  removeItem: vi.fn<(key: string) => void>(),
}

const windowStub: any = { localStorage: localStorageMock }

vi.stubGlobal('window', windowStub)
vi.stubGlobal('localStorage', localStorageMock)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const { filterChunkForUpload } = await import('./indexer')
const { invoke } = await import('@tauri-apps/api/core')
const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  localStorageMock.getItem.mockReturnValue(null)
})

describe('filterChunkForUpload', () => {
  it('omits already indexed items', async () => {
    mockedInvoke.mockResolvedValueOnce([
      { user_id: 'user-1', modality: 'image', uri: '/keep', ts: '2024-01-01T00:00:00Z' },
    ])
    const chunk = [
      { path: '/keep', modality: 'image', modified: '2024-01-01T00:00:00Z' },
      { path: '/skip', modality: 'image', modified: '2024-01-02T00:00:00Z' },
    ]

    const { filteredChunk } = await filterChunkForUpload('http://localhost:8080', chunk, 'user-1')

    expect(filteredChunk).toHaveLength(1)
    expect(filteredChunk[0].path).toBe('/keep')
    expect(mockedInvoke).toHaveBeenCalledWith('filter_indexed', expect.objectContaining({
      serverUrl: 'http://localhost:8080',
      payload: expect.any(Object),
    }))
  })

  it('falls back to original chunk on failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chunk = [
      { path: '/a', modality: 'image', modified: '2024-01-01T00:00:00Z' },
      { path: '/b', modality: 'image', modified: '2024-01-01T00:00:00Z' },
    ]

    const { filteredChunk } = await filterChunkForUpload('http://localhost:8080', chunk, 'user-1')

    expect(filteredChunk).toHaveLength(2)
    warnSpy.mockRestore()
  })
})
