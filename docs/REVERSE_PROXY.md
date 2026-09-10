# HTTPS through a reverse proxy

Frolo binds to **port 4512** and is intended for a **trusted LAN**. It serves
plain HTTP and **never opens a router mapping to expose itself**. For remote
access, or to get HTTPS, put Frolo behind a reverse proxy that you control and
terminate TLS there.

When Frolo runs behind an HTTPS proxy, set `FROLO_BEHIND_TLS=1` so session and
CSRF cookies are marked `Secure`. In `docker-compose.yml` this is the
`FROLO_BEHIND_TLS` environment variable (or set it in `/opt/frolo/.env`).

## Caddy (simplest — automatic HTTPS)

```caddyfile
frolo.example.com {
    reverse_proxy 127.0.0.1:4512
}
```

Caddy obtains and renews certificates automatically. Set `FROLO_BEHIND_TLS=1`
and restart Frolo.

## Nginx

```nginx
server {
    listen 443 ssl;
    server_name frolo.example.com;

    ssl_certificate     /etc/letsencrypt/live/frolo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/frolo.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:4512;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Server-Sent Events (live deployment updates) need buffering off.
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

Frolo trusts `X-Forwarded-*` headers for correct client-IP handling (used by
login rate limiting). Only enable the proxy on a host you control.

## Traefik (labels)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.frolo.rule=Host(`frolo.example.com`)"
  - "traefik.http.routers.frolo.entrypoints=websecure"
  - "traefik.http.routers.frolo.tls.certresolver=le"
  - "traefik.http.services.frolo.loadbalancer.server.port=4512"
```

## Notes

- **CSRF/Origin:** Frolo checks the request `Origin` for state-changing calls.
  Add your external hostname to `FROLO_ALLOWED_ORIGINS` (comma-separated) if the
  proxy presents a different host than the LAN IP.
- **Do not** forward port 4512 directly on your router to the public internet.
  Terminate TLS and add authentication at the proxy if you expose Frolo remotely.
