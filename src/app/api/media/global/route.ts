import { t as translate } from "@/lib/i18n";
import { deleteGlobalAsset, importFileToGlobal, listGlobalAssets, syncExistingAssetsToGlobal } from "@/lib/global-assets";
import type { GlobalAssetKind, GlobalAssetSource } from "@/lib/db/schema";
import { MAX_UPLOAD_BYTES } from "@/lib/editing/media";

let syncedOnce = false;

export async function GET(request: Request) {
  try {
    // Run sync on first call to ensure any existing project assets/renders/audio are indexed
    if (!syncedOnce) {
      syncExistingAssetsToGlobal();
      syncedOnce = true;
    }

    const { searchParams } = new URL(request.url);
    const kind = (searchParams.get("kind") || "all") as GlobalAssetKind | "all";
    const source = (searchParams.get("source") || "all") as GlobalAssetSource | "all";
    const search = searchParams.get("search") || undefined;
    const forceSync = searchParams.get("sync") === "1";

    if (forceSync) {
      syncExistingAssetsToGlobal();
    }

    const assets = listGlobalAssets({ kind, source, search });
    return Response.json({ assets });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : translate("Error when you get global assets.") },
      { status: 500 },
    );
  }
}

/** Bulk removal: `{ ids: string[] }`. Answers with what left the library and what could not. */
export async function DELETE(request: Request) {
  const body = await request.json().catch(() => null);
  const ids: unknown = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || !ids.every((id) => typeof id === "string")) {
    return Response.json({ error: translate("Request invalid.") }, { status: 400 });
  }
  const removed: string[] = [];
  const failed: string[] = [];
  for (const id of new Set(ids as string[])) {
    try {
      if (await deleteGlobalAsset(id)) removed.push(id);
      else failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return Response.json({ removed, failed }, { status: removed.length || !failed.length ? 200 : 500 });
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES + 65536) {
    return Response.json({ error: translate("The limit is 256 MB per file.") }, { status: 413 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: translate("No files were provided.") }, { status: 400 });
    }

    const asset = await importFileToGlobal(file);
    return Response.json({ asset });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : translate("The file could not be uploaded to the global library.") },
      { status: 400 },
    );
  }
}
