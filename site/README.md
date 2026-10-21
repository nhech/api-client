# Landing page

Static source for <https://api-client.longtd.me>. No framework, no npm dependencies, no external fonts or scripts. It shares its design (`styles.css`, the structure of `main.js`) with the [Git Pro](https://git-pro.longtd.me) page. This README, `site/og/` and `site/deploy/` are source-only and are not deployed.

| Path | Purpose |
|---|---|
| `site/index.html` | The single page. Uses the `{{NAME}}`, `{{SITE_URL}}`, `{{REPO_URL}}`, `{{VERSION}}`, `{{NODE_MINIMUM}}`, `{{VSCODE_MINIMUM}}` and `{{KEYWORDS}}` placeholders. |
| `site/404.html` | Not-found page. Uses root-relative URLs because nginx serves it for missing paths at any depth. |
| `site/styles.css` | Design tokens (dark for every visitor by default; light only after choosing it with the toggle, which is stored), layout and motion. The "before and after" example under the hero is the `.convert` block at the end. |
| `site/main.js` | Progressive enhancement only: theme toggle, copy buttons, reveal on scroll, current-section highlight, mobile menu. If it fails to load, the inline head script returns the page to the no-JS layout. |
| `site/favicon.svg`, `site/icon.png` | The mark, and a 256 pixel PNG of it rendered by `npm run site:icon`. The build box-filters the 32 pixel favicon from the PNG and copies it as the touch icon. |
| `site/og.jpg`, `site/og/og-card.html` | The 1200 × 630 social card and its source. Re-render with `npm run site:og` after editing the card. |
| `site/robots.txt`, `site/sitemap.xml`, `site/site.webmanifest` | Crawling and install metadata. |
| `site/deploy/` | The production origin: `Dockerfile`, `nginx.conf` and `compose.yml` for an nginx container behind the Cloudflare Tunnel. |

The example under the hero is real: the request on the left is a made-up Thunder Client request, and the file on the right is the output of the importer for it (`node samples/make-sample.cjs`, then the command line), copied without edits. If the output format changes, copy it again.

## Names and address

The product name, the public address and the repository are three constants at the top of `scripts/build-site.cjs` (`NAME`, `SITE_URL`, `REPO_URL`). The pages take them from there through placeholders, and `scripts/deploy-site.cjs` reads the address from the same place. Two places write the name by hand: the social card (`site/og/og-card.html`, then `npm run site:og`) and `short_name` in `site/site.webmanifest`. The VS Code command name quoted in `site/index.html` follows `extension/package.json`. When the product gets its real name, change those too.

The version, the Node.js minimum and the VS Code minimum come from `package.json` and `extension/package.json`; edit those, not the HTML.

## Build and preview

```sh
npm run site:build   # node scripts/build-site.cjs -> site-dist/
npm run site:serve   # node scripts/serve-site.cjs -> http://127.0.0.1:4173/
```

`site:build` copies `site/` except the source-only entries into `site-dist/` (ignored by Git), replaces the placeholders, puts a content hash on the CSS and JS URLs, and validates the result: every local `href`/`src` (including `srcset` candidates and the manifest, sitemap and CSS `url()`s) resolves, every `#fragment` has a matching `id`, ids are unique, each page has one `<h1>`, every `<img>` has `alt`, `width` and `height` that match the image, the required meta tags, canonical, Open Graph and Twitter tags are present, the JSON-LD is valid and has no ratings, reviews or priced offers, `og.jpg` is 1200 × 630, and no placeholder is left. It prints a JSON summary and exits with code 1 on any failure. CI runs it on every push.

Always preview `site-dist/`, not `site/`. Set `PORT` to use another port with `site:serve`.

## Deploy

The page is served the same way as `git-pro.longtd.me`: an nginx container on the host machine, reached by the Cloudflare Tunnel that the `cloudflared` service runs.

```sh
npm run site:deploy               # build, generate the CSP, rebuild and restart the container, verify
npm run site:deploy -- --verify   # only verify the running container
```

The container binds to `127.0.0.1` only (port `API_CLIENT_SITE_PORT`, default `4281`), has a read-only filesystem, no capabilities and a Content-Security-Policy that allows only same-origin files plus the hash of each inline script and `style` attribute. It restarts with Docker. To stop it: `docker compose -f site/deploy/compose.yml down`.

### One-time setup in Cloudflare

Nothing in this repository changes the tunnel or the DNS. Add the hostname once:

- In the tunnel's `config.yml`, above the final catch-all rule:

  ```yaml
  - hostname: api-client.longtd.me
    service: http://localhost:4281
  ```

  then restart the `Cloudflared` service (PowerShell as administrator: `Restart-Service Cloudflared`). This blips every site on the tunnel for a few seconds.
- In the Cloudflare dashboard for the `longtd.me` zone, add a proxied `CNAME` record `api-client` that points to `<tunnel-id>.cfargotunnel.com`. (Do not use `cloudflared tunnel route dns` here if its certificate belongs to another zone: it would create the record under that zone.)

The Universal SSL certificate for `longtd.me` already covers `api-client.longtd.me`. Check with `curl -I https://api-client.longtd.me/` (HTTP/2 200, `server: cloudflare`, a `content-security-policy` header).
