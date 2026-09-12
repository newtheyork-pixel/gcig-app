import { useState } from 'react';

// Combined mark for the auth pages (login, invite, password). The
// file is .webp because Cloudflare Polish rewrites PNG/JPEG and
// often leaves the old Content-Type; Safari then refuses to paint it
// under nosniff. Polish does not rewrite WebP. Hide the whole white
// chip if the file fails: onError used to set display:none on the
// <img> and leave an empty rounded box.
export default function AuthBrandMark() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="rounded-xl bg-white px-8 py-5">
      <img
        src="/griffin-logo.webp"
        alt="The Griffin Fund"
        width={900}
        height={396}
        className="h-16 w-auto"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
