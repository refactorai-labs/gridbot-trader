import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grid Bot Simulator',
  description: 'Dual grid trading bot simulator with adaptive strategy',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen relative">
        <div className="relative z-10">
          {children}
        </div>
      </body>
    </html>
  );
}
