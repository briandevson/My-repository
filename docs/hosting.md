# Hosting Aetheria for free

Aetheria is a long-lived process: one authoritative world, ticking every 600 ms,
holding every player, NPC and dropped item in memory, with WebSockets open to
each client. That rules out serverless platforms entirely — Vercel, Netlify and
Cloudflare Pages run a function per request and cannot hold a socket or a world.

What a host must give you:

| Need | Why |
| --- | --- |
| A persistent process | The tick loop *is* the game |
| WebSockets | The whole protocol |
| Durable storage | Characters, or nobody comes back |

Free tiers usually fail the third one. Their filesystems are **ephemeral**:
wiped on restart, redeploy and idle spin-down. A game that forgets everyone's
character overnight is worse than no game, so Aetheria can keep characters in
Postgres instead — set `DATABASE_URL` and it is used automatically.

## The options, honestly

**Truly free and always on**

- **A machine you already own** plus a free [Cloudflare Tunnel][tunnel] — a
  public HTTPS URL with no port forwarding, no card, and a real disk. The catch
  is that the machine has to stay awake.
- **Oracle Cloud Always Free** — a real VM that never sleeps. The most capable
  free option; signup asks for a card to verify identity and ARM capacity is
  sometimes unavailable in a given region.

**Free but sleeps**

- **Render free** — spins down after ~15 minutes idle and takes about a minute
  to wake, with an [ephemeral filesystem][render-free]; pair it with a Postgres
  database so characters survive.
- **Koyeb free** — supports WebSockets, but free instances scale to zero after
  an hour of inactivity and that cannot be disabled.

For a handful of friends, sleeping is survivable: the first person to open the
link waits a minute while the world boots, and everyone after that is fine.
Losing characters is not survivable, which is why `DATABASE_URL` exists.

**No longer free:** Fly.io ended its free allowance for new accounts — new
signups get a short trial. The `fly.toml` in the repo still works if you have a
legacy account or are happy to pay a few dollars a month.

## Recipe: a free host that sleeps

1. Create a free Postgres database (Neon, Supabase and Render all offer one) and
   copy its connection string.
2. Deploy this repo. Every option below reads the `Dockerfile` in the root.
3. Set environment variables:

   ```
   DATABASE_URL=postgres://...      # characters live here, not on disk
   TRUST_PROXY=1                    # the platform terminates TLS in front
   ```

   Add `DATABASE_SSL=no-verify` only if the provider uses a self-signed
   certificate and the connection is refused without it.
4. Open the URL and create a character. Check `/healthz` if anything looks
   wrong — it reports player count, tick and uptime.

The table is created on boot, so there is no migration step.

## Recipe: your own machine, free and always on

```bash
docker compose up -d                       # or: npm start
cloudflared tunnel --url http://localhost:8080
```

`cloudflared` prints a public HTTPS URL you can send to friends. Characters are
saved to a Docker volume on your disk; no database needed.

## Keeping it healthy

- `GET /healthz` → `{"ok":true,"players":n,"tick":n,"uptime":n}`
- `MAX_PLAYERS` (100), `MAX_PER_ADDRESS` (4) cap the load.
- Set `TRUST_PROXY=1` **only** behind a real proxy: the forwarded header is
  trivially forged, and trusting it without one lets a single client bypass
  every per-address limit.

[tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
[render-free]: https://render.com/docs/free
