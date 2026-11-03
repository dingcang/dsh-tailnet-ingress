# dsh-tailnet-ingress

[中文](README.md) | English

A small DSH bundle that serves the loopback Web UI on this machine's own non-public addresses. DSH deliberately binds one concrete address and rejects wildcards, so this is how a deployment answers on its LAN interface and a tunnel interface at the same time while `http://127.0.0.1:<port>` keeps working.

It listens on each servable address and pipes raw TCP to the loopback listener: HTTP, WebSocket upgrades, and everything else pass through untouched. Nothing is inspected, rewritten, or injected.

## Zero-config by default

`autoDetect` is on, so on every boot the plugin reads `os.networkInterfaces()` and serves every non-loopback IPv4 in these ranges:

| Range | Why |
| --- | --- |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | Normal LAN addresses |
| `100.64.0.0/10` | CGNAT — Tailscale hands out `100.x` addresses from here |
| `198.18.0.0/15` | RFC 2544 benchmark range; Shadowrocket's TUN lives at `198.18.0.1` |

The address DSH itself binds is always skipped, so enabling the plugin on a `--host 192.168.1.5` deployment cannot collide with its own listener. Public addresses are never served.

### How the address list is built

Detection reads the operating system's interface table through Node's `os.networkInterfaces()` — no external command, no probe traffic, and no query to the tunnel application:

1. Collect every entry reporting `internal: false` and family IPv4. IPv6 is never served.
2. Drop duplicate addresses.
3. Keep only addresses inside the ranges above; anything public is discarded.
4. Put explicit `hosts` entries first, so configuration always wins and the order is deterministic.
5. Remove the address DSH itself binds, read back from `webServer.getOrigin()`.
6. Listen on each remaining address at the resolved port.

Detection runs on every activation, so a DHCP renewal or a tunnel coming up is picked up at the next start without editing configuration. An address that disappears between detection and `listen` logs a warning while the others keep serving.

## Why `198.18.0.1` matters

Shadowrocket's Tailscale module is a NetworkExtension packet tunnel. It rewrites inbound packets addressed to the node's tailnet address into its own TUN address — `198.18.0.1` on `utun6` — and preserves the port. macOS therefore only ever sees traffic addressed to that literal, which is why a listener on `127.0.0.1` or the LAN address never receives tailnet inbound.

## Serving an address grants no access

The pipe does not rewrite `Host`. DSH's `/api` trust fence still rejects every authority that `--trusted-host` does not name, so a listener on a hotel LAN address does not expose the UI there. Declare each authority a browser will use:

```bash
dsh web --host 127.0.0.1 --trusted-host 192.168.1.5 100.x.y.z
```

Without that, `/api` requests answer `403`. The launch token is per process, and each authority needs its own cookie exchange once.

## Lifecycle

Listeners are owned by `ctx.effect`: they start with the plugin on every `dsh web` boot and close on shutdown or reload. `port: 0` follows the port the Web listener actually binds, so `--port` changes keep both sides aligned.

## Install

```bash
# from npm (recommended)
dsh plugin --profile web add @dingcang/dsh-tailnet-ingress

# from GitHub
dsh plugin --profile web add github:dingcang/dsh-tailnet-ingress

# or from a local directory
dsh plugin --profile web add file:/path/to/dsh-tailnet-ingress
```

Restart `dsh web` afterwards so the profile reloads the package.

## Configure

The bundle's patch supplies defaults. Override them in **your profile's** `cordis.patch.yml` by row id — never by editing this package:

```yaml
- id: dsh-tailnet-ingress
  config:
    hosts: [192.168.1.5]   # explicit addresses instead of / in addition to detection
    autoDetect: true
    port: 0                # 0 = follow the Web listener
    upstreamHost: 127.0.0.1
    upstreamPort: 0        # 0 = follow `port`
```

| Key | Default | Meaning |
| --- | --- | --- |
| `hosts` | `[]` | Extra addresses to serve, merged with detection |
| `autoDetect` | `true` | Serve the machine's own private / CGNAT / tunnel IPv4 addresses |
| `port` | `0` | `0` follows the Web listener's port |
| `upstreamHost` | `127.0.0.1` | Loopback listener DSH owns |
| `upstreamPort` | `0` | `0` follows `port` |

Setting `autoDetect: false` and listing `hosts` explicitly is the way to pin a single address.
