"use client";

import { FormEvent, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i;

/** Reads a filename out of a Content-Disposition header, if present. */
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  const asciiMatch = header.match(/filename="?([^";]+)"?/i);
  return asciiMatch ? asciiMatch[1] : null;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isValidUrl = YOUTUBE_URL_PATTERN.test(url.trim());

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "loading") return;

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("Please paste a YouTube link first.");
      setStatus("error");
      return;
    }
    if (!isValidUrl) {
      setError("That doesn't look like a YouTube link.");
      setStatus("error");
      return;
    }

    setStatus("loading");
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmedUrl }),
      });

      if (!response.ok) {
        let message = `Download failed (${response.status}).`;
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch {
          // Response wasn't JSON — fall back to the generic message above.
        }
        throw new Error(message);
      }

      // The API streams the video back as the response body. Buffer it into a Blob so
      // the browser can hand it to the user as a normal file download.
      const blob = await response.blob();
      const filename =
        filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
        "video.mp4";

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);

      setSuccessMessage(`Downloaded "${filename}".`);
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 py-16 dark:bg-black">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            YouTube Downloader
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Paste a link, get an MP4 with video and audio merged in 720p+.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="youtube-url" className="sr-only">
            YouTube URL
          </label>
          <input
            id="youtube-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (status !== "idle") {
                setStatus("idle");
                setError(null);
                setSuccessMessage(null);
              }
            }}
            disabled={status === "loading"}
            className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />

          <button
            type="submit"
            disabled={status === "loading" || url.trim().length === 0}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? (
              <>
                <Spinner />
                Downloading&hellip;
              </>
            ) : (
              "Download"
            )}
          </button>
        </form>

        {status === "loading" && (
          <p className="mt-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
            Fetching video info and merging streams — this can take a moment for longer
            videos.
          </p>
        )}

        {status === "error" && error && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </div>
        )}

        {status === "success" && successMessage && (
          <div
            role="status"
            className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-950/40 dark:text-green-400"
          >
            {successMessage}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-white"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
