import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Goose gold logo and wordmark";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logo = await readFile(join(process.cwd(), "app", "_assets", "goose-wordmark.png"), "base64");

  // Keep the visible wordmark inside the center square used by some previews.
  return new ImageResponse(
    (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "#0b0b0a",
      }}>
        <img src={`data:image/png;base64,${logo}`} alt={alt} width={768} height={256} />
      </div>
    ),
    size,
  );
}
