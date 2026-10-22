import { AuthForm } from '@/components/AuthForm';
import type { Metadata } from 'next';


export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return <AuthForm mode="login" />;
}

