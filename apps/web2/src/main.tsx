import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './tma/tokens.css'
import './tma/ui'
import './web2.css'
import { routes } from './routes'

createRoot(document.getElementById('root')!).render(<RouterProvider router={createBrowserRouter(routes)} />)
