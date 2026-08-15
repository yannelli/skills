import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skills Tracker",
  description: "Track the skills you are learning and how confident you feel.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
