export interface RuntimeImageContent {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** A live adapter/model observation, not a launch-time promise. */
export interface RuntimeInputCapabilities {
  version: 1;
  images: boolean;
}

export const RUNTIME_INPUT_LIMITS = {
  textBytes: 1024 * 1024,
  images: 4,
  imageBytes: 10 * 1024 * 1024,
  totalImageBytes: 20 * 1024 * 1024,
  // Base64, text (including JSON escaping), and a small structural envelope.
  transportBytes: 34 * 1024 * 1024,
} as const;

export class RuntimeInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Validate untrusted transport input; no paths, URLs, or arbitrary MIME types. */
export function runtimeInput(input: unknown, images: unknown): { input: string; images: RuntimeImageContent[] } {
  if (typeof input !== "string") throw new RuntimeInputError("input must be a string");
  if (Buffer.byteLength(input, "utf8") > RUNTIME_INPUT_LIMITS.textBytes) throw new RuntimeInputError("Input exceeds 1 MiB", 413);
  if (images !== undefined && !Array.isArray(images)) throw new RuntimeInputError("images must be an array");
  const values: unknown[] = images ?? [];
  if (values.length > RUNTIME_INPUT_LIMITS.images) throw new RuntimeInputError("Too many images", 413);
  let total = 0;
  const normalized = values.map((value): RuntimeImageContent => {
    const image = value as Partial<RuntimeImageContent> | null;
    if (!image || image.type !== "image" || typeof image.data !== "string"
      || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType ?? "")) {
      throw new RuntimeInputError("Invalid image content");
    }
    if (image.data.length > Math.ceil(RUNTIME_INPUT_LIMITS.imageBytes / 3) * 4) throw new RuntimeInputError("Image is too large", 413);
    if (!image.data.length || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new RuntimeInputError("Invalid image base64");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data) throw new RuntimeInputError("Invalid image base64");
    if (bytes.length > RUNTIME_INPUT_LIMITS.imageBytes) throw new RuntimeInputError("Image is too large", 413);
    total += bytes.length;
    if (total > RUNTIME_INPUT_LIMITS.totalImageBytes) throw new RuntimeInputError("Combined images are too large", 413);
    return { type: "image", data: image.data, mimeType: image.mimeType! };
  });
  if (!input.trim() && !normalized.length) throw new RuntimeInputError("input or images are required");
  return { input, images: normalized };
}
