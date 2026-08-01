import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import AuthGate from "@/components/AuthGate";
import UiProvider from "@/components/ui/UiProvider";
import { ModelsProvider } from "@/lib/models";
import { VersionWatcher } from "@/components/VersionWatcher";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: "Enpii Assist",
  description: "Enpii Assist",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={`${inter.variable} ${jetbrains.variable} h-full overflow-hidden antialiased`}>
      <body className="flex h-full min-h-0 flex-col overflow-hidden">
        <VersionWatcher />
        <AuthProvider>
          <UiProvider>
            <ModelsProvider>
              <AuthGate>{children}</AuthGate>
            </ModelsProvider>
          </UiProvider>
        </AuthProvider>
      </body>
    </html>
  );
}