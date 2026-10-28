function isOpen(isoUtc) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return false;
  const hour = d.getUTCHours();
  const day = d.getUTCDay();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

module.exports = { isOpen };
