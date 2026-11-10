/**
 * 粘贴选择题的本地解析器。
 *
 * 只认常见排版：题号 + 题干 + A-D 选项 + 「答案 / Answer」+「解析 / Explanation」。
 * 不调用模型，也不猜题意；识别不了的段落会跳过并如实告诉用户。
 */

export const MAX_QUIZ_QUESTIONS = 50;
export const MAX_QUIZ_TEXT = 50000;

const QUESTION_RE = /^(?:(\d{1,3})\s*[.、)．)]|(?:question|q)\s*(\d{1,3})\s*[.、:：)]?|[一二三四五六七八九十]{1,3}\s*[.、．)])\s*(.*)$/i;
const OPTION_RE = /^(?:[（(]\s*([A-Ha-h])\s*[）)]|([A-Ha-h])\s*[.、)．:：])\s*(.+)$/;
const ANSWER_RE = /^(?:答案|参考答案|正确答案|answer|correct\s*answer)\s*[:：]?\s*([A-Ha-h](?:\s*[,，、/和]\s*[A-Ha-h])*)/i;
const EXPLAIN_RE = /^(?:解析|解释|说明|explanation)\s*[:：]?\s*(.*)$/i;
const INLINE_ANSWER_RE = /(?:答案|正确答案|answer)\s*[:：]?\s*([A-Ha-h])\s*$/i;

function normalizeLine(line) {
  return String(line || '')
    .replace(/\u3000/g, ' ')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｈａ-ｈ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/．/g, '.')
    .trim();
}

function emptyBlock(stem = '') {
  return { stem, options: [], answer: '', explanation: '' };
}

function finishBlock(block) {
  if (!block) return null;
  const seen = new Set();
  const options = [];
  for (const option of block.options) {
    if (seen.has(option.key)) continue;
    seen.add(option.key);
    options.push(option);
  }
  if (!block.stem.trim() || options.length < 2) return null;
  const answer = block.answer.slice(0, 1);
  return {
    stem: block.stem.trim(),
    options,
    answer: answer && seen.has(answer) ? answer : '',
    explanation: block.explanation.trim(),
  };
}

export function parseQuizText(raw) {
  const text = String(raw || '').slice(0, MAX_QUIZ_TEXT).replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(normalizeLine);

  const blocks = [];
  let current = null;
  let skipped = 0;

  for (const line of lines) {
    if (!line) continue;

    const question = line.match(QUESTION_RE);
    if (question) {
      const finished = finishBlock(current);
      if (current && !finished && (current.options.length || current.answer)) skipped += 1;
      if (finished) blocks.push(finished);
      current = emptyBlock(question[3] || '');
      continue;
    }

    if (!current) current = emptyBlock();

    let body = line;
    const inlineAnswer = body.match(INLINE_ANSWER_RE);
    if (inlineAnswer) {
      current.answer = inlineAnswer[1].toUpperCase();
      body = body.slice(0, inlineAnswer.index).trim();
      if (!body) continue;
    }

    const answer = body.match(ANSWER_RE);
    if (answer) {
      current.answer = answer[1].toUpperCase().replace(/[^A-H]/g, '').slice(0, 1);
      continue;
    }

    const explanation = body.match(EXPLAIN_RE);
    if (explanation) {
      current.explanation = explanation[1].trim();
      continue;
    }

    const option = body.match(OPTION_RE);
    if (option) {
      current.options.push({
        key: (option[1] || option[2]).toUpperCase(),
        text: option[3].trim(),
      });
      continue;
    }

    if (!current.stem) current.stem = body;
    else if (current.options.length) {
      const last = current.options[current.options.length - 1];
      last.text = `${last.text} ${body}`.trim();
    } else {
      current.stem = `${current.stem} ${body}`.trim();
    }
  }

  const finished = finishBlock(current);
  if (current && !finished) skipped += 1;
  if (finished) blocks.push(finished);

  const questions = blocks.slice(0, MAX_QUIZ_QUESTIONS);
  if (!questions.length) {
    const hasOptions = /(?:^|\n)\s*[（(]?[A-Ha-h][）)]?\s*[.、)．:：]\s*\S/.test(text);
    throw new Error(hasOptions
      ? '识别到了选项，但没有找到完整的题干。请把题干和 A-D 选项分行粘贴。'
      : '没有识别到选择题。请粘贴「题干 + A/B/C/D 选项」，答案和解析可以不带。');
  }
  return { questions, skipped, truncated: blocks.length > MAX_QUIZ_QUESTIONS };
}
