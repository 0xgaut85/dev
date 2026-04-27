import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crunchbase Lead Finder",
  description: "Filter and enrich Crunchbase leads for outreach",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">{children}</body>
    </html>
  );
}
