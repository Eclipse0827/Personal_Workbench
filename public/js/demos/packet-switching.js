/**
 * 演示：电路交换 vs 分组交换。
 * 上半部分先建立一条独占线路，再整条发送；下半部分把消息拆成分组，
 * 每个分组独立选路，所以会先后错开到达，最后在接收端重组。
 */

import { h } from '../ui.js';
import { svg, text, setPathProgress, prefersReducedMotion } from './svg.js';

const END = 4200;

const CIRCUIT_ROUTE = 'M 100 90 H 660';

const PACKETS = [
  {
    no: 1,
    route: [[100, 130], [240, 58], [480, 120], [600, 130]],
    start: 200,
    duration: 2100,
  },
  {
    no: 2,
    route: [[100, 130], [240, 190], [480, 120], [600, 130]],
    start: 200,
    duration: 1600,
  },
  {
    no: 3,
    route: [[100, 130], [240, 58], [240, 190], [480, 120], [600, 130]],
    start: 200,
    duration: 1400,
  },
  {
    no: 4,
    route: [[100, 130], [240, 190], [240, 58], [480, 120], [600, 130]],
    start: 200,
    duration: 1900,
  },
];

function routeSegments(points) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  return { segs, total };
}

function pointOnRoute(segments, p) {
  const target = Math.max(0, Math.min(1, p)) * segments.total;
  for (const seg of segments.segs) {
    if (target <= seg.start + seg.len || seg === segments.segs[segments.segs.length - 1]) {
      const local = seg.len ? (target - seg.start) / seg.len : 0;
      return {
        x: seg.a[0] + (seg.b[0] - seg.a[0]) * local,
        y: seg.a[1] + (seg.b[1] - seg.a[1]) * local,
      };
    }
  }
  return { x: 0, y: 0 };
}

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

function endpoint(x, y, label, sub) {
  return [
    svg('rect', { x, y: y - 30, width: 76, height: 60, rx: 12, class: 'demo-endpoint' }),
    text(x + 38, y - 2, label, { class: 'demo-endpoint-label', 'text-anchor': 'middle' }),
    sub ? text(x + 38, y + 17, sub, { class: 'demo-endpoint-sub', 'text-anchor': 'middle' }) : null,
  ];
}

function router(x, y, name) {
  return [
    svg('circle', { cx: x, cy: y, r: 21, class: 'demo-router' }),
    text(x, y + 5, name, { class: 'demo-router-label', 'text-anchor': 'middle' }),
  ];
}

