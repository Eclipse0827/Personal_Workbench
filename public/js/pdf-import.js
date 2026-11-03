/**
 * PDF 导入：浏览器里用 PDF.js 提取目录和逐页文字。
 * ---------------------------------------------------------------
 * 把解析放在浏览器，服务端就不需要额外的 PDF 依赖；提取出来的文字再交给
 * 本地服务保存和分析。原始 PDF 单独上传一份，供阅读时查看原页。
 */

import { api } from './api.js';

const PDFJS_DIR = '/vendor/pdfjs/';
const MAX_PAGES = 3000;
const MAX_PAGE_CHARS = 120000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

let pdfjsPromise = null;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_DIR}pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_DIR}pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsPromise;
}

function friendlyLoadError(err) {
  const name = err && err.name;
  const msg = (err && err.message) || String(err);
  if (name === 'PasswordException') return new Error('这份 PDF 有密码，先去掉密码再导入。');
  if (name === 'InvalidPDFException' || /Invalid PDF/i.test(msg)) return new Error('这个文件不是有效的 PDF。');
  if (name === 'MissingPDFException') return new Error('读不到这个 PDF 文件。');
  return new Error(`PDF 读取失败：${msg}`);
}

function itemsToText(items) {
  let out = '';
  let lastY = null;
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const y = item.transform ? Number(item.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && out && !out.endsWith('\n')) {
      out += '\n';
    }
    out += item.str;
    if (item.hasEOL && !out.endsWith('\n')) out += '\n';
    lastY = y;
  }
  return out
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function resolveDestinationPage(doc, dest) {
  try {
    let target = dest;
    if (typeof target === 'string') target = await doc.getDestination(target);
    if (!Array.isArray(target) || !target.length) return null;
    const ref = target[0];
    if (ref && typeof ref === 'object') {
      const index = await doc.getPageIndex(ref);
      return index + 1;
    }
    if (typeof ref === 'number' && Number.isFinite(ref)) return Math.round(ref) + 1;
  } catch { /* 书签目标坏了就跳过这一条 */ }
  return null;
}

