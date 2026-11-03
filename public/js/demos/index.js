/**
 * 教材里有对应知识点的动画演示。
 * 服务端只在章节标题/原文命中关键词时返回这些 id，前端按 id 取组件。
 */

import circuitOhm from './circuit-ohm.js';
import packetSwitching from './packet-switching.js';
import tcpHandshake from './tcp-handshake.js';

const DEMOS = new Map([
  circuitOhm,
  packetSwitching,
  tcpHandshake,
].map((demo) => [demo.id, demo]));

export function demoInfo(id) {
  const demo = DEMOS.get(id);
  if (!demo) return null;
  return {
    id: demo.id,
    title: demo.title,
    description: demo.description,
    hint: demo.hint,
    concept: demo.concept || '',
  };
}

export function mountDemo(id, container) {
  const demo = DEMOS.get(id);
  if (!demo) throw new Error(`没有这个演示：${id}`);
  return demo.mount(container);
}

export function demoIds() {
  return [...DEMOS.keys()];
}
