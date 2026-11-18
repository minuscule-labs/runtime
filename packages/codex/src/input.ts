import { createHash } from "node:crypto";
import type { RuntimeImageContent } from "@minu/runtime-core";

/** Canonical base64 is validated by Core before this function is used. */
export function codexInputFingerprint(input: string, images: RuntimeImageContent[]): string {
  return createHash("sha256").update(JSON.stringify([input, images.map(image => [image.mimeType, image.data])])).digest("hex");
}
export function nativeInput(input: string, images: RuntimeImageContent[]): Array<Record<string, unknown>> {
  return [...(input ? [{ type: "text", text: input, text_elements: [] }] : []),
    ...images.map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))];
}
