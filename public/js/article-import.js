/**
 * 外刊导入：在本机读取文件文字，再把文字交给服务端保存。
 *
 * 只做文字层提取，不做 OCR。扫描版 PDF 提取不到文字时明确报错，
 * 不假装导入成功，也不把空文件塞进书架。
 */

import { extractPdf } from './pdf-import.js';

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const TEXT_FILE = /\.(txt|md|markdown|text)$/i;
const MAX_CHARS = 300000;

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

/** 读取一个文件，返回 { text, format, fileName, title, warnings }。不写任何数据。 */
export async function prepareArticleFile(file, { onProgress } = {}) {
  if (!file) throw failure('还没有选择文件', 'no-file');
  if (file.size > MAX_IMPORT_BYTES) {
    throw failure('文件超过 4MB。外刊一般不会这么大，先确认选对了文件。', 'too-large');
  }

  const fileName = file.name || '未命名文章';

  if (/\.pdf$/i.test(fileName)) {
    const extracted = await extractPdf(file, { onProgress });
    const text = extracted.pages
      .map((page) => page.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!text || extracted.textChars < 20) {
      throw failure(
        '这份 PDF 没有可提取的文字层，很可能是扫描件。这一版暂时不做 OCR，请换一份带文字层的 PDF，或者把文字复制出来粘贴导入。',
        'pdf-no-text'
      );
    }
    if (text.length > MAX_CHARS) {
      throw failure(`提取出 ${text.length} 个字符，超过单篇 ${MAX_CHARS} 字符的上限。先拆分一下。`, 'too-large');
    }
    return {
      text,
      format: 'pdf',
      fileName,
      title: String(extracted.metaTitle || '').trim() || fileName.replace(/\.pdf$/i, '').trim(),
      warnings: extracted.textChars < 200
        ? ['这份 PDF 的文字层很薄，可能有内容在图片里。本模块不做 OCR，图片里的文字读不到。']
        : [],
      meta: { pageCount: extracted.pageCount },
    };
  }

  if (!TEXT_FILE.test(fileName)) {
    throw failure('目前支持 .txt、.md 和带文字层的 .pdf。扫描版 PDF 需要 OCR，这一版还没有。', 'unsupported');
  }

  const raw = await file.text();
  if (raw.includes('\uFFFD')) {
    throw failure('这个文件不是 UTF-8 文字，读取后出现了乱码。请用编辑器另存为 UTF-8 后再导入。', 'encoding');
  }
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) throw failure('这个文件里没有文字。', 'empty');
  if (text.length > MAX_CHARS) {
    throw failure(`文件有 ${text.length} 个字符，超过单篇 ${MAX_CHARS} 字符的上限。先拆分一下。`, 'too-large');
  }

  return {
    text,
    format: /\.(md|markdown)$/i.test(fileName) ? 'md' : 'plain',
    fileName,
    title: fileName.replace(/\.[^.]+$/, '').trim(),
    warnings: [],
  };
}

/** 把段落还原成可编辑的文本，替换正文前让用户看到自己改的是什么。 */
export function textFromParagraphs(paragraphs = []) {
  return (paragraphs || [])
    .map((p) => {
      if (p.kind === 'heading') return `${'#'.repeat(Math.min(6, p.level || 1))} ${p.text}`;
      if (p.kind === 'quote') return `> ${p.text}`;
      if (p.kind === 'list') return `- ${p.text}`;
      if (p.kind === 'code') return `\`\`\`\n${p.text}\n\`\`\``;
      return p.text;
    })
    .join('\n\n');
}
