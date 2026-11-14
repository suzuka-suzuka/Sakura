function formatBytes(bytes, decimals = 1) {
    if (bytes === 0 || bytes === undefined || bytes === null) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec === 0) return '0 B/s';
    return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(seconds) {
    if (!seconds) return '0秒';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${mins}分钟`;
    return `${mins}分钟`;
}

const RING_COLORS = { accent: 'var(--accent)', violet: 'var(--violet)', cyan: 'var(--cyan)' };

function CircleProgress({ value, label, subLabel, color = 'accent', size = 90, strokeWidth = 9 }) {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const percent = Math.min(Math.max(value || 0, 0), 100);
    const offset = circumference - (percent / 100) * circumference;
    let stroke = RING_COLORS[color] || color;
    if (percent >= 90) stroke = 'var(--danger)';
    else if (percent >= 70) stroke = 'var(--warn)';

    return (
        <div className="circle-progress" style={{ width: size }}>
            <svg width={size} height={size}>
                <circle className="circle-bg" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} />
                <circle
                    className="circle-fill"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    strokeWidth={strokeWidth}
                    style={{ strokeDasharray: circumference, strokeDashoffset: offset, stroke }}
                />
            </svg>
            <div className="circle-value">{percent.toFixed(0)}%</div>
            <div className="circle-label">{label}</div>
            {subLabel && <div className="circle-sub-label">{subLabel}</div>}
        </div>
    );
}

function StorageBar({ mount, used, total }) {
    const percent = total > 0 ? (used / total) * 100 : 0;
    let level = 'bar-normal';
    if (percent >= 90) level = 'bar-danger';
    else if (percent >= 70) level = 'bar-warning';

    return (
        <div className="storage-bar-item">
            <div className="storage-bar-head">
                <span className="storage-mount" title={mount}>{mount}</span>
                <span className="storage-size">{formatBytes(used)} / {formatBytes(total)} · {percent.toFixed(0)}%</span>
            </div>
            <div className="storage-bar-bg">
                <div className={`storage-bar-fill ${level}`} style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>
        </div>
    );
}

function DashCard({ className, title, extra = null, children }) {
    return (
        <section className={`card ${className}`}>
            <header className="card-header">
                <h3 className="card-title">{title}</h3>
                {extra}
            </header>
            <div className="dash-card-body">{children}</div>
        </section>
    );
}

export default function SystemMonitor({ staticInfo, dynamicInfo, botInfo, loading }) {
    if (loading && !staticInfo && !dynamicInfo && !botInfo) {
        return (
            <div className="loading-container" style={{ minHeight: 240 }}>
                <div className="spinner"></div>
            </div>
        );
    }

    const accounts = (botInfo?.accounts || []).filter((account) => account?.status !== 'offline');
    const os = staticInfo?.os || {};
    const cpu = staticInfo?.cpu || {};
    const graphics = staticInfo?.graphics || {};
    const mem = dynamicInfo?.mem || {};
    const currentLoad = dynamicInfo?.currentLoad || {};
    const cpuSpeed = dynamicInfo?.cpuCurrentSpeed || {};
    const fsSize = dynamicInfo?.fsSize || [];
    const time = dynamicInfo?.time || {};
    const nodeProcess = dynamicInfo?.nodeProcess || {};
    const networkSummary = dynamicInfo?.networkSummary || {};

    const cpuUsage = currentLoad.currentLoad || 0;
    const actualMemUsed = Number.isFinite(mem.actualUsed) ? mem.actualUsed : (mem.used || 0);
    const memUsage = mem.total > 0 ? (actualMemUsed / mem.total) * 100 : 0;
    const swapUsage = mem.swaptotal > 0 ? (mem.swapused / mem.swaptotal) * 100 : 0;
    const mainGpu = graphics.controllers?.[0];
    const cpuCores = cpu.physicalCores || cpu.cores || '-';
    const cpuThreads = cpu.cores || '-';
    const cpuFreq = cpuSpeed.avg?.toFixed(1) || cpu.speed || '-';

    return (
        <div className="dash">
            <DashCard
                className="dash-bots"
                title="机器人账号"
                extra={accounts.length > 0 ? <span className="field-count">{accounts.length}</span> : null}
            >
                {accounts.length === 0 ? (
                    <div className="dash-empty">
                        <img src="https://q1.qlogo.cn/g?b=qq&nk=10000&s=100" alt="" />
                        <span>还没有账号连接</span>
                    </div>
                ) : (
                    <div className="bot-cards-row">
                        {accounts.map((account) => (
                            <div key={account.self_id} className="bot-card" title={`${account.nickname || ''}（${account.uin}）`}>
                                <img
                                    className="bot-card-avatar"
                                    src={`https://q1.qlogo.cn/g?b=qq&nk=${account.uin}&s=100`}
                                    alt=""
                                    onError={(event) => {
                                        event.target.src = 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=100';
                                    }}
                                />
                                <span className="bot-card-text">
                                    <span className="bot-card-nick">{account.nickname || account.uin}</span>
                                    <span className="bot-card-id">{account.uin}</span>
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </DashCard>

            <section className="card dash-stat">
                <CircleProgress value={cpuUsage} label="CPU" subLabel={`${cpuCores}C${cpuThreads}T · ${cpuFreq}GHz`} color="accent" />
            </section>
            <section className="card dash-stat">
                <CircleProgress
                    value={memUsage}
                    label="内存"
                    subLabel={`${formatBytes(actualMemUsed)} / ${formatBytes(mem.total)}`}
                    color="violet"
                />
            </section>
            <section className="card dash-stat">
                <CircleProgress
                    value={mem.swaptotal > 0 ? swapUsage : 0}
                    label="Swap"
                    subLabel={mem.swaptotal > 0 ? `${formatBytes(mem.swapused)} / ${formatBytes(mem.swaptotal)}` : '未启用'}
                    color="cyan"
                />
            </section>

            <DashCard className="dash-sys" title="系统信息">
                <dl className="kv-list">
                    <dt>系统</dt>
                    <dd title={`${os.distro || ''} ${os.release || ''}`}>{os.distro} {os.release}</dd>
                    <dt>CPU</dt>
                    <dd title={cpu.brand || cpu.manufacturer}>{cpu.brand || cpu.manufacturer || '-'}</dd>
                    <dt>GPU</dt>
                    <dd title={mainGpu?.model}>{mainGpu?.model || '-'}</dd>
                    <dt>内存</dt>
                    <dd>{formatBytes(mem.total)}</dd>
                    <dt>Node</dt>
                    <dd>{nodeProcess.version || '-'}{nodeProcess.pid ? ` · PID ${nodeProcess.pid}` : ''}</dd>
                </dl>
            </DashCard>

            <DashCard className="dash-storage" title="磁盘">
                <div className="storage-bars">
                    {fsSize.length === 0 && <span className="dash-empty">暂无数据</span>}
                    {fsSize.slice(0, 4).map((fs, idx) => (
                        <StorageBar key={idx} mount={fs.mount} used={fs.used} total={fs.size} />
                    ))}
                </div>
            </DashCard>

            <DashCard className="dash-net" title="网络与运行">
                <div className="stat-list">
                    <div className="stat">
                        <div className="stat-label">↓ 下载</div>
                        <div className="stat-value">{formatSpeed(networkSummary.rx_sec)}</div>
                    </div>
                    <div className="stat">
                        <div className="stat-label">↑ 上传</div>
                        <div className="stat-value">{formatSpeed(networkSummary.tx_sec)}</div>
                    </div>
                    <div className="stat">
                        <div className="stat-label">系统运行</div>
                        <div className="stat-value">{formatUptime(time.uptime)}</div>
                    </div>
                    <div className="stat">
                        <div className="stat-label">Node 运行</div>
                        <div className="stat-value">{formatUptime(nodeProcess.uptime)}</div>
                    </div>
                </div>
            </DashCard>
        </div>
    );
}