export default {
  id: 'packet-switching',
  title: '分组交换：为什么网络不用「占线」',
  description: '同一段消息，上半部分走独占线路，下半部分被拆成分组各自选路。',
  hint: '注意两边的到达顺序：电路交换按顺序到达；分组交换路径不同，可能乱序，需要在接收端按序号重组。',
  concept: '分组交换如何拆分报文、独立选路并在接收端重组',

  mount(stage) {
    const reduceMotion = prefersReducedMotion();
    let t = reduceMotion ? 1400 : 0;
    let playing = !reduceMotion;
    let visible = true;
    let last = performance.now();
    let arrivedSignature = '';
    let io = null;

    // ------------------------------------------------------------ 上半：电路交换

    const circuitHot = svg('path', {
      d: CIRCUIT_ROUTE,
      class: 'demo-circuit-hot',
    });
    const messageGroup = svg('g', { class: 'demo-message', style: { opacity: '0' } }, [
      svg('rect', { x: -58, y: -17, width: 116, height: 34, rx: 8, class: 'demo-message-box' }),
      text(0, 5, '整条报文', { class: 'demo-message-label', 'text-anchor': 'middle' }),
    ]);

    const circuitSvg = svg('svg', {
      viewBox: '0 0 760 150',
      class: 'demo-svg demo-svg-net',
      role: 'img',
      'aria-label': '电路交换：先建立独占线路再发送整条报文',
    }, [
      svg('path', { d: CIRCUIT_ROUTE, class: 'demo-net-line' }),
      circuitHot,
      ...endpoint(24, 90, '发送方', '主机'),
      ...endpoint(660, 90, '接收方', '主机'),
      ...router(240, 90, 'A'),
      ...router(420, 90, 'B'),
      ...router(590, 90, 'C'),
      messageGroup,
      text(380, 128, '建立连接 → 整条报文顺序通过 → 释放线路', {
        class: 'demo-caption',
        'text-anchor': 'middle',
      }),
    ]);

    const circuitState = h('div.demo-phase-state', {}, '准备建立连接');
    const circuitPanel = h('div.demo-net-panel', {}, [
      h('div.demo-net-head', {}, [
        h('strong', {}, '电路交换'),
        h('span.demo-net-tag', {}, '先建线路 · 独占'),
      ]),
      circuitSvg,
      circuitState,
    ]);

    // ------------------------------------------------------------ 下半：分组交换

    const edges = [
      [100, 130, 240, 58], [100, 130, 240, 190],
      [260, 66, 460, 112], [260, 182, 460, 128],
      [240, 78, 240, 170],
      [500, 120, 660, 130],
    ];

    const packetGroups = PACKETS.map((p) => {
      const group = svg('g', { class: `demo-packet-group p${p.no}`, style: { opacity: '0' } }, [
        svg('rect', { x: -18, y: -13, width: 36, height: 26, rx: 6, class: 'demo-packet' }),
        text(0, 5, String(p.no), { class: 'demo-packet-label', 'text-anchor': 'middle' }),
      ]);
      return { ...p, group, segments: routeSegments(p.route) };
    });

    const packetSvg = svg('svg', {
      viewBox: '0 0 760 240',
      class: 'demo-svg demo-svg-net',
      role: 'img',
      'aria-label': '分组交换：报文被拆成多个分组，各自选择路径后重组',
    }, [
      ...edges.map(([x1, y1, x2, y2]) => svg('line', { x1, y1, x2, y2, class: 'demo-net-line' })),
      ...endpoint(24, 130, '发送方', '主机'),
      ...endpoint(660, 130, '接收方', '主机'),
      ...router(240, 58, 'A'),
      ...router(240, 190, 'B'),
      ...router(480, 120, 'C'),
      ...packetGroups.map((p) => p.group),
      text(380, 226, '每个分组独立选路；先到的先缓存，最后按序号排好', {
        class: 'demo-caption',
        'text-anchor': 'middle',
      }),
    ]);

    const packetState = h('div.demo-phase-state', {}, '等待发送');
    const reassembly = h('div.demo-reassembly', {}, [
      h('span.demo-reassembly-label', {}, '接收端缓存'),
      h('span.tiny.muted', {}, '空'),
    ]);
    const packetPanel = h('div.demo-net-panel', {}, [
      h('div.demo-net-head', {}, [
        h('strong', {}, '分组交换'),
        h('span.demo-net-tag', {}, '无需建线路 · 共享'),
      ]),
      packetSvg,
      packetState,
      reassembly,
    ]);

    // ------------------------------------------------------------ 控制与时间轴

    const timelineFill = h('i', { style: { width: '0%' } });
    const timeline = h('div.demo-timeline-bar', {}, [timelineFill]);

    const playBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        if (t >= END) {
          t = 0;
          playing = true;
          arrivedSignature = '';
        } else {
          playing = !playing;
        }
        syncButton();
        kick();
      },
    }, reduceMotion ? '▶ 播放' : '⏸ 暂停');

    const restartBtn = h('button.demo-btn', {
      type: 'button',
      onclick: () => {
        t = 0;
        playing = true;
        arrivedSignature = '';
        syncButton();
        kick();
      },
    }, '↻ 重播');

    function syncButton() {
      if (t >= END) playBtn.textContent = '↻ 重播';
      else if (playing) playBtn.textContent = '⏸ 暂停';
      else playBtn.textContent = '▶ 播放';
    }

    const controls = h('div.demo-foot', {}, [
      h('div.demo-foot-btns', {}, [playBtn, restartBtn]),
      reduceMotion
        ? h('span.tiny.muted', {}, '系统开启了“减少动态效果”，先显示中间状态；点播放仍可看到全过程。')
        : h('span.tiny.muted', {}, '两种方式同时开始，对比谁先让消息到达。'),
    ]);

    function setStatus(el, value) {
      if (el._demoCache === value) return;
      el._demoCache = value;
      el.textContent = value;
    }

    // ------------------------------------------------------------ 每帧绘制

    function paint() {
      // 电路交换
      const setup = Math.min(1, t / 850);
      setPathProgress(circuitHot, setup);
      circuitHot.style.opacity = t >= 3400 ? '0.25' : '1';

      const msgProgress = Math.max(0, Math.min(1, (t - 850) / 1100));
      if (t >= 850) {
        const eased = easeInOut(msgProgress);
        messageGroup.style.opacity = '1';
        messageGroup.setAttribute('transform', `translate(${100 + eased * 500} 90)`);
      } else {
        messageGroup.style.opacity = '0';
      }

      let cState;
      if (t < 850) cState = '① 正在逐段建立独占线路，此时还不能发数据';
      else if (msgProgress < 1) cState = '② 线路已占用，整条报文正按顺序通过';
      else if (t < 3400) cState = '报文已到达；线路仍然被占用，别人不能用';
      else cState = '③ 释放线路。整个连接期间，即使没在发数据也占着资源';
      setStatus(circuitState, cState);

      // 分组交换
      const arrived = [];
      for (const packet of packetGroups) {
        const p = Math.max(0, Math.min(1, (t - packet.start) / packet.duration));
        if (t < packet.start) {
          packet.group.style.opacity = '0';
          continue;
        }
        packet.group.style.opacity = '1';
        const point = pointOnRoute(packet.segments, easeInOut(p));
        packet.group.setAttribute('transform', `translate(${point.x} ${point.y})`);
        if (p >= 1) arrived.push({ no: packet.no, at: packet.start + packet.duration });
      }

      const signature = arrived.map((x) => x.no).join(',');
      if (signature !== arrivedSignature) {
        arrivedSignature = signature;
        if (!arrived.length) {
          reassembly.replaceChildren(
            h('span.demo-reassembly-label', {}, '接收端缓存'),
            h('span.tiny.muted', {}, '空')
          );
        } else {
          const ordered = [...arrived].sort((a, b) => a.at - b.at);
          reassembly.replaceChildren(
            h('span.demo-reassembly-label', {}, '到达顺序'),
            ...ordered.map((x) => h(`span.demo-packet-chip.p${x.no}`, {}, String(x.no))),
            arrived.length === 4
              ? h('span.demo-reassembly-done', {}, '→ 按序号 ①②③④ 重组')
              : h('span.tiny.muted', {}, `已到 ${arrived.length}/4`)
          );
        }
      }

      let pState;
      if (t < 200) pState = '① 无需建立连接，消息先被拆成 4 个分组';
      else if (arrived.length < 4) pState = '② 分组各走各的路，经过不同路由器转发';
      else pState = '③ 分组可能乱序到达，接收端按序号缓存并重组';
      setStatus(packetState, pState);

      timelineFill.style.width = `${Math.min(100, (t / END) * 100)}%`;
    }

    // ------------------------------------------------------------ 动画循环

    let raf = 0;
    function frame(now) {
      if (!packetSvg.isConnected) return;
      const dt = Math.min(80, now - last);
      last = now;
      if (playing && visible) {
        t = Math.min(END, t + dt);
        if (t >= END) {
          playing = false;
          syncButton();
        }
      }
      paint();
      raf = requestAnimationFrame(frame);
    }

    function kick() {
      last = performance.now();
    }

    stage.appendChild(h('div.demo-net', {}, [circuitPanel, packetPanel]));
    stage.appendChild(controls);
    stage.appendChild(timeline);

    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        visible = entries.some((x) => x.isIntersecting);
        last = performance.now();
      }, { threshold: 0.05 });
      io.observe(stage);
    }

    paint();
    syncButton();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (io) io.disconnect();
    };
  },
};
