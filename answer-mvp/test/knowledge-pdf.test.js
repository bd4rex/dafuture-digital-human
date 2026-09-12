import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KnowledgeStore, parseKnowledgeFile } from '../knowledge-store.js';
import { buildApp } from '../server.js';

// Small valid PDFs exercise the real parser without external fixtures or OCR.
function pdfWithPages(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, page] of pages.entries()) {
    let stream = '';
    if (page.text !== undefined) {
      const text = page.text.replace(/[()\\]/g, '\\$&');
      stream += `BT\n/F1 12 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
    }
    if (page.image) {
      stream += 'q\n20 0 0 20 72 680 cm\nBI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI\nQ\n';
    }
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

function parsePdf(pages) {
  return parseKnowledgeFile({ filename: '知识资料.pdf', buffer: pdfWithPages(pages) });
}

test('PDF 只导入真实页文字，不加入解析器生成的页码', async () => {
  const result = await parsePdf([{ text: 'The venue is Hall A.' }]);
  assert.equal(result.preview, 'The venue is Hall A.');
  assert.equal(result.textLength, result.preview.length);
  assert.deepEqual(result.chunkTexts, ['The venue is Hall A.']);
});

test('空白、空文本和纯图片 PDF 均提示先 OCR，不把页码当作知识', async (t) => {
  for (const [name, pages] of [
    ['空白页', [{}]],
    ['仅空格文字', [{ text: '   ' }]],
    ['纯图片页', [{ image: true }]],
    ['多页无文字', [{}, { image: true }, { text: '' }]],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(parsePdf(pages), (error) => {
        assert.equal(error.code, 'KNOWLEDGE_NO_TEXT');
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /文字层.*OCR/);
        return true;
      });
    });
  }
});

test('多页混合 PDF 保留各页实际文字和顺序，忽略空白及图片页', async () => {
  const result = await parsePdf([
    { text: 'First page knowledge.' },
    {},
    { image: true },
    { text: 'Last page knowledge.', image: true },
  ]);
  assert.match(result.preview, /^First page knowledge\.[\s\S]*Last page knowledge\.$/);
  assert.doesNotMatch(result.preview, /-- \d+ of \d+ --/);
  assert.equal(result.chunkTexts.length, 1);
});

test('原文恰好包含页码样式时保留，不通过正则误删业务文字', async () => {
  const result = await parsePdf([{ text: '-- 1 of 1 --' }]);
  assert.equal(result.preview, '-- 1 of 1 --');
});

test('无文字或损坏 PDF 的替换导入失败，已有索引与原文件完整保留', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pdf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    knowledgePath: path.join(directory, 'knowledge.json'),
    filesDirectory: path.join(directory, 'files'),
    logger: { info() {}, warn() {} },
  };
  const store = new KnowledgeStore(options);
  await store.start();
  await store.importFiles([{ filename: '原知识.txt', buffer: Buffer.from('测试会场在 A 厅。') }]);
  const indexBefore = await readFile(options.knowledgePath);
  const namesBefore = await readdir(options.filesDirectory);
  const originalBefore = await readFile(store.originalPath(store.documents[0]));
  for (const buffer of [pdfWithPages([{}]), pdfWithPages([{ image: true }]), Buffer.from('%PDF-1.4\nbroken')]) {
    await assert.rejects(store.importFiles([
      { filename: '新知识.txt', buffer: Buffer.from('这份文件也不能部分导入。') },
      { filename: '不可提取.pdf', buffer },
    ], 'replace'), (error) => {
      assert.ok(['KNOWLEDGE_NO_TEXT', 'KNOWLEDGE_INVALID_PDF'].includes(error.code));
      return true;
    });
    assert.deepEqual(await readFile(options.knowledgePath), indexBefore);
    assert.deepEqual(await readdir(options.filesDirectory), namesBefore);
    assert.deepEqual(await readFile(store.originalPath(store.documents[0])), originalBefore);
    assert.equal(store.documents.length, 1);
    const reloaded = new KnowledgeStore(options);
    await reloaded.start();
    assert.equal(reloaded.importedChunks()[0].text, '测试会场在 A 厅。');
  }
});

test('真实 HTTP 上传图片 PDF 返回 OCR 提示和 400，替换请求不影响现有知识', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pdf-http-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const knowledgePath = path.join(directory, 'knowledge.json');
  const filesDirectory = path.join(directory, 'files');
  app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model.json'),
    knowledgePath, knowledgeFilesDirectory: filesDirectory,
    adminAuthPath: path.join(directory, 'admin.json'),
    liveControlPath: path.join(directory, 'host.json'),
    opsLogPath: path.join(directory, 'ops.jsonl'),
    bundledKnowledgeEnabled: false, adminPassword: 'isolated-pdf-password', adminApiKey: '',
    logger: false, llmFetch: async () => { throw new Error('文件上传不应调用模型'); },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'isolated-pdf-password' }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(login.status, 200); await login.arrayBuffer();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function upload(filename, bytes, mode) {
    const form = new FormData();
    form.append('mode', mode);
    form.append('files', new Blob([bytes]), filename);
    return fetch(`${origin}/api/knowledge/import`, {
      method: 'POST', headers: { cookie }, body: form, signal: AbortSignal.timeout(10_000),
    });
  }
  const initial = await upload('有效资料.pdf', pdfWithPages([{ text: 'Confirmed venue: Hall A.' }]), 'append');
  assert.equal(initial.status, 200);
  const document = (await initial.json()).documents[0];
  const indexBefore = await readFile(knowledgePath);
  const filesBefore = await readdir(filesDirectory);
  const rejected = await upload('扫描件.pdf', pdfWithPages([{ image: true }]), 'replace');
  assert.equal(rejected.status, 400);
  const failure = await rejected.json();
  assert.equal(failure.error, 'KNOWLEDGE_NO_TEXT');
  assert.match(failure.message, /文字层.*OCR/);
  assert.deepEqual(await readFile(knowledgePath), indexBefore);
  assert.deepEqual(await readdir(filesDirectory), filesBefore);
  assert.equal(app.knowledgeStore.findDocument(document.id).chunks[0].text, 'Confirmed venue: Hall A.');
});
