import { t as translate } from "@/lib/i18n";
import { redirect } from "next/navigation";
import { Suspense } from "react";

/** Preserve bookmarked result URLs while keeping every task in the same studio. */
export default function ResultPage({ params }: PageProps<"/projects/[id]/results">) {
  return <Suspense fallback={<p className="text-muted">{translate("Opening the studio…")}</p>}><ResultRedirect params={params} /></Suspense>;
}
async function ResultRedirect({ params }: { params: PageProps<"/projects/[id]/results">["params"] }) {
  const { id } = await params;
  return redirect(`/projects/${id}?panel=exports`);
}
