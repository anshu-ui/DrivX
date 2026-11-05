import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { cssVariables } from "@drivx/design-tokens";
import "./globals.css";

// Plus Jakarta Sans is the product face on mobile too, so the console cannot
// drift from it. Five cuts, because the scale asks for a real 800 on the
// wordmark and the headings rather than a synthesised one.
const jakarta = localFont({
  src: [
    { path: "../public/fonts/plus-jakarta-400.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/plus-jakarta-500.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/plus-jakarta-600.ttf", weight: "600", style: "normal" },
    { path: "../public/fonts/plus-jakarta-700.ttf", weight: "700", style: "normal" },
    { path: "../public/fonts/plus-jakarta-800.ttf", weight: "800", style: "normal" },
  ],
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: "DrivX Admin",
  description: "Live bookings, driver operations and the DrivX earnings ledger.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`}>
      <head>
        <style id="drivx-tokens">{cssVariables()}</style>
      </head>
      <body className="min-h-full flex flex-col bg-background text-ink">{children}</body>
    </html>
  );
}
