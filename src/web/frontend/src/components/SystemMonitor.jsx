import { useMemo } from 'react';

// 格式化字节
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0 || bytes === undefined || bytes === null) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// 格式化速度
function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec === 0) return '0 B/s';
    return formatBytes(bytesPerSec) + '/s';
}

// 格式化时间
function formatUptime(seconds) {
    if (!seconds) return '0秒';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${mins}分钟`;
    return `${mins}分钟`;
}

// 环形进度条组件
function CircleProgress({ value, label, subLabel, color = '#d87093', size = 90, strokeWidth = 8 }) {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const percent = Math.min(Math.max(value || 0, 0), 100);
    const offset = circumference - (percent / 100) * circumference;

    // 根据使用率变色
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

// 存储条组件
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

// 主组件
export default function SystemMonitor({ staticInfo, dynamicInfo, botInfo, networkSpeed, loading }) {
    // 计算总网络速度（所有网卡加起来）
    const totalNetworkSpeed = useMemo(() => {
        if (!networkSpeed || networkSpeed.length === 0) {
            return { rx: 0, tx: 0 };
        }
        return networkSpeed.reduce((acc, s) => ({
            rx: acc.rx + (s.rxSpeed || 0),
            tx: acc.tx + (s.txSpeed || 0),
        }), { rx: 0, tx: 0 });
    }, [networkSpeed]);

    // 从 dynamicInfo.networkStats 计算所有网卡的总流量速度
    const networkStatsSpeed = useMemo(() => {
        const stats = dynamicInfo?.networkStats;
        if (!stats || stats.length === 0) return null;

        // 计算所有网卡的总速度（包括虚拟网卡、TUN等）
        let totalRx = 0;
        let totalTx = 0;

        for (const s of stats) {
            // rx_sec 和 tx_sec 是 systeminformation 计算的每秒字节数
            totalRx += s.rx_sec || 0;
            totalTx += s.tx_sec || 0;
        }

        return { rx_sec: totalRx, tx_sec: totalTx };
    }, [dynamicInfo?.networkStats]);

    // 最终网络速度
    const finalNetworkSpeed = useMemo(() => {
        // 优先使用 systeminformation 提供的实时速率
        if (networkStatsSpeed && (networkStatsSpeed.rx_sec > 0 || networkStatsSpeed.tx_sec > 0)) {
            return {
                rx: networkStatsSpeed.rx_sec,
                tx: networkStatsSpeed.tx_sec,
            };
        }
        // 否则使用手动计算的速度
        if (totalNetworkSpeed.rx > 0 || totalNetworkSpeed.tx > 0) {
            return totalNetworkSpeed;
        }
        return { rx: 0, tx: 0 };
    }, [totalNetworkSpeed, networkStatsSpeed]);


    const os = staticInfo?.os || {};
    const cpu = staticInfo?.cpu || {};
    const graphics = staticInfo?.graphics || {};
    const mem = dynamicInfo?.mem || {};
    const currentLoad = dynamicInfo?.currentLoad || {};
    const cpuSpeed = dynamicInfo?.cpuCurrentSpeed || {};
    const fsSize = dynamicInfo?.fsSize || [];
    const time = dynamicInfo?.time || {};
    const nodeProcess = dynamicInfo?.nodeProcess || {};

    // 计算各项使用率
    const cpuUsage = currentLoad.currentLoad || 0;
    const memUsage = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
    const swapUsage = mem.swaptotal > 0 ? (mem.swapused / mem.swaptotal) * 100 : 0;

    // 获取主显卡信息
    const mainGpu = graphics.controllers?.[0];

    // CPU 信息
    const cpuCores = cpu.physicalCores || cpu.cores || '-';
    const cpuThreads = cpu.cores || '-';
    const cpuFreq = cpuSpeed.avg?.toFixed(1) || cpu.speed || '-';

    return (
        <div className="system-monitor-compact">
            {/* 第一行：Bot信息 + 环形图（合并为一个卡片） */}
            <div className="monitor-row-1">
                {/* Bot 信息 */}
                <div className="bot-section">
                    <img
                        className="bot-avatar-sm"
                        src={botInfo?.uin ? `https://q1.qlogo.cn/g?b=qq&nk=${botInfo.uin}&s=640` : 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=640'}
                        alt="Avatar"
                        onError={(e) => { e.target.src = 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=640'; }}
                    />
                    <div className="bot-info-sm">
                        <div className="bot-name-sm">{botInfo?.nickname || '未连接'}</div>
                        <div className="bot-qq-sm">{botInfo?.uin || '-'}</div>
                        <div className={`bot-status-sm ${botInfo?.uin ? 'online' : 'offline'}`}>
                            <span className="dot"></span>
                            {botInfo?.uin ? '在线' : '离线'}
                        </div>
                    </div>
                </div>

                {/* 分隔线 */}
                <div className="row-divider"></div>

                {/* 环形图表 */}
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

            {/* 第二行：系统信息 + 存储/网络 */}
            <div className="monitor-row-2">
                {/* 系统信息 */}
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

                {/* 存储和网络 */}
                <div className="storage-network-compact">
                    {/* 存储条 */}
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

                    {/* 网络速度 */}
                    <div className="network-row">
                        <div className="speed-item">
                            <span className="speed-label">下载</span>
                            <span className="speed-val">{formatSpeed(finalNetworkSpeed.rx)}</span>
                        </div>
                        <div className="speed-item">
                            <span className="speed-label">上传</span>
                            <span className="speed-val">{formatSpeed(finalNetworkSpeed.tx)}</span>
                        </div>
                    </div>

                    {/* 运行时间 */}
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
