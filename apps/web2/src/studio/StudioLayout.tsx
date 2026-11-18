/**
 * The shared layout of every studio route (plan 20261118-melhorias-tma, MT-06). The page width lives here, not in each
 * screen: a studio page fills the viewport, so its breadcrumb bar runs full width and its side panel sits flush on the
 * right edge, as on the canvas artboards. The look lives in layout.css.
 */
import { Outlet } from 'react-router-dom'
import './layout.css'

export function StudioLayout() {
  return (
    <div className="stu-layout" data-testid="studio-layout">
      <Outlet />
    </div>
  )
}
