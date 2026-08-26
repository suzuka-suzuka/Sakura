import fs from 'node:fs';
import path from 'node:path';

function isDirectoryEntry(parentPath, entry) {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;

    try {
        return fs.statSync(path.join(parentPath, entry.name)).isDirectory();
    } catch {
        return false;
    }
}

export function listServerDirectories(requestedPath, fallbackRoot = process.cwd()) {
    const baseRoot = path.resolve(fallbackRoot);
    const input = String(requestedPath || '').trim();
    const candidate = input
        ? (path.isAbsolute(input) ? input : path.resolve(baseRoot, input))
        : baseRoot;
    const directoryPath = fs.realpathSync(candidate);

    if (!fs.statSync(directoryPath).isDirectory()) {
        throw new Error(`不是文件夹：${directoryPath}`);
    }

    const directories = fs.readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => isDirectoryEntry(directoryPath, entry))
        .map((entry) => ({
            name: entry.name,
            path: path.join(directoryPath, entry.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', {
            numeric: true,
            sensitivity: 'base',
        }));
    const parentPath = path.dirname(directoryPath);

    return {
        path: directoryPath,
        parent: parentPath === directoryPath ? null : parentPath,
        directories,
    };
}
