import { ProductUpload } from './components/ProductUpload';
import { JobQueue } from './components/JobQueue';
import Link from 'next/link';

export default function Home() {
  return (
    <main className="page">
      <div className="page-header">
        <h1>UGC Creator</h1>
        <Link href="/ready" className="nav-link">
          Ready to Post &rarr;
        </Link>
      </div>
      <ProductUpload />
      <JobQueue />
    </main>
  );
}
