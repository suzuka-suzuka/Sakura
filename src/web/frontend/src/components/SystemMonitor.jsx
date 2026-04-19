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

function CircleProgress({ value, label, subLabel, color = '#d87093', size = 90, strokeWidth = 8 }) {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const percent = Math.min(Math.max(value || 0, 0), 100);
    const offset = circumference - (percent / 100) * circumference;

    const getColor = () => {
        if (percent >= 90) return '#e53935';
        if (percent >= 70) return '#f57c00';
        return color;
    };

    return (
        <div className="circle-progress" style={{ width: size, height: size + 36 }}>
            <svg width={size} height={size}>
                <circle
                    className="circle-bg"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    strokeWidth={strokeWidth}
                />
                <circle
                    className="circle-fill"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    strokeWidth={strokeWidth}
                    style={{
                        strokeDasharray: circumference,
                        strokeDashoffset: offset,
                        stroke: getColor(),
                    }}
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

    const getBarColor = () => {
        if (percent >= 90) return 'bar-danger';
        if (percent >= 70) return 'bar-warning';
        return 'bar-normal';
    };

    return (
        <div className="storage-bar-item">
            <div className="storage-bar-wrapper">
                <div className="storage-bar-bg">
                    <div
                        className={`storage-bar-fill ${getBarColor()}`}
                        style={{ width: `${Math.min(percent, 100)}%` }}
                    />
                    <div className="storage-bar-text">
                        <span className="storage-mount">{mount}</span>
                        <span className="storage-size">{formatBytes(used)} / {formatBytes(total)}</span>
                    </div>
                </div>
                <span className="storage-percent">{percent.toFixed(0)}%</span>
            </div>
        </div>
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

    const accounts = botInfo?.accounts || [];
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
    const memUsage = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
    const swapUsage = mem.swaptotal > 0 ? (mem.swapused / mem.swaptotal) * 100 : 0;
    const mainGpu = graphics.controllers?.[0];
    const cpuCores = cpu.physicalCores || cpu.cores || '-';
    const cpuThreads = cpu.cores || '-';
    const cpuFreq = cpuSpeed.avg?.toFixed(1) || cpu.speed || '-';

    return (
        <div className="system-monitor-compact">
            <div className="monitor-row-1">
                <div className="bot-section bot-section-multi">
                    {accounts.length === 0 ? (
                        <div className="bot-summary-block">
                            <img
                                className="bot-avatar-sm"
                                src="https://q1.qlogo.cn/g?b=qq&nk=10000&s=640"
                                alt="Avatar"
                            />
                            <div className="bot-info-sm">
                                <div className="bot-name-sm">未连接</div>
                                <div className="bot-status-sm offline">
                                    <span className="dot"></span>离线
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="bot-cards-row">
                            {accounts.map((account) => (
                                <div key={account.self_id} className="bot-card">
                                    <img
                                        className="bot-card-avatar"
                                        src={`https://q1.qlogo.cn/g?b=qq&nk=${account.uin}&s=640`}
                                        alt="Avatar"
                                        onError={(event) => {
                                            event.target.src = 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=640';
                                        }}
                                    />
                                    <div className="bot-card-nick">{account.nickname || account.uin}</div>
                                    <div className="bot-card-id">{account.uin}</div>
                                    <div className={`bot-card-status ${account.status === 'offline' ? 'offline' : ''}`}>
                                        <span className="dot"></span>{account.status === 'offline' ? '离线' : '在线'}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="row-divider"></div>

                <div className="circles-section">
                    <CircleProgress
                        value={cpuUsage}
                        label="CPU"
                        subLabel={`${cpuCores}C${cpuThreads}T ${cpuFreq}GHz`}
                        color="#d87093"
                    />
                    <CircleProgress
                        value={memUsage}
                        label="内存"
                        subLabel={`${formatBytes(mem.used)} / ${formatBytes(mem.total)}`}
                        color="#7c4dff"
                    />
                    <CircleProgress
                        value={mem.swaptotal > 0 ? swapUsage : 0}
                        label="Swap"
                        subLabel={mem.swaptotal > 0 ? `${formatBytes(mem.swapused)} / ${formatBytes(mem.swaptotal)}` : '- / -'}
                        color="#00bcd4"
                    />
                </div>
            </div>

            <div className="monitor-row-2">
                <div className="sys-info-compact">
                    <div className="sys-info-grid">
                        <div className="sys-item">
                            <span className="sys-label">系统</span>
                            <span className="sys-text">{os.distro} {os.release}</span>
                        </div>
                        <div className="sys-item">
                            <span className="sys-label">CPU</span>
                            <span className="sys-text">{cpu.brand || cpu.manufacturer}</span>
                        </div>
                        <div className="sys-item">
                            <span className="sys-label">GPU</span>
                            <span className="sys-text">{mainGpu?.model || '-'}</span>
                        </div>
                        <div className="sys-item">
                            <span className="sys-label">内存</span>
                            <span className="sys-text">{formatBytes(mem.total)}</span>
                        </div>
                        <div className="sys-item">
                            <span className="sys-label">Node</span>
                            <span className="sys-text">{nodeProcess.version} (PID: {nodeProcess.pid})</span>
                        </div>
                    </div>
                </div>

                <div className="storage-network-compact">
                    <div className="storage-bars">
                        {fsSize.slice(0, 4).map((fs, idx) => (
                            <StorageBar
                                key={idx}
                                mount={fs.mount}
                                used={fs.used}
                                total={fs.size}
                            />
                        ))}
                    </div>

                    <div className="network-row">
                        <div className="speed-item">
                            <span className="speed-label">下载</span>
                            <span className="speed-val">{formatSpeed(networkSummary.rx_sec)}</span>
                        </div>
                        <div className="speed-item">
                            <span className="speed-label">上传</span>
                            <span className="speed-val">{formatSpeed(networkSummary.tx_sec)}</span>
                        </div>
                    </div>

                    <div className="uptime-row">
                        <div className="uptime-item">
                            <span className="uptime-label">系统运行</span>
                            <span className="uptime-val">{formatUptime(time.uptime)}</span>
                        </div>
                        <div className="uptime-item">
                            <span className="uptime-label">Node运行</span>
                            <span className="uptime-val">{formatUptime(nodeProcess.uptime)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
