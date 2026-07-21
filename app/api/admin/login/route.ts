import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import {
  createSessionToken,
  getAdminPasswordHash,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Virheellinen pyyntö." }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminHash = getAdminPasswordHash();

  // Fail closed if the admin account isn't configured.
  if (!adminEmail || !adminHash || !process.env.ADMIN_SESSION_SECRET) {
    console.error(
      "[admin/login] Missing ADMIN_EMAIL / ADMIN_PASSWORD_HASH / ADMIN_SESSION_SECRET."
    );
    return NextResponse.json(
      { error: "Kirjautuminen ei ole käytettävissä." },
      { status: 500 }
    );
  }

  const emailMatches = email === adminEmail;
  // Always run bcrypt.compare (even on email mismatch) to avoid leaking which
  // field was wrong via timing. Generic error message either way.
  const passwordMatches = await bcrypt.compare(password, adminHash);

  if (!emailMatches || !passwordMatches) {
    return NextResponse.json(
      { error: "Väärä sähköposti tai salasana." },
      { status: 401 }
    );
  }

  cookies().set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