async function flattenOutline(doc, items, level, out) {
  if (!Array.isArray(items) || level > 4) return;
  for (const item of items) {
    if (out.length >= 500) return;
    const title = String((item && item.title) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (title && item.dest) {
      const page = await resolveDestinationPage(doc, item.dest);
      if (page) out.push({ title, page, level });
    }
    if (item.items && item.items.length) {
      await flattenOutline(doc, item.items, level + 1, out);
    }
  }
}

function suggestTitle(metaTitle, fileName) {
  const fromFile = String(fileName || '').replace(/\.pdf$/i, '').trim().slice(0, 200);
  const fromMeta = String(metaTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (fromMeta && fromMeta.length >= 2 && !/^(untitled|无标题|microsoft word|document\d*)$/i.test(fromMeta)
    && !/^Microsoft Word - /i.test(fromMeta)) {
    return fromMeta;
  }
  return fromFile || '未命名教材';
}

/**
 * 只做提取，不写任何数据。
 * 返回 { pageCount, pages, outlineItems, metaTitle, textChars }。
 */
export async function extractPdf(file, { onProgress } = {}) {
  if (!file) throw new Error('还没有选择文件');
  if (!/\.pdf$/i.test(file.name || '')) throw new Error('请选择一个 PDF 文件');
  if (file.size > MAX_FILE_BYTES) throw new Error('PDF 超过 200MB，先拆分或压缩一下再导入。');

  onProgress && onProgress({ step: 'read', label: '读取 PDF', detail: file.name });
  const pdfjsLib = await loadPdfJs();
  let doc;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: `${PDFJS_DIR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_DIR}standard_fonts/`,
    });
    doc = await task.promise;
  } catch (err) {
    throw friendlyLoadError(err);
  }

  try {
    const pageCount = doc.numPages;
    if (!pageCount) throw new Error('这个 PDF 没有页面');
    if (pageCount > MAX_PAGES) throw new Error(`这本书有 ${pageCount} 页，超过 ${MAX_PAGES} 页的上限`);

    let metaTitle = '';
    try {
      const meta = await doc.getMetadata();
      metaTitle = (meta && meta.info && meta.info.Title) || '';
    } catch { /* 有些 PDF 没有元数据 */ }

    let outlineItems = [];
    try {
      const outline = await doc.getOutline();
      if (outline && outline.length) {
        outlineItems = [];
        await flattenOutline(doc, outline, 0, outlineItems);
      }
    } catch { outlineItems = []; }

    const pages = [];
    let textChars = 0;
    for (let n = 1; n <= pageCount; n += 1) {
      let text = '';
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent({ includeMarkedContent: false });
        text = itemsToText(content.items).slice(0, MAX_PAGE_CHARS);
        page.cleanup();
      } catch {
        text = '';
      }
      if (text) textChars += text.replace(/\s/g, '').length;
      pages.push({ page: n, text });
      onProgress && onProgress({
        step: 'extract',
        label: '提取文字',
        detail: `第 ${n} / ${pageCount} 页`,
        page: n,
        pageCount,
        pct: Math.round((n / pageCount) * 100),
      });
    }

    return {
      pageCount,
      pages,
      outlineItems,
      metaTitle,
      textChars,
      fileName: file.name,
      fileSize: file.size,
    };
  } finally {
    try { await doc.destroy(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/**
 * 完整导入：提取 → 保存文字 → 上传原始 PDF → 分析目录。
 * onProgress 会收到 { step, label, detail, pct? }。
 * 文字层不可读时不去拦导入：服务端会用 Windows OCR 识别目录，正文按节懒识别。
 */
export async function importTextbookFromFile(file, { onProgress } = {}) {
  const extracted = await extractPdf(file, { onProgress });
  const lowText = extracted.textChars < 200;

  onProgress && onProgress({
    step: 'save',
    label: '保存教材文字',
    detail: lowText
      ? '这次几乎没有提取到文字，先保存页码；稍后由本机 OCR 识别'
      : '写入本机 data/textbooks/',
  });
  let imported;
  try {
    imported = await api.importTextbook({
      title: suggestTitle(extracted.metaTitle, extracted.fileName),
      fileName: extracted.fileName,
      fileSize: extracted.fileSize,
      pageCount: extracted.pageCount,
      outlineItems: extracted.outlineItems,
      pages: extracted.pages,
    });
  } catch (err) {
    throw new Error(`教材文字保存失败：${err.message}`);
  }

  const bookId = imported.book.id;
  const warnings = [];

  onProgress && onProgress({ step: 'upload', label: '保存原始 PDF', detail: '之后可以直接看原页' });
  try {
    await api.uploadTextbookFile(bookId, file);
  } catch (err) {
    warnings.push(`原始 PDF 没有保存：${err.message}。讲义和原文仍然可以读，但看不了 PDF 原页。`);
  }

  onProgress && onProgress({
    step: 'analyze',
    label: '整理目录与章节',
    detail: lowText
      ? '文字层不可读，正在准备本机 OCR 识别目录'
      : '正在从目录、书签和正文标题里搭框架',
  });

  let polling = true;
  let pollingBusy = false;
  const timer = setInterval(async () => {
    if (!polling || pollingBusy) return;
    pollingBusy = true;
    try {
      const latest = await api.getTextbook(bookId);
      if (!polling || !latest || latest.status !== 'analyzing') return;
      onProgress && onProgress({
        step: 'analyze',
        label: '整理目录与章节',
        detail: latest.statusMessage || '正在整理…',
        poll: true,
      });
    } catch { /* 轮询失败不影响正式分析请求 */ } finally {
      pollingBusy = false;
    }
  }, 1500);

  try {
    const analyzed = await api.analyzeTextbook(bookId);
    polling = false;
    clearInterval(timer);
    return { book: analyzed.book, warnings, extracted };
  } catch (err) {
    polling = false;
    clearInterval(timer);
    err.bookId = bookId;
    err.stage = 'analyze';
    throw err;
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
