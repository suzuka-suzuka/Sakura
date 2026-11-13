import Icon, { SakuraLogo } from './Icon';

export default function Sidebar({
    groups,
    activeKey,
    onNavigate,
    onOpenSearch,
    connected,
    theme,
    onToggleTheme,
    onLogout,
    open,
    onClose,
}) {
    return (
        <>
            <div className={`sidebar-backdrop ${open ? 'show' : ''}`} onClick={onClose} />
            <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="导航">
                <div className="sidebar-brand">
                    <SakuraLogo size={26} />
                    <span className="sidebar-brand-text">Sakura</span>
                    <a
                        className="icon-btn sidebar-brand-link"
                        href="https://github.com/suzuka-suzuka/Sakura"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="在 GitHub 上查看"
                        aria-label="在 GitHub 上查看"
                    >
                        <Icon name="external" size={15} />
                    </a>
                </div>

                <button type="button" className="sidebar-search" onClick={onOpenSearch}>
                    <Icon name="search" size={16} />
                    <span>搜索设置</span>
                    <kbd>Ctrl K</kbd>
                </button>

                <nav className="sidebar-nav">
                    {groups.map((group, groupIndex) => (
                        <div key={`${group.title}-${groupIndex}`} className="nav-group">
                            {group.title && <div className="nav-group-title">{group.title}</div>}
                            {group.items.map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    className={`nav-item ${activeKey === item.key ? 'active' : ''}`}
                                    aria-current={activeKey === item.key ? 'page' : undefined}
                                    onClick={() => onNavigate(item)}
                                >
                                    <Icon name={item.icon || 'puzzle'} size={17} />
                                    <span className="nav-item-label">{item.title}</span>
                                </button>
                            ))}
                        </div>
                    ))}
                </nav>

                <div className="sidebar-footer">
                    <span className={`connection ${connected ? 'online' : 'offline'}`} title={connected ? '实时同步已连接' : '实时同步未连接'}>
                        <span className="connection-dot" />
                        {connected ? '已连接' : '未连接'}
                    </span>
                    <div className="sidebar-footer-actions">
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={onToggleTheme}
                            title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
                            aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
                        >
                            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
                        </button>
                        <button type="button" className="icon-btn" onClick={onLogout} title="退出登录" aria-label="退出登录">
                            <Icon name="logout" size={17} />
                        </button>
                    </div>
                </div>
            </aside>
        </>
    );
}
