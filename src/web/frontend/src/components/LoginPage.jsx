import { useState } from 'react';

export default function LoginPage({ onLogin }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!password.trim()) return;

        setLoading(true);
        setError('');

        const result = await onLogin(password);
        if (!result.success) {
            setError(result.error || '登录失败');
        }
        setLoading(false);
    };

    return (
        <div className="login-container">
            <form className="login-card" onSubmit={handleSubmit}>
                <h2>🌸 Sakura</h2>
                <p>配置面板登录</p>

                {error && <div className="login-error">{error}</div>}

                <div className="field-group">
                    <label className="field-label">密码</label>
                    <input
                        type="password"
                        className="field-input"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="请输入面板密码"
                        autoFocus
                    />
                </div>

                <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
                    disabled={loading}
                >
                    {loading ? '登录中...' : '登 录'}
                </button>
            </form>
        </div>
    );
}
