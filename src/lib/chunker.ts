export type ChunkOptions = {
  maxLength: number;
  mode?: "paragraph" | "length";
};

export function chunkMessage(text: string, options: ChunkOptions): string[] {
  const { maxLength, mode = "paragraph" } = options;

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;

    if (mode === "paragraph") {
      // Try to split at paragraph boundary
      const lastParagraph = remaining.lastIndexOf("\n\n", maxLength);
      if (lastParagraph > maxLength * 0.3) {
        splitAt = lastParagraph + 2;
      } else {
        // Fall back to newline
        const lastNewline = remaining.lastIndexOf("\n", maxLength);
        if (lastNewline > maxLength * 0.3) {
          splitAt = lastNewline + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
