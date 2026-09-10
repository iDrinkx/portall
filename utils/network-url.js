const net = require("net");
const dns = require("dns").promises;
const fetch = require("node-fetch");

function isBlockedIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a >= 224 || (a === 169 && b === 254);
}

function isBlockedIpv6(hostname) {
  const value = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "::") return true;
  if (value === "::1") return false;

  const firstHextet = Number.parseInt(value.split(":", 1)[0], 16);
  if (!Number.isInteger(firstHextet)) return true;
  return (firstHextet & 0xffc0) === 0xfe80 || (firstHextet & 0xff00) === 0xff00;
}

function assertAllowedIp(hostname) {
  const normalizedHostname = String(hostname || "").replace(/^\[|\]$/g, "");
  const ipVersion = net.isIP(normalizedHostname);
  if ((ipVersion === 4 && isBlockedIpv4(normalizedHostname)) || (ipVersion === 6 && isBlockedIpv6(normalizedHostname))) {
    throw new Error("Service URL is not allowed");
  }
}

function validateTrustedServiceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("Invalid service URL");
  }

  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Invalid service URL");
  }

  assertAllowedIp(parsed.hostname);

  // Private IPv4, loopback and Docker hostnames are intentional supported deployment targets.
  // Hostnames are not DNS-resolved here to avoid breaking Docker service discovery; DNS rebinding
  // remains a deployment-level risk for administrator-configured hostnames.
  return parsed.toString().replace(/\/$/, "");
}

async function resolveAndValidateHostname(url) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Service hostname cannot be resolved");
  addresses.forEach(({ address }) => assertAllowedIp(address));
}

async function safeFetchConfiguredUrl(value, options = {}) {
  const maxRedirects = 5;
  let url = validateTrustedServiceUrl(value);
  const { fetchImpl = fetch, headers: requestHeaders, method: requestMethod, ...requestOptions } = options;
  let headers = new fetch.Headers(requestHeaders || {});
  let method = String(requestMethod || "GET").toUpperCase();
  let body = requestOptions.body;
  delete requestOptions.body;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    await resolveAndValidateHostname(url);
    const response = await fetchImpl(url, { ...requestOptions, headers, method, body, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === maxRedirects) throw new Error("Too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect location is missing");
    const nextUrl = validateTrustedServiceUrl(new URL(location, url).toString());
    const crossOrigin = new URL(nextUrl).origin !== new URL(url).origin;
    const convertsToGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST");
    if (crossOrigin && body != null && !["GET", "HEAD"].includes(method) && !convertsToGet) {
      throw new Error("Cross-origin redirect with request body is not allowed");
    }
    if (crossOrigin) {
      for (const name of [...headers.keys()]) {
        if (["authorization", "cookie", "x-api-key", "x-plex-token"].includes(name)
          || /(?:^|[-_])(token|api[-_]?key|secret)(?:$|[-_])/i.test(name)) {
          headers.delete(name);
        }
      }
    }
    if (convertsToGet) {
      method = "GET";
      body = undefined;
      headers.delete("content-length");
      headers.delete("content-type");
    }
    url = nextUrl;
  }
  throw new Error("Too many redirects");
}

module.exports = { validateTrustedServiceUrl, resolveAndValidateHostname, safeFetchConfiguredUrl };
