import { ProductUpload } from './components/ProductUpload';
import { JobQueue } from './components/JobQueue';
import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <h1 style={{ margin: 0 }}>UGC Creator</h1>
        <Link href="/ready" style={{ color: '#0070f3', fontWeight: 600 }}>
          Ready to Post &rarr;
        </Link>
      </div>
      <ProductUpload />
      <JobQueue />
    </main>
  );
}
