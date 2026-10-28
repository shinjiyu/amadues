const fs = require('fs');
const path = require('path');

function statusOf(orderId) {
  const orders = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'orders.json'), 'utf8'));
  const order = orders.find(o => o.id === orderId);
  if (!order) return 'missing';
  return order.status;
}

module.exports = { statusOf };
