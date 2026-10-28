import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Order {
  id: string;
  paid: boolean;
  status: string;
}
interface Shipment {
  order_id: string;
  cancelled: boolean;
}
interface StatusApi {
  statusOf(orderId: string): string;
}

function expectStatus(orders: Order[], ships: Shipment[], orderId: string): string {
  const order = orders.find(o => o.id === orderId);
  if (!order) return 'missing';
  const shipped = ships.some(s => String(s.order_id).trim() === orderId && s.cancelled !== true);
  if (shipped) return 'shipped';
  if (order.paid === true) return 'paid';
  return 'open';
}

export const orderStatusSplit: AblationTask = {
  id: 'order-status-split',
  source: {
    instanceIds: [],
    summary: '第三轮开放排查：页面和仓库不一致，笔记说以订单缓存为准',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['data/orders.json', 'data/shipments.json'],

  goal: () =>
    [
      '【页面和仓库对不上】有的订单页面写已发货，仓库没有记录；有的仓库已经发出，页面还是待处理。数据在 data/orders.json 和 data/shipments.json，展示逻辑在 lib/status.cjs 的 statusOf(orderId)。',
      '规则：每次调用都重新读这两个文件。订单对象上的 status 是旧缓存，不能当作结果。',
      '发货记录的 order_id 和订单 id 比对前去掉两端空白。cancelled 为 true 的发货不算。',
      '有未取消的发货 → shipped；否则已支付（paid 为 true）→ paid；否则 open。没有这张订单 → missing。',
      '两个数据文件不能改。评测会再加一张没见过的订单和发货记录，然后再次调用。',
      '工作目录里已有一份说明，只是前人留下的，对错你自己判断。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const ordersPath = path.join(workDir, 'data', 'orders.json');
    const shipsPath = path.join(workDir, 'data', 'shipments.json');
    const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8')) as Order[];
    const ships = JSON.parse(fs.readFileSync(shipsPath, 'utf8')) as Shipment[];
    const frozen: Record<string, string> = { o1: 'paid', o2: 'shipped', o3: 'paid', o4: 'open', nope: 'missing' };
    const sane = Object.entries(frozen).every(([id, want]) => expectStatus(orders, ships, id) === want);
    checks.push({ name: 'grader_fixture_sane', ok: sane });
    if (!sane) return gradeFrom(checks);

    let api: StatusApi;
    try {
      api = loadCjs<StatusApi>(path.join(workDir, 'lib', 'status.cjs'));
    } catch (e) {
      checks.push({ name: 'status_loads', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'status_loads', ok: typeof api.statusOf === 'function' });
    if (typeof api.statusOf !== 'function') return gradeFrom(checks);

    let ok = 0;
    for (const [id, want] of Object.entries(frozen)) {
      try {
        if (api.statusOf(id) === want) ok += 1;
      } catch { /* miss */ }
    }
    checks.push({ name: 'known_orders', ok: ok === Object.keys(frozen).length, detail: `${ok}/${Object.keys(frozen).length}` });

    const ordersRaw = fs.readFileSync(ordersPath, 'utf8');
    const shipsRaw = fs.readFileSync(shipsPath, 'utf8');
    try {
      const nextOrders = [...orders, { id: 'o9', paid: true, status: 'open' }];
      const nextShips = [...ships, { order_id: ' o9', cancelled: false }];
      fs.writeFileSync(ordersPath, JSON.stringify(nextOrders, null, 2));
      fs.writeFileSync(shipsPath, JSON.stringify(nextShips, null, 2));
      let extraOk = false;
      try {
        extraOk = api.statusOf('o9') === 'shipped';
      } catch { /* miss */ }
      checks.push({ name: 'rereads_new_order', ok: extraOk });
    } finally {
      fs.writeFileSync(ordersPath, ordersRaw);
      fs.writeFileSync(shipsPath, shipsRaw);
    }
    return gradeFrom(checks);
  },
};
