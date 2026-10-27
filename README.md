# Chatcord

A free Discord-style chat website: accounts, servers + invite codes, text & voice channels, DMs,
voice/video calls, mute/deafen, camera on/off, screen share, image/video/file uploads, emojis,
reactions, replies, edit/delete, mentions, search, typing indicators, unread badges, and a full
theme editor (text, background, text-background, sidebar, accent colors, fonts, sizes, background image).

## Run locally
    npm install
    npm start        # http://localhost:3000

## Put it online (free, shareable link)
1. Create a free GitHub account and push this folder to a new repo.
2. Go to https://render.com -> New -> Blueprint (or Web Service) -> pick the repo.
   `render.yaml` is already set up. You get a link like `https://chatcord-xxxx.onrender.com`.
3. Share that link. Anyone can open it, register, and chat.

Notes
- Free Render sleeps after ~15 min idle (first load takes ~30 s) and its disk is wiped on redeploy.
  To keep messages/uploads, add a Render persistent disk and set env `DATA_DIR` to its mount path,
  or host on a VPS / any always-on Node host.
- Calls need HTTPS (hosts give this automatically; `localhost` also works).

## Calls on restricted networks (school / office / strict Wi-Fi)
The site itself uses only HTTPS on port 443 and falls back to long-polling, so it loads on most
restricted networks. Voice/video is peer-to-peer and strict firewalls block that without a TURN relay.
Get a free TURN account (e.g. metered.ca or Cloudflare Calls TURN) and set these env vars on your host:

    TURN_URLS=turn:HOST:443?transport=tcp,turns:HOST:443?transport=tcp
    TURN_USER=...
    TURN_PASS=...

Calls are a mesh (everyone connects to everyone), best for up to ~6-8 people per call (hard limit 12).
