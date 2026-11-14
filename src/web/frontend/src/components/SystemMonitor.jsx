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

/** 时长只保留最大的两个单位，返回 [[数字, 单位], ...]，单位用小字显示 */
function uptimeParts(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days > 0) return [[days, '天'], [hours, '时']];
    if (hours > 0) return [[hours, '时'], [mins, '分']];
    if (mins > 0) return [[mins, '分'], [total % 60, '秒']];
    return [[total, '秒']];
}

function Uptime({ seconds }) {
    return uptimeParts(seconds).map(([number, unit]) => (
        <span key={unit}>{number}<span className="stat-unit">{unit}</span></span>
    ));
}

function avatarUrl(uin) {
    return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`;
}

const FALLBACK_AVATAR = avatarUrl(10000);

/** 群和好友数，列表还没拉到时不显示 */
function directoryText(account) {
    const parts = [];
    if (account.groupCount != null) parts.push(`群 ${account.groupCount}`);
    if (account.friendCount != null) parts.push(`好友 ${account.friendCount}`);
    return parts.join(' · ');
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

function diskLevel(percent) {
    if (percent >= 90) return 'bar-danger';
    if (percent >= 70) return 'bar-warning';
    return 'bar-normal';
}

function StorageBar({ mount, used, total }) {
    const percent = total > 0 ? (used / total) * 100 : 0;
    return (
        <div className="storage-bar-item">
            <div className="storage-bar-head">
                <span className="storage-mount" title={mount}>{mount}</span>
                <span className="storage-size">{formatBytes(used)} / {formatBytes(total)} · {percent.toFixed(0)}%</span>
            </div>
            <div className="storage-bar-bg">
                <div className={`storage-bar-fill ${diskLevel(percent)}`} style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>
        </div>
    );
}

/** 只有一个分区时：大号百分比 + 进度条 + 已用 / 剩余 / 总共 */
function DiskSummary({ disk }) {
    const total = disk.size || 0;
    const used = disk.used || 0;
    const free = Number.isFinite(disk.available) ? disk.available : Math.max(0, total - used);
    const percent = total > 0 ? (used / total) * 100 : 0;
    return (
        <div className="disk-summary">
            <div className="disk-summary-head">
                <span className="disk-summary-percent">{percent.toFixed(0)}<span className="stat-unit">%</span></span>
                <span className="storage-mount" title={disk.mount}>{disk.mount}</span>
            </div>
            <div className="storage-bar-bg">
                <div className={`storage-bar-fill ${diskLevel(percent)}`} style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>
            <dl className="disk-summary-stats">
                <div><dt>已用</dt><dd>{formatBytes(used)}</dd></div>
                <div><dt>剩余</dt><dd>{formatBytes(free)}</dd></div>
                <div><dt>总共</dt><dd>{formatBytes(total)}</dd></div>
            </dl>
        </div>
    );
}

/** 只有一个账号时的名片：和右边的环形图卡片一样大 */
function BotProfile({ account }) {
    const meta = directoryText(account);
    return (
        <section className="card dash-bots dash-profile" title={`${account.nickname || ''}（${account.uin}）`}>
            <img
                className="dash-profile-avatar"
                src={avatarUrl(account.uin)}
                alt=""
                onError={(event) => { event.target.src = FALLBACK_AVATAR; }}
            />
            <div className="dash-profile-name">{account.nickname || account.uin}</div>
            <div className="dash-profile-id">{account.uin}</div>
            <div className="dash-profile-meta">
                <span className="connection-dot" />
                在线{meta ? ` · ${meta}` : ''}
            </div>
        </section>
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
    // 账号卡按数量定宽：一个号是名片，和三个环形图并排四等分；两个号占半行；更多时独占一行
    const botsLayout = accounts.length <= 1 ? 'one' : accounts.length === 2 ? 'two' : 'many';
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
        <div className={`dash dash--bots-${botsLayout}`}>
            {accounts.length === 0 && (
                <section className="card dash-bots dash-profile dash-profile--empty">
                    <img className="dash-profile-avatar" src={FALLBACK_AVATAR} alt="" />
                    <div className="dash-profile-name">还没有账号连接</div>
                    <div className="dash-profile-meta">连接后会显示在这里</div>
                </section>
            )}
            {accounts.length === 1 && <BotProfile account={accounts[0]} />}
            {accounts.length > 1 && (
                <DashCard
                    className="dash-bots"
                    title="机器人账号"
                    extra={<span className="field-count">{accounts.length}</span>}
                >
                    <div className="bot-cards-row">
                        {accounts.map((account) => {
                            const meta = directoryText(account);
                            return (
                                <div key={account.self_id} className="bot-card" title={`${account.nickname || ''}（${account.uin}）`}>
                                    <img
                                        className="bot-card-avatar"
                                        src={avatarUrl(account.uin)}
                                        alt=""
                                        onError={(event) => { event.target.src = FALLBACK_AVATAR; }}
                                    />
                                    <span className="bot-card-text">
                                        <span className="bot-card-nick">{account.nickname || account.uin}</span>
                                        <span className="bot-card-id">{account.uin}</span>
                                        {meta && <span className="bot-card-meta">{meta}</span>}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </DashCard>
            )}

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
                {fsSize.length === 1 ? (
                    <DiskSummary disk={fsSize[0]} />
                ) : (
                    <div className="storage-bars">
                        {fsSize.length === 0 && <span className="dash-empty">暂无数据</span>}
                        {fsSize.slice(0, 4).map((fs, idx) => (
                            <StorageBar key={idx} mount={fs.mount} used={fs.used} total={fs.size} />
                        ))}
                    </div>
                )}
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
                        <div className="stat-value"><Uptime seconds={time.uptime} /></div>
                    </div>
                    <div className="stat">
                        <div className="stat-label">Node 运行</div>
                        <div className="stat-value"><Uptime seconds={nodeProcess.uptime} /></div>
                    </div>
                </div>
            </DashCard>
        </div>
    );
}
