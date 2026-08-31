# Word Tennis clip relay

Moves a clip from one player's phone to the other's **without it ever becoming a
file they can open early**. No dependencies, no database, no storage account —
plain Node and a folder on disk.

The clip id rides inside the normal turn link. The video itself can only be
downloaded after the receiver has posted a guess, and it is deleted the moment
they move on.

## Run it locally

```
cd server
node index.js          # http://localhost:8080
```

Put the game at `server/public/index.html` and it is served from the same
address, so there is nothing to configure — both players just open the URL.

## Deploy (pick one)

**Render / Railway** — easiest, free tier, no CLI:
1. Push this `server/` folder to a GitHub repo.
2. New Web Service → point at the repo.
3. Build command: *(leave empty)* · Start command: `node index.js`
4. Deploy. Your address is the game.

**Fly.io** — `fly launch` in this folder, accept the defaults, `fly deploy`.
Add a volume if you want clips to survive a restart (they're disposable, so you
don't have to).

## Endpoints

| Method | Path | What |
| --- | --- | --- |
| POST | `/api/clips` | raw video body, `x-wt-type` header → `{id}` |
| POST | `/api/clips/:id/unlock` | `{guess}` — required before any download |
| GET | `/api/clips/:id` | the video; **403** until unlocked |
| DELETE | `/api/clips/:id` | destroy it |
| GET | `/api/health` | `{ok, clips}` |

Unwatched clips are swept after 48 hours.
