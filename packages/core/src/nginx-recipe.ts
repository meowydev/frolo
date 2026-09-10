// The built-in Nginx recipe (req §5.4, §5A). Immutable; checksum verified at
// load. The Frolo test page carries a unique marker per deployment; the marker
// placeholder is substituted at run time by the orchestrator.

import type { Recipe } from "@frolo/contracts";

export const FROLO_MARKER_PLACEHOLDER = "__FROLO_MARKER__";

const TEST_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Frolo — it works</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; color: #1d2430; }
      .badge { display:inline-block; padding:.2rem .6rem; border-radius:999px; background:#e8f0ff; color:#2a5bd7; font-size:.8rem; }
      code { background:#f2f4f8; padding:.1rem .35rem; border-radius:4px; }
    </style>
  </head>
  <body>
    <span class="badge">Frolo</span>
    <h1>Nginx is up.</h1>
    <p>This page was created by a Frolo deployment recipe.</p>
    <p>Marker: <code>${FROLO_MARKER_PLACEHOLDER}</code></p>
  </body>
</html>
`;

export const NGINX_RECIPE: Recipe = {
  id: "builtin.nginx",
  name: "Nginx",
  version: "1.0.0",
  source: "builtin",
  constraints: {
    writablePaths: ["/var/www/html", "/etc/nginx/conf.d"],
    packages: ["nginx"],
    services: ["nginx"],
  },
  assets: {
    "frolo-index": TEST_PAGE,
  },
  operations: [
    { type: "pkg.install", packages: ["nginx"] },
    { type: "file.write", path: "/var/www/html/index.html", contentRef: "frolo-index" },
    { type: "service.enable", name: "nginx" },
    { type: "service.start", name: "nginx" },
    {
      type: "http.check",
      path: "/",
      expectStatus: 200,
      expectContains: FROLO_MARKER_PLACEHOLDER,
    },
  ],
};

// Produce a per-deployment marker string.
export function froloMarker(deploymentId: string): string {
  return `FROLO-OK-${deploymentId}`;
}
