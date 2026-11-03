/**
 * 本机 OCR（Windows.Media.Ocr）
 * ---------------------------------------------------------------
 * 用系统自带的 Windows OCR 识别 PDF 页面，不联网、不需要额外安装。
 * 渲染由 Windows.Data.Pdf 完成，因此服务端不用引入 PDF 依赖。
 *
 * 只负责“把页面变成文字和坐标”。目录怎么理解、正文怎么用，交给上层。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'ocr.ps1');
const MAX_BATCH_PAGES = 40;
const DEFAULT_TIMEOUT = 150000;

let availabilityPromise = null;
let queue = Promise.resolve();

function runPowerShell(args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message || '').trim().slice(0, 1200);
          const wrapped = new Error(detail || '本机 OCR 没有启动');
          wrapped.code = err.killed ? 'OCR_TIMEOUT' : 'OCR_FAILED';
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function getAvailability() {
  if (!availabilityPromise) {
    availabilityPromise = (async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'study-ocr-lang-'));
      const outFile = path.join(dir, 'languages.json');
      try {
        await runPowerShell(['-ListLanguages', '-OutJson', outFile], { timeout: 30000 });
        const data = await readJson(outFile);
        const languages = Array.isArray(data.languages) ? data.languages : [];
        return {
          available: languages.includes('zh-Hans-CN'),
          languages,
          engine: 'windows-ocr',
          reason: languages.includes('zh-Hans-CN')
            ? ''
            : '系统没有安装中文 OCR 语言包（设置 → 时间和语言 → 语言和区域 → 中文 → 语言选项 → 可选功能里添加“光学字符识别”）。',
        };
      } catch (err) {
        return {
          available: false,
          languages: [],
          engine: 'windows-ocr',
          reason: `本机 OCR 不可用：${err.message}`,
        };
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  }
  return availabilityPromise;
}

function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

/**
 * 渲染并识别指定的 PDF 页面（1 起始）。
 * 返回 ocr.ps1 的原始结构，附带 page result。
 */
async function runPages({ pdfPath, pages, width = 1800, languages, column = false, timeout = DEFAULT_TIMEOUT }) {
  const list = [...new Set((pages || []).map((n) => Math.round(Number(n))).filter((n) => n >= 1))]
    .sort((a, b) => a - b)
    .slice(0, MAX_BATCH_PAGES);
  if (!list.length) throw Object.assign(new Error('没有要识别的页码'), { code: 'OCR_BAD_PAGES' });
  const absolutePdf = pdfPath ? path.resolve(pdfPath) : '';
  if (!absolutePdf || !fs.existsSync(absolutePdf)) {
    throw Object.assign(new Error('原始 PDF 不在本机，无法做 OCR'), { code: 'OCR_NO_PDF' });
  }
  const availability = await getAvailability();
  if (!availability.available) {
    throw Object.assign(new Error(availability.reason || '本机 OCR 不可用'), { code: 'OCR_UNAVAILABLE' });
  }

  return enqueue(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'study-ocr-'));
    const outFile = path.join(dir, 'result.json');
    const langs = (languages && languages.length ? languages : ['zh-Hans-CN', 'en-US']).join(',');
    try {
      const args = [
        '-PdfPath', absolutePdf,
        '-OutJson', outFile,
        '-Pages', list.join(','),
        '-Width', String(Math.max(800, Math.min(3200, Math.round(width)))),
        '-Languages', langs,
      ];
      if (column) args.push('-ColumnPass');
      await runPowerShell(args, { timeout });
      const data = await readJson(outFile);
      if (!data || !Array.isArray(data.pages)) throw new Error('本机 OCR 没有返回页面结果');
      const okPages = data.pages.filter((p) => p && !p.error);
      if (!okPages.length) {
        const firstError = data.pages.find((p) => p && p.error);
        throw new Error(firstError ? firstError.error : '本机 OCR 没有识别出任何页面');
      }
      return data;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

function collapseCjkSpaces(input) {
  let s = String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  s = s.replace(/([（(【\[])\s+/g, '$1').replace(/\s+([）)】\]])/g, '$1');
  s = s.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1');
  s = s.replace(/([^\x00-\x7F])\s+(?=[0-9A-Za-z§])/g, '$1');
  s = s.replace(/([0-9A-Za-z§])\s+(?=[^\x00-\x7F])/g, '$1');
  s = s.replace(/§\s+/g, '§');
  s = s.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  return s.trim();
}

function pageLines(page, passName = 'zh-Hans-CN') {
  const pass = page && page.passes && page.passes[passName];
  const lines = pass && Array.isArray(pass.lines) ? pass.lines : [];
  return lines
    .filter((line) => line && String(line.text || '').trim())
    .slice()
    .sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0));
}

