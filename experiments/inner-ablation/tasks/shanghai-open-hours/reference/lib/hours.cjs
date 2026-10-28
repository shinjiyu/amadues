function isOpen(isoUtc) {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return false;
  const local = new Date(ms + 8 * 60 * 60 * 1000);
  const day = local.getUTCDay();
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 && mins < 17 * 60;
}

module.exports = { isOpen };
