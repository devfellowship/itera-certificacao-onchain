import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** Side of the square crop viewport on screen, and of the file sent to the API. */
const VIEW = 160
export const OUTPUT = 256

export interface CropState {
  img: HTMLImageElement
  /** 1 = the short side fills the square. */
  zoom: number
  /** Offset of the image center from the viewport center, in viewport pixels. */
  x: number
  y: number
}

function baseScale(img: HTMLImageElement) {
  return VIEW / Math.min(img.naturalWidth, img.naturalHeight)
}

/** Keeps the square covered: the image can never be dragged past an edge. */
function clamp(c: CropState): CropState {
  const s = baseScale(c.img) * c.zoom
  const maxX = Math.max(0, (c.img.naturalWidth * s - VIEW) / 2)
  const maxY = Math.max(0, (c.img.naturalHeight * s - VIEW) / 2)
  return { ...c, x: Math.min(maxX, Math.max(-maxX, c.x)), y: Math.min(maxY, Math.max(-maxY, c.y)) }
}

/** Renders the visible square at OUTPUT×OUTPUT and returns it as a PNG blob. */
export function renderCrop(c: CropState): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT
  canvas.height = OUTPUT
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('canvas is not available'))
  const k = OUTPUT / VIEW
  const s = baseScale(c.img) * c.zoom * k
  const w = c.img.naturalWidth * s
  const h = c.img.naturalHeight * s
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(c.img, OUTPUT / 2 + c.x * k - w / 2, OUTPUT / 2 + c.y * k - h / 2, w, h)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), 'image/png'))
}

/** Square crop: drag to move, slider to zoom. The preview is exactly what the API receives. */
export function AvatarCropper({ crop, onChange }: { crop: CropState; onChange: (c: CropState) => void }) {
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const s = baseScale(crop.img) * crop.zoom

  useEffect(() => {
    onChange(clamp(crop))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop.img])

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y }
    setDragging(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    onChange(clamp({ ...crop, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }))
  }
  const up = () => {
    drag.current = null
    setDragging(false)
  }
  const nudge = (dx: number, dy: number) => onChange(clamp({ ...crop, x: crop.x + dx, y: crop.y + dy }))

  return (
    <div className="tps-crop">
      <div
        className="tps-crop__view"
        data-dragging={dragging || undefined}
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        tabIndex={0}
        role="application"
        aria-label="Picture crop. Drag or use the arrow keys to move the picture."
        onKeyDown={(e) => {
          const step = e.shiftKey ? 16 : 4
          if (e.key === 'ArrowLeft') nudge(-step, 0)
          else if (e.key === 'ArrowRight') nudge(step, 0)
          else if (e.key === 'ArrowUp') nudge(0, -step)
          else if (e.key === 'ArrowDown') nudge(0, step)
          else return
          e.preventDefault()
        }}
        data-testid="avatar-crop"
      >
        <img
          src={crop.img.src}
          alt=""
          draggable={false}
          style={{
            width: crop.img.naturalWidth * s,
            height: crop.img.naturalHeight * s,
            transform: `translate(calc(-50% + ${crop.x}px), calc(-50% + ${crop.y}px))`,
          }}
        />
      </div>
      <label className="tps-crop__zoom">
        <span className="tma-label">Zoom</span>
        <input type="range" min={1} max={3} step={0.01} value={crop.zoom} onChange={(e) => onChange(clamp({ ...crop, zoom: Number(e.target.value) }))} aria-label="Zoom" />
      </label>
    </div>
  )
}
