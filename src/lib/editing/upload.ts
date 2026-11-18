import { t as translate } from "@/lib/i18n";
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** Bound the streamed multipart body as well as the declared length. */
export async function readMediaUpload(request: Request): Promise<File> {
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES + 65536) throw new Error(translate("The limit is 256 MB per file."));
  let bytes = 0;
  const body = request.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > MAX_UPLOAD_BYTES + 65536) throw new Error(translate("The limit is 256 MB per file."));
    controller.enqueue(chunk);
  } }));
  const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error(translate("Select a file."));
  return file;
}
