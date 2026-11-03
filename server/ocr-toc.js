/**
 * 从 OCR 结果里还原目录结构。
 * ---------------------------------------------------------------
 * Windows OCR 会漏掉小字号页码、把“章”认成“早”、把 § 弄丢，
 * 所以这里不依赖某一种字形，而是结合：
 *   - 中文标题行的阅读顺序；
 *   - 左侧的小节序号列；
 *   - 右侧页码列（单独的裁剪 OCR pass，顺序稳定）；
 *   - 正文前几页里出现的节标题（把目录页码换算成 PDF 页序）。
 * 宁可标“估算”，也不假装页码是精确的。
 */

const { pageLines, pageText, collapseCjkSpaces } = require('./ocr');

const CHAPTER_RE = /^第?([一二三四五六七八九十百千零〇两\d]{1,4})[章篇部]/;
const CHAPTER_MARK_RE = /^(?:第[一二三四五六七八九十百千零〇两\d]{1,4}[章篇部]?|[早章])$/;
const SECTION_NUMBER_RE = /^[§S$s]?\s*(\d{1,2})(?:[.．]\s*(\d{1,2})){1,2}/;
const PAGE_NOISE_RE = /^(?:目录|目\s*录|contents?|参考答案)$/i;

// 只有真正出现在题干/答案里的说法才算习题页；“参考答案”四个字本身
// 常出现在目录页的页眉或书末条目里，不能据此误杀目录。
const EXERCISE_MARK_RE = /本题|故选|选项\s*[A-DＡ-Ｄ]|〖\s*答\s*案\s*〗|〖\s*解\s*析\s*〗|综上所?述|答案\s*[:：]|解析\s*[:：]|配套习题|习题和解析|填空题|选择题|判断题|简答题|计算题/g;
// 单位、频段、选项这类纯符号标题，通常来自表格，而不是目录条目。
const TABLE_TITLE_RE = /^[A-Za-z0-9\s、，,.．:：\-~～—/\\()（）[\]【】]+$/;

function parseCnNumber(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
  if (s.length === 1 && digits[s] !== undefined) return digits[s];
  return null;
}

function cleanTitle(raw) {
  let t = collapseCjkSpaces(raw);
  t = t.replace(/^[·•.\s]+/, '').replace(/[.·…\s]{3,}\d{1,4}\s*$/, '');
  t = t.replace(/\s+\d{1,4}\s*$/, '');
  t = t.replace(/[.·…]{2,}/g, ' ');
  t = t.replace(/^([§S$s])\s*(?=\d)/, '§');
  t = t.replace(/^§?\s*(\d{1,2})\s*[.．]\s*(\d{1,2})(?=\D)/, '§$1.$2 ');
  t = t.replace(/^(第[一二三四五六七八九十百千零〇两\d]+[章篇部节])(?=\S)/, '$1 ');
  // Windows OCR 在目录字号下常把“入”认成“人”；“人门”不是常用词
  t = t.replace(/人门/g, '入门');
  return t.replace(/\s+/g, ' ').trim();
}

function stripChapterMarker(title) {
  return String(title || '')
    .replace(/^第[一二三四五六七八九十百千零〇两\d]+[章篇部]\s*/, '')
    .replace(/^[早章]\s*/, '')
    .trim();
}

function stripSectionMarker(title) {
  return String(title || '')
    .replace(/^[§S$s]?\s*\d{1,2}(?:[.．]\d{1,3}){1,2}\s*/, '')
    .replace(/^第[一二三四五六七八九十百千零〇两\d]+节\s*/, '')
    .trim();
}

function isNoiseTitle(text, width, height, y) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (PAGE_NOISE_RE.test(t)) return true;
  if (/《.*》/.test(t)) return true;
  if (/参考答案|习题解析|目录|contents/i.test(t) && t.length < 30) return true;
  if (y < height * 0.06 || y > height * 0.95) return true;
  if (width && t.length <= 2 && !/[A-Za-z]/.test(t)) return true;
  if (!/[\u3400-\u9fffA-Za-z]/.test(t)) return true;
  if (/[。！？；]/.test(t) && t.length > 26) return true;
  return false;
}

