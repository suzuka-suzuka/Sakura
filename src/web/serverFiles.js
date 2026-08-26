import fs from 'node:fs';
import path from 'node:path';

export const MAX_EDITABLE_FILE_SIZE = 2 * 1024 * 1024;
export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
    '.bat', '.c', '.cc', '.cfg', '.cmd', '.conf', '.cpp', '.css', '.csv',
    '.env', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json',
    '.jsx', '.log', '.md', '.mjs', '.php', '.properties', '.ps1', '.py',
    '.rb', '.rs', '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx',
    '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const TEXT_FILE_NAMES = new Set([
    '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore',
    'dockerfile', 'license', 'makefile', 'readme',
]);
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.zip': 'application/zip',
};

function createServerFileError(message, statusCode = 400, code = 'FILE_OPERATION_FAILED') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function resolveRequestedPath(requestedPath, fallbackRoot = process.cwd()) {
    const fallback = path.resolve(fallbackRoot);
    const input = String(requestedPath || '').trim();
    return input
        ? path.resolve(path.isAbsolute(input) ? input : path.resolve(fallback, input))
        : fallback;
}

function ensureDirectory(requestedPath, fallbackRoot) {
    const candidate = resolveRequestedPath(requestedPath, fallbackRoot);
    const directoryPath = fs.realpathSync(candidate);
    if (!fs.statSync(directoryPath).isDirectory()) {
        throw createServerFileError(`不是文件夹：${directoryPath}`);
    }
    return directoryPath;
}

function ensureRegularFile(requestedPath, fallbackRoot) {
    const candidate = resolveRequestedPath(requestedPath, fallbackRoot);
    const filePath = fs.realpathSync(candidate);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
        throw createServerFileError(`不是文件：${filePath}`);
    }
    return { filePath, stats };
}

function validateEntryName(rawName) {
    const name = String(rawName || '').trim();
    if (!name) {
        throw createServerFileError('名称不能为空');
    }
    if (name === '.' || name === '..' || path.basename(name) !== name || /[\\/\p{Cc}]/u.test(name)) {
        throw createServerFileError('名称不能包含路径分隔符或控制字符');
    }
    return name;
}

function isEditableTextFile(fileName, size) {
    if (size > MAX_EDITABLE_FILE_SIZE) return false;
    const lowerName = fileName.toLowerCase();
    const extension = path.extname(lowerName);
    return TEXT_EXTENSIONS.has(extension)
        || TEXT_FILE_NAMES.has(lowerName)
        || (!extension && size <= 256 * 1024);
}

function readEntry(directoryPath, entry) {
    const entryPath = path.join(directoryPath, entry.name);
    const lstat = fs.lstatSync(entryPath);
    let stats = lstat;
    let targetAvailable = true;

    if (lstat.isSymbolicLink()) {
        try {
            stats = fs.statSync(entryPath);
        } catch {
            targetAvailable = false;
        }
    }

    const type = targetAvailable && stats.isDirectory()
        ? 'directory'
        : targetAvailable && stats.isFile()
            ? 'file'
            : 'other';

    return {
        name: entry.name,
        path: entryPath,
        type,
        size: type === 'file' ? stats.size : null,
        mtimeMs: stats.mtimeMs,
        editable: type === 'file' && isEditableTextFile(entry.name, stats.size),
        symbolicLink: lstat.isSymbolicLink(),
    };
}

export function listServerRoots() {
    if (process.platform !== 'win32') {
        return [{ name: '/', path: '/' }];
    }

    const roots = [];
    for (let code = 65; code <= 90; code += 1) {
        const drivePath = `${String.fromCharCode(code)}:\\`;
        try {
            if (fs.existsSync(drivePath)) {
                roots.push({ name: drivePath, path: drivePath });
            }
        } catch {
            // 某些网络盘或可移动盘可能暂时不可访问，跳过即可。
        }
    }
    return roots;
}

