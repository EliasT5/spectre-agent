# Tailnet Remote Access Playbook

Follow the global rules in `README.md`: official repo only, show commands first, confirm `sudo`/admin and startup changes, stop on first error, and never print the PIN or secrets.

## Goal

Reach Spectre from your **phone** and from **another computer** over your private Tailscale network (tailnet), with **HTTPS**.

This is optional. The loopback URL (`http://127.0.0.1:3100`) is all you need on the machine Spectre runs on. Set this up only when the human wants to open Spectre from another device.

## Why HTTPS is required (do not skip)

Spectre's login sets a session cookie with the `Secure` flag. Browsers **drop a `Secure` cookie over plain HTTP** on any hostname other than `localhost`. So over plain HTTP on a tailnet name, the PIN screen accepts the PIN and then bounces straight back to `/pin` in a loop — it looks broken but it is the cookie being discarded.

`tailscale serve` fronts Spectre with real HTTPS using Tailscale's built-in certificate authority — no Caddy, no certbot, no firewall holes, no public exposure. That satisfies the `Secure`-cookie requirement and is the supported remote-access path (see `docs/M6-INSTALLER.md` and the docker-compose `edge` / `SPECTRE_SITE_ADDRESS` notes for the alternative reverse-proxy path).

Do not instead set `SHELL_BIND=0.0.0.0` over plain HTTP to reach it remotely: besides the cookie problem, that exposes the PIN-gated host-shell surface on every interface.

## 1. Install Tailscale (host + each device)

Install Tailscale on the machine running Spectre, and on every device you want to reach it from (phone, laptop):

- Download: <https://tailscale.com/download>

On the host, joining the tailnet needs elevated rights. Confirm with the human before running it, because it changes network membership:

```bash
sudo tailscale up
```

On macOS/Windows the app's "Log in" button is equivalent to `tailscale up`. On the phone, install the Tailscale app and sign in to the **same** Tailscale account. All devices must be on the same tailnet.

Verify the host joined and note its tailnet name:

```bash
tailscale status
```

Expected: the host appears with a name like `your-host.your-tailnet.ts.net`.

## 2. Serve Spectre over HTTPS on the tailnet

The installer detects Tailscale and offers to run this for you during setup. If it did and it succeeded, skip to step 3. Otherwise run it yourself from any shell on the host (replace `3100` if the human chose a different `SHELL_PORT`):

```bash
tailscale serve --bg https / http://127.0.0.1:3100
```

This publishes the shell at `https://<host>.<tailnet>.ts.net` with automatic HTTPS. `--bg` keeps it running in the background and it re-establishes after reboot.

Check what is being served:

```bash
tailscale serve status
```

Expected: an `https://` entry proxying to `http://127.0.0.1:3100`.

Notes:
- Use the loopback target `http://127.0.0.1:3100`, not the tailnet name — Tailscale terminates HTTPS and forwards to Spectre locally.
- This is `tailscale serve` (tailnet-only, private). Do **not** use `tailscale funnel` unless the human explicitly wants Spectre exposed to the **public** internet — that is a much larger surface and needs its own confirmation.

## 3. Open it from a phone

1. Make sure the phone's Tailscale app is connected (same account as the host).
2. In the phone browser, open:

   ```text
   https://<host>.<tailnet>.ts.net
   ```

   (Get `<host>.<tailnet>.ts.net` from `tailscale status` on the host, or from the phone's Tailscale app device list.)
3. The human enters the PIN they set during install. The same URL adapts to the mobile layout. Do not enter or invent the PIN for them.

Because this is HTTPS, the `Secure` session cookie sets correctly and login sticks.

## 4. Open it from another computer

1. That computer must be signed in to Tailscale on the same account.
2. Open the same `https://<host>.<tailnet>.ts.net` URL in its browser.
3. The human enters the PIN.

## Verify

From the host, confirm the serve mapping is live and the shell answers locally:

```bash
tailscale serve status
curl -I http://127.0.0.1:3100
```

Any HTTP response on the loopback check plus an `https://` entry in the serve status means the tailnet URL should load on a connected device.

## Troubleshooting

- **PIN login loops back to `/pin` from a device** — you are on plain HTTP. Confirm you opened the `https://` tailnet URL, and that `tailscale serve status` shows the HTTPS mapping.
- **Tailnet URL does not resolve on the phone** — the phone is not connected to Tailscale, or it is on a different account/tailnet than the host. Reconnect the Tailscale app.
- **`tailscale serve` says it needs HTTPS to be enabled** — enable MagicDNS + HTTPS certificates in the Tailscale admin console (Settings → the "HTTPS Certificates" toggle), then re-run the serve command.
- **Nothing loads and `tailscale status` shows the host as offline** — run `sudo tailscale up` again (confirm with the human first).

## Notes

- Serve config persists; you normally set it once. Removing it: `tailscale serve --https=443 off`.
- Keep `SHELL_BIND=127.0.0.1` (the default). `tailscale serve` reaches Spectre over loopback, so you never need to bind it to other interfaces.
- Do not add reverse proxies, TLS certs, port-forwarding, or firewall changes for this — `tailscale serve` covers it.