function numericCandidates(page, pageCount) {
  const width = Number(page.width) || 0;
  const height = Number(page.height) || 0;
  const out = [];

  const push = (value, y, x, source) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1) return;
    if (n > pageCount + 80) return;
    if (!width || x < width * 0.62) return;
    if (y < height * 0.05 || y > height * 0.97) return;
    out.push({ value: n, y: Number(y) || 0, x: Number(x) || 0, source, page: page.page });
  };

  for (const line of pageLines(page, 'numbers')) {
    const m = collapseCjkSpaces(line.text).match(/\d{1,4}/);
    if (m) push(m[0], line.y, line.x, 'numbers');
  }
  for (const line of pageLines(page, 'en-US')) {
    const text = collapseCjkSpaces(line.text);
    const matches = [...text.matchAll(/\d{1,4}/g)];
    for (const m of matches) push(m[0], line.y, line.x + (line.w || 0) * 0.6, 'en');
  }
  for (const line of pageLines(page, 'zh-Hans-CN')) {
    const text = collapseCjkSpaces(line.text);
    const m = text.match(/(\d{1,4})\s*$/);
    if (!m) continue;
    if (line.x < width * 0.68) continue;
    push(m[1], line.y, line.x, 'zh');
  }

  out.sort((a, b) => a.y - b.y || a.x - b.x);
  const deduped = [];
  for (const item of out) {
    const dup = deduped.find((x) => x.value === item.value && Math.abs(x.y - item.y) < Math.max(36, height * 0.012));
    if (dup) {
      if (dup.source !== 'numbers' && item.source === 'numbers') {
        dup.source = item.source;
        dup.y = item.y;
        dup.x = item.x;
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped;
}

function findMarker(lines, width, y, radius) {
  return lines.find((line) => {
    const text = collapseCjkSpaces(line.text);
    return line.x < width * 0.32
      && Math.abs((Number(line.y) || 0) - y) <= radius
      && CHAPTER_MARK_RE.test(text);
  }) || null;
}

function findOrdinal(lines, width, y, radius) {
  return lines.find((line) => {
    const text = collapseCjkSpaces(line.text);
    // 有些目录把“3.1”单独排在小节序号列里，标题行本身没有编号
    if (!/^(?:\d{1,2}[.．])?\d{1,2}$/.test(text)) return false;
    if (line.x < width * 0.13 || line.x > width * 0.40) return false;
    return Math.abs((Number(line.y) || 0) - y) <= radius;
  }) || null;
}

function ordinalNumber(text) {
  const m = collapseCjkSpaces(text).match(/^(?:\d{1,2}[.．])?(\d{1,2})$/);
  return m ? Number(m[1]) : null;
}

function parseTocPage(page, { pageCount }) {
  const width = Number(page.width) || 0;
  const height = Number(page.height) || 0;
  const lines = pageLines(page, 'zh-Hans-CN');
  const radius = Math.max(48, height * 0.018);
  const candidates = [];

  for (const line of lines) {
    const raw = collapseCjkSpaces(line.text);
    if (!raw) continue;
    if (isNoiseTitle(raw, width, height, Number(line.y) || 0)) continue;
    if (line.x < width * 0.18) continue;
    if (/^\d{1,4}$/.test(raw)) continue;
    if (/^(?:[§S$s]\s*)?\d{1,2}(?:[.．]\s*\d{1,2}){1,2}$/.test(raw)) continue;

    const title = cleanTitle(raw);
    if (!title || title.length < 2) continue;

    const marker = findMarker(lines, width, line.y, radius);
    const ordinal = marker ? null : findOrdinal(lines, width, line.y, radius);
    const chapterMatch = title.match(CHAPTER_RE);
    const sectionMatch = title.match(SECTION_NUMBER_RE);
    const isChapter = Boolean(marker || (chapterMatch && !sectionMatch));

    candidates.push({
      y: Number(line.y) || 0,
      x: Number(line.x) || 0,
      lineHeight: Number(line.h) || 0,
      rawTitle: title,
      isChapter,
      ordinal: ordinal ? ordinalNumber(ordinal.text) : null,
      sectionNumber: sectionMatch ? Number(sectionMatch[2]) : null,
      chapterNumber: chapterMatch ? parseCnNumber(chapterMatch[1]) : null,
    });
  }

  // Windows OCR 对目录这种带编号列的版面不保证按阅读顺序返回，按纵坐标重排
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  // 没有章标记、也没有序号的行只有在行距明显更大时才可能是章标题
  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    if (item.isChapter || item.ordinal || item.sectionNumber) continue;
    const prev = candidates[i - 1];
    const gap = prev ? item.y - prev.y : 0;
    if (!prev || gap < 160 * 1.55) {
      candidates.splice(i, 1);
      i -= 1;
    }
  }

  return { entries: candidates, numbers: numericCandidates(page, pageCount), width, height };
}

function countExerciseMarks(page) {
  const text = pageText(page);
  return (text.match(EXERCISE_MARK_RE) || []).length;
}

/** 同一纵坐标上的条目数。真正的目录一行只放一个标题，表格却会被拆成多列。 */
function rowStats(entries) {
  const rows = [];
  for (const entry of entries) {
    const tolerance = Math.max(18, (Number(entry.lineHeight) || 40) * 0.6);
    const row = rows.find((r) => Math.abs(r.y - entry.y) <= tolerance);
    if (row) row.count += 1;
    else rows.push({ y: entry.y, count: 1 });
  }
  const multi = rows.reduce((n, r) => n + (r.count > 1 ? r.count : 0), 0);
  return { rows: rows.length, multi };
}

/** 有多少条目录条目能在同一行右侧找到页码。 */
function matchedNumberCount(parsed) {
  const used = new Set();
  let count = 0;
  for (const entry of parsed.entries) {
    const tolerance = Math.max(28, (Number(entry.lineHeight) || 40) * 1.8);
    let best = null;
    parsed.numbers.forEach((num, index) => {
      if (used.has(index)) return;
      const dy = Math.abs(num.y - entry.y);
      if (dy <= tolerance && (!best || dy < best.dy)) best = { index, dy };
    });
    if (best) {
      used.add(best.index);
      count += 1;
    }
  }
  return count;
}

function titleLooksTabular(rawTitle) {
  const compact = String(rawTitle || '').replace(/\s+/g, '');
  if (!compact) return true;
  return TABLE_TITLE_RE.test(compact) && compact.length <= 18;
}

/**
 * 判断一页是否真的像目录。
 * 习题页、答案页常常也有一列数字和编号，单靠“有编号 + 有页码”会误判，
 * 因此同时检查同一行是否拆成多列、编号是否重复或倒退、标题是否像表格。
 */
function evaluateTocPage(page, parsed, { hasTocWord = false } = {}) {
  const entries = parsed.entries || [];
  const chapterEntries = entries.filter((e) => e.isChapter);
  const sectionEntries = entries.filter((e) => !e.isChapter);
  const ordinals = sectionEntries.filter((e) => e.ordinal != null).map((e) => e.ordinal);
  const distinctOrdinals = new Set(ordinals);
  const row = rowStats(entries);
  const matched = matchedNumberCount(parsed);
  const marks = countExerciseMarks(page);
  const tabularTitles = entries.filter((e) => titleLooksTabular(e.rawTitle)).length;
  const punctuationTitles = entries.filter((e) => /[，、;；]/.test(e.rawTitle)).length;
  const bracketTitles = entries.filter((e) => /[（(]/.test(e.rawTitle)).length;
  const longTitles = entries.filter((e) => e.rawTitle.replace(/\s+/g, '').length > 22).length;
  const sentenceTitles = entries.filter((e) => /[。；]/.test(e.rawTitle)).length;
  const reasons = [];

  if (entries.length < 2) reasons.push('条目太少');
  if (marks >= 2) reasons.push('看起来是习题或答案页');
  if (entries.length && row.multi / entries.length > 0.35) reasons.push('同一行被拆成多列');
  if (bracketTitles / entries.length > 0.35) reasons.push('标题里大量括号，像习题正文');
  if (longTitles / entries.length > 0.4) reasons.push('标题太长，像正文句子');
  if (sentenceTitles / entries.length > 0.15) reasons.push('标题以句号或分号结尾');

  // 即使有章标题，大量小节共用同一个编号也说明这不是目录，而是题干边上的题号。
  if (!hasTocWord && chapterEntries.length < 2
    && ordinals.length >= 6 && distinctOrdinals.size / ordinals.length < 0.5) {
    reasons.push('小节编号大量重复');
  }

  if (!hasTocWord && !chapterEntries.length) {
    if (ordinals.length < 3) reasons.push('缺少连续的小节编号');
    if (ordinals.length !== distinctOrdinals.size) reasons.push('小节编号大量重复');
    const ordered = sectionEntries.map((e) => e.ordinal).filter((n) => n != null);
    if (ordered.some((n, i) => i > 0 && n < ordered[i - 1])) reasons.push('小节编号倒退');
    if (matched < 2) reasons.push('没有可对应的页码列');
    if (punctuationTitles / entries.length > 0.2) reasons.push('标题带表格式标点');
    if (tabularTitles / entries.length > 0.3) reasons.push('标题像表格里的数据');
    if (distinctOrdinals.size >= 3) {
      const span = Math.max(...distinctOrdinals) - Math.min(...distinctOrdinals);
      if (span > distinctOrdinals.size * 3 + 2) reasons.push('小节编号跨度异常');
    }
  }

  const strong = hasTocWord
    || (chapterEntries.length >= 1 && (matched >= 2 || entries.length >= 8))
    || (!chapterEntries.length && distinctOrdinals.size >= 3 && matched >= 2);

  return {
    accept: entries.length >= 3 && strong && !reasons.length,
    strong,
    reasons,
    metrics: {
      entries: entries.length,
      chapters: chapterEntries.length,
      ordinals: ordinals.length,
      matched,
      exerciseMarks: marks,
      multiRow: row.multi,
      tabularTitles,
    },
  };
}

function detectTocPages(pages, { pageCount }) {
  const found = [];
  for (const page of pages) {
    const parsed = parseTocPage(page, { pageCount });
    const hasTocWord = pageLines(page, 'zh-Hans-CN').some((l) => /目\s*录|contents/i.test(collapseCjkSpaces(l.text)));
    const verdict = evaluateTocPage(page, parsed, { hasTocWord });
    if (!verdict.accept) continue;
    const score = parsed.entries.length
      + verdict.metrics.matched
      + verdict.metrics.chapters * 2
      + (hasTocWord ? 15 : 0);
    found.push({ page: page.page, parsed, score, hasTocWord, metrics: verdict.metrics });
  }
  if (!found.length) return { pages: [], parsed: [] };

  // 目录页通常连续。先把相邻页分成若干组，再选证据最强的一组，
  // 避免前面某张带编号的练习页把真正的目录挤掉。
  const ordered = found.sort((a, b) => a.page - b.page);
  const runs = [];
  for (const item of ordered) {
    const run = runs[runs.length - 1];
    if (run && item.page - run[run.length - 1].page <= 3) run.push(item);
    else runs.push([item]);
  }
  const ranked = runs.map((run) => ({
    run,
    score: run.reduce((sum, x) => sum + x.score, 0) + (run.some((x) => x.hasTocWord) ? 10 : 0),
  })).sort((a, b) => b.score - a.score || a.run[0].page - b.run[0].page);
  const kept = ranked[0].run;
  return { pages: kept.map((x) => x.page), parsed: kept };
}

function sectionGrams(title) {
  const clean = stripSectionMarker(title).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  const grams = [];
  for (let i = 0; i + 1 < clean.length; i += 1) grams.push(clean.slice(i, i + 2));
  return { clean, grams };
}

function matchBodySections(bodyPages, chapters) {
  const entries = [];
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      const { clean, grams } = sectionGrams(section.rawTitle);
      if (clean.length < 4 || grams.length < 2) continue;
      entries.push({ section, clean, grams });
    }
  }
  const matches = [];
  for (const page of bodyPages) {
    if (!entries.length) break;
    const text = pageText(page).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
    if (!text) continue;
    const head = text.slice(0, Math.max(1600, text.length * 0.4));
    const lines = pageLines(page, 'zh-Hans-CN')
      .map((l) => ({ raw: collapseCjkSpaces(l.text), clean: collapseCjkSpaces(l.text).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '') }))
      .filter((l) => l.clean.length >= 3);
    for (const entry of entries) {
      if (entry.section.pdfPage) continue;
      let hit = 0;
      for (const gram of entry.grams) if (head.includes(gram)) hit += 1;
      const coverage = entry.grams.length ? hit / entry.grams.length : 0;
      const lengthOk = entry.clean.length >= 6 ? coverage >= 0.6 : coverage >= 0.68;
      if (lengthOk && hit >= Math.min(3, entry.grams.length)) {
        entry.section.pdfPage = page.page;
        entry.section.matchCoverage = coverage;
        // OCR 可能把标题里的一个字认错（如“入门”认成“人门”），
        // 正文里同一行通常是清楚的，拿来修正目录标题。
        let bestLine = null;
        let bestHits = 0;
        for (const line of lines) {
          if (line.clean.length > 40 || line.clean.length < 4) continue;
          if (Math.abs(line.clean.length - entry.clean.length) > 4) continue;
          let hits = 0;
          for (const gram of entry.grams) if (line.clean.includes(gram)) hits += 1;
          if (hits > bestHits) { bestHits = hits; bestLine = line; }
        }
        if (bestLine && bestHits >= hit) entry.section.bodyTitle = stripSectionMarker(cleanTitle(bestLine.raw));
        matches.push({
          title: entry.section.rawTitle,
          page: page.page,
          coverage,
          correctedTitle: entry.section.bodyTitle || null,
        });
      }
    }
  }
  return matches;
}

