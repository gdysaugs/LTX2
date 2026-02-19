import { NavLink } from 'react-router-dom'

export function TopNav() {
  return (
    <header className='top-nav'>
      <div className='top-nav__brand'>
        <span className='top-nav__title'>Civitai UK</span>
      </div>
      <nav className='top-nav__links'>
        <NavLink to='/' className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
          リアル
        </NavLink>
        <NavLink to='/anime' className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
          アニメ
        </NavLink>
        <NavLink to='/image' className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
          編集
        </NavLink>
        <NavLink to='/voice' className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
          ボイス
        </NavLink>
        <NavLink to='/purchase' className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
          クレジット
        </NavLink>
      </nav>
    </header>
  )
}

