import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter, Roboto_Flex } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** inter — the frost shell's face (1:1 with the design files) */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

/** material you — the lock screen's face (settings › lock screen › font) */
const robotoFlex = Roboto_Flex({
  variable: "--font-material-you",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // the site wears hub.hertswoodacademy.org's own title + icon — the tab
  // looks exactly like the school hub, because it IS the school hub
  title: "Student Hub",
  description: " ",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/hub/favicon-196.png", sizes: "196x196", type: "image/png" },
      { url: "/hub/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/frost/icons/icon-180.png",
  },
  // PWA addon — installs as frost with the snowflake mark
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "frost",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${robotoFlex.variable} ${inter.variable} antialiased bg-black text-foreground`}>
        {children}
      </body>
    </html>
  );
}
