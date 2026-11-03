/**
 * 本地术语表
 * ---------------------------------------------------------------
 * 只收录能确定讲清楚的常见术语，宁可少而准，也不自动编造。
 * 远程/本机模型生成的术语卡会单独标注来源；这里的内容是人工整理的兜底。
 */

const TERMS = [
  {
    id: 'limit',
    term: '极限',
    aliases: ['极限'],
    subject: '数学',
    plain: '看一个量“越来越接近”某个确定值的趋势，而不是看它某一刻等于多少。极限存在，表示无论怎么靠近，最后都能稳定在同一个数附近。',
    example: '把一杯 20°C 的水放到暖气旁，水温会越来越接近室温，但不会真的超过它。研究“最后会稳定到几度”，就是在看极限。',
  },
  {
    id: 'infinitesimal',
    term: '无穷小',
    aliases: ['无穷小'],
    subject: '数学',
    plain: '不是“一个很小的数”，而是“极限为 0 的变量”。它会越来越接近 0，但通常不等于 0。',
    example: '每步走剩下路程的一半：第一天剩一半，第二天剩四分之一……剩余路程本身就是一个无穷小。',
  },
  {
    id: 'equivalent-infinitesimal',
    term: '等价无穷小',
    aliases: ['等价无穷小'],
    subject: '数学',
    plain: '两个无穷小之比的极限为 1 时，称它们等价。在乘除运算中可以互相替换来简化式子，但加减法里不能随手替换。',
    example: '把“1 美元≈7 元人民币”当成近似汇率，算总价时可以直接乘除；但如果你在算“差了几毛钱”，就不能再用这个近似值糊弄过去。',
  },
  {
    id: 'lhopital',
    term: '洛必达法则',
    aliases: ['洛必达'],
    subject: '数学',
    plain: '遇到 0/0 或 ∞/∞ 型极限且满足条件时，可以分别对分子、分母求导，再用新的极限判断原来的极限。它不是万能公式，先要检查适用条件。',
    example: '比较两个人谁先到终点，不去看他们起点和终点的位置，而看“此刻的速度”之比——洛必达法则就是把位置问题换成速度问题。',
  },
  {
    id: 'taylor',
    term: '泰勒公式',
    aliases: ['泰勒公式', '泰勒展开', '泰勒'],
    subject: '数学',
    plain: '用一个多项式在某一点附近近似复杂函数：先对齐函数值，再对齐斜率，再对齐弯曲程度，逐层逼近。',
    example: '地球表面看起来是平的，因为在小范围内，球面可以用一个平面很好地近似；泰勒公式就是给曲线做这种“局部近似”，只是精度可以一层层提高。',
  },
  {
    id: 'asymptote',
    term: '渐近线',
    aliases: ['渐近线'],
    subject: '数学',
    plain: '曲线在远处无限接近、但通常不会真正相交的直线。它描述的是函数在无穷远处的走势。',
    example: '站在铁轨中间往远处看，两条铁轨像是要汇成一点，但它们并没有真的相交，只是越来越接近——这就是渐近的感觉。',
  },
  {
    id: 'continuity',
    term: '连续',
    aliases: ['连续', '间断点'],
    subject: '数学',
    plain: '函数图像不断开：自变量稍微变一点，函数值也只变一点点。某点连续要同时满足“有定义、有极限、极限等于函数值”。',
    example: '地铁线路图上的一笔画不断，就是连续；如果中间缺了一站，线断了，就是不连续。',
  },
  {
    id: 'derivative',
    term: '导数',
    aliases: ['导数', '求导'],
    subject: '数学',
    plain: '函数在某一点的瞬时变化率，也就是曲线在该点的切线斜率。它回答的是“此刻变化得有多快”。',
    example: '汽车仪表盘上的速度，就是里程对时间的导数：它显示的不是你走了多远，而是这一瞬间你跑得多快。',
  },
  {
    id: 'differential',
    term: '微分',
    aliases: ['微分'],
    subject: '数学',
    plain: '用切线（线性函数）在局部近似函数的变化量，核心是“变化量的主要线性部分”。',
    example: '用直尺去量一小段圆弧，会觉得它几乎是直的；微分就是这一小段“直尺近似”的数学写法。',
  },
  {
    id: 'composite-function',
    term: '复合函数',
    aliases: ['复合函数'],
    subject: '数学',
    plain: '把一个函数的输出，作为另一个函数的输入，两个步骤串起来形成新函数。求导时要按链式法则一层层乘起来。',
    example: '先把人民币按汇率换成美元，再用美元价格算能买几件商品；两步串起来的换算关系，就是一个复合函数。',
  },
  {
    id: 'implicit-function',
    term: '隐函数',
    aliases: ['隐函数'],
    subject: '数学',
    plain: '变量之间的关系写在一个方程里，没有直接写成 y=... 的形式，但对应关系仍然存在。求导时把 y 看成 x 的函数再处理。',
    example: '商场规则写着“消费满 300 元办会员卡”，它没有直接告诉你每笔消费对应什么卡，但你去查规则就能得到答案——关系藏在规则里，就像隐函数。',
  },
  {
    id: 'parametric-equation',
    term: '参数方程',
    aliases: ['参数方程'],
    subject: '数学',
    plain: '借助第三个变量（参数）分别表示 x 和 y，用参数的变化描述整条曲线。',
    example: '用时间 t 记录一辆小车的位置：t 决定横向坐标，也决定纵向坐标，合起来就是小车走过的轨迹。',
  },
  {
    id: 'integral',
    term: '积分',
    aliases: ['积分', '定积分', '不定积分'],
    subject: '数学',
    plain: '把无数个小块累加起来求总效果：定积分求累积量，不定积分求原函数。微分和积分是一对互逆操作。',
    example: '把一天里每一秒的用水量加起来，就是今天一共用了多少水；把每一小段时间的降雨量加起来，就得到总降雨量——这就是积分。',
  },
  {
    id: 'variable-limit-integral',
    term: '变限积分',
    aliases: ['变限积分'],
    subject: '数学',
    plain: '积分上限（或下限）是变量的积分，结果不是一个数，而是一个函数。对它求导要用微积分基本定理。',
    example: '每天往存钱罐里加钱，总额会随天数变化。“到第 t 天一共有多少”就是一个变限积分；它对天数的变化率，就是每天新加的钱。',
  },
  {
    id: 'substitution',
    term: '换元法',
    aliases: ['换元法', '换元'],
    subject: '数学',
    plain: '把一个复杂的整体换成新变量，让式子变简单；积分换元时还要把 dx 一起换掉。',
    example: '把“一箱 12 瓶”整体记作“1 箱”，算总量时就不用一瓶一瓶数；换元就是给复杂对象起一个简单的新名字。',
  },
  {
    id: 'integration-by-parts',
    term: '分部积分',
    aliases: ['分部积分'],
    subject: '数学',
    plain: '把两个函数乘积的积分，转换成另一个更容易计算的积分，本质来自乘积的求导公式。',
    example: '搬一张大桌子出门，先拆成桌面和桌腿两件会更好搬；分部积分就是换一种拆法，把难积的部分拆到另一边去。',
  },
  {
    id: 'rational-function',
    term: '有理函数',
    aliases: ['有理函数'],
    subject: '数学',
    plain: '两个多项式相除得到的函数。积分时常用部分分式把它拆成几个更简单的分式。',
    example: '把总价按人数平均分，每人应付“总价 ÷ 人数”，这是一个有理式；人数固定时，它随总价线性变化。',
  },
  {
    id: 'recurrence',
    term: '递推',
    aliases: ['递推'],
    subject: '数学',
    plain: '用前一项或前几项算出下一项，一步步把结果推下去。',
    example: '规定“这个月体重 = 上个月体重 − 0.5 kg”，只要知道上个月是多少，就能逐月算出以后的数据。',
  },
  {
    id: 'voltage',
    term: '电压',
    aliases: ['电压', '电势差'],
    subject: '电路',
    plain: '两点之间的电势差，表示单位正电荷从一点移到另一点时电场力做的功。它提供推动电荷流动的“压力差”。',
    example: '水塔越高，水管两端的水压差越大，水流越有劲；电压就是电路里的“水压差”。',
  },
  {
    id: 'current',
    term: '电流',
    aliases: ['电流'],
    subject: '电路',
    plain: '单位时间内通过导体截面的电荷量，表示电荷流动的快慢和多少。',
    example: '同一根水管里每秒流过多少水，就是水流大小；电路里每秒流过多少电荷，就是电流。',
  },
  {
    id: 'resistance',
    term: '电阻',
    aliases: ['电阻'],
    subject: '电路',
    plain: '导体对电流的阻碍作用。材料、长度、横截面积和温度都会影响它。',
    example: '水管越细、越长，水流越费劲；电阻就像水管对水流的阻力。',
  },
  {
    id: 'ohms-law',
    term: '欧姆定律',
    aliases: ['欧姆定律', '欧姆'],
    subject: '电路',
    plain: '同一段线性导体中，电流与电压成正比、与电阻成反比：I = U / R。',
    example: '水压越大，水流越大；管道越窄，水流越小。欧姆定律就是电路里的这条“水压—水管”关系。',
  },
  {
    id: 'kcl',
    term: '基尔霍夫电流定律',
    aliases: ['基尔霍夫电流定律', 'KCL', '节点电流'],
    subject: '电路',
    plain: '电荷不会在节点凭空堆积或消失：流入节点的电流总和等于流出节点的电流总和。',
    example: '十字路口每秒驶入的车辆必须等于驶出的车辆，否则车会堆积或凭空出现——节点上的电荷也一样。',
  },
  {
    id: 'kvl',
    term: '基尔霍夫电压定律',
    aliases: ['基尔霍夫电压定律', 'KVL', '回路电压'],
    subject: '电路',
    plain: '沿闭合回路走一圈，各段电压降的代数和为零，本质是电场力做功与路径无关（能量守恒）。',
    example: '绕小区走一圈回到原点，一路上坡下坡的高度变化总和为零；绕电路一圈，电压升降的总和也为零。',
  },
  {
    id: 'thevenin',
    term: '戴维南定理',
    aliases: ['戴维南'],
    subject: '电路',
    plain: '一个含独立源的线性二端网络，对外可以等效成一个电压源串联一个电阻：开路电压加等效电阻。',
    example: '不管一台机器内部多复杂，你只关心它插到插座上能提供多大电压、内阻多大；戴维南就是给复杂电路做“外部等效”。',
  },
  {
    id: 'phasor',
    term: '相量',
    aliases: ['相量'],
    subject: '电路',
    plain: '用一个复数表示正弦量的幅值和初相，把同频率正弦量的加减和微分方程，变成复数代数运算。',
    example: '同一首歌的旋律可以用“音量 + 节拍位置”两个数来表示；相量就是用“大小 + 角度”两个信息来描述正弦波。',
  },
  {
    id: 'protocol',
    term: '协议',
    aliases: ['协议'],
    subject: '网络',
    plain: '通信双方约定好的数据格式、发送顺序和应答规则。没有协议，双方即使收到 0 和 1，也不知道该怎么解释。',
    example: '寄快递要填收件人、地址、电话，寄件人和快递员都按同一张单子填写；这张大家共同遵守的单子，就是协议。',
  },
  {
    id: 'packet-switching',
    term: '分组交换',
    aliases: ['分组交换'],
    subject: '网络',
    plain: '把数据切成小块（分组），每个分组独立选择路径、在节点存储转发，到达目的地后再按顺序重组。',
    example: '搬家时把家具拆成小件分批运输，到了新家再组装；不用等一整辆专车，也不怕某一件太大过不了门。',
  },
  {
    id: 'circuit-switching',
    term: '电路交换',
    aliases: ['电路交换'],
    subject: '网络',
    plain: '通信前先建立一条独占的物理通路，通信结束后释放。建立连接慢，但传输时延稳定。',
    example: '打电话：拨通后这条线路只归你们两个人使用，别人打不进来；挂断后线路才释放。',
  },
  {
    id: 'router',
    term: '路由器',
    aliases: ['路由器', '路由选择'],
    subject: '网络',
    plain: '根据分组的目的地址和路由表，为分组选择下一跳的网络设备。它连接不同网络，隔离广播域。',
    example: '快递分拣中心看包裹上的目的地，决定把它发往哪个城市；路由器就是网络里的分拣中心。',
  },
  {
    id: 'ip-address',
    term: 'IP 地址',
    aliases: ['IP 地址', 'IP地址'],
    subject: '网络',
    plain: '在网络中标识一台主机或接口的地址，用于寻址和转发。IPv4 是 32 位，通常写成四段十进制数。',
    example: '门牌号：快递员要知道你在哪条街、几号楼、几号房，才能把包裹送到；IP 地址就是设备在网络里的门牌号。',
  },
  {
    id: 'tcp',
    term: 'TCP',
    aliases: ['TCP', '传输控制协议'],
    subject: '网络',
    plain: '面向连接、可靠、按序的传输层协议，用确认、重传、滑动窗口和拥塞控制，保证数据尽量完整送达。',
    example: '寄重要文件用挂号信：寄出有回执，丢了会补寄，收件人按顺序签收；TCP 就是网络里的挂号信。',
  },
  {
    id: 'three-way-handshake',
    term: '三次握手',
    aliases: ['三次握手'],
    subject: '网络',
    plain: '建立 TCP 连接时，双方交换 SYN 和 ACK，确认彼此的发送与接收能力都正常，然后才开始传数据。',
    example: '打电话先问“能听见吗？”对方答“能，你能听见我吗？”你说“能”，双方确认后正式开聊。',
  },
  {
    id: 'sliding-window',
    term: '滑动窗口',
    aliases: ['滑动窗口'],
    subject: '网络',
    plain: '允许发送方在收到确认前连续发送多个分组，用窗口大小控制“已发送但未确认”的数据量，兼顾效率和接收能力。',
    example: '传送带一次能放几件包裹，送出一件就补一件；窗口就是传送带上同时能放几件。',
  },
  {
    id: 'congestion-control',
    term: '拥塞控制',
    aliases: ['拥塞控制'],
    subject: '网络',
    plain: '根据网络拥塞程度调整发送速率，避免过多数据把网络压垮；常见有慢开始、拥塞避免、快重传和快恢复。',
    example: '高速公路堵车时，入口会限流，等路况好转再逐步放行；拥塞控制就是给网络入口“限流”。',
  },
  {
    id: 'dns',
    term: 'DNS',
    aliases: ['DNS', '域名系统'],
    subject: '网络',
    plain: '把域名解析成 IP 地址的分布式系统。浏览器先问 DNS，拿到地址后才能找到服务器。',
    example: '手机通讯录：你输入“妈妈”就能找到号码；DNS 就是网络里的通讯录，把好记的名字换成地址。',
  },
  {
    id: 'http',
    term: 'HTTP',
    aliases: ['HTTP'],
    subject: '网络',
    plain: '浏览器和服务器之间请求/响应的应用层协议，规定请求方法、状态码和报文格式。',
    example: '在餐厅点菜：你说要什么（请求），服务员把菜端来（响应），菜单和上菜流程就是协议。',
  },
  {
    id: 'subnet-mask',
    term: '子网掩码',
    aliases: ['子网掩码'],
    subject: '网络',
    plain: '用连续的 1 和 0 划分 IP 地址中的网络号和主机号，帮助设备判断目标是否在同一子网。',
    example: '邮编前几位代表城市，后几位代表街道；子网掩码决定 IP 地址里哪几位是“城市”、哪几位是“街道”。',
  },
  {
    id: 'ethernet',
    term: '以太网',
    aliases: ['以太网'],
    subject: '网络',
    plain: '最常见的局域网技术，用 MAC 地址标识网卡，通过交换机在局域网内转发帧。',
    example: '一栋楼里的内部信箱系统：每户有固定信箱号，楼内信件由管理员按信箱号分拣，不需要邮局介入。',
  },
];

