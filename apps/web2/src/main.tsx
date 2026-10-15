import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
// One visual identity with apps/web: the design tokens are imported, not copied.
import '../../web/src/tma/tokens.css'
import './web2.css'
import { routes } from './routes'

createRoot(document.getElementById('root')!).render(<RouterProvider router={createBrowserRouter(routes)} />)