/** 把 OCR 的一页压成可读正文；保留换行，去掉中文间多余空格。 */
function pageText(page, { passName = 'zh-Hans-CN' } = {}) {
  const lines = pageLines(page, passName);
  const out = [];
  for (const line of lines) {
    const text = collapseCjkSpaces(line.text);
    if (!text) continue;
    if (/^[\s.·…\-—_]+$/.test(text)) continue;
    out.push(text);
  }
  return out.join('\n').trim();
}

function isLikelyGarbled(text) {
  const s = String(text || '');
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 40) return false;
  const han = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  const hanRatio = han / compact.length;
  const latinRatio = (letters + digits) / compact.length;
  const symbolRuns = (s.match(/[!-/:-@[-`{-~]{2,}/g) || []).join('').length;
  const symbolRatio = symbolRuns / compact.length;
  const latinWords = (s.match(/[A-Za-z]{2,}/g) || []).length;
  const avgWord = latinWords ? letters / latinWords : 0;

  if (han >= 25 && hanRatio >= 0.08) return false;
  if (letters >= 120 && avgWord >= 2.5 && avgWord <= 12 && latinRatio >= 0.45 && symbolRatio < 0.2) return false;
  if (han < 8 && letters < 40) return symbolRatio > 0.15 || hanRatio < 0.02;
  return symbolRatio > 0.22 || (han < 12 && latinRatio < 0.25);
}

function readableTextScore(text) {
  const s = String(text || '');
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 20) return { score: 0, chars: compact.length };
  let score = 0;
  if (isLikelyGarbled(s)) score -= 2;
  const han = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (han >= 25) score += 2;
  else if (han >= 8) score += 1;
  if (letters >= 80) score += 1;
  const lines = s.split(/\n+/).filter((l) => l.trim().length >= 4).length;
  if (lines >= 2) score += 1;
  return { score, chars: compact.length };
}

/** 判断一本书的整体文字层质量。 */
function assessTextQuality(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const substantive = list.filter((p) => String((p && p.text) || '').replace(/\s/g, '').length >= 80);
  const totalChars = list.reduce((n, p) => n + String((p && p.text) || '').replace(/\s/g, '').length, 0);
  if (!list.length || totalChars < 120) {
    return { quality: 'empty', totalChars, sampled: 0, readable: 0, reason: '没有可用的文字层' };
  }
  const sample = substantive.slice(0, 60);
  let readable = 0;
  for (const p of sample) {
    if (!isLikelyGarbled(p.text) && readableTextScore(p.text).score >= 2) readable += 1;
  }
  const ratio = sample.length ? readable / sample.length : 0;
  if (ratio >= 0.7) return { quality: 'ok', totalChars, sampled: sample.length, readable, reason: '' };
  if (ratio <= 0.2) return { quality: 'garbled', totalChars, sampled: sample.length, readable, reason: '文字层看起来是乱码' };
  return { quality: 'mixed', totalChars, sampled: sample.length, readable, reason: '部分页面没有可用文字' };
}

module.exports = {
  getAvailability,
  runPages,
  pageText,
  pageLines,
  collapseCjkSpaces,
  isLikelyGarbled,
  assessTextQuality,
  MAX_BATCH_PAGES,
};
