/**
 * Save fetched JSON as a file. The export routes are session-authenticated JSON,
 * not attachments, so the browser cannot simply follow a link: build a Blob URL,
 * click a transient anchor, then release the URL.
 */

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename-safe slug: "meera.iyer@acme.in" → "meera.iyer-acme.in". */
export function fileSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "traveller";
}
