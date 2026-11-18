import Link from "next/link";

/** Header and centred column for every page except the full-screen studio. */
export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-4">
          <Link href="/" className="font-semibold tracking-tight">
            VideoGen
          </Link>
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</main>
    </>
  );
}
