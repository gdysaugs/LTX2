import { NavLink } from 'react-router-dom'

export function TopNav() {
  return (
    <aside className="side-rail">
      <div className="side-rail__brand">
        <img className="side-rail__logo" src="/media/animone-logo.webp" alt="Animone AI" />
        <span>Animone AI</span>
      </div>
      <nav className="side-rail__nav">
        <NavLink to="/" className={({ isActive }) => `side-rail__link${isActive ? ' is-active' : ''}`}>
          T2V
        </NavLink>
        <NavLink to="/video" className={({ isActive }) => `side-rail__link${isActive ? ' is-active' : ''}`}>
          I2V
        </NavLink>
        <NavLink to="/purchase" className={({ isActive }) => `side-rail__link${isActive ? ' is-active' : ''}`}>
          トークン
        </NavLink>
      </nav>
    </aside>
  )
}
