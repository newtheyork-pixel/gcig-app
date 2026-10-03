import { useState } from 'react';

// Combined mark for the auth pages (login, invite, password). The
// file is .webp because Cloudflare Polish rewrites PNG/JPEG and
// often leaves the old Content-Type; Safari then refuses to paint it
// under nosniff. Polish does not rewrite WebP. Hide the image if it
// fails and fall back to the wordmark.
export default function AuthBrandMark() {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <div className="text-2xl font-semibold tracking-tight text-navy">The Griffin Fund</div>
      ) : (
        <img
          src="/griffin-logo.webp"
          alt="The Griffin Fund"
          width={1091}
          height={458}
          className="h-14 w-auto"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.16em] text-navy-400">
        Grace Church School
      </div>
    </>
  );
}
