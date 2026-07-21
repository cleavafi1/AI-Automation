import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import LoginForm from "@/components/admin/LoginForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = {
  title: "Cleava Admin — Kirjaudu",
};

export default function AdminLoginPage() {
  // If already signed in, skip the form.
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token)) {
    redirect("/admin");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Cleava
          </p>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            Admin-kirjautuminen
          </h1>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <LoginForm />
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">
          Mansio Group Oy · Cleava
        </p>
      </div>
    </main>
  );
}
