import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cleava — Pyydä tarjous",
  description:
    "Pyydä tarjous Cleavan siivouspalveluista. Otamme yhteyttä 24 tunnin sisällä.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fi">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