function normalizeForMatch(input) {
  return String(input || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
    if (n >= 20) break;
  }
  return n;
}

/**
 * 从文字里挑出术语表命中的条目。按首次出现顺序返回，避免总把同一个词排在最前。
 */
function matchTerms(text, { limit = 4 } = {}) {
  const hay = normalizeForMatch(text);
  if (!hay) return [];
  const hits = [];
  for (const term of TERMS) {
    let best = null;
    for (const alias of term.aliases || [term.term]) {
      const needle = normalizeForMatch(alias);
      if (!needle) continue;
      const index = hay.indexOf(needle);
      if (index === -1) continue;
      if (!best || needle.length > best.needle.length || (needle.length === best.needle.length && index < best.index)) {
        best = { needle, index };
      }
    }
    if (!best) continue;
    hits.push({
      id: term.id,
      term: term.term,
      subject: term.subject,
      plain: term.plain,
      example: term.example,
      count: countOccurrences(hay, best.needle),
      index: best.index,
      specificity: best.needle.length,
    });
  }
  hits.sort((a, b) => a.index - b.index || b.specificity - a.specificity);
  return hits.slice(0, Math.max(0, limit)).map(({ count, index, specificity, ...rest }) => rest);
}

/**
 * 书级关键词：用书名、章节标题、导览和一小段可读正文来匹配。
 * 扫描版教材的 OCR 标题可能认错字，正文样本能让术语卡更可靠。
 */
function bookTerms(book, { limit = 10, sampleText = '' } = {}) {
  const chapters = book && Array.isArray(book.chapters) ? book.chapters : [];
  const parts = [book && book.title];
  for (const chapter of chapters) {
    parts.push(chapter.title);
    for (const section of chapter.sections || []) parts.push(section.title);
  }
  if (book && book.guide && book.guide.overview) parts.push(book.guide.overview);
  if (sampleText) parts.push(String(sampleText).slice(0, 12000));
  return matchTerms(parts.filter(Boolean).join('\n'), { limit });
}

module.exports = { TERMS, matchTerms, bookTerms };