function assignPrintedPages(chapters, numbers) {
  const flat = chapters.flatMap((c) => c.sections);
  const used = new Set();
  for (const section of flat) {
    if (!section.tocPage || section.tocY == null) continue;
    const candidates = numbers.filter((n) =>
      n.page === section.tocPage && !used.has(`${n.page}:${n.value}:${n.y}`));
    if (!candidates.length) continue;
    let best = null;
    for (const n of candidates) {
      const dy = Math.abs(n.y - section.tocY);
      if (!best || dy < best.dy) best = { n, dy };
    }
    const rowTolerance = Math.max(28, (section.tocLineHeight || 40) * 1.8);
    if (best && best.dy <= rowTolerance) {
      section.printedPage = best.n.value;
      section.printedSource = best.n.source;
      used.add(`${best.n.page}:${best.n.value}:${best.n.y}`);
    }
  }
}

function chooseOffset(chapters, matches, lastTocPage, pageCount) {
  const votes = [];
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      if (section.pdfPage && section.printedPage != null) {
        const diff = section.pdfPage - section.printedPage;
        if (diff >= 0 && diff <= 80) votes.push({ diff, weight: 2, source: 'body' });
      }
    }
  }
  // 正文第一页出现在目录之后；第一节通常从印刷第 1 页开始
  let firstMatch = null;
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      if (section.pdfPage && !firstMatch) firstMatch = section;
    }
  }
  if (firstMatch) votes.push({ diff: firstMatch.pdfPage - 1, weight: 1, source: 'first-body' });
  if (lastTocPage) votes.push({ diff: lastTocPage, weight: 1, source: 'after-toc' });

  if (!votes.length) return { offset: Math.max(1, lastTocPage || 0), source: 'fallback' };
  const counts = new Map();
  for (const vote of votes) {
    const item = counts.get(vote.diff) || { diff: vote.diff, weight: 0, sources: new Set() };
    item.weight += vote.weight;
    item.sources.add(vote.source);
    counts.set(vote.diff, item);
  }
  const ranked = [...counts.values()].sort((a, b) =>
    b.weight - a.weight || (b.sources.has('body') ? 1 : 0) - (a.sources.has('body') ? 1 : 0) || a.diff - b.diff);
  return { offset: ranked[0].diff, source: ranked[0].sources.has('body') ? 'body' : 'after-toc' };
}

