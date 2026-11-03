/**
 * 演示里画 SVG 的最小工具。
 * 只做创建与属性设置，不碰 HTML 字符串。
 */

const NS = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      el.setAttribute('class', Array.isArray(v) ? v.join(' ') : v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') {
      el.textContent = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendSvg(el, children);
  return el;
}

export function appendSvg(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendSvg(parent, child);
    else if (child.nodeType) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function text(x, y, content, attrs = {}) {
  return svg('text', { x, y, ...attrs }, [content]);
}

export function defsArrow(id, color = 'currentColor') {
  return svg('defs', {}, [
    svg('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: '8',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    }, [
      svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }),
    ]),
  ]);
}

/** 让一条 path 从「没画出来」到「画出来」 */
export function revealPath(el, duration = 650) {
  let length = 0;
  try { length = el.getTotalLength(); } catch { length = 0; }
  if (!length) {
    el.style.opacity = '1';
    return;
  }
  el.style.strokeDasharray = `${length}`;
  el.style.strokeDashoffset = `${length}`;
  el.style.opacity = '1';
  void el.getBoundingClientRect();
  el.style.transition = `stroke-dashoffset ${duration}ms ease, opacity 200ms ease`;
  el.style.strokeDashoffset = '0';
}

/** 把一条 path 直接设置成「已经画了 p 比例」 */
export function setPathProgress(el, p) {
  let length = 0;
  try { length = el.getTotalLength(); } catch { length = 0; }
  if (!length) return;
  el.style.strokeDasharray = `${length}`;
  el.style.strokeDashoffset = `${length * (1 - Math.max(0, Math.min(1, p)))}`;
}

export function pointOnPath(el, p) {
  let length = 0;
  try { length = el.getTotalLength(); } catch { length = 0; }
  const at = Math.max(0, Math.min(1, p)) * length;
  try { return el.getPointAtLength(at); } catch { return { x: 0, y: 0 }; }
}

export function polylinePath(points) {
  if (!points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
}

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
