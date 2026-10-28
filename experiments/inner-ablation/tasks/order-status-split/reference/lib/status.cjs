const fs = require('fs');
const path = require('path');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8'));
}

function statusOf(orderId) {
  const orders = load('orders.json');
  const ships = load('shipments.json');
  const order = orders.find(o => o.id === orderId);
  if (!order) return 'missing';
  const shipped = ships.some(s => String(s.order_id).trim() === orderId && s.cancelled !== true);
  if (shipped) return 'shipped';
  if (order.paid === true) return 'paid';
  return 'open';
}

module.exports = { statusOf };
