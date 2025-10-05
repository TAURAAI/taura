# API Reference

## Types
- `Modality = 'image' | 'pdf_page' | 'doc' | 'audio_seg' | 'video_kf' | 'text'`
- `MediaItem`: id, userId, modality, uri, thumbUrl?, ts?, lat?, lon?, album?, embedding?
- `RankedItem = MediaItem & { score: number }`
- `RerankOptions`:
  - `timeBoost?: { kind: 'decay'; halfLifeDays: number; weight?: number } | { kind: 'window'; start?: string; end?: string; weight?: number }`
  - `geoBoost?: { lat: number; lon: number; km: number; weight?: number }`
  - `modalityPrior?: Partial<Record<Modality, number>>`
  - `embeddingDim?: number` (default 1152)

## Functions
- `cosine(a, b): number`
- `haversineKm(lat1, lon1, lat2, lon2): number`
- `rerank(queryVec, items, options): RankedItem[]`
- `buildPgvectorCosineQuery({ tableVec, table }): string`

## Taura API client
```ts
new TauraClient({ baseURL, token?, fetchFn?, timeoutMs? })
```
- `search(req: SearchRequest): Promise<SearchResponse>`
- `embedText(text: string): Promise<Float32Array>`
- `embedImageBytes(bytes: Uint8Array): Promise<Float32Array>`
- `embedImageUrl(url: string): Promise<Float32Array>`

`SearchRequest` shape matches the gateway spec with `filters.modality/time_range/geo`.

## Hybrid search
```ts
hybridSearch(client, userId, text, filters?, { topK?, applyClientRerank?, ...rerankOptions })
```
- If `applyClientRerank` is false, returns server ordering with server `score`.
- If true, computes query embedding via `embedText` and applies rerank() locally.
