# TubeDrop: YouTube uploads for Claude (self-hosted MCP connector)

A remote MCP server that lets Claude upload videos to **your own** YouTube channel, with **your own** Google
credentials. It runs on Vercel with a Neon Postgres database. Nothing is shared with anyone else: your Google
Cloud project, your API quota, your channel.

What Claude can do with it: upload a video (with title, description, tags, category, privacy or a scheduled
`publish_at`, AI-content disclosure), set a thumbnail, add captions, edit a video's metadata or schedule, list
recent uploads, and manage playlists. Optionally it can also publish Reels to your Instagram professional
account (see [Instagram Reels](#instagram-reels-optional)).

## Set it up (about 15 minutes)

### 1. Google Cloud project

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3** and **Google Drive API**.
3. **Google Auth Platform → Branding**: app name (anything), your email as support and developer contact.
4. **Audience**: user type **External**. Add your own Google account under **Test users**.
   - Testing mode signs you out every 7 days. To avoid that, press **Publish app** ("In production").
     For your own use you do not need Google's verification; you will just see an "unverified app" screen
     when you connect. Click *Advanced → Go to (app name)*.
5. **Clients → Create client**: type **Web application**. Under *Authorised redirect URIs* add
   `https://tubedrop.vercel.app/google/callback` (you can come back and fix the name after step 3).
   Copy the **Client ID** and **Client secret**.

### 2. Get the code

Fork this repository (or use it as a template) into your own GitHub account.

### 3. Deploy on Vercel

1. <https://vercel.com/new> → import your repository.
2. Framework preset: *Other*. Leave the root directory and build settings empty.
3. Add the environment variables below, then **Deploy**.
4. In the project, open **Storage → Create → Neon** (free tier is enough) and connect it to the project.
   This sets `DATABASE_URL` for you. Redeploy once afterwards. Tables are created automatically on first use.

| Variable | Required | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | From step 1.5 |
| `GOOGLE_CLIENT_SECRET` | yes | From step 1.5 |
| `ENC_KEY` | yes | A random 32-byte key: `openssl rand -base64 32`. Keep it secret; it encrypts the stored Google tokens. |
| `DATABASE_URL` | yes | Set by the Neon integration |
| `ALLOWED_EMAILS` | strongly recommended | Your Google account email(s), comma-separated. Anyone else is refused. |
| `PUBLIC_URL` | optional | e.g. `https://my-uploader.vercel.app` if you use a custom domain |
| `GITHUB_TOKEN`, `MEDIA_REPO` (owner/repo), `SKETCHFAB_TOKEN` | optional | Only for the GitHub-relay and Sketchfab tools |
| `META_ACCESS_TOKEN` | optional | Only for Instagram Reels. The Instagram tools appear only when this is set. |
| `META_APP_ID`, `META_APP_SECRET` | optional | Lets `whoami` show when the Instagram token expires. |
| `META_IG_USER_ID` | optional | Only if the token reaches several Instagram accounts and you want a specific one. |

Check it: opening `https://tubedrop.vercel.app/` shows a short "TubeDrop" page.

### 4. Connect Claude

1. In Claude: **Settings → Connectors → Add custom connector**, URL `https://tubedrop.vercel.app/mcp`.
2. Press **Connect**. Google asks twice: first Drive access, then YouTube (pick your channel). Tick the boxes.
3. Ask Claude "which channel is TubeDrop connected to?" It should answer with your channel.

## How uploads work

1. **Your machine → Drive.** Claude calls `get_upload_url` (`kind: "drive"`, file size, name, type). The server
   opens a one-time Google *resumable upload session* in the connector's Drive folder ("TubeDrop Uploads") and returns its URL. Claude (or a script it runs) sends the file there with HTTP PUT; it never
   passes through the server. `scripts/upload.sh <url> <file> <content-type>` sends it in
   64 MB chunks and resumes after a dropped connection. The machine sending must be able to reach
   `www.googleapis.com`.
2. **Drive → YouTube.** `upload_video` with the Drive file id (plus `thumbnail_drive_file`,
   `captions_drive_file`) copies the video to YouTube server-side; call `continue_upload` until it says done.
3. **Cleanup.** Once YouTube has the whole video, the video, thumbnail and captions files are deleted from
   Drive (`delete_from_drive`, default true). Only files inside the connector's own uploads folder are ever
   deleted; anything else in your Drive is left alone. A thumbnail or captions file that failed to apply is kept
   so it can be retried.

You can also skip Drive entirely: `get_upload_url` with `kind: "video"` (plus the metadata) uploads straight to
YouTube, and `kind: "thumbnail"` / `"captions"` attach to an existing video.

Uploads default to **private**. Scheduled videos use `privacy: private` plus `publish_at`; setting
`privacy: public` on a scheduled video publishes it now.

## Instagram Reels (optional)

TubeDrop can also publish a Drive video as a Reel on your Instagram **Business or Creator** account, through
the *Instagram API with Unified login* (no Facebook Page needed). It posts to one account: yours, through an
access token you generate in Meta's dashboard. Anyone allowed to use the connector (`ALLOWED_EMAILS`) can post
to it.

### Set it up

1. Switch your Instagram account to a professional account (Instagram app: Settings → Account type and tools).
2. At <https://developers.facebook.com/apps> create an app and add the use case **Manage messaging & content on
   Instagram**. New apps get *API setup with Unified login*; the app must belong to a business portfolio.
3. In **Use cases → Customize → API setup with Unified login → Generate access tokens**, add your Instagram
   account as a tester and accept the invite in the Instagram app (Settings → Website permissions → Apps and
   websites → Tester invites). For your own account you do not need Meta's App Review.
4. Click **Generate token** and copy it (it is shown once). Check it in the
   [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken): the scopes must include
   `instagram_content_publish`; note when it expires.
5. In Vercel set `META_ACCESS_TOKEN` to the token. Optionally also set `META_APP_ID` and `META_APP_SECRET` (App
   settings → Basic) so `whoami` can show the token's expiry. Redeploy.
6. Ask Claude "whoami": it should show your Instagram username.

If the token has an expiry date, generate a new one before then and update `META_ACCESS_TOKEN`. When a token stops
working, the Instagram tools say so.

### How it works

1. Get the video into Drive the usual way (`get_upload_url` with `kind: "drive"`).
2. `instagram_publish_reel` with the Drive id, caption and optionally a JPEG `cover_drive_file`. Meta publishes
   from a URL, so TubeDrop gives it a link to `/ig/media/<job>/video?t=<secret>`, which streams the Drive file.
   Each link has its own random secret and stops working once the Reel is published or fails.
3. Instagram processes the video; call `instagram_continue_publish` about once a minute until it says done. The
   result has the Reel's link, and the video and cover are deleted from the Drive uploads folder.

`instagram_list_media` lists recent posts and how much of the 24-hour API publishing limit is used.

**A Reel is public as soon as it is published.** The API has no private or scheduled posts, so the publish tool
requires `user_confirmed: true` and Claude is told to post only when you have clearly said so.

Reel specs: MP4 or MOV, H.264 or HEVC, AAC audio, 3 seconds to 15 minutes, 9:16 recommended, at most 300 MB.

## Limits worth knowing

- **Quota.** Your Google Cloud project has a daily YouTube Data API quota (10,000 units by default); a video
  upload uses a large share of it. You can request more in the Cloud console.
- **New API projects.** YouTube may keep uploads from new, unaudited API projects private until the project
  passes YouTube's API compliance audit. Test with one upload first.
- **Security.** The database holds your encrypted Google refresh tokens. Keep `ENC_KEY` and `DATABASE_URL`
  secret, and keep `ALLOWED_EMAILS` set.

## Development

```bash
npm install
npm run typecheck
npm test        # end-to-end test against a fake Google and an in-process Postgres
```
