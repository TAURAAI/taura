import { useEffect, useRef, useState, type ReactNode } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// Generates URLs 001..N based on the provided base/pad/ext.
function buildFrameUrlsFromBase(dir: string, base: string, ext: string, pad: number, count: number) {
  const urls: string[] = []
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(pad, '0')
    urls.push(`${dir.replace(/\/$/, '')}/${base}${n}${ext}`)
  }
  return urls
}

function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, canvas: HTMLCanvasElement) {
  const cw = canvas.width
  const ch = canvas.height
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  // cover logic
  const cr = cw / ch
  const ir = iw / ih
  let dw = cw
  let dh = ch
  if (ir > cr) {
    // image is wider
    dh = ch
    dw = Math.round(ch * ir)
  } else {
    dw = cw
    dh = Math.round(cw / ir)
  }
  const dx = Math.round((cw - dw) / 2)
  const dy = Math.round((ch - dh) / 2)
  ctx.clearRect(0, 0, cw, ch)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, dx, dy, dw, dh)
}

export interface ScrollImageSequenceProps {
  className?: string
  // Total frames (if no manifest is provided)
  frames?: number
  // Pixel height of the scroll section (affects scroll distance)
  scrollLengthPx?: number
  // If true, reverse playback (280 -> 1)
  reverse?: boolean
  // Optional manifest path to discover local frames at runtime
  manifestPath?: string
  // Optional overlay content that fades in near the end
  children?: ReactNode
  // Start overlay (shows at start, then fades out)
  startOverlay?: ReactNode
  startDisappearAt?: number | null
  // End overlay (fades in near the end)
  endOverlay?: ReactNode
  endAppearAt?: number | null
  // Optional background element to fade in at end
  backgroundRef?: React.RefObject<HTMLElement>
  // Inline background node to render beneath the canvas (preferred)
  backgroundNode?: ReactNode
  // When provided, overlay starts visible and fades out at this progress [0..1]
  overlayDisappearAt?: number | null
  // When provided, overlay starts hidden and fades in at this progress [0..1]
  overlayAppearAt?: number | null
  // Optional element below the sequence to hide during cross-fade and while pinned
  belowRef?: React.RefObject<HTMLElement>
}

