function getTrustProxySetting(value = process.env.TRUST_PROXY) {
  const configured = String(value || "").trim();
  if (!configured || /^(false|off|0)$/i.test(configured)) return false;
  if (/^\d+$/.test(configured)) return Number(configured);

  // Express accepts proxy-addr names, IP addresses and CIDR ranges. Never accept
  // the permissive `true` value: direct clients could then forge forwarding headers.
  if (/^true$/i.test(configured)) return false;
  const trustedProxies = configured.split(",").map(entry => entry.trim()).filter(Boolean);
  return trustedProxies.length ? trustedProxies : false;
}

module.exports = { getTrustProxySetting };
