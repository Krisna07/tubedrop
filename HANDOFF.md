# TubeDrop: project handoff

Written 27 Oct 2026 at the end of the session that built this. Read this first, then `README.md`.

## The idea

TubeDrop is a remote MCP connector that lets Claude upload videos to the user's own YouTube channel with the user's own Google sign-in. Anyone can self-host it on Vercel + Neon in about 15 minutes (guide: `README.md`). Nothing is shared between installs: each owner has their own Google Cloud project, their own YouTube API quota, their own channel.

It came out of the owner's (Krishna's) YouTube channel The Dubious Archive, where scheduled Claude runs research, script, animate, voice, render and schedule a documentary plus Shorts twice a day, then upload them through this connector. The bigger vision is "Claude runs your channel": the whole studio, not just the upload. TubeDrop is the piece that is ready to share first.

How it compares (researched Oct 2026): hosted services (Upload-Post, PostOnce, Blotato, Ayrshare, Zapier MCP) hold the YouTube access themselves and charge a subscription; open-source uploaders (e.g. anwerj's youtube-uploader-mcp) use your own Google credentials but run locally only. TubeDrop is hosted (works in claude.ai, on phones and in scheduled runs) and uses the owner's own credentials.

## Idea discussed, not built: multi-user "bring your own Google project"

One hosted TubeDrop for many people: a small dashboard where a user signs in (with the operator's Google app, email scope only), pastes their own Google OAuth Client ID/Secret (stored encrypted), and gets a personal connector URL `https://<host>/u/<tenant-id>/mcp`. The OAuth flow then uses that tenant's Google client, so the consent screen, quota and channel are theirs. Needs: a `tenants` table, `tenant_id` on the other tables, tenant-aware `oauth.ts`, the dashboard pages, a "delete my account" button. Risks: the operator holds other people's secrets; users must set up Google Cloud (10–15 min). Self-hosting covers most of this need today.

## How it works

- `api/index.ts`: one Vercel function (`vercel.json` rewrites everything to it). Routes: OAuth metadata (`/.well-known/...`), `/register` (dynamic client registration), `/authorize`, `/google/callback`, `/token`, `/mcp` (stateless Streamable HTTP, JSON-RPC), `/` (home page).
- `lib/oauth.ts`: TubeDrop is its own OAuth 2.1 server (PKCE S256) for Claude, delegating sign-in to Google in two steps: (1) the personal Google account: identity + Drive (`drive.readonly`, `drive.file`); (2) the YouTube channel account, which may be a brand account (`youtube.force-ssl`). `ALLOWED_EMAILS` gates step 1. Only Claude redirect hosts (claude.ai, claude.com, localhost) are accepted.
- `lib/util.ts`: env, AES-256-GCM encryption of stored Google tokens (`ENC_KEY`), Neon client, schema creation and migration on first use. `globalThis.__uploaderSql` is a test seam (in-process Postgres).
- `lib/google.ts`: Google access-token refresh, fetch helpers, Drive helpers.
- `lib/tools.ts`: the MCP tools and the upload "pump".

### Upload flow (the main path)

1. Machine → Drive. `get_upload_url` (`kind: "drive"`) opens a Google resumable upload session in the connector's Drive folder "TubeDrop Uploads" (found by app property `tubedrop=uploads`; folders made before the rename, marked `dubiousArchive=uploads`, are still recognised). The caller PUTs the bytes straight to Google with `scripts/upload.sh <url> <file> <type>` (64 MB chunks, resumes after failures).
2. Drive → YouTube. `upload_video` (Drive id + all metadata + `thumbnail_drive_file`, `captions_drive_file`) starts a YouTube resumable session and copies in 32 MB chunks within a ~240 s budget per call; `continue_upload` until done. Job state lives in the `jobs` table.
3. Cleanup. When YouTube has the whole video: thumbnail and captions are applied, then the video, thumbnail and captions are deleted from Drive (`delete_from_drive`, default true). Only files whose parent is the uploads folder are ever deleted; a thumbnail/captions file that failed is kept for a retry.

Also: `get_upload_url` `kind: "video" | "thumbnail" | "captions"` uploads straight to YouTube with no Drive; `update_video` (setting `privacy: public` on a scheduled video clears `publishAt` and publishes now); `set_thumbnail`, `add_captions`, `list_my_videos`, `list_playlists`, `create_playlist`, `find_drive_files`. Owner-specific extras: `import_from_github` (needs `GITHUB_TOKEN` + `MEDIA_REPO`), `sketchfab_search`, `sketchfab_save_model` (needs `SKETCHFAB_TOKEN`). These use the operator's keys; before sharing one install with other people, limit them to the owner's email.

## Tests

`npm test` runs `test/e2e.mts`: a fake Google (Drive + YouTube, real HTTP, resumable semantics, one injected 503) and in-process Postgres (PGlite), driving the real handler, bearer auth, JSON-RPC, tools, pump, cleanup and `scripts/upload.sh`. 19/19 pass. `npm run typecheck` is clean.

## Where things stand (27 Oct 2026)

- Code: complete and tested here. Not yet deployed anywhere.
- Live connector: the old version runs as Vercel project `dubious-archive-uploader` (prj_Hhw4ckKP03YU0aSh1oSm5b6EOacP, team team_WbX8X2GWYWERAQckAMG0aA8I), URL `https://dubious-archive-uploader.vercel.app`, currently returning 404 on everything. Cause: the project auto-deploys from `Krisna07/dubious-archive-media` without Root Directory `uploader`, so new builds contain no function. The last working deployment is `dpl_6W33M2WnQQgFMk1LTZzBKw8sZdvo`. Moving to this repo fixes it.
- Production database (Neon): keep it. The schema migration only adds columns (`IF NOT EXISTS`), so existing users and tokens survive.

## Next steps, in order

1. Vercel: connect project `dubious-archive-uploader` to this repo (Settings → Git), root directory empty. Rename the project to `tubedrop` and add domain `tubedrop.vercel.app` (keep the old domain until the scheduled tasks are switched). Env vars stay: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENC_KEY`, `DATABASE_URL`, `ALLOWED_EMAILS`; add `MEDIA_REPO=Krisna07/dubious-archive-media` only if the GitHub tools are still wanted. Redeploy and check `/` shows the TubeDrop page.
2. Google Cloud: add redirect URI `https://tubedrop.vercel.app/google/callback`; rename the consent screen app to TubeDrop.
3. Claude: add custom connector TubeDrop with `https://tubedrop.vercel.app/mcp`, Connect, then remove the old "Dubious" connector.
4. Smoke test with a small real file: Drive upload → `upload_video` as private → check thumbnail, captions, Drive cleanup → delete the test video.
5. Channel tasks (owner's channel, done from the `dubious-archive-media` repo):
   - Publish now (owner asked): film `jTSzKI-i_oM`, Shorts `sVxqcqSzLHY`, `13yg5TMhePY`, `35twafCLTcM` (`update_video` with `privacy: public`).
   - Merge branch `uploader-direct-upload` there (runbook uses Drive→YouTube + `production/upload.sh`), then remove `uploader/` from that repo and point its README at TubeDrop.
   - Update the two scheduled tasks ("Dubious Archive — daily video A/B") to say "TubeDrop connector" and to follow the new runbook; runs commit only `production/topics.md`.
   - Delete leftover branches: `tubedrop-export`, `media/2026-10-27-tunguska-1908`, `media/2026-10-27-dancing-plague` (Claude's git proxy refused branch deletes; use GitHub's UI).
6. Before sharing publicly: make this repo public, add a licence, limit GitHub/Sketchfab tools to the owner, and consider dropping `drive.readonly` (a Google "restricted" scope) in favour of `drive.file` only.

## Things to know

- Google "Testing" mode signs users out every 7 days; for personal use, publish the app ("In production") unverified to avoid it.
- YouTube may keep uploads from new, unaudited API projects private until YouTube's API audit; check with one test upload on any new Google project.
- Quota: 10,000 units/day per Google project by default; an upload is expensive.
- Never make a video public without the owner's explicit go-ahead. Default to private or scheduled.
