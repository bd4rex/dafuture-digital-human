import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export const KNOWLEDGE_LIMITS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxExtractedCharacters: 1_000_000,
  maxDocuments: 500,
  maxChunks: 5_000,
});

export const SUPPORTED_KNOWLEDGE_EXTENSIONS = Object.freeze([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.docx',
  '.pdf',
]);

const EXTENSION_MEDIA_TYPES = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
});

function knowledgeError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function cleanFilename(value) {
  const supplied = typeof value === 'string' ? value : '';
  let filename = path
    .basename(supplied.replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  if (!filename || filename === '.' || filename === '..') {
    filename = 'unnamed';
  }

  if (filename.length > 180) {
    const extension = path.extname(filename).slice(0, 16);
    filename = `${filename.slice(0, 180 - extension.length)}${extension}`;
  }
  return filename;
}

function normalizeExtractedText(value) {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function decodeUtf8(buffer, filename) {
  if (buffer.includes(0)) {
    throw knowledgeError(
      'KNOWLEDGE_INVALID_TEXT',
      `文件“${filename}”不是可识别的 UTF-8 文本。`,
    );
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw knowledgeError(
      'KNOWLEDGE_INVALID_TEXT',
      `文件“${filename}”不是有效的 UTF-8 文本，请转换编码后再导入。`,
    );
  }
}

async function extractText(buffer, filename, extension) {
  if (['.txt', '.md', '.csv'].includes(extension)) {
    return decodeUtf8(buffer, filename);
  }

  if (extension === '.json') {
    const source = decodeUtf8(buffer, filename);
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_JSON',
        `文件“${filename}”不是有效的 JSON。`,
      );
    }
  }

  if (extension === '.docx') {
    if (buffer.length < 4 || buffer.subarray(0, 2).toString('ascii') !== 'PK') {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_DOCX',
        `文件“${filename}”不是有效的 DOCX 文档。`,
      );
    }
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_DOCX',
        `无法解析文件“${filename}”，请确认它是有效的 DOCX 文档。`,
      );
    }
  }

  if (extension === '.pdf') {
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_PDF',
        `文件“${filename}”不是有效的 PDF。`,
      );
    }

    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } catch {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_PDF',
        `无法从文件“${filename}”提取文字；扫描件请先进行 OCR。`,
      );
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  throw knowledgeError(
    'KNOWLEDGE_UNSUPPORTED_TYPE',
    `不支持文件“${filename}”的格式。`,
  );
}

export function chunkKnowledgeText(
  text,
  { maxCharacters = 2_000, overlapCharacters = 160 } = {},
) {
  if (!text) {
    return [];
  }

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxCharacters, text.length);
    if (end < text.length) {
      const minimumEnd = start + Math.floor(maxCharacters * 0.58);
      const searchArea = text.slice(minimumEnd, end);
      let relativeBoundary = -1;
      for (const pattern of [/\n\n/g, /[\n。！？；]/g]) {
        for (const match of searchArea.matchAll(pattern)) {
          relativeBoundary = match.index + match[0].length;
        }
        if (relativeBoundary >= 0) {
          break;
        }
      }
      if (relativeBoundary >= 0) {
        end = minimumEnd + relativeBoundary;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(start + 1, end - overlapCharacters);
  }
  return chunks;
}

export async function parseKnowledgeFile({ filename, mimetype, buffer }) {
  const cleanedFilename = cleanFilename(filename);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw knowledgeError(
      'KNOWLEDGE_EMPTY_FILE',
      `文件“${cleanedFilename}”为空，未导入。`,
    );
  }
  if (buffer.length > KNOWLEDGE_LIMITS.maxFileBytes) {
    throw knowledgeError(
      'KNOWLEDGE_FILE_TOO_LARGE',
      `文件“${cleanedFilename}”超过 10 MB 上限。`,
      413,
    );
  }

  const extension = path.extname(cleanedFilename).toLowerCase();
  if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.includes(extension)) {
    throw knowledgeError(
      'KNOWLEDGE_UNSUPPORTED_TYPE',
      `不支持“${extension || '无扩展名'}”格式。可导入 TXT、Markdown、CSV、JSON、DOCX 或 PDF。`,
    );
  }

  const extractedText = normalizeExtractedText(
    await extractText(buffer, cleanedFilename, extension),
  );
  if (!extractedText) {
    throw knowledgeError(
      'KNOWLEDGE_NO_TEXT',
      `文件“${cleanedFilename}”中没有可用文字。`,
    );
  }
  if (extractedText.length > KNOWLEDGE_LIMITS.maxExtractedCharacters) {
    throw knowledgeError(
      'KNOWLEDGE_TEXT_TOO_LARGE',
      `文件“${cleanedFilename}”提取后超过 100 万字符上限。`,
      413,
    );
  }

  const chunks = chunkKnowledgeText(extractedText);
  return {
    filename: cleanedFilename,
    extension,
    mediaType: EXTENSION_MEDIA_TYPES[extension],
    suppliedMediaType: typeof mimetype === 'string' ? mimetype : '',
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    textLength: extractedText.length,
    preview: extractedText.slice(0, 500),
    chunkTexts: chunks,
    buffer,
  };
}

