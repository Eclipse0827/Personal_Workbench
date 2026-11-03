'use strict';

/**
 * 数据迁移：第一版的「焦虑记录」→ 我的档案里的「思考档案」
 * ---------------------------------------------------------------
 * PRD 10：「不删除用户已有数据或配置」。
 *
 * 所以这里的原则是：
 *   · 只读原记录，绝不修改、绝不删除 data/entries/ 里的任何文件
 *   · 生成一份新的 Archive，用 legacyEntryId 指回原记录，可追溯
 *   · 用 data/meta.json 记住「已经迁移过」，重复启动不会生出重复档案
 */

const db = require('./db');
const textbook = require('./textbook');
const { newArchive } = require('./models');

const MIGRATION_KEY = 'legacy-entries-to-archives-v1';
const TEXTBOOK_DEMO_MIGRATION_KEY = 'textbook-demos-v2';
const TEXTBOOK_LESSON_MIGRATION_KEY = 'textbook-lessons-text-first-v1';

// 旧版讲义会建议「先看动画」，和新版的文字优先相冲突。
// 本地讲义直接按新规则重算；模型讲义只删掉这类建议，不重新调用模型。
function stripAnimationAdvice(text) {
  return String(text || '')
    .replace(/[^。！？\n]*(?:动画|先看)[^。！？\n]*[。！？]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把一条旧记录转成档案正文：原始记录和后来的整理分开放，标注清楚 */
function entryToContent(entry) {
  const lines = [];
  const created = entry.createdAt ? new Date(entry.createdAt) : null;

  lines.push('## 原始记录');
  lines.push('');
  lines.push('> ' + String(entry.original && entry.original.text || '').split('\n').join('\n> '));
  lines.push('');

  const a = entry.analysis;
  if (a) {
    lines.push('## 当时整理的内容');
    lines.push('');
    if (a.summary) {
      lines.push(a.summary);
      lines.push('');
    }
    const block = (title, arr) => {
      if (!arr || !arr.length) return;
      lines.push(`**${title}**`);
      lines.push('');
      for (const it of arr) lines.push(`- ${it.text}`);
      lines.push('');
    };
    block('已经发生的事实', a.facts);
    block('我的猜测', a.guesses);
    block('担心的事', a.worries);
    block('尚未确定的信息', a.unknowns);
    block('我真正在意的', a.needs);
    if (a.patterns && a.patterns.length) {
      lines.push('**当时看到的可能模式（假设）**');
      lines.push('');
      for (const p of a.patterns) {
        lines.push(`- ${p.label}${p.status === 'rejected' ? '（后来被我否认了）' : ''}：${p.hypothesis}`);
      }
      lines.push('');
    }
  }

  const actions = (entry.checklist && entry.checklist.actions) || [];
  if (actions.length) {
    lines.push('## 当时的措施');
    lines.push('');
    for (const act of actions) lines.push(`- [${act.done ? 'x' : ' '}] ${act.title}`);
    lines.push('');
  }

  const checkins = (entry.checklist && entry.checklist.checkins) || [];
  if (checkins.length) {
    lines.push('## 当时的打卡');
    lines.push('');
    for (const c of checkins) {
      const when = c.at ? new Date(c.at).toLocaleString('zh-CN') : '';
      lines.push(`- ${when} · ${c.actionTitle || ''}${c.note ? ` —— ${c.note}` : ''}`);
    }
    lines.push('');
  }

  if (entry.review && entry.review.status === 'done') {
    lines.push('## 后来的回看');
    lines.push('');
    for (const [k, v] of Object.entries(entry.review.answers || {})) {
      const text = Array.isArray(v)
        ? v.map((x) => (typeof x === 'object' ? `- ${x.text}` : `- ${x}`)).join('\n')
        : String(v);
      if (!text.trim()) continue;
      lines.push(`**${k}**`);
      lines.push('');
      lines.push(text);
      lines.push('');
    }
  }

  if (entry.corrections && entry.corrections.length) {
    lines.push('## 当时对系统的纠正');
    lines.push('');
    for (const c of entry.corrections) lines.push(`- 关于「${c.label}」：${c.note || '不是这样'}`);
    lines.push('');
  }

  if (created) {
    lines.push('---');
    lines.push(`从第一版的记录迁移而来（创建于 ${created.toLocaleString('zh-CN')}）。原始文件仍保存在 data/entries/ 里，未被修改。`);
  }

  return lines.join('\n');
}

/**
 * 执行迁移。幂等，而且**自愈**。
 *
 * 早先的版本只在 meta 里记一个「已迁移」的标记，然后就整体跳过。
 * 那样有个隐患：只要迁移出来的档案因为任何原因丢了（误删、测试清理出错），
 * 原始记录还在，却再也回不到「我的档案」里 —— 这次就真的碰到了。
 *
 * 现在改成逐条对齐：
 *   · 原始记录还在、档案没了      → 重新补一份
 *   · 档案还在                    → 跳过
 *   · 用户主动删过这条            → 记在 meta.dismissedLegacyIds 里，不再复活
 */
async function migrateTextbookDemos(meta) {
  if ((meta.migrations || []).includes(TEXTBOOK_DEMO_MIGRATION_KEY)) return 0;
  let updated = 0;
  for (const book of await db.list('textbooks')) {
    if (!book || !Array.isArray(book.chapters)) continue;
    if ((book.demoPolicyVersion || 1) >= textbook.DEMO_POLICY_VERSION) continue;
    try {
      const pages = await db.readTextbookPages(book.id);
      if (!pages.length) continue;
      const { changed } = textbook.refreshDemos(book, pages);
      book.demoPolicyVersion = textbook.DEMO_POLICY_VERSION;
      await db.put('textbooks', book);
      if (changed) updated += 1;
    } catch (err) {
      // 单本教材出问题不应该阻止服务启动
      console.warn(`  教材「${book.title || book.id}」的辅助动画重算失败：${err.message}`);
    }
  }
  return updated;
}

async function migrateTextbookLessons(meta) {
  if ((meta.migrations || []).includes(TEXTBOOK_LESSON_MIGRATION_KEY)) return 0;
  let updated = 0;
  for (const book of await db.list('textbooks')) {
    if (!book || !Array.isArray(book.chapters)) continue;
    try {
      const pages = await db.readTextbookPages(book.id);
      if (!pages.length) continue;
      let changed = false;
      for (const chapter of book.chapters) {
        for (const section of chapter.sections || []) {
          if (!section.lesson) continue;
          if (section.lesson.provider === 'local') {
            const text = pages
              .filter((p) => p.page >= section.pageStart && p.page <= section.pageEnd)
              .map((p) => p.text)
              .join('\n');
            section.lesson = textbook.localLesson({
              bookTitle: book.title,
              chapterTitle: chapter.title,
              section,
              text,
            });
            changed = true;
          } else if (section.lesson.overview) {
            const cleaned = stripAnimationAdvice(section.lesson.overview);
            if (cleaned !== section.lesson.overview) {
              section.lesson.overview = cleaned;
              changed = true;
            }
          }
        }
      }
      if (changed) {
        await db.put('textbooks', book);
        updated += 1;
      }
    } catch (err) {
      console.warn(`  教材「${book.title || book.id}」的旧讲义重算失败：${err.message}`);
    }
  }
  return updated;
}

async function runMigrations() {
  db.ensureDirs();
  const meta = await db.getMeta();
  const migratedOnce = (meta.migrations || []).includes(MIGRATION_KEY);
  const dismissed = new Set(meta.dismissedLegacyIds || []);
  const textbookDemos = await migrateTextbookDemos(meta);
  const textbookLessons = await migrateTextbookLessons(meta);

  const entries = await db.list('legacyEntries');
  const archives = await db.list('archives');

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry || !entry.id) { skipped += 1; continue; }
    // 用户明确删掉过的，尊重这个决定，不再生成
    if (dismissed.has(entry.id)) { skipped += 1; continue; }
    // 已经有对应档案了，跳过
    if (archives.some((a) => a.legacyEntryId === entry.id)) { skipped += 1; continue; }

    const archive = newArchive({
      title: entry.title || '未命名的记录',
      content: entryToContent(entry),
      type: 'thought',
      origin: 'legacy',
      legacyEntryId: entry.id,
    });
    // 保留原来的创建时间，这样档案列表里的时间线是真实的
    if (entry.createdAt) {
      archive.createdAt = entry.createdAt;
      archive.updatedAt = entry.createdAt;
    }
    await db.put('archives', archive);
    migrated += 1;
  }

  await db.saveMeta({
    ...meta,
    migrations: [...new Set([
      ...(meta.migrations || []),
      MIGRATION_KEY,
      TEXTBOOK_DEMO_MIGRATION_KEY,
      TEXTBOOK_LESSON_MIGRATION_KEY,
    ])],
  });

  return {
    migrated,
    skipped,
    total: entries.length,
    /** 之前迁移过、这次是补回来的，启动日志里要区分开 */
    restored: migratedOnce ? migrated : 0,
    firstRun: !migratedOnce,
    textbookDemos,
    textbookLessons,
  };
}

/** 用户删掉某份迁移档案时记一笔，避免下次启动又把它补回来 */
async function rememberDismissed(legacyEntryId) {
  if (!legacyEntryId) return;
  const meta = await db.getMeta();
  const list = new Set(meta.dismissedLegacyIds || []);
  list.add(legacyEntryId);
  await db.saveMeta({ ...meta, dismissedLegacyIds: [...list] });
}

module.exports = { runMigrations, rememberDismissed, entryToContent, MIGRATION_KEY };
