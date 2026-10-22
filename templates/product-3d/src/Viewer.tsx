import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from 'react'
import { Maximize2, RotateCcw } from 'lucide-react'
import type { Locale, ProductOption } from '@lovbase/core/product-3d'
import { ChairPoster } from './ChairPoster'
const ChairScene = lazy(() => import('./ChairScene'))
const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onFailure()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
export function Viewer({
  seat,
  frame,
  locale,
}: {
  seat?: ProductOption
  frame?: ProductOption
  locale: Locale
}) {
  const ready = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  const [failed, setFailed] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const [dimensions, setDimensions] = useState(false)
  const onFailure = useCallback(() => setFailed(true), [])
  const canRender = ready && !failed && typeof window.WebGL2RenderingContext !== 'undefined'
  const poster = <ChairPoster seat={seat?.color} frame={frame?.color} />
  const fallback = (
    <div className="studio-fallback">
      {poster}
      <p>
        {locale === 'zh'
          ? '三维暂不可用，仍可选择材质和保存方案。'
          : '3D is unavailable. You can still configure and save your design.'}
      </p>
    </div>
  )
  return (
    <div
      className="studio-viewer"
      aria-label={locale === 'zh' ? '餐椅三维预览' : 'Interactive chair preview'}
    >
      <div className="studio-viewer-label">
        <span>01 / ARC COLLECTION</span>
        <span>{locale === 'zh' ? '为日常而设计' : 'Made for everyday'}</span>
      </div>
      <div className="studio-canvas">
        {!ready ? (
          poster
        ) : !canRender ? (
          fallback
        ) : (
          <SceneBoundary fallback={fallback} onFailure={onFailure}>
            <Suspense fallback={poster}>
              <ChairScene seat={seat} frame={frame} resetKey={resetKey} onFailure={onFailure} />
            </Suspense>
          </SceneBoundary>
        )}
      </div>
      {dimensions && (
        <div className="studio-dimensions">
          <strong>49 × 48 × 85 cm</strong>
          <span>
            {locale === 'zh' ? '宽 × 深 × 高 · 座高 46 cm' : 'Width × depth × height · seat 46 cm'}
          </span>
        </div>
      )}
      <div className="studio-viewer-bottom">
        <span>
          {canRender
            ? locale === 'zh'
              ? '拖动旋转 · 滚动缩放'
              : 'Drag to rotate · scroll to zoom'
            : locale === 'zh'
              ? '静态预览'
              : 'Static preview'}
        </span>
        <div>
          <button
            type="button"
            aria-label={locale === 'zh' ? '查看尺寸' : 'Dimensions'}
            aria-pressed={dimensions}
            onClick={() => setDimensions(!dimensions)}
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            aria-label={locale === 'zh' ? '恢复视角' : 'Reset view'}
            disabled={!canRender}
            onClick={() => setResetKey((key) => key + 1)}
          >
            <RotateCcw size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}
