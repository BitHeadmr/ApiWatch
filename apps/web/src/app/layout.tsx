import type { Metadata } from 'next';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import './globals.css';
import { AuthProvider } from '@/lib/auth';


export const metadata: Metadata = {
  title: { default: 'APIWatch', template: '%s · APIWatch' },
  description: 'Know when your APIs go down before your customers do.',
};

export default function RootLayout({ children }: any) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