export default function ScrollImageSequence({ className, frames = 280, scrollLengthPx = 3000, reverse = false, manifestPath = '/sequence/manifest.json', children, startOverlay, startDisappearAt = 0.08, endOverlay, endAppearAt = 0.75, backgroundRef, backgroundNode, overlayDisappearAt = null, overlayAppearAt = 0.75, belowRef }: ScrollImageSequenceProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const overlayStartRef = useRef<HTMLDivElement | null>(null)
  const overlayEndRef = useRef<HTMLDivElement | null>(null)
  const bgWrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef({ i: 0 })
  const imagesRef = useRef<HTMLImageElement[]>([])
  const loadedRef = useRef<boolean[]>([])
  const [urls, setUrls] = useState<string[] | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      canvas.width = Math.floor(rect.width * dpr)
      canvas.height = Math.floor(rect.height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // Draw in device pixels directly (avoid double DPR scaling)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      // redraw current frame on resize
      const curr = imagesRef.current[frameRef.current.i]
      if (curr && curr.complete) drawImageCover(ctx as any, curr, canvas)
    }

    // Fill container to viewport
    const setMinHeight = () => {
      wrap.style.minHeight = `${window.innerHeight}px`
    }

    setMinHeight()
    resize()
    const onWinResize = () => { setMinHeight(); resize() }
    window.addEventListener('resize', onWinResize)

    // Also observe element size changes (e.g., when unpinned or layout shifts) to keep canvas & background in sync
    const ro = new ResizeObserver(() => {
      // Defer slightly to allow layout to settle (especially after pin/unpin)
      requestAnimationFrame(resize)
    })
    try { ro.observe(wrap) } catch (_) { /* no-op */ }

    // If not yet discovered, fetch manifest to construct URLs
    let aborted = false
    async function ensureUrls() {
      if (urls && urls.length) return urls
      try {
        const res = await fetch(manifestPath, { cache: 'no-store' })
        if (res.ok) {
          const m = await res.json()
          const list = buildFrameUrlsFromBase(m.dir || '/sequence', m.base || 'aurora-', m.ext || '.jpg', m.pad || 3, m.frameCount || frames)
          if (!aborted) setUrls(reverse ? list.slice().reverse() : list)
          return list
        }
      } catch (_) {
        // fall back below
      }
      const fallback = buildFrameUrlsFromBase('/sequence', 'aurora-', '.jpg', 3, frames)
      if (!aborted) setUrls(reverse ? fallback.slice().reverse() : fallback)
      return fallback
    }

    // We will proceed after URLs ready
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    ensureUrls().then((list) => {
      if (aborted) return
      // Lazy create image objects
      imagesRef.current = new Array(list.length)
      loadedRef.current = new Array(list.length).fill(false)
      const createImage = (idx: number) => {
        if (imagesRef.current[idx]) return imagesRef.current[idx]
        const img = new Image()
        // Hint browsers to decode off-main-thread when possible
        img.decoding = 'async'
        img.src = list[idx]
        img.onload = () => {
          loadedRef.current[idx] = true
          if (idx === frameRef.current.i) {
            const ctx = canvas.getContext('2d')
            if (ctx) drawImageCover(ctx, img, canvas)
          }
        }
        img.onerror = () => {
          // eslint-disable-next-line no-console
          console.warn('Failed to load frame', list[idx])
        }
        imagesRef.current[idx] = img
        return img
      }

      // Prime first few frames for quick start
      for (let i = 0; i < Math.min(6, list.length); i++) createImage(i)

      const render = (i: number) => {
        const clamped = Math.max(0, Math.min(list.length - 1, Math.floor(i)))
        frameRef.current.i = clamped
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const img = imagesRef.current[clamped] || createImage(clamped)
        if (!img) return
        if (img.complete) {
          drawImageCover(ctx, img, canvas)
        }
        // opportunistically preload neighbors
        createImage(Math.min(clamped + 1, list.length - 1))
        createImage(Math.max(clamped - 1, 0))
      }

      // Set up ScrollTrigger with pinning and scrub to control frame index
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: wrap,
          start: 'top top',
          end: `+=${scrollLengthPx}`,
          scrub: 0.2,
          pin: true,
          anticipatePin: 1,
          onLeave: () => {
            if (canvasWrapRef.current) gsap.set(canvasWrapRef.current, { opacity: 0 })
            const bgEl = (backgroundNode ? bgWrapRef.current : backgroundRef?.current) as HTMLElement | null | undefined
            if (bgEl) gsap.set(bgEl, { opacity: 1 })
            if (belowRef?.current) gsap.set(belowRef.current, { opacity: 1 })
          },
          onEnterBack: () => {
            if (canvasWrapRef.current) gsap.set(canvasWrapRef.current, { opacity: 1 })
            const bgEl = (backgroundNode ? bgWrapRef.current : backgroundRef?.current) as HTMLElement | null | undefined
            if (bgEl) gsap.set(bgEl, { opacity: 0 })
            if (belowRef?.current) gsap.set(belowRef.current, { opacity: 0 })
          },
        },
        onUpdate: () => {
          // noop; frame tween updates do the drawing
        },
      })

      // 1) Advance frames over the full scroll
      tl.to(frameRef.current, {
        i: list.length - 1,
        onUpdate: () => render(frameRef.current.i),
        snap: { i: 1 },
        duration: 1,
      }, 0)

      // 2) Overlay timing
      if (overlayRef.current) {
        if (overlayDisappearAt !== null && overlayDisappearAt !== undefined) {
          gsap.set(overlayRef.current, { opacity: 1 })
          tl.to(overlayRef.current, { opacity: 0, duration: 0.2 }, Math.max(0, Math.min(1, overlayDisappearAt)))
        } else if (overlayAppearAt !== null && overlayAppearAt !== undefined) {
          gsap.set(overlayRef.current, { opacity: 0 })
          tl.to(overlayRef.current, { opacity: 1, duration: 0.2 }, Math.max(0, Math.min(1, overlayAppearAt)))
        } else {
          // default: keep hidden
          gsap.set(overlayRef.current, { opacity: 0 })
        }
      }
      if (overlayStartRef.current && startOverlay) {
        gsap.set(overlayStartRef.current, { opacity: 1 })
        const when = Math.max(0, Math.min(1, startDisappearAt ?? 0.08))
        tl.to(overlayStartRef.current, { opacity: 0, duration: 0.15 }, when)
      }
      if (overlayEndRef.current && endOverlay) {
        gsap.set(overlayEndRef.current, { opacity: 0 })
        const when = Math.max(0, Math.min(1, endAppearAt ?? 0.75))
        tl.to(overlayEndRef.current, { opacity: 1, duration: 0.2 }, when)
      }

      // 3) Cross-fade at the very end: align with the final frame
      const listLen = list.length
      // Start a tenth-frame before the end; very tight transition
      const crossStart = listLen > 1 ? 1 - (0.1 / (listLen - 1)) : 0.995
      const crossDur = 0.03
      if (canvasWrapRef.current) gsap.set(canvasWrapRef.current, { opacity: 1 })
      const bgEl = (backgroundNode ? bgWrapRef.current : backgroundRef?.current) as HTMLElement | null | undefined
      if (bgEl) gsap.set(bgEl, { opacity: 0 })
      if (belowRef?.current) gsap.set(belowRef.current, { opacity: 0 })
      if (canvasWrapRef.current) tl.to(canvasWrapRef.current, { opacity: 0, duration: crossDur }, crossStart)
      if (bgEl) tl.to(bgEl, { opacity: 1, duration: crossDur }, crossStart)

      // Background visibility handled by ScrollTrigger callbacks above

      // Initial draw attempt (in case first image already cached)
      render(0)

      // cleanup
      const cleanup = () => {
        ScrollTrigger.getAll().forEach((st) => st.kill())
        tl.kill()
      }
      // return cleanup function
      // Note: we cannot return from inside promise; we attach to outer effect cleanup
      ;(wrap as any)._sequenceCleanup = cleanup
    })

    return () => {
      aborted = true
      const cleanup = (wrap as any)._sequenceCleanup
      if (typeof cleanup === 'function') cleanup()
      window.removeEventListener('resize', onWinResize)
      try { ro.disconnect() } catch (_) { /* ignore */ }
    }
  }, [frames, scrollLengthPx, reverse, manifestPath])

  return (
    <section
      ref={wrapRef}
      className={className}
      // Use both height and minHeight to aggressively cover viewport; 100dvh for modern browsers, fallback to 100vh
      style={{ position: 'relative', width: '100%', height: '100vh', minHeight: '100dvh', overflow: 'hidden', background: 'transparent' }}
    >
      {backgroundNode && (
        <div ref={bgWrapRef} id="__seq_bg__" style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}>
          {backgroundNode}
        </div>
      )}
      <div ref={canvasWrapRef} style={{ position: 'absolute', inset: 0, willChange: 'opacity', zIndex: 1 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
      <div ref={overlayRef} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', opacity: 0, zIndex: 2 }}>
        {children}
      </div>
      {startOverlay && (
        <div ref={overlayStartRef} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 2 }}>
          {startOverlay}
        </div>
      )}
      {endOverlay && (
        <div ref={overlayEndRef} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', zIndex: 3 }}>
          {endOverlay}
        </div>
      )}
    </section>
  )
}