function validString(value, location, { pattern } = {}) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${location} 必须是非空字符串`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${location} 格式无效`);
  }
  return value;
}

function validNonNegativeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} 必须是非负整数`);
  }
  return value;
}

function prepareStoredDocument(rawDocument, documentIndex) {
  const location = `knowledge.json.documents[${documentIndex}]`;
  if (!rawDocument || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
    throw new Error(`${location} 必须是对象`);
  }

  const id = validString(rawDocument.id, `${location}.id`, {
    pattern: /^doc-[a-z0-9-]+$/,
  });
  const storedFilename = validString(
    rawDocument.storedFilename,
    `${location}.storedFilename`,
    { pattern: /^doc-[a-z0-9-]+\.[a-z0-9]+$/ },
  );
  if (path.basename(storedFilename) !== storedFilename) {
    throw new Error(`${location}.storedFilename 不允许包含路径`);
  }

  const chunks = rawDocument.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error(`${location}.chunks 必须是非空数组`);
  }
  const preparedChunks = chunks.map((rawChunk, chunkIndex) => {
    const chunkLocation = `${location}.chunks[${chunkIndex}]`;
    if (!rawChunk || typeof rawChunk !== 'object' || Array.isArray(rawChunk)) {
      throw new Error(`${chunkLocation} 必须是对象`);
    }
    return Object.freeze({
      id: validString(rawChunk.id, `${chunkLocation}.id`, {
        pattern: /^doc-[a-z0-9-]+-chunk-\d+$/,
      }),
      text: validString(rawChunk.text, `${chunkLocation}.text`),
    });
  });

  const extension = validString(rawDocument.extension, `${location}.extension`);
  if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.includes(extension)) {
    throw new Error(`${location}.extension 不受支持`);
  }

  return Object.freeze({
    id,
    filename: validString(rawDocument.filename, `${location}.filename`),
    storedFilename,
    extension,
    mediaType: validString(rawDocument.mediaType, `${location}.mediaType`),
    size: validNonNegativeInteger(rawDocument.size, `${location}.size`),
    sha256: validString(rawDocument.sha256, `${location}.sha256`, {
      pattern: /^[a-f0-9]{64}$/,
    }),
    importedAt: validString(rawDocument.importedAt, `${location}.importedAt`),
    textLength: validNonNegativeInteger(
      rawDocument.textLength,
      `${location}.textLength`,
    ),
    chunks: Object.freeze(preparedChunks),
  });
}

function prepareKnowledgeIndex(rawIndex) {
  if (!rawIndex || typeof rawIndex !== 'object' || Array.isArray(rawIndex)) {
    throw new Error('knowledge.json 顶层必须是对象');
  }
  if (rawIndex.version !== 1 || !Array.isArray(rawIndex.documents)) {
    throw new Error('knowledge.json 必须使用 version 1 且包含 documents 数组');
  }
  if (rawIndex.documents.length > KNOWLEDGE_LIMITS.maxDocuments) {
    throw new Error(`knowledge.json 最多包含 ${KNOWLEDGE_LIMITS.maxDocuments} 个文件`);
  }

  const ids = new Set();
  const storedNames = new Set();
  const documents = rawIndex.documents.map((rawDocument, index) => {
    const document = prepareStoredDocument(rawDocument, index);
    if (ids.has(document.id)) {
      throw new Error(`knowledge.json 包含重复文档 ID：${document.id}`);
    }
    if (storedNames.has(document.storedFilename)) {
      throw new Error(`knowledge.json 包含重复存储文件：${document.storedFilename}`);
    }
    ids.add(document.id);
    storedNames.add(document.storedFilename);
    return document;
  });
  const chunkCount = documents.reduce(
    (total, document) => total + document.chunks.length,
    0,
  );
  if (chunkCount > KNOWLEDGE_LIMITS.maxChunks) {
    throw new Error(`knowledge.json 最多包含 ${KNOWLEDGE_LIMITS.maxChunks} 个知识片段`);
  }
  return Object.freeze(documents);
}

function serializableDocuments(documents) {
  return documents.map((document) => ({
    id: document.id,
    filename: document.filename,
    storedFilename: document.storedFilename,
    extension: document.extension,
    mediaType: document.mediaType,
    size: document.size,
    sha256: document.sha256,
    importedAt: document.importedAt,
    textLength: document.textLength,
    chunks: document.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
    })),
  }));
}

function publicDocument(document) {
  return {
    id: document.id,
    filename: document.filename,
    extension: document.extension,
    mediaType: document.mediaType,
    size: document.size,
    importedAt: document.importedAt,
    textLength: document.textLength,
    chunkCount: document.chunks.length,
    preview: document.chunks.map((chunk) => chunk.text).join('\n').slice(0, 500),
  };
}

async function atomicWrite(targetPath, data) {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export class KnowledgeStore {
  constructor({ knowledgePath, filesDirectory, logger }) {
    this.knowledgePath = knowledgePath;
    this.filesDirectory = filesDirectory;
    this.logger = logger;
    this.documents = Object.freeze([]);
    this.revision = null;
    this.loadedAt = null;
    this.mutationQueue = Promise.resolve();
  }

  async start() {
    await mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
    let serialized;
    try {
      serialized = await readFile(this.knowledgePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`无法读取知识库索引：${error.message}`, { cause: error });
      }
      await this.persistDocuments([]);
      this.logger.info({ knowledgePath: this.knowledgePath }, '已创建空知识库');
      return;
    }

    try {
      this.documents = prepareKnowledgeIndex(JSON.parse(serialized));
    } catch (error) {
      throw new Error(`服务启动失败：知识库索引无效：${error.message}`, {
        cause: error,
      });
    }
    this.revision = createHash('sha256').update(serialized).digest('hex');
    this.loadedAt = new Date().toISOString();
    this.logger.info(
      {
        documentCount: this.documents.length,
        chunkCount: this.chunkCount(),
        knowledgeRevision: this.revision.slice(0, 12),
      },
      '已加载持久化知识库',
    );
  }

  chunkCount() {
    return this.documents.reduce(
      (total, document) => total + document.chunks.length,
      0,
    );
  }

  publicSnapshot() {
    return {
      documents: this.documents.map(publicDocument),
      revision: this.revision,
      loadedAt: this.loadedAt,
      documentCount: this.documents.length,
      chunkCount: this.chunkCount(),
      supportedExtensions: [...SUPPORTED_KNOWLEDGE_EXTENSIONS],
      limits: {
        maxFiles: KNOWLEDGE_LIMITS.maxFiles,
        maxFileBytes: KNOWLEDGE_LIMITS.maxFileBytes,
        maxTotalBytes: KNOWLEDGE_LIMITS.maxTotalBytes,
        maxChunks: KNOWLEDGE_LIMITS.maxChunks,
      },
    };
  }

  importedChunks() {
    return this.documents.flatMap((document) => document.chunks);
  }

  findDocument(id) {
    return this.documents.find((document) => document.id === id) ?? null;
  }

  originalPath(document) {
    return path.join(this.filesDirectory, document.storedFilename);
  }

  async originalStat(document) {
    try {
      const result = await stat(this.originalPath(document));
      return result.isFile() ? result : null;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  queueMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async persistDocuments(documents) {
    const index = {
      version: 1,
      updatedAt: new Date().toISOString(),
      documents: serializableDocuments(documents),
    };
    const serialized = `${JSON.stringify(index, null, 2)}\n`;
    await atomicWrite(this.knowledgePath, serialized);
    this.documents = Object.freeze([...documents]);
    this.revision = createHash('sha256').update(serialized).digest('hex');
    this.loadedAt = new Date().toISOString();
  }

  async importFiles(files, mode = 'append') {
    if (!['append', 'replace'].includes(mode)) {
      throw knowledgeError(
        'KNOWLEDGE_INVALID_MODE',
        '导入方式必须是 append 或 replace。',
      );
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw knowledgeError('KNOWLEDGE_FILES_REQUIRED', '请至少选择一个文件。');
    }
    if (files.length > KNOWLEDGE_LIMITS.maxFiles) {
      throw knowledgeError(
        'KNOWLEDGE_TOO_MANY_FILES',
        `每次最多导入 ${KNOWLEDGE_LIMITS.maxFiles} 个文件。`,
        413,
      );
    }

    const totalBytes = files.reduce(
      (total, file) => total + (Buffer.isBuffer(file.buffer) ? file.buffer.length : 0),
      0,
    );
    if (totalBytes > KNOWLEDGE_LIMITS.maxTotalBytes) {
      throw knowledgeError(
        'KNOWLEDGE_TOTAL_TOO_LARGE',
        '本次导入的文件合计超过 30 MB 上限。',
        413,
      );
    }

    const parsedFiles = [];
    for (const file of files) {
      parsedFiles.push(await parseKnowledgeFile(file));
    }

    return this.queueMutation(async () => {
      const existingHashes = new Set(
        mode === 'append' ? this.documents.map((document) => document.sha256) : [],
      );
      const accepted = [];
      const skipped = [];
      for (const parsedFile of parsedFiles) {
        if (existingHashes.has(parsedFile.sha256)) {
          skipped.push({
            filename: parsedFile.filename,
            reason: '文件内容已存在',
          });
          continue;
        }
        existingHashes.add(parsedFile.sha256);
        accepted.push(parsedFile);
      }

      const nextCount =
        (mode === 'append' ? this.documents.length : 0) + accepted.length;
      if (nextCount > KNOWLEDGE_LIMITS.maxDocuments) {
        throw knowledgeError(
          'KNOWLEDGE_DOCUMENT_LIMIT',
          `知识库最多保存 ${KNOWLEDGE_LIMITS.maxDocuments} 个文件。`,
          413,
        );
      }
      const nextChunkCount =
        (mode === 'append' ? this.chunkCount() : 0) +
        accepted.reduce(
          (total, parsedFile) => total + parsedFile.chunkTexts.length,
          0,
        );
      if (nextChunkCount > KNOWLEDGE_LIMITS.maxChunks) {
        throw knowledgeError(
          'KNOWLEDGE_CHUNK_LIMIT',
          `知识库最多保存 ${KNOWLEDGE_LIMITS.maxChunks} 个可检索片段。`,
          413,
        );
      }

      const now = new Date().toISOString();
      const newDocuments = accepted.map((parsedFile) => {
        const id = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
        const storedFilename = `${id}${parsedFile.extension}`;
        return Object.freeze({
          id,
          filename: parsedFile.filename,
          storedFilename,
          extension: parsedFile.extension,
          mediaType: parsedFile.mediaType,
          size: parsedFile.size,
          sha256: parsedFile.sha256,
          importedAt: now,
          textLength: parsedFile.textLength,
          chunks: Object.freeze(
            parsedFile.chunkTexts.map((text, index) =>
              Object.freeze({
                id: `${id}-chunk-${index + 1}`,
                text,
              }),
            ),
          ),
          buffer: parsedFile.buffer,
        });
      });

      const writtenPaths = [];
      try {
        for (const document of newDocuments) {
          const originalPath = this.originalPath(document);
          await atomicWrite(originalPath, document.buffer);
          writtenPaths.push(originalPath);
        }

        const storedNewDocuments = newDocuments.map(({ buffer: _buffer, ...document }) =>
          Object.freeze(document),
        );
        const previousDocuments = this.documents;
        const nextDocuments =
          mode === 'append'
            ? [...previousDocuments, ...storedNewDocuments]
            : storedNewDocuments;

        if (accepted.length > 0 || mode === 'replace') {
          await this.persistDocuments(nextDocuments);
        }

        if (mode === 'replace') {
          const retainedNames = new Set(
            storedNewDocuments.map((document) => document.storedFilename),
          );
          await Promise.all(
            previousDocuments
              .filter((document) => !retainedNames.has(document.storedFilename))
              .map((document) =>
                rm(this.originalPath(document), { force: true }).catch((error) => {
                  this.logger.warn(
                    { err: error, documentId: document.id },
                    '旧知识文件清理失败',
                  );
                }),
              ),
          );
        }

        this.logger.info(
          {
            mode,
            importedCount: storedNewDocuments.length,
            skippedCount: skipped.length,
            documentCount: this.documents.length,
          },
          '外部知识文件已导入并持久化',
        );

        return {
          ...this.publicSnapshot(),
          imported: storedNewDocuments.map(publicDocument),
          skipped,
          mode,
        };
      } catch (error) {
        await Promise.all(
          writtenPaths.map((writtenPath) => rm(writtenPath, { force: true })),
        );
        throw error;
      }
    });
  }

  async deleteDocument(id) {
    return this.queueMutation(async () => {
      const document = this.findDocument(id);
      if (!document) {
        throw knowledgeError(
          'KNOWLEDGE_NOT_FOUND',
          '未找到要删除的知识文件。',
          404,
        );
      }

      await this.persistDocuments(
        this.documents.filter((candidate) => candidate.id !== id),
      );
      await rm(this.originalPath(document), { force: true }).catch((error) => {
        this.logger.warn({ err: error, documentId: id }, '知识原文件清理失败');
      });
      this.logger.info({ documentId: id }, '知识文件已删除');
      return this.publicSnapshot();
    });
  }
}
