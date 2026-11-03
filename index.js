/**
 * Tailnet ingress: serves the loopback DSH Web UI on extra local addresses.
 *
 * DSH deliberately binds exactly one concrete address, so a deployment that
 * must answer on several — the LAN interface plus a tunnel interface — cannot
 * express it with `--host`. This plugin listens on each servable address and
 * pipes raw TCP to the loopback listener, leaving the default
 * `http://127.0.0.1:<port>` entry point untouched.
 *
 * Shadowrocket's Tailscale module rewrites inbound packets addressed to the
 * node's tailnet address into its own TUN address (utun6, 198.18.0.1) while
 * preserving the port, so serving that address is what admits tailnet clients.
 *
 * Lifecycle: the listeners are owned by `ctx.effect`, so they start with the
 * plugin on every `dsh web` boot and close on shutdown or reload. Ports come
 * from the live Web listener instead of being hard-coded, so `--port` changes
 * keep both sides aligned.
 *
 * Security: a raw pipe forwards HTTP and WebSocket upgrades without inspecting
 * them, and it does NOT rewrite `Host`. DSH's `/api` trust fence therefore
 * still rejects every authority that `--trusted-host` does not name, so
 * serving an address here grants no access by itself.
 */

import net from 'node:net'
import os from 'node:os'

/** Stable plugin name. */
export const name = 'tailnet-ingress'

/** The Web listener this ingress mirrors. */
export const inject = ['webServer']

/**
 * Non-public IPv4 ranges worth serving by default: RFC 1918 private space,
 * CGNAT (Tailscale hands out 100.64.0.0/10), and the RFC 2544 benchmark range
 * that Shadowrocket uses for its TUN interface.
 */
const SERVABLE_RANGES = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
]

/**
 * Read a dotted quad as a 32-bit value.
 * @param text - candidate address.
 * @returns the numeric value, or undefined when it is not a dotted quad.
 */
function ipv4Value(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/**
 * Whether an address falls in one range.
 * @param address - candidate dotted quad.
 * @param base - network address of one SERVABLE_RANGES entry.
 * @param bits - prefix length of that entry.
 * @returns true when the address is inside.
 */
function inRange(address, base, bits) {
  const candidate = ipv4Value(address)
  const network = ipv4Value(base)
  if (candidate === undefined || network === undefined) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (candidate & mask) === (network & mask)
}

/**
 * Discover this machine's non-public IPv4 addresses, the set a LAN or tunnel
 * client could reasonably reach.
 * @returns addresses in interface order, without duplicates.
 */
function discoverHosts() {
  const hosts = []
  const seen = new Set()
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      const family = typeof address.family === 'string' ? address.family : `IPv${address.family}`
      if (family !== 'IPv4') continue
      if (seen.has(address.address)) continue
      if (!SERVABLE_RANGES.some(([base, bits]) => inRange(address.address, base, bits))) continue
      seen.add(address.address)
      hosts.push(address.address)
    }
  }
  return hosts
}

/**
 * Normalize configured addresses.
 * @param value - the row's `hosts` value, a list or a single address.
 * @returns unique, non-empty addresses in configuration order.
 */
function normalizeHosts(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const seen = new Set()
  const hosts = []
  for (const item of list) {
    const host = typeof item === 'string' ? item.trim() : ''
    if (host === '' || seen.has(host)) continue
    seen.add(host)
    hosts.push(host)
  }
  return hosts
}

/**
 * The address DSH itself binds, read back from the announced origin.
 * @param ctx - context carrying the activated `webServer` service.
 * @returns the bind address literal, or undefined when unavailable.
 */
function boundAddress(ctx) {
  try {
    return new URL(ctx.webServer.getOrigin()).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

/**
 * Resolve a port, treating a non-positive value as "follow the Web listener".
 * @param ctx - context carrying the activated `webServer` service.
 * @param configured - the row's configured port, or 0/null to follow.
 * @returns the port to use, or undefined when nothing can establish it.
 */
function resolvePort(ctx, configured) {
  const wanted = Number(configured ?? 0)
  if (Number.isInteger(wanted) && wanted > 0) return wanted
  try {
    // `getOrigin` throws until the carrier has bound, and inject guarantees it
    // is already active, so this reads the port the process really serves on.
    const origin = new URL(ctx.webServer.getOrigin())
    if (origin.port !== '') {
      const port = Number(origin.port)
      if (Number.isInteger(port) && port > 0) return port
    }
    return origin.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

/**
 * Serve the discovered and configured addresses.
 * @param ctx - Cordis context owning the listeners.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const configured = normalizeHosts(config?.hosts)
  const discovered = config?.autoDetect === false ? [] : discoverHosts()
  const bound = boundAddress(ctx)

  const seen = new Set()
  const hosts = []
  for (const host of [...configured, ...discovered]) {
    // Serving the address DSH already owns would collide with its listener.
    if (host === bound || seen.has(host)) continue
    seen.add(host)
    hosts.push(host)
  }

  if (hosts.length === 0) {
    ctx.logger.warn('tailnet-ingress: no servable address found; set `hosts` or leave `autoDetect` on')
    return
  }

  const port = resolvePort(ctx, config?.port)
  if (port === undefined) {
    ctx.logger.warn('tailnet-ingress: cannot determine the Web listener port; no ingress listener started')
    return
  }
  const upstreamPort = resolvePort(ctx, config?.upstreamPort) ?? port
  const upstreamHost = String(config?.upstreamHost ?? '127.0.0.1')

  ctx.effect(() => {
    /** @type {import('node:net').Server[]} */
    const servers = []
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set()

    for (const host of hosts) {
      const server = net.createServer((client) => {
        const upstream = net.connect({ host: upstreamHost, port: upstreamPort })
        sockets.add(client)
        sockets.add(upstream)
        let settled = false
        const teardown = () => {
          if (settled) return
          settled = true
          sockets.delete(client)
          sockets.delete(upstream)
          client.destroy()
          upstream.destroy()
        }
        upstream.on('connect', () => {
          client.pipe(upstream)
          upstream.pipe(client)
        })
        client.on('error', teardown)
        upstream.on('error', teardown)
        client.on('close', teardown)
        upstream.on('close', teardown)
      })
      // An address can be absent, for example while the tunnel that provides
      // it is down. Report it and keep the other listeners serving.
      server.on('error', (error) => {
        ctx.logger.warn(
          'tailnet-ingress: cannot listen on %s:%d (%s); is that interface up?',
          host,
          port,
          error.code ?? error.message,
        )
      })
      server.listen(port, host, () => {
        ctx.logger.info('tailnet-ingress: %s:%d -> %s:%d', host, port, upstreamHost, upstreamPort)
      })
      servers.push(server)
    }

    return () => {
      for (const server of servers) server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    }
  })
}
