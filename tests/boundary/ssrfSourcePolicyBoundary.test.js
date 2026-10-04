import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { StorageService } from "../../src/platform/storage/StorageService.js";

describe("SSRF Mitigation & SourcePolicy Boundary Tests (Task T4)", () => {
  let storageService;
  let mockProvider;
  let originalFetch;
  let originalDnsLookup;

  before(() => {
    mockProvider = {
      upload: async (path, body, options) => {
        return `https://storage.example.com/${path}`;
      },
      delete: async () => {},
      deleteFiles: async () => ({ deletedCount: 1, failures: [] }),
      getUrl: (path) => `https://storage.example.com/${path}`,
    };

    storageService = new StorageService("test-bucket", mockProvider);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDnsLookup = dns.lookup;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dns.lookup = originalDnsLookup;
  });

  // ── TEST 1: Direct Private IPv4 literals are rejected ──
  it("TEST 1: Rejects private IPv4 addresses (127.0.0.1, 10.x, 192.168.x, 169.254.x)", async () => {
    const targets = [
      "http://127.0.0.1/admin",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/secret",
      "http://169.254.169.254/latest/meta-data/",
    ];

    for (const url of targets) {
      await assert.rejects(
        async () => {
          await storageService.uploadFromUrl("test/path.png", url);
        },
        /(SSRF|forbidden|restricted|prohibited|invalid)/i,
        `Expected ${url} to be blocked by SSRF defense`
      );
    }
  });

  // ── TEST 2: Localhost and internal hostnames are rejected ──
  it("TEST 2: Rejects localhost, .local, and .internal domains", async () => {
    const targets = [
      "http://localhost:8080/data",
      "http://service.local/api",
      "http://metadata.internal/creds",
    ];

    for (const url of targets) {
      await assert.rejects(
        async () => {
          await storageService.uploadFromUrl("test/path.png", url);
        },
        /(SSRF|forbidden|restricted|local)/i,
        `Expected ${url} to be blocked by SSRF defense`
      );
    }
  });

  // ── TEST 3: Hostname that resolves via DNS to a private IP is rejected ──
  it("TEST 3: Rejects public-looking hostname that resolves to a private IP (DNS rebinding)", async () => {
    dns.lookup = async (hostname) => {
      if (hostname === "evil.example.com") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    };

    await assert.rejects(
      async () => {
        await storageService.uploadFromUrl("test/path.png", "http://evil.example.com/exploit.png");
      },
      /(SSRF|restricted IP|SSRF protection)/i,
      "Expected evil.example.com resolving to 127.0.0.1 to be blocked"
    );
  });

  // ── TEST 4: Redirect from public URL to internal private IP is rejected ──
  it("TEST 4: Rejects redirect from a public URL to a private IP address", async () => {
    dns.lookup = async (hostname) => {
      return [{ address: "93.184.216.34", family: 4 }];
    };

    globalThis.fetch = async (url, options = {}) => {
      // First hop: public host redirects to private IP
      if (url.includes("public.example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/metadata" },
        });
      }
      return new Response(Buffer.from("leak"), { status: 200 });
    };

    await assert.rejects(
      async () => {
        await storageService.uploadFromUrl("test/path.png", "http://public.example.com/redirect");
      },
      /(SSRF|forbidden|restricted|private)/i,
      "Expected redirect to 127.0.0.1 to be blocked"
    );
  });

  // ── TEST 5: Non-http/https protocols are rejected ──
  it("TEST 5: Rejects non-HTTP(S) protocols like file:// or ftp://", async () => {
    const prohibited = [
      "file:///etc/passwd",
      "ftp://example.com/image.png",
      "gopher://127.0.0.1:70",
    ];

    for (const url of prohibited) {
      await assert.rejects(
        async () => {
          await storageService.uploadFromUrl("test/path.png", url);
        },
        /(protocol|Only HTTP|invalid)/i,
        `Expected protocol in ${url} to be rejected`
      );
    }
  });

  // ── TEST 6: Oversize body is rejected ──
  it("TEST 6: Rejects remote file that exceeds maximum allowed size", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    globalThis.fetch = async () => {
      // Declares 150MB content length, default limit is 100MB
      return new Response(Buffer.alloc(1024), {
        status: 200,
        headers: {
          "content-length": String(150 * 1024 * 1024),
          "content-type": "image/png",
        },
      });
    };

    await assert.rejects(
      async () => {
        await storageService.uploadFromUrl("test/path.png", "https://public.example.com/huge.png");
      },
      /(too large|exceeds maximum|limit)/i,
      "Expected oversize file to be rejected"
    );
  });

  // ── TEST 7: Prohibited MIME type is rejected ──
  it("TEST 7: Rejects remote file with disallowed MIME type", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    globalThis.fetch = async () => {
      return new Response(Buffer.from("<script>alert(1)</script>"), {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      });
    };

    await assert.rejects(
      async () => {
        await storageService.uploadFromUrl("test/path.png", "https://public.example.com/file.html", {
          purpose: "character_reference", // only images allowed
        });
      },
      /(format|MIME|not allowed)/i,
      "Expected non-image MIME type to be rejected for character_reference"
    );
  });

  // ── TEST 8: Valid public image URL succeeds ──
  it("TEST 8: Legitimate public image URL succeeds and uploads to storage", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    const samplePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    globalThis.fetch = async () => {
      return new Response(samplePng, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(samplePng.length),
        },
      });
    };

    const result = await storageService.uploadFromUrl("test/valid.png", "https://public.example.com/image.png");
    assert.strictEqual(result, "https://storage.example.com/test/valid.png");
  });
});