export function listServerFiles(requestedPath, fallbackRoot = process.cwd()) {
    const directoryPath = ensureDirectory(requestedPath, fallbackRoot);
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
        .map((entry) => {
            try {
                return readEntry(directoryPath, entry);
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((left, right) => {
            if (left.type !== right.type) {
                if (left.type === 'directory') return -1;
                if (right.type === 'directory') return 1;
            }
            return left.name.localeCompare(right.name, 'zh-CN', {
                numeric: true,
                sensitivity: 'base',
            });
        });
    const parentPath = path.dirname(directoryPath);

    return {
        path: directoryPath,
        parent: parentPath === directoryPath ? null : parentPath,
        roots: listServerRoots(),
        entries,
    };
}

export function readServerTextFile(requestedPath, fallbackRoot = process.cwd()) {
    const { filePath, stats } = ensureRegularFile(requestedPath, fallbackRoot);
    if (stats.size > MAX_EDITABLE_FILE_SIZE) {
        throw createServerFileError('文件超过 2 MB，请下载后在本地编辑', 413, 'FILE_TOO_LARGE');
    }

    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
        throw createServerFileError('该文件不是可编辑的文本文件', 415, 'BINARY_FILE');
    }

    let content;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw createServerFileError('文件不是 UTF-8 编码，请下载后在本地编辑', 415, 'UNSUPPORTED_ENCODING');
    }

    return {
        path: filePath,
        name: path.basename(filePath),
        content,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
    };
}

export function writeServerTextFile(
    requestedPath,
    content,
    expectedMtimeMs,
    fallbackRoot = process.cwd(),
    { force = false } = {},
) {
    const { filePath, stats } = ensureRegularFile(requestedPath, fallbackRoot);
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_FILE_SIZE) {
        throw createServerFileError('保存内容超过 2 MB', 413, 'FILE_TOO_LARGE');
    }

    const expected = Number(expectedMtimeMs);
    if (!force && Number.isFinite(expected) && Math.abs(stats.mtimeMs - expected) > 1) {
        throw createServerFileError('文件已在服务器上发生变化，请重新打开后再编辑', 409, 'FILE_CHANGED');
    }

    fs.writeFileSync(filePath, text, 'utf8');
    const savedStats = fs.statSync(filePath);
    return {
        path: filePath,
        size: savedStats.size,
        mtimeMs: savedStats.mtimeMs,
    };
}

export function createServerEntry(directory, rawName, type, fallbackRoot = process.cwd()) {
    const directoryPath = ensureDirectory(directory, fallbackRoot);
    const name = validateEntryName(rawName);
    const targetPath = path.join(directoryPath, name);
    if (fs.existsSync(targetPath)) {
        throw createServerFileError(`已存在同名项目：${name}`, 409, 'FILE_EXISTS');
    }

    if (type === 'directory') {
        fs.mkdirSync(targetPath);
    } else if (type === 'file') {
        fs.writeFileSync(targetPath, '', { encoding: 'utf8', flag: 'wx' });
    } else {
        throw createServerFileError('不支持的项目类型');
    }

    return { path: targetPath, name, type };
}

export function renameServerEntry(requestedPath, rawName, fallbackRoot = process.cwd()) {
    const sourcePath = resolveRequestedPath(requestedPath, fallbackRoot);
    fs.lstatSync(sourcePath);
    const name = validateEntryName(rawName);
    const targetPath = path.join(path.dirname(sourcePath), name);
    if (sourcePath === targetPath) {
        return { path: sourcePath, name };
    }
    if (fs.existsSync(targetPath)) {
        throw createServerFileError(`已存在同名项目：${name}`, 409, 'FILE_EXISTS');
    }

    fs.renameSync(sourcePath, targetPath);
    return { path: targetPath, name };
}

export function deleteServerEntry(requestedPath, fallbackRoot = process.cwd()) {
    const targetPath = resolveRequestedPath(requestedPath, fallbackRoot);
    const stats = fs.lstatSync(targetPath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
        fs.rmdirSync(targetPath);
    } else {
        fs.unlinkSync(targetPath);
    }
    return { path: targetPath };
}

export function getServerDownload(requestedPath, fallbackRoot = process.cwd()) {
    const { filePath, stats } = ensureRegularFile(requestedPath, fallbackRoot);
    const extension = path.extname(filePath).toLowerCase();
    return {
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        contentType: MIME_TYPES[extension] || 'application/octet-stream',
    };
}

export function writeServerUpload(directory, rawName, buffer, overwrite = false, fallbackRoot = process.cwd()) {
    if (!Buffer.isBuffer(buffer)) {
        throw createServerFileError('上传内容无效');
    }
    if (buffer.length > MAX_UPLOAD_FILE_SIZE) {
        throw createServerFileError('单个上传文件不能超过 50 MB', 413, 'FILE_TOO_LARGE');
    }

    const directoryPath = ensureDirectory(directory, fallbackRoot);
    const name = validateEntryName(rawName);
    const targetPath = path.join(directoryPath, name);
    if (fs.existsSync(targetPath) && !overwrite) {
        throw createServerFileError(`已存在同名文件：${name}`, 409, 'FILE_EXISTS');
    }
    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isFile()) {
        throw createServerFileError(`同名项目不是文件：${name}`, 409, 'NOT_A_FILE');
    }

    fs.writeFileSync(targetPath, buffer, overwrite ? undefined : { flag: 'wx' });
    const stats = fs.statSync(targetPath);
    return { path: targetPath, name, size: stats.size, mtimeMs: stats.mtimeMs };
}

export function getServerFileErrorStatus(error) {
    if (Number.isInteger(error?.statusCode)) return error.statusCode;
    switch (error?.code) {
        case 'ENOENT':
            return 404;
        case 'EACCES':
        case 'EPERM':
            return 403;
        case 'EEXIST':
        case 'ENOTEMPTY':
            return 409;
        case 'EISDIR':
        case 'ENOTDIR':
            return 400;
        default:
            return 400;
    }
}