function parseToc(pages, { pageCount }) {
  const detected = detectTocPages(pages, { pageCount });
  if (!detected.parsed.length) {
    return { ok: false, reason: '没有识别到目录页', tocPages: [], chapters: [], offset: null, note: '' };
  }

  const chapters = [];
  let current = null;
  let chapterCounter = 0;
  for (const item of detected.parsed) {
    for (const entry of item.parsed.entries) {
      if (entry.isChapter) {
        chapterCounter += 1;
        const number = entry.chapterNumber || chapterCounter;
        const title = stripChapterMarker(entry.rawTitle);
        current = {
          number,
          rawTitle: title || entry.rawTitle,
          chapterTitle: title ? `第 ${number} 章 ${title}` : `第 ${number} 章`,
          sections: [],
          tocPage: item.page,
        };
        chapters.push(current);
        continue;
      }
      if (!current) {
        chapterCounter += 1;
        current = {
          number: chapterCounter,
          rawTitle: '开头',
          chapterTitle: `第 ${chapterCounter} 章 开头`,
          sections: [],
          tocPage: item.page,
        };
        chapters.push(current);
      }
      const sectionNumber = entry.ordinal
        || entry.sectionNumber
        || current.sections.length + 1;
      const title = stripSectionMarker(entry.rawTitle);
      if (!title) continue;
      current.sections.push({
        number: sectionNumber,
        rawTitle: title,
        sectionTitle: `§${current.number}.${sectionNumber} ${title}`,
        printedPage: null,
        pdfPage: null,
        estimated: false,
        tocPage: item.page,
        tocY: entry.y,
        tocLineHeight: entry.lineHeight,
      });
    }
  }

  const chaptersWithSections = chapters.filter((c) => c.sections.length);
  if (!chaptersWithSections.length) {
    return { ok: false, reason: '目录页没有可用的章节条目', tocPages: detected.pages, chapters: [], offset: null, note: '' };
  }

  const flatTitles = chaptersWithSections.flatMap((c) => c.sections.map((s) => s.rawTitle));
  if (flatTitles.length < 2) {
    return { ok: false, reason: '目录页的条目太少', tocPages: detected.pages, chapters: [], offset: null, note: '' };
  }
  const badTitles = flatTitles.filter((title) => {
    const compact = String(title || '').replace(/\s+/g, '');
    if (compact.length < 2 || compact.length > 60) return true;
    return TABLE_TITLE_RE.test(compact) && compact.length <= 18;
  }).length;
  if (badTitles / flatTitles.length > 0.4) {
    return { ok: false, reason: '目录标题大多像表格内容', tocPages: detected.pages, chapters: [], offset: null, note: '' };
  }
  if (new Set(flatTitles).size / flatTitles.length < 0.7) {
    return { ok: false, reason: '目录条目标题大量重复', tocPages: detected.pages, chapters: [], offset: null, note: '' };
  }

  const numbers = [];
  for (const item of detected.parsed) numbers.push(...item.parsed.numbers);
  assignPrintedPages(chaptersWithSections, numbers);

  const lastTocPage = detected.pages[detected.pages.length - 1];
  const bodyPages = pages
    .filter((p) => p.page > lastTocPage && !detected.pages.includes(p.page))
    .sort((a, b) => a.page - b.page);
  const bodyMatches = matchBodySections(bodyPages, chaptersWithSections);
  const offsetInfo = chooseOffset(chaptersWithSections, bodyMatches, lastTocPage, pageCount);

  // 用正文里更清楚的标题修正目录 OCR 的个别错字
  for (const chapter of chaptersWithSections) {
    for (const section of chapter.sections) {
      if (!section.bodyTitle || section.bodyTitle.length < 4) continue;
      section.rawTitle = section.bodyTitle;
      section.sectionTitle = `§${chapter.number}.${section.number} ${section.bodyTitle}`;
    }
  }

  // 先换算 PDF 页序，再用正文标题命中直接校正
  for (const chapter of chaptersWithSections) {
    for (const section of chapter.sections) {
      if (section.pdfPage) {
        section.pageStart = section.pdfPage;
        continue;
      }
      if (section.printedPage != null) {
        section.pageStart = Math.max(1, Math.min(pageCount, section.printedPage + offsetInfo.offset));
        continue;
      }
      section.pageStart = null;
    }
  }

  // 补全漏掉的页码：优先按相邻已确认页插值，宁可标“约”
  const flat = chaptersWithSections.flatMap((c) => c.sections);
  for (let i = 0; i < flat.length; i += 1) {
    const section = flat[i];
    if (section.pageStart) continue;
    let prev = i - 1;
    while (prev >= 0 && !flat[prev].pageStart) prev -= 1;
    let next = i + 1;
    while (next < flat.length && !flat[next].pageStart) next += 1;
    const before = prev >= 0 ? flat[prev].pageStart : null;
    const after = next < flat.length ? flat[next].pageStart : null;
    let guess;
    if (before != null && after != null && after > before) {
      const gap = next - prev;
      guess = before + Math.max(1, Math.round((after - before) / gap));
    } else if (before != null) {
      guess = before + 1;
    } else if (after != null) {
      guess = Math.max(1, after - (next - i));
    } else {
      guess = Math.max(1, lastTocPage + 1);
    }
    section.pageStart = Math.min(pageCount, guess);
    section.estimated = true;
  }

  // 保证节页序单调；同一页上的多个节可以并列，但不能倒退
  for (let i = 0; i < flat.length; i += 1) {
    if (i && flat[i].pageStart < flat[i - 1].pageStart) {
      flat[i].pageStart = flat[i - 1].pageStart;
      flat[i].estimated = true;
    }
  }

  for (const chapter of chaptersWithSections) {
    const starts = chapter.sections.map((s) => s.pageStart).filter(Boolean);
    chapter.pageStart = starts.length ? Math.min(...starts) : Math.max(1, lastTocPage + 1);
    chapter.estimated = chapter.sections.some((s) => s.estimated);
  }

  const estimatedCount = flat.filter((s) => s.estimated).length;
  const noteParts = ['目录由本机 OCR 识别'];
  if (offsetInfo.source === 'body') noteParts.push('页码已按正文标题校正为 PDF 页序');
  else noteParts.push(`页码按目录后第一页估算（+${offsetInfo.offset}）`);
  if (estimatedCount) noteParts.push(`${estimatedCount} 节页码为估算`);

  return {
    ok: true,
    tocPages: detected.pages,
    chapters: chaptersWithSections,
    offset: offsetInfo.offset,
    offsetSource: offsetInfo.source,
    bodyMatches,
    estimatedCount,
    note: noteParts.join('，'),
  };
}

module.exports = {
  parseToc,
  detectTocPages,
  parseTocPage,
  cleanTitle,
  stripChapterMarker,
  stripSectionMarker,
};
