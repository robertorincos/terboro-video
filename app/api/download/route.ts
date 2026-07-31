import youtubedl from "youtube-dl-exec";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

// child_process/fs access requires the Node.js runtime — this route can't run on Edge.
export const runtime = "nodejs";
// Every request depends on user input; never let Next.js cache or prerender this route.
export const dynamic = "force-dynamic";
// Downloads can take a while on longer videos — raise the ceiling on hosts that allow it
// (e.g. Vercel Pro/Enterprise). Hosts that ignore this (Vercel Hobby caps at 10s) will
// need a queue/webhook based flow instead of a single synchronous request.
export const maxDuration = 300;

const ALLOWED_HOSTS = new Set(["youtube.com", "youtu.be", "music.youtube.com"]);

// Best video+audio up to 1080p, merged into a single stream. Capped at 1080p so a stray
// 4K/8K source doesn't turn every request into a multi-GB download; drop the height
// filters if you want to always take the single best available track.
const VIDEO_FORMAT =
  "bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best";

class ClientError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Validates the URL is a real YouTube video link and returns it normalized. */
function normalizeYouTubeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ClientError("Please enter a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ClientError("Only http/https URLs are supported.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ClientError("That doesn't look like a YouTube link.");
  }

  const isValidVideoLink =
    host === "youtu.be"
      ? parsed.pathname.length > 1
      : (parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))) ||
        parsed.pathname.startsWith("/shorts/") ||
        parsed.pathname.startsWith("/embed/");

  if (!isValidVideoLink) {
    throw new ClientError("That doesn't look like a YouTube video link.");
  }

  return parsed.toString();
}

/** Strips characters that are illegal in filenames or HTTP header values. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return cleaned.length > 0 ? cleaned : "video";
}

/** Pulls yt-dlp's stderr out of the error thrown by youtube-dl-exec. */
function extractStderr(err: unknown): string {
  if (err instanceof Error) {
    return (err as Error & { stderr?: string }).stderr || err.message || "";
  }
  return String(err);
}

/** Maps raw yt-dlp failure output to a short, user-facing message + status code. */
function friendlyErrorFromStderr(stderr: string): ClientError {
  const message = stderr.toLowerCase();
  if (message.includes("private video")) {
    return new ClientError("This video is private and can't be downloaded.", 403);
  }
  if (message.includes("video unavailable")) {
    return new ClientError("This video is unavailable — it may have been removed.", 404);
  }
  if (message.includes("sign in") || message.includes("age")) {
    return new ClientError(
      "This video is age-restricted or requires sign-in, so it can't be downloaded.",
      403
    );
  }
  if (message.includes("ffmpeg") && message.includes("not found")) {
    return new ClientError(
      "Server misconfiguration: ffmpeg is required to merge video and audio but isn't installed.",
      500
    );
  }
  if (message.includes("unable to extract") || message.includes("unsupported url")) {
    return new ClientError(
      "Couldn't read this link — double-check it's a valid YouTube video URL.",
      400
    );
  }
  return new ClientError(
    "Failed to download this video. It may be region-locked, live, or otherwise unavailable.",
    502
  );
}

export async function POST(request: NextRequest) {
  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return Response.json({ error: "A YouTube URL is required." }, { status: 400 });
  }
  if (body.url.length > 2048) {
    return Response.json({ error: "URL is too long." }, { status: 400 });
  }

  let videoUrl: string;
  try {
    videoUrl = normalizeYouTubeUrl(body.url);
  } catch (err) {
    const status = err instanceof ClientError ? err.status : 400;
    const message = err instanceof Error ? err.message : "Invalid URL.";
    return Response.json({ error: message }, { status });
  }

  // Step 1: fetch metadata only (no download). This fails fast — and cheaply — on
  // private/deleted/age-restricted videos, and gives us a real title for the filename
  // before we spend time downloading and merging anything.
  let title = "video";
  try {
    const info = (await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
    })) as { title?: string };
    if (info?.title) title = sanitizeFilename(info.title);
  } catch (err) {
    const friendly = friendlyErrorFromStderr(extractStderr(err));
    return Response.json({ error: friendly.message }, { status: friendly.status });
  }

  // Step 2: download best video+audio and merge with ffmpeg into one .mp4.
  // We deliberately merge to a temp file on disk rather than piping yt-dlp's stdout
  // straight through: an mp4's moov atom generally needs a seekable output to finalize,
  // so ffmpeg can't reliably mux merged mp4 to a pipe. Writing to disk first, then
  // streaming the finished file back, sidesteps that entirely.
  const outputPath = path.join(tmpdir(), `ytdl-${randomUUID()}.mp4`);
  try {
    await youtubedl(videoUrl, {
      output: outputPath,
      format: VIDEO_FORMAT,
      mergeOutputFormat: "mp4",
      noPlaylist: true,
      noWarnings: true,
      ...(process.env.FFMPEG_PATH ? { ffmpegLocation: process.env.FFMPEG_PATH } : {}),
    });
  } catch (err) {
    await unlink(outputPath).catch(() => {});
    const friendly = friendlyErrorFromStderr(extractStderr(err));
    return Response.json({ error: friendly.message }, { status: friendly.status });
  }

  let fileSize: number;
  try {
    fileSize = (await stat(outputPath)).size;
  } catch {
    return Response.json(
      { error: "Download finished but the output file went missing. Please try again." },
      { status: 500 }
    );
  }

  // Step 3: stream the file from disk straight into the HTTP response body instead of
  // reading it into a Buffer first — this keeps memory flat regardless of video length.
  // The temp file is deleted once the stream closes, whether it finished normally or the
  // client disconnected mid-download.
  const nodeStream = createReadStream(outputPath);
  nodeStream.on("close", () => {
    unlink(outputPath).catch(() => {});
  });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  const asciiFallback = (title.replace(/[^\x20-\x7E]/g, "_") || "video").trim() || "video";

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileSize),
      // filename= covers older clients; filename*= (RFC 5987) preserves non-ASCII titles.
      "Content-Disposition": `attachment; filename="${asciiFallback}.mp4"; filename*=UTF-8''${encodeURIComponent(
        title
      )}.mp4`,
      "Cache-Control": "no-store",
    },
  });
}
