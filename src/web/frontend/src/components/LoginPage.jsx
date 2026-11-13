import { useState } from 'react';
import Icon, { SakuraLogo } from './Icon';

export default function LoginPage({ onLogin }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [show, setShow] = useState(false);

    const handleSubmit = async (event) => {
        event.preventDefault();
        if (!password.trim()) return;

        setLoading(true);
        setError('');
        const result = await onLogin(password);
        if (!result.success) setError(result.error || '登录失败');
        setLoading(false);
    };

    return (
        <div className="login">
            <form className="login-card" onSubmit={handleSubmit}>
                <div className="login-brand">
                    <SakuraLogo size={40} />
                    <h1>Sakura</h1>
                    <p>配置面板</p>
                </div>

                <label className="login-label" htmlFor="login-password">面板密码</label>
                <div className="input-with-action">
                    <input
                        id="login-password"
                        type={show ? 'text' : 'password'}
                        className="field-input"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="config.yaml 里 web.password 的值"
                        autoComplete="current-password"
                        autoFocus
                    />
                    <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? '隐藏密码' : '显示密码'}>
                        <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
                    </button>
                </div>

                {error && (
                    <div className="login-error" role="alert">
                        <Icon name="alert" size={15} />
                        {error}
                    </div>
                )}

                <button type="submit" className="btn btn-primary btn-block" disabled={loading || !password.trim()}>
                    {loading ? '登录中…' : '登录'}
                </button>
            </form>
        </div>
    );
}
