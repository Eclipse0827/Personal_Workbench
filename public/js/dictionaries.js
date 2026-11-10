/**
 * 词典跳转链接。
 * 欧路没有公开的词典内容接口，这里只负责把用户带到词典网页，不抓取释义。
 */

export function dictionaryLinks(term) {
  const word = String(term || '').trim().replace(/\s+/g, ' ');
  if (!word) return null;
  const q = encodeURIComponent(word);
  return {
    oxford: `https://www.oxfordlearnersdictionaries.com/search/english/?q=${q}`,
    eudic: `https://dict.eudic.net/dicts/en/${q}`,
  };
}