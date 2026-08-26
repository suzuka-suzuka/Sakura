import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function readErrorResponse(response) {
    try {
        const payload = await response.json();
        return {
            message: payload.error || `请求失败 (${response.status})`,
            code: payload.code || 'REQUEST_FAILED',
        };
    } catch {
        return { message: `请求失败 (${response.status})`, code: 'REQUEST_FAILED' };
    }
}

async function requestJson(token, onUnauthorized, url, options = {}) {
    const headers = {
        Authorization: `Bearer ${token}`,
        ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
    };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) onUnauthorized?.();
    if (!response.ok) {
        const detail = await readErrorResponse(response);
        const error = new Error(detail.message);
        error.code = detail.code;
        error.status = response.status;
        throw error;
    }

    const payload = await response.json();
    if (!payload.success) {
        const error = new Error(payload.error || '操作失败');
        error.code = payload.code || 'REQUEST_FAILED';
        throw error;
    }
    return payload.data;
}

function formatSize(size) {
    if (size == null) return '—';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(mtimeMs) {
    if (!mtimeMs) return '—';
    return new Date(mtimeMs).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function getEntryIcon(entry) {
    if (entry.type === 'directory') return '📁';
    const extension = entry.name.split('.').pop()?.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) return '🖼️';
    if (['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)) return '🗜️';
    if (['mp3', 'wav', 'flac', 'ogg'].includes(extension)) return '🎵';
    if (['mp4', 'mkv', 'webm', 'mov'].includes(extension)) return '🎬';
    if (entry.editable) return '📄';
    return '📦';
}

export default function FileManager({ token, onUnauthorized, onToast }) {
    const uploadInputRef = useRef(null);
    const [directoryPath, setDirectoryPath] = useState('');
    const [pathInput, setPathInput] = useState('');
    const [parentPath, setParentPath] = useState(null);
    const [roots, setRoots] = useState([]);
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editor, setEditor] = useState(null);
    const [nameDialog, setNameDialog] = useState(null);

    const notify = useCallback((message, type = 'info') => {
        onToast?.(message, type);
    }, [onToast]);

    const loadDirectory = useCallback(async (requestedPath = '') => {
        setLoading(true);
        setError('');
        try {
            const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : '';
            const data = await requestJson(token, onUnauthorized, `/api/files${query}`);
            setDirectoryPath(data.path || '');
            setPathInput(data.path || '');
            setParentPath(data.parent || null);
            setRoots(Array.isArray(data.roots) ? data.roots : []);
            setEntries(Array.isArray(data.entries) ? data.entries : []);
        } catch (loadError) {
            setError(loadError.message || '读取文件夹失败');
        } finally {
            setLoading(false);
        }
    }, [token, onUnauthorized]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void loadDirectory('');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [loadDirectory]);

    const openTypedPath = (event) => {
        event.preventDefault();
        void loadDirectory(pathInput);
    };

    const openEditor = async (entry) => {
        setEditor({
            path: entry.path,
            name: entry.name,
            content: '',
            mtimeMs: entry.mtimeMs,
            loading: true,
            loaded: false,
            saving: false,
            error: '',
            errorCode: '',
        });
        try {
            const data = await requestJson(
                token,
                onUnauthorized,
                `/api/files/content?path=${encodeURIComponent(entry.path)}`,
            );
            setEditor((current) => current?.path === entry.path ? {
                ...current,
                content: data.content || '',
                mtimeMs: data.mtimeMs,
                loading: false,
                loaded: true,
                error: '',
                errorCode: '',
            } : current);
        } catch (openError) {
            setEditor((current) => current?.path === entry.path ? {
                ...current,
                loading: false,
                loaded: false,
                error: openError.message || '读取文件失败',
                errorCode: openError.code || 'REQUEST_FAILED',
            } : current);
        }
    };

    const saveEditor = async (force = false) => {
        if (!editor || !editor.loaded || editor.loading || editor.saving) return;
        setEditor((current) => ({ ...current, saving: true, error: '', errorCode: '' }));
        try {
            const data = await requestJson(token, onUnauthorized, '/api/files/content', {
                method: 'PUT',
                body: JSON.stringify({
                    path: editor.path,
                    content: editor.content,
                    expectedMtimeMs: editor.mtimeMs,
                    force,
                }),
            });
            setEditor((current) => ({
                ...current,
                mtimeMs: data.mtimeMs,
                saving: false,
                error: '',
                errorCode: '',
            }));
            notify(`${editor.name} 已保存`, 'success');
            void loadDirectory(directoryPath);
        } catch (saveError) {
            setEditor((current) => ({
                ...current,
                saving: false,
                error: saveError.message || '保存失败',
                errorCode: saveError.code || 'REQUEST_FAILED',
            }));
        }
    };

    const downloadEntry = async (entry) => {
        try {
            const data = await requestJson(token, onUnauthorized, '/api/files/download-ticket', {
                method: 'POST',
                body: JSON.stringify({ path: entry.path }),
            });
            const anchor = document.createElement('a');
            anchor.href = `/api/files/download?ticket=${encodeURIComponent(data.ticket)}`;
            anchor.download = data.name || entry.name;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } catch (downloadError) {
            notify(downloadError.message || '下载失败', 'error');
        }
    };

    const openCreateDialog = (type) => {
        setNameDialog({
            mode: 'create',
            type,
            name: '',
            submitting: false,
            error: '',
        });
    };

    const openRenameDialog = (entry) => {
        setNameDialog({
            mode: 'rename',
            type: entry.type,
            path: entry.path,
            name: entry.name,
            submitting: false,
            error: '',
        });
    };

    const submitNameDialog = async (event) => {
        event.preventDefault();
        if (!nameDialog || nameDialog.submitting) return;
        setNameDialog((current) => ({ ...current, submitting: true, error: '' }));
        try {
            if (nameDialog.mode === 'create') {
                await requestJson(token, onUnauthorized, '/api/files/entry', {
                    method: 'POST',
                    body: JSON.stringify({
                        directory: directoryPath,
                        name: nameDialog.name,
                        type: nameDialog.type,
                    }),
                });
                notify(nameDialog.type === 'directory' ? '文件夹已创建' : '文件已创建', 'success');
            } else {
                await requestJson(token, onUnauthorized, '/api/files/rename', {
                    method: 'POST',
                    body: JSON.stringify({ path: nameDialog.path, name: nameDialog.name }),
                });
                notify('重命名成功', 'success');
            }
            setNameDialog(null);
            void loadDirectory(directoryPath);
        } catch (submitError) {
            setNameDialog((current) => ({
                ...current,
                submitting: false,
                error: submitError.message || '操作失败',
            }));
        }
    };

    const deleteEntry = async (entry) => {
        const extra = entry.type === 'directory' ? '（只能删除空文件夹）' : '';
        if (!window.confirm(`确定删除“${entry.name}”吗？${extra}`)) return;
        try {
            await requestJson(token, onUnauthorized, '/api/files', {
                method: 'DELETE',
                body: JSON.stringify({ path: entry.path }),
            });
            notify(`${entry.name} 已删除`, 'success');
            void loadDirectory(directoryPath);
        } catch (deleteError) {
            notify(deleteError.message || '删除失败', 'error');
        }
    };

    const uploadFile = async (file, overwrite = false) => {
        const query = new URLSearchParams({
            directory: directoryPath,
            name: file.name,
            overwrite: String(overwrite),
        });
        const response = await fetch(`/api/files/upload?${query}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/octet-stream',
            },
            body: file,
        });
        if (response.status === 401) onUnauthorized?.();
        if (!response.ok) {
            const detail = await readErrorResponse(response);
            const uploadError = new Error(detail.message);
            uploadError.code = detail.code;
            throw uploadError;
        }
        return response.json();
    };

    const handleUpload = async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length === 0) return;

        let uploaded = 0;
        for (const file of files) {
            if (file.size > MAX_UPLOAD_BYTES) {
                notify(`${file.name} 超过 50 MB，已跳过`, 'error');
                continue;
            }
            try {
                await uploadFile(file);
                uploaded += 1;
            } catch (uploadError) {
                if (
                    uploadError.code === 'FILE_EXISTS'
                    && window.confirm(`“${file.name}”已经存在，是否覆盖？`)
                ) {
                    try {
                        await uploadFile(file, true);
                        uploaded += 1;
                    } catch (overwriteError) {
                        notify(overwriteError.message || `${file.name} 上传失败`, 'error');
                    }
                } else {
                    notify(uploadError.message || `${file.name} 上传失败`, 'error');
                }
            }
        }

        if (uploaded > 0) {
            notify(`已上传 ${uploaded} 个文件`, 'success');
            void loadDirectory(directoryPath);
        }
    };

    return (
        <div className="file-manager">
            <div className="file-manager-card">
                <div className="file-manager-toolbar">
                    <form className="file-manager-path-form" onSubmit={openTypedPath}>
                        <input
                            className="field-input"
                            value={pathInput}
                            onChange={(event) => setPathInput(event.target.value)}
                            aria-label="服务器路径"
                        />
                        <button className="btn btn-secondary" type="submit" disabled={loading}>打开</button>
                    </form>
                    <div className="file-manager-toolbar-actions">
                        <button
                            className="btn btn-secondary"
                            type="button"
                            disabled={!parentPath || loading}
                            onClick={() => void loadDirectory(parentPath)}
                        >
                            ↑ 上级
                        </button>
                        <button
                            className="btn btn-secondary"
                            type="button"
                            disabled={loading}
                            onClick={() => void loadDirectory(directoryPath)}
                        >
                            刷新
                        </button>
                        <button className="btn btn-secondary" type="button" onClick={() => openCreateDialog('directory')}>
                            新建文件夹
                        </button>
                        <button className="btn btn-secondary" type="button" onClick={() => openCreateDialog('file')}>
                            新建文件
                        </button>
                        <button className="btn btn-primary" type="button" onClick={() => uploadInputRef.current?.click()}>
                            上传
                        </button>
                        <input
                            ref={uploadInputRef}
                            type="file"
                            multiple
                            hidden
                            onChange={handleUpload}
                        />
                    </div>
                </div>

                {roots.length > 1 && (
                    <div className="file-manager-roots">
                        <span>磁盘</span>
                        {roots.map((root) => (
                            <button key={root.path} type="button" onClick={() => void loadDirectory(root.path)}>
                                {root.name}
                            </button>
                        ))}
                    </div>
                )}

                {error && <div className="file-manager-error">{error}</div>}

                <div className="file-manager-table" aria-busy={loading}>
                    <div className="file-manager-row file-manager-header-row">
                        <div>名称</div>
                        <div>大小</div>
                        <div>修改时间</div>
                        <div>操作</div>
                    </div>
                    {loading && <div className="file-manager-empty">正在读取...</div>}
                    {!loading && entries.length === 0 && !error && (
                        <div className="file-manager-empty">这个文件夹是空的</div>
                    )}
                    {!loading && entries.map((entry) => (
                        <div className="file-manager-row" key={entry.path}>
                            <div className="file-manager-name-cell">
                                <button
                                    type="button"
                                    className="file-manager-name"
                                    onClick={() => {
                                        if (entry.type === 'directory') void loadDirectory(entry.path);
                                        else if (entry.editable) void openEditor(entry);
                                    }}
                                >
                                    <span>{getEntryIcon(entry)}</span>
                                    <span className="file-manager-name-text">{entry.name}</span>
                                    {entry.symbolicLink && <span className="file-manager-badge">链接</span>}
                                </button>
                            </div>
                            <div className="file-manager-meta">{formatSize(entry.size)}</div>
                            <div className="file-manager-meta">{formatTime(entry.mtimeMs)}</div>
                            <div className="file-manager-actions">
                                {entry.type === 'file' && entry.editable && (
                                    <button type="button" onClick={() => void openEditor(entry)}>编辑</button>
                                )}
                                {entry.type === 'file' && (
                                    <button type="button" onClick={() => void downloadEntry(entry)}>下载</button>
                                )}
                                <button type="button" onClick={() => openRenameDialog(entry)}>重命名</button>
                                <button type="button" className="danger" onClick={() => void deleteEntry(entry)}>删除</button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {nameDialog && (
                <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setNameDialog(null); }}>
                    <div className="modal-card file-manager-name-modal" onClick={(event) => event.stopPropagation()}>
                        <div className="modal-header">
                            <span className="modal-title">
                                {nameDialog.mode === 'rename'
                                    ? '重命名'
                                    : nameDialog.type === 'directory' ? '新建文件夹' : '新建文件'}
                            </span>
                            <button type="button" className="modal-close" onClick={() => setNameDialog(null)}>✕</button>
                        </div>
                        <form onSubmit={submitNameDialog}>
                            <div className="modal-body">
                                <label className="field-label" htmlFor="file-manager-entry-name">名称</label>
                                <input
                                    id="file-manager-entry-name"
                                    className="field-input"
                                    value={nameDialog.name}
                                    autoFocus
                                    onChange={(event) => setNameDialog((current) => ({ ...current, name: event.target.value }))}
                                />
                                {nameDialog.error && <div className="file-manager-dialog-error">{nameDialog.error}</div>}
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setNameDialog(null)}>取消</button>
                                <button type="submit" className="btn btn-primary" disabled={nameDialog.submitting || !nameDialog.name.trim()}>
                                    {nameDialog.submitting ? '处理中...' : '确定'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {editor && (
                <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !editor.saving) setEditor(null); }}>
                    <div className="modal-card file-editor-modal" onClick={(event) => event.stopPropagation()}>
                        <div className="modal-header">
                            <div className="file-editor-title">
                                <span className="modal-title">编辑 {editor.name}</span>
                                <span title={editor.path}>{editor.path}</span>
                            </div>
                            <button type="button" className="modal-close" disabled={editor.saving} onClick={() => setEditor(null)}>✕</button>
                        </div>
                        <div className="modal-body file-editor-body">
                            {editor.loading ? (
                                <div className="file-manager-empty">正在读取...</div>
                            ) : editor.loaded ? (
                                <textarea
                                    className="file-editor-textarea"
                                    value={editor.content}
                                    spellCheck={false}
                                    onChange={(event) => setEditor((current) => ({
                                        ...current,
                                        content: event.target.value,
                                        error: '',
                                        errorCode: '',
                                    }))}
                                    onKeyDown={(event) => {
                                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                                            event.preventDefault();
                                            void saveEditor();
                                        }
                                    }}
                                />
                            ) : (
                                <div className="file-manager-empty">无法打开这个文件</div>
                            )}
                            {editor.error && <div className="file-manager-dialog-error">{editor.error}</div>}
                        </div>
                        <div className="modal-footer file-editor-footer">
                            <span>UTF-8 文本，最大 2 MB · Ctrl+S 保存</span>
                            <div>
                                <button type="button" className="btn btn-secondary" disabled={editor.saving} onClick={() => setEditor(null)}>关闭</button>
                                {editor.errorCode === 'FILE_CHANGED' && (
                                    <button
                                        type="button"
                                        className="btn btn-danger"
                                        disabled={editor.saving}
                                        onClick={() => {
                                            if (window.confirm('服务器上的文件已经变化，确定用当前内容覆盖吗？')) void saveEditor(true);
                                        }}
                                    >覆盖服务器版本</button>
                                )}
                                <button type="button" className="btn btn-primary" disabled={!editor.loaded || editor.loading || editor.saving} onClick={() => void saveEditor()}>
                                    {editor.saving ? '保存中...' : '保存'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
