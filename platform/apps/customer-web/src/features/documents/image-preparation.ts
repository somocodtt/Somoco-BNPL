const maxDimension = 1_600;

export async function prepareImageForUpload(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error("DOCUMENT_IMAGE_REQUIRED");
  }
  if (typeof createImageBitmap !== "function") return file;
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", 0.82);
    });
  } finally {
    image.close();
  }
}
