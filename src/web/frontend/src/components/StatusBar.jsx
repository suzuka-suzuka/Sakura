export default function StatusBar({ connected, saving, onLogout }) {
    return (
        <div className="status-bar">
            <div className="status-indicator">
                <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></span>
                {connected ? '实时同步已连接' : '实时同步未连接'}
                {saving && <span style={{ marginLeft: 12, color: 'var(--accent)' }}>● 保存中...</span>}
            </div>
            <div className="status-actions">
                <button className="btn btn-secondary" onClick={onLogout}>
                    退出
                </button>
            </div>
        </div>
    );
}
