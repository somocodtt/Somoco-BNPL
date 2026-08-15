import { fileTypeFromBuffer } from "file-type";

export async function detectFileMimeType(
  bytes: Uint8Array,
): Promise<string | undefined> {
  return (await fileTypeFromBuffer(bytes))?.mime;
}
