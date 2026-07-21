import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import LogoutButton from "@/components/admin/LogoutButton";

// Guards every /admin/* route in this group. Fails closed: any missing/invalid
// session redirects to the login page.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function ProtectedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    redirect("/admin/login");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Cleava
            </span>
            <span className="text-slate-300">/</span>
            <span className="text-sm font-semibold text-slate-900">Admin</span>
          </div>
          <LogoutButton />
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-4 py-6 sm:px-6">
        {/* Sidebar */}
        <aside className="hidden w-44 shrink-0 sm:block">
          <nav className="space-y-1">
            <Link
              href="/admin"
              className="block rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
            >
              Quotes
            </Link>
            {/* More sections can be added here later. */}
          </nav>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
