"use client";

/**
 * Inline <script> that runs once while the HTML is parsed, without React's dev warning about rendering
 * scripts on the client: the server emits it as JavaScript, the client renders it as inert text.
 * suppressHydrationWarning covers the `type` mismatch.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
