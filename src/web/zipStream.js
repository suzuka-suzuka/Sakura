import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform, pipeline } from 'node:stream';

// 流式 ZIP 写出器：边遍历边压缩边发送，不在内存或磁盘上攒整个压缩包。
// 文件头先写、CRC 和大小放在数据描述符里（通用标志位 3），超过 4 GB 的条目和偏移走 ZIP64。

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
// 文件在读取过程中可能变大，接近 4 GB 的条目提前按 ZIP64 写本地头
const ZIP64_ENTRY_THRESHOLD = 0xf0000000;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const MADE_BY_UNIX = 3 << 8;

// 本身已经压缩过的格式直接存储，省掉白白消耗的 CPU
const STORED_EXTENSIONS = new Set([
    '.7z', '.aac', '.apk', '.avif', '.br', '.bz2', '.docx', '.flac', '.gif', '.gz',
    '.heic', '.jar', '.jpeg', '.jpg', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.ogg',
    '.opus', '.png', '.pptx', '.rar', '.tgz', '.webm', '.webp', '.woff', '.woff2',
    '.xlsx', '.xz', '.zip', '.zst',
]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

// zlib.crc32 从 Node 20.15 / 22.2 起才有，老版本用查表兜底
const crc32 = typeof zlib.crc32 === 'function'
    ? (buffer, value) => zlib.crc32(buffer, value)
    : (buffer, value = 0) => {
        let crc = (value ^ UINT32_MAX) >>> 0;
        for (let index = 0; index < buffer.length; index += 1) {
            crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ UINT32_MAX) >>> 0;
    };

function toDosDateTime(date) {
    const year = date.getFullYear();
    if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

function writeUInt64(buffer, value, offset) {
    buffer.writeBigUInt64LE(BigInt(value), offset);
}

function buildLocalHeader(entry) {
    const extra = entry.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (entry.zip64) {
        // 本地头里的 ZIP64 扩展字段：大小写 0，真实值在数据描述符里
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(entry.versionNeeded, 4);
    header.writeUInt16LE(entry.flags, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.dos.time, 10);
    header.writeUInt16LE(entry.dos.date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(entry.zip64 ? UINT32_MAX : 0, 18);
    header.writeUInt32LE(entry.zip64 ? UINT32_MAX : 0, 22);
    header.writeUInt16LE(entry.nameBuffer.length, 26);
    header.writeUInt16LE(extra.length, 28);
    return Buffer.concat([header, entry.nameBuffer, extra]);
}

function buildDataDescriptor(entry) {
    if (entry.zip64) {
        const descriptor = Buffer.alloc(24);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(entry.crc, 4);
        writeUInt64(descriptor, entry.compressedSize, 8);
        writeUInt64(descriptor, entry.size, 16);
        return descriptor;
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    return descriptor;
}

function buildCentralHeader(entry) {
    const sizes64 = entry.zip64 || entry.size >= UINT32_MAX || entry.compressedSize >= UINT32_MAX;
    const offset64 = entry.offset >= UINT32_MAX;
    const extraFields = [];
    if (sizes64) extraFields.push(entry.size, entry.compressedSize);
    if (offset64) extraFields.push(entry.offset);

    let extra = Buffer.alloc(0);
    if (extraFields.length > 0) {
        extra = Buffer.alloc(4 + extraFields.length * 8);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(extraFields.length * 8, 2);
        extraFields.forEach((value, index) => writeUInt64(extra, value, 4 + index * 8));
    }
    const versionNeeded = extraFields.length > 0 ? VERSION_ZIP64 : entry.versionNeeded;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(MADE_BY_UNIX | VERSION_ZIP64, 4);
    header.writeUInt16LE(versionNeeded, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.dos.time, 12);
    header.writeUInt16LE(entry.dos.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(sizes64 ? UINT32_MAX : entry.compressedSize, 20);
    header.writeUInt32LE(sizes64 ? UINT32_MAX : entry.size, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    // 高 16 位放 Unix 权限，低位放 DOS 目录属性
    header.writeUInt32LE((((entry.mode & 0xffff) << 16) | (entry.isDirectory ? 0x10 : 0)) >>> 0, 38);
    header.writeUInt32LE(offset64 ? UINT32_MAX : entry.offset, 42);
    return Buffer.concat([header, entry.nameBuffer, extra]);
}

function buildEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const needsZip64 = entryCount >= UINT16_MAX
        || centralSize >= UINT32_MAX
        || centralOffset >= UINT32_MAX;
    const parts = [];

    if (needsZip64) {
        const record = Buffer.alloc(56);
        record.writeUInt32LE(0x06064b50, 0);
        writeUInt64(record, 44, 4);
        record.writeUInt16LE(MADE_BY_UNIX | VERSION_ZIP64, 12);
        record.writeUInt16LE(VERSION_ZIP64, 14);
        record.writeUInt32LE(0, 16);
        record.writeUInt32LE(0, 20);
        writeUInt64(record, entryCount, 24);
        writeUInt64(record, entryCount, 32);
        writeUInt64(record, centralSize, 40);
        writeUInt64(record, centralOffset, 48);

        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        locator.writeUInt32LE(0, 4);
        writeUInt64(locator, centralOffset + centralSize, 8);
        locator.writeUInt32LE(1, 16);
        parts.push(record, locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(entryCount, UINT16_MAX), 8);
    end.writeUInt16LE(Math.min(entryCount, UINT16_MAX), 10);
    end.writeUInt32LE(Math.min(centralSize, UINT32_MAX), 12);
    end.writeUInt32LE(Math.min(centralOffset, UINT32_MAX), 16);
    end.writeUInt16LE(0, 20);
    parts.push(end);
    return Buffer.concat(parts);
}

function createEntry(name, stats, isDirectory) {
    const zip64 = !isDirectory && stats.size >= ZIP64_ENTRY_THRESHOLD;
    const stored = isDirectory || STORED_EXTENSIONS.has(path.extname(name).toLowerCase());
    return {
        nameBuffer: Buffer.from(isDirectory ? `${name}/` : name, 'utf8'),
        isDirectory,
        zip64,
        method: stored ? METHOD_STORE : METHOD_DEFLATE,
        flags: FLAG_UTF8 | (isDirectory ? 0 : FLAG_DATA_DESCRIPTOR),
        versionNeeded: zip64 ? VERSION_ZIP64 : VERSION_DEFAULT,
        dos: toDosDateTime(stats.mtime),
        mode: stats.mode,
        crc: 0,
        size: 0,
        compressedSize: 0,
        offset: 0,
    };
}

async function* readFileData(source, entry) {
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            entry.crc = crc32(chunk, entry.crc);
            entry.size += chunk.length;
            callback(null, chunk);
        },
    });
    const streams = [source, counter];
    if (entry.method === METHOD_DEFLATE) streams.push(zlib.createDeflateRaw({ level: 6 }));

    let pipelineError = null;
    const output = pipeline(...streams, (error) => {
        if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') pipelineError = error;
    });
    for await (const chunk of output) {
        entry.compressedSize += chunk.length;
        yield chunk;
    }
    if (pipelineError) throw pipelineError;
    if (!entry.zip64 && (entry.size >= UINT32_MAX || entry.compressedSize >= UINT32_MAX)) {
        throw new Error(`文件在打包过程中增长超过 4 GB：${entry.nameBuffer.toString('utf8')}`);
    }
}

async function* walkDirectory(directoryPath, relativeName, onSkip) {
    let dirents;
    try {
        dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
        onSkip?.(relativeName, error);
        return;
    }

    for (const dirent of dirents) {
        const absolutePath = path.join(directoryPath, dirent.name);
        const childName = `${relativeName}/${dirent.name}`;
        let stats;
        try {
            stats = await fs.promises.lstat(absolutePath);
            // 文件链接跟随到目标；目录链接跳过，避免循环和把别处的大目录一起打进去
            if (stats.isSymbolicLink()) {
                stats = await fs.promises.stat(absolutePath);
                if (!stats.isFile()) continue;
            }
        } catch (error) {
            onSkip?.(childName, error);
            continue;
        }

        if (stats.isDirectory()) {
            yield { type: 'directory', name: childName, stats };
            yield* walkDirectory(absolutePath, childName, onSkip);
        } else if (stats.isFile()) {
            yield { type: 'file', name: childName, path: absolutePath, stats };
        }
    }
}

async function* generateZip(directoryPath, rootName, onSkip) {
    const entries = [];
    let offset = 0;

    const rootStats = await fs.promises.stat(directoryPath);
    const items = (async function* () {
        yield { type: 'directory', name: rootName, stats: rootStats };
        yield* walkDirectory(directoryPath, rootName, onSkip);
    })();

    for await (const item of items) {
        if (item.type === 'directory') {
            const entry = createEntry(item.name, item.stats, true);
            entry.offset = offset;
            const header = buildLocalHeader(entry);
            offset += header.length;
            entries.push(entry);
            yield header;
            continue;
        }

        // 先打开再写文件头：打不开（被删、没权限）就整条跳过，不留半截条目
        let handle;
        try {
            handle = await fs.promises.open(item.path, 'r');
        } catch (error) {
            onSkip?.(item.name, error);
            continue;
        }

        const entry = createEntry(item.name, item.stats, false);
        entry.offset = offset;
        const header = buildLocalHeader(entry);
        offset += header.length;
        // 读流接管文件句柄；客户端中途断开时 finally 负责关掉它
        const source = handle.createReadStream();
        try {
            yield header;
            for await (const chunk of readFileData(source, entry)) {
                offset += chunk.length;
                yield chunk;
            }
        } finally {
            source.destroy();
        }

        const descriptor = buildDataDescriptor(entry);
        offset += descriptor.length;
        entries.push(entry);
        yield descriptor;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const entry of entries) {
        const header = buildCentralHeader(entry);
        centralSize += header.length;
        yield header;
    }
    yield buildEndOfCentralDirectory(entries.length, centralSize, centralOffset);
}

/**
 * 把一个文件夹打包成 ZIP 的可读流，压缩包内以 rootName 作为顶层目录。
 * @param {string} directoryPath 已解析好的真实目录路径
 * @param {string} rootName 压缩包内的顶层目录名
 * @param {{ onSkip?: (name: string, error: Error) => void }} [options] 跳过无法读取的条目时回调
 */
export function createDirectoryZipStream(directoryPath, rootName, { onSkip } = {}) {
    return Readable.from(generateZip(directoryPath, rootName, onSkip), { objectMode: false });
}
