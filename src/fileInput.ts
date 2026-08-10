import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

export interface ResolvedFile {
  bytes: Uint8Array;
  originalFilename: string | null;
  contentType: string | null;
}

const DATA_URI_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;

// Maximum number of bytes we will accept for any single input, regardless of
// how it arrived (uploaded File, remote URL, or data URI). Reads the override
// from MAX_UPLOAD_BYTES so operators can tune it without a code change, and
// falls back to 25 MiB when it is unset or nonsensical. Kept self-contained
// here (not in config.ts) so this module is safe to reuse in isolation.
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env["MAX_UPLOAD_BYTES"];
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 25 * 1024 * 1024;
})();

// Follow at most this many redirect hops for a remote fetch. Each hop's target
// host is re-validated against the SSRF blocklist before we chase it, so a
// public URL cannot bounce us onto an internal address.
const MAX_REDIRECTS = 5;

// Exact-match allowlist of hosts that may bypass the SSRF blocklist, read from
// SSRF_ALLOWED_HOSTS (comma-separated, e.g. "localhost,127.0.0.1"). Empty by
// default, so protection is fully on unless an operator deliberately opts a host
// in — used for local dev and the test suite, where the "remote" source is
// legitimately a loopback address (test/upload.test.ts re-fetches from
// http://localhost:<port>). Read lazily per request so tests can set it at
// runtime and so it never silently disables the guard for anything else.
function allowedHosts(): Set<string> {
  const raw = process.env["SSRF_ALLOWED_HOSTS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Returns true when `ip` (a numeric address literal, v4 or v6) points at a
// destination we must never let the server fetch: loopback, RFC1918 / ULA
// private space, link-local (which includes the 169.254.169.254 cloud metadata
// endpoint), or the unspecified address. Anything unrecognised is treated as
// blocked so an address we cannot reason about never slips through.
export function isBlockedAddress(ip: string): boolean {
  const address = ip.trim().toLowerCase();

  if (isIPv4(address)) {
    const octets = address.split(".").map((o) => Number(o));
    if (octets.length !== 4) return true;
    const [a = -1, b = -1] = octets;
    if (a === 0) return true; // 0.0.0.0/8, incl. the unspecified address
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata)
    return false;
  }

  if (isIPv6(address)) {
    const groups = ipv6Groups(address);
    if (groups === null) return true; // unparseable v6 -> block conservatively
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

    // IPv4-mapped (::ffff:a.b.c.d) — unwrap and judge the embedded v4 address.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
      return isBlockedAddress(v4);
    }

    if (groups.every((g) => g === 0)) return true; // :: unspecified
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
      return true; // ::1 loopback
    }
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }

  // Not a numeric literal — callers must resolve hostnames before calling us.
  return true;
}

// Expands an IPv6 literal (including "::" compression and an optional embedded
// IPv4 tail) into its 8 numeric 16-bit groups, or null if it cannot be parsed.
function ipv6Groups(address: string): number[] | null {
  let text = address;

  // Fold a trailing dotted-quad (e.g. ::ffff:1.2.3.4) into two hex groups.
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4?.[1]) {
    const octets = v4[1].split(".").map((o) => Number(o));
    if (octets.length !== 4 || octets.some((o) => o < 0 || o > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((h) => Number.parseInt(h, 16)));
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];

  const groups =
    halves.length === 2 ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right] : left;

  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

// Resolves a hostname and rejects if it (or any address it points at) is a
// blocked destination. Literal IPs are judged directly; names are resolved via
// DNS and every returned address is checked, so a name that maps to an internal
// IP is refused just like the literal would be.
async function assertHostAllowed(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets from URL host

  if (allowedHosts().has(host.toLowerCase())) return;

  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refusing to fetch blocked address ${host} (SSRF protection).`);
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve remote host ${host}.`);
  }
  if (addresses.length === 0) {
    throw new Error(`Could not resolve remote host ${host}.`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing to fetch ${host}: resolves to blocked address ${address} (SSRF protection).`);
    }
  }
}

// Reads a response body while enforcing the byte cap, aborting the stream as
// soon as the limit is crossed so an oversized remote body never fully lands in
// memory. Falls back to buffering only when the body is not a readable stream.
async function readBodyWithCap(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    if (buffered.byteLength > maxBytes) {
      throw new Error(`Remote file exceeds the maximum allowed size of ${maxBytes} bytes.`);
    }
    return buffered;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Remote file exceeds the maximum allowed size of ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Fetches a remote URL with SSRF and size protections: only http(s), every hop
// host is re-validated, redirects are followed manually up to MAX_REDIRECTS,
// and the Content-Length hint plus the actual stream are both capped.
async function fetchRemote(initialUrl: string): Promise<ResolvedFile> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`Invalid remote URL: ${currentUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme ${parsed.protocol} (only http and https are allowed).`);
    }

    await assertHostAllowed(parsed.hostname);

    const response = await fetch(currentUrl, { redirect: "manual" });

    // Manual redirect handling: re-validate the target host before chasing it.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Remote host returned a redirect without a Location header.`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while fetching ${initialUrl}.`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch remote file ${initialUrl}: ${response.status} ${response.statusText}`);
    }

    // Trust-but-verify the advertised length before reading anything.
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      throw new Error(`Remote file exceeds the maximum allowed size of ${MAX_UPLOAD_BYTES} bytes.`);
    }

    const bytes = await readBodyWithCap(response, MAX_UPLOAD_BYTES);
    return {
      bytes,
      originalFilename: parsed.pathname.split("/").pop() || null,
      contentType: response.headers.get("content-type"),
    };
  }

  // Unreachable: the loop either returns or throws on the final hop.
  throw new Error(`Too many redirects while fetching ${initialUrl}.`);
}

export async function resolveFileInput(file: unknown): Promise<ResolvedFile> {
  if (file instanceof File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Uploaded file exceeds the maximum allowed size of ${MAX_UPLOAD_BYTES} bytes.`);
    }
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalFilename: file.name || null,
      contentType: file.type || null,
    };
  }

  if (typeof file === "string") {
    if (/^https?:\/\//i.test(file)) {
      return fetchRemote(file);
    }

    const dataUriMatch = file.match(DATA_URI_RE);
    if (dataUriMatch) {
      const [, mime, isBase64, payload] = dataUriMatch;
      const bytes = isBase64
        ? Uint8Array.from(atob(payload ?? ""), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload ?? ""));
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(`Data URI exceeds the maximum allowed size of ${MAX_UPLOAD_BYTES} bytes.`);
      }
      return { bytes, originalFilename: null, contentType: mime || null };
    }

    throw new Error("Unsupported `file` value: expected a remote URL, a data URI, or an uploaded file.");
  }

  throw new Error("Missing `file` param.");
}
